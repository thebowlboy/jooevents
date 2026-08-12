import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { SQLiteFoundationError } from './foundation-errors';
import { canonicalSQLiteTarget, sqliteCoordinationPaths } from './file-ownership';
import { loadSQLiteFoundationArtifacts, migrateOrValidateSQLite, type SQLiteMigrationState } from './migration-runner';
import { observeProcessIdentity } from './process-identity';

interface FileSignature {
  readonly device: string;
  readonly inode: string;
  readonly links: string;
  readonly size: string;
  readonly modifiedNanoseconds: string;
}

export type SQLiteStatus =
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'compatible'; readonly path: string; readonly migration: SQLiteMigrationState }
  | { readonly kind: 'migration_required'; readonly path: string; readonly code: string; readonly details: Readonly<Record<string, unknown>> }
  | { readonly kind: 'incompatible'; readonly path: string; readonly code: string; readonly details: Readonly<Record<string, unknown>> }
  | {
      readonly kind: 'unstable';
      readonly path: string;
      readonly reason: string;
      readonly coordination?: SQLiteCoordinationDiagnostic;
    }
  | { readonly kind: 'refused'; readonly path: string; readonly code: string; readonly reason: string };

export interface SQLiteCoordinationDiagnostic {
  readonly migrationLock: boolean;
  readonly rebuildLock: boolean;
  readonly recoveryLock: boolean;
  readonly rebuildJournal: boolean;
  readonly journalStage: string | null;
  readonly journalLockBinding: 'matched' | 'missing_lock' | 'mismatch' | 'malformed' | null;
  readonly rebuildOwner: 'alive' | 'gone' | 'unknown' | null;
  readonly nextAction:
    | 'wait_for_owner'
    | 'recover_rebuild'
    | 'retry_rebuild'
    | 'inspect_coordination'
    | null;
}

export type SQLiteStatusProbePoint =
  | 'after_filesystem_observation'
  | 'before_final_data_version'
  | 'after_connection_close';

export interface SQLiteStatusOptions {
  /** Deterministic fixture seam; production callers omit it. */
  readonly testOnlyProbe?: (point: SQLiteStatusProbePoint) => void;
}

function signature(path: string): FileSignature {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new SQLiteFoundationError('database_path_unsafe', 'SQLite status accepts regular single-link files only.', { path });
  }
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    links: stat.nlink.toString(),
    size: stat.size.toString(),
    modifiedNanoseconds: stat.mtimeNs.toString()
  };
}

function signatureSet(path: string): Readonly<Record<string, FileSignature>> {
  const result: Record<string, FileSignature> = { database: signature(path) };
  const wal = `${path}-wal`;
  const shm = `${path}-shm`;
  if (existsSync(wal)) result.wal = signature(wal);
  if (existsSync(shm)) result.shm = signature(shm);
  if (result.wal && !result.shm) {
    throw new SQLiteFoundationError('status_unstable', 'A SQLite WAL without its SHM companion is not safe to classify.');
  }
  return result;
}

function sameSignatures(
  before: Readonly<Record<string, FileSignature>>,
  after: Readonly<Record<string, FileSignature>>
): boolean {
  const stable = (value: Readonly<Record<string, FileSignature>>) => ({
    ...value,
    // SQLite's read-only WAL coordination updates SHM lock bookkeeping and its
    // mtime. Identity, size, WAL/main signatures, and data_version remain guarded.
    ...(value.shm ? { shm: { ...value.shm, modifiedNanoseconds: '<coordination>' } } : {})
  });
  return JSON.stringify(stable(before)) === JSON.stringify(stable(after));
}

function sameExactSignatures(
  before: Readonly<Record<string, FileSignature>>,
  after: Readonly<Record<string, FileSignature>>
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

interface CoordinationState {
  readonly migration: boolean;
  readonly rebuild: boolean;
  readonly recovery: boolean;
  readonly journal: boolean;
}

function lockState(path: string): CoordinationState {
  const coordination = sqliteCoordinationPaths(path);
  return {
    migration: existsSync(coordination.migrationLock),
    rebuild: existsSync(coordination.rebuildLock),
    recovery: existsSync(coordination.recoveryLock),
    journal: existsSync(coordination.rebuildJournal)
  };
}

function coordinationKey(state: CoordinationState): string {
  return JSON.stringify(state);
}

function hasCoordination(state: CoordinationState): boolean {
  return state.migration || state.rebuild || state.recovery || state.journal;
}

function smallJsonRecord(path: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function coordinationDiagnostic(path: string, state: CoordinationState): SQLiteCoordinationDiagnostic {
  const paths = sqliteCoordinationPaths(path);
  const journal = state.journal ? smallJsonRecord(paths.rebuildJournal) : null;
  const lock = state.rebuild ? smallJsonRecord(paths.rebuildLock) : null;
  const journalLockId = typeof journal?.rebuildLockId === 'string' ? journal.rebuildLockId : null;
  const lockJournalId = typeof lock?.journalLockId === 'string' ? lock.journalLockId : null;
  const journalStage = typeof journal?.stage === 'string' ? journal.stage : null;
  let rebuildOwner: SQLiteCoordinationDiagnostic['rebuildOwner'] = null;
  if (state.rebuild) {
    const pid = typeof lock?.pid === 'number' && Number.isInteger(lock.pid) ? lock.pid : null;
    const recordedToken = typeof lock?.processStartToken === 'string' ? lock.processStartToken : null;
    if (pid === null || !recordedToken) {
      rebuildOwner = 'unknown';
    } else {
      const processIdentity = observeProcessIdentity(pid);
      rebuildOwner = processIdentity.kind === 'unavailable'
        ? 'unknown'
        : processIdentity.kind === 'absent' || processIdentity.startToken !== recordedToken
          ? 'gone'
          : 'alive';
    }
  }
  const journalLockBinding = !state.journal
    ? null
    : !journal
      ? 'malformed'
      : !state.rebuild
        ? 'missing_lock'
        : !lock || !journalLockId || !lockJournalId
          ? 'malformed'
          : journalLockId === lockJournalId
            ? 'matched'
            : 'mismatch';
  const nextAction: SQLiteCoordinationDiagnostic['nextAction'] =
    journalLockBinding === 'mismatch' || journalLockBinding === 'malformed'
      ? 'inspect_coordination'
      : state.journal
        ? rebuildOwner === 'alive'
          ? 'wait_for_owner'
          : rebuildOwner === 'unknown' && state.rebuild
            ? 'inspect_coordination'
            : 'recover_rebuild'
        : state.rebuild || state.recovery
          ? rebuildOwner === 'gone'
            ? 'retry_rebuild'
            : rebuildOwner === 'unknown'
              ? 'inspect_coordination'
              : 'wait_for_owner'
          : state.migration
            ? 'wait_for_owner'
            : null;
  return {
    migrationLock: state.migration,
    rebuildLock: state.rebuild,
    recoveryLock: state.recovery,
    rebuildJournal: state.journal,
    journalStage,
    journalLockBinding,
    rebuildOwner,
    nextAction
  };
}

/** Strictly diagnostic: no owners, sidecars, ledgers, pragmas, or target files are created. */
export function statusSQLite(requestedPath: string, options: SQLiteStatusOptions = {}): SQLiteStatus {
  let path = requestedPath;
  try {
    path = canonicalSQLiteTarget(requestedPath);
    const locksBefore = lockState(path);
    if (hasCoordination(locksBefore)) {
      return {
        kind: 'unstable',
        path,
        reason: 'A migration, rebuild, or recovery marker is present.',
        coordination: coordinationDiagnostic(path, locksBefore)
      };
    }
    if (!existsSync(path)) return { kind: 'missing', path };
    const before = signatureSet(path);
    options.testOnlyProbe?.('after_filesystem_observation');

    const database = new Database(path, { readonly: true, create: false, strict: true });
    let result: SQLiteStatus;
    let dataVersionBefore = -1;
    let dataVersionAfter = -1;
    let duringReadBefore: Readonly<Record<string, FileSignature>> | undefined;
    let duringReadAfter: Readonly<Record<string, FileSignature>> | undefined;
    try {
      dataVersionBefore = database.query<{ data_version: number }, []>('PRAGMA data_version').get()?.data_version ?? -1;
      duringReadBefore = signatureSet(path);
      try {
        const migration = migrateOrValidateSQLite({
          database,
          artifacts: loadSQLiteFoundationArtifacts(),
          policy: 'validate',
          isMemory: false
        });
        result = { kind: 'compatible', path, migration };
      } catch (error) {
        if (error instanceof SQLiteFoundationError && error.code === 'migration_required') {
          result = { kind: 'migration_required', path, code: error.code, details: error.details };
        } else if (error instanceof SQLiteFoundationError) {
          result = { kind: 'incompatible', path, code: error.code, details: error.details };
        } else {
          result = {
            kind: 'refused',
            path,
            code: 'sqlite_status_failed',
            reason: error instanceof Error ? error.message : String(error)
          };
        }
      }
      options.testOnlyProbe?.('before_final_data_version');
      dataVersionAfter = database.query<{ data_version: number }, []>('PRAGMA data_version').get()?.data_version ?? -1;
      duringReadAfter = signatureSet(path);
    } finally {
      database.close();
    }
    const immediatelyAfterClose = signatureSet(path);
    options.testOnlyProbe?.('after_connection_close');

    const after = signatureSet(path);
    const locksAfter = lockState(path);
    if (
      !sameSignatures(before, after) ||
      !duringReadBefore || !duringReadAfter || !sameExactSignatures(duringReadBefore, duringReadAfter) ||
      !sameExactSignatures(immediatelyAfterClose, after) ||
      coordinationKey(locksBefore) !== coordinationKey(locksAfter) ||
      dataVersionBefore !== dataVersionAfter
    ) {
      return { kind: 'unstable', path, reason: 'The database, sidecars, data version, or coordination state changed during status.' };
    }
    return result;
  } catch (error) {
    if (error instanceof SQLiteFoundationError && error.code === 'status_unstable') {
      return { kind: 'unstable', path, reason: error.message };
    }
    return {
      kind: 'refused',
      path,
      code: error instanceof SQLiteFoundationError ? error.code : 'sqlite_status_failed',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
