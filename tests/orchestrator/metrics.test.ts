import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/contracts/fakes.js';
import type { Attempt, SwarmEvent } from '../../src/contracts/types.js';
import { calculateMetrics } from '../../src/orchestrator/metrics.js';

const time = (seconds: number): string => new Date(Date.UTC(2026, 10, 10) + seconds * 1000).toISOString();
const attempt = (taskId: string, n: number, start: number, state: Attempt['state'] = 'running'): Attempt => ({
  runId: 'run', taskId, attemptId: `${taskId}-a${n}`, n, state, resume: n > 1,
  startedAt: time(start), deadlineAt: time(start + 600),
});
const event = (a: Attempt, type: string, at: number, data: SwarmEvent['data'] = {}): SwarmEvent => ({
  runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, type, at: time(at), data,
});

describe('calculateMetrics', () => {
  it('measures resumed attempts and parallel execution from durable fake-store records', async () => {
    const store = new MemoryStore();
    const first = attempt('T1', 1, 0, 'interrupted');
    const resumed = attempt('T1', 2, 20, 'passed');
    const parallel = attempt('T2', 1, 5, 'passed');
    for (const a of [first, resumed, parallel]) await store.createAttempt(a);
    for (const e of [
      event(first, 'attempt.interrupted', 10), event(first, 'attempt.interrupted', 10),
      event(resumed, 'gate.result', 40, { pass: true }),
      event(resumed, 'task.status', 50, { status: 'done' }),
      event(parallel, 'task.status', 30, { status: 'done' }),
    ]) await store.appendEvent(e);

    const result = calculateMetrics(await store.listAttempts('run'),
      (await store.listEvents('run')).map(item => item.event), new Date(time(100)));
    expect(result.tasks).toEqual({
      T1: { attemptCount: 2, interruptedCount: 1, durationMs: 30_000, elapsedMs: 40_000 },
      T2: { attemptCount: 1, interruptedCount: 0, durationMs: 25_000, elapsedMs: 25_000 },
    });
    expect(result.total).toEqual({ attemptCount: 3, interruptedCount: 1, durationMs: 55_000, elapsedMs: 40_000 });
  });

  it('uses the earliest valid endpoint regardless of event order or pass/fail outcome', () => {
    const a = attempt('T1', 1, 10, 'failed');
    const events = [
      event(a, 'task.status', 40, { status: 'blocked' }),
      event(a, 'gate.result', 30, { pass: false }), event(a, 'gate.result', 30, { pass: false }),
      { ...event(a, 'gate.result', 20), at: 'invalid' },
      event(a, 'task.status', 15, { status: 'review' }),
    ];
    expect(calculateMetrics([a], events, new Date(time(100))).total.durationMs).toBe(20_000);
  });

  it('falls back to now for missing or invalid event timestamps, even for stored terminal states', () => {
    const open = attempt('T1', 1, 10);
    const endedWithoutTimestamp = attempt('T2', 1, 20, 'interrupted');
    const events = [
      { ...event(open, 'gate.result', 30), at: undefined as unknown as string },
      { ...event(endedWithoutTimestamp, 'attempt.interrupted', 30), at: 'not a date' },
    ];
    expect(calculateMetrics([open, endedWithoutTimestamp], events, new Date(time(50))).total).toEqual({
      attemptCount: 2, interruptedCount: 1, durationMs: 70_000, elapsedMs: 40_000,
    });
  });

  it('ignores unmatched run, task, and attempt events and events without an attempt id', () => {
    const a = attempt('T1', 1, 10);
    const events = [
      { ...event(a, 'gate.result', 11), runId: 'another-run' },
      { ...event(a, 'gate.result', 12), taskId: 'T2' },
      { ...event(a, 'attempt.interrupted', 13), attemptId: 'T1-a2' },
      { ...event(a, 'task.status', 14, { status: 'done' }), attemptId: undefined },
    ];
    expect(calculateMetrics([a], events, new Date(time(20))).total).toEqual({
      attemptCount: 1, interruptedCount: 0, durationMs: 10_000, elapsedMs: 10_000,
    });
  });

  it('accepts attempt ids in event data and counts an interruption once', () => {
    const a = attempt('T1', 1, 0);
    const e = { ...event(a, 'attempt.interrupted', 5), attemptId: undefined, taskId: undefined,
      data: { attemptId: a.attemptId } };
    expect(calculateMetrics([a], [e, e], new Date(time(20))).total).toEqual({
      attemptCount: 1, interruptedCount: 1, durationMs: 5_000, elapsedMs: 5_000,
    });
  });

  it('excludes invalid starts and clamps negative durations and invalid now', () => {
    const invalid = { ...attempt('T1', 1, 0, 'interrupted'), startedAt: 'invalid' };
    const negative = attempt('T2', 1, 10);
    const open = attempt('T3', 1, 20);
    const result = calculateMetrics([invalid, negative, open],
      [event(negative, 'gate.result', 5)], new Date('invalid'));
    expect(result.total).toEqual({ attemptCount: 3, interruptedCount: 1, durationMs: 0, elapsedMs: 10_000 });
    expect(Object.values(result.tasks).every(value => value.durationMs === 0 && value.elapsedMs === 0)).toBe(true);
  });

  it('returns zeros for no attempts and does not mutate inputs', () => {
    expect(calculateMetrics([], [], new Date(time(20)))).toEqual({
      tasks: {}, total: { attemptCount: 0, interruptedCount: 0, durationMs: 0, elapsedMs: 0 },
    });
    const attempts = [attempt('__proto__', 1, 10)];
    const events = [event(attempts[0], 'gate.result', 20)];
    const snapshot = structuredClone({ attempts, events });
    const result = calculateMetrics(attempts, events, new Date(time(30)));
    expect({ attempts, events }).toEqual(snapshot);
    expect(Object.hasOwn(result.tasks, '__proto__')).toBe(true);
    expect(result.tasks.__proto__.durationMs).toBe(10_000);
  });
});
