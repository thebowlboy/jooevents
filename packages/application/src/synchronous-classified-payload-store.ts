import { versionedDefinitionRefSchema, type VersionedDefinitionRef } from '@jooevents/contracts';
import {
  canonicalJsonText,
  createPayloadRef,
  parseInstant,
  parsePayloadRefId,
  type Instant,
  type PayloadRef,
  type PayloadRefId
} from '@jooevents/kernel';
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes as secureRandomBytes,
  timingSafeEqual
} from 'node:crypto';
import type { ClassifiedPayloadProfiles } from './classified-payloads';

export const SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO = Object.freeze({
  algorithm: 'aes-256-gcm' as const,
  keyBytes: 32,
  nonceBytes: 12,
  authenticationTagBytes: 16
});

export type SynchronousClassifiedPayloadStoreErrorCode =
  | 'invalid_encryption_profile'
  | 'encryption_profile_unavailable'
  | 'invalid_payload_input'
  | 'transaction_required'
  | 'payload_not_found'
  | 'payload_ref_collision'
  | 'payload_binding_mismatch'
  | 'payload_corrupt'
  | 'nonce_unavailable'
  | 'payload_store_failure';

/** Deliberately contains only a stable code, never provider, SQL, or content detail. */
export class SynchronousClassifiedPayloadStoreError extends Error {
  readonly code: SynchronousClassifiedPayloadStoreErrorCode;

  constructor(code: SynchronousClassifiedPayloadStoreErrorCode) {
    super(code);
    this.name = 'SynchronousClassifiedPayloadStoreError';
    this.code = code;
  }
}

declare const synchronousClassifiedPayloadEncryptionProfileBrand: unique symbol;

/**
 * Process-authenticated encryption selection. Key bytes remain in this module's
 * private WeakMap and are not properties of the handle.
 */
export interface SynchronousClassifiedPayloadEncryptionProfile {
  readonly reference: VersionedDefinitionRef;
  readonly [synchronousClassifiedPayloadEncryptionProfileBrand]: true;
}

interface EncryptionProfileRecord {
  readonly keyBytes: Uint8Array;
}

const encryptionProfiles = new WeakMap<object, EncryptionProfileRecord>();

export function issueSynchronousClassifiedPayloadEncryptionProfile(input: {
  readonly reference: VersionedDefinitionRef;
  readonly keyBytes: Uint8Array;
}): SynchronousClassifiedPayloadEncryptionProfile {
  let reference: VersionedDefinitionRef;
  try {
    reference = versionedDefinitionRefSchema.parse(input.reference);
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('invalid_encryption_profile');
  }
  if (!(input.keyBytes instanceof Uint8Array)
      || input.keyBytes.byteLength !== SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.keyBytes) {
    throw new SynchronousClassifiedPayloadStoreError('invalid_encryption_profile');
  }
  const profile = Object.freeze({ reference: Object.freeze({ ...reference }) }) as unknown as
    SynchronousClassifiedPayloadEncryptionProfile;
  encryptionProfiles.set(profile, Object.freeze({ keyBytes: Uint8Array.from(input.keyBytes) }));
  return profile;
}

export function assertSynchronousClassifiedPayloadEncryptionProfile(
  profile: SynchronousClassifiedPayloadEncryptionProfile
): void {
  if (!profile || typeof profile !== 'object' || !encryptionProfiles.has(profile)) {
    throw new SynchronousClassifiedPayloadStoreError('invalid_encryption_profile');
  }
}

export function synchronousClassifiedPayloadEncryptionProfileReference(
  profile: SynchronousClassifiedPayloadEncryptionProfile
): VersionedDefinitionRef {
  assertSynchronousClassifiedPayloadEncryptionProfile(profile);
  return profile.reference;
}

export interface SynchronousClassifiedPayloadCiphertext {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authenticationTag: Uint8Array;
}

export type SynchronousClassifiedPayloadNonceSource = (size: number) => Uint8Array;

function profileRecord(
  profile: SynchronousClassifiedPayloadEncryptionProfile
): EncryptionProfileRecord {
  assertSynchronousClassifiedPayloadEncryptionProfile(profile);
  return encryptionProfiles.get(profile)!;
}

function owned(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function validBytes(value: Uint8Array, length?: number): boolean {
  return value instanceof Uint8Array && (length === undefined || value.byteLength === length);
}

/** Server-only synchronous cryptography for a transaction-local SQLite adapter. */
export function sealSynchronousClassifiedPayload(input: {
  readonly profile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly plaintext: Uint8Array;
  readonly authenticatedData: Uint8Array;
  readonly nonceSource?: SynchronousClassifiedPayloadNonceSource;
}): SynchronousClassifiedPayloadCiphertext {
  const profile = profileRecord(input.profile);
  if (!validBytes(input.plaintext) || !validBytes(input.authenticatedData)) {
    throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
  }
  const nonceSource = input.nonceSource
    ?? ((size: number) => Uint8Array.from(secureRandomBytes(size)));
  let nonce: Uint8Array;
  try {
    nonce = Uint8Array.from(nonceSource(SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.nonceBytes));
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('nonce_unavailable');
  }
  if (!validBytes(nonce, SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.nonceBytes)) {
    throw new SynchronousClassifiedPayloadStoreError('nonce_unavailable');
  }

  try {
    const cipher = createCipheriv(
      SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.algorithm,
      owned(profile.keyBytes),
      owned(nonce),
      { authTagLength: SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.authenticationTagBytes }
    );
    cipher.setAAD(owned(input.authenticatedData), { plaintextLength: input.plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(owned(input.plaintext)), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    return Object.freeze({
      nonce: Uint8Array.from(nonce),
      ciphertext: Uint8Array.from(ciphertext),
      authenticationTag: Uint8Array.from(authenticationTag)
    });
  } catch (error) {
    if (error instanceof SynchronousClassifiedPayloadStoreError) throw error;
    throw new SynchronousClassifiedPayloadStoreError('payload_store_failure');
  }
}

/** Authentication failures collapse to one content-free corruption result. */
export function openSynchronousClassifiedPayload(input: {
  readonly profile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly encrypted: SynchronousClassifiedPayloadCiphertext;
  readonly authenticatedData: Uint8Array;
}): Uint8Array {
  const profile = profileRecord(input.profile);
  if (!validBytes(input.encrypted.nonce, SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.nonceBytes)
      || !validBytes(input.encrypted.authenticationTag, SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.authenticationTagBytes)
      || !validBytes(input.encrypted.ciphertext)
      || !validBytes(input.authenticatedData)) {
    throw new SynchronousClassifiedPayloadStoreError('payload_corrupt');
  }
  try {
    const decipher = createDecipheriv(
      SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.algorithm,
      owned(profile.keyBytes),
      owned(input.encrypted.nonce),
      { authTagLength: SYNCHRONOUS_CLASSIFIED_PAYLOAD_CRYPTO.authenticationTagBytes }
    );
    decipher.setAAD(owned(input.authenticatedData), {
      plaintextLength: input.encrypted.ciphertext.byteLength
    });
    decipher.setAuthTag(owned(input.encrypted.authenticationTag));
    return Uint8Array.from(Buffer.concat([
      decipher.update(owned(input.encrypted.ciphertext)),
      decipher.final()
    ]));
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('payload_corrupt');
  }
}

/** Constant-time comparison for equal-length digest/tag material. */
export function sameSynchronousClassifiedPayloadVerifier(
  left: Uint8Array,
  right: Uint8Array
): boolean {
  if (!validBytes(left) || !validBytes(right) || left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(owned(left), owned(right));
}

export interface SynchronousClassifiedPayloadPutInput {
  readonly payloadRefId: PayloadRefId;
  readonly binding: SynchronousClassifiedPayloadBinding;
  readonly purpose: string;
  readonly bytes: Uint8Array;
  readonly createdAt: Instant;
}

/** Trusted storage input. Integrity digest and byte size are derived inside the store. */
export interface SynchronousClassifiedPayloadBinding {
  readonly profiles: ClassifiedPayloadProfiles;
  readonly scopeBinding: string;
  readonly contentType: string;
}

export interface SynchronousClassifiedPayloadReadInput {
  readonly payloadRef: PayloadRef;
  readonly expectedBinding: SynchronousClassifiedPayloadBinding;
  readonly purpose: string;
}

export type SynchronousClassifiedPayloadPutResult =
  | { readonly kind: 'inserted'; readonly payloadRef: PayloadRef }
  | { readonly kind: 'replay'; readonly payloadRef: PayloadRef };

/**
 * Canonical adopted-byte port. Implementations are synchronous so callers can
 * use the exact SQLite handle already held by a Foundation Unit of Work.
 */
export interface SynchronousClassifiedPayloadStore {
  put(input: SynchronousClassifiedPayloadPutInput): SynchronousClassifiedPayloadPutResult;
  read(input: SynchronousClassifiedPayloadReadInput): Uint8Array;
}

declare const synchronousClassifiedPayloadAdoptionReceiptBrand: unique symbol;

/** Opaque proof that one store put was followed by exact descriptor-bound read-back. */
export interface SynchronousClassifiedPayloadAdoptionReceipt {
  readonly [synchronousClassifiedPayloadAdoptionReceiptBrand]: true;
}

interface AdoptionReceiptRecord {
  readonly store: SynchronousClassifiedPayloadStore;
  readonly kind: SynchronousClassifiedPayloadPutResult['kind'];
  readonly payloadRef: PayloadRef;
  readonly bindingCanonical: string;
  readonly purpose: string;
  readonly byteSize: number;
  readonly integrityDigest: Uint8Array;
}

export interface OpenedSynchronousClassifiedPayloadAdoptionReceipt {
  readonly kind: SynchronousClassifiedPayloadPutResult['kind'];
  readonly payloadRef: PayloadRef;
}

const adoptionReceipts = new WeakMap<object, AdoptionReceiptRecord>();

/**
 * Performs the authoritative adoption ceremony on one exact store instance.
 * A receipt is issued only after immutable put/replay and exact read-back agree.
 */
export function adoptSynchronousClassifiedPayload(input: {
  readonly store: SynchronousClassifiedPayloadStore;
  readonly put: SynchronousClassifiedPayloadPutInput;
}): SynchronousClassifiedPayloadAdoptionReceipt {
  if (!input.store || typeof input.store.put !== 'function' || typeof input.store.read !== 'function') {
    throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
  }
  const result = input.store.put(input.put);
  const readBack = input.store.read({
    payloadRef: result.payloadRef,
    expectedBinding: input.put.binding,
    purpose: input.put.purpose
  });
  if (!(readBack instanceof Uint8Array)
      || readBack.byteLength !== input.put.bytes.byteLength
      || !sameSynchronousClassifiedPayloadVerifier(readBack, input.put.bytes)) {
    throw new SynchronousClassifiedPayloadStoreError('payload_corrupt');
  }
  const receipt = Object.freeze(Object.create(null)) as SynchronousClassifiedPayloadAdoptionReceipt;
  adoptionReceipts.set(receipt, Object.freeze({
    store: input.store,
    kind: result.kind,
    payloadRef: result.payloadRef,
    bindingCanonical: canonicalJsonText(input.put.binding),
    purpose: input.put.purpose,
    byteSize: input.put.bytes.byteLength,
    integrityDigest: Uint8Array.from(createHash('sha256').update(input.put.bytes).digest())
  }));
  return receipt;
}

/** Opens only authentic receipts, optionally binding them to the expected store. */
export function openSynchronousClassifiedPayloadAdoptionReceipt(input: {
  readonly receipt: SynchronousClassifiedPayloadAdoptionReceipt;
  readonly expectedStore?: SynchronousClassifiedPayloadStore;
  readonly expected?: {
    readonly binding: SynchronousClassifiedPayloadBinding;
    readonly purpose: string;
    readonly bytes: Uint8Array;
  };
}): OpenedSynchronousClassifiedPayloadAdoptionReceipt {
  const record = adoptionReceipts.get(input.receipt);
  if (!record || (input.expectedStore !== undefined && input.expectedStore !== record.store)) {
    throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
  }
  if (input.expected !== undefined) {
    if (!(input.expected.bytes instanceof Uint8Array)
        || canonicalJsonText(input.expected.binding) !== record.bindingCanonical
        || input.expected.purpose !== record.purpose
        || input.expected.bytes.byteLength !== record.byteSize
        || !sameSynchronousClassifiedPayloadVerifier(
          Uint8Array.from(createHash('sha256').update(input.expected.bytes).digest()),
          record.integrityDigest
        )) {
      throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
    }
  }
  return Object.freeze({
    kind: record.kind,
    payloadRef: record.payloadRef
  });
}

export function normalizeSynchronousClassifiedPayloadRef(value: unknown): PayloadRef {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 1 || !('id' in value)) {
      throw new TypeError();
    }
    return createPayloadRef(parsePayloadRefId((value as { readonly id: unknown }).id));
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
  }
}

export function normalizeSynchronousClassifiedPayloadCreatedAt(value: unknown): Instant {
  try {
    return parseInstant(value);
  } catch {
    throw new SynchronousClassifiedPayloadStoreError('invalid_payload_input');
  }
}
