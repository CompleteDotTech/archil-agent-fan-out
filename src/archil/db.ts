import type { Disk } from 'disk';
export interface Db {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(stmts: { sql: string; params?: unknown[] }[]): Promise<void>;
}
export function archilDb(disk: Disk, path: string): Db { throw new Error('not implemented'); }
export function nodeSqliteDb(filename = ':memory:'): Db { throw new Error('not implemented'); }
