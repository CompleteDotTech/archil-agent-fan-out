import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import { createGitHubClient } from '../../src/github/client.js';
import { marker, parseMarker } from '../../src/github/markers.js';

const options = { owner: 'test', repo: 'demo', dryRun: false };
const rateLimit = (status = 403, headers: Record<string, string> = {}) =>
  Object.assign(new Error('You have exceeded a secondary rate limit'), { status, response: { headers } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('GitHub client', () => {
  it('paces REST and GraphQL in one FIFO queue and unwraps REST data', async () => {
    const starts: number[] = [];
    const request = vi.fn(async () => { starts.push(Date.now()); return { data: { number: 7 } }; });
    const graphql = vi.fn(async () => { starts.push(Date.now()); return { node: 'result' }; });
    const client = createGitHubClient({ ...options, octokit: { request, graphql } });
    const first = client.request('GET /repos/{owner}/{repo}/issues');
    const second = client.graphql('query { viewer { login } }');
    const third = client.request('GET /last');
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 1000]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual([0, 1000, 2000]);
    expect(await Promise.all([first, second, third])).toEqual([{ number: 7 }, { node: 'result' }, { number: 7 }]);
    expect(request.mock.calls[0]).toEqual(['GET /repos/{owner}/{repo}/issues', { owner: 'test', repo: 'demo' }]);
  });

  it('does not overlap calls even when a response takes longer than the interval', async () => {
    let release!: (value: { data: object }) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ data: {} });
    const client = createGitHubClient({ ...options, octokit: { request, graphql: vi.fn() } });
    const first = client.request('GET /slow');
    const second = client.request('GET /next');
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(1);
    release({ data: {} });
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After and keeps later calls behind the retry', async () => {
    const request = vi.fn().mockRejectedValueOnce(rateLimit(403, { 'Retry-After': '2' }))
      .mockResolvedValue({ data: {} });
    const client = createGitHubClient({ ...options, octokit: { request, graphql: vi.fn() } });
    const first = client.request('POST /first');
    const second = client.request('GET /second');
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe('POST /first');
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(request.mock.calls[2][0]).toBe('GET /second');
  });

  it('defaults to 60 seconds, retries only three times, and recovers the queue', async () => {
    const failure = rateLimit(429);
    const graphql = vi.fn().mockRejectedValue(failure);
    const request = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createGitHubClient({ ...options, octokit: { request, graphql } });
    const rejected = expect(client.graphql('mutation { example }')).rejects.toBe(failure);
    const next = client.request('GET /next');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(graphql).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    expect(graphql).toHaveBeenCalledTimes(4);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await next).toEqual({ ok: true });
  });

  it('does not retry ordinary authorization or server errors', async () => {
    for (const status of [403, 500]) {
      const failure = Object.assign(new Error('Permission denied'), { status });
      const request = vi.fn().mockRejectedValue(failure);
      const client = createGitHubClient({ ...options, octokit: { request, graphql: vi.fn() } });
      await expect(client.request('GET /private')).rejects.toBe(failure);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('returns deterministic offline identities and records every call', async () => {
    const plan = await new FixturePlanner().plan({ runId: 'offline', brief: 'test', targetRepo: 'test/demo' });
    const onCall = vi.fn();
    const octokit = { request: vi.fn(), graphql: vi.fn() };
    const client = createGitHubClient({ ...options, dryRun: true, minIntervalMs: 0, onCall, octokit });
    expect([client.owner, client.repo, client.dryRun]).toEqual(['test', 'demo', true]);
    for (const [index, task] of plan.tasks.entries()) {
      const number = index + 1;
      expect(await client.request('POST /repos/{owner}/{repo}/issues', { body: marker(plan.runId, task.id) }))
        .toEqual({ number, id: 1000 + number, node_id: `I_${number}`, html_url: `https://github.com/test/demo/issues/${number}` });
    }
    expect(await client.request('POST /repos/{owner}/{repo}/pulls')).toEqual({ number: 101, html_url: 'https://github.com/test/demo/pull/101' });
    expect(await client.request('PUT /repos/{owner}/{repo}/pulls/101/merge')).toEqual({ sha: 'dry1' });
    expect(await client.request('GET /repos/{owner}/{repo}/issues')).toEqual({});
    expect(await client.graphql('query { viewer { login } }')).toEqual({});
    expect(onCall).toHaveBeenCalledTimes(plan.tasks.length + 4);
    expect(onCall.mock.calls[0][0]).toEqual({ method: 'POST', path: '/repos/{owner}/{repo}/issues',
      params: { owner: 'test', repo: 'demo', body: marker(plan.runId, plan.tasks[0].id) } });
    expect(octokit.request).not.toHaveBeenCalled();
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});

it('finds markers embedded in issue bodies and rejects missing or malformed markers', () => {
  expect(marker('run-1', 'T1')).toBe('<!-- swarm:run-1:T1 -->');
  expect(parseMarker(`Description\n${marker('run-1', 'T1')}\nMore text`)).toEqual({ runId: 'run-1', taskId: 'T1' });
  for (const body of [undefined, null, '', '<!-- swarm:run: -->', '<!-- swarm:run:task:extra -->']) {
    expect(parseMarker(body)).toBeUndefined();
  }
});
