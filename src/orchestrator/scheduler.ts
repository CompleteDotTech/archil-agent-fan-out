import type {
  Attempt, Dispatch, Gate, IntegratorHooks, Manifest, Publisher, RecoveryHooks,
  SandboxRunner, SharedDisk, Store, TaskSpec, TaskStatus,
} from "../contracts/types.js";
import { attemptId, readyTasks } from "./state.js";

export interface SchedulerPorts {
  store: Store;
  publisher: Publisher;
  sandboxes: SandboxRunner;
  gate: Gate;
  disk: SharedDisk;
  recovery?: RecoveryHooks;
  integrator?: IntegratorHooks;
  now?: () => Date;
  log?: (s: string) => void;
}

export interface SchedulerOptions {
  concurrency: number;
  attemptTimeoutMs: number;
  baseCommit: string;
  workerEnv: Record<string, string>;
  sandboxPool: string[];
  pollMs?: number;
}

export function createScheduler(ports: SchedulerPorts, opts: SchedulerOptions): {
  runUntilDone(runId: string): Promise<{ done: string[]; blocked: string[] }>;
} {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error("Scheduler concurrency must be a positive integer");
  }
  if (!Number.isFinite(opts.attemptTimeoutMs) || opts.attemptTimeoutMs <= 0) {
    throw new Error("Scheduler attemptTimeoutMs must be positive");
  }
  const { store, publisher, sandboxes, disk } = ports;
  const now = ports.now ?? (() => new Date());
  const pool = [...new Set(opts.sandboxPool)];
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, opts.pollMs ?? 25));

  async function event(runId: string, taskId: string, type: string,
    data: Record<string, unknown>, id?: string): Promise<void> {
    await store.appendEvent({ runId, taskId, attemptId: id, at: now().toISOString(), type, data });
  }

  async function status(runId: string, taskId: string, value: TaskStatus): Promise<void> {
    await store.setTaskStatus(runId, taskId, value);
    await publisher.setStatus(runId, taskId, value);
    await event(runId, taskId, "task.status", { status: value });
  }

  async function current(attempt: Attempt): Promise<boolean> {
    return (await store.currentAttempt(attempt.runId, attempt.taskId))?.attemptId === attempt.attemptId;
  }

  async function newAttempt(runId: string, task: TaskSpec, sandboxId: string,
    findings?: string[]): Promise<Attempt> {
    const previous = await store.currentAttempt(runId, task.id);
    const n = (previous?.n ?? 0) + 1;
    const started = now();
    const attempt: Attempt = {
      runId, taskId: task.id, attemptId: attemptId(task.id, n), n, sandboxId,
      resume: false, state: "running", startedAt: started.toISOString(),
      deadlineAt: new Date(started.getTime() + opts.attemptTimeoutMs).toISOString(),
      ...(findings ? { findings } : {}),
    };
    await writeTask(task, attempt);
    await store.createAttempt(attempt);
    return attempt;
  }

  async function writeTask(task: TaskSpec, attempt: Attempt): Promise<void> {
    await disk.write(`${directory(attempt)}/task.json`, JSON.stringify({
      ...task, task, runId: attempt.runId, taskId: task.id,
      attemptId: attempt.attemptId, n: attempt.n, sandboxId: attempt.sandboxId,
      resume: attempt.resume, startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt,
      findings: attempt.findings ?? [], attempt,
    }));
  }

  function directory(attempt: Attempt): string {
    return `/runs/${attempt.runId}/${attempt.taskId}/${attempt.attemptId}`;
  }

  // Output callbacks are synchronous; serialize their durable writes and drain before handoff.
  async function execute(attempt: Attempt, lastLineAt: Map<string, number>): Promise<void> {
    let pending = "";
    let writes = Promise.resolve();
    const line = (value: string) => {
      const timestamp = now().getTime();
      const last = lastLineAt.get(attempt.taskId);
      if (last !== undefined && timestamp - last < 500) return;
      lastLineAt.set(attempt.taskId, timestamp);
      writes = writes.then(async () => {
        if (await current(attempt)) {
          await event(attempt.runId, attempt.taskId, "agent.log", { line: value }, attempt.attemptId);
        }
      });
    };
    try {
      await sandboxes.exec(attempt.sandboxId!, "bash /mnt/archil/swarm/worker/run-task.sh", {
        env: { ...opts.workerEnv, RUN_ID: attempt.runId, TASK_ID: attempt.taskId,
          ATTEMPT_ID: attempt.attemptId, BASE_COMMIT: opts.baseCommit,
          RESUME: attempt.resume ? "1" : "0" },
        timeoutMs: opts.attemptTimeoutMs,
        onOutput(chunk) {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const value of lines) line(value);
        },
      });
    } finally {
      if (pending) line(pending);
      await writes;
    }
  }

  async function runUntilDone(runId: string): Promise<{ done: string[]; blocked: string[] }> {
    const plan = await store.getPlan(runId);
    if (!plan) throw new Error(`Unknown run: ${runId}`);
    const tasks = plan.tasks.filter((task) => task.kind === "task");
    const active = new Map<string, Promise<void>>();
    const busy = new Set<string>();
    const lastLineAt = new Map<string, number>();
    const failures = new Map<string, number>();
    for (const { event: recorded } of await store.listEvents(runId)) {
      if (recorded.type === "gate.result" && recorded.data.pass === false && recorded.taskId) {
        failures.set(recorded.taskId, (failures.get(recorded.taskId) ?? 0) + 1);
      }
    }

    async function recover(attempt: Attempt): Promise<Attempt | undefined> {
      if (!await current(attempt)) return undefined;
      if (!ports.recovery) {
        await store.updateAttempt(runId, attempt.attemptId, { state: "interrupted" });
        await event(runId, attempt.taskId, "attempt.interrupted", {}, attempt.attemptId);
        await status(runId, attempt.taskId, "blocked");
        return undefined;
      }
      const dispatch: Dispatch | undefined = await ports.recovery.onInterrupted(attempt);
      if (!dispatch) {
        if (await current(attempt)) await status(runId, attempt.taskId, "blocked");
        return undefined;
      }
      // Recovery owns creation; never recreate or overwrite its persisted attempt.
      const next = await store.currentAttempt(runId, attempt.taskId);
      if (!next || dispatch.runId !== runId || dispatch.taskId !== attempt.taskId
        || next.attemptId !== dispatch.attemptId || next.sandboxId !== dispatch.sandboxId) {
        throw new Error("Recovery returned a dispatch without a matching persisted attempt");
      }
      return next;
    }

    async function work(task: TaskSpec, first: Attempt): Promise<void> {
      let attempt = first;
      const reserved = new Set([first.sandboxId!]);
      try {
        for (;;) {
          if (!await current(attempt)) return;
          const sandboxId = attempt.sandboxId;
          if (!sandboxId) throw new Error("Attempt has no sandbox");
          if (!reserved.has(sandboxId)) {
            if (busy.has(sandboxId)) throw new Error("Recovery sandbox is already in use");
            busy.add(sandboxId);
            reserved.add(sandboxId);
          }
          await writeTask(task, attempt);
          await status(runId, task.id, "running");
          await event(runId, task.id, "attempt.started", {
            attemptId: attempt.attemptId, sandboxId, resume: attempt.resume,
          }, attempt.attemptId);
          let interrupted = false;
          try { await execute(attempt, lastLineAt); }
          catch { interrupted = true; }
          if (!await current(attempt)) return;
          let manifest: Manifest | undefined;
          if (!interrupted) {
            const raw = await disk.read(`${directory(attempt)}/manifest.json`);
            if (raw) {
              try { manifest = JSON.parse(raw) as Manifest; } catch { /* Recover incomplete writes. */ }
            }
          }
          if (!await current(attempt)) return;
          if (!manifest || manifest.runId !== runId || manifest.taskId !== task.id
            || manifest.attemptId !== attempt.attemptId) {
            const next = await recover(attempt);
            if (!next) return;
            attempt = next;
            continue;
          }
          await store.saveManifest(manifest);
          await store.updateAttempt(runId, attempt.attemptId, { state: "submitted" });
          const result = await ports.gate.check({ task, manifest, sandboxId });
          if (!await current(attempt)) return;
          await event(runId, task.id, "gate.result", { pass: result.pass, findings: result.findings }, attempt.attemptId);
          await store.updateAttempt(runId, attempt.attemptId, {
            state: result.pass ? "passed" : "failed", findings: result.findings,
          });
          if (!result.pass) {
            const count = (failures.get(task.id) ?? 0) + 1;
            failures.set(task.id, count);
            if (count > 1) {
              await status(runId, task.id, "blocked");
              return;
            }
            attempt = await newAttempt(runId, task, sandboxId, result.findings);
            continue;
          }
          await status(runId, task.id, "review");
          if (!await current(attempt)) return;
          const issues = await store.getIssueNumbers(runId);
          const pr = await publisher.openPullRequest({ runId, taskId: task.id,
            branch: manifest.branch, title: task.title,
            body: `${manifest.summary}${issues[task.id] ? `\n\nCloses #${issues[task.id]}` : ""}`,
          });
          if (!await current(attempt)) return;
          await event(runId, task.id, "pr.opened", pr, attempt.attemptId);
          if (ports.integrator) ports.integrator.enqueue(task, manifest, pr);
          else await status(runId, task.id, "done");
          return;
        }
      } catch (error) {
        ports.log?.(`Scheduler task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (await current(attempt)) {
          await store.updateAttempt(runId, attempt.attemptId, { state: "failed" });
          await status(runId, task.id, "blocked");
        }
      } finally {
        for (const sandboxId of reserved) busy.delete(sandboxId);
      }
    }

    for (;;) {
      const statuses = await store.getTaskStatuses(runId);
      // Propagate terminal dependency failures before selecting further work.
      let changed = false;
      for (const task of tasks) {
        const value = statuses[task.id] ?? "backlog";
        if ((value === "backlog" || value === "ready") && task.dependsOn.some((id) => statuses[id] === "blocked")) {
          await status(runId, task.id, "blocked");
          changed = true;
        }
      }
      if (changed) continue;
      if (tasks.every((task) => statuses[task.id] === "done" || statuses[task.id] === "blocked")) {
        await Promise.all(active.values());
        return { done: tasks.filter((task) => statuses[task.id] === "done").map((task) => task.id),
          blocked: tasks.filter((task) => statuses[task.id] === "blocked").map((task) => task.id) };
      }
      // A recovery hook (including restart recovery) can have already persisted a dispatch.
      // Adopt it without allocating a new attempt or a second sandbox lease.
      for (const task of tasks) {
        if (active.size >= opts.concurrency) break;
        if (statuses[task.id] !== "running" || active.has(task.id)) continue;
        const existing = await store.currentAttempt(runId, task.id);
        if (!existing?.sandboxId || existing.state !== "running") {
          await status(runId, task.id, "blocked");
          continue;
        }
        if (busy.has(existing.sandboxId)) continue;
        busy.add(existing.sandboxId);
        const job = work(task, existing).finally(() => { active.delete(task.id); });
        active.set(task.id, job);
      }
      const candidates = readyTasks(plan, statuses).filter((task) => !active.has(task.id));
      for (const task of candidates) {
        if (active.size >= opts.concurrency) break;
        const sandboxId = pool.find((id) => !busy.has(id));
        if (!sandboxId) break;
        busy.add(sandboxId);
        let attempt: Attempt;
        try { attempt = await newAttempt(runId, task, sandboxId); }
        catch (error) { busy.delete(sandboxId); throw error; }
        const job = work(task, attempt).finally(() => { active.delete(task.id); });
        active.set(task.id, job);
      }
      // With no workers or integrator handoff, remaining backlog cannot make progress.
      if (active.size === 0 && !tasks.some((task) => statuses[task.id] === "review" || statuses[task.id] === "running")) {
        for (const task of tasks) {
          if (statuses[task.id] !== "done" && statuses[task.id] !== "blocked") {
            await status(runId, task.id, "blocked");
          }
        }
        continue;
      }
      await Promise.race([...active.values(), pause()]);
    }
  }

  return { runUntilDone };
}
