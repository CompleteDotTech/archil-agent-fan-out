import type { Hono } from 'hono';

/** Serve / and /app.js from publicDir, returning 404 for unknown files. */
export function createUi(_publicDir: string): Hono {
  throw new Error('not implemented');
}
