import { createHash, randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { SQLiteFoundationError } from './foundation-errors';
import type { SQLiteFoundationErrorCode } from './foundation-errors';
import {
  acquireSQLiteExclusiveLock,
  canonicalSQLiteTarget,
  listSQLiteOwners,
  sqliteFileIdentity
} from './file-ownership';
import {
  loadSQLiteFoundationArtifacts,
  validateManagedSQLiteCoordinate,
  type SQLiteDatabaseClass
} from './migration-runner';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import { captureSQLiteSchema, fingerprintSQLiteSchema } from './schema-snapshot';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type RetainedSQLiteDatabaseClass = Extract<
  SQLiteDatabaseClass,
  'retained_development' | 'frozen_release'
>;

export interface RetainedSQLiteBackupDescriptor {
  readonly formatVersion: 1;
  readonly identityKind: 'managed' | 'untracked_legacy';
  readonly databaseId: string | null;
  readonly databaseClass: RetainedSQLiteDatabaseClass;
  readonly schemaFingerprintSha256: string;
  readonly migrationId: string;
  readonly schemaEpoch: number;
  readonly sequence: number;
  readonly bytes: number;
  readonly sha256: string;
}

function refuse(
  code: SQLiteFoundationErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new SQLiteFoundationError(code, message, details);
}

function assertBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse('backup_refused', 'A retained SQLite backup requires a positive byte ceiling.');
  }
}

function assertDirectFile(path: string, maximumBytes: number): number {
  const stat = lstatSync(path);
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes
  ) {
    refuse('backup_refused', 'A retained SQLite backup artifact has an unsafe file shape.', { path });
  }
  return stat.size;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeSerializedJournalHeader(serialized: Uint8Array): Buffer {
  const bytes = Buffer.from(serialized);
  if (
    bytes.byteLength < 100 ||
    bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
    ![1, 2].includes(bytes[18] ?? 0) ||
    ![1, 2].includes(bytes[19] ?? 0)
  ) {
    return refuse('backup_invalid', 'SQLite serialization returned an invalid database header.');
  }
  // serialize() returns a complete checkpointed page image, but preserves the
  // source WAL mode bytes. A standalone backup has no WAL and must open read-only,
  // so record the standard rollback-journal read/write format in its file header.
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  assertDirectFile(path, bytes.byteLength);
  fsyncDirectory(dirname(path));
}

function assertIntegrity(database: Database): void {
  try {
    const integrity = database.query<{ readonly integrity_check: string }, []>(
      'PRAGMA integrity_check'
    ).all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      refuse('backup_invalid', 'The retained SQLite artifact failed integrity verification.');
    }
    if (database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all().length !== 0) {
      refuse('backup_invalid', 'The retained SQLite artifact failed foreign-key verification.');
    }
  } catch (error) {
    if (error instanceof SQLiteFoundationError) throw error;
    refuse('backup_invalid', 'The retained SQLite artifact could not be parsed for integrity verification.');
  }
}

interface RetainedSQLiteBackupIdentity {
  readonly identityKind: 'managed' | 'untracked_legacy';
  readonly databaseId: string | null;
  readonly databaseClass: RetainedSQLiteDatabaseClass;
  readonly schemaFingerprint: string;
  readonly migrationId: string;
  readonly schemaEpoch: number;
  readonly sequence: number;
}

function validateState(input: {
  readonly database: Database;
  readonly expectedDatabaseId?: string;
  readonly expectedDatabaseClass: RetainedSQLiteDatabaseClass;
}): RetainedSQLiteBackupIdentity {
  assertIntegrity(input.database);
  const applicationFingerprint = fingerprintSQLiteSchema(
    captureSQLiteSchema(input.database, 'application')
  );
  const runnerObjectCount = input.database.query<{ readonly count: number }, []>(`
    SELECT count(*) AS count FROM sqlite_schema
     WHERE name IN ('schema_migrations','schema_epoch_transitions','database_instance_metadata')
        OR tbl_name IN ('schema_migrations','schema_epoch_transitions','database_instance_metadata')
  `).get()?.count ?? 0;
  const predecessor = SQLITE_MIGRATION_MANIFEST.acceptedPredecessorLineages[0];
  if (runnerObjectCount === 0 && applicationFingerprint === predecessor.sourceApplicationFingerprint) {
    if (input.expectedDatabaseClass !== 'retained_development' || input.expectedDatabaseId !== undefined) {
      refuse('backup_invalid', 'The untracked legacy backup has no database ID and can only be retained development.');
    }
    return {
      identityKind: 'untracked_legacy',
      databaseId: null,
      databaseClass: 'retained_development',
      schemaFingerprint: applicationFingerprint,
      migrationId: predecessor.sourceTerminal.migrationId,
      schemaEpoch: predecessor.sourceTerminal.schemaEpoch,
      sequence: predecessor.sourceTerminal.sequence
    };
  }
  if (!input.expectedDatabaseId) {
    refuse('backup_invalid', 'A managed retained SQLite artifact requires its expected database ID.');
  }
  const state = validateManagedSQLiteCoordinate({
    database: input.database,
    artifacts: loadSQLiteFoundationArtifacts(),
    databaseClass: input.expectedDatabaseClass
  });
  if (
    state.databaseId !== input.expectedDatabaseId ||
    state.databaseClass !== input.expectedDatabaseClass ||
    !state.schemaFingerprint || !state.migrationId || !state.coordinate
  ) {
    refuse('backup_invalid', 'The retained SQLite artifact does not match its expected identity.');
  }
  return {
    identityKind: 'managed',
    databaseId: state.databaseId,
    databaseClass: state.databaseClass,
    schemaFingerprint: state.schemaFingerprint,
    migrationId: state.migrationId,
    schemaEpoch: state.coordinate.schemaEpoch,
    sequence: state.coordinate.sequence
  };
}

function descriptorFrom(input: {
  readonly bytes: Uint8Array;
  readonly state: RetainedSQLiteBackupIdentity;
}): RetainedSQLiteBackupDescriptor {
  const { state } = input;
  return Object.freeze({
    formatVersion: 1,
    identityKind: state.identityKind,
    databaseId: state.databaseId,
    databaseClass: state.databaseClass,
    schemaFingerprintSha256: state.schemaFingerprint,
    migrationId: state.migrationId,
    schemaEpoch: state.schemaEpoch,
    sequence: state.sequence,
    bytes: input.bytes.byteLength,
    sha256: digest(input.bytes)
  });
}

function sameDescriptor(
  actual: RetainedSQLiteBackupDescriptor,
  expected: RetainedSQLiteBackupDescriptor
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Verifies an inert retained backup or restore candidate without creating SQLite
 * owner records, sidecars, migrations, or application state.
 */
export function verifyRetainedSQLiteBackup(input: {
  readonly backupPath: string;
  readonly expectedDatabaseId?: string;
  readonly expectedDatabaseClass: RetainedSQLiteDatabaseClass;
  readonly maximumBytes: number;
  readonly expectedDescriptor?: RetainedSQLiteBackupDescriptor;
}): RetainedSQLiteBackupDescriptor {
  assertBound(input.maximumBytes);
  const path = canonicalSQLiteTarget(input.backupPath);
  if (!existsSync(path)) refuse('backup_missing', 'The retained SQLite backup is missing.');
  const size = assertDirectFile(path, input.maximumBytes);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== size) {
    return refuse('backup_invalid', 'The retained SQLite backup changed while it was read.');
  }

  const database = new Database(path, { readonly: true, create: false, strict: true });
  let state: RetainedSQLiteBackupIdentity;
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    state = validateState({
      database,
      ...(input.expectedDatabaseId ? { expectedDatabaseId: input.expectedDatabaseId } : {}),
      expectedDatabaseClass: input.expectedDatabaseClass
    });
  } finally {
    database.close();
  }
  const descriptor = descriptorFrom({ bytes, state });
  if (input.expectedDescriptor && !sameDescriptor(descriptor, input.expectedDescriptor)) {
    return refuse('backup_invalid', 'The retained SQLite backup descriptor does not match.');
  }
  return descriptor;
}

/**
 * Creates one offline, verified retained backup. The caller must stop every runtime
 * owner first and supply an unused exact destination plus an explicit memory ceiling.
 */
export function createRetainedSQLiteBackup(input: {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly expectedDatabaseId?: string;
  readonly expectedDatabaseClass: RetainedSQLiteDatabaseClass;
  readonly maximumSerializeBytes: number;
}): RetainedSQLiteBackupDescriptor {
  assertBound(input.maximumSerializeBytes);
  const sourcePath = canonicalSQLiteTarget(input.databasePath);
  const backupPath = canonicalSQLiteTarget(input.backupPath);
  if (!existsSync(sourcePath)) refuse('backup_missing', 'The retained SQLite source is missing.');
  if (sourcePath === backupPath || existsSync(backupPath)) {
    refuse('backup_refused', 'The retained SQLite backup requires an unused distinct destination.');
  }

  const sourceIdentity = sqliteFileIdentity(sourcePath);
  const lock = acquireSQLiteExclusiveLock(sourcePath, 'rebuild');
  try {
    if (listSQLiteOwners(sourcePath).length !== 0) {
      refuse('database_busy', 'Every SQLite runtime owner must stop before retained backup.');
    }
    if (existsSync(backupPath)) {
      refuse('backup_refused', 'The retained SQLite backup destination became occupied.');
    }

    const mainSize = statSync(sourcePath).size;
    const walPath = `${sourcePath}-wal`;
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    if (
      !Number.isSafeInteger(mainSize + walSize) ||
      mainSize + walSize > input.maximumSerializeBytes
    ) {
      refuse('backup_too_large', 'The retained SQLite source exceeds its configured serialization ceiling.');
    }

    const source = new Database(sourcePath, { create: false, strict: true });
    let bytes: Buffer;
    try {
      source.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
      const checkpoint = source.query<{
        readonly busy: number;
        readonly log: number;
        readonly checkpointed: number;
      }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (!checkpoint || checkpoint.busy !== 0) {
        return refuse('database_busy', 'The retained SQLite WAL could not be checkpointed for backup.');
      }
      source.exec('BEGIN EXCLUSIVE;');
      validateState({
        database: source,
        ...(input.expectedDatabaseId ? { expectedDatabaseId: input.expectedDatabaseId } : {}),
        expectedDatabaseClass: input.expectedDatabaseClass
      });
      bytes = normalizeSerializedJournalHeader(source.serialize());
      source.exec('COMMIT;');
    } finally {
      if (source.inTransaction) source.exec('ROLLBACK;');
      source.close();
    }
    if (bytes.byteLength > input.maximumSerializeBytes) {
      return refuse('backup_too_large', 'The serialized retained SQLite backup exceeds its configured ceiling.');
    }
    const finalIdentity = sqliteFileIdentity(sourcePath);
    if (
      finalIdentity.device !== sourceIdentity.device ||
      finalIdentity.inode !== sourceIdentity.inode
    ) {
      return refuse('backup_refused', 'The retained SQLite source identity changed during backup.');
    }

    writeExclusive(backupPath, bytes);
    return verifyRetainedSQLiteBackup({
      backupPath,
      ...(input.expectedDatabaseId ? { expectedDatabaseId: input.expectedDatabaseId } : {}),
      expectedDatabaseClass: input.expectedDatabaseClass,
      maximumBytes: input.maximumSerializeBytes
    });
  } finally {
    lock.release();
  }
}

/**
 * Copies a verified backup to a fresh path and re-verifies it as a restore candidate.
 * It never replaces, renames, or removes an existing database.
 */
export function createVerifiedRetainedSQLiteRestoreCandidate(input: {
  readonly backupPath: string;
  readonly restoreCandidatePath: string;
  readonly expectedDescriptor: RetainedSQLiteBackupDescriptor;
  readonly maximumBytes: number;
}): RetainedSQLiteBackupDescriptor {
  assertBound(input.maximumBytes);
  const backup = verifyRetainedSQLiteBackup({
    backupPath: input.backupPath,
    ...(input.expectedDescriptor.databaseId
      ? { expectedDatabaseId: input.expectedDescriptor.databaseId }
      : {}),
    expectedDatabaseClass: input.expectedDescriptor.databaseClass,
    expectedDescriptor: input.expectedDescriptor,
    maximumBytes: input.maximumBytes
  });
  const sourcePath = canonicalSQLiteTarget(input.backupPath);
  const candidatePath = canonicalSQLiteTarget(input.restoreCandidatePath);
  if (sourcePath === candidatePath || existsSync(candidatePath)) {
    refuse('restore_refused', 'A restore rehearsal requires an unused distinct candidate path.');
  }
  const bytes = readFileSync(sourcePath);
  if (bytes.byteLength !== backup.bytes || digest(bytes) !== backup.sha256) {
    return refuse('backup_invalid', 'The retained SQLite backup changed before restore rehearsal.');
  }
  writeExclusive(candidatePath, bytes);
  return verifyRetainedSQLiteBackup({
    backupPath: candidatePath,
    ...(backup.databaseId ? { expectedDatabaseId: backup.databaseId } : {}),
    expectedDatabaseClass: backup.databaseClass,
    expectedDescriptor: backup,
    maximumBytes: input.maximumBytes
  });
}

/** Generates an unused-looking backup filename token without selecting a directory. */
export function newRetainedSQLiteBackupToken(): string {
  return randomBytes(16).toString('hex');
}
