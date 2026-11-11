import { createHash } from 'node:crypto';
import type { Research, SharedDisk, Source } from '../contracts/types.js';

function isSources(value: unknown): value is Source[] {
  return Array.isArray(value) && value.every(source =>
    source !== null && typeof source === 'object' &&
    typeof source.title === 'string' && typeof source.url === 'string' &&
    (source.snippet === undefined || typeof source.snippet === 'string'));
}

/** A best-effort persistent cache; concurrent requests share work within this wrapper. */
export function createCachedResearch(
  research: Research,
  disk: SharedDisk,
  opts: { prefix?: string } = {},
): Research {
  const prefix = (opts.prefix ?? '/research/cache').replace(/\/+$/, '');
  const pending = new Map<string, Promise<unknown>>();

  function cached<T>(
    args: unknown[],
    valid: (value: unknown) => value is T,
    request: () => Promise<T>,
  ): Promise<T> {
    const key = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;

    const result = (async () => {
      const path = `${prefix}/${key}.json`;
      try {
        const raw = await disk.read(path);
        if (raw !== undefined) {
          const value: unknown = JSON.parse(raw);
          if (valid(value)) return value;
        }
      } catch {
        // Missing, corrupt, or unavailable cache entries are ordinary misses.
      }

      const value = await request();
      try {
        await disk.write(path, JSON.stringify(value));
      } catch {
        // Persistence must never prevent returning a successful request.
      }
      return value;
    })().finally(() => { pending.delete(key); });
    pending.set(key, result);
    return result;
  }

  return {
    search: (query, options) => cached(
      ['search', query, options?.maxResults ?? null, options?.site ?? null],
      isSources,
      () => research.search(query, options),
    ),
    fetch: url => cached(
      ['fetch', url],
      (value): value is string => typeof value === 'string',
      () => research.fetch(url),
    ),
  };
}
