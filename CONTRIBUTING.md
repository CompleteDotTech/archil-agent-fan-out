# Contributing

Thanks for your interest in Archil Agent Swarm! The project was built under a hackathon deadline by a Codex swarm. The conventions below keep it easy to work on for both humans and agents.

## Setup

```bash
nvm use            # Node 22.19+ (see .nvmrc)
npm ci
npm run typecheck
npm test
```

Before opening a PR, run the full pipeline locally. It needs no credentials:

```bash
npm run swarm -- --brief demo/bookmark-brief.md --repo demo/bookmarks --local --fake-agent
# … Final acceptance suite: PASS
```

## Conventions

- **TypeScript, ESM, NodeNext.** Use `.js` extensions in relative imports.
- **Ports and fakes.** Code against the interfaces in `src/contracts/types.ts`, and test with the fakes in `src/contracts/fakes.ts`. Tests must not touch the network.
- **Small, injected functions.** Pass dependencies in as parameters so tests can substitute fakes.
- **Configuration.** Environment variables are read only in `src/compose.ts` and `scripts/`. Everything else receives configuration through parameters.
- **No secrets.** Never log, print or commit tokens, API keys or disk IDs, including in screenshots and issue reports.

## Ownership

Paths are owned by workstreams, as listed in [AGENTS.md](AGENTS.md). Changes to `src/contracts/**`, `package.json` or the lockfile are root-owned. If your change needs one, say so in your PR so it can be reviewed on its own.

## Pull requests

- Keep each PR focused, and link issues with `Closes #n`.
- Fill in the verification checklist in the PR template.
- Labels drive the release notes (`enhancement`, `bug`, `documentation`, `ci`, `dependencies`).

Taking part in this project means agreeing to the [Code of Conduct](CODE_OF_CONDUCT.md).
