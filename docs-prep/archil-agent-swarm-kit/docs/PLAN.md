# Archil Agent Swarm: plan v2

**Updated 7:10 PM PT, Nov 10 2026, after review.**

Version 1 assumed four hours of build time. We have about 2 hours 20 minutes before table demos, so everything below is sized for that. The build itself is done by a Codex swarm; see the build section at the end and `swarm/tasks.yaml`.

## What we're building

A GitHub-driven agent swarm on Archil. The input is a brief and a target repo. The output is a tested application that was merged one pull request at a time. In between:

1. **Plan.** A planner, grounded in Keenable research, publishes an issue hierarchy with dependencies.
2. **Prepare.** The architecture task runs in a template Archil sandbox. The orchestrator then stops that sandbox and forks one sandbox per worker.
3. **Build.** Each fork runs a Codex worker on one ready task. Workers exchange context through a shared Archil disk.
4. **Check and merge.** A deterministic gate checks every result, and passing results merge one at a time.
5. **Recover.** A killed worker resumes where it stopped.

The promise: every assignment maps to an issue, every worker has a durable workspace, and every completed task has verification evidence.

## Event facts (checked tonight)

- **Schedule (PT):** table demos at 9:30, submissions close at 10:00, winners at 10:30. Teams of up to four.
- **Judging:** every project is judged in every track:
  - Most creative
  - Best use of Archil sandboxes or file systems
  - Best technical execution
  - Best use of Keenable ($1,000 in credits)
- **Archil access:** free via code `ArchilHackathon26`. Which limits apply isn't confirmed. If the Free-plan limits apply, that means 5 concurrent sandboxes, 30-minute sessions and allowlisted egress. Ask the Archil team, and run `npm run smoke` (task C1) as early as possible.
- **Keenable:**
  - $200 in credits per builder with code `N1WEB` at sign-up.
  - Keyless also works: `/v1/search/public` and `/v1/fetch/public` with an `X-Keenable-Title` header, 1,000 requests per hour per IP. Both were verified from a cloud machine tonight.
- **Models:** bring your own `OPENAI_API_KEY`. The planner uses it, and so does Codex in each sandbox (passed as `CODEX_API_KEY`).
- **Region:** sandboxes and SQLite exist only in AWS regions, so the disk, sandboxes and SQLite all go in `aws-us-west-2`. Region is fixed when a disk is created.

## What changed from v1

| v1 | v2 | Why |
|---|---|---|
| Disk in `gcp-us-central1` | Everything in `aws-us-west-2` | The GCP region has no sandboxes and no SQLite |
| Unspecified agent loop | `codex exec` in each sandbox, following Archil's Codex guide | Documented by Archil, with built-in resume (`codex exec resume --last`) |
| Clone and install per worker | Architecture task runs in a template sandbox, which is then stopped and forked once per worker | Identical code and `node_modules` everywhere; no lockfile conflicts |
| Heartbeats and leases | Execution handle plus deadline | Less code. Recovery is stop, start, resume |
| Reviewer agent | Deterministic gate: verify commands re-run in the fork, and the diff stays inside the task's owned paths. One retry, then Blocked | Fast and objective. An LLM reviewer is a stretch goal |
| Workers call GitHub | The orchestrator is the only GitHub API caller. Workers push attempt branches with a contents-only token | One paced queue, idempotent writes, stale attempts can't publish |
| Claim transactions | Single-writer orchestrator using batch transactions | Archil SQLite documents batch transactions only |
| Research inside workers | The planner researches with Keenable and writes cited notes to the shared disk, which workers read | Sandbox egress may block Keenable |
| Custom UI for everything | GitHub Project board for the hierarchy, plus one page for logs, sources, PRs and a Stop button | Less UI to build |
| Epic, feature, task, subtask, milestone | Epic and task only | Time |

## Components

| Component | Implementation | Workstream |
|---|---|---|
| Contracts | `src/contracts/types.ts` (frozen) and `fakes.ts` | root |
| Planner and validator | AI SDK `generateObject` with a zod schema. Validation rejects cycles, missing dependencies, tasks without verify commands, and owned paths that overlap between parallel tasks | A |
| Research | Keenable search and fetch. Writes `/research/<run>/<task>/sources.md` with citations | A |
| GitHub publisher | Paced queue (one write per second or slower), with dry-run mode. Creates issues, sub-issues, blocked-by links, Project items and status, PRs and squash merges | B |
| Store | Archil SQLite through `@archildata/sqlite`. One writer process | C |
| Sandboxes | Archil TypeScript SDK (`disk`): template, fork, run, stop, start | C |
| Worker | `src/worker/run-task.sh` inside each sandbox: Codex or fake agent, then verify, commit, push branch, write manifest, sync | C |
| Scheduler, gate, integrator, recovery | TypeScript in the orchestrator process | D |
| Dashboard | Hono server and SSE, plus one HTML page with a Stop button | E |
| Demo target | Bookmark manager seed repo plus fake-agent outputs | E |

## Shared disk layout

The disk is mounted in conditional mode, and each directory has one writer.

```
/swarm/worker/run-task.sh, /swarm/fixtures/agent/<task>/   orchestrator uploads these at run start
/spec/<run>/plan.json                                       orchestrator
/research/<run>/<task>/sources.{md,json}                    planner (Keenable)
/runs/<run>/<task>/<attempt>/task.json                      orchestrator
/runs/<run>/<task>/<attempt>/{agent.log,final.md,verify.log,manifest.json}   that attempt's worker
/delivery/<run>/report.md                                   integrator
```

Rules:

- **Sync:** workers sync after every file (`archil sync /mnt/archil`, falling back to `sync <file>`). Unsynced writes are lost if a sandbox is killed.
- **Signaling:** the orchestrator signals every handoff; nothing polls the disk. Readers run `archil invalidate-cache /mnt/archil` before reading.
- **No `archil checkout`:** a crashed client keeps its delegation.
- **Local files:** git clones and `node_modules` live on each sandbox's own root disk.

## Runtime state

SQLite, written only by the orchestrator:

- `runs`
- `tasks` (status, issue number)
- `attempts` (attempt id, n, sandbox id, resume flag, state, deadline, findings)
- `manifests`
- `events` (index, type, data). The dashboard streams these.

Writes that touch several rows use `db.transaction([...])`. With a single writer, claims aren't needed.

## Worker lifecycle (inside a fork)

1. The orchestrator writes `task.json`, then runs `run-task.sh` with `RUN_ID`, `TASK_ID`, `ATTEMPT_ID`, `BASE_COMMIT` and `RESUME`.
2. The worker checks out `swarm/<run>/<task>/<attempt>` and builds the prompt: task, owned paths, verify commands, research notes and gate findings.
3. It runs `codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>" < /dev/null`. On resume it runs `codex exec resume --last ...` instead. The VM itself is the sandbox.
4. It runs the verify commands, commits, and pushes the attempt branch.
5. It writes `manifest.json`, syncs, and exits.

`AGENT=fake` copies canned files instead of running Codex, so the whole pipeline can be tested in seconds.

## Gate

A result passes when both hold:

- The orchestrator re-runs every verify command in the fork and each exits 0.
- Every changed file matches the task's owned paths.

On failure, the task gets one retry with the findings, then becomes Blocked.

## Recovery (the Archil demo)

1. Someone presses Stop on a worker in the dashboard, which calls `sandbox.stop()`.
2. The exec ends without a manifest, so the attempt is marked interrupted.
3. The orchestrator creates attempt n+1, calls `sandbox.start()`, and runs `run-task.sh RESUME=1`.
4. Codex resumes its session on the same root disk.

Only the current attempt's manifest is accepted. If the orchestrator itself restarts, it treats every running attempt as interrupted and resumes it.

## GitHub mapping

- **Issues:** an epic issue, with task sub-issues and blocked-by links. Both linking endpoints take the issue's numeric `id`, not its `number`.
- **Project Status:** Backlog, Ready, Running, Review, Done, Blocked.
- **Pull requests:** one per passing attempt, with "Closes #n" in the body. They are squash-merged in dependency order.
- **Idempotency:** every body carries `<!-- swarm:<run>:<task> -->`, so a retry finds the existing issue instead of creating a duplicate.
- **Rate limits:** GitHub allows 500 content writes per hour, so develop in `--dry-run` and publish only full runs.

## Demo target: bookmark manager

The plan lives in `fixtures/plan.bookmarks.json`:

- **T1, architecture:** runs alone in the template sandbox and writes the contract and acceptance tests.
- **T2, T3, T4:** API and store, web UI, and search. They run in parallel forks.
- **Integration:** the orchestrator merges each PR, runs `npm test` on main, and writes the report.

The planner can generate a plan live. If its output doesn't validate, the run falls back to the fixture.

## Table demo

- **Finished run, open in tabs:** the Project board, PRs, the delivery report and research sources.
- **Live run, started at 9:25:** agents are working when judges walk up. Invite the judge to press Stop on a worker and watch it resume.
- **Backup:** a screen recording of the 9:00 rehearsal.

## Cuts and stretch goals

- **Cut:** LLM reviewer, heartbeats and leases, milestones and subtasks, Casco integration, multiple target repos.
- **Stretch, only after a full green run:**
  - LLM reviewer.
  - Git-bundle handoff, so sandboxes hold no GitHub credentials.
  - Archil credential brokering.
  - Orchestrator crash-and-resume demo.
  - Best-of-two forks for T1.

## Risks

| Risk | Mitigation |
|---|---|
| Sandbox egress is blocked | Run C1 at about 7:40. If GitHub is blocked, workers write a git bundle to the shared disk and the orchestrator pushes it |
| 30-minute session cap | Keep each task under about 15 minutes; resume handles a pause |
| Model rate limits (about 15 Codex agents in the build swarm) | On 429 errors, set `max_parallel_leaves_per_workstream: 1` |
| GitHub secondary rate limits | Dry-run by default |
| A live demo run fails | Recorded rehearsal plus the finished run's tabs |

## How the build is done: a Codex swarm in three layers

```
Root orchestrator: your Codex session on main (swarm/prompts/root.md)
  ├─ Layer 0: R0.1 scaffold and deps, R0.2 fakes, R0.3 worker-launch smoke test
  ├─ Layer 1: ws_orchestrator subagents A, B, C, D, E (.codex/agents/ws_orchestrator.toml)
  │    └─ Layer 2: leaf workers, one `codex exec` per task in .wt/<task>
  │         (started by swarm/bin/swarm.mjs; sandboxed, no network, ≤2 per workstream at a time)
  └─ Layer 3: merge ws/* into main, then I1 compose CLI, I2 real Archil, I3 rehearsal, I4 live run
```

Why the build swarm is shaped this way:

- **Subagent nesting:** Codex's docs allow one level of subagent nesting by default, so leaves are processes, not grandchild subagents.
- **Shared checkout:** agents editing the same checkout conflict, so every agent gets its own git worktree.
- **Ownership:** contracts and `package.json` are frozen in layer 0, so the 20 leaf tasks have disjoint owned paths and build against fakes.

**Timeline (PT):**

| Time | What |
|---|---|
| 7:15–7:35 | Layer 0, plus human setup (codes, AWS disk, repos, tokens) |
| 7:35–8:30 | Layers 1 and 2 fan out. C1 lands first and the human runs `npm run smoke` |
| 8:30–8:40 | Merge the workstreams |
| 8:40–9:00 | I1, then I2: fake agent on real Archil |
| 9:00–9:25 | I3 rehearsal and recording |
| 9:25 | I4 live run |
| Before 10:00 | Submit |
