import { createHash } from 'node:crypto';
export function marker(runId: string, taskId: string): string {
  return `<!-- swarm:${runId}:${taskId} -->`;
}

export function parseMarker(body: string | null | undefined): { runId: string; taskId: string } | undefined {
  const match = /<!-- swarm:([^\s:<>]+):([^\s:<>]+) -->/.exec(body ?? '');
  return match ? { runId: match[1], taskId: match[2] } : undefined;
}

/** GitHub label names are limited to 50 characters; bodies retain the full ID. */
export function runLabel(runId: string): string {
 const label=`swarm:${runId}`;
 return label.length <= 50 ? label : `swarm:${createHash('sha256').update(runId).digest('hex').slice(0,40)}`;
}
