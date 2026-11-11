import { Octokit } from '@octokit/rest';

export interface GitHubClientOptions {
  token?: string;
  owner: string;
  repo: string;
  dryRun: boolean;
  minIntervalMs?: number;
  onCall?: (call: { method: string; path: string; params: unknown }) => void;
  octokit?: { request: Function; graphql: Function };
}

export interface GitHubClient {
  owner: string;
  repo: string;
  dryRun: boolean;
  /** Returns the REST response body, without Octokit's transport envelope. */
  request(route: string, params?: object): Promise<any>;
  graphql(query: string, vars?: object): Promise<any>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(error: unknown): number | undefined {
  const failure = error as {
    status?: number;
    message?: string;
    response?: { status?: number; headers?: Record<string, unknown>; data?: { message?: string } };
  } | null;
  const status = failure?.status ?? failure?.response?.status;
  if (status !== 403 && status !== 429) return undefined;
  const headers = failure?.response?.headers ?? {};
  const retryAfter = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  const message = `${failure?.message ?? ''} ${failure?.response?.data?.message ?? ''}`;
  if (status !== 429 && retryAfter === undefined && !/secondary rate|abuse/i.test(message)) return undefined;
  const seconds = Number(retryAfter);
  return retryAfter !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000;
}

export function createGitHubClient(opts: GitHubClientOptions): GitHubClient {
  const interval = opts.minIntervalMs ?? 1000;
  if (!Number.isFinite(interval) || interval < 0) throw new Error('minIntervalMs must be a non-negative finite number');
  const octokit = opts.dryRun ? undefined : (opts.octokit ?? new Octokit({ auth: opts.token }));
  let tail: Promise<void> = Promise.resolve();
  let lastStarted: number | undefined;
  let issueNumber = 0;
  let pullNumber = 0;
  let mergeNumber = 0;

  function enqueue<T>(method: string, path: string, params: object, call: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      for (let retries = 0; ; retries++) {
        const delay = lastStarted === undefined ? 0 : interval - (Date.now() - lastStarted);
        if (delay > 0) await sleep(delay);
        lastStarted = Date.now();
        opts.onCall?.({ method, path, params });
        try {
          return await call();
        } catch (error) {
          const backoff = retryDelay(error);
          if (backoff === undefined || retries >= 3) throw error;
          await sleep(backoff);
        }
      }
    });
    // A failed request must not poison later queue entries.
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function synthetic(method: string, path: string): object {
    const endpoint = path.split('?')[0].replace(/\/$/, '');
    const base = `https://github.com/${opts.owner}/${opts.repo}`;
    if (method === 'POST' && endpoint.endsWith('/issues')) {
      const n = ++issueNumber;
      return { number: n, id: 1000 + n, node_id: `I_${n}`, html_url: `${base}/issues/${n}` };
    }
    if (method === 'POST' && endpoint.endsWith('/pulls')) {
      const n = 100 + ++pullNumber;
      return { number: n, html_url: `${base}/pull/${n}` };
    }
    if (method === 'PUT' && endpoint.endsWith('/merge')) return { sha: `dry${++mergeNumber}` };
    return {};
  }

  return {
    owner: opts.owner,
    repo: opts.repo,
    dryRun: opts.dryRun,
    request(route, params = {}) {
      const match = /^(\S+)\s+(.+)$/.exec(route);
      const method = match ? match[1].toUpperCase() : 'GET';
      const path = match ? match[2] : route;
      const parameters = { owner: opts.owner, repo: opts.repo, ...params };
      return enqueue(method, path, parameters, async () => {
        if (opts.dryRun) return synthetic(method, path);
        const response = await octokit!.request(route, parameters);
        return response.data;
      });
    },
    graphql(query, vars = {}) {
      return enqueue('POST', '/graphql', { query, ...vars }, async () => {
        if (opts.dryRun) return {};
        return octokit!.graphql(query, vars);
      });
    },
  };
}
