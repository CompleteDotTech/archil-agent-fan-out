import { describe, it, expect } from 'vitest';
import { MemoryStore, MemoryDisk, FixturePlanner, FixtureResearch, RecordingPublisher, PassGate, LocalSandboxRunner } from '../../src/contracts/fakes.js';

describe('contract fakes', () => {
  it('stores plans, statuses and ordered events', async () => {
    const store = new MemoryStore();
    await store.init();
    const plan = await new FixturePlanner().plan({ runId: 'r', brief: 'brief', targetRepo: 'local/demo' });
    await store.savePlan(plan);
    expect((await store.getPlan('r'))?.brief).toBe('brief');
    await store.setTaskStatus('r', 'T1', 'done');
    expect((await store.getTaskStatuses('r')).T1).toBe('done');
    const event = {runId:'r', at:new Date().toISOString(), type:'test', data:{}};
    await store.appendEvent(event); await store.appendEvent(event);
    const events = await store.listEvents('r');
    expect(events).toHaveLength(2);
    expect(events[1]!.index).toBeGreaterThan(events[0]!.index);
    expect(await store.listEvents('r', events[0]!.index)).toHaveLength(1);
  });
  it('stores disk paths and provides fixture research and publishing', async () => {
    const disk = new MemoryDisk();
    await disk.write('/z/file', 'z'); await disk.write('/a/file', 'a');
    expect(await disk.read('/missing')).toBeUndefined();
    expect(await disk.list('/')).toEqual(['/a/file','/z/file']);
    expect((await new FixtureResearch().search('test')).length).toBeGreaterThan(0);
    const plan = await new FixturePlanner().plan({runId:'r',brief:'b',targetRepo:'x/y'});
    const pub = new RecordingPublisher();
    const issues = await pub.publishPlan(plan);
    expect(Object.keys(issues)).toHaveLength(plan.tasks.length);
    const pr = await pub.openPullRequest({runId:'r',taskId:'T1',branch:'b',title:'t',body:'b'});
    expect(pr.number).toBe(100);
    expect((await pub.mergePullRequest(pr.number)).mergeCommit).toBeTruthy();
    expect(pub.calls.length).toBeGreaterThan(0);
    expect((await new PassGate().check({task:plan.tasks[0]!,manifest:{} as never,sandboxId:'s'})).pass).toBe(true);
  });
  it('runs local commands and rejects an interrupted execution', async () => {
    const runner = new LocalSandboxRunner();
    const {templateId} = await runner.prepareTemplate({runId:'r',targetRepo:'local/demo',setup:['echo ready > ready.txt']});
    const [id] = await runner.fork(templateId,1);
    try {
      expect((await runner.exec(id!, 'cat ready.txt')).stdout.trim()).toBe('ready');
      const pending = runner.exec(id!, 'sleep 30');
      const rejected = expect(pending).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 50));
      await runner.stop(id!); await rejected;
      await runner.start(id!);
      expect((await runner.exec(id!, 'echo restarted')).exitCode).toBe(0);
    } finally { await runner.remove(id!); await runner.remove(templateId); }
  });
});
