import { describe, expect, it, vi } from 'vitest';
import { LocalSandboxRunner, MemoryDisk, MemoryStore, RecordingPublisher } from '../../src/contracts/fakes.js';
import type { Attempt, Manifest, SwarmEvent, TaskSpec } from '../../src/contracts/types.js';
import { createIntegrator } from '../../src/orchestrator/integrate.js';

const runId = 'integration-test';
const refresh = 'cd /repo && git fetch origin && git checkout -B main origin/main';
const task = (id: string): TaskSpec => ({
  id, title: `Task ${id}`, kind: 'task', dependsOn: [], owns: ['src/**'], acceptance: [], verify: ['npm test'],
});
const manifest = (id: string): Manifest => ({
  runId, taskId: id, attemptId: `${id}-a1`, baseCommit: 'base', headCommit: 'head',
  branch: `swarm/${runId}/${id}/${id}-a1`, changedFiles: ['src/app.ts'], checks: [], summary: 'Done', status: 'complete',
});
const pr = (number: number) => ({ number, url: `https://github.com/local/demo/pull/${number}` });
const success = { exitCode: 0, stdout: 'passed', stderr: '' };

function setup(finalVerify = ['npm test', 'npm run typecheck'], timeoutMs?: number) {
  const store = new MemoryStore();
  const disk = new MemoryDisk();
  const publisher = new RecordingPublisher();
  const sandboxes = new LocalSandboxRunner();
  const exec = vi.spyOn(sandboxes, 'exec').mockResolvedValue(success);
  const ports = { store, disk, publisher, sandboxes };
  return { ...ports, exec, integrator: createIntegrator(ports, { runId, integrationSandboxId: 'integration', finalVerify, timeoutMs }) };
}

describe('sequential integrator', () => {
  it('holds the entire merge and verification sequence in FIFO order', async () => {
    const { integrator, exec, publisher, store } = setup();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    exec.mockImplementationOnce(async () => { entered(); await barrier; return success; });
    integrator.enqueue(task('T1'), manifest('T1'), pr(100));
    integrator.enqueue(task('T2'), manifest('T2'), pr(101));
    let idle = false;
    const waiting = integrator.idle().then(() => { idle = true; });
    await started;
    expect(publisher.calls.filter(call => call.method === 'mergePullRequest').map(call => call.args)).toEqual([[100]]);
    expect(idle).toBe(false);
    expect((await store.listEvents(runId)).map(item => item.event.type)).toEqual(['pr.merged']);
    release();
    await waiting;
    expect(publisher.calls.filter(call => call.method === 'mergePullRequest').map(call => call.args)).toEqual([[100], [101]]);
    expect(exec.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['integration', refresh], ['integration', 'cd /repo && npm test'], ['integration', 'cd /repo && npm run typecheck'],
      ['integration', refresh], ['integration', 'cd /repo && npm test'], ['integration', 'cd /repo && npm run typecheck'],
    ]);
    expect(exec.mock.calls.every(call => call[2]?.timeoutMs === 120_000)).toBe(true);
    expect(await store.getTaskStatuses(runId)).toEqual({ T1: 'done', T2: 'done' });
    expect(publisher.calls.filter(call => call.method === 'setStatus').map(call => call.args)).toEqual([
      [runId, 'T1', 'done'], [runId, 'T2', 'done'],
    ]);
    expect((await store.listEvents(runId)).map(item => [item.event.type, item.event.taskId])).toEqual([
      ['pr.merged', 'T1'], ['task.status', 'T1'], ['integration.result', 'T1'],
      ['pr.merged', 'T2'], ['task.status', 'T2'], ['integration.result', 'T2'],
    ]);
  });

  it('blocks failed checks, comments with an output tail, and continues queued work', async () => {
    const { integrator, exec, publisher, store } = setup();
    exec.mockResolvedValueOnce(success).mockResolvedValueOnce({
      exitCode: 1, stdout: Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n'), stderr: 'assertion failed',
    });
    integrator.enqueue(task('T1'), manifest('T1'), pr(100));
    integrator.enqueue(task('T2'), manifest('T2'), pr(101));
    await integrator.idle();
    expect(await store.getTaskStatuses(runId)).toEqual({ T1: 'blocked', T2: 'done' });
    const comment = publisher.calls.find(call => call.method === 'comment');
    expect(comment?.args.slice(0, 2)).toEqual([runId, 'T1']);
    expect(comment?.args[2]).toContain('assertion failed');
    expect(comment?.args[2]).not.toContain('line-0\n');
    const results = (await store.listEvents(runId)).filter(item => item.event.type === 'integration.result');
    expect(results.map(item => item.event.data.pass)).toEqual([false, true]);
    expect(exec).toHaveBeenCalledTimes(6);
  });

  it('does not verify stale code when refreshing main fails', async () => {
    const { integrator, exec, store } = setup();
    exec.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'fetch failed' });
    integrator.enqueue(task('T1'), manifest('T1'), pr(100));
    await integrator.idle();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await store.getTaskStatuses(runId)).toEqual({ T1: 'blocked' });
  });

  it.each([0, 1])('blocks a timeout during command %i and continues queued work with the configured limit', async commandIndex => {
    const { integrator, exec, publisher, store } = setup(['npm test'], 500);
    if (commandIndex === 1) exec.mockResolvedValueOnce(success);
    exec.mockRejectedValueOnce(new Error('Execution timed out after 500ms'));
    integrator.enqueue(task('T1'), manifest('T1'), pr(100));
    integrator.enqueue(task('T2'), manifest('T2'), pr(101));
    await integrator.idle();
    expect(exec.mock.calls.every(call => call[2]?.timeoutMs === 500)).toBe(true);
    expect(await store.getTaskStatuses(runId)).toEqual({ T1: 'blocked', T2: 'done' });
    expect(publisher.calls.find(call => call.method === 'comment')?.args[2]).toContain('Execution timed out after 500ms');
    const results = (await store.listEvents(runId)).filter(item => item.event.type === 'integration.result');
    expect(results.map(item => item.event.data.pass)).toEqual([false, true]);
  });

  it.each(['merge', 'exec'])('records a %s exception and drains the rest of the queue', async failure => {
    const { integrator, exec, publisher, store } = setup([]);
    if (failure === 'merge') vi.spyOn(publisher, 'mergePullRequest').mockRejectedValueOnce(new Error('merge refused'));
    else exec.mockRejectedValueOnce(new Error('sandbox stopped'));
    integrator.enqueue(task('T1'), manifest('T1'), pr(100));
    integrator.enqueue(task('T2'), manifest('T2'), pr(101));
    await integrator.idle();
    expect(await store.getTaskStatuses(runId)).toEqual({ T1: 'blocked', T2: 'done' });
    expect(publisher.calls.find(call => call.method === 'comment')?.args[2]).toContain(
      failure === 'merge' ? 'merge refused' : 'sandbox stopped',
    );
  });

  it('still persists blocked status when a failure comment cannot be published', async () => {
    const { integrator, exec, publisher, store } = setup();
    exec.mockRejectedValueOnce(new Error('sandbox stopped'));
    vi.spyOn(publisher, 'comment').mockRejectedValueOnce(new Error('GitHub unavailable'));
    integrator.enqueue(task('T1'), manifest('T1'), pr(100));
    integrator.enqueue(task('T2'), manifest('T2'), pr(101));
    await expect(integrator.idle()).rejects.toThrow('Integration reporting failed');
    expect(await store.getTaskStatuses(runId)).toEqual({ T1: 'blocked', T2: 'done' });
    expect((await store.listEvents(runId)).filter(item => item.event.type === 'integration.result')).toHaveLength(2);
  });
});

describe('delivery report', () => {
  it('waits for integration and includes plan, attempts, findings, research, and final results', async () => {
    const { integrator, store, disk, publisher } = setup();
    const plan = { runId, brief: 'Demo', targetRepo: 'local/demo', baseBranch: 'main', tasks: [task('T1'), task('T2')] };
    await store.savePlan(plan);
    const issues = await publisher.publishPlan(plan);
    for (const [taskId, issue] of Object.entries(issues)) await store.setIssueNumber(runId, taskId, issue);
    const attempt: Attempt = {
      runId, taskId: 'T1', attemptId: 'T1-a1', n: 1, resume: false, state: 'failed',
      startedAt: '2026-11-10T01:00:01.000Z', deadlineAt: '2026-11-10T02:00:00.000Z', findings: ['Outside ownership'],
    };
    await store.createAttempt(attempt);
    await store.createAttempt({ ...attempt, attemptId: 'T1-a2', n: 2, state: 'passed', findings: [] });
    const seedEvent = async (type: string, data: SwarmEvent['data'], taskId?: string) => {
      await store.appendEvent({ runId, at: '2026-11-10T01:00:00.000Z', type, data, taskId });
    };
    await seedEvent('run.started', { brief: 'Demo' });
    await seedEvent('gate.result', { pass: false, findings: ['npm test failed'] }, 'T1');
    await seedEvent('research.done', { count: 3 }, 'T1');
    await disk.write(`/research/${runId}/T2/sources.json`, JSON.stringify([{ url: 'https://example.com' }]));
    integrator.enqueue(task('T1'), { ...manifest('T1'), attemptId: 'T1-a2' }, pr(100));
    const path = await integrator.writeReport();
    expect(path).toBe(`/delivery/${runId}/report.md`);
    const report = await disk.read(path);
    for (const text of [
      'Started: 2026-11-10T01:00:00.000Z', 'Ended:', 'Final test result: **PASS**',
      'Issue: [#1](https://github.com/local/demo/issues/1)', 'PR: [#100]', 'Attempts: 2',
      'Outside ownership', 'npm test failed', 'Research source count: 3', 'Research source count: 1',
      'T1-a1: failed', 'T1-a2: passed', 'Status: done', 'npm run typecheck', 'passed',
    ]) expect(report).toContain(text);
    expect((await store.listEvents(runId)).at(-1)?.event).toMatchObject({ type: 'run.done', data: { reportPath: path } });
  });

  it('recovers PR and failure evidence from events in a fresh integrator', async () => {
    const { store, disk, publisher, sandboxes } = setup();
    await store.savePlan({ runId, brief: '', targetRepo: 'local/demo', baseBranch: 'main', tasks: [task('T1')] });
    for (const [type, data] of [
      ['pr.opened', { number: 110, url: 'https://github.com/local/demo/pull/110' }],
      ['integration.result', { pass: false, output: 'test failure' }],
    ] as const) await store.appendEvent({ runId, taskId: 'T1', at: '2026-11-10T01:00:00.000Z', type, data });
    const restored = createIntegrator({ store, disk, publisher, sandboxes }, {
      runId, integrationSandboxId: 'integration', finalVerify: ['npm test'],
    });
    await restored.writeReport();
    const report = await disk.read(`/delivery/${runId}/report.md`);
    expect(report).toContain('Final test result: **FAIL**');
    expect(report).toContain('PR: [#110](https://github.com/local/demo/pull/110)');
    expect(report).toContain('test failure');
  });

  it('does not claim unexecuted tests passed', async () => {
    const { integrator, disk } = setup();
    await integrator.idle();
    const report = await disk.read(await integrator.writeReport());
    expect(report).toContain('Final test result: **Not run**');
  });

  it('links Radar evidence and matching receipts, and requires a final suite and gated merge', async () => {
    const { integrator, store, disk } = setup();
    await store.savePlan({ runId, brief: 'Radar', targetRepo: 'local/demo', baseBranch: 'main', tasks: [task('T4')] });
    await store.createAttempt({runId, taskId:'T4',attemptId:'T4-a1',n:1,resume:false,state:'passed',startedAt:'2026-11-11T00:00:00Z',deadlineAt:'2026-11-11T01:00:00Z'});
    await disk.write(`/research/${runId}/dataset.json`, JSON.stringify({
      runId,datasetId:'dataset-one',researchMode:'fixture',
      events:[{id:'event-one',name:'Evidence event',fields:{deadline:{status:'verified',value:'2026-12-01',findingIds:['finding-one']}}},
        {id:'event-two',name:'Uncertain event',fields:{deadline:{status:'conflicting',value:null,findingIds:[]}}}],
      findings:[{id:'finding-one',eventId:'event-one',field:'deadline',sourceId:'source-one',value:'2026-12-01'}],
      sources:[{id:'source-one',url:'https://example.test/rules',retrievedAt:'2026-11-11T00:00:00Z',contentPath:`/research/${runId}/roles/requirements/pages/source-one.md`}],
      roles:[{role:'discovery',status:'complete',findings:[],errors:[]},{role:'requirements',status:'complete',findings:[{}],errors:['timezone unknown']},{role:'comparison',status:'failed',findings:[],errors:['no source']}],
    }));
    await disk.write(`/runs/${runId}/T4/T4-a1/research-receipt.json`,JSON.stringify({runId,taskId:'T4',datasetId:'dataset-one',consumed:true,sha256:'abc123',eventCount:2}));
    const event = async (type:string,data:SwarmEvent['data'],taskId?:string,attemptId?:string) => {
      await store.appendEvent({runId,type,data,taskId,attemptId,at:'2026-11-11T00:00:00Z'});
    };
    await event('run.started',{mode:'test',agent:'fake',infrastructure:'local',planMode:'radar-fixture'});
    await event('integration.result',{pass:true,output:'intermediate typecheck'},'T4','T4-a1');
    let report = await disk.read(await integrator.writeReport());
    expect(report).toContain('Final test result: **Not run**');
    expect(report).toContain('Verified PR: not recorded');
    expect(report).toContain('coding agent: fake; infrastructure: local');
    expect(report).toContain('finding finding-one');
    expect(report).toContain('deadline 2026-12-01');
    expect(report).toContain('deadline conflicting; no verified deadline chain claimed');
    expect(report).toContain('SHA256 abc123, events 2');
    expect(report).toContain('timezone unknown');
    expect(report).toContain('comparison');
    await event('gate.result',{pass:true},'T4','T4-a1');
    await event('pr.opened',{number:42,url:'https://github.com/local/demo/pull/42'},'T4','T4-a1');
    await event('pr.merged',{number:42},'T4','T4-a1');
    await event('integration.result',{pass:true,final:true,output:'all 9 target tests passed'});
    report = await disk.read(await integrator.writeReport());
    expect(report).toContain('Final test result: **PASS**');
    expect(report).toContain('Verified PR: [#42](https://github.com/local/demo/pull/42)');
    expect(report).toContain('all 9 target tests passed');
  });

  it('does not accept a different run dataset or mismatched Radar receipt', async () => {
    const { integrator, store, disk } = setup();
    await disk.write(`/research/${runId}/dataset.json`,JSON.stringify({runId:'other',events:[],findings:[],sources:[],roles:[]}));
    let report=await disk.read(await integrator.writeReport());
    expect(report).toContain('invalid or belongs to another run');
    await store.savePlan({runId,brief:'',targetRepo:'local/demo',baseBranch:'main',tasks:[task('T4')]});
    await store.createAttempt({runId,taskId:'T4',attemptId:'T4-a1',n:1,resume:false,state:'passed',startedAt:'2026-11-11T00:00:00Z',deadlineAt:'2026-11-11T01:00:00Z'});
    await disk.write(`/research/${runId}/dataset.json`,JSON.stringify({runId,datasetId:'right',researchMode:'fresh',events:[],findings:[],sources:[],roles:[]}));
    await disk.write(`/runs/${runId}/T4/T4-a1/research-receipt.json`,JSON.stringify({runId,taskId:'T4',datasetId:'wrong',consumed:true,sha256:'wrong'}));
    report=await disk.read(await integrator.writeReport());
    expect(report).toContain('Matching research consumption receipt: not recorded');
    expect(report).not.toContain('SHA256 wrong');
  });
});
