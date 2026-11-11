import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixturePlanner, MemoryDisk, MemoryStore, PassGate, RecordingPublisher } from "../../src/contracts/fakes.js";
import type {
  Attempt, Dispatch, ExecResult, Gate, IntegratorHooks, Manifest,
  RecoveryHooks, SandboxRunner, TaskStatus,
} from "../../src/contracts/types.js";
import { attemptId, canTransition, readyTasks } from "../../src/orchestrator/state.js";

// D1's implementation is developed in another worktree. Keep this suite typecheckable
// before it lands, while exercising the real public module when tests are run.
type SchedulerFactory = (ports: {
  store: MemoryStore; publisher: RecordingPublisher; sandboxes: SandboxRunner;
  gate: Gate; disk: MemoryDisk; recovery?: RecoveryHooks; integrator?: IntegratorHooks;
  now?: () => Date;
}, opts: {
  concurrency: number; attemptTimeoutMs: number; baseCommit: string;
  workerEnv: Record<string, string>; sandboxPool: string[]; pollMs?: number; workerScriptPath?: string;
}) => { runUntilDone(runId: string): Promise<{ done: string[]; blocked: string[] }> };

interface Execution {
  sandboxId: string;
  cmd: string;
  opts: NonNullable<Parameters<SandboxRunner["exec"]>[2]>;
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  active: boolean;
}

class ControlledSandboxes implements SandboxRunner {
  readonly executions: Execution[] = [];
  maxActive = 0;
  readonly collisions: string[] = [];

  async prepareTemplate(): Promise<{ templateId: string; baseCommit: string }> {
    throw new Error("Scheduler must use its supplied sandbox pool");
  }
  async fork(): Promise<string[]> { throw new Error("Unexpected fork"); }
  async stop(): Promise<void> {}
  async start(): Promise<void> {}
  async remove(): Promise<void> {}

  exec(sandboxId: string, cmd: string, opts: Execution["opts"] = {}): Promise<ExecResult> {
    if (this.executions.some((execution) => execution.active && execution.sandboxId === sandboxId)) {
      this.collisions.push(sandboxId);
    }
    return new Promise((resolve, reject) => {
      const execution: Execution = {
        sandboxId, cmd, opts, active: true,
        resolve: (result) => { execution.active = false; resolve(result); },
        reject: (error) => { execution.active = false; reject(error); },
      };
      this.executions.push(execution);
      this.maxActive = Math.max(this.maxActive, this.executions.filter((item) => item.active).length);
    });
  }
}

const runId = "scheduler-test";
const baseCommit = "base-sha";
const pathFor = (taskId: string, id: string, file: string) => `/runs/${runId}/${taskId}/${id}/${file}`;
const taskOf = (execution: Execution) => execution.opts.env!.TASK_ID!;
const idOf = (execution: Execution) => execution.opts.env!.ATTEMPT_ID!;

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let tick = 0; tick < 100; tick++) {
    if (await predicate()) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("Scheduler did not reach the expected state within 100 poll intervals");
}

async function harness(options: { concurrency?: number; poolSize?: number; single?: boolean; gate?: Gate; workerScriptPath?: string } = {}) {
  const store = new MemoryStore();
  const disk = new MemoryDisk();
  const publisher = new RecordingPublisher();
  const sandboxes = new ControlledSandboxes();
  const plan = await new FixturePlanner().plan({ runId, brief: "test", targetRepo: "local/test" });
  if (options.single) plan.tasks = plan.tasks.filter((task) => task.id === "T1");
  await store.savePlan(plan);
  const integrations: string[] = [];
  const integrationStatuses: TaskStatus[] = [];
  const integrator: IntegratorHooks = {
    enqueue(task) {
      integrations.push(task.id);
      // enqueue is synchronous; completion deliberately arrives on a later poll.
      void store.getTaskStatuses(runId).then((statuses) => integrationStatuses.push(statuses[task.id]!));
      setTimeout(() => { void store.setTaskStatus(runId, task.id, "done"); }, 3);
    },
  };
  const ports = { store, disk, publisher, sandboxes, gate: options.gate ?? new PassGate(), integrator };
  const schedulerModule = "../../src/orchestrator/scheduler.js";
  const { createScheduler } = await import(schedulerModule) as { createScheduler: SchedulerFactory };
  const start = (recovery?: RecoveryHooks) => {
    const scheduler = createScheduler({ ...ports, recovery }, {
      concurrency: options.concurrency ?? 3, attemptTimeoutMs: 10_000,
      baseCommit, workerEnv: { AGENT: "fake", PUSH: "0" },
      sandboxPool: Array.from({ length: options.poolSize ?? 3 }, (_, i) => `sandbox-${i}`), pollMs: 1,
      workerScriptPath: options.workerScriptPath,
    });
    let result: { done: string[]; blocked: string[] } | undefined;
    let failure: unknown;
    void scheduler.runUntilDone(runId).then((value) => { result = value; }, (error: unknown) => { failure = error; });
    return {
      async finish() {
        await eventually(() => result !== undefined || failure !== undefined);
        if (failure !== undefined) throw failure;
        return result!;
      },
      settled: () => result !== undefined || failure !== undefined,
    };
  };
  async function complete(execution: Execution, patch: Partial<Manifest> = {}) {
    const taskId = taskOf(execution);
    const manifest: Manifest = {
      runId, taskId, attemptId: idOf(execution), baseCommit, headCommit: "head-sha",
      branch: `swarm/${runId}/${taskId}/${idOf(execution)}`, changedFiles: [],
      checks: [], summary: `Completed ${taskId}`, status: "complete", ...patch,
    };
    await disk.write(pathFor(taskId, idOf(execution), "manifest.json"), JSON.stringify(manifest));
    execution.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
  return { ...ports, plan, integrations, integrationStatuses, start, complete };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("task state helpers", () => {
  it("selects only runnable tasks with merged dependencies, in plan order", async () => {
    const plan = await new FixturePlanner().plan({ runId, brief: "test", targetRepo: "local/test" });
    expect(readyTasks(plan, {}).map((task) => task.id)).toEqual(["T1"]);
    expect(readyTasks(plan, { T1: "review" })).toEqual([]);
    expect(readyTasks(plan, { T1: "blocked" })).toEqual([]);
    expect(readyTasks(plan, { T1: "done", T2: "running", T3: "ready", T4: "backlog" })
      .map((task) => task.id)).toEqual(["T3", "T4"]);
    expect(readyTasks(plan, { T1: "done", T2: "done", T3: "blocked", T4: "review" })).toEqual([]);
  });

  it("gives attempts stable, task-scoped identifiers", () => {
    expect(attemptId("T1", 1)).toBe("T1-a1");
    expect(attemptId("T2", 12)).toBe("T2-a12");
  });

  it("allows lifecycle steps and retries but fences terminal states", () => {
    for (const [from, to] of [
      ["backlog", "ready"], ["ready", "running"], ["running", "review"],
      ["review", "running"], ["review", "done"], ["running", "blocked"],
    ] as const) expect(canTransition(from, to)).toBe(true);
    for (const terminal of ["done", "blocked"] as const) {
      for (const target of ["backlog", "ready", "running", "review"] as const) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
    expect(canTransition("backlog", "done")).toBe(false);
    expect(canTransition("ready", "done")).toBe(false);
  });
});

describe("scheduler", () => {
  it("runs fixture T1 first, waits for integration, then runs T2–T4 in parallel", async () => {
    const h = await harness();
    const run = h.start();
    await eventually(() => h.sandboxes.executions.length === 1);
    const first = h.sandboxes.executions[0]!;
    expect(taskOf(first)).toBe("T1");
    expect(first.cmd).toContain("/mnt/archil/swarm/worker/run-task.sh");
    expect(first.opts.env).toMatchObject({ RUN_ID: runId, TASK_ID: "T1", ATTEMPT_ID: "T1-a1", BASE_COMMIT: baseCommit, RESUME: "0", AGENT: "fake", PUSH: "0" });
    expect(JSON.parse((await h.disk.read(pathFor("T1", "T1-a1", "task.json")))!)).toMatchObject(h.plan.tasks.find((task) => task.id === "T1")!);
    const attempt = await h.store.currentAttempt(runId, "T1");
    expect(attempt).toMatchObject({ runId, taskId: "T1", attemptId: "T1-a1", n: 1, sandboxId: first.sandboxId, resume: false, state: "running" });
    expect(Date.parse(attempt!.deadlineAt) - Date.parse(attempt!.startedAt)).toBe(10_000);
    await h.complete(first);
    await eventually(() => h.integrations.length === 1);
    expect(run.settled()).toBe(false);
    expect(h.sandboxes.executions).toHaveLength(1);
    await eventually(() => h.sandboxes.executions.length === 4);
    expect(h.sandboxes.executions.slice(1).map(taskOf).sort()).toEqual(["T2", "T3", "T4"]);
    expect(h.sandboxes.maxActive).toBe(3);
    expect(new Set(h.sandboxes.executions.slice(1).map((execution) => execution.sandboxId)).size).toBe(3);
    for (const execution of h.sandboxes.executions.slice(1)) await h.complete(execution);
    expect(await run.finish()).toEqual({ done: ["T1", "T2", "T3", "T4"], blocked: [] });
    expect(h.integrationStatuses).toEqual(["review", "review", "review", "review"]);
    expect(h.sandboxes.collisions).toEqual([]);
    expect(h.publisher.calls.filter((call) => call.method === "openPullRequest")).toHaveLength(4);
    expect(h.sandboxes.executions.map(taskOf)).not.toContain("EP1");
  });

  it.each([{ concurrency: 2, poolSize: 3 }, { concurrency: 3, poolSize: 1 }])(
    "bounds dispatch by concurrency $concurrency and pool size $poolSize", async (options) => {
      const h = await harness(options);
      const run = h.start();
      const limit = Math.min(options.concurrency, options.poolSize);
      await eventually(() => h.sandboxes.executions.length === 1);
      await h.complete(h.sandboxes.executions[0]!);
      await eventually(() => h.sandboxes.executions.length === 1 + limit);
      expect(h.sandboxes.executions.filter((execution) => execution.active)).toHaveLength(limit);
      for (let poll = 0; poll < 20 && !run.settled(); poll++) {
        for (const execution of h.sandboxes.executions.filter((item) => item.active)) await h.complete(execution);
        await vi.advanceTimersByTimeAsync(5);
        if (h.sandboxes.executions.length >= 4 && !h.sandboxes.executions.some((item) => item.active)) break;
      }
      expect((await run.finish()).done.sort()).toEqual(["T1", "T2", "T3", "T4"]);
      expect(h.sandboxes.maxActive).toBe(limit);
      expect(h.sandboxes.collisions).toEqual([]);
    },
  );

  it.each([false, true])("feeds gate findings into exactly one retry (retry passes: %s)", async (retryPasses) => {
    const check = vi.fn<Gate["check"]>()
      .mockResolvedValueOnce({ pass: false, findings: ["Outside owns: private.txt", "npm test exited 1"] })
      .mockResolvedValue({ pass: retryPasses, findings: retryPasses ? [] : ["Still failing"] });
    const h = await harness({ single: true, gate: { check } });
    const run = h.start();
    await eventually(() => h.sandboxes.executions.length === 1);
    await h.complete(h.sandboxes.executions[0]!);
    await eventually(() => h.sandboxes.executions.length === 2);
    const retry = h.sandboxes.executions[1]!;
    expect(idOf(retry)).toBe("T1-a2");
    expect(JSON.parse((await h.disk.read(pathFor("T1", "T1-a2", "task.json")))!))
      .toMatchObject({ id: "T1", findings: ["Outside owns: private.txt", "npm test exited 1"] });
    expect(h.publisher.calls.filter((call) => call.method === "openPullRequest")).toHaveLength(0);
    await h.complete(retry);
    expect(await run.finish()).toEqual(retryPasses ? { done: ["T1"], blocked: [] } : { done: [], blocked: ["T1"] });
    expect(check).toHaveBeenCalledTimes(2);
    expect(h.sandboxes.executions).toHaveLength(2);
    expect(h.integrations).toEqual(retryPasses ? ["T1"] : []);
    expect(await h.store.getTaskStatuses(runId)).toMatchObject({ T1: retryPasses ? "done" : "blocked" });
  });

  it.each(["missing", "rejected"] as const)("recovers an exec with a %s manifest using the supplied dispatch", async (mode) => {
    const h = await harness({ single: true, workerScriptPath:'/mnt/archil/swarm/run-isolated/worker.sh' });
    const interrupted: Attempt[] = [];
    const recovery: RecoveryHooks = {
      async onInterrupted(attempt) {
        interrupted.push(attempt);
        const next: Attempt = { ...attempt, n: 2, attemptId: "T1-a2", resume: true, state: "running" };
        await h.store.updateAttempt(runId, attempt.attemptId, { state: "interrupted" });
        await h.store.createAttempt(next);
        return { ...next, sandboxId: attempt.sandboxId! } satisfies Dispatch;
      },
    };
    const run = h.start(recovery);
    await eventually(() => h.sandboxes.executions.length === 1);
    const first = h.sandboxes.executions[0]!;
    if (mode === "missing") first.resolve({ exitCode: 0, stdout: "", stderr: "" });
    else first.reject(new Error("Sandbox stopped"));
    await eventually(() => h.sandboxes.executions.length === 2);
    const resumed = h.sandboxes.executions[1]!;
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ taskId: "T1", attemptId: "T1-a1" });
    expect(resumed.sandboxId).toBe(first.sandboxId);
    expect(resumed.cmd).toBe(first.cmd);
    expect(resumed.cmd).toContain('/swarm/run-isolated/worker.sh');
    expect(resumed.opts.env).toMatchObject({ ATTEMPT_ID: "T1-a2", RESUME: "1" });
    expect(h.integrations).toEqual([]);
    await h.complete(resumed);
    expect(await run.finish()).toEqual({ done: ["T1"], blocked: [] });
  });

  it('quotes a configured script path as one shell argument', async () => {
    const directory = mkdtempSync(join(tmpdir(),'swarm-script-'));
    const path = join(directory,"worker's $(printf substituted) script.sh");
    writeFileSync(path,'printf scoped-script');
    try {
      const h=await harness({single:true,workerScriptPath:path});
      const run=h.start();
      await eventually(()=>h.sandboxes.executions.length===1);
      const execution=h.sandboxes.executions[0]!;
      expect(execFileSync('bash',['-c',execution.cmd],{encoding:'utf8'})).toBe('scoped-script');
      await h.complete(execution);
      expect(await run.finish()).toEqual({done:['T1'],blocked:[]});
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });

  it("blocks an interrupted task when recovery gives up", async () => {
    const h = await harness({ single: true });
    const onInterrupted = vi.fn<RecoveryHooks["onInterrupted"]>().mockResolvedValue(undefined);
    const run = h.start({ onInterrupted });
    await eventually(() => h.sandboxes.executions.length === 1);
    h.sandboxes.executions[0]!.reject(new Error("Sandbox stopped"));
    expect(await run.finish()).toEqual({ done: [], blocked: ["T1"] });
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(h.integrations).toEqual([]);
  });

  it("never gates or publishes a stale manifest from a superseded attempt", async () => {
    const check = vi.fn<Gate["check"]>().mockResolvedValue({ pass: true, findings: [] });
    const h = await harness({ single: true, gate: { check } });
    const run = h.start();
    await eventually(() => h.sandboxes.executions.length === 1);
    const first = (await h.store.currentAttempt(runId, "T1"))!;
    await h.store.createAttempt({ ...first, attemptId: "T1-a2", n: 2, state: "submitted" });
    await h.store.setTaskStatus(runId, "T1", "review");
    await h.complete(h.sandboxes.executions[0]!);
    await vi.advanceTimersByTimeAsync(10);
    expect(check).not.toHaveBeenCalled();
    expect(h.publisher.calls.filter((call) => call.method === "openPullRequest")).toEqual([]);
    expect(h.integrations).toEqual([]);
    // The superseding owner determines the task's terminal state.
    await h.store.setTaskStatus(runId, "T1", "blocked");
    expect(await run.finish()).toEqual({ done: [], blocked: ["T1"] });
  });

  it("terminates with blocked descendants instead of waiting forever on dependencies", async () => {
    const h = await harness({ gate: { check: async () => ({ pass: false, findings: ["Failed verification"] }) } });
    const run = h.start();
    await eventually(() => h.sandboxes.executions.length === 1);
    await h.complete(h.sandboxes.executions[0]!);
    await eventually(() => h.sandboxes.executions.length === 2);
    await h.complete(h.sandboxes.executions[1]!);
    const result = await run.finish();
    expect(result.done).toEqual([]);
    expect(result.blocked.sort()).toEqual(["T1", "T2", "T3", "T4"]);
    expect(h.sandboxes.executions.map(taskOf)).toEqual(["T1", "T1"]);
    expect(await h.store.getTaskStatuses(runId)).toMatchObject({ T1: "blocked", T2: "blocked", T3: "blocked", T4: "blocked" });
  });

  it("records lifecycle and throttled output events with run, task and attempt identities", async () => {
    const h = await harness({ single: true });
    const run = h.start();
    await eventually(() => h.sandboxes.executions.length === 1);
    const execution = h.sandboxes.executions[0]!;
    execution.opts.onOutput!("first line\n");
    execution.opts.onOutput!("too soon\n");
    await vi.advanceTimersByTimeAsync(501);
    execution.opts.onOutput!("later line\n");
    await h.complete(execution);
    await run.finish();
    const events = (await h.store.listEvents(runId)).map(({ event }) => event);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId, taskId: "T1", type: "task.status", data: expect.objectContaining({ status: "running" }) }),
      expect.objectContaining({ runId, taskId: "T1", attemptId: "T1-a1", type: "attempt.started" }),
      expect.objectContaining({ runId, taskId: "T1", type: "gate.result", data: expect.objectContaining({ pass: true }) }),
      expect.objectContaining({ runId, taskId: "T1", type: "pr.opened", data: expect.objectContaining({ number: 100 }) }),
    ]));
    const logs = events.filter((event) => event.type === "agent.log");
    expect(logs).toHaveLength(2);
    expect(logs.map((event) => event.data.line)).toEqual(["first line", "later line"]);
    for (const event of logs) {
      expect(event).toMatchObject({ runId, taskId: "T1", attemptId: "T1-a1" });
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
    expect(Date.parse(logs[1]!.at) - Date.parse(logs[0]!.at)).toBeGreaterThanOrEqual(500);
  });
});
