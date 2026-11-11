import type { Plan, TaskSpec } from '../contracts/types.js';
import { marker } from './markers.js';

/** Render the issue body using the publisher's existing Markdown layout. */
export function renderIssueBody(plan: Plan, task: TaskSpec): string {
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

/** Append the issue linkage and idempotency marker without changing the supplied body. */
export function renderPullRequestBody(input: {
  runId: string;
  taskId: string;
  issueNumber: number;
  body: string;
}): string {
  return `${input.body}\n\nCloses #${input.issueNumber}\n${marker(input.runId, input.taskId)}`;
}
