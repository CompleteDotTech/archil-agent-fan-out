import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SharedDisk, Store } from '../contracts/types.js';

function eventCursor(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

export function createDashboard(ports: { store: Store; disk?: SharedDisk }, hooks: { stopTask(runId: string, taskId: string): Promise<void> }, opts?: { projectUrl?: string; publicDir?: string }): Hono {
  const app = new Hono();
  const { store } = ports;
  // Identifies this server process. Event indexes restart when an in-memory
  // store restarts, so clients reload when this changes instead of resuming
  // from a cursor that belongs to a previous process.
  const serverId = randomUUID();

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
    return c.json({ plan, statuses, attempts, issues, events: events.slice(-300),
      evidenceEvents: events.filter(item => item.event.type !== 'agent.log'), projectUrl: opts?.projectUrl ?? null, serverId });
  });

  // Read-only artifact views. Never expose arbitrary shared-disk paths or HTML
  // fetched from external sources as executable same-origin content.
  app.get('/research/:runId/*', async c => {
    const runId = c.req.param('runId');
    const prefix = `/research/${runId}/`;
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(c.req.url).pathname); } catch { return c.notFound(); }
    const relative = pathname.slice(prefix.length);
    if (!ports.disk || !await store.getPlan(runId) || !pathname.startsWith(prefix)
      || !/^[a-zA-Z0-9_./-]+\.(?:json|md)$/.test(relative)
      || relative.split('/').some(part => part === '.' || part === '..')) return c.notFound();
    const contents = await ports.disk.read(prefix + relative);
    if (contents === undefined) return c.notFound();
    c.header('Content-Type', relative.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(contents);
  });

  app.get('/runs/:runId/:taskId/:attemptId/research-receipt.json', async c => {
    const { runId, taskId, attemptId } = c.req.param();
    if (!ports.disk || ![runId, taskId, attemptId].every(part => /^[a-zA-Z0-9_-]+$/.test(part))
      || !await store.getPlan(runId)) return c.notFound();
    const contents = await ports.disk.read(`/runs/${runId}/${taskId}/${attemptId}/research-receipt.json`);
    if (contents === undefined) return c.notFound();
    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(contents);
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
      let idlePolls = 0;
      try {
        while (!stream.aborted) {
          const events = await store.listEvents(runId, after);
          for (const entry of events) {
            if (stream.aborted) break;
            await stream.writeSSE({ id: String(entry.index), data: JSON.stringify(entry) });
            after = entry.index;
          }
          if (stream.aborted) break;
          // Keep idle connections alive through proxies that drop silent streams.
          idlePolls = events.length ? 0 : idlePolls + 1;
          if (idlePolls >= 15) { idlePolls = 0; await stream.write(': keepalive\n\n'); }
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
