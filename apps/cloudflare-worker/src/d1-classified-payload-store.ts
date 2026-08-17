import {
  ImmutableClassifiedPayloadRecordCodec,
  parseImmutableClassifiedPayloadRecord,
  type ImmutableClassifiedPayloadRecord,
  type ImmutableClassifiedPayloadRecordCodecOptions,
  type ImmutableClassifiedPayloadRecordRow
} from '@jooevents/application/immutable-classified-payload-record';
import {
  SynchronousClassifiedPayloadStoreError,
  normalizeSynchronousClassifiedPayloadRef,
  type SynchronousClassifiedPayloadPutInput,
  type SynchronousClassifiedPayloadPutResult,
  type SynchronousClassifiedPayloadReadInput,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import type { PayloadRefId } from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';

const READ_COLUMNS = `payload_ref_id,record_schema_version,
  encryption_profile_key,encryption_profile_version,
  classification_profile_key,classification_profile_version,
  schema_profile_key,schema_profile_version,
  content_profile_key,content_profile_version,
  integrity_profile_key,integrity_profile_version,
  descriptor_auth_profile_key,descriptor_auth_profile_version,
  scope_binding,purpose,content_type,byte_size,
  integrity_digest_sha256,authenticated_data_digest_sha256,
  nonce,ciphertext,authentication_tag,created_at_ms`;

const INSERT_SQL = `INSERT INTO classified_payload_records (
  payload_ref_id,record_schema_version,
  encryption_profile_key,encryption_profile_version,
  classification_profile_key,classification_profile_version,
  schema_profile_key,schema_profile_version,
  content_profile_key,content_profile_version,
  integrity_profile_key,integrity_profile_version,
  descriptor_auth_profile_key,descriptor_auth_profile_version,
  scope_binding,purpose,content_type,byte_size,
  integrity_digest_sha256,authenticated_data_digest_sha256,
  nonce,ciphertext,authentication_tag,created_at_ms
) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const READ_BATCH_SIZE = 50;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Loads exact immutable rows before entering a synchronous application ceremony. */
export async function readD1ClassifiedPayloadRecords(
  session: D1DatabaseSession,
  payloadRefIds: readonly PayloadRefId[]
): Promise<readonly ImmutableClassifiedPayloadRecord[]> {
  if (payloadRefIds.length === 0) return Object.freeze([]);
  const unique = [...new Set(payloadRefIds)];
  if (unique.length !== payloadRefIds.length) {
    throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
  }
  const records: ImmutableClassifiedPayloadRecord[] = [];
  try {
    for (let offset = 0; offset < unique.length; offset += READ_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + READ_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const rows = await session.prepare(`SELECT ${READ_COLUMNS}
        FROM classified_payload_records WHERE payload_ref_id IN (${placeholders})`)
        .bind(...batch).all<ImmutableClassifiedPayloadRecordRow>();
      records.push(...rows.results.map(parseImmutableClassifiedPayloadRecord));
    }
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
  }
  return Object.freeze(records);
}

export interface D1BufferedClassifiedPayloadStoreOptions
  extends ImmutableClassifiedPayloadRecordCodecOptions {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly preloadedRecords?: readonly ImmutableClassifiedPayloadRecord[];
}

/**
 * Synchronous classified-payload port backed by one guarded D1 batch attempt.
 * Newly sealed records remain readable in-memory for the required adoption
 * read-back, while ciphertext rows commit atomically with their owning domain.
 */
export class D1BufferedClassifiedPayloadStore implements SynchronousClassifiedPayloadStore {
  readonly #codec: ImmutableClassifiedPayloadRecordCodec;
  readonly #records = new Map<PayloadRefId, ImmutableClassifiedPayloadRecord>();
  readonly #nonces = new Set<string>();

  constructor(private readonly options: D1BufferedClassifiedPayloadStoreOptions) {
    this.#codec = new ImmutableClassifiedPayloadRecordCodec(options);
    for (const record of options.preloadedRecords ?? []) {
      if (this.#records.has(record.payloadRefId)) {
        throw new SynchronousClassifiedPayloadStoreError('payload_corrupt');
      }
      this.#records.set(record.payloadRefId, record);
      this.#nonces.add(this.#nonceIdentity(record));
    }
  }

  put(input: SynchronousClassifiedPayloadPutInput): SynchronousClassifiedPayloadPutResult {
    let record = this.#codec.create(input);
    const existing = this.#records.get(record.payloadRefId);
    if (existing !== undefined) return this.#codec.replay(existing, input);

    for (let attempt = 1; attempt < 8 && this.#nonces.has(this.#nonceIdentity(record)); attempt += 1) {
      record = this.#codec.create(input);
    }
    const nonceIdentity = this.#nonceIdentity(record);
    if (this.#nonces.has(nonceIdentity)) {
      throw new SynchronousClassifiedPayloadStoreError('nonce_unavailable');
    }

    const nonce = arrayBuffer(record.nonce);
    this.options.unitOfWork.assertCurrent(
      'NOT EXISTS (SELECT 1 FROM classified_payload_records WHERE payload_ref_id = ?)',
      [record.payloadRefId]
    );
    this.options.unitOfWork.assertCurrent(`NOT EXISTS (
      SELECT 1 FROM classified_payload_records
       WHERE encryption_profile_key = ? AND encryption_profile_version = ? AND nonce = ?
    )`, [record.encryptionProfile.key, record.encryptionProfile.version, nonce]);
    const profiles = record.descriptor.profiles;
    this.options.unitOfWork.write(INSERT_SQL, [
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
      nonce,
      arrayBuffer(record.ciphertext),
      arrayBuffer(record.authenticationTag),
      Date.parse(record.createdAt)
    ]);
    this.#records.set(record.payloadRefId, record);
    this.#nonces.add(nonceIdentity);
    return Object.freeze({ kind: 'inserted', payloadRef: { id: record.payloadRefId } });
  }

  read(input: SynchronousClassifiedPayloadReadInput): Uint8Array {
    const payloadRef = normalizeSynchronousClassifiedPayloadRef(input.payloadRef);
    const record = this.#records.get(payloadRef.id);
    if (record === undefined) {
      throw new SynchronousClassifiedPayloadStoreError('payload_not_found');
    }
    return this.#codec.read(record, input);
  }

  #nonceIdentity(record: ImmutableClassifiedPayloadRecord): string {
    let nonce = '';
    for (const byte of record.nonce) nonce += byte.toString(16).padStart(2, '0');
    return `${record.encryptionProfile.key}\0${record.encryptionProfile.version}\0${nonce}`;
  }
}
