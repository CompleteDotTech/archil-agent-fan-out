# Running the build swarm

## Start

1. **Add the kit to the repo.** Put these files in the root of a fresh clone of the product repo, then commit:

   ```bash
   git add -A && git commit -m "swarm kit"
   ```

2. **Check prerequisites.**
   - Codex CLI, logged in or with `CODEX_API_KEY` set.
   - Node 22.13 or later (`node -v`).
   - Access to `gpt-6.1-sol`. Ultrafast in Codex needs the Pro tier on a ChatGPT account. With an API key it is available but bills at 6× the standard rate.

3. **Launch the root orchestrator.** Use a shell that does *not* export your Archil, GitHub or Keenable secrets, because every agent inherits it and orchestrators run unsandboxed:

   ```bash
   export SWARM_MODEL=gpt-6.1-sol SWARM_SERVICE_TIER=ultrafast SWARM_LEAF_EFFORT=medium SWARM_ORCH_EFFORT=low
   export SWARM_MAX_LEAVES=24 SWARM_MAX_ORCH=16
   codex -m gpt-6.1-sol -c service_tier=ultrafast -c model_reasoning_effort=medium \
     --dangerously-bypass-approvals-and-sandbox \
     "Read swarm/prompts/kickoff.md and execute it now."
   ```

4. **Watch progress** from another terminal:

   ```bash
   node swarm/bin/swarm.mjs status
   tail -f .swarm/logs/<ID>.log
   ```

5. **Run the secret-dependent steps in your own terminal**, with the secrets exported: `npm run smoke` when the notes say C1 merged, and later the I2–I4 runs.

## Shape of the swarm

- **Root:** your Codex session. It runs the foundation tasks itself and, for R0.2, three native subagents.
- **Workstream orchestrators:** five `codex exec` processes, one per workstream (`swarm.mjs orchestrate <WS>`).
- **Deeper orchestrators:** each orchestrator splits tasks into sub-tasks (`spawn-sub`), or hands sub-trees to child orchestrator processes (`orchestrate <TASK>`). Depth is unlimited.
- **Leaves:** sandboxed `codex exec` processes, each in its own git worktree.
- **Global caps:** 24 leaves and 16 orchestrator processes by default. Change them live with `node swarm/bin/swarm.mjs caps <leaves> <orch>`.

## If something goes wrong

| Problem | Fix |
|---|---|
| Codex refuses to start because of `.codex/config.toml` | Delete the offending line |
| The `orchestrator` agent's model is rejected | Delete its `model` line in `.codex/agents/orchestrator.toml` |
| Smoke fails on the model or speed | Prefix commands with `SWARM_SERVICE_TIER=` (no Ultrafast), or set `SWARM_MODEL=` to use your default model |
| Leaves fail with EPERM or sandbox errors | `export SWARM_LEAF_SANDBOX=bypass` before launching the root |
| Rate limits (429) | `node swarm/bin/swarm.mjs caps 12 8` |
| Costs climbing | `node swarm/bin/swarm.mjs caps 6 4` |
| Emergency stop | `pkill -f "swarm/bin/swarm.mjs _run"; pkill -f "codex exec"` |

## Layout

- **Worktrees:** `.wt/ws-<WS>` (workstream branches), `.wt/<TASK>` and `.wt/<TASK>.<sub>...` (task and sub-task branches).
- **Harness files:** `.swarm/state`, `out`, `logs`, `prompts`, `retry`, `adhoc`, `caps.json` and `notes.md`.

Everything under `.wt/` and `.swarm/` is gitignored.
