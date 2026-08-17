import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excludeGeneratedReviewOverlay } from './exclude-demo-private-overlay';
import {
  SQLITE_MIGRATION_MANIFEST,
  type SQLiteMigrationManifestEntry
} from '../packages/persistence/src/sqlite/migration-manifest';

const REPOSITORY_ROOT = resolve(import.meta.dir, '..');
const GENERATED_ROOT = resolve(REPOSITORY_ROOT, 'apps/cloudflare-worker/.generated');
const CLOUDFLARE_ASSET_ROOT = resolve(REPOSITORY_ROOT, 'apps/web/build-live');
const GENERATED_MARKER = 'jooevents-cloudflare-generated-v1';
const D1_RUNTIME_INFRASTRUCTURE: GeneratedCloudflareMigration = Object.freeze({
  fileName: '1000_d1_runtime_v1.sql',
  sql: `CREATE TABLE d1_operation_batch_guards (
  batch_id TEXT NOT NULL,
  guard_sequence INTEGER NOT NULL CHECK (guard_sequence > 0),
  passed INTEGER NOT NULL CHECK (passed = 1),
  PRIMARY KEY (batch_id, guard_sequence)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER d1_operation_batch_guard_abort
BEFORE INSERT ON d1_operation_batch_guards
WHEN NEW.passed <> 1
BEGIN
  SELECT RAISE(ABORT, 'jooevents_d1_guard_conflict');
END;
`
});
const D1_FILE_TRANSFER_INFRASTRUCTURE: GeneratedCloudflareMigration = Object.freeze({
  fileName: '1001_d1_file_transfer_attempts_v1.sql',
  sql: `CREATE TABLE d1_file_upload_transfer_attempts (
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) = 36),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK (length(event_id) = 36),
  intent_id TEXT NOT NULL CHECK (length(intent_id) = 36),
  storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'stored', 'safe_refusal', 'ambiguous_failure'
  )),
  outcome_code TEXT CHECK (outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 100),
  stored_byte_size INTEGER CHECK (stored_byte_size IS NULL OR stored_byte_size > 0),
  stored_sha256 TEXT CHECK (stored_sha256 IS NULL OR length(stored_sha256) = 64),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms BETWEEN 0 AND 8640000000000000),
  finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms BETWEEN started_at_ms AND 8640000000000000),
  PRIMARY KEY (attempt_id),
  FOREIGN KEY (workspace_id, event_id, intent_id)
    REFERENCES file_upload_intents(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (state = 'claimed' AND outcome_code IS NULL AND stored_byte_size IS NULL
      AND stored_sha256 IS NULL AND finished_at_ms IS NULL)
    OR (state = 'stored' AND outcome_code IS NULL AND stored_byte_size IS NOT NULL
      AND stored_sha256 IS NOT NULL AND finished_at_ms IS NOT NULL)
    OR (state IN ('safe_refusal', 'ambiguous_failure') AND outcome_code IS NOT NULL
      AND stored_byte_size IS NULL AND stored_sha256 IS NULL AND finished_at_ms IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX d1_file_upload_one_effective_transfer
  ON d1_file_upload_transfer_attempts(workspace_id, event_id, intent_id)
  WHERE state IN ('claimed', 'stored', 'ambiguous_failure');

CREATE INDEX d1_file_upload_transfer_by_intent
  ON d1_file_upload_transfer_attempts(workspace_id, event_id, intent_id, started_at_ms);

CREATE TRIGGER d1_file_upload_transfer_one_resolution
BEFORE UPDATE ON d1_file_upload_transfer_attempts
WHEN OLD.state <> 'claimed'
  OR NEW.state NOT IN ('stored', 'safe_refusal', 'ambiguous_failure')
  OR OLD.attempt_id <> NEW.attempt_id
  OR OLD.workspace_id <> NEW.workspace_id
  OR OLD.event_id <> NEW.event_id
  OR OLD.intent_id <> NEW.intent_id
  OR OLD.storage_key <> NEW.storage_key
  OR OLD.started_at_ms <> NEW.started_at_ms
BEGIN
  SELECT RAISE(ABORT, 'd1 file upload attempt may resolve exactly once');
END;

CREATE TRIGGER d1_file_upload_transfer_no_delete
BEFORE DELETE ON d1_file_upload_transfer_attempts
BEGIN
  SELECT RAISE(ABORT, 'd1 file upload attempts are retained');
END;
`
});

export interface GeneratedCloudflareMigration {
  readonly fileName: string;
  readonly sql: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readVerifiedArtifact(artifact: URL, expectedSha256: string): string {
  const path = fileURLToPath(artifact);
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new TypeError(`Canonical migration checksum mismatch for ${basename(path)}.`);
  }
  return bytes.toString('utf8').trimEnd();
}

function migrationReceipt(entry: SQLiteMigrationManifestEntry): string {
  return `INSERT INTO schema_migrations (
  migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
  source_fingerprint, result_fingerprint, transition_id, runner_version,
  build_identity, applied_at, duration_ms
) VALUES (
  ${quoteSql(entry.migrationId)}, ${entry.schemaEpoch}, ${entry.sequence}, 'sqlite',
  ${quoteSql(entry.checksumSha256)}, 'executed',
  ${quoteSql(entry.expectedBeforeApplicationFingerprint)},
  ${quoteSql(entry.expectedAfterApplicationFingerprint)},
  NULL, ${SQLITE_MIGRATION_MANIFEST.runnerVersion}, 'cloudflare-d1',
  unixepoch() * 1000, 0
);`;
}

const D1_SUBMISSION_TRIAGE_PREFLIGHT = `-- D1 transport preflight.
-- A fresh Cloudflare database has no retained discarded rows. This durable,
-- migration-local table replaces the Bun runner's connection-local temporary table
-- and is dropped by the canonical migration below.
CREATE TABLE e2_0002_submission_triage_spam_rows (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  head_json TEXT NOT NULL,
  head_digest_sha256 TEXT NOT NULL,
  PRIMARY KEY (workspace_id,event_id,submission_id)
) STRICT, WITHOUT ROWID;

`;

function adaptApiKeyHintConstraintForD1(
  sql: string,
  input: { readonly prefix: string; readonly length: number }
): string {
  const characterClass = '[A-Za-z0-9_-]';
  const source = `length(token_hint) = ${input.length} AND token_hint GLOB '${input.prefix}${characterClass.repeat(4)}'`;
  if (!sql.includes(source)) {
    throw new TypeError(`Canonical API-key migration is missing its reviewed ${input.prefix} hint constraint.`);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const characterChecks = Array.from({ length: 4 }, (_, index) =>
    `instr('${alphabet}', substr(token_hint, ${input.prefix.length + index + 1}, 1)) > 0`
  ).join('\n      AND ');
  return sql.replace(
    source,
    `length(token_hint) = ${input.length}\n      AND substr(token_hint, 1, ${input.prefix.length}) = '${input.prefix}'\n      AND ${characterChecks}`
  );
}

/** D1 runs migration statements on connections that do not share TEMP state. */
function adaptCanonicalMigrationForD1(entry: SQLiteMigrationManifestEntry, sql: string): string {
  let adapted = sql;
  if (entry.migrationId === 'e2_0002_submission_triage_spam') {
    adapted = D1_SUBMISSION_TRIAGE_PREFLIGHT + adapted;
  }
  if (entry.migrationId === 'e2_0004_api_key_prefix') {
    adapted = adapted.replace(
      'CREATE TEMP TABLE e2_0004_api_key_prefix_guard',
      'CREATE TABLE e2_0004_api_key_prefix_guard'
    );
  }
  if (entry.migrationId === 'e2_0003_external_agent_api') {
    adapted = adaptApiKeyHintConstraintForD1(adapted, { prefix: 'joak1_', length: 10 });
  }
  if (entry.migrationId === 'e2_0004_api_key_prefix'
      || entry.migrationId === 'e2_0005_api_key_never_expire') {
    adapted = adaptApiKeyHintConstraintForD1(adapted, { prefix: 'jooak1_', length: 11 });
  }
  adapted = adapted.replaceAll('temp.e2_0002_submission_triage_spam_rows', 'e2_0002_submission_triage_spam_rows');
  adapted = adapted.replaceAll('temp.e2_0004_api_key_prefix_guard', 'e2_0004_api_key_prefix_guard');
  if (/\b(?:TEMP\s+TABLE|temp\.e2_)/i.test(adapted)) {
    throw new TypeError(`Canonical migration ${entry.migrationId} contains an unaudited TEMP dependency.`);
  }
  return adapted;
}

/**
 * Renders D1 migration files directly from the canonical retained SQLite
 * manifest. The generated files are build material, never a second schema
 * authority. Each migration carries the same append-only canonical receipt.
 */
export function renderCloudflareD1Migrations(): readonly GeneratedCloudflareMigration[] {
  const bootstrap = readVerifiedArtifact(
    SQLITE_MIGRATION_MANIFEST.bootstrap.artifact,
    SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256
  );
  const files: GeneratedCloudflareMigration[] = [{
    fileName: '0000_jooevents_runner.sql',
    sql: `${bootstrap}\n\nINSERT INTO database_instance_metadata (
  singleton_key, application_key, database_id, database_class,
  created_at, classification_changed_at
) VALUES (
  1, 'jooevents', lower(hex(randomblob(16))), 'frozen_release',
  unixepoch() * 1000, unixepoch() * 1000
);\n`
  }];

  for (const entry of SQLITE_MIGRATION_MANIFEST.migrations) {
    const canonical = readVerifiedArtifact(entry.artifact, entry.checksumSha256);
    const d1Sql = adaptCanonicalMigrationForD1(entry, canonical);
    const ordinal = entry.sequence.toString().padStart(4, '0');
    files.push({
      fileName: `${ordinal}_${entry.migrationId}.sql`,
      sql: `${d1Sql}\n\n-- Canonical retained-migration receipt.\n${migrationReceipt(entry)}\n`
    });
  }
  files.push(D1_RUNTIME_INFRASTRUCTURE);
  files.push(D1_FILE_TRANSFER_INFRASTRUCTURE);
  return Object.freeze(files.map((file) => Object.freeze(file)));
}

function assertSafeGeneratedRoot(): void {
  if (GENERATED_ROOT !== resolve(REPOSITORY_ROOT, 'apps/cloudflare-worker/.generated')) {
    throw new TypeError('Cloudflare generated root is not the expected repository path.');
  }
  if (!existsSync(GENERATED_ROOT)) return;
  const root = lstatSync(GENERATED_ROOT);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new TypeError('Cloudflare generated root must be a direct directory.');
  }
  for (const entry of readdirSync(GENERATED_ROOT, { withFileTypes: true })) {
    const allowed = entry.name === 'migrations' || entry.name === 'manifest.json';
    if (!allowed || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new TypeError(`Unexpected object in Cloudflare generated root: ${entry.name}`);
    }
  }
}

export function writeCloudflareD1Migrations(): readonly GeneratedCloudflareMigration[] {
  const migrations = renderCloudflareD1Migrations();
  assertSafeGeneratedRoot();
  const migrationRoot = resolve(GENERATED_ROOT, 'migrations');
  if (existsSync(migrationRoot)) rmSync(migrationRoot, { recursive: true });
  mkdirSync(migrationRoot, { recursive: true, mode: 0o755 });
  for (const migration of migrations) {
    writeFileSync(resolve(migrationRoot, migration.fileName), migration.sql, { mode: 0o644 });
  }
  const manifest = {
    formatVersion: 1,
    generator: GENERATED_MARKER,
    releaseFloor: SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)?.releaseFloorId,
    files: migrations.map((migration) => ({
      fileName: migration.fileName,
      bytes: Buffer.byteLength(migration.sql),
      sha256: sha256(migration.sql)
    }))
  };
  mkdirSync(dirname(resolve(GENERATED_ROOT, 'manifest.json')), { recursive: true, mode: 0o755 });
  writeFileSync(resolve(GENERATED_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644
  });
  return migrations;
}

function command(arguments_: readonly string[]): void {
  const result = Bun.spawnSync([...arguments_], {
    cwd: REPOSITORY_ROOT,
    stdout: 'inherit',
    stderr: 'inherit'
  });
  if (result.exitCode !== 0) throw new Error(`${arguments_[0]} failed with exit code ${result.exitCode}.`);
}

export function prepareCloudflareApplication(): void {
  writeCloudflareD1Migrations();
  command(['bun', 'run', '--cwd', 'apps/web', 'build:live']);
  const exclusion = excludeGeneratedReviewOverlay(CLOUDFLARE_ASSET_ROOT);
  if (existsSync(resolve(CLOUDFLARE_ASSET_ROOT, 'reviews'))) {
    throw new TypeError('Cloudflare application assets still contain generated review material.');
  }
  if (exclusion.removed) {
    console.log(`Excluded ${exclusion.fileCount} generated review artifact(s) from Cloudflare application assets.`);
  }
}

if (import.meta.main) {
  prepareCloudflareApplication();
  console.log('Prepared verified Cloudflare assets and D1 migrations.');
}
