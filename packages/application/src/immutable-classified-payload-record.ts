import {
  createPayloadRef,
  encodeCanonicalJson,
  parseInstant,
  parsePayloadRefId,
  type Instant,
  type PayloadRefId
} from '@jooevents/kernel';
import { createHash } from 'node:crypto';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfileKind,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from './classified-payloads';
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
  type SynchronousClassifiedPayloadReadInput
} from './synchronous-classified-payload-store';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const canonicalContentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

interface NormalizedDescriptor {
  readonly profiles: ClassifiedPayloadProfiles;
  readonly scopeBinding: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly integrityDigest: string;
}

type NormalizedBinding = Pick<NormalizedDescriptor, 'profiles' | 'scopeBinding' | 'contentType'>;

export interface ImmutableClassifiedPayloadRecordRow {
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

export interface ImmutableClassifiedPayloadRecord {
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
  return Object.freeze({
    profiles,
    scopeBinding: canonicalText(candidate.scopeBinding, 256),
    contentType: canonicalText(candidate.contentType, 191, canonicalContentTypePattern),
    byteSize: candidate.byteSize,
    integrityDigest: canonicalText(candidate.integrityDigest, 64, sha256Pattern)
  });
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

function authenticatedData(input: {
  readonly payloadRefId: PayloadRefId;
  readonly encryptionProfile: { readonly key: string; readonly version: number };
  readonly descriptor: NormalizedDescriptor;
  readonly purpose: string;
  readonly createdAt: Instant;
}): Uint8Array {
  const { profiles } = input.descriptor;
  try {
    return encodeCanonicalJson({
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
    });
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
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (Array.isArray(value) && value.every((item) =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 255
  )) bytes = Uint8Array.from(value as number[]);
  else corrupt();
  if (length !== undefined && bytes.byteLength !== length) corrupt();
  return Uint8Array.from(bytes);
}

export function parseImmutableClassifiedPayloadRecord(
  row: ImmutableClassifiedPayloadRecordRow
): ImmutableClassifiedPayloadRecord {
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
  const createdAtMs = integer(row.created_at_ms);
  let createdAt: Instant;
  try {
    createdAt = parseInstant(new Date(createdAtMs).toISOString());
  } catch {
    return corrupt();
  }
  return Object.freeze({
    payloadRefId,
    encryptionProfile,
    descriptor: Object.freeze({
      profiles,
      scopeBinding: rowText(row.scope_binding, 256),
      contentType: rowText(row.content_type, 191, canonicalContentTypePattern),
      byteSize,
      integrityDigest: rowText(row.integrity_digest_sha256, 64, sha256Pattern)
    }),
    purpose: rowText(row.purpose, 160, stableKeyPattern),
    authenticatedDataDigest: rowText(
      row.authenticated_data_digest_sha256,
      64,
      sha256Pattern
    ),
    nonce: blob(row.nonce, SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.nonceBytes),
    ciphertext: blob(row.ciphertext, byteSize),
    authenticationTag: blob(
      row.authentication_tag,
      SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.authenticationTagBytes
    ),
    createdAt
  });
}

export interface ImmutableClassifiedPayloadRecordCodecOptions {
  readonly encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly retainedEncryptionProfiles?: readonly SynchronousClassifiedPayloadEncryptionProfile[];
  readonly nonceSource?: SynchronousClassifiedPayloadNonceSource;
}

/** Runtime-neutral immutable-record contract shared by SQLite and D1 adapters. */
export class ImmutableClassifiedPayloadRecordCodec {
  readonly #encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly #encryptionReference: { readonly key: string; readonly version: number };
  readonly #profiles: ReadonlyMap<string, SynchronousClassifiedPayloadEncryptionProfile>;
  readonly #nonceSource: SynchronousClassifiedPayloadNonceSource | undefined;

  constructor(options: ImmutableClassifiedPayloadRecordCodecOptions) {
    assertSynchronousClassifiedPayloadEncryptionProfile(options.encryptionProfile);
    this.#encryptionProfile = options.encryptionProfile;
    this.#encryptionReference = Object.freeze({
      ...synchronousClassifiedPayloadEncryptionProfileReference(options.encryptionProfile)
    });
    const byReference = new Map<string, SynchronousClassifiedPayloadEncryptionProfile>();
    for (const candidate of [options.encryptionProfile, ...(options.retainedEncryptionProfiles ?? [])]) {
      assertSynchronousClassifiedPayloadEncryptionProfile(candidate);
      const reference = synchronousClassifiedPayloadEncryptionProfileReference(candidate);
      const identity = `${reference.key}\0${reference.version}`;
      if (byReference.has(identity)) {
        throw new SynchronousClassifiedPayloadStoreError('invalid_encryption_profile');
      }
      byReference.set(identity, candidate);
    }
    this.#profiles = byReference;
    this.#nonceSource = options.nonceSource;
  }

  create(input: SynchronousClassifiedPayloadPutInput): ImmutableClassifiedPayloadRecord {
    let payloadRefId: PayloadRefId;
    try {
      payloadRefId = parsePayloadRefId(input.payloadRefId);
    } catch {
      return invalidInput();
    }
    const normalizedBinding = binding(input.binding);
    const purpose = normalizedPurpose(input.purpose);
    const createdAt = normalizeSynchronousClassifiedPayloadCreatedAt(input.createdAt);
    if (!(input.bytes instanceof Uint8Array)) invalidInput();
    const recordDescriptor: NormalizedDescriptor = Object.freeze({
      ...normalizedBinding,
      byteSize: input.bytes.byteLength,
      integrityDigest: sha256(input.bytes)
    });
    const aad = authenticatedData({
      payloadRefId,
      encryptionProfile: this.#encryptionReference,
      descriptor: recordDescriptor,
      purpose,
      createdAt
    });
    const encrypted = sealSynchronousClassifiedPayload({
      profile: this.#encryptionProfile,
      plaintext: input.bytes,
      authenticatedData: aad,
      ...(this.#nonceSource === undefined ? {} : { nonceSource: this.#nonceSource })
    });
    return Object.freeze({
      payloadRefId,
      encryptionProfile: this.#encryptionReference,
      descriptor: recordDescriptor,
      purpose,
      authenticatedDataDigest: sha256(aad),
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      authenticationTag: encrypted.authenticationTag,
      createdAt
    });
  }

  replay(
    record: ImmutableClassifiedPayloadRecord,
    input: SynchronousClassifiedPayloadPutInput
  ): SynchronousClassifiedPayloadPutResult {
    const expected = this.#expected(input);
    if (record.payloadRefId !== expected.payloadRefId
        || !sameDescriptor(record.descriptor, expected.descriptor)
        || record.purpose !== expected.purpose
        || record.createdAt !== expected.createdAt
        || !sameSynchronousClassifiedPayloadVerifier(this.#open(record), input.bytes)) {
      throw new SynchronousClassifiedPayloadStoreError('payload_ref_collision');
    }
    return Object.freeze({ kind: 'replay', payloadRef: createPayloadRef(record.payloadRefId) });
  }

  read(
    record: ImmutableClassifiedPayloadRecord,
    input: SynchronousClassifiedPayloadReadInput
  ): Uint8Array {
    const payloadRef = normalizeSynchronousClassifiedPayloadRef(input.payloadRef);
    const expectedBinding = binding(input.expectedBinding);
    const purpose = normalizedPurpose(input.purpose);
    if (record.payloadRefId !== payloadRef.id
        || !sameBinding(record.descriptor, expectedBinding)
        || record.purpose !== purpose) {
      throw new SynchronousClassifiedPayloadStoreError('payload_binding_mismatch');
    }
    return Uint8Array.from(this.#open(record));
  }

  #expected(input: SynchronousClassifiedPayloadPutInput): Readonly<{
    payloadRefId: PayloadRefId;
    descriptor: NormalizedDescriptor;
    purpose: string;
    createdAt: Instant;
  }> {
    let payloadRefId: PayloadRefId;
    try {
      payloadRefId = parsePayloadRefId(input.payloadRefId);
    } catch {
      return invalidInput();
    }
    if (!(input.bytes instanceof Uint8Array)) invalidInput();
    const normalizedBinding = binding(input.binding);
    return Object.freeze({
      payloadRefId,
      descriptor: Object.freeze({
        ...normalizedBinding,
        byteSize: input.bytes.byteLength,
        integrityDigest: sha256(input.bytes)
      }),
      purpose: normalizedPurpose(input.purpose),
      createdAt: normalizeSynchronousClassifiedPayloadCreatedAt(input.createdAt)
    });
  }

  #open(record: ImmutableClassifiedPayloadRecord): Uint8Array {
    const profile = this.#profiles.get(
      `${record.encryptionProfile.key}\0${record.encryptionProfile.version}`
    );
    if (profile === undefined) {
      throw new SynchronousClassifiedPayloadStoreError('encryption_profile_unavailable');
    }
    const aad = authenticatedData({
      payloadRefId: record.payloadRefId,
      encryptionProfile: record.encryptionProfile,
      descriptor: record.descriptor,
      purpose: record.purpose,
      createdAt: record.createdAt
    });
    if (!sameDigest(sha256(aad), record.authenticatedDataDigest)) corrupt();
    const plaintext = openSynchronousClassifiedPayload({
      profile,
      encrypted: {
        nonce: record.nonce,
        ciphertext: record.ciphertext,
        authenticationTag: record.authenticationTag
      },
      authenticatedData: aad
    });
    if (plaintext.byteLength !== record.descriptor.byteSize
        || !sameDigest(sha256(plaintext), record.descriptor.integrityDigest)) corrupt();
    return plaintext;
  }
}
