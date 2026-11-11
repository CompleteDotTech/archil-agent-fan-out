import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { MemoryStore } from '../contracts/fakes.js';
import type { Attempt, Plan, TaskStatus } from '../contracts/types.js';
import { createDashboard } from './server.js';

const runId = 'demo';
const tickMs = 2_000;

interface DemoWorker {
  taskId: string;
  attempt: Attempt;
  progress: number;
  finishAt: number;
  resumeAt?: number;
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await readFile(
    new URL('../../fixtures/plan.bookmarks.json', import.meta.url), 'utf8',
  )) as Plan;
  const plan: Plan = { ...fixture, runId };
  const store = new MemoryStore();
  const workers: DemoWorker[] = [];
  const now = () => new Date().toISOString();

  async function event(type: string, data: Record<string, unknown>, taskId?: string, attemptId?: string) {
    await store.appendEvent({ runId, type, data, taskId, attemptId, at: now() });
  }

  async function status(taskId: string, value: TaskStatus) {
    await store.setTaskStatus(runId, taskId, value);
    await event('task.status', { status: value }, taskId);
  }

  async function startAttempt(taskId: string, n = 1): Promise<Attempt> {
    const attempt: Attempt = {
      runId, taskId, attemptId: `${taskId}-a${n}`, n,
      sandboxId: `demo-sandbox-${taskId.toLowerCase()}`,
      resume: n > 1, state: 'running', startedAt: now(),
      deadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    await store.createAttempt(attempt);
    await status(taskId, 'running');
    await event('attempt.started', {
      attemptId: attempt.attemptId, sandboxId: attempt.sandboxId, resume: attempt.resume,
    }, taskId, attempt.attemptId);
    return attempt;
  }

  async function log(worker: DemoWorker, line: string) {
    await event('agent.log', { line }, worker.taskId, worker.attempt.attemptId);
  }

  async function openPr(taskId: string, number: number) {
    await event('pr.opened', {
      number, url: `https://github.com/${plan.targetRepo}/pull/${number}`,
    }, taskId);
  }

  await store.init();
  await store.savePlan(plan);
  await event('run.started', { brief: plan.brief, demo: true });
  for (const [index, task] of plan.tasks.entries()) {
    await store.setIssueNumber(runId, task.id, index + 1);
  }
  await event('plan.published', { issues: await store.getIssueNumbers(runId) });

  // Architecture has already merged, so all three independent forks are visible at startup.
  for (const task of plan.tasks) {
    if (task.kind === 'epic') {
      await status(task.id, 'running');
      continue;
    }
    const attempt = await startAttempt(task.id);
    if (task.dependsOn.length === 0) {
      await event('agent.log', { line: 'Architecture contract and acceptance tests committed.' }, task.id, attempt.attemptId);
      await store.updateAttempt(runId, attempt.attemptId, { state: 'passed' });
      await event('gate.result', { pass: true, findings: [] }, task.id, attempt.attemptId);
      await openPr(task.id, 100);
      await event('pr.merged', { number: 100 }, task.id);
      await status(task.id, 'done');
    } else {
      const worker = { taskId: task.id, attempt, progress: 0, finishAt: 25 + workers.length * 8 };
      workers.push(worker);
      await log(worker, 'Fork ready; reading the shared API contract and acceptance tests.');
    }
  }

  // Serialize timer ticks and HTTP stop requests to avoid racing an interrupted attempt's completion.
  let pending = Promise.resolve();
  let closing = false;
  function enqueue(action: () => Promise<void>): Promise<void> {
    const next = pending.then(async () => { if (!closing) await action(); });
    pending = next.catch(() => undefined);
    return next;
  }

  async function stopTask(requestRunId: string, taskId: string) {
    await enqueue(async () => {
      if (requestRunId !== runId) throw new Error('Unknown demo run');
      const worker = workers.find(item => item.taskId === taskId);
      if (!worker || worker.attempt.state !== 'running') return;
      await event('attempt.stop_requested', { attemptId: worker.attempt.attemptId }, taskId, worker.attempt.attemptId);
      worker.attempt.state = 'interrupted';
      await store.updateAttempt(runId, worker.attempt.attemptId, { state: 'interrupted' });
      await event('attempt.interrupted', { attemptId: worker.attempt.attemptId }, taskId, worker.attempt.attemptId);
      await status(taskId, 'ready');
      await log(worker, 'Sandbox stopped. Shared disk and working tree preserved; resuming in 4 seconds.');
      worker.resumeAt = Date.now() + 4_000;
    });
  }

  async function tick() {
    for (const [index, worker] of workers.entries()) {
      if (worker.attempt.state === 'interrupted') {
        if (Date.now() < (worker.resumeAt ?? Infinity)) continue;
        worker.attempt = await startAttempt(worker.taskId, worker.attempt.n + 1);
        delete worker.resumeAt;
        await log(worker, 'Resumed the Codex session in the same sandbox; continuing from the saved working tree.');
      }
      if (worker.attempt.state !== 'running') continue;
      worker.progress++;
      if (worker.progress === 1) {
        await event('research.done', {
          count: 2, sourcesPath: `/research/${runId}/${worker.taskId}/sources.md`,
        }, worker.taskId);
        await log(worker, 'Read cited research notes from the shared disk.');
      } else if (worker.progress === worker.finishAt - 2) {
        await log(worker, 'Acceptance checks passed; writing the manifest and syncing the shared disk.');
      } else if (worker.progress === worker.finishAt - 1) {
        worker.attempt.state = 'submitted';
        await store.updateAttempt(runId, worker.attempt.attemptId, { state: 'submitted' });
        await event('gate.result', { pass: true, findings: [] }, worker.taskId, worker.attempt.attemptId);
        await status(worker.taskId, 'review');
        await openPr(worker.taskId, 101 + index);
      } else if (worker.progress % 3 === 0) {
        await log(worker, `Implementing ${worker.taskId}: saved checkpoint ${Math.floor(worker.progress / 3)}; verification in progress.`);
      }
    }
    // A submitted PR merges on the next tick, keeping Review visible in the dashboard.
    for (const [index, worker] of workers.entries()) {
      if (worker.attempt.state !== 'submitted') continue;
      worker.progress++;
      if (worker.progress <= worker.finishAt) continue;
      await event('pr.merged', { number: 101 + index }, worker.taskId);
      await event('integration.result', { pass: true, output: 'npm test: all acceptance checks passed (simulated demo).' }, worker.taskId);
      worker.attempt.state = 'passed';
      await store.updateAttempt(runId, worker.attempt.attemptId, { state: 'passed' });
      await status(worker.taskId, 'done');
    }
    if (workers.every(worker => worker.attempt.state === 'passed')) {
      for (const task of plan.tasks.filter(task => task.kind === 'epic')) await status(task.id, 'done');
      clearInterval(timer);
    }
  }

  const app = createDashboard({ store }, { stopTask }, {
    publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
  });
  const server = serve({ fetch: app.fetch, port: 3000 }, () => {
    console.log('Dashboard demo: http://localhost:3000/?run=demo (simulated data; no external services)');
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const timer = setInterval(() => {
    void enqueue(tick).catch(error => {
      console.error('Demo update failed:', error);
      process.exitCode = 1;
      shutdown();
    });
  }, tickMs);

  function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    server.close();
    // SSE connections otherwise keep server.close() waiting indefinitely.
    for (const socket of sockets) socket.destroy();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('error', error => {
    console.error('Dashboard server failed:', error);
    process.exitCode = 1;
    shutdown();
  });
}

void main().catch(error => {
  console.error('Unable to start dashboard demo:', error);
  process.exitCode = 1;
});
