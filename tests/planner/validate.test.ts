import { describe, expect, it } from 'vitest';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import type { Plan, TaskSpec } from '../../src/contracts/types.js';
import { topoOrder, validatePlan } from '../../src/planner/validate.js';

function task(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return { id, title: id, kind: 'task', dependsOn: [], owns: [`src/${id}/**`], acceptance: [], verify: ['npm test'], ...overrides };
}

function epic(id = 'EP1', overrides: Partial<TaskSpec> = {}): TaskSpec {
  return task(id, { kind: 'epic', owns: [], verify: [], ...overrides });
}

function plan(tasks: TaskSpec[]): Plan {
  return { runId: 'test', brief: 'Test plan', targetRepo: 'local/demo', baseBranch: 'main', tasks };
}

describe('validatePlan', () => {
  it('accepts the bookmarks fixture supplied by the offline planner fake', async () => {
    const fixture = await new FixturePlanner().plan({ runId: 'test', brief: 'Bookmarks', targetRepo: 'local/demo' });
    expect(validatePlan(fixture)).toEqual({ ok: true, errors: [] });
    expect(topoOrder(fixture)).toEqual(['T1', 'T2', 'T3', 'T4']);
  });

  it.each([
    { name: 'duplicate task ids', tasks: [task('A'), task('A')], error: 'Duplicate id "A"' },
    { name: 'duplicate epic and task ids', tasks: [epic('A'), task('A')], error: 'Duplicate id "A"' },
    { name: 'missing dependency', tasks: [task('A'), task('B', { dependsOn: ['absent'] })], error: '"B" depends on missing id "absent"' },
    { name: 'missing epic dependency', tasks: [task('A'), epic('E', { dependsOn: ['absent'] })], error: '"E" depends on missing id "absent"' },
    { name: 'missing parent', tasks: [task('A', { parent: 'absent' })], error: '"A" has missing parent "absent"' },
    { name: 'task parent', tasks: [task('A'), task('B', { parent: 'A' })], error: 'Parent "A" of "B" must be an epic' },
    { name: 'epic verify commands', tasks: [task('A'), epic('E', { verify: ['npm test'] })], error: 'Epic "E" must have no verify' },
    { name: 'empty plan', tasks: [], error: 'at least one task with no dependencies' },
    { name: 'only epics', tasks: [epic()], error: 'at least one task with no dependencies' },
    { name: 'epic root does not count as a task root', tasks: [epic(), task('A', { dependsOn: ['EP1'] })], error: 'at least one task with no dependencies' },
    { name: 'missing owns', tasks: [task('A', { owns: [] })], error: '"A" must have at least one non-empty owns glob' },
    { name: 'blank owns', tasks: [task('A', { owns: ['  '] })], error: '"A" must have at least one non-empty owns glob' },
    { name: 'missing verify', tasks: [task('A', { verify: [] })], error: '"A" must have at least one non-empty verify command' },
    { name: 'blank verify', tasks: [task('A', { verify: ['\t'] })], error: '"A" must have at least one non-empty verify command' },
    { name: 'self cycle', tasks: [task('A', { dependsOn: ['A'] })], error: 'Dependency cycle: A -> A' },
    { name: 'long cycle', tasks: [task('A', { dependsOn: ['B'] }), task('B', { dependsOn: ['C'] }), task('C', { dependsOn: ['A'] })], error: 'Dependency cycle: A -> B -> C -> A' },
    { name: 'disconnected cycle', tasks: [task('root'), task('A', { dependsOn: ['B'] }), task('B', { dependsOn: ['A'] })], error: 'Dependency cycle: A -> B -> A' },
    { name: 'cycle through an epic', tasks: [task('A', { dependsOn: ['E'] }), epic('E', { dependsOn: ['A'] })], error: 'Dependency cycle: A -> E -> A' },
  ])('rejects $name with a clear error', ({ tasks, error }) => {
    const result = validatePlan(plan(tasks));
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes(error))).toBe(true);
  });

  it.each([
    { count: 6, maxTasks: undefined, ok: true },
    { count: 7, maxTasks: undefined, ok: false },
    { count: 2, maxTasks: 2, ok: true },
    { count: 3, maxTasks: 2, ok: false },
    { count: 7, maxTasks: 8, ok: true },
    { count: 1, maxTasks: 0, ok: false },
  ])('enforces task limit: $count tasks, maximum $maxTasks', ({ count, maxTasks, ok }) => {
    const input = plan([epic(), epic('EP2'), ...Array.from({ length: count }, (_, i) => task(`T${i}`, { parent: 'EP1' }))]);
    const result = validatePlan(input, { maxTasks });
    expect(result.ok).toBe(ok);
    if (!ok) expect(result.errors).toContain(`Plan has ${count} tasks; maximum is ${maxTasks ?? 6} (epics excluded).`);
  });

  it.each([
    { left: 'src/**', right: 'src/api/**', overlap: true },
    { left: 'src/api/**', right: 'src/**', overlap: true },
    { left: 'src/*/a.ts', right: 'src/*/b.ts', overlap: true },
    { left: 'src/a?.ts', right: 'src/abc.ts', overlap: true },
    { left: 'src/[ab]/**', right: 'src/z/**', overlap: true },
    { left: 'src/{api,ui}/**', right: 'src/data/**', overlap: true },
    { left: '**', right: 'public/**', overlap: true },
    { left: '?file', right: 'src/**', overlap: true },
    { left: 'src/a.ts', right: 'src/a.ts', overlap: true },
    { left: 'src/a', right: 'src/abc', overlap: true },
    { left: 'src/api/**', right: 'src/ui/**', overlap: false },
    { left: 'src/a.ts', right: 'src/b.ts', overlap: false },
  ])('compares literal prefixes of $left and $right', ({ left, right, overlap }) => {
    const result = validatePlan(plan([task('A', { owns: [left] }), task('B', { owns: [right] })]));
    expect(result.ok).toBe(!overlap);
    if (overlap) {
      expect(result.errors).toEqual([`Concurrent tasks "A" and "B" have overlapping owns globs "${left}" and "${right}".`]);
    }
  });

  it.each([
    { name: 'direct dependencies', tasks: [task('A', { owns: ['**'] }), task('B', { dependsOn: ['A'] })] },
    { name: 'transitive dependencies in reverse input order', tasks: [task('C', { owns: ['**'], dependsOn: ['B'] }), task('B', { dependsOn: ['A'] }), task('A', { owns: ['**'] })] },
    { name: 'epic ownership', tasks: [epic('E', { owns: ['**'] }), task('A', { parent: 'E' }), task('B', { parent: 'E' })] },
  ])('allows overlaps for $name', ({ tasks }) => {
    expect(validatePlan(plan(tasks))).toEqual({ ok: true, errors: [] });
  });

  it('rejects overlapping siblings even when both depend on a shared root', () => {
    const result = validatePlan(plan([task('root'), task('A', { dependsOn: ['root'], owns: ['src/shared/**'] }), task('B', { dependsOn: ['root'], owns: ['src/shared/file.ts'] })]));
    expect(result.errors).toEqual(['Concurrent tasks "A" and "B" have overlapping owns globs "src/shared/**" and "src/shared/file.ts".']);
  });

  it('checks every owns glob, not only the first', () => {
    const result = validatePlan(plan([task('A', { owns: ['a/**', 'shared/**'] }), task('B', { owns: ['b/**', 'shared/**'] })]));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('"shared/**" and "shared/**"');
  });
});

describe('topoOrder', () => {
  it.each([
    { name: 'empty graph', tasks: [], expected: [] },
    { name: 'only epics', tasks: [epic()], expected: [] },
    { name: 'independent tasks', tasks: [task('B'), task('A')], expected: ['B', 'A'] },
    { name: 'reversed chain', tasks: [task('C', { dependsOn: ['B'] }), task('B', { dependsOn: ['A'] }), task('A')], expected: ['A', 'B', 'C'] },
    { name: 'diamond', tasks: [task('D', { dependsOn: ['B', 'C'] }), task('B', { dependsOn: ['A'] }), task('C', { dependsOn: ['A'] }), task('A')], expected: ['A', 'B', 'C', 'D'] },
    { name: 'dependencies through epics', tasks: [task('B', { dependsOn: ['E'] }), epic('E', { dependsOn: ['A'] }), task('A')], expected: ['A', 'B'] },
  ])('orders $name without mutation', ({ tasks, expected }) => {
    const input = plan(tasks);
    const before = structuredClone(input);
    expect(topoOrder(input)).toEqual(expected);
    expect(input).toEqual(before);
  });

  it.each([
    { tasks: [task('A'), task('A')], error: /Duplicate id "A"/ },
    { tasks: [task('A', { dependsOn: ['missing'] })], error: /missing id "missing"/ },
    { tasks: [task('A', { dependsOn: ['B'] }), task('B', { dependsOn: ['A'] })], error: /A -> B -> A/ },
  ])('throws on an invalid dependency graph', ({ tasks, error }) => {
    expect(() => topoOrder(plan(tasks))).toThrow(error);
  });
});
