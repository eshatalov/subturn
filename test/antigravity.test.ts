// test/antigravity.test.ts — antigravity auth, shadow home, model probe, and
// ACP turn behavior, offline against a stateful fake `agy` script. No real
// harness is launched.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { antigravityPlugin, resolveCredentialSource } from "../src/plugins/antigravity.ts";
import { extractAcpModels } from "../src/plugins/acp-models-probe.ts";
import type { LaunchContext } from "../src/plugins/types.ts";

const root = mkdtempSync(path.join(tmpdir(), "subturn-antigravity-test-"));
const workDir = path.join(root, "work");
mkdirSync(workDir, { recursive: true });

// Stateful fake `agy` binary speaking ACP ndjson on stdio. Persists sessions
// under --gemini-dir/--app-data-dir, refreshes its shadow token in place with
// writeFileSync (mirroring agy's os.WriteFile), and validates GEMINI_API_KEY
// when authenticate("gemini-api-key") is called.
const fakeAgy = path.join(root, "agy");
writeFileSync(
  fakeAgy,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : "";
};
const geminiDir = flag("--gemini-dir");
const appDataDir = flag("--app-data-dir") || "antigravity-cli";
const appRoot = path.join(geminiDir, appDataDir);
const convDir = path.join(appRoot, "conversations");
const authStatePath = path.join(appRoot, "cache", "acp-auth-state.json");

const mode = process.env.FAKE_AGY_MODE ?? "ok";
const calls = [];
let authedMethod = null;
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ok = (id, r) => send({ jsonrpc: "2.0", id, result: r });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const config = { model: "gemini-4-neon", thought_level: "high" };
const configOptions = () => [
  { id: "model", type: "select", currentValue: config.model, options: [{ value: "gemini-4-neon" }, { value: "gemini-3.8-flash" }, { value: "gemini-4-neon" }] },
  { id: "thought_level", type: "select", currentValue: config.thought_level, options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
];

function silentAuthOk() {
  // Mirror agy's persisted auth-method behavior: if cache/acp-auth-state.json
  // recorded gemini-api-key, silent auth fails when GEMINI_API_KEY is absent.
  if (fs.existsSync(authStatePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(authStatePath, "utf8"));
      if (saved.methodId === "gemini-api-key" && !process.env.GEMINI_API_KEY) return false;
    } catch {}
  }
  for (const name of ["antigravity-oauth-token", "acp_token.json"]) {
    const p = path.join(appRoot, name);
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8").trim().length > 0) {
      // Simulate agy's os.WriteFile token refresh inside the shadow.
      fs.writeFileSync(p, '{"token":{"access_token":"refreshed-in-shadow"}}');
      return true;
    }
  }
  return false;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    calls.push({ method, params });
    if (method === "initialize") {
      // Deliberately omit authMethods / loadSession to cover unadvertised-method compatibility.
      ok(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    } else if (method === "authenticate") {
      if (params.methodId === "gemini-api-key") {
        if (!process.env.GEMINI_API_KEY) {
          fail(id, -32000, "GEMINI_API_KEY missing in child env");
          continue;
        }
        fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
        fs.writeFileSync(authStatePath, JSON.stringify({ methodId: "gemini-api-key" }));
        authedMethod = "gemini-api-key";
        ok(id, {});
      } else {
        fail(id, -32602, "unsupported auth method: " + params.methodId);
      }
    } else if (method === "session/new") {
      if (authedMethod === null && !silentAuthOk()) {
        fail(id, -32000, "Authentication required");
        continue;
      }
      const sessionId = "agy-sess-1234";
      fs.mkdirSync(convDir, { recursive: true });
      fs.writeFileSync(path.join(convDir, sessionId + ".json"), JSON.stringify({ cwd: params.cwd, created: true }));
      ok(id, {
        sessionId,
        models: { availableModels: [{ modelId: "gemini-4-neon-high" }, { modelId: "gemini-3.8-flash-low" }], currentModelId: "gemini-4-neon-high" },
        configOptions: configOptions(),
      });
    } else if (method === "session/load") {
      if (authedMethod === null && !silentAuthOk()) {
        fail(id, -32000, "Authentication required");
        continue;
      }
      const savedPath = path.join(convDir, params.sessionId + ".json");
      if (!fs.existsSync(savedPath)) {
        fail(id, -32602, "session not found in shadow: " + savedPath);
        continue;
      }
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED " } } } });
      ok(id, { sessionId: params.sessionId, configOptions: configOptions() });
    } else if (method === "session/set_config_option") {
      if (mode === "bad-model" && params.configId === "model") {
        fail(id, -32602, "Unknown model ID: " + params.value);
        continue;
      }
      if (mode === "bad-effort" && params.configId === "thought_level") {
        fail(id, -32602, 'Thinking level "' + params.value + '" is not offered');
        continue;
      }
      config[params.configId] = params.value;
      ok(id, { configOptions: configOptions() });
    } else if (method === "session/prompt") {
      if (mode === "refusal") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "quota exhausted" } } } });
        ok(id, { stopReason: "refusal" });
        continue;
      }
      const order = calls.map((c) => c.method + (c.params?.configId ? ":" + c.params.configId : "")).join(",");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok:" + order } } } });
      ok(id, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2 } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);
chmodSync(fakeAgy, 0o755);

const envKeys = ["GEMINI_HOME", "SSH_CONNECTION", "GEMINI_API_KEY", "FAKE_AGY_MODE"] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

function restoreEnv(): void {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

async function withEnv<T>(
  overrides: Partial<Record<(typeof envKeys)[number], string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  for (const k of envKeys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    restoreEnv();
  }
}

test.after(() => {
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

test("auth honors explicit GEMINI_HOME (antigravity-acp before antigravity-cli), legacy acp_token.json, and refuses empty SSH profile", async () => {
  const profile = path.join(root, "explicit-profile");
  const acpDir = path.join(profile, "antigravity-acp");
  const cliDir = path.join(profile, "antigravity-cli");
  mkdirSync(acpDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(path.join(cliDir, "antigravity-oauth-token"), '{"token":{"access_token":"cli"}}');
  writeFileSync(path.join(acpDir, "antigravity-oauth-token"), '{"token":{"access_token":"acp"}}');

  await withEnv({ GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, async () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "file");
    assert.deepEqual(src.files, [path.join(acpDir, "antigravity-oauth-token")]);
    const auth = await antigravityPlugin.auth();
    assert.equal(auth.ok, true);
  });

  // Legacy acp_token.json is detected when antigravity-oauth-token is absent.
  const legacyProfile = path.join(root, "legacy-profile");
  mkdirSync(path.join(legacyProfile, "antigravity-acp"), { recursive: true });
  const legacyFile = path.join(legacyProfile, "antigravity-acp", "acp_token.json");
  writeFileSync(legacyFile, '{"refresh_token":"r"}');
  await withEnv({ GEMINI_HOME: legacyProfile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "file");
    assert.deepEqual(src.files, [legacyFile]);
  });

  // Empty explicit profile over SSH must fail, never silently use ~/.gemini.
  const emptyProfile = path.join(root, "empty-explicit");
  mkdirSync(path.join(emptyProfile, "antigravity-cli"), { recursive: true });
  writeFileSync(path.join(emptyProfile, "antigravity-cli", "antigravity-oauth-token"), "   \n");
  await withEnv({ GEMINI_HOME: emptyProfile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, async () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "none");
    const auth = await antigravityPlugin.auth();
    assert.equal(auth.ok, false);
    assert.match(auth.detail, /agy/);
  });

  // Non-linux/non-darwin platform without token or API key fails cleanly.
  await withEnv({ GEMINI_HOME: emptyProfile }, () => {
    const src = resolveCredentialSource("win32");
    assert.equal(src.kind, "none");
  });
});

test("auth gives deterministic precedence to GEMINI_API_KEY and handles desktop Linux cache hints cleanly", async () => {
  const profile = path.join(root, "linux-hint-profile");
  const cacheDir = path.join(profile, "antigravity-cli", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "acp-auth-state.json"), JSON.stringify({ methodId: "oauth-personal" }));

  // Explicit GEMINI_API_KEY wins deterministically even if a stale cache hint exists.
  await withEnv({ GEMINI_HOME: profile, GEMINI_API_KEY: "test-key" }, () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "api-key");
  });

  // Without GEMINI_API_KEY on desktop Linux, cache hint reports keyring.
  await withEnv({ GEMINI_HOME: profile }, () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "keyring");
    assert.match(src.detail, /oauth-personal/);
  });

  // Under SSH, a desktop cache hint is ignored.
  await withEnv({ GEMINI_HOME: profile, SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 50000" }, () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "none");
  });

  // Without file token, hint, or API key on desktop Linux -> ok with unverified keyring note.
  const blank = path.join(root, "linux-blank-profile");
  mkdirSync(blank, { recursive: true });
  await withEnv({ GEMINI_HOME: blank }, () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "keyring-unverified");
    assert.match(src.detail, /unverified/);
  });

  // Non-OAuth methodId in acp-auth-state.json is not treated as an OAuth hint.
  const nonOauth = path.join(root, "linux-non-oauth");
  mkdirSync(path.join(nonOauth, "antigravity-cli", "cache"), { recursive: true });
  writeFileSync(path.join(nonOauth, "antigravity-cli", "cache", "acp-auth-state.json"), JSON.stringify({ methodId: "gemini-api-key" }));
  await withEnv({ GEMINI_HOME: nonOauth }, () => {
    const src = resolveCredentialSource("linux");
    assert.equal(src.kind, "keyring-unverified");
  });
});

test("home makes private 0600 copies, reconciles account switches on resume, and handles relative GEMINI_HOME", async () => {
  const profileA = path.join(root, "profile-a");
  const profileB = path.join(root, "profile-b");
  mkdirSync(path.join(profileA, "antigravity-acp"), { recursive: true });
  mkdirSync(path.join(profileB, "antigravity-acp"), { recursive: true });
  const tokenA = path.join(profileA, "antigravity-acp", "antigravity-oauth-token");
  const tokenB = path.join(profileB, "antigravity-acp", "antigravity-oauth-token");
  writeFileSync(tokenA, '{"token":{"access_token":"account-A"}}');
  writeFileSync(tokenB, '{"token":{"access_token":"account-B"}}');
  writeFileSync(path.join(profileA, "AGENTS.md"), "user instructions that must not leak");

  const sessionDir = path.join(root, "session-reconcile");
  const shadow = path.join(sessionDir, "home", "gemini");
  const shadowToken = path.join(shadow, "antigravity-cli", "antigravity-oauth-token");

  // Relative GEMINI_HOME resolves cleanly and produces a private 0600 file (not a symlink).
  const relA = path.relative(process.cwd(), profileA);
  await withEnv({ GEMINI_HOME: relA, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, async () => {
    const homeA = await antigravityPlugin.home(sessionDir);
    assert.equal(homeA.env["GEMINI_HOME"], shadow);
    assert.equal(homeA.env["AGY_CLI_DISABLE_AUTO_UPDATE"], "1");
    assert.equal(lstatSync(shadowToken).isSymbolicLink(), false, "must be a private copy, not a symlink");
    assert.equal(statSync(shadowToken).mode & 0o777, 0o600);
    assert.equal(readFileSync(shadowToken, "utf8"), '{"token":{"access_token":"account-A"}}');
    assert.equal(existsSync(path.join(shadow, "AGENTS.md")), false);
  });

  // Same-profile resume preserves a refreshed shadow token when source is unchanged.
  writeFileSync(shadowToken, '{"token":{"access_token":"refreshed-in-shadow"}}');
  await withEnv({ GEMINI_HOME: profileA, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, async () => {
    const homeReused = await antigravityPlugin.home(sessionDir);
    assert.match(homeReused.note, /reused/);
    assert.equal(readFileSync(shadowToken, "utf8"), '{"token":{"access_token":"refreshed-in-shadow"}}');
  });

  // Updating the source token file replaces the shadow copy.
  writeFileSync(tokenA, '{"token":{"access_token":"account-A-v2"}}');
  await withEnv({ GEMINI_HOME: profileA, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, async () => {
    await antigravityPlugin.home(sessionDir);
    assert.equal(readFileSync(shadowToken, "utf8"), '{"token":{"access_token":"account-A-v2"}}');
  });

  // Switching to profile B on resume replaces the shadow copy with B.
  await withEnv({ GEMINI_HOME: profileB, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, async () => {
    await antigravityPlugin.home(sessionDir);
    assert.equal(readFileSync(shadowToken, "utf8"), '{"token":{"access_token":"account-B"}}');
    assert.equal(readFileSync(tokenA, "utf8"), '{"token":{"access_token":"account-A-v2"}}', "profile A untouched");
  });

  // Switching to API-key mode removes the stale file token from the shadow.
  await withEnv({ GEMINI_HOME: profileB, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", GEMINI_API_KEY: "k" }, async () => {
    await antigravityPlugin.home(sessionDir);
    assert.equal(existsSync(shadowToken), false, "stale token file must be removed");
  });
});

test("extractAcpModels prefers flat or grouped configOptions model ids and falls back cleanly", () => {
  const mixed = {
    models: {
      availableModels: [
        { modelId: "gemini-4-neon-high" },
        { modelId: "gemini-4-neon-low" },
      ],
    },
    configOptions: [
      {
        id: "model",
        options: [
          { value: "gemini-4-neon" },
          { group: "recommended", name: "Recommended", options: [{ value: "gemini-3.8-flash" }, { value: "gemini-4-neon" }] },
        ],
      },
      { id: "thought_level", options: [{ value: "low" }] },
    ],
  };
  assert.deepEqual(extractAcpModels(mixed), ["gemini-4-neon", "gemini-3.8-flash"]);

  const emptyConfigFallback = {
    models: {
      availableModels: [{ modelId: "grok-4.6" }, { modelId: "grok-4.7" }],
    },
    configOptions: [{ id: "model", options: [] }],
  };
  assert.deepEqual(extractAcpModels(emptyConfigFallback), ["grok-4.6", "grok-4.7"]);
  assert.equal(extractAcpModels({}), null);
});

test("launch runs stateful ACP turns across shadow rename, keeps user token untouched, validates API key, bad effort, refusal, and models()", async () => {
  const profile = path.join(root, "launch-profile");
  mkdirSync(path.join(profile, "antigravity-cli"), { recursive: true });
  const realTokenPath = path.join(profile, "antigravity-cli", "antigravity-oauth-token");
  const originalToken = '{"token":{"access_token":"real-user-token"}}';
  writeFileSync(realTokenPath, originalToken);

  const runTurn = async (opts: {
    sessionDir: string;
    nativeSessionId?: string;
    envOverrides: Partial<Record<(typeof envKeys)[number], string | undefined>>;
  }) => {
    mkdirSync(opts.sessionDir, { recursive: true });
    const events: Array<Record<string, unknown>> = [];
    const evidence: Record<string, string> = {};
    let reportedId = "";
    return withEnv(opts.envOverrides, async () => {
      const home = await antigravityPlugin.home(opts.sessionDir);
      const ctx: LaunchContext = {
        binPath: fakeAgy,
        model: "gemini-3.8-flash",
        effort: "low",
        prompt: "hi",
        cwd: workDir,
        sessionDir: opts.sessionDir,
        turn: opts.nativeSessionId === undefined ? 1 : 2,
        nativeSessionId: opts.nativeSessionId,
        deadlineMs: Date.now() + 30_000,
        env: home.env,
        emit: (e) => events.push(e),
        writeEvidence: (file, content) => { evidence[file] = content; },
        onChildPid: () => {},
        onNativeSessionId: (id) => { reportedId = id; },
      };
      const outcome = await antigravityPlugin.launch(ctx);
      return { outcome, events, evidence, reportedId, shadow: home.env["GEMINI_HOME"]! };
    });
  };

  // 1. Fresh turn with OAuth file token: argv, order, ack, usage, exit event,
  // and user's real token is NOT mutated by agy's in-place refresh.
  const stagingDir = path.join(root, "staging-turn-1");
  const fresh = await runTurn({
    sessionDir: stagingDir,
    envOverrides: { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
  });
  assert.equal(fresh.outcome.ok, true, fresh.outcome.error);
  assert.equal(fresh.reportedId, "agy-sess-1234");
  assert.equal(readFileSync(realTokenPath, "utf8"), originalToken, "refresh in shadow must never mutate real profile");
  assert.equal(
    fresh.outcome.finalText,
    "ok:initialize,session/new,session/set_config_option:model,session/set_config_option:thought_level,session/prompt",
  );
  assert.deepEqual(fresh.outcome.usage, { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2 });
  assert.ok(fresh.events.some((e) => e["type"] === "exit"), "exit event recorded in evidence");
  const spawnEvent = fresh.events.find((e) => e["type"] === "spawn");
  assert.deepEqual(spawnEvent?.["argv"], [
    fakeAgy,
    "acp",
    "--gemini-dir", fresh.shadow,
    "--app-data-dir", "antigravity-cli",
    "--dangerously-skip-permissions",
    "--disable-telemetry",
    "--include-default-customizations=false",
  ]);
  const ack = JSON.parse(fresh.evidence["ack.json"] ?? "{}") as Record<string, unknown>;
  assert.equal(ack["harness"], "antigravity");
  assert.equal(ack["acknowledged_model"], "gemini-3.8-flash");
  assert.equal(ack["acknowledged_effort"], "low");

  // 2. Rename session dir (like supervisor's adoptStaged), then resume:
  // stateful session/load reads the persisted session in the moved shadow.
  const adoptedDir = path.join(root, "adopted-agy-sess-1234");
  renameSync(stagingDir, adoptedDir);
  const resumed = await runTurn({
    sessionDir: adoptedDir,
    nativeSessionId: "agy-sess-1234",
    envOverrides: { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
  });
  assert.equal(resumed.outcome.ok, true, resumed.outcome.error);
  assert.equal(
    resumed.outcome.finalText,
    "ok:initialize,session/load,session/set_config_option:model,session/set_config_option:thought_level,session/prompt",
  );
  assert.equal(resumed.outcome.finalText?.includes("REPLAYED"), false);

  // 3. API key auth sends authenticate before session/new (validated in child env),
  // and switching from API key to OAuth on resume in the same shadow clears
  // persisted `cache/acp-auth-state.json` so silent OAuth resume succeeds.
  const emptyProfile = path.join(root, "apikey-empty");
  mkdirSync(emptyProfile, { recursive: true });
  const apiKeySessionDir = path.join(root, "turn-apikey");
  const apiKeyRun = await runTurn({
    sessionDir: apiKeySessionDir,
    envOverrides: { GEMINI_HOME: emptyProfile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", GEMINI_API_KEY: "test-key" },
  });
  assert.equal(apiKeyRun.outcome.ok, true, apiKeyRun.outcome.error);
  assert.equal(
    apiKeyRun.outcome.finalText,
    "ok:initialize,authenticate,session/new,session/set_config_option:model,session/set_config_option:thought_level,session/prompt",
  );
  assert.equal(
    existsSync(path.join(apiKeyRun.shadow, "antigravity-cli", "cache", "acp-auth-state.json")),
    true,
    "fake agy persisted gemini-api-key auth state",
  );
  const apiKeyToOauthResume = await runTurn({
    sessionDir: apiKeySessionDir,
    nativeSessionId: "agy-sess-1234",
    envOverrides: { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
  });
  assert.equal(apiKeyToOauthResume.outcome.ok, true, apiKeyToOauthResume.outcome.error);
  assert.equal(
    apiKeyToOauthResume.outcome.finalText,
    "ok:initialize,session/load,session/set_config_option:model,session/set_config_option:thought_level,session/prompt",
  );

  // 4. Rejected model and unsupported thought_level both fail loudly with -32602
  // before any prompt, preserving per-config evidence.
  const badModel = await runTurn({
    sessionDir: path.join(root, "turn-bad-model"),
    envOverrides: { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", FAKE_AGY_MODE: "bad-model" },
  });
  assert.equal(badModel.outcome.ok, false);
  assert.match(badModel.outcome.error ?? "", /rpc error -32602/);
  assert.ok(badModel.events.some((e) => e["type"] === "set_config_error" && e["configId"] === "model"));

  const badEffort = await runTurn({
    sessionDir: path.join(root, "turn-bad-effort"),
    envOverrides: { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", FAKE_AGY_MODE: "bad-effort" },
  });
  assert.equal(badEffort.outcome.ok, false);
  assert.match(badEffort.outcome.error ?? "", /rpc error -32602/);
  assert.ok(
    badEffort.events.some((e) => e["type"] === "set_config_result" && e["configId"] === "model"),
    "successful model config exchange must remain in evidence",
  );
  assert.ok(
    badEffort.events.some((e) => e["type"] === "set_config_error" && e["configId"] === "thought_level"),
    "failed thought_level config exchange must be recorded in evidence",
  );

  // 5. stopReason=refusal fails the turn cleanly with raw reason.
  const refused = await runTurn({
    sessionDir: path.join(root, "turn-refusal"),
    envOverrides: { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", FAKE_AGY_MODE: "refusal" },
  });
  assert.equal(refused.outcome.ok, false);
  assert.match(refused.outcome.error ?? "", /stopReason=refusal/);

  // 6. models() works with both file token (without mutating user's file) and GEMINI_API_KEY.
  const modelsFromFile = await withEnv(
    { GEMINI_HOME: profile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
    () => antigravityPlugin.models(fakeAgy),
  );
  assert.deepEqual(modelsFromFile, ["gemini-4-neon", "gemini-3.8-flash"]);
  assert.equal(readFileSync(realTokenPath, "utf8"), originalToken, "models() probe must never mutate real profile");

  const modelsFromKey = await withEnv(
    { GEMINI_HOME: emptyProfile, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", GEMINI_API_KEY: "test-key" },
    () => antigravityPlugin.models(fakeAgy),
  );
  assert.deepEqual(modelsFromKey, ["gemini-4-neon", "gemini-3.8-flash"]);
});
