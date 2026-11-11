import { describe, expect, it, vi } from 'vitest';
import { MemoryDisk } from '../../src/contracts/fakes.js';
import type { Research, Source } from '../../src/contracts/types.js';
import { createCachedResearch } from '../../src/research/cache.js';

const sources: Source[] = [{ title: 'Example', url: 'https://example.test', snippet: 'A page' }];
function stub() {
  return {
    search: vi.fn<Research['search']>().mockResolvedValue(sources),
    fetch: vi.fn<Research['fetch']>().mockResolvedValue('# Example'),
  };
}

describe('cached research', () => {
  it('persists JSON and reuses both operations across wrapper instances', async () => {
    const disk = new MemoryDisk();
    const first = createCachedResearch(stub(), disk);
    expect(await first.search('topic')).toEqual(sources);
    expect(await first.fetch('https://example.test')).toBe('# Example');
    const underlying = stub();
    const second = createCachedResearch(underlying, disk);
    expect(await second.search('topic')).toEqual(sources);
    expect(await second.fetch('https://example.test')).toBe('# Example');
    expect(underlying.search).not.toHaveBeenCalled();
    expect(underlying.fetch).not.toHaveBeenCalled();
    expect(await disk.list('/research/cache/')).toHaveLength(2);
    for (const [path, raw] of disk.files) {
      expect(path).toMatch(/^\/research\/cache\/[a-f0-9]{64}\.json$/);
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('keys all inputs and operations separately, regardless of option property order', async () => {
    const disk = new MemoryDisk();
    const underlying = stub();
    const cached = createCachedResearch(underlying, disk);
    await cached.search('topic', { maxResults: 2, site: 'a.test' });
    await cached.search('topic', { site: 'a.test', maxResults: 2 });
    await cached.search('other', { maxResults: 2, site: 'a.test' });
    await cached.search('topic', { maxResults: 3, site: 'a.test' });
    await cached.search('topic', { maxResults: 2, site: 'b.test' });
    await cached.search('topic');
    await cached.search('topic', {});
    await cached.fetch('topic');
    await cached.fetch('other');
    expect(underlying.search).toHaveBeenCalledTimes(5);
    expect(underlying.fetch).toHaveBeenCalledTimes(2);
    expect(await disk.list('/research/cache/')).toHaveLength(7);
  });

  it('persists empty arrays and strings as cache hits', async () => {
    const disk = new MemoryDisk();
    const underlying = stub();
    underlying.search.mockResolvedValue([]);
    underlying.fetch.mockResolvedValue('');
    await createCachedResearch(underlying, disk).search('empty');
    await createCachedResearch(underlying, disk).fetch('empty');
    const cached = createCachedResearch(stub(), disk);
    expect(await cached.search('empty')).toEqual([]);
    expect(await cached.fetch('empty')).toBe('');
  });

  it.each(['broken JSON', 'null', '{}', '[{"title":"missing url"}]', '42']) (
    'replaces corrupt or invalid entries: %s', async raw => {
      const disk = new MemoryDisk();
      const underlying = stub();
      const cached = createCachedResearch(underlying, disk);
      await cached.search('topic');
      await cached.fetch('page');
      for (const path of disk.files.keys()) await disk.write(path, raw);
      expect(await cached.search('topic')).toEqual(sources);
      expect(await cached.fetch('page')).toBe('# Example');
      expect(underlying.search).toHaveBeenCalledTimes(2);
      expect(underlying.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['read', 'write'] as const)('tolerates disk %s failures', async method => {
    const disk = new MemoryDisk();
    vi.spyOn(disk, method).mockRejectedValue(new Error('disk unavailable'));
    const underlying = stub();
    const cached = createCachedResearch(underlying, disk);
    expect(await cached.search('topic')).toEqual(sources);
    expect(await cached.fetch('page')).toBe('# Example');
    expect(underlying.search).toHaveBeenCalledWith('topic', undefined);
    expect(underlying.fetch).toHaveBeenCalledWith('page');
  });

  it('isolates custom prefixes and normalizes trailing slashes', async () => {
    const disk = new MemoryDisk();
    await createCachedResearch(stub(), disk, { prefix: '/custom///' }).search('topic');
    const underlying = stub();
    await createCachedResearch(underlying, disk, { prefix: '/custom' }).search('topic');
    expect(underlying.search).not.toHaveBeenCalled();
    await createCachedResearch(underlying, disk).search('topic');
    expect(underlying.search).toHaveBeenCalledTimes(1);
    expect(await disk.list('/custom/')).toHaveLength(1);
  });

  it.each(['search', 'fetch'] as const)('deduplicates concurrent %s calls', async method => {
    const disk = new MemoryDisk();
    const underlying = stub();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    underlying.search.mockImplementation(async () => { await gate; return sources; });
    underlying.fetch.mockImplementation(async () => { await gate; return '# Example'; });
    const cached = createCachedResearch(underlying, disk);
    const calls = Array.from({ length: 10 }, () => cached[method]('same'));
    await vi.waitFor(() => expect(underlying[method]).toHaveBeenCalledTimes(1));
    release();
    const expected = method === 'search' ? sources : '# Example';
    expect(await Promise.all(calls)).toEqual(Array(10).fill(expected));
    expect(await cached[method]('same')).toEqual(expected);
    expect(underlying[method]).toHaveBeenCalledTimes(1);
  });

  it.each(['search', 'fetch'] as const)('does not cache rejected %s calls and retries afterward', async method => {
    const disk = new MemoryDisk();
    const underlying = stub();
    const error = new Error('upstream unavailable');
    underlying[method].mockRejectedValueOnce(error);
    const cached = createCachedResearch(underlying, disk);
    const results = await Promise.allSettled([cached[method]('same'), cached[method]('same')]);
    expect(results).toEqual(Array(2).fill({ status: 'rejected', reason: error }));
    expect(underlying[method]).toHaveBeenCalledTimes(1);
    expect(disk.files.size).toBe(0);
    expect(await cached[method]('same')).toEqual(method === 'search' ? sources : '# Example');
    expect(underlying[method]).toHaveBeenCalledTimes(2);
    expect(disk.files.size).toBe(1);
  });
});
