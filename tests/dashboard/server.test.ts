import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/contracts/fakes.js';
import type { Plan, SwarmEvent } from '../../src/contracts/types.js';
import { createDashboard } from '../../src/dashboard/server.js';

const plan: Plan = {
  runId: 'demo', brief: 'Demo', targetRepo: 'owner/repo', baseBranch: 'main',
  tasks: [{ id: 'T1', title: 'Build', kind: 'task', dependsOn: [], owns: ['src/**'], acceptance: [], verify: ['npm test'] }],
};
const event = (runId: string, line: string): SwarmEvent => ({
  runId, taskId: 'T1', at: '2026-11-10T12:00:00.000Z', type: 'agent.log', data: { line },
});

async function setup() {
  const store = new MemoryStore();
  await store.init();
  await store.savePlan(plan);
  const stopTask = vi.fn(async (_runId: string, _taskId: string) => {});
  return { store, stopTask, app: createDashboard({ store }, { stopTask }, { projectUrl: 'https://github.com/orgs/example/projects/1' }) };
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  const frame = new TextDecoder().decode(value);
  const data = frame.split('\n').find(line => line.startsWith('data: '));
  expect(data).toBeDefined();
  return { frame, entry: JSON.parse(data!.slice(6)) };
}

afterEach(() => vi.useRealTimers());

describe('dashboard server', () => {
  it('returns run-scoped state and the last 300 indexed events without changing the store', async () => {
    const { store, app } = await setup();
    await store.savePlan({ ...plan, runId: 'other' });
    await store.setTaskStatus('demo', 'T1', 'running');
    await store.setTaskStatus('other', 'T1', 'done');
    await store.setIssueNumber('demo', 'T1', 42);
    await store.setIssueNumber('other', 'T1', 99);
    const attempt = { runId: 'demo', taskId: 'T1', attemptId: 'T1-a1', n: 1, resume: false, state: 'running' as const, startedAt: '2026-11-10T12:00:00Z', deadlineAt: '2026-11-10T12:10:00Z' };
    await store.createAttempt(attempt);
    await store.createAttempt({ ...attempt, runId: 'other' });
    for (let i = 0; i < 305; i++) {
      await store.appendEvent(event('demo', String(i)));
      await store.appendEvent(event('other', 'unrelated'));
    }
    const response = await app.request('/api/runs/demo');
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot).toEqual({
      plan, statuses: { T1: 'running' }, attempts: [attempt], issues: { T1: 42 },
      events: (await store.listEvents('demo')).slice(-300), projectUrl: 'https://github.com/orgs/example/projects/1',
    });
    expect(snapshot.events).toHaveLength(300);
    expect(snapshot.events[0].event.data.line).toBe('5');
    expect(await store.listEvents('demo')).toHaveLength(305);
  });

  it('returns 404 for missing runs on every run endpoint', async () => {
    const { app, stopTask } = await setup();
    for (const path of ['/api/runs/missing', '/api/runs/missing/stream', '/api/runs/missing/tasks/T1/stop']) {
      const response = await app.request(path, { method: path.endsWith('/stop') ? 'POST' : 'GET' });
      expect(response.status).toBe(404);
    }
    expect(stopTask).not.toHaveBeenCalled();
  });

  it('awaits the stop hook before responding', async () => {
    const { store } = await setup();
    let release!: () => void;
    const stopTask = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const app = createDashboard({ store }, { stopTask });
    let responded = false;
    const response = Promise.resolve(app.request('/api/runs/demo/tasks/T1/stop', { method: 'POST' })).then(result => {
      responded = true;
      return result;
    });
    await vi.waitFor(() => expect(stopTask).toHaveBeenCalledWith('demo', 'T1'));
    expect(responded).toBe(false);
    release();
    expect(await (await response).json()).toEqual({ ok: true });
  });

  it('serves index.html from the configured public directory', async () => {
    const { store, stopTask } = await setup();
    const publicDir = await mkdtemp(join(tmpdir(), 'dashboard-'));
    try {
      await writeFile(join(publicDir, 'index.html'), '<!doctype html><h1>Custom dashboard</h1>');
      const response = await createDashboard({ store }, { stopTask }, { publicDir }).request('/');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe('<!doctype html><h1>Custom dashboard</h1>');
    } finally {
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it('streams snapshot-compatible wrappers, polls for new events, and cancels cleanly', async () => {
    vi.useFakeTimers();
    const { store, app } = await setup();
    await store.appendEvent(event('demo', 'first'));
    const listEvents = vi.spyOn(store, 'listEvents');
    const response = await app.request('/api/runs/demo/stream');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    try {
      const first = await readEvent(reader);
      expect(first.entry).toEqual({ index: 1, event: event('demo', 'first') });
      expect(first.frame).toContain('id: 1\n');
      await vi.advanceTimersByTimeAsync(0);
      await store.appendEvent(event('demo', 'second'));
      const next = readEvent(reader);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await next).entry).toEqual({ index: 2, event: event('demo', 'second') });
      expect(listEvents).toHaveBeenLastCalledWith('demo', 1);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await reader.cancel();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    const calls = listEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listEvents).toHaveBeenCalledTimes(calls);
  });

  it.each([
    { query: '?after=1', headers: {} as Record<string, string>, expected: 2 },
    { query: '?after=0', headers: { 'Last-Event-ID': '2' }, expected: 3 },
  ])('resumes SSE using $query and $headers', async ({ query, headers, expected }) => {
    const { store, app } = await setup();
    for (let i = 1; i <= 3; i++) await store.appendEvent(event('demo', String(i)));
    const controller = new AbortController();
    const response = await app.request(`/api/runs/demo/stream${query}`, { headers, signal: controller.signal });
    const reader = response.body!.getReader();
    try {
      expect((await readEvent(reader)).entry.index).toBe(expected);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });

  it('removes the pending poll when the request is aborted', async () => {
    vi.useFakeTimers();
    const { store, app } = await setup();
    const listEvents = vi.spyOn(store, 'listEvents');
    const controller = new AbortController();
    const response = await app.request('/api/runs/demo/stream', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listEvents).toHaveBeenCalledTimes(1);
    await response.body!.cancel();
  });
});
