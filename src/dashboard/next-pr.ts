import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';

export interface NextPrConfig {
  runId: string;
  taskId: string;
  title: string;
  targetRepo: string;
  appUrl: string;
  liveUrl: string;
}
export interface NextPrState {
  phase: 'ready' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  endedAt?: string;
  prUrl?: string;
  message?: string;
}
/** Constructing or reading this page cannot start a worker. Only the protected POST can. */
export function createNextPrLauncher(config: NextPrConfig, deps: {
  start: () => Promise<{ prUrl: string }>;
  progress?: () => Promise<string | undefined>;
  now?: () => string;
  initial?: NextPrState;
  html?: string;
}) {
  const app = new Hono();
  const token = randomUUID();
  const now = deps.now ?? (() => new Date().toISOString());
  let state: NextPrState = deps.initial ?? { phase: 'ready' };
  app.get('/', async c => {
    const html = deps.html ?? await readFile(new URL('./public/next-pr.html', import.meta.url), 'utf8');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(html.replaceAll('__DEMO_TOKEN__', token));
  });
  app.get('/api/demo/status', async c => {
    c.header('Cache-Control', 'no-store');
    const progress = state.phase === 'running' ? await deps.progress?.().catch(() => undefined) : undefined;
    return c.json({ ...config, ...state, ...(progress ? { progress } : {}) });
  });
  app.post('/api/demo/start', async c => {
    if (c.req.header('Origin') !== new URL(c.req.url).origin || c.req.header('X-Demo-Token') !== token) {
      return c.json({ error: 'Use the Create next PR button on this page.' }, 403);
    }
    if (state.phase !== 'ready') return c.json({ error: 'This prepared task has already been started.', phase: state.phase }, 409);
    state = { phase: 'running', startedAt: now() };
    void Promise.resolve().then(deps.start).then(result => {
      state = { ...state, phase: 'completed', endedAt: now(), prUrl: result.prUrl };
    }).catch(() => {
      state = { ...state, phase: 'failed', endedAt: now(), message: 'The task stopped. Evidence is preserved; inspect the live dashboard or run report.' };
    });
    return c.json({ ...config, ...state }, 202);
  });
  return app;
}
