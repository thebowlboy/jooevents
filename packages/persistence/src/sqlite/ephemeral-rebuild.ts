import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteFoundationError } from './foundation-errors';
import {
  acquireSQLiteExclusiveLock,
  acquireSQLiteRebuildRecoveryLock,
  acquireSQLiteRebuildStartLock,
  canonicalSQLiteTarget,
  listSQLiteOwners,
  sqliteCoordinationPaths
} from './file-ownership';
import { loadSQLiteFoundationArtifacts, migrateOrValidateSQLite, type SQLiteMigrationState } from './migration-runner';

interface EphemeralMarker {
  readonly formatVersion: 1;
  readonly applicationKey: 'jooevents';
  readonly canonicalDatabasePath: string;
  readonly databaseId: string;
  readonly nonce: string;
}

type RebuildStage =
  | 'prepared'
  | 'marker_preserved'
  | 'old_moved'
  | 'new_database_installed'
  | 'new_installed'
  | 'verified';

interface RebuildJournal {
  readonly formatVersion: 1;
  readonly rebuildLockId: string;
  readonly canonicalDatabasePath: string;
  readonly recoveryDirectory: string;
  readonly expectedOldDatabaseId: string;
  readonly newDatabaseId: string;
  readonly buildingPath: string;
  readonly buildingMarkerPath: string;
  readonly oldPath: string;
  readonly oldMarkerPath: string;
  readonly backupPath: string;
  readonly abandonedNewPath: string;
  readonly abandonedNewMarkerPath: string;
  readonly stage: RebuildStage;
}

export type EphemeralRebuildFaultPoint =
  | RebuildStage
  | 'before_journal'
  | 'after_marker_preserve_before_stage'
  | 'after_old_move_before_stage'
  | 'after_new_database_move_before_stage'
  | 'after_new_marker_move_before_stage';

export type EphemeralRecoveryFaultPoint =
  | 'after_recovery_marker_preserved'
  | 'after_recovery_old_database_moved'
  | 'after_recovery_new_database_installed'
  | 'after_recovery_new_marker_installed'
  | 'after_recovery_new_database_abandoned'
  | 'after_recovery_old_database_restored'
  | 'after_recovery_new_marker_abandoned'
  | 'after_recovery_old_marker_restored';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function assertPrivateRegular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new SQLiteFoundationError('rebuild_refused', 'Rebuild markers and journals must be private regular single-link files.', { path });
  }
}

function writeExclusive(path: string, bytes: string | Uint8Array): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  assertPrivateRegular(path);
}

function replaceJournal(path: string, journal: RebuildJournal): void {
  const temporary = `${path}.next-${randomBytes(8).toString('hex')}`;
  writeExclusive(temporary, `${JSON.stringify(journal)}\n`);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureUnderTemporaryRoot(path: string): void {
  const temporaryRoot = realpathSync(tmpdir());
  if (path !== temporaryRoot && !path.startsWith(`${temporaryRoot}/`)) {
    throw new SQLiteFoundationError(
      'rebuild_refused',
      'File-backed ephemeral databases are restricted to the operating-system temporary root.'
    );
  }
}

function markerPath(databasePath: string): string {
  return `${databasePath}.jooevents-ephemeral.json`;
}

function markerJson(marker: EphemeralMarker): string {
  return `${JSON.stringify({
    applicationKey: marker.applicationKey,
    canonicalDatabasePath: marker.canonicalDatabasePath,
    databaseId: marker.databaseId,
    formatVersion: marker.formatVersion,
    nonce: marker.nonce
  })}\n`;
}

function readMarker(path: string, expectedDatabasePath: string, expectedDatabaseId?: string): EphemeralMarker {
  if (!existsSync(path)) {
    throw new SQLiteFoundationError('rebuild_refused', 'The exact ephemeral rebuild marker is missing.');
  }
  assertPrivateRegular(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SQLiteFoundationError('rebuild_refused', 'The ephemeral rebuild marker is not valid JSON.');
  }
  const marker = value as Partial<EphemeralMarker>;
  if (
    marker.formatVersion !== 1 || marker.applicationKey !== 'jooevents' ||
    marker.canonicalDatabasePath !== expectedDatabasePath ||
    typeof marker.databaseId !== 'string' || !/^[0-9a-f]{32}$/.test(marker.databaseId) ||
    typeof marker.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(marker.nonce) ||
    (expectedDatabaseId !== undefined && marker.databaseId !== expectedDatabaseId)
  ) {
    throw new SQLiteFoundationError('rebuild_refused', 'The ephemeral marker does not match the exact database target and identity.');
  }
  return marker as EphemeralMarker;
}

function validateRecoveryDirectory(path: string, target: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new SQLiteFoundationError('rebuild_refused', 'The recovery directory must be absolute and normalized.');
  }
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SQLiteFoundationError('rebuild_refused', 'The recovery directory must be a real existing directory.');
  }
  if (stat.dev !== statSync(dirname(target)).dev) {
    throw new SQLiteFoundationError('rebuild_refused', 'Recovery and target directories must be on the same device.');
  }
  return canonical;
}

function validateEphemeralDatabase(path: string, expectedId?: string): SQLiteMigrationState {
  const database = new Database(path, { readonly: true, create: false, strict: true });
  try {
    const integrity = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new SQLiteFoundationError('rebuild_refused', 'The ephemeral database failed SQLite integrity verification.');
    }
    if (database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all().length !== 0) {
      throw new SQLiteFoundationError('rebuild_refused', 'The ephemeral database failed SQLite foreign-key verification.');
    }
    const state = migrateOrValidateSQLite({
      database,
      artifacts: loadSQLiteFoundationArtifacts(),
      policy: 'validate',
      databaseClass: 'ephemeral',
      isMemory: false,
      allowFileBackedEphemeral: true
    });
    if (expectedId !== undefined && state.databaseId !== expectedId) {
      throw new SQLiteFoundationError('rebuild_refused', 'The ephemeral database identity changed.');
    }
    return state;
  } finally {
    database.close();
  }
}

/** Creates a marked file-backed ephemeral database solely for isolated test harnesses. */
export function createEphemeralSQLiteFile(databasePath: string): SQLiteMigrationState {
  const path = canonicalSQLiteTarget(databasePath);
  ensureUnderTemporaryRoot(path);
  if (existsSync(path) || existsSync(markerPath(path))) {
    throw new SQLiteFoundationError('rebuild_refused', 'An ephemeral test database must start from an unused exact path.');
  }
  const lock = acquireSQLiteExclusiveLock(path, 'migration');
  try {
    const database = new Database(path, { create: true, strict: true });
    let state: SQLiteMigrationState;
    try {
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      state = migrateOrValidateSQLite({
        database,
        artifacts: loadSQLiteFoundationArtifacts(),
        policy: 'apply',
        databaseClass: 'ephemeral',
        isMemory: false,
        allowFileBackedEphemeral: true
      });
      database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    } finally {
      database.close();
    }
    writeExclusive(markerPath(path), markerJson({
      formatVersion: 1,
      applicationKey: 'jooevents',
      canonicalDatabasePath: path,
      databaseId: state.databaseId!,
      nonce: randomBytes(32).toString('hex')
    }));
    return state;
  } finally {
    lock.release();
  }
}

function readJournal(path: string, expectedDatabasePath: string): RebuildJournal {
  if (!existsSync(path)) {
    throw new SQLiteFoundationError('recovery_required', 'No exact ephemeral rebuild journal exists for this target.');
  }
  assertPrivateRegular(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SQLiteFoundationError('recovery_required', 'The ephemeral rebuild journal is malformed.');
  }
  const journal = value as Partial<RebuildJournal>;
  if (
    journal.formatVersion !== 1 || journal.canonicalDatabasePath !== expectedDatabasePath ||
    ![
      'prepared',
      'marker_preserved',
      'old_moved',
      'new_database_installed',
      'new_installed',
      'verified'
    ].includes(String(journal.stage)) ||
    typeof journal.rebuildLockId !== 'string' || !/^[0-9a-f]{32}$/.test(journal.rebuildLockId) ||
    typeof journal.recoveryDirectory !== 'string' || typeof journal.expectedOldDatabaseId !== 'string' ||
    typeof journal.newDatabaseId !== 'string' || typeof journal.buildingPath !== 'string' ||
    typeof journal.buildingMarkerPath !== 'string' || typeof journal.oldPath !== 'string' ||
    typeof journal.oldMarkerPath !== 'string' || typeof journal.backupPath !== 'string' ||
    typeof journal.abandonedNewPath !== 'string' || typeof journal.abandonedNewMarkerPath !== 'string'
  ) {
    throw new SQLiteFoundationError('recovery_required', 'The ephemeral rebuild journal does not match the requested target.');
  }
  if (
    !/^[0-9a-f]{32}$/.test(journal.expectedOldDatabaseId) ||
    !/^[0-9a-f]{32}$/.test(journal.newDatabaseId)
  ) {
    throw new SQLiteFoundationError('recovery_required', 'The ephemeral rebuild journal contains an invalid database identity.');
  }
  const checked = journal as RebuildJournal;
  let recoveryDirectory: string;
  try {
    recoveryDirectory = validateRecoveryDirectory(checked.recoveryDirectory, expectedDatabasePath);
  } catch {
    throw new SQLiteFoundationError('recovery_required', 'The rebuild journal recovery directory is no longer an exact safe target.');
  }
  if (recoveryDirectory !== checked.recoveryDirectory) {
    throw new SQLiteFoundationError('recovery_required', 'The rebuild journal recovery directory changed identity.');
  }
  const databaseName = basename(expectedDatabasePath);
  const buildingPrefix = `${databaseName}.building-`;
  const buildingName = basename(checked.buildingPath);
  const token = buildingName.startsWith(buildingPrefix) ? buildingName.slice(buildingPrefix.length) : '';
  if (!/^[0-9a-f]{16}$/.test(token)) {
    throw new SQLiteFoundationError('recovery_required', 'The rebuild journal has an invalid replacement identity.');
  }
  const targetParent = dirname(expectedDatabasePath);
  const exactPaths = {
    buildingPath: join(targetParent, `${databaseName}.building-${token}`),
    buildingMarkerPath: join(targetParent, `${databaseName}.new-marker-${token}.json`),
    backupPath: join(recoveryDirectory, `${databaseName}.backup-${token}`),
    oldPath: join(recoveryDirectory, `${databaseName}.old-${token}`),
    oldMarkerPath: join(recoveryDirectory, `${databaseName}.old-marker-${token}.json`),
    abandonedNewPath: join(recoveryDirectory, `${databaseName}.abandoned-new-${token}`),
    abandonedNewMarkerPath: join(recoveryDirectory, `${databaseName}.abandoned-new-marker-${token}.json`)
  } as const;
  for (const [key, exactPath] of Object.entries(exactPaths)) {
    if (checked[key as keyof typeof exactPaths] !== exactPath) {
      throw new SQLiteFoundationError('recovery_required', 'The rebuild journal contains an out-of-scope artifact path.', { key });
    }
  }
  if (new Set([expectedDatabasePath, markerPath(expectedDatabasePath), ...Object.values(exactPaths)]).size !== 9) {
    throw new SQLiteFoundationError('recovery_required', 'The rebuild journal aliases two recovery artifacts.');
  }
  return checked;
}

function archiveJournal(journalPath: string, journal: RebuildJournal, suffix: string): string {
  const archived = join(journal.recoveryDirectory, `${basename(journalPath)}.${suffix}-${randomBytes(6).toString('hex')}`);
  if (existsSync(archived)) throw new SQLiteFoundationError('recovery_required', 'The resolved journal archive path already exists.');
  renameSync(journalPath, archived);
  fsyncDirectory(dirname(journalPath));
  fsyncDirectory(journal.recoveryDirectory);
  return archived;
}

function databaseIdAt(path: string): string | null {
  if (!existsSync(path)) return null;
  return validateEphemeralDatabase(path).databaseId;
}

function markerIdAt(path: string, canonicalDatabasePath: string): string | null {
  if (!existsSync(path)) return null;
  return readMarker(path, canonicalDatabasePath).databaseId;
}

function preserveOldMarker(journal: RebuildJournal): void {
  if (existsSync(journal.oldMarkerPath)) {
    readMarker(journal.oldMarkerPath, journal.canonicalDatabasePath, journal.expectedOldDatabaseId);
    return;
  }
  readMarker(markerPath(journal.canonicalDatabasePath), journal.canonicalDatabasePath, journal.expectedOldDatabaseId);
  writeExclusive(journal.oldMarkerPath, readFileSync(markerPath(journal.canonicalDatabasePath)));
  fsyncDirectory(journal.recoveryDirectory);
  readMarker(journal.oldMarkerPath, journal.canonicalDatabasePath, journal.expectedOldDatabaseId);
}

function completeNewPair(
  journal: RebuildJournal,
  fault?: (point: EphemeralRecoveryFaultPoint) => void
): void {
  preserveOldMarker(journal);
  fault?.('after_recovery_marker_preserved');
  const oldAtRecovery = databaseIdAt(journal.oldPath);
  const currentBeforeMove = databaseIdAt(journal.canonicalDatabasePath);
  const buildingBeforeMove = databaseIdAt(journal.buildingPath);
  const currentMarkerBeforeMove = markerIdAt(
    markerPath(journal.canonicalDatabasePath),
    journal.canonicalDatabasePath
  );
  const buildingMarkerBeforeMove = markerIdAt(journal.buildingMarkerPath, journal.canonicalDatabasePath);
  if (currentBeforeMove !== journal.newDatabaseId && buildingBeforeMove !== journal.newDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'Completion preflight cannot validate the exact new database.');
  }
  if (currentMarkerBeforeMove !== journal.newDatabaseId && buildingMarkerBeforeMove !== journal.newDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'Completion preflight cannot validate the exact new marker.');
  }
  if (oldAtRecovery === null) {
    if (currentBeforeMove !== journal.expectedOldDatabaseId) {
      throw new SQLiteFoundationError('recovery_required', 'Completion cannot locate the exact old database before replacement.');
    }
    renameSync(journal.canonicalDatabasePath, journal.oldPath);
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fsyncDirectory(journal.recoveryDirectory);
    fault?.('after_recovery_old_database_moved');
  } else if (oldAtRecovery !== journal.expectedOldDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'The recorded old database path has a different identity.');
  } else if (currentBeforeMove === journal.expectedOldDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'Two paths claim the old database identity during completion.');
  }

  const current = databaseIdAt(journal.canonicalDatabasePath);
  if (current === null) {
    if (databaseIdAt(journal.buildingPath) !== journal.newDatabaseId) {
      throw new SQLiteFoundationError('recovery_required', 'Completion cannot locate the exact new database.');
    }
    renameSync(journal.buildingPath, journal.canonicalDatabasePath);
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fault?.('after_recovery_new_database_installed');
  } else if (current !== journal.newDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'The target does not contain the expected new database during completion.');
  }

  const currentMarkerId = markerIdAt(markerPath(journal.canonicalDatabasePath), journal.canonicalDatabasePath);
  if (currentMarkerId !== journal.newDatabaseId) {
    if (markerIdAt(journal.buildingMarkerPath, journal.canonicalDatabasePath) !== journal.newDatabaseId) {
      throw new SQLiteFoundationError('recovery_required', 'Completion cannot locate the exact new marker.');
    }
    renameSync(journal.buildingMarkerPath, markerPath(journal.canonicalDatabasePath));
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fault?.('after_recovery_new_marker_installed');
  }
  readMarker(markerPath(journal.canonicalDatabasePath), journal.canonicalDatabasePath, journal.newDatabaseId);
  validateEphemeralDatabase(journal.canonicalDatabasePath, journal.newDatabaseId);
}

function restoreOldPair(
  journal: RebuildJournal,
  fault?: (point: EphemeralRecoveryFaultPoint) => void
): void {
  preserveOldMarker(journal);
  const current = databaseIdAt(journal.canonicalDatabasePath);
  const oldAtRecovery = databaseIdAt(journal.oldPath);
  const currentMarkerBeforeRestore = markerIdAt(
    markerPath(journal.canonicalDatabasePath),
    journal.canonicalDatabasePath
  );
  if (
    (current === journal.newDatabaseId && oldAtRecovery !== journal.expectedOldDatabaseId) ||
    (current === null && oldAtRecovery !== journal.expectedOldDatabaseId) ||
    (current === journal.expectedOldDatabaseId && oldAtRecovery !== null)
  ) {
    throw new SQLiteFoundationError('recovery_required', 'Restore preflight cannot prove one exact old database source.');
  }
  if (
    currentMarkerBeforeRestore !== null &&
    currentMarkerBeforeRestore !== journal.newDatabaseId &&
    currentMarkerBeforeRestore !== journal.expectedOldDatabaseId
  ) {
    throw new SQLiteFoundationError('recovery_required', 'Restore preflight found an unknown marker identity.');
  }
  if (current === journal.newDatabaseId) {
    if (existsSync(journal.abandonedNewPath)) {
      throw new SQLiteFoundationError('recovery_required', 'The abandoned-new database path is already occupied.');
    }
    renameSync(journal.canonicalDatabasePath, journal.abandonedNewPath);
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fsyncDirectory(journal.recoveryDirectory);
    fault?.('after_recovery_new_database_abandoned');
  } else if (current !== null && current !== journal.expectedOldDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'Restore found an unknown database identity at the target.');
  }

  if (databaseIdAt(journal.canonicalDatabasePath) === null) {
    if (databaseIdAt(journal.oldPath) !== journal.expectedOldDatabaseId) {
      throw new SQLiteFoundationError('recovery_required', 'Restore cannot locate the exact old database.');
    }
    renameSync(journal.oldPath, journal.canonicalDatabasePath);
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fsyncDirectory(journal.recoveryDirectory);
    fault?.('after_recovery_old_database_restored');
  } else if (existsSync(journal.oldPath)) {
    throw new SQLiteFoundationError('recovery_required', 'Two paths claim the old database identity during restore.');
  }

  const currentMarkerPath = markerPath(journal.canonicalDatabasePath);
  const currentMarkerId = markerIdAt(currentMarkerPath, journal.canonicalDatabasePath);
  if (currentMarkerId === journal.newDatabaseId) {
    if (existsSync(journal.abandonedNewMarkerPath)) {
      throw new SQLiteFoundationError('recovery_required', 'The abandoned-new marker path is already occupied.');
    }
    renameSync(currentMarkerPath, journal.abandonedNewMarkerPath);
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fsyncDirectory(journal.recoveryDirectory);
    fault?.('after_recovery_new_marker_abandoned');
  } else if (currentMarkerId !== null && currentMarkerId !== journal.expectedOldDatabaseId) {
    throw new SQLiteFoundationError('recovery_required', 'Restore found an unknown marker identity at the target.');
  }

  if (markerIdAt(currentMarkerPath, journal.canonicalDatabasePath) === null) {
    renameSync(journal.oldMarkerPath, currentMarkerPath);
    fsyncDirectory(dirname(journal.canonicalDatabasePath));
    fsyncDirectory(journal.recoveryDirectory);
    fault?.('after_recovery_old_marker_restored');
  }
  readMarker(currentMarkerPath, journal.canonicalDatabasePath, journal.expectedOldDatabaseId);
  validateEphemeralDatabase(journal.canonicalDatabasePath, journal.expectedOldDatabaseId);
}

export function rebuildEphemeralSQLite(input: {
  readonly databasePath: string;
  readonly expectedDatabaseId: string;
  readonly recoveryDirectory: string;
  readonly fault?: (point: EphemeralRebuildFaultPoint) => void;
}): { readonly oldDatabaseId: string; readonly newDatabaseId: string; readonly backupPath: string; readonly archivedJournalPath: string } {
  const path = canonicalSQLiteTarget(input.databasePath);
  ensureUnderTemporaryRoot(path);
  const recoveryDirectory = validateRecoveryDirectory(input.recoveryDirectory, path);
  const lock = acquireSQLiteRebuildStartLock(path, recoveryDirectory);
  try {
    if (listSQLiteOwners(path).length !== 0) throw new SQLiteFoundationError('database_busy', 'An ephemeral database cannot rebuild with live owners.');
    const paths = sqliteCoordinationPaths(path);
    if (existsSync(paths.rebuildJournal)) throw new SQLiteFoundationError('recovery_required', 'An interrupted rebuild must be recovered first.');
    const oldMarker = readMarker(markerPath(path), path, input.expectedDatabaseId);
    validateEphemeralDatabase(path, oldMarker.databaseId);

    const source = new Database(path, { create: false, strict: true });
    let backup: Buffer;
    try {
      source.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
      source.exec('BEGIN EXCLUSIVE;');
      backup = source.serialize();
      source.exec('COMMIT;');
    } finally {
      if (source.inTransaction) source.exec('ROLLBACK;');
      source.close();
    }
    if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
      throw new SQLiteFoundationError('rebuild_refused', 'The checkpointed ephemeral database retained an unexpected WAL/SHM sidecar.');
    }
    if (backup.byteLength > 16 * 1024 * 1024) {
      throw new SQLiteFoundationError('rebuild_refused', 'The bounded ephemeral rebuild refuses databases above 16 MiB.');
    }

    const token = randomBytes(8).toString('hex');
    const buildingPath = join(dirname(path), `${basename(path)}.building-${token}`);
    const buildingState = createEphemeralSQLiteFile(buildingPath);
    const buildingMarker = readMarker(markerPath(buildingPath), buildingPath, buildingState.databaseId!);
    const finalMarkerTemporaryPath = join(dirname(path), `${basename(path)}.new-marker-${token}.json`);
    if (existsSync(finalMarkerTemporaryPath)) {
      throw new SQLiteFoundationError('rebuild_refused', 'The replacement marker path already exists.');
    }
    writeExclusive(finalMarkerTemporaryPath, markerJson({
      ...buildingMarker,
      canonicalDatabasePath: path
    }));
    const backupPath = join(recoveryDirectory, `${basename(path)}.backup-${token}`);
    const oldPath = join(recoveryDirectory, `${basename(path)}.old-${token}`);
    const oldMarkerPath = join(recoveryDirectory, `${basename(path)}.old-marker-${token}.json`);
    const abandonedNewPath = join(recoveryDirectory, `${basename(path)}.abandoned-new-${token}`);
    const abandonedNewMarkerPath = join(recoveryDirectory, `${basename(path)}.abandoned-new-marker-${token}.json`);
    for (const candidate of [backupPath, oldPath, oldMarkerPath, abandonedNewPath, abandonedNewMarkerPath, paths.rebuildJournal]) {
      if (existsSync(candidate)) throw new SQLiteFoundationError('rebuild_refused', 'A rebuild recovery artifact path already exists.', { candidate });
    }
    writeExclusive(backupPath, backup);
    validateEphemeralDatabase(backupPath, oldMarker.databaseId);
    fsyncDirectory(recoveryDirectory);

    let journal: RebuildJournal = {
      formatVersion: 1,
      rebuildLockId: lock.journalLockId!,
      canonicalDatabasePath: path,
      recoveryDirectory,
      expectedOldDatabaseId: oldMarker.databaseId,
      newDatabaseId: buildingState.databaseId!,
      buildingPath,
      buildingMarkerPath: finalMarkerTemporaryPath,
      oldPath,
      oldMarkerPath,
      backupPath,
      abandonedNewPath,
      abandonedNewMarkerPath,
      stage: 'prepared'
    };
    input.fault?.('before_journal');
    writeExclusive(paths.rebuildJournal, `${JSON.stringify(journal)}\n`);
    fsyncDirectory(dirname(path));
    input.fault?.('prepared');

    preserveOldMarker(journal);
    input.fault?.('after_marker_preserve_before_stage');
    journal = { ...journal, stage: 'marker_preserved' };
    replaceJournal(paths.rebuildJournal, journal);
    input.fault?.('marker_preserved');

    renameSync(path, oldPath);
    fsyncDirectory(dirname(path));
    fsyncDirectory(recoveryDirectory);
    input.fault?.('after_old_move_before_stage');
    journal = { ...journal, stage: 'old_moved' };
    replaceJournal(paths.rebuildJournal, journal);
    input.fault?.('old_moved');

    renameSync(buildingPath, path);
    fsyncDirectory(dirname(path));
    input.fault?.('after_new_database_move_before_stage');
    journal = { ...journal, stage: 'new_database_installed' };
    replaceJournal(paths.rebuildJournal, journal);
    input.fault?.('new_database_installed');

    renameSync(finalMarkerTemporaryPath, markerPath(path));
    fsyncDirectory(dirname(path));
    input.fault?.('after_new_marker_move_before_stage');
    journal = { ...journal, stage: 'new_installed' };
    replaceJournal(paths.rebuildJournal, journal);
    input.fault?.('new_installed');
    readMarker(markerPath(path), path, journal.newDatabaseId);
    validateEphemeralDatabase(path, journal.newDatabaseId);
    journal = { ...journal, stage: 'verified' };
    replaceJournal(paths.rebuildJournal, journal);
    input.fault?.('verified');
    const archivedJournalPath = archiveJournal(paths.rebuildJournal, journal, 'complete');
    return {
      oldDatabaseId: journal.expectedOldDatabaseId,
      newDatabaseId: journal.newDatabaseId,
      backupPath: journal.backupPath,
      archivedJournalPath
    };
  } finally {
    lock.release();
  }
}

export function recoverEphemeralSQLiteRebuild(input: {
  readonly databasePath: string;
  readonly action: 'restore' | 'complete';
  readonly fault?: (point: EphemeralRecoveryFaultPoint) => void;
}): { readonly databaseId: string; readonly archivedJournalPath: string } {
  const path = canonicalSQLiteTarget(input.databasePath);
  ensureUnderTemporaryRoot(path);
  const paths = sqliteCoordinationPaths(path);
  const observedJournal = readJournal(paths.rebuildJournal, path);
  const lock = acquireSQLiteRebuildRecoveryLock({
    canonicalDatabasePath: path,
    recoveryDirectory: observedJournal.recoveryDirectory,
    journalLockId: observedJournal.rebuildLockId
  });
  try {
    const journal = readJournal(paths.rebuildJournal, path);
    if (JSON.stringify(journal) !== JSON.stringify(observedJournal)) {
      throw new SQLiteFoundationError('recovery_required', 'The rebuild journal changed while recovery ownership was established.');
    }
    if (listSQLiteOwners(path).length !== 0) throw new SQLiteFoundationError('database_busy', 'Recovery requires zero live owners.');
    if (input.action === 'complete') {
      completeNewPair(journal, input.fault);
      const archivedJournalPath = archiveJournal(paths.rebuildJournal, journal, 'recovered-complete');
      return { databaseId: journal.newDatabaseId, archivedJournalPath };
    }

    restoreOldPair(journal, input.fault);
    const archivedJournalPath = archiveJournal(paths.rebuildJournal, journal, 'restored');
    return { databaseId: journal.expectedOldDatabaseId, archivedJournalPath };
  } finally {
    lock.release();
  }
}
