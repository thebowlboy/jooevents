import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import type { SQLiteFoundationErrorCode } from './foundation-errors';
import { canonicalSQLiteTarget, listSQLiteOwners } from './file-ownership';
import {
  createRetainedSQLiteBackup,
  createVerifiedRetainedSQLiteRestoreCandidate,
  verifyRetainedSQLiteBackup
} from './retained-backup';

const directories: string[] = [];
const opened: OpenSQLiteResult[] = [];
const maximumBytes = 16 * 1024 * 1024;
const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true });
  }
});

function fixture(): {
  readonly directory: string;
  readonly sourcePath: string;
  readonly backupPath: string;
  readonly candidatePath: string;
} {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-retained-backup-')));
  directories.push(directory);
  return {
    directory,
    sourcePath: join(directory, 'source.sqlite'),
    backupPath: join(directory, 'backup.sqlite'),
    candidatePath: join(directory, 'restored.sqlite')
  };
}

function createRetained(path: string, databaseClass: 'retained_development' | 'frozen_release' = 'retained_development') {
  const openedDatabase = openSQLite(path, { migrationPolicy: 'apply', databaseClass });
  const now = Date.parse('2026-08-13T00:00:00.000Z');
  openedDatabase.sqlite.query(`
    insert into workspaces (id, name, state, created_at, updated_at, version)
    values ('workspace_backup_proof', 'Backup proof', 'active', ?, ?, 1)
  `).run(now, now);
  const databaseId = openedDatabase.migration.databaseId!;
  openedDatabase.sqlite.close();
  return { databaseId, databaseClass } as const;
}

function expectCode(work: () => unknown, code: SQLiteFoundationErrorCode): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('retained SQLite backup and restore rehearsal', () => {
  test('creates a bounded verified backup and a separately verified restore candidate', () => {
    const paths = fixture();
    const source = createRetained(paths.sourcePath);

    const backup = createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    });
    expect(backup).toMatchObject({
      formatVersion: 1,
      databaseId: source.databaseId,
      databaseClass: 'retained_development',
      migrationId: 'e1_0001_identity_access',
      schemaEpoch: 1,
      sequence: 1
    });
    expect(backup.bytes).toBeGreaterThan(0);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(paths.backupPath)).toBe(true);
    expect(existsSync(`${paths.backupPath}-wal`)).toBe(false);
    expect(existsSync(`${paths.backupPath}-shm`)).toBe(false);
    expect(listSQLiteOwners(canonicalSQLiteTarget(paths.sourcePath))).toEqual([]);

    expect(createVerifiedRetainedSQLiteRestoreCandidate({
      backupPath: paths.backupPath,
      restoreCandidatePath: paths.candidatePath,
      expectedDescriptor: backup,
      maximumBytes
    })).toEqual(backup);
    expect(readFileSync(paths.candidatePath)).toEqual(readFileSync(paths.backupPath));
    expect(existsSync(`${paths.candidatePath}-wal`)).toBe(false);
    expect(existsSync(`${paths.candidatePath}-shm`)).toBe(false);

    const restored = new Database(paths.candidatePath, { readonly: true, create: false, strict: true });
    try {
      expect(restored.query<{ readonly name: string }, []>(
        "select name from workspaces where id = 'workspace_backup_proof'"
      ).get()).toEqual({ name: 'Backup proof' });
    } finally {
      restored.close();
    }
  });

  test('checkpoints committed WAL state into the verified backup', () => {
    const paths = fixture();
    const source = createRetained(paths.sourcePath, 'frozen_release');
    const writer = new Database(paths.sourcePath, { create: false, strict: true });
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    writer.query(`update workspaces set name = 'WAL-backed proof', version = 2 where id = ?`)
      .run('workspace_backup_proof');
    writer.close();

    const backup = createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    });
    expect(backup.databaseClass).toBe('frozen_release');

    const verified = new Database(paths.backupPath, { readonly: true, create: false, strict: true });
    try {
      expect(verified.query<{ readonly name: string }, []>(
        "select name from workspaces where id = 'workspace_backup_proof'"
      ).get()).toEqual({ name: 'WAL-backed proof' });
    } finally {
      verified.close();
    }
  });

  test('refuses live owners, the wrong identity, occupied targets, and unbounded serialization', () => {
    const paths = fixture();
    const source = createRetained(paths.sourcePath);
    const live = openSQLite(paths.sourcePath);
    opened.push(live);

    expectCode(() => createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    }), 'database_busy');
    live.sqlite.close();
    opened.pop();

    expectCode(() => createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: '0'.repeat(32),
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    }), 'backup_invalid');
    expectCode(() => createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: 0
    }), 'backup_refused');

    writeFileSync(paths.backupPath, 'occupied');
    expectCode(() => createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    }), 'backup_refused');
  });

  test('detects changed backup bytes and refuses symlink or hardlink artifacts', () => {
    const paths = fixture();
    const source = createRetained(paths.sourcePath);
    const backup = createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    });

    const bytes = readFileSync(paths.backupPath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(paths.backupPath, bytes);
    expectCode(() => verifyRetainedSQLiteBackup({
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      expectedDescriptor: backup,
      maximumBytes
    }), 'backup_invalid');

    const cleanPath = join(paths.directory, 'clean.sqlite');
    const hardlinkPath = join(paths.directory, 'hardlink.sqlite');
    const symlinkPath = join(paths.directory, 'symlink.sqlite');
    writeFileSync(cleanPath, readFileSync(paths.sourcePath));
    linkSync(cleanPath, hardlinkPath);
    symlinkSync(cleanPath, symlinkPath);
    expectCode(() => verifyRetainedSQLiteBackup({
      backupPath: hardlinkPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumBytes
    }), 'database_path_unsafe');
    expectCode(() => verifyRetainedSQLiteBackup({
      backupPath: symlinkPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumBytes
    }), 'database_path_unsafe');
  });

  test('never replaces an existing restore target', () => {
    const paths = fixture();
    const source = createRetained(paths.sourcePath);
    const backup = createRetainedSQLiteBackup({
      databasePath: paths.sourcePath,
      backupPath: paths.backupPath,
      expectedDatabaseId: source.databaseId,
      expectedDatabaseClass: source.databaseClass,
      maximumSerializeBytes: maximumBytes
    });
    writeFileSync(paths.candidatePath, 'must remain');

    expectCode(() => createVerifiedRetainedSQLiteRestoreCandidate({
      backupPath: paths.backupPath,
      restoreCandidatePath: paths.candidatePath,
      expectedDescriptor: backup,
      maximumBytes
    }), 'restore_refused');
    expect(readFileSync(paths.candidatePath, 'utf8')).toBe('must remain');
  });

  test('exposes explicit backup and non-replacing restore rehearsal commands', () => {
    const paths = fixture();
    const source = createRetained(paths.sourcePath);
    const backup = Bun.spawnSync([
      process.execPath,
      cliPath,
      'backup',
      '--database', paths.sourcePath,
      '--backup', paths.backupPath,
      '--expected-database-id', source.databaseId,
      '--class', source.databaseClass,
      '--max-bytes', String(maximumBytes)
    ]);
    expect(backup.exitCode).toBe(0);
    const descriptor = JSON.parse(backup.stdout.toString()) as {
      readonly databaseId: string;
      readonly sha256: string;
    };
    expect(descriptor.databaseId).toBe(source.databaseId);

    const rehearsal = Bun.spawnSync([
      process.execPath,
      cliPath,
      'restore-rehearsal',
      '--backup', paths.backupPath,
      '--candidate', paths.candidatePath,
      '--expected-database-id', source.databaseId,
      '--expected-sha256', descriptor.sha256,
      '--class', source.databaseClass,
      '--max-bytes', String(maximumBytes)
    ]);
    expect(rehearsal.exitCode).toBe(0);
    expect(JSON.parse(rehearsal.stdout.toString())).toMatchObject({
      databaseId: source.databaseId,
      sha256: descriptor.sha256
    });

    const refusedCandidate = join(paths.directory, 'wrong-digest.sqlite');
    const refused = Bun.spawnSync([
      process.execPath,
      cliPath,
      'restore-rehearsal',
      '--backup', paths.backupPath,
      '--candidate', refusedCandidate,
      '--expected-database-id', source.databaseId,
      '--expected-sha256', '0'.repeat(64),
      '--class', source.databaseClass,
      '--max-bytes', String(maximumBytes)
    ]);
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(refusedCandidate)).toBe(false);
  });
});
