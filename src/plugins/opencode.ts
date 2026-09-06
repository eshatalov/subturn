// plugins/opencode.ts — OpenCode over native ACP (`opencode acp`).
//
// Bundle: applied via session/set_config_option — configId "model" first
// (the "effort" option only exists after a model with variants is selected),
// then configId "effort". Both are mandatory; the server refuses nonsense
// with -32602, which comes back as evidence, not vocabulary. Resume (ACP
// session/load, handled in acp-turn) runs the same configure step, so the
// bundle is re-applied explicitly on every turn — never server defaults.
//
// Posture: `opencode acp` has no --auto flag; the permissive posture is the
// Subturn's ACP client itself, which answers every session/request_permission
// with the most permissive option (core/acp.ts). No prompt can fire
// unanswered.
//
// Shadow home: VERIFIED EMPIRICALLY 2026-09-01 against opencode 1.18.25 —
// `XDG_DATA_HOME=<dir> opencode session list` creates and uses
// `<dir>/opencode/` (opencode.db, log/) and sees none of the user's
// sessions. OpenCode keeps sessions AND auth in that one data dir, so the
// shadow sets XDG_DATA_HOME and symlinks the user's real auth.json back in.
// The user's config dir (~/.config/opencode) is deliberately left alone:
// provider definitions may live there and auth alone is not enough for
// custom providers (zai-coding-plan et al.).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { ensureDir, shareAuth } from "./shadow.ts";
import { configuredValue, runAcpTurn } from "../core/acp-turn.ts";
import type { AcpClient } from "../core/acp.ts";
import { spawn } from "node:child_process";

const SET_CONFIG_TIMEOUT_MS = 30_000;

function realDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(homedir(), ".local", "share");
  return path.join(base, "opencode");
}

function realAuthPath(): string {
  return path.join(realDataDir(), "auth.json");
}

async function setConfig(
  client: AcpClient,
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  return client.request(
    "session/set_config_option",
    { sessionId, configId, value },
    SET_CONFIG_TIMEOUT_MS,
  );
}

export const opencodePlugin: Plugin = {
  name: "opencode",
  hints: {
    binaryNames: ["opencode"],
    wellKnownDirs: ["~/.opencode/bin", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  },

  auth(): Promise<AuthResult> {
    const p = realAuthPath();
    if (!existsSync(p)) {
      return Promise.resolve({ ok: false, detail: `no auth file at ${p} — run \`opencode auth login\`` });
    }
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const providers = Object.keys(parsed);
      if (providers.length === 0) {
        return Promise.resolve({ ok: false, detail: `${p} has no provider credentials` });
      }
      return Promise.resolve({ ok: true, detail: `auth.json providers: ${providers.join(", ")}` });
    } catch {
      return Promise.resolve({ ok: false, detail: `${p} is not valid JSON` });
    }
  },

  models(binPath: string): Promise<string[] | null> {
    // `opencode models` lists provider/model ids without launching a turn.
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(binPath, ["models"], { stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        resolve(null);
      }, 30_000);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => { out += d; });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", () => {
        clearTimeout(timer);
        const models = out.split("\n").map((l) => l.trim()).filter((l) => l.includes("/"));
        resolve(models.length > 0 ? models : null);
      });
    });
  },

  home(sessionDir: string): Promise<ShadowHome> {
    const shadowData = ensureDir(path.join(sessionDir, "home", "opencode-data"));
    const linked = shareAuth(realAuthPath(), path.join(shadowData, "opencode", "auth.json"));
    return Promise.resolve({
      env: { XDG_DATA_HOME: shadowData },
      note:
        `XDG_DATA_HOME=${shadowData} (verified: opencode puts its data dir, sessions included, under $XDG_DATA_HOME/opencode); ` +
        `auth.json ${linked ? "symlinked from" : "NOT FOUND at"} ${realAuthPath()}`,
    });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    return runAcpTurn(ctx, {
      argv: [ctx.binPath, "acp"],
      configure: async (client, sessionId) => {
        // Model FIRST — the effort option appears only after the model set.
        const modelRes = await setConfig(client, sessionId, "model", ctx.model);
        const effortRes = await setConfig(client, sessionId, "effort", ctx.effort);
        // The effort response is the later echo of the whole option list, so
        // it is the authoritative currentValue for both.
        const model = configuredValue(effortRes, "model") ?? configuredValue(modelRes, "model");
        const effort = configuredValue(effortRes, "effort");
        return {
          harness: "opencode",
          requested: { model: ctx.model, effort: ctx.effort },
          ...(model !== undefined ? { acknowledged_model: model } : {}),
          ...(effort !== undefined ? { acknowledged_effort: effort } : {}),
          set_config_responses: { model: modelRes ?? null, effort: effortRes ?? null },
        };
      },
    });
  },
};
