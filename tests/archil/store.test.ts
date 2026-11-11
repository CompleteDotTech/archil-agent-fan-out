import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type SQLiteDatabase } from '@archildata/sqlite';
import type { Disk } from 'disk';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import type { Attempt, Manifest, Plan, Store, SwarmEvent, TaskStatus } from '../../src/contracts/types.js';
import { archilDb, nodeSqliteDb, type Db } from '../../src/archil/db.js';
import { createSqliteStore } from '../../src/archil/store.js';

vi.mock('@archildata/sqlite', () => ({ createDatabase: vi.fn() }));

describe('Archil SQLite operation queue', () => {
  it('serializes writes, journal-capable reads and deferred transactions, then continues after rejection', async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    let individualTransactionExecutions = 0;
    const failure = new Error('SDK operation failed');
    const operation = (name: string): Promise<unknown> => {
      started.push(name); active++; peak = Math.max(peak, active);
      return new Promise((resolve, reject) => releases.push(() => {
        active--;
        if (name === 'fail') reject(failure);
        else resolve(name === 'read' || name === 'after' ? [{ value: name }] : undefined);
      }));
    };
    const sdk = {
      write(strings: TemplateStringsArray) {
        const name = strings.join('?');
        const deferred = () => ({
          name,
          then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
            if (name.startsWith('batch-')) individualTransactionExecutions++;
            return operation(name).then(resolve, reject);
          },
        });
        return { run: deferred, all: deferred };
      },
      transaction(operations: { name: string }[]) {
        // Merely constructing transaction operations must not execute them.
        expect(operations.map(item => item.name)).toEqual(['batch-one', 'batch-two']);
        expect(individualTransactionExecutions).toBe(0);
        return operation('transaction');
      },
    } as unknown as SQLiteDatabase;
    vi.mocked(createDatabase).mockResolvedValueOnce(sdk);
    const db = archilDb({ id: 'disk' } as Disk, 'state.sqlite');
    const results = Promise.allSettled([
      db.run('write'), db.all('read'), db.batch([{ sql: 'batch-one' }, { sql: 'batch-two' }]),
      db.run('fail'), db.all('after'),
    ]);
    for (const name of ['write', 'read', 'transaction', 'fail', 'after']) {
      await vi.waitFor(() => expect(started.at(-1)).toBe(name));
      expect(active).toBe(1);
      releases.shift()!();
    }
    expect(await results).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: [{ value: 'read' }] },
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: [{ value: 'after' }] },
    ]);
    expect(started).toEqual(['write', 'read', 'transaction', 'fail', 'after']);
    expect(peak).toBe(1);
    expect(individualTransactionExecutions).toBe(0);
  });

  it('retries failed database initialization without poisoning queued operations', async () => {
    const failure = new Error('temporary initialization failure');
    const sdk = { write: () => ({ all: () => Promise.resolve([{ value: 'recovered' }]) }) } as unknown as SQLiteDatabase;
    vi.mocked(createDatabase).mockRejectedValueOnce(failure).mockResolvedValueOnce(sdk);
    const db = archilDb({ id: 'disk' } as Disk, 'state.sqlite');
    expect(await Promise.allSettled([db.run('first'), db.all('next')])).toEqual([
      { status: 'rejected', reason: failure }, { status: 'fulfilled', value: [{ value: 'recovered' }] },
    ]);
  });
});

const startedAt = '2026-11-10T12:00:00.000Z';
const deadlineAt = '2026-11-10T12:15:00.000Z';

function attempt(runId: string, taskId: string, n: number): Attempt {
  return {
    runId, taskId, attemptId: `${taskId}-a${n}`, n,
    resume: false, state: 'running', startedAt, deadlineAt,
  };
}

function manifest(runId: string): Manifest {
  return {
    runId, taskId: 'T1', attemptId: 'T1-a1',
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
    branch: `swarm/${runId}/T1/T1-a1`,
    changedFiles: ['src/types.ts', 'docs/api.md'],
    checks: [{ cmd: 'npm test', exitCode: 0, logPath: `/runs/${runId}/verify.log` }],
    summary: 'Created the API contract.\nQuotes: "ready"; Unicode: ✓', status: 'complete',
  };
}

function event(runId: string, line: string, at = startedAt): SwarmEvent {
  return {
    runId, taskId: 'T1', attemptId: 'T1-a1', at, type: 'agent.log',
    data: { line, nested: { ready: true }, values: [1, null, '✓'] },
  };
}

describe('SQLite Store with node:sqlite', () => {
  let db: Db;
  let store: Store;
  let plan: Plan;

  beforeEach(async () => {
    db = nodeSqliteDb();
    store = createSqliteStore(db);
    await store.init();
    plan = await new FixturePlanner().plan({
      runId: 'run-one', brief: 'Build bookmarks with "quotes" and Unicode ✓.\nSecond line.',
      targetRepo: 'local/bookmarks', baseBranch: 'develop',
    });
  });

  it('initializes repeatedly without deleting persisted state', async () => {
    await store.savePlan(plan);
    await store.setTaskStatus(plan.runId, 'T1', 'done');
    await store.setIssueNumber(plan.runId, 'T1', 42);
    const first = attempt(plan.runId, 'T1', 1);
    await store.createAttempt(first);
    await store.appendEvent(event(plan.runId, 'saved'));

    await store.init();
    const reopened = createSqliteStore(db);
    await reopened.init();

    expect(await reopened.getPlan(plan.runId)).toEqual(plan);
    expect((await reopened.getTaskStatuses(plan.runId)).T1).toBe('done');
    expect(await reopened.getIssueNumbers(plan.runId)).toEqual({ T1: 42 });
    expect(await reopened.currentAttempt(plan.runId, 'T1')).toEqual(first);
    expect((await reopened.listEvents(plan.runId)).map(row => row.event)).toEqual([event(plan.runId, 'saved')]);
  });

  it('round trips the full fixture plan and replaces its content on save', async () => {
    expect(await store.getPlan('missing')).toBeUndefined();
    await store.savePlan(plan);
    expect(await store.getPlan(plan.runId)).toEqual(plan);
    const updated = { ...plan, brief: 'Updated brief', baseBranch: 'release' };
    await store.savePlan(updated);
    expect(await store.getPlan(plan.runId)).toEqual(updated);

    const read = (await store.getPlan(plan.runId))!;
    read.tasks[0]!.acceptance.push('client-side mutation');
    expect(await store.getPlan(plan.runId)).toEqual(updated);
  });

  it('starts all tasks in backlog and updates statuses and issue numbers independently', async () => {
    expect(await store.getTaskStatuses('missing')).toEqual({});
    expect(await store.getIssueNumbers('missing')).toEqual({});
    await store.savePlan(plan);
    const expected: Record<string, TaskStatus> = Object.fromEntries(plan.tasks.map(task => [task.id, 'backlog']));
    expect(await store.getTaskStatuses(plan.runId)).toEqual(expected);
    expect(await store.getIssueNumbers(plan.runId)).toEqual({});

    for (const status of ['ready', 'running', 'review', 'done', 'blocked', 'backlog'] as const) {
      await store.setTaskStatus(plan.runId, 'T1', status);
      expected.T1 = status;
      expect(await store.getTaskStatuses(plan.runId)).toEqual(expected);
    }
    await store.setTaskStatus(plan.runId, 'T1', 'done');
    await store.setIssueNumber(plan.runId, 'T1', 12);
    await store.setIssueNumber(plan.runId, 'T2', 13);
    await store.setIssueNumber(plan.runId, 'T1', 99);
    await store.savePlan(plan);
    expected.T1 = 'done';
    expect(await store.getTaskStatuses(plan.runId)).toEqual(expected);
    expect(await store.getIssueNumbers(plan.runId)).toEqual({ T1: 99, T2: 13 });
  });

  it('creates and patches attempts, selecting current by highest numeric n', async () => {
    await store.savePlan(plan);
    expect(await store.currentAttempt(plan.runId, 'T1')).toBeUndefined();
    expect(await store.listAttempts(plan.runId)).toEqual([]);
    const first = attempt(plan.runId, 'T1', 1);
    const highest = { ...attempt(plan.runId, 'T1', 10), sandboxId: 'sandbox-ten', resume: true, findings: ['Retry "quoted" check', '✓'] };
    const second = { ...attempt(plan.runId, 'T1', 2), startedAt: deadlineAt };
    const otherTask = attempt(plan.runId, 'T2', 1);
    // Deliberately insert out of order; neither insertion time nor lexical ids determine current.
    for (const value of [first, highest, second, otherTask]) await store.createAttempt(value);
    expect(await store.currentAttempt(plan.runId, 'T1')).toEqual(highest);
    expect(await store.currentAttempt(plan.runId, 'T2')).toEqual(otherTask);

    const patch: Partial<Attempt> = { state: 'interrupted', findings: ['Execution stopped'], deadlineAt: '2026-11-10T12:30:00.000Z' };
    await store.updateAttempt(plan.runId, highest.attemptId, patch);
    const updated = { ...highest, ...patch };
    expect(await store.currentAttempt(plan.runId, 'T1')).toEqual(updated);
    expect(await store.listAttempts(plan.runId)).toHaveLength(4);
    expect(await store.listAttempts(plan.runId)).toEqual(expect.arrayContaining([first, updated, second, otherTask]));
  });

  it('preserves disjoint patches applied concurrently to an attempt', async () => {
    const first = attempt(plan.runId, 'T1', 1);
    await store.createAttempt(first);

    await Promise.all([
      store.updateAttempt(plan.runId, first.attemptId, { state: 'failed' }),
      store.updateAttempt(plan.runId, first.attemptId, { findings: ['Check failed'] }),
    ]);

    expect(await store.currentAttempt(plan.runId, 'T1')).toEqual({
      ...first, state: 'failed', findings: ['Check failed'],
    });
  });

  it('continues queued attempt patches after an update rejects', async () => {
    const first = attempt(plan.runId, 'T1', 1);
    await store.createAttempt(first);

    const results = await Promise.allSettled([
      store.updateAttempt(plan.runId, 'missing', { state: 'failed' }),
      store.updateAttempt(plan.runId, first.attemptId, { state: 'passed' }),
    ]);

    expect(results[0]).toEqual({
      status: 'rejected', reason: new Error('Unknown attempt: missing'),
    });
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
    expect(await store.currentAttempt(plan.runId, 'T1')).toEqual({ ...first, state: 'passed' });
  });

  it('persists complete manifest JSON and replaces the same attempt manifest', async () => {
    await store.savePlan(plan);
    await store.createAttempt(attempt(plan.runId, 'T1', 1));
    const initial = manifest(plan.runId);
    await store.saveManifest(initial);
    // Store has no manifest reader; inspect only the documented persisted JSON column.
    expect((await db.all<{ json: string }>('SELECT json FROM manifests')).map(row => JSON.parse(row.json))).toEqual([initial]);
    const updated: Manifest = { ...initial, status: 'failed', checks: [{ cmd: 'npm test', exitCode: 1 }], summary: 'Check failed' };
    await store.saveManifest(updated);
    const other = manifest('run-two');
    await store.savePlan({ ...plan, runId: 'run-two' });
    await store.createAttempt(attempt('run-two', 'T1', 1));
    await store.saveManifest(other);
    const rows = (await db.all<{ json: string }>('SELECT json FROM manifests')).map(row => JSON.parse(row.json));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([updated, other]));
  });

  it('orders events by append index and uses an exclusive cursor across interleaved runs', async () => {
    expect(await store.listEvents(plan.runId)).toEqual([]);
    const first = event(plan.runId, 'first', deadlineAt);
    const other = event('run-two', 'other');
    const second = event(plan.runId, 'second');
    const third = event(plan.runId, 'third');
    for (const value of [first, other, second, third]) await store.appendEvent(value);
    const rows = await store.listEvents(plan.runId);
    expect(rows.map(row => row.event)).toEqual([first, second, third]);
    expect(rows.every(row => Number.isInteger(row.index) && row.index > 0)).toBe(true);
    expect(rows[1]!.index).toBeGreaterThan(rows[0]!.index);
    expect(rows[2]!.index).toBeGreaterThan(rows[1]!.index);
    expect(await store.listEvents(plan.runId, 0)).toEqual(rows);
    expect(await store.listEvents(plan.runId, rows[0]!.index)).toEqual(rows.slice(1));
    expect(await store.listEvents(plan.runId, rows[2]!.index)).toEqual([]);
    const otherRows = await store.listEvents('run-two');
    expect(otherRows.map(row => row.event)).toEqual([other]);
    expect(otherRows[0]!.index).toBeGreaterThan(rows[0]!.index);
    expect(otherRows[0]!.index).toBeLessThan(rows[1]!.index);
    expect(await store.listEvents(plan.runId, otherRows[0]!.index)).toEqual(rows.slice(1));
    expect(await store.listEvents('missing')).toEqual([]);
  });

  it('isolates plans, statuses, issues and identical attempt ids between runs', async () => {
    const otherPlan = { ...plan, runId: 'run-two', brief: 'A separate run' };
    await store.savePlan(plan);
    await store.savePlan(otherPlan);
    await store.setTaskStatus(plan.runId, 'T1', 'done');
    await store.setTaskStatus(otherPlan.runId, 'T1', 'running');
    await store.setIssueNumber(plan.runId, 'T1', 101);
    await store.setIssueNumber(otherPlan.runId, 'T1', 202);
    const first = attempt(plan.runId, 'T1', 1);
    const other = { ...attempt(otherPlan.runId, 'T1', 1), sandboxId: 'separate-sandbox' };
    await store.createAttempt(first);
    await store.createAttempt(other);
    await store.updateAttempt(plan.runId, first.attemptId, { state: 'passed' });

    expect(await store.getPlan(plan.runId)).toEqual(plan);
    expect(await store.getPlan(otherPlan.runId)).toEqual(otherPlan);
    expect((await store.getTaskStatuses(plan.runId)).T1).toBe('done');
    expect((await store.getTaskStatuses(otherPlan.runId)).T1).toBe('running');
    expect(await store.getIssueNumbers(plan.runId)).toEqual({ T1: 101 });
    expect(await store.getIssueNumbers(otherPlan.runId)).toEqual({ T1: 202 });
    expect(await store.listAttempts(plan.runId)).toEqual([{ ...first, state: 'passed' }]);
    expect(await store.listAttempts(otherPlan.runId)).toEqual([other]);
    expect(await store.currentAttempt(otherPlan.runId, 'T1')).toEqual(other);
    expect(await store.listAttempts('missing')).toEqual([]);
  });
});
