import { z } from 'zod';
import type { Plan, TaskSpec } from '../contracts/types.js';

export const taskSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['epic', 'task']),
  parent: z.string().optional(),
  dependsOn: z.array(z.string()),
  owns: z.array(z.string()),
  acceptance: z.array(z.string()),
  verify: z.array(z.string()),
  research: z.array(z.string()).optional(),
  prompt: z.string().optional(),
}) satisfies z.ZodType<TaskSpec>;

export const planSchema = z.object({
  runId: z.string(),
  brief: z.string(),
  targetRepo: z.string(),
  baseBranch: z.string(),
  tasks: z.array(taskSpecSchema),
}) satisfies z.ZodType<Plan>;

// Structured Outputs requires every property to be present. Nullable values
// represent the optional fields used by the internal Plan contract.
export const modelPlanSchema = planSchema.extend({
  tasks: z.array(taskSpecSchema.extend({
    parent: z.string().nullable(),
    research: z.array(z.string()).nullable(),
    prompt: z.string().nullable(),
  })),
});

export function normalizeModelPlan(value: z.infer<typeof modelPlanSchema>): Plan {
  return planSchema.parse({
    ...value,
    tasks: value.tasks.map(({ parent, research, prompt, ...task }) => ({
      ...task,
      ...(parent === null ? {} : { parent }),
      ...(research === null ? {} : { research }),
      ...(prompt === null ? {} : { prompt }),
    })),
  });
}
