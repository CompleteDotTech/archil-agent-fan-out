import { Hono } from 'hono';
import type { Store } from '../contracts/types.js';
export function createDashboard(ports: { store: Store }, hooks: { stopTask(runId: string, taskId: string): Promise<void> }, opts?: { projectUrl?: string; publicDir?: string }): Hono {
  throw new Error('not implemented');
}
