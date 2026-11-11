import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureResearch } from '../../src/contracts/fakes.js';
import { createKeenableResearch } from '../../src/research/keenable.js';

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/keenable-search.json', import.meta.url), 'utf8'));
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
const query = fixture.search.query as string;

afterEach(() => vi.useRealTimers());

describe('Keenable research', () => {
  it('uses keyed endpoints and maps the recorded fixture to the Research port', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture.search)).mockResolvedValueOnce(json(fixture.fetch));
    const research = createKeenableResearch({ apiKey: 'test-key', appTitle: 'Swarm', baseUrl: 'https://example.test/', fetchImpl: transport });
    const expected = new FixtureResearch();
    expect(await research.search(query, { maxResults: 3, site: 'hono.dev' })).toEqual(await expected.search(query));
    expect(transport.mock.calls[0]).toEqual(['https://example.test/v1/search', {
      method: 'POST', headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode: 'realtime', max_results: 3, site: 'hono.dev' }),
    }]);
    const url = 'https://hono.dev/docs/api/routing?a=1&b=two words';
    expect(await research.fetch(url)).toBe(await expected.fetch(url));
    expect(transport.mock.calls[1]).toEqual([`https://example.test/v1/fetch?url=${encodeURIComponent(url)}`, {
      method: 'GET', headers: { 'X-API-Key': 'test-key' },
    }]);
  });

  it('uses public endpoints with the required title and default base', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture.search)).mockResolvedValueOnce(json(fixture.fetch));
    const research = createKeenableResearch({ appTitle: 'Swarm', fetchImpl: transport });
    await research.search(query);
    await research.fetch(fixture.fetch.url);
    expect(transport.mock.calls[0][0]).toBe('https://api.keenable.ai/v1/search/public');
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string).max_results).toBe(10);
    expect(transport.mock.calls[1][0]).toBe(`https://api.keenable.ai/v1/fetch/public?url=${encodeURIComponent(fixture.fetch.url)}`);
    for (const [, init] of transport.mock.calls) {
      expect(new Headers(init?.headers).get('X-Keenable-Title')).toBe('Swarm');
      expect(new Headers(init?.headers).has('X-API-Key')).toBe(false);
    }
  });

  it.each(['search', 'fetch'] as const)('falls back on exhausted credits from %s and logs once', async (method) => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'insufficient_credits' } }, 402))
      .mockResolvedValueOnce(json(method === 'search' ? fixture.search : fixture.fetch))
      .mockResolvedValueOnce(json(fixture.search));
    const log = vi.fn();
    const research = createKeenableResearch({ apiKey: 'test-key', appTitle: 'Swarm', fetchImpl: transport, log });
    await research[method]('input');
    await research.search(query);
    expect(transport.mock.calls[0][0]).toContain(`/v1/${method}`);
    expect(transport.mock.calls[1][0]).toContain(`/v1/${method}/public`);
    expect(transport.mock.calls[2][0]).toContain('/v1/search/public');
    expect(new Headers(transport.mock.calls[1][1]?.headers).get('X-Keenable-Title')).toBe('Swarm');
    expect(new Headers(transport.mock.calls[1][1]?.headers).has('X-API-Key')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).not.toContain('test-key');
  });

  it('waits Retry-After seconds, caps delays at ten seconds, and retries twice', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '60' }))
      .mockResolvedValueOnce(json(fixture.search));
    const research = createKeenableResearch({ appTitle: 'Swarm', fetchImpl: transport });
    const result = research.search(query);
    await vi.advanceTimersByTimeAsync(1999);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toHaveLength(3);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('stops after two retries for page fetches', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 429, { 'Retry-After': '1' }));
    const result = createKeenableResearch({ appTitle: 'Swarm', fetchImpl: transport }).fetch('https://example.test');
    await vi.runAllTimersAsync();
    expect(await result).toBe('');
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([0, 80, 2.8, Number.NaN])('bounds maxResults %s to the API range', async (maxResults) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json(fixture.search));
    await createKeenableResearch({ appTitle: 'Swarm', fetchImpl: transport }).search(query, { maxResults });
    const expected = Number.isNaN(maxResults) ? 10 : Math.min(50, Math.max(1, Math.floor(maxResults)));
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string).max_results).toBe(expected);
  });

  it.each([400, 401, 402, 500])('returns empty results for HTTP %s', async (status) => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => json({ error: 'other_error' }, status));
    const research = createKeenableResearch({ apiKey: 'test-key', appTitle: 'Swarm', fetchImpl: transport });
    expect(await research.search(query)).toEqual([]);
    expect(await research.fetch('https://example.test')).toBe('');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('handles network errors, invalid JSON, and malformed response shapes', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('not JSON')).mockResolvedValueOnce(new Response('not JSON'))
      .mockResolvedValueOnce(json({ results: [{ title: 'missing url' }, null] })).mockResolvedValueOnce(json({ content: 3 }));
    const research = createKeenableResearch({ appTitle: 'Swarm', fetchImpl: transport });
    for (let i = 0; i < 3; i++) {
      expect(await research.search(query)).toEqual([]);
      expect(await research.fetch('https://example.test')).toBe('');
    }
  });
});
