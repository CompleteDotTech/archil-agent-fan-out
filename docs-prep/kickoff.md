# Kickoff: build archil-agent-swarm with maximum fan-out

You are the ROOT orchestrator. Build this repo as fast as possible by keeping the largest number of Codex agents doing useful, non-overlapping work at every moment. Orchestration can go as many layers deep as the work supports.

## Setup

- **Model:** `gpt-6.1-sol` at Ultrafast speed. It is already set for you and for every child through the launch flags and the `SWARM_*` environment variables. Don't change them unless something below says to.
- **Deadlines (Pacific):**
  - 7:45 PM: fan-out starts.
  - 8:20 PM: no new work.
  - 8:30 PM: every orchestrator reports.
  - 9:00 PM: integrated and green.
  - 9:30 PM: table demos.
- **Read first:** `AGENTS.md`, `docs/PLAN.md`, `swarm/tasks.yaml`, `swarm/prompts/orchestrator.md` (the instructions every child orchestrator gets) and this file.

## Phase 0: foundation (target done by 7:45 PM)

Do R0.1 first, because everything depends on `node_modules`. Parallelize inside it: start the `npm install` commands, and write `tsconfig.json`, `vitest.config.ts` and the directory skeleton while they run. Run R0.1's verify commands, then commit.

R0.2 runs as a parallel split. Spawn three native subagents at once. They share this checkout and write different files, so they don't conflict:

1. `src/contracts/fakes/memory.ts`: MemoryStore and MemoryDisk.
2. `src/contracts/fakes/fixtures.ts`: FixtureResearch, FixturePlanner, RecordingPublisher and PassGate.
3. `src/contracts/fakes/sandbox.ts`: LocalSandboxRunner.

While they work, you write `tests/contracts/fakes.test.ts`, plus `src/contracts/fakes.ts` re-exporting all three. Wait for them, run R0.2's verify commands, then commit.

R0.3: run `node swarm/bin/swarm.mjs smoke`.
- If it fails on the model or speed, run `SWARM_SERVICE_TIER= node swarm/bin/swarm.mjs smoke`. If that passes, put `SWARM_SERVICE_TIER=` in front of every `orchestrate` command below, and tell the human Ultrafast is unavailable on this account.
- If it fails with sandbox errors, use `SWARM_LEAF_SANDBOX=bypass` the same way.
- If it still fails, stop and show the human `.swarm/logs/_smoke.log`.

## Phase 1: fan out everything at once (7:45 to 8:20 PM)

1. Run `node swarm/bin/swarm.mjs caps 24 16`. That allows 24 leaves and 16 orchestrator processes at once, across the whole tree.
2. Start all five workstream orchestrators in the same command, C first so the smoke script lands early:
   `for ws in C A B D E; do node swarm/bin/swarm.mjs orchestrate $ws; done`
3. They split their tasks using the hints below, hand sub-trees to child orchestrators, and keep capacity full. The tree can go as deep as useful.
4. While they run, you work too.
   - **Draft I1.** Write `src/cli.ts` and `src/compose.ts` against the factory names in the workstream `glue` entries of `swarm/tasks.yaml`. Get the `--local` fake path compiling first. Finish it after the merges.
   - **Monitor every 3 minutes:**
     - **Status.** Run `node swarm/bin/swarm.mjs status`, then give the human one line: merged / running / blocked counts, plus anything notable.
     - **Rate limits.** Run `grep -lE "429|rate.?limit|insufficient_quota" .swarm/logs/*.log` and look at logs from the last few minutes. If more than two show rate limiting, cut caps by about a third, for example `caps 16 12`. If nothing shows it and leaf capacity is full, raise caps by about a quarter, up to `caps 40 24`. You want as many agents as the API sustains without errors.
     - **Dead orchestrators.** An orchestrator process showing `crashed` or `failed` before its scope is done: restart it with `orchestrate <scope>`. It continues from the saved state.
     - **Notes.** "C1 merged" means: tell the human to run `npm run smoke` in their own terminal and paste you the table. Blocked or contract-change notes: decide fast. Only you change `src/contracts/**`. After a change, commit on main and tell affected orchestrators to run `git -C .wt/ws-<ID> merge main` (put the instruction in `.swarm/notes.md`).
5. **8:20 PM:** run `node swarm/bin/swarm.mjs note "STOP NEW WORK: finalize and report by 8:30"`.

## Phase 2: integrate (8:30 to 9:00 PM)

1. Merge with `node swarm/bin/swarm.mjs merge-ws <ID>` for C, A, B, D, E in that order. After each one, run `npm run typecheck && npm test`. Fix breakages yourself, or spawn fix-up leaves with `spawn-sub`, then commit.
2. Finish I1 until its verify commands pass. Use native subagents in parallel for independent fixes.
3. Hand over to the human for I2, I3 and I4, which need secrets. Give exact commands from `tasks.yaml`, and stay available for fixes.

## Split hints for orchestrators

**Patterns, in order of preference:**

- **(a) Independent files in parallel.**
- **(b) Stub first, then implementation and tests in parallel.** The orchestrator writes a stub with the final exported signatures in `.wt/<TASK>` (`throw new Error("not implemented")`) and commits it. Then it spawns an implementation part (owns the source file, verifies with typecheck) and a test part (owns the test file, verifies with typecheck) at the same time. After both merge, `finalize` runs the real tests.

Every part's OWNS must be a subset of its task's OWNS.

| Task | Parts |
|---|---|
| A1 | `keenable.ts` and its tests (b) |
| A2 | leaf |
| A3 | `schema.ts` + `prompt.ts`, then `planner.ts` and `planner.test.ts` in parallel (b) |
| A4 | leaf |
| B1 | `markers.ts` and `client.ts` in parallel, plus `client.test.ts` (b) |
| B2 | `publish.ts` and its tests (b) |
| B3 | `flow.ts` and its tests (b) |
| C1 | leaf (urgent) |
| C2 | `db.ts` and `store.ts` in parallel (stub `db.ts` first), plus `store.test.ts` |
| C3 | `sandbox.ts`, `disk.ts` and `sandbox.test.ts`, all in parallel (stub first) |
| C4 | `run-task.sh` and `tests/worker/run-task.test.ts` (b) |
| D1 | `state.ts` first, then `scheduler.ts` and `scheduler.test.ts` in parallel |
| D2 | `globs.ts` and `gate.ts` in parallel, plus `gate.test.ts` (b) |
| D3 | `integrate.ts` and its tests (b) |
| D4 | `recovery.ts` and its tests (b) |
| E1 | `server.ts` and `dev.ts` in parallel, plus tests |
| E2 | leaf |
| E3 | `fixtures/agent/T1` first; then `demo/target-seed/**`, `fixtures/agent/T2`, `T3`, `T4` and `demo/assemble.sh`, all in parallel. That's six agents. |
| E4 | `README.md`, `docs/DEMO.md` and `docs/architecture.md`, all in parallel |

## Stretch lists (spare capacity only)

Stretch work uses new files only, inside the workstream's OWNS. It runs as `spawn-sub` under a merged task (see `orchestrator.md`). Start it only after the workstream's core tasks are merged or running.

- **A:**
  - `src/research/cache.ts`: memoize Keenable results on the shared disk.
  - `src/planner/repair.ts`: one LLM repair pass for plans that fail validation.
- **B:**
  - `src/github/bootstrap.ts`: create labels, find the Project and Status field ids, and print the env lines.
  - `src/github/render.ts`: issue and PR body rendering, with snapshot tests.
- **C:**
  - `src/worker/bundle.sh` and `src/archil/bundle.ts`: git-bundle handoff, so no GitHub credentials sit in sandboxes.
  - `src/archil/image.ts`: a prebaked sandbox image with Codex and dependencies.
  - `scripts/rehearse.ts`: a one-command rehearsal.
- **D:**
  - `src/orchestrator/reviewer.ts`: an advisory LLM review in the report.
  - `src/orchestrator/race.ts`: best-of-two forks for T1.
  - `src/orchestrator/metrics.ts`: per-task timings.
- **E:**
  - `src/dashboard/public/graph.js`: a live dependency graph.
  - `src/dashboard/replay.ts`: replay a finished run from its events.
  - `docs/RECORDING.md`.

## Rules for the whole tree

- **Throughput wins, but never at the cost of a red merge.** Every merge passes its gate.
- **One owner per file at any moment.** Agents never share a file concurrently.
- **Nobody but you touches `main`.** Nobody but you edits `src/contracts/**`, `package.json`, `package-lock.json` or `tsconfig.json`.
- **No secrets.** None in code, logs or messages. Leaves have no network and need no secrets.
- **Human commands win.** If the human says "slow down", run `caps 6 4`. If they say "stop", run `pkill -f "swarm/bin/swarm.mjs _run"; pkill -f "codex exec"` and report state.

Start Phase 0 now.
