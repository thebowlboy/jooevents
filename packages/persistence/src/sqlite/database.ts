import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { SQLiteFoundationError } from './foundation-errors';
import {
  acquireSQLiteExclusiveLock,
  acquireSQLiteOwner,
  attachSQLiteOwner,
  canonicalSQLiteTarget,
  sqliteFileIdentity,
  type SQLiteFileIdentity,
  type SQLiteExclusiveLock,
  type SQLiteFileOwner,
  type SQLiteOwnerKind
} from './file-ownership';
import {
  loadSQLiteFoundationArtifacts,
  migrateOrValidateSQLite,
  skippedSQLiteMigrationState,
  type SQLiteDatabaseClass,
  type SQLiteMigrationPolicy,
  type SQLiteMigrationState
} from './migration-runner';
import { captureSQLiteSchema, fingerprintSQLiteSchema } from './schema-snapshot';

export interface OpenSQLiteResult {
  readonly sqlite: Database;
  readonly migration: SQLiteMigrationState;
}

export interface OpenSQLiteOptions {
  /** @deprecated Use migrationPolicy. `false` maps to `none`; `true` maps to `apply`. */
  readonly migrate?: boolean;
  readonly migrationPolicy?: SQLiteMigrationPolicy;
  readonly databaseClass?: SQLiteDatabaseClass;
}

function migrationPolicy(options: OpenSQLiteOptions, isMemory: boolean): SQLiteMigrationPolicy {
  if (options.migrate !== undefined && options.migrationPolicy !== undefined) {
    const legacyPolicy = options.migrate ? 'apply' : 'none';
    if (legacyPolicy !== options.migrationPolicy) {
      throw new SQLiteFoundationError(
        'invalid_migration_options',
        'migrate and migrationPolicy specify conflicting SQLite migration behavior.'
      );
    }
  }
  if (options.migrationPolicy) return options.migrationPolicy;
  if (options.migrate !== undefined) return options.migrate ? 'apply' : 'none';
  // Disposable in-memory tests retain the convenient migrate-on-open behavior.
  // File-backed targets default to validation so startup cannot silently adopt or
  // migrate a retained database.
  return isMemory ? 'apply' : 'validate';
}

function probeOwnerBinding(path: string): {
  readonly kind: SQLiteOwnerKind;
  readonly databaseId?: string;
  readonly sourceFingerprint?: string;
  readonly expectedFileIdentity?: SQLiteFileIdentity;
} {
  if (!existsSync(path)) return { kind: 'pending-create' };
  const beforeIdentity = sqliteFileIdentity(path);
  const probe = new Database(path, { readonly: true, create: false, strict: true });
  let binding: {
    readonly kind: 'ordinary';
    readonly databaseId: string;
  } | {
    readonly kind: 'pending-adoption';
    readonly sourceFingerprint: string;
  };
  try {
    const metadataTableCount = probe.query<{ count: number }, []>(`
      select count(*) as count from sqlite_schema
       where type = 'table' and name = 'database_instance_metadata'
    `).get()?.count ?? 0;
    if (metadataTableCount === 1) {
      const rows = probe.query<{ database_id: string; database_class: string }, []>(`
        select database_id, database_class from database_instance_metadata
      `).all();
      const row = rows[0];
      if (
        rows.length !== 1 || !row || !/^[0-9a-f]{32}$/.test(row.database_id) ||
        !['ephemeral', 'retained_development', 'frozen_release'].includes(row.database_class)
      ) {
        throw new SQLiteFoundationError('owner_record_malformed', 'Database instance metadata cannot establish an owner identity.');
      }
      binding = { kind: 'ordinary', databaseId: row.database_id };
    } else {
      binding = {
        kind: 'pending-adoption',
        sourceFingerprint: fingerprintSQLiteSchema(captureSQLiteSchema(probe, 'application'))
      };
    }
  } finally {
    probe.close();
  }
  const afterIdentity = sqliteFileIdentity(path);
  if (beforeIdentity.device !== afterIdentity.device || beforeIdentity.inode !== afterIdentity.inode) {
    throw new SQLiteFoundationError('database_path_unsafe', 'The SQLite target identity changed during its ownership probe.');
  }
  return { ...binding, expectedFileIdentity: beforeIdentity };
}

export function openSQLite(path: string, options: OpenSQLiteOptions = {}): OpenSQLiteResult {
  const isMemory = path === ':memory:' || path === '';
  const policy = migrationPolicy(options, isMemory);
  // Verify every executable byte before opening a target that may be mutated.
  const artifacts = policy === 'none' ? undefined : loadSQLiteFoundationArtifacts();
  let migrationLock: SQLiteExclusiveLock | undefined;
  let owner: SQLiteFileOwner | undefined;
  let expectedFileIdentity: SQLiteFileIdentity | undefined;
  let expectedDatabaseId: string | undefined;
  const target = isMemory ? path : canonicalSQLiteTarget(path);
  if (!isMemory && policy === 'apply') migrationLock = acquireSQLiteExclusiveLock(target, 'migration');
  const exists = isMemory || existsSync(target);
  if (!exists && policy !== 'apply') {
    migrationLock?.release();
    throw new SQLiteFoundationError('database_missing', 'SQLite validation cannot create a missing database.');
  }
  if (!exists && options.databaseClass === undefined) {
    migrationLock?.release();
    throw new SQLiteFoundationError(
      'database_class_required',
      'Creating a file-backed SQLite database requires an explicit database class.'
    );
  }
  if (!isMemory) {
    try {
      const binding = probeOwnerBinding(target);
      if (binding.kind === 'pending-adoption' && policy !== 'apply') {
        throw new SQLiteFoundationError(
          'migration_required',
          'An untracked SQLite database requires explicit migration/adoption before application startup.',
          { actualFingerprint: binding.sourceFingerprint }
        );
      }
      expectedFileIdentity = binding.expectedFileIdentity;
      if (binding.kind === 'ordinary') expectedDatabaseId = binding.databaseId;
      owner = acquireSQLiteOwner({ canonicalDatabasePath: target, ...binding });
    } catch (error) {
      migrationLock?.release();
      throw error;
    }
  }

  let sqlite: Database;
  try {
    sqlite = new Database(target, { create: isMemory || (!exists && policy === 'apply'), strict: true });
  } catch (error) {
    owner?.release();
    migrationLock?.release();
    throw error;
  }
  try {
    if (!isMemory && exists && expectedFileIdentity) {
      const openedIdentity = sqliteFileIdentity(target);
      // acquireSQLiteOwner already compared the probed identity. This second path
      // observation closes the owner-to-handle open window before any SQL executes.
      if (
        openedIdentity.device !== expectedFileIdentity.device ||
        openedIdentity.inode !== expectedFileIdentity.inode
      ) {
        throw new SQLiteFoundationError('database_path_unsafe', 'The SQLite target identity changed before its handle opened.');
      }
    }
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const foreignKeys = sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys;
    if (foreignKeys !== 1) {
      throw new SQLiteFoundationError('foreign_keys_unavailable', 'SQLite foreign-key enforcement could not be enabled.');
    }
    const migration = policy === 'none'
      ? skippedSQLiteMigrationState(isMemory ? 'ephemeral' : options.databaseClass ?? null)
      : migrateOrValidateSQLite({
          database: sqlite,
          artifacts: artifacts!,
          policy,
          ...(options.databaseClass ? { databaseClass: options.databaseClass } : {}),
          isMemory
        });
    if (expectedDatabaseId && migration.databaseId !== expectedDatabaseId) {
      throw new SQLiteFoundationError(
        'owner_record_malformed',
        'The opened SQLite database identity does not match its lifetime owner binding.'
      );
    }
    if (owner && migration.databaseId) owner.promote(migration.databaseId);
    migrationLock?.release();
    migrationLock = undefined;
    if (owner) attachSQLiteOwner(sqlite, owner);
    return { sqlite, migration };
  } catch (error) {
    sqlite.close();
    owner?.release();
    migrationLock?.release();
    throw error;
  }
}
