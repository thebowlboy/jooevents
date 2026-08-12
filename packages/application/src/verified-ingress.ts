import {
  canonicalJsonText,
  createPayloadRef,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parsePayloadRefId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifiedEnvelopeHandleId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  type ContractVersion,
  type EventScopeRef,
  type Instant,
  type PayloadRef,
  type PayloadRefId,
  type SourceConnectionId,
  type SourceConnectionRevisionId,
  type VerifiedEnvelopeHandleId,
  type VerifierRevisionId
} from '@jooevents/kernel';
import {
  createAuthenticatedPayloadStageDescriptor,
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  createStageReconciliationPolicyRef,
  type AuthenticatedPayloadStageDescriptor,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfiles,
  type ClassifiedPayloadStageStore,
  type PayloadStageInspection,
  type PayloadStageReconciliationCandidate,
  type StageReconciliationPolicyRef
} from './classified-payloads';
import { createHmac, timingSafeEqual } from 'node:crypto';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const VERIFIED_INGRESS_LIMITS = Object.freeze({
  maximumRawEnvelopeBytes: 8 * 1024 * 1024,
  maximumNormalizedContentBytes: 8 * 1024 * 1024,
  maximumSemanticIdentityMaterialBytes: 1_024,
  maximumContentBindingProfiles: 8,
  maximumStageTtlMs: 24 * 60 * 60 * 1_000
});

export interface VerifiedIngressDefinitionRef {
  readonly key: string;
  readonly version: ContractVersion;
}

export interface VerifiedIngressSourceConnectionConfig {
  readonly binding: VerifiedIngressDefinitionRef;
  readonly sourceConnectionId: SourceConnectionId;
  readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
  readonly scope: EventScopeRef;
  readonly verifierContract: VerifiedIngressDefinitionRef;
  readonly verifierRevisionId: VerifierRevisionId;
  readonly maximumRawEnvelopeBytes: number;
  readonly maximumNormalizedContentBytes: number;
  readonly semanticIdentityProfile: VerifiedIngressDefinitionRef;
  readonly semanticIdentityKeyBytes: Uint8Array;
  /** Primary profile first, followed by every retained profile needed for replay. */
  readonly contentBindingProfiles: readonly [
    VerifiedIngressContentBindingProfile,
    ...VerifiedIngressContentBindingProfile[]
  ];
  readonly classifiedPayloadProfiles: ClassifiedPayloadProfiles;
  readonly normalizedContentType: string;
  readonly stageTtlMs: number;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
}

export interface VerifiedIngressContentBindingProfile {
  readonly profile: VerifiedIngressDefinitionRef;
  readonly keyBytes: Uint8Array;
}

export interface VerifiedIngressSourceConnectionRegistry {
  resolve(binding: VerifiedIngressDefinitionRef): VerifiedIngressSourceConnectionConfig | undefined;
}

export type VerifiedIngressRejectionReason =
  | 'source_connection_unavailable'
  | 'verifier_unavailable'
  | 'raw_envelope_too_large'
  | 'invalid_authenticity'
  | 'replay_window'
  | 'malformed_envelope'
  | 'ambiguous_evidence'
  | 'normalized_content_invalid';

export type VerifiedIngressVerificationResult =
  | {
      readonly kind: 'verified';
      readonly semanticIdentityMaterial: Uint8Array;
      readonly normalizedRetainedContent: Uint8Array;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: Exclude<
        VerifiedIngressRejectionReason,
        | 'source_connection_unavailable'
        | 'verifier_unavailable'
        | 'raw_envelope_too_large'
        | 'normalized_content_invalid'
      >;
    };

export interface RegisteredVerifiedIngressVerifier {
  readonly contract: VerifiedIngressDefinitionRef;
  readonly revisionId: VerifierRevisionId;
  verify(input: {
    readonly rawEnvelope: Uint8Array;
    readonly protocolEvidence: unknown;
    readonly receivedAt: Instant;
    readonly sourceConnectionId: SourceConnectionId;
  }): VerifiedIngressVerificationResult | Promise<VerifiedIngressVerificationResult>;
}

export interface VerifiedIngressVerifierRegistry {
  resolve(input: {
    readonly contract: VerifiedIngressDefinitionRef;
    readonly revisionId: VerifierRevisionId;
  }): RegisteredVerifiedIngressVerifier | undefined;
}

export interface SealedVerifiedIngressContentBinding {
  readonly profile: VerifiedIngressDefinitionRef;
  readonly value: string;
  readonly keyVerifier: string;
}

export interface VerifiedIngressConfigurationSnapshot {
  readonly binding: VerifiedIngressDefinitionRef;
  readonly sourceConnectionId: SourceConnectionId;
  readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
  readonly scope: EventScopeRef;
  readonly verifierContract: VerifiedIngressDefinitionRef;
  readonly verifierRevisionId: VerifierRevisionId;
  readonly maximumRawEnvelopeBytes: number;
  readonly maximumNormalizedContentBytes: number;
  readonly semanticIdentityProfile: VerifiedIngressDefinitionRef;
  readonly semanticIdentityKeyVerifier: string;
  readonly contentBindingProfiles: readonly {
    readonly profile: VerifiedIngressDefinitionRef;
    readonly keyVerifier: string;
  }[];
  readonly classifiedPayloadProfiles: ClassifiedPayloadProfiles;
  readonly normalizedContentType: string;
  readonly stageTtlMs: number;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
}

declare const verifiedEnvelopeHandleBrand: unique symbol;

/** Publicly opaque. Runtime authenticity is object identity in the boundary's WeakMap. */
export interface VerifiedEnvelopeHandle {
  readonly id: VerifiedEnvelopeHandleId;
  readonly [verifiedEnvelopeHandleBrand]: true;
}

declare const adoptedVerifiedEnvelopeHandleBrand: unique symbol;

/** Publicly opaque evidence that the classified stage adoption fence was acquired. */
export interface AdoptedVerifiedEnvelopeHandle {
  readonly id: VerifiedEnvelopeHandleId;
  readonly [adoptedVerifiedEnvelopeHandleBrand]: true;
}

export interface SealedVerifiedEnvelopeMaterial {
  readonly handleId: VerifiedEnvelopeHandleId;
  readonly binding: VerifiedIngressDefinitionRef;
  readonly sourceConnectionId: SourceConnectionId;
  readonly sourceConnectionRevisionId: SourceConnectionRevisionId;
  readonly scope: EventScopeRef;
  readonly verifierContract: VerifiedIngressDefinitionRef;
  readonly verifierRevisionId: VerifierRevisionId;
  readonly configuration: VerifiedIngressConfigurationSnapshot;
  readonly semanticIdentity: string;
  readonly contentBindings: readonly [
    SealedVerifiedIngressContentBinding,
    ...SealedVerifiedIngressContentBinding[]
  ];
  readonly stage: AuthenticatedPayloadStageDescriptor;
  readonly expectedDescriptor: ClassifiedPayloadDescriptor;
  readonly receivedAt: Instant;
}

export interface SealedAdoptedVerifiedEnvelopeMaterial extends SealedVerifiedEnvelopeMaterial {
  readonly adoptionHandleId: VerifiedEnvelopeHandleId;
  readonly adoptedStage: AuthenticatedPayloadStageDescriptor;
  readonly payloadRef: PayloadRef;
}

export interface VerifiedEnvelopeSealReader {
  /** Opens authenticity only. Intended for diagnostics/reconciliation, not new intake. */
  openStaged(handle: object): SealedVerifiedEnvelopeMaterial | undefined;
  openAdopted(handle: object): SealedAdoptedVerifiedEnvelopeMaterial | undefined;
  /** Also proves that the exact connection/verifier configuration is still current. */
  openCurrentStaged(handle: object): SealedVerifiedEnvelopeMaterial | undefined;
  /** Called inside the final SQL transaction; returns undefined after revocation/rotation. */
  openCurrentAdopted(handle: object): SealedAdoptedVerifiedEnvelopeMaterial | undefined;
  /** Rechecks a durable pre-adoption intent after the original WeakMap seal is lost. */
  isCurrentRegistration(snapshot: VerifiedIngressConfigurationSnapshot): boolean;
}

export interface VerifiedIngressDurableIntentRecord {
  readonly version: 1;
  readonly intentId: string;
  readonly payloadRefId: PayloadRefId;
  readonly configuration: VerifiedIngressConfigurationSnapshot;
  readonly semanticIdentity: string;
  readonly contentBindings: readonly [
    SealedVerifiedIngressContentBinding,
    ...SealedVerifiedIngressContentBinding[]
  ];
  readonly stage: AuthenticatedPayloadStageDescriptor;
  /** Server-keyed binding to the classified descriptor; the ordinary digest is not durable SQL. */
  readonly expectedDescriptorBinding: string;
  readonly receivedAt: Instant;
}

export interface VerifiedIngressDurableIntent {
  readonly record: VerifiedIngressDurableIntentRecord;
  /** Server-keyed authentication over every canonical field in `record`. */
  readonly authenticator: string;
}

export type VerifiedIngressRecoveryResult =
  | { readonly kind: 'staged'; readonly handle: VerifiedEnvelopeHandle }
  | { readonly kind: 'adoption_pending'; readonly handle: AdoptedVerifiedEnvelopeHandle }
  | { readonly kind: 'stale_registration' }
  | { readonly kind: 'invalid' };

export type VerifiedIngressIntentVerificationResult =
  | { readonly kind: 'verified'; readonly intent: VerifiedIngressDurableIntent }
  | { readonly kind: 'stale_registration' }
  | { readonly kind: 'invalid' };

export interface VerifiedIngressRecoveryAuthority {
  /** Creates the only durable representation allowed to cross a process restart. */
  prepare(input: {
    readonly handle: VerifiedEnvelopeHandle;
    readonly intentId: string;
    readonly payloadRefId: PayloadRefId;
  }): VerifiedIngressDurableIntent;
  /** Authenticates a durable record and rechecks its exact source/verifier configuration. */
  verifyCurrent(intent: unknown): VerifiedIngressIntentVerificationResult;
  /** Verifies the keyed record, current registration, and authenticated filesystem state before resealing. */
  reseal(input: {
    readonly intent: unknown;
    readonly candidate: PayloadStageReconciliationCandidate;
  }): Promise<VerifiedIngressRecoveryResult>;
}

export type VerifiedIngressStageResult =
  | { readonly kind: 'rejected'; readonly reason: VerifiedIngressRejectionReason }
  | { readonly kind: 'staged'; readonly handle: VerifiedEnvelopeHandle };

export interface VerifiedIngressBoundary {
  readonly sealReader: VerifiedEnvelopeSealReader;
  readonly recovery: VerifiedIngressRecoveryAuthority;
  verifyAndStage(input: {
    readonly rawEnvelope: Uint8Array;
    readonly protocolEvidence: unknown;
  }): Promise<VerifiedIngressStageResult>;
  adopt(input: {
    readonly handle: VerifiedEnvelopeHandle;
    readonly payloadRefId: PayloadRefId;
  }): Promise<AdoptedVerifiedEnvelopeHandle>;
  markAdopted(handle: AdoptedVerifiedEnvelopeHandle): Promise<PayloadRef>;
}

export interface VerifiedIngressBoundaryOptions {
  readonly binding: VerifiedIngressDefinitionRef;
  readonly sourceConnections: VerifiedIngressSourceConnectionRegistry;
  readonly verifiers: VerifiedIngressVerifierRegistry;
  readonly stageStore: ClassifiedPayloadStageStore;
  readonly clock: { now(): string };
  readonly newHandleId?: () => string;
}

interface StoredStagedSeal {
  readonly configuration: NormalizedConnectionConfig;
  readonly material: SealedVerifiedEnvelopeMaterial;
}

interface StoredAdoptedSeal extends StoredStagedSeal {
  readonly material: SealedAdoptedVerifiedEnvelopeMaterial;
}

interface NormalizedContentBindingProfile {
  readonly profile: VerifiedIngressDefinitionRef;
  readonly keyBytes: Uint8Array;
}

interface NormalizedConnectionConfig
  extends Omit<
    VerifiedIngressSourceConnectionConfig,
    | 'binding'
    | 'scope'
    | 'verifierContract'
    | 'semanticIdentityProfile'
    | 'semanticIdentityKeyBytes'
    | 'contentBindingProfiles'
  > {
  readonly binding: VerifiedIngressDefinitionRef;
  readonly scope: EventScopeRef;
  readonly verifierContract: VerifiedIngressDefinitionRef;
  readonly semanticIdentityProfile: VerifiedIngressDefinitionRef;
  readonly semanticIdentityKeyBytes: Uint8Array;
  readonly contentBindingProfiles: readonly [
    NormalizedContentBindingProfile,
    ...NormalizedContentBindingProfile[]
  ];
}

function definitionRef(value: VerifiedIngressDefinitionRef): VerifiedIngressDefinitionRef {
  if (!stableKeyPattern.test(value.key)) throw new TypeError('verified ingress definition key is invalid');
  return Object.freeze({ key: value.key, version: parseContractVersion(value.version) });
}

function positiveBounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function keyBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 128) {
    throw new TypeError(`${label} must contain 32 to 128 bytes`);
  }
  return Uint8Array.from(value);
}

function normalizeConfiguration(value: VerifiedIngressSourceConnectionConfig): NormalizedConnectionConfig {
  if (value.scope.kind !== 'event') throw new TypeError('verified ingress scope must be event-bound');
  if (value.contentBindingProfiles.length === 0 || value.contentBindingProfiles.length > 8) {
    throw new TypeError('verified ingress requires one to eight content binding profiles');
  }
  const identities = new Set<string>();
  const bindings = value.contentBindingProfiles.map((candidate) => {
    const profile = definitionRef(candidate.profile);
    const identity = canonicalJsonText(profile);
    if (identities.has(identity)) throw new TypeError('content binding profiles must be unique');
    identities.add(identity);
    return {
      profile,
      keyBytes: keyBytes(candidate.keyBytes, 'content binding key')
    };
  });
  const primary = bindings[0];
  if (!primary) throw new TypeError('a primary content binding profile is required');
  if (!value.normalizedContentType || value.normalizedContentType.length > 255) {
    throw new TypeError('normalized ingress content type is invalid');
  }
  return {
    binding: definitionRef(value.binding),
    sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId),
    sourceConnectionRevisionId: parseSourceConnectionRevisionId(value.sourceConnectionRevisionId),
    scope: Object.freeze({
      kind: 'event',
      workspaceId: parseWorkspaceId(value.scope.workspaceId),
      eventId: parseEventId(value.scope.eventId)
    }),
    verifierContract: definitionRef(value.verifierContract),
    verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId),
    maximumRawEnvelopeBytes: positiveBounded(
      value.maximumRawEnvelopeBytes,
      VERIFIED_INGRESS_LIMITS.maximumRawEnvelopeBytes,
      'raw envelope bound'
    ),
    maximumNormalizedContentBytes: positiveBounded(
      value.maximumNormalizedContentBytes,
      VERIFIED_INGRESS_LIMITS.maximumNormalizedContentBytes,
      'normalized content bound'
    ),
    semanticIdentityProfile: definitionRef(value.semanticIdentityProfile),
    semanticIdentityKeyBytes: keyBytes(value.semanticIdentityKeyBytes, 'semantic identity key'),
    contentBindingProfiles: Object.freeze([primary, ...bindings.slice(1)]),
    classifiedPayloadProfiles: Object.freeze({
      classification: createClassifiedPayloadProfileRef(
        'classification',
        value.classifiedPayloadProfiles.classification.key,
        value.classifiedPayloadProfiles.classification.version
      ),
      schema: createClassifiedPayloadProfileRef(
        'schema',
        value.classifiedPayloadProfiles.schema.key,
        value.classifiedPayloadProfiles.schema.version
      ),
      content: createClassifiedPayloadProfileRef(
        'content',
        value.classifiedPayloadProfiles.content.key,
        value.classifiedPayloadProfiles.content.version
      ),
      integrity: createClassifiedPayloadProfileRef(
        'integrity',
        value.classifiedPayloadProfiles.integrity.key,
        value.classifiedPayloadProfiles.integrity.version
      ),
      descriptorAuth: createClassifiedPayloadProfileRef(
        'descriptor_auth',
        value.classifiedPayloadProfiles.descriptorAuth.key,
        value.classifiedPayloadProfiles.descriptorAuth.version
      )
    }),
    normalizedContentType: value.normalizedContentType,
    stageTtlMs: positiveBounded(
      value.stageTtlMs,
      VERIFIED_INGRESS_LIMITS.maximumStageTtlMs,
      'stage TTL'
    ),
    reconciliationPolicy: createStageReconciliationPolicyRef(
      value.reconciliationPolicy.key,
      value.reconciliationPolicy.version
    )
  };
}

function keyVerifier(
  namespace: string,
  profile: VerifiedIngressDefinitionRef,
  key: Uint8Array,
  prefix: 'ikv1_' | 'isv1_'
): string {
  return `${prefix}${createHmac('sha256', key)
    .update(`${namespace}\0`, 'utf8')
    .update(canonicalJsonText(profile), 'utf8')
    .digest('hex')}`;
}

function serverKeyedValue(
  key: Uint8Array,
  namespace: string,
  value: unknown,
  prefix: 'idb1_' | 'via1_'
): string {
  return `${prefix}${createHmac('sha256', key)
    .update(`${namespace}\0`, 'utf8')
    .update(canonicalJsonText(value), 'utf8')
    .digest('hex')}`;
}

function sameServerKeyedValue(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function configurationSnapshot(
  configuration: NormalizedConnectionConfig
): VerifiedIngressConfigurationSnapshot {
  return Object.freeze({
    binding: Object.freeze({ ...configuration.binding }),
    sourceConnectionId: configuration.sourceConnectionId,
    sourceConnectionRevisionId: configuration.sourceConnectionRevisionId,
    scope: Object.freeze({ ...configuration.scope }),
    verifierContract: Object.freeze({ ...configuration.verifierContract }),
    verifierRevisionId: configuration.verifierRevisionId,
    maximumRawEnvelopeBytes: configuration.maximumRawEnvelopeBytes,
    maximumNormalizedContentBytes: configuration.maximumNormalizedContentBytes,
    semanticIdentityProfile: Object.freeze({ ...configuration.semanticIdentityProfile }),
    semanticIdentityKeyVerifier: keyVerifier(
      'jooevents.verified-ingress.semantic-identity-key.v1',
      configuration.semanticIdentityProfile,
      configuration.semanticIdentityKeyBytes,
      'isv1_'
    ),
    contentBindingProfiles: Object.freeze(configuration.contentBindingProfiles.map((profile) =>
      Object.freeze({
        profile: Object.freeze({ ...profile.profile }),
        keyVerifier: keyVerifier(
          'jooevents.verified-inbox.key-verifier.v1',
          profile.profile,
          profile.keyBytes,
          'ikv1_'
        )
      })
    )),
    classifiedPayloadProfiles: configuration.classifiedPayloadProfiles,
    normalizedContentType: configuration.normalizedContentType,
    stageTtlMs: configuration.stageTtlMs,
    reconciliationPolicy: configuration.reconciliationPolicy
  });
}

function sameRef(left: VerifiedIngressDefinitionRef, right: VerifiedIngressDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function sameConfiguration(left: NormalizedConnectionConfig, right: NormalizedConnectionConfig): boolean {
  return (
    sameRef(left.binding, right.binding) &&
    left.sourceConnectionId === right.sourceConnectionId &&
    left.sourceConnectionRevisionId === right.sourceConnectionRevisionId &&
    canonicalJsonText(left.scope) === canonicalJsonText(right.scope) &&
    sameRef(left.verifierContract, right.verifierContract) &&
    left.verifierRevisionId === right.verifierRevisionId &&
    left.maximumRawEnvelopeBytes === right.maximumRawEnvelopeBytes &&
    left.maximumNormalizedContentBytes === right.maximumNormalizedContentBytes &&
    sameRef(left.semanticIdentityProfile, right.semanticIdentityProfile) &&
    sameBytes(left.semanticIdentityKeyBytes, right.semanticIdentityKeyBytes) &&
    left.contentBindingProfiles.length === right.contentBindingProfiles.length &&
    left.contentBindingProfiles.every((profile, index) => {
      const candidate = right.contentBindingProfiles[index];
      return candidate !== undefined && sameRef(profile.profile, candidate.profile) &&
        sameBytes(profile.keyBytes, candidate.keyBytes);
    }) &&
    canonicalJsonText(left.classifiedPayloadProfiles) === canonicalJsonText(right.classifiedPayloadProfiles) &&
    left.normalizedContentType === right.normalizedContentType &&
    left.stageTtlMs === right.stageTtlMs &&
    canonicalJsonText(left.reconciliationPolicy) === canonicalJsonText(right.reconciliationPolicy)
  );
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

const encoder = new TextEncoder();

async function hmac(key: Uint8Array, namespace: string, profile: VerifiedIngressDefinitionRef, material: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const frame = concat(
    encoder.encode(`${namespace}\0${canonicalJsonText(profile)}\0`),
    material
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', imported, Uint8Array.from(frame).buffer as ArrayBuffer)
  );
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(value))));
}

function frozenMaterial(material: SealedVerifiedEnvelopeMaterial): SealedVerifiedEnvelopeMaterial {
  const stage = normalizedStage(material.stage);
  const expectedDescriptor = normalizedDescriptor(material.expectedDescriptor);
  return Object.freeze({
    ...material,
    binding: Object.freeze({ ...material.binding }),
    scope: Object.freeze({ ...material.scope }),
    verifierContract: Object.freeze({ ...material.verifierContract }),
    configuration: Object.freeze({
      ...material.configuration,
      binding: Object.freeze({ ...material.configuration.binding }),
      scope: Object.freeze({ ...material.configuration.scope }),
      verifierContract: Object.freeze({ ...material.configuration.verifierContract }),
      semanticIdentityProfile: Object.freeze({ ...material.configuration.semanticIdentityProfile }),
      contentBindingProfiles: Object.freeze(material.configuration.contentBindingProfiles.map((profile) =>
        Object.freeze({ profile: Object.freeze({ ...profile.profile }), keyVerifier: profile.keyVerifier })
      )),
      classifiedPayloadProfiles: Object.freeze({ ...material.configuration.classifiedPayloadProfiles }),
      reconciliationPolicy: Object.freeze({ ...material.configuration.reconciliationPolicy })
    }),
    contentBindings: Object.freeze(
      material.contentBindings.map((binding) => Object.freeze({
        profile: Object.freeze({ ...binding.profile }),
        value: binding.value,
        keyVerifier: binding.keyVerifier
      }))
    ) as SealedVerifiedEnvelopeMaterial['contentBindings'],
    stage,
    expectedDescriptor
  });
}

function normalizedStage(value: AuthenticatedPayloadStageDescriptor): AuthenticatedPayloadStageDescriptor {
  return createAuthenticatedPayloadStageDescriptor({
    stageId: value.stageId,
    expectedVersion: Number(value.expectedVersion),
    fence: Number(value.fence),
    expiresAt: value.expiresAt,
    reconciliationPolicy: createStageReconciliationPolicyRef(
      value.reconciliationPolicy.key,
      Number(value.reconciliationPolicy.version)
    ),
    authenticationProfile: createClassifiedPayloadProfileRef(
      'descriptor_auth',
      value.authenticationProfile.key,
      Number(value.authenticationProfile.version)
    ),
    authenticationTag: value.authenticationTag
  });
}

function normalizedDescriptor(value: ClassifiedPayloadDescriptor): ClassifiedPayloadDescriptor {
  return createClassifiedPayloadDescriptor({
    profiles: Object.freeze({
      classification: createClassifiedPayloadProfileRef(
        'classification', value.profiles.classification.key, Number(value.profiles.classification.version)
      ),
      schema: createClassifiedPayloadProfileRef(
        'schema', value.profiles.schema.key, Number(value.profiles.schema.version)
      ),
      content: createClassifiedPayloadProfileRef(
        'content', value.profiles.content.key, Number(value.profiles.content.version)
      ),
      integrity: createClassifiedPayloadProfileRef(
        'integrity', value.profiles.integrity.key, Number(value.profiles.integrity.version)
      ),
      descriptorAuth: createClassifiedPayloadProfileRef(
        'descriptor_auth', value.profiles.descriptorAuth.key, Number(value.profiles.descriptorAuth.version)
      )
    }),
    scopeBinding: value.scopeBinding,
    contentType: value.contentType,
    byteSize: value.byteSize,
    integrityDigest: value.integrityDigest
  });
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) =>
    descriptor.get !== undefined || descriptor.set !== undefined
  )) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function definitionRefFromUnknown(value: unknown): VerifiedIngressDefinitionRef {
  if (!exactObject(value, ['key', 'version']) || typeof value.key !== 'string' ||
    typeof value.version !== 'number') {
    throw new TypeError('invalid durable definition reference');
  }
  return definitionRef({ key: value.key, version: parseContractVersion(value.version) });
}

function classifiedProfileFromUnknown<Kind extends keyof ClassifiedPayloadProfiles>(
  value: unknown,
  property: Kind,
  kind: ClassifiedPayloadProfiles[Kind]['kind']
): ClassifiedPayloadProfiles[Kind] {
  if (!exactObject(value, ['kind', 'key', 'version']) || value.kind !== kind ||
    typeof value.key !== 'string' || typeof value.version !== 'number') {
    throw new TypeError('invalid durable classified payload profile');
  }
  return createClassifiedPayloadProfileRef(
    kind,
    value.key,
    value.version
  ) as ClassifiedPayloadProfiles[Kind];
}

function stageFromUnknown(value: unknown): AuthenticatedPayloadStageDescriptor {
  if (!exactObject(value, [
    'stageId', 'expectedVersion', 'fence', 'expiresAt', 'reconciliationPolicy',
    'authenticationProfile', 'authenticationTag'
  ]) || !exactObject(value.reconciliationPolicy, ['key', 'version']) ||
    !exactObject(value.authenticationProfile, ['kind', 'key', 'version']) ||
    value.authenticationProfile.kind !== 'descriptor_auth' ||
    typeof value.stageId !== 'string' || typeof value.expectedVersion !== 'number' ||
    typeof value.fence !== 'number' || typeof value.expiresAt !== 'string' ||
    typeof value.reconciliationPolicy.key !== 'string' ||
    typeof value.reconciliationPolicy.version !== 'number' ||
    typeof value.authenticationProfile.key !== 'string' ||
    typeof value.authenticationProfile.version !== 'number' ||
    typeof value.authenticationTag !== 'string') {
    throw new TypeError('invalid durable authenticated stage');
  }
  return createAuthenticatedPayloadStageDescriptor({
    stageId: value.stageId,
    expectedVersion: value.expectedVersion,
    fence: value.fence,
    expiresAt: value.expiresAt,
    reconciliationPolicy: createStageReconciliationPolicyRef(
      value.reconciliationPolicy.key, value.reconciliationPolicy.version
    ),
    authenticationProfile: createClassifiedPayloadProfileRef(
      'descriptor_auth',
      value.authenticationProfile.key,
      value.authenticationProfile.version
    ),
    authenticationTag: value.authenticationTag
  });
}

function snapshotFromUnknown(value: unknown): VerifiedIngressConfigurationSnapshot | undefined {
  try {
    if (!exactObject(value, [
      'binding', 'sourceConnectionId', 'sourceConnectionRevisionId', 'scope',
      'verifierContract', 'verifierRevisionId', 'maximumRawEnvelopeBytes',
      'maximumNormalizedContentBytes', 'semanticIdentityProfile',
      'semanticIdentityKeyVerifier', 'contentBindingProfiles', 'classifiedPayloadProfiles',
      'normalizedContentType', 'stageTtlMs', 'reconciliationPolicy'
    ])) return undefined;
    if (!exactObject(value.scope, ['kind', 'workspaceId', 'eventId']) || value.scope.kind !== 'event') {
      return undefined;
    }
    if (!Array.isArray(value.contentBindingProfiles) || value.contentBindingProfiles.length === 0 ||
      value.contentBindingProfiles.length > VERIFIED_INGRESS_LIMITS.maximumContentBindingProfiles) {
      return undefined;
    }
    const contentBindingProfiles = value.contentBindingProfiles.map((candidate) => {
      if (!exactObject(candidate, ['profile', 'keyVerifier']) ||
        typeof candidate.keyVerifier !== 'string' || !/^ikv1_[0-9a-f]{64}$/.test(candidate.keyVerifier)) {
        throw new TypeError('invalid durable content binding profile');
      }
      return Object.freeze({
        profile: definitionRefFromUnknown(candidate.profile),
        keyVerifier: candidate.keyVerifier
      });
    });
    if (!exactObject(value.classifiedPayloadProfiles, [
      'classification', 'schema', 'content', 'integrity', 'descriptorAuth'
    ])) return undefined;
    const rawProfiles = value.classifiedPayloadProfiles;
    if (!exactObject(value.reconciliationPolicy, ['key', 'version'])) return undefined;
    if (typeof value.semanticIdentityKeyVerifier !== 'string' ||
      !/^isv1_[0-9a-f]{64}$/.test(value.semanticIdentityKeyVerifier)) return undefined;
    if (typeof value.normalizedContentType !== 'string' || !value.normalizedContentType ||
      value.normalizedContentType.length > 255) return undefined;
    if (typeof value.maximumRawEnvelopeBytes !== 'number' ||
      typeof value.maximumNormalizedContentBytes !== 'number' ||
      typeof value.stageTtlMs !== 'number' ||
      typeof value.reconciliationPolicy.key !== 'string' ||
      typeof value.reconciliationPolicy.version !== 'number') return undefined;
    return Object.freeze({
      binding: definitionRefFromUnknown(value.binding),
      sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId),
      sourceConnectionRevisionId: parseSourceConnectionRevisionId(value.sourceConnectionRevisionId),
      scope: Object.freeze({
        kind: 'event' as const,
        workspaceId: parseWorkspaceId(value.scope.workspaceId),
        eventId: parseEventId(value.scope.eventId)
      }),
      verifierContract: definitionRefFromUnknown(value.verifierContract),
      verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId),
      maximumRawEnvelopeBytes: positiveBounded(
        value.maximumRawEnvelopeBytes, VERIFIED_INGRESS_LIMITS.maximumRawEnvelopeBytes, 'raw envelope bound'
      ),
      maximumNormalizedContentBytes: positiveBounded(
        value.maximumNormalizedContentBytes,
        VERIFIED_INGRESS_LIMITS.maximumNormalizedContentBytes,
        'normalized content bound'
      ),
      semanticIdentityProfile: definitionRefFromUnknown(value.semanticIdentityProfile),
      semanticIdentityKeyVerifier: value.semanticIdentityKeyVerifier,
      contentBindingProfiles: Object.freeze(contentBindingProfiles),
      classifiedPayloadProfiles: Object.freeze({
        classification: classifiedProfileFromUnknown(
          rawProfiles.classification, 'classification', 'classification'
        ),
        schema: classifiedProfileFromUnknown(rawProfiles.schema, 'schema', 'schema'),
        content: classifiedProfileFromUnknown(rawProfiles.content, 'content', 'content'),
        integrity: classifiedProfileFromUnknown(rawProfiles.integrity, 'integrity', 'integrity'),
        descriptorAuth: classifiedProfileFromUnknown(
          rawProfiles.descriptorAuth, 'descriptorAuth', 'descriptor_auth'
        )
      }),
      normalizedContentType: value.normalizedContentType,
      stageTtlMs: positiveBounded(
        value.stageTtlMs, VERIFIED_INGRESS_LIMITS.maximumStageTtlMs, 'stage TTL'
      ),
      reconciliationPolicy: createStageReconciliationPolicyRef(
        value.reconciliationPolicy.key, value.reconciliationPolicy.version
      )
    });
  } catch {
    return undefined;
  }
}

function durableIntentFromUnknown(value: unknown): VerifiedIngressDurableIntent | undefined {
  try {
    if (!exactObject(value, ['record', 'authenticator']) || typeof value.authenticator !== 'string' ||
      !/^via1_[0-9a-f]{64}$/.test(value.authenticator)) return undefined;
    if (!exactObject(value.record, [
      'version', 'intentId', 'payloadRefId', 'configuration', 'semanticIdentity',
      'contentBindings', 'stage', 'expectedDescriptorBinding', 'receivedAt'
    ]) || value.record.version !== 1 || typeof value.record.intentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.record.intentId) ||
      typeof value.record.payloadRefId !== 'string' || typeof value.record.receivedAt !== 'string' ||
      typeof value.record.semanticIdentity !== 'string' || !/^si1_[A-Za-z0-9_-]{24,160}$/.test(value.record.semanticIdentity) ||
      typeof value.record.expectedDescriptorBinding !== 'string' ||
      !/^idb1_[0-9a-f]{64}$/.test(value.record.expectedDescriptorBinding) ||
      !Array.isArray(value.record.contentBindings) || value.record.contentBindings.length === 0 ||
      value.record.contentBindings.length > VERIFIED_INGRESS_LIMITS.maximumContentBindingProfiles) return undefined;
    const configuration = snapshotFromUnknown(value.record.configuration);
    if (!configuration) return undefined;
    const contentBindings = value.record.contentBindings.map((candidate) => {
      if (!exactObject(candidate, ['profile', 'value', 'keyVerifier']) ||
        typeof candidate.value !== 'string' || !/^kb1_[A-Za-z0-9_-]{32,128}$/.test(candidate.value) ||
        typeof candidate.keyVerifier !== 'string' || !/^ikv1_[0-9a-f]{64}$/.test(candidate.keyVerifier)) {
        throw new TypeError('invalid durable binding');
      }
      return Object.freeze({
        profile: definitionRefFromUnknown(candidate.profile),
        value: candidate.value,
        keyVerifier: candidate.keyVerifier
      });
    });
    const primary = contentBindings[0];
    if (!primary) return undefined;
    const stage = stageFromUnknown(value.record.stage);
    const record: VerifiedIngressDurableIntentRecord = Object.freeze({
      version: 1,
      intentId: value.record.intentId.toLowerCase(),
      payloadRefId: parsePayloadRefId(value.record.payloadRefId),
      configuration,
      semanticIdentity: value.record.semanticIdentity,
      contentBindings: Object.freeze([primary, ...contentBindings.slice(1)]) as readonly [
        SealedVerifiedIngressContentBinding,
        ...SealedVerifiedIngressContentBinding[]
      ],
      stage,
      expectedDescriptorBinding: value.record.expectedDescriptorBinding,
      receivedAt: parseInstant(value.record.receivedAt)
    });
    return Object.freeze({ record, authenticator: value.authenticator });
  } catch {
    return undefined;
  }
}

/**
 * Creates one route-bound verification/staging authority. It has no operation,
 * reliability, SQL, or provider-specific policy dependency.
 */
export function createVerifiedIngressBoundary(options: VerifiedIngressBoundaryOptions): VerifiedIngressBoundary {
  const bound = definitionRef(options.binding);
  const stagedSeals = new WeakMap<object, StoredStagedSeal>();
  const adoptedSeals = new WeakMap<object, StoredAdoptedSeal>();
  const newHandleId = options.newHandleId ?? (() => crypto.randomUUID());
  const now = (): Instant => parseInstant(options.clock.now());

  const currentConfiguration = (): NormalizedConnectionConfig | undefined => {
    const candidate = options.sourceConnections.resolve(bound);
    if (!candidate) return undefined;
    const normalized = normalizeConfiguration(candidate);
    if (!sameRef(normalized.binding, bound)) return undefined;
    const verifier = options.verifiers.resolve({
      contract: normalized.verifierContract,
      revisionId: normalized.verifierRevisionId
    });
    if (!verifier || !sameRef(verifier.contract, normalized.verifierContract) ||
      verifier.revisionId !== normalized.verifierRevisionId) return undefined;
    return normalized;
  };

  const isCurrent = (seal: StoredStagedSeal): boolean => {
    const current = currentConfiguration();
    return current !== undefined && sameConfiguration(seal.configuration, current);
  };

  const reader: VerifiedEnvelopeSealReader = Object.freeze({
    openStaged(handle: object) {
      return stagedSeals.get(handle)?.material;
    },
    openAdopted(handle: object) {
      return adoptedSeals.get(handle)?.material;
    },
    openCurrentStaged(handle: object) {
      const seal = stagedSeals.get(handle);
      return seal && isCurrent(seal) ? seal.material : undefined;
    },
    openCurrentAdopted(handle: object) {
      const seal = adoptedSeals.get(handle);
      return seal && isCurrent(seal) ? seal.material : undefined;
    },
    isCurrentRegistration(snapshot: VerifiedIngressConfigurationSnapshot) {
      const current = currentConfiguration();
      return current !== undefined &&
        canonicalJsonText(configurationSnapshot(current)) === canonicalJsonText(snapshot);
    }
  });

  const durableRecord = (input: {
    readonly seal: StoredStagedSeal;
    readonly intentId: string;
    readonly payloadRefId: PayloadRefId;
  }): VerifiedIngressDurableIntentRecord => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.intentId)) {
      throw new TypeError('verified ingress intent ID must be an application UUIDv4 or UUIDv7');
    }
    const material = input.seal.material;
    return Object.freeze({
      version: 1 as const,
      intentId: input.intentId.toLowerCase(),
      payloadRefId: parsePayloadRefId(input.payloadRefId),
      configuration: material.configuration,
      semanticIdentity: material.semanticIdentity,
      contentBindings: material.contentBindings,
      stage: normalizedStage(material.stage),
      expectedDescriptorBinding: serverKeyedValue(
        input.seal.configuration.semanticIdentityKeyBytes,
        'jooevents.verified-ingress.descriptor-binding.v1',
        material.expectedDescriptor,
        'idb1_'
      ),
      receivedAt: parseInstant(material.receivedAt)
    });
  };

  const recovery: VerifiedIngressRecoveryAuthority = Object.freeze({
    prepare(input: {
      readonly handle: VerifiedEnvelopeHandle;
      readonly intentId: string;
      readonly payloadRefId: PayloadRefId;
    }): VerifiedIngressDurableIntent {
      const seal = stagedSeals.get(input.handle);
      if (!seal || !isCurrent(seal)) throw new TypeError('unsealed_or_stale_verified_envelope');
      const record = durableRecord({
        seal,
        intentId: input.intentId,
        payloadRefId: input.payloadRefId
      });
      return Object.freeze({
        record,
        authenticator: serverKeyedValue(
          seal.configuration.semanticIdentityKeyBytes,
          'jooevents.verified-ingress.durable-intent.v1',
          record,
          'via1_'
        )
      });
    },
    verifyCurrent(intentValue: unknown): VerifiedIngressIntentVerificationResult {
      const intent = durableIntentFromUnknown(intentValue);
      if (!intent) return Object.freeze({ kind: 'invalid' });
      const current = currentConfiguration();
      if (!current || canonicalJsonText(configurationSnapshot(current)) !==
        canonicalJsonText(intent.record.configuration)) {
        return Object.freeze({ kind: 'stale_registration' });
      }
      const expectedAuthenticator = serverKeyedValue(
        current.semanticIdentityKeyBytes,
        'jooevents.verified-ingress.durable-intent.v1',
        intent.record,
        'via1_'
      );
      return sameServerKeyedValue(intent.authenticator, expectedAuthenticator)
        ? Object.freeze({ kind: 'verified', intent })
        : Object.freeze({ kind: 'invalid' });
    },
    async reseal(input: {
      readonly intent: unknown;
      readonly candidate: PayloadStageReconciliationCandidate;
    }): Promise<VerifiedIngressRecoveryResult> {
      const verification = recovery.verifyCurrent(input.intent);
      if (verification.kind !== 'verified') return verification;
      const intent = verification.intent;
      const current = currentConfiguration();
      if (!current || canonicalJsonText(configurationSnapshot(current)) !==
        canonicalJsonText(intent.record.configuration)) {
        return Object.freeze({ kind: 'stale_registration' });
      }
      let inspection: PayloadStageInspection;
      try {
        inspection = await options.stageStore.inspect({
          source: 'reconciliation',
          candidate: input.candidate
        });
      } catch {
        return Object.freeze({ kind: 'invalid' });
      }
      let inspectionStage: AuthenticatedPayloadStageDescriptor;
      let descriptor: ClassifiedPayloadDescriptor;
      try {
        inspectionStage = normalizedStage(inspection.stage);
        descriptor = normalizedDescriptor(inspection.classified);
      } catch {
        return Object.freeze({ kind: 'invalid' });
      }
      const record = intent.record;
      if (inspectionStage.stageId !== record.stage.stageId ||
        !sameServerKeyedValue(
          record.expectedDescriptorBinding,
          serverKeyedValue(
            current.semanticIdentityKeyBytes,
            'jooevents.verified-ingress.descriptor-binding.v1',
            descriptor,
            'idb1_'
          )
        )) {
        return Object.freeze({ kind: 'invalid' });
      }
      const material = frozenMaterial({
        handleId: parseVerifiedEnvelopeHandleId(crypto.randomUUID()),
        binding: current.binding,
        sourceConnectionId: current.sourceConnectionId,
        sourceConnectionRevisionId: current.sourceConnectionRevisionId,
        scope: current.scope,
        verifierContract: current.verifierContract,
        verifierRevisionId: current.verifierRevisionId,
        configuration: intent.record.configuration,
        semanticIdentity: record.semanticIdentity,
        contentBindings: record.contentBindings,
        stage: record.stage,
        expectedDescriptor: descriptor,
        receivedAt: record.receivedAt
      });
      if (inspection.state === 'staged') {
        if (inspection.payloadRef || canonicalJsonText(inspectionStage) !== canonicalJsonText(record.stage)) {
          return Object.freeze({ kind: 'invalid' });
        }
        const handle = Object.freeze({ id: material.handleId }) as VerifiedEnvelopeHandle;
        stagedSeals.set(handle, { configuration: current, material });
        return Object.freeze({ kind: 'staged', handle });
      }
      if (inspection.state !== 'adoption_pending' ||
        !inspection.payloadRef || inspection.payloadRef.id !== record.payloadRefId ||
        Number(inspectionStage.expectedVersion) !== Number(record.stage.expectedVersion) + 1 ||
        Number(inspectionStage.fence) !== Number(record.stage.fence) + 1 ||
        inspectionStage.expiresAt !== record.stage.expiresAt ||
        canonicalJsonText(inspectionStage.reconciliationPolicy) !== canonicalJsonText(record.stage.reconciliationPolicy) ||
        canonicalJsonText(inspectionStage.authenticationProfile) !== canonicalJsonText(record.stage.authenticationProfile)) {
        return Object.freeze({ kind: 'invalid' });
      }
      const adoptedHandle = Object.freeze({
        id: parseVerifiedEnvelopeHandleId(crypto.randomUUID())
      }) as AdoptedVerifiedEnvelopeHandle;
      const adoptedMaterial = Object.freeze({
        ...material,
        adoptionHandleId: adoptedHandle.id,
        adoptedStage: inspectionStage,
        payloadRef: createPayloadRef(record.payloadRefId)
      });
      adoptedSeals.set(adoptedHandle, { configuration: current, material: adoptedMaterial });
      return Object.freeze({ kind: 'adoption_pending', handle: adoptedHandle });
    }
  });

  const boundary: VerifiedIngressBoundary = {
    sealReader: reader,
    recovery,
    async verifyAndStage(input: {
      readonly rawEnvelope: Uint8Array;
      readonly protocolEvidence: unknown;
    }): Promise<VerifiedIngressStageResult> {
      const configuration = currentConfiguration();
      if (!configuration) {
        return { kind: 'rejected', reason: 'source_connection_unavailable' };
      }
      if (!(input.rawEnvelope instanceof Uint8Array) ||
        input.rawEnvelope.byteLength > configuration.maximumRawEnvelopeBytes) {
        return { kind: 'rejected', reason: 'raw_envelope_too_large' };
      }
      const verifier = options.verifiers.resolve({
        contract: configuration.verifierContract,
        revisionId: configuration.verifierRevisionId
      });
      if (!verifier || !sameRef(verifier.contract, configuration.verifierContract) ||
        verifier.revisionId !== configuration.verifierRevisionId) {
        return { kind: 'rejected', reason: 'verifier_unavailable' };
      }
      const receivedAt = now();
      const verification = await verifier.verify({
        rawEnvelope: Uint8Array.from(input.rawEnvelope),
        protocolEvidence: input.protocolEvidence,
        receivedAt,
        sourceConnectionId: configuration.sourceConnectionId
      });
      if (verification.kind === 'rejected') {
        if (verification.reason !== 'invalid_authenticity' &&
          verification.reason !== 'replay_window' &&
          verification.reason !== 'malformed_envelope' &&
          verification.reason !== 'ambiguous_evidence') {
          return { kind: 'rejected', reason: 'normalized_content_invalid' };
        }
        return Object.freeze({ kind: 'rejected' as const, reason: verification.reason });
      }
      if (!(verification.semanticIdentityMaterial instanceof Uint8Array) ||
        verification.semanticIdentityMaterial.byteLength === 0 ||
        verification.semanticIdentityMaterial.byteLength > VERIFIED_INGRESS_LIMITS.maximumSemanticIdentityMaterialBytes ||
        !(verification.normalizedRetainedContent instanceof Uint8Array) ||
        verification.normalizedRetainedContent.byteLength === 0 ||
        verification.normalizedRetainedContent.byteLength > configuration.maximumNormalizedContentBytes) {
        return { kind: 'rejected', reason: 'normalized_content_invalid' };
      }
      const semanticMaterial = concat(
        encoder.encode(`${configuration.sourceConnectionId}\0`),
        Uint8Array.from(verification.semanticIdentityMaterial)
      );
      const semanticIdentity = `si1_${base64Url(await hmac(
        configuration.semanticIdentityKeyBytes,
        'jooevents.verified-ingress.semantic-identity.v1',
        configuration.semanticIdentityProfile,
        semanticMaterial
      ))}`;
      const normalizedBytes = Uint8Array.from(verification.normalizedRetainedContent);
      const bindings = await Promise.all(configuration.contentBindingProfiles.map(async (profile) => ({
        profile: profile.profile,
        value: `kb1_${base64Url(await hmac(
          profile.keyBytes,
          'jooevents.verified-inbox.content-binding.v1',
          profile.profile,
          normalizedBytes
        ))}`,
        keyVerifier: keyVerifier(
          'jooevents.verified-inbox.key-verifier.v1',
          profile.profile,
          profile.keyBytes,
          'ikv1_'
        )
      })));
      const primary = bindings[0];
      if (!primary) return { kind: 'rejected', reason: 'normalized_content_invalid' };
      const expectedDescriptor = createClassifiedPayloadDescriptor({
        profiles: configuration.classifiedPayloadProfiles,
        scopeBinding: canonicalJsonText(configuration.scope),
        contentType: configuration.normalizedContentType,
        byteSize: normalizedBytes.byteLength,
        integrityDigest: await sha256(normalizedBytes)
      });
      const expiresAt = parseInstant(
        new Date(Date.parse(receivedAt) + configuration.stageTtlMs).toISOString()
      );
      const returnedStage = await options.stageStore.put({
        descriptor: expectedDescriptor,
        bytes: normalizedBytes,
        expiresAt,
        reconciliationPolicy: configuration.reconciliationPolicy
      });
      const stage = createAuthenticatedPayloadStageDescriptor({
        stageId: returnedStage.stageId,
        expectedVersion: returnedStage.expectedVersion,
        fence: returnedStage.fence,
        expiresAt: returnedStage.expiresAt,
        reconciliationPolicy: returnedStage.reconciliationPolicy,
        authenticationProfile: returnedStage.authenticationProfile,
        authenticationTag: returnedStage.authenticationTag
      });
      const handle = Object.freeze({
        id: parseVerifiedEnvelopeHandleId(newHandleId())
      }) as VerifiedEnvelopeHandle;
      const material = frozenMaterial({
        handleId: handle.id,
        binding: configuration.binding,
        sourceConnectionId: configuration.sourceConnectionId,
        sourceConnectionRevisionId: configuration.sourceConnectionRevisionId,
        scope: configuration.scope,
        verifierContract: configuration.verifierContract,
        verifierRevisionId: configuration.verifierRevisionId,
        configuration: configurationSnapshot(configuration),
        semanticIdentity,
        contentBindings: Object.freeze([primary, ...bindings.slice(1)]),
        stage,
        expectedDescriptor,
        receivedAt
      });
      stagedSeals.set(handle, { configuration, material });
      return { kind: 'staged', handle };
    },
    async adopt(input: {
      readonly handle: VerifiedEnvelopeHandle;
      readonly payloadRefId: PayloadRefId;
    }): Promise<AdoptedVerifiedEnvelopeHandle> {
      const seal = stagedSeals.get(input.handle);
      if (!seal || !isCurrent(seal)) throw new TypeError('unsealed_or_stale_verified_envelope');
      const payloadRefId = parsePayloadRefId(input.payloadRefId);
      const adoption = await options.stageStore.adopt({
        stage: seal.material.stage,
        expectedDescriptor: seal.material.expectedDescriptor,
        payloadRefId,
        at: now()
      });
      if (adoption.payloadRef.id !== payloadRefId) throw new TypeError('verified_ingress_adoption_mismatch');
      const adoptedHandle = Object.freeze({
        id: parseVerifiedEnvelopeHandleId(newHandleId())
      }) as AdoptedVerifiedEnvelopeHandle;
      const continuation = createAuthenticatedPayloadStageDescriptor({
        stageId: adoption.continuation.stageId,
        expectedVersion: adoption.continuation.expectedVersion,
        fence: adoption.continuation.fence,
        expiresAt: adoption.continuation.expiresAt,
        reconciliationPolicy: adoption.continuation.reconciliationPolicy,
        authenticationProfile: adoption.continuation.authenticationProfile,
        authenticationTag: adoption.continuation.authenticationTag
      });
      const material = Object.freeze({
        ...seal.material,
        adoptionHandleId: adoptedHandle.id,
        adoptedStage: continuation,
        payloadRef: createPayloadRef(payloadRefId)
      });
      adoptedSeals.set(adoptedHandle, { configuration: seal.configuration, material });
      return adoptedHandle;
    },
    async markAdopted(handle: AdoptedVerifiedEnvelopeHandle): Promise<PayloadRef> {
      const seal = adoptedSeals.get(handle);
      if (!seal) throw new TypeError('unsealed_adopted_verified_envelope');
      const marked = await options.stageStore.markAdopted({
        stage: seal.material.adoptedStage,
        payloadRef: seal.material.payloadRef
      });
      return marked.payloadRef;
    }
  };
  return Object.freeze(boundary);
}
