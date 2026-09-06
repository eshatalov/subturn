// plugins/codex.ts — Codex headless (`codex exec --json`); codex ships no
// native ACP.
//
// Bundle: `-m <model>` and `-c model_reasoning_effort=<effort>`, verbatim.
// The acknowledged bundle is read back from the JSONL stream when codex
// echoes its configuration (session_configured / turn context events).
//
// Posture: `--dangerously-bypass-approvals-and-sandbox` — codex's own
// validated non-interactive full-access mode; no approval prompt exists in
// exec mode with it. `--skip-git-repo-check` keeps non-repo cwds working.
// stdin carries the prompt and is closed immediately (codex hangs on an
// open stdin — recorded harness homework).
//
// Shadow home: CODEX_HOME relocates the whole home; the user's real
// ~/.codex/auth.json is symlinked back in (auth.json is the one
// shared entry). The user's config.toml is
// deliberately NOT shared: it can carry instructions and profiles the
// caller never asked for (principle 5); the cost is that exotic
// config-defined model providers won't resolve in the shadow — a failed
// run's evidence names the model codex refused.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { ensureDir, shareAuth } from "./shadow.ts";
import { runJsonlTurn } from "../core/jsonl-turn.ts";
import { isRecord } from "../core/json.ts";
import type { Usage } from "../core/state.ts";

function realCodexHome(): string {
  const env = process.env["CODEX_HOME"];
  return env !== undefined && env !== "" ? env : path.join(homedir(), ".codex");
}

/** Walk $CODEX_HOME/sessions (recursively) for rollout-*<id>.jsonl and take the last line whose
 * payload names a model (session_meta / turn_context). Best effort. */
function readRolloutBundle(codexHome: string | undefined, id: string): Record<string, unknown> | null {
  if (codexHome === undefined) return null;
  const root = path.join(codexHome, "sessions");
  if (!existsSync(root)) return null;
  const stack = [root];
  let file: string | null = null;
  while (stack.length > 0 && file === null) {
    const dir = stack.pop() as string;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e);
      if (e.endsWith(".jsonl") && e.includes(id)) { file = full; break; }
      try { if (statSync(full).isDirectory()) stack.push(full); } catch { /* skip */ }
    }
  }
  if (file === null) return null;
  const out: Record<string, unknown> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"model"')) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const payload = isRecord(parsed) && isRecord(parsed["payload"]) ? parsed["payload"] : null;
      if (payload === null) continue;
      if (typeof payload["model"] === "string") out["configured_model"] = payload["model"];
      const eff = payload["effort"] ?? payload["reasoning_effort"];
      if (typeof eff === "string") out["configured_effort"] = eff;
    }
  } catch { return null; }
  return Object.keys(out).length > 0 ? out : null;
}

export const codexPlugin: Plugin = {
  name: "codex",
  hints: {
    binaryNames: ["codex"],
    wellKnownDirs: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  },

  auth(): Promise<AuthResult> {
    if (process.env["OPENAI_API_KEY"] !== undefined && process.env["OPENAI_API_KEY"] !== "") {
      return Promise.resolve({ ok: true, detail: "OPENAI_API_KEY set" });
    }
    const p = path.join(realCodexHome(), "auth.json");
    if (!existsSync(p)) {
      return Promise.resolve({ ok: false, detail: `no auth file at ${p} — run \`codex login\`` });
    }
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const hasTokens = parsed["tokens"] !== undefined && parsed["tokens"] !== null;
      const hasKey = typeof parsed["OPENAI_API_KEY"] === "string" && parsed["OPENAI_API_KEY"] !== "";
      if (!hasTokens && !hasKey) {
        return Promise.resolve({ ok: false, detail: `${p} has neither tokens nor an API key` });
      }
      return Promise.resolve({ ok: true, detail: `auth.json ${hasTokens ? "tokens" : "api key"} at ${p}` });
    } catch {
      return Promise.resolve({ ok: false, detail: `${p} is not valid JSON` });
    }
  },

  models(): Promise<string[] | null> {
    // No cheap advertisement without running codex; honest null.
    return Promise.resolve(null);
  },

  home(sessionDir: string): Promise<ShadowHome> {
    const shadow = ensureDir(path.join(sessionDir, "home", "codex"));
    const realAuth = path.join(realCodexHome(), "auth.json");
    const linked = shareAuth(realAuth, path.join(shadow, "auth.json"));
    return Promise.resolve({
      env: { CODEX_HOME: shadow },
      note:
        `CODEX_HOME=${shadow} (sessions land under the shadow, invisible to \`codex resume\`); ` +
        `auth.json ${linked ? "symlinked from" : "NOT FOUND at"} ${realAuth}; ` +
        `user config.toml deliberately not shared (principle 5)`,
    });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    const lastMessageFile = path.join(ctx.sessionDir, "final.txt");
    const bundleFlags = [
      "--json",
      "-m", ctx.model,
      "-c", `model_reasoning_effort=${ctx.effort}`,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--output-last-message", lastMessageFile,
    ];
    // Resume: `codex exec resume <id>` continues the stored rollout in this
    // session's CODEX_HOME shadow — non-forking, same conversation. Model
    // and effort are re-applied explicitly (never server defaults). The
    // resume subcommand takes the same flags EXCEPT --color (validated live
    // 2026-09-01: `--color` is rejected there), so --color rides only on
    // the fresh-exec argv.
    const argv = ctx.nativeSessionId !== undefined
      ? [ctx.binPath, "exec", "resume", ...bundleFlags, ctx.nativeSessionId, "-"]
      : [ctx.binPath, "exec", "--color", "never", ...bundleFlags, "-"]; // prompt from stdin

    let lastAgentMessage = "";
    const usage: Usage = {};
    let ack: Record<string, unknown> | null = null;
    let idReported = false;
    let nativeId: string | null = null;
    let errorEvent: string | null = null;

    const readTokens = (info: unknown): void => {
      if (!isRecord(info)) return;
      const total = isRecord(info["total_token_usage"]) ? info["total_token_usage"] : info;
      const inp = total["input_tokens"];
      const out = total["output_tokens"];
      const tot = total["total_tokens"];
      if (typeof inp === "number") usage.input_tokens = inp;
      if (typeof out === "number") usage.output_tokens = out;
      if (typeof tot === "number") usage.total_tokens = tot;
    };

    return runJsonlTurn(ctx, argv, {
      onEvent: (event) => {
        // codex exec --json wraps most payloads in {id, msg:{type,...}};
        // newer builds also emit flat {type: ...} items. Handle both.
        const msg = isRecord(event["msg"]) ? event["msg"] : event;
        const type = typeof msg["type"] === "string" ? msg["type"] : "";
        if (type === "agent_message" && typeof msg["message"] === "string") {
          lastAgentMessage = msg["message"];
        }
        if (type === "item.completed" && isRecord(msg["item"])) {
          const item = msg["item"];
          if (item["item_type"] === "agent_message" && typeof item["text"] === "string") {
            lastAgentMessage = item["text"];
          }
        }
        if (type === "token_count") readTokens(msg["info"] ?? msg);
        if (type === "turn.completed" && isRecord(msg["usage"])) readTokens(msg["usage"]);
        if (type === "error" && typeof msg["message"] === "string") {
          errorEvent = msg["message"];
        }
        // The native session id: codex echoes it in the configuration event
        // (session_configured.session_id; newer builds thread.started
        // .thread_id). It is THE session id Subturn returns.
        if (!idReported) {
          const echoedId = msg["session_id"] ?? msg["thread_id"] ?? event["thread_id"];
          if (typeof echoedId === "string" && echoedId !== "") {
            ctx.onNativeSessionId(echoedId);
            nativeId = echoedId;
            idReported = true;
          }
        }
        // Acknowledged bundle: codex echoes its resolved configuration once.
        if (ack === null && (type === "session_configured" || type === "session.created" || type === "thread.started")) {
          const model = msg["model"];
          const effortAck = msg["reasoning_effort"] ?? msg["reasoningEffort"];
          ack = {
            harness: "codex",
            requested: { model: ctx.model, effort: ctx.effort },
            ...(typeof model === "string" ? { acknowledged_model: model } : {}),
            ...(effortAck !== undefined ? { acknowledged_effort: effortAck } : {}),
            echo_event_type: type,
          };
          ctx.writeEvidence("ack.json", JSON.stringify(ack, null, 2));
        }
      },
      finish: (exit, stderrTail) => {
        // `thread.started` (0.152) echoes no model. The rollout in the shadow
        // CODEX_HOME records the CONFIGURED bundle (turn_context) — what
        // codex sent, not what the server served. Recorded as such: it
        // catches a misspelled flag, not a server-side substitution.
        if (ack !== null && !("acknowledged_model" in ack) && nativeId !== null) {
          const configured = readRolloutBundle(ctx.env["CODEX_HOME"], nativeId);
          if (configured !== null) {
            ack = {
              ...ack,
              ...configured,
              configured_bundle_note: "from the shadow rollout: configured by codex, not server-attested",
            };
            ctx.writeEvidence("ack.json", JSON.stringify(ack, null, 2));
          }
        }
        let finalText = lastAgentMessage;
        try {
          if (existsSync(lastMessageFile)) {
            const fromFile = readFileSync(lastMessageFile, "utf8");
            if (fromFile.trim() !== "") finalText = fromFile;
          }
        } catch { /* fall back to streamed message */ }
        if (exit.code === 0) {
          const outcome: LaunchOutcome = { ok: true, finalText };
          if (Object.keys(usage).length > 0) outcome.usage = usage;
          return outcome;
        }
        return {
          ok: false,
          error:
            `codex exec exited code=${String(exit.code)} signal=${String(exit.signal)}` +
            (errorEvent !== null ? `\nlast error event: ${errorEvent}` : "") +
            `\nstderr tail:\n${stderrTail}`,
        };
      },
    });
  },
};
