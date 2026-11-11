import { describe, expect, it, vi } from 'vitest';
import { FixturePlanner } from '../../src/contracts/fakes.js';
import type { Plan } from '../../src/contracts/types.js';
import { systemPrompt } from '../../src/planner/prompt.js';
import { repairPlan } from '../../src/planner/repair.js';
import { validatePlan } from '../../src/planner/validate.js';

const fixture = () => new FixturePlanner().plan({
  runId: 'repair-test', brief: 'Build bookmarks', targetRepo: 'local/bookmarks', baseBranch: 'develop',
});

function breakPlan(plan: Plan): Plan {
  const broken = structuredClone(plan);
  broken.tasks[2]!.dependsOn = ['missing-task'];
  return broken;
}

describe('repairPlan', () => {
  it('returns the same valid input without generation', async () => {
    const plan = await fixture();
    const generate = vi.fn();
    await expect(repairPlan(plan, { generate })).resolves.toBe(plan);
    expect(generate).not.toHaveBeenCalled();
  });

  it('repairs once with shared guidance, the full original plan, and every error', async () => {
    const plan = await fixture();
    const broken = breakPlan(plan);
    const generate = vi.fn().mockResolvedValue(plan);
    const repaired = await repairPlan(broken, { generate });
    expect(repaired).toEqual(plan);
    expect(validatePlan(repaired).ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const [system, user] = generate.mock.calls[0]!;
    expect(system).toContain(systemPrompt);
    expect(system).toContain('Repair the supplied plan');
    expect(system).toContain('Preserve runId, brief, targetRepo and baseBranch exactly');
    expect(user).toContain(JSON.stringify(broken, null, 2));
    expect(user).toContain(JSON.stringify(validatePlan(broken).errors, null, 2));
  });

  it('rejects an invalid generated schema with field findings and no retry', async () => {
    const broken = breakPlan(await fixture());
    const generate = vi.fn().mockResolvedValue({ ...broken, tasks: 'invalid' });
    const validate = vi.fn(validatePlan);
    await expect(repairPlan(broken, { generate, validate })).rejects.toThrow(/invalid schema:[\s\S]*tasks:/);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('rejects a semantically invalid generated plan with findings and no retry', async () => {
    const broken = breakPlan(await fixture());
    const generate = vi.fn().mockResolvedValue(broken);
    await expect(repairPlan(broken, { generate })).rejects.toThrow(/failed validation:[\s\S]*missing-task/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(['runId', 'brief', 'targetRepo', 'baseBranch'] as const)(
    'rejects changes to protected identity field %s', async field => {
      const plan = await fixture();
      const generate = vi.fn().mockResolvedValue({ ...plan, [field]: 'changed' });
      await expect(repairPlan(breakPlan(plan), { generate }))
        .rejects.toThrow(`changed protected identity fields: ${field}`);
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates the generator rejection unchanged without retries', async () => {
    const error = new Error('generator unavailable');
    const generate = vi.fn().mockRejectedValue(error);
    await expect(repairPlan(breakPlan(await fixture()), { generate })).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses the injected validator for both input and repair', async () => {
    const plan = await fixture();
    const validate = vi.fn<typeof validatePlan>()
      .mockReturnValueOnce({ ok: false, errors: ['Custom structure rule'] })
      .mockReturnValueOnce({ ok: true, errors: [] });
    const generate = vi.fn().mockResolvedValue(plan);
    await expect(repairPlan(plan, { generate, validate })).resolves.toEqual(plan);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenNthCalledWith(1, plan);
    expect(validate).toHaveBeenNthCalledWith(2, plan);
    expect(generate.mock.calls[0]![1]).toContain('Custom structure rule');
  });

  it('honors an injected validator on the fast path', async () => {
    const broken = breakPlan(await fixture());
    const validate = vi.fn<typeof validatePlan>().mockReturnValue({ ok: true, errors: [] });
    const generate = vi.fn();
    await expect(repairPlan(broken, { generate, validate })).resolves.toBe(broken);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it('preserves nested input and generated objects even when a validator mutates its argument', async () => {
    const plan = await fixture();
    const broken = breakPlan(plan);
    const before = structuredClone(broken);
    const validate = vi.fn<typeof validatePlan>(candidate => {
      const result = validatePlan(candidate);
      candidate.tasks[1]!.acceptance.push('validator mutation');
      return result;
    });
    const repaired = await repairPlan(broken, { generate: vi.fn().mockResolvedValue(plan), validate });
    expect(broken).toEqual(before);
    expect(repaired).toEqual(plan);
    repaired.tasks[1]!.owns.push('new/**');
    expect(broken).toEqual(before);
    expect(plan.tasks[1]!.owns).not.toContain('new/**');
  });
});
