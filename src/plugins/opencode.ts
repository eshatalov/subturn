// plugins/opencode.ts — OpenCode over native ACP (`opencode acp`).
//
// Bundle: applied via session/set_config_option — configId "model" first
// (the "effort" option only exists after a model with variants is selected),
// then configId "effort". Both are mandatory; the server refuses nonsense
// with -32602, which comes back as evidence, not vocabulary. Resume (ACP
// session/load, handled in acp-turn) runs the same configure step, so the
// bundle is re-applied explicitly on every turn — never server defaults.
//
// The server lists models before its plugins have added theirs (the
// OpenCode Console providers, providers from the user's config) and
// announces the rest with config_option_update about a second later. A
// model refused right after the session opens is therefore set again after
// each such update (retryOnConfigUpdate in acp-turn).
//
// Posture: `opencode acp` has no --auto flag; the permissive posture is the
// Subturn's ACP client itself, which answers every session/request_permission
// with the most permissive option (core/acp.ts). No prompt can fire
// unanswered.
//
// Shadow home: `opencode acp` runs its own `opencode serve --stdio` child,
// never the user's background service, and that server keeps sessions and
// credentials (table `credential`) in one SQLite file,
// $XDG_DATA_HOME/opencode/opencode.db, or wherever OPENCODE_DB points. The
// child gets both variables, so a user's OPENCODE_DB cannot lead it back to
// the user's file. The shadow is a snapshot of the
// user's file: `VACUUM INTO` from a read-only connection (consistent while
// the user's service writes), then every table outside KEEP_TABLES emptied
// and the models.dev catalog cache dropped from kv (the binary bundles
// one). No table is dropped: the server refuses to start with one missing.
// Foreign keys are off on that connection so emptying a table cannot
// cascade into a kept one. The snapshot is renamed into place from a .tmp
// file, so an existing opencode.db is always a finished shadow.
// OPENCODE_PRINT_LOGS=1 sends the private server's stderr to stderr.log,
// so a startup death leaves evidence.
//
// OAuth rows are copied with an empty refresh token: the shadow uses the
// access token but can never refresh it, so it can never revoke the user's.
// Once the token expires, turns in that shadow fail with an auth error and
// a fresh spawn snapshots the user's current login.
//
// The user's config dir (~/.config/opencode) is left alone: provider
// definitions may live there (zai-coding-plan et al.).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AuthResult, LaunchContext, LaunchOutcome, Plugin, ShadowHome } from "./types.ts";
import { configuredValue, runAcpTurn } from "../core/acp-turn.ts";
import type { AcpClient } from "../core/acp.ts";
import { probeAcpModels } from "./acp-models-probe.ts";

const SET_CONFIG_TIMEOUT_MS = 30_000;

// The login and the schema bookkeeping; every other table is emptied.
const KEEP_TABLES = new Set(["credential", "migration", "account", "account_state", "control_account", "kv"]);

function realDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(homedir(), ".local", "share");
  return path.join(base, "opencode");
}

function realDbPath(): string {
  // OpenCode resolves OPENCODE_DB against its data dir.
  const override = process.env["OPENCODE_DB"];
  return path.resolve(realDataDir(), override !== undefined && override !== "" ? override : "opencode.db");
}

/** Copy the user's opencode.db to `shadowDb` keeping only the login (see
 * header). The user's DB is opened read-only. */
export function snapshotCredentials(userDb: string, shadowDb: string): void {
  mkdirSync(path.dirname(shadowDb), { recursive: true });
  const tmp = `${shadowDb}.tmp`;
  rmSync(tmp, { force: true });
  try {
    const src = new DatabaseSync(userDb, { readOnly: true });
    try {
      src.prepare("VACUUM INTO ?").run(tmp);
    } finally {
      src.close();
    }
    chmodSync(tmp, 0o600); // like the user's DB: the copy holds their credentials
    const db = new DatabaseSync(tmp, { enableForeignKeyConstraints: false });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => String(r["name"]));
      for (const t of tables) {
        if (!KEEP_TABLES.has(t)) db.exec(`DELETE FROM "${t.replaceAll('"', '""')}"`);
      }
      db.exec("DELETE FROM kv WHERE key LIKE 'models-dev:catalog%'");
      db.exec("UPDATE credential SET value = json_set(value, '$.refresh', '') WHERE json_extract(value, '$.type') = 'oauth'");
      db.exec("VACUUM");
    } finally {
      db.close();
    }
    renameSync(tmp, shadowDb);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
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
    const p = realDbPath();
    if (!existsSync(p)) {
      return Promise.resolve({ ok: false, detail: `no opencode.db at ${p} — run \`opencode auth login\`` });
    }
    let ids: string[];
    try {
      const db = new DatabaseSync(p, { readOnly: true });
      try {
        // A row's presence is the login; which one is active is the harness's call.
        ids = db
          .prepare("SELECT DISTINCT integration_id FROM credential WHERE integration_id IS NOT NULL ORDER BY integration_id")
          .all()
          .map((r) => String(r["integration_id"]));
      } finally {
        db.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.resolve({ ok: false, detail: `cannot read credentials from ${p}: ${msg}` });
    }
    if (ids.length === 0) {
      return Promise.resolve({ ok: false, detail: `${p} has no credentials — run \`opencode auth login\`` });
    }
    return Promise.resolve({ ok: true, detail: `credentials in opencode.db: ${ids.join(", ")}` });
  },

  async models(binPath: string): Promise<string[] | null> {
    // Throwaway ACP handshake in a temp shadow; `opencode models` would start
    // a background service that outlives us.
    const tmp = mkdtempSync(path.join(tmpdir(), "subturn-opencode-models-"));
    try {
      const shadowDb = path.join(tmp, "opencode", "opencode.db");
      snapshotCredentials(realDbPath(), shadowDb);
      return await probeAcpModels([binPath, "acp"], { XDG_DATA_HOME: tmp, OPENCODE_DB: shadowDb });
    } catch {
      return null;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },

  home(sessionDir: string): Promise<ShadowHome> {
    const shadowData = path.join(sessionDir, "home", "opencode-data");
    const shadowDb = path.join(shadowData, "opencode", "opencode.db");
    // A resumed turn reuses the shadow: session/load finds the session there.
    const fresh = !existsSync(shadowDb);
    if (fresh) snapshotCredentials(realDbPath(), shadowDb);
    return Promise.resolve({
      env: { XDG_DATA_HOME: shadowData, OPENCODE_DB: shadowDb, OPENCODE_PRINT_LOGS: "1" },
      note: fresh
        ? `XDG_DATA_HOME=${shadowData}; credentials snapshotted from ${realDbPath()}, session tables emptied`
        : `XDG_DATA_HOME=${shadowData}; existing shadow reused (resumed turn)`,
    });
  },

  launch(ctx: LaunchContext): Promise<LaunchOutcome> {
    return runAcpTurn(ctx, {
      argv: [ctx.binPath, "acp"],
      configure: async (client, sessionId, retryOnConfigUpdate) => {
        // Model FIRST — the effort option appears only after the model set.
        const modelRes = await retryOnConfigUpdate(() => setConfig(client, sessionId, "model", ctx.model));
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
