import { describe, expect, it, vi } from 'vitest';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import type { Plan } from '../../src/contracts/types.js';
import { createGitHubClient, type GitHubClient } from '../../src/github/client.js';
import { marker, runLabel } from '../../src/github/markers.js';
import { publishPlan, type ProjectConfig } from '../../src/github/publish.js';

const project: ProjectConfig = {
  projectId: 'project', statusFieldId: 'status',
  statusOptionIds: { backlog: 'b', ready: 'r', running: 'x', review: 'v', done: 'd', blocked: 'z' },
};
async function fixture(): Promise<Plan> {
  const plan = await new FixturePlanner().plan({ runId: 'run-1', brief: 'Test', targetRepo: 'test/demo' });
  // Put the epic last to ensure publishing sorts kinds rather than relying on planner order.
  plan.tasks = [...plan.tasks.filter(task => task.kind === 'task'), ...plan.tasks.filter(task => task.kind === 'epic')];
  return plan;
}
function dryClient() {
  const calls: { method: string; path: string; params: any }[] = [];
  const client = createGitHubClient({ owner: 'test', repo: 'demo', dryRun: true,
    minIntervalMs: 0, onCall: call => calls.push(call) });
  return { client, calls };
}
const base = '/repos/{owner}/{repo}/issues';

describe('publishPlan', () => {
  it('uses bounded deterministic labels for long run IDs and preserves full markers', async () => {
    const plan=await fixture(); plan.runId='radar-rehearsal-'+'x'.repeat(80);
    const {client,calls}=dryClient(); await publishPlan(client,plan);
    expect(runLabel(plan.runId).length).toBeLessThanOrEqual(50);
    expect(runLabel(plan.runId)).not.toBe(runLabel(plan.runId+'other'));
    const create=calls.find(call=>call.method==='POST'&&call.path===base)!;
    expect(create.params.labels).toContain(runLabel(plan.runId));
    expect(create.params.body).toContain(marker(plan.runId,'EP1'));
    expect(calls[0].params.labels).toBe(runLabel(plan.runId));
  });
  it('looks up run issues first, then creates epics and tasks before linking numeric ids', async () => {
    const plan = await fixture();
    const { client, calls } = dryClient();
    const result = await publishPlan(client, plan);
    expect(calls[0]).toMatchObject({ method: 'GET', path: base,
      params: { labels: 'swarm:run-1', state: 'all' } });
    const ordered = [...plan.tasks.filter(task => task.kind === 'epic'), ...plan.tasks.filter(task => task.kind === 'task')];
    const creates = calls.filter(call => call.path === base && call.method === 'POST');
    expect(creates).toHaveLength(plan.tasks.length);
    expect(calls.slice(1, 1 + plan.tasks.length)).toEqual(creates);
    ordered.forEach((task, index) => {
      expect(result[task.id]).toBe(index + 1);
      const params = creates[index].params;
      expect(params.title).toBe(task.title);
      expect(params.labels).toEqual(['swarm', 'swarm:run-1', `type:${task.kind}`]);
      expect(params.body).toContain(marker(plan.runId, task.id));
      expect(params.body).toContain(`Research notes: /research/run-1/${task.id}/sources.md`);
      expect(params.body).toContain(['```sh', ...task.verify, '```'].join('\n'));
      task.acceptance.forEach(criterion => expect(params.body).toContain(`- [ ] ${criterion}`));
      task.owns.forEach(path => expect(params.body).toContain(`- \`${path}\``));
    });
    const subIssues = calls.filter(call => call.path.endsWith('/sub_issues'));
    const dependencies = calls.filter(call => call.path.endsWith('/blocked_by'));
    expect(subIssues).toHaveLength(plan.tasks.filter(task => task.parent).length);
    for (const task of plan.tasks) {
      if (task.parent) expect(subIssues).toContainEqual(expect.objectContaining({
        path: `${base}/${result[task.parent]}/sub_issues`,
        params: expect.objectContaining({ sub_issue_id: 1000 + result[task.id] }),
      }));
      for (const dependency of task.dependsOn) expect(dependencies).toContainEqual(expect.objectContaining({
        path: `${base}/${result[task.id]}/dependencies/blocked_by`,
        params: expect.objectContaining({ issue_id: 1000 + result[dependency] }),
      }));
    }
    expect(dependencies).toHaveLength(plan.tasks.reduce((count, task) => count + task.dependsOn.length, 0));
    expect(calls.indexOf(dependencies[0])).toBeGreaterThan(calls.indexOf(subIssues.at(-1)!));
  });

  it('reuses dry-run issues and links on a second publish', async () => {
    const plan = await fixture();
    const { client, calls } = dryClient();
    const first = await publishPlan(client, plan);
    calls.length = 0;
    expect(await publishPlan(client, structuredClone(plan))).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('adds project items using node ids and assigns ready or backlog after all links', async () => {
    const plan = await fixture();
    const { client, calls } = dryClient();
    const numbers = await publishPlan(client, plan, { project });
    const graphql = calls.filter(call => call.path === '/graphql');
    expect(graphql).toHaveLength(plan.tasks.length * 2);
    expect(calls.slice(-graphql.length)).toEqual(graphql);
    for (const task of plan.tasks) {
      const nodeId = `I_${numbers[task.id]}`;
      const index = graphql.findIndex(call => call.params.input.contentId === nodeId);
      expect(graphql[index].params.query).toContain('addProjectV2ItemById');
      expect(graphql[index].params.input).toEqual({ projectId: 'project', contentId: nodeId });
      expect(graphql[index + 1].params.query).toContain('updateProjectV2ItemFieldValue');
      expect(graphql[index + 1].params.input).toEqual({ projectId: 'project',
        itemId: `dry-item:project:${nodeId}`, fieldId: 'status',
        value: { singleSelectOptionId: task.dependsOn.length ? 'b' : 'r' } });
    }
  });

  it('reuses closed marked issues, ignores pull requests and other runs, and repairs missing links', async () => {
    const plan = await fixture();
    const identities = plan.tasks.map((task, index) => ({ number: 40 + index, id: 900 + index,
      node_id: `NODE_${index}`, body: marker(plan.runId, task.id), state: 'closed' }));
    let dependenciesComplete = false;
    const request = vi.fn(async (route: string, params?: any): Promise<any> => {
      if (route === `GET ${base}`) return [
        { ...identities[0], number: 200, pull_request: {} },
        { ...identities[0], number: 201, body: marker('another-run', plan.tasks[0].id) },
        ...identities,
      ];
      if (route.startsWith('GET ')) {
        // Existing sub-issue links are retained; missing dependencies are repaired.
        if (route.endsWith('/sub_issues') || dependenciesComplete) return identities;
        return [];
      }
      if (route === `POST ${base}`) throw new Error('Must reuse existing issues');
      return params;
    });
    const graphql = vi.fn(async (query: string) => query.includes('addProjectV2ItemById')
      ? { addProjectV2ItemById: { item: { id: 'returned-item' } } } : {});
    const client: GitHubClient = { owner: 'test', repo: 'demo', dryRun: false, request, graphql };
    expect(await publishPlan(client, plan, { project })).toEqual(Object.fromEntries(
      plan.tasks.map((task, index) => [task.id, identities[index].number]),
    ));
    expect(request.mock.calls.filter(([route]) => route.startsWith('POST ') && route.endsWith('/sub_issues'))).toHaveLength(0);
    const posts = request.mock.calls.filter(([route]) => route.startsWith('POST '));
    expect(posts).toHaveLength(plan.tasks.reduce((count, task) => count + task.dependsOn.length, 0));
    for (const [, params] of posts) expect(identities.map(issue => issue.id)).toContain(params.issue_id);
    expect(graphql.mock.calls[1]).toEqual([expect.stringContaining('updateProjectV2ItemFieldValue'),
      expect.objectContaining({ input: expect.objectContaining({ itemId: 'returned-item' }) })]);
    dependenciesComplete = true;
    request.mockClear();
    await publishPlan(client, plan);
    expect(request.mock.calls.every(([route]) => route.startsWith('GET '))).toBe(true);
  });

  it('paginates existing run issues before creating any new ones', async () => {
    const plan = await fixture();
    plan.tasks = [plan.tasks[0]];
    plan.tasks[0].parent = undefined;
    plan.tasks[0].dependsOn = [];
    const request = vi.fn(async (_route: string, params?: any) => params.page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ number: index, id: index, node_id: `N_${index}`, body: '' }))
      : [{ number: 123, id: 999, node_id: 'found', body: marker(plan.runId, plan.tasks[0].id) }]);
    const client: GitHubClient = { owner: 'test', repo: 'demo', dryRun: false, request, graphql: vi.fn() };
    expect(await publishPlan(client, plan)).toEqual({ [plan.tasks[0].id]: 123 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toMatchObject({ page: 2, per_page: 100 });
  });
});
