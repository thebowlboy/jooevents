import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';

const temporaryDirectories: string[] = [];
const opened: OpenSQLiteResult[] = [];

afterEach(() => {
  while (opened.length) opened.pop()?.sqlite.close();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-runner-'));
  temporaryDirectories.push(directory);
  return join(directory, 'database.sqlite');
}

function expectFoundationError(work: () => unknown, code: SQLiteFoundationError['code']): SQLiteFoundationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return error as SQLiteFoundationError;
  }
  throw new Error(`Expected ${code}`);
}

function applicationRows(database: Database, selectedTableNames?: readonly string[]): string {
  const tableNames = selectedTableNames ?? database.query<{ name: string }, []>(`
    select name from pragma_table_list
     where schema = 'main' and type = 'table' and name not like 'sqlite_%'
       and name not in ('schema_migrations', 'schema_epoch_transitions', 'database_instance_metadata')
     order by name
  `).all().map((row) => row.name);
  const rows = tableNames.map((table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const values = database.query<Record<string, unknown>, []>(`select * from ${quoted}`).all()
      .map((row) => JSON.stringify(row))
      .sort();
    return [table, values] as const;
  });
  return JSON.stringify(rows);
}

describe('SQLite epoch-2 retained-baseline runner', () => {
  test('migrates an empty ephemeral database once with a terminal receipt', () => {
    const database = openSQLite(':memory:');
    opened.push(database);
    expect(database.migration).toMatchObject({
      status: 'applied',
      coordinate: { schemaEpoch: 2, sequence: 1 },
      migrationId: 'e2_0001_jooevents_foundation',
      databaseClass: 'ephemeral',
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    });
    expect(database.migration.databaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(database.sqlite.query<{ receipt_kind: string; checksum_sha256: string }, []>(
      'select receipt_kind, checksum_sha256 from schema_migrations'
    ).get()).toEqual({
      receipt_kind: 'executed',
      checksum_sha256: SQLITE_MIGRATION_MANIFEST.migrations[0].checksumSha256
    });
    expect(database.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('file creation requires a class and a replay remains one receipt', () => {
    const path = temporaryDatabasePath();
    expectFoundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'database_class_required');

    const first = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    const databaseId = first.migration.databaseId;
    expect(first.migration.status).toBe('applied');
    first.sqlite.close();

    const replay = openSQLite(path);
    opened.push(replay);
    expect(replay.migration).toMatchObject({ status: 'current', databaseClass: 'retained_development', databaseId });
    expect(replay.sqlite.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count).toBe(1);
  });

  test('validate is non-creating and reports an exact predecessor as migration-required', () => {
    const missing = temporaryDatabasePath();
    expect(existsSync(missing)).toBe(false);
    expectFoundationError(() => openSQLite(missing, { migrationPolicy: 'validate' }), 'database_missing');
    expect(existsSync(missing)).toBe(false);

    const legacyPath = temporaryDatabasePath();
    const legacy = new Database(legacyPath, { create: true, strict: true });
    legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
    legacy.close();
    expectFoundationError(() => openSQLite(legacyPath), 'migration_required');
    expect(existsSync(`${legacyPath}-wal`)).toBe(false);
    expect(existsSync(`${legacyPath}-shm`)).toBe(false);
  });

  test('file classes are closed and checked against durable metadata', () => {
    const ephemeralPath = temporaryDatabasePath();
    expectFoundationError(
      () => openSQLite(ephemeralPath, { migrationPolicy: 'apply', databaseClass: 'ephemeral' }),
      'database_class_mismatch'
    );

    const frozenPath = temporaryDatabasePath();
    const frozen = openSQLite(frozenPath, { migrationPolicy: 'apply', databaseClass: 'frozen_release' });
    expect(frozen.migration.databaseClass).toBe('frozen_release');
    frozen.sqlite.close();
    expectFoundationError(
      () => openSQLite(frozenPath, { databaseClass: 'retained_development' }),
      'database_class_mismatch'
    );
  });

  test('adopts only the exact legacy shape and preserves every application row', () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec('PRAGMA foreign_keys = ON;');
    legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    legacy.query('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)')
      .run('auth_legacy', 'Legacy Owner', 'legacy@example.com', now, now);
    legacy.query('insert into workspaces (id, name, state, created_at, updated_at, version) values (?, ?, ?, ?, ?, 1)')
      .run('workspace_legacy', 'Legacy Workspace', 'active', now, now);
    legacy.query('insert into events (id, workspace_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)')
      .run('event_legacy', 'workspace_legacy', 'Legacy Event', now, now);
    const predecessorTables = legacy.query<{ name: string }, []>(`
      SELECT name FROM pragma_table_list
       WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name
    `).all().map((row) => row.name);
    const before = applicationRows(legacy, predecessorTables);
    legacy.close();

    const adopted = openSQLite(path, { migrationPolicy: 'apply' });
    opened.push(adopted);
    expect(adopted.migration).toMatchObject({
      status: 'bridged',
      coordinate: { schemaEpoch: 2, sequence: 1 },
      databaseClass: 'retained_development'
    });
    expect(adopted.sqlite.query<{ receipt_kind: string }, []>(
      'SELECT receipt_kind FROM schema_migrations ORDER BY schema_epoch,sequence'
    ).all().map((row) => row.receipt_kind)).toEqual(['legacy_adoption', 'epoch_bridge']);
    expect(applicationRows(adopted.sqlite, predecessorTables)).toBe(before);
  });

  test('a partial legacy schema refuses without inventing runner receipts', () => {
    const path = temporaryDatabasePath();
    const partial = new Database(path, { create: true, strict: true });
    partial.exec('CREATE TABLE auth_users (id TEXT PRIMARY KEY);');
    partial.close();

    const error = expectFoundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'schema_drift');
    expect(Array.isArray(error.details.differences)).toBe(true);
    const inspection = new Database(path, { readonly: true, create: false, strict: true });
    expect(inspection.query<{ count: number }, []>(
      "select count(*) as count from sqlite_schema where name = 'schema_migrations'"
    ).get()?.count).toBe(0);
    inspection.close();
  });

  test('a partial runner schema is a runner refusal, not legacy adoption', () => {
    const path = temporaryDatabasePath();
    const partial = new Database(path, { create: true, strict: true });
    partial.exec('CREATE TABLE schema_migrations (migration_id TEXT PRIMARY KEY);');
    partial.close();
    expectFoundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'runner_schema_malformed');
  });

  test('matching receipts cannot conceal live schema drift', () => {
    const path = temporaryDatabasePath();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    const drifted = new Database(path, { create: false, strict: true });
    drifted.exec('CREATE TABLE unexpected_state (id TEXT PRIMARY KEY);');
    drifted.close();

    const error = expectFoundationError(() => openSQLite(path), 'schema_drift');
    expect(error.details.actualFingerprint).not.toBe(error.details.expectedFingerprint);
  });

  test('an unknown but physically valid receipt makes the chain malformed', () => {
    const path = temporaryDatabasePath();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.query(`
      insert into schema_migrations
        (migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
         source_fingerprint, result_fingerprint, transition_id, runner_version,
         build_identity, applied_at, duration_ms)
      values ('unknown_e1_0002', 1, 2, 'sqlite', ?, 'executed', ?, ?, null, 1, 'test', 0, 0)
    `).run(
      '0'.repeat(64),
      SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint,
      SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    );
    created.sqlite.close();

    expectFoundationError(() => openSQLite(path), 'receipt_chain_malformed');
  });

  test('migration receipts are append-only at the database boundary', () => {
    const database = openSQLite(':memory:');
    opened.push(database);
    expect(() => database.sqlite.exec("update schema_migrations set build_identity = 'changed';")).toThrow('append-only');
    expect(() => database.sqlite.exec('delete from schema_migrations;')).toThrow('append-only');
    expect(() => database.sqlite.exec("update database_instance_metadata set database_id = '00000000000000000000000000000000';"))
      .toThrow('identity is immutable');
    expect(() => database.sqlite.exec('delete from database_instance_metadata;')).toThrow('identity is durable');
  });

  test('the compatibility boolean maps to the explicit none policy', () => {
    const database = openSQLite(':memory:', { migrate: false });
    opened.push(database);
    expect(database.migration.status).toBe('skipped');
    expect(database.sqlite.query<{ count: number }, []>(
      "select count(*) as count from sqlite_schema where type = 'table' and name not like 'sqlite_%'"
    ).get()?.count).toBe(0);
  });
});
