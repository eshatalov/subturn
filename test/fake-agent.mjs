// test/fake-agent.mjs — a scripted ACP agent for tests. Speaks ndjson
// JSON-RPC on stdio like a real harness. Behavior via FAKE_MODE:
//   ok         — handshake, set_config acks, prompt streams two chunks, end_turn
//   permission — asks for permission mid-prompt; completes only when allowed
//   hang       — accepts the prompt request and never answers (deadline test)
//   badeffort  — refuses the "effort" set_config with -32602
//   grok       — never answers the prompt request; completes via the private
//                _x.ai/session/prompt_complete notification (race test)
//   die        — exits immediately (launch-failure-before-session-id test)
//
// session/new returns a unique harness-native id; session/load accepts any
// id, replays one agent_message_chunk (which must NOT leak into the resumed
// turn's final text), and the next prompt reply echoes the loaded id so
// tests can prove the resume really carried the session.

import { randomBytes } from "node:crypto";

const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "die") {
  process.stderr.write("fake agent dying before any session exists\n");
  process.exit(3);
}

let buf = "";
const config = { model: null, effort: null };
let loadedSessionId = null;
let pendingPermissionId = null;
let pendingPromptId = null;
let promptSessionId = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function result(id, payload) {
  send({ jsonrpc: "2.0", id, result: payload });
}

function chunk(sessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

function finishPrompt() {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: promptSessionId,
      update: { sessionUpdate: "usage_update", input_tokens: 120, output_tokens: 45 },
    },
  });
  result(pendingPromptId, { stopReason: "end_turn" });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    // Junk line before a real response: must land in evidence, not crash.
    process.stdout.write("fake-agent booting, please ignore this line\n");
    result(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    return;
  }
  if (method === "session/new") {
    result(id, {
      sessionId: `fake-session-${randomBytes(6).toString("hex")}`,
      models: {
        currentModelId: "fake-model-1",
        availableModels: [
          { modelId: "fake-model-1", _meta: { reasoningEffort: "high" } },
          { modelId: "fake-model-2" },
        ],
      },
    });
    return;
  }
  if (method === "session/load") {
    loadedSessionId = params.sessionId;
    // History replay BEFORE the load response — a real agent streams the
    // whole conversation back; none of it belongs to the new turn.
    chunk(params.sessionId, "REPLAYED-HISTORY-MUST-NOT-LEAK ");
    result(id, {});
    return;
  }
  if (method === "session/set_config_option") {
    if (mode === "badeffort" && params.configId === "effort") {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `invalid effort: ${params.value}` } });
      return;
    }
    config[params.configId] = params.value;
    result(id, { configId: params.configId, currentValue: params.value });
    return;
  }
  if (method === "session/prompt") {
    pendingPromptId = id;
    promptSessionId = params.sessionId;
    if (mode === "hang") return; // never answers; the reaper must kill us
    if (mode === "grok") {
      chunk(params.sessionId, "grok-style completion");
      send({
        jsonrpc: "2.0",
        method: "_x.ai/session/prompt_complete",
        params: {
          sessionId: params.sessionId,
          promptId: params._meta?.promptId,
          stopReason: "end_turn",
        },
      });
      return; // the standard prompt response never comes
    }
    if (mode === "permission") {
      pendingPermissionId = "perm-1";
      send({
        jsonrpc: "2.0",
        id: pendingPermissionId,
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: { title: "run rm -rf ./scratch", kind: "execute", locations: [{ path: "/tmp/scratch" }] },
          options: [
            { optionId: "reject", kind: "reject_once" },
            { optionId: "yes-once", kind: "allow_once" },
            { optionId: "yes-always", kind: "allow_always" },
          ],
        },
      });
      return;
    }
    if (loadedSessionId !== null) {
      chunk(params.sessionId, `Resumed ${loadedSessionId} `);
      chunk(params.sessionId, `(model=${config.model ?? "unset"}, effort=${config.effort ?? "unset"})`);
      finishPrompt();
      return;
    }
    chunk(params.sessionId, "Hello from the ");
    chunk(params.sessionId, `fake agent (model=${config.model ?? "unset"}, effort=${config.effort ?? "unset"})`);
    finishPrompt();
    return;
  }
  if (id !== undefined && method !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

function handleResponse(msg) {
  // The client's answer to our permission request.
  if (msg.id === pendingPermissionId && pendingPermissionId !== null) {
    pendingPermissionId = null;
    const outcome = msg.result?.outcome;
    if (outcome?.outcome === "selected" && outcome.optionId === "yes-always") {
      chunk(promptSessionId, "permission granted, work done");
      finishPrompt();
    } else {
      result(pendingPromptId, { stopReason: "cancelled" });
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buf += data;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.method === "string") handle(msg);
    else handleResponse(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
