// core/acp-turn.ts — one full subagent turn over ACP: spawn → initialize →
// session/new (or session/load when resuming) → configure (plugin hook) →
// prompt → final text. Shared by the opencode and grok plugins (and the test
// fake). Evidence streams to disk as it happens via ctx.emit; the caller's
// deadline bounds the prompt phase.
//
// Resume (ctx.nativeSessionId set): session/load {sessionId, cwd,
// mcpServers} — the non-forking ACP resume. Agents replay the conversation
// as session/update notifications during load; replayed agent_message_chunks are evidence but must
// NOT leak into this turn's final text, so chunk collection starts only
// when the prompt is sent.

import type { LaunchContext, LaunchOutcome } from "../plugins/types.ts";
import type { Usage } from "./state.ts";
import { AcpClient, RpcError } from "./acp.ts";
import { spawnHarness } from "./child.ts";
import { isRecord } from "./json.ts";
import path from "node:path";

const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_NEW_TIMEOUT_MS = 60_000;
const SESSION_LOAD_TIMEOUT_MS = 120_000; // replay of a long history takes time

export interface AcpTurnPlan {
  argv: string[];
  /** Applied after session/new or session/load; returns the
   * acknowledged-bundle record for ack.json, or null when the harness
   * echoes nothing. Throw to fail. Runs on resumed turns too — this is
   * where model+effort are re-applied explicitly. */
  configure?: (client: AcpClient, sessionId: string) => Promise<Record<string, unknown> | null>;
  /** Extract the acknowledged bundle from the session/new response (grok:
   * models.currentModelId + reasoningEffort meta). */
  ackFromSessionNew?: (result: Record<string, unknown>) => Record<string, unknown> | null;
  /** grok's private prompt-completion fallback: race session/prompt against
   * the `_x.ai/session/prompt_complete` notification. */
  grokCompletionRace?: boolean;
  /** Vendor extension notifications the plugin wants to read (grok's
   * `_x.ai/session_notification` carries usage and model changes). The
   * sink lets a handler contribute usage candidates and patch ack.json
   * after it was first written (a harness may re-select the model AFTER
   * session/new; the patched ack is the evidence). */
  extNotifications?: Record<string, (params: unknown, sink: ExtSink) => void>;
}

/** The value a session/set_config_option response reports for `configId`:
 * either a flat `{currentValue}` echo or the full `configOptions` list
 * (opencode) with the matching option's currentValue. */
export function configuredValue(response: unknown, configId: string): string | undefined {
  if (!isRecord(response)) return undefined;
  if (response["configId"] === configId && typeof response["currentValue"] === "string") {
    return response["currentValue"];
  }
  const options = response["configOptions"];
  if (Array.isArray(options)) {
    for (const o of options) {
      if (isRecord(o) && o["id"] === configId && typeof o["currentValue"] === "string") return o["currentValue"];
    }
  }
  return undefined;
}

export interface ExtSink {
  usage(candidate: unknown): void;
  ack(patch: Record<string, unknown>): void;
}

function extractUsage(candidates: unknown[]): Usage | undefined {
  // Cheap extraction only (AGENTS.md non-goal: no metrics science). Walk the
  // last-seen usage-ish records for common token fields.
  const usage: Usage = {};
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const inp = c["input_tokens"] ?? c["inputTokens"];
    const out = c["output_tokens"] ?? c["outputTokens"];
    const total = c["total_tokens"] ?? c["totalTokens"];
    const cacheRead = c["cache_read_input_tokens"] ?? c["cachedReadTokens"] ?? c["cache_read_tokens"];
    const cacheCreate = c["cache_creation_input_tokens"] ?? c["cacheCreationTokens"];
    const reasoning = c["reasoning_tokens"] ?? c["reasoningTokens"];
    const cost = c["cost_usd"] ?? c["costUsd"] ?? c["total_cost_usd"];
    if (typeof inp === "number") usage.input_tokens = inp;
    if (typeof out === "number") usage.output_tokens = out;
    if (typeof total === "number") usage.total_tokens = total;
    if (typeof cacheRead === "number") usage.cache_read_input_tokens = cacheRead;
    if (typeof cacheCreate === "number") usage.cache_creation_input_tokens = cacheCreate;
    if (typeof reasoning === "number") usage.reasoning_tokens = reasoning;
    if (typeof cost === "number") usage.cost_usd = cost;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export async function runAcpTurn(ctx: LaunchContext, plan: AcpTurnPlan): Promise<LaunchOutcome> {
  const spawned = spawnHarness({
    argv: plan.argv,
    cwd: ctx.cwd,
    env: ctx.env,
    stderrFile: path.join(ctx.sessionDir, "stderr.log"),
  });
  ctx.onChildPid(spawned.pid);
  ctx.emit({ type: "spawn", argv: plan.argv, pid: spawned.pid });

  const finalChunks: string[] = [];
  const usageCandidates: unknown[] = [];
  let activeSessionId = "";
  let collecting = false; // off until the prompt goes out (replay isn't ours)

  const client = new AcpClient(spawned.child, {
    emit: (e) => ctx.emit(e),
    onSessionUpdate: (sessionId, update) => {
      if (activeSessionId !== "" && sessionId !== activeSessionId) {
        ctx.emit({ type: "foreign_session_update", sessionId, update });
        return;
      }
      ctx.emit({ type: collecting ? "session_update" : "session_update_replay", update });
      if (!collecting) return;
      if (update["sessionUpdate"] === "agent_message_chunk") {
        const content = update["content"];
        if (isRecord(content) && typeof content["text"] === "string") {
          finalChunks.push(content["text"]);
        }
      }
      if (isRecord(update["usage"])) usageCandidates.push(update["usage"]);
      else if (update["sessionUpdate"] === "usage_update") usageCandidates.push(update);
    },
  });

  // ack.json = the harness's echo at session setup (base) overlaid with
  // whatever vendor notifications reported later (patches). Patches are
  // kept apart so a session/new echo that lands AFTER an early
  // model_changed cannot erase it.
  let ackBase: Record<string, unknown> | null = null;
  let ackPatches: Record<string, unknown> = {};
  const currentAck = (): Record<string, unknown> | null =>
    ackBase === null && Object.keys(ackPatches).length === 0 ? null : { ...(ackBase ?? {}), ...ackPatches };
  const writeAck = (): void => {
    const ack = currentAck();
    if (ack !== null) ctx.writeEvidence("ack.json", JSON.stringify(ack, null, 2));
  };
  const sink: ExtSink = {
    usage: (candidate) => { usageCandidates.push(candidate); },
    ack: (patch) => {
      ackPatches = { ...ackPatches, ...patch };
      writeAck();
      ctx.emit({ type: "acknowledged_bundle_update", patch });
    },
  };
  for (const [method, handler] of Object.entries(plan.extNotifications ?? {})) {
    client.onExtNotification(method, (params) => handler(params, sink));
  }

  try {
    const initResult = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, INITIALIZE_TIMEOUT_MS);
    ctx.emit({ type: "initialize_result", result: initResult ?? null });
    if (!isRecord(initResult) || initResult["protocolVersion"] !== 1) {
      throw new Error(`initialize: unexpected protocolVersion in ${JSON.stringify(initResult)}`);
    }

    let sessionNewResult: Record<string, unknown> | null = null;
    if (ctx.nativeSessionId !== undefined) {
      // Non-forking resume: same session id, conversation continues.
      activeSessionId = ctx.nativeSessionId;
      const loadResult = await client.request("session/load", {
        sessionId: activeSessionId,
        cwd: ctx.cwd,
        mcpServers: [],
      }, SESSION_LOAD_TIMEOUT_MS);
      ctx.emit({ type: "session_load_result", result: loadResult ?? null });
    } else {
      const newResult = await client.request("session/new", {
        cwd: ctx.cwd,
        mcpServers: [],
      }, SESSION_NEW_TIMEOUT_MS);
      ctx.emit({ type: "session_new_result", result: newResult ?? null });
      if (!isRecord(newResult) || typeof newResult["sessionId"] !== "string") {
        throw new Error(`session/new: missing sessionId in ${JSON.stringify(newResult)}`);
      }
      sessionNewResult = newResult;
      activeSessionId = newResult["sessionId"];
    }
    // The harness's own id IS the session id (AGENTS.md). On turn 1 this
    // write is what unblocks the caller's launch.
    ctx.onNativeSessionId(activeSessionId);

    if (plan.ackFromSessionNew !== undefined && sessionNewResult !== null) {
      ackBase = plan.ackFromSessionNew(sessionNewResult);
    }
    if (plan.configure !== undefined) {
      const configureAck = await plan.configure(client, activeSessionId);
      if (configureAck !== null) ackBase = { ...(ackBase ?? {}), ...configureAck };
    }
    if (currentAck() !== null) {
      writeAck();
      ctx.emit({ type: "acknowledged_bundle", ack: currentAck() });
    }

    // The prompt phase is bounded by the session deadline; the supervisor's
    // reaper is the authority, this timeout just keeps the promise settled.
    const promptTimeoutMs = Math.max(10_000, ctx.deadlineMs - Date.now() + 60_000);
    collecting = true;

    let promptResult: unknown;
    if (plan.grokCompletionRace === true) {
      const promptId = `subturn-${process.pid}-t${ctx.turn}`;
      let settled = false;
      const fallback = new Promise<unknown>((resolve, reject) => {
        client.onExtNotification("_x.ai/session/prompt_complete", (params) => {
          if (settled) return;
          const p = isRecord(params) ? params : {};
          if (p["sessionId"] !== activeSessionId) return;
          if (p["promptId"] !== undefined && p["promptId"] !== promptId) return;
          settled = true;
          if (p["stopReason"] === "error" || p["stopReason"] === "rate_limit") {
            reject(new Error(`grok prompt_complete: ${JSON.stringify(p)}`));
            return;
          }
          resolve({ stopReason: p["stopReason"] ?? "end_turn", _meta: p });
        });
      });
      const standard = client.request("session/prompt", {
        sessionId: activeSessionId,
        prompt: [{ type: "text", text: ctx.prompt }],
        _meta: { promptId, requestId: promptId },
      }, promptTimeoutMs);
      standard.then(() => { settled = true; }, () => { /* raced */ });
      promptResult = await Promise.race([standard, fallback]);
      // Late settlement of the loser is irrelevant; keep the process from
      // treating it as unhandled.
      void standard.catch(() => {});
      void fallback.catch(() => {});
    } else {
      promptResult = await client.request("session/prompt", {
        sessionId: activeSessionId,
        prompt: [{ type: "text", text: ctx.prompt }],
      }, promptTimeoutMs);
    }
    ctx.emit({ type: "prompt_result", result: promptResult ?? null });
    if (isRecord(promptResult)) {
      const meta = promptResult["_meta"];
      if (isRecord(meta) && meta["usage"] !== undefined) usageCandidates.push(meta["usage"]);
      if (promptResult["usage"] !== undefined) usageCandidates.push(promptResult["usage"]);
    }

    const stopReason = isRecord(promptResult) ? promptResult["stopReason"] : undefined;
    const finalText = finalChunks.join("");
    if (stopReason === "cancelled") {
      return { ok: false, error: `prompt stopReason=cancelled\nstderr tail:\n${spawned.stderrTail()}` };
    }
    const outcome: LaunchOutcome = { ok: true, finalText };
    const usage = extractUsage(usageCandidates);
    if (usage !== undefined) outcome.usage = usage;
    return outcome;
  } catch (e) {
    const detail = e instanceof RpcError
      ? `rpc error ${e.code}: ${e.message}\ndata: ${JSON.stringify(e.data)}`
      : e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `${detail}\nstderr tail:\n${spawned.stderrTail()}`,
    };
  } finally {
    client.close();
    // Graceful: give the harness a moment to exit on stdin close, then kill
    // the group (adapter children can outlive the leader).
    const exited = await Promise.race([
      spawned.waitExit().then(() => true),
      new Promise<false>((r) => setTimeout(r, 3000, false)),
    ]);
    if (!exited) ctx.emit({ type: "close_forced_kill", pid: spawned.pid });
    spawned.killGroup();
  }
}
