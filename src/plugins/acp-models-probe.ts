// plugins/acp-models-probe.ts — throwaway ACP handshake for CLI `status`:
// spawn the agent, initialize + session/new in a temp cwd, read the
// advertised models, kill. Never sends a prompt; costs no quota. Models are
// read from either shape a harness advertises them in: grok's
// `models.availableModels[].modelId`, or opencode's `configOptions[]` entry
// with id "model" (`options[].value`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AcpClient } from "../core/acp.ts";
import { spawnHarness } from "../core/child.ts";
import { isRecord } from "../core/json.ts";

export async function probeAcpModels(
  argv: string[],
  env: Record<string, string>,
): Promise<string[] | null> {
  const cwd = mkdtempSync(path.join(tmpdir(), "subturn-probe-"));
  const stderrFile = path.join(cwd, "stderr.log");
  let spawned: ReturnType<typeof spawnHarness>;
  try {
    spawned = spawnHarness({ argv, cwd, env, stderrFile });
  } catch {
    rmSync(cwd, { recursive: true, force: true });
    return null;
  }
  const client = new AcpClient(spawned.child, {
    emit: () => { /* probe: evidence not retained */ },
    onSessionUpdate: () => { /* none expected before a prompt */ },
  });
  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, 20_000);
    const res = await client.request("session/new", { cwd, mcpServers: [] }, 30_000);
    if (!isRecord(res)) return null;
    const ids: string[] = [];
    const models = isRecord(res["models"]) ? res["models"] : null;
    const available = models?.["availableModels"];
    if (Array.isArray(available)) {
      for (const m of available) {
        if (isRecord(m) && typeof m["modelId"] === "string") ids.push(m["modelId"]);
      }
    }
    const configOptions = res["configOptions"];
    if (Array.isArray(configOptions)) {
      for (const o of configOptions) {
        if (!isRecord(o) || o["id"] !== "model" || !Array.isArray(o["options"])) continue;
        for (const v of o["options"]) {
          if (isRecord(v) && typeof v["value"] === "string") ids.push(v["value"]);
        }
      }
    }
    // grok advertises the same ids in both shapes.
    return ids.length > 0 ? [...new Set(ids)] : null;
  } catch {
    return null;
  } finally {
    client.close();
    spawned.killGroup();
    rmSync(cwd, { recursive: true, force: true });
  }
}
