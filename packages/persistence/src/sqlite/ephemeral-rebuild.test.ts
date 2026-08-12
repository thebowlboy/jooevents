import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSQLite, type OpenSQLiteResult } from './database';
import {
  createEphemeralSQLiteFile,
  rebuildEphemeralSQLite,
  recoverEphemeralSQLiteRebuild
} from './ephemeral-rebuild';
import { SQLiteFoundationError } from './foundation-errors';
import { canonicalSQLiteTarget, sqliteCoordinationPaths } from './file-ownership';
import { statusSQLite } from './status';

const directories: string[] = [];
const opened: OpenSQLiteResult[] = [];
const childFixture = fileURLToPath(new URL('./test-fixtures/runner-child.ts', import.meta.url));

afterEach(() => {
  while (opened.length) opened.pop()?.sqlite.close();
  while (directories.length) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-rebuild-'));
  directories.push(directory);
  const recovery = join(directory, 'recovery');
  mkdirSync(recovery, { mode: 0o700 });
  return { path: join(directory, 'database.sqlite'), recovery };
}

function expectCode(work: () => unknown, code: SQLiteFoundationError['code']): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('guarded ephemeral SQLite rebuild and recovery', () => {
  test('rebuilds only a marked ephemeral target and preserves a verified recovery set', () => {
    const { path, recovery } = fixture();
    const initial = createEphemeralSQLiteFile(path);
    const populated = openSQLite(path);
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    populated.sqlite.query(`insert into workspaces (id, name, state, created_at, updated_at, version)
      values ('workspace_ephemeral', 'Discardable', 'active', ?, ?, 1)`).run(now, now);
    populated.sqlite.close();

    const rebuilt = rebuildEphemeralSQLite({
      databasePath: path,
      expectedDatabaseId: initial.databaseId!,
      recoveryDirectory: recovery
    });
    expect(rebuilt.newDatabaseId).not.toBe(rebuilt.oldDatabaseId);
    expect(existsSync(rebuilt.backupPath)).toBe(true);
    expect(existsSync(rebuilt.archivedJournalPath)).toBe(true);
    expect(statusSQLite(path)).toMatchObject({ kind: 'compatible', migration: { databaseId: rebuilt.newDatabaseId } });

    const replacement = openSQLite(path);
    opened.push(replacement);
    expect(replacement.sqlite.query<{ count: number }, []>(
      "select count(*) as count from workspaces where id = 'workspace_ephemeral'"
    ).get()?.count).toBe(0);
  });

  test('refuses retained databases and live ephemeral owners', () => {
    const retainedFixture = fixture();
    const retained = openSQLite(retainedFixture.path, {
      migrationPolicy: 'apply',
      databaseClass: 'retained_development'
    });
    const retainedId = retained.migration.databaseId!;
    retained.sqlite.close();
    expectCode(() => rebuildEphemeralSQLite({
      databasePath: retainedFixture.path,
      expectedDatabaseId: retainedId,
      recoveryDirectory: retainedFixture.recovery
    }), 'rebuild_refused');

    const ephemeralFixture = fixture();
    const ephemeral = createEphemeralSQLiteFile(ephemeralFixture.path);
    const live = openSQLite(ephemeralFixture.path);
    expectCode(() => rebuildEphemeralSQLite({
      databasePath: ephemeralFixture.path,
      expectedDatabaseId: ephemeral.databaseId!,
      recoveryDirectory: ephemeralFixture.recovery
    }), 'database_busy');
    live.sqlite.close();
  });

  test('restores the exact old pair after interruption following the old move', () => {
    const { path, recovery } = fixture();
    const initial = createEphemeralSQLiteFile(path);
    expect(() => rebuildEphemeralSQLite({
      databasePath: path,
      expectedDatabaseId: initial.databaseId!,
      recoveryDirectory: recovery,
      fault(point) {
        if (point === 'old_moved') throw new Error('simulated interruption');
      }
    })).toThrow('simulated interruption');
    const canonical = canonicalSQLiteTarget(path);
    expect(existsSync(canonical)).toBe(false);
    expect(existsSync(sqliteCoordinationPaths(canonical).rebuildJournal)).toBe(true);

    const restored = recoverEphemeralSQLiteRebuild({ databasePath: path, action: 'restore' });
    expect(restored.databaseId).toBe(initial.databaseId!);
    expect(existsSync(restored.archivedJournalPath)).toBe(true);
    expect(statusSQLite(path)).toMatchObject({ kind: 'compatible', migration: { databaseId: initial.databaseId } });
  });

  test('finishes the prepared replacement after interruption', () => {
    const { path, recovery } = fixture();
    const initial = createEphemeralSQLiteFile(path);
    expect(() => rebuildEphemeralSQLite({
      databasePath: path,
      expectedDatabaseId: initial.databaseId!,
      recoveryDirectory: recovery,
      fault(point) {
        if (point === 'prepared') throw new Error('prepared interruption');
      }
    })).toThrow('prepared interruption');

    const completed = recoverEphemeralSQLiteRebuild({ databasePath: path, action: 'complete' });
    expect(completed.databaseId).not.toBe(initial.databaseId);
    expect(statusSQLite(path)).toMatchObject({ kind: 'compatible', migration: { databaseId: completed.databaseId } });
  });

  test('recovery refuses a journal path that escapes its exact generated recovery set', () => {
    const { path, recovery } = fixture();
    const initial = createEphemeralSQLiteFile(path);
    expect(() => rebuildEphemeralSQLite({
      databasePath: path,
      expectedDatabaseId: initial.databaseId!,
      recoveryDirectory: recovery,
      fault(point) {
        if (point === 'prepared') throw new Error('prepared interruption');
      }
    })).toThrow('prepared interruption');

    const journalPath = sqliteCoordinationPaths(canonicalSQLiteTarget(path)).rebuildJournal;
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    journal.oldPath = path;
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, 'utf8');
    expectCode(() => recoverEphemeralSQLiteRebuild({ databasePath: path, action: 'complete' }), 'recovery_required');
    expect(statusSQLite(path)).toMatchObject({
      kind: 'unstable',
      coordination: { journalLockBinding: 'missing_lock', nextAction: 'recover_rebuild' }
    });
  });

  test('an explicit retry reclaims a dead unstaged rebuild lock without touching the source pair', () => {
    const { path, recovery } = fixture();
    const initial = createEphemeralSQLiteFile(path);
    const crashed = Bun.spawnSync([
      process.execPath,
      childFixture,
      'crash-rebuild',
      path,
      recovery,
      initial.databaseId!,
      'before_journal'
    ]);
    expect(crashed.exitCode).toBe(75);
    const coordination = sqliteCoordinationPaths(canonicalSQLiteTarget(path));
    expect(existsSync(coordination.rebuildJournal)).toBe(false);
    expect(statusSQLite(path)).toMatchObject({
      kind: 'unstable',
      coordination: { rebuildOwner: 'gone', nextAction: 'retry_rebuild' }
    });

    const rebuilt = rebuildEphemeralSQLite({
      databasePath: path,
      expectedDatabaseId: initial.databaseId!,
      recoveryDirectory: recovery
    });
    expect(rebuilt.oldDatabaseId).toBe(initial.databaseId!);
    expect(rebuilt.newDatabaseId).not.toBe(initial.databaseId!);
    expect(statusSQLite(path)).toMatchObject({
      kind: 'compatible',
      migration: { databaseId: rebuilt.newDatabaseId }
    });
    expect(readdirSync(recovery).some((name) => name.includes('.crashed-'))).toBe(true);
  });

  test('recovery refuses a journal whose lock origin no longer matches the crashed rebuild lock', () => {
    const { path, recovery } = fixture();
    const initial = createEphemeralSQLiteFile(path);
    const crashed = Bun.spawnSync([
      process.execPath,
      childFixture,
      'crash-rebuild',
      path,
      recovery,
      initial.databaseId!,
      'prepared'
    ]);
    expect(crashed.exitCode).toBe(75);
    const coordination = sqliteCoordinationPaths(canonicalSQLiteTarget(path));
    const journal = JSON.parse(readFileSync(coordination.rebuildJournal, 'utf8')) as Record<string, unknown>;
    journal.rebuildLockId = '0'.repeat(32);
    writeFileSync(coordination.rebuildJournal, `${JSON.stringify(journal)}\n`, 'utf8');
    expect(statusSQLite(path)).toMatchObject({
      kind: 'unstable',
      coordination: { journalLockBinding: 'mismatch', nextAction: 'inspect_coordination' }
    });
    expectCode(() => recoverEphemeralSQLiteRebuild({ databasePath: path, action: 'restore' }), 'recovery_required');
    expect(existsSync(coordination.rebuildLock)).toBe(true);
  });

  for (const scenario of [
    { point: 'prepared', action: 'complete', expected: 'new' },
    { point: 'after_marker_preserve_before_stage', action: 'complete', expected: 'new' },
    { point: 'marker_preserved', action: 'complete', expected: 'new' },
    { point: 'after_old_move_before_stage', action: 'restore', expected: 'old' },
    { point: 'old_moved', action: 'restore', expected: 'old' },
    { point: 'after_new_database_move_before_stage', action: 'restore', expected: 'old' },
    { point: 'new_database_installed', action: 'restore', expected: 'old' },
    { point: 'after_new_marker_move_before_stage', action: 'restore', expected: 'old' },
    { point: 'new_installed', action: 'restore', expected: 'old' },
    { point: 'verified', action: 'complete', expected: 'new' }
  ] as const) {
    test(`reclaims a journal-bound lock after a hard process exit at ${scenario.point}`, () => {
      const { path, recovery } = fixture();
      const initial = createEphemeralSQLiteFile(path);
      const crashed = Bun.spawnSync([
        process.execPath,
        childFixture,
        'crash-rebuild',
        path,
        recovery,
        initial.databaseId!,
        scenario.point
      ]);
      expect(crashed.exitCode).toBe(75);
      const canonical = canonicalSQLiteTarget(path);
      const coordination = sqliteCoordinationPaths(canonical);
      expect(existsSync(coordination.rebuildLock)).toBe(true);
      expect(existsSync(coordination.recoveryLock)).toBe(true);
      expect(statusSQLite(path)).toMatchObject({
        kind: 'unstable',
        coordination: {
          rebuildLock: true,
          recoveryLock: true,
          rebuildJournal: true,
          journalLockBinding: 'matched',
          rebuildOwner: 'gone',
          nextAction: 'recover_rebuild'
        }
      });

      const recovered = recoverEphemeralSQLiteRebuild({ databasePath: path, action: scenario.action });
      if (scenario.expected === 'old') expect(recovered.databaseId).toBe(initial.databaseId!);
      else expect(recovered.databaseId).not.toBe(initial.databaseId!);
      expect(statusSQLite(path)).toMatchObject({
        kind: 'compatible',
        migration: { databaseId: recovered.databaseId }
      });
      expect(existsSync(coordination.rebuildLock)).toBe(false);
      expect(existsSync(coordination.recoveryLock)).toBe(false);
      expect(readdirSync(recovery).some((name) => name.includes('.crashed-'))).toBe(true);
    });
  }

  for (const scenario of [
    {
      initialPoint: 'prepared',
      action: 'complete',
      recoveryPoint: 'after_recovery_marker_preserved',
      expected: 'new'
    },
    {
      initialPoint: 'prepared',
      action: 'complete',
      recoveryPoint: 'after_recovery_old_database_moved',
      expected: 'new'
    },
    {
      initialPoint: 'prepared',
      action: 'complete',
      recoveryPoint: 'after_recovery_new_database_installed',
      expected: 'new'
    },
    {
      initialPoint: 'prepared',
      action: 'complete',
      recoveryPoint: 'after_recovery_new_marker_installed',
      expected: 'new'
    },
    {
      initialPoint: 'new_installed',
      action: 'restore',
      recoveryPoint: 'after_recovery_new_database_abandoned',
      expected: 'old'
    },
    {
      initialPoint: 'new_installed',
      action: 'restore',
      recoveryPoint: 'after_recovery_old_database_restored',
      expected: 'old'
    },
    {
      initialPoint: 'new_installed',
      action: 'restore',
      recoveryPoint: 'after_recovery_new_marker_abandoned',
      expected: 'old'
    },
    {
      initialPoint: 'new_installed',
      action: 'restore',
      recoveryPoint: 'after_recovery_old_marker_restored',
      expected: 'old'
    }
  ] as const) {
    test(`a second recovery converges after a hard exit at ${scenario.recoveryPoint}`, () => {
      const { path, recovery } = fixture();
      const initial = createEphemeralSQLiteFile(path);
      expect(Bun.spawnSync([
        process.execPath,
        childFixture,
        'crash-rebuild',
        path,
        recovery,
        initial.databaseId!,
        scenario.initialPoint
      ]).exitCode).toBe(75);
      expect(Bun.spawnSync([
        process.execPath,
        childFixture,
        'crash-recovery',
        path,
        scenario.action,
        scenario.recoveryPoint
      ]).exitCode).toBe(77);
      expect(statusSQLite(path)).toMatchObject({
        kind: 'unstable',
        coordination: {
          journalLockBinding: 'matched',
          rebuildOwner: 'gone',
          nextAction: 'recover_rebuild'
        }
      });

      const recovered = recoverEphemeralSQLiteRebuild({ databasePath: path, action: scenario.action });
      if (scenario.expected === 'old') expect(recovered.databaseId).toBe(initial.databaseId!);
      else expect(recovered.databaseId).not.toBe(initial.databaseId!);
      expect(statusSQLite(path)).toMatchObject({
        kind: 'compatible',
        migration: { databaseId: recovered.databaseId }
      });
    });
  }
});
