# Rehearsal recording checklist

Follow [the plan](PLAN.md) and [the table-demo script](DEMO.md). Record during the planned 9:00–9:25 PM PT rehearsal on November 10, 2026; have playback ready before the 9:25 live run and 9:30 table demos. This checklist does not establish that a recording or successful recovery exists.

## Prepare

- [ ] Open the finished run's Project board, pull requests, delivery report and cited research sources in separate tabs. Review the actual verification and integration results.
- [ ] Note the finished run ID and the rehearsal run ID. Keep the current run ID visible in the dashboard or alongside the capture; identify each run when switching tabs.
- [ ] Confirm whether the rehearsal uses real Codex or `AGENT=fake`, a generated or fixture plan, and live or dry-run publishing. Label canned-file execution explicitly.
- [ ] Frame readable dashboard logs and task details, close secret-bearing windows, and check capture and microphone settings. Select a currently running worker for the Stop demonstration.

## Capture

- [ ] Start screen recording before the demonstration. State the run ID and execution mode, then briefly show the issue hierarchy and dependencies.
- [ ] Show the selected worker running, including its task ID, attempt ID and sandbox ID. Press Stop once while recording.
- [ ] Capture the interruption evidence, then the next attempt starting with resume enabled in the same sandbox. Compare the before/after sandbox IDs and show resumed session output where available; a Stop click alone does not prove recovery.
- [ ] Continue through the resumed worker's result and verification evidence. Show the gate result and resulting PR/merge evidence actually available. If recovery fails or remains pending, say so; do not narrate an unobserved success.
- [ ] Record the final delivery report at `/delivery/<run>/report.md`, showing its run ID and actual integration result. Show a completed-run report separately if the rehearsal has not finished, identifying the different run.
- [ ] Show the research citations in `/research/<run>/<task>/sources.md`, including readable source titles and URLs, and explain that these notes ground the worker's task.
- [ ] Stop recording and save the file with its run ID. Note timestamps for Stop, interruption, resume, verification, final report and citations.

## Review and keep ready

- [ ] Play the saved file from the beginning, seek through Stop/resume and the final evidence, and check readable text, audible narration and correct run labels. Confirm no secrets appear.
- [ ] Retake missing or unreadable evidence where possible. If recovery was not demonstrated, mark it unverified and use only the behavior actually captured.
- [ ] Keep the playable file accessible locally and open at the Stop/resume segment, alongside the finished-run tabs, before starting the fresh 9:25 live run.
- [ ] If the live demonstration stalls, explicitly introduce the fallback as a rehearsal recording. Keep the finished board, PRs, report and sources accessible even if playback fails.
