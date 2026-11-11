import type { Attempt, SwarmEvent } from '../contracts/types.js';

/** Counts include attempts with invalid start times; durations exclude those attempts. */
export interface ExecutionMetrics {
  attemptCount: number;
  /** Attempts interrupted in stored state or by an interruption event, counted once each. */
  interruptedCount: number;
  /** Sum of active attempt intervals in milliseconds; parallel execution is additive. */
  durationMs: number;
  /** Wall time from earliest valid start to latest end, including pauses between attempts. */
  elapsedMs: number;
}

/** Tasks are keyed by taskId. Pass one run's attempts/events for a per-run report. */
export interface SwarmMetrics {
  tasks: Record<string, ExecutionMetrics>;
  total: ExecutionMetrics;
}

interface Accumulator {
  metrics: ExecutionMetrics;
  start?: number;
  end?: number;
}

const empty = (): Accumulator => ({
  metrics: { attemptCount: 0, interruptedCount: 0, durationMs: 0, elapsedMs: 0 },
});

function terminal(event: SwarmEvent): boolean {
  return event.type === 'attempt.interrupted' || event.type === 'gate.result'
    || (event.type === 'task.status' && (event.data.status === 'done' || event.data.status === 'blocked'));
}

function matches(event: SwarmEvent, attempt: Attempt): boolean {
  return event.runId === attempt.runId
    && (event.attemptId ?? event.data.attemptId) === attempt.attemptId
    && (event.taskId === undefined || event.taskId === attempt.taskId);
}

function add(acc: Accumulator, interrupted: boolean, start: number, end: number): void {
  acc.metrics.attemptCount++;
  if (interrupted) acc.metrics.interruptedCount++;
  if (!Number.isFinite(start)) return;
  // An invalid injected now cannot contribute an endpoint; retain the valid start.
  const clampedEnd = Number.isFinite(end) ? Math.max(start, end) : start;
  acc.metrics.durationMs += clampedEnd - start;
  acc.start = Math.min(acc.start ?? start, start);
  acc.end = Math.max(acc.end ?? clampedEnd, clampedEnd);
  acc.metrics.elapsedMs = acc.end - acc.start;
}

/**
 * Calculate execution metrics without mutating inputs. The earliest valid matching
 * interruption, gate result, or terminal task status ends an attempt. Duplicate and
 * later terminal events cannot add time. Missing/invalid endpoints use `now` (defaults
 * to the current time); invalid starts contribute counts only, and negative intervals
 * become zero. Stored state alone has no timestamp and therefore cannot end an interval.
 * Resumed attempts count separately; their downtime appears only in elapsedMs.
 * Only tasks represented by attempts appear in the result. Total elapsedMs is the
 * overall span, not the sum of task elapsed times.
 */
export function calculateMetrics(
  attempts: Attempt[], events: SwarmEvent[], now: Date = new Date(),
): SwarmMetrics {
  const tasks = new Map<string, Accumulator>();
  const total = empty();
  for (const attempt of attempts) {
    let end = Infinity;
    let interrupted = attempt.state === 'interrupted';
    for (const event of events) {
      if (!matches(event, attempt)) continue;
      if (event.type === 'attempt.interrupted') interrupted = true;
      if (!terminal(event)) continue;
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) end = Math.min(end, at);
    }
    if (end === Infinity) end = now.getTime();
    const start = Date.parse(attempt.startedAt);
    const task = tasks.get(attempt.taskId) ?? empty();
    tasks.set(attempt.taskId, task);
    add(task, interrupted, start, end);
    add(total, interrupted, start, end);
  }
  return {
    tasks: Object.fromEntries([...tasks].map(([id, value]) => [id, value.metrics])),
    total: total.metrics,
  };
}
