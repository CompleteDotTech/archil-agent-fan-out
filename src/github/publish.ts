import type { Plan, TaskSpec, TaskStatus } from '../contracts/types.js';
import type { GitHubClient } from './client.js';
import { marker, runLabel } from './markers.js';

export interface ProjectConfig {
  projectId: string;
  statusFieldId: string;
  statusOptionIds: Record<TaskStatus, string>;
}

interface Issue {
  number: number;
  id: number;
  node_id: string;
  body?: string | null;
  pull_request?: unknown;
}

// The transport's dry-run responses are stateless; retain simulated published issues here.
const dryIssues = new WeakMap<GitHubClient, Map<string, Issue>>();
const dryLinks = new WeakMap<GitHubClient, Set<string>>();

function bodyFor(plan: Plan, task: TaskSpec): string {
  return [
    marker(plan.runId, task.id),
    task.prompt ?? '',
    '## Acceptance criteria',
    ...task.acceptance.map(criterion => `- [ ] ${criterion}`),
    '', '## Verify', '```sh', ...task.verify, '```',
    '', '## Owned paths', ...task.owns.map(path => `- \`${path}\``),
    '', `Research notes: /research/${plan.runId}/${task.id}/sources.md`,
  ].join('\n');
}

async function listIssues(client: GitHubClient, route: string, params: object = {}): Promise<Issue[]> {
  const result: Issue[] = [];
  for (let page = 1; ; page++) {
    const response: unknown = await client.request(route, { ...params, per_page: 100, page });
    const issues = Array.isArray(response) ? response as Issue[] : [];
    result.push(...issues);
    if (issues.length < 100) return result;
  }
}

async function link(
  client: GitHubClient, route: string, issueId: number,
  field: 'sub_issue_id' | 'issue_id', fresh: boolean,
): Promise<void> {
  const key = `${route}:${issueId}`;
  if (client.dryRun) {
    const links = dryLinks.get(client) ?? new Set<string>();
    dryLinks.set(client, links);
    if (links.has(key)) return;
    await client.request(`POST ${route}`, { [field]: issueId });
    links.add(key);
  } else {
    if (!fresh && (await listIssues(client, `GET ${route}`)).some(issue => issue.id === issueId)) return;
    await client.request(`POST ${route}`, { [field]: issueId });
  }
}

const addItem = `mutation AddPlanItem($input: AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input: $input) { item { id } }
}`;
const setItemStatus = `mutation SetPlanItemStatus($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;

export async function publishPlan(
  client: GitHubClient, plan: Plan, opts: { project?: ProjectConfig } = {},
): Promise<Record<string, number>> {
  const base = '/repos/{owner}/{repo}/issues';
  const existing = await listIssues(client, `GET ${base}`, {
    labels: runLabel(plan.runId), state: 'all',
  });
  const simulated = dryIssues.get(client) ?? new Map<string, Issue>();
  if (client.dryRun) dryIssues.set(client, simulated);
  const issues = new Map<string, Issue>();
  const created = new Set<string>();
  const tasks = [
    ...plan.tasks.filter(task => task.kind === 'epic'),
    ...plan.tasks.filter(task => task.kind === 'task'),
  ];
  for (const task of tasks) {
    const tag = marker(plan.runId, task.id);
    let issue = existing.find(candidate => !candidate.pull_request && candidate.body?.includes(tag));
    if (!issue && client.dryRun) issue = simulated.get(tag);
    if (!issue) {
      issue = await client.request(`POST ${base}`, {
        title: task.title, body: bodyFor(plan, task),
        labels: ['swarm', runLabel(plan.runId), `type:${task.kind}`],
      }) as Issue;
      created.add(task.id);
      if (client.dryRun) simulated.set(tag, issue);
    }
    issues.set(task.id, issue);
  }
  const getIssue = (id: string): Issue => {
    const issue = issues.get(id);
    if (!issue) throw new Error(`Plan references unknown task: ${id}`);
    return issue;
  };
  for (const task of tasks) {
    if (!task.parent) continue;
    const parent = getIssue(task.parent);
    await link(client, `${base}/${parent.number}/sub_issues`, getIssue(task.id).id,
      'sub_issue_id', created.has(task.parent));
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      await link(client, `${base}/${getIssue(task.id).number}/dependencies/blocked_by`,
        getIssue(dependency).id, 'issue_id', created.has(task.id));
    }
  }
  if (opts.project) {
    const project = opts.project;
    for (const task of tasks) {
      const issue = getIssue(task.id);
      const result = await client.graphql(addItem, {
        input: { projectId: project.projectId, contentId: issue.node_id },
      });
      const itemId = result?.addProjectV2ItemById?.item?.id
        ?? (client.dryRun ? `dry-item:${project.projectId}:${issue.node_id}` : undefined);
      if (!itemId) throw new Error(`GitHub returned no Project item for ${task.id}`);
      await client.graphql(setItemStatus, {
        input: {
          projectId: project.projectId, itemId, fieldId: project.statusFieldId,
          value: { singleSelectOptionId: project.statusOptionIds[task.dependsOn.length ? 'backlog' : 'ready'] },
        },
      });
    }
  }
  return Object.fromEntries(tasks.map(task => [task.id, getIssue(task.id).number]));
}
