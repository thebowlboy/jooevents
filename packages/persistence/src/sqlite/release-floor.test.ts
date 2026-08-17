import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import {
  loadSQLiteFoundationArtifacts,
  migrateOrValidateSQLite,
  validateManagedSQLiteCoordinate
} from './migration-runner';
import {
  promoteManagedSQLiteReleaseFloor,
  promoteSQLiteReleaseFloorAtPath
} from './release-floor';

const temporaryDirectories: string[] = [];
const opened: OpenSQLiteResult[] = [];

afterEach(() => {
  while (opened.length) opened.pop()?.sqlite.close();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function pathFor(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-release-floor-'));
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

function retainedDatabase(): OpenSQLiteResult {
  const openedDatabase = openSQLite(pathFor(), {
    migrationPolicy: 'apply',
    databaseClass: 'retained_development'
  });
  opened.push(openedDatabase);
  return openedDatabase;
}

describe('SQLite first release floor', () => {
  test('publishes one exact executable floor at the terminal migration', () => {
    const floor = SQLITE_MIGRATION_MANIFEST.releaseFloors[0];
    const terminal = SQLITE_MIGRATION_MANIFEST.migrations.at(-1)!;
    expect(floor).toEqual({
      releaseFloorId: 'sqlite-e2-s6',
      terminalMigration: {
        migrationId: terminal.migrationId,
        schemaEpoch: terminal.schemaEpoch,
        sequence: terminal.sequence
      },
      expectedApplicationFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentApplicationFingerprint,
      expectedFullFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint,
      minimumRunnerVersion: SQLITE_MIGRATION_MANIFEST.runnerVersion
    });
  });

  test('atomically promotes retained development while preserving its durable identity', () => {
    const target = retainedDatabase();
    const databaseId = target.migration.databaseId!;
    const before = target.sqlite.query<{ created_at: number; classification_changed_at: number }, []>(`
      SELECT created_at,classification_changed_at FROM database_instance_metadata
    `).get()!;
    const result = promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId
    });
    expect(result).toMatchObject({
      status: 'promoted',
      releaseFloorId: 'sqlite-e2-s6',
      coordinate: { schemaEpoch: 2, sequence: 6 },
      migrationId: 'e2_0006_airtable_sync',
      databaseClass: 'frozen_release',
      databaseId
    });
    expect(target.sqlite.query<{
      database_id: string;
      database_class: string;
      created_at: number;
      classification_changed_at: number;
    }, []>('SELECT database_id,database_class,created_at,classification_changed_at FROM database_instance_metadata').get())
      .toEqual({
        database_id: databaseId,
        database_class: 'frozen_release',
        created_at: before.created_at,
        classification_changed_at: expect.any(Number)
      });
  });

  test('a fresh frozen install is immediately valid at the same supported floor', () => {
    const fresh = openSQLite(pathFor(), {
      migrationPolicy: 'apply',
      databaseClass: 'frozen_release'
    });
    opened.push(fresh);
    expect(promoteManagedSQLiteReleaseFloor({
      database: fresh.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: fresh.migration.databaseId!
    })).toMatchObject({
      status: 'already_frozen',
      releaseFloorId: 'sqlite-e2-s6',
      databaseClass: 'frozen_release'
    });
  });

  test('is idempotent only for the same frozen floor and exact database identity', () => {
    const target = retainedDatabase();
    const databaseId = target.migration.databaseId!;
    promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId
    });
    expect(promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId,
      releaseFloorId: 'sqlite-e2-s6'
    })).toMatchObject({ status: 'already_frozen', databaseId });
    expectFoundationError(() => promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: '0'.repeat(32)
    }), 'release_promotion_refused');
    expectFoundationError(() => promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId,
      releaseFloorId: 'sqlite-unknown'
    }), 'release_promotion_refused');
  });

  test('rolls classification back on a fault and a retry safely completes it', () => {
    const target = retainedDatabase();
    const databaseId = target.migration.databaseId!;
    expectFoundationError(() => promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId,
      fault(point) {
        if (point === 'after_classification_before_commit') throw new Error('simulated interruption');
      }
    }), 'release_promotion_failed');
    expect(target.sqlite.query<{ database_class: string }, []>(
      'SELECT database_class FROM database_instance_metadata'
    ).get()).toEqual({ database_class: 'retained_development' });
    expect(promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId
    }).status).toBe('promoted');
  });

  test('a lost response after commit retries as already frozen', () => {
    const target = retainedDatabase();
    const databaseId = target.migration.databaseId!;
    expect(() => promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId,
      fault(point) {
        if (point === 'after_commit_before_return') throw new Error('simulated lost response');
      }
    })).toThrow('simulated lost response');
    expect(promoteManagedSQLiteReleaseFloor({
      database: target.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: databaseId
    }).status).toBe('already_frozen');
  });

  test('refuses ephemeral and partial managed coordinates', () => {
    const ephemeral = openSQLite(':memory:');
    opened.push(ephemeral);
    expectFoundationError(() => promoteManagedSQLiteReleaseFloor({
      database: ephemeral.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: ephemeral.migration.databaseId!
    }), 'release_promotion_refused');

    const path = pathFor();
    const partial = new Database(path, { create: true, strict: true });
    partial.exec('PRAGMA foreign_keys = ON;');
    let migrationPass = 0;
    expectFoundationError(() => migrateOrValidateSQLite({
      database: partial,
      artifacts: loadSQLiteFoundationArtifacts(),
      policy: 'apply',
      databaseClass: 'retained_development',
      isMemory: false,
      fault(point) {
        if (point === 'after_schema_before_receipt' && (migrationPass += 1) === 6) {
          throw new Error('hold before sequence 6 receipt');
        }
      }
    }), 'migration_transaction_failed');
    const partialState = validateManagedSQLiteCoordinate({
      database: partial,
      artifacts: loadSQLiteFoundationArtifacts()
    });
    expect(partialState.migrationId).toBe('e2_0005_api_key_never_expire');
    expectFoundationError(() => promoteManagedSQLiteReleaseFloor({
      database: partial,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: partialState.databaseId!
    }), 'migration_required');
    partial.close();
  });

  test('bridged epoch-1 data reaches the same floor only after its verified upgrade', () => {
    const path = pathFor();
    const predecessor = new Database(path, { create: true, strict: true });
    predecessor.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
    predecessor.close();
    expectFoundationError(() => openSQLite(path, {
      migrationPolicy: 'apply',
      databaseClass: 'frozen_release'
    }), 'database_class_mismatch');

    const bridged = openSQLite(path, {
      migrationPolicy: 'apply',
      databaseClass: 'retained_development'
    });
    opened.push(bridged);
    const result = promoteManagedSQLiteReleaseFloor({
      database: bridged.sqlite,
      artifacts: loadSQLiteFoundationArtifacts(),
      expectedDatabaseId: bridged.migration.databaseId!
    });
    expect(result).toMatchObject({
      status: 'promoted',
      releaseFloorId: 'sqlite-e2-s6',
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    });
  });

  test('path and CLI entry points require the exact opaque identity and never migrate', () => {
    const path = pathFor();
    const created = openSQLite(path, {
      migrationPolicy: 'apply',
      databaseClass: 'retained_development'
    });
    const databaseId = created.migration.databaseId!;
    created.sqlite.close();
    expectFoundationError(() => promoteSQLiteReleaseFloorAtPath({
      databasePath: path,
      expectedDatabaseId: 'f'.repeat(32)
    }), 'release_promotion_refused');

    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const promoted = Bun.spawnSync([
      process.execPath,
      cli,
      'promote-release',
      '--database',
      path,
      '--expected-database-id',
      databaseId
    ]);
    expect(promoted.exitCode).toBe(0);
    expect(JSON.parse(promoted.stdout.toString())).toMatchObject({
      status: 'promoted',
      releaseFloorId: 'sqlite-e2-s6',
      databaseId
    });
    const replay = promoteSQLiteReleaseFloorAtPath({ databasePath: path, expectedDatabaseId: databaseId });
    expect(replay.status).toBe('already_frozen');
  });
});
