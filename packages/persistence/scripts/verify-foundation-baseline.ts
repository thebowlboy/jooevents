import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS } from '../src/sqlite/foundation-ephemeral-sqlite-runtime';
import { readVerifiedSQLiteArtifact, sha256Hex } from '../src/sqlite/migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from '../src/sqlite/migration-manifest';
import { loadSQLiteFoundationArtifacts } from '../src/sqlite/migration-runner';
import { openSQLite } from '../src/sqlite/database';
import {
  canonicalSchemaJson,
  captureSQLiteSchema,
  diffSQLiteSchemas,
  fingerprintSQLiteSchema,
  type SQLiteSchemaSnapshot
} from '../src/sqlite/schema-snapshot';

const receiptPath = new URL(
  '../migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.receipt.json',
  import.meta.url
);
const ACCEPTED_RECEIPT_CHECKSUM = '9b359072138c16d1709a1e59cf82a3e2d415daf6f1736d999750a2308d46480a';

interface FoundationReceipt {
  readonly migrationId: string;
  readonly coordinate: { readonly schemaEpoch: number; readonly sequence: number };
  readonly artifacts: Readonly<Record<'baseline' | 'bridge' | 'predecessor' | 'runnerBootstrap', {
    readonly path: string;
    readonly checksumSha256: string;
  }>>;
  readonly fingerprints: {
    readonly emptyApplication: string;
    readonly runner: string;
    readonly currentApplication: string;
    readonly currentFull: string;
  };
  readonly dictionary: { readonly path: string; readonly checksumSha256: string };
  readonly sourceArtifacts: readonly { readonly id: string; readonly checksumSha256: string }[];
}

export interface FoundationBaselineVerificationResult {
  readonly freshApplicationFingerprint: string;
  readonly freshFullFingerprint: string;
  readonly authoringApplicationFingerprint: string;
  readonly bridgedApplicationFingerprint: string;
  readonly bridgedFullFingerprint: string;
  readonly sourceArtifactCount: number;
}

function fail(path: string, expected: unknown, actual: unknown): never {
  throw new Error(`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function equal(path: string, expected: unknown, actual: unknown): void {
  if (!Object.is(expected, actual)) fail(path, expected, actual);
}

function sameSchema(path: string, expected: SQLiteSchemaSnapshot, actual: SQLiteSchemaSnapshot): void {
  if (canonicalSchemaJson(expected) === canonicalSchemaJson(actual)) return;
  const differences = diffSQLiteSchemas(expected, actual);
  throw new Error(`${path}: schema drift\n${differences.join('\n')}`);
}

function assertHealthy(path: string, database: Database): void {
  const foreignKeys = database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all();
  if (foreignKeys.length !== 0) fail(`${path}/foreign_key_check`, [], foreignKeys);
  const integrity = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    fail(`${path}/integrity_check`, [{ integrity_check: 'ok' }], integrity);
  }
}

function readReceipt(): FoundationReceipt {
  const verified = readVerifiedSQLiteArtifact(receiptPath, ACCEPTED_RECEIPT_CHECKSUM);
  return JSON.parse(verified.sql) as FoundationReceipt;
}

function verifyReceipt(receipt: FoundationReceipt): void {
  const baseline = SQLITE_MIGRATION_MANIFEST.migrations[0];
  const lineage = SQLITE_MIGRATION_MANIFEST.acceptedPredecessorLineages[0];
  equal('/receipt/migrationId', baseline.migrationId, receipt.migrationId);
  equal('/receipt/coordinate/schemaEpoch', baseline.schemaEpoch, receipt.coordinate.schemaEpoch);
  equal('/receipt/coordinate/sequence', baseline.sequence, receipt.coordinate.sequence);
  equal('/receipt/artifacts/baseline/path', 'migrations/sqlite/e2_0001_jooevents_foundation.sql', receipt.artifacts.baseline.path);
  equal('/receipt/artifacts/bridge/path', 'migrations/sqlite/e1_identity_access_to_e2_foundation.sql', receipt.artifacts.bridge.path);
  equal('/receipt/artifacts/predecessor/path', 'migrations/sqlite/0001_identity_access.sql', receipt.artifacts.predecessor.path);
  equal('/receipt/artifacts/runnerBootstrap/path', 'migrations/sqlite/schema_migrations.sql', receipt.artifacts.runnerBootstrap.path);
  equal('/receipt/artifacts/baseline/checksumSha256', baseline.checksumSha256, receipt.artifacts.baseline.checksumSha256);
  equal('/receipt/artifacts/bridge/checksumSha256', lineage.bridgeChecksumSha256, receipt.artifacts.bridge.checksumSha256);
  equal('/receipt/artifacts/predecessor/checksumSha256', SQLITE_MIGRATION_MANIFEST.predecessor.checksumSha256, receipt.artifacts.predecessor.checksumSha256);
  equal('/receipt/artifacts/runnerBootstrap/checksumSha256', SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256, receipt.artifacts.runnerBootstrap.checksumSha256);
  equal('/receipt/dictionary/checksumSha256', SQLITE_MIGRATION_MANIFEST.dictionary.checksumSha256, receipt.dictionary.checksumSha256);
  equal('/receipt/dictionary/path', 'migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.schema.json', receipt.dictionary.path);
  equal('/receipt/fingerprints/emptyApplication', SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint, receipt.fingerprints.emptyApplication);
  equal('/receipt/fingerprints/runner', SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint, receipt.fingerprints.runner);
  equal('/receipt/fingerprints/currentApplication', SQLITE_MIGRATION_MANIFEST.expectedCurrentApplicationFingerprint, receipt.fingerprints.currentApplication);
  equal('/receipt/fingerprints/currentFull', SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint, receipt.fingerprints.currentFull);

  equal('/receipt/sourceArtifacts/length', FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS.length, receipt.sourceArtifacts.length);
  FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS.forEach((artifact, index) => {
    equal(`/receipt/sourceArtifacts/${index}/id`, artifact.id, receipt.sourceArtifacts[index]?.id);
    equal(
      `/receipt/sourceArtifacts/${index}/checksumSha256`,
      sha256Hex(Buffer.from(artifact.sql, 'utf8')),
      receipt.sourceArtifacts[index]?.checksumSha256
    );
  });
}

export function verifyFoundationBaseline(): FoundationBaselineVerificationResult {
  const artifacts = loadSQLiteFoundationArtifacts();
  const receipt = readReceipt();
  verifyReceipt(receipt);

  const fresh = openSQLite(':memory:');
  const authoring = new Database(':memory:', { create: true, strict: true });
  const bridgeDirectory = mkdtempSync(join(tmpdir(), 'jooevents-foundation-bridge-'));
  const bridgePath = join(bridgeDirectory, 'predecessor.sqlite');
  let bridged: ReturnType<typeof openSQLite> | undefined;
  try {
    const freshApplication = captureSQLiteSchema(fresh.sqlite, 'application');
    const freshFull = captureSQLiteSchema(fresh.sqlite, 'full');
    equal('/fresh/state/status', 'applied', fresh.migration.status);

    authoring.exec('PRAGMA foreign_keys = ON;');
    authoring.exec(artifacts.predecessor.sql);
    for (const artifact of FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS) authoring.exec(artifact.sql);
    const authoringApplication = captureSQLiteSchema(authoring, 'application');
    sameSchema('/authoring/application', freshApplication, authoringApplication);

    const dictionary = JSON.parse(artifacts.dictionary.sql) as SQLiteSchemaSnapshot;
    sameSchema('/dictionary/application', dictionary, freshApplication);

    const predecessor = new Database(bridgePath, { create: true, strict: true });
    try {
      predecessor.exec('PRAGMA foreign_keys = ON;');
      predecessor.exec(artifacts.predecessor.sql);
      assertHealthy('/predecessor', predecessor);
    } finally {
      predecessor.close();
    }
    bridged = openSQLite(bridgePath, {
      migrationPolicy: 'apply',
      databaseClass: 'retained_development'
    });
    equal('/bridge/state/status', 'bridged', bridged.migration.status);
    const bridgedApplication = captureSQLiteSchema(bridged.sqlite, 'application');
    const bridgedFull = captureSQLiteSchema(bridged.sqlite, 'full');
    sameSchema('/bridge/application', freshApplication, bridgedApplication);
    sameSchema('/bridge/full', freshFull, bridgedFull);

    assertHealthy('/fresh', fresh.sqlite);
    assertHealthy('/authoring', authoring);
    assertHealthy('/bridge', bridged.sqlite);

    const result = {
      freshApplicationFingerprint: fingerprintSQLiteSchema(freshApplication),
      freshFullFingerprint: fingerprintSQLiteSchema(freshFull),
      authoringApplicationFingerprint: fingerprintSQLiteSchema(authoringApplication),
      bridgedApplicationFingerprint: fingerprintSQLiteSchema(bridgedApplication),
      bridgedFullFingerprint: fingerprintSQLiteSchema(bridgedFull),
      sourceArtifactCount: FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS.length
    };
    equal('/result/freshApplicationFingerprint', receipt.fingerprints.currentApplication, result.freshApplicationFingerprint);
    equal('/result/freshFullFingerprint', receipt.fingerprints.currentFull, result.freshFullFingerprint);
    return Object.freeze(result);
  } finally {
    bridged?.sqlite.close();
    authoring.close();
    fresh.sqlite.close();
    rmSync(bridgeDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(verifyFoundationBaseline(), null, 2));
}
