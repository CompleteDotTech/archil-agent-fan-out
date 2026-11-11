import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Store } from '../contracts/types.js';

function eventCursor(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

export function createDashboard(ports: { store: Store }, hooks: { stopTask(runId: string, taskId: string): Promise<void> }, opts?: { projectUrl?: string; publicDir?: string }): Hono {
  const app = new Hono();
  const { store } = ports;

  app.get('/api/runs/:runId', async c => {
    const runId = c.req.param('runId');
    const plan = await store.getPlan(runId);
    if (!plan) return c.json({ error: 'Run not found' }, 404);
    const [statuses, attempts, issues, events] = await Promise.all([
      store.getTaskStatuses(runId),
      store.listAttempts(runId),
      store.getIssueNumbers(runId),
      store.listEvents(runId),
    ]);
    return c.json({ plan, statuses, attempts, issues, events: events.slice(-300), projectUrl: opts?.projectUrl ?? null });
  });

  app.get('/api/runs/:runId/stream', async c => {
    const runId = c.req.param('runId');
    if (!await store.getPlan(runId)) return c.json({ error: 'Run not found' }, 404);
    let after = eventCursor(c.req.header('Last-Event-ID')) ?? eventCursor(c.req.query('after')) ?? 0;
    return streamSSE(c, async stream => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const cancelWait = () => {
        clearTimeout(timer);
        wake?.();
      };
      const abort = () => stream.abort();
      const signal = c.req.raw.signal;
      stream.onAbort(cancelWait);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        while (!stream.aborted) {
          const events = await store.listEvents(runId, after);
          for (const entry of events) {
            if (stream.aborted) break;
            await stream.writeSSE({ id: String(entry.index), data: JSON.stringify(entry) });
            after = entry.index;
          }
          if (stream.aborted) break;
          await new Promise<void>(resolve => {
            wake = resolve;
            timer = setTimeout(resolve, 1_000);
          });
          wake = undefined;
        }
      } finally {
        cancelWait();
        signal.removeEventListener('abort', abort);
      }
    });
  });

  app.post('/api/runs/:runId/tasks/:taskId/stop', async c => {
    const runId = c.req.param('runId');
    if (!await store.getPlan(runId)) return c.json({ error: 'Run not found' }, 404);
    await hooks.stopTask(runId, c.req.param('taskId'));
    return c.json({ ok: true });
  });

  app.get('/', async c => {
    const file = opts?.publicDir
      ? join(opts.publicDir, 'index.html')
      : new URL('./public/index.html', import.meta.url);
    try {
      return c.html(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return c.notFound();
      throw error;
    }
  });

  return app;
}
