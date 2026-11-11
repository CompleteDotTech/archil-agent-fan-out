# Running the build swarm

1. **Add the kit to the repo.** Put these files in the root of a fresh clone of the product repo, then commit:

   ```bash
   git add -A && git commit -m "swarm kit"
   ```

2. **Check Codex and Node.** You need Codex CLI, logged in or with `CODEX_API_KEY` set, and Node 22.13 or later (`node -v`).

3. **Start the root orchestrator.** Do this in a shell that does *not* export your Archil, GitHub or Keenable secrets, because every agent inherits that environment and the root runs unsandboxed:

   ```bash
   codex --dangerously-bypass-approvals-and-sandbox
   ```

   Then tell it: "Read swarm/prompts/root.md and do it."

4. **Watch progress** from another terminal:

   ```bash
   node swarm/bin/swarm.mjs status
   tail -f .swarm/logs/<TASK>.log
   ```

5. **Run the secret-dependent steps in your own terminal**, with the secrets exported: `npm run smoke` once C1 lands, and later the I2–I4 runs.

   ```bash
   export ARCHIL_API_KEY=... ARCHIL_REGION=aws-us-west-2 ARCHIL_DISK_ID=dsk-...
   export GITHUB_TOKEN=... GITHUB_PUSH_TOKEN=... OPENAI_API_KEY=... KEENABLE_API_KEY=...
   export TARGET_REPO=<org>/swarm-demo-bookmarks
   ```

## If something goes wrong

| Problem | Fix |
|---|---|
| Subagents don't spawn | Run `node swarm/bin/swarm.mjs ws-run <A..E>` once per workstream, from a terminal |
| Leaf workers fail with EPERM or sandbox errors | `export SWARM_LEAF_SANDBOX=bypass` before starting the root |
| Model API returns 429 | Set `limits.max_parallel_leaves_per_workstream: 1` in `swarm/tasks.yaml` |
| You want a different model | `export SWARM_CODEX_ARGS="-m <model>"` |
| A worker hangs | It's killed after `leaf_timeout_minutes`; its state shows `failed` and its orchestrator retries it |

## Layout

- **Worktrees:** `.wt/ws-<ID>` (workstream branches) and `.wt/<TASK>` (leaf branches).
- **Harness files:** `.swarm/{state,out,logs,prompts,retry}`, plus `.swarm/notes.md`.

Everything under `.wt/` and `.swarm/` is gitignored.
