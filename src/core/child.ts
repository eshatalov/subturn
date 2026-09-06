// core/child.ts — spawn helper for harness children. Every child gets its
// own process group (detached) so the reaper can kill the whole tree, pipes
// only (never inherit), and stderr streamed straight into the session's
// evidence file.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

const STDERR_TAIL_CAP = 64 * 1024;

export interface HarnessChild {
  child: ChildProcess;
  pid: number;
  /** Bounded rolling tail of stderr (evidence has the full file). */
  stderrTail(): string;
  /** SIGKILL the whole process group; safe to call repeatedly. */
  killGroup(): void;
  /** Resolves with the exit record once the child exits. */
  waitExit(): Promise<{ code: number | null; signal: string | null }>;
}

export function spawnHarness(opts: {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stderrFile: string;
}): HarnessChild {
  const [cmd, ...args] = opts.argv;
  if (cmd === undefined) throw new Error("empty argv");
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    detached: true, // own process group — the reaper kills the whole tree
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawned child has no pid");

  let stderrStream: WriteStream | null = null;
  try {
    stderrStream = createWriteStream(opts.stderrFile, { flags: "a" });
  } catch {
    stderrStream = null;
  }
  let tail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CAP);
    stderrStream?.write(chunk);
  });
  child.stdin?.on("error", () => { /* EPIPE never crashes the supervisor */ });

  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      stderrStream?.end();
      resolve({ code, signal });
    });
    child.on("error", () => resolve({ code: null, signal: null }));
  });

  return {
    child,
    pid,
    stderrTail: () => tail,
    killGroup: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }
    },
    waitExit: () => exit,
  };
}

/** Write the prompt to stdin and close it. Codex hangs on an open stdin;
 * closing lets headless harnesses detect the end of the prompt. */
export function writeStdinAndClose(child: ChildProcess, text: string): void {
  try {
    child.stdin?.write(text);
  } catch { /* EPIPE — the exit path reports the real failure */ }
  try {
    child.stdin?.end();
  } catch { /* already closed */ }
}
