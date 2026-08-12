import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { SQLiteFoundationError } from './foundation-errors';
import {
  decodeSQLiteArtifact,
  sha256Hex,
  type VerifiedSQLiteArtifact
} from './migration-artifact';
import {
  captureSQLiteSchema,
  diffSQLiteSchemas,
  fingerprintSQLiteSchema,
  type SQLiteSchemaSnapshot
} from './schema-snapshot';

/**
 * Test-only manifest runner for isolated, caller-owned SQLite databases. It cannot
 * replace or extend the production migration manifest.
 */

export interface SQLiteTrialMigrationCoordinate {
  readonly schemaEpoch: number;
  readonly sequence: number;
}

export interface SQLiteTrialMigrationReference extends SQLiteTrialMigrationCoordinate {
  readonly migrationId: string;
}

export interface SQLiteTrialArtifactInput {
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
}

export interface SQLiteTrialMigrationEntry extends SQLiteTrialMigrationReference {
  readonly dialect: 'sqlite';
  readonly artifact: SQLiteTrialArtifactInput;
  readonly atomicity: 'transactional';
  readonly dependsOn: SQLiteTrialMigrationReference | null;
  readonly expectedBeforeApplicationFingerprint: string;
  readonly expectedAfterApplicationFingerprint: string;
  readonly targetedVerifierIds: readonly string[];
}

export interface SQLiteTrialPredecessorLineage {
  readonly transitionId: string;
  readonly lineageId: string;
  readonly dialect: 'sqlite';
  readonly sourceTerminal: SQLiteTrialMigrationReference;
  readonly sourceReceiptSetDigestSha256: string;
  readonly sourceApplicationFingerprint: string;
  readonly destinationBaseline: SQLiteTrialMigrationReference;
  readonly bridgeArtifactId: string;
  readonly bridgeArtifact: SQLiteTrialArtifactInput;
  readonly atomicity: 'transactional';
  readonly targetedVerifierIds: readonly string[];
  readonly verifierSetDigestSha256: string;
  readonly minimumRunnerVersion: number;
}

export interface SQLiteTrialMigrationManifestInput {
  readonly formatVersion: 1;
  readonly runnerVersion: number;
  readonly dialect: 'sqlite';
  readonly bootstrap: {
    readonly artifact: SQLiteTrialArtifactInput;
    readonly expectedRunnerFingerprint: string;
  };
  readonly migrations: readonly SQLiteTrialMigrationEntry[];
  readonly expectedEmptyApplicationFingerprint: string;
  readonly expectedCurrentApplicationFingerprint: string;
  readonly expectedCurrentFullFingerprint: string;
  readonly verifiers: readonly SQLiteTrialMigrationVerifierDefinition[];
  readonly acceptedPredecessorLineages: readonly SQLiteTrialPredecessorLineage[];
}

export interface CompiledSQLiteTrialMigrationManifest {
  readonly formatVersion: 1;
  readonly runnerVersion: number;
  readonly dialect: 'sqlite';
  readonly currentCoordinate: SQLiteTrialMigrationCoordinate;
}

export interface SQLiteTrialMigrationVerifierDefinition {
  readonly id: string;
  readonly selectSql: string;
  readonly expectedRowsDigestSha256: string;
}

export type SQLiteTrialMigrationFaultPoint =
  | 'before_runner_lock'
  | 'before_migration_lock'
  | 'before_bridge_lock'
  | 'after_migration_schema_before_receipt'
  | 'after_migration_receipt_before_commit'
  | 'after_bridge_schema_before_transition'
  | 'after_bridge_transition_before_receipt'
  | 'after_commit_before_return';

export interface SQLiteTrialMigrationState {
  readonly status: 'applied' | 'bridged' | 'current';
  readonly coordinate: SQLiteTrialMigrationCoordinate;
  readonly migrationId: string;
  readonly databaseId: string;
  readonly databaseClass: 'ephemeral';
  readonly applicationFingerprint: string;
  readonly fullFingerprint: string;
  readonly receiptCount: number;
}

interface CompiledEntry extends Omit<SQLiteTrialMigrationEntry, 'artifact' | 'dependsOn' | 'targetedVerifierIds'> {
  readonly artifact: VerifiedSQLiteArtifact;
  readonly dependsOn: SQLiteTrialMigrationReference | null;
  readonly targetedVerifierIds: readonly string[];
}

interface CompiledLineage extends Omit<SQLiteTrialPredecessorLineage, 'bridgeArtifact' | 'sourceTerminal' | 'destinationBaseline' | 'targetedVerifierIds'> {
  readonly bridgeArtifact: VerifiedSQLiteArtifact;
  readonly sourceTerminal: SQLiteTrialMigrationReference;
  readonly destinationBaseline: SQLiteTrialMigrationReference;
  readonly targetedVerifierIds: readonly string[];
}

interface CompiledManifestState {
  readonly input: Omit<SQLiteTrialMigrationManifestInput, 'bootstrap' | 'migrations' | 'verifiers' | 'acceptedPredecessorLineages'>;
  readonly bootstrap: {
    readonly artifact: VerifiedSQLiteArtifact;
    readonly expectedRunnerFingerprint: string;
  };
  readonly migrations: readonly CompiledEntry[];
  readonly lineages: readonly CompiledLineage[];
  readonly verifiers: ReadonlyMap<string, SQLiteTrialMigrationVerifierDefinition>;
  readonly runnerSnapshot: SQLiteSchemaSnapshot;
  readonly currentSnapshot: SQLiteSchemaSnapshot;
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
  readonly application_key: string;
  readonly database_id: string;
  readonly database_class: string;
  readonly created_at: number;
  readonly classification_changed_at: number;
}

interface DatabaseListRow {
  readonly seq: number;
  readonly name: string;
  readonly file: string;
}

const manifestState = new WeakMap<CompiledSQLiteTrialMigrationManifest, CompiledManifestState>();
const HEX_64 = /^[0-9a-f]{64}$/;
const STABLE_ID = /^[a-z][a-z0-9_.-]{1,119}$/;
const RUNNER_OBJECT_NAMES = Object.freeze([
  'schema_migrations',
  'schema_epoch_transitions',
  'database_instance_metadata'
]);

function invalidManifest(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new SQLiteFoundationError('invalid_migration_options', message, details);
}

function requireHex(value: string, field: string): void {
  if (!HEX_64.test(value)) invalidManifest(`${field} must be lowercase SHA-256 hex.`);
}

function requireStableId(value: string, field: string): void {
  if (!STABLE_ID.test(value)) invalidManifest(`${field} is not a stable migration identifier.`);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) invalidManifest(`${field} must be a positive safe integer.`);
}

function sameReference(left: SQLiteTrialMigrationReference, right: SQLiteTrialMigrationReference): boolean {
  return left.schemaEpoch === right.schemaEpoch &&
    left.sequence === right.sequence &&
    left.migrationId === right.migrationId;
}

function freezeReference(reference: SQLiteTrialMigrationReference): SQLiteTrialMigrationReference {
  return Object.freeze({
    migrationId: reference.migrationId,
    schemaEpoch: reference.schemaEpoch,
    sequence: reference.sequence
  });
}

type SQLiteLexicalToken =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'semicolon' };

function sqliteLexicalTokens(sql: string): readonly SQLiteLexicalToken[] {
  const tokens: SQLiteLexicalToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(sql.length, index + 2);
      continue;
    }
    if (current === "'") {
      const quote = current;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (current === '"' || current === '`') {
      const quote = current;
      let value = '';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            value += quote;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += sql[index] ?? '';
        index += 1;
      }
      if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
        tokens.push(Object.freeze({ kind: 'word', value: value.toUpperCase() }));
      }
      continue;
    }
    if (current === '[') {
      let value = '';
      index += 1;
      while (index < sql.length && sql[index] !== ']') {
        value += sql[index] ?? '';
        index += 1;
      }
      index = Math.min(sql.length, index + 1);
      if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
        tokens.push(Object.freeze({ kind: 'word', value: value.toUpperCase() }));
      }
      continue;
    }
    if (current === ';') {
      tokens.push(Object.freeze({ kind: 'semicolon' }));
      index += 1;
      continue;
    }
    if (current !== undefined && /[A-Za-z_]/.test(current)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index] ?? '')) index += 1;
      tokens.push(Object.freeze({ kind: 'word', value: sql.slice(start, index).toUpperCase() }));
      continue;
    }
    index += 1;
  }
  return Object.freeze(tokens);
}

function assertRunnerOwnedTransactions(sql: string, label: string, allowRunnerPragmas: boolean): void {
  const prohibitedStatements = new Set([
    'ATTACH',
    'BEGIN',
    'COMMIT',
    'DETACH',
    'END',
    'RELEASE',
    'ROLLBACK',
    'SAVEPOINT',
    'VACUUM'
  ]);
  let statementWords: string[] = [];
  let triggerDeclaration = false;
  let triggerBody = false;
  let triggerEndPending = false;
  let caseDepth = 0;

  function resetStatement(): void {
    statementWords = [];
    triggerDeclaration = false;
    triggerBody = false;
    triggerEndPending = false;
    caseDepth = 0;
  }

  for (const token of sqliteLexicalTokens(sql)) {
    if (token.kind === 'semicolon') {
      if (!triggerBody || triggerEndPending) resetStatement();
      continue;
    }
    const word = token.value;
    if (triggerBody) {
      if (triggerEndPending) {
        invalidManifest(`${label} contains malformed SQL after a trigger END token.`);
      }
      if (word === 'CASE') {
        caseDepth += 1;
      } else if (word === 'END') {
        if (caseDepth > 0) caseDepth -= 1;
        else triggerEndPending = true;
      }
      continue;
    }

    if (statementWords.length === 0 &&
      (prohibitedStatements.has(word) || (!allowRunnerPragmas && word === 'PRAGMA'))) {
      invalidManifest(`${label} contains runner-owned or external-database control.`, { keyword: word });
    }
    statementWords.push(word);
    if (
      (statementWords[0] === 'CREATE' && statementWords[1] === 'TRIGGER') ||
      (statementWords[0] === 'CREATE' &&
        (statementWords[1] === 'TEMP' || statementWords[1] === 'TEMPORARY') &&
        statementWords[2] === 'TRIGGER')
    ) {
      triggerDeclaration = true;
    }
    if (triggerDeclaration && word === 'BEGIN') triggerBody = true;
  }
}

function assertNoRunnerRelationAccess(sql: string, label: string): void {
  const forbidden = new Set([
    'SCHEMA_MIGRATIONS',
    'SCHEMA_EPOCH_TRANSITIONS',
    'DATABASE_INSTANCE_METADATA',
    'LOAD_EXTENSION',
    'READFILE',
    'SQLITE_SCHEMA',
    'SQLITE_MASTER',
    'WRITEFILE'
  ]);
  const referenced = sqliteLexicalTokens(sql).find((token) =>
    token.kind === 'word' && forbidden.has(token.value)
  );
  if (referenced?.kind === 'word') {
    invalidManifest(`${label} may not access runner-owned relations.`, { relation: referenced.value });
  }
}

function compileArtifact(
  input: SQLiteTrialArtifactInput,
  label: string,
  allowRunnerRelations = false
): VerifiedSQLiteArtifact {
  requireHex(input.checksumSha256, `${label}.checksumSha256`);
  const bytes = Buffer.from(input.bytes);
  const actual = sha256Hex(bytes);
  if (actual !== input.checksumSha256) {
    throw new SQLiteFoundationError(
      'artifact_checksum_mismatch',
      `${label} bytes do not match the manifest checksum.`,
      { expectedChecksumSha256: input.checksumSha256, actualChecksumSha256: actual }
    );
  }
  const sql = decodeSQLiteArtifact(bytes);
  assertRunnerOwnedTransactions(sql, label, allowRunnerRelations);
  if (!allowRunnerRelations) assertNoRunnerRelationAccess(sql, label);
  return Object.freeze({ bytes, checksumSha256: actual, sql });
}

function compileVerifierIds(ids: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(ids)) invalidManifest(`${field} must be an array.`);
  const copy = ids.map((id, index) => {
    requireStableId(id, `${field}[${index}]`);
    return id;
  });
  if (new Set(copy).size !== copy.length) invalidManifest(`${field} contains a duplicate verifier.`);
  const sorted = [...copy].sort();
  if (!copy.every((id, index) => id === sorted[index])) {
    invalidManifest(`${field} must be in canonical lexical order.`);
  }
  return Object.freeze(copy);
}

export function sqliteTrialVerifierSetDigest(ids: readonly string[]): string {
  return sha256Hex(encodeCanonicalJson([...ids]));
}

export function sqliteTrialVerifierRowsDigest(
  rows: readonly Readonly<Record<string, unknown>>[]
): string {
  const canonicalRows = rows
    .map((row) => Buffer.from(encodeCanonicalJson(row)).toString('utf8'))
    .sort();
  return sha256Hex(encodeCanonicalJson(canonicalRows));
}

export function sqliteTrialReceiptSetDigest(receipts: readonly {
  readonly migrationId: string;
  readonly schemaEpoch: number;
  readonly sequence: number;
  readonly dialect: 'sqlite';
  readonly checksumSha256: string;
  readonly receiptKind: 'executed' | 'legacy_adoption' | 'epoch_bridge';
}[]): string {
  const canonical = receipts.map((receipt) => ({
    checksum_sha256: receipt.checksumSha256,
    dialect: receipt.dialect,
    migration_id: receipt.migrationId,
    receipt_kind: receipt.receiptKind,
    schema_epoch: receipt.schemaEpoch,
    sequence: receipt.sequence
  })).sort((left, right) =>
    left.schema_epoch - right.schema_epoch ||
    left.sequence - right.sequence ||
    left.dialect.localeCompare(right.dialect) ||
    left.migration_id.localeCompare(right.migration_id)
  );
  return sha256Hex(encodeCanonicalJson(canonical));
}

function runnerObjectCount(database: Database): number {
  const placeholders = RUNNER_OBJECT_NAMES.map(() => '?').join(', ');
  return database.query<{ count: number }, string[]>(`
    select count(*) as count
      from main.sqlite_schema
     where name in (${placeholders}) or tbl_name in (${placeholders})
  `).get(...RUNNER_OBJECT_NAMES, ...RUNNER_OBJECT_NAMES)?.count ?? 0;
}

function schemaMismatch(
  message: string,
  expected: SQLiteSchemaSnapshot,
  actual: SQLiteSchemaSnapshot
): SQLiteFoundationError {
  return new SQLiteFoundationError('schema_drift', message, {
    expectedFingerprint: fingerprintSQLiteSchema(expected),
    actualFingerprint: fingerprintSQLiteSchema(actual),
    differences: diffSQLiteSchemas(expected, actual)
  });
}

function assertFingerprint(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SQLiteFoundationError('schema_drift', `${label} does not match its declared fingerprint.`, {
      expectedFingerprint: expected,
      actualFingerprint: actual
    });
  }
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
        // Preserve the first failure; callers discard the connection on rollback failure.
      }
    }
    if (error instanceof SQLiteFoundationError) throw error;
    throw new SQLiteFoundationError(
      'migration_transaction_failed',
      'The manifest-driven SQLite migration transaction failed and was rolled back.',
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function compileEntries(input: SQLiteTrialMigrationManifestInput): readonly CompiledEntry[] {
  if (!Array.isArray(input.migrations) || input.migrations.length === 0) {
    invalidManifest('A migration manifest must contain at least one active migration.');
  }
  const entries = input.migrations.map((entry, index): CompiledEntry => {
    requireStableId(entry.migrationId, `migrations[${index}].migrationId`);
    requirePositiveInteger(entry.schemaEpoch, `migrations[${index}].schemaEpoch`);
    requirePositiveInteger(entry.sequence, `migrations[${index}].sequence`);
    if (entry.dialect !== 'sqlite' || entry.atomicity !== 'transactional') {
      invalidManifest('The Wave-0 trial supports only transactional SQLite artifacts.');
    }
    requireHex(entry.expectedBeforeApplicationFingerprint, `migrations[${index}].expectedBeforeApplicationFingerprint`);
    requireHex(entry.expectedAfterApplicationFingerprint, `migrations[${index}].expectedAfterApplicationFingerprint`);
    const dependsOn = entry.dependsOn === null ? null : freezeReference(entry.dependsOn);
    const targetedVerifierIds = compileVerifierIds(
      entry.targetedVerifierIds,
      `migrations[${index}].targetedVerifierIds`
    );
    if (entry.expectedBeforeApplicationFingerprint === entry.expectedAfterApplicationFingerprint &&
      targetedVerifierIds.length === 0) {
      invalidManifest('A data-only migration must declare at least one targeted verifier.', {
        migrationId: entry.migrationId
      });
    }
    return Object.freeze({
      migrationId: entry.migrationId,
      schemaEpoch: entry.schemaEpoch,
      sequence: entry.sequence,
      dialect: 'sqlite',
      artifact: compileArtifact(entry.artifact, `migrations[${index}].artifact`),
      atomicity: 'transactional',
      dependsOn,
      expectedBeforeApplicationFingerprint: entry.expectedBeforeApplicationFingerprint,
      expectedAfterApplicationFingerprint: entry.expectedAfterApplicationFingerprint,
      targetedVerifierIds
    });
  });

  const firstEpoch = entries[0]?.schemaEpoch;
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry.schemaEpoch !== firstEpoch) invalidManifest('One active chain may contain only one schema epoch.');
    if (entry.sequence !== index + 1) invalidManifest('Active migration sequences must be contiguous and start at one.');
    if (ids.has(entry.migrationId)) invalidManifest('Migration IDs must be unique.', { migrationId: entry.migrationId });
    ids.add(entry.migrationId);
    const coordinateKey = `${entry.schemaEpoch}:${entry.sequence}`;
    if (coordinates.has(coordinateKey)) invalidManifest('Migration coordinates must be unique.', { coordinateKey });
    coordinates.add(coordinateKey);
    if (index === 0) {
      if (entry.dependsOn !== null) invalidManifest('The baseline migration must not declare a dependency.');
    } else {
      const prior = entries[index - 1];
      if (!prior || entry.dependsOn === null || !sameReference(entry.dependsOn, prior)) {
        invalidManifest('Each migration must depend exactly on the prior active coordinate.', {
          migrationId: entry.migrationId
        });
      }
      if (entry.expectedBeforeApplicationFingerprint !== prior.expectedAfterApplicationFingerprint) {
        invalidManifest('Adjacent migration fingerprints do not form one exact chain.', {
          migrationId: entry.migrationId
        });
      }
    }
  });
  return Object.freeze(entries);
}

function compileLineages(
  input: SQLiteTrialMigrationManifestInput,
  entries: readonly CompiledEntry[]
): readonly CompiledLineage[] {
  if (!Array.isArray(input.acceptedPredecessorLineages)) {
    invalidManifest('acceptedPredecessorLineages must be an array.');
  }
  const transitionIds = new Set<string>();
  const lineageKeys = new Set<string>();
  return Object.freeze(input.acceptedPredecessorLineages.map((lineage, index): CompiledLineage => {
    requireStableId(lineage.transitionId, `lineages[${index}].transitionId`);
    requireStableId(lineage.lineageId, `lineages[${index}].lineageId`);
    requireStableId(lineage.bridgeArtifactId, `lineages[${index}].bridgeArtifactId`);
    requireStableId(lineage.sourceTerminal.migrationId, `lineages[${index}].sourceTerminal.migrationId`);
    requirePositiveInteger(lineage.sourceTerminal.schemaEpoch, `lineages[${index}].sourceTerminal.schemaEpoch`);
    requirePositiveInteger(lineage.sourceTerminal.sequence, `lineages[${index}].sourceTerminal.sequence`);
    requirePositiveInteger(lineage.minimumRunnerVersion, `lineages[${index}].minimumRunnerVersion`);
    requireHex(lineage.sourceReceiptSetDigestSha256, `lineages[${index}].sourceReceiptSetDigestSha256`);
    requireHex(lineage.sourceApplicationFingerprint, `lineages[${index}].sourceApplicationFingerprint`);
    requireHex(lineage.verifierSetDigestSha256, `lineages[${index}].verifierSetDigestSha256`);
    if (lineage.dialect !== 'sqlite' || lineage.atomicity !== 'transactional') {
      invalidManifest('Wave-0 predecessor bridges must be transactional SQLite artifacts.');
    }
    const baseline = entries[0];
    if (!baseline || !sameReference(lineage.destinationBaseline, baseline)) {
      invalidManifest('A predecessor lineage must target the exact active baseline.');
    }
    if (lineage.sourceTerminal.schemaEpoch >= baseline.schemaEpoch) {
      invalidManifest('A predecessor lineage must move to a strictly newer schema epoch.');
    }
    const verifierIds = compileVerifierIds(lineage.targetedVerifierIds, `lineages[${index}].targetedVerifierIds`);
    if (sqliteTrialVerifierSetDigest(verifierIds) !== lineage.verifierSetDigestSha256) {
      invalidManifest('A predecessor lineage verifier-set digest does not match its ordered verifier IDs.');
    }
    if (transitionIds.has(lineage.transitionId)) invalidManifest('Transition IDs must be unique.');
    transitionIds.add(lineage.transitionId);
    const lineageKey = `${lineage.lineageId}:sqlite:${baseline.schemaEpoch}`;
    if (lineageKeys.has(lineageKey)) invalidManifest('Lineage/dialect/destination epoch must be unique.');
    lineageKeys.add(lineageKey);
    return Object.freeze({
      transitionId: lineage.transitionId,
      lineageId: lineage.lineageId,
      dialect: 'sqlite',
      sourceTerminal: freezeReference(lineage.sourceTerminal),
      sourceReceiptSetDigestSha256: lineage.sourceReceiptSetDigestSha256,
      sourceApplicationFingerprint: lineage.sourceApplicationFingerprint,
      destinationBaseline: freezeReference(lineage.destinationBaseline),
      bridgeArtifactId: lineage.bridgeArtifactId,
      bridgeArtifact: compileArtifact(lineage.bridgeArtifact, `lineages[${index}].bridgeArtifact`),
      atomicity: 'transactional',
      targetedVerifierIds: verifierIds,
      verifierSetDigestSha256: lineage.verifierSetDigestSha256,
      minimumRunnerVersion: lineage.minimumRunnerVersion
    });
  }));
}

function compileVerifiers(
  input: SQLiteTrialMigrationManifestInput,
  entries: readonly CompiledEntry[],
  lineages: readonly CompiledLineage[]
): ReadonlyMap<string, SQLiteTrialMigrationVerifierDefinition> {
  if (!Array.isArray(input.verifiers)) invalidManifest('verifiers must be an array.');
  const referenced = new Set<string>();
  for (const entry of entries) {
    for (const id of entry.targetedVerifierIds) referenced.add(id);
  }
  for (const lineage of lineages) {
    for (const id of lineage.targetedVerifierIds) referenced.add(id);
  }
  const definitions = new Map<string, SQLiteTrialMigrationVerifierDefinition>();
  input.verifiers.forEach((definition, index) => {
    requireStableId(definition.id, `verifiers[${index}].id`);
    requireHex(definition.expectedRowsDigestSha256, `verifiers[${index}].expectedRowsDigestSha256`);
    const tokens = sqliteLexicalTokens(definition.selectSql);
    const words = tokens.filter((token): token is Extract<SQLiteLexicalToken, { kind: 'word' }> =>
      token.kind === 'word'
    );
    if (words[0]?.value !== 'SELECT' || tokens.some((token) => token.kind === 'semicolon')) {
      invalidManifest('A targeted verifier must be exactly one SELECT statement.', {
        verifierId: definition.id
      });
    }
    if (definitions.has(definition.id)) {
      invalidManifest('Targeted verifier definitions must be unique.', { verifierId: definition.id });
    }
    definitions.set(definition.id, Object.freeze({
      id: definition.id,
      selectSql: definition.selectSql,
      expectedRowsDigestSha256: definition.expectedRowsDigestSha256
    }));
  });
  for (const id of referenced) {
    if (!definitions.has(id)) invalidManifest('The manifest cites an unknown targeted verifier.', { verifierId: id });
  }
  for (const id of definitions.keys()) {
    if (!referenced.has(id)) invalidManifest('The manifest registers an orphan targeted verifier.', { verifierId: id });
  }
  return definitions;
}

function buildReferenceSnapshots(
  bootstrap: VerifiedSQLiteArtifact,
  entries: readonly CompiledEntry[],
  verifiers: ReadonlyMap<string, SQLiteTrialMigrationVerifierDefinition>,
  input: SQLiteTrialMigrationManifestInput
): { readonly runner: SQLiteSchemaSnapshot; readonly current: SQLiteSchemaSnapshot } {
  const database = new Database(':memory:', { create: true, strict: true });
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    const empty = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
    assertFingerprint('The empty application schema', empty, input.expectedEmptyApplicationFingerprint);
    database.exec(bootstrap.sql);
    assertDisposableTrialTarget(database);
    const runner = captureSQLiteSchema(database, 'runner');
    assertFingerprint(
      'The runner bootstrap schema',
      fingerprintSQLiteSchema(runner),
      input.bootstrap.expectedRunnerFingerprint
    );
    for (const entry of entries) {
      immediateTransaction(database, () => {
        const runnerDataBefore = captureRunnerData(database);
        assertFingerprint(
          `Migration ${entry.migrationId} before-schema`,
          fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application')),
          entry.expectedBeforeApplicationFingerprint
        );
        database.exec(entry.artifact.sql);
        if (!database.inTransaction) {
          throw new SQLiteFoundationError(
            'migration_transaction_failed',
            `Migration ${entry.migrationId} escaped reference validation.`
          );
        }
        assertDisposableTrialTarget(database);
        assertFingerprint(
          `Migration ${entry.migrationId} runner schema`,
          fingerprintSQLiteSchema(captureSQLiteSchema(database, 'runner')),
          input.bootstrap.expectedRunnerFingerprint
        );
        assertFingerprint(
          `Migration ${entry.migrationId} after-schema`,
          fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application')),
          entry.expectedAfterApplicationFingerprint
        );
        runVerifierDefinitions(database, verifiers, entry.targetedVerifierIds, 'migration', entry);
        assertForeignKeyIntegrity(database);
        assertRunnerDataUnchanged(runnerDataBefore, captureRunnerData(database));
      });
    }
    const applicationFingerprint = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
    assertFingerprint('The current application schema', applicationFingerprint, input.expectedCurrentApplicationFingerprint);
    const current = captureSQLiteSchema(database, 'full');
    assertFingerprint('The current full schema', fingerprintSQLiteSchema(current), input.expectedCurrentFullFingerprint);
    return { runner, current };
  } finally {
    database.close();
  }
}

export function compileSQLiteTrialMigrationManifest(
  input: SQLiteTrialMigrationManifestInput
): CompiledSQLiteTrialMigrationManifest {
  if (input.formatVersion !== 1 || input.dialect !== 'sqlite') invalidManifest('Unknown migration manifest format or dialect.');
  requirePositiveInteger(input.runnerVersion, 'runnerVersion');
  requireHex(input.bootstrap.expectedRunnerFingerprint, 'bootstrap.expectedRunnerFingerprint');
  requireHex(input.expectedEmptyApplicationFingerprint, 'expectedEmptyApplicationFingerprint');
  requireHex(input.expectedCurrentApplicationFingerprint, 'expectedCurrentApplicationFingerprint');
  requireHex(input.expectedCurrentFullFingerprint, 'expectedCurrentFullFingerprint');
  const bootstrap = Object.freeze({
    artifact: compileArtifact(input.bootstrap.artifact, 'bootstrap.artifact', true),
    expectedRunnerFingerprint: input.bootstrap.expectedRunnerFingerprint
  });
  const migrations = compileEntries(input);
  const first = migrations[0];
  const last = migrations.at(-1);
  if (!first || !last) invalidManifest('The active migration chain is empty.');
  if (first.expectedBeforeApplicationFingerprint !== input.expectedEmptyApplicationFingerprint) {
    invalidManifest('The active baseline must begin at the declared empty application fingerprint.');
  }
  if (last.expectedAfterApplicationFingerprint !== input.expectedCurrentApplicationFingerprint) {
    invalidManifest('The active chain terminal fingerprint does not match the manifest current fingerprint.');
  }
  const lineages = compileLineages(input, migrations);
  const verifiers = compileVerifiers(input, migrations, lineages);
  const snapshots = buildReferenceSnapshots(bootstrap.artifact, migrations, verifiers, input);
  const handle = Object.freeze({
    formatVersion: 1 as const,
    runnerVersion: input.runnerVersion,
    dialect: 'sqlite' as const,
    currentCoordinate: Object.freeze({ schemaEpoch: last.schemaEpoch, sequence: last.sequence })
  });
  manifestState.set(handle, Object.freeze({
    input: Object.freeze({
      formatVersion: 1,
      runnerVersion: input.runnerVersion,
      dialect: 'sqlite',
      expectedEmptyApplicationFingerprint: input.expectedEmptyApplicationFingerprint,
      expectedCurrentApplicationFingerprint: input.expectedCurrentApplicationFingerprint,
      expectedCurrentFullFingerprint: input.expectedCurrentFullFingerprint
    }),
    bootstrap,
    migrations,
    lineages,
    verifiers,
    runnerSnapshot: snapshots.runner,
    currentSnapshot: snapshots.current
  }));
  return handle;
}

function openManifest(handle: CompiledSQLiteTrialMigrationManifest): CompiledManifestState {
  const state = manifestState.get(handle);
  if (!state) invalidManifest('The compiled migration manifest is not authentic.');
  return state;
}

function receiptRows(database: Database): readonly ReceiptRow[] {
  return database.query<ReceiptRow, []>(`
    select migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
           source_fingerprint, result_fingerprint, transition_id, runner_version,
           build_identity, applied_at, duration_ms
      from main.schema_migrations
     order by schema_epoch, sequence, dialect, migration_id
  `).all();
}

function transitionRows(database: Database): readonly TransitionRow[] {
  return database.query<TransitionRow, []>(`
    select id, lineage_id, dialect, source_epoch, source_sequence,
           source_receipt_set_digest, source_fingerprint, destination_epoch,
           destination_migration_id, destination_baseline_checksum,
           destination_fingerprint, bridge_artifact_id, bridge_artifact_checksum,
           atomicity, verifier_set_digest, runner_version, build_identity,
           applied_at, duration_ms
      from main.schema_epoch_transitions
     order by destination_epoch, id
  `).all();
}

function metadataRows(database: Database): readonly MetadataRow[] {
  return database.query<MetadataRow, []>(`
    select application_key, database_id, database_class, created_at, classification_changed_at
      from main.database_instance_metadata
     order by singleton_key
  `).all();
}

interface RunnerDataSnapshot {
  readonly receipts: readonly ReceiptRow[];
  readonly transitions: readonly TransitionRow[];
  readonly metadata: readonly MetadataRow[];
}

function captureRunnerData(database: Database): RunnerDataSnapshot {
  return Object.freeze({
    receipts: receiptRows(database),
    transitions: transitionRows(database),
    metadata: metadataRows(database)
  });
}

function runnerDataDigest(value: unknown): string {
  return sha256Hex(encodeCanonicalJson(value));
}

function assertRunnerDataUnchanged(before: RunnerDataSnapshot, after: RunnerDataSnapshot): void {
  if (runnerDataDigest(before) !== runnerDataDigest(after)) {
    throw new SQLiteFoundationError(
      'receipt_chain_malformed',
      'An application migration attempted to alter runner-owned rows.'
    );
  }
}

function assertArrayPrefix(before: readonly unknown[], after: readonly unknown[], label: string): void {
  if (after.length !== before.length + 1 ||
    runnerDataDigest(before) !== runnerDataDigest(after.slice(0, before.length))) {
    throw new SQLiteFoundationError('receipt_chain_malformed', `The runner did not append exactly one ${label}.`);
  }
}

function assertForeignKeyIntegrity(database: Database): void {
  const violations = database.query<Record<string, unknown>, []>('PRAGMA main.foreign_key_check').all();
  if (violations.length > 0) {
    throw new SQLiteFoundationError('schema_drift', 'The migrated database violates foreign-key integrity.', {
      violationCount: violations.length
    });
  }
}

function metadata(database: Database): MetadataRow {
  const rows = metadataRows(database);
  const row = rows[0];
  if (rows.length !== 1 || !row || row.application_key !== 'jooevents' ||
    !/^[0-9a-f]{32}$/.test(row.database_id) ||
    !['ephemeral', 'retained_development', 'frozen_release'].includes(row.database_class) ||
    !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
    !Number.isSafeInteger(row.classification_changed_at) || row.classification_changed_at < row.created_at) {
    throw new SQLiteFoundationError('receipt_chain_malformed', 'Database instance metadata is missing or malformed.');
  }
  return row;
}

function assertDisposableTrialTarget(database: Database): void {
  const databases = database.query<DatabaseListRow, []>('PRAGMA database_list').all();
  const main = databases.find((entry) => entry.name === 'main');
  const onlyBuiltInMemorySchemas = databases.every((entry) =>
    entry.file === '' && (entry.name === 'main' || entry.name === 'temp')
  );
  const temporaryObjectCount = database.query<{ count: number }, []>(`
    select count(*) as count from sqlite_temp_schema
  `).get()?.count ?? 0;
  if (!main || main.seq !== 0 || main.file !== '' || !onlyBuiltInMemorySchemas || temporaryObjectCount !== 0) {
    throw new SQLiteFoundationError(
      'database_class_mismatch',
      'The disposable migration-chain proof accepts only an unshadowed in-memory main database.'
    );
  }
}

function assertRunner(database: Database, state: CompiledManifestState): void {
  assertDisposableTrialTarget(database);
  const actual = captureSQLiteSchema(database, 'runner');
  if (fingerprintSQLiteSchema(actual) !== state.bootstrap.expectedRunnerFingerprint) {
    throw new SQLiteFoundationError('runner_schema_malformed', 'Runner objects do not match the manifest bootstrap.', {
      expectedFingerprint: state.bootstrap.expectedRunnerFingerprint,
      actualFingerprint: fingerprintSQLiteSchema(actual),
      differences: diffSQLiteSchemas(state.runnerSnapshot, actual)
    });
  }
}

function ensureRunner(database: Database, state: CompiledManifestState): boolean {
  return immediateTransaction(database, () => {
    if (runnerObjectCount(database) === 0) {
      const application = captureSQLiteSchema(database, 'application');
      const fingerprint = fingerprintSQLiteSchema(application);
      if (fingerprint !== state.input.expectedEmptyApplicationFingerprint) {
        throw new SQLiteFoundationError('schema_drift', 'An unmanaged database does not match the active empty baseline.', {
          expectedFingerprint: state.input.expectedEmptyApplicationFingerprint,
          actualFingerprint: fingerprint
        });
      }
      database.exec(state.bootstrap.artifact.sql);
      assertRunner(database, state);
      insertMetadata(database, randomBytes(16).toString('hex'), Date.now());
      return true;
    }
    assertRunner(database, state);
    const existing = metadata(database);
    if (existing.database_class !== 'ephemeral') {
      throw new SQLiteFoundationError(
        'database_class_mismatch',
        'The disposable migration-chain proof refuses non-ephemeral database metadata.'
      );
    }
    return false;
  });
}

function insertMetadata(
  database: Database,
  databaseId: string,
  now: number
): void {
  database.query(`
    insert into main.database_instance_metadata
      (singleton_key, application_key, database_id, database_class, created_at, classification_changed_at)
    values (1, 'jooevents', ?, ?, ?, ?)
  `).run(databaseId, 'ephemeral', now, now);
}

function insertMigrationReceipt(
  database: Database,
  state: CompiledManifestState,
  entry: CompiledEntry,
  kind: 'executed' | 'epoch_bridge',
  sourceFingerprint: string,
  transitionId: string | null,
  startedAt: number
): void {
  database.query(`
    insert into main.schema_migrations
      (migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
       source_fingerprint, result_fingerprint, transition_id, runner_version,
       build_identity, applied_at, duration_ms)
    values (?, ?, ?, 'sqlite', ?, ?, ?, ?, ?, ?, 'migration-chain-trial', ?, ?)
  `).run(
    entry.migrationId,
    entry.schemaEpoch,
    entry.sequence,
    entry.artifact.checksumSha256,
    kind,
    sourceFingerprint,
    entry.expectedAfterApplicationFingerprint,
    transitionId,
    state.input.runnerVersion,
    startedAt,
    Math.max(0, Date.now() - startedAt)
  );
}

function runVerifierDefinitions(
  database: Database,
  definitions: ReadonlyMap<string, SQLiteTrialMigrationVerifierDefinition>,
  ids: readonly string[],
  kind: 'migration' | 'epoch_bridge',
  migration: SQLiteTrialMigrationReference
): void {
  for (const id of ids) {
    const verifier = definitions.get(id);
    if (!verifier) invalidManifest('The manifest cites an unknown targeted verifier.', { verifierId: id });
    const rows = database.query<Record<string, unknown>, []>(verifier.selectSql).all();
    const actualRowsDigestSha256 = sqliteTrialVerifierRowsDigest(rows);
    if (actualRowsDigestSha256 !== verifier.expectedRowsDigestSha256) {
      throw new SQLiteFoundationError(
        'schema_drift',
        'A targeted migration verifier rejected the migrated state.',
        {
          verifierId: id,
          kind,
          migrationId: migration.migrationId,
          expectedRowsDigestSha256: verifier.expectedRowsDigestSha256,
          actualRowsDigestSha256
        }
      );
    }
  }
}

function runVerifiers(
  database: Database,
  state: CompiledManifestState,
  ids: readonly string[],
  kind: 'migration' | 'epoch_bridge',
  migration: SQLiteTrialMigrationReference
): void {
  runVerifierDefinitions(database, state.verifiers, ids, kind, migration);
}

function assertReceiptCommon(row: ReceiptRow, runnerVersion: number): void {
  if (row.dialect !== 'sqlite' || !HEX_64.test(row.checksum_sha256) ||
    !HEX_64.test(row.source_fingerprint) || !HEX_64.test(row.result_fingerprint) ||
    row.runner_version !== runnerVersion || row.build_identity.length < 1 || row.build_identity.length > 120 ||
    !Number.isSafeInteger(row.applied_at) || row.applied_at < 0 ||
    !Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0) {
    throw new SQLiteFoundationError('receipt_chain_malformed', 'A migration receipt is malformed.', {
      migrationId: row.migration_id
    });
  }
}

function validateExpectedReceipt(
  row: ReceiptRow,
  state: CompiledManifestState,
  entry: CompiledEntry,
  kind: 'executed' | 'epoch_bridge',
  sourceFingerprint: string,
  transitionId: string | null
): void {
  assertReceiptCommon(row, state.input.runnerVersion);
  if (row.migration_id !== entry.migrationId || row.schema_epoch !== entry.schemaEpoch ||
    row.sequence !== entry.sequence || row.checksum_sha256 !== entry.artifact.checksumSha256 ||
    row.receipt_kind !== kind || row.source_fingerprint !== sourceFingerprint ||
    row.result_fingerprint !== entry.expectedAfterApplicationFingerprint ||
    row.transition_id !== transitionId) {
    throw new SQLiteFoundationError(
      'receipt_chain_malformed',
      'The appended migration receipt does not match its exact manifest entry.',
      { migrationId: entry.migrationId }
    );
  }
}

function activeReceiptPrefix(
  receipts: readonly ReceiptRow[],
  state: CompiledManifestState
): { readonly offset: number; readonly count: number } | undefined {
  if (receipts.length > state.migrations.length) return undefined;
  for (let index = 0; index < receipts.length; index += 1) {
    const row = receipts[index];
    const entry = state.migrations[index];
    if (!row || !entry) return undefined;
    assertReceiptCommon(row, state.input.runnerVersion);
    if (row.migration_id !== entry.migrationId || row.schema_epoch !== entry.schemaEpoch ||
      row.sequence !== entry.sequence || row.checksum_sha256 !== entry.artifact.checksumSha256 ||
      row.receipt_kind !== 'executed' || row.transition_id !== null ||
      row.source_fingerprint !== entry.expectedBeforeApplicationFingerprint ||
      row.result_fingerprint !== entry.expectedAfterApplicationFingerprint) return undefined;
  }
  return { offset: 0, count: receipts.length };
}

function sourceDigest(rows: readonly ReceiptRow[]): string {
  return sqliteTrialReceiptSetDigest(rows.map((row) => ({
    migrationId: row.migration_id,
    schemaEpoch: row.schema_epoch,
    sequence: row.sequence,
    dialect: 'sqlite' as const,
    checksumSha256: row.checksum_sha256,
    receiptKind: row.receipt_kind as 'executed' | 'legacy_adoption' | 'epoch_bridge'
  })));
}

function validateSingleEpochPredecessorReceiptChain(rows: readonly ReceiptRow[]): ReceiptRow {
  if (rows.length === 0) {
    throw new SQLiteFoundationError('receipt_chain_malformed', 'A predecessor receipt set cannot be empty.');
  }
  const epoch = rows[0]?.schema_epoch;
  const ids = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.dialect !== 'sqlite' || !STABLE_ID.test(row.migration_id) ||
      !Number.isSafeInteger(row.schema_epoch) || row.schema_epoch <= 0 || row.schema_epoch !== epoch ||
      !Number.isSafeInteger(row.sequence) || row.sequence !== index + 1 ||
      !HEX_64.test(row.checksum_sha256) || !HEX_64.test(row.source_fingerprint) ||
      !HEX_64.test(row.result_fingerprint) ||
      (row.receipt_kind !== 'executed' && row.receipt_kind !== 'legacy_adoption') ||
      row.transition_id !== null || !Number.isSafeInteger(row.runner_version) || row.runner_version <= 0 ||
      row.build_identity.length < 1 || row.build_identity.length > 120 ||
      !Number.isSafeInteger(row.applied_at) || row.applied_at < 0 ||
      !Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0 || ids.has(row.migration_id)) {
      throw new SQLiteFoundationError('receipt_chain_malformed', 'A predecessor migration receipt is malformed.', {
        receiptIndex: index
      });
    }
    if ((index === 0 && row.receipt_kind === 'legacy_adoption' && row.sequence !== 1) ||
      (index > 0 && row.receipt_kind !== 'executed')) {
      throw new SQLiteFoundationError('receipt_chain_malformed', 'The predecessor receipt-kind sequence is invalid.');
    }
    const prior = rows[index - 1];
    if (prior && row.source_fingerprint !== prior.result_fingerprint) {
      throw new SQLiteFoundationError('receipt_chain_malformed', 'Predecessor receipt fingerprints are not continuous.');
    }
    ids.add(row.migration_id);
  }
  const terminal = rows.at(-1);
  if (!terminal) throw new SQLiteFoundationError('receipt_chain_malformed', 'The predecessor terminal receipt is missing.');
  return terminal;
}

function lineageForSource(
  rows: readonly ReceiptRow[],
  applicationFingerprint: string,
  state: CompiledManifestState
): CompiledLineage | undefined {
  const validatedTerminal = validateSingleEpochPredecessorReceiptChain(rows);
  const digest = sourceDigest(rows);
  return state.lineages.find((lineage) => {
    return validatedTerminal.migration_id === lineage.sourceTerminal.migrationId &&
      validatedTerminal.schema_epoch === lineage.sourceTerminal.schemaEpoch &&
      validatedTerminal.sequence === lineage.sourceTerminal.sequence &&
      validatedTerminal.result_fingerprint === lineage.sourceApplicationFingerprint &&
      digest === lineage.sourceReceiptSetDigestSha256 &&
      applicationFingerprint === lineage.sourceApplicationFingerprint;
  });
}

function validateTransition(
  row: TransitionRow,
  lineage: CompiledLineage,
  baseline: CompiledEntry,
  runnerVersion: number
): void {
  const valid = row.id === lineage.transitionId && row.lineage_id === lineage.lineageId &&
    row.dialect === 'sqlite' && row.source_epoch === lineage.sourceTerminal.schemaEpoch &&
    row.source_sequence === lineage.sourceTerminal.sequence &&
    row.source_receipt_set_digest === lineage.sourceReceiptSetDigestSha256 &&
    row.source_fingerprint === lineage.sourceApplicationFingerprint &&
    row.destination_epoch === baseline.schemaEpoch && row.destination_migration_id === baseline.migrationId &&
    row.destination_baseline_checksum === baseline.artifact.checksumSha256 &&
    row.destination_fingerprint === baseline.expectedAfterApplicationFingerprint &&
    row.bridge_artifact_id === lineage.bridgeArtifactId &&
    row.bridge_artifact_checksum === lineage.bridgeArtifact.checksumSha256 &&
    row.atomicity === 'transactional' && row.verifier_set_digest === lineage.verifierSetDigestSha256 &&
    row.runner_version === runnerVersion && row.build_identity.length >= 1 && row.build_identity.length <= 120 &&
    Number.isSafeInteger(row.applied_at) && row.applied_at >= 0 &&
    Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0;
  if (!valid) throw new SQLiteFoundationError('receipt_chain_malformed', 'The epoch transition does not match its public lineage descriptor.');
}

function bridgedPrefix(
  receipts: readonly ReceiptRow[],
  transitions: readonly TransitionRow[],
  state: CompiledManifestState
): { readonly lineage: CompiledLineage; readonly sourceCount: number; readonly activeCount: number } | undefined {
  if (transitions.length !== 1) return undefined;
  const transition = transitions[0];
  if (!transition) return undefined;
  const lineage = state.lineages.find((candidate) => candidate.transitionId === transition.id);
  const baseline = state.migrations[0];
  if (!lineage || !baseline) return undefined;
  const sourceCount = receipts.findIndex((row) => row.migration_id === baseline.migrationId && row.schema_epoch === baseline.schemaEpoch);
  if (sourceCount <= 0) return undefined;
  const sourceRows = receipts.slice(0, sourceCount);
  const sourceTerminal = validateSingleEpochPredecessorReceiptChain(sourceRows);
  if (sourceDigest(sourceRows) !== lineage.sourceReceiptSetDigestSha256) return undefined;
  if (sourceTerminal.migration_id !== lineage.sourceTerminal.migrationId ||
    sourceTerminal.schema_epoch !== lineage.sourceTerminal.schemaEpoch ||
    sourceTerminal.sequence !== lineage.sourceTerminal.sequence ||
    sourceTerminal.result_fingerprint !== lineage.sourceApplicationFingerprint) return undefined;
  validateTransition(transition, lineage, baseline, state.input.runnerVersion);
  const activeRows = receipts.slice(sourceCount);
  if (activeRows.length > state.migrations.length) return undefined;
  for (let index = 0; index < activeRows.length; index += 1) {
    const row = activeRows[index];
    const entry = state.migrations[index];
    if (!row || !entry) return undefined;
    assertReceiptCommon(row, state.input.runnerVersion);
    const baselineRow = index === 0;
    if (row.migration_id !== entry.migrationId || row.schema_epoch !== entry.schemaEpoch ||
      row.sequence !== entry.sequence || row.checksum_sha256 !== entry.artifact.checksumSha256 ||
      row.source_fingerprint !== (baselineRow ? lineage.sourceApplicationFingerprint : entry.expectedBeforeApplicationFingerprint) ||
      row.result_fingerprint !== entry.expectedAfterApplicationFingerprint ||
      row.receipt_kind !== (baselineRow ? 'epoch_bridge' : 'executed') ||
      row.transition_id !== (baselineRow ? lineage.transitionId : null)) return undefined;
  }
  return { lineage, sourceCount, activeCount: activeRows.length };
}

function lockedActiveProgress(database: Database, state: CompiledManifestState): {
  readonly kind: 'fresh' | 'bridged';
  readonly count: number;
} {
  const receipts = receiptRows(database);
  const transitions = transitionRows(database);
  const active = transitions.length === 0 ? activeReceiptPrefix(receipts, state) : undefined;
  const bridged = active ? undefined : bridgedPrefix(receipts, transitions, state);
  const progress = active
    ? { kind: 'fresh' as const, count: active.count }
    : bridged
      ? { kind: 'bridged' as const, count: bridged.activeCount }
      : undefined;
  if (!progress) {
    throw new SQLiteFoundationError(
      'receipt_chain_malformed',
      'The migration chain changed before the runner acquired its write lock.'
    );
  }
  const expectedFingerprint = state.migrations[progress.count]?.expectedBeforeApplicationFingerprint
    ?? state.input.expectedCurrentApplicationFingerprint;
  assertFingerprint(
    'The locked migration prefix schema',
    fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application')),
    expectedFingerprint
  );
  return progress;
}

type LockedMigrationClassification =
  | { readonly kind: 'fresh'; readonly count: number }
  | { readonly kind: 'bridged'; readonly count: number }
  | { readonly kind: 'predecessor'; readonly lineage: CompiledLineage };

function classifyLockedMigrationState(
  database: Database,
  state: CompiledManifestState
): LockedMigrationClassification {
  const receipts = receiptRows(database);
  const transitions = transitionRows(database);
  const applicationFingerprint = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
  const active = transitions.length === 0 ? activeReceiptPrefix(receipts, state) : undefined;
  if (active) {
    const expectedFingerprint = state.migrations[active.count]?.expectedBeforeApplicationFingerprint
      ?? state.input.expectedCurrentApplicationFingerprint;
    assertFingerprint('The active receipt prefix schema', applicationFingerprint, expectedFingerprint);
    return { kind: 'fresh', count: active.count };
  }
  const bridged = bridgedPrefix(receipts, transitions, state);
  if (bridged) {
    const expectedFingerprint = state.migrations[bridged.activeCount]?.expectedBeforeApplicationFingerprint
      ?? state.input.expectedCurrentApplicationFingerprint;
    assertFingerprint('The bridged receipt prefix schema', applicationFingerprint, expectedFingerprint);
    return { kind: 'bridged', count: bridged.activeCount };
  }
  if (transitions.length === 0) {
    const lineage = lineageForSource(receipts, applicationFingerprint, state);
    if (lineage) return { kind: 'predecessor', lineage };
  }
  throw new SQLiteFoundationError(
    'receipt_chain_malformed',
    'The migration receipts, transition lineage, and live schema do not match this manifest.',
    { receiptCount: receipts.length, transitionCount: transitions.length, applicationFingerprint }
  );
}

function applyEntries(
  database: Database,
  state: CompiledManifestState,
  startIndex: number,
  fault?: (point: SQLiteTrialMigrationFaultPoint, migration: SQLiteTrialMigrationReference) => void
): number {
  let appliedCount = 0;
  for (let index = startIndex; index < state.migrations.length; index += 1) {
    const entry = state.migrations[index];
    if (!entry) continue;
    fault?.('before_migration_lock', entry);
    const startedAt = Date.now();
    const applied = immediateTransaction(database, () => {
      const progress = lockedActiveProgress(database, state);
      if (progress.count > index) return false;
      if (progress.count !== index) {
        throw new SQLiteFoundationError(
          'receipt_chain_malformed',
          'The locked migration prefix is not contiguous with the requested entry.'
        );
      }
      const runnerDataBefore = captureRunnerData(database);
      const before = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
      assertFingerprint(`Migration ${entry.migrationId} before-schema`, before, entry.expectedBeforeApplicationFingerprint);
      database.exec(entry.artifact.sql);
      if (!database.inTransaction) {
        throw new SQLiteFoundationError(
          'migration_transaction_failed',
          `Migration ${entry.migrationId} escaped the runner-owned transaction.`
        );
      }
      assertDisposableTrialTarget(database);
      assertRunner(database, state);
      const after = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
      assertFingerprint(`Migration ${entry.migrationId} after-schema`, after, entry.expectedAfterApplicationFingerprint);
      runVerifiers(database, state, entry.targetedVerifierIds, 'migration', entry);
      assertRunner(database, state);
      assertForeignKeyIntegrity(database);
      assertRunnerDataUnchanged(runnerDataBefore, captureRunnerData(database));
      fault?.('after_migration_schema_before_receipt', entry);
      insertMigrationReceipt(database, state, entry, 'executed', before, null, startedAt);
      const runnerDataAfter = captureRunnerData(database);
      assertArrayPrefix(runnerDataBefore.receipts, runnerDataAfter.receipts, 'migration receipt');
      if (runnerDataDigest(runnerDataBefore.transitions) !== runnerDataDigest(runnerDataAfter.transitions) ||
        runnerDataDigest(runnerDataBefore.metadata) !== runnerDataDigest(runnerDataAfter.metadata)) {
        throw new SQLiteFoundationError('receipt_chain_malformed', 'Appending a receipt changed another runner-owned family.');
      }
      const appendedReceipt = runnerDataAfter.receipts.at(-1);
      if (!appendedReceipt) throw new SQLiteFoundationError('receipt_chain_malformed', 'The appended receipt is missing.');
      validateExpectedReceipt(appendedReceipt, state, entry, 'executed', before, null);
      fault?.('after_migration_receipt_before_commit', entry);
      return true;
    });
    if (applied) {
      appliedCount += 1;
      fault?.('after_commit_before_return', entry);
    }
  }
  return appliedCount;
}

function bridgePredecessor(
  database: Database,
  state: CompiledManifestState,
  lineage: CompiledLineage,
  fault?: (point: SQLiteTrialMigrationFaultPoint, migration: SQLiteTrialMigrationReference) => void
): boolean {
  const baseline = state.migrations[0];
  if (!baseline) invalidManifest('The destination manifest has no baseline.');
  if (state.input.runnerVersion < lineage.minimumRunnerVersion) {
    throw new SQLiteFoundationError('migration_required', 'The runner is too old for the accepted predecessor lineage.');
  }
  fault?.('before_bridge_lock', baseline);
  const startedAt = Date.now();
  const bridged = immediateTransaction(database, () => {
    const runnerDataBefore = captureRunnerData(database);
    const sourceRows = receiptRows(database);
    const transitions = transitionRows(database);
    const existingBridge = bridgedPrefix(sourceRows, transitions, state);
    if (existingBridge) {
      const expectedFingerprint = state.migrations[existingBridge.activeCount]?.expectedBeforeApplicationFingerprint
        ?? state.input.expectedCurrentApplicationFingerprint;
      assertFingerprint(
        'The concurrently bridged application schema',
        fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application')),
        expectedFingerprint
      );
      return false;
    }
    if (transitions.length !== 0) {
      throw new SQLiteFoundationError(
        'receipt_chain_malformed',
        'The predecessor transition changed before the bridge acquired its write lock.'
      );
    }
    const sourceTerminal = validateSingleEpochPredecessorReceiptChain(sourceRows);
    const before = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
    if (sourceDigest(sourceRows) !== lineage.sourceReceiptSetDigestSha256 ||
      sourceTerminal.migration_id !== lineage.sourceTerminal.migrationId ||
      sourceTerminal.schema_epoch !== lineage.sourceTerminal.schemaEpoch ||
      sourceTerminal.sequence !== lineage.sourceTerminal.sequence ||
      sourceTerminal.result_fingerprint !== lineage.sourceApplicationFingerprint ||
      before !== lineage.sourceApplicationFingerprint) {
      throw new SQLiteFoundationError('receipt_chain_malformed', 'The predecessor changed before the bridge acquired its write lock.');
    }
    database.exec(lineage.bridgeArtifact.sql);
    if (!database.inTransaction) {
      throw new SQLiteFoundationError(
        'migration_transaction_failed',
        'The predecessor bridge escaped the runner-owned transaction.'
      );
    }
    assertDisposableTrialTarget(database);
    assertRunner(database, state);
    const after = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
    assertFingerprint('The bridged baseline schema', after, baseline.expectedAfterApplicationFingerprint);
    runVerifiers(database, state, lineage.targetedVerifierIds, 'epoch_bridge', baseline);
    assertRunner(database, state);
    assertForeignKeyIntegrity(database);
    assertRunnerDataUnchanged(runnerDataBefore, captureRunnerData(database));
    fault?.('after_bridge_schema_before_transition', baseline);
    database.query(`
      insert into main.schema_epoch_transitions
        (id, lineage_id, dialect, source_epoch, source_sequence,
         source_receipt_set_digest, source_fingerprint, destination_epoch,
         destination_migration_id, destination_baseline_checksum,
         destination_fingerprint, bridge_artifact_id, bridge_artifact_checksum,
         atomicity, verifier_set_digest, runner_version, build_identity,
         applied_at, duration_ms)
      values (?, ?, 'sqlite', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transactional', ?, ?,
              'migration-chain-trial', ?, ?)
    `).run(
      lineage.transitionId,
      lineage.lineageId,
      lineage.sourceTerminal.schemaEpoch,
      lineage.sourceTerminal.sequence,
      lineage.sourceReceiptSetDigestSha256,
      lineage.sourceApplicationFingerprint,
      baseline.schemaEpoch,
      baseline.migrationId,
      baseline.artifact.checksumSha256,
      baseline.expectedAfterApplicationFingerprint,
      lineage.bridgeArtifactId,
      lineage.bridgeArtifact.checksumSha256,
      lineage.verifierSetDigestSha256,
      state.input.runnerVersion,
      startedAt,
      Math.max(0, Date.now() - startedAt)
    );
    fault?.('after_bridge_transition_before_receipt', baseline);
    insertMigrationReceipt(
      database,
      state,
      baseline,
      'epoch_bridge',
      lineage.sourceApplicationFingerprint,
      lineage.transitionId,
      startedAt
    );
    assertForeignKeyIntegrity(database);
    const runnerDataAfter = captureRunnerData(database);
    assertArrayPrefix(runnerDataBefore.transitions, runnerDataAfter.transitions, 'epoch transition');
    assertArrayPrefix(runnerDataBefore.receipts, runnerDataAfter.receipts, 'migration receipt');
    if (runnerDataDigest(runnerDataBefore.metadata) !== runnerDataDigest(runnerDataAfter.metadata)) {
      throw new SQLiteFoundationError('receipt_chain_malformed', 'The epoch bridge changed database identity metadata.');
    }
    const transition = runnerDataAfter.transitions.at(-1);
    const receipt = runnerDataAfter.receipts.at(-1);
    if (!transition || !receipt) throw new SQLiteFoundationError('receipt_chain_malformed', 'The bridged receipt pair is incomplete.');
    validateTransition(transition, lineage, baseline, state.input.runnerVersion);
    validateExpectedReceipt(
      receipt,
      state,
      baseline,
      'epoch_bridge',
      lineage.sourceApplicationFingerprint,
      lineage.transitionId
    );
    return true;
  });
  if (bridged) fault?.('after_commit_before_return', baseline);
  return bridged;
}

function finalState(
  database: Database,
  state: CompiledManifestState,
  status: SQLiteTrialMigrationState['status']
): SQLiteTrialMigrationState {
  assertForeignKeyIntegrity(database);
  const applicationFingerprint = fingerprintSQLiteSchema(captureSQLiteSchema(database, 'application'));
  assertFingerprint('The terminal application schema', applicationFingerprint, state.input.expectedCurrentApplicationFingerprint);
  const full = captureSQLiteSchema(database, 'full');
  const fullFingerprint = fingerprintSQLiteSchema(full);
  if (fullFingerprint !== state.input.expectedCurrentFullFingerprint) {
    throw schemaMismatch('The terminal full schema does not match the manifest.', state.currentSnapshot, full);
  }
  const meta = metadata(database);
  const last = state.migrations.at(-1);
  if (!last) invalidManifest('The manifest terminal migration is missing.');
  return Object.freeze({
    status,
    coordinate: Object.freeze({ schemaEpoch: last.schemaEpoch, sequence: last.sequence }),
    migrationId: last.migrationId,
    databaseId: meta.database_id,
    databaseClass: 'ephemeral',
    applicationFingerprint,
    fullFingerprint,
    receiptCount: receiptRows(database).length
  });
}

export function runSQLiteTrialMigrationChain(input: {
  readonly database: Database;
  readonly manifest: CompiledSQLiteTrialMigrationManifest;
  readonly fault?: (point: SQLiteTrialMigrationFaultPoint, migration: SQLiteTrialMigrationReference) => void;
}): SQLiteTrialMigrationState {
  const state = openManifest(input.manifest);
  if (input.database.inTransaction) {
    invalidManifest('The migration runner must own the outer SQLite transaction.');
  }
  assertDisposableTrialTarget(input.database);
  input.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const foreignKeys = input.database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys;
  const busyTimeout = input.database.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout;
  if (foreignKeys !== 1 || busyTimeout !== 5000) {
    throw new SQLiteFoundationError(
      'foreign_keys_unavailable',
      'The migration runner could not establish its required SQLite connection policy.',
      { foreignKeys, busyTimeout }
    );
  }
  const firstMigration = state.migrations[0];
  if (!firstMigration) invalidManifest('The manifest has no baseline migration.');
  input.fault?.('before_runner_lock', firstMigration);
  const created = ensureRunner(input.database, state);
  const classification = immediateTransaction(input.database, () =>
    classifyLockedMigrationState(input.database, state)
  );
  if (classification.kind === 'fresh') {
    const appliedCount = applyEntries(input.database, state, classification.count, input.fault);
    return finalState(input.database, state, created || appliedCount > 0 ? 'applied' : 'current');
  }
  if (classification.kind === 'bridged') {
    const appliedCount = applyEntries(input.database, state, classification.count, input.fault);
    return finalState(input.database, state, appliedCount > 0 ? 'bridged' : 'current');
  }
  const bridgeApplied = bridgePredecessor(input.database, state, classification.lineage, input.fault);
  const appliedCount = applyEntries(input.database, state, 1, input.fault);
  return finalState(input.database, state, bridgeApplied || appliedCount > 0 ? 'bridged' : 'current');
}
