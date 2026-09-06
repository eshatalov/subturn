// test/core.test.ts — the async session flow against the fake ACP agent:
// launch failures as plain errors (no pseudo-sessions), native-id return,
// the resume flow (sequential-turn guard, replay isolation, context echo),
// the permission posture, await long-polling, and the deadline reaper. No
// real harness is ever launched here; the fake plugin exercises the
// identical path (detached supervisor, ACP client, evidence files).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = mkdtempSync(path.join(tmpdir(), "subturn-test-"));
process.env["SUBTURN_STATE_DIR"] = path.join(stateRoot, "state");
process.env["SUBTURN_FAKE_AGENT"] = path.join(here, "fake-agent.mjs");

const workDir = path.join(stateRoot, "work");
mkdirSync(workDir, { recursive: true });

// Import AFTER the env is pinned (modules read env lazily, but be explicit).
const { spawn, resume, awaitTurn, cancel, inspect } = await import("../src/core/core.ts");
const { MAX_WAIT_S } = await import("../src/core/limits.ts");
const { readSession, sessionsDir, rotateSessionId, resolveSessionDir, sessionDir } =
  await import("../src/core/state.ts");

test.after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    harness: "fake",
    model: "fake-model-1",
    effort: "high",
    prompt: "say hello",
    cwd: workDir,
    ...overrides,
  } as Parameters<typeof spawn>[0];
}

function listSessions(): string[] {
  try {
    return readdirSync(sessionsDir());
  } catch {
    return [];
  }
}

test("launch failures before a session exists are plain errors — no pseudo-session", async () => {
  const before = listSessions();
  await assert.rejects(() => spawn(baseInput({ harness: "nonesuch" })), /unknown harness "nonesuch".*fake/s);
  await assert.rejects(() => spawn(baseInput({ effort: "" })), /spawn: missing effort \(required: harness, model, effort, prompt, cwd\)/);
  await assert.rejects(() => spawn(baseInput({ cwd: "relative/path" })), /cwd must be an absolute path/);
  // Every missing field in one message, so a caller never learns them one per call.
  await assert.rejects(
    () => spawn({ harness: "fake", cwd: baseInput().cwd } as never),
    /spawn: missing model, effort, prompt \(required: harness, model, effort, prompt, cwd\)$/,
  );
  await assert.rejects(() => resume({} as never), /resume: missing session_id, prompt \(required: session_id, prompt\)$/);
  process.env["SUBTURN_FAKE_AUTH_FAIL"] = "1";
  try {
    await assert.rejects(() => spawn(baseInput()), /not authorized.*deliberately failing/s);
  } finally {
    delete process.env["SUBTURN_FAKE_AUTH_FAIL"];
  }
  assert.deepEqual(listSessions(), before, "failed launches must not create sessions");
});

test("child dead before emitting a session id: plain error with spawn + stderr + exit inline", async () => {
  process.env["FAKE_MODE"] = "die";
  const before = listSessions();
  try {
    await assert.rejects(
      () => spawn(baseInput()),
      (e: Error) => {
        assert.match(e.message, /before the harness produced a session/);
        assert.match(e.message, /auth check: fake plugin always authorized/);
        assert.match(e.message, /"type":"spawn"/, "the exact argv must be inline");
        assert.match(e.message, /fake agent dying before any session exists/, "stderr must be inline");
        return true;
      },
    );
  } finally {
    delete process.env["FAKE_MODE"];
  }
  assert.deepEqual(listSessions(), before, "a pre-session failure must not create a session");
});

test("end-to-end: launch returns the harness's own session id; await long-polls to completed", async () => {
  delete process.env["FAKE_MODE"];
  const t0 = Date.now();
  const res = await spawn(baseInput());
  assert.equal(res.status, "running");
  assert.ok(Date.now() - t0 < 10_000, "launch must return within seconds");
  // The id is the fake harness's own, unprefixed and unmodified.
  assert.match(res.session_id, /^fake-session-[0-9a-f]{12}$/);

  const done = await awaitTurn(res.session_id, 30);
  assert.equal(done.status, "completed");
  assert.equal(done.turn, 1);
  assert.ok(done.final_text?.includes("Hello from the fake agent"));
  assert.ok(done.final_text?.includes("model=fake-model-1"));
  assert.ok(done.final_text?.includes("effort=high"));
  assert.equal(done.usage?.input_tokens, 120);
  assert.equal(done.usage?.output_tokens, 45);
  // The acknowledged bundle rides on await: a substitution is visible
  // without inspect.
  assert.deepEqual(done.bundle, { model: "fake-model-1", effort: "high" });

  // The session dir is keyed by the native id (adopted from staging).
  const dir = resolveSessionDir(res.session_id);
  assert.ok(dir !== null && dir.endsWith(res.session_id));

  // await states the outcome; inspect explains: evidence must be complete.
  const evidence = inspect(res.session_id);
  assert.equal(evidence.session.status, "completed");
  assert.equal(evidence.session_id, res.session_id);
  const ack = evidence.acknowledged_bundle as Record<string, unknown>;
  assert.equal((ack["requested"] as Record<string, unknown>)["model"], "fake-model-1");
  const eventTypes = (evidence.events.parsed as Array<Record<string, unknown>>).map((e) => e["type"]);
  assert.ok(eventTypes.includes("spawn"));
  assert.ok(eventTypes.includes("native_session_id"));
  assert.ok(eventTypes.includes("session_new_result"));
  assert.ok(eventTypes.includes("non_json_line")); // the junk boot line is evidence
  assert.ok(eventTypes.includes("prompt_result"));
});

test("resume: same id, same bundle, context carried, replay never leaks into final text", async () => {
  delete process.env["FAKE_MODE"];
  const res = await spawn(baseInput({ prompt: "first turn" }));
  await awaitTurn(res.session_id, 30);

  const resumed = await resume({ session_id: res.session_id, prompt: "second turn" });
  assert.equal(resumed.session_id, res.session_id, "resume must repeat the current id");
  assert.equal(resumed.status, "running");

  const done = await awaitTurn(res.session_id, 30);
  assert.equal(done.status, "completed");
  assert.equal(done.turn, 2);
  // The fake echoes the loaded id: proves session/load carried the session.
  assert.ok(done.final_text?.includes(`Resumed ${res.session_id}`));
  // The bundle was re-applied explicitly on the resumed turn.
  assert.ok(done.final_text?.includes("model=fake-model-1"));
  assert.ok(done.final_text?.includes("effort=high"));
  // Replayed history is evidence, never this turn's final text.
  assert.ok(!done.final_text?.includes("REPLAYED-HISTORY-MUST-NOT-LEAK"));
  const evidence = inspect(res.session_id);
  const types = (evidence.events.parsed as Array<Record<string, unknown>>).map((e) => e["type"]);
  assert.ok(types.includes("session_update_replay"), "the replay must still be in evidence");
  assert.ok(types.includes("session_load_result"));
});

test("resume: unknown or GC'd id is a plain error; running turn refuses a second one", async () => {
  await assert.rejects(() => resume({ session_id: "never-existed", prompt: "hi" }), /unknown session/);
  await assert.rejects(() => resume({ session_id: "../etc", prompt: "hi" }), /session_id is required/);

  process.env["FAKE_MODE"] = "hang";
  try {
    const res = await spawn(baseInput({ prompt: "hang", timeout: 15 }));
    await assert.rejects(
      () => resume({ session_id: res.session_id, prompt: "too soon" }),
      /still has a turn running.*sequential/s,
    );
    // Cleanup: let the reaper finish it fast.
    const record = readSession(res.session_id);
    if (record?.supervisor_pid !== undefined) {
      try { process.kill(record.supervisor_pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (record?.child_pid !== undefined) {
      try { process.kill(-record.child_pid, "SIGKILL"); } catch { /* gone */ }
    }
  } finally {
    delete process.env["FAKE_MODE"];
  }
});

test("posture: a permission request is auto-answered with the most permissive option", async () => {
  process.env["FAKE_MODE"] = "permission";
  try {
    const res = await spawn(baseInput({ prompt: "do the risky thing" }));
    const done = await awaitTurn(res.session_id, 30);
    assert.equal(done.status, "completed");
    assert.ok(done.final_text?.includes("permission granted"));
    const evidence = inspect(res.session_id);
    const perm = (evidence.events.parsed as Array<Record<string, unknown>>)
      .find((e) => e["type"] === "permission_request");
    assert.ok(perm !== undefined, "permission event must be in evidence");
    assert.equal(perm["auto_selected"], "yes-always");
  } finally {
    delete process.env["FAKE_MODE"];
  }
});

test("configure failure after the id exists: failed turn with raw rpc evidence", async () => {
  process.env["FAKE_MODE"] = "badeffort";
  try {
    const res = await spawn(baseInput({ effort: "nonsense" }));
    // The id existed (session/new succeeded), so this is a session that
    // failed — discovered via await, diagnosed via inspect.
    const done = await awaitTurn(res.session_id, 30);
    assert.equal(done.status, "failed");
    // await never explains…
    assert.equal(done.final_text, undefined);
    // …inspect does.
    const evidence = inspect(res.session_id);
    assert.ok(evidence.error.text?.includes("-32602"));
    assert.ok(evidence.error.text?.includes("invalid effort: nonsense"));
  } finally {
    delete process.env["FAKE_MODE"];
  }
});

test("deadline is the only reaper: a hung turn is killed and finalized, evidence kept", async () => {
  process.env["FAKE_MODE"] = "hang";
  try {
    const res = await spawn(baseInput({ prompt: "hang forever", timeout: 3 }));
    assert.equal(res.status, "running");
    const done = await awaitTurn(res.session_id, 30);
    assert.equal(done.status, "failed");
    const record = readSession(res.session_id);
    assert.equal(record?.reaped, true);
    const evidence = inspect(res.session_id);
    assert.ok(evidence.error.text?.includes("deadline exceeded"));
    // The harness child must actually be dead.
    const childPid = record?.child_pid;
    assert.ok(childPid !== undefined);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(childPid, 0), "harness child must be killed by the reaper");
  } finally {
    delete process.env["FAKE_MODE"];
  }
});

test("await: timeout 0 is an immediate snapshot; unknown ids refused; wait capped at 300", async () => {
  const res = await spawn(baseInput());
  const snap = await awaitTurn(res.session_id, 0);
  assert.ok(["running", "completed"].includes(snap.status));
  await awaitTurn(res.session_id, 30); // drain
  await assert.rejects(() => awaitTurn("never-existed-id"), /unknown session/);
  await assert.rejects(() => awaitTurn("has/slash"), /session_id is required/);
  assert.equal(MAX_WAIT_S, 300);
});

test("prune (sweep with a zero window) removes every finished session and keeps running ones", async () => {
  const { sweepExpired } = await import("../src/core/state.ts");
  delete process.env["FAKE_MODE"];
  const done = await spawn(baseInput({ prompt: "quick" }));
  await awaitTurn(done.session_id, 30);
  process.env["FAKE_MODE"] = "hang";
  let hung;
  try {
    hung = await spawn(baseInput({ prompt: "hang", timeout: 20 }));
  } finally {
    delete process.env["FAKE_MODE"];
  }

  const result = sweepExpired(0);
  assert.equal(result.running, 1);
  assert.ok(result.removed >= 1, "the finished session must go");
  assert.throws(() => inspect(done.session_id), /unknown session/);
  assert.equal(inspect(hung.session_id).session.status, "running", "a running session is never pruned");
  await cancel(hung.session_id);
});

test("inspect works on a running session (evidence streams to disk, id-addressed mid-run)", async () => {
  process.env["FAKE_MODE"] = "hang";
  try {
    const res = await spawn(baseInput({ prompt: "hang", timeout: 20 }));
    let evidence = inspect(res.session_id);
    const deadlineAt = Date.now() + 10_000;
    while (Date.now() < deadlineAt) {
      evidence = inspect(res.session_id);
      const types = (evidence.events.parsed as Array<Record<string, unknown>>).map((e) => e["type"]);
      if (types.includes("session_new_result")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(evidence.session.status, "running");
    const types = (evidence.events.parsed as Array<Record<string, unknown>>).map((e) => e["type"]);
    assert.ok(types.includes("session_new_result"), "mid-run evidence must show the handshake");
    // Mid-run the id resolves through the staging link.
    assert.ok(resolveSessionDir(res.session_id) !== null);
    // Cleanup: don't leave the hung session past the test file's lifetime.
    const record = readSession(res.session_id);
    if (record?.supervisor_pid !== undefined) {
      try { process.kill(record.supervisor_pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (record?.child_pid !== undefined) {
      try { process.kill(-record.child_pid, "SIGKILL"); } catch { /* gone */ }
    }
  } finally {
    delete process.env["FAKE_MODE"];
  }
});

test("id rotation is absorbed: dir renamed, old id stays resolvable, record updated", async () => {
  // Unit-level: no harness rotates today, but the mechanism must hold.
  const res = await spawn(baseInput());
  await awaitTurn(res.session_id, 30);
  const oldId = res.session_id;
  const newId = `rotated-${oldId}`;
  const dir = resolveSessionDir(oldId);
  assert.ok(dir !== null);
  rotateSessionId(dir, oldId, newId);
  const viaOld = readSession(oldId);
  const viaNew = readSession(newId);
  assert.equal(viaOld?.session_id, newId, "old id resolves to the record with the CURRENT id");
  assert.equal(viaNew?.session_id, newId);
  assert.deepEqual(viaOld?.previous_session_ids, [oldId]);
  assert.ok(existsSync(sessionDir(newId)));
  // await through the old id reports the current id.
  const checked = await awaitTurn(oldId);
  assert.equal(checked.session_id, newId);
});

test("staging leaves nothing addressable behind for pre-id failures", async () => {
  process.env["FAKE_MODE"] = "die";
  try {
    await assert.rejects(() => spawn(baseInput()));
  } finally {
    delete process.env["FAKE_MODE"];
  }
  // Staging evidence may exist on disk (GC'd later) but is not a session.
  for (const entry of listSessions()) {
    const rec = readSession(entry);
    assert.ok(rec === null || rec.session_id !== "", "no id-less session may be addressable");
  }
});

test("cancel: stops a running turn through its supervisor; evidence kept; the session stays resumable", async () => {
  process.env["FAKE_MODE"] = "hang";
  let res: { session_id: string };
  try {
    res = await spawn(baseInput({ prompt: "hang", timeout: 120 }));
  } finally {
    delete process.env["FAKE_MODE"];
  }
  const cancelled = await cancel(res.session_id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(readSession(res.session_id)?.status, "cancelled");
  const evidence = inspect(res.session_id);
  assert.match(evidence.error.text ?? "", /cancelled by the caller/);
  const types = (evidence.events.parsed as Array<Record<string, unknown>>).map((e) => e["type"]);
  assert.ok(types.includes("cancelled"), "the reap is on the event stream");
  // A finished turn is returned unchanged.
  assert.equal((await cancel(res.session_id)).status, "cancelled");
  // await agrees, and never explains.
  const seen = await awaitTurn(res.session_id, 0);
  assert.equal(seen.status, "cancelled");
  assert.equal(seen.final_text, undefined);
  // The conversation goes on.
  const resumed = await resume({ session_id: res.session_id, prompt: "after cancel" });
  const done = await awaitTurn(resumed.session_id, 30);
  assert.equal(done.status, "completed");
  assert.equal(done.turn, 2);
  await assert.rejects(() => cancel("never-existed-id"), /unknown session/);
});
