import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  SQLITE_MIGRATION_MANIFEST,
  canonicalSQLiteTarget,
  captureSQLiteSchema,
  fingerprintSQLiteSchema,
  listSQLiteOwners,
  openSQLite
} from '@jooevents/persistence';
import { loadConfig, type ConfiguredServerConfig } from '../config';
import {
  createConfiguredSQLiteAuthRuntime,
  type ConfiguredSQLiteAuthRuntime
} from './configured-sqlite-auth-runtime';

const temporaryDirectories: string[] = [];
const runtimes: ConfiguredSQLiteAuthRuntime[] = [];
const durableKey = (seed: number) => Buffer.alloc(32, seed).toString('base64url');

function cleanupTemporaryDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  const resolvedPath = realpathSync(path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !basename(path).startsWith('jooevents-configured-runtime-')
    || basename(resolvedPath) !== basename(path)
    || dirname(resolvedPath) !== realpathSync(tmpdir())
  ) {
    throw new Error(`unsafe_configured_runtime_test_cleanup:${path}`);
  }
  rmSync(path, { recursive: true });
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) cleanupTemporaryDirectory(directory);
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-configured-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

function configFor(dataDirectory: string): ConfiguredServerConfig {
  return loadConfig({
    JOOEVENTS_BASE_URL: 'http://localhost:5176',
    JOOEVENTS_TRUSTED_ORIGINS: '',
    JOOEVENTS_AUTH_SECRETS: `2:${'n'.repeat(32)},1:${'o'.repeat(32)}`,
    JOOEVENTS_REQUEST_HASH_KEYS: `2:${durableKey(1)},1:${durableKey(2)}`,
    JOOEVENTS_IDEMPOTENCY_KEYS: `2:${durableKey(3)},1:${durableKey(4)}`,
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `2:${durableKey(5)},1:${durableKey(6)}`,
    JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
    JOOEVENTS_DATABASE_DRIVER: 'sqlite',
    JOOEVENTS_DATABASE_PATH: 'jooevents.sqlite',
    JOOEVENTS_BLOB_DRIVER: 'filesystem',
    JOOEVENTS_DATA_DIRECTORY: dataDirectory
  });
}

function createRetainedDatabase(path: string): string {
  const database = openSQLite(path, {
    migrationPolicy: 'apply',
    databaseClass: 'retained_development'
  });
  const databaseId = database.migration.databaseId;
  database.sqlite.close();
  if (!databaseId) throw new Error('Retained test database did not receive an identity.');
  return databaseId;
}

function count(runtime: ConfiguredSQLiteAuthRuntime, table: string): number {
  return runtime.database.sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

describe('configured SQLite auth runtime', () => {
  test('reopens the retained epoch-2 baseline without adding runtime schema overlays', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'jooevents.sqlite');
    const databaseId = createRetainedDatabase(path);
    const config = configFor(directory);

    const first = createConfiguredSQLiteAuthRuntime({ config });
    runtimes.push(first);
    expect(first.database.migration).toMatchObject({
      status: 'current',
      coordinate: { schemaEpoch: 2, sequence: 1 },
      migrationId: 'e2_0001_jooevents_foundation',
      databaseClass: 'retained_development',
      databaseId,
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    });
    expect(fingerprintSQLiteSchema(captureSQLiteSchema(first.database.sqlite, 'full')))
      .toBe(SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint);
    expect(await (await first.app.request('/health')).json()).toEqual({ ok: true });
    const anonymous = await first.app.request('/api/me/access-context');
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toMatchObject({ state: 'anonymous' });

    const now = Date.parse('2026-08-13T00:00:00.000Z');
    first.database.sqlite.query(`
      INSERT INTO auth_users (
        id, name, email, email_verified, image, created_at, updated_at
      ) VALUES ('retained-user', 'Retained User', 'retained@example.com', 1, NULL, ?, ?)
    `).run(now, now);
    const workspaceId = first.workspaceId;
    expect(count(first, 'schema_migrations')).toBe(1);
    expect(count(first, 'bootstrap_state')).toBe(1);
    expect(count(first, 'workspaces')).toBe(1);
    expect(count(first, 'access_reservations')).toBe(1);
    expect(count(first, 'audit_events')).toBe(1);

    first.close();
    first.close();
    expect(listSQLiteOwners(canonicalSQLiteTarget(path))).toEqual([]);

    const reopened = createConfiguredSQLiteAuthRuntime({ config });
    runtimes.push(reopened);
    expect(reopened.workspaceId).toBe(workspaceId);
    expect(reopened.database.migration).toMatchObject({ status: 'current', databaseId });
    expect(reopened.database.sqlite.query<{ readonly email: string }, [string]>(
      'SELECT email FROM auth_users WHERE id = ?'
    ).get('retained-user')).toEqual({ email: 'retained@example.com' });
    expect(count(reopened, 'schema_migrations')).toBe(1);
    expect(count(reopened, 'bootstrap_state')).toBe(1);
    expect(count(reopened, 'workspaces')).toBe(1);
    expect(count(reopened, 'access_reservations')).toBe(1);
    expect(count(reopened, 'audit_events')).toBe(1);
    expect(fingerprintSQLiteSchema(captureSQLiteSchema(reopened.database.sqlite, 'full')))
      .toBe(SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint);
  });

  test('refuses a missing retained database without creating it', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'jooevents.sqlite');
    expect(() => createConfiguredSQLiteAuthRuntime({ config: configFor(directory) }))
      .toThrow('SQLite validation cannot create a missing database.');
    expect(existsSync(path)).toBe(false);
    expect(listSQLiteOwners(canonicalSQLiteTarget(path))).toEqual([]);
  });

  test('refuses schema drift and releases the lifetime owner', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'jooevents.sqlite');
    createRetainedDatabase(path);
    const drifted = new Database(path, { create: false, strict: true });
    drifted.exec('CREATE TABLE unexpected_runtime_table (id TEXT PRIMARY KEY);');
    drifted.close();

    expect(() => createConfiguredSQLiteAuthRuntime({ config: configFor(directory) })).toThrow();
    expect(listSQLiteOwners(canonicalSQLiteTarget(path))).toEqual([]);
  });

  test('closes the database when composition fails after a successful open', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'jooevents.sqlite');
    createRetainedDatabase(path);
    const invalidAfterOpen = { ...configFor(directory), baseUrl: 'not-a-url' };

    expect(() => createConfiguredSQLiteAuthRuntime({ config: invalidAfterOpen })).toThrow();
    expect(listSQLiteOwners(canonicalSQLiteTarget(path))).toEqual([]);
  });
});
