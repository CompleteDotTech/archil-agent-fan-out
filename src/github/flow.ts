import type { Publisher, TaskStatus } from '../contracts/types.js';
import type { GitHubClient } from './client.js';
import { marker } from './markers.js';

export type IssueOf = (runId: string, taskId: string) => Promise<number>;
export interface FlowProject {
  projectId: string;
  statusFieldId: string;
  statusOptionIds: Record<TaskStatus, string>;
}

const issues = '/repos/{owner}/{repo}/issues';
const pulls = '/repos/{owner}/{repo}/pulls';

/** Bind once per publisher so Project item identities survive status changes. */
export function setStatus(
  client: GitHubClient, issueOf: IssueOf, project?: FlowProject,
): Publisher['setStatus'] {
  const itemIds = new Map<number, string>();
  return async (runId, taskId, status) => {
    const issue_number = await issueOf(runId, taskId);
    const issue = await client.request(`GET ${issues}/{issue_number}`, { issue_number });
    const labels: string[] = (issue.labels ?? [])
      .map((label: string | { name?: string }) => typeof label === 'string' ? label : label.name)
      .filter((name: string | undefined): name is string => !!name && !name.startsWith('status:'));
    await client.request(`PUT ${issues}/{issue_number}/labels`, {
      issue_number, labels: [...labels, `status:${status}`],
    });
    if (!project) return;
    let itemId = itemIds.get(issue_number);
    if (!itemId) {
      // Adding an issue already in the Project returns its existing item.
      const added = await client.graphql(`mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`, { projectId: project.projectId, contentId: issue.node_id ?? (client.dryRun ? `I_${issue_number}` : undefined) });
      itemId = added.addProjectV2ItemById?.item?.id;
      if (!itemId && client.dryRun) itemId = `dry-project-item-${issue_number}`;
      if (!itemId) throw new Error(`No Project item returned for issue #${issue_number}`);
      itemIds.set(issue_number, itemId);
    }
    await client.graphql(`mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`, { projectId: project.projectId, itemId, fieldId: project.statusFieldId,
      optionId: project.statusOptionIds[status] });
  };
}

export function openPullRequest(
  client: GitHubClient, issueOf: IssueOf, _project?: FlowProject,
): Publisher['openPullRequest'] {
  return async ({ runId, taskId, branch, title, body }) => {
    const existing = await client.request(`GET ${pulls}`, {
      state: 'open', head: `${client.owner}:${branch}`, per_page: 100,
    });
    if (Array.isArray(existing) && existing.length > 0) {
      return { number: existing[0].number, url: existing[0].html_url };
    }
    const issue = await issueOf(runId, taskId);
    const pr = await client.request(`POST ${pulls}`, {
      head: branch, base: 'main', title,
      body: `${body}\n\nCloses #${issue}\n${marker(runId, taskId)}`,
    });
    return { number: pr.number, url: pr.html_url };
  };
}

export function mergePullRequest(
  client: GitHubClient, _issueOf: IssueOf, _project?: FlowProject,
): Publisher['mergePullRequest'] {
  return async pull_number => {
    const merged = await client.request(`PUT ${pulls}/{pull_number}/merge`, {
      pull_number, merge_method: 'squash',
    });
    if (merged.merged === false || !merged.sha) {
      throw new Error(`Pull request #${pull_number} was not merged`);
    }
    return { mergeCommit: merged.sha };
  };
}

export function comment(
  client: GitHubClient, issueOf: IssueOf, _project?: FlowProject,
): Publisher['comment'] {
  return async (runId, taskId, body) => {
    const issue_number = await issueOf(runId, taskId);
    await client.request(`POST ${issues}/{issue_number}/comments`, { issue_number, body });
  };
}
