import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/contracts/fakes.js';
import { createGitHubClient } from '../../src/github/client.js';
import { comment, mergePullRequest, openPullRequest, setStatus, type FlowProject } from '../../src/github/flow.js';

async function setup() {
  const store = new MemoryStore();
  await store.setIssueNumber('run', 'T1', 42);
  const issueOf = vi.fn(async (runId: string, taskId: string) => {
    const issue = (await store.getIssueNumbers(runId))[taskId];
    if (!issue) throw new Error('Unknown task');
    return issue;
  });
  const onCall = vi.fn();
  const client = createGitHubClient({ owner: 'test', repo: 'demo', dryRun: true, minIntervalMs: 0, onCall });
  return { client, issueOf, onCall };
}

const input = { runId: 'run', taskId: 'T1', branch: 'swarm/run/T1/a1', title: 'Implement T1', body: 'Verified.' };
const project: FlowProject = { projectId: 'P1', statusFieldId: 'F1', statusOptionIds: {
  backlog: 'B', ready: 'R', running: 'W', review: 'V', done: 'D', blocked: 'X',
} };

describe('GitHub flow', () => {
  it('creates a linked PR, squash merges it, and comments using offline identities', async () => {
    const { client, issueOf, onCall } = await setup();
    const pr = await openPullRequest(client, issueOf)(input);
    expect(pr).toEqual({ number: 101, url: 'https://github.com/test/demo/pull/101' });
    expect(onCall.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/repos/{owner}/{repo}/pulls',
      params: { state: 'open', head: 'test:swarm/run/T1/a1' } });
    expect(onCall.mock.calls[1][0]).toMatchObject({ method: 'POST', params: {
      head: input.branch, base: 'main', title: input.title,
      body: 'Verified.\n\nCloses #42\n<!-- swarm:run:T1 -->',
    } });
    expect(await mergePullRequest(client, issueOf)(pr.number)).toEqual({ mergeCommit: 'dry1' });
    expect(onCall.mock.calls[2][0]).toMatchObject({ method: 'PUT',
      path: '/repos/{owner}/{repo}/pulls/{pull_number}/merge', params: { pull_number: 101, merge_method: 'squash' } });
    await comment(client, issueOf)('run', 'T1', 'All checks passed');
    expect(onCall.mock.calls[3][0]).toMatchObject({ method: 'POST',
      path: '/repos/{owner}/{repo}/issues/{issue_number}/comments', params: { issue_number: 42, body: 'All checks passed' } });
  });

  it('reuses dry-run PR identities by branch in the bound publisher', async () => {
    const { client, issueOf, onCall } = await setup();
    const open = openPullRequest(client, issueOf);
    const first = await open(input);
    expect(await open({ ...input, title: 'Updated title' })).toEqual(first);
    const second = await open({ ...input, branch: 'swarm/run/T1/a2' });
    expect(first).toEqual({ number: 101, url: 'https://github.com/test/demo/pull/101' });
    expect(second).toEqual({ number: 102, url: 'https://github.com/test/demo/pull/102' });
    expect(await open(input)).toEqual(first);
    expect(await open({ ...input, branch: 'swarm/run/T1/a2' })).toEqual(second);
    expect(onCall.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(2);
    expect(issueOf).toHaveBeenCalledTimes(2);

    const other = await setup();
    expect(await openPullRequest(other.client, other.issueOf)(input)).toEqual(first);
    expect(other.onCall.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
  });

  it('looks up existing live PRs on every call without looking up the issue or posting', async () => {
    const { client, issueOf } = await setup();
    client.dryRun = false;
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce([{ number: 77, html_url: 'https://example.test/77' }])
      .mockResolvedValueOnce([{ number: 78, html_url: 'https://example.test/78' }]);
    const open = openPullRequest(client, issueOf);
    expect(await open(input)).toEqual({ number: 77, url: 'https://example.test/77' });
    expect(await open(input)).toEqual({ number: 78, url: 'https://example.test/78' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('GET /repos/{owner}/{repo}/pulls', {
      state: 'open', head: `test:${input.branch}`, per_page: 100,
    });
    expect(issueOf).not.toHaveBeenCalled();
  });

  it('preserves unrelated labels and removes every old status label', async () => {
    const { client, issueOf, onCall } = await setup();
    const original = client.request.bind(client);
    vi.spyOn(client, 'request').mockImplementation(async (route, params) => route.startsWith('GET')
      ? { labels: [{ name: 'swarm' }, 'status:ready', { name: 'status:blocked' }, { name: 'type:task' }] }
      : original(route, params));
    await setStatus(client, issueOf)('run', 'T1', 'running');
    expect(onCall.mock.calls[0][0]).toMatchObject({ method: 'PUT', params: {
      issue_number: 42, labels: ['swarm', 'type:task', 'status:running'],
    } });
  });

  it('caches Project item ids across status updates', async () => {
    const { client, issueOf } = await setup();
    vi.spyOn(client, 'request').mockResolvedValue({ labels: [], node_id: 'I42' });
    const graphql = vi.spyOn(client, 'graphql').mockResolvedValue({ addProjectV2ItemById: { item: { id: 'ITEM42' } } });
    const status = setStatus(client, issueOf, project);
    await status('run', 'T1', 'running');
    await status('run', 'T1', 'done');
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[0][1]).toEqual({ projectId: 'P1', contentId: 'I42' });
    expect(graphql.mock.calls[1][1]).toEqual({ projectId: 'P1', itemId: 'ITEM42', fieldId: 'F1', optionId: 'W' });
    expect(graphql.mock.calls[2][1]).toEqual({ projectId: 'P1', itemId: 'ITEM42', fieldId: 'F1', optionId: 'D' });
  });

  it('supports Project updates with the unmodified dry-run client', async () => {
    const { client, issueOf, onCall } = await setup();
    await setStatus(client, issueOf, project)('run', 'T1', 'review');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ path: '/graphql',
      params: { itemId: 'dry-project-item-42', optionId: 'V' } });
  });

  it('does not report a refused merge as successful', async () => {
    const { client, issueOf } = await setup();
    vi.spyOn(client, 'request').mockResolvedValue({ merged: false, sha: null });
    await expect(mergePullRequest(client, issueOf)(12)).rejects.toThrow('was not merged');
  });
});
