import { DatabaseSync } from 'node:sqlite';
import { createDatabase, type SQLiteDatabase, type SQLiteValue } from '@archildata/sqlite';
import type { Disk } from 'disk';
export interface Db {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(stmts: { sql: string; params?: unknown[] }[]): Promise<void>;
}

function parameters(params: unknown[]): SQLiteValue[] {
  return params.map((value) => {
    if (value === null || typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'bigint' || value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return value;
    }
    throw new TypeError('Unsupported SQLite parameter type');
  });
}

function template(sql: string, count: number): TemplateStringsArray {
  const fragments: string[] = [];
  let start = 0;
  // Skip quoted identifiers, string literals, and comments when finding placeholders.
  const tokens = /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|\?/g;
  for (const match of sql.matchAll(tokens)) {
    if (match[0] !== '?') continue;
    fragments.push(sql.slice(start, match.index));
    start = match.index + 1;
  }
  fragments.push(sql.slice(start));
  if (fragments.length !== count + 1) {
    throw new TypeError('SQLite placeholder count does not match parameter count');
  }
  return Object.assign(fragments, { raw: [...fragments] });
}

export function archilDb(disk: Disk, path: string): Db {
  let database: Promise<SQLiteDatabase> | undefined;
  const getDatabase = () => database ??= createDatabase(disk, path).catch(error => {
    database = undefined;
    throw error;
  });
  // Every SDK operation uses a writable directory checkout, including reads
  // that can recover a journal. Serialize all of them through this one writer.
  let pending: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async run(sql, params = []) {
      const values = parameters(params);
      const strings = template(sql, values.length);
      await enqueue(async () => {
        const db = await getDatabase();
        await db.write(strings, ...values).run();
      });
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const values = parameters(params);
      const strings = template(sql, values.length);
      return enqueue(async () => {
        const db = await getDatabase();
        return await db.write<T>(strings, ...values).all();
      });
    },
    async batch(stmts) {
      if (stmts.length === 0) return;
      const prepared = stmts.map(({ sql, params = [] }) => {
        const values = parameters(params);
        return { strings: template(sql, values.length), values };
      });
      await enqueue(async () => {
        const db = await getDatabase();
        // Operations must stay deferred until the SDK starts the transaction.
        await db.transaction(prepared.map(({ strings, values }) => db.write(strings, ...values).run()));
      });
    },
  };
}

export function nodeSqliteDb(filename = ':memory:'): Db {
  const db = new DatabaseSync(filename);
  const bindings = (params: unknown[]) => parameters(params).map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value);

  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...bindings(params));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...bindings(params)) as T[];
    },
    async batch(stmts) {
      if (stmts.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const { sql, params = [] } of stmts) {
          db.prepare(sql).run(...bindings(params));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
