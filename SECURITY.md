# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through [GitHub security advisories](https://github.com/CompleteDotTech/archil-agent-fan-out/security/advisories/new). We aim to acknowledge reports within a few days.

## Scope and design notes

- Only the orchestrator calls the GitHub API. Workers receive a **contents-only** push token, so a stale attempt can't publish.
- Workers run `codex exec` with approvals bypassed **inside an isolated Archil sandbox**. The VM is the sandbox. Don't run the worker script on a machine you care about.
- Credentials are read only in `src/compose.ts` and `scripts/`, and are passed into sandboxes as environment variables. They're never written to the shared disk.
- The live dashboard has no authentication and is meant for local or demo use. Don't expose it publicly while connected to real credentials.
