// plugins/fake.ts — a test-only plugin, present in the registry only when
// SUBTURN_FAKE_AGENT names a fake ACP agent script. It exercises the
// whole real path (launch → supervisor → ACP client → evidence → await)
// against a scripted agent, costing nothing. Never registered in normal use.

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { configuredValue, runAcpTurn } from "../core/acp-turn.ts";

function fakeAgentScript(): string | null {
  const p = process.env["SUBTURN_FAKE_AGENT"];
  return p !== undefined && p !== "" ? p : null;
}

export const fakePlugin: Plugin = {
  name: "fake",
  hints: {
    // The fake agent runs on the node executable already running Subturn.
    binaryNames: [process.execPath.split("/").pop() ?? "node"],
    wellKnownDirs: [process.execPath.slice(0, process.execPath.lastIndexOf("/"))],
  },

  auth(): Promise<AuthResult> {
    if (process.env["SUBTURN_FAKE_AUTH_FAIL"] === "1") {
      return Promise.resolve({ ok: false, detail: "fake auth deliberately failing (test)" });
    }
    return Promise.resolve({ ok: true, detail: "fake plugin always authorized" });
  },

  models(): Promise<string[] | null> {
    return Promise.resolve(["fake-model-1", "fake-model-2"]);
  },

  home(_sessionDir: string): Promise<ShadowHome> {
    return Promise.resolve({ env: {}, note: "fake plugin: no shadow home" });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    const script = fakeAgentScript();
    if (script === null) {
      return Promise.resolve({ ok: false, error: "SUBTURN_FAKE_AGENT not set" });
    }
    return runAcpTurn(ctx, {
      argv: [process.execPath, script],
      configure: async (client, sessionId) => {
        const modelRes = await client.request(
          "session/set_config_option",
          { sessionId, configId: "model", value: ctx.model },
          15_000,
        );
        const effortRes = await client.request(
          "session/set_config_option",
          { sessionId, configId: "effort", value: ctx.effort },
          15_000,
        );
        const model = configuredValue(modelRes, "model");
        const effort = configuredValue(effortRes, "effort");
        return {
          harness: "fake",
          requested: { model: ctx.model, effort: ctx.effort },
          ...(model !== undefined ? { acknowledged_model: model } : {}),
          ...(effort !== undefined ? { acknowledged_effort: effort } : {}),
          set_config_responses: { model: modelRes ?? null, effort: effortRes ?? null },
        };
      },
    });
  },
};
