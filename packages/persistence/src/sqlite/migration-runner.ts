import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { SQLiteFoundationError } from './foundation-errors';
import { readVerifiedSQLiteArtifact, type VerifiedSQLiteArtifact } from './migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import {
  captureSQLiteSchema,
  diffSQLiteSchemas,
  fingerprintSQLiteSchema,
  type SQLiteSchemaSnapshot
} from './schema-snapshot';

export type SQLiteMigrationPolicy = 'apply' | 'validate' | 'none';
export type SQLiteDatabaseClass = 'ephemeral' | 'retained_development' | 'frozen_release';
export type SQLiteMigrationFaultPoint =
  | 'after_schema_before_receipt'
  | 'after_receipt_before_commit'
  | 'after_commit_before_return';

export interface SQLiteFoundationArtifacts {
  readonly bootstrap: VerifiedSQLiteArtifact;
  readonly predecessor: VerifiedSQLiteArtifact;
}

export interface SQLiteMigrationState {
  readonly status: 'applied' | 'adopted' | 'current' | 'skipped';
  readonly coordinate: { readonly schemaEpoch: 1; readonly sequence: 1 } | null;
  readonly migrationId: 'e1_0001_identity_access' | null;
  readonly databaseClass: SQLiteDatabaseClass | null;
  readonly databaseId: string | null;
  readonly schemaFingerprint: string | null;
}

interface ExpectedSnapshots {
  readonly emptyApplication: SQLiteSchemaSnapshot;
  readonly application: SQLiteSchemaSnapshot;
  readonly runner: SQLiteSchemaSnapshot;
  readonly full: SQLiteSchemaSnapshot;
}

interface ReceiptRow {
  readonly migration_id: string;
  readonly schema_epoch: number;
  readonly sequence: number;
  readonly dialect: string;
  readonly checksum_sha256: string;
  readonly receipt_kind: string;
  readonly source_fingerprint: string;
  readonly result_fingerprint: string;
  readonly transition_id: string | null;
  readonly runner_version: number;
  readonly build_identity: string;
  readonly applied_at: number;
  readonly duration_ms: number;
}

interface MetadataRow {
  readonly singleton_key: number;
  readonly application_key: string;
  readonly database_id: string;
  readonly database_class: string;
  readonly created_at: number;
  readonly classification_changed_at: number;
}

const manifestMigration = SQLITE_MIGRATION_MANIFEST.migrations[0];
let expectedSnapshotCache: ExpectedSnapshots | undefined;

export function loadSQLiteFoundationArtifacts(): SQLiteFoundationArtifacts {
  return {
    bootstrap: readVerifiedSQLiteArtifact(
      SQLITE_MIGRATION_MANIFEST.bootstrap.artifact,
      SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256
    ),
    predecessor: readVerifiedSQLiteArtifact(
      manifestMigration.artifact,
      manifestMigration.checksumSha256
    )
  };
}

function assertFingerprint(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SQLiteFoundationError(
      'artifact_checksum_mismatch',
      `The checked-in ${label} checkpoint does not match its executable artifacts.`,
      { expectedFingerprint: expected, actualFingerprint: actual }
    );
  }
}

function expectedSnapshots(artifacts: SQLiteFoundationArtifacts): ExpectedSnapshots {
  if (expectedSnapshotCache) return expectedSnapshotCache;

  const reference = new Database(':memory:', { create: true, strict: true });
  try {
    reference.exec('PRAGMA foreign_keys = ON;');
    const emptyApplication = captureSQLiteSchema(reference, 'application');
    reference.exec(artifacts.predecessor.sql);
    const application = captureSQLiteSchema(reference, 'application');
    reference.exec(artifacts.bootstrap.sql);
    const runner = captureSQLiteSchema(reference, 'runner');
    const full = captureSQLiteSchema(reference, 'full');

    assertFingerprint(
      'empty-application schema',
      fingerprintSQLiteSchema(emptyApplication),
      SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint
    );
    assertFingerprint(
      'epoch-1 application schema',
      fingerprintSQLiteSchema(application),
      manifestMigration.expectedApplicationFingerprint
    );
    assertFingerprint(
      'runner schema',
      fingerprintSQLiteSchema(runner),
      SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint
    );
    assertFingerprint(
      'current full schema',
      fingerprintSQLiteSchema(full),
      SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    );

    expectedSnapshotCache = { emptyApplication, application, runner, full };
    return expectedSnapshotCache;
  } finally {
    reference.close();
  }
}

function runnerObjectCount(database: Database): number {
  return database.query<{ count: number }, []>(`
    select count(*) as count
      from sqlite_schema
     where name in ('schema_migrations', 'schema_epoch_transitions', 'database_instance_metadata')
        or tbl_name in ('schema_migrations', 'schema_epoch_transitions', 'database_instance_metadata')
  `).get()?.count ?? 0;
}

function schemaDrift(
  expected: SQLiteSchemaSnapshot,
  actual: SQLiteSchemaSnapshot,
  message: string
): SQLiteFoundationError {
  return new SQLiteFoundationError('schema_drift', message, {
    expectedFingerprint: fingerprintSQLiteSchema(expected),
    actualFingerprint: fingerprintSQLiteSchema(actual),
    differences: diffSQLiteSchemas(expected, actual)
  });
}

function ensureRunnerSchema(database: Database, expected: ExpectedSnapshots): void {
  const actualRunner = captureSQLiteSchema(database, 'runner');
  if (fingerprintSQLiteSchema(actualRunner) !== SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint) {
    throw new SQLiteFoundationError(
      'runner_schema_malformed',
      'Migration runner objects are missing or do not match the declared runner version.',
      {
        expectedFingerprint: SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint,
        actualFingerprint: fingerprintSQLiteSchema(actualRunner),
        differences: diffSQLiteSchemas(expected.runner, actualRunner)
      }
    );
  }
}

function ensureCurrentFullSchema(database: Database, expected: ExpectedSnapshots): string {
  const actual = captureSQLiteSchema(database, 'full');
  const fingerprint = fingerprintSQLiteSchema(actual);
  if (fingerprint !== SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint) {
    throw schemaDrift(expected.full, actual, 'The migration receipts and live SQLite schema disagree.');
  }
  return fingerprint;
}

function asDatabaseClass(value: string): SQLiteDatabaseClass | undefined {
  if (value === 'ephemeral' || value === 'retained_development' || value === 'frozen_release') return value;
  return undefined;
}

function malformedReceipt(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new SQLiteFoundationError('receipt_chain_malformed', message, details);
}

function validateManagedDatabase(
  database: Database,
  expected: ExpectedSnapshots,
  requestedClass?: SQLiteDatabaseClass
): SQLiteMigrationState {
  ensureRunnerSchema(database, expected);
  const schemaFingerprint = ensureCurrentFullSchema(database, expected);
  const receipts = database.query<ReceiptRow, []>(`
    select migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
           source_fingerprint, result_fingerprint, transition_id, runner_version,
           build_identity, applied_at, duration_ms
      from schema_migrations
     order by schema_epoch, sequence, dialect, migration_id
  `).all();
  if (receipts.length !== 1) malformedReceipt('Epoch 1 requires exactly one migration receipt.', { receiptCount: receipts.length });
  const receipt = receipts[0];
  if (!receipt) malformedReceipt('The epoch-1 migration receipt is missing.');

  const expectedSource = receipt.receipt_kind === 'executed'
    ? SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint
    : receipt.receipt_kind === 'legacy_adoption'
      ? manifestMigration.expectedApplicationFingerprint
      : undefined;
  const receiptMatches =
    receipt.migration_id === manifestMigration.migrationId &&
    receipt.schema_epoch === manifestMigration.schemaEpoch &&
    receipt.sequence === manifestMigration.sequence &&
    receipt.dialect === 'sqlite' &&
    receipt.checksum_sha256 === manifestMigration.checksumSha256 &&
    expectedSource !== undefined &&
    receipt.source_fingerprint === expectedSource &&
    receipt.result_fingerprint === SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint &&
    receipt.transition_id === null &&
    receipt.runner_version === SQLITE_MIGRATION_MANIFEST.runnerVersion &&
    receipt.build_identity.length >= 1 &&
    receipt.build_identity.length <= 120 &&
    Number.isInteger(receipt.applied_at) && receipt.applied_at >= 0 &&
    Number.isInteger(receipt.duration_ms) && receipt.duration_ms >= 0;
  if (!receiptMatches) {
    malformedReceipt('The epoch-1 migration receipt does not match the public manifest.', {
      migrationId: receipt.migration_id,
      schemaEpoch: receipt.schema_epoch,
      sequence: receipt.sequence,
      dialect: receipt.dialect,
      receiptKind: receipt.receipt_kind
    });
  }

  const transitionCount = database.query<{ count: number }, []>('select count(*) as count from schema_epoch_transitions').get()?.count ?? 0;
  if (transitionCount !== 0) malformedReceipt('Epoch 1 cannot contain an epoch-transition receipt.', { transitionCount });

  const metadataRows = database.query<MetadataRow, []>(`
    select singleton_key, application_key, database_id, database_class, created_at,
           classification_changed_at
      from database_instance_metadata
  `).all();
  if (metadataRows.length !== 1) malformedReceipt('The database instance must have exactly one metadata row.', { metadataCount: metadataRows.length });
  const metadata = metadataRows[0];
  const databaseClass = metadata ? asDatabaseClass(metadata.database_class) : undefined;
  if (
    !metadata || metadata.singleton_key !== 1 || metadata.application_key !== 'jooevents' ||
    !/^[0-9a-f]{32}$/.test(metadata.database_id) || databaseClass === undefined ||
    !Number.isInteger(metadata.created_at) || metadata.created_at < 0 ||
    !Number.isInteger(metadata.classification_changed_at) || metadata.classification_changed_at < metadata.created_at
  ) {
    malformedReceipt('Database instance metadata is malformed.');
  }
  if (requestedClass !== undefined && requestedClass !== databaseClass) {
    throw new SQLiteFoundationError(
      'database_class_mismatch',
      'The requested database class does not match the durable database identity.',
      { requestedClass, actualClass: databaseClass }
    );
  }

  return {
    status: 'current',
    coordinate: { schemaEpoch: 1, sequence: 1 },
    migrationId: 'e1_0001_identity_access',
    databaseClass,
    databaseId: metadata.database_id,
    schemaFingerprint
  };
}

function insertMetadata(
  database: Database,
  databaseClass: SQLiteDatabaseClass,
  databaseId: string,
  now: number
): void {
  database.query(`
    insert into database_instance_metadata
      (singleton_key, application_key, database_id, database_class, created_at, classification_changed_at)
    values (1, 'jooevents', ?, ?, ?, ?)
  `).run(databaseId, databaseClass, now, now);
}

function insertEpochOneReceipt(
  database: Database,
  receiptKind: 'executed' | 'legacy_adoption',
  sourceFingerprint: string,
  durationMs: number,
  now: number
): void {
  database.query(`
    insert into schema_migrations
      (migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
       source_fingerprint, result_fingerprint, transition_id, runner_version,
       build_identity, applied_at, duration_ms)
    values (?, 1, 1, 'sqlite', ?, ?, ?, ?, null, ?, 'jooevents-dev', ?, ?)
  `).run(
    manifestMigration.migrationId,
    manifestMigration.checksumSha256,
    receiptKind,
    sourceFingerprint,
    SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint,
    SQLITE_MIGRATION_MANIFEST.runnerVersion,
    now,
    durationMs
  );
}

function immediateTransaction<T>(database: Database, work: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the first error. The caller closes this connection immediately.
      }
    }
    if (error instanceof SQLiteFoundationError) throw error;
    throw new SQLiteFoundationError(
      'migration_transaction_failed',
      'The SQLite migration transaction failed and was rolled back.',
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function applyFreshDatabase(
  database: Database,
  artifacts: SQLiteFoundationArtifacts,
  expected: ExpectedSnapshots,
  databaseClass: SQLiteDatabaseClass,
  fault?: (point: SQLiteMigrationFaultPoint) => void
): SQLiteMigrationState {
  const startedAt = Date.now();
  const databaseId = randomBytes(16).toString('hex');
  const sourceFingerprint = SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint;

  const result = immediateTransaction<SQLiteMigrationState>(database, () => {
    const before = captureSQLiteSchema(database, 'application');
    if (fingerprintSQLiteSchema(before) !== sourceFingerprint || runnerObjectCount(database) !== 0) {
      throw schemaDrift(expected.emptyApplication, before, 'The database stopped being empty before migration acquired its write lock.');
    }
    database.exec(artifacts.bootstrap.sql);
    database.exec(artifacts.predecessor.sql);
    const application = captureSQLiteSchema(database, 'application');
    if (fingerprintSQLiteSchema(application) !== manifestMigration.expectedApplicationFingerprint) {
      throw schemaDrift(expected.application, application, 'The frozen epoch-1 migration produced an unexpected application schema.');
    }
    const runner = captureSQLiteSchema(database, 'runner');
    if (fingerprintSQLiteSchema(runner) !== SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint) {
      throw new SQLiteFoundationError('runner_schema_malformed', 'The runner bootstrap produced an unexpected schema.');
    }
    insertMetadata(database, databaseClass, databaseId, startedAt);
    const full = captureSQLiteSchema(database, 'full');
    if (fingerprintSQLiteSchema(full) !== SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint) {
      throw schemaDrift(expected.full, full, 'Fresh migration did not produce the declared full schema.');
    }
    fault?.('after_schema_before_receipt');
    insertEpochOneReceipt(database, 'executed', sourceFingerprint, Math.max(0, Date.now() - startedAt), startedAt);
    fault?.('after_receipt_before_commit');
    return {
      status: 'applied',
      coordinate: { schemaEpoch: 1, sequence: 1 },
      migrationId: 'e1_0001_identity_access',
      databaseClass,
      databaseId,
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    };
  });
  fault?.('after_commit_before_return');
  return result;
}

function adoptLegacyDatabase(
  database: Database,
  artifacts: SQLiteFoundationArtifacts,
  expected: ExpectedSnapshots,
  fault?: (point: SQLiteMigrationFaultPoint) => void
): SQLiteMigrationState {
  const startedAt = Date.now();
  const databaseId = randomBytes(16).toString('hex');

  const result = immediateTransaction<SQLiteMigrationState>(database, () => {
    if (runnerObjectCount(database) !== 0) {
      throw new SQLiteFoundationError('runner_schema_malformed', 'Runner objects appeared before legacy adoption acquired its write lock.');
    }
    const application = captureSQLiteSchema(database, 'application');
    if (fingerprintSQLiteSchema(application) !== manifestMigration.expectedApplicationFingerprint) {
      throw schemaDrift(expected.application, application, 'The legacy database changed before adoption acquired its write lock.');
    }
    database.exec(artifacts.bootstrap.sql);
    insertMetadata(database, 'retained_development', databaseId, startedAt);
    const full = captureSQLiteSchema(database, 'full');
    if (fingerprintSQLiteSchema(full) !== SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint) {
      throw schemaDrift(expected.full, full, 'Legacy adoption did not produce the declared full schema.');
    }
    fault?.('after_schema_before_receipt');
    insertEpochOneReceipt(
      database,
      'legacy_adoption',
      manifestMigration.expectedApplicationFingerprint,
      Math.max(0, Date.now() - startedAt),
      startedAt
    );
    fault?.('after_receipt_before_commit');
    return {
      status: 'adopted',
      coordinate: { schemaEpoch: 1, sequence: 1 },
      migrationId: 'e1_0001_identity_access',
      databaseClass: 'retained_development',
      databaseId,
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    };
  });
  fault?.('after_commit_before_return');
  return result;
}

export function migrateOrValidateSQLite(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly policy: Exclude<SQLiteMigrationPolicy, 'none'>;
  readonly databaseClass?: SQLiteDatabaseClass;
  readonly isMemory: boolean;
  /** Test harness only: permits an explicitly marked file under the OS temp root. */
  readonly allowFileBackedEphemeral?: boolean;
  /** Test-only deterministic process-termination seam; production openers never provide it. */
  readonly fault?: (point: SQLiteMigrationFaultPoint) => void;
}): SQLiteMigrationState {
  const expected = expectedSnapshots(input.artifacts);
  const runnerObjects = runnerObjectCount(input.database);
  if (runnerObjects > 0) {
    const state = validateManagedDatabase(input.database, expected, input.databaseClass);
    if (input.policy === 'apply') {
      input.database.exec(
        !input.isMemory && state.databaseClass === 'ephemeral' && input.allowFileBackedEphemeral
          ? 'PRAGMA journal_mode = DELETE;'
          : 'PRAGMA journal_mode = WAL;'
      );
    }
    return state;
  }

  const application = captureSQLiteSchema(input.database, 'application');
  const applicationFingerprint = fingerprintSQLiteSchema(application);
  const empty = applicationFingerprint === SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint;
  const legacy = applicationFingerprint === manifestMigration.expectedApplicationFingerprint;

  if (input.policy === 'validate') {
    throw new SQLiteFoundationError(
      'migration_required',
      empty ? 'The SQLite database is empty and requires migration.'
        : legacy ? 'The exact legacy SQLite database requires adoption.'
          : 'The SQLite database is not at a supported managed coordinate.',
      { actualFingerprint: applicationFingerprint }
    );
  }

  if (empty) {
    const databaseClass = input.isMemory ? 'ephemeral' : input.databaseClass;
    if (input.isMemory && input.databaseClass !== undefined && input.databaseClass !== 'ephemeral') {
      throw new SQLiteFoundationError('database_class_mismatch', 'In-memory SQLite databases must be classified as ephemeral.');
    }
    if (!databaseClass) {
      throw new SQLiteFoundationError(
        'database_class_required',
        'Creating a file-backed SQLite database requires an explicit database class.'
      );
    }
    if (!input.isMemory && databaseClass === 'ephemeral' && input.allowFileBackedEphemeral !== true) {
      throw new SQLiteFoundationError('database_class_mismatch', 'File-backed SQLite databases cannot be classified as ephemeral.');
    }
    input.database.exec(
      !input.isMemory && databaseClass === 'ephemeral'
        ? 'PRAGMA journal_mode = DELETE;'
        : 'PRAGMA journal_mode = WAL;'
    );
    return applyFreshDatabase(input.database, input.artifacts, expected, databaseClass, input.fault);
  }

  if (legacy) {
    if (input.databaseClass !== undefined && input.databaseClass !== 'retained_development') {
      throw new SQLiteFoundationError(
        'database_class_mismatch',
        'Exact legacy databases are adopted as retained_development.'
      );
    }
    input.database.exec('PRAGMA journal_mode = WAL;');
    return adoptLegacyDatabase(input.database, input.artifacts, expected, input.fault);
  }

  throw schemaDrift(expected.application, application, 'The untracked SQLite schema does not exactly match the frozen epoch-1 predecessor.');
}

export function skippedSQLiteMigrationState(databaseClass: SQLiteDatabaseClass | null): SQLiteMigrationState {
  return {
    status: 'skipped',
    coordinate: null,
    migrationId: null,
    databaseClass,
    databaseId: null,
    schemaFingerprint: null
  };
}
