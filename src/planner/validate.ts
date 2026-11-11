import type { Plan, TaskSpec } from '../contracts/types.js';

/** Inspect all nodes, including epics, before filtering the execution order. */
function dependencyGraph(plan: Plan): {
  nodes: Map<string, TaskSpec>;
  order: string[];
  errors: string[];
} {
  const nodes = new Map<string, TaskSpec>();
  const errors: string[] = [];
  for (const task of plan.tasks) {
    if (nodes.has(task.id)) errors.push(`Duplicate id "${task.id}".`);
    else nodes.set(task.id, task);
  }

  const state = new Map<string, 'visiting' | 'visited'>();
  const path: string[] = [];
  const order: string[] = [];
  function visit(id: string): void {
    if (state.get(id) === 'visited') return;
    if (state.get(id) === 'visiting') {
      errors.push(`Dependency cycle: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}.`);
      return;
    }
    const task = nodes.get(id)!;
    state.set(id, 'visiting');
    path.push(id);
    for (const dependency of task.dependsOn) {
      if (!nodes.has(dependency)) {
        errors.push(`Task "${id}" depends on missing id "${dependency}".`);
      } else {
        visit(dependency);
      }
    }
    path.pop();
    state.set(id, 'visited');
    if (task.kind === 'task') order.push(id);
  }
  for (const id of nodes.keys()) visit(id);
  return { nodes, order, errors };
}

function dependenciesOf(id: string, nodes: Map<string, TaskSpec>): Set<string> {
  const reached = new Set<string>();
  const pending = [...(nodes.get(id)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    if (reached.has(dependency)) continue;
    reached.add(dependency);
    pending.push(...(nodes.get(dependency)?.dependsOn ?? []));
  }
  return reached;
}

function literalPrefix(glob: string): string {
  const wildcard = glob.search(/[*?\[{]/);
  return wildcard === -1 ? glob : glob.slice(0, wildcard);
}

export function validatePlan(plan: Plan, opts?: { maxTasks?: number }): { ok: boolean; errors: string[] } {
  const { nodes, errors } = dependencyGraph(plan);
  const tasks = plan.tasks.filter((task) => task.kind === 'task');
  const maxTasks = opts?.maxTasks ?? 6;

  if (!tasks.some((task) => task.dependsOn.length === 0)) {
    errors.push('Plan must contain at least one task with no dependencies.');
  }
  if (tasks.length > maxTasks) {
    errors.push(`Plan has ${tasks.length} tasks; maximum is ${maxTasks} (epics excluded).`);
  }
  for (const task of plan.tasks) {
    if (task.parent !== undefined) {
      const parent = nodes.get(task.parent);
      if (!parent) errors.push(`Task "${task.id}" has missing parent "${task.parent}".`);
      else if (parent.kind !== 'epic') errors.push(`Parent "${task.parent}" of "${task.id}" must be an epic.`);
    }
    if (task.kind === 'epic') {
      if (task.verify.length > 0) errors.push(`Epic "${task.id}" must have no verify commands.`);
    } else {
      if (task.owns.length === 0 || task.owns.some((glob) => glob.trim().length === 0)) {
        errors.push(`Task "${task.id}" must have at least one non-empty owns glob and no empty globs.`);
      }
      if (task.verify.length === 0 || task.verify.some((command) => command.trim().length === 0)) {
        errors.push(`Task "${task.id}" must have at least one non-empty verify command and no empty commands.`);
      }
    }
  }

  const reachable = new Map(tasks.map((task) => [task.id, dependenciesOf(task.id, nodes)]));
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const left = tasks[i];
      const right = tasks[j];
      if (reachable.get(left.id)!.has(right.id) || reachable.get(right.id)!.has(left.id)) continue;
      for (const leftGlob of left.owns) {
        for (const rightGlob of right.owns) {
          const leftPrefix = literalPrefix(leftGlob);
          const rightPrefix = literalPrefix(rightGlob);
          if (leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)) {
            errors.push(`Concurrent tasks "${left.id}" and "${right.id}" have overlapping owns globs "${leftGlob}" and "${rightGlob}".`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Dependencies first, with input order breaking ties. Invalid dependency graphs throw. */
export function topoOrder(plan: Plan): string[] {
  const { order, errors } = dependencyGraph(plan);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return order;
}
