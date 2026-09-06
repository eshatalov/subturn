// test/parking.test.ts — claude session-file parking, offline. The plugin
// runs claude in the user's default config dir (keychain auth is bound to
// it) and keeps hygiene by moving the session's files out of
// <config>/projects/ into Subturn evidence after each turn, restoring them
// before a resume. Surgical: only files named by the session id move.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const configDir = mkdtempSync(path.join(tmpdir(), "subturn-claude-config-"));
process.env["CLAUDE_CONFIG_DIR"] = configDir;

const { parkSessionFiles, unparkSessionFiles } = await import("../src/plugins/claude.ts");

test.after(() => {
  delete process.env["CLAUDE_CONFIG_DIR"];
  rmSync(configDir, { recursive: true, force: true });
});

test("park moves only this session's files; unpark restores them for --resume", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const otherId = "99999999-8888-7777-6666-555555555555";
  const projDir = path.join(configDir, "projects", "-Users-someone-proj");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(path.join(projDir, `${sessionId}.jsonl`), "ours\n");
  writeFileSync(path.join(projDir, `${otherId}.jsonl`), "the user's other session\n");

  const sessionDir = mkdtempSync(path.join(tmpdir(), "subturn-claude-session-"));
  try {
    const report = parkSessionFiles(sessionId, sessionDir);
    assert.equal(report["verified_clean"], true, "the session must vanish from the projects listing");
    assert.deepEqual(report["failures"], []);
    // Gone from the projects dir; the user's other session untouched.
    const left = readdirSync(projDir);
    assert.deepEqual(left, [`${otherId}.jsonl`]);
    // Present in Subturn evidence.
    const parked = path.join(sessionDir, "parked", "-Users-someone-proj", `${sessionId}.jsonl`);
    assert.ok(existsSync(parked));
    assert.equal(readFileSync(parked, "utf8"), "ours\n");

    // Unpark restores the exact file to the exact place.
    const restore = unparkSessionFiles(sessionDir);
    assert.deepEqual(restore["failures"], []);
    assert.ok(existsSync(path.join(projDir, `${sessionId}.jsonl`)));
    assert.ok(!existsSync(parked));

    // Park again (as after a resumed turn) still works.
    const report2 = parkSessionFiles(sessionId, sessionDir);
    assert.equal(report2["verified_clean"], true);
    assert.deepEqual(readdirSync(projDir), [`${otherId}.jsonl`]);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("park with nothing to park reports honestly; unpark without a manifest is a no-op", () => {
  const sessionDir = mkdtempSync(path.join(tmpdir(), "subturn-claude-session2-"));
  try {
    const report = parkSessionFiles("no-such-session-id", sessionDir);
    assert.deepEqual(report["moved"], []);
    assert.equal(report["verified_clean"], true);
    const restore = unparkSessionFiles(sessionDir);
    assert.deepEqual(restore["restored"], []);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
