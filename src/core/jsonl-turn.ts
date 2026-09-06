// core/jsonl-turn.ts — one headless harness turn over a JSONL stdout stream
// (codex exec --json, claude -p --output-format stream-json). Spawn, feed
// the prompt on stdin and CLOSE it (codex hangs on an open stdin), stream
// every parsed event into evidence, and let a plugin extractor fold the
// stream into final text + usage.

import path from "node:path";

import type { LaunchContext, LaunchOutcome } from "../plugins/types.ts";
import { spawnHarness, writeStdinAndClose } from "./child.ts";
import { isRecord } from "./json.ts";

export interface JsonlFold {
  /** Called per parsed JSON event, in order. */
  onEvent(event: Record<string, unknown>): void;
  /** Called once after exit; decides the outcome. */
  finish(exit: { code: number | null; signal: string | null }, stderrTail: string): LaunchOutcome;
}

export async function runJsonlTurn(
  ctx: LaunchContext,
  argv: string[],
  fold: JsonlFold,
): Promise<LaunchOutcome> {
  const spawned = spawnHarness({
    argv,
    cwd: ctx.cwd,
    env: ctx.env,
    stderrFile: path.join(ctx.sessionDir, "stderr.log"),
  });
  ctx.onChildPid(spawned.pid);
  ctx.emit({ type: "spawn", argv, pid: spawned.pid });

  let buf = "";
  spawned.child.stdout?.setEncoding("utf8");
  spawned.child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        ctx.emit({ type: "non_json_line", line });
        continue;
      }
      if (!isRecord(parsed)) {
        ctx.emit({ type: "non_json_line", line });
        continue;
      }
      ctx.emit({ type: "harness_event", event: parsed });
      try {
        fold.onEvent(parsed);
      } catch {
        /* extractor bugs never kill the stream; the raw event is on disk */
      }
    }
  });

  writeStdinAndClose(spawned.child, ctx.prompt);
  const exit = await spawned.waitExit();
  ctx.emit({ type: "exit", code: exit.code, signal: exit.signal });
  return fold.finish(exit, spawned.stderrTail());
}
