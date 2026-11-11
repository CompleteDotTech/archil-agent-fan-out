# Brief: bookmark manager

Build a small bookmark manager.

- Add a bookmark with a URL, a title and optional tags.
- List bookmarks, newest first.
- Delete a bookmark.
- Search by text (title or URL) or by tag (`tag:work`).
- Provide a JSON API and a single-page web UI served by the same Node server.
- Keep data in memory. Persistence is out of scope.
- Use TypeScript, Hono and vitest.
- Every feature has an automated acceptance test, and `npm test` passes.
