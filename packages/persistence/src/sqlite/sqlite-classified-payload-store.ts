import type { Database } from 'bun:sqlite';
import {
  ImmutableClassifiedPayloadRecordCodec,
  parseImmutableClassifiedPayloadRecord,
  type ImmutableClassifiedPayloadRecord,
  type ImmutableClassifiedPayloadRecordRow
} from '@jooevents/application/immutable-classified-payload-record';
import {
  SynchronousClassifiedPayloadStoreError,
  type SynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadNonceSource,
  type SynchronousClassifiedPayloadPutInput,
  type SynchronousClassifiedPayloadPutResult,
  type SynchronousClassifiedPayloadReadInput,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import type { PayloadRefId } from '@jooevents/kernel';

const maximumNonceAttempts = 8;

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
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
  readonly encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly retainedEncryptionProfiles?: readonly SynchronousClassifiedPayloadEncryptionProfile[];
  /** Test-only injection; ordinary composition uses the cryptographic default. */
  readonly nonceSource?: SynchronousClassifiedPayloadNonceSource;
}

export class SQLiteClassifiedPayloadStore implements SynchronousClassifiedPayloadStore {
  readonly #codec: ImmutableClassifiedPayloadRecordCodec;

  constructor(
    private readonly sqlite: Database,
    options: SQLiteClassifiedPayloadStoreOptions
  ) {
    this.#codec = new ImmutableClassifiedPayloadRecordCodec(options);
  }

  #readRow(payloadRefId: PayloadRefId): ImmutableClassifiedPayloadRecord | undefined {
    let rows: ImmutableClassifiedPayloadRecordRow[];
    try {
      rows = this.sqlite.query<ImmutableClassifiedPayloadRecordRow, [string]>(
        READ_PAYLOAD_SQL
      ).all(payloadRefId);
    } catch {
      throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
    }
    if (rows.length > 1) throw new SynchronousClassifiedPayloadStoreError('payload_corrupt');
    return rows[0] === undefined ? undefined : parseImmutableClassifiedPayloadRecord(rows[0]);
  }

  put(input: SynchronousClassifiedPayloadPutInput): SynchronousClassifiedPayloadPutResult {
    if (!this.sqlite.inTransaction) {
      throw new SynchronousClassifiedPayloadStoreError('transaction_required');
    }
    const probe = this.#codec.create(input);
    const existing = this.#readRow(probe.payloadRefId);
    if (existing !== undefined) return this.#codec.replay(existing, input);

    let record: ImmutableClassifiedPayloadRecord | undefined;
    for (let attempt = 0; attempt < maximumNonceAttempts; attempt += 1) {
      record = attempt === 0 ? probe : this.#codec.create(input);
      let existingNonce: unknown;
      try {
        existingNonce = this.sqlite.query<
          { readonly present: number },
          [string, number, Uint8Array]
        >(NONCE_EXISTS_SQL).get(
          record.encryptionProfile.key,
          record.encryptionProfile.version,
          record.nonce
        );
      } catch {
        throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
      }
      if (existingNonce === null) break;
      record = undefined;
    }
    if (record === undefined) throw new SynchronousClassifiedPayloadStoreError('nonce_unavailable');

    const profiles = record.descriptor.profiles;
    try {
      this.sqlite.query<never, [
        string, string, number, string, number, string, number, string, number,
        string, number, string, number, string, string, string, number, string,
        string, Uint8Array, Uint8Array, Uint8Array, number
      ]>(INSERT_PAYLOAD_SQL).run(
        record.payloadRefId,
        record.encryptionProfile.key,
        record.encryptionProfile.version,
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
        record.descriptor.scopeBinding,
        record.purpose,
        record.descriptor.contentType,
        record.descriptor.byteSize,
        record.descriptor.integrityDigest,
        record.authenticatedDataDigest,
        record.nonce,
        record.ciphertext,
        record.authenticationTag,
        Date.parse(record.createdAt)
      );
    } catch {
      const raced = this.#readRow(record.payloadRefId);
      if (raced !== undefined) {
        throw new SynchronousClassifiedPayloadStoreError('payload_ref_collision');
      }
      throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
    }
    return Object.freeze({ kind: 'inserted', payloadRef: { id: record.payloadRefId } });
  }

  read(input: SynchronousClassifiedPayloadReadInput): Uint8Array {
    const row = this.#readRow(input.payloadRef.id);
    if (row === undefined) throw new SynchronousClassifiedPayloadStoreError('payload_not_found');
    return this.#codec.read(row, input);
  }
}
