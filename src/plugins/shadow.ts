// plugins/shadow.ts — helpers for building shadow homes: a harness home
// where auth is shared back from the user's real home (symlink) and session
// state stays private to Subturn (AGENTS.md principle 5).

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Symlink `realPath` into the shadow at `linkPath` when the real file
 * exists. Returns whether the link was made. */
export function shareAuth(realPath: string, linkPath: string): boolean {
  if (!existsSync(realPath)) return false;
  ensureDir(path.dirname(linkPath));
  try {
    symlinkSync(realPath, linkPath);
    return true;
  } catch {
    // Already linked (session dir reuse) or unlinkable — the launch will
    // surface the real failure if auth is genuinely missing.
    return existsSync(linkPath);
  }
}
