export function marker(runId: string, taskId: string): string {
  return `<!-- swarm:${runId}:${taskId} -->`;
}

export function parseMarker(body: string | null | undefined): { runId: string; taskId: string } | undefined {
  const match = /<!-- swarm:([^\s:<>]+):([^\s:<>]+) -->/.exec(body ?? '');
  return match ? { runId: match[1], taskId: match[2] } : undefined;
}
