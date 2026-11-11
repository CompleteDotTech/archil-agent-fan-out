import { describe, expect, it, vi } from 'vitest';
import { LocalSandboxRunner, MemoryDisk, MemoryStore } from '../../src/contracts/fakes.js';
import type { Attempt, Manifest } from '../../src/contracts/types.js';
import { createRecovery } from '../../src/orchestrator/recovery.js';

const attempt = (patch: Partial<Attempt> = {}): Attempt => ({
  runId: 'run', taskId: 'T1', attemptId: 'T1-a1', n: 1, sandboxId: 'sandbox',
  resume: false, state: 'running', startedAt: '2026-11-10T00:00:00.000Z',
  deadlineAt: '2026-11-10T00:01:00.000Z', ...patch,
});
const path = (a: Attempt) => `/runs/${a.runId}/${a.taskId}/${a.attemptId}/task.json`;

function setup(maxResumes?: number) {
  const store = new MemoryStore();
  const disk = new MemoryDisk();
  const sandboxes = new LocalSandboxRunner();
  const start = vi.spyOn(sandboxes, 'start').mockResolvedValue();
  const stop = vi.spyOn(sandboxes, 'stop').mockResolvedValue();
  const recovery = createRecovery({ store, disk, sandboxes }, { maxResumes });
  const seed = async (a = attempt()) => {
    await store.createAttempt(a);
    await disk.write(path(a), JSON.stringify({ id: a.taskId, findings: ['keep context'] }));
    return a;
  };
  return { store, disk, sandboxes, start, stop, recovery, seed };
}

describe('recovery', () => {
  it('persists interruption and a new attempt in the same sandbox with a renewed deadline', async () => {
    const { seed, recovery, store, disk, start } = setup();
    const a = await seed();
    const dispatch = await recovery.onInterrupted(a);
    expect(dispatch).toEqual({ runId: 'run', taskId: 'T1', attemptId: 'T1-a2', n: 2, sandboxId: 'sandbox', resume: true });
    const next = (await store.currentAttempt('run', 'T1'))!;
    expect(next).toMatchObject({ ...dispatch, state: 'running' });
    expect(Date.parse(next.deadlineAt) - Date.parse(next.startedAt)).toBe(60_000);
    expect(Date.parse(next.startedAt)).toBeGreaterThan(Date.parse(a.startedAt));
    expect((await store.listAttempts('run'))[0].state).toBe('interrupted');
    expect(await disk.read(path(next))).toBe(await disk.read(path(a)));
    expect(start).toHaveBeenCalledWith('sandbox');
    expect((await store.listEvents('run'))[0].event).toMatchObject({
      type: 'attempt.interrupted', attemptId: a.attemptId, data: { attemptId: a.attemptId },
    });
  });

  it('allows two resumes by default then gives up without starting the sandbox', async () => {
    const { seed, recovery, store, start } = setup();
    await seed();
    for (let i = 0; i < 2; i++) {
      expect(await recovery.onInterrupted((await store.currentAttempt('run', 'T1'))!)).toBeDefined();
    }
    expect(await recovery.onInterrupted((await store.currentAttempt('run', 'T1'))!)).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    expect((await store.listAttempts('run')).map(a => a.state)).toEqual(['interrupted', 'interrupted', 'interrupted']);
  });

  it('counts resumes independently of attempt numbers used by gate retries', async () => {
    const { seed, recovery } = setup(1);
    expect(await recovery.onInterrupted(await seed(attempt({ n: 4, attemptId: 'T1-a4' })))).toMatchObject({ n: 5 });
  });

  it('supports disabling resumes and rejects invalid limits', async () => {
    const { seed, recovery, start, store, disk, sandboxes } = setup(0);
    expect(await recovery.onInterrupted(await seed())).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    for (const maxResumes of [-1, 0.5, NaN, Infinity]) {
      expect(() => createRecovery({ store, disk, sandboxes }, { maxResumes })).toThrow('maxResumes');
    }
  });

  it('fences concurrent and stale callbacks without duplicating attempts or events', async () => {
    const { seed, recovery, store, start } = setup();
    const a = await seed();
    const results = await Promise.all([recovery.onInterrupted(a), recovery.onInterrupted(a)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await recovery.onInterrupted(a)).toBeUndefined();
    expect(await store.listAttempts('run')).toHaveLength(2);
    expect(await store.listEvents('run')).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('ignores only already-running errors and permits retry after other start failures', async () => {
    const { seed, recovery, start, store } = setup();
    const a = await seed();
    start.mockRejectedValueOnce(new Error('service unavailable'));
    await expect(recovery.onInterrupted(a)).rejects.toThrow('service unavailable');
    expect(await store.listAttempts('run')).toHaveLength(1);
    start.mockRejectedValueOnce(new Error('Sandbox is already running'));
    expect(await recovery.onInterrupted(a)).toMatchObject({ attemptId: 'T1-a2' });
    expect(await store.listEvents('run')).toHaveLength(1);
  });

  it('does not create an unusable attempt if task.json is missing', async () => {
    const { recovery, store, start } = setup();
    await store.createAttempt(attempt());
    await expect(recovery.onInterrupted(attempt())).rejects.toThrow('Missing task.json');
    expect(await store.listAttempts('run')).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('recovers a snapshot of running attempts only, within the requested run', async () => {
    const { seed, recovery, store } = setup();
    await seed();
    await seed(attempt({ taskId: 'T2', attemptId: 'T2-a1' }));
    await seed(attempt({ taskId: 'T3', attemptId: 'T3-a1', state: 'passed' }));
    await seed(attempt({ runId: 'other' }));
    expect((await recovery.resumeAfterRestart('run')).map(a => a.taskId)).toEqual(['T1', 'T2']);
    expect((await store.currentAttempt('other', 'T1'))?.state).toBe('running');
    expect((await store.currentAttempt('run', 'T3'))?.state).toBe('passed');
  });

  it('marks superseded running attempts interrupted without resuming them', async () => {
    const { seed, recovery, store, start } = setup();
    await seed();
    await seed(attempt({ n: 2, attemptId: 'T1-a2' }));
    expect(await recovery.resumeAfterRestart('run')).toHaveLength(1);
    expect((await store.currentAttempt('run', 'T1'))?.attemptId).toBe('T1-a3');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('ignores stop requests for missing or completed attempts', async () => {
    const { seed, recovery, stop, store } = setup();
    await recovery.requestStop('run', 'missing');
    await seed(attempt({ state: 'passed' }));
    await recovery.requestStop('run', 'T1');
    expect(stop).not.toHaveBeenCalled();
    expect(await store.listEvents('run')).toEqual([]);
  });

  it('matches all manifest identity fields against the current attempt', () => {
    const { recovery } = setup();
    const a = attempt();
    const manifest: Manifest = {
      runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, baseCommit: 'base', headCommit: 'head',
      branch: 'branch', changedFiles: [], checks: [], summary: '', status: 'complete',
    };
    expect(recovery.isCurrent(a, manifest)).toBe(true);
    for (const key of ['runId', 'taskId', 'attemptId'] as const) {
      expect(recovery.isCurrent(a, { ...manifest, [key]: 'stale' })).toBe(false);
    }
  });

  it('stops an executing local worker and resumes with its filesystem intact', async () => {
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const sandboxes = new LocalSandboxRunner();
    const { templateId } = await sandboxes.prepareTemplate({ runId: 'run', targetRepo: 'local/demo', setup: [] });
    const [sandboxId] = await sandboxes.fork(templateId, 1);
    try {
      const a = attempt({ sandboxId });
      await store.createAttempt(a);
      await disk.write(path(a), '{"id":"T1"}');
      const recovery = createRecovery({ store, disk, sandboxes });
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const executing = sandboxes.exec(sandboxId, 'echo durable > progress.txt; echo ready; sleep 30', {
        timeoutMs: 5000, onOutput: chunk => { if (chunk.includes('ready')) ready(); },
      });
      const rejected = expect(executing).rejects.toThrow('Sandbox stopped');
      await started;
      await recovery.requestStop('run', 'T1');
      await rejected;
      await expect(sandboxes.exec(sandboxId, 'true')).rejects.toThrow('Sandbox stopped');
      const resumed = await recovery.onInterrupted(a);
      expect(resumed).toMatchObject({ sandboxId, resume: true, attemptId: 'T1-a2' });
      expect((await sandboxes.exec(sandboxId, 'cat progress.txt')).stdout.trim()).toBe('durable');
      expect((await store.listEvents('run')).map(({ event }) => event.type)).toEqual([
        'attempt.stop_requested', 'attempt.interrupted',
      ]);
    } finally {
      await sandboxes.remove(sandboxId);
      await sandboxes.remove(templateId);
    }
  });
});
