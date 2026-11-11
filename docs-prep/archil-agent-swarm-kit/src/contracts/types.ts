// src/contracts/types.ts
// FROZEN after Layer 0. Every workstream builds against these types and ports.
// Only the root orchestrator may change this file; it then tells workstreams to merge main.

// ---------- Plan ----------

export type TaskStatus = "backlog" | "ready" | "running" | "review" | "done" | "blocked";

export interface TaskSpec {
  id: string; // stable within a run, e.g. "T2"
  title: string;
  kind: "epic" | "task";
  parent?: string; // epic id (tasks only)
  dependsOn: string[]; // task ids that must be DONE (merged) before this one is dispatched
  owns: string[]; // globs in the TARGET repo this task may change; parallel tasks must not overlap
  acceptance: string[]; // human-readable criteria (rendered into the GitHub issue)
  verify: string[]; // shell commands run in the worker checkout; every one must exit 0
  research?: string[]; // Keenable queries the planner runs before dispatch
  prompt?: string; // extra instructions for the coding agent
}

export interface Plan {
  runId: string;
  brief: string;
  targetRepo: string; // "owner/name"
  baseBranch: string; // usually "main"
  tasks: TaskSpec[]; // epics and tasks
}

// ---------- Execution ----------

export type AttemptState = "running" | "interrupted" | "submitted" | "passed" | "failed";

export interface Attempt {
  runId: string;
  taskId: string;
  attemptId: string; // `${taskId}-a${n}`
  n: number; // 1, 2, ...
  sandboxId?: string;
  resume: boolean; // true when this attempt continues an interrupted one in the same sandbox
  state: AttemptState;
  startedAt: string; // ISO 8601
  deadlineAt: string; // ISO 8601
  findings?: string[]; // gate findings fed into a retry
}

export interface CheckResult {
  cmd: string;
  exitCode: number;
  logPath?: string; // path on the shared disk
}

// Written by the worker to /runs/<run>/<task>/<attempt>/manifest.json on the shared disk.
export interface Manifest {
  runId: string;
  taskId: string;
  attemptId: string;
  baseCommit: string;
  headCommit: string;
  branch: string; // pushed attempt branch: swarm/<run>/<task>/<attempt>
  changedFiles: string[];
  checks: CheckResult[];
  summary: string; // first part of the agent's final message
  status: "complete" | "failed";
}

export interface GateResult {
  pass: boolean;
  findings: string[];
}

// What the scheduler needs to (re)start a worker.
export interface Dispatch {
  runId: string;
  taskId: string;
  attemptId: string;
  n: number;
  sandboxId: string;
  resume: boolean;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

// ---------- Events (dashboard + audit trail) ----------
// type is one of:
//   run.started {brief} | plan.published {issues} | research.done {taskId, count, sourcesPath}
//   task.status {status} | attempt.started {attemptId, sandboxId, resume} | attempt.interrupted {attemptId}
//   agent.log {line} | gate.result {pass, findings} | pr.opened {number, url} | pr.merged {number}
//   integration.result {pass, output} | run.done {reportPath}
export interface SwarmEvent {
  runId: string;
  taskId?: string;
  attemptId?: string;
  at: string; // ISO 8601
  type: string;
  data: Record<string, unknown>;
}

// ---------- Ports (one implementation per workstream; fakes in src/contracts/fakes.ts) ----------

// Workstream C. Archil SQLite. Single writer: the orchestrator process.
export interface Store {
  init(): Promise<void>;
  savePlan(plan: Plan): Promise<void>;
  getPlan(runId: string): Promise<Plan | undefined>;
  setTaskStatus(runId: string, taskId: string, status: TaskStatus): Promise<void>;
  getTaskStatuses(runId: string): Promise<Record<string, TaskStatus>>;
  createAttempt(attempt: Attempt): Promise<void>;
  updateAttempt(runId: string, attemptId: string, patch: Partial<Attempt>): Promise<void>;
  currentAttempt(runId: string, taskId: string): Promise<Attempt | undefined>;
  listAttempts(runId: string): Promise<Attempt[]>;
  saveManifest(manifest: Manifest): Promise<void>;
  setIssueNumber(runId: string, taskId: string, issue: number): Promise<void>;
  getIssueNumbers(runId: string): Promise<Record<string, number>>;
  appendEvent(event: SwarmEvent): Promise<void>;
  listEvents(runId: string, afterIndex?: number): Promise<{ index: number; event: SwarmEvent }[]>;
}

// Workstream C. The Archil shared disk as seen from the orchestrator (paths are disk-relative, start with "/").
export interface SharedDisk {
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string | undefined>; // undefined when the file does not exist
  list(prefix: string): Promise<string[]>;
}

// Workstream A. Keenable.
export interface Research {
  search(query: string, opts?: { maxResults?: number; site?: string }): Promise<Source[]>;
  fetch(url: string): Promise<string>; // page as markdown ("" on failure)
}

// Workstream A.
export interface Planner {
  plan(input: { runId: string; brief: string; targetRepo: string; baseBranch?: string }): Promise<Plan>;
}

// Workstream B. GitHub. Only the orchestrator calls it (one paced queue).
export interface Publisher {
  publishPlan(plan: Plan): Promise<Record<string, number>>; // taskId -> issue number
  setStatus(runId: string, taskId: string, status: TaskStatus): Promise<void>;
  openPullRequest(input: {
    runId: string;
    taskId: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  mergePullRequest(prNumber: number): Promise<{ mergeCommit: string }>;
  comment(runId: string, taskId: string, body: string): Promise<void>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Workstream C. Archil sandboxes.
export interface SandboxRunner {
  // Creates the template sandbox (shared disk mounted conditional at /mnt/archil), clones the target
  // repo to /repo, installs the Codex CLI, runs `setup` commands in /repo, records HEAD, then stops it.
  prepareTemplate(input: {
    runId: string;
    targetRepo: string;
    setup: string[];
  }): Promise<{ templateId: string; baseCommit: string }>;
  fork(templateId: string, count: number): Promise<string[]>; // running forks, disk mounted
  exec(
    sandboxId: string,
    cmd: string,
    opts?: { env?: Record<string, string>; onOutput?: (chunk: string) => void; timeoutMs?: number },
  ): Promise<ExecResult>; // rejects if the sandbox stops mid-command or the timeout hits
  stop(sandboxId: string): Promise<void>;
  start(sandboxId: string): Promise<void>;
  remove(sandboxId: string): Promise<void>;
}

// Workstream D.
export interface Gate {
  check(input: { task: TaskSpec; manifest: Manifest; sandboxId: string }): Promise<GateResult>;
}

// Workstream D. Hooks the scheduler calls.
export interface RecoveryHooks {
  // Called when a worker's exec ends without a manifest (sandbox stopped, crashed or timed out).
  // Returns the next attempt to dispatch, or undefined to give up (task -> blocked).
  onInterrupted(attempt: Attempt): Promise<Dispatch | undefined>;
}

export interface IntegratorHooks {
  // Called after the gate passes and the PR is open. Merges sequentially and runs the final checks.
  enqueue(task: TaskSpec, manifest: Manifest, pr: { number: number; url: string }): void;
}

// ---------- Environment variables (read only in src/compose.ts and scripts/) ----------
// ARCHIL_API_KEY, ARCHIL_REGION (aws-us-west-2), ARCHIL_DISK_ID
// GITHUB_TOKEN (orchestrator: issues, PRs, contents, org Projects)
// GITHUB_PUSH_TOKEN (sandboxes: contents read/write on the target repo only)
// OPENAI_API_KEY (planner; passed to sandboxes as CODEX_API_KEY)
// KEENABLE_API_KEY (optional; keyless public endpoints otherwise)
// GITHUB_PROJECT_ID, GITHUB_STATUS_FIELD_ID (optional; Project status sync)
