// The five session operations shared by the CLI and MCP faces.
//
// Failure semantics (AGENTS.md principle 3): anything that goes wrong
// BEFORE the harness produces a session id — bad args, unknown harness,
// binary missing, logged out, spawn refused, child dead early — throws a
// plain Error carrying everything known inline (faces surface it as an MCP
// tool error / CLI stderr). No pseudo-session exists in that case. From the
// moment a session id exists, failures are discovered via await and
// diagnosed via inspect.

import { spawn as spawnChild } from "node:child_process";
import { openSync, closeSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createStaging,
  isSafeId,
  readRecordFrom,
  readEvidenceFrom,
  readSession,
  readEvidence,
  reconcile,
  resolveSessionDir,
  sweepExpired,
  writeRecordTo,
  isPidAlive,
  killTree,
  type SessionRecord,
  type SessionStatus,
  type Usage,
} from "./state.ts";
import { resolvePin, type Pin } from "./discovery.ts";
import { loadPlugin, pluginNames } from "../plugins/index.ts";
import type { AuthResult, Plugin } from "../plugins/types.ts";
import { MAX_WAIT_S } from "./limits.ts";

/** Default turn deadline: 3600 s; SUBTURN_DEADLINE_S overrides. */
function defaultDeadlineS(): number {
  const env = Number(process.env["SUBTURN_DEADLINE_S"]);
  return Number.isFinite(env) && env > 0 ? env : 3600;
}
const MAX_DEADLINE_S = 6 * 3600;
/** How long spawn will wait for the harness to produce its session id
 * before declaring the bring-up dead. Internal, generous; real bring-up is
 * a few seconds. */
const BRINGUP_CAP_MS = 120_000;

export interface SpawnInput {
  harness: string;
  model: string;
  effort: string;
  prompt: string;
  cwd: string;
  timeout?: number | undefined;
}

export interface SpawnResult {
  /** The harness's own session id — bare, unprefixed, unmodified. */
  session_id: string;
  status: "running";
}

function supervisorEntry(): string {
  // Same directory as this module, in both worlds: src/core/supervisor.ts
  // when running type-stripped sources, dist/core/supervisor.js when built.
  const self = fileURLToPath(import.meta.url);
  const ext = self.endsWith(".ts") ? ".ts" : ".js";
  return path.join(path.dirname(self), `supervisor${ext}`);
}

function spawnSupervisor(dir: string): void {
  const logFd = openSync(path.join(dir, "supervisor.log"), "a");
  try {
    const child = spawnChild(process.execPath, [supervisorEntry(), dir], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function validateDeadline(deadlineS: number, given: number | undefined): void {
  if (!Number.isFinite(deadlineS) || deadlineS <= 0 || deadlineS > MAX_DEADLINE_S) {
    throw new Error(`timeout must be in (0, ${MAX_DEADLINE_S}] (got ${String(given)})`);
  }
}

/** Compose the everything-inline spawn error from staged evidence. */
function bringupError(dir: string, headline: string): Error {
  const parts: string[] = [headline];
  const rec = readRecordFrom(dir);
  if (rec?.auth_detail !== undefined) parts.push(`auth check: ${rec.auth_detail}`);
  const errText = readEvidenceFrom(dir, "error.txt");
  if (errText !== null && errText.trim() !== "") parts.push(`detail: ${errText.trim()}`);
  const spawnJson = readEvidenceFrom(dir, "spawn.json");
  if (spawnJson !== null) parts.push(`spawn: ${spawnJson.trim()}`);
  // The exact argv + exit live in the event stream; surface both.
  const events = (readEvidenceFrom(dir, "events.jsonl") ?? "")
    .split("\n")
    .filter((l) => l.includes('"type":"spawn"') || l.includes('"type":"exit"'));
  if (events.length > 0) parts.push(`process events: ${events.join(" ")}`);
  const stderr = readEvidenceFrom(dir, "stderr.log");
  if (stderr !== null && stderr.trim() !== "") {
    parts.push(`stderr tail:\n${stderr.slice(-8_192)}`);
  }
  const supLog = readEvidenceFrom(dir, "supervisor.log");
  if (supLog !== null && supLog.trim() !== "") {
    parts.push(`supervisor log tail:\n${supLog.slice(-4_096)}`);
  }
  return new Error(parts.join("\n"));
}

// Required fields per verb. One error names every missing field and the full
// required set, so a single failed call is enough to build the right one.
const SPAWN_REQUIRED = ["harness", "model", "effort", "prompt", "cwd"];
const RESUME_REQUIRED = ["session_id", "prompt"];

function requireFields(verb: string, input: object, required: string[]): void {
  const values = input as Record<string, unknown>;
  const missing = required.filter((k) => typeof values[k] !== "string" || values[k] === "");
  if (missing.length === 0) return;
  throw new Error(`${verb}: missing ${missing.join(", ")} (required: ${required.join(", ")})`);
}

/** null when `p` is a directory, otherwise the reason it is not. */
function notADirectory(p: string): string | null {
  try {
    return statSync(p).isDirectory() ? null : "is not a directory";
  } catch {
    return "does not exist";
  }
}

/** Admission: binary pin + cheap auth check — milliseconds, before any
 * quota is spent. Runs for every turn, so a harness uninstalled or logged
 * out since the last one is refused up front. */
async function admit(plugin: Plugin): Promise<{ pin: Pin; auth: AuthResult }> {
  const pin = await resolvePin(plugin.name, plugin.hints);
  if (pin === null) {
    throw new Error(`harness "${plugin.name}" is not installed (no binary found on PATH or in well-known dirs)`);
  }
  const auth = await plugin.auth();
  if (!auth.ok) {
    throw new Error(`harness "${plugin.name}" is not authorized: ${auth.detail}`);
  }
  return { pin, auth };
}

/** Resolve a caller-supplied id to its evidence dir and reconciled record. */
function locate(sessionId: string): { dir: string; record: SessionRecord } {
  if (typeof sessionId !== "string" || !isSafeId(sessionId)) {
    throw new Error(`session_id is required (got ${JSON.stringify(sessionId)})`);
  }
  const dir = resolveSessionDir(sessionId);
  const record = dir !== null ? readRecordFrom(dir) : null;
  if (dir === null || record === null) {
    throw new Error(
      `unknown session ${sessionId} (never launched here, or its evidence aged out of the retention window)`,
    );
  }
  return { dir, record: reconcile(record) };
}

export async function spawn(input: SpawnInput): Promise<SpawnResult> {
  try {
    sweepExpired();
  } catch { /* retention GC never fails a spawn */ }

  // Validation failures are plain errors — no session exists yet.
  requireFields("spawn", input, SPAWN_REQUIRED);
  const plugin = await loadPlugin(input.harness);
  if (plugin === undefined) {
    throw new Error(`unknown harness "${input.harness}" (known: ${pluginNames().join(", ")})`);
  }
  if (!path.isAbsolute(input.cwd)) {
    throw new Error(`cwd must be an absolute path (got ${JSON.stringify(input.cwd)})`);
  }
  const cwdProblem = notADirectory(input.cwd);
  if (cwdProblem !== null) throw new Error(`cwd ${cwdProblem}: ${input.cwd}`);
  const deadlineS = input.timeout ?? defaultDeadlineS();
  validateDeadline(deadlineS, input.timeout);
  const { pin, auth } = await admit(plugin);

  const now = Date.now();
  const record: SessionRecord = {
    session_id: "", // the harness's id, filled in by the supervisor
    harness: plugin.name,
    model: input.model,
    effort: input.effort,
    cwd: input.cwd,
    bin_path: pin.binPath,
    auth_detail: auth.detail,
    status: "running",
    turn: 1,
    created_at: new Date(now).toISOString(),
    turn_started_at: new Date(now).toISOString(),
    deadline_at: new Date(now + deadlineS * 1000).toISOString(),
  };
  const dir = createStaging(record, input.prompt);

  // Detach the per-turn supervisor: the launching process (one-shot CLI or
  // MCP server) is free to exit while the subagent runs on.
  spawnSupervisor(dir);

  // Block the few seconds until the harness produces its session id
  // (AGENTS.md: spawn returns the native id or fails with everything
  // known inline — never a pseudo-session).
  const waitUntil = now + Math.min(BRINGUP_CAP_MS, deadlineS * 1000 + 10_000);
  for (;;) {
    await sleep(120);
    const rec = readRecordFrom(dir);
    if (rec === null) {
      // Adoption briefly removes the staging path before replacing it
      // with a forwarding symlink. Re-read below in case it just finished.
      break;
    }
    if (rec.session_id !== "") {
      return { session_id: rec.session_id, status: "running" };
    }
    if (rec.status === "failed") {
      throw bringupError(dir, `spawn failed before the harness produced a session (harness "${plugin.name}")`);
    }
    if (Date.now() >= waitUntil) {
      // Hung bring-up: kill the supervisor tree, fail loudly.
      if (rec.child_pid !== undefined && isPidAlive(rec.child_pid)) killTree(rec.child_pid);
      if (rec.supervisor_pid !== undefined && isPidAlive(rec.supervisor_pid)) {
        try { process.kill(rec.supervisor_pid, "SIGKILL"); } catch { /* gone */ }
      }
      try {
        writeRecordTo(dir, { ...rec, status: "failed", finished_at: new Date().toISOString() });
      } catch { /* evidence dir may be gone */ }
      throw bringupError(
        dir,
        `harness "${plugin.name}" produced no session id within ${Math.round((waitUntil - now) / 1000)}s; killed`,
      );
    }
  }
  // A completed adoption leaves a forwarding symlink at the staging path.
  const rec = readRecordFrom(dir);
  if (rec !== null && rec.session_id !== "") {
    return { session_id: rec.session_id, status: "running" };
  }
  throw new Error(
    "spawn lost track of the session during bring-up (staging record vanished before an id was published); " +
      `staging dir was ${dir}`,
  );
}

export interface ResumeInput {
  session_id: string;
  prompt: string;
  timeout?: number | undefined;
}

export async function resume(input: ResumeInput): Promise<SpawnResult> {
  requireFields("resume", input, RESUME_REQUIRED);
  const { dir, record: rec } = locate(input.session_id);
  if (rec.status === "running") {
    throw new Error(
      `session ${rec.session_id} still has a turn running — turns of one conversation are sequential; ` +
        `await it (or cancel it) and resume after it finishes`,
    );
  }
  const cwdProblem = notADirectory(rec.cwd);
  if (cwdProblem !== null) throw new Error(`the session's cwd ${cwdProblem} any more: ${rec.cwd}`);
  const plugin = await loadPlugin(rec.harness);
  if (plugin === undefined) {
    throw new Error(`the session's harness "${rec.harness}" has no plugin any more (known: ${pluginNames().join(", ")})`);
  }
  const deadlineS = input.timeout ?? defaultDeadlineS();
  validateDeadline(deadlineS, input.timeout);
  const { pin, auth } = await admit(plugin);

  const now = Date.now();
  const next: SessionRecord = {
    ...rec,
    bin_path: pin.binPath,
    auth_detail: auth.detail,
    status: "running",
    turn: rec.turn + 1,
    turn_started_at: new Date(now).toISOString(),
    deadline_at: new Date(now + deadlineS * 1000).toISOString(),
  };
  delete next.started_at;
  delete next.finished_at;
  delete next.supervisor_pid;
  delete next.child_pid;
  delete next.usage;
  delete next.reaped;
  try {
    writeRecordTo(dir, next);
    // The new turn's prompt replaces the old one (the event stream keeps
    // per-turn history).
    writeFileSync(path.join(dir, "prompt.txt"), input.prompt);
  } catch (e) {
    throw new Error(`cannot admit the resumed turn: ${String(e)}`);
  }
  spawnSupervisor(dir);
  // The id already exists, so this returns immediately; anything that goes
  // wrong from here is a turn failure: await discovers it, inspect explains.
  // The response repeats the CURRENT id — if the harness rotates ids on this
  // turn, Subturn absorbs it (old id stays resolvable).
  return { session_id: next.session_id, status: "running" };
}

export interface TurnState {
  session_id: string;
  status: SessionStatus;
  turn: number;
  elapsed_s: number;
  /** running only: seconds until the deadline reaper fires. */
  deadline_in_s?: number;
  /** completed only. */
  final_text?: string;
  usage?: Usage;
  /** completed only: the bundle the harness acknowledged, where it echoes
   * one (grok, opencode: model+effort; claude: model; codex: nothing). The
   * caller compares it with what it asked for; Subturn never gates. */
  bundle?: { model?: string; effort?: string };
}

function elapsedS(record: SessionRecord): number {
  const start = Date.parse(record.started_at ?? record.turn_started_at ?? record.created_at);
  const end = record.finished_at !== undefined ? Date.parse(record.finished_at) : Date.now();
  return Math.round((end - start) / 100) / 10;
}

function acknowledgedBundle(sessionId: string): TurnState["bundle"] | undefined {
  const raw = readEvidence(sessionId, "ack.json");
  if (raw === null) return undefined;
  let ack: unknown;
  try { ack = JSON.parse(raw); } catch { return undefined; }
  if (typeof ack !== "object" || ack === null) return undefined;
  const a = ack as Record<string, unknown>;
  const bundle: { model?: string; effort?: string } = {};
  if (typeof a["acknowledged_model"] === "string") bundle.model = a["acknowledged_model"];
  if (typeof a["acknowledged_effort"] === "string") bundle.effort = a["acknowledged_effort"];
  return Object.keys(bundle).length > 0 ? bundle : undefined;
}

function project(record: SessionRecord): TurnState {
  const result: TurnState = {
    session_id: record.session_id,
    status: record.status,
    turn: record.turn,
    elapsed_s: elapsedS(record),
  };
  if (record.status === "running") {
    result.deadline_in_s = Math.max(0, Math.round((Date.parse(record.deadline_at) - Date.now()) / 1000));
  }
  if (record.status === "completed") {
    result.final_text = readEvidence(record.session_id, "final.txt") ?? "";
    if (record.usage !== undefined) result.usage = record.usage;
    const bundle = acknowledgedBundle(record.session_id);
    if (bundle !== undefined) result.bundle = bundle;
  }
  // failed / cancelled: status + timing and nothing else — await never explains (AGENTS.md).
  return result;
}

/** Poll the record until the turn is no longer running or the wait ends. */
async function settle(sessionId: string, record: SessionRecord, waitMs: number): Promise<SessionRecord> {
  const waitUntil = Date.now() + waitMs;
  let current: SessionRecord | null = record;
  while (current !== null && current.status === "running" && Date.now() < waitUntil) {
    await sleep(Math.min(300, Math.max(1, waitUntil - Date.now())));
    current = readSession(sessionId);
    if (current !== null) current = reconcile(current);
  }
  if (current === null) throw new Error(`session ${sessionId} vanished while waiting`);
  return current;
}

/** await: the answer if the turn is done, else block up to timeoutS
 * (default and max MAX_WAIT_S; 0 = the current state at once). */
export async function awaitTurn(sessionId: string, timeoutS?: number): Promise<TurnState> {
  const { record } = locate(sessionId);
  if (record.status !== "running") return project(record);
  const boundedS = Math.min(Math.max(0, timeoutS ?? MAX_WAIT_S), MAX_WAIT_S);
  return project(await settle(sessionId, record, boundedS * 1000));
}

// The supervisor's hygiene after a kill is bounded (finalize capped at 15 s),
// so a cancel that has not finalized by now points at a stuck supervisor.
const CANCEL_SETTLE_MS = 30_000;

/** cancel: stop the running turn through its supervisor (SIGTERM → the same
 * reap path as the deadline: kill tree, hygiene, evidence kept), and return
 * once the session is finalized. A finished turn is returned unchanged. */
export async function cancel(sessionId: string): Promise<TurnState> {
  const { record } = locate(sessionId);
  if (record.status !== "running") return project(record);
  if (record.supervisor_pid === undefined) {
    throw new Error(`session ${sessionId} has no supervisor recorded yet; try again in a moment`);
  }
  try {
    process.kill(record.supervisor_pid, "SIGTERM");
  } catch {
    /* already gone: reconcile finalizes it on the next read */
  }
  const settled = await settle(sessionId, record, CANCEL_SETTLE_MS);
  if (settled.status === "running") {
    throw new Error(
      `cancel signalled supervisor ${record.supervisor_pid} but the turn is still running after ` +
        `${CANCEL_SETTLE_MS / 1000}s; inspect ${sessionId}`,
    );
  }
  return project(settled);
}

// Inspect returns raw evidence with honest truncation: enormous streams are
// capped, and the caps say so alongside the on-disk paths that hold it all.
const INSPECT_MAX_EVENTS = 500;
const INSPECT_MAX_TEXT = 200_000;
const INSPECT_MAX_STDERR = 32_768;

function capText(text: string | null, cap: number): { text: string | null; truncated: boolean } {
  if (text === null) return { text: null, truncated: false };
  if (text.length <= cap) return { text, truncated: false };
  return { text: `…[${text.length - cap} chars truncated; full file on disk]\n` + text.slice(-cap), truncated: true };
}

export interface InspectResult {
  session_id: string;
  session: SessionRecord;
  session_dir: string;
  prompt: { text: string | null; truncated: boolean };
  spawn: unknown;
  acknowledged_bundle: unknown;
  events: { count: number; returned: number; parsed: unknown[] };
  error: { text: string | null; truncated: boolean };
  final: { text: string | null; truncated: boolean };
  stderr_tail: { text: string | null; truncated: boolean };
  supervisor_log: { text: string | null; truncated: boolean };
}

export function inspect(sessionId: string): InspectResult {
  const { dir, record } = locate(sessionId);
  const eventsRaw = readEvidenceFrom(dir, "events.jsonl") ?? "";
  const lines = eventsRaw.split("\n").filter((l) => l.trim() !== "");
  const kept = lines.slice(-INSPECT_MAX_EVENTS);
  const parsed = kept.map((l) => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      return { unparsable_event_line: l };
    }
  });

  const parseJson = (file: string): unknown => {
    const raw = readEvidenceFrom(dir, file);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { unparsable_file: file, raw };
    }
  };

  return {
    session_id: record.session_id,
    session: record,
    session_dir: dir,
    prompt: capText(readEvidenceFrom(dir, "prompt.txt"), INSPECT_MAX_TEXT),
    spawn: parseJson("spawn.json"),
    acknowledged_bundle: parseJson("ack.json"),
    events: { count: lines.length, returned: kept.length, parsed },
    error: capText(readEvidenceFrom(dir, "error.txt"), INSPECT_MAX_TEXT),
    final: capText(readEvidenceFrom(dir, "final.txt"), INSPECT_MAX_TEXT),
    stderr_tail: capText(readEvidenceFrom(dir, "stderr.log"), INSPECT_MAX_STDERR),
    supervisor_log: capText(readEvidenceFrom(dir, "supervisor.log"), INSPECT_MAX_STDERR),
  };
}
