import {
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  type IdempotencyCredentialSealer,
  type RequestHashSealer
} from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  versionedDefinitionRefSchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseContractVersion } from '@jooevents/kernel';
import { hkdfSync, timingSafeEqual } from 'node:crypto';

export const DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES = Object.freeze({
  requestHash: 'JOOEVENTS_REQUEST_HASH_KEYS',
  idempotency: 'JOOEVENTS_IDEMPOTENCY_KEYS',
  classifiedPayload: 'JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS',
  persistentHmac: 'JOOEVENTS_PERSISTENT_HMAC_KEYS'
} as const);

type DurableCryptoKeyEnvironmentDuty =
  (typeof DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES)[keyof typeof DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES];

export const DURABLE_CRYPTO_PROFILE_ERROR_CODES = Object.freeze([
  'missing_key_ring',
  'invalid_key_ring_entry',
  'invalid_key_material',
  'duplicate_key_version',
  'unordered_key_versions',
  'duplicate_key_material',
  'invalid_profile_reference',
  'profile_version_unavailable',
  'invalid_retained_profile_order',
  'misaligned_key_versions',
  'derived_key_collision'
] as const);

export type DurableCryptoProfileErrorCode =
  (typeof DURABLE_CRYPTO_PROFILE_ERROR_CODES)[number];

export interface DurableCryptoProfileConfigurationIssue {
  readonly duty: DurableCryptoKeyEnvironmentDuty;
  readonly code: DurableCryptoProfileErrorCode;
}

/** Contains only configuration duties and stable codes, never key material. */
export class DurableCryptoProfileConfigurationError extends Error {
  readonly issues: readonly DurableCryptoProfileConfigurationIssue[];

  constructor(issues: readonly DurableCryptoProfileConfigurationIssue[]) {
    const safeIssues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
    super(`Invalid durable crypto profile configuration (${safeIssues
      .map((issue) => `${issue.duty}:${issue.code}`)
      .join(', ')}).`);
    this.name = 'DurableCryptoProfileConfigurationError';
    this.issues = safeIssues;
  }
}

export interface DurableCryptoProfileEnvironment {
  readonly requestHashKeys?: string | undefined;
  readonly idempotencyKeys?: string | undefined;
  readonly classifiedPayloadKeys?: string | undefined;
  readonly persistentHmacKeys?: string | undefined;
}

export interface ClassifiedPayloadEncryptionProfileSelection {
  readonly active: VersionedDefinitionRef;
  /** Older readable profiles, newest first. */
  readonly retained?: readonly VersionedDefinitionRef[];
}

export interface ClassifiedPayloadEncryptionProfileComposition {
  readonly encryptionProfile: SynchronousClassifiedPayloadEncryptionProfile;
  readonly retainedEncryptionProfiles: readonly SynchronousClassifiedPayloadEncryptionProfile[];
}

export interface DurableCryptoProfileSelection {
  readonly active: VersionedDefinitionRef;
  /** Older configured versions, newest first. */
  readonly retained: readonly VersionedDefinitionRef[];
}

declare const durableCryptoProfileCompositionBrand: unique symbol;

/** Server-only opaque composition. No method returns or accepts raw key material. */
export interface DurableCryptoProfileComposition {
  readonly [durableCryptoProfileCompositionBrand]: true;
  requestHashSealer(profile: VersionedDefinitionRef): RequestHashSealer;
  idempotencyCredentialSealer(profile: VersionedDefinitionRef): IdempotencyCredentialSealer;
  classifiedPayloadEncryptionProfiles(
    selection: ClassifiedPayloadEncryptionProfileSelection
  ): ClassifiedPayloadEncryptionProfileComposition;
  profileSelection(
    family: KeyFamily,
    key: string
  ): DurableCryptoProfileSelection;
  /**
   * Supplies one purpose-separated temporary key to a synchronous factory.
   * The temporary bytes are zeroed before this method returns; factories must
   * copy the bytes they need and must never return or retain this exact view.
   */
  withPersistentHmacKey<Result>(
    profile: VersionedDefinitionRef,
    create: (keyBytes: Uint8Array) => Result
  ): Result;
  withPersistentHmacKeySelection<Result>(
    key: string,
    create: (selection: {
      readonly active: { readonly reference: VersionedDefinitionRef; readonly keyBytes: Uint8Array };
      readonly retained: readonly {
        readonly reference: VersionedDefinitionRef;
        readonly keyBytes: Uint8Array;
      }[];
    }) => Result
  ): Result;
}

export type DurableCryptoKeyFamily =
  'request_hash' | 'idempotency' | 'classified_payload' | 'persistent_hmac';
type KeyFamily = DurableCryptoKeyFamily;

interface KeyRingEntry {
  readonly version: number;
  readonly keyBytes: Uint8Array;
}

interface KeyRing {
  readonly duty: DurableCryptoKeyEnvironmentDuty;
  readonly family: KeyFamily;
  readonly entries: readonly KeyRingEntry[];
  readonly byVersion: ReadonlyMap<number, Uint8Array>;
}

interface DerivedKeyRecord {
  readonly identity: string;
  readonly keyBytes: Uint8Array;
}

const canonicalBase64UrlKey = /^[A-Za-z0-9_-]{43}$/;
const positiveInteger = /^[1-9][0-9]*$/;
const keyLength = 32;
const kdfSalt = new TextEncoder().encode('jooevents:durable-crypto-profile:hkdf-sha256:v1');
const issuedCompositions = new WeakSet<object>();

function issue(
  duty: DurableCryptoKeyEnvironmentDuty,
  code: DurableCryptoProfileErrorCode
): DurableCryptoProfileConfigurationIssue {
  return Object.freeze({ duty, code });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && timingSafeEqual(
      Buffer.from(left.buffer, left.byteOffset, left.byteLength),
      Buffer.from(right.buffer, right.byteOffset, right.byteLength)
    );
}

function parseKeyRing(input: {
  readonly value: string | undefined;
  readonly family: KeyFamily;
  readonly duty: DurableCryptoKeyEnvironmentDuty;
  readonly issues: DurableCryptoProfileConfigurationIssue[];
}): KeyRing {
  if (input.value === undefined || input.value.trim().length === 0) {
    input.issues.push(issue(input.duty, 'missing_key_ring'));
    return Object.freeze({
      duty: input.duty,
      family: input.family,
      entries: Object.freeze([]),
      byVersion: new Map()
    });
  }

  const entries: KeyRingEntry[] = [];
  for (const item of input.value.split(',')) {
    const candidate = item.trim();
    const separator = candidate.indexOf(':');
    if (separator <= 0 || separator !== candidate.lastIndexOf(':')) {
      input.issues.push(issue(input.duty, 'invalid_key_ring_entry'));
      continue;
    }
    const versionText = candidate.slice(0, separator);
    const encodedKey = candidate.slice(separator + 1);
    const version = Number(versionText);
    if (!positiveInteger.test(versionText) || !Number.isSafeInteger(version)) {
      input.issues.push(issue(input.duty, 'invalid_key_ring_entry'));
      continue;
    }
    if (!canonicalBase64UrlKey.test(encodedKey)) {
      input.issues.push(issue(input.duty, 'invalid_key_material'));
      continue;
    }
    const decoded = Uint8Array.from(Buffer.from(encodedKey, 'base64url'));
    if (decoded.byteLength !== keyLength || Buffer.from(decoded).toString('base64url') !== encodedKey) {
      decoded.fill(0);
      input.issues.push(issue(input.duty, 'invalid_key_material'));
      continue;
    }
    entries.push(Object.freeze({ version, keyBytes: decoded }));
  }

  if (new Set(entries.map((entry) => entry.version)).size !== entries.length) {
    input.issues.push(issue(input.duty, 'duplicate_key_version'));
  }
  if (entries.some((entry, index) =>
    index > 0 && entry.version >= (entries[index - 1]?.version ?? 0))) {
    input.issues.push(issue(input.duty, 'unordered_key_versions'));
  }
  return Object.freeze({
    duty: input.duty,
    family: input.family,
    entries: Object.freeze(entries),
    byVersion: new Map(entries.map((entry) => [entry.version, entry.keyBytes] as const))
  });
}

function assertNoRepeatedRawMaterial(
  rings: readonly KeyRing[],
  issues: DurableCryptoProfileConfigurationIssue[]
): void {
  const seen: Array<{ readonly duty: DurableCryptoKeyEnvironmentDuty; readonly bytes: Uint8Array }> = [];
  for (const ring of rings) {
    for (const entry of ring.entries) {
      if (seen.some((candidate) => sameBytes(candidate.bytes, entry.keyBytes))) {
        issues.push(issue(ring.duty, 'duplicate_key_material'));
      } else {
        seen.push(Object.freeze({ duty: ring.duty, bytes: entry.keyBytes }));
      }
    }
  }
}

function assertAlignedKeyVersions(
  rings: readonly KeyRing[],
  issues: DurableCryptoProfileConfigurationIssue[]
): void {
  const expected = rings[0]?.entries.map((entry) => entry.version).join(',');
  for (const ring of rings.slice(1)) {
    if (ring.entries.map((entry) => entry.version).join(',') !== expected) {
      issues.push(issue(ring.duty, 'misaligned_key_versions'));
    }
  }
}

function profileIdentity(input: {
  readonly family: KeyFamily;
  readonly purpose: string;
  readonly profile: VersionedDefinitionRef;
}): string {
  return JSON.stringify([
    'jooevents.durable-crypto-profile',
    1,
    input.family,
    input.purpose,
    input.profile.key,
    input.profile.version
  ]);
}

function normalizeProfile(
  value: VersionedDefinitionRef,
  duty: DurableCryptoKeyEnvironmentDuty
): VersionedDefinitionRef {
  const parsed = versionedDefinitionRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableCryptoProfileConfigurationError([
      issue(duty, 'invalid_profile_reference')
    ]);
  }
  return Object.freeze({ ...parsed.data });
}

function deriveProfileKey(input: {
  readonly ring: KeyRing;
  readonly purpose: string;
  readonly profile: VersionedDefinitionRef;
  readonly allRawKeys: readonly Uint8Array[];
  readonly derived: DerivedKeyRecord[];
}): Uint8Array {
  const profile = normalizeProfile(input.profile, input.ring.duty);
  const rootKey = input.ring.byVersion.get(Number(profile.version));
  if (rootKey === undefined) {
    throw new DurableCryptoProfileConfigurationError([
      issue(input.ring.duty, 'profile_version_unavailable')
    ]);
  }
  const identity = profileIdentity({
    family: input.ring.family,
    purpose: input.purpose,
    profile
  });
  const existing = input.derived.find((record) => record.identity === identity);
  if (existing !== undefined) return Uint8Array.from(existing.keyBytes);

  const derived = new Uint8Array(hkdfSync(
    'sha256',
    rootKey,
    kdfSalt,
    new TextEncoder().encode(identity),
    keyLength
  ));
  if (input.allRawKeys.some((key) => sameBytes(key, derived))
      || input.derived.some((record) => sameBytes(record.keyBytes, derived))) {
    derived.fill(0);
    throw new DurableCryptoProfileConfigurationError([
      issue(input.ring.duty, 'derived_key_collision')
    ]);
  }
  input.derived.push(Object.freeze({ identity, keyBytes: Uint8Array.from(derived) }));
  return derived;
}

function assertRetainedProfileOrder(input: {
  readonly ring: KeyRing;
  readonly active: VersionedDefinitionRef;
  readonly retained: readonly VersionedDefinitionRef[];
}): void {
  const references = [input.active, ...input.retained];
  if (references.some((profile) => profile.key !== input.active.key)
      || new Set(references.map((profile) => Number(profile.version))).size !== references.length
      || input.retained.some((profile, index) =>
        Number(profile.version) >= Number(references[index]?.version))) {
    throw new DurableCryptoProfileConfigurationError([
      issue(input.ring.duty, 'invalid_retained_profile_order')
    ]);
  }
}

/**
 * Parses configured key rings and authenticates an opaque exact-profile resolver.
 * Ring syntax is newest-first `version:canonical-base64url-32-byte-key` entries.
 */
export function createDurableCryptoProfileComposition(
  environment: DurableCryptoProfileEnvironment
): DurableCryptoProfileComposition {
  const issues: DurableCryptoProfileConfigurationIssue[] = [];
  const requestHash = parseKeyRing({
    value: environment.requestHashKeys,
    family: 'request_hash',
    duty: DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash,
    issues
  });
  const idempotency = parseKeyRing({
    value: environment.idempotencyKeys,
    family: 'idempotency',
    duty: DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.idempotency,
    issues
  });
  const classifiedPayload = parseKeyRing({
    value: environment.classifiedPayloadKeys,
    family: 'classified_payload',
    duty: DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.classifiedPayload,
    issues
  });
  const persistentHmac = parseKeyRing({
    value: environment.persistentHmacKeys,
    family: 'persistent_hmac',
    duty: DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.persistentHmac,
    issues
  });
  const rings = Object.freeze([
    requestHash,
    idempotency,
    classifiedPayload,
    persistentHmac
  ]);
  assertNoRepeatedRawMaterial(rings, issues);
  assertAlignedKeyVersions(rings, issues);
  if (issues.length > 0) throw new DurableCryptoProfileConfigurationError(issues);

  const allRawKeys = Object.freeze(rings.flatMap((ring) => ring.entries.map((entry) => entry.keyBytes)));
  const derived: DerivedKeyRecord[] = [];
  const encryptionProfiles = new Map<string, SynchronousClassifiedPayloadEncryptionProfile>();
  const derive = (ring: KeyRing, purpose: string, profile: VersionedDefinitionRef) =>
    deriveProfileKey({ ring, purpose, profile, allRawKeys, derived });
  const encryptionProfile = (profile: VersionedDefinitionRef) => {
    const normalized = normalizeProfile(profile, classifiedPayload.duty);
    const identity = profileIdentity({
      family: classifiedPayload.family,
      purpose: 'synchronous-classified-payload-encryption',
      profile: normalized
    });
    const existing = encryptionProfiles.get(identity);
    if (existing !== undefined) return existing;
    const keyBytes = derive(
      classifiedPayload,
      'synchronous-classified-payload-encryption',
      normalized
    );
    try {
      const issued = issueSynchronousClassifiedPayloadEncryptionProfile({
        reference: normalized,
        keyBytes
      });
      encryptionProfiles.set(identity, issued);
      return issued;
    } finally {
      keyBytes.fill(0);
    }
  };
  const selection = (ring: KeyRing, key: string): DurableCryptoProfileSelection => {
    const references = ring.entries.map((entry) => normalizeProfile(
      Object.freeze({ key, version: entry.version }),
      ring.duty
    ));
    const active = references[0];
    if (active === undefined) {
      throw new DurableCryptoProfileConfigurationError([
        issue(ring.duty, 'missing_key_ring')
      ]);
    }
    return Object.freeze({
      active,
      retained: Object.freeze(references.slice(1))
    });
  };

  const composition = Object.freeze({
    requestHashSealer(profile: VersionedDefinitionRef): RequestHashSealer {
      const normalized = normalizeProfile(profile, requestHash.duty);
      const keyBytes = derive(requestHash, 'canonical-operation-request-hash', normalized);
      try {
        return createHmacRequestHashSealer({ profile: normalized, keyBytes });
      } finally {
        keyBytes.fill(0);
      }
    },
    idempotencyCredentialSealer(profile: VersionedDefinitionRef): IdempotencyCredentialSealer {
      const normalized = normalizeProfile(profile, idempotency.duty);
      const keyBytes = derive(idempotency, 'raw-idempotency-credential-verifier', normalized);
      try {
        return createHmacIdempotencyCredentialSealer({
          profile: Object.freeze({
            key: normalized.key,
            version: parseContractVersion(normalized.version)
          }),
          keyBytes
        });
      } finally {
        keyBytes.fill(0);
      }
    },
    classifiedPayloadEncryptionProfiles(
      selection: ClassifiedPayloadEncryptionProfileSelection
    ): ClassifiedPayloadEncryptionProfileComposition {
      const active = normalizeProfile(selection.active, classifiedPayload.duty);
      const retained = Object.freeze((selection.retained ?? []).map((profile) =>
        normalizeProfile(profile, classifiedPayload.duty)));
      assertRetainedProfileOrder({ ring: classifiedPayload, active, retained });
      return Object.freeze({
        encryptionProfile: encryptionProfile(active),
        retainedEncryptionProfiles: Object.freeze(retained.map(encryptionProfile))
      });
    },
    profileSelection(
      family: KeyFamily,
      key: string
    ): DurableCryptoProfileSelection {
      const ring = family === 'request_hash'
        ? requestHash
        : family === 'idempotency'
          ? idempotency
          : family === 'classified_payload'
            ? classifiedPayload
            : persistentHmac;
      return selection(ring, key);
    },
    withPersistentHmacKey<Result>(
      profile: VersionedDefinitionRef,
      create: (keyBytes: Uint8Array) => Result
    ): Result {
      const normalized = normalizeProfile(profile, persistentHmac.duty);
      const keyBytes = derive(
        persistentHmac,
        'persistent-domain-hmac',
        normalized
      );
      try {
        return create(keyBytes);
      } finally {
        keyBytes.fill(0);
      }
    },
    withPersistentHmacKeySelection<Result>(
      key: string,
      create: (selection: {
        readonly active: { readonly reference: VersionedDefinitionRef; readonly keyBytes: Uint8Array };
        readonly retained: readonly {
          readonly reference: VersionedDefinitionRef;
          readonly keyBytes: Uint8Array;
        }[];
      }) => Result
    ): Result {
      const references = selection(persistentHmac, key);
      const temporary = [references.active, ...references.retained].map((reference) => ({
        reference,
        keyBytes: derive(persistentHmac, 'persistent-domain-hmac', reference)
      }));
      try {
        return create(Object.freeze({
          active: temporary[0]!,
          retained: Object.freeze(temporary.slice(1))
        }));
      } finally {
        for (const profile of temporary) profile.keyBytes.fill(0);
      }
    }
  }) as DurableCryptoProfileComposition;
  issuedCompositions.add(composition);
  return composition;
}

export function assertDurableCryptoProfileComposition(
  value: DurableCryptoProfileComposition
): void {
  if (!value || typeof value !== 'object' || !issuedCompositions.has(value)) {
    throw new DurableCryptoProfileConfigurationError([
      issue(DURABLE_CRYPTO_KEY_ENVIRONMENT_DUTIES.requestHash, 'invalid_profile_reference')
    ]);
  }
}
