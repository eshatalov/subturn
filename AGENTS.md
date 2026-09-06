# Subturn

Subturn is a tiny MCP server for spawning subagents in other harnesses. Think of it as a thin layer between your main agent and the coding agent that runs the model you want for a particular task.

## Why we're building it

Every harness has its own specifics. Once you use a few of them side by side and tell your agent how to drive each one with its own set of options, the instructions get big and hard to maintain. And most attempts to use the CLIs without detailed instructions end in a chain of errors and investigations.

This project aims at a small, concise API for controlling subagents with the models you want to combine. So the rule for this project is simple. A caller should not have to know anything about a specific harness. If a caller has to remember a flag, an enum, a quirk, a minimum timeout, or a cleanup step for one harness, that is a bug in Subturn, and we fix Subturn.

## What we can never compromise on

### 1. The caller's surface stays tiny

Five tools, `spawn`, `resume`, `await`, `cancel`, `inspect`, each with a few obvious parameters. A calling agent should be able to use Subturn correctly after reading one paragraph (plus, probably, a table saying which model to use for which kind of task). A new parameter, error code, or concept for the caller has to prove it can't live inside Subturn instead.

### 2. The model and effort pass through; everything else stays inside

The caller names a harness, a full model id, and a reasoning effort. We pass the model and effort to the harness exactly as given. We don't keep a catalog, we don't validate them, we don't route. Which model to run is the caller's decision. Both are required, because a run without an explicit effort picks up whatever default the vendor has that week, and then the same prompt gives different results on different days.

Everything below that, the spawn command, the protocol, the spelling of flags, the things one harness does differently from the others, stays in that harness's plugin. That is where the complexity belongs; the core only validates inputs, picks a plugin, records, and reports. None of it may show up in a parameter, in an error the caller is expected to parse, or in a document the caller is expected to read.

### 3. We own the launch; the caller owns the debugging

Subturn starts the session correctly, tells you how it ended, and stops there. It doesn't retry, back off, track quota, or decide that a harness is flaky. All of that is policy, and the orchestrator is the one with the context to decide it. What Subturn owes the caller on failure is evidence. If the launch dies before the harness has produced a session, the error says everything we know, inline. Once a session exists, everything about it must be readable from `inspect`.

`await` and `inspect` have separate jobs. `await` tells you the outcome and never explains it. `inspect` gives you the raw record and never summarizes. If an `await` response leaves a question open, the answer is to look in `inspect`, not to make `await` say more.

### 4. The subagent is never told "no"; containment is the caller's job

There is no permission parameter. Permissions overcomplicate things fast: every harness has its own permission system, and none of them is compatible with the others.

Every plugin launches its harness with a permissive flag set that we have checked once, so no approval prompt can ever fire with nobody there to answer it. The subagent works at full strength.

That means the subagent can, in principle, touch anything on the machine. We accept that on purpose. The orchestrator knows the situation, so it decides: give the subagent a throwaway directory or worktree when it matters, diff it afterwards, read the evidence. That's one line of instructions and it's the same for every harness. We are not a security layer and we don't claim to be one.

### 5. Leave no trace in the user's harnesses

The user must never find Subturn sessions in their `codex resume`, `claude -r`, `grok sessions`, or `opencode session` lists, and a subagent must never pick up the user's project-level instruction files by accident. Each plugin keeps its harness's history private to Subturn, using whatever the harness already offers for that, a home-directory variable or a config-dir switch, rather than machinery of our own. What Subturn keeps is evidence, not an archive: it exists for `inspect` and `resume` and gets deleted after the retention window. When Subturn is gone, the user's machine looks the way it did before.

### 6. Session ids are the harness's own

The id we hand back is the harness's own session id, not something we minted. We may one day inspect or resume a session that Subturn did not start, so nothing in the design may assume an id was born here. If a harness changes its id on resume, Subturn keeps the old one working and the caller never notices.

## A note from the maintainer

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here. If a rule here fights the task in front of you, say so before you break it.

## Glossary

- **you** is the agent reading this file and changing Subturn.
- **me, us, and maintainers** mean the people building Subturn. These are who you are talking to now.
- **caller** is the agent calling Subturn's tools, usually an orchestrator running inside Claude Code or another host.
- **user** is the person the caller works for. They own the machine, subscriptions, and credentials Subturn borrows.
- **harness** is a coding agent Subturn can drive. Each one has a plugin.
- **plugin** is the module for one harness: how to find it, check its login, launch it safely, and clean up after it.
- **bundle** is a model id plus a reasoning effort, both required, both passed through as given.
- **session** is one conversation with a subagent, under the harness's own id. It is made of sequential **turns**.
- **launch posture** is the permissive flag set a harness is always started with. Fixed per plugin, not configurable.
- **shadow home** is a harness home directory the plugin builds per session, with the user's login shared in and the session history kept private.
- **evidence** is everything Subturn writes down about a session: the command, the event stream, stderr, timing, the outcome. `inspect` returns it.
- **face** is an entry point over the core. There are two: MCP for agents and a CLI for people and scripts. Neither holds state.

## The three ways to hurt yourself

1. **Running the built CLI against the real state dir.** `~/.local/state/subturn` holds the user's live sessions and their evidence. `subturn prune` deletes every finished session there, immediately, with no undo. Set `SUBTURN_STATE_DIR` to a scratch directory before you try any command by hand. The tests already do this for themselves.
2. **Spending the user's quota.** The live tests run real turns on the user's subscriptions. That is why they sit behind `SUBTURN_LIVE=1`. Run them when asked, and say afterwards how many turns you spent.
3. **Killing by pattern.** No `pkill -f`, no killing a pid you found by matching a name or a path. The harnesses under test are the same binaries the user is working in right now, and your own session is one of them. Kill only a pid you captured when you spawned it, or go through `cancel`.

## Verifying

- `npm run typecheck`, then `npm test`. The tests run the whole real path against a scripted fake agent, offline, in a temporary state dir. For most changes that is the proof.
- If you touched a face, check the built output too: `npm run build`, then a real stdio handshake or a CLI call, with `SUBTURN_STATE_DIR` pointed at scratch.
- If you touched the server's startup path, measure it: time to `initialize` and idle memory. The server runs in every host session, so a few megabytes get multiplied.
- For plugin changes the last word is a live smoke on one cheap bundle. Ask first.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(cli): unknown parameters are no longer accepted`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- One concern per PR. If the description says "also", split it.

## Non-goals

- No permission, sandbox, or isolation feature. See principle 4.
- No structured output, no metrics. Subturn returns the final text and whatever usage numbers are cheap to get; making sense of them is the caller's job.
- No workspace management. We don't create worktrees and we don't diff the caller's tree.
- No status or discovery tool for agents. "What's installed and logged in" is a question for a person, and the CLI answers it without costing anyone context.
