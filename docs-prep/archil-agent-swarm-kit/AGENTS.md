# AGENTS.md: rules for every Codex agent in this repo

This repo is built by a three-layer Codex swarm:

- **Root orchestrator**: the human's Codex session on `main`.
- **Workstream orchestrators** (A–E): Codex subagents, one per workstream, each working on branch `ws/<ID>` in `.wt/ws-<ID>`.
- **Leaf workers**: headless `codex exec` processes, one per task, each working on branch `task/<ID>` in `.wt/<ID>`.

Read `docs/PLAN.md` for what we are building. Read `swarm/tasks.yaml` for the task you were given.

## Ownership

| Paths | Owner |
|---|---|
| `src/contracts/**`, `src/cli.ts`, `src/compose.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `fixtures/plan.*.json`, `fixtures/keenable-search.json`, `demo/brief.md`, `swarm/**`, `.codex/**` | root only |
| `src/planner/**`, `src/research/**`, `tests/planner/**`, `tests/research/**` | workstream A |
| `src/github/**`, `tests/github/**` | workstream B |
| `src/archil/**`, `src/worker/**`, `scripts/**`, `tests/archil/**`, `tests/worker/**` | workstream C |
| `src/orchestrator/**`, `tests/orchestrator/**` | workstream D |
| `src/dashboard/**`, `tests/dashboard/**`, `demo/target-seed/**`, `demo/assemble.sh`, `fixtures/agent/**`, `README.md`, `docs/DEMO.md`, `docs/architecture.md` | workstream E |

## Hard rules

1. **Stay in your paths.** A leaf edits only the paths in its prompt's OWNS list, and the harness rejects diffs outside them. An orchestrator edits only its workstream's paths.
2. **Root-only files.** Never edit `package.json`, `package-lock.json`, `tsconfig.json` or `src/contracts/**`. If you need a dependency or a contract change, stop and say so in your final message.
3. **No git as a leaf.** Leaf workers never run `git commit`, `push`, `merge`, `rebase` or `checkout`. The harness commits for you.
4. **No network in leaf tasks.**
   - Code against the ports in `src/contracts/types.ts`, and test with the fakes in `src/contracts/fakes.ts`.
   - Get exact SDK signatures from the type definitions already installed in `node_modules/` (`disk`, `@archildata/sqlite`, `keenable`, `@octokit/rest`, `ai`, `@ai-sdk/openai`, `hono`). Don't guess them.
   - API facts we verified are in each task's NOTES.
5. **Verify before you finish.** Run every VERIFY command in your prompt, and fix failures until they all pass.
6. **No secrets in code or output.** Never print, log or hard-code a secret. Read env vars only in `src/compose.ts` and `scripts/`; everything else receives configuration through parameters.
7. **Code style.**
   - TypeScript, ESM, Node 22.13 or later. Use `.js` extensions in relative imports (NodeNext).
   - Keep functions small, and inject their dependencies so tests can pass in fakes.
   - Tests use vitest and no network. Put shared fixtures in `fixtures/`.

## Commands

```bash
npm run typecheck              # tsc --noEmit
npx vitest run tests/<area>    # one area
npm test                       # everything
node swarm/bin/swarm.mjs status
```

## Final message (leaf workers)

```
STATUS: done | blocked
SUMMARY: one or two sentences
FILES: the files you created or changed
INTEGRATION NOTES: env vars, assumptions, TODOs the integrator must know
```
