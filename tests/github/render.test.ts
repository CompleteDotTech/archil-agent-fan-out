import { describe, expect, it } from 'vitest';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import { renderIssueBody, renderPullRequestBody } from '../../src/github/render.js';

async function fixture() {
  return new FixturePlanner().plan({
    runId: 'bookmarks-demo',
    brief: 'Build a bookmark manager with an API and single-page UI.',
    targetRepo: 'test/bookmarks',
  });
}

describe('renderIssueBody', () => {
  it('renders a realistic task with multiline prompt and verification commands', async () => {
    const plan = await fixture();
    const task = {
      ...plan.tasks.find(task => task.id === 'T2')!,
      prompt: 'Implement the API from docs/api.md.\n\nKeep storage in memory; preserve newest-first order.',
      verify: ['npm run typecheck', 'node --input-type=module <<\'JS\'\nconsole.log("API smoke check");\nJS'],
    };
    const before = structuredClone({ plan, task });

    expect(renderIssueBody(plan, task)).toMatchInlineSnapshot(`
      "<!-- swarm:bookmarks-demo:T2 -->
      Implement the API from docs/api.md.

      Keep storage in memory; preserve newest-first order.
      ## Acceptance criteria
      - [ ] POST /api/bookmarks validates url and title and returns 201 with the bookmark
      - [ ] GET /api/bookmarks lists newest first; DELETE /api/bookmarks/:id returns 204, or 404 if unknown
      - [ ] tests/acceptance/api.test.ts passes

      ## Verify
      \`\`\`sh
      npm run typecheck
      node --input-type=module <<'JS'
      console.log("API smoke check");
      JS
      \`\`\`

      ## Owned paths
      - \`src/api/**\`
      - \`src/store/**\`
      - \`tests/api/**\`

      Research notes: /research/bookmarks-demo/T2/sources.md"
    `);
    expect({ plan, task }).toEqual(before);
  });

  it('renders an epic with omitted prompt, no commands, and no owned paths', async () => {
    const plan = await fixture();
    const epic = plan.tasks.find(task => task.kind === 'epic')!;

    expect(renderIssueBody(plan, epic)).toMatchInlineSnapshot(`
      "<!-- swarm:bookmarks-demo:EP1 -->

      ## Acceptance criteria
      - [ ] Users can add, list, delete and search bookmarks through a JSON API and a single-page UI
      - [ ] npm test passes on main after all tasks merge

      ## Verify
      \`\`\`sh
      \`\`\`

      ## Owned paths

      Research notes: /research/bookmarks-demo/EP1/sources.md"
    `);
  });

  it('renders an explicitly empty optional prompt like an omitted prompt', async () => {
    const plan = await fixture();
    const task = plan.tasks.find(task => task.id === 'T2')!;
    const body = renderIssueBody(plan, { ...task, prompt: '' });

    expect(body).toBe(renderIssueBody(plan, task));
    expect(body).toMatchInlineSnapshot(`
      "<!-- swarm:bookmarks-demo:T2 -->

      ## Acceptance criteria
      - [ ] POST /api/bookmarks validates url and title and returns 201 with the bookmark
      - [ ] GET /api/bookmarks lists newest first; DELETE /api/bookmarks/:id returns 204, or 404 if unknown
      - [ ] tests/acceptance/api.test.ts passes

      ## Verify
      \`\`\`sh
      npx vitest run tests/acceptance/api.test.ts
      \`\`\`

      ## Owned paths
      - \`src/api/**\`
      - \`src/store/**\`
      - \`tests/api/**\`

      Research notes: /research/bookmarks-demo/T2/sources.md"
    `);
  });
});

describe('renderPullRequestBody', () => {
  it('preserves multiline Markdown and trailing whitespace before the link and marker', () => {
    const input = {
      runId: 'bookmarks-demo', taskId: 'T2', issueNumber: 42,
      body: '## Changes\n- Implement bookmark API and in-memory storage.\n\n## Verification\n```sh\nnpm run typecheck\nnpx vitest run tests/acceptance/api.test.ts\n```\n',
    };
    const before = { ...input };

    expect(renderPullRequestBody(input)).toMatchInlineSnapshot(`
      "## Changes
      - Implement bookmark API and in-memory storage.

      ## Verification
      \`\`\`sh
      npm run typecheck
      npx vitest run tests/acceptance/api.test.ts
      \`\`\`


      Closes #42
      <!-- swarm:bookmarks-demo:T2 -->"
    `);
    expect(input).toEqual(before);
  });

  it('retains the leading blank lines for an empty body', () => {
    expect(renderPullRequestBody({
      runId: 'bookmarks-demo', taskId: 'T3', issueNumber: 105, body: '',
    })).toMatchInlineSnapshot(`
      "

      Closes #105
      <!-- swarm:bookmarks-demo:T3 -->"
    `);
  });
});
