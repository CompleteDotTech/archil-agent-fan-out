# Hackathon Opportunity Radar demo

This is the requested next demo, replacing the bookmark manager as the primary
presentation concept. It is the implementation specification. Current execution status and concrete
evidence are recorded in [RADAR-EVIDENCE.md](RADAR-EVIDENCE.md); supported commands
are in [RADAR-RUNBOOK.md](RADAR-RUNBOOK.md). The specification itself is not evidence
that a run succeeded. The legacy bookmark script
below remains available as a labeled fallback.

## Hackathon Opportunity Radar: implementation prompt

Act as the implementation lead for this repository. Build and rehearse a demo in
which our swarm researches real hackathon opportunities and produces a useful,
tested application from a product brief. The audience should see research become
both reliable application data and concrete engineering work.

Read `AGENTS.md`, `docs/PLAN.md`, `swarm/tasks.yaml`, and the current code before
changing anything. Respect file ownership and preserve unrelated work. Audit the
existing planner, research, scheduler, dashboard, worker and integration paths.
Identify what works today and implement the missing pieces; do not present this
specification as an already working capability.

### 1. Product brief

“Build Hackathon Opportunity Radar for a developer deciding which hackathon to
enter. Research five real opportunities, explain the relevant requirements with
sources, and let the developer filter and save a shortlist. Deliver a working web
app with an API, automated tests and a visible record of how the swarm built it.”

Keep the product small and polished:

- Five real events with event name, official URL, location/online status, event
  dates, submission deadline and timezone when available, eligibility, and prizes
  or judging categories. Prefer upcoming events at research time. If fewer than
  five can be verified, report the shortfall; label historical examples explicitly.
- Filters for location/online status, eligibility and submission deadline. Use
  explicit eligibility categories such as student-only, open or unknown; do not
  claim a user qualifies when the sources are ambiguous.
- Event cards plus a readable details view. Each important factual field links to
  supporting evidence, with a retrieval timestamp. Display “unknown” or “not
  verified” rather than inventing missing facts. Distinguish deadline from event
  start date, and unknown prizes from no prizes.
- A saved shortlist that survives browser reload using local storage; scope it to
  the run so rehearsal selections do not appear in the judges' app. In-memory API
  data is acceptable; a database-backed user account system is out of scope.
- A source/evidence view reachable from the product. Keep the engineering dashboard
  separate so the finished app remains useful to an ordinary user.
- TypeScript, Hono and the existing test stack unless inspection establishes a
  concrete need to change them. Avoid accounts, payments, maps and broad scraping.

### 2. Three research roles, with a real handoff

Implement visible, bounded research jobs with explicit inputs, outputs, status,
error handling and a completion condition:

1. **Discovery:** use Keenable to find candidate events and official event pages.
   Produce a candidate list, source URLs and the rationale for selecting five.
2. **Requirements:** verify dates, deadlines, timezone, attendance mode and
   eligibility against official sources for the selected candidates.
3. **Comparison:** verify prizes, judging categories and submission deliverables
   for those same candidates. Summarize distinctions without inventing rankings.

Discovery precedes the other two roles; requirements and comparison may then run
in parallel. Prefer official sources. Preserve conflicting statements and flag
uncertainty rather than silently choosing a convenient answer. Every displayed
claim must map to a finding and supporting source. Give events, findings and
sources stable identifiers within the run.

Use Keenable through an orchestrator-owned research service. Development leaves
and sandbox coding workers must not gain network access just to perform research.
The current planner's research queries are not automatically three independent
research agents: implement and expose those roles, or accurately report the
remaining limitation. A role name alone is not evidence of an agent execution.

Write each role's structured JSON findings and human-readable cited notes to its
own run-scoped directory on the shared Archil disk. Include query, URL, retrieval
time, supported fields, verification status and errors. Define a validated schema
and a deterministic consolidation step that produces the five-event dataset.
Keep one writer per artifact, sync handoffs and invalidate caches as required by
the existing disk integration. Never store credentials in these artifacts.

Coding workers must actually consume the consolidated dataset and relevant notes.
Display research progress and counts in the engineering dashboard, with links to
artifacts. Show completion only after validated outputs are available. Separate
external source content from trusted task instructions.

### 3. Build flow and evidence

Retain the project's architecture-first model: establish shared types, API
contracts, acceptance tests and installed dependencies in the template sandbox,
then fork bounded coding tasks with disjoint owned paths. Suitable coding roles
are API/data loading, application UI/shortlist, and filtering/evidence behavior.
Resolve their exact boundaries against the code rather than forcing this naming.

Inspect the current scheduler and planner constraints before adding research
phases or cross-role dependencies. Use an explicit research preflight if that is
the smallest reliable implementation; only claim research and coding overlap
when they genuinely do. Replace bookmark-specific prompts, fixtures and seed
instructions where needed. An invalid Radar plan must not silently fall back to
building a bookmark manager. Any Radar fixture plan must be clearly identified.

Show the chain for at least one concrete example:

- An official page establishes an event's submission deadline.
- A research finding records that deadline and its source.
- A coding task consumes the dataset and implements the deadline filter/details.
- A test verifies the filter and the citation mapping.
- A verified PR delivers the implementation, and the app demonstrates it.

Distinguish research-derived content from research-derived design decisions; show
which of each actually occurred. Keep issues, attempts, PRs, verification results
and final delivery evidence linked to the correct run. Use real Codex workers and
real Archil infrastructure for the claimed live swarm demonstration. Fake-agent
runs remain useful engineering checks but do not satisfy that claim.

### 4. Repeatability: at least two executions

The minimum is a complete **rehearsal/test run** followed by a separate **judges'
run**. A smoke test or replay of rehearsal output does not count as the second
execution. Support additional practice runs without manual repair.

For every execution:

- Assign a unique run ID and record mode, start time, seed commit, target
  repository/branch, dataset identity, research mode and software revision.
- Start from a clean, documented seed. Prefer separate disposable target repos for
  rehearsal and judges; otherwise use isolated branches only if the integration
  path supports them. Do not reset or delete a completed run to make room.
- Isolate issues, PRs, research directories, orchestration state, application data,
  browser shortlist storage and delivery reports. Respect provider concurrency
  limits; stop unnecessary rehearsal compute while preserving its evidence.
- Record whether research was fetched fresh or reused from a timestamped cache.
  Prefer fresh research for the judges' run; disclose cached data if used. Keep
  external responses deterministic in automated tests using fixtures.
- Provide an exact start procedure using supported commands, prerequisites and
  expected outputs. Do not document imaginary CLI flags. Make repeat-run setup
  scripted where practical, with safeguards against overwriting existing runs.

**Run A — rehearsal:** execute the complete research-to-app flow, verify the app,
inspect its citations and merged PRs, rehearse the presentation, and capture a
backup recording. Check playback. Record duration, failures, repairs and whether
all acceptance criteria passed. Preserve this as the finished exhibit.

**Run B — judges:** prepare its clean target and startup procedure after the
rehearsal succeeds. Start the fresh execution when presentation timing is
explicitly signaled, early enough for active work to be visible. Do not start it
prematurely during implementation or report it completed before it runs. Finish
and verify the delivery even if the short presentation ends first. Show the
rehearsal app while the fresh build progresses, explicitly labeling the two runs.

If the live run stalls, switch to the labeled rehearsal recording or completed
exhibit and state the current live status. Never relabel a recording, fixture,
cached response or fake-agent execution as fresh live work.

### 5. Verification and completion criteria

Run applicable repository type checks and tests, plus final target-app checks.
Use network-free automated tests for research schemas/consolidation, source
mapping, missing/conflicting facts, filters, shortlist persistence/isolation,
research-to-worker handoff and run isolation. Include an end-to-end check that
research artifacts reach the dataset rendered by the app. Verify every displayed
source link maps to the intended factual claim. Manually check representative
real sources during rehearsal; do not claim automated live source verification
if only fixtures were tested.

A successful rehearsal must demonstrate five sourced events or explicitly report
a shortfall, useful filters, a reload-persistent shortlist, all three research
roles, consumed shared-disk artifacts, real worker execution, verified PR delivery,
and passing integrated tests. Capture an evidence index with links and actual
results. Separate “implemented,” “rehearsed successfully,” and “demonstrated to
judges” in the final report. A prepared judges' command is not a completed run.

### 6. Three-minute presentation

- **0:00–0:25:** use the completed rehearsal app to answer a concrete question:
  “Which online events fit my eligibility and close after my chosen date?” Save
  one event. Identify this as the rehearsal result.
- **0:25–1:00:** switch to the fresh judges' run. Show real research role status,
  one finding and its official source. If discovery has finished, show the saved
  artifact and timestamp rather than pretending a search is still running.
- **1:00–1:35:** show the shared-disk handoff and coding workers in separate Archil
  forks. Explain their assignments and show actual progress.
- **1:35–2:20:** trace a rehearsal finding through its coding task, test and merged
  PR into the working filter or details view. Label the run on every exhibit.
- **2:20–3:00:** return to the app, open a citation and show the shortlist. Finish
  with delivery evidence and the honest status of the fresh run.

Opening line: “Give our swarm a product brief. It researches real opportunities,
shares the evidence, and builds a tested app you can use.”

The optional Stop/resume moment comes only after the core research-to-product
story is reliable. If demonstrated, show the interrupted attempt and resumed
attempt in the same sandbox; do not infer recovery from a button press.

### 7. Deliverables

Deliver the app and orchestration changes, supported repeat-run instructions,
research schemas and artifacts, meaningful tests, the rehearsal evidence index,
a checked recording, a prepared judges' run, and the final judges' evidence when
that execution happens. Report missing credentials or access without exposing
secrets. Keep this README's kickoff prompt and these instructions consistent.

## Legacy bookmark demo and recovery fallback

The following script describes the previous demo target. It remains a fallback,
not a substitute for the Radar acceptance criteria above.

### Table demo: Archil Agent Swarm

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
