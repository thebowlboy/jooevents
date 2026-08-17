import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS } from '../src/sqlite/foundation-ephemeral-sqlite-runtime';
import { readVerifiedSQLiteArtifact, sha256Hex } from '../src/sqlite/migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from '../src/sqlite/migration-manifest';
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
  equal('/receipt/dictionary/checksumSha256', 'ef195d4a735afdb949061f33eb46e7f00402c7bb37bc57475918f1547c247ef1', receipt.dictionary.checksumSha256);
  equal('/receipt/dictionary/path', 'migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.schema.json', receipt.dictionary.path);
  equal('/receipt/fingerprints/emptyApplication', SQLITE_MIGRATION_MANIFEST.expectedEmptyApplicationFingerprint, receipt.fingerprints.emptyApplication);
  equal('/receipt/fingerprints/runner', SQLITE_MIGRATION_MANIFEST.bootstrap.expectedRunnerFingerprint, receipt.fingerprints.runner);
  equal('/receipt/fingerprints/currentApplication', baseline.expectedAfterApplicationFingerprint, receipt.fingerprints.currentApplication);
  equal('/receipt/fingerprints/currentFull', '1a08edc1f996c5ab25a2f76e3bd6721f45fb1868c8afc0157f0ce946224ca81d', receipt.fingerprints.currentFull);

  receipt.sourceArtifacts.forEach((acceptedArtifact, index) => {
    const artifact = FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS.find(
      (candidate) => candidate.id === acceptedArtifact.id
    );
    if (artifact === undefined) {
      fail(`/receipt/sourceArtifacts/${index}/id`, acceptedArtifact.id, undefined);
    }
    equal(`/receipt/sourceArtifacts/${index}/id`, artifact.id, acceptedArtifact.id);
    equal(
      `/receipt/sourceArtifacts/${index}/checksumSha256`,
      sha256Hex(Buffer.from(artifact.sql, 'utf8')),
      acceptedArtifact.checksumSha256
    );
  });
}

export function verifyFoundationBaseline(): FoundationBaselineVerificationResult {
  const receipt = readReceipt();
  verifyReceipt(receipt);
  const baseline = SQLITE_MIGRATION_MANIFEST.migrations[0];
  const lineage = SQLITE_MIGRATION_MANIFEST.acceptedPredecessorLineages[0];
  const bootstrap = readVerifiedSQLiteArtifact(
    SQLITE_MIGRATION_MANIFEST.bootstrap.artifact,
    SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256
  );
  const predecessorArtifact = readVerifiedSQLiteArtifact(
    SQLITE_MIGRATION_MANIFEST.predecessor.artifact,
    SQLITE_MIGRATION_MANIFEST.predecessor.checksumSha256
  );
  const baselineArtifact = readVerifiedSQLiteArtifact(baseline.artifact, baseline.checksumSha256);
  const bridgeArtifact = readVerifiedSQLiteArtifact(lineage.bridgeArtifact, lineage.bridgeChecksumSha256);
  const dictionaryArtifact = readVerifiedSQLiteArtifact(
    new URL('../migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.schema.json', import.meta.url),
    receipt.dictionary.checksumSha256
  );
  const acceptedAuthoringArtifacts = receipt.sourceArtifacts.map((acceptedArtifact, index) => {
    const artifact = FOUNDATION_SCHEMA_AUTHORING_ARTIFACTS.find(
      (candidate) => candidate.id === acceptedArtifact.id
    );
    if (artifact === undefined) {
      fail(`/receipt/sourceArtifacts/${index}/id`, acceptedArtifact.id, undefined);
    }
    return artifact;
  });

  const fresh = new Database(':memory:', { create: true, strict: true });
  const authoring = new Database(':memory:', { create: true, strict: true });
  const bridgeDirectory = mkdtempSync(join(tmpdir(), 'jooevents-foundation-bridge-'));
  const bridgePath = join(bridgeDirectory, 'predecessor.sqlite');
  let bridged: Database | undefined;
  try {
    fresh.exec('PRAGMA foreign_keys = ON;');
    fresh.exec(bootstrap.sql);
    fresh.exec(baselineArtifact.sql);
    const freshApplication = captureSQLiteSchema(fresh, 'application');
    const freshFull = captureSQLiteSchema(fresh, 'full');

    authoring.exec('PRAGMA foreign_keys = ON;');
    authoring.exec(predecessorArtifact.sql);
    for (const artifact of acceptedAuthoringArtifacts) authoring.exec(artifact.sql);
    const authoringApplication = captureSQLiteSchema(authoring, 'application');
    sameSchema('/authoring/application', freshApplication, authoringApplication);

    const dictionary = JSON.parse(dictionaryArtifact.sql) as SQLiteSchemaSnapshot;
    sameSchema('/dictionary/application', dictionary, freshApplication);

    const predecessor = new Database(bridgePath, { create: true, strict: true });
    try {
      predecessor.exec('PRAGMA foreign_keys = ON;');
      predecessor.exec(predecessorArtifact.sql);
      assertHealthy('/predecessor', predecessor);
    } finally {
      predecessor.close();
    }
    bridged = new Database(bridgePath, { create: false, strict: true });
    bridged.exec('PRAGMA foreign_keys = ON;');
    bridged.exec(bootstrap.sql);
    bridged.exec(bridgeArtifact.sql);
    const bridgedApplication = captureSQLiteSchema(bridged, 'application');
    const bridgedFull = captureSQLiteSchema(bridged, 'full');
    sameSchema('/bridge/application', freshApplication, bridgedApplication);
    sameSchema('/bridge/full', freshFull, bridgedFull);

    assertHealthy('/fresh', fresh);
    assertHealthy('/authoring', authoring);
    assertHealthy('/bridge', bridged);

    const result = {
      freshApplicationFingerprint: fingerprintSQLiteSchema(freshApplication),
      freshFullFingerprint: fingerprintSQLiteSchema(freshFull),
      authoringApplicationFingerprint: fingerprintSQLiteSchema(authoringApplication),
      bridgedApplicationFingerprint: fingerprintSQLiteSchema(bridgedApplication),
      bridgedFullFingerprint: fingerprintSQLiteSchema(bridgedFull),
      sourceArtifactCount: acceptedAuthoringArtifacts.length
    };
    equal('/result/freshApplicationFingerprint', receipt.fingerprints.currentApplication, result.freshApplicationFingerprint);
    equal('/result/freshFullFingerprint', receipt.fingerprints.currentFull, result.freshFullFingerprint);
    return Object.freeze(result);
  } finally {
    bridged?.close();
    authoring.close();
    fresh.close();
    rmSync(bridgeDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(verifyFoundationBaseline(), null, 2));
}
