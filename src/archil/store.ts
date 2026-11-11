import type { Attempt, Plan, Store, SwarmEvent, TaskStatus } from '../contracts/types.js';
import type { Db } from './db.js';

type JsonRow = { json: string };

// One writer process only: the orchestrator owns all mutations, including the
// read/modify/write in updateAttempt. Multi-statement writes use atomic batches.
export function createSqliteStore(db: Db): Store {
  const writeAttempt = (attempt: Attempt): Promise<void> => db.run(
    `INSERT INTO attempts (run_id, attempt_id, task_id, n, started_at, json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, attempt_id) DO UPDATE SET
       task_id = excluded.task_id, n = excluded.n,
       started_at = excluded.started_at, json = excluded.json`,
    [attempt.runId, attempt.attemptId, attempt.taskId, attempt.n,
      attempt.startedAt, JSON.stringify(attempt)],
  );

  return {
    async init() {
      await db.batch([
        { sql: `CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY, json TEXT NOT NULL
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS tasks (
          run_id TEXT NOT NULL, task_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'backlog', issue_number INTEGER,
          PRIMARY KEY (run_id, task_id)
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS attempts (
          run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL,
          n INTEGER NOT NULL, started_at TEXT NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (run_id, attempt_id)
        )` },
        { sql: `CREATE INDEX IF NOT EXISTS attempts_current
          ON attempts (run_id, task_id, n DESC, started_at DESC)` },
        { sql: `CREATE TABLE IF NOT EXISTS manifests (
          run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (run_id, attempt_id)
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS events (
          idx INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, json TEXT NOT NULL
        )` },
        { sql: 'CREATE INDEX IF NOT EXISTS events_run ON events (run_id, idx)' },
      ]);
    },

    async savePlan(plan) {
      await db.batch([
        {
          sql: `INSERT INTO runs (run_id, json) VALUES (?, ?)
            ON CONFLICT (run_id) DO UPDATE SET json = excluded.json`,
          params: [plan.runId, JSON.stringify(plan)],
        },
        ...plan.tasks.map(task => ({
          // Existing rows retain status and issue number, including tasks
          // removed from a revised plan, matching the in-memory store.
          sql: `INSERT INTO tasks (run_id, task_id, status) VALUES (?, ?, ?)
            ON CONFLICT (run_id, task_id) DO NOTHING`,
          params: [plan.runId, task.id, 'backlog'],
        })),
      ]);
    },

    async getPlan(runId) {
      const [row] = await db.all<JsonRow>('SELECT json FROM runs WHERE run_id = ?', [runId]);
      return row ? JSON.parse(row.json) as Plan : undefined;
    },

    async setTaskStatus(runId, taskId, status) {
      await db.run(
        `INSERT INTO tasks (run_id, task_id, status) VALUES (?, ?, ?)
         ON CONFLICT (run_id, task_id) DO UPDATE SET status = excluded.status`,
        [runId, taskId, status],
      );
    },

    async getTaskStatuses(runId) {
      const rows = await db.all<{ task_id: string; status: TaskStatus }>(
        'SELECT task_id, status FROM tasks WHERE run_id = ?', [runId],
      );
      return Object.fromEntries(rows.map(row => [row.task_id, row.status]));
    },

    createAttempt: writeAttempt,

    async updateAttempt(runId, attemptId, patch) {
      const [row] = await db.all<JsonRow>(
        'SELECT json FROM attempts WHERE run_id = ? AND attempt_id = ?', [runId, attemptId],
      );
      if (!row) throw new Error(`Unknown attempt: ${attemptId}`);
      const attempt = JSON.parse(row.json) as Attempt;
      await writeAttempt({ ...attempt, ...patch, runId, attemptId });
    },

    async currentAttempt(runId, taskId) {
      const [row] = await db.all<JsonRow>(
        `SELECT json FROM attempts WHERE run_id = ? AND task_id = ?
         ORDER BY n DESC, started_at DESC, attempt_id DESC LIMIT 1`,
        [runId, taskId],
      );
      return row ? JSON.parse(row.json) as Attempt : undefined;
    },

    async listAttempts(runId) {
      const rows = await db.all<JsonRow>(
        'SELECT json FROM attempts WHERE run_id = ? ORDER BY rowid ASC', [runId],
      );
      return rows.map(row => JSON.parse(row.json) as Attempt);
    },

    async saveManifest(manifest) {
      await db.run(
        `INSERT INTO manifests (run_id, attempt_id, json) VALUES (?, ?, ?)
         ON CONFLICT (run_id, attempt_id) DO UPDATE SET json = excluded.json`,
        [manifest.runId, manifest.attemptId, JSON.stringify(manifest)],
      );
    },

    async setIssueNumber(runId, taskId, issue) {
      await db.run(
        `INSERT INTO tasks (run_id, task_id, issue_number) VALUES (?, ?, ?)
         ON CONFLICT (run_id, task_id) DO UPDATE SET issue_number = excluded.issue_number`,
        [runId, taskId, issue],
      );
    },

    async getIssueNumbers(runId) {
      const rows = await db.all<{ task_id: string; issue_number: number }>(
        'SELECT task_id, issue_number FROM tasks WHERE run_id = ? AND issue_number IS NOT NULL',
        [runId],
      );
      return Object.fromEntries(rows.map(row => [row.task_id, row.issue_number]));
    },

    async appendEvent(event) {
      await db.run('INSERT INTO events (run_id, json) VALUES (?, ?)',
        [event.runId, JSON.stringify(event)]);
    },

    async listEvents(runId, afterIndex = 0) {
      const rows = await db.all<JsonRow & { idx: number }>(
        'SELECT idx, json FROM events WHERE run_id = ? AND idx > ? ORDER BY idx ASC',
        [runId, afterIndex],
      );
      return rows.map(row => ({ index: row.idx, event: JSON.parse(row.json) as SwarmEvent }));
    },
  };
}
