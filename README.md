# subturn

Run subagents in any coding agent you have installed, from any MCP client. You pick the harness and model, it handles the rest.

It is an MCP server. A coding agent calls it with a harness, a model and effort, a prompt, and a working directory; Subturn starts a session in that harness with the logins you already have, hands back the harness's own session id, and the caller collects the answer later. Codex, Claude Code, Grok, and OpenCode are supported today. The npm package, the MCP server name, and the CLI binary are all called `subturn`. Why it is shaped this way is in [AGENTS.md](AGENTS.md).

## Install and wire up

The MCP server is a stdio process. Any host that can run a command as an MCP server can run it via `npx`:

```sh
claude mcp add subturn -- npx -y subturn serve      # Claude Code
codex mcp add subturn -- npx -y subturn serve       # Codex
```

For hosts configured by file, the entry is the same command:

```json
{ "command": "npx", "args": ["-y", "subturn", "serve"] }
```

`npx -y` fetches the package on first use, which can trip a host's MCP start-up timeout on a cold machine. When that matters, install once and point the host at the binary:

```sh
npm install -g subturn
claude mcp add subturn -- subturn serve
```

Requires Node 22 or newer. Until the package is published, `npx github:eshatalov/subturn` works the same way. From a checkout, `npm install` builds `dist/` and the server is `node dist/faces/mcp.js`.

## The caller's whole manual

An orchestrator needs one instruction file to use Subturn, and it has two parts. The first is a paragraph saying how to call the five tools. It is the same in every project, and it is the whole surface Subturn exposes; we keep it that size on purpose. The second is a routing table: which model, at which effort, for which kind of work, and where to go when the default falls short. That is where the real knowledge lives, it is written and tuned by the orchestrator's owner, and Subturn never gets in its way.

[CLAUDE.local.template.md](CLAUDE.local.template.md) is the whole file. Copy it to a project as `CLAUDE.local.md`, or paste it into whatever instruction file your host reads. Its table is an example trimmed to two harnesses; replace it with yours.

## CLI

The same binary is a CLI with the same verbs, plus human-only extras:

```sh
subturn spawn --harness opencode --model zai-coding-plan/glm-5.3 \
    --effort high --cwd /tmp/scratch --prompt "Reply with exactly: ok"
subturn await <session-id> --timeout 120
subturn resume <session-id> --prompt "And now do the next thing"
subturn cancel <session-id>
subturn inspect <session-id>
subturn status     # what is installed and logged in, advertised models; probes only
subturn prune      # delete every session not running now, without waiting out the 7 days
subturn serve      # the MCP stdio server
```

CLI `spawn` and `resume` detach a per-turn supervisor, so the one-shot invocation exits while the subagent runs.

## How it works

**Core** (`src/core`) has five functions, one per verb. Admission runs before any quota is spent: a persisted per-harness pin (binary path and version, self-healing on staleness) and a cheap auth check that never launches the harness (Codex's `auth.json` tokens, the macOS keychain item for Claude Code, Grok's and OpenCode's auth files). A spawn that dies before the harness produces a session id throws a plain error carrying the auth result, argv, stderr, and exit inline. Model ids are never gated: a wrong one fails inside the harness and comes back as evidence.

**Sessions** live under `~/.local/state/subturn/sessions/<session-id>/` (`SUBTURN_STATE_DIR` overrides). The directory holds the record, the prompt, the spawn command, the event stream as it happens, stderr, the acknowledged bundle where the harness echoes one, and the final text, so `inspect` works on a running session. Retention is 7 days after the last turn (`SUBTURN_RETENTION_DAYS`), swept on each spawn or on demand by `prune`; the resume window is the retention window, because the harness state needed for resume lives in the same directory. The deadline default is 3600 s (`SUBTURN_DEADLINE_S`), the maximum six hours.

**Supervisor** (`src/core/supervisor.ts`) runs every turn in its own detached process, so neither an MCP server restart nor a one-shot CLI exit can orphan a run. It publishes the native id the moment the harness reports it, reaps at the deadline or on `cancel` through one kill path (the harness child and every process it spawned, since tool shells often sit in their own process group), runs the plugin's hygiene, and absorbs id rotation on resume by keeping the old id resolvable.

**Faces** (`src/faces`) are single files over the core. The interface is defined once as data in `interface.ts`; the MCP server and the CLI both derive from it, so they cannot drift. The MCP server holds no state and loads the core on the first tool call, since it sits in every host session and most never spawn. Unknown parameters are refused by the verb table itself.

**Plugins** (`src/plugins`) answer a small interface per harness: detection hints, auth, advertised models, shadow home, launch, and post-turn hygiene. Adding a harness is one entry in the registry; plugin modules load on first use.

| harness  | transport | bundle | resume | session hygiene |
|----------|-----------|--------|--------|-----------------|
| opencode | native ACP (`opencode acp`) | `session/set_config_option` model then effort, every turn | ACP `session/load`, replay isolated from the new turn's final text | shadow data dir via `XDG_DATA_HOME`; `auth.json` symlinked back |
| grok     | native ACP (`grok agent … stdio`) | `-m` / `--reasoning-effort` every turn; ack read from `session/new` | ACP `session/load` | shadow home via `GROK_HOME`; `auth.json` symlinked back |
| codex    | headless `codex exec --json` | `-m` / `-c model_reasoning_effort=` every turn | `codex exec resume <id>` in the session's `CODEX_HOME` shadow | shadow home via `CODEX_HOME`; `auth.json` symlinked back; the user's `config.toml` deliberately not shared |
| claude   | headless `claude -p --output-format stream-json` | `--model` / `--effort` every turn | `claude -p --resume <id>` after restoring parked files | default config dir, because keychain auth is bound to it; session files parked out of `~/.claude/projects` the moment a turn ends |

Every plugin launches its harness in a validated permissive posture (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`, `--always-approve`, or Subturn's own allow-everything ACP permission handler). Concurrent sessions of one harness do not collide: shadow state is per session.

## Development

```sh
npm run typecheck   # src + tests
npm test            # scripted fake agent, offline, temp state dir; touches no real harness
npm run build       # dist/, what the faces run from
```

Tests need Node 22.18 or newer, since they run the TypeScript sources through Node's own type stripping. They drive the full path (spawn, detached supervisor, ACP client, evidence, resume, await) against `test/fake-agent.mjs`, including replay isolation on resume, the sequential-turn guard, id-rotation absorption, and claude parking on a temp config dir.

Live tests spend real quota and are gated:

```sh
SUBTURN_LIVE=1 node --test test/live.test.ts                      # smoke + resume, two tiny turns
SUBTURN_LIVE=1 SUBTURN_LIVE_KILL=1 node --test test/live.test.ts     # resume after a deadline kill
SUBTURN_LIVE=1 SUBTURN_LIVE_CANCEL=1 node --test test/live.test.ts   # cancel mid-turn, then resume
```

`SUBTURN_LIVE_HARNESS` picks the harness (default `opencode`); each harness has a cheap default bundle, and `SUBTURN_LIVE_MODEL` with `SUBTURN_LIVE_EFFORT` override it.
