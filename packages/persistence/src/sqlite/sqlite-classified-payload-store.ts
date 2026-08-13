import type { Database } from 'bun:sqlite';
import {
  SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO,
  SynchronousClassifiedPayloadStoreError,
  assertSynchronousClassifiedPayloadEncryptionProfile,
  normalizeSynchronousClassifiedPayloadCreatedAt,
  normalizeSynchronousClassifiedPayloadRef,
  openSynchronousClassifiedPayload,
  sameSynchronousClassifiedPayloadVerifier,
  sealSynchronousClassifiedPayload,
  synchronousClassifiedPayloadEncryptionProfileReference,
  type SynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadNonceSource,
  type SynchronousClassifiedPayloadPutInput,
  type SynchronousClassifiedPayloadPutResult,
  type SynchronousClassifiedPayloadReadInput,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfileKind,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import {
  createPayloadRef,
  encodeCanonicalJson,
  parseInstant,
  parsePayloadRefId,
  type Instant,
  type PayloadRefId
} from '@jooevents/kernel';
import { createHash } from 'node:crypto';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const canonicalContentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const maximumNonceAttempts = 8;

/** Additive schema for explicitly ephemeral SQLite compositions only. */
export const SQLITE_CLASSIFIED_PAYLOAD_STORE_SQL = `
CREATE TABLE classified_payload_records (
  payload_ref_id TEXT PRIMARY KEY
    CHECK(length(payload_ref_id) = 36 AND payload_ref_id = lower(payload_ref_id)),
  record_schema_version INTEGER NOT NULL CHECK(record_schema_version = 1),
  encryption_profile_key TEXT NOT NULL
    CHECK(length(encryption_profile_key) BETWEEN 1 AND 160
      AND encryption_profile_key = lower(encryption_profile_key)
      AND encryption_profile_key = trim(encryption_profile_key)),
  encryption_profile_version INTEGER NOT NULL CHECK(encryption_profile_version > 0),
  classification_profile_key TEXT NOT NULL
    CHECK(length(classification_profile_key) BETWEEN 1 AND 160
      AND classification_profile_key = lower(classification_profile_key)
      AND classification_profile_key = trim(classification_profile_key)),
  classification_profile_version INTEGER NOT NULL CHECK(classification_profile_version > 0),
  schema_profile_key TEXT NOT NULL
    CHECK(length(schema_profile_key) BETWEEN 1 AND 160
      AND schema_profile_key = lower(schema_profile_key)
      AND schema_profile_key = trim(schema_profile_key)),
  schema_profile_version INTEGER NOT NULL CHECK(schema_profile_version > 0),
  content_profile_key TEXT NOT NULL
    CHECK(length(content_profile_key) BETWEEN 1 AND 160
      AND content_profile_key = lower(content_profile_key)
      AND content_profile_key = trim(content_profile_key)),
  content_profile_version INTEGER NOT NULL CHECK(content_profile_version > 0),
  integrity_profile_key TEXT NOT NULL CHECK(integrity_profile_key = 'integrity.sha256'),
  integrity_profile_version INTEGER NOT NULL CHECK(integrity_profile_version = 1),
  descriptor_auth_profile_key TEXT NOT NULL
    CHECK(length(descriptor_auth_profile_key) BETWEEN 1 AND 160
      AND descriptor_auth_profile_key = lower(descriptor_auth_profile_key)
      AND descriptor_auth_profile_key = trim(descriptor_auth_profile_key)),
  descriptor_auth_profile_version INTEGER NOT NULL CHECK(descriptor_auth_profile_version > 0),
  scope_binding TEXT NOT NULL CHECK(length(scope_binding) BETWEEN 1 AND 256),
  purpose TEXT NOT NULL
    CHECK(length(purpose) BETWEEN 1 AND 160 AND purpose = lower(purpose) AND purpose = trim(purpose)),
  content_type TEXT NOT NULL
    CHECK(length(content_type) BETWEEN 3 AND 191 AND content_type = lower(content_type)
      AND content_type = trim(content_type)),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  integrity_digest_sha256 TEXT NOT NULL
    CHECK(length(integrity_digest_sha256) = 64
      AND integrity_digest_sha256 = lower(integrity_digest_sha256)),
  authenticated_data_digest_sha256 TEXT NOT NULL
    CHECK(length(authenticated_data_digest_sha256) = 64
      AND authenticated_data_digest_sha256 = lower(authenticated_data_digest_sha256)),
  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK(length(ciphertext) = byte_size),
  authentication_tag BLOB NOT NULL CHECK(length(authentication_tag) = 16),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE (encryption_profile_key, encryption_profile_version, nonce)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER classified_payload_records_reject_update
BEFORE UPDATE ON classified_payload_records
BEGIN
  SELECT RAISE(ABORT, 'classified payload records are immutable');
END;

CREATE TRIGGER classified_payload_records_reject_delete
BEFORE DELETE ON classified_payload_records
BEGIN
  SELECT RAISE(ABORT, 'classified payload records are immutable');
END;
`;

export function installSQLiteClassifiedPayloadStoreSchema(sqlite: Database): void {
  if (sqlite.inTransaction) {
    throw new SynchronousClassifiedPayloadStoreError('transaction_required');
  }
  try {
    sqlite.exec(SQLITE_CLASSIFIED_PAYLOAD_STORE_SQL);
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
  }
}

interface NormalizedDescriptor {
  readonly profiles: ClassifiedPayloadProfiles;
  readonly scopeBinding: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly integrityDigest: string;
}
type NormalizedBinding = Pick<NormalizedDescriptor, 'profiles' | 'scopeBinding' | 'contentType'>;

interface PayloadRow {
  readonly payload_ref_id: unknown;
  readonly record_schema_version: unknown;
  readonly encryption_profile_key: unknown;
  readonly encryption_profile_version: unknown;
  readonly classification_profile_key: unknown;
  readonly classification_profile_version: unknown;
  readonly schema_profile_key: unknown;
  readonly schema_profile_version: unknown;
  readonly content_profile_key: unknown;
  readonly content_profile_version: unknown;
  readonly integrity_profile_key: unknown;
  readonly integrity_profile_version: unknown;
  readonly descriptor_auth_profile_key: unknown;
  readonly descriptor_auth_profile_version: unknown;
  readonly scope_binding: unknown;
  readonly purpose: unknown;
  readonly content_type: unknown;
  readonly byte_size: unknown;
  readonly integrity_digest_sha256: unknown;
  readonly authenticated_data_digest_sha256: unknown;
  readonly nonce: unknown;
  readonly ciphertext: unknown;
  readonly authentication_tag: unknown;
  readonly created_at_ms: unknown;
}

interface CanonicalRow {
  readonly payloadRefId: PayloadRefId;
  readonly encryptionProfile: { readonly key: string; readonly version: number };
  readonly descriptor: NormalizedDescriptor;
  readonly purpose: string;
  readonly authenticatedDataDigest: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authenticationTag: Uint8Array;
  readonly createdAt: Instant;
}

function invalidInput(): never {
  throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
}

function corrupt(): never {
  throw new SynchronousClassifiedPayloadStoreError('payload_corrupt');
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function canonicalText(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
      || value.normalize('NFC') !== value || value.includes('\0')
      || (pattern !== undefined && !pattern.test(value))) invalidInput();
  return value;
}

function profile<Kind extends ClassifiedPayloadProfileKind>(
  value: unknown,
  kind: Kind
): ClassifiedPayloadProfileRef<Kind> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, ['kind', 'key', 'version'])) invalidInput();
  const candidate = value as { readonly kind?: unknown; readonly key?: unknown; readonly version?: unknown };
  if (candidate.kind !== kind || typeof candidate.version !== 'number'
      || !Number.isSafeInteger(candidate.version) || candidate.version <= 0) invalidInput();
  const key = canonicalText(candidate.key, 160, stableKeyPattern);
  try {
    return createClassifiedPayloadProfileRef(kind, key, candidate.version);
  } catch {
    return invalidInput();
  }
}

function descriptor(value: unknown): NormalizedDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, ['profiles', 'scopeBinding', 'contentType', 'byteSize', 'integrityDigest'])) {
    invalidInput();
  }
  const candidate = value as {
    readonly profiles?: unknown;
    readonly scopeBinding?: unknown;
    readonly contentType?: unknown;
    readonly byteSize?: unknown;
    readonly integrityDigest?: unknown;
  };
  if (!candidate.profiles || typeof candidate.profiles !== 'object' || Array.isArray(candidate.profiles)
      || !exactKeys(candidate.profiles, [
        'classification', 'schema', 'content', 'integrity', 'descriptorAuth'
      ])) invalidInput();
  const profilesCandidate = candidate.profiles as Record<string, unknown>;
  const profiles: ClassifiedPayloadProfiles = Object.freeze({
    classification: profile(profilesCandidate.classification, 'classification'),
    schema: profile(profilesCandidate.schema, 'schema'),
    content: profile(profilesCandidate.content, 'content'),
    integrity: profile(profilesCandidate.integrity, 'integrity'),
    descriptorAuth: profile(profilesCandidate.descriptorAuth, 'descriptor_auth')
  });
  if (profiles.integrity.key !== 'integrity.sha256' || Number(profiles.integrity.version) !== 1) {
    invalidInput();
  }
  if (typeof candidate.byteSize !== 'number' || !Number.isSafeInteger(candidate.byteSize)
      || candidate.byteSize < 0) invalidInput();
  const integrityDigest = canonicalText(candidate.integrityDigest, 64, sha256Pattern);
  const scopeBinding = canonicalText(candidate.scopeBinding, 256);
  const contentType = canonicalText(candidate.contentType, 191, canonicalContentTypePattern);
  return Object.freeze({ profiles, scopeBinding, contentType, byteSize: candidate.byteSize, integrityDigest });
}

function binding(value: unknown): NormalizedBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, ['profiles', 'scopeBinding', 'contentType'])) invalidInput();
  const candidate = value as {
    readonly profiles?: unknown;
    readonly scopeBinding?: unknown;
    readonly contentType?: unknown;
  };
  return descriptor({
    profiles: candidate.profiles,
    scopeBinding: candidate.scopeBinding,
    contentType: candidate.contentType,
    byteSize: 0,
    integrityDigest: '0'.repeat(64)
  });
}

function normalizedPurpose(value: unknown): string {
  return canonicalText(value, 160, stableKeyPattern);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hexBytes(value: string): Uint8Array {
  if (!sha256Pattern.test(value)) corrupt();
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function sameDigest(left: string, right: string): boolean {
  return sameSynchronousClassifiedPayloadVerifier(hexBytes(left), hexBytes(right));
}

function bindingValue(input: {
  readonly payloadRefId: PayloadRefId;
  readonly encryptionProfile: { readonly key: string; readonly version: number };
  readonly descriptor: NormalizedDescriptor;
  readonly purpose: string;
  readonly createdAt: Instant;
}): object {
  const { profiles } = input.descriptor;
  return {
    format: 'jooevents.sqlite-classified-payload',
    version: 1,
    payloadRefId: input.payloadRefId,
    encryptionProfile: input.encryptionProfile,
    classificationProfile: profiles.classification,
    schemaProfile: profiles.schema,
    contentProfile: profiles.content,
    integrityProfile: profiles.integrity,
    descriptorAuthenticationProfile: profiles.descriptorAuth,
    scopeBinding: input.descriptor.scopeBinding,
    purpose: input.purpose,
    contentType: input.descriptor.contentType,
    byteSize: input.descriptor.byteSize,
    integrityDigestSha256: input.descriptor.integrityDigest,
    createdAt: input.createdAt
  };
}

function authenticatedData(input: Parameters<typeof bindingValue>[0]): Uint8Array {
  try {
    return encodeCanonicalJson(bindingValue(input));
  } catch {
    return invalidInput();
  }
}

function sameProfile(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameDescriptor(left: NormalizedDescriptor, right: NormalizedDescriptor): boolean {
  return left.scopeBinding === right.scopeBinding
    && left.contentType === right.contentType
    && left.byteSize === right.byteSize
    && sameDigest(left.integrityDigest, right.integrityDigest)
    && sameProfile(left.profiles.classification, right.profiles.classification)
    && sameProfile(left.profiles.schema, right.profiles.schema)
    && sameProfile(left.profiles.content, right.profiles.content)
    && sameProfile(left.profiles.integrity, right.profiles.integrity)
    && sameProfile(left.profiles.descriptorAuth, right.profiles.descriptorAuth);
}

function sameBinding(left: NormalizedBinding, right: NormalizedBinding): boolean {
  return left.scopeBinding === right.scopeBinding
    && left.contentType === right.contentType
    && sameProfile(left.profiles.classification, right.profiles.classification)
    && sameProfile(left.profiles.schema, right.profiles.schema)
    && sameProfile(left.profiles.content, right.profiles.content)
    && sameProfile(left.profiles.integrity, right.profiles.integrity)
    && sameProfile(left.profiles.descriptorAuth, right.profiles.descriptorAuth);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) corrupt();
  return value;
}

function rowText(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string') corrupt();
  try {
    return canonicalText(value, maximum, pattern);
  } catch {
    return corrupt();
  }
}

function rowProfile<Kind extends ClassifiedPayloadProfileKind>(
  keyValue: unknown,
  versionValue: unknown,
  kind: Kind
): ClassifiedPayloadProfileRef<Kind> {
  const key = rowText(keyValue, 160, stableKeyPattern);
  const version = integer(versionValue);
  if (version <= 0) corrupt();
  try {
    return createClassifiedPayloadProfileRef(kind, key, version);
  } catch {
    return corrupt();
  }
}

function blob(value: unknown, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) corrupt();
  return Uint8Array.from(value);
}

function parseRow(row: PayloadRow): CanonicalRow {
  let payloadRefId: PayloadRefId;
  try {
    payloadRefId = parsePayloadRefId(row.payload_ref_id);
  } catch {
    return corrupt();
  }
  if (integer(row.record_schema_version) !== 1) corrupt();
  const encryptionProfile = Object.freeze({
    key: rowText(row.encryption_profile_key, 160, stableKeyPattern),
    version: integer(row.encryption_profile_version)
  });
  if (encryptionProfile.version <= 0) corrupt();
  const profiles: ClassifiedPayloadProfiles = Object.freeze({
    classification: rowProfile(
      row.classification_profile_key,
      row.classification_profile_version,
      'classification'
    ),
    schema: rowProfile(row.schema_profile_key, row.schema_profile_version, 'schema'),
    content: rowProfile(row.content_profile_key, row.content_profile_version, 'content'),
    integrity: rowProfile(row.integrity_profile_key, row.integrity_profile_version, 'integrity'),
    descriptorAuth: rowProfile(
      row.descriptor_auth_profile_key,
      row.descriptor_auth_profile_version,
      'descriptor_auth'
    )
  });
  if (profiles.integrity.key !== 'integrity.sha256' || Number(profiles.integrity.version) !== 1) corrupt();
  const byteSize = integer(row.byte_size);
  if (byteSize < 0) corrupt();
  const descriptorValue: NormalizedDescriptor = Object.freeze({
    profiles,
    scopeBinding: rowText(row.scope_binding, 256),
    contentType: rowText(row.content_type, 191, canonicalContentTypePattern),
    byteSize,
    integrityDigest: rowText(row.integrity_digest_sha256, 64, sha256Pattern)
  });
  const purpose = rowText(row.purpose, 160, stableKeyPattern);
  const authenticatedDataDigest = rowText(
    row.authenticated_data_digest_sha256,
    64,
    sha256Pattern
  );
  const createdAtMs = integer(row.created_at_ms);
  let createdAt: Instant;
  try {
    createdAt = parseInstant(new Date(createdAtMs).toISOString());
  } catch {
    return corrupt();
  }
  const nonce = blob(row.nonce, SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.nonceBytes);
  const ciphertext = blob(row.ciphertext, byteSize);
  const authenticationTag = blob(
    row.authentication_tag,
    SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.authenticationTagBytes
  );
  return Object.freeze({
    payloadRefId,
    encryptionProfile,
    descriptor: descriptorValue,
    purpose,
    authenticatedDataDigest,
    nonce,
    ciphertext,
    authenticationTag,
    createdAt
  });
}

const READ_PAYLOAD_SQL = `
SELECT payload_ref_id, record_schema_version,
       encryption_profile_key, encryption_profile_version,
       classification_profile_key, classification_profile_version,
       schema_profile_key, schema_profile_version,
       content_profile_key, content_profile_version,
       integrity_profile_key, integrity_profile_version,
       descriptor_auth_profile_key, descriptor_auth_profile_version,
       scope_binding, purpose, content_type, byte_size,
       integrity_digest_sha256, authenticated_data_digest_sha256,
       nonce, ciphertext, authentication_tag, created_at_ms
  FROM classified_payload_records
 WHERE payload_ref_id = ?
`;

const NONCE_EXISTS_SQL = `
SELECT 1 AS present
  FROM classified_payload_records
 WHERE encryption_profile_key = ?
   AND encryption_profile_version = ?
   AND nonce = ?
 LIMIT 1
`;

const INSERT_PAYLOAD_SQL = `
INSERT INTO classified_payload_records (
  payload_ref_id, record_schema_version,
  encryption_profile_key, encryption_profile_version,
  classification_profile_key, classification_profile_version,
  schema_profile_key, schema_profile_version,
  content_profile_key, content_profile_version,
  integrity_profile_key, integrity_profile_version,
  descriptor_auth_profile_key, descriptor_auth_profile_version,
  scope_binding, purpose, content_type, byte_size,
  integrity_digest_sha256, authenticated_data_digest_sha256,
  nonce, ciphertext, authentication_tag, created_at_ms
) VALUES (
  ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
`;

export interface SQLiteClassifiedPayloadStoreOptions {
  /** Active writer profile. */
  readonly encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  /** Older exact-profile readers retained for existing immutable records. */
  readonly retainedEncryptionProfiles?: readonly SynchronousClassifiedPayloadEncryptionProfile[];
  /** Test-only injection; ordinary composition uses the cryptographic default. */
  readonly nonceSource?: SynchronousClassifiedPayloadNonceSource;
}

export class SQLiteClassifiedPayloadStore implements SynchronousClassifiedPayloadStore {
  readonly #sqlite: Database;
  readonly #encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly #encryptionReference: { readonly key: string; readonly version: number };
  readonly #encryptionProfilesByReference: ReadonlyMap<
    string,
    SynchronousClassifiedPayloadEncryptionProfile
  >;
  readonly #nonceSource: SynchronousClassifiedPayloadNonceSource | undefined;

  constructor(sqlite: Database, options: SQLiteClassifiedPayloadStoreOptions) {
    assertSynchronousClassifiedPayloadEncryptionProfile(options.encryptionProfile);
    this.#sqlite = sqlite;
    this.#encryptionProfile = options.encryptionProfile;
    this.#encryptionReference = Object.freeze({
      ...synchronousClassifiedPayloadEncryptionProfileReference(options.encryptionProfile)
    });
    const profiles = [options.encryptionProfile, ...(options.retainedEncryptionProfiles ?? [])];
    const byReference = new Map<string, SynchronousClassifiedPayloadEncryptionProfile>();
    for (const profile of profiles) {
      assertSynchronousClassifiedPayloadEncryptionProfile(profile);
      const reference = synchronousClassifiedPayloadEncryptionProfileReference(profile);
      const identity = `${reference.key}\0${reference.version}`;
      if (byReference.has(identity)) {
        throw new SynchronousClassifiedPayloadStoreError('invalid_encryption_profile');
      }
      byReference.set(identity, profile);
    }
    this.#encryptionProfilesByReference = byReference;
    this.#nonceSource = options.nonceSource;
  }

  #openRow(row: CanonicalRow): Uint8Array {
    const profile = this.#encryptionProfilesByReference.get(
      `${row.encryptionProfile.key}\0${row.encryptionProfile.version}`
    );
    if (profile === undefined) {
      throw new SynchronousClassifiedPayloadStoreError('encryption_profile_unavailable');
    }
    const storedAad = authenticatedData({
      payloadRefId: row.payloadRefId,
      encryptionProfile: row.encryptionProfile,
      descriptor: row.descriptor,
      purpose: row.purpose,
      createdAt: row.createdAt
    });
    if (!sameDigest(sha256(storedAad), row.authenticatedDataDigest)) corrupt();
    const plaintext = openSynchronousClassifiedPayload({
      profile,
      encrypted: {
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authenticationTag: row.authenticationTag
      },
      authenticatedData: storedAad
    });
    if (plaintext.byteLength !== row.descriptor.byteSize
        || !sameDigest(sha256(plaintext), row.descriptor.integrityDigest)) corrupt();
    return plaintext;
  }

  #readRow(payloadRefId: PayloadRefId): CanonicalRow | undefined {
    let rows: PayloadRow[];
    try {
      rows = this.#sqlite.query<PayloadRow, [string]>(READ_PAYLOAD_SQL).all(payloadRefId);
    } catch {
      throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
    }
    if (rows.length > 1) corrupt();
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  }

  put(input: SynchronousClassifiedPayloadPutInput): SynchronousClassifiedPayloadPutResult {
    if (!this.#sqlite.inTransaction) {
      throw new SynchronousClassifiedPayloadStoreError('transaction_required');
    }
    let payloadRefId: PayloadRefId;
    try {
      payloadRefId = parsePayloadRefId(input.payloadRefId);
    } catch {
      return invalidInput();
    }
    const expectedBinding = binding(input.binding);
    const purpose = normalizedPurpose(input.purpose);
    const createdAt = normalizeSynchronousClassifiedPayloadCreatedAt(input.createdAt);
    if (!(input.bytes instanceof Uint8Array)) invalidInput();
    const actualDigest = sha256(input.bytes);
    const expectedDescriptor: NormalizedDescriptor = Object.freeze({
      ...expectedBinding,
      byteSize: input.bytes.byteLength,
      integrityDigest: actualDigest
    });

    const existing = this.#readRow(payloadRefId);
    if (existing !== undefined) {
      if (!sameDescriptor(existing.descriptor, expectedDescriptor)
          || existing.purpose !== purpose
          || existing.createdAt !== createdAt) {
        throw new SynchronousClassifiedPayloadStoreError('payload_ref_collision');
      }
      const existingBytes = this.#openRow(existing);
      if (!sameSynchronousClassifiedPayloadVerifier(existingBytes, input.bytes)) {
        throw new SynchronousClassifiedPayloadStoreError('payload_ref_collision');
      }
      return Object.freeze({ kind: 'replay', payloadRef: createPayloadRef(payloadRefId) });
    }

    const aad = authenticatedData({
      payloadRefId,
      encryptionProfile: this.#encryptionReference,
      descriptor: expectedDescriptor,
      purpose,
      createdAt
    });
    const aadDigest = sha256(aad);
    let encrypted: ReturnType<typeof sealSynchronousClassifiedPayload> | undefined;
    for (let attempt = 0; attempt < maximumNonceAttempts; attempt += 1) {
      encrypted = sealSynchronousClassifiedPayload({
        profile: this.#encryptionProfile,
        plaintext: input.bytes,
        authenticatedData: aad,
        ...(this.#nonceSource === undefined ? {} : { nonceSource: this.#nonceSource })
      });
      let existingNonce: unknown;
      try {
        existingNonce = this.#sqlite.query<{ readonly present: number }, [string, number, Uint8Array]>(
          NONCE_EXISTS_SQL
        ).get(this.#encryptionReference.key, this.#encryptionReference.version, encrypted.nonce);
      } catch {
        throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
      }
      if (existingNonce === null) break;
      encrypted = undefined;
    }
    if (encrypted === undefined) throw new SynchronousClassifiedPayloadStoreError('nonce_unavailable');

    const profiles = expectedDescriptor.profiles;
    try {
      this.#sqlite.query<never, [
        string, string, number, string, number, string, number, string, number,
        string, number, string, number, string, string, string, number, string,
        string, Uint8Array, Uint8Array, Uint8Array, number
      ]>(INSERT_PAYLOAD_SQL).run(
        payloadRefId,
        this.#encryptionReference.key,
        this.#encryptionReference.version,
        profiles.classification.key,
        Number(profiles.classification.version),
        profiles.schema.key,
        Number(profiles.schema.version),
        profiles.content.key,
        Number(profiles.content.version),
        profiles.integrity.key,
        Number(profiles.integrity.version),
        profiles.descriptorAuth.key,
        Number(profiles.descriptorAuth.version),
        expectedDescriptor.scopeBinding,
        purpose,
        expectedDescriptor.contentType,
        expectedDescriptor.byteSize,
        expectedDescriptor.integrityDigest,
        aadDigest,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authenticationTag,
        Date.parse(createdAt)
      );
    } catch {
      const raced = this.#readRow(payloadRefId);
      if (raced !== undefined) throw new SynchronousClassifiedPayloadStoreError('payload_ref_collision');
      throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
    }
    return Object.freeze({ kind: 'inserted', payloadRef: createPayloadRef(payloadRefId) });
  }

  read(input: SynchronousClassifiedPayloadReadInput): Uint8Array {
    const payloadRef = normalizeSynchronousClassifiedPayloadRef(input.payloadRef);
    const expectedBinding = binding(input.expectedBinding);
    const purpose = normalizedPurpose(input.purpose);
    const row = this.#readRow(payloadRef.id);
    if (row === undefined) throw new SynchronousClassifiedPayloadStoreError('payload_not_found');
    const plaintext = this.#openRow(row);

    if (!sameBinding(row.descriptor, expectedBinding)
        || row.purpose !== purpose) {
      throw new SynchronousClassifiedPayloadStoreError('payload_binding_mismatch');
    }
    return Uint8Array.from(plaintext);
  }
}
