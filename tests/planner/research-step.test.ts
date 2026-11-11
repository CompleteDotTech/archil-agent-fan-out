import { describe, expect, it, vi } from 'vitest';
import { FixtureResearch, MemoryDisk } from '../../src/contracts/fakes.js';
import type { Plan, Source, TaskSpec } from '../../src/contracts/types.js';
import { runResearch } from '../../src/planner/research-step.js';

const sources: Source[] = [
  { title: 'First source', url: 'https://example.test/first', snippet: 'First snippet' },
  { title: 'Second source', url: 'https://example.test/second' },
  { title: 'Third source', url: 'https://example.test/third', snippet: 'Third snippet' },
  { title: 'Fourth source', url: 'https://example.test/fourth' },
];

function task(id: string, research?: string[]): TaskSpec {
  return { id, title: id, kind: 'task', dependsOn: [], owns: [], acceptance: [], verify: [], research };
}

function plan(...tasks: TaskSpec[]): Plan {
  return { runId: 'run-1', brief: 'Research test', targetRepo: 'local/demo', baseBranch: 'main', tasks };
}

function fixture(content = 'Fetched page text'): FixtureResearch {
  return new FixtureResearch({ search: { results: sources }, fetch: { content } });
}

describe('runResearch', () => {
  it('writes default top-three citations and fetches only the top result per query', async () => {
    const research = fixture();
    const search = vi.spyOn(research, 'search');
    const fetch = vi.spyOn(research, 'fetch');
    const disk = new MemoryDisk();

    const result = await runResearch({ plan: plan(task('T1', ['query'])), research, disk });

    expect(search).toHaveBeenCalledWith('query', { maxResults: 3 });
    expect(fetch.mock.calls).toEqual([[sources[0]!.url]]);
    expect(result).toEqual({ T1: sources.slice(0, 3) });
    expect(JSON.parse((await disk.read('/research/run-1/T1/sources.json'))!)).toEqual(result.T1);
    const markdown = (await disk.read('/research/run-1/T1/sources.md'))!;
    expect(markdown).toContain('1. First source\n   URL: https://example.test/first\n   First snippet');
    expect(markdown).toContain('2. Second source\n   URL: https://example.test/second');
    expect(markdown).toContain('3. Third source');
    expect(markdown).toContain('## Excerpt\n\n### [1] First source\n\nFetched page text');
    expect(markdown).not.toContain('undefined');
  });

  it('honors maxResults across queries and tasks, skipping tasks without queries', async () => {
    const research = fixture();
    const search = vi.spyOn(research, 'search');
    const disk = new MemoryDisk();
    const result = await runResearch({
      plan: plan(task('T1', ['one', 'two']), task('T2', ['three']), task('T3'), task('T4', [])),
      research, disk, maxResults: 1,
    });

    expect(search.mock.calls).toEqual(['one', 'two', 'three'].map(query => [query, { maxResults: 1 }]));
    expect(result).toEqual({ T1: [sources[0], sources[0]], T2: [sources[0]] });
    expect(await disk.list('/research/')).toHaveLength(4);
    expect(await disk.read('/research/run-1/T1/sources.md')).toContain('### [2] First source');
  });

  it('truncates each fetched page to 6000 characters', async () => {
    const disk = new MemoryDisk();
    await runResearch({ plan: plan(task('T1', ['query'])), research: fixture('x'.repeat(6000) + 'TRUNCATED'), disk });

    const markdown = (await disk.read('/research/run-1/T1/sources.md'))!;
    expect(markdown).toContain('x'.repeat(6000));
    expect(markdown).not.toContain('TRUNCATED');
  });

  it('continues after search and fetch failures, preserving successful citations', async () => {
    const research = fixture();
    vi.spyOn(research, 'search').mockRejectedValueOnce(new Error('search unavailable'));
    const fetch = vi.spyOn(research, 'fetch').mockRejectedValueOnce(new Error('fetch unavailable'));
    const disk = new MemoryDisk();

    const result = await runResearch({
      plan: plan(task('T1', ['bad search', 'bad fetch', 'good']), task('T2', ['another task'])),
      research, disk, maxResults: 1,
    });

    expect(result).toEqual({ T1: [sources[0], sources[0]], T2: [sources[0]] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await disk.read('/research/run-1/T1/sources.md')).toContain('### [2] First source');
    expect(await disk.read('/research/run-1/T2/sources.md')).toContain('Fetched page text');
  });

  it('writes empty artifacts when every query fails or returns no results', async () => {
    const research = fixture();
    vi.spyOn(research, 'search').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
    const fetch = vi.spyOn(research, 'fetch');
    const disk = new MemoryDisk();

    expect(await runResearch({ plan: plan(task('T1', ['bad']), task('T2', ['empty'])), research, disk }))
      .toEqual({ T1: [], T2: [] });
    expect(fetch).not.toHaveBeenCalled();
    for (const id of ['T1', 'T2']) {
      expect(await disk.read(`/research/run-1/${id}/sources.json`)).toBe('[]');
      expect(await disk.read(`/research/run-1/${id}/sources.md`)).toContain('## Excerpt');
    }
  });

  it('surfaces disk failures instead of reporting unsaved research as complete', async () => {
    const disk = new MemoryDisk();
    vi.spyOn(disk, 'write').mockRejectedValue(new Error('disk unavailable'));
    await expect(runResearch({ plan: plan(task('T1', ['query'])), research: fixture(), disk }))
      .rejects.toThrow('disk unavailable');
  });
});
