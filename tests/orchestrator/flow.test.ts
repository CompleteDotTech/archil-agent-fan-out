import { describe, expect, it } from 'vitest';
import { FixturePlanner, MemoryDisk, MemoryStore, RecordingPublisher } from '../../src/contracts/fakes.js';
import type { Manifest, SandboxRunner } from '../../src/contracts/types.js';
import { createGate, createIntegrator, createRecovery, createScheduler } from '../../src/orchestrator/index.js';

describe('orchestrator flow', () => {
  it('delivers the bookmark plan after stopping and resuming one worker', async () => {
    const store = new MemoryStore();
    const disk = new MemoryDisk();
    const publisher = new RecordingPublisher();
    const plan = await new FixturePlanner().plan({
      runId: 'flow', brief: 'Build bookmarks', targetRepo: 'local/bookmarks',
    });
    await store.init();
    await store.savePlan(plan);
    const issues = await publisher.publishPlan(plan);
    for (const [taskId, number] of Object.entries(issues)) {
      await store.setIssueNumber(plan.runId, taskId, number);
    }
    const starts: string[] = [];
    const stops: string[] = [];
    const dispatches: { taskId: string; attemptId: string; sandboxId: string; resume: string | undefined }[] = [];
    let recovery: ReturnType<typeof createRecovery>;
    const sandboxes: SandboxRunner = {
      async prepareTemplate() { return { templateId: 'template', baseCommit: 'base' }; },
      async fork() { return ['worker-1', 'worker-2', 'worker-3']; },
      async start(id) { starts.push(id); },
      async stop(id) { stops.push(id); },
      async remove() {},
      async exec(sandboxId, cmd, opts) {
        if (cmd !== 'bash /mnt/archil/swarm/worker/run-task.sh') {
          return { exitCode: 0, stdout: 'checks passed', stderr: '' };
        }
        const env = opts?.env ?? {};
        const taskId = env.TASK_ID!;
        const attemptId = env.ATTEMPT_ID!;
        dispatches.push({ taskId, attemptId, sandboxId, resume: env.RESUME });
        if (taskId !== 'T1') {
          expect((await store.getTaskStatuses(plan.runId)).T1).toBe('done');
        }
        opts?.onOutput?.(`working on ${taskId}\n`);
        if (taskId === 'T2' && attemptId === 'T2-a1') {
          await recovery.requestStop(plan.runId, taskId);
          throw new Error('worker sandbox stopped');
        }
        const changedFiles: Record<string, string[]> = {
          T1: ['docs/api.md'], T2: ['src/api/bookmarks.ts'],
          T3: ['public/index.html'], T4: ['src/search/search.ts'],
        };
        const manifest: Manifest = {
          runId: plan.runId, taskId, attemptId, baseCommit: env.BASE_COMMIT!,
          headCommit: `head-${attemptId}`, branch: `swarm/${plan.runId}/${taskId}/${attemptId}`,
          changedFiles: changedFiles[taskId]!, checks: [], summary: `${taskId} ready`, status: 'complete',
        };
        await disk.write(`/runs/${plan.runId}/${taskId}/${attemptId}/manifest.json`, JSON.stringify(manifest));
        return { exitCode: 0, stdout: 'worker complete', stderr: '' };
      },
    };
    recovery = createRecovery({ store, sandboxes, disk });
    const integrator = createIntegrator({ store, publisher, sandboxes, disk }, {
      runId: plan.runId, integrationSandboxId: 'integration', finalVerify: ['npm test'],
    });
    const scheduler = createScheduler({
      store, publisher, sandboxes, disk, recovery, integrator, gate: createGate(sandboxes),
    }, {
      concurrency: 3, attemptTimeoutMs: 10_000, baseCommit: 'base', workerEnv: {},
      sandboxPool: ['worker-1', 'worker-2', 'worker-3'], pollMs: 1,
    });

    const result = await scheduler.runUntilDone(plan.runId);
    await integrator.idle();
    expect(result.blocked).toEqual([]);
    expect([...result.done].sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(dispatches.map(item => item.taskId)[0]).toBe('T1');
    const t2 = dispatches.filter(item => item.taskId === 'T2');
    expect(t2).toHaveLength(2);
    expect(t2[1]).toMatchObject({ attemptId: 'T2-a2', sandboxId: t2[0]!.sandboxId, resume: '1' });
    expect(stops).toEqual([t2[0]!.sandboxId]);
    expect(starts).toContain(t2[0]!.sandboxId);
    const attempts = await store.listAttempts(plan.runId);
    expect(attempts.find(item => item.attemptId === 'T2-a1')?.state).toBe('interrupted');
    expect(attempts.find(item => item.attemptId === 'T2-a2')?.resume).toBe(true);
    expect(publisher.calls.filter(call => call.method === 'mergePullRequest')).toHaveLength(4);
    const events = (await store.listEvents(plan.runId)).map(item => item.event);
    expect(events.some(event => event.type === 'attempt.interrupted' && event.taskId === 'T2')).toBe(true);
    expect(events.filter(event => event.type === 'integration.result')).toHaveLength(4);
    const reportPath = await integrator.writeReport();
    expect(reportPath).toBe('/delivery/flow/report.md');
    const report = await disk.read(reportPath);
    expect(report).toContain('Final test result: **PASS**');
    expect(report).toContain('T2-a1: interrupted');
    expect(report).toContain('T2-a2:');
  });
});
