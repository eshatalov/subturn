#!/usr/bin/env node
// faces/cli.ts — the CLI face: the same five verbs as the MCP face, derived
// from the same verb table, plus the human-only extras that would be dead
// context weight as MCP tools:
//   subturn status   — what's installed and authorized, advertised models
//   subturn prune    — delete every session that is not running right now
//   subturn serve    — run the MCP stdio server (what hosts configure)
// The CLI's spawn/resume detach their per-turn supervisor (core does), so
// this one-shot process exits while the subagent runs.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import { verbs } from "./interface.ts";
import { startMcpServer } from "./mcp.ts";

function usage(): string {
  return [
    "subturn — run subagent turns in any installed harness",
    "",
    "  subturn spawn --harness <h> --model <m> --effort <e> --cwd <dir> \\",
    "                  (--prompt <text> | --prompt-file <file>) [--timeout <n>]",
    "  subturn resume <session-id> (--prompt <text> | --prompt-file <file>) [--timeout <n>]",
    "  subturn await <session-id> [--timeout <n>]",
    "  subturn cancel <session-id>",
    "  subturn inspect <session-id>",
    "  subturn status            # human-only: pins, auth, advertised models",
    "  subturn prune             # human-only: delete every session not running now (no more resume)",
    "  subturn serve             # run the MCP stdio server",
    "",
    "Session ids are the harnesses' own. All verbs print JSON (status and prune print a line).",
  ].join("\n");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runVerb(name: string, args: Record<string, unknown>): Promise<void> {
  const verb = verbs.find((v) => v.name === name);
  if (verb === undefined) throw new Error(`unknown verb ${name}`);
  printJson(await verb.run(args));
}

function promptFrom(values: { prompt?: string | undefined; "prompt-file"?: string | undefined }): string | undefined {
  if (values.prompt !== undefined) return values.prompt;
  if (values["prompt-file"] !== undefined) return readFileSync(values["prompt-file"], "utf8");
  return undefined;
}

async function cmdSpawn(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      harness: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      cwd: { type: "string" },
      "timeout": { type: "string" },
    },
  });
  await runVerb("spawn", {
    harness: values.harness,
    model: values.model,
    effort: values.effort,
    prompt: promptFrom(values),
    cwd: values.cwd ?? process.cwd(),
    ...(values["timeout"] !== undefined ? { timeout: Number(values["timeout"]) } : {}),
  });
}

async function cmdResume(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      "timeout": { type: "string" },
    },
    allowPositionals: true,
  });
  await runVerb("resume", {
    session_id: positionals[0],
    prompt: promptFrom(values),
    ...(values["timeout"] !== undefined ? { timeout: Number(values["timeout"]) } : {}),
  });
}

async function cmdAwait(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "timeout": { type: "string" } },
    allowPositionals: true,
  });
  await runVerb("await", {
    session_id: positionals[0],
    ...(values["timeout"] !== undefined ? { timeout: Number(values["timeout"]) } : {}),
  });
}

async function cmdCancel(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  await runVerb("cancel", { session_id: positionals[0] });
}

async function cmdInspect(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  await runVerb("inspect", { session_id: positionals[0] });
}

async function cmdPrune(): Promise<void> {
  // Human-only. The retention sweep with a zero window: every session whose
  // turn is not running goes, evidence and all; running ones are untouched.
  const { sweepExpired } = await import("../core/state.ts");
  const { removed, running } = sweepExpired(0);
  console.log(`removed ${removed} session(s); ${running} still running, kept`);
}

async function cmdStatus(): Promise<void> {
  // Human-only. Probes: version/auth/handshake — never a prompt.
  const { loadPlugins } = await import("../plugins/index.ts");
  const { resolvePin } = await import("../core/discovery.ts");
  const rows: string[] = [];
  for (const [name, plugin] of await loadPlugins()) {
    const pin = await resolvePin(name, plugin.hints);
    if (pin === null) {
      rows.push(`${name.padEnd(9)} not installed`);
      continue;
    }
    const auth = await plugin.auth();
    let modelsLine = "";
    if (auth.ok) {
      const models = await plugin.models(pin.binPath);
      modelsLine = models !== null
        ? `\n${" ".repeat(10)}models: ${models.join(", ")}`
        : `\n${" ".repeat(10)}models: (no cheap advertisement for this harness)`;
    }
    rows.push(
      `${name.padEnd(9)} ${pin.version}\n` +
      `${" ".repeat(10)}binary: ${pin.binPath}\n` +
      `${" ".repeat(10)}auth:   ${auth.ok ? "ok" : "NOT AUTHORIZED"} — ${auth.detail}` +
      modelsLine,
    );
  }
  console.log(rows.join("\n"));
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    switch (verb) {
      case "spawn": await cmdSpawn(rest); return;
      case "resume": await cmdResume(rest); return;
      case "await": await cmdAwait(rest); return;
      case "cancel": await cmdCancel(rest); return;
      case "inspect": await cmdInspect(rest); return;
      case "status": await cmdStatus(); return;
      case "prune": await cmdPrune(); return;
      case "serve": await startMcpServer(); return;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(usage());
        return;
      default:
        console.error(`unknown verb: ${verb}\n\n${usage()}`);
        process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("/cli.js") || entry.endsWith("/cli.ts") || entry.endsWith("/subturn")) {
  void main();
}
