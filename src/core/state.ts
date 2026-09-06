// core/state.ts — Subturn's file-based state. A session's dir is keyed by
// the HARNESS'S OWN session id (AGENTS.md: the native id is THE id) under
// ~/.local/state/subturn/sessions/<session-id>/. A brand-new launch runs
// in a staging dir (~/.../staging/<random>/) until the harness produces its
// id; the id then appears as a sessions/<id> symlink to the staging dir
// (renaming mid-run would break the shadow-home paths the harness child was
// spawned with), and the supervisor swaps the symlink for the real dir when
// the turn ends. If a harness ever rotates ids on resume, the dir is renamed
// to the new id and the old id stays resolvable via an alias symlink.
// Nothing here may assume an id was born in Subturn — no prefixes, no
// formats; lookups go through this record store.
//
// Session directory layout (all files owned by the supervisor except the
// initial writes done by launch/resume):
//   record.json     — the snapshot `await` reads (status, timing, bundle, ids)
//   prompt.txt      — the current turn's prompt, verbatim
//   spawn.json      — argv, cwd, env delta, shadow-home note (evidence)
//   events.jsonl    — parsed event stream, appended as it happens (evidence)
//   stderr.log      — child stderr, raw (evidence)
//   ack.json        — harness-acknowledged bundle where the protocol echoes one
//   final.txt       — final message text of the latest completed turn
//   error.txt       — failure detail; every `failed` status is explained here
//   supervisor.log  — the supervisor's own stdout/stderr (evidence of Subturn itself)
//   home/           — the harness's per-session shadow home (persists across
//                     turns; retention keeps it for the whole resume window)
//   parked/         — harness session files moved out of the user's harness
//                     home after each turn (claude); restored on resume

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type SessionStatus = "running" | "completed" | "failed" | "cancelled";

export interface Usage {
  /** Uncached prompt tokens as the harness reports them (claude and grok
   * report cache hits separately — see the cache_* fields). */
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  cost_usd?: number;
}

/** The snapshot in record.json — everything resume needs (harness, bundle,
 * cwd, ids) plus the latest turn's state. `await` returns a projection of
 * this and nothing more; every "why" lives in the evidence files (inspect). */
export interface SessionRecord {
  /** The harness's own session id, bare and unmodified. Empty string only
   * while a fresh launch is still waiting for the harness to produce it. */
  session_id: string;
  /** Earlier ids of this session, if the harness ever rotated them on
   * resume. Each stays resolvable via an alias symlink. */
  previous_session_ids?: string[];
  harness: string;
  model: string;
  effort: string;
  cwd: string;
  /** resolved harness binary, pinned at admission. */
  bin_path?: string;
  /** the admission-time auth check result (evidence). */
  auth_detail?: string;
  /** state of the LATEST turn (turns of one conversation are sequential). */
  status: SessionStatus;
  /** 1-based turn counter; bumped by resume admission. */
  turn: number;
  /** session birth (first launch admission). */
  created_at: string;
  /** when the latest turn was admitted (launch or resume call). */
  turn_started_at: string;
  /** when the latest turn's supervisor actually started. */
  started_at?: string;
  /** the latest turn's reaper moment. */
  deadline_at: string;
  /** when the latest turn finished. */
  finished_at?: string;
  /** pid of the latest turn's detached supervisor. */
  supervisor_pid?: number;
  /** pid of the harness child once spawned. */
  child_pid?: number;
  /** set on completed turns when cheaply extractable. */
  usage?: Usage;
  /** true when the deadline reaper killed the latest turn (a caller's
   * cancel shows as status "cancelled" instead). */
  reaped?: boolean;
}

/** Every live descendant of `root`. Must be read BEFORE root dies: a child
 * of a dead process is reparented to init and the link is gone. Harness tool
 * shells often sit in their own process group (Claude Code detaches its Bash
 * tool that way), so a group kill of the harness alone leaves them running. */
function listDescendants(root: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of children.get(parent) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** SIGKILL a harness child and everything it spawned: the descendants are
 * collected first, then each pid and its process group is killed. Safe to
 * call repeatedly and on pids that are already gone. */
export function killTree(root: number): void {
  const descendants = listDescendants(root);
  for (const pid of [root, ...descendants]) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader, or gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}

export function stateDir(): string {
  const override = process.env["SUBTURN_STATE_DIR"];
  if (override !== undefined && override !== "") return override;
  return path.join(homedir(), ".local", "state", "subturn");
}

export function sessionsDir(): string {
  return path.join(stateDir(), "sessions");
}

export function stagingDir(): string {
  return path.join(stateDir(), "staging");
}

/** Path-safety only — NEVER an id-format check (native ids are the
 * harnesses' own; we may not assume anything about their shape). */
export function isSafeId(value: string): boolean {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= 250 &&
    !value.startsWith(".") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsDir(), sessionId);
}

// ---- dir-addressed primitives (the supervisor works on a dir that may be
// staged or adopted; id-addressed helpers below resolve through the store).

export function writeRecordTo(dir: string, record: SessionRecord): void {
  const tmp = path.join(dir, `.record.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path.join(dir, "record.json"));
}

export function readRecordFrom(dir: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "record.json"), "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

export function appendEventTo(dir: string, event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(path.join(dir, "events.jsonl"), line + "\n");
}

export function writeEvidenceTo(dir: string, file: string, content: string): void {
  writeFileSync(path.join(dir, file), content);
}

export function readEvidenceFrom(dir: string, file: string): string | null {
  try {
    return readFileSync(path.join(dir, file), "utf8");
  } catch {
    return null;
  }
}

// ---- id-addressed store: how faces (check/inspect/resume) find a session.

/** Resolve a session id to its dir, or null. Follows alias symlinks (old
 * rotated ids, mid-run staging links) transparently. */
export function resolveSessionDir(sessionId: string): string | null {
  if (!isSafeId(sessionId)) return null;
  const dir = sessionDir(sessionId);
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

export function readSession(sessionId: string): SessionRecord | null {
  const dir = resolveSessionDir(sessionId);
  if (dir === null) return null;
  return readRecordFrom(dir);
}

export function readEvidence(sessionId: string, file: string): string | null {
  const dir = resolveSessionDir(sessionId);
  if (dir === null) return null;
  return readEvidenceFrom(dir, file);
}

/** Create the staging dir for a fresh launch (no session id yet). */
export function createStaging(record: SessionRecord, prompt: string): string {
  const dir = path.join(stagingDir(), `stage-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "prompt.txt"), prompt);
  writeRecordTo(dir, record);
  return dir;
}

/** Publish a staged session under its native id: sessions/<id> becomes a
 * symlink to the staging dir. Called by the supervisor the moment the
 * harness reports its id; the record must already carry it. */
export function linkStaged(nativeId: string, stagedDir: string): void {
  mkdirSync(sessionsDir(), { recursive: true });
  const link = sessionDir(nativeId);
  try {
    rmSync(link, { force: true });
  } catch { /* nothing there */ }
  symlinkSync(stagedDir, link);
}

/** Turn-end adoption: replace the sessions/<id> symlink with the real dir.
 * Only safe once the harness child is gone (its shadow-home paths die with
 * the rename). Idempotent; a crash before this leaves the symlink working. */
export function adoptStaged(nativeId: string, stagedDir: string): string {
  const dest = sessionDir(nativeId);
  try {
    if (lstatSync(dest).isSymbolicLink()) rmSync(dest);
  } catch { /* no link — first adoption or already adopted */ }
  if (!existsSync(dest)) renameSync(stagedDir, dest);
  // Leave a forwarding symlink at the staging path: a launch call still
  // polling it (turn finished at bring-up speed) reads the adopted record
  // through it. Swept with the rest of staging.
  try {
    symlinkSync(dest, stagedDir);
  } catch { /* forwarding is best-effort */ }
  return dest;
}

/** Id rotation on resume (hypothetical, absorbed here so no caller ever
 * tracks it): rename the dir to the new id and leave the old id resolvable
 * as an alias symlink. Returns the new dir. */
export function rotateSessionId(dir: string, oldId: string, newId: string): string {
  const record = readRecordFrom(dir);
  const dest = sessionDir(newId);
  renameSync(dir, dest);
  try {
    rmSync(sessionDir(oldId), { force: true });
  } catch { /* nothing stale */ }
  symlinkSync(dest, sessionDir(oldId));
  if (record !== null) {
    record.previous_session_ids = [...(record.previous_session_ids ?? []), oldId];
    record.session_id = newId;
    writeRecordTo(dest, record);
  }
  return dest;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lazy consistency: a turn stuck in "running" whose supervisor is gone
 * (crash, machine reboot) is finalized as failed at read time. The deadline
 * stays the only *scheduled* reaper; this is bookkeeping for a reaper that
 * died with its session.
 */
export function reconcile(record: SessionRecord): SessionRecord {
  if (record.status !== "running") return record;
  const supervisorGone =
    record.supervisor_pid === undefined || !isPidAlive(record.supervisor_pid);
  if (!supervisorGone) return record;
  // Grace: a freshly admitted turn may not have its supervisor pid yet.
  const ageMs = Date.now() - Date.parse(record.turn_started_at ?? record.created_at);
  if (record.supervisor_pid === undefined && ageMs < 30_000) return record;
  const failed: SessionRecord = {
    ...record,
    status: "failed",
    finished_at: new Date().toISOString(),
  };
  try {
    const dir = resolveSessionDir(record.session_id);
    if (dir === null) return failed;
    const existing = readEvidenceFrom(dir, "error.txt") ?? "";
    writeEvidenceTo(
      dir,
      "error.txt",
      existing +
        `supervisor process ${record.supervisor_pid ?? "(never recorded)"} is gone while the turn was still running; finalized at read time\n`,
    );
    if (record.child_pid !== undefined && isPidAlive(record.child_pid)) killTree(record.child_pid);
    writeRecordTo(dir, failed);
  } catch {
    /* read-time reconciliation is best-effort */
  }
  return failed;
}

/** Evidence retention = the resumability window: 7 days by default,
 * SUBTURN_RETENTION_DAYS overrides. Shadow homes and parked harness files
 * live inside the session dir, so they share the window — nothing deletes
 * them earlier, and GC of the dir is what ends resumability. */
function retentionDays(): number {
  const env = Number(process.env["SUBTURN_RETENTION_DAYS"]);
  return Number.isFinite(env) && env > 0 ? env : 7;
}

function expired(rec: SessionRecord | null, entryPath: string, cutoff: number): boolean {
  if (rec === null) {
    try {
      return statSync(entryPath).mtimeMs < cutoff; // unreadable: by mtime
    } catch {
      return false;
    }
  }
  // A "running" record whose supervisor died is finished for our purposes.
  if (reconcile(rec).status === "running") return false;
  return Date.parse(rec.finished_at ?? rec.turn_started_at ?? rec.created_at) < cutoff;
}

export interface SweepResult {
  /** sessions deleted (evidence and all — no longer resumable). */
  removed: number;
  /** sessions with a turn still running, left alone. */
  running: number;
}

/** Retention GC. Called opportunistically from launch (never fails one) and
 * on demand by CLI `prune` (days = 0: everything not running). */
export function sweepExpired(days = retentionDays()): SweepResult {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const removed = new Set<string>();
  const running = new Set<string>();
  // A mid-run session is reachable twice (sessions/<id> → staging/<x>), so
  // sessions are counted by real path.
  const sweep = (dir: string, entry: string): void => {
    let key = dir;
    try {
      key = realpathSync(dir);
    } catch { /* about to be removed or already gone; the raw path will do */ }
    const rec = readRecordFrom(dir);
    if (expired(rec, dir, cutoff)) {
      rmSync(dir, { recursive: true, force: true });
      if (entry !== dir) rmSync(entry, { force: true });
      removed.add(key);
    } else if (rec !== null && rec.status === "running") {
      running.add(key);
    }
  };
  // sessions/: real dirs, alias symlinks, and mid-run staging links.
  let entries: string[] = [];
  try {
    entries = readdirSync(sessionsDir());
  } catch { /* nothing yet */ }
  for (const entry of entries) {
    const p = path.join(sessionsDir(), entry);
    try {
      const lst = lstatSync(p);
      if (lst.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(p);
        } catch {
          rmSync(p, { force: true }); // dangling alias
          continue;
        }
        sweep(target, p);
        continue;
      }
      sweep(p, p);
    } catch { /* never let GC fail a launch */ }
  }
  // staging/: pre-id failures and orphans (anything old enough).
  let staged: string[] = [];
  try {
    staged = readdirSync(stagingDir());
  } catch { /* nothing yet */ }
  for (const entry of staged) {
    const p = path.join(stagingDir(), entry);
    try {
      if (lstatSync(p).isSymbolicLink()) {
        // Forwarding link left by adoption: drop it once its target is gone.
        if (!existsSync(p)) rmSync(p, { force: true });
        continue;
      }
      sweep(p, p);
    } catch { /* never let GC fail a launch */ }
  }
  return { removed: removed.size, running: running.size };
}
