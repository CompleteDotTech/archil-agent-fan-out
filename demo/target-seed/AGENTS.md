# Product worker instructions

Build the bookmark manager described in your assigned task. T1 creates the
application scaffold and contracts; later tasks implement features against those
contracts. Read the task's acceptance criteria, owned paths and verification
commands before editing.

- Edit only paths in your task's OWNS list. Other workers may be active; preserve
  their changes and do not modify another task's files.
- Never edit `package.json` or dependency lockfiles. Dependencies are supplied by
  the seed. Report a missing dependency to the orchestrator.
- Use TypeScript with strict checking, ESM and NodeNext resolution. Relative
  imports must use `.js` extensions even when importing TypeScript files.
- Follow the API contract in `docs/api.md` and shared types in `src/types.ts`
  once T1 creates them. Keep data in memory and keep tests independent of network
  services.
- Run every verification command assigned to your task and fix failures before
  reporting completion. Run `npm run typecheck` for TypeScript changes. The final
  integrated application must pass `npm test`.
- Do not commit, push, merge or change branches; the worker harness manages git.
- Never hard-code or print secrets.

Report what changed, which verification commands passed and any remaining
blockers in your final response.
