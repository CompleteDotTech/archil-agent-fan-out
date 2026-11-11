import type { Attempt, Manifest, Plan, SharedDisk, Store, SwarmEvent, TaskStatus } from '../types.js';

const copy = <T>(value: T): T => structuredClone(value);
const key = (runId: string, id: string): string => JSON.stringify([runId, id]);

export class MemoryStore implements Store {
  private readonly plans = new Map<string, Plan>();
  private readonly statuses = new Map<string, Record<string, TaskStatus>>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly manifests = new Map<string, Manifest>();
  private readonly issues = new Map<string, Record<string, number>>();
  private readonly events: { index: number; event: SwarmEvent }[] = [];
  private nextIndex = 1;

  async init(): Promise<void> {}

  async savePlan(plan: Plan): Promise<void> {
    this.plans.set(plan.runId, copy(plan));
    const statuses = this.statuses.get(plan.runId) ?? {};
    for (const task of plan.tasks) statuses[task.id] ??= 'backlog';
    this.statuses.set(plan.runId, statuses);
  }

  async getPlan(runId: string): Promise<Plan | undefined> {
    return copy(this.plans.get(runId));
  }

  async setTaskStatus(runId: string, taskId: string, status: TaskStatus): Promise<void> {
    const statuses = this.statuses.get(runId) ?? {};
    statuses[taskId] = status;
    this.statuses.set(runId, statuses);
  }

  async getTaskStatuses(runId: string): Promise<Record<string, TaskStatus>> {
    return copy(this.statuses.get(runId) ?? {});
  }

  async createAttempt(attempt: Attempt): Promise<void> {
    this.attempts.set(key(attempt.runId, attempt.attemptId), copy(attempt));
  }

  async updateAttempt(runId: string, attemptId: string, patch: Partial<Attempt>): Promise<void> {
    const id = key(runId, attemptId);
    const attempt = this.attempts.get(id);
    if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
    this.attempts.set(id, { ...attempt, ...copy(patch), runId, attemptId });
  }

  async currentAttempt(runId: string, taskId: string): Promise<Attempt | undefined> {
    const attempts = [...this.attempts.values()].filter(a => a.runId === runId && a.taskId === taskId);
    attempts.sort((a, b) => b.n - a.n || b.startedAt.localeCompare(a.startedAt));
    return copy(attempts[0]);
  }

  async listAttempts(runId: string): Promise<Attempt[]> {
    return copy([...this.attempts.values()].filter(a => a.runId === runId));
  }

  async saveManifest(manifest: Manifest): Promise<void> {
    this.manifests.set(key(manifest.runId, manifest.attemptId), copy(manifest));
  }

  async setIssueNumber(runId: string, taskId: string, issue: number): Promise<void> {
    const issues = this.issues.get(runId) ?? {};
    issues[taskId] = issue;
    this.issues.set(runId, issues);
  }

  async getIssueNumbers(runId: string): Promise<Record<string, number>> {
    return copy(this.issues.get(runId) ?? {});
  }

  async appendEvent(event: SwarmEvent): Promise<void> {
    this.events.push({ index: this.nextIndex++, event: copy(event) });
  }

  async listEvents(runId: string, afterIndex = 0): Promise<{ index: number; event: SwarmEvent }[]> {
    return copy(this.events.filter(item => item.event.runId === runId && item.index > afterIndex));
  }
}

export class MemoryDisk implements SharedDisk {
  readonly files = new Map<string, string>();

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter(path => path.startsWith(prefix)).sort();
  }
}
