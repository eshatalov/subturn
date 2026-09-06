// plugins/types.ts — the plugin interface. All harness complexity lives
// behind these functions (AGENTS.md "Plugins"): detect, auth, models,
// launch, home, finalize. Adding a harness is adding one module answering
// this interface; nothing else in Subturn changes.

import type { Usage } from "../core/state.ts";

export interface DetectHints {
  /** Binary name(s) to hunt on PATH. */
  binaryNames: string[];
  /** Extra directories to search beyond PATH (installers love ~/.x/bin). */
  wellKnownDirs: string[];
}

export interface AuthResult {
  ok: boolean;
  /** Human-oriented one-liner; shown by CLI `status`, carried inline in a
   * launch error. Never something a caller is expected to parse. */
  detail: string;
}

export interface ShadowHome {
  /** Environment overlay applied to the harness child. */
  env: Record<string, string>;
  /** Honest note about what the shadow does (evidence, spawn.json). */
  note: string;
}

export interface LaunchContext {
  binPath: string;
  model: string;
  effort: string;
  prompt: string;
  cwd: string;
  /** The session's evidence dir (staging for a first turn; stable for the
   * whole turn either way). */
  sessionDir: string;
  /** 1-based turn number. Turn 1 creates the harness session; turn >1 must
   * resume `nativeSessionId` non-forking, re-applying model+effort
   * explicitly (never let a resumed turn fall back to server defaults). */
  turn: number;
  /** The harness's own session id. In launch(): set iff turn > 1 (the id to
   * resume). By finalize() time the supervisor has updated it to the current
   * id (turn 1 included, once reported), so hygiene always knows the id. */
  nativeSessionId?: string | undefined;
  /** Absolute epoch ms; the supervisor reaps at this moment regardless. */
  deadlineMs: number;
  /** Environment overlay from home() — already includes the shadow home. */
  env: Record<string, string>;
  /** Append one parsed event to events.jsonl (evidence stream). */
  emit(event: Record<string, unknown>): void;
  /** Write a whole evidence file (ack.json, etc.). */
  writeEvidence(file: string, content: string): void;
  /** Report the harness child pid so the reaper can kill its group. */
  onChildPid(pid: number): void;
  /** Report the harness's OWN session id the moment it is known. On turn 1
   * this is what unblocks the caller's launch; on a resumed turn a different
   * id than the one resumed means the harness rotated ids — Subturn
   * absorbs that (records the new id, keeps the old one resolvable). */
  onNativeSessionId(id: string): void;
}

export interface LaunchOutcome {
  ok: boolean;
  finalText?: string;
  usage?: Usage;
  /** Failure detail for error.txt. Raw and honest; inspect returns it as-is. */
  error?: string;
}

export interface Plugin {
  readonly name: string;
  readonly hints: DetectHints;
  /** Cheap authorized check — must never launch the harness. */
  auth(): Promise<AuthResult>;
  /** Advertised model ids, best effort. CLI `status` only; may spawn a
   * throwaway handshake but must never run a prompt. Null = unavailable. */
  models(binPath: string): Promise<string[] | null>;
  /** Build the per-session shadow home (auth shared back, sessions private).
   * Idempotent: resumed turns reuse the same sessionDir and shadow. */
  home(sessionDir: string): Promise<ShadowHome>;
  /** Run the whole turn in the harness's validated permissive posture.
   * Runs inside the detached supervisor; streams evidence via ctx. */
  launch(ctx: LaunchContext): Promise<LaunchOutcome>;
  /** Session hygiene after a turn ends (completed, failed, or reaped) —
   * claude parks its session files out of the user's projects dir here.
   * Best-effort; the supervisor bounds it and runs it on every path. */
  finalize?(ctx: LaunchContext): Promise<void>;
}
