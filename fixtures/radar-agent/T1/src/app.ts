import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApi } from './api/index.js';
import { createUi } from './ui/index.js';
import { filterEvents } from './filter/index.js';
import type { RadarDataset } from './types.js';
export function createApp(options: { dataset?: RadarDataset; publicDir?: string } = {}): Hono {
 const app = new Hono();
 let api: Hono | undefined;
 let ui: Hono | undefined;
 app.all('/api/*', c => { api ??= createApi(options.dataset ?? JSON.parse(readFileSync('data/research.json','utf8')) as RadarDataset, filterEvents); return api.fetch(c.req.raw); });
 app.get('*', c => { ui ??= createUi(options.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url))); return ui.fetch(c.req.raw); });
 return app;
}
