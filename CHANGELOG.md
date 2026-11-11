# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-10

The first release, built for the Archil hackathon table demos.

### Added

- **Planner** using AI SDK `generateObject` and a zod schema, with a validator that rejects cycles, missing dependencies, missing verify commands and overlapping owned paths. A plan that fails validation falls back to the fixture plan.
- **Keenable research** step that writes cited `sources.md` notes to the shared disk before dispatch.
- **GitHub publisher**: a paced, idempotent queue for issues, sub-issues, blocked-by links, Project v2 status, PRs and squash merges, with dry-run support.
- **Archil adapters** for the conditional-mode shared disk, template-and-fork sandboxes and the SQLite state store.
- **Worker** (`run-task.sh`) that runs Codex or the fake agent, then verifies, commits, pushes an attempt branch, writes a manifest and syncs.
- **Orchestrator** with a scheduler, a deterministic gate (verify re-runs plus owned-path checks, one retry, then Blocked), sequential integration and stop/resume recovery.
- **Live dashboard** (Hono and SSE) showing task activity, agent logs, sources and PRs, with a Stop control.
- **`--local` mode**, which runs the whole pipeline with no cloud credentials.
- Architecture diagrams, demo scripts and 260 offline tests.

[0.1.0]: https://github.com/CompleteDotTech/archil-agent-fan-out/releases/tag/v0.1.0
