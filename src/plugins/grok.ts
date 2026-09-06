// plugins/grok.ts — Grok over native ACP (`grok agent ... stdio`).
//
// Bundle: model and effort go as process flags BEFORE the `stdio`
// subcommand (`-m <model> --reasoning-effort <effort>`); grok stdio has no
// set_config. The acknowledged bundle is read back from the session/new
// response (models.currentModelId + the current model's
// _meta.reasoningEffort, plus the `x.ai/sessionConfig` selected option) and
// recorded in ack.json — evidence, not a gate.
//
// Posture: `--always-approve` (validated in Grok's own CLI: auto-approves
// all tool executions), plus Subturn's ACP client's allow-everything
// permission handler as a backstop.
//
// Past-ACP quirk (observed live): grok can complete a
// prompt via the private `_x.ai/session/prompt_complete` notification
// without ever answering the standard session/prompt request. The turn
// races both; the promptId rides in _meta.promptId/_meta.requestId.
//
// Shadow home: GROK_HOME relocates the whole home (sessions land under
// $GROK_HOME/sessions); the user's real ~/.grok/auth.json is symlinked in.
// The shadow lives in the session dir and persists for the retention
// window, so resume (ACP session/load, handled in acp-turn) finds the
// session state; model+effort are re-applied on every turn via the same
// process flags.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { ensureDir, shareAuth } from "./shadow.ts";
import { runAcpTurn } from "../core/acp-turn.ts";
import { isRecord } from "../core/json.ts";
import { probeAcpModels } from "./acp-models-probe.ts";

function realGrokHome(): string {
  const env = process.env["GROK_HOME"];
  return env !== undefined && env !== "" ? env : path.join(homedir(), ".grok");
}

export const grokPlugin: Plugin = {
  name: "grok",
  hints: {
    binaryNames: ["grok"],
    wellKnownDirs: ["~/.grok/bin", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  },

  auth(): Promise<AuthResult> {
    if (process.env["XAI_API_KEY"] !== undefined && process.env["XAI_API_KEY"] !== "") {
      return Promise.resolve({ ok: true, detail: "XAI_API_KEY set" });
    }
    const p = path.join(realGrokHome(), "auth.json");
    if (!existsSync(p)) {
      return Promise.resolve({ ok: false, detail: `no auth file at ${p} — run \`grok\` once to log in` });
    }
    try {
      JSON.parse(readFileSync(p, "utf8"));
      return Promise.resolve({ ok: true, detail: `auth.json present at ${p}` });
    } catch {
      return Promise.resolve({ ok: false, detail: `${p} is not valid JSON` });
    }
  },

  models(binPath: string): Promise<string[] | null> {
    // Throwaway ACP handshake (initialize + session/new, never a prompt).
    return probeAcpModels([binPath, "agent", "stdio"], {
      GROK_HOME: realGrokHome(),
    });
  },

  home(sessionDir: string): Promise<ShadowHome> {
    const shadow = ensureDir(path.join(sessionDir, "home", "grok"));
    const realAuth = path.join(realGrokHome(), "auth.json");
    const linked = shareAuth(realAuth, path.join(shadow, "auth.json"));
    return Promise.resolve({
      env: { GROK_HOME: shadow },
      note:
        `GROK_HOME=${shadow} (sessions land under the shadow, invisible to \`grok sessions\`); ` +
        `auth.json ${linked ? "symlinked from" : "NOT FOUND at"} ${realAuth}`,
    });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    return runAcpTurn(ctx, {
      argv: [
        ctx.binPath,
        "agent",
        "-m", ctx.model,
        "--reasoning-effort", ctx.effort,
        "--always-approve",
        "stdio",
      ],
      grokCompletionRace: true,
      extNotifications: {
        // Grok's private session channel (validated live 2026-09-02):
        //  - `model_changed` fires when the server re-selects the model
        //    AFTER session/new (a launch campaign flipped grok-4.5 to
        //    grok-4.6 despite `-m`); the ack must follow.
        //  - `turn_completed` carries the turn's usage (camelCase) and
        //    `modelUsage` keyed by the model that actually served it.
        "_x.ai/session_notification": (params, sink) => {
          const update = isRecord(params) && isRecord(params["update"]) ? params["update"] : null;
          if (update === null) return;
          if (update["sessionUpdate"] === "model_changed") {
            const patch: Record<string, unknown> = {};
            if (typeof update["model_id"] === "string") patch["acknowledged_model"] = update["model_id"];
            if (typeof update["reasoning_effort"] === "string") patch["acknowledged_effort"] = update["reasoning_effort"];
            if (Object.keys(patch).length > 0) sink.ack({ ...patch, model_changed_after_session_new: true });
          }
          if (update["sessionUpdate"] === "turn_completed" && isRecord(update["usage"])) {
            sink.usage(update["usage"]);
            const perModel = update["usage"]["modelUsage"];
            if (isRecord(perModel)) sink.ack({ served_models: Object.keys(perModel) });
          }
        },
      },
      ackFromSessionNew: (result) => {
        // Measured live: the applied bundle is
        // echoed in models.currentModelId + availableModels[current]._meta
        // .reasoningEffort and in _meta["x.ai/sessionConfig"].options.
        const ack: Record<string, unknown> = {
          harness: "grok",
          requested: { model: ctx.model, effort: ctx.effort },
        };
        const models = isRecord(result["models"]) ? result["models"] : null;
        const currentModelId = models?.["currentModelId"];
        if (typeof currentModelId === "string") ack["acknowledged_model"] = currentModelId;
        const available = models?.["availableModels"];
        if (Array.isArray(available)) {
          for (const m of available) {
            if (isRecord(m) && m["modelId"] === currentModelId && isRecord(m["_meta"])) {
              const eff = m["_meta"]["reasoningEffort"];
              if (typeof eff === "string") ack["acknowledged_effort"] = eff;
            }
          }
        }
        const meta = isRecord(result["_meta"]) ? result["_meta"] : null;
        const sessionConfig = meta?.["x.ai/sessionConfig"];
        if (sessionConfig !== undefined) ack["session_config"] = sessionConfig;
        return ack;
      },
    });
  },
};
