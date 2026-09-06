// plugins/claude.ts — Claude Code headless (`claude -p --output-format
// stream-json`); Subturn does not use an ACP adapter here.
//
// Bundle: `--model <model> --effort <effort>`, verbatim (claude's effort
// knob takes low|medium|high|xhigh|max; an invalid value fails inside the
// harness and comes back as evidence).
//
// Posture: `--dangerously-skip-permissions` — claude's validated bypass
// mode; no permission prompt can fire in print mode with it.
//
// Hygiene by parking, NOT a shadow home (proven by live smoke 2026-09-01):
// claude's keychain credentials are per-config-dir — the service name is
// "Claude Code-credentials-<8-hex hash of the dir>" — so any fresh
// CLAUDE_CONFIG_DIR shadow starts logged out, and the owner refuses extra
// logins. The plugin therefore runs claude in the user's DEFAULT config dir
// (auth just works) and, the moment a turn ends, MOVES the session's files
// (the session .jsonl and other files named by the session id, and nothing
// else) out of <config>/projects/<munged-cwd>/ into the Subturn session dir.
// The session is visible in `claude -r` only while actually running. On
// resume the files are restored first, then `claude -p --resume <id>` (no
// --fork-session: same conversation, same id) continues the turn.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { runJsonlTurn } from "../core/jsonl-turn.ts";
import { isRecord } from "../core/json.ts";
import type { Usage } from "../core/state.ts";

function realConfigDir(): string {
  const env = process.env["CLAUDE_CONFIG_DIR"];
  return env !== undefined && env !== "" ? env : path.join(homedir(), ".claude");
}

function projectsDir(): string {
  return path.join(realConfigDir(), "projects");
}

interface ParkManifest {
  session_id: string;
  moved: Array<{ project_dir: string; file: string }>;
}

function manifestPath(sessionDir: string): string {
  return path.join(sessionDir, "parked", "manifest.json");
}

/** Find every file named by the session id anywhere under the projects dir.
 * Surgical: only files carrying the session id in their name — never the
 * user's other sessions. */
function findSessionFiles(sessionId: string): Array<{ project_dir: string; file: string }> {
  const hits: Array<{ project_dir: string; file: string }> = [];
  let projects: string[] = [];
  try {
    projects = readdirSync(projectsDir());
  } catch {
    return hits;
  }
  for (const proj of projects) {
    const projPath = path.join(projectsDir(), proj);
    try {
      if (!statSync(projPath).isDirectory()) continue;
      for (const entry of readdirSync(projPath)) {
        if (entry.includes(sessionId)) hits.push({ project_dir: projPath, file: entry });
      }
    } catch { /* unreadable project dir — not ours to touch */ }
  }
  return hits;
}

/** Move this session's files out of the user's projects dir into the Subturn
 * session dir. Returns an honest report for the evidence stream. */
export function parkSessionFiles(sessionId: string, sessionDir: string): Record<string, unknown> {
  const found = findSessionFiles(sessionId);
  const moved: ParkManifest["moved"] = [];
  const failures: string[] = [];
  for (const hit of found) {
    const destDir = path.join(sessionDir, "parked", path.basename(hit.project_dir));
    try {
      mkdirSync(destDir, { recursive: true });
      renameSync(path.join(hit.project_dir, hit.file), path.join(destDir, hit.file));
      moved.push(hit);
    } catch (e) {
      failures.push(`${hit.file}: ${String(e)}`);
    }
  }
  if (moved.length > 0) {
    const manifest: ParkManifest = { session_id: sessionId, moved };
    try {
      mkdirSync(path.join(sessionDir, "parked"), { recursive: true });
      writeFileSync(manifestPath(sessionDir), JSON.stringify(manifest, null, 2));
    } catch (e) {
      failures.push(`manifest: ${String(e)}`);
    }
  }
  // Verify: the session must no longer appear in the projects dir listing.
  const leftBehind = findSessionFiles(sessionId).map((h) => path.join(h.project_dir, h.file));
  return {
    type: "claude_parked",
    session_id: sessionId,
    moved: moved.map((m) => path.join(m.project_dir, m.file)),
    failures,
    left_behind: leftBehind,
    verified_clean: leftBehind.length === 0,
  };
}

/** Restore parked files so `claude --resume` finds the session again. */
export function unparkSessionFiles(sessionDir: string): Record<string, unknown> {
  let manifest: ParkManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath(sessionDir), "utf8")) as ParkManifest;
  } catch {
    return { type: "claude_unparked", restored: [], note: "no park manifest (nothing to restore)" };
  }
  const restored: string[] = [];
  const failures: string[] = [];
  for (const m of manifest.moved) {
    const src = path.join(sessionDir, "parked", path.basename(m.project_dir), m.file);
    const dest = path.join(m.project_dir, m.file);
    try {
      mkdirSync(m.project_dir, { recursive: true });
      renameSync(src, dest);
      restored.push(dest);
    } catch (e) {
      failures.push(`${m.file}: ${String(e)}`);
    }
  }
  return { type: "claude_unparked", restored, failures };
}

export const claudePlugin: Plugin = {
  name: "claude",
  hints: {
    binaryNames: ["claude"],
    wellKnownDirs: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  },

  auth(): Promise<AuthResult> {
    if (process.platform === "darwin") {
      // Cheap keychain presence check; never launches claude. The service
      // name is per-config-dir; the bare name covers the default dir.
      const res = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
        stdio: "ignore",
        timeout: 10_000,
      });
      if (res.status === 0) {
        return Promise.resolve({ ok: true, detail: 'keychain item "Claude Code-credentials" present' });
      }
      // Fall through: keychain miss can still mean file-based credentials.
    }
    const creds = path.join(realConfigDir(), ".credentials.json");
    if (existsSync(creds)) {
      return Promise.resolve({ ok: true, detail: `credentials file at ${creds}` });
    }
    if (process.env["ANTHROPIC_API_KEY"] !== undefined && process.env["ANTHROPIC_API_KEY"] !== "") {
      return Promise.resolve({ ok: true, detail: "ANTHROPIC_API_KEY set" });
    }
    return Promise.resolve({
      ok: false,
      detail: "no keychain item, credentials file, or ANTHROPIC_API_KEY — run `claude` once to log in",
    });
  },

  models(): Promise<string[] | null> {
    // No cheap advertisement without launching claude; honest null.
    return Promise.resolve(null);
  },

  home(_sessionDir: string): Promise<ShadowHome> {
    // Deliberately NO shadow: keychain auth is bound to the config dir
    // (see header). Hygiene comes from parking in finalize().
    return Promise.resolve({
      env: {},
      note:
        `default config dir ${realConfigDir()} (keychain auth is per-config-dir; a shadow would be ` +
        "logged out) — session files are parked into Subturn evidence when the turn ends",
    });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    if (ctx.nativeSessionId !== undefined) {
      // Restore this session's parked files before claude looks for them.
      ctx.emit(unparkSessionFiles(ctx.sessionDir));
    }
    const argv = [
      ctx.binPath,
      "-p",
      ...(ctx.nativeSessionId !== undefined ? ["--resume", ctx.nativeSessionId] : []),
      "--output-format", "stream-json",
      "--verbose", // required by claude for stream-json in print mode
      "--model", ctx.model,
      "--effort", ctx.effort,
      "--dangerously-skip-permissions",
    ];

    let finalText = "";
    let isError = false;
    let resultSubtype = "";
    const usage: Usage = {};
    let ack: Record<string, unknown> | null = null;
    let idReported = false;

    return runJsonlTurn(ctx, argv, {
      onEvent: (event) => {
        const type = typeof event["type"] === "string" ? event["type"] : "";
        if (type === "system" && event["subtype"] === "init") {
          // The native session id: claude echoes it in the init event. With
          // --resume and no --fork-session it stays the same id.
          if (!idReported && typeof event["session_id"] === "string" && event["session_id"] !== "") {
            ctx.onNativeSessionId(event["session_id"]);
            idReported = true;
          }
          if (ack === null) {
            // Acknowledged bundle: the init event echoes the resolved model.
            // Effort is never echoed (claude 2.1: no field in init or result).
            ack = {
              harness: "claude",
              requested: { model: ctx.model, effort: ctx.effort },
              ...(typeof event["model"] === "string" ? { acknowledged_model: event["model"] } : {}),
            };
            ctx.writeEvidence("ack.json", JSON.stringify(ack, null, 2));
          }
        }
        if (type === "result") {
          if (typeof event["result"] === "string") finalText = event["result"];
          if (event["is_error"] === true) isError = true;
          if (typeof event["subtype"] === "string") resultSubtype = event["subtype"];
          const u = event["usage"];
          if (isRecord(u)) {
            // input_tokens is the UNCACHED part only; the bulk of a claude
            // prompt lands in the cache_* fields of the same record.
            if (typeof u["input_tokens"] === "number") usage.input_tokens = u["input_tokens"];
            if (typeof u["output_tokens"] === "number") usage.output_tokens = u["output_tokens"];
            if (typeof u["cache_read_input_tokens"] === "number") usage.cache_read_input_tokens = u["cache_read_input_tokens"];
            if (typeof u["cache_creation_input_tokens"] === "number") usage.cache_creation_input_tokens = u["cache_creation_input_tokens"];
            const details = u["output_tokens_details"];
            if (isRecord(details) && typeof details["thinking_tokens"] === "number") usage.reasoning_tokens = details["thinking_tokens"];
          }
          if (typeof event["total_cost_usd"] === "number") usage.cost_usd = event["total_cost_usd"];
        }
      },
      finish: (exit, stderrTail) => {
        // claude does not reject an unknown --effort: it warns on stderr and
        // runs on the default. That warning is the only effort evidence.
        const effortWarning = stderrTail.split("\n").find((l) => l.includes("--effort"));
        if (ack !== null && effortWarning !== undefined) {
          ack = { ...ack, effort_warning: effortWarning.trim() };
          ctx.writeEvidence("ack.json", JSON.stringify(ack, null, 2));
        }
        if (exit.code === 0 && !isError) {
          const outcome: LaunchOutcome = { ok: true, finalText };
          if (Object.keys(usage).length > 0) outcome.usage = usage;
          return outcome;
        }
        return {
          ok: false,
          error:
            `claude -p exited code=${String(exit.code)} signal=${String(exit.signal)}` +
            (isError ? ` result subtype=${resultSubtype}` : "") +
            (finalText !== "" ? `\nresult text: ${finalText}` : "") +
            `\nstderr tail:\n${stderrTail}`,
        };
      },
    });
  },

  finalize(ctx: LaunchContext): Promise<void> {
    // The supervisor keeps ctx.nativeSessionId current (turn 1 gets it once
    // the init event reported it). No id = the harness never created a
    // session; nothing can be parked.
    if (ctx.nativeSessionId === undefined || ctx.nativeSessionId === "") {
      ctx.emit({ type: "claude_parked", note: "no session id; nothing to park" });
      return Promise.resolve();
    }
    ctx.emit(parkSessionFiles(ctx.nativeSessionId, ctx.sessionDir));
    return Promise.resolve();
  },
};
