# Bookmark application contract

This document is the shared contract for the parallel T2 (API/store), T3
(UI/static files), and T4 (search) tasks. Keep the exports below unchanged.
The seed already supplies all dependencies; do not change its package files.
No database, remote service, environment variables, or build step is required.

## Data and HTTP

`src/types.ts` exports `Bookmark { id: string; url: string; title: string;
tags: string[]; createdAt: string }` and `NewBookmark { url: string;
title: string; tags?: string[] }`. IDs are unique opaque strings; timestamps
are ISO 8601 strings. Tags default to `[]`. Store and return trimmed URL/title
strings and trimmed, nonempty tags. Accept only absolute HTTP(S) URLs and
nonempty titles. Reject non-object bodies, malformed JSON, missing/non-string
URL/title, and tags that are not arrays of strings.

| Request | Success | Failure |
| --- | --- | --- |
| `POST /api/bookmarks` with JSON `NewBookmark` | `201`, JSON `Bookmark` | `400`, JSON `{ "error": "..." }` |
| `GET /api/bookmarks` | `200`, JSON `Bookmark[]`, newest first | — |
| `GET /api/bookmarks?q=<encoded query>` | `200`, JSON `Bookmark[]`, filtered in original order | — |
| `DELETE /api/bookmarks/:id` | `204`, empty body | `404`, JSON `{ "error": "..." }` |

Responses with JSON use `application/json`. Unknown API routes return 404.
No envelope wraps successful JSON. Each app has an independent in-memory
store; list results and returned bookmarks must not expose mutable store state.
Newest means insertion order (new additions first), even with equal timestamps.

## Stable module exports

All relative TypeScript imports use `.js` extensions. No module factory runs
at import time. T1's throwing implementations are intentional and must be
replaced inside each implementing task's owned directories.

### T2: API and store

`src/store/index.ts` exports `createBookmarkStore(): BookmarkStore`.
`BookmarkStore`, exported from `src/types.ts`, has synchronous methods:

```ts
list(): Bookmark[];
create(input: NewBookmark): Bookmark;
delete(id: string): boolean;
```

`src/api/index.ts` exports
`createApi(store: BookmarkStore, search: SearchBookmarks): Hono`.
Register **full paths** (`/api/bookmarks`, `/api/bookmarks/:id`), not paths
relative to `/api`. The API owns HTTP input validation. Call the injected
`search(store.list(), query)` only when `q` is present and nonblank; otherwise
return `store.list()` without invoking search. The API must not import UI or
construct a different store. This permits the API acceptance suite to run
while the T4 search stub and T3 UI stub still throw.

### T4: search

`src/search/index.ts` exports
`searchBookmarks(bookmarks: Bookmark[], query: string): Bookmark[]`.
`SearchBookmarks` in `src/types.ts` names that function type.
Whitespace separates terms. All terms must match (AND). Ordinary terms match
title OR URL by case-insensitive substring. `tag:<name>` terms match a complete
tag, case-insensitively. Blank/whitespace queries return all bookmarks. Do not
mutate or reorder the input. No special quoting or punctuation syntax is needed.

### T3: UI and static serving

`src/ui/index.ts` exports `createUi(publicDir: string): Hono`.
Serve the absolute directory passed by the app, never the caller's working
directory. `GET /` returns `public/index.html` as HTML; `GET /app.js` returns
`public/app.js` as JavaScript. Unknown paths and traversal attempts return 404.
The UI router does not import the API, store, or search modules.

`public/index.html` contains a form `#add-form` with controls named `url`,
`title`, and `tags`; a search input `#search`; a list `#bookmarks`; and a visible
error container `#error`. Load `/app.js` with a script tag. `public/app.js` uses
browser `fetch` and DOM APIs only, with no external scripts, styles, or CDN.
Load the list on page load. Submit the form as JSON via POST, split comma-
separated tags into trimmed nonempty strings, then refresh. Search sends an
encoded `q` via GET. Each bookmark has a link, tags, and a Delete button;
DELETE the encoded ID then refresh. Use `textContent` for user-supplied text,
clear successful form submissions, and display failed requests in `#error`.

## App and verification

`src/app.ts` exports `createApp(options?: AppOptions): Hono`. Options are
`store?: BookmarkStore`, `search?: SearchBookmarks`, and `publicDir?: string`.
Defaults use the modules above and a public directory relative to app.ts.
Factories are invoked lazily on the first matching request, then cached per
app: API requests never initialize UI, and UI requests never initialize API
or store. The original request URL is forwarded unchanged to each router.
`src/server.ts` starts the app on port 3000 with `@hono/node-server`.

Run `npm run typecheck` after T1. Acceptance suites intentionally fail on T1
alone until their owning implementation lands:

- T2: `npx vitest run tests/acceptance/api.test.ts` (does not exercise search).
- T3: `npx vitest run tests/acceptance/ui.test.ts` (does not call the API).
- T4: `npx vitest run tests/acceptance/search.test.ts` (pure search only).
- Assembled T1–T4: `npm test`, including `tests/acceptance/e2e.test.ts`.

Acceptance tests use Hono's in-process `app.request()` and synthetic bookmark
data. They require neither a listening server nor network. The UI suite checks
the served HTML/JavaScript contract; the end-to-end suite exercises the complete
HTTP app (assets plus add/list/search/delete), not a headless browser.
