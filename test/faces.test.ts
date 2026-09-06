// test/faces.test.ts — the MCP face lists exactly five tools and routes
// calls through the same core; launch failures surface as MCP tool errors
// (isError), never pseudo-sessions; the grok prompt-completion race
// resolves a turn whose standard prompt response never arrives.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = mkdtempSync(path.join(tmpdir(), "subturn-faces-test-"));
process.env["SUBTURN_STATE_DIR"] = path.join(stateRoot, "state");
process.env["SUBTURN_FAKE_AGENT"] = path.join(here, "fake-agent.mjs");
const workDir = path.join(stateRoot, "work");
mkdirSync(workDir, { recursive: true });

const { buildServer } = await import("../src/faces/mcp.ts");
const { runAcpTurn } = await import("../src/core/acp-turn.ts");

test.after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

async function connectedClient() {
  const server = buildServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("MCP face lists exactly five tools: spawn, resume, await, cancel, inspect", async () => {
  const client = await connectedClient();
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["await", "cancel", "inspect", "resume", "spawn"],
  );
  const hints = Object.fromEntries(tools.tools.map((t) => [t.name, t.annotations]));
  assert.equal(hints["inspect"]?.readOnlyHint, true);
  assert.equal(hints["await"]?.readOnlyHint, true);
  assert.equal(hints["cancel"]?.destructiveHint, true);
  assert.equal(hints["spawn"]?.openWorldHint, true);
  await client.close();
});

test("MCP face runs spawn → await → resume → await end to end on native ids", async () => {
  const client = await connectedClient();
  const launched = await client.callTool({
    name: "spawn",
    arguments: {
      harness: "fake",
      model: "fake-model-2",
      effort: "max",
      prompt: "hello over mcp",
      cwd: workDir,
    },
  });
  assert.notEqual(launched.isError, true);
  const launchPayload = JSON.parse(
    (launched.content as Array<{ type: string; text: string }>)[0]!.text,
  ) as { session_id: string; status: string };
  assert.equal(launchPayload.status, "running");
  assert.match(launchPayload.session_id, /^fake-session-/, "the id is the harness's own");

  const checked = await client.callTool({
    name: "await",
    arguments: { session_id: launchPayload.session_id, timeout: 30 },
  });
  const checkPayload = JSON.parse(
    (checked.content as Array<{ type: string; text: string }>)[0]!.text,
  ) as { status: string; final_text?: string };
  assert.equal(checkPayload.status, "completed");
  assert.ok(checkPayload.final_text?.includes("model=fake-model-2"));

  const resumed = await client.callTool({
    name: "resume",
    arguments: { session_id: launchPayload.session_id, prompt: "again" },
  });
  assert.notEqual(resumed.isError, true);
  const resumePayload = JSON.parse(
    (resumed.content as Array<{ type: string; text: string }>)[0]!.text,
  ) as { session_id: string };
  assert.equal(resumePayload.session_id, launchPayload.session_id);

  const checked2 = await client.callTool({
    name: "await",
    arguments: { session_id: launchPayload.session_id, timeout: 30 },
  });
  const checkPayload2 = JSON.parse(
    (checked2.content as Array<{ type: string; text: string }>)[0]!.text,
  ) as { status: string; turn: number; final_text?: string };
  assert.equal(checkPayload2.status, "completed");
  assert.equal(checkPayload2.turn, 2);
  assert.ok(checkPayload2.final_text?.includes(`Resumed ${launchPayload.session_id}`));

  const inspected = await client.callTool({
    name: "inspect",
    arguments: { session_id: launchPayload.session_id },
  });
  assert.notEqual(inspected.isError, true);
  await client.close();
});

test("MCP face: a launch that fails before a session exists is a tool error with detail inline", async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: "spawn",
    arguments: { harness: "nonesuch", model: "m", effort: "low", prompt: "p", cwd: workDir },
  });
  assert.equal(res.isError, true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /unknown harness "nonesuch"/);
  await client.close();
});

test("MCP face refuses unknown parameters instead of running on defaults", async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: "spawn",
    arguments: { harness: "fake", model: "m", effort: "low", prompt: "p", cwd: workDir, deadline_s: 5 },
  });
  assert.equal(res.isError, true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /spawn: unknown parameter deadline_s \(accepted: harness, model, effort, prompt, cwd, timeout\)/);
  await client.close();
});

test("MCP face returns tool errors, not crashes, for unknown session ids", async () => {
  const client = await connectedClient();
  const res = await client.callTool({ name: "await", arguments: { session_id: "no-such-session" } });
  assert.equal(res.isError, true);
  const res2 = await client.callTool({ name: "resume", arguments: { session_id: "no-such-session", prompt: "p" } });
  assert.equal(res2.isError, true);
  await client.close();
});

test("grok private prompt-completion race resolves without a standard prompt response", async () => {
  const sessionDir = mkdtempSync(path.join(stateRoot, "grok-race-"));
  const events: Array<Record<string, unknown>> = [];
  process.env["FAKE_MODE"] = "grok";
  try {
    const outcome = await runAcpTurn(
      {
        binPath: process.execPath,
        model: "fake-model-1",
        effort: "high",
        prompt: "complete privately",
        cwd: workDir,
        sessionDir,
        turn: 1,
        nativeSessionId: undefined,
        deadlineMs: Date.now() + 30_000,
        env: {},
        emit: (e) => events.push(e),
        writeEvidence: () => { /* not needed */ },
        onChildPid: () => { /* not needed */ },
        onNativeSessionId: () => { /* not needed */ },
      },
      {
        argv: [process.execPath, path.join(here, "fake-agent.mjs")],
        grokCompletionRace: true,
      },
    );
    assert.equal(outcome.ok, true);
    assert.ok(outcome.finalText?.includes("grok-style completion"));
    const promptResult = events.find((e) => e["type"] === "prompt_result");
    assert.ok(promptResult !== undefined, "the private completion must settle the turn");
  } finally {
    delete process.env["FAKE_MODE"];
  }
});
