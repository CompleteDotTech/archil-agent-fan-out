import { Hono } from 'hono';
import type { BookmarkStore, NewBookmark, SearchBookmarks } from '../types.js';

function validate(body: unknown): NewBookmark | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Expected a JSON object';
  }
  const { url, title, tags } = body as Record<string, unknown>;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    return 'URL must be an absolute HTTP(S) URL';
  }
  try {
    const parsed = new URL(url.trim());
    if (!parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
      return 'URL must be an absolute HTTP(S) URL';
    }
  } catch {
    return 'URL must be an absolute HTTP(S) URL';
  }
  if (typeof title !== 'string' || !title.trim()) return 'Title must be a nonempty string';
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string'))) {
    return 'Tags must be an array of strings';
  }
  return {
    url: url.trim(),
    title: title.trim(),
    tags: ((tags ?? []) as string[]).map((tag) => tag.trim()).filter(Boolean),
  };
}

export function createApi(store: BookmarkStore, search: SearchBookmarks): Hono {
  const app = new Hono();
  app.get('/api/bookmarks', (context) => {
    const bookmarks = store.list();
    const query = context.req.query('q');
    return context.json(query?.trim() ? search(bookmarks, query) : bookmarks);
  });
  app.post('/api/bookmarks', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json<unknown>();
    } catch {
      return context.json({ error: 'Malformed JSON body' }, 400);
    }
    const input = validate(body);
    if (typeof input === 'string') return context.json({ error: input }, 400);
    return context.json(store.create(input), 201);
  });
  app.delete('/api/bookmarks/:id', (context) => {
    if (!store.delete(context.req.param('id'))) {
      return context.json({ error: 'Bookmark not found' }, 404);
    }
    return context.body(null, 204);
  });
  return app;
}
