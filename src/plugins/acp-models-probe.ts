// plugins/acp-models-probe.ts — throwaway ACP handshake for CLI `status`:
// spawn the agent, initialize + session/new in a temp cwd, read the
// advertised models, kill. Never sends a prompt; costs no quota. Models are
// read preferentially from `configOptions[]` entry with id "model"
// (`options[].value`, used by opencode and antigravity where
// `models.availableModels` may carry legacy effort-suffixed ids), falling
// back to `models.availableModels[].modelId` (grok).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AcpClient } from "../core/acp.ts";
import { spawnHarness } from "../core/child.ts";
import { isRecord } from "../core/json.ts";

/** Extract deduplicated model ids from a `session/new` response, preferring
 * `configOptions[id="model"]` when it yields at least one id and falling back
 * to `models.availableModels[].modelId`. */
export function extractAcpModels(res: unknown): string[] | null {
  if (!isRecord(res)) return null;
  const fromConfig: string[] = [];
  const configOptions = res["configOptions"];
  if (Array.isArray(configOptions)) {
    for (const o of configOptions) {
      if (!isRecord(o) || o["id"] !== "model" || !Array.isArray(o["options"])) continue;
      for (const entry of o["options"]) {
        if (!isRecord(entry)) continue;
        if (typeof entry["value"] === "string" && entry["value"] !== "") {
          fromConfig.push(entry["value"]);
        } else if (Array.isArray(entry["options"])) {
          // Grouped select option (ACP v1): flatten nested options.
          for (const nested of entry["options"]) {
            if (isRecord(nested) && typeof nested["value"] === "string" && nested["value"] !== "") {
              fromConfig.push(nested["value"]);
            }
          }
        }
      }
    }
  }
  if (fromConfig.length > 0) return [...new Set(fromConfig)];

  const fromAvailable: string[] = [];
  const models = isRecord(res["models"]) ? res["models"] : null;
  const available = models?.["availableModels"];
  if (Array.isArray(available)) {
    for (const m of available) {
      if (isRecord(m) && typeof m["modelId"] === "string" && m["modelId"] !== "") {
        fromAvailable.push(m["modelId"]);
      }
    }
  }
  return fromAvailable.length > 0 ? [...new Set(fromAvailable)] : null;
}

export async function probeAcpModels(
  argv: string[],
  env: Record<string, string>,
  opts?: { authMethodId?: string },
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
    const init = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, 20_000);
    if (!isRecord(init) || init["protocolVersion"] !== 1) return null;
    if (opts?.authMethodId !== undefined) {
      await client.request("authenticate", { methodId: opts.authMethodId }, 20_000);
    }
    const res = await client.request("session/new", { cwd, mcpServers: [] }, 30_000);
    return extractAcpModels(res);
  } catch {
    return null;
  } finally {
    client.close();
    spawned.killGroup();
    rmSync(cwd, { recursive: true, force: true });
  }
}
