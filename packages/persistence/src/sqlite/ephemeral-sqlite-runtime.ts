import type { Database } from 'bun:sqlite';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openSQLite, type OpenSQLiteResult, type SQLiteDatabase } from './database';
import { createEphemeralSQLiteFile } from './ephemeral-rebuild';
import { SQLiteFoundationError } from './foundation-errors';
import { listSQLiteOwners, sqliteCoordinationPaths } from './file-ownership';
import { decodeSQLiteArtifact, sha256Hex } from './migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import type { SQLiteMigrationState } from './migration-runner';
import {
  canonicalSchemaJson,
  captureSQLiteSchema,
  fingerprintSQLiteSchema,
  type SQLiteRelationSnapshot,
  type SQLiteSchemaSnapshot
} from './schema-snapshot';

const DIRECTORY_PREFIX = `jooevents-ephemeral-runtime-${process.pid}-`;
const DATABASE_NAME = 'runtime.sqlite';
const MARKER_SUFFIX = '.jooevents-ephemeral.json';
const ARTIFACT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const EXPECTED_ARTIFACT_KEYS = ['id', 'sql'] as const;
const MAX_SCHEMA_ARTIFACTS = 128;
const MAX_SCHEMA_ARTIFACT_BYTES = 4 * 1024 * 1024;

const CONNECTION_PROFILE_PRAGMAS = [
  'application_id',
  'auto_vacuum',
  'busy_timeout',
  'cache_size',
  'defer_foreign_keys',
  'encoding',
  'foreign_keys',
  'ignore_check_constraints',
  'journal_mode',
  'journal_size_limit',
  'legacy_alter_table',
  'locking_mode',
  'max_page_count',
  'mmap_size',
  'query_only',
  'read_uncommitted',
  'recursive_triggers',
  'secure_delete',
  'synchronous',
  'temp_store',
  'threads',
  'trusted_schema',
  'user_version',
  'wal_autocheckpoint',
  'writable_schema'
] as const;

type ConnectionProfilePragma = typeof CONNECTION_PROFILE_PRAGMAS[number];
type ConnectionProfileValue = number | string;
type SQLiteConnectionProfile = Readonly<Record<ConnectionProfilePragma, ConnectionProfileValue>>;

interface OwnedEntryIdentity {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly device: string;
  readonly inode: string;
  readonly uid: string;
  readonly mode: number;
  readonly requireSingleLink: boolean;
}

interface RuntimeLayout {
  readonly directory: OwnedEntryIdentity;
  readonly database: OwnedEntryIdentity;
  readonly marker: OwnedEntryIdentity;
  readonly owners: OwnedEntryIdentity;
  readonly markerBytes: Buffer;
}

interface InstallationGuard {
  readonly protectedSchema: SQLiteSchemaSnapshot;
  readonly protectedSchemaJson: string;
  readonly relationCountsJson: string;
  readonly runnerRowsJson: string;
  readonly connectionProfile: SQLiteConnectionProfile;
  readonly connectionProfileJson: string;
}

interface DatabaseListRow {
  readonly seq: number;
  readonly name: string;
  readonly file: string;
}

interface CompiledSchemaArtifact {
  readonly id: string;
  readonly checksumSha256: string;
  readonly sql: string;
}

export interface EphemeralSQLiteSchemaArtifact {
  /** Stable diagnostic identity. Array position is the installation order. */
  readonly id: string;
  /** Additive, schema-only SQLite SQL. Runtime code computes and reports its digest. */
  readonly sql: string;
}

export interface InstalledEphemeralSQLiteSchemaArtifact {
  readonly id: string;
  readonly checksumSha256: string;
}

export interface EphemeralSQLiteCloseResult {
  readonly kind: 'closed_private_tree_retained';
  readonly directoryPath: string;
}

export interface EphemeralSQLiteRuntime {
  readonly kind: 'ephemeral_sqlite';
  readonly directoryPath: string;
  readonly databasePath: string;
  readonly sqlite: Database;
  readonly db: SQLiteDatabase;
  /** The retained migration chain applied before additive runtime schema artifacts. */
  readonly retainedBaseline: SQLiteMigrationState;
  readonly installedSchemaArtifacts: readonly InstalledEphemeralSQLiteSchemaArtifact[];
  /** Fingerprint of the complete schema after every additive artifact is installed. */
  readonly runtimeSchemaFingerprint: string;
  /** Digest binding ordered artifact identities/checksums to the resulting full schema. */
  readonly schemaOverlayDigestSha256: string;
  /**
   * Closes the database and lifetime owner. The private OS-temporary tree remains
   * because this API has no descriptor-relative deletion primitive.
   */
  close(): EphemeralSQLiteCloseResult;
}

function unsafe(message: string, details: Readonly<Record<string, unknown>> = {}): SQLiteFoundationError {
  return new SQLiteFoundationError('database_path_unsafe', message, details);
}

function assertSupportedPlatform(): void {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || typeof process.getuid !== 'function') {
    throw new SQLiteFoundationError(
      'platform_unsupported',
      'The ephemeral SQLite runtime requires POSIX ownership and mode semantics.',
      { platform: process.platform }
    );
  }
}

function currentUid(): bigint {
  return BigInt(process.getuid!());
}

function captureOwnedEntry(
  path: string,
  kind: OwnedEntryIdentity['kind'],
  mode: number,
  requireSingleLink: boolean
): OwnedEntryIdentity {
  const stat = lstatSync(path, { bigint: true });
  const expectedKind = kind === 'file' ? stat.isFile() : stat.isDirectory();
  if (
    !expectedKind || stat.isSymbolicLink() || stat.uid !== currentUid() ||
    Number(stat.mode & 0o777n) !== mode || (requireSingleLink && stat.nlink !== 1n) ||
    realpathSync(path) !== path
  ) {
    throw unsafe('An ephemeral SQLite runtime path failed its private ownership check.', { path, kind });
  }
  return {
    path,
    kind,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: stat.uid.toString(),
    mode,
    requireSingleLink
  };
}

function assertOwnedEntry(identity: OwnedEntryIdentity): void {
  const current = captureOwnedEntry(
    identity.path,
    identity.kind,
    identity.mode,
    identity.requireSingleLink
  );
  if (
    current.device !== identity.device || current.inode !== identity.inode ||
    current.uid !== identity.uid
  ) {
    throw unsafe('An ephemeral SQLite runtime path changed identity.', { path: identity.path });
  }
}

function exactKeys(value: object): readonly string[] {
  return Reflect.ownKeys(value).map((key) => typeof key === 'string' ? key : String(key)).sort();
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
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
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
      let identifier = '';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            identifier += quote;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        identifier += sql[index] ?? '';
        index += 1;
      }
      if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
        tokens.push(Object.freeze({ kind: 'word', value: identifier.toUpperCase() }));
      }
      continue;
    }
    if (current === '[') {
      let identifier = '';
      index += 1;
      while (index < sql.length && sql[index] !== ']') {
        identifier += sql[index] ?? '';
        index += 1;
      }
      index = Math.min(sql.length, index + 1);
      if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
        tokens.push(Object.freeze({ kind: 'word', value: identifier.toUpperCase() }));
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

function invalidSchemaArtifact(index: number, reason: string, keyword?: string): never {
  throw new TypeError(
    `ephemeral_sqlite_schema_artifact_sql_invalid:${index}:${reason}${keyword ? `:${keyword}` : ''}`
  );
}

function assertAllowedSchemaStatement(words: readonly string[], index: number): void {
  if (words.length === 0) return;
  const allowed = words[0] === 'CREATE' && (
    words[1] === 'TABLE' ||
    words[1] === 'INDEX' ||
    words[1] === 'TRIGGER' ||
    words[1] === 'VIEW' ||
    (words[1] === 'UNIQUE' && words[2] === 'INDEX')
  );
  if (!allowed) invalidSchemaArtifact(index, 'statement_not_additive_create', words[0]);
  if (words[1] === 'TABLE') {
    for (let wordIndex = 0; wordIndex < words.length - 1; wordIndex += 1) {
      if (
        words[wordIndex] === 'AS' &&
        ['SELECT', 'VALUES', 'WITH'].includes(words[wordIndex + 1] ?? '')
      ) {
        invalidSchemaArtifact(index, 'create_table_as_select_forbidden');
      }
    }
  }
}

function assertAdditiveSchemaSql(sql: string, index: number): void {
  const forbiddenWords = new Set([
    'ATTACH',
    'DETACH',
    'LOAD_EXTENSION',
    'PRAGMA',
    'READFILE',
    'REINDEX',
    'SQLITE_MASTER',
    'SQLITE_SCHEMA',
    'TEMP',
    'TEMPORARY',
    'VACUUM',
    'VIRTUAL',
    'WRITEFILE',
    'ALTER',
    'DROP'
  ]);
  const tokens = sqliteLexicalTokens(sql);
  if (tokens.length === 0) invalidSchemaArtifact(index, 'empty');
  let statementWords: string[] = [];
  let triggerDeclaration = false;
  let triggerBody = false;
  let triggerEndPending = false;
  let caseDepth = 0;
  let statementCount = 0;

  function finishStatement(): void {
    if (statementWords.length !== 0) {
      assertAllowedSchemaStatement(statementWords, index);
      statementCount += 1;
    }
    statementWords = [];
    triggerDeclaration = false;
    triggerBody = false;
    triggerEndPending = false;
    caseDepth = 0;
  }

  for (const token of tokens) {
    if (token.kind === 'semicolon') {
      if (!triggerBody || triggerEndPending) finishStatement();
      continue;
    }
    const word = token.value;
    if (triggerBody) {
      if (triggerEndPending) invalidSchemaArtifact(index, 'malformed_trigger');
      if (
        word === 'ATTACH' || word === 'DETACH' || word === 'LOAD_EXTENSION' ||
        word === 'PRAGMA' || word === 'READFILE' || word === 'REINDEX' ||
        word === 'VACUUM' || word === 'WRITEFILE' || word === 'ALTER' || word === 'DROP' ||
        word === 'INSERT' || word === 'REPLACE' || word === 'UPDATE' || word === 'DELETE'
      ) {
        invalidSchemaArtifact(index, 'forbidden_trigger_control', word);
      }
      if (word === 'CASE') caseDepth += 1;
      else if (word === 'END') {
        if (caseDepth > 0) caseDepth -= 1;
        else triggerEndPending = true;
      }
      continue;
    }
    if (forbiddenWords.has(word)) invalidSchemaArtifact(index, 'forbidden_control', word);
    statementWords.push(word);
    if (
      (statementWords[0] === 'CREATE' && statementWords[1] === 'TRIGGER') ||
      (statementWords[0] === 'CREATE' && statementWords[1] === 'TEMP' && statementWords[2] === 'TRIGGER') ||
      (statementWords[0] === 'CREATE' && statementWords[1] === 'TEMPORARY' && statementWords[2] === 'TRIGGER')
    ) {
      triggerDeclaration = true;
    }
    if (triggerDeclaration && word === 'BEGIN') triggerBody = true;
  }
  if (triggerBody && !triggerEndPending) invalidSchemaArtifact(index, 'unterminated_trigger');
  finishStatement();
  if (statementCount === 0) invalidSchemaArtifact(index, 'empty');
}

function compileSchemaSql(sql: string, index: number): CompiledSchemaArtifact['sql'] {
  const bytes = Buffer.from(sql, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_SCHEMA_ARTIFACT_BYTES) {
    throw new TypeError(`ephemeral_sqlite_schema_artifact_size_invalid:${index}`);
  }
  const decoded = decodeSQLiteArtifact(bytes);
  if (decoded !== sql) {
    throw new TypeError(`ephemeral_sqlite_schema_artifact_encoding_invalid:${index}`);
  }
  assertAdditiveSchemaSql(decoded, index);
  return decoded;
}

function normalizeSchemaArtifacts(value: unknown): readonly CompiledSchemaArtifact[] {
  if (!Array.isArray(value)) {
    throw new TypeError('ephemeral_sqlite_schema_artifacts_array_required');
  }
  if (value.length > MAX_SCHEMA_ARTIFACTS) {
    throw new TypeError('ephemeral_sqlite_schema_artifacts_limit_exceeded');
  }
  const seen = new Set<string>();
  const artifacts = value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError(`ephemeral_sqlite_schema_artifact_invalid:${index}`);
    }
    const keys = exactKeys(candidate);
    if (
      keys.length !== EXPECTED_ARTIFACT_KEYS.length ||
      keys.some((key, keyIndex) => key !== EXPECTED_ARTIFACT_KEYS[keyIndex])
    ) {
      throw new TypeError(`ephemeral_sqlite_schema_artifact_shape_invalid:${index}`);
    }
    const descriptor = candidate as Partial<EphemeralSQLiteSchemaArtifact>;
    if (
      typeof descriptor.id !== 'string' || descriptor.id.length > 80 || !ARTIFACT_ID.test(descriptor.id) ||
      typeof descriptor.sql !== 'string'
    ) {
      throw new TypeError(`ephemeral_sqlite_schema_artifact_invalid:${index}`);
    }
    if (seen.has(descriptor.id)) {
      throw new TypeError(`ephemeral_sqlite_schema_artifact_duplicate:${descriptor.id}`);
    }
    seen.add(descriptor.id);
    const sql = compileSchemaSql(descriptor.sql, index);
    return Object.freeze({ id: descriptor.id, checksumSha256: sha256Hex(Buffer.from(sql, 'utf8')), sql });
  });
  return Object.freeze(artifacts);
}

function assertEpochOne(state: SQLiteMigrationState): void {
  const migration = SQLITE_MIGRATION_MANIFEST.migrations[0];
  if (
    state.coordinate?.schemaEpoch !== migration.schemaEpoch ||
    state.coordinate.sequence !== migration.sequence ||
    state.migrationId !== migration.migrationId ||
    state.databaseClass !== 'ephemeral' ||
    typeof state.databaseId !== 'string' || !/^[0-9a-f]{32}$/.test(state.databaseId) ||
    state.schemaFingerprint !== SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
  ) {
    throw new SQLiteFoundationError(
      'schema_drift',
      'The ephemeral SQLite runtime did not open at the exact retained schema coordinate.'
    );
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function relationCounts(sqlite: Database, relations: readonly SQLiteRelationSnapshot[]): string {
  const counts = relations
    .filter((relation) => relation.kind === 'table')
    .map((relation) => ({
      name: relation.name,
      count: sqlite.query<{ count: number }, []>(
        `select count(*) as count from ${quoteIdentifier(relation.name)}`
      ).get()?.count ?? -1
    }));
  return canonicalJson(counts);
}

function pragmaValue(sqlite: Database, pragma: ConnectionProfilePragma): ConnectionProfileValue {
  const row = sqlite.query<Record<string, unknown>, []>(`PRAGMA ${pragma}`).get();
  const values = row ? Object.values(row) : [];
  if (values.length !== 1) {
    throw new SQLiteFoundationError('schema_drift', 'A required SQLite connection pragma is unavailable.', {
      pragma
    });
  }
  const value = values[0];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new SQLiteFoundationError('schema_drift', 'A required SQLite connection pragma returned an invalid value.', {
      pragma
    });
  }
  return value;
}

function captureConnectionProfile(sqlite: Database): SQLiteConnectionProfile {
  return Object.freeze(Object.fromEntries(
    CONNECTION_PROFILE_PRAGMAS.map((pragma) => [pragma, pragmaValue(sqlite, pragma)])
  ) as Record<ConnectionProfilePragma, ConnectionProfileValue>);
}

function assertRequiredConnectionProfile(profile: SQLiteConnectionProfile, artifactId: string): void {
  if (
    profile.foreign_keys !== 1 || profile.busy_timeout !== 5000 ||
    String(profile.journal_mode).toLowerCase() !== 'delete' ||
    String(profile.locking_mode).toLowerCase() !== 'normal' ||
    profile.query_only !== 0 || profile.ignore_check_constraints !== 0 ||
    profile.writable_schema !== 0 || profile.read_uncommitted !== 0 ||
    profile.defer_foreign_keys !== 0
  ) {
    throw new SQLiteFoundationError(
      'schema_drift',
      'An ephemeral SQLite schema artifact changed required connection safety settings.',
      { artifactId, connectionProfile: profile }
    );
  }
}

function assertDatabaseIntegrity(sqlite: Database, artifactId: string): void {
  const integrityRows = sqlite.query<Record<string, unknown>, []>('PRAGMA integrity_check').all();
  const integrityValue = integrityRows.length === 1 ? Object.values(integrityRows[0] ?? {})[0] : undefined;
  const foreignKeyViolations = sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all();
  if (integrityValue !== 'ok' || foreignKeyViolations.length !== 0) {
    throw new SQLiteFoundationError(
      'schema_drift',
      'An ephemeral SQLite schema artifact left the database inconsistent.',
      {
        artifactId,
        integrityResult: integrityValue ?? null,
        foreignKeyViolationCount: foreignKeyViolations.length
      }
    );
  }
}

function runnerRows(sqlite: Database): string {
  return canonicalJson({
    metadata: sqlite.query<Record<string, unknown>, []>(
      'select * from database_instance_metadata order by singleton_key'
    ).all(),
    migrations: sqlite.query<Record<string, unknown>, []>(
      'select * from schema_migrations order by schema_epoch, sequence, dialect'
    ).all(),
    transitions: sqlite.query<Record<string, unknown>, []>(
      'select * from schema_epoch_transitions order by destination_epoch, lineage_id, dialect'
    ).all()
  });
}

function captureInstallationGuard(sqlite: Database): InstallationGuard {
  const protectedSchema = captureSQLiteSchema(sqlite, 'full');
  const connectionProfile = captureConnectionProfile(sqlite);
  return {
    protectedSchema,
    protectedSchemaJson: canonicalSchemaJson(protectedSchema),
    relationCountsJson: relationCounts(sqlite, protectedSchema.relations),
    runnerRowsJson: runnerRows(sqlite),
    connectionProfile,
    connectionProfileJson: canonicalJson(connectionProfile)
  };
}

function protectedProjection(
  actual: SQLiteSchemaSnapshot,
  expected: SQLiteSchemaSnapshot
): SQLiteSchemaSnapshot {
  const expectedRelationNames = new Set(expected.relations.map((relation) => relation.name));
  const expectedTriggerNames = new Set(expected.triggers.map((trigger) => trigger.name));
  return {
    formatVersion: 1,
    dialect: 'sqlite',
    scope: 'full',
    relations: actual.relations.filter((relation) => expectedRelationNames.has(relation.name)),
    triggers: actual.triggers.filter((trigger) =>
      expectedTriggerNames.has(trigger.name) || expectedRelationNames.has(trigger.targetRelation)
    )
  };
}

function assertOnlyMainDatabase(sqlite: Database, databasePath: string): void {
  const databases = sqlite.query<DatabaseListRow, []>('PRAGMA database_list').all();
  const main = databases.find((database) => database.name === 'main');
  const attached = databases.filter((database) => database.name !== 'main' && database.name !== 'temp');
  const temp = databases.find((database) => database.name === 'temp');
  const tempObjectCount = temp
    ? sqlite.query<{ count: number }, []>(`
        select count(*) as count from temp.sqlite_schema where name not like 'sqlite_%'
      `).get()?.count ?? -1
    : 0;
  if (
    main?.seq !== 0 || main.file !== databasePath || attached.length !== 0 ||
    (temp !== undefined && (temp.file !== '' || tempObjectCount !== 0))
  ) {
    throw unsafe('An ephemeral SQLite schema artifact attached an unexpected database.');
  }
}

function assertAddedTablesEmpty(
  sqlite: Database,
  actual: SQLiteSchemaSnapshot,
  protectedSchema: SQLiteSchemaSnapshot,
  artifactId: string
): void {
  const protectedNames = new Set(protectedSchema.relations.map((relation) => relation.name));
  const populated = actual.relations
    .filter((relation) => relation.kind === 'table' && !protectedNames.has(relation.name))
    .map((relation) => ({
      name: relation.name,
      count: sqlite.query<{ count: number }, []>(
        `select count(*) as count from ${quoteIdentifier(relation.name)}`
      ).get()?.count ?? -1
    }))
    .filter((entry) => entry.count !== 0);
  if (populated.length !== 0) {
    throw new SQLiteFoundationError(
      'schema_drift',
      'Ephemeral SQLite schema artifacts may not install fixture or seed rows.',
      { artifactId, populated }
    );
  }
}

function assertInstallationGuard(
  sqlite: Database,
  databasePath: string,
  guard: InstallationGuard,
  artifactId: string
): void {
  assertOnlyMainDatabase(sqlite, databasePath);
  const connectionProfile = captureConnectionProfile(sqlite);
  assertRequiredConnectionProfile(connectionProfile, artifactId);
  if (canonicalJson(connectionProfile) !== guard.connectionProfileJson) {
    throw new SQLiteFoundationError(
      'schema_drift',
      'An ephemeral SQLite schema artifact changed the connection profile.',
      {
        artifactId,
        expectedConnectionProfile: guard.connectionProfile,
        actualConnectionProfile: connectionProfile
      }
    );
  }
  const actual = captureSQLiteSchema(sqlite, 'full');
  const protectedActual = protectedProjection(actual, guard.protectedSchema);
  if (
    canonicalSchemaJson(protectedActual) !== guard.protectedSchemaJson ||
    relationCounts(sqlite, guard.protectedSchema.relations) !== guard.relationCountsJson ||
    runnerRows(sqlite) !== guard.runnerRowsJson
  ) {
    throw new SQLiteFoundationError(
      'schema_drift',
      'An ephemeral SQLite schema artifact changed the retained schema coordinate or its records.',
      { artifactId }
    );
  }
  assertAddedTablesEmpty(sqlite, actual, guard.protectedSchema, artifactId);
  assertDatabaseIntegrity(sqlite, artifactId);
}

function parseMarker(markerBytes: Buffer, databasePath: string, databaseId: string): void {
  let value: unknown;
  try {
    value = JSON.parse(markerBytes.toString('utf8'));
  } catch {
    throw unsafe('The ephemeral SQLite marker is not valid JSON.');
  }
  const marker = value as Record<string, unknown>;
  if (
    marker.formatVersion !== 1 || marker.applicationKey !== 'jooevents' ||
    marker.canonicalDatabasePath !== databasePath || marker.databaseId !== databaseId ||
    typeof marker.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(marker.nonce)
  ) {
    throw unsafe('The ephemeral SQLite marker does not bind the exact runtime database.');
  }
}

function captureRuntimeLayout(
  directory: OwnedEntryIdentity,
  databasePath: string,
  databaseId: string
): RuntimeLayout {
  const markerPath = `${databasePath}${MARKER_SUFFIX}`;
  const ownersPath = sqliteCoordinationPaths(databasePath).owners;
  const database = captureOwnedEntry(databasePath, 'file', 0o600, true);
  const marker = captureOwnedEntry(markerPath, 'file', 0o600, true);
  const owners = captureOwnedEntry(ownersPath, 'directory', 0o700, false);
  const markerBytes = readFileSync(markerPath);
  parseMarker(markerBytes, databasePath, databaseId);
  const liveOwners = listSQLiteOwners(databasePath);
  const owner = liveOwners[0];
  if (
    liveOwners.length !== 1 || owner?.kind !== 'ordinary' || owner.databaseId !== databaseId ||
    owner.canonicalDatabasePath !== databasePath || owner.pid !== process.pid
  ) {
    throw unsafe('The ephemeral SQLite handle does not hold its exact lifetime owner.');
  }
  return { directory, database, marker, owners, markerBytes };
}

function expectedRootEntries(layout: RuntimeLayout): readonly string[] {
  return [basename(layout.database.path), basename(layout.marker.path), basename(layout.owners.path)].sort();
}

function assertExactRuntimeLayout(layout: RuntimeLayout, ownersMustBeEmpty: boolean): void {
  assertOwnedEntry(layout.directory);
  assertOwnedEntry(layout.database);
  assertOwnedEntry(layout.marker);
  assertOwnedEntry(layout.owners);
  const entries = readdirSync(layout.directory.path).sort();
  if (canonicalJson(entries) !== canonicalJson(expectedRootEntries(layout))) {
    throw unsafe('The ephemeral SQLite directory contains an unexpected entry.', { entries });
  }
  if (!readFileSync(layout.marker.path).equals(layout.markerBytes)) {
    throw unsafe('The ephemeral SQLite marker changed during the runtime lifetime.');
  }
  if (ownersMustBeEmpty && readdirSync(layout.owners.path).length !== 0) {
    throw unsafe('The ephemeral SQLite owner directory is not empty after close.');
  }
}

function closeFailedRuntime(
  opened: OpenSQLiteResult | undefined,
  layout: RuntimeLayout | undefined
): unknown | undefined {
  const errors: unknown[] = [];
  if (opened) {
    if (opened.sqlite.inTransaction) {
      try {
        opened.sqlite.exec('ROLLBACK;');
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      opened.sqlite.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (layout) {
    try {
      assertExactRuntimeLayout(layout, true);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return undefined;
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'Ephemeral SQLite failure close was incomplete.');
}

function installSchemaArtifact(
  sqlite: Database,
  databasePath: string,
  guard: InstallationGuard,
  artifact: CompiledSchemaArtifact
): void {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    sqlite.exec(artifact.sql);
    assertInstallationGuard(sqlite, databasePath, guard, artifact.id);
    sqlite.exec('COMMIT;');
    if (sqlite.inTransaction) {
      throw new SQLiteFoundationError(
        'migration_transaction_failed',
        'Ephemeral SQLite schema installation did not close its transaction.',
        { artifactId: artifact.id }
      );
    }
  } catch (error) {
    if (sqlite.inTransaction) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // The connection is closed and the private temporary tree retained by the caller.
      }
    }
    throw error;
  }
}

function freezeMigrationState(state: SQLiteMigrationState): SQLiteMigrationState {
  return Object.freeze({
    ...state,
    coordinate: state.coordinate ? Object.freeze({ ...state.coordinate }) : null
  });
}

/**
 * Creates one fresh marked SQLite file under an internally owned temporary
 * directory, opens it once, and installs additive schema artifacts in exact order.
 * No caller-supplied file path is accepted.
 */
export function createEphemeralSQLiteRuntime(
  schemaArtifactInput: readonly EphemeralSQLiteSchemaArtifact[]
): EphemeralSQLiteRuntime {
  // Validate every declarative artifact and platform prerequisite before filesystem state exists.
  const artifacts = normalizeSchemaArtifacts(schemaArtifactInput);
  assertSupportedPlatform();
  const temporaryRoot = realpathSync(tmpdir());
  const directoryPath = mkdtempSync(join(temporaryRoot, DIRECTORY_PREFIX));
  let directory: OwnedEntryIdentity;
  try {
    chmodSync(directoryPath, 0o700);
    directory = captureOwnedEntry(directoryPath, 'directory', 0o700, false);
    if (readdirSync(directoryPath).length !== 0) {
      throw unsafe('A newly created ephemeral SQLite directory was not empty.');
    }
  } catch (error) {
    // This API has no descriptor-relative delete primitive. Retain the private
    // process-created directory instead of making a pathname-based cleanup attempt.
    throw error;
  }

  const databasePath = join(directoryPath, DATABASE_NAME);
  let opened: OpenSQLiteResult | undefined;
  let layout: RuntimeLayout | undefined;
  try {
    const created = createEphemeralSQLiteFile(databasePath);
    assertEpochOne(created);
    chmodSync(databasePath, 0o600);
    opened = openSQLite(databasePath, {
      migrationPolicy: 'validate',
      databaseClass: 'ephemeral'
    });
    assertEpochOne(opened.migration);
    if (opened.migration.databaseId !== created.databaseId) {
      throw unsafe('The ephemeral SQLite identity changed between creation and open.');
    }
    layout = captureRuntimeLayout(directory, databasePath, created.databaseId!);
    const guard = captureInstallationGuard(opened.sqlite);
    assertInstallationGuard(opened.sqlite, databasePath, guard, 'runtime-baseline');

    for (const artifact of artifacts) {
      installSchemaArtifact(opened.sqlite, databasePath, guard, artifact);
      assertExactRuntimeLayout(layout, false);
    }

    const retainedBaseline = freezeMigrationState(opened.migration);
    const runtimeSchemaFingerprint = fingerprintSQLiteSchema(captureSQLiteSchema(opened.sqlite, 'full'));
    const installedSchemaArtifacts = Object.freeze(artifacts.map((artifact) => Object.freeze({
      id: artifact.id,
      checksumSha256: artifact.checksumSha256
    })));
    const schemaOverlayDigestSha256 = sha256Hex(canonicalJson({
      installedSchemaArtifacts,
      runtimeSchemaFingerprint
    }));
    if (!HEX_SHA256.test(runtimeSchemaFingerprint) || !HEX_SHA256.test(schemaOverlayDigestSha256)) {
      throw new SQLiteFoundationError('schema_drift', 'The ephemeral SQLite schema identity is malformed.');
    }
    const closeResult = Object.freeze({
      kind: 'closed_private_tree_retained' as const,
      directoryPath
    });
    let closeState: 'open' | 'closed' | 'failed' = 'open';
    let closeError: unknown;
    const close = (): EphemeralSQLiteCloseResult => {
      if (closeState === 'closed') return closeResult;
      if (closeState === 'failed') throw closeError;
      try {
        opened!.sqlite.close();
        assertExactRuntimeLayout(layout!, true);
        closeState = 'closed';
        return closeResult;
      } catch (error) {
        closeError = error instanceof SQLiteFoundationError
          ? error
          : unsafe('The ephemeral SQLite runtime could not be closed safely.', {
              cause: error instanceof Error ? error.message : String(error)
            });
        closeState = 'failed';
        throw closeError;
      }
    };
    return Object.freeze({
      kind: 'ephemeral_sqlite' as const,
      directoryPath,
      databasePath,
      sqlite: opened.sqlite,
      db: opened.db,
      retainedBaseline,
      installedSchemaArtifacts,
      runtimeSchemaFingerprint,
      schemaOverlayDigestSha256,
      close
    });
  } catch (error) {
    const closeError = closeFailedRuntime(opened, layout);
    if (closeError !== undefined) {
      throw new AggregateError([error, closeError], 'Ephemeral SQLite creation failed and close was incomplete.');
    }
    throw error;
  }
}
