import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { canonicalJsonSha256, canonicalJsonText } from '@jooevents/kernel';
import { SQLiteFoundationError } from './foundation-errors';
import { readVerifiedSQLiteArtifact, type VerifiedSQLiteArtifact } from './migration-artifact';
import {
  SQLITE_MIGRATION_MANIFEST,
  type SQLiteMigrationManifestEntry
} from './migration-manifest';
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
  | 'after_bridge_schema_before_transition'
  | 'after_bridge_transition_before_receipt'
  | 'after_commit_before_return';

export interface SQLiteFoundationArtifacts {
  readonly bootstrap: VerifiedSQLiteArtifact;
  readonly predecessor: VerifiedSQLiteArtifact;
  readonly migrations: readonly VerifiedSQLiteArtifact[];
  readonly bridge: VerifiedSQLiteArtifact;
  readonly dictionary: VerifiedSQLiteArtifact;
}

export interface SQLiteMigrationState {
  readonly status: 'applied' | 'bridged' | 'current' | 'skipped';
  readonly coordinate: { readonly schemaEpoch: number; readonly sequence: number } | null;
  readonly migrationId: string | null;
  readonly databaseClass: SQLiteDatabaseClass | null;
  readonly databaseId: string | null;
  readonly schemaFingerprint: string | null;
}

interface ExpectedSnapshots {
  readonly emptyApplication: SQLiteSchemaSnapshot;
  readonly predecessorApplication: SQLiteSchemaSnapshot;
  readonly currentApplication: SQLiteSchemaSnapshot;
  readonly applicationByMigrationId: ReadonlyMap<string, SQLiteSchemaSnapshot>;
  readonly runner: SQLiteSchemaSnapshot;
  readonly currentFull: SQLiteSchemaSnapshot;
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

interface TransitionRow {
  readonly id: string;
  readonly lineage_id: string;
  readonly dialect: string;
  readonly source_epoch: number;
  readonly source_sequence: number;
  readonly source_receipt_set_digest: string;
  readonly source_fingerprint: string;
  readonly destination_epoch: number;
  readonly destination_migration_id: string;
  readonly destination_baseline_checksum: string;
  readonly destination_fingerprint: string;
  readonly bridge_artifact_id: string;
  readonly bridge_artifact_checksum: string;
  readonly atomicity: string;
  readonly verifier_set_digest: string;
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

const baseline = SQLITE_MIGRATION_MANIFEST.migrations[0];
const currentMigration = SQLITE_MIGRATION_MANIFEST.migrations.at(-1)!;
const lineage = SQLITE_MIGRATION_MANIFEST.acceptedPredecessorLineages[0];
let expectedSnapshotCache: ExpectedSnapshots | undefined;

export function loadSQLiteFoundationArtifacts(): SQLiteFoundationArtifacts {
  return {
    bootstrap: readVerifiedSQLiteArtifact(
      SQLITE_MIGRATION_MANIFEST.bootstrap.artifact,
      SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256
    ),
    predecessor: readVerifiedSQLiteArtifact(
      SQLITE_MIGRATION_MANIFEST.predecessor.artifact,
      SQLITE_MIGRATION_MANIFEST.predecessor.checksumSha256
    ),
    migrations: SQLITE_MIGRATION_MANIFEST.migrations.map((migration) =>
      readVerifiedSQLiteArtifact(migration.artifact, migration.checksumSha256)
    ),
    bridge: readVerifiedSQLiteArtifact(lineage.bridgeArtifact, lineage.bridgeChecksumSha256),
    dictionary: readVerifiedSQLiteArtifact(
      SQLITE_MIGRATION_MANIFEST.dictionary.artifact,
      SQLITE_MIGRATION_MANIFEST.dictionary.checksumSha256
    )
  };
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

function assertFingerprint(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SQLiteFoundationError('artifact_checksum_mismatch', `${label} does not match its checked-in checkpoint.`, {
      expectedFingerprint: expected,
      actualFingerprint: actual
    });
  }
}

interface SubmissionTriageSpamRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly submission_id: string;
  readonly head_json: string;
}

/** Prepare deterministic transformed values that SQLite cannot hash itself. */
function prepareMigration(database: Database, migration: SQLiteMigrationManifestEntry): void {
  if (migration.migrationId === 'e2_0004_api_key_prefix') {
    const existing = database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM api_keys'
    ).get()?.count ?? 0;
    if (existing !== 0) {
      throw new Error(
        'e2_0004_api_key_prefix requires an empty api_keys table because issued hash-only credentials cannot be converted'
      );
    }
    return;
  }
  if (migration.migrationId !== 'e2_0002_submission_triage_spam') return;
  database.exec(`
    CREATE TEMP TABLE e2_0002_submission_triage_spam_rows (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      head_json TEXT NOT NULL,
      head_digest_sha256 TEXT NOT NULL,
      PRIMARY KEY (workspace_id,event_id,submission_id)
    ) STRICT, WITHOUT ROWID;
  `);
  const rows = database.query<SubmissionTriageSpamRow, []>(`
    SELECT workspace_id,event_id,submission_id,head_json
      FROM submission_triage_heads
     WHERE state = 'discarded_recoverable'
     ORDER BY workspace_id,event_id,submission_id
  `).all();
  const insert = database.query<never, [string, string, string, string, string]>(`
    INSERT INTO temp.e2_0002_submission_triage_spam_rows
      (workspace_id,event_id,submission_id,head_json,head_digest_sha256)
    VALUES (?,?,?,?,?)
  `);
  for (const row of rows) {
    const parsed = JSON.parse(row.head_json) as Record<string, unknown>;
    const transformed = Object.freeze({ ...parsed, state: 'spam' });
    insert.run(
      row.workspace_id,
      row.event_id,
      row.submission_id,
      canonicalJsonText(transformed),
      canonicalJsonSha256(transformed)
    );
  }
}

function expectedSnapshots(artifacts: SQLiteFoundationArtifacts): ExpectedSnapshots {
  if (expectedSnapshotCache) return expectedSnapshotCache;
  const database = new Database(':memory:', { create: true, strict: true });
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    const emptyApplication = captureSQLiteSchema(database, 'application');
    assertFingerprint(
      'Empty application schema',
      fingerprintSQLiteSchema(emptyApplication),
      SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint
    );
    database.exec(artifacts.predecessor.sql);
    const predecessorApplication = captureSQLiteSchema(database, 'application');
    assertFingerprint(
      'Epoch-1 predecessor schema',
      fingerprintSQLiteSchema(predecessorApplication),
      SQLITE_MIGRATION_MANIFEST.predecessor.expectedApplicationFingerprint
    );

    const current = new Database(':memory:', { create: true, strict: true });
    try {
      current.exec('PRAGMA foreign_keys = ON;');
      current.exec(artifacts.bootstrap.sql);
      const runner = captureSQLiteSchema(current, 'runner');
      assertFingerprint(
        'Migration runner schema',
        fingerprintSQLiteSchema(runner),
        SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint
      );
      const applicationByMigrationId = new Map<string, SQLiteSchemaSnapshot>();
      for (const [index, migration] of SQLITE_MIGRATION_MANIFEST.migrations.entries()) {
        const before = fingerprintSQLiteSchema(captureSQLiteSchema(current, 'application'));
        assertFingerprint(`${migration.migrationId} source schema`, before, migration.expectedBeforeApplicationFingerprint);
        prepareMigration(current, migration);
        current.exec(artifacts.migrations[index]!.sql);
        const after = captureSQLiteSchema(current, 'application');
        assertFingerprint(
          `${migration.migrationId} result schema`,
          fingerprintSQLiteSchema(after),
          migration.expectedAfterApplicationFingerprint
        );
        applicationByMigrationId.set(migration.migrationId, after);
      }
      const currentApplication = captureSQLiteSchema(current, 'application');
      const currentFull = captureSQLiteSchema(current, 'full');
      assertFingerprint(
        'Epoch-2 application schema',
        fingerprintSQLiteSchema(currentApplication),
        SQLITE_MIGRATION_MANIFEST.expectedCurrentApplicationFingerprint
      );
      assertFingerprint(
        'Epoch-2 full schema',
        fingerprintSQLiteSchema(currentFull),
        SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
      );
      if (`${artifacts.dictionary.sql.trim()}\n` !== `${JSON.stringify(JSON.parse(artifacts.dictionary.sql))}\n`) {
        throw new SQLiteFoundationError('artifact_checksum_mismatch', 'The epoch-2 schema dictionary is not canonical JSON.');
      }
      const dictionarySnapshot = JSON.parse(artifacts.dictionary.sql) as SQLiteSchemaSnapshot;
      if (fingerprintSQLiteSchema(dictionarySnapshot) !== SQLITE_MIGRATION_MANIFEST.expectedCurrentApplicationFingerprint) {
        throw new SQLiteFoundationError('artifact_checksum_mismatch', 'The epoch-2 schema dictionary fingerprint disagrees with the baseline.');
      }
      expectedSnapshotCache = {
        emptyApplication,
        predecessorApplication,
        currentApplication,
        applicationByMigrationId,
        runner,
        currentFull
      };
      return expectedSnapshotCache;
    } finally {
      current.close();
    }
  } finally {
    database.close();
  }
}

function runnerObjectCount(database: Database): number {
  return database.query<{ count: number }, []>(`
    SELECT count(*) AS count FROM sqlite_schema
     WHERE name IN ('schema_migrations','schema_epoch_transitions','database_instance_metadata')
        OR tbl_name IN ('schema_migrations','schema_epoch_transitions','database_instance_metadata')
  `).get()?.count ?? 0;
}

function asDatabaseClass(value: string): SQLiteDatabaseClass | undefined {
  return value === 'ephemeral' || value === 'retained_development' || value === 'frozen_release'
    ? value
    : undefined;
}

function ensureRunnerSchema(database: Database, expected: ExpectedSnapshots): void {
  const actual = captureSQLiteSchema(database, 'runner');
  if (fingerprintSQLiteSchema(actual) !== SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint) {
    throw new SQLiteFoundationError('runner_schema_malformed', 'Migration runner objects do not match runner version 2.', {
      differences: diffSQLiteSchemas(expected.runner, actual)
    });
  }
}

function metadata(database: Database, requestedClass?: SQLiteDatabaseClass): MetadataRow {
  const rows = database.query<MetadataRow, []>('SELECT * FROM database_instance_metadata').all();
  const row = rows[0];
  const databaseClass = row ? asDatabaseClass(row.database_class) : undefined;
  if (rows.length !== 1 || !row || row.singleton_key !== 1 || row.application_key !== 'jooevents'
      || !/^[0-9a-f]{32}$/.test(row.database_id) || databaseClass === undefined
      || !Number.isSafeInteger(row.created_at) || row.created_at < 0
      || !Number.isSafeInteger(row.classification_changed_at)
      || row.classification_changed_at < row.created_at) {
    throw new SQLiteFoundationError('receipt_chain_malformed', 'Database instance metadata is missing or malformed.');
  }
  if (requestedClass !== undefined && requestedClass !== databaseClass) {
    throw new SQLiteFoundationError('database_class_mismatch', 'The requested database class does not match durable metadata.', {
      requestedClass,
      actualClass: databaseClass
    });
  }
  return row;
}

function receipts(database: Database): readonly ReceiptRow[] {
  return database.query<ReceiptRow, []>(`
    SELECT migration_id,schema_epoch,sequence,dialect,checksum_sha256,receipt_kind,
           source_fingerprint,result_fingerprint,transition_id,runner_version,
           build_identity,applied_at,duration_ms
      FROM schema_migrations ORDER BY schema_epoch,sequence,dialect,migration_id
  `).all();
}

function transitions(database: Database): readonly TransitionRow[] {
  return database.query<TransitionRow, []>(`
    SELECT id,lineage_id,dialect,source_epoch,source_sequence,source_receipt_set_digest,
           source_fingerprint,destination_epoch,destination_migration_id,
           destination_baseline_checksum,destination_fingerprint,bridge_artifact_id,
           bridge_artifact_checksum,atomicity,verifier_set_digest,runner_version,
           build_identity,applied_at,duration_ms
      FROM schema_epoch_transitions ORDER BY destination_epoch,id
  `).all();
}

function validCommonReceipt(row: ReceiptRow): boolean {
  return row.dialect === 'sqlite'
    && row.runner_version === SQLITE_MIGRATION_MANIFEST.runnerVersion
    && row.build_identity.length >= 1 && row.build_identity.length <= 120
    && Number.isSafeInteger(row.applied_at) && row.applied_at >= 0
    && Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0;
}

function sourceReceiptDigest(row: ReceiptRow): string {
  return canonicalJsonSha256([{
    checksum_sha256: row.checksum_sha256,
    dialect: row.dialect,
    migration_id: row.migration_id,
    receipt_kind: row.receipt_kind,
    schema_epoch: row.schema_epoch,
    sequence: row.sequence
  }]);
}

function isPredecessorReceipt(row: ReceiptRow | undefined): row is ReceiptRow {
  return Boolean(row && validCommonReceipt(row)
    && row.migration_id === lineage.sourceTerminal.migrationId
    && row.schema_epoch === lineage.sourceTerminal.schemaEpoch
    && row.sequence === lineage.sourceTerminal.sequence
    && row.checksum_sha256 === SQLITE_MIGRATION_MANIFEST.predecessor.checksumSha256
    && row.receipt_kind === lineage.sourceReceiptKind
    && row.source_fingerprint === lineage.sourceApplicationFingerprint
    && row.result_fingerprint === lineage.sourceApplicationFingerprint
    && row.transition_id === null
    && sourceReceiptDigest(row) === lineage.sourceReceiptSetDigestSha256);
}

function isBaselineReceipt(row: ReceiptRow | undefined, kind: 'executed' | 'epoch_bridge'): row is ReceiptRow {
  return Boolean(row && validCommonReceipt(row)
    && row.migration_id === baseline.migrationId
    && row.schema_epoch === baseline.schemaEpoch
    && row.sequence === baseline.sequence
    && row.checksum_sha256 === baseline.checksumSha256
    && row.receipt_kind === kind
    && row.source_fingerprint === (kind === 'executed'
      ? SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint
      : lineage.sourceApplicationFingerprint)
    && row.result_fingerprint === baseline.expectedAfterApplicationFingerprint
    && row.transition_id === (kind === 'executed' ? null : lineage.transitionId));
}

function isExecutedReceipt(
  row: ReceiptRow | undefined,
  migration: SQLiteMigrationManifestEntry
): row is ReceiptRow {
  return Boolean(row && validCommonReceipt(row)
    && row.migration_id === migration.migrationId
    && row.schema_epoch === migration.schemaEpoch
    && row.sequence === migration.sequence
    && row.checksum_sha256 === migration.checksumSha256
    && row.receipt_kind === 'executed'
    && row.source_fingerprint === migration.expectedBeforeApplicationFingerprint
    && row.result_fingerprint === migration.expectedAfterApplicationFingerprint
    && row.transition_id === null);
}

function isTransition(row: TransitionRow | undefined): row is TransitionRow {
  return Boolean(row
    && row.id === lineage.transitionId
    && row.lineage_id === lineage.lineageId
    && row.dialect === 'sqlite'
    && row.source_epoch === lineage.sourceTerminal.schemaEpoch
    && row.source_sequence === lineage.sourceTerminal.sequence
    && row.source_receipt_set_digest === lineage.sourceReceiptSetDigestSha256
    && row.source_fingerprint === lineage.sourceApplicationFingerprint
    && row.destination_epoch === baseline.schemaEpoch
    && row.destination_migration_id === baseline.migrationId
    && row.destination_baseline_checksum === baseline.checksumSha256
    && row.destination_fingerprint === baseline.expectedAfterApplicationFingerprint
    && row.bridge_artifact_id === lineage.bridgeArtifactId
    && row.bridge_artifact_checksum === lineage.bridgeChecksumSha256
    && row.atomicity === 'transactional'
    && row.verifier_set_digest === lineage.verifierSetDigestSha256
    && row.runner_version === SQLITE_MIGRATION_MANIFEST.runnerVersion
    && row.build_identity.length >= 1 && row.build_identity.length <= 120
    && Number.isSafeInteger(row.applied_at) && row.applied_at >= 0
    && Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0);
}

function assertCurrentSchema(database: Database, expected: ExpectedSnapshots): string {
  const application = captureSQLiteSchema(database, 'application');
  if (fingerprintSQLiteSchema(application) !== SQLITE_MIGRATION_MANIFEST.expectedCurrentApplicationFingerprint) {
    throw schemaDrift(expected.currentApplication, application, 'The live application schema is not the accepted epoch-2 baseline.');
  }
  const full = captureSQLiteSchema(database, 'full');
  const fullFingerprint = fingerprintSQLiteSchema(full);
  if (fullFingerprint !== SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint) {
    throw schemaDrift(expected.currentFull, full, 'Migration receipts and the live full schema disagree.');
  }
  if (database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all().length !== 0) {
    throw new SQLiteFoundationError('schema_drift', 'The epoch-2 database violates foreign-key integrity.');
  }
  return fullFingerprint;
}

function validateManagedDatabase(
  database: Database,
  expected: ExpectedSnapshots,
  requestedClass?: SQLiteDatabaseClass
): SQLiteMigrationState {
  ensureRunnerSchema(database, expected);
  const meta = metadata(database, requestedClass);
  const receiptRows = receipts(database);
  const transitionRows = transitions(database);
  const bridged = isPredecessorReceipt(receiptRows[0])
    && isBaselineReceipt(receiptRows[1], 'epoch_bridge')
    && transitionRows.length === 1 && isTransition(transitionRows[0]);
  const fresh = isBaselineReceipt(receiptRows[0], 'executed') && transitionRows.length === 0;
  const offset = bridged ? 1 : 0;
  const migrationReceipts = receiptRows.slice(offset);
  const acceptedPrefix = (fresh || bridged)
    && migrationReceipts.length >= 1
    && migrationReceipts.length <= SQLITE_MIGRATION_MANIFEST.migrations.length
    && migrationReceipts.every((row, index) => index === 0
      ? isBaselineReceipt(row, bridged ? 'epoch_bridge' : 'executed')
      : isExecutedReceipt(row, SQLITE_MIGRATION_MANIFEST.migrations[index]!));
  if (!acceptedPrefix) {
    throw new SQLiteFoundationError('receipt_chain_malformed', 'The migration receipt chain is not an accepted epoch-2 lineage.', {
      receiptCount: receiptRows.length,
      transitionCount: transitionRows.length
    });
  }
  const applied = SQLITE_MIGRATION_MANIFEST.migrations[migrationReceipts.length - 1]!;
  const application = captureSQLiteSchema(database, 'application');
  if (fingerprintSQLiteSchema(application) !== applied.expectedAfterApplicationFingerprint) {
    throw schemaDrift(
      expected.applicationByMigrationId.get(applied.migrationId)!,
      application,
      'The live application schema disagrees with its terminal migration receipt.'
    );
  }
  const terminal = applied.migrationId === currentMigration.migrationId;
  return {
    status: 'current',
    coordinate: { schemaEpoch: applied.schemaEpoch, sequence: applied.sequence },
    migrationId: applied.migrationId,
    databaseClass: asDatabaseClass(meta.database_class)!,
    databaseId: meta.database_id,
    schemaFingerprint: terminal
      ? assertCurrentSchema(database, expected)
      : fingerprintSQLiteSchema(captureSQLiteSchema(database, 'full'))
  };
}

function immediateTransaction<Value>(database: Database, work: () => Value): Value {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const value = work();
    database.exec('COMMIT;');
    return value;
  } catch (error) {
    if (database.inTransaction) {
      try { database.exec('ROLLBACK;'); } catch { /* preserve the first failure */ }
    }
    if (error instanceof SQLiteFoundationError) throw error;
    throw new SQLiteFoundationError('migration_transaction_failed', 'The SQLite migration transaction failed and rolled back.', {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function insertMetadata(database: Database, databaseClass: SQLiteDatabaseClass, databaseId: string, now: number): void {
  database.query(`
    INSERT INTO database_instance_metadata
      (singleton_key,application_key,database_id,database_class,created_at,classification_changed_at)
    VALUES (1,'jooevents',?,?,?,?)
  `).run(databaseId, databaseClass, now, now);
}

function insertReceipt(database: Database, input: {
  readonly migrationId: string;
  readonly schemaEpoch: number;
  readonly sequence: number;
  readonly checksumSha256: string;
  readonly receiptKind: 'executed' | 'legacy_adoption' | 'epoch_bridge';
  readonly sourceFingerprint: string;
  readonly resultFingerprint: string;
  readonly transitionId: string | null;
  readonly appliedAt: number;
}): void {
  database.query(`
    INSERT INTO schema_migrations
      (migration_id,schema_epoch,sequence,dialect,checksum_sha256,receipt_kind,
       source_fingerprint,result_fingerprint,transition_id,runner_version,
       build_identity,applied_at,duration_ms)
    VALUES (?,?,?,'sqlite',?,?,?,?,?,?,'jooevents',?,0)
  `).run(
    input.migrationId,
    input.schemaEpoch,
    input.sequence,
    input.checksumSha256,
    input.receiptKind,
    input.sourceFingerprint,
    input.resultFingerprint,
    input.transitionId,
    SQLITE_MIGRATION_MANIFEST.runnerVersion,
    input.appliedAt
  );
}

function insertTransition(database: Database, appliedAt: number): void {
  database.query(`
    INSERT INTO schema_epoch_transitions
      (id,lineage_id,dialect,source_epoch,source_sequence,source_receipt_set_digest,
       source_fingerprint,destination_epoch,destination_migration_id,
       destination_baseline_checksum,destination_fingerprint,bridge_artifact_id,
       bridge_artifact_checksum,atomicity,verifier_set_digest,runner_version,
       build_identity,applied_at,duration_ms)
    VALUES (?,?,'sqlite',?,?,?,?,?,?,?,?,?,?,'transactional',?,?,'jooevents',?,0)
  `).run(
    lineage.transitionId,
    lineage.lineageId,
    lineage.sourceTerminal.schemaEpoch,
    lineage.sourceTerminal.sequence,
    lineage.sourceReceiptSetDigestSha256,
    lineage.sourceApplicationFingerprint,
    baseline.schemaEpoch,
    baseline.migrationId,
    baseline.checksumSha256,
    baseline.expectedAfterApplicationFingerprint,
    lineage.bridgeArtifactId,
    lineage.bridgeChecksumSha256,
    lineage.verifierSetDigestSha256,
    SQLITE_MIGRATION_MANIFEST.runnerVersion,
    appliedAt
  );
}

function applyPendingMigrations(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly expected: ExpectedSnapshots;
  readonly appliedCount: number;
  readonly databaseClass: SQLiteDatabaseClass;
  readonly databaseId: string;
  readonly fault?: (point: SQLiteMigrationFaultPoint) => void;
}): SQLiteMigrationState {
  for (let index = input.appliedCount; index < SQLITE_MIGRATION_MANIFEST.migrations.length; index += 1) {
    const migration = SQLITE_MIGRATION_MANIFEST.migrations[index]!;
    const artifact = input.artifacts.migrations[index]!;
    const appliedAt = Date.now();
    immediateTransaction(input.database, () => {
      const before = captureSQLiteSchema(input.database, 'application');
      if (fingerprintSQLiteSchema(before) !== migration.expectedBeforeApplicationFingerprint) {
        throw schemaDrift(
          input.expected.applicationByMigrationId.get(SQLITE_MIGRATION_MANIFEST.migrations[index - 1]!.migrationId)!,
          before,
          `${migration.migrationId} source schema changed before the migration lock.`
        );
      }
      prepareMigration(input.database, migration);
      input.database.exec(artifact.sql);
      const after = captureSQLiteSchema(input.database, 'application');
      if (fingerprintSQLiteSchema(after) !== migration.expectedAfterApplicationFingerprint) {
        throw schemaDrift(
          input.expected.applicationByMigrationId.get(migration.migrationId)!,
          after,
          `${migration.migrationId} did not reach its checked-in schema.`
        );
      }
      if (input.database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all().length !== 0) {
        throw new SQLiteFoundationError('schema_drift', `${migration.migrationId} produced a foreign-key violation.`);
      }
      input.fault?.('after_schema_before_receipt');
      insertReceipt(input.database, {
        migrationId: migration.migrationId,
        schemaEpoch: migration.schemaEpoch,
        sequence: migration.sequence,
        checksumSha256: migration.checksumSha256,
        receiptKind: 'executed',
        sourceFingerprint: migration.expectedBeforeApplicationFingerprint,
        resultFingerprint: migration.expectedAfterApplicationFingerprint,
        transitionId: null,
        appliedAt
      });
      input.fault?.('after_receipt_before_commit');
    });
  }
  return {
    status: 'applied',
    coordinate: { schemaEpoch: currentMigration.schemaEpoch, sequence: currentMigration.sequence },
    migrationId: currentMigration.migrationId,
    databaseClass: input.databaseClass,
    databaseId: input.databaseId,
    schemaFingerprint: assertCurrentSchema(input.database, input.expected)
  };
}

function applyFreshDatabase(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly expected: ExpectedSnapshots;
  readonly databaseClass: SQLiteDatabaseClass;
  readonly fault?: (point: SQLiteMigrationFaultPoint) => void;
}): SQLiteMigrationState {
  const appliedAt = Date.now();
  const databaseId = randomBytes(16).toString('hex');
  immediateTransaction(input.database, () => {
    const before = captureSQLiteSchema(input.database, 'application');
    if (fingerprintSQLiteSchema(before) !== SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint
        || runnerObjectCount(input.database) !== 0) {
      throw schemaDrift(input.expected.emptyApplication, before, 'The database stopped being empty before the migration lock.');
    }
    input.database.exec(input.artifacts.bootstrap.sql);
    input.database.exec(input.artifacts.migrations[0]!.sql);
    ensureRunnerSchema(input.database, input.expected);
    insertMetadata(input.database, input.databaseClass, databaseId, appliedAt);
    const application = captureSQLiteSchema(input.database, 'application');
    if (fingerprintSQLiteSchema(application) !== baseline.expectedAfterApplicationFingerprint) {
      throw schemaDrift(
        input.expected.applicationByMigrationId.get(baseline.migrationId)!,
        application,
        'The baseline migration did not reach its checked-in schema.'
      );
    }
    input.fault?.('after_schema_before_receipt');
    insertReceipt(input.database, {
      migrationId: baseline.migrationId,
      schemaEpoch: baseline.schemaEpoch,
      sequence: baseline.sequence,
      checksumSha256: baseline.checksumSha256,
      receiptKind: 'executed',
      sourceFingerprint: SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint,
      resultFingerprint: baseline.expectedAfterApplicationFingerprint,
      transitionId: null,
      appliedAt
    });
    input.fault?.('after_receipt_before_commit');
  });
  const result = applyPendingMigrations({
    database: input.database,
    artifacts: input.artifacts,
    expected: input.expected,
    appliedCount: 1,
    databaseClass: input.databaseClass,
    databaseId,
    ...(input.fault ? { fault: input.fault } : {})
  });
  input.fault?.('after_commit_before_return');
  return result;
}

function bridgeUntrackedPredecessor(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly expected: ExpectedSnapshots;
  readonly fault?: (point: SQLiteMigrationFaultPoint) => void;
}): SQLiteMigrationState {
  const appliedAt = Date.now();
  const databaseId = randomBytes(16).toString('hex');
  immediateTransaction(input.database, () => {
    const before = captureSQLiteSchema(input.database, 'application');
    if (runnerObjectCount(input.database) !== 0
        || fingerprintSQLiteSchema(before) !== lineage.sourceApplicationFingerprint) {
      throw schemaDrift(input.expected.predecessorApplication, before, 'The retained predecessor changed before the bridge lock.');
    }
    input.database.exec(input.artifacts.bootstrap.sql);
    ensureRunnerSchema(input.database, input.expected);
    insertMetadata(input.database, 'retained_development', databaseId, appliedAt);
    insertReceipt(input.database, {
      migrationId: lineage.sourceTerminal.migrationId,
      schemaEpoch: lineage.sourceTerminal.schemaEpoch,
      sequence: lineage.sourceTerminal.sequence,
      checksumSha256: SQLITE_MIGRATION_MANIFEST.predecessor.checksumSha256,
      receiptKind: 'legacy_adoption',
      sourceFingerprint: lineage.sourceApplicationFingerprint,
      resultFingerprint: lineage.sourceApplicationFingerprint,
      transitionId: null,
      appliedAt
    });
    input.database.exec(input.artifacts.bridge.sql);
    const after = captureSQLiteSchema(input.database, 'application');
    if (fingerprintSQLiteSchema(after) !== baseline.expectedAfterApplicationFingerprint) {
      throw schemaDrift(
        input.expected.applicationByMigrationId.get(baseline.migrationId)!,
        after,
        'The retained bridge did not reach the epoch-2 baseline.'
      );
    }
    if (input.database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all().length !== 0) {
      throw new SQLiteFoundationError('schema_drift', 'The retained bridge produced a foreign-key violation.');
    }
    input.fault?.('after_schema_before_receipt');
    input.fault?.('after_bridge_schema_before_transition');
    insertTransition(input.database, appliedAt);
    input.fault?.('after_bridge_transition_before_receipt');
    insertReceipt(input.database, {
      migrationId: baseline.migrationId,
      schemaEpoch: baseline.schemaEpoch,
      sequence: baseline.sequence,
      checksumSha256: baseline.checksumSha256,
      receiptKind: 'epoch_bridge',
      sourceFingerprint: lineage.sourceApplicationFingerprint,
      resultFingerprint: baseline.expectedAfterApplicationFingerprint,
      transitionId: lineage.transitionId,
      appliedAt
    });
    input.fault?.('after_receipt_before_commit');
  });
  const result = applyPendingMigrations({
    database: input.database,
    artifacts: input.artifacts,
    expected: input.expected,
    appliedCount: 1,
    databaseClass: 'retained_development',
    databaseId,
    ...(input.fault ? { fault: input.fault } : {})
  });
  input.fault?.('after_commit_before_return');
  return result;
}

export function migrateOrValidateSQLite(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly policy: Exclude<SQLiteMigrationPolicy, 'none'>;
  readonly databaseClass?: SQLiteDatabaseClass;
  readonly isMemory: boolean;
  readonly allowFileBackedEphemeral?: boolean;
  readonly fault?: (point: SQLiteMigrationFaultPoint) => void;
}): SQLiteMigrationState {
  const expected = expectedSnapshots(input.artifacts);
  const runnerObjects = runnerObjectCount(input.database);
  if (runnerObjects > 0) {
    const state = validateManagedDatabase(input.database, expected, input.databaseClass);
    const appliedCount = SQLITE_MIGRATION_MANIFEST.migrations.findIndex(
      (migration) => migration.migrationId === state.migrationId
    ) + 1;
    if (state.migrationId !== currentMigration.migrationId) {
      if (input.policy === 'validate') {
        throw new SQLiteFoundationError(
          'migration_required',
          `The managed SQLite database requires ${currentMigration.migrationId}.`,
          { currentMigrationId: state.migrationId, requiredMigrationId: currentMigration.migrationId }
        );
      }
      return applyPendingMigrations({
        database: input.database,
        artifacts: input.artifacts,
        expected,
        appliedCount,
        databaseClass: state.databaseClass!,
        databaseId: state.databaseId!,
        ...(input.fault ? { fault: input.fault } : {})
      });
    }
    if (input.policy === 'apply') {
      input.database.exec(!input.isMemory && state.databaseClass === 'ephemeral' && input.allowFileBackedEphemeral
        ? 'PRAGMA journal_mode = DELETE;'
        : 'PRAGMA journal_mode = WAL;');
    }
    return state;
  }

  const application = captureSQLiteSchema(input.database, 'application');
  const fingerprint = fingerprintSQLiteSchema(application);
  const empty = fingerprint === SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint;
  const predecessor = fingerprint === lineage.sourceApplicationFingerprint;
  if (input.policy === 'validate') {
    throw new SQLiteFoundationError('migration_required', empty
      ? 'The SQLite database is empty and requires the epoch-2 baseline.'
      : predecessor
        ? 'The exact epoch-1 retained predecessor requires its verified epoch-2 bridge.'
        : 'The SQLite database is not at a supported managed coordinate.', { actualFingerprint: fingerprint });
  }
  if (empty) {
    const databaseClass = input.isMemory ? 'ephemeral' : input.databaseClass;
    if (input.isMemory && input.databaseClass !== undefined && input.databaseClass !== 'ephemeral') {
      throw new SQLiteFoundationError('database_class_mismatch', 'In-memory SQLite databases must be ephemeral.');
    }
    if (!databaseClass) {
      throw new SQLiteFoundationError('database_class_required', 'Creating a file-backed SQLite database requires an explicit class.');
    }
    if (!input.isMemory && databaseClass === 'ephemeral' && input.allowFileBackedEphemeral !== true) {
      throw new SQLiteFoundationError('database_class_mismatch', 'File-backed SQLite databases cannot be classified as ephemeral.');
    }
    input.database.exec(!input.isMemory && databaseClass === 'ephemeral'
      ? 'PRAGMA journal_mode = DELETE;'
      : 'PRAGMA journal_mode = WAL;');
    return applyFreshDatabase({
      database: input.database,
      artifacts: input.artifacts,
      expected,
      databaseClass,
      ...(input.fault ? { fault: input.fault } : {})
    });
  }
  if (predecessor) {
    if (input.isMemory || (input.databaseClass !== undefined && input.databaseClass !== 'retained_development')) {
      throw new SQLiteFoundationError('database_class_mismatch', 'The epoch-1 predecessor can only bridge as retained_development.');
    }
    input.database.exec('PRAGMA journal_mode = WAL;');
    return bridgeUntrackedPredecessor({
      database: input.database,
      artifacts: input.artifacts,
      expected,
      ...(input.fault ? { fault: input.fault } : {})
    });
  }
  throw schemaDrift(expected.currentApplication, application, 'The untracked SQLite schema is not empty or the exact epoch-1 predecessor.');
}

/** Validate an accepted managed coordinate without requiring it to be terminal. */
export function validateManagedSQLiteCoordinate(input: {
  readonly database: Database;
  readonly artifacts: SQLiteFoundationArtifacts;
  readonly databaseClass?: SQLiteDatabaseClass;
}): SQLiteMigrationState {
  const expected = expectedSnapshots(input.artifacts);
  if (runnerObjectCount(input.database) === 0) {
    throw new SQLiteFoundationError('migration_required', 'The SQLite database is not yet managed.');
  }
  return validateManagedDatabase(input.database, expected, input.databaseClass);
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
