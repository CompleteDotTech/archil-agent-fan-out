import type { Plan, TaskSpec, TaskStatus } from "../contracts/types.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ["ready", "running", "blocked"],
  ready: ["running", "blocked"],
  running: ["review", "blocked"],
  review: ["done", "blocked", "running"],
  done: [],
  blocked: [],
};

/** Select dispatchable tasks in plan order, after all dependencies have merged. */
export function readyTasks(plan: Plan, statuses: Record<string, TaskStatus>): TaskSpec[] {
  return plan.tasks.filter((task) => {
    const status = statuses[task.id] ?? "backlog";
    return task.kind === "task"
      && (status === "backlog" || status === "ready")
      && task.dependsOn.every((dependency) => statuses[dependency] === "done");
  });
}

export function attemptId(taskId: string, n: number): string {
  return `${taskId}-a${n}`;
}

/** Terminal tasks can retain their status but cannot re-enter the lifecycle. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || transitions[from].includes(to);
}
