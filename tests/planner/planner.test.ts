import { describe, expect, it, vi } from 'vitest';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import { createPlanner } from '../../src/planner/planner.js';
import { planSchema, taskSpecSchema } from '../../src/planner/schema.js';
import { validatePlan } from '../../src/planner/validate.js';

const input = { runId: 'run-test', brief: 'Build a bookmark manager', targetRepo: 'local/bookmarks' };
const fixture = () => new FixturePlanner().plan(input);

describe('createPlanner', () => {
  it('returns a valid fixture and supplies the architecture rules and request metadata', async () => {
    const plan = await fixture();
    const generate = vi.fn().mockResolvedValue(plan);
    await expect(createPlanner({ generate }).plan(input)).resolves.toEqual(plan);
    expect(generate).toHaveBeenCalledTimes(1);
    const [system, user] = generate.mock.calls[0]!;
    expect(system).toContain('at most 6 executable tasks');
    expect(system).toContain('docs/api.md');
    expect(system).toContain('fixtures/plan.bookmarks.json');
    expect(user).toContain('"baseBranch": "main"');
    expect(user).toContain(input.targetRepo);
  });

  it('retries a structurally broken response once with the schema errors', async () => {
    const plan = await fixture();
    const generate = vi.fn().mockResolvedValueOnce({ ...plan, tasks: 'invalid' }).mockResolvedValueOnce(plan);
    const validate = vi.fn(validatePlan);
    await expect(createPlanner({ generate, validate }).plan({ ...input, baseBranch: 'develop' }))
      .resolves.toEqual(plan);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![1]).toContain('tasks:');
    expect(generate.mock.calls[1]![1]).toContain('"baseBranch": "develop"');
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('retries a plan rejected by semantic validation', async () => {
    const plan = await fixture();
    const broken = structuredClone(plan);
    broken.tasks[2]!.dependsOn = ['missing-task'];
    const generate = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(plan);
    await expect(createPlanner({ generate }).plan(input)).resolves.toEqual(plan);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![1]).toContain('missing-task');
  });

  it('throws an Error listing both failures after two invalid responses', async () => {
    const plan = await fixture();
    const broken = structuredClone(plan);
    broken.tasks[2]!.verify = [];
    const generate = vi.fn().mockResolvedValueOnce({ ...plan, runId: 123 }).mockResolvedValueOnce(broken);
    const result = createPlanner({ generate }).plan(input);
    await expect(result).rejects.toThrow(/Attempt 1:[\s\S]*runId:[\s\S]*Attempt 2:[\s\S]*verify command/);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not retry generation transport failures', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    await expect(createPlanner({ generate }).plan(input)).rejects.toThrow('provider unavailable');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('plan schemas', () => {
  it('accepts the contract fixture including omitted optional fields', async () => {
    const plan = await fixture();
    expect(planSchema.parse(plan)).toEqual(plan);
    expect(taskSpecSchema.parse(plan.tasks[0])).toEqual(plan.tasks[0]);
  });

  it('rejects invalid kinds and non-string task fields', async () => {
    const plan = await fixture();
    expect(taskSpecSchema.safeParse({ ...plan.tasks[0], kind: 'feature' }).success).toBe(false);
    expect(taskSpecSchema.safeParse({ ...plan.tasks[0], research: [12] }).success).toBe(false);
  });
});
