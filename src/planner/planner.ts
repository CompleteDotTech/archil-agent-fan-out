import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import type { Planner } from '../contracts/types.js';
import { systemPrompt, userPrompt } from './prompt.js';
import { planSchema } from './schema.js';
import { validatePlan } from './validate.js';

export function createPlanner(deps: {
  generate: (system: string, user: string) => Promise<unknown>;
  validate?: typeof validatePlan;
}): Planner {
  const validate = deps.validate ?? validatePlan;
  return {
    async plan(input) {
      const request = userPrompt(input);
      let prompt = request;
      const failures: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const parsed = planSchema.safeParse(await deps.generate(systemPrompt, prompt));
        const validation = parsed.success ? validate(parsed.data) : undefined;
        if (parsed.success && validation?.ok) return parsed.data;

        const errors = parsed.success
          ? validation!.errors
          : parsed.error.issues.map(issue => `${issue.path.join('.') || 'plan'}: ${issue.message}`);
        if (errors.length === 0) errors.push('Plan validation failed.');
        failures.push(`Attempt ${attempt}:\n${errors.join('\n')}`);
        prompt = `${request}\n\nThe previous plan was invalid. Return a corrected full Plan. Fix these errors:\n${errors.join('\n')}`;
      }
      throw new Error(`Unable to generate a valid plan after 2 attempts:\n${failures.join('\n')}`);
    },
  };
}

export function openAiGenerate(opts: {
  model: string;
  apiKey: string;
}): (system: string, user: string) => Promise<unknown> {
  const openai = createOpenAI({ apiKey: opts.apiKey });
  return async (system, user) => {
    const result = await generateObject({
      model: openai(opts.model),
      schema: planSchema,
      system,
      prompt: user,
    });
    return result.object;
  };
}
