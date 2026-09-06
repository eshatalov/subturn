// faces/interface.ts — the caller-facing interface, defined ONCE as data.
// Both faces (MCP for agents, CLI for humans/scripts) derive from this
// table, so they cannot drift. Five verbs, a handful of obvious
// parameters; anything more is a defect in this layer (AGENTS.md).

import { MAX_WAIT_S } from "../core/limits.ts";
import { pluginNames } from "../plugins/index.ts";

// The core (and the plugins it pulls in) loads on the first call, not at
// startup: an MCP server sits in every host session, and most of them never
// spawn anything.
const core = () => import("../core/core.ts");

/** Behaviour hints for the host (MCP tool annotations); the model never
 * reads them as text. */
export interface Annotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface VerbSpec {
  name: string;
  description: string;
  /** JSON Schema for the verb's input object. */
  inputSchema: Record<string, unknown>;
  annotations: Annotations;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** Starts or continues a subagent that can touch anything in its cwd. */
const startsWork: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Reads Subturn's own state only. */
const readsOnly: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const str = (description: string): Record<string, unknown> => ({ type: "string", description });

const harnessList = (): string => {
  const names = pluginNames();
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names.join("");
};

/** Sent once in the MCP handshake; the host shows it to its model. */
export const instructions =
  `Use when you want a subagent running a specific model in another harness (${harnessList()}).`;

const sessionId = str("Session id returned by spawn.");
const deadline = { type: "number", description: "Kill the turn after this many seconds (default 3600)." };

// The MCP SDK does not enforce inputSchema; a stray key (say, a parameter
// from an older version) would otherwise be dropped silently and the call
// would run on defaults. Every verb refuses unknown keys, by its own schema.
const guarded = (spec: VerbSpec): VerbSpec => {
  const accepted = Object.keys(spec.inputSchema["properties"] as Record<string, unknown>);
  return {
    ...spec,
    run: (args) => {
      const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
      if (unknown.length > 0) {
        return Promise.reject(
          new Error(`${spec.name}: unknown parameter ${unknown.join(", ")} (accepted: ${accepted.join(", ")})`),
        );
      }
      return spec.run(args);
    },
  };
};

const specs: VerbSpec[] = [
  {
    name: "spawn",
    description:
      "Start a subagent on a prompt. Returns a session id in seconds; the answer comes from await. " +
      "Fails at once if the harness is not installed or not logged in.",
    inputSchema: {
      type: "object",
      properties: {
        harness: str(`One of ${harnessList()}.`),
        model: str("Model id as the harness names it, e.g. gpt-5.6-sol, zai-coding-plan/glm-5.3, grok-4.6."),
        effort: str("Reasoning effort as the harness names it, e.g. low, medium, high."),
        prompt: str("What you want done."),
        cwd: str("Absolute directory the subagent works in. It can write anything there."),
        timeout: deadline,
      },
      required: ["harness", "model", "effort", "prompt", "cwd"],
      additionalProperties: false,
    },
    annotations: startsWork,
    run: async (args) =>
      (await core()).spawn({
        harness: args["harness"] as string,
        model: args["model"] as string,
        effort: args["effort"] as string,
        prompt: args["prompt"] as string,
        cwd: args["cwd"] as string,
        timeout: args["timeout"] as number | undefined,
      }),
  },
  {
    name: "resume",
    description:
      "Continue a conversation once its turn is no longer running, keeping its context and settings. " +
      "Returns at once; the answer comes from await. Conversations stay resumable for 7 days after " +
      "their last turn.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        prompt: str("The follow-up."),
        timeout: deadline,
      },
      required: ["session_id", "prompt"],
      additionalProperties: false,
    },
    annotations: startsWork,
    run: async (args) =>
      (await core()).resume({
        session_id: args["session_id"] as string,
        prompt: args["prompt"] as string,
        timeout: args["timeout"] as number | undefined,
      }),
  },
  {
    name: "await",
    description:
      "Get the answer after spawn or resume, waiting up to timeout for the turn to finish. A turn " +
      "that outlasts the wait keeps running.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        timeout: {
          type: "number",
          description: `How long to wait, in seconds (max ${MAX_WAIT_S}, the default); 0 reports the current state without waiting.`,
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: readsOnly,
    run: async (args) => (await core()).awaitTurn(args["session_id"] as string, args["timeout"] as number | undefined),
  },
  {
    name: "cancel",
    description:
      "Stop a running turn: work you no longer need, or a subagent going the wrong way. Returns " +
      "once it is dead; the session stays available for inspect and resume. On a finished turn it " +
      "changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args) => (await core()).cancel(args["session_id"] as string),
  },
  {
    name: "inspect",
    description:
      "Explain a session: use when await reports a failure, the answer looks wrong, or to watch " +
      "what a running turn is doing. Returns the raw record: spawn command, event stream, " +
      "permission events, stderr, exit status, timing.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: readsOnly,
    run: async (args) => (await core()).inspect(args["session_id"] as string),
  },
];

export const verbs: VerbSpec[] = specs.map(guarded);
