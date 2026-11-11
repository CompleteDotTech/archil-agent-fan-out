# Radar runbook

This procedure separates preparation, execution, and evidence. A prepared judges' run is **not an execution**. Start it only when the presenter explicitly signals presentation time. The second execution remains incomplete until research, workers, PR delivery, and final verification all finish.

## Prerequisites

Run from the swarm repository with Node 22.19+, installed dependencies, `git`, and `gh`. The ignored `.env` supplies `ARCHIL_API_KEY`, `ARCHIL_DISK_ID`, `ARCHIL_REGION`, `GITHUB_TOKEN`, `GITHUB_PUSH_TOKEN`, and `OPENAI_API_KEY`. `KEENABLE_API_KEY` is optional; the adapter can use Keenable's public endpoints. Never print this file. The CLI loads it and makes `GITHUB_TOKEN` available to `gh` through `GH_TOKEN` without printing either value.

Environment variables take precedence; `.env` fills missing names. This session’s supplied GitHub tokens do not cover newly created targets. A working stored GitHub CLI login was verified: add `--github-cli-auth` to `seed` and `start` to use it explicitly in memory without changing `.env`.

The GitHub token must create a private disposable target repository under the requested owner and publish issues/PRs; the worker push token must access that target. Confirm applicable Archil concurrency limits before running. The architecture phase precedes three coding workers; research is an orchestrator preflight, not concurrent research inside coding sandboxes.

Verify local code with `npm run typecheck` and `npm test`. Check provider access with `node --env-file=.env --import tsx scripts/smoke.ts`; this creates and cleans up smoke infrastructure and does not count as a Radar execution.

## Run A: rehearsal

Choose a new repository name. Do not point this procedure at an existing application repository.

```bash
node --import tsx scripts/radar-run.ts prepare --mode rehearsal --repo OWNER/radar-rehearsal-UNIQUE --port 3000
```

Record the printed run ID as `REHEARSAL_ID`. Preparation creates `.swarm/radar/REHEARSAL_ID/run.json`, including software revision, mode, target, research mode, and preparation timestamp. It does not contact providers or start research/workers.

```bash
node --import tsx scripts/radar-run.ts seed --run REHEARSAL_ID
node --import tsx scripts/radar-run.ts start --run REHEARSAL_ID
```

`seed` creates a fresh private target repo from `demo/radar-seed`, pushes its initial commit, and records that exact seed commit. `gh` refuses an existing repository. `start` checks that target `main` still matches the recorded seed, acquires an exclusive start lock, and runs fresh Keenable research with real Archil/Codex workers. It uses the explicitly labeled Radar fixture **plan**, not fixture research or fake coding agents.

The dashboard URL is printed when the run begins. It shows the run ID and role/worker events. After the run ends, inspect:

- `run.json`: actual `startedAt`, `endedAt`, and terminal state;
- `dataset.json`: run-scoped structured research, sources, findings, retrieval timestamps, and unknown/conflicting fields;
- `events.json`: role status, worker attempts, gates, PRs, merges, and final integration;
- `artifacts/research/REHEARSAL_ID/`: each role's findings and archived page evidence;
- `artifacts/runs/REHEARSAL_ID/`: task manifests, checks, logs, and dataset-consumption receipts;
- `artifacts/delivery/REHEARSAL_ID/report.md`: delivery and verification results;
- `app.tgz`: preserved delivered application, excluding dependencies and Git metadata.

All paths above are beneath `.swarm/radar/REHEARSAL_ID/`. These ignored artifacts are local exhibits; preserve them with the recording and do not delete them to prepare another run. The application also remains in the target repository. An unsuccessful run is retained as `failed` and cannot be restarted under the same ID; prepare a new isolated run after repairing the cause.

Serve the preserved delivery without keeping cloud compute running:

```bash
node --import tsx scripts/radar-serve.ts --run REHEARSAL_ID --port 3200
node scripts/radar-browser.mjs http://127.0.0.1:3200 .swarm/radar/REHEARSAL_ID/browser --record-seconds 180 --dashboard 'http://127.0.0.1:3200/engineering?run=REHEARSAL_ID'
```

The browser command writes a silent three-minute walkthrough, screenshot evidence, behavioral QA, and a complete video decode check. It does not claim a narrated talk or a judges execution. The `/engineering` view is explicitly recorded evidence. For actual activity use `scripts/radar-capture.mjs LIVE_DASHBOARD_URL NEW_DIRECTORY 900` while a rehearsal runs; it records timestamped states and stops on a terminal event. Keep both the live capture and finished-app walkthrough.

If an earlier SDK version exported only top-level files, `node --import tsx scripts/radar-export.ts --run REHEARSAL_ID` retrieves nested raw pages and receipts. `node --import tsx scripts/radar-audit.ts --run REHEARSAL_ID` checks their claim mapping, hashes, ownership, PR gates, final results and parallel execution.

Open the merged target application and verify all filters, the details/evidence view, and shortlist persistence after reload. Confirm every displayed citation supports its named field; manually open representative official sources and compare them to the archived research quotes. Report any missing field or fewer than five verified events. Do not describe five candidates with failed fetches as five verified opportunities.

Capture a backup video showing the working app, actual role events, shared-disk receipts, separate workers, one finding-to-PR trace, and final test results. Play the resulting recording and confirm its video, duration, readable run ID, and actual content before calling it a checked backup. Record the file path and playback result in the rehearsal evidence index. A recording of static exhibits is not evidence that work was running live.

## Run B: prepare, start only on signal

Only after the rehearsal succeeds, prepare another new target:

```bash
node --import tsx scripts/radar-run.ts prepare --mode judges --repo OWNER/radar-judges-UNIQUE --port 3001
node --import tsx scripts/radar-run.ts seed --run JUDGES_ID
```

Stop here. This leaves a clean seeded repo and no research or worker execution. Keep the completed rehearsal app available separately while the new run works. Its shortlist is keyed to its own dataset run ID, so it cannot leak into the judges' run.

When the presenter explicitly says presentation time has arrived:

```bash
node --import tsx scripts/radar-run.ts start --run JUDGES_ID --presentation-now
```

The flag is an explicit signal, not a scheduling mechanism. Without it, the judges' start command fails before provider access or state mutation. Do not pre-add it to an unattended command. The command rejects a changed target seed or previously started run. The judges' run fetches new research rather than replaying the rehearsal dataset.

Complete and verify the judges' run even if the three-minute talk ends first. Its own `run.json`, dataset, events, receipts, PRs, report, and application artifact must exist before marking it complete. If live work stalls, state the actual status and switch to the labeled rehearsal result or checked recording. Never call fixture output, cached research, a recording, or a prepared command a live execution.

## Three-minute rehearsal script

**0:00–0:25 — working rehearsal app.** Say: “Give our swarm a product brief. It researches real opportunities, shares the evidence, and builds a tested app you can use.” Clearly label the rehearsal run. Use location/online, eligibility, and deadline filters to answer a real selection question. Save one result.

**0:25–1:00 — judges' research.** Open the distinct judges' dashboard and name its run ID. Show actual discovery/requirements/comparison states and one source. If research has completed, show the saved artifact and retrieval timestamp; do not pretend it is still searching.

**1:00–1:35 — handoff and workers.** Show the consolidated dataset, one task's matching consumption receipt, and separate Archil sandbox IDs for coding assignments. Explain architecture-first ordering and bounded, disjoint file ownership. Claim parallel workers only if their attempts overlap in the actual record.

**1:35–2:20 — finding to tested feature.** In the rehearsal evidence, trace a deadline from official source URL to finding ID, dataset field, coding task, passing filter/citation test, gated PR, merge, and rendered app. Distinguish research-derived event content from engineering design choices.

**2:20–3:00 — delivered app.** Reopen the citation, reload the saved shortlist, and finish on the app with its delivery evidence. State the fresh run's actual status. Recovery is optional and should not displace this core story.

Time one complete practice aloud. Record actual duration, failures/repairs, verified criteria, and unchecked criteria in the evidence index. “Implemented,” “rehearsed successfully,” and “demonstrated to judges” are separate claims.
