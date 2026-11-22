// plugins/antigravity.ts — Antigravity CLI over native ACP (`agy acp`).
//
// Bundle: applied via session/set_config_option — configId "model" first,
// then configId "thought_level" (agy's spelling of effort). Both are
// mandatory on fresh and resumed turns: if a model or thinking level is
// unknown or unsupported, agy refuses with -32602 before any prompt runs,
// and the raw RPC error lands in evidence.
//
// Posture: `--dangerously-skip-permissions` on the CLI plus Subturn's own
// allow-everything ACP permission handler (core/acp.ts) as a backstop.
// `--disable-telemetry` and `--include-default-customizations=false` keep
// telemetry off and prevent default customizations from leaking in.
//
// Shadow home: `--gemini-dir <shadow> --app-data-dir antigravity-cli` plus
// `GEMINI_HOME=<shadow>` isolate conversations, brain, annotations, logs,
// and caches per session, invisible to the user's `~/.gemini/antigravity-cli`
// history (principle 5). `AGY_CLI_DISABLE_AUTO_UPDATE=1` keeps the CLI from
// self-updating mid-turn.
//
// Auth: `GEMINI_API_KEY` takes precedence when set (like OPENAI_API_KEY in
// codex and XAI_API_KEY in grok) and authenticates via ACP `authenticate`
// (`gemini-api-key`). Otherwise agy 1.5 uses Google OAuth: the OS keyring on
// desktop (shared across `--gemini-dir`s automatically), or
// `antigravity-oauth-token` (legacy `acp_token.json`) inside the app-data dir
// over SSH / headless profiles (including T3 Code's `GEMINI_HOME` +
// `SSH_CONNECTION` profiles). File tokens are COPIED (0o600, atomic rename)
// into the shadow rather than symlinked: agy writes refreshes with
// `os.WriteFile`, so a symlink would mutate the user's profile and race
// concurrent sessions. Each turn reconciles the shadow's token files with the
// active credential source. On desktop Linux without a file token or cache
// hint, the OS keyring cannot be inspected cheaply without native bindings, so
// auth returns ok with an honest "unverified" note and lets `session/new`
// confirm (agy fails fast with -32000 when logged out).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { ensureDir } from "./shadow.ts";
import { configuredValue, runAcpTurn } from "../core/acp-turn.ts";
import type { AcpClient } from "../core/acp.ts";
import { isRecord } from "../core/json.ts";
import { probeAcpModels } from "./acp-models-probe.ts";

const SET_CONFIG_TIMEOUT_MS = 30_000;
const APP_DATA_DIR = "antigravity-cli";
const TOKEN_FILES = ["antigravity-oauth-token", "acp_token.json"] as const;

type CredentialSource =
  | { kind: "api-key"; detail: string }
  | { kind: "file"; files: string[]; detail: string }
  | { kind: "keyring"; detail: string }
  | { kind: "keyring-unverified"; detail: string }
  | { kind: "none"; detail: string };

function hasApiKey(): boolean {
  const apiKey = process.env["GEMINI_API_KEY"];
  return apiKey !== undefined && apiKey.trim() !== "";
}

function isSshSession(): boolean {
  const ssh = process.env["SSH_CONNECTION"];
  return ssh !== undefined && ssh.trim() !== "";
}

function realGeminiRoot(): { root: string; explicit: boolean } {
  const env = process.env["GEMINI_HOME"];
  if (env !== undefined && env.trim() !== "") return { root: path.resolve(env), explicit: true };
  return { root: path.join(homedir(), ".gemini"), explicit: false };
}

function candidateAppDirs(root: string, explicit: boolean): string[] {
  // Explicit GEMINI_HOME (e.g. T3 Code) stores its token in antigravity-acp
  // first; default ~/.gemini uses antigravity-cli first. Never fall back from
  // an explicit profile root to ~/.gemini.
  return explicit
    ? [path.join(root, "antigravity-acp"), path.join(root, APP_DATA_DIR)]
    : [path.join(root, APP_DATA_DIR), path.join(root, "antigravity-acp")];
}

function isReadableNonEmptyFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    return readFileSync(filePath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function readOauthStateHint(appDir: string): { methodId: string; file: string } | null {
  const file = path.join(appDir, "cache", "acp-auth-state.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(parsed) && typeof parsed["methodId"] === "string" && parsed["methodId"].startsWith("oauth-")) {
      return { methodId: parsed["methodId"], file };
    }
  } catch { /* absent or unreadable */ }
  return null;
}

function hasMacKeychainItem(): boolean {
  const res = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity"], {
    stdio: "ignore",
    timeout: 10_000,
  });
  return res.status === 0;
}

/** Single credential-source resolver shared by auth(), home(), and models(). */
export function resolveCredentialSource(platform: NodeJS.Platform = process.platform): CredentialSource {
  // 1. Explicit API key takes deterministic precedence (matches codex and grok).
  if (hasApiKey()) {
    return { kind: "api-key", detail: "GEMINI_API_KEY set" };
  }

  const { root, explicit } = realGeminiRoot();
  const appDirs = candidateAppDirs(root, explicit);

  // 2. File-based OAuth token(s) in the selected profile.
  for (const dir of appDirs) {
    const found = TOKEN_FILES.map((f) => path.join(dir, f)).filter(isReadableNonEmptyFile);
    if (found.length > 0) {
      return { kind: "file", files: found, detail: `oauth token at ${found[0]}` };
    }
  }

  const ssh = isSshSession();

  // 3. Desktop OS keyring (macOS keychain check, or Linux cache hint / unverified).
  if (!ssh) {
    if (platform === "darwin" && hasMacKeychainItem()) {
      return { kind: "keyring", detail: 'keychain item "gemini"/"antigravity" present' };
    }
    if (platform === "linux") {
      for (const dir of appDirs) {
        const hint = readOauthStateHint(dir);
        if (hint !== null) {
          return { kind: "keyring", detail: `oauth hint (${hint.methodId}) at ${hint.file}` };
        }
      }
      return { kind: "keyring-unverified", detail: "desktop keyring unverified — agy will confirm on launch" };
    }
  }

  const where = ssh
    ? `no oauth token under ${appDirs.join(" or ")} (SSH file storage)`
    : platform === "darwin"
      ? `no keychain item "gemini"/"antigravity" or oauth token under ${appDirs.join(" or ")}`
      : `no oauth token under ${appDirs.join(" or ")}`;
  return {
    kind: "none",
    detail: `${where} and GEMINI_API_KEY unset — run \`agy\` or \`agy acp --login\` to log in`,
  };
}

function shadowGeminiDir(sessionDir: string): string {
  return path.join(sessionDir, "home", "gemini");
}

function acpArgv(binPath: string, shadow: string): string[] {
  return [
    binPath,
    "acp",
    "--gemini-dir", shadow,
    "--app-data-dir", APP_DATA_DIR,
    "--dangerously-skip-permissions",
    "--disable-telemetry",
    "--include-default-customizations=false",
  ];
}

/** Write a private 0o600 copy atomically so agy's in-place token refreshes
 * never escape the shadow into the user's real profile. */
function copySecretFile(data: Buffer, dest: string): void {
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Reconcile the shadow's private credential files with the active source.
 * When the source path and bytes are unchanged on resume, keep the shadow's
 * own (possibly refreshed) copy; when the source changes, replace or clear
 * stale token files and clear agy's persisted `cache/acp-auth-state.json`
 * so switching between API key and OAuth never gets stuck on the old method. */
function prepareShadow(shadow: string, source: CredentialSource): { copied: string[]; reused: boolean } {
  ensureDir(shadow);
  const appDir = ensureDir(path.join(shadow, APP_DATA_DIR));
  const stampFile = path.join(shadow, ".subturn-auth-source.json");
  const authStateFile = path.join(appDir, "cache", "acp-auth-state.json");

  const fileEntries = source.kind === "file"
    ? source.files.map((src) => {
        const data = readFileSync(src);
        const hash = createHash("sha256").update(data).digest("hex");
        return { src, name: path.basename(src), data, hash };
      })
    : [];
  const nextStamp = JSON.stringify({
    kind: source.kind,
    files: fileEntries.map((f) => ({ src: f.src, hash: f.hash })),
  });

  let prevStamp = "";
  try { prevStamp = readFileSync(stampFile, "utf8"); } catch { /* fresh shadow */ }

  const allPresent = fileEntries.every((f) => existsSync(path.join(appDir, f.name)));
  if (prevStamp === nextStamp && allPresent) {
    // Still guard against a stale gemini-api-key state file when not in api-key mode.
    if (source.kind !== "api-key") rmSync(authStateFile, { force: true });
    return { copied: fileEntries.map((f) => f.src), reused: true };
  }

  const keepNames = new Set(fileEntries.map((f) => f.name));
  for (const entry of fileEntries) {
    copySecretFile(entry.data, path.join(appDir, entry.name));
  }
  for (const name of TOKEN_FILES) {
    if (!keepNames.has(name)) {
      rmSync(path.join(appDir, name), { force: true });
    }
  }
  rmSync(authStateFile, { force: true });
  writeFileSync(stampFile, nextStamp);
  return { copied: fileEntries.map((f) => f.src), reused: false };
}

async function applyConfig(
  ctx: LaunchContext,
  client: AcpClient,
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  try {
    const res = await client.request(
      "session/set_config_option",
      { sessionId, configId, value },
      SET_CONFIG_TIMEOUT_MS,
    );
    ctx.emit({ type: "set_config_result", configId, value, result: res ?? null });
    return res;
  } catch (err) {
    ctx.emit({
      type: "set_config_error",
      configId,
      value,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export const antigravityPlugin: Plugin = {
  name: "antigravity",
  hints: {
    // Only `agy`, never `antigravity` (which can be the Antigravity IDE binary).
    binaryNames: ["agy"],
    wellKnownDirs: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
  },

  auth(): Promise<AuthResult> {
    const source = resolveCredentialSource();
    return Promise.resolve({ ok: source.kind !== "none", detail: source.detail });
  },

  async models(binPath: string): Promise<string[] | null> {
    // Throwaway ACP handshake in a disposable shadow: `session/new` creates a
    // session, so it must never touch the user's ~/.gemini/antigravity-cli.
    const tmp = mkdtempSync(path.join(tmpdir(), "subturn-antigravity-models-"));
    try {
      const source = resolveCredentialSource();
      prepareShadow(tmp, source);
      return await probeAcpModels(
        acpArgv(binPath, tmp),
        { GEMINI_HOME: tmp, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
        source.kind === "api-key" ? { authMethodId: "gemini-api-key" } : undefined,
      );
    } catch {
      return null;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },

  home(sessionDir: string): Promise<ShadowHome> {
    const shadow = shadowGeminiDir(sessionDir);
    const source = resolveCredentialSource();
    const { copied, reused } = prepareShadow(shadow, source);
    const authNote =
      source.kind === "file"
        ? `private oauth copy (0600) ${reused ? "reused" : "copied"} from ${copied.join(", ")}`
        : source.detail;
    return Promise.resolve({
      env: {
        GEMINI_HOME: shadow,
        AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      },
      note:
        `GEMINI_HOME=${shadow} (--gemini-dir + --app-data-dir ${APP_DATA_DIR}; sessions invisible to \`agy\`); ` +
        `AGY_CLI_DISABLE_AUTO_UPDATE=1; ${authNote}`,
    });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    const shadow = ctx.env["GEMINI_HOME"] ?? shadowGeminiDir(ctx.sessionDir);
    return runAcpTurn(ctx, {
      argv: acpArgv(ctx.binPath, shadow),
      ...(hasApiKey() ? { authMethodId: "gemini-api-key" } : {}),
      configure: async (client, sessionId) => {
        // Model FIRST — available thought_level values depend on the model.
        // Always send thought_level even if absent from configOptions so an
        // unsupported effort fails loudly with -32602 rather than silently
        // running without the requested bundle. Emit each exchange as it
        // happens so a failed step still leaves prior evidence intact.
        const modelRes = await applyConfig(ctx, client, sessionId, "model", ctx.model);
        const effortRes = await applyConfig(ctx, client, sessionId, "thought_level", ctx.effort);
        const model = configuredValue(effortRes, "model") ?? configuredValue(modelRes, "model");
        const effort = configuredValue(effortRes, "thought_level");
        return {
          harness: "antigravity",
          requested: { model: ctx.model, effort: ctx.effort },
          ...(model !== undefined ? { acknowledged_model: model } : {}),
          ...(effort !== undefined ? { acknowledged_effort: effort } : {}),
          set_config_responses: { model: modelRes ?? null, thought_level: effortRes ?? null },
        };
      },
    });
  },
};
