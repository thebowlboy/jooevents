import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createEphemeralSQLiteRuntime,
  type EphemeralSQLiteRuntime,
  type EphemeralSQLiteSchemaArtifact
} from './ephemeral-sqlite-runtime';
import {
  createFoundationEphemeralSQLiteRuntime,
  FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS
} from './foundation-ephemeral-sqlite-runtime';
import { SQLiteFoundationError } from './foundation-errors';
import { listSQLiteOwners, sqliteCoordinationPaths } from './file-ownership';
import { sha256Hex } from './migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import { captureSQLiteSchema, fingerprintSQLiteSchema } from './schema-snapshot';

const temporaryRoot = realpathSync(tmpdir());
const cleanupDirectories = new Set<string>();
const runtimePrefix = `jooevents-ephemeral-runtime-${process.pid}-`;
const fixturePrefix = 'jooevents-ephemeral-runtime-test-fixture-';

function trackRuntime(runtime: EphemeralSQLiteRuntime): EphemeralSQLiteRuntime {
  cleanupDirectories.add(runtime.directoryPath);
  return runtime;
}

function userFixture(): string {
  const directory = mkdtempSync(join(temporaryRoot, fixturePrefix));
  chmodSync(directory, 0o700);
  cleanupDirectories.add(directory);
  return directory;
}

function runtimeDirectories(): ReadonlySet<string> {
  return new Set(readdirSync(temporaryRoot)
    .filter((name) => name.startsWith(runtimePrefix) && !name.startsWith(fixturePrefix))
    .map((name) => join(temporaryRoot, name)));
}

function trackNewRuntimeDirectories(before: ReadonlySet<string>): readonly string[] {
  return [...runtimeDirectories()].filter((path) => !before.has(path));
}

function assertSafeTestCleanupTarget(path: string): void {
  const stat = lstatSync(path);
  const name = basename(path);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    dirname(path) !== temporaryRoot ||
    (!name.startsWith(runtimePrefix) && !name.startsWith(fixturePrefix))
  ) {
    throw new Error(`unsafe_test_cleanup_target:${path}`);
  }
}

afterEach(() => {
  for (const directory of cleanupDirectories) {
    if (!existsSync(directory)) continue;
    assertSafeTestCleanupTarget(directory);
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

function expectFoundationCode(
  operation: () => unknown,
  code: SQLiteFoundationError['code']
): SQLiteFoundationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return error as SQLiteFoundationError;
  }
  throw new Error(`expected_${code}`);
}

describe('ephemeral SQLite runtime', () => {
  test('owns one private epoch-1 file and explicitly retains the closed OS-temporary tree', () => {
    const runtime = trackRuntime(createEphemeralSQLiteRuntime([]));
    const markerPath = `${runtime.databasePath}.jooevents-ephemeral.json`;
    const ownersPath = sqliteCoordinationPaths(runtime.databasePath).owners;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;

    expect(runtime.kind).toBe('ephemeral_sqlite');
    expect(runtime.databasePath).toBe(join(runtime.directoryPath, 'runtime.sqlite'));
    expect(dirname(runtime.directoryPath)).toBe(temporaryRoot);
    expect(basename(runtime.directoryPath).startsWith(runtimePrefix)).toBe(true);
    expect(statSync(runtime.directoryPath).mode & 0o777).toBe(0o700);
    expect(statSync(runtime.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    expect(statSync(ownersPath).mode & 0o777).toBe(0o700);
    expect(runtime.retainedBaseline).toMatchObject({
      status: 'current',
      coordinate: { schemaEpoch: 1, sequence: 1 },
      migrationId: 'e1_0001_identity_access',
      databaseClass: 'ephemeral',
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    });
    expect(Object.isFrozen(runtime.retainedBaseline)).toBe(true);
    expect(marker).toMatchObject({
      formatVersion: 1,
      applicationKey: 'jooevents',
      canonicalDatabasePath: runtime.databasePath,
      databaseId: runtime.retainedBaseline.databaseId
    });
    expect(listSQLiteOwners(runtime.databasePath)).toEqual([
      expect.objectContaining({
        kind: 'ordinary',
        canonicalDatabasePath: runtime.databasePath,
        databaseId: runtime.retainedBaseline.databaseId,
        pid: process.pid
      })
    ]);
    expect(runtime.installedSchemaArtifacts).toEqual([]);
    expect(runtime.runtimeSchemaFingerprint).toBe(SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint);
    expect(runtime.schemaOverlayDigestSha256).toMatch(/^[0-9a-f]{64}$/);

    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    expect(first).toEqual({
      kind: 'closed_private_tree_retained',
      directoryPath: runtime.directoryPath
    });
    expect(existsSync(runtime.directoryPath)).toBe(true);
    expect(existsSync(runtime.databasePath)).toBe(true);
    expect(readdirSync(ownersPath)).toEqual([]);
    expect(() => runtime.sqlite.query('select 1').get()).toThrow();
  });

  test('installs declarative additive schema in exact order and reports its honest identity', () => {
    const artifacts: readonly EphemeralSQLiteSchemaArtifact[] = [
      {
        id: 'foundation-schema',
        sql: 'create table runtime_installation_order (ordinal integer primary key, artifact_id text not null unique);'
      },
      {
        id: 'event-schema',
        sql: 'create index runtime_installation_order_artifact_idx on runtime_installation_order(artifact_id);'
      }
    ];
    const first = trackRuntime(createEphemeralSQLiteRuntime(artifacts));
    const second = trackRuntime(createEphemeralSQLiteRuntime(artifacts));

    expect(first.installedSchemaArtifacts).toEqual(artifacts.map((artifact) => ({
      id: artifact.id,
      checksumSha256: sha256Hex(Buffer.from(artifact.sql, 'utf8'))
    })));
    expect(Object.isFrozen(first.installedSchemaArtifacts)).toBe(true);
    expect(first.sqlite.query<{ name: string }, []>(`
      select name from sqlite_schema
       where name in ('runtime_installation_order', 'runtime_installation_order_artifact_idx')
       order by name
    `).all()).toEqual([
      { name: 'runtime_installation_order' },
      { name: 'runtime_installation_order_artifact_idx' }
    ]);
    const actual = fingerprintSQLiteSchema(captureSQLiteSchema(first.sqlite, 'full'));
    expect(first.runtimeSchemaFingerprint).toBe(actual);
    expect(first.runtimeSchemaFingerprint).not.toBe(first.retainedBaseline.schemaFingerprint);
    expect(first.schemaOverlayDigestSha256).toBe(second.schemaOverlayDigestSha256);

    first.close();
    second.close();
  });

  test('composes the joined trial schema families through inert ordered artifacts', () => {
    const runtime = trackRuntime(createFoundationEphemeralSQLiteRuntime());

    expect(runtime.installedSchemaArtifacts.map((artifact) => artifact.id))
      .toEqual(FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS.map((artifact) => artifact.id));
    expect(FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS).toHaveLength(62);
    expect(Object.isFrozen(FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS)).toBe(true);
    expect(FOUNDATION_EPHEMERAL_SCHEMA_ARTIFACTS.every(Object.isFrozen)).toBe(true);
    expect(runtime.sqlite.query<{ count: number }, []>(`
      select count(*) as count
        from sqlite_schema
       where type in ('table', 'view') and name not like 'sqlite_%'
    `).get()?.count).toBe(265);
    expect(runtime.sqlite.query<{ name: string }, []>(`
      select name
        from sqlite_schema
       where type = 'table' and name in (
         'schedule_placement_sets',
         'schedule_occurrences',
         'schedule_placement_draft_receipt_links',
         'schedule_placement_changeset_receipt_links'
       )
       order by name collate binary
    `).all().map((row) => row.name)).toEqual([
      'schedule_occurrences',
      'schedule_placement_changeset_receipt_links',
      'schedule_placement_draft_receipt_links',
      'schedule_placement_sets'
    ]);
    expect(runtime.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(fingerprintSQLiteSchema(captureSQLiteSchema(runtime.sqlite, 'full')))
      .toBe(runtime.runtimeSchemaFingerprint);

    runtime.close();
  });

  test('rejects external-database and connection-control SQL before creating a runtime tree', () => {
    const fixture = userFixture();
    const escapedDatabase = join(fixture, 'escaped.sqlite');
    const before = runtimeDirectories();
    const invalidSql = [
      `attach database '${escapedDatabase.replaceAll("'", "''")}' as escaped; create table escaped.proof(value text); detach database escaped;`,
      `vacuum into '${escapedDatabase.replaceAll("'", "''")}';`,
      'pragma query_only=on;',
      'pragma ignore_check_constraints=on;',
      "create view unsafe_extension as select load_extension('/tmp/not-loaded');",
      'create table seeded_rows(id integer); insert into seeded_rows values (1);',
      'update workspaces set name = name;',
      'delete from workspaces;',
      'alter table workspaces add column unsafe text;',
      'drop table workspaces;',
      'reindex;',
      `
        create table deferred_write(id text);
        create trigger deferred_write_delete after insert on deferred_write begin
          delete from workspaces;
        end;
      `
    ];

    for (const [index, sql] of invalidSql.entries()) {
      expect(() => createEphemeralSQLiteRuntime([{ id: `unsafe-${index}`, sql }]))
        .toThrow('ephemeral_sqlite_schema_artifact_sql_invalid');
    }
    expect(trackNewRuntimeDirectories(before)).toEqual([]);
    expect(existsSync(escapedDatabase)).toBe(false);
  });

  test('refuses unsupported platform semantics before creating a runtime tree', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('process_platform_descriptor_missing');
    const before = runtimeDirectories();
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      expectFoundationCode(() => createEphemeralSQLiteRuntime([]), 'platform_unsupported');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
    expect(trackNewRuntimeDirectories(before)).toEqual([]);
  });

  test('rejects data-bearing or callback-shaped schema input before touching user files', () => {
    const directory = userFixture();
    const userDatabase = join(directory, 'user.sqlite');
    const userLink = join(directory, 'user-link.sqlite');
    const bytes = Buffer.from('not a jooevents database\n');
    writeFileSync(userDatabase, bytes, { mode: 0o600 });
    symlinkSync(userDatabase, userLink);
    const before = runtimeDirectories();

    expect(() => createEphemeralSQLiteRuntime({
      artifacts: [],
      databasePath: userDatabase
    } as never)).toThrow('ephemeral_sqlite_schema_artifacts_array_required');
    expect(() => createEphemeralSQLiteRuntime([{
      id: 'callback-carrier',
      sql: 'create table callback_carrier(id text);',
      install() {}
    }] as never)).toThrow('ephemeral_sqlite_schema_artifact_shape_invalid');
    expect(() => createEphemeralSQLiteRuntime([{
      id: '../../user.sqlite',
      sql: 'create table invalid_id(id text);'
    }])).toThrow('ephemeral_sqlite_schema_artifact_invalid');
    expect(() => createEphemeralSQLiteRuntime([{
      id: 'data-copy',
      sql: 'create table copied_runner_rows as select * from schema_migrations;'
    }])).toThrow('create_table_as_select_forbidden');
    expect(() => createEphemeralSQLiteRuntime([{
      id: 'cte-data-copy',
      sql: 'create table copied_runner_rows as with source as (select * from schema_migrations) select * from source;'
    }])).toThrow('create_table_as_select_forbidden');
    expect(() => createEphemeralSQLiteRuntime([{
      id: 'empty-schema',
      sql: ';;;'
    }])).toThrow('ephemeral_sqlite_schema_artifact_sql_invalid');

    expect(trackNewRuntimeDirectories(before)).toEqual([]);
    expect(readFileSync(userDatabase).equals(bytes)).toBe(true);
    expect(lstatSync(userLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(userLink)).toBe(userDatabase);
  });

  test('rejects changes to retained epoch-1 objects and retains the failed private tree', () => {
    const before = runtimeDirectories();
    const error = expectFoundationCode(() => createEphemeralSQLiteRuntime([{
      id: 'forbidden-baseline-change',
      sql: 'create index forbidden_workspace_name on workspaces(name);'
    }]), 'schema_drift');
    const created = trackNewRuntimeDirectories(before);

    expect(error.details).toMatchObject({ artifactId: 'forbidden-baseline-change' });
    expect(created).toHaveLength(1);
    cleanupDirectories.add(created[0]!);
    const failedDatabasePath = join(created[0]!, 'runtime.sqlite');
    expect(existsSync(failedDatabasePath)).toBe(true);
    expect(readdirSync(sqliteCoordinationPaths(failedDatabasePath).owners)).toEqual([]);
    const failedDatabase = new Database(failedDatabasePath, { readonly: true, create: false, strict: true });
    try {
      expect(failedDatabase.query<{ count: number }, []>(`
        select count(*) as count from sqlite_schema where name = 'forbidden_workspace_name'
      `).get()?.count).toBe(0);
      expect(fingerprintSQLiteSchema(captureSQLiteSchema(failedDatabase, 'full')))
        .toBe(SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint);
    } finally {
      failedDatabase.close();
    }
  });

  test('closes but never pathname-deletes a tree whose content changed', () => {
    const runtime = trackRuntime(createEphemeralSQLiteRuntime([]));
    const unexpectedPath = join(runtime.directoryPath, 'unexpected-user-content');
    writeFileSync(unexpectedPath, 'do not delete\n', { mode: 0o600 });

    const first = expectFoundationCode(() => runtime.close(), 'database_path_unsafe');
    expect(() => runtime.sqlite.query('select 1').get()).toThrow();
    expect(existsSync(runtime.directoryPath)).toBe(true);
    expect(existsSync(runtime.databasePath)).toBe(true);
    expect(readFileSync(unexpectedPath, 'utf8')).toBe('do not delete\n');
    let second: unknown;
    try {
      runtime.close();
    } catch (error) {
      second = error;
    }
    expect(second).toBe(first);
  });
});
