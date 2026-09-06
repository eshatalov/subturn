Delegate through the `subturn` MCP server. Never call the harness CLIs from Bash.

Spawn with a harness (`codex`, `claude`, `grok`, `opencode`), a full model id and a reasoning effort (both passed verbatim), a prompt, and an absolute cwd. After the few seconds the harness needs to come up you get its own session id back while the subagent runs on; if anything fails before the session exists, the spawn itself errors with the full detail inline. `await` the id for the outcome, waiting up to `timeout` seconds (default and max 300, `0` for a snapshot; the turn keeps running if the wait runs out): final text, usage, and the model and effort the harness acknowledged on success, bare `failed` or `cancelled` otherwise. `resume` the id with a new prompt to continue the conversation once its turn is no longer running; harness, model, effort, and cwd carry over, the id stays the same, and the conversation stays resumable for 7 days after its last turn. `cancel` kills a running turn and keeps the session. Every "why" is in `inspect`, which returns the raw evidence and works mid-run. Turns die at their deadline (default 3600 s), so fire-and-forget is safe; fan-out is just several spawns. Give the subagent a disposable cwd or worktree when cleanliness matters and diff it afterwards.

- The prompt is all the subagent sees. Put everything it needs in it.
- Subagents cannot delegate further. Cross-checks and reviews are separate spawns from here.
- Retries and fallbacks are yours. On `failed`, read `inspect` before trying again.
- Pick the bundle from the table and always pass the effort.

## Routing

`sol` = codex `gpt-5.6-sol`, `luna` = codex `gpt-5.6-luna`, `glm` = opencode `zai-coding-plan/glm-5.3`. `/` = any of these, `+` = both, findings merged. For `fable`, `opus`, `sonnet` and `haiku` don't use MCP, use native subagents instead

| Task | Default | When the default falls short |
|---|---|---|
| Search and reconnaissance in code | luna medium / glm low | sol medium |
| Mechanical implementation | luna high / glm high | sol high |
| Implementation with design decisions | sol high | fable high |
| Debugging, root cause | luna high / glm high | sol high |
| Review of a diff, when it matters | sol medium + glm high | sol high + fable medium + glm high |
| Docs and prose | sol medium | glm max |
| Plans and architecture | sol high | fable high |
| Data, scripts, pipelines | luna medium / glm low | sol medium |
