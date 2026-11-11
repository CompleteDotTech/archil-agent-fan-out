import type { Publisher } from '../contracts/types.js';
import type { GitHubClient } from './client.js';
import { publishPlan, type ProjectConfig } from './publish.js';
import { setStatus, openPullRequest, mergePullRequest, comment, type IssueOf } from './flow.js';

export { createGitHubClient } from './client.js';
export type { GitHubClient, GitHubClientOptions } from './client.js';
export { publishPlan } from './publish.js';
export type { ProjectConfig } from './publish.js';

export function createPublisher(opts: {
  client: GitHubClient;
  issueOf: IssueOf;
  project?: ProjectConfig;
}): Publisher {
  const { client, issueOf, project } = opts;
  return {
    publishPlan: plan => publishPlan(client, plan, { project }),
    setStatus: setStatus(client, issueOf, project),
    openPullRequest: openPullRequest(client, issueOf, project),
    mergePullRequest: mergePullRequest(client, issueOf, project),
    comment: comment(client, issueOf, project),
  };
}
