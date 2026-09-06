// plugins/index.ts — the plugin registry. Adding a harness is adding one
// entry; disabling one is removing it (it then refuses in spawn as an
// unknown harness and vanishes from CLI status). Plugin modules load on
// first use: names are free, so an MCP server that never spawns never pays
// for the plugins or the core they pull in.

import type { Plugin } from "./types.ts";

interface Entry {
  name: string;
  load(): Promise<Plugin>;
}

const builtIn: Entry[] = [
  { name: "codex", load: () => import("./codex.ts").then((m) => m.codexPlugin) },
  { name: "claude", load: () => import("./claude.ts").then((m) => m.claudePlugin) },
  { name: "grok", load: () => import("./grok.ts").then((m) => m.grokPlugin) },
  { name: "opencode", load: () => import("./opencode.ts").then((m) => m.opencodePlugin) },
];

// Test seam: the fake plugin exists only when SUBTURN_FAKE_AGENT names a
// fake agent script (fake.ts reads the same variable for the script path).
const fake: Entry = { name: "fake", load: () => import("./fake.ts").then((m) => m.fakePlugin) };

function entries(): Entry[] {
  const script = process.env["SUBTURN_FAKE_AGENT"];
  return script !== undefined && script !== "" ? [...builtIn, fake] : builtIn;
}

export function pluginNames(): string[] {
  return entries().map((e) => e.name);
}

export function loadPlugin(name: string): Promise<Plugin | undefined> {
  const entry = entries().find((e) => e.name === name);
  return entry === undefined ? Promise.resolve(undefined) : entry.load();
}

export async function loadPlugins(): Promise<Map<string, Plugin>> {
  const map = new Map<string, Plugin>();
  for (const e of entries()) map.set(e.name, await e.load());
  return map;
}
