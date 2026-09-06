// core/discovery.ts — discovery is a mechanism, not a tool (AGENTS.md).
// A persisted per-harness pin (binary path + version) makes launch admit and
// spawn without a PATH hunt; the cache self-heals — a stale or missing entry
// triggers one probe, never a refusal.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { stateDir } from "./state.ts";
import type { DetectHints } from "../plugins/types.ts";

export interface Pin {
  binPath: string;
  version: string;
  /** mtime of the binary at probe time — a rewritten binary invalidates. */
  binMtimeMs: number;
  checkedAt: string;
}

type Cache = Record<string, Pin>;

function cacheFile(): string {
  return path.join(stateDir(), "discovery.json");
}

function readCache(): Cache {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as Cache;
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = cacheFile() + `.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, cacheFile());
  } catch {
    /* the cache is an accelerator; losing a write costs one re-probe */
  }
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** PATH + well-known dirs hunt. Returns the first executable hit. */
function findBinary(hints: DetectHints): string | null {
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((d) => d !== "");
  const extraDirs = hints.wellKnownDirs.map((d) => d.replace(/^~(?=\/|$)/, homedir()));
  for (const name of hints.binaryNames) {
    for (const dir of [...pathDirs, ...extraDirs]) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

const VERSION_TIMEOUT_MS = 10_000;

/** `<bin> --version`, first line, 10 s cap. Never throws. */
function captureVersion(binPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let out = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const firstLine = v?.split("\n", 1)[0]?.trim() ?? "";
      resolve(firstLine.length > 0 ? firstLine : null);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      done(null);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { out += d; });
    child.on("error", () => done(null));
    child.on("close", () => done(out));
  });
}

/**
 * Resolve the pin for one harness: cached when the binary is still the same
 * file, re-probed otherwise. Null = the harness is not installed.
 */
export async function resolvePin(name: string, hints: DetectHints): Promise<Pin | null> {
  const cache = readCache();
  const cached = cache[name];
  if (cached !== undefined) {
    try {
      const st = statSync(cached.binPath);
      if (st.isFile() && st.mtimeMs === cached.binMtimeMs) return cached;
    } catch {
      /* stale — fall through to re-probe */
    }
  }
  const binPath = findBinary(hints);
  if (binPath === null) {
    if (cached !== undefined) {
      delete cache[name];
      writeCache(cache);
    }
    return null;
  }
  const version = (await captureVersion(binPath)) ?? "unknown";
  let binMtimeMs = 0;
  try {
    binMtimeMs = statSync(binPath).mtimeMs;
  } catch {
    /* keep 0: next resolve re-probes */
  }
  const pin: Pin = { binPath, version, binMtimeMs, checkedAt: new Date().toISOString() };
  cache[name] = pin;
  writeCache(cache);
  return pin;
}
