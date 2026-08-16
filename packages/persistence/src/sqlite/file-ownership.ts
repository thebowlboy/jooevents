import { Database } from 'bun:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SQLiteFoundationError } from './foundation-errors';
import { assertRecordedProcessDead, currentProcessStartToken } from './process-identity';
import { loadSQLiteFoundationArtifacts, migrateOrValidateSQLite } from './migration-runner';
import { captureSQLiteSchema, fingerprintSQLiteSchema } from './schema-snapshot';

export type SQLiteOwnerKind = 'ordinary' | 'pending-adoption' | 'pending-create';

interface OwnerRecord {
  readonly formatVersion: 1;
  readonly ownerId: string;
  readonly kind: SQLiteOwnerKind;
  readonly canonicalDatabasePath: string;
  readonly pid: number;
  readonly processStartToken: string | null;
  readonly createdAt: number;
  readonly targetDevice?: string;
  readonly targetInode?: string;
  readonly databaseId?: string;
  readonly sourceFingerprint?: string;
}

export interface SQLiteFileIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface SQLiteFileOwner {
  readonly ownerId: string;
  readonly canonicalDatabasePath: string;
  readonly kind: SQLiteOwnerKind;
  promote(databaseId: string): void;
  release(): void;
}

export interface SQLiteExclusiveLock {
  readonly path: string;
  readonly lockId: string;
  /** Stable origin binding retained across explicit crashed-lock recovery. */
  readonly journalLockId: string | null;
  release(): void;
}

interface CoordinationLockRecord {
  readonly formatVersion: 1;
  readonly lockId: string;
  readonly kind: 'migration' | 'rebuild' | 'recovery';
  readonly canonicalDatabasePath: string;
  readonly pid: number;
  readonly processStartToken: string | null;
  readonly createdAt: number;
  readonly journalLockId?: string;
  readonly expectedJournalPath?: string;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function fsyncDirectoryPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularSingleLink(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new SQLiteFoundationError(
      'database_path_unsafe',
      'SQLite targets and coordination records must be regular single-link files.',
      { path }
    );
  }
}

export function sqliteFileIdentity(path: string): SQLiteFileIdentity {
  assertRegularSingleLink(path);
  const stat = lstatSync(path, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function sameFileIdentity(left: SQLiteFileIdentity, right: SQLiteFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function canonicalSQLiteTarget(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new SQLiteFoundationError('database_path_unsafe', 'File-backed SQLite paths must be absolute and normalized.');
  }
  const requestedParent = dirname(path);
  const canonicalParent = realpathSync(requestedParent);
  const parentStat = lstatSync(canonicalParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new SQLiteFoundationError('database_path_unsafe', 'The SQLite parent must be a real directory.');
  }
  const canonical = join(canonicalParent, basename(path));
  if (existsSync(canonical)) assertRegularSingleLink(canonical);
  return canonical;
}

export function sqliteCoordinationPaths(canonicalDatabasePath: string) {
  return {
    owners: `${canonicalDatabasePath}.jooevents-owners`,
    migrationLock: `${canonicalDatabasePath}.jooevents-migrate.lock`,
    rebuildLock: `${canonicalDatabasePath}.jooevents-rebuild.lock`,
    recoveryLock: `${canonicalDatabasePath}.jooevents-rebuild-recovery.lock`,
    rebuildJournal: `${canonicalDatabasePath}.jooevents-rebuild.json`
  } as const;
}

function ensureOwnersDirectory(path: string): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new SQLiteFoundationError(
      'owner_record_malformed',
      'The SQLite owners path must be a private real directory.',
      { path }
    );
  }
}

function parseOwnerRecord(path: string): OwnerRecord {
  assertRegularSingleLink(path);
  const stat = lstatSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new SQLiteFoundationError('owner_record_malformed', 'SQLite owner records must be owner-only.', { path });
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SQLiteFoundationError('owner_record_malformed', 'A SQLite owner record is not valid JSON.', { path });
  }
  const record = value as Partial<OwnerRecord>;
  if (
    record.formatVersion !== 1 || typeof record.ownerId !== 'string' || !/^[0-9a-f]{32}$/.test(record.ownerId) ||
    (record.kind !== 'ordinary' && record.kind !== 'pending-adoption' && record.kind !== 'pending-create') ||
    typeof record.canonicalDatabasePath !== 'string' || !Number.isInteger(record.pid) || (record.pid ?? 0) <= 0 ||
    (record.processStartToken !== null && (
      typeof record.processStartToken !== 'string' || !/^[0-9a-f]{64}$/.test(record.processStartToken)
    )) ||
    !Number.isInteger(record.createdAt) || (record.createdAt ?? -1) < 0 ||
    (record.kind !== 'pending-create' && (
      typeof record.targetDevice !== 'string' || !/^\d+$/.test(record.targetDevice) ||
      typeof record.targetInode !== 'string' || !/^\d+$/.test(record.targetInode)
    )) ||
    (record.kind === 'pending-create' && (record.targetDevice !== undefined || record.targetInode !== undefined)) ||
    (record.kind === 'ordinary' && (typeof record.databaseId !== 'string' || !/^[0-9a-f]{32}$/.test(record.databaseId))) ||
    (record.kind === 'pending-adoption' && (
      typeof record.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.sourceFingerprint)
    ))
  ) {
    throw new SQLiteFoundationError('owner_record_malformed', 'A SQLite owner record has an invalid shape.', { path });
  }
  return record as OwnerRecord;
}

export function listSQLiteOwners(canonicalDatabasePath: string): readonly OwnerRecord[] {
  const ownersPath = sqliteCoordinationPaths(canonicalDatabasePath).owners;
  if (!existsSync(ownersPath)) return [];
  ensureOwnersDirectory(ownersPath);
  return readdirSync(ownersPath).sort().map((name) => {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) {
      throw new SQLiteFoundationError('owner_record_malformed', 'The SQLite owners directory contains an unknown entry.', { name });
    }
    return parseOwnerRecord(join(ownersPath, name));
  });
}

function canonicalOwnerJson(record: OwnerRecord): string {
  return `${JSON.stringify({
    canonicalDatabasePath: record.canonicalDatabasePath,
    createdAt: record.createdAt,
    ...(record.databaseId ? { databaseId: record.databaseId } : {}),
    formatVersion: record.formatVersion,
    kind: record.kind,
    ownerId: record.ownerId,
    pid: record.pid,
    processStartToken: record.processStartToken,
    ...(record.targetDevice ? { targetDevice: record.targetDevice } : {}),
    ...(record.targetInode ? { targetInode: record.targetInode } : {}),
    ...(record.sourceFingerprint ? { sourceFingerprint: record.sourceFingerprint } : {})
  })}\n`;
}

function writeExclusivePrivateFile(path: string, contents: string): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  assertRegularSingleLink(path);
}

export function acquireSQLiteOwner(input: {
  readonly canonicalDatabasePath: string;
  readonly kind: SQLiteOwnerKind;
  readonly databaseId?: string;
  readonly sourceFingerprint?: string;
  readonly expectedFileIdentity?: SQLiteFileIdentity;
}): SQLiteFileOwner {
  const paths = sqliteCoordinationPaths(input.canonicalDatabasePath);
  if (existsSync(paths.rebuildLock) || existsSync(paths.recoveryLock) || existsSync(paths.rebuildJournal)) {
    throw new SQLiteFoundationError('recovery_required', 'SQLite rebuild or recovery is in progress.');
  }
  if (input.kind === 'ordinary' && (typeof input.databaseId !== 'string' || !/^[0-9a-f]{32}$/.test(input.databaseId))) {
    throw new SQLiteFoundationError('owner_record_malformed', 'An ordinary SQLite owner requires an exact database identity.');
  }
  if (input.kind === 'pending-adoption' && (
    typeof input.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(input.sourceFingerprint)
  )) {
    throw new SQLiteFoundationError('owner_record_malformed', 'A pending-adoption owner requires the exact source fingerprint.');
  }
  if (input.kind === 'pending-create' && existsSync(input.canonicalDatabasePath)) {
    throw new SQLiteFoundationError('database_busy', 'A pending-create owner cannot bind an existing SQLite target.');
  }
  const targetIdentity = input.kind === 'pending-create'
    ? undefined
    : sqliteFileIdentity(input.canonicalDatabasePath);
  if (targetIdentity && input.expectedFileIdentity && !sameFileIdentity(targetIdentity, input.expectedFileIdentity)) {
    throw new SQLiteFoundationError('database_path_unsafe', 'The SQLite target identity changed before ownership was established.');
  }
  ensureOwnersDirectory(paths.owners);
  const existing = listSQLiteOwners(input.canonicalDatabasePath);
  if (existing.some((owner) => owner.canonicalDatabasePath !== input.canonicalDatabasePath)) {
    throw new SQLiteFoundationError('owner_record_malformed', 'An existing SQLite owner record binds another canonical target.');
  }
  if (
    targetIdentity && existing.some((owner) =>
      owner.targetDevice !== targetIdentity.device || owner.targetInode !== targetIdentity.inode
    )
  ) {
    throw new SQLiteFoundationError('database_path_unsafe', 'An existing SQLite owner record binds another file identity.');
  }
  if (input.kind !== 'ordinary' && existing.length > 0) {
    throw new SQLiteFoundationError('database_busy', 'An untracked SQLite database cannot be adopted while another owner exists.');
  }
  if (input.kind === 'ordinary' && existing.some((owner) => owner.kind !== 'ordinary' || owner.databaseId !== input.databaseId)) {
    throw new SQLiteFoundationError('database_busy', 'SQLite ownership is held by a different database identity or pending transition.');
  }

  const ownerId = randomBytes(16).toString('hex');
  const createdAt = Date.now();
  const processStartToken = currentProcessStartToken();
  let kind = input.kind;
  const recordPath = join(paths.owners, `${ownerId}.json`);
  let released = false;
  const record = (): OwnerRecord => ({
    formatVersion: 1,
    ownerId,
    kind,
    canonicalDatabasePath: input.canonicalDatabasePath,
    pid: process.pid,
    processStartToken,
    createdAt,
    ...(targetIdentity ? { targetDevice: targetIdentity.device, targetInode: targetIdentity.inode } : {}),
    ...(kind === 'ordinary' && input.databaseId ? { databaseId: input.databaseId } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {})
  });
  writeExclusivePrivateFile(recordPath, canonicalOwnerJson(record()));
  fsyncDirectoryPath(paths.owners);
  if (targetIdentity && !sameFileIdentity(targetIdentity, sqliteFileIdentity(input.canonicalDatabasePath))) {
    safeUnlink(recordPath);
    throw new SQLiteFoundationError('database_path_unsafe', 'The SQLite target identity changed while ownership was established.');
  }
  if (existsSync(paths.rebuildLock) || existsSync(paths.recoveryLock) || existsSync(paths.rebuildJournal)) {
    safeUnlink(recordPath);
    throw new SQLiteFoundationError('recovery_required', 'SQLite rebuild began while ownership was being established.');
  }

  return {
    ownerId,
    canonicalDatabasePath: input.canonicalDatabasePath,
    get kind() { return kind; },
    promote(databaseId: string) {
      if (released || kind === 'ordinary') return;
      if (!/^[0-9a-f]{32}$/.test(databaseId)) {
        throw new SQLiteFoundationError('owner_record_malformed', 'Cannot promote an owner without a valid database identity.');
      }
      const currentIdentity = sqliteFileIdentity(input.canonicalDatabasePath);
      if (targetIdentity && !sameFileIdentity(targetIdentity, currentIdentity)) {
        throw new SQLiteFoundationError('database_path_unsafe', 'The SQLite target identity changed before owner promotion.');
      }
      const promoted: OwnerRecord = {
        ...record(),
        kind: 'ordinary',
        databaseId,
        targetDevice: currentIdentity.device,
        targetInode: currentIdentity.inode
      };
      const temporary = join(paths.owners, `${ownerId}.promote-${randomBytes(8).toString('hex')}`);
      writeExclusivePrivateFile(temporary, canonicalOwnerJson(promoted));
      renameSync(temporary, recordPath);
      fsyncDirectoryPath(paths.owners);
      kind = 'ordinary';
    },
    release() {
      if (released) return;
      assertRegularSingleLink(recordPath);
      const current = parseOwnerRecord(recordPath);
      if (
        current.ownerId !== ownerId || current.pid !== process.pid ||
        current.processStartToken !== processStartToken ||
        current.canonicalDatabasePath !== input.canonicalDatabasePath
      ) {
        throw new SQLiteFoundationError('owner_record_malformed', 'Refusing to release an owner record that changed identity.');
      }
      if (
        current.targetDevice !== undefined && current.targetInode !== undefined &&
        !sameFileIdentity(
          { device: current.targetDevice, inode: current.targetInode },
          sqliteFileIdentity(input.canonicalDatabasePath)
        )
      ) {
        throw new SQLiteFoundationError('database_path_unsafe', 'Refusing to release ownership after the SQLite target identity changed.');
      }
      safeUnlink(recordPath);
      fsyncDirectoryPath(paths.owners);
      released = true;
    }
  };
}

function waitBriefly(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function canonicalLockJson(record: CoordinationLockRecord): string {
  return `${JSON.stringify({
    canonicalDatabasePath: record.canonicalDatabasePath,
    createdAt: record.createdAt,
    ...(record.expectedJournalPath ? { expectedJournalPath: record.expectedJournalPath } : {}),
    formatVersion: record.formatVersion,
    ...(record.journalLockId ? { journalLockId: record.journalLockId } : {}),
    kind: record.kind,
    lockId: record.lockId,
    pid: record.pid,
    processStartToken: record.processStartToken
  })}\n`;
}

function parseCoordinationLock(path: string): CoordinationLockRecord {
  assertRegularSingleLink(path);
  const stat = lstatSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new SQLiteFoundationError('owner_record_malformed', 'SQLite coordination locks must be owner-only.', { path });
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SQLiteFoundationError('owner_record_malformed', 'A SQLite coordination lock is not valid JSON.', { path });
  }
  const record = value as Partial<CoordinationLockRecord>;
  if (
    record.formatVersion !== 1 || typeof record.lockId !== 'string' || !/^[0-9a-f]{32}$/.test(record.lockId) ||
    (record.kind !== 'migration' && record.kind !== 'rebuild' && record.kind !== 'recovery') ||
    typeof record.canonicalDatabasePath !== 'string' || !Number.isInteger(record.pid) || (record.pid ?? 0) <= 0 ||
    (record.processStartToken !== null && (
      typeof record.processStartToken !== 'string' || !/^[0-9a-f]{64}$/.test(record.processStartToken)
    )) ||
    !Number.isInteger(record.createdAt) || (record.createdAt ?? -1) < 0 ||
    (record.kind === 'rebuild' && (
      typeof record.journalLockId !== 'string' || !/^[0-9a-f]{32}$/.test(record.journalLockId) ||
      typeof record.expectedJournalPath !== 'string'
    )) ||
    (record.kind !== 'rebuild' && (record.journalLockId !== undefined || record.expectedJournalPath !== undefined))
  ) {
    throw new SQLiteFoundationError('owner_record_malformed', 'A SQLite coordination lock has an invalid shape.', { path });
  }
  return record as CoordinationLockRecord;
}

function makeCoordinationLock(input: {
  readonly canonicalDatabasePath: string;
  readonly path: string;
  readonly kind: CoordinationLockRecord['kind'];
  readonly journalLockId?: string;
}): SQLiteExclusiveLock {
  const lockId = randomBytes(16).toString('hex');
  const record: CoordinationLockRecord = {
    formatVersion: 1,
    lockId,
    kind: input.kind,
    canonicalDatabasePath: input.canonicalDatabasePath,
    pid: process.pid,
    processStartToken: currentProcessStartToken(),
    createdAt: Date.now(),
    ...(input.kind === 'rebuild' ? {
      journalLockId: input.journalLockId ?? lockId,
      expectedJournalPath: sqliteCoordinationPaths(input.canonicalDatabasePath).rebuildJournal
    } : {})
  };
  writeExclusivePrivateFile(input.path, canonicalLockJson(record));
  fsyncDirectoryPath(dirname(input.path));
  let released = false;
  return {
    path: input.path,
    lockId,
    journalLockId: record.journalLockId ?? null,
    release() {
      if (released) return;
      const current = parseCoordinationLock(input.path);
      if (
        current.lockId !== record.lockId || current.kind !== record.kind ||
        current.pid !== record.pid || current.processStartToken !== record.processStartToken ||
        current.canonicalDatabasePath !== record.canonicalDatabasePath ||
        current.journalLockId !== record.journalLockId
      ) {
        throw new SQLiteFoundationError('owner_record_malformed', 'Refusing to release a coordination lock that changed identity.');
      }
      safeUnlink(input.path);
      fsyncDirectoryPath(dirname(input.path));
      released = true;
    }
  };
}

function acquireRecoveryClaim(canonicalDatabasePath: string): SQLiteExclusiveLock {
  const path = sqliteCoordinationPaths(canonicalDatabasePath).recoveryLock;
  while (true) {
    try {
      return makeCoordinationLock({ canonicalDatabasePath, path, kind: 'recovery' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = parseCoordinationLock(path);
      if (stale.kind !== 'recovery' || stale.canonicalDatabasePath !== canonicalDatabasePath) {
        throw new SQLiteFoundationError('owner_record_malformed', 'The rebuild-recovery claim does not match this target.');
      }
      assertRecordedProcessDead(stale.pid, stale.processStartToken);
      // Another recovery may win this exact unlink/create race; O_EXCL in the next
      // loop elects one claimant and the loser observes its live process identity.
      safeUnlink(path);
      fsyncDirectoryPath(dirname(path));
    }
  }
}

function archiveCrashedRebuildLock(input: {
  readonly canonicalDatabasePath: string;
  readonly recoveryDirectory: string;
  readonly expectedJournalLockId?: string;
}): string | null {
  const paths = sqliteCoordinationPaths(input.canonicalDatabasePath);
  if (!existsSync(paths.rebuildLock)) return null;
  const crashed = parseCoordinationLock(paths.rebuildLock);
  if (
    crashed.kind !== 'rebuild' || crashed.canonicalDatabasePath !== input.canonicalDatabasePath ||
    crashed.expectedJournalPath !== paths.rebuildJournal ||
    (input.expectedJournalLockId !== undefined && crashed.journalLockId !== input.expectedJournalLockId)
  ) {
    throw new SQLiteFoundationError('recovery_required', 'The crashed rebuild lock is not bound to the exact recovery journal.');
  }
  assertRecordedProcessDead(crashed.pid, crashed.processStartToken);
  const archived = join(input.recoveryDirectory, `${basename(paths.rebuildLock)}.crashed-${crashed.lockId}`);
  if (existsSync(archived)) {
    throw new SQLiteFoundationError('recovery_required', 'The crashed rebuild-lock archive already exists.', { archived });
  }
  renameSync(paths.rebuildLock, archived);
  fsyncDirectoryPath(dirname(paths.rebuildLock));
  fsyncDirectoryPath(input.recoveryDirectory);
  return archived;
}

function compositeRecoveryLock(rebuild: SQLiteExclusiveLock, claim: SQLiteExclusiveLock): SQLiteExclusiveLock {
  let released = false;
  return {
    path: rebuild.path,
    lockId: rebuild.lockId,
    journalLockId: rebuild.journalLockId,
    release() {
      if (released) return;
      rebuild.release();
      claim.release();
      released = true;
    }
  };
}

export function acquireSQLiteExclusiveLock(
  canonicalDatabasePath: string,
  kind: 'migration' | 'rebuild',
  timeoutMs = 5_000
): SQLiteExclusiveLock {
  const paths = sqliteCoordinationPaths(canonicalDatabasePath);
  const path = kind === 'migration' ? paths.migrationLock : paths.rebuildLock;
  const conflicting = kind === 'migration'
    ? [paths.rebuildLock, paths.recoveryLock]
    : [paths.migrationLock, paths.recoveryLock];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (conflicting.some((candidate) => existsSync(candidate)) || (kind === 'migration' && existsSync(paths.rebuildJournal))) {
      if (Date.now() >= deadline) throw new SQLiteFoundationError('database_busy', 'SQLite coordination is held by another operation.');
      waitBriefly(10);
      continue;
    }
    try {
      const lock = makeCoordinationLock({ canonicalDatabasePath, path, kind });
      if (conflicting.some((candidate) => existsSync(candidate)) || (kind === 'migration' && existsSync(paths.rebuildJournal))) {
        lock.release();
        if (Date.now() >= deadline) throw new SQLiteFoundationError('database_busy', 'SQLite coordination changed during lock acquisition.');
        waitBriefly(10);
        continue;
      }
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new SQLiteFoundationError('database_busy', `Timed out waiting for the SQLite ${kind} lock.`);
      waitBriefly(10);
    }
  }
}

/** Starts or restarts an unstaged ephemeral rebuild after proving any prior lock owner dead. */
export function acquireSQLiteRebuildStartLock(
  canonicalDatabasePath: string,
  recoveryDirectory: string
): SQLiteExclusiveLock {
  const paths = sqliteCoordinationPaths(canonicalDatabasePath);
  const claim = acquireRecoveryClaim(canonicalDatabasePath);
  try {
    if (existsSync(paths.migrationLock)) {
      throw new SQLiteFoundationError('database_busy', 'A migration lock blocks ephemeral rebuild start.');
    }
    if (existsSync(paths.rebuildJournal)) {
      throw new SQLiteFoundationError('recovery_required', 'A staged rebuild must be recovered rather than restarted.');
    }
    archiveCrashedRebuildLock({ canonicalDatabasePath, recoveryDirectory });
    const rebuild = makeCoordinationLock({
      canonicalDatabasePath,
      path: paths.rebuildLock,
      kind: 'rebuild'
    });
    return compositeRecoveryLock(rebuild, claim);
  } catch (error) {
    claim.release();
    throw error;
  }
}

/** Claims a staged journal after proving the journal-bound rebuild process is gone. */
export function acquireSQLiteRebuildRecoveryLock(input: {
  readonly canonicalDatabasePath: string;
  readonly recoveryDirectory: string;
  readonly journalLockId: string;
}): SQLiteExclusiveLock {
  if (!/^[0-9a-f]{32}$/.test(input.journalLockId)) {
    throw new SQLiteFoundationError('recovery_required', 'Recovery requires the journal-bound rebuild lock identity.');
  }
  const paths = sqliteCoordinationPaths(input.canonicalDatabasePath);
  const claim = acquireRecoveryClaim(input.canonicalDatabasePath);
  try {
    if (!existsSync(paths.rebuildJournal)) {
      throw new SQLiteFoundationError('recovery_required', 'The journal-bound recovery artifact disappeared before lock claim.');
    }
    if (existsSync(paths.migrationLock)) {
      throw new SQLiteFoundationError('database_busy', 'A migration lock blocks rebuild recovery.');
    }
    archiveCrashedRebuildLock({
      canonicalDatabasePath: input.canonicalDatabasePath,
      recoveryDirectory: input.recoveryDirectory,
      expectedJournalLockId: input.journalLockId
    });
    const rebuild = makeCoordinationLock({
      canonicalDatabasePath: input.canonicalDatabasePath,
      path: paths.rebuildLock,
      kind: 'rebuild',
      journalLockId: input.journalLockId
    });
    return compositeRecoveryLock(rebuild, claim);
  } catch (error) {
    claim.release();
    throw error;
  }
}

export function attachSQLiteOwner(database: Database, owner: SQLiteFileOwner): void {
  const originalClose = database.close.bind(database);
  let closed = false;
  Object.defineProperty(database, 'close', {
    configurable: true,
    value(throwOnError?: boolean) {
      if (closed) return;
      originalClose(throwOnError);
      owner.release();
      closed = true;
    }
  });
}

export function recoverStaleSQLiteOwner(canonicalDatabasePath: string, ownerId: string): void {
  if (!/^[0-9a-f]{32}$/.test(ownerId)) {
    throw new SQLiteFoundationError('owner_record_malformed', 'A stale-owner recovery requires one exact owner ID.');
  }
  if (canonicalSQLiteTarget(canonicalDatabasePath) !== canonicalDatabasePath) {
    throw new SQLiteFoundationError('database_path_unsafe', 'Stale-owner recovery requires the exact canonical target path.');
  }
  const paths = sqliteCoordinationPaths(canonicalDatabasePath);
  if (existsSync(paths.rebuildJournal)) {
    throw new SQLiteFoundationError('recovery_required', 'Owner cleanup cannot run while rebuild recovery evidence exists.');
  }
  const lock = acquireSQLiteExclusiveLock(canonicalDatabasePath, 'rebuild');
  try {
    if (existsSync(paths.rebuildJournal)) {
      throw new SQLiteFoundationError('recovery_required', 'Rebuild recovery began while stale-owner cleanup was acquiring exclusion.');
    }
    const owners = listSQLiteOwners(canonicalDatabasePath);
    if (owners.length !== 1 || owners[0]?.ownerId !== ownerId) {
      throw new SQLiteFoundationError('database_busy', 'Stale-owner cleanup requires exactly the requested owner record and no other owner.');
    }
    const recordPath = join(paths.owners, `${ownerId}.json`);
    const record = parseOwnerRecord(recordPath);
    if (record.canonicalDatabasePath !== canonicalDatabasePath) {
      throw new SQLiteFoundationError('owner_record_malformed', 'The stale owner does not bind the requested canonical database path.');
    }
    if (
      record.targetDevice !== undefined && record.targetInode !== undefined &&
      !sameFileIdentity(
        { device: record.targetDevice, inode: record.targetInode },
        sqliteFileIdentity(canonicalDatabasePath)
      )
    ) {
      throw new SQLiteFoundationError('database_path_unsafe', 'The stale owner no longer binds the current SQLite file identity.');
    }
    assertRecordedProcessDead(record.pid, record.processStartToken);

    const database = new Database(canonicalDatabasePath, { create: false, strict: true });
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
      const pendingSourceChanged = record.kind === 'pending-adoption'
        && fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application')) !== record.sourceFingerprint;
      let managedDatabaseId: string | null = null;
      try {
        managedDatabaseId = migrateOrValidateSQLite({
          database,
          artifacts: loadSQLiteFoundationArtifacts(),
          policy: 'validate',
          isMemory: false
        }).databaseId;
      } catch (error) {
        if (!(error instanceof SQLiteFoundationError) || error.code !== 'migration_required' || record.kind !== 'pending-adoption') {
          throw error;
        }
        // An exact uncommitted legacy adoption remains intentionally unmanaged;
        // its source identity is already bound by the owner record and migrator.
      }
      if (pendingSourceChanged && managedDatabaseId === null) {
        throw new SQLiteFoundationError('schema_drift', 'The pending-adoption source fingerprint changed before owner recovery.');
      }
      if (record.kind === 'ordinary' && managedDatabaseId !== record.databaseId) {
        throw new SQLiteFoundationError('owner_record_malformed', 'The durable database identity no longer matches the stale ordinary owner.');
      }
      safeUnlink(recordPath);
      fsyncDirectoryPath(paths.owners);
      database.exec('ROLLBACK;');
    } finally {
      if (database.inTransaction) database.exec('ROLLBACK;');
      database.close();
    }
  } finally {
    lock.release();
  }
}
