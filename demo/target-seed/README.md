# Bookmark manager demo target

This is the seed repository for the agent swarm's bookmark manager demo. It
contains project configuration only. Architecture task T1 supplies the application
scaffold, API contract, shared types and acceptance tests before feature workers
begin.

The finished application adds, lists, deletes and searches in-memory bookmarks
through a Hono JSON API and a single-page web UI. Search supports title or URL
text and `tag:work` terms.

Use Node.js 22.13 or later. Install dependencies with `npm install` during target
repository setup. After T1 supplies the scaffold:

```sh
npm run typecheck
npm test
npm start
```

The start command runs `src/server.ts`. Before T1, there are no source files or
tests, so these commands do not yet verify or run an application. T1's stub
acceptance tests may fail until the corresponding feature tasks land.

Workers must read `AGENTS.md`, edit only their assigned owned paths, leave
`package.json` and lockfiles unchanged, and run every verification command in
their task. The architecture task defines the contracts used by later workers;
the complete application must pass `npm run typecheck` and `npm test`.
