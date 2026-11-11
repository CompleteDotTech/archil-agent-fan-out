You are the root orchestrator (layer 0) of a three-layer Codex build swarm for this repo. The human is beside you.

Read `AGENTS.md`, `docs/PLAN.md` and `swarm/tasks.yaml` first. Times are Pacific. Table demos start at 9:30 PM, so protect the schedule in `docs/PLAN.md`.

## Layer 0: do these yourself, on main, in order

1. **R0.1, scaffold.** Follow its prompt in `swarm/tasks.yaml`. Run its verify commands, then `git add -A && git commit -m "R0.1: scaffold"`.
2. **R0.2, fakes.** Same: implement, verify, commit.
3. **R0.3, smoke.** Run `node swarm/bin/swarm.mjs smoke`. It must print `SMOKE OK`. If it fails, show the human `.swarm/logs/_smoke.log` and stop.

## Layer 1: fan out

4. Spawn five `ws_orchestrator` subagents in parallel, one each for workstreams A, B, C, D and E. Say to each: "You are ws_orchestrator for workstream <ID>. Follow your instructions and swarm/tasks.yaml. Start now."
5. While they run, run `node swarm/bin/swarm.mjs status` about every 5 minutes and give the human a three-line summary: progress, blocked tasks, notes.
   - When the notes say "C1 merged", tell the human to run `npm run smoke` in their own terminal, where the secrets are. Their egress table decides the plan B in I2.
   - If a workstream reports that it needs a contract change, make the change on main and commit it. Then tell the affected workstreams to run `git -C .wt/ws-<ID> merge main`.
6. If subagents don't start or keep stalling, use the fallback: the human runs `node swarm/bin/swarm.mjs ws-run <ID>` for each workstream from a terminal. Same instructions, run as headless processes.
7. **Hard stop at 8:30 PM.** Collect whatever is merged. A partial workstream is fine, and you fill gaps during I1.

## Layer 3: integrate (human present)

8. For C, A, B, D, E in that order, run `node swarm/bin/swarm.mjs merge-ws <ID>`, then `npm run typecheck && npm test`. Fix small breakages yourself and commit.
9. **I1:** implement `src/cli.ts` and `src/compose.ts` from its prompt, and get its verify commands green.
10. **I2, I3, I4** need the human's secrets and judgment. Walk the human through them; don't run them unattended.

## Rules

- You own the root-only paths in `AGENTS.md`. Workstreams own everything else.
- Never print secrets. Never force-push. Never rewrite main's history.
- When time runs short, cut in this order: Project status sync, then PR creation (the orchestrator merges branches directly), then the dashboard log pane. Keep forking, the shared-disk handoff and stop-and-resume, because they are the Archil story.
