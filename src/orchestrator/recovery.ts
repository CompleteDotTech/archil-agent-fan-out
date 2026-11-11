import type {
  Attempt, Dispatch, Manifest, RecoveryHooks, SandboxRunner, SharedDisk, Store,
} from '../contracts/types.js';

export interface RecoveryPorts {
  store: Store;
  sandboxes: SandboxRunner;
  disk: SharedDisk;
  log?: (message: string) => void;
}

export type Recovery = RecoveryHooks & {
  requestStop(runId: string, taskId: string): Promise<void>;
  resumeAfterRestart(runId: string): Promise<Dispatch[]>;
  /** Pass the store's current attempt to fence manifests from older workers. */
  isCurrent(attempt: Attempt, manifest: Manifest): boolean;
};

export function createRecovery(ports: RecoveryPorts, opts: { maxResumes?: number } = {}): Recovery {
  const { store, sandboxes, disk } = ports;
  const maxResumes = opts.maxResumes ?? 2;
  if (!Number.isInteger(maxResumes) || maxResumes < 0) {
    throw new Error('maxResumes must be a non-negative integer');
  }
  const pending = new Map<string, Promise<unknown>>();

  // Dashboard stops, restart scans, and exec callbacks may arrive together.
  async function serialized<T>(runId: string, taskId: string, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([runId, taskId]);
    const previous = pending.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(action);
    pending.set(key, job);
    try { return await job; }
    finally { if (pending.get(key) === job) pending.delete(key); }
  }

  async function event(attempt: Attempt, type: string): Promise<void> {
    await store.appendEvent({
      runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      at: new Date().toISOString(), type,
      data: { attemptId: attempt.attemptId, sandboxId: attempt.sandboxId },
    });
  }

  async function interrupt(attempt: Attempt): Promise<Dispatch | undefined> {
    const attempts = await store.listAttempts(attempt.runId);
    const persisted = attempts.find(item => item.attemptId === attempt.attemptId && item.taskId === attempt.taskId);
    if (!persisted || (persisted.state !== 'running' && persisted.state !== 'interrupted')) return undefined;
    if (persisted.state === 'running') {
      await store.updateAttempt(attempt.runId, attempt.attemptId, { state: 'interrupted' });
      await event(persisted, 'attempt.interrupted');
    }
    const current = await store.currentAttempt(attempt.runId, attempt.taskId);
    if (current?.attemptId !== persisted.attemptId) return undefined;
    const resumes = attempts.filter(item => item.taskId === attempt.taskId && item.resume).length;
    if (resumes >= maxResumes || !persisted.sandboxId) return undefined;

    const directory = `/runs/${persisted.runId}/${persisted.taskId}`;
    const task = await disk.read(`${directory}/${persisted.attemptId}/task.json`);
    if (task === undefined) throw new Error(`Missing task.json for ${persisted.attemptId}`);
    try { await sandboxes.start(persisted.sandboxId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already running/i.test(message)) throw error;
    }
    const n = persisted.n + 1;
    const startedAt = new Date();
    const duration = Date.parse(persisted.deadlineAt) - Date.parse(persisted.startedAt);
    const next: Attempt = {
      ...persisted, n, attemptId: `${persisted.taskId}-a${n}`, resume: true, state: 'running',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(startedAt.getTime() + Math.max(0, duration)).toISOString(),
    };
    await disk.write(`${directory}/${next.attemptId}/task.json`, task);
    await store.createAttempt(next);
    ports.log?.(`Resuming ${next.taskId} as ${next.attemptId}`);
    return {
      runId: next.runId, taskId: next.taskId, attemptId: next.attemptId, n,
      sandboxId: persisted.sandboxId, resume: true,
    };
  }

  const onInterrupted = (attempt: Attempt) => serialized(attempt.runId, attempt.taskId, () => interrupt(attempt));

  return {
    onInterrupted,
    async requestStop(runId, taskId) {
      await serialized(runId, taskId, async () => {
        const attempt = await store.currentAttempt(runId, taskId);
        if (!attempt?.sandboxId || attempt.state !== 'running') return;
        await sandboxes.stop(attempt.sandboxId);
        await event(attempt, 'attempt.stop_requested');
      });
    },
    async resumeAfterRestart(runId) {
      const dispatches: Dispatch[] = [];
      // Snapshot first: attempts created during recovery must not be recovered again.
      for (const attempt of await store.listAttempts(runId)) {
        if (attempt.state !== 'running') continue;
        const dispatch = await onInterrupted(attempt);
        if (dispatch) dispatches.push(dispatch);
      }
      return dispatches;
    },
    isCurrent(attempt, manifest) {
      return attempt.runId === manifest.runId && attempt.taskId === manifest.taskId
        && attempt.attemptId === manifest.attemptId;
    },
  };
}
