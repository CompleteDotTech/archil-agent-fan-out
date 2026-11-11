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
