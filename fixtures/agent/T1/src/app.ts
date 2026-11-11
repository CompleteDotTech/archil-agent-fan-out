import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createApi } from './api/index.js';
import { searchBookmarks } from './search/index.js';
import { createBookmarkStore } from './store/index.js';
import { createUi } from './ui/index.js';
import type { BookmarkStore, SearchBookmarks } from './types.js';

export interface AppOptions {
  store?: BookmarkStore;
  search?: SearchBookmarks;
  publicDir?: string;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  let api: Hono | undefined;
  let ui: Hono | undefined;

  // Delay factory calls so each parallel task can test its feature with other stubs intact.
  app.all('/api/*', (context) => {
    api ??= createApi(options.store ?? createBookmarkStore(), options.search ?? searchBookmarks);
    return api.fetch(context.req.raw);
  });
  app.get('*', (context) => {
    ui ??= createUi(options.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url)));
    return ui.fetch(context.req.raw);
  });
  return app;
}
