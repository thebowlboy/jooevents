import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { Database } from 'bun:sqlite';
import { BETTER_AUTH_SCHEMA } from '../better-auth-schema-definition';

export * from '../better-auth-schema-definition';

/** Backward-compatible name for the schema used by the Bun SQLite adapter. */
export const SQLITE_BETTER_AUTH_SCHEMA = BETTER_AUTH_SCHEMA;

export type SQLiteBetterAuthDatabase = ReturnType<
  typeof drizzle<typeof SQLITE_BETTER_AUTH_SCHEMA>
>;

/** Creates the narrow ORM handle only at the Better Auth composition boundary. */
export function createSQLiteBetterAuthDatabase(sqlite: Database): SQLiteBetterAuthDatabase {
  return drizzle(sqlite, { schema: SQLITE_BETTER_AUTH_SCHEMA });
}
