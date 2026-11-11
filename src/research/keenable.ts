import type { Research, Source } from '../contracts/types.js';

export interface KeenableResearchOptions {
  apiKey?: string;
  appTitle: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function insufficientCredits(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('insufficient_credits');
  if (!isRecord(value)) return false;
  return ['error', 'code', 'type', 'message', 'detail'].some((key) => insufficientCredits(value[key]));
}

function maxResults(value = 10): number {
  return Number.isFinite(value) ? Math.min(50, Math.max(1, Math.floor(value))) : 10;
}

/** HTTP adapter; configuration and transport are injected, and failures are best-effort. */
export function createKeenableResearch(opts: KeenableResearchOptions): Research {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = (opts.baseUrl ?? 'https://api.keenable.ai').replace(/\/+$/, '');
  let useKey = Boolean(opts.apiKey);

  async function request(path: string, body?: unknown, url?: string): Promise<unknown> {
    let retries = 0;
    try {
      for (;;) {
        const keyed = useKey;
        const headers: Record<string, string> = keyed
          ? { 'X-API-Key': opts.apiKey! }
          : { 'X-Keenable-Title': opts.appTitle };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const endpoint = `${base}/v1/${path}${keyed ? '' : '/public'}${url === undefined ? '' : `?url=${encodeURIComponent(url)}`}`;
        const response = await fetchImpl(endpoint, {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 429 && retries < 2) {
          retries++;
          const seconds = Number(response.headers.get('Retry-After') ?? '1');
          const delay = Number.isFinite(seconds) ? Math.min(10, Math.max(0, seconds)) : 1;
          await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
          continue;
        }
        if (response.status === 402 && keyed) {
          const error: unknown = await response.json();
          if (insufficientCredits(error)) {
            // Flip before logging: concurrent requests log exhaustion only once.
            if (useKey) {
              useKey = false;
              try {
                opts.log?.('Keenable credits exhausted; using public endpoints.');
              } catch { /* Logging must not interrupt research. */ }
            }
            continue;
          }
        }
        if (!response.ok) return undefined;
        return await response.json();
      }
    } catch {
      return undefined;
    }
  }

  return {
    async search(query, searchOpts) {
      const result = await request('search', {
        query,
        mode: 'realtime',
        max_results: maxResults(searchOpts?.maxResults),
        ...(searchOpts?.site === undefined ? {} : { site: searchOpts.site }),
      });
      if (!isRecord(result) || !Array.isArray(result.results)) return [];
      return result.results.flatMap((item: unknown): Source[] => {
        if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') return [];
        return [{ title: item.title, url: item.url, ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}) }];
      });
    },
    async fetch(url) {
      const result = await request('fetch', undefined, url);
      return isRecord(result) && typeof result.content === 'string' ? result.content : '';
    },
  };
}
