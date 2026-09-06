// test/live.test.ts — OPT-IN live smoke + resume against ONE real harness.
// Skipped unless SUBTURN_LIVE=1 (never runs in CI or a default `npm
// test`): it spends real quota — two turns (launch + resume) per invocation.
//   SUBTURN_LIVE=1 SUBTURN_LIVE_HARNESS=claude node --test test/live.test.ts
// SUBTURN_LIVE_MODEL / _EFFORT override the harness's default cheap
// bundle. SUBTURN_LIVE_KILL=1 runs the resume-after-deadline-kill probe
// instead (kill at ~20 s, then one resume; outcome reported honestly).
// SUBTURN_LIVE_CANCEL=1 runs the cancel probe: cancel ~10 s in, assert the
// harness AND its tool shells are gone, then one resume.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

const live = process.env["SUBTURN_LIVE"] === "1";
const kill = process.env["SUBTURN_LIVE_KILL"] === "1";
const cancelProbe = process.env["SUBTURN_LIVE_CANCEL"] === "1";
const harness = process.env["SUBTURN_LIVE_HARNESS"] ?? "opencode";

const cheapBundles: Record<string, { model: string; effort: string }> = {
  claude: { model: "claude-haiku-4-5-20251001", effort: "low" },
  codex: { model: "gpt-5.3-codex-spark", effort: "low" },
  grok: { model: "grok-4.6", effort: "low" },
  opencode: { model: "zai-coding-plan/glm-5.3-flash", effort: "low" },
};

const model = process.env["SUBTURN_LIVE_MODEL"] ?? cheapBundles[harness]?.model ?? "";
const effort = process.env["SUBTURN_LIVE_EFFORT"] ?? cheapBundles[harness]?.effort ?? "low";

const HASH_JOB =
  "python3 -c 'import hashlib\nh=b\"\"\nfor i in range(100_000_000): h=hashlib.sha256(h+str(i).encode()).digest()\nprint(h.hex())'";

function claudeProjectsHasSession(sessionId: string): boolean {
  const projects = path.join(
    process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homedir(), ".claude"),
    "projects",
  );
  try {
    for (const proj of readdirSync(projects)) {
      try {
        if (readdirSync(path.join(projects, proj)).some((f) => f.includes(sessionId))) return true;
      } catch { /* not a dir */ }
    }
  } catch { /* no projects dir */ }
  return false;
}

test(`live smoke + resume: ${harness} ${model}/${effort}`, { skip: !live || kill || cancelProbe }, async () => {
  const { spawn, resume, awaitTurn, inspect } = await import("../src/core/core.ts");
  const workDir = mkdtempSync(path.join(tmpdir(), "subturn-live-"));
  try {
    const res = await spawn({
      harness,
      model,
      effort,
      prompt: "Reply with exactly: ok",
      cwd: workDir,
      timeout: 300,
    });
    assert.equal(res.status, "running");
    assert.ok(res.session_id !== "", "launch must return the harness's own session id");
    console.log(`[live] ${harness} native session id: ${res.session_id}`);

    const done = await awaitTurn(res.session_id, 240);
    if (done.status !== "completed") {
      const evidence = inspect(res.session_id);
      assert.fail(`live turn 1 ${done.status}: ${JSON.stringify(evidence.error)}\nstderr: ${JSON.stringify(evidence.stderr_tail)}`);
    }
    assert.ok((done.final_text ?? "").toLowerCase().includes("ok"));

    if (harness === "claude") {
      assert.equal(
        claudeProjectsHasSession(res.session_id),
        false,
        "after the turn, the session must be parked out of ~/.claude/projects",
      );
    }

    const resumed = await resume({
      session_id: res.session_id,
      prompt: "Now reply with exactly: ok2",
      timeout: 300,
    });
    console.log(`[live] resume returned id: ${resumed.session_id}`);
    const done2 = await awaitTurn(resumed.session_id, 240);
    if (done2.status !== "completed") {
      const evidence = inspect(resumed.session_id);
      assert.fail(`live turn 2 ${done2.status}: ${JSON.stringify(evidence.error)}\nstderr: ${JSON.stringify(evidence.stderr_tail)}`);
    }
    assert.ok((done2.final_text ?? "").includes("ok2"), `turn 2 must show context/instruction held: ${done2.final_text}`);
    assert.equal(done2.turn, 2);

    if (harness === "claude") {
      assert.equal(claudeProjectsHasSession(res.session_id), false, "parked again after the resumed turn");
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test(`live kill-resume probe: ${harness} ${model}/${effort}`, { skip: !live || !kill }, async () => {
  const { spawn, resume, awaitTurn, inspect } = await import("../src/core/core.ts");
  const workDir = mkdtempSync(path.join(tmpdir(), "subturn-live-kill-"));
  try {
    const res = await spawn({
      harness,
      model,
      effort,
      // Foreground compute the model needs the result of, not a sleep or an
      // essay: fast models finish an essay inside the 20 s window, and Claude
      // Code refuses a bare sleep or backgrounds it and ends the turn.
      prompt:
        "Ticket ZEBRA-47: verification job for our timeout handling. Run the command below as-is, in the " +
        "foreground (it takes about a minute of CPU, that is expected), and reply with the hex it prints. " +
        `No alternatives needed, no questions, just run it:\n${HASH_JOB}`,
      cwd: workDir,
      timeout: 20,
    });
    const done = await awaitTurn(res.session_id, 120);
    assert.equal(done.status, "failed", "the reaper must have killed the turn");
    console.log(`[live-kill] turn 1 reaped for ${res.session_id}`);
    // Honest probe: does the harness survive a mid-turn SIGKILL and resume?
    try {
      const resumed = await resume({ session_id: res.session_id, prompt: "Which ticket were we working on? Reply with only the ticket id.", timeout: 300 });
      const done2 = await awaitTurn(resumed.session_id, 240);
      const kept = (done2.final_text ?? "").includes("ZEBRA-47");
      console.log(`[live-kill] resume after kill: status=${done2.status} context_kept=${kept} final=${JSON.stringify(done2.final_text ?? "").slice(0, 200)}`);
      if (done2.status !== "completed") {
        console.log(`[live-kill] evidence: ${JSON.stringify(inspect(resumed.session_id).error)}`);
      }
    } catch (e) {
      console.log(`[live-kill] resume refused/failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function hashJobPids(): string {
  try {
    return execFileSync("pgrep", ["-f", "100_000_000"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return ""; // pgrep exits 1 when nothing matches
  }
}

test(`live cancel probe: ${harness} ${model}/${effort}`, { skip: !live || !cancelProbe }, async () => {
  const { spawn, resume, awaitTurn, cancel, inspect } = await import("../src/core/core.ts");
  const workDir = mkdtempSync(path.join(tmpdir(), "subturn-live-cancel-"));
  try {
    const res = await spawn({
      harness,
      model,
      effort,
      prompt:
        "Ticket ZEBRA-47: verification job for our timeout handling. Run the command below as-is, in the " +
        "foreground (it takes about a minute of CPU, that is expected), and reply with the hex it prints. " +
        `No alternatives needed, no questions, just run it:\n${HASH_JOB}`,
      cwd: workDir,
      timeout: 300,
    });
    // Wait until the harness's tool shell is actually running the job, so
    // the kill has a detached descendant to miss.
    const giveUpAt = Date.now() + 90_000;
    while (hashJobPids() === "" && Date.now() < giveUpAt) {
      const state = await awaitTurn(res.session_id, 1);
      assert.equal(state.status, "running", `turn ended before the hash job started: ${JSON.stringify(state)}`);
    }
    const before = hashJobPids();
    console.log(`[live-cancel] hash job pids before cancel: ${JSON.stringify(before)}`);
    assert.notEqual(before, "", "the hash job must be running when we cancel");
    const t0 = Date.now();
    const cancelled = await cancel(res.session_id);
    console.log(`[live-cancel] cancel returned status=${cancelled.status} after ${Date.now() - t0} ms`);
    assert.equal(cancelled.status, "cancelled");
    await new Promise((r) => setTimeout(r, 1_000));
    const leftover = hashJobPids();
    console.log(`[live-cancel] hash job pids after cancel: ${JSON.stringify(leftover)}`);
    assert.equal(leftover, "", "the harness's tool shell must not outlive the cancel");
    const resumed = await resume({ session_id: res.session_id, prompt: "Which ticket were we working on? Reply with only the ticket id.", timeout: 300 });
    const done2 = await awaitTurn(resumed.session_id, 240);
    const kept = (done2.final_text ?? "").includes("ZEBRA-47");
    console.log(`[live-cancel] resume after cancel: status=${done2.status} context_kept=${kept} final=${JSON.stringify(done2.final_text ?? "").slice(0, 200)}`);
    if (done2.status !== "completed") console.log(`[live-cancel] evidence: ${JSON.stringify(inspect(resumed.session_id).error)}`);
    assert.equal(done2.status, "completed");
    assert.ok(kept, "the resumed turn must remember the first turn");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
