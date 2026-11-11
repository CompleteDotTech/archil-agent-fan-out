import type { Hono } from 'hono';
import type { BookmarkStore, SearchBookmarks } from '../types.js';

/** Routes use full /api/bookmarks paths, because app forwards the original request. */
export function createApi(_store: BookmarkStore, _search: SearchBookmarks): Hono {
  throw new Error('not implemented');
}
