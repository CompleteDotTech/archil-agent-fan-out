import type { Plan, Research, SharedDisk, Source } from '../contracts/types.js';

/** Collect best-effort research; disk failures still surface to the caller. */
export async function runResearch(input: {
  plan: Plan;
  research: Research;
  disk: SharedDisk;
  maxResults?: number;
}): Promise<Record<string, Source[]>> {
  const { plan, research, disk, maxResults = 3 } = input;
  const entries: [string, Source[]][] = [];

  for (const task of plan.tasks) {
    if (!task.research?.length) continue;

    const sources: Source[] = [];
    const excerpts: string[] = [];
    for (const query of task.research) {
      let results: Source[];
      try {
        results = await research.search(query, { maxResults });
      } catch {
        // One unavailable query must not discard other research for this task.
        continue;
      }

      const citation = sources.length + 1;
      sources.push(...results);
      const top = results[0];
      if (!top) continue;

      try {
        const excerpt = (await research.fetch(top.url)).slice(0, 6000);
        if (excerpt) excerpts.push(`### [${citation}] ${top.title}\n\n${excerpt}`);
      } catch {
        // Search citations remain useful even when the page cannot be fetched.
      }
    }

    const citations = sources.map((source, index) =>
      `${index + 1}. ${source.title}\n   URL: ${source.url}${source.snippet ? `\n   ${source.snippet}` : ''}`,
    );
    const markdown = [
      '# Sources',
      citations.join('\n\n'),
      '## Excerpt',
      excerpts.join('\n\n'),
    ].join('\n\n') + '\n';
    const path = `/research/${plan.runId}/${task.id}`;
    await disk.write(`${path}/sources.json`, JSON.stringify(sources, null, 2));
    await disk.write(`${path}/sources.md`, markdown);
    entries.push([task.id, sources]);
  }

  return Object.fromEntries(entries);
}
