import type { TaskStatus } from '../contracts/types.js';
import type { GitHubClient } from './client.js';
import type { ProjectConfig } from './publish.js';

export interface BootstrapOptions {
  runId: string;
  projectNumber?: number;
  projectOwner?: string;
}

export interface BootstrapResult {
  project?: ProjectConfig;
  env: Record<string, string>;
  /** Shell-safe assignments, suitable for an environment file. */
  envLines: string[];
}

const statuses: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running',
  review: 'Review', done: 'Done', blocked: 'Blocked',
};
const dryLabels = new WeakMap<GitHubClient, Set<string>>();

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function ensureLabels(client: GitHubClient, runId: string): Promise<void> {
  const existing = new Set(client.dryRun ? dryLabels.get(client) : undefined);
  for (let page = 1; ; page++) {
    const response: unknown = await client.request('GET /repos/{owner}/{repo}/labels', {
      per_page: 100, page,
    });
    if (!Array.isArray(response) && !client.dryRun) {
      throw new Error('GitHub label listing returned an invalid response');
    }
    const labels = Array.isArray(response) ? response : [];
    for (const label of labels) {
      const name = record(label).name;
      if (nonempty(name)) existing.add(name.toLowerCase());
    }
    if (labels.length < 100) break;
  }
  if (client.dryRun) dryLabels.set(client, existing);
  const wanted = ['swarm', `swarm:${runId}`, 'type:epic', 'type:task',
    ...Object.keys(statuses).map(status => `status:${status}`)];
  for (const name of wanted) {
    if (existing.has(name.toLowerCase())) continue;
    await client.request('POST /repos/{owner}/{repo}/labels', { name, color: '5319e7' });
    existing.add(name.toLowerCase());
  }
}

type OwnerKind = 'organization' | 'user';

async function projectPage(
  client: GitHubClient, kind: OwnerKind, owner: string, number: number, after: string | null,
): Promise<Record<string, unknown>> {
  const response: unknown = await client.graphql(`
    query BootstrapProject($owner: String!, $number: Int!, $after: String) {
      ${kind}(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 100, after: $after) {
            nodes {
              __typename
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { owner, number, after });
  return record(record(record(response)[kind]).projectV2);
}

async function discoverProject(client: GitHubClient, owner: string, number: number): Promise<ProjectConfig> {
  let kind: OwnerKind = 'organization';
  let page: Record<string, unknown> = {};
  // A user login makes the organization lookup fail; do not surface raw API errors.
  try { page = await projectPage(client, kind, owner, number, null); } catch { /* Try user below. */ }
  if (!nonempty(page.id)) {
    kind = 'user';
    try { page = await projectPage(client, kind, owner, number, null); } catch { /* Report safely below. */ }
  }
  if (!nonempty(page.id)) {
    throw new Error('GitHub Project was not found or is inaccessible; check projectOwner, projectNumber, and Project read permissions (dry-run requires an injected Project response)');
  }
  const projectId = page.id;
  const cursors = new Set<string>();
  for (;;) {
    const fields = record(page.fields);
    if (!Array.isArray(fields.nodes)) throw new Error('GitHub Project returned no readable fields');
    const status = fields.nodes.map(record).find(field => field.name === 'Status');
    if (status) {
      if (!nonempty(status.id) || !Array.isArray(status.options)
        || (status.__typename !== undefined && status.__typename !== 'ProjectV2SingleSelectField')) {
        throw new Error('GitHub Project Status must be a single-select field with an ID and options');
      }
      const options = status.options.map(record);
      const statusOptionIds = {} as Record<TaskStatus, string>;
      const missing: string[] = [];
      for (const key of Object.keys(statuses) as TaskStatus[]) {
        const matches = options.filter(option => option.name === statuses[key] && nonempty(option.id));
        if (matches.length > 1) throw new Error(`GitHub Project Status has duplicate ${statuses[key]} options`);
        if (matches.length === 0) missing.push(statuses[key]);
        else statusOptionIds[key] = matches[0].id as string;
      }
      if (missing.length) throw new Error(`GitHub Project Status is missing options: ${missing.join(', ')}`);
      return { projectId, statusFieldId: status.id, statusOptionIds };
    }
    const info = record(fields.pageInfo);
    if (!info.hasNextPage) throw new Error('GitHub Project is missing a Status single-select field');
    if (!nonempty(info.endCursor) || cursors.has(info.endCursor)) {
      throw new Error('GitHub Project field pagination returned an invalid cursor');
    }
    cursors.add(info.endCursor);
    try { page = await projectPage(client, kind, owner, number, info.endCursor); }
    catch { throw new Error('Unable to read GitHub Project fields; check Project read permissions'); }
    if (page.id !== projectId) throw new Error('GitHub Project changed or became inaccessible while reading fields');
  }
}

export async function bootstrapGitHub(client: GitHubClient, opts: BootstrapOptions): Promise<BootstrapResult> {
  if (!nonempty(opts.runId)) throw new Error('runId must be nonempty');
  if (opts.projectNumber !== undefined
    && (!Number.isSafeInteger(opts.projectNumber) || opts.projectNumber < 1)) {
    throw new Error('projectNumber must be a positive integer');
  }
  const owner = opts.projectOwner ?? client.owner;
  if (opts.projectNumber !== undefined && !nonempty(owner)) throw new Error('projectOwner must be nonempty');
  try { await ensureLabels(client, opts.runId); }
  catch { throw new Error('Unable to bootstrap GitHub labels; check repository access and Issues write permissions'); }
  if (opts.projectNumber === undefined) return { env: {}, envLines: [] };
  const project = await discoverProject(client, owner, opts.projectNumber);
  const env = {
    GITHUB_PROJECT_ID: project.projectId,
    GITHUB_STATUS_FIELD_ID: project.statusFieldId,
    GITHUB_STATUS_OPTIONS_JSON: JSON.stringify(project.statusOptionIds),
  };
  const envLines = Object.entries(env).map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`);
  return { project, env, envLines };
}
