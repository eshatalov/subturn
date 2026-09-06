// core/acp.ts — a minimal ACP (Agent Client Protocol) client: JSON-RPC 2.0
// over ndjson on a child's stdio. Used by the opencode and grok plugins (and
// the fake-agent tests). Client behavior:
//   - session/request_permission is ALWAYS answered with the most permissive
//     option (launch posture: no prompt may fire unanswered) and recorded as
//     a permission event in the evidence stream;
//   - fs/* and unknown requests get -32601 (we offer no fs capability);
//   - unknown notifications are recorded, never answered;
//   - non-JSON stdout lines are recorded verbatim (evidence, not garbage).

import type { ChildProcess } from "node:child_process";
import { isRecord } from "./json.ts";

export interface AcpHooks {
  /** Every noteworthy wire event, appended to events.jsonl. */
  emit(event: Record<string, unknown>): void;
  /** session/update notifications for the active session. */
  onSessionUpdate(sessionId: string, update: Record<string, unknown>): void;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Most permissive first: the posture is "the subagent never hears no". */
function pickPermissionOption(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  const parsed = options
    .filter(isRecord)
    .map((o) => ({
      optionId: typeof o["optionId"] === "string" ? o["optionId"] : null,
      kind: typeof o["kind"] === "string" ? o["kind"] : "",
    }))
    .filter((o): o is { optionId: string; kind: string } => o.optionId !== null);
  if (parsed.length === 0) return null;
  for (const kind of ["allow_always", "allow_once"]) {
    const hit = parsed.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  const nonReject = parsed.find((o) => !o.kind.startsWith("reject"));
  return (nonReject ?? parsed[0]!).optionId;
}

export class AcpClient {
  private readonly child: ChildProcess;
  private readonly hooks: AcpHooks;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";
  private dead = false;
  private readonly extNotificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(child: ChildProcess, hooks: AcpHooks) {
    this.child = child;
    this.hooks = hooks;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stdout?.on("end", () => this.markDead("stdout ended"));
    child.stdout?.on("error", () => this.markDead("stdout error"));
    child.on("exit", () => this.markDead("process exited"));
  }

  /** Register a handler for a vendor extension notification. */
  onExtNotification(method: string, handler: (params: unknown) => void): void {
    this.extNotificationHandlers.set(method, handler);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.dead) {
        reject(new Error(`acp line is dead (${method} not sent)`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
      if (!this.writeLine({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`acp stdin not writable (${method} not sent)`));
      }
    });
  }

  close(): void {
    try { this.child.stdin?.end(); } catch { /* already closed */ }
  }

  private writeLine(obj: unknown): boolean {
    const stdin = this.child.stdin;
    if (this.dead || !stdin || stdin.destroyed) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      this.markDead("stdin write failed");
      return false;
    }
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    const err = new Error(`acp process died: ${reason}`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line === "") continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.hooks.emit({ type: "non_json_line", line });
      return;
    }
    if (!isRecord(msg)) {
      this.hooks.emit({ type: "non_json_line", line });
      return;
    }
    const method = msg["method"];
    if (typeof method === "string") {
      if ("id" in msg && msg["id"] !== undefined && msg["id"] !== null) {
        this.handleAgentRequest(msg["id"], method, msg["params"]);
      } else {
        this.handleAgentNotification(method, msg["params"]);
      }
      return;
    }
    this.handleResponse(msg);
  }

  private handleAgentRequest(id: unknown, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      const p = isRecord(params) ? params : {};
      const toolCall = isRecord(p["toolCall"]) ? p["toolCall"] : {};
      const optionId = pickPermissionOption(p["options"]);
      // Evidence: permission events with their paths (AGENTS.md inspect).
      this.hooks.emit({
        type: "permission_request",
        title: toolCall["title"] ?? null,
        kind: toolCall["kind"] ?? null,
        locations: toolCall["locations"] ?? null,
        options: p["options"] ?? null,
        auto_selected: optionId,
      });
      if (optionId === null) {
        this.writeLine({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      this.writeLine({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "selected", optionId } },
      });
      return;
    }
    if (method === "fs/read_text_file" || method === "fs/write_text_file") {
      this.hooks.emit({ type: "fs_request_refused", method });
      this.writeLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "fs capability not offered" },
      });
      return;
    }
    this.hooks.emit({ type: "unknown_agent_request", method, params: params ?? null });
    this.writeLine({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }

  private handleAgentNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const p = isRecord(params) ? params : {};
      const sessionId = typeof p["sessionId"] === "string" ? p["sessionId"] : "";
      const update = isRecord(p["update"]) ? p["update"] : {};
      this.hooks.onSessionUpdate(sessionId, update);
      return;
    }
    const ext = this.extNotificationHandlers.get(method);
    if (ext !== undefined) {
      this.hooks.emit({ type: "ext_notification", method, params: params ?? null });
      ext(params);
      return;
    }
    // Unknown notifications: recorded, never answered.
    this.hooks.emit({ type: "unknown_notification", method, params: params ?? null });
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const rawId = msg["id"];
    const id = typeof rawId === "number" ? rawId : Number(rawId);
    const pending = this.pending.get(id);
    if (pending === undefined) return; // late/foreign response
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = msg["error"];
    if (error !== undefined && error !== null) {
      const e = isRecord(error) ? error : {};
      pending.reject(
        new RpcError(
          typeof e["code"] === "number" ? e["code"] : -32000,
          typeof e["message"] === "string" ? e["message"] : "rpc error",
          e["data"],
        ),
      );
      return;
    }
    pending.resolve(msg["result"]);
  }
}
