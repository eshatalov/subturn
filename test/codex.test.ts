// test/codex.test.ts — codex launch argv, offline. The "harness" is a
// stand-in binary that exits at once; only the recorded spawn argv matters.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { codexPlugin } from "../src/plugins/codex.ts";
import type { LaunchContext } from "../src/plugins/types.ts";

const sessionDir = mkdtempSync(path.join(tmpdir(), "subturn-codex-session-"));

test.after(() => rmSync(sessionDir, { recursive: true, force: true }));

async function launchArgv(nativeSessionId?: string): Promise<string[]> {
  let argv: string[] = [];
  const ctx: LaunchContext = {
    binPath: process.execPath,
    model: "some-model",
    effort: "low",
    prompt: "hi",
    cwd: sessionDir,
    sessionDir,
    turn: nativeSessionId === undefined ? 1 : 2,
    nativeSessionId,
    deadlineMs: Date.now() + 30_000,
    env: {},
    emit: (event) => {
      if (event["type"] === "spawn") argv = event["argv"] as string[];
    },
    writeEvidence: () => {},
    onChildPid: () => {},
    onNativeSessionId: () => {},
  };
  await codexPlugin.launch(ctx);
  return argv;
}

const hasPair = (argv: string[], flag: string, value: string): boolean =>
  argv.some((a, i) => a === flag && argv[i + 1] === value);

test("every codex turn pins the standard service tier", async () => {
  for (const argv of [await launchArgv(), await launchArgv("some-session")]) {
    assert.ok(hasPair(argv, "-c", "service_tier=default"), `argv: ${JSON.stringify(argv)}`);
  }
});
