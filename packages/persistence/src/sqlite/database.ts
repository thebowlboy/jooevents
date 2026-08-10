import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../schema';

export type SQLiteDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenSQLiteResult {
  readonly sqlite: Database;
  readonly db: SQLiteDatabase;
}

export function openSQLite(path: string, options: { readonly migrate?: boolean } = {}): OpenSQLiteResult {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  if (options.migrate !== false) {
    const migration = readFileSync(new URL('../../migrations/sqlite/0001_identity_access.sql', import.meta.url), 'utf8');
    sqlite.exec(migration);
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
