# Table demo: Archil Agent Swarm

Source: [plan v2](PLAN.md). These are rehearsal scripts for the planned system, not a record of completed implementation. Use each claim only after observing it in rehearsal; describe any unverified behavior as intended. All times below are Pacific Time (PT), November 10, 2026.

## Setup

- Rehearse and screen-record during the 9:00–9:25 window. Keep a successful run as the finished exhibit; note its run ID.
- Open that run's GitHub Project board, pull requests, delivery report and research sources in tabs. Keep the live dashboard separate and clearly identify which run is on screen.
- Use the bookmark manager target: T1 establishes architecture and acceptance tests in the template sandbox; T2 (API/store), T3 (web UI) and T4 (search) run in parallel forks.
- Check the Stop-and-resume sequence in rehearsal. Have the recording open at that moment before judges arrive.
- Start a fresh live run at 9:25 so workers are active for the 9:30 table demos. Do not rely on a fresh run finishing during the pitch.

## 60-second script

| Time | Spoken lines | Actions |
|---|---|---|
| 0:00–0:10 | “We turn a brief and a target repo into a tested application, with every assignment linked to an issue and every completed task backed by verification evidence.” | Show the finished run's Project board. |
| 0:10–0:25 | “Keenable grounds the plan in cited research. Architecture runs first in an Archil template; API, UI and search workers then build in separate forks, sharing context through an Archil disk.” | Open a research source, then switch to the live dashboard. |
| 0:25–0:45 | “Press Stop on this running worker. The recovery we are demonstrating restarts the same sandbox and resumes the Codex session.” | Invite the judge to press Stop once. Follow the sequence below; narrate only what appears. |
| 0:45–1:00 | “The gate re-runs checks and enforces owned paths. Passing PRs merge one at a time, then integration runs the tests on main.” | Show a finished-run PR and its delivery report. If recovery is still pending, say so and show the recorded sequence. |

## Three-minute script

| Time | Spoken lines | Actions |
|---|---|---|
| 0:00–0:25 | “The input is a brief and a repo. Our example is a bookmark manager. This completed run shows the issue hierarchy and dependencies; this other tab is the live run.” | Show the finished Project board and identify the two runs. |
| 0:25–0:50 | “The planner uses Keenable search and fetch, then writes cited research to the shared disk for workers to read. The planner can generate a plan live; if it fails validation, the run falls back to the fixture.” | Show the finished research sources. Disclose whether the exhibited plan used the fixture. |
| 0:50–1:15 | “Architecture and acceptance tests run in the template first. The template is stopped and forked for the API/store, UI and search tasks. Each worker has its own workspace; the shared disk carries context and evidence, and Archil SQLite holds orchestration state.” | Show the live workers and their tasks. |
| 1:15–2:00 | “Please press Stop on this running worker. We want to show that a stopped worker can continue its work in the same sandbox.” | Run the Stop moment below. Show the interruption and resume if observed; use the rehearsal recording if the live sequence stalls. |
| 2:00–2:40 | “A worker submits verification results and a manifest. The orchestrator re-runs every verify command and checks that changed files stay within the task's owned paths. A failed gate gets one retry, then the task becomes Blocked. Passing PRs merge sequentially in dependency order.” | Show a finished PR and verification evidence. Do not suggest a failed-gate example occurred unless the exhibit shows it. |
| 2:40–3:00 | “The final integration runs `npm test` on main and writes a delivery report. Issues explain the assignments, PRs show the changes, and the report shows the outcome.” | Finish on the completed run's delivery report and its actual result. |

## The “press Stop” moment

**Setup:** Select a worker that is currently running in the fresh live run. Keep its task and attempt visible. Do not press Stop on a finished task.

**Say:** “Press Stop on this worker. Watch whether it resumes in the same sandbox.”

**Action:** Let the judge press Stop once. The planned sequence is:

1. The dashboard calls `sandbox.stop()`.
2. Execution ends without a manifest; the attempt is marked interrupted.
3. The orchestrator creates attempt n+1, starts the same sandbox and runs the worker with `RESUME=1`.
4. Codex resumes its session on the same root disk. Only the current attempt's manifest is accepted.

**Say after observing recovery:** “That is the next attempt in the same sandbox, continuing the session.” Point to available task, attempt and sandbox evidence; do not infer recovery merely because Stop was pressed. The shared disk preserves synced evidence; unsynced writes can be lost when a sandbox is killed.

**If recovery is not visible within the pitch slot:** “The live recovery has not completed. Here is the rehearsal recording of the sequence.” Switch to the backup instead of promising immediate success.

## Fallback: rehearsal recording

- Record the 9:00 rehearsal, including the running worker, Stop, interruption, restart/resume and resulting verification evidence. Check playback before 9:25.
- Keep the recording ready alongside the finished run's board, PRs, report and sources. If the live run fails, show these exhibits and explicitly call the video a recording.
- If rehearsal did not demonstrate recovery, say it remains unverified. Show only the behavior and results actually captured; a recording is not evidence of a successful live run.
- If using `AGENT=fake`, label it as canned-file execution for pipeline testing. Do not present it as a live Codex coding session.

## 9:25 PM PT checklist

- [ ] Archil smoke check (`npm run smoke`) has passed; disk, sandboxes and SQLite use `aws-us-west-2`. Confirm applicable sandbox limits rather than assuming them.
- [ ] Finished-run ID is noted; its Project board, PRs, delivery report and cited research sources are open and readable.
- [ ] Actual verification and integration results have been reviewed; spoken claims match the evidence.
- [ ] Rehearsal recording plays and the Stop/resume segment is ready, or recovery is clearly marked unverified.
- [ ] A fresh live run is started, the correct dashboard is open, and a running worker is available for Stop.
- [ ] Presenter knows whether the run uses a generated or fixture plan and real Codex or fake-agent execution.
- [ ] Demo tabs and recording reveal no secrets.
- [ ] Ready for table demos at 9:30; leave time to submit before submissions close at 10:00.
