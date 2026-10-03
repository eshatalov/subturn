// core/discovery.ts — discovery is a mechanism, not a tool (AGENTS.md).
// Every copy of the binary on PATH and in the well-known dirs is a
// candidate; the newest `--version` is launched. The persisted per-harness
// pin is keyed on that candidate set (paths, mtimes, sizes): while the set
// is unchanged, admission reuses the pin without a probe. A shim that
// dispatches to another file at run time does not change when its target
// does, so a pin also expires after PIN_TTL_MS and is probed again.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { stateDir } from "./state.ts";
import type { DetectHints } from "../plugins/types.ts";

export interface Candidate {
  binPath: string;
  /** First line of `--version`; "unknown" when it printed nothing. */
  version: string;
  /** mtime + size of the file the path resolves to. */
  fingerprint: string;
}

export interface Pin {
  binPath: string;
  version: string;
  checkedAt: string;
  /** Every distinct executable found, in hunt order; the pin is the newest
   * of them. CLI `status` lists the rest. */
  candidates: Candidate[];
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

function fingerprintOf(p: string): string {
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
}

/** PATH + well-known dirs hunt. Every executable hit, in hunt order, one
 * per real file; the first spelling of a file is kept. */
function findCandidates(hints: DetectHints): Array<{ binPath: string; fingerprint: string }> {
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((d) => d !== "");
  const extraDirs = hints.wellKnownDirs.map((d) => d.replace(/^~(?=\/|$)/, homedir()));
  const seen = new Set<string>();
  const found: Array<{ binPath: string; fingerprint: string }> = [];
  for (const name of hints.binaryNames) {
    for (const dir of [...pathDirs, ...extraDirs]) {
      const candidate = path.join(dir, name);
      if (!isExecutable(candidate)) continue;
      let real = candidate;
      try { real = realpathSync(candidate); } catch { /* keep the spelling */ }
      if (seen.has(real)) continue;
      seen.add(real);
      found.push({ binPath: candidate, fingerprint: fingerprintOf(candidate) });
    }
  }
  return found;
}

const VERSION_TIMEOUT_MS = 10_000;
const PIN_TTL_MS = 24 * 60 * 60 * 1000;

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

/** The first dotted number in a version line ("codex-cli 0.159.0",
 * "2.1.283 (Claude Code)", "grok 1.0.44 (abc) [stable]"). Null when none. */
function parseVersion(line: string): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(line);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** >0 when a is newer than b. Unparsable loses to parsed; two unparsable tie. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return (pa === null ? 0 : 1) - (pb === null ? 0 : 1);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function sameSet(
  cached: Candidate[] | undefined,
  found: Array<{ binPath: string; fingerprint: string }>,
): boolean {
  if (cached === undefined || cached.length !== found.length) return false;
  return cached.every((c, i) => c.binPath === found[i]?.binPath && c.fingerprint === found[i]?.fingerprint);
}

/**
 * Resolve the pin for one harness: cached while the installed set is
 * unchanged and the pin is younger than PIN_TTL_MS, re-probed otherwise.
 * Null = the harness is not installed.
 */
export async function resolvePin(name: string, hints: DetectHints): Promise<Pin | null> {
  const cache = readCache();
  const cached = cache[name];
  const found = findCandidates(hints);
  if (cached !== undefined && sameSet(cached.candidates, found)
    && Date.now() - Date.parse(cached.checkedAt) < PIN_TTL_MS) return cached;
  if (found.length === 0) {
    if (cached !== undefined) {
      delete cache[name];
      writeCache(cache);
    }
    return null;
  }
  const versions = await Promise.all(found.map((c) => captureVersion(c.binPath)));
  const candidates: Candidate[] = found.map((c, i) => ({ ...c, version: versions[i] ?? "unknown" }));
  // Newest wins; a tie keeps hunt order.
  let best = candidates[0] as Candidate;
  for (const c of candidates.slice(1)) {
    if (compareVersions(c.version, best.version) > 0) best = c;
  }
  const pin: Pin = { binPath: best.binPath, version: best.version, checkedAt: new Date().toISOString(), candidates };
  cache[name] = pin;
  writeCache(cache);
  return pin;
}
