// core/supervisor.ts — the per-turn supervisor process. Launch and resume
// (any face) spawn this detached, so a one-shot CLI invocation can exit
// while the subagent runs, and an MCP server restart can't orphan a turn.
//
// The supervisor is the only writer of record.json after handoff, the only
// reaper (deadline or cancel: kill + finalize + keep evidence), and the process
// the plugin's launch() actually runs in. It is also where the native
// session id becomes the session's address: on turn 1 it publishes
// sessions/<id> as a symlink to the staging dir the moment the harness
// reports its id, then writes the id into the record (that write is what
// unblocks the caller's spawn), and it swaps the symlink for the real dir
// when the turn ends. A rotated id on a resumed turn is absorbed the same
// way (rename + alias symlink).
//
// Usage: node supervisor.js <sessionDir>

import path from "node:path";
import { readFileSync } from "node:fs";

import {
  readRecordFrom,
  writeRecordTo,
  appendEventTo,
  writeEvidenceTo,
  readEvidenceFrom,
  linkStaged,
  adoptStaged,
  rotateSessionId,
  isSafeId,
  killTree,
  type SessionRecord,
  type SessionStatus,
} from "./state.ts";
import { loadPlugin } from "../plugins/index.ts";
import type { LaunchContext, LaunchOutcome } from "../plugins/types.ts";

async function main(): Promise<void> {
  const startDir = process.argv[2];
  if (startDir === undefined) {
    console.error("usage: supervisor <sessionDir>");
    process.exit(2);
  }
  // Adoption and id rotation change the evidence path at turn end.
  let dir = startDir;
  const record = readRecordFrom(dir);
  if (record === null) {
    console.error(`no record.json under ${dir}`);
    process.exit(2);
  }
  const isFirstTurn = record.session_id === "";
  let nativeId = record.session_id; // "" until the harness reports one
  let rotatedFrom: string | null = null;

  record.supervisor_pid = process.pid;
  record.started_at = new Date().toISOString();
  writeRecordTo(dir, record);
  appendEventTo(dir, { type: "supervisor_started", pid: process.pid, turn: record.turn });
  // Per-turn prompt history lives in the event stream (prompt.txt holds only
  // the current turn's prompt).
  try {
    appendEventTo(dir, {
      type: "turn_prompt",
      turn: record.turn,
      prompt: readFileSync(path.join(dir, "prompt.txt"), "utf8"),
    });
  } catch { /* prompt read failure is reported below */ }

  const childPids: number[] = [];
  // Kill the whole tree, not just the harness's group: tool shells the
  // harness detached into their own groups would otherwise outlive the turn.
  const killChildren = (): void => {
    for (const pid of childPids) killTree(pid);
  };

  const failTurn = (error: string, reaped: boolean, status: SessionStatus = "failed"): void => {
    const existing = readEvidenceFrom(dir, "error.txt");
    writeEvidenceTo(dir, "error.txt", (existing ?? "") + error + "\n");
    const current = readRecordFrom(dir) ?? record;
    const final: SessionRecord = {
      ...current,
      status,
      finished_at: new Date().toISOString(),
      ...(reaped ? { reaped: true } : {}),
    };
    writeRecordTo(dir, final);
  };

  const plugin = await loadPlugin(record.harness);
  if (plugin === undefined) {
    failTurn(`no plugin for harness "${record.harness}"`, false);
    return;
  }
  const binPath = record.bin_path;
  if (binPath === undefined) {
    failTurn("record.json carries no bin_path (admission should have set it)", false);
    return;
  }
  let prompt: string;
  try {
    prompt = readFileSync(path.join(dir, "prompt.txt"), "utf8");
  } catch (e) {
    failTurn(`cannot read prompt.txt: ${String(e)}`, false);
    return;
  }

  const deadlineMs = Date.parse(record.deadline_at);

  let home: { env: Record<string, string>; note: string };
  try {
    home = await plugin.home(dir);
  } catch (e) {
    failTurn(`shadow home build failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`, false);
    return;
  }

  writeEvidenceTo(dir, "spawn.json", JSON.stringify({
    harness: record.harness,
    bin_path: binPath,
    cwd: record.cwd,
    turn: record.turn,
    env_delta: home.env,
    shadow_home_note: home.note,
    auth_detail: record.auth_detail ?? null,
    deadline_at: record.deadline_at,
    ...(isFirstTurn ? {} : { resumes_session_id: nativeId }),
  }, null, 2));

  let reaped = false; // set by reap() below; onChildPid consults it
  const ctx: LaunchContext = {
    binPath,
    model: record.model,
    effort: record.effort,
    prompt,
    cwd: record.cwd,
    sessionDir: dir,
    turn: record.turn,
    nativeSessionId: isFirstTurn ? undefined : nativeId,
    deadlineMs,
    env: home.env,
    emit: (event) => appendEventTo(dir, event),
    writeEvidence: (file, content) => writeEvidenceTo(dir, file, content),
    onChildPid: (pid) => {
      childPids.push(pid);
      if (reaped) killTree(pid); // a reap already ran; nothing may outlive it
      const current = readRecordFrom(dir) ?? record;
      current.child_pid = pid;
      writeRecordTo(dir, current);
    },
    onNativeSessionId: (id) => {
      if (!isSafeId(id)) {
        appendEventTo(dir, { type: "native_session_id_unsafe", id });
        return;
      }
      appendEventTo(dir, { type: "native_session_id", id, turn: record.turn });
      ctx.nativeSessionId = id; // keep current for plugin.finalize (parking)
      if (isFirstTurn && nativeId === "") {
        nativeId = id;
        // Address before announcement: sessions/<id> must resolve before the
        // record carries the id, because the id in the record is what returns
        // the caller's spawn, and its very next call may be inspect or await.
        try {
          linkStaged(id, dir);
        } catch (e) {
          appendEventTo(dir, { type: "link_staged_failed", error: String(e) });
        }
        const current = readRecordFrom(dir) ?? record;
        current.session_id = id;
        writeRecordTo(dir, current);
        return;
      }
      if (!isFirstTurn && id !== nativeId && rotatedFrom === null) {
        // The harness rotated ids on resume. Absorb: record the new current
        // id now (the dir is renamed at turn end, when the child is gone).
        rotatedFrom = nativeId;
        nativeId = id;
        const current = readRecordFrom(dir) ?? record;
        current.previous_session_ids = [...(current.previous_session_ids ?? []), rotatedFrom];
        current.session_id = id;
        writeRecordTo(dir, current);
        appendEventTo(dir, { type: "session_id_rotated", from: rotatedFrom, to: id });
      }
    },
  };

  // Post-turn hygiene: plugin.finalize (claude parks its session files) plus
  // the dir's move to its final address. Runs on every path, bounded.
  let sealed = false;
  const sealTurn = async (): Promise<void> => {
    if (sealed) return;
    sealed = true;
    if (plugin.finalize !== undefined) {
      try {
        await Promise.race([
          plugin.finalize(ctx),
          new Promise<void>((r) => setTimeout(r, 15_000, undefined)),
        ]);
      } catch (e) {
        appendEventTo(dir, { type: "finalize_failed", error: String(e) });
      }
    }
    try {
      if (isFirstTurn && nativeId !== "") {
        dir = adoptStaged(nativeId, dir);
      } else if (rotatedFrom !== null) {
        dir = rotateSessionId(dir, rotatedFrom, nativeId);
      }
    } catch (e) {
      appendEventTo(dir, { type: "adopt_failed", error: String(e) });
    }
  };

  // Two reapers, one path: the deadline (scheduled) and cancel (core sends
  // SIGTERM). Either kills the child tree, runs hygiene, finalizes, keeps the
  // evidence. Fire-and-forget turns die at the deadline instead of hanging
  // on the user's subscription.
  let turnDone = false; // the plugin returned: a late cancel must not rewrite the outcome
  const reap = (status: SessionStatus, event: Record<string, unknown>, error: string): void => {
    if (reaped || turnDone) return;
    reaped = true;
    clearTimeout(reaperTimer);
    appendEventTo(dir, event);
    killChildren();
    // Hygiene still runs (parking must not be skipped on a reap); the record
    // flips only after it, so a fast resume can't race the parking. The
    // plugin promise below may still be settling; it no longer matters.
    void sealTurn().finally(() => {
      failTurn(error, status === "failed", status);
      setTimeout(() => process.exit(0), 250).unref();
    });
  };
  const msLeft = Math.max(0, deadlineMs - Date.now());
  const reaperTimer = setTimeout(
    () => reap("failed", { type: "deadline_reaped", deadline_at: record.deadline_at },
      `deadline exceeded (${record.deadline_at}); child tree killed, evidence kept`),
    msLeft,
  );
  process.on("SIGTERM", () =>
    reap("cancelled", { type: "cancelled" }, "cancelled by the caller; child tree killed, evidence kept"));

  let outcome: LaunchOutcome;
  try {
    outcome = await plugin.launch(ctx);
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.stack ?? e.message : String(e) };
  }
  clearTimeout(reaperTimer);
  if (reaped) return; // the reaper already finalized; evidence stands as-is
  turnDone = true;

  // Belt and braces: no harness child may outlive its turn (also required
  // before adoption — the rename must not race a live child's shadow paths).
  killChildren();

  // Hygiene BEFORE the final record write: the turn reads as finished only
  // once parking/adoption are done, so a fast resume can't race them.
  await sealTurn();

  if (outcome.ok) {
    writeEvidenceTo(dir, "final.txt", outcome.finalText ?? "");
    const current = readRecordFrom(dir) ?? record;
    const final: SessionRecord = {
      ...current,
      status: "completed",
      finished_at: new Date().toISOString(),
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    };
    writeRecordTo(dir, final);
    appendEventTo(dir, { type: "supervisor_finished", status: "completed", turn: record.turn });
  } else {
    failTurn(outcome.error ?? "launch failed without detail", false);
    appendEventTo(dir, { type: "supervisor_finished", status: "failed", turn: record.turn });
  }
}

main().catch((e) => {
  // Last resort: surface the crash in evidence if we can.
  try {
    const dir = process.argv[2] ?? "";
    const record = readRecordFrom(dir);
    if (record !== null && record.status === "running") {
      const existing = readEvidenceFrom(dir, "error.txt");
      writeEvidenceTo(
        dir,
        "error.txt",
        (existing ?? "") + `supervisor crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
      );
      writeRecordTo(dir, { ...record, status: "failed", finished_at: new Date().toISOString() });
    }
  } catch { /* nothing left to report to */ }
  console.error(e);
  process.exit(1);
});
