import type { Database } from 'bun:sqlite';
import { openSQLite } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import { acquireSQLiteExclusiveLock, canonicalSQLiteTarget } from './file-ownership';
import { SQLITE_MIGRATION_MANIFEST, type SQLiteReleaseFloor } from './migration-manifest';
import {
  loadSQLiteFoundationArtifacts,
  validateManagedSQLiteCoordinate,
  type SQLiteFoundationArtifacts,
  type SQLiteMigrationState
} from './migration-runner';

export type SQLiteReleasePromotionFaultPoint =
  | 'after_classification_before_commit'
  | 'after_commit_before_return';

export interface SQLiteReleasePromotionResult {
  readonly status: 'promoted' | 'already_frozen';
  readonly releaseFloorId: string;
  readonly coordinate: { readonly schemaEpoch: number; readonly sequence: number };
  readonly migrationId: string;
  readonly databaseClass: 'frozen_release';
  readonly databaseId: string;
  readonly schemaFingerprint: string;
}

function releaseFloor(floorId?: string): SQLiteReleaseFloor {
  const selected = floorId === undefined
    ? SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)
    : SQLITE_MIGRATION_MANIFEST.releaseFloors.find((floor) => floor.releaseFloorId === floorId);
  if (!selected) {
    throw new SQLiteFoundationError('release_promotion_refused', 'The requested SQLite release floor is not supported.', {
      requestedReleaseFloorId: floorId ?? null
    });
  }
  const terminal = SQLITE_MIGRATION_MANIFEST.migrations.find(
    (migration) => migration.migrationId === selected.terminalMigration.migrationId
  );
  if (
    !terminal ||
    terminal.schemaEpoch !== selected.terminalMigration.schemaEpoch ||
    terminal.sequence !== selected.terminalMigration.sequence ||
    terminal.expectedAfterApplicationFingerprint !== selected.expectedApplicationFingerprint ||
    selected.minimumRunnerVersion > SQLITE_MIGRATION_MANIFEST.runnerVersion
  ) {
    throw new SQLiteFoundationError(
      'release_promotion_refused',
      'The requested SQLite release floor is inconsistent with the executable migration manifest.',
      { requestedReleaseFloorId: selected.releaseFloorId }
    );
  }
  return selected;
}

function assertExactFloor(state: SQLiteMigrationState, floor: SQLiteReleaseFloor): asserts state is SQLiteMigrationState & {
  readonly coordinate: { readonly schemaEpoch: number; readonly sequence: number };
  readonly migrationId: string;
  readonly databaseId: string;
  readonly schemaFingerprint: string;
} {
  if (
    state.coordinate?.schemaEpoch !== floor.terminalMigration.schemaEpoch ||
    state.coordinate.sequence !== floor.terminalMigration.sequence ||
    state.migrationId !== floor.terminalMigration.migrationId ||
    state.schemaFingerprint !== floor.expectedFullFingerprint
  ) {
    throw new SQLiteFoundationError(
      'migration_required',
      `The SQLite database must be at ${floor.terminalMigration.migrationId} before release promotion.`,
      {
        releaseFloorId: floor.releaseFloorId,
        actualMigrationId: state.migrationId,
        requiredMigrationId: floor.terminalMigration.migrationId
      }
    );
  }
  if (!state.databaseId) {
    throw new SQLiteFoundationError('release_promotion_refused', 'The managed SQLite database has no durable identity.');
  }
}

function frozenResult(
  state: SQLiteMigrationState,
  floor: SQLiteReleaseFloor,
  status: SQLiteReleasePromotionResult['status']
): SQLiteReleasePromotionResult {
  assertExactFloor(state, floor);
  if (state.databaseClass !== 'frozen_release') {
    throw new SQLiteFoundationError('release_promotion_refused', 'SQLite release promotion did not persist frozen_release.');
  }
  return {
    status,
    releaseFloorId: floor.releaseFloorId,
    coordinate: state.coordinate,
    migrationId: state.migrationId,
    databaseClass: 'frozen_release',
    databaseId: state.databaseId,
    schemaFingerprint: state.schemaFingerprint
  };
}

/** Atomically graduates one exact retained-development coordinate into the release compatibility promise. */
export function promoteManagedSQLiteReleaseFloor(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly expectedDatabaseId: string;
  readonly releaseFloorId?: string;
  readonly fault?: (point: SQLiteReleasePromotionFaultPoint) => void;
}): SQLiteReleasePromotionResult {
  const floor = releaseFloor(input.releaseFloorId);
  const initial = validateManagedSQLiteCoordinate({ database: input.database, artifacts: input.artifacts });
  assertExactFloor(initial, floor);
  if (initial.databaseId !== input.expectedDatabaseId) {
    throw new SQLiteFoundationError('release_promotion_refused', 'The expected database identity does not match the release target.', {
      expectedDatabaseId: input.expectedDatabaseId,
      actualDatabaseId: initial.databaseId
    });
  }
  if (initial.databaseClass === 'ephemeral') {
    throw new SQLiteFoundationError('release_promotion_refused', 'An ephemeral SQLite database cannot become a release floor.');
  }
  if (initial.databaseClass === 'frozen_release') return frozenResult(initial, floor, 'already_frozen');

  input.database.exec('BEGIN IMMEDIATE;');
  try {
    const locked = validateManagedSQLiteCoordinate({ database: input.database, artifacts: input.artifacts });
    assertExactFloor(locked, floor);
    if (locked.databaseId !== input.expectedDatabaseId || locked.databaseClass !== 'retained_development') {
      throw new SQLiteFoundationError(
        'release_promotion_refused',
        'The SQLite release target changed before classification was committed.'
      );
    }
    const update = input.database.query(`
      UPDATE database_instance_metadata
         SET database_class = 'frozen_release', classification_changed_at = ?
       WHERE singleton_key = 1 AND database_id = ? AND database_class = 'retained_development'
    `).run(Date.now(), input.expectedDatabaseId);
    if (update.changes !== 1) {
      throw new SQLiteFoundationError(
        'release_promotion_refused',
        'The SQLite release classification changed before it could be committed.'
      );
    }
    input.fault?.('after_classification_before_commit');
    input.database.exec('COMMIT;');
  } catch (error) {
    if (input.database.inTransaction) {
      try { input.database.exec('ROLLBACK;'); } catch { /* preserve the first failure */ }
    }
    if (error instanceof SQLiteFoundationError) throw error;
    throw new SQLiteFoundationError('release_promotion_failed', 'SQLite release promotion failed and rolled back.', {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  input.fault?.('after_commit_before_return');
  const promoted = validateManagedSQLiteCoordinate({
    database: input.database,
    artifacts: input.artifacts,
    databaseClass: 'frozen_release'
  });
  return frozenResult(promoted, floor, 'promoted');
}

/** Path-safe operator entry point. It validates but never migrates the target. */
export function promoteSQLiteReleaseFloorAtPath(input: {
  readonly databasePath: string;
  readonly expectedDatabaseId: string;
  readonly releaseFloorId?: string;
}): SQLiteReleasePromotionResult {
  const target = canonicalSQLiteTarget(input.databasePath);
  const lock = acquireSQLiteExclusiveLock(target, 'migration');
  try {
    const opened = openSQLite(target, { migrationPolicy: 'validate' });
    try {
      return promoteManagedSQLiteReleaseFloor({
        database: opened.sqlite,
        artifacts: loadSQLiteFoundationArtifacts(),
        expectedDatabaseId: input.expectedDatabaseId,
        ...(input.releaseFloorId ? { releaseFloorId: input.releaseFloorId } : {})
      });
    } finally {
      opened.sqlite.close();
    }
  } finally {
    lock.release();
  }
}
