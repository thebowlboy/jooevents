import type { VersionedDefinitionRef } from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type AuditEventId,
  type CeremonyEvidenceId,
  type Clock,
  type ContractVersion,
  type EventScopeRef,
  type Instant,
  type PublicPolicyRevisionId
} from '@jooevents/kernel';
import { createHmac, randomBytes as secureRandomBytes } from 'node:crypto';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const opaqueActionAnchorPattern = /^pma_[A-Za-z0-9_-]{16,240}$/;
const opaqueEvidencePatterns = Object.freeze({
  originEvidenceId: /^poe_[A-Za-z0-9_-]{16,240}$/,
  csrfEvidenceId: /^pce_[A-Za-z0-9_-]{16,240}$/,
  rateLimitEvidenceId: /^pre_[A-Za-z0-9_-]{16,240}$/,
  replayEvidenceId: /^ppe_[A-Za-z0-9_-]{16,240}$/
});
const rawContinuationPattern = /^gsr_[A-Za-z0-9_-]{43}$/;

export const PUBLIC_MUTATION_CONTINUATION_LIMITS = Object.freeze({
  continuationEntropyBytes: 32,
  maximumLifetimeMs: 15 * 60 * 1_000,
  maximumVerificationProfiles: 8,
  maximumVerifierMaterialBytes: 512
});

export interface PublicMutationContinuationKeyProfile {
  readonly reference: VersionedDefinitionRef;
  readonly keyBytes: Uint8Array;
}

export interface PublicMutationContinuationPolicy {
  readonly binding: VersionedDefinitionRef;
  readonly publicPolicyRevisionId: PublicPolicyRevisionId;
  readonly operation: {
    readonly name: string;
    readonly version: ContractVersion;
  };
  readonly scope: EventScopeRef;
  readonly purpose: string;
  readonly action: string;
  /** Opaque server-held action/draft identity. It is never selected by a request body. */
  readonly actionAnchorId: string;
  readonly lifetimeMs: number;
  readonly bootstrapVerifier: VersionedDefinitionRef;
  readonly originPolicy: VersionedDefinitionRef;
  readonly csrfPolicy: VersionedDefinitionRef;
  readonly rateLimitPolicy: VersionedDefinitionRef;
  readonly replayPolicy: VersionedDefinitionRef;
  /** Primary mint profile first, then retained profiles accepted during the lifetime. */
  readonly continuationProfiles: readonly [
    PublicMutationContinuationKeyProfile,
    ...PublicMutationContinuationKeyProfile[]
  ];
  readonly principalPartitionProfile: PublicMutationContinuationKeyProfile;
  readonly bootstrapReplayProfile: PublicMutationContinuationKeyProfile;
}

export interface PublicMutationContinuationPolicyRegistry {
  resolve(binding: VersionedDefinitionRef): PublicMutationContinuationPolicy | undefined;
}

export const PUBLIC_MUTATION_BOOTSTRAP_REJECTION_REASONS = [
  'origin_rejected',
  'csrf_rejected',
  'rate_limited',
  'replay_rejected',
  'verifier_invalid'
] as const;

export type PublicMutationBootstrapRejectionReason =
  (typeof PUBLIC_MUTATION_BOOTSTRAP_REJECTION_REASONS)[number];

export type PublicMutationBootstrapVerification =
  | {
      readonly kind: 'verified';
      readonly principalPartitionMaterial: Uint8Array;
      readonly bootstrapReplayMaterial: Uint8Array;
      readonly originEvidenceId: string;
      readonly csrfEvidenceId: string;
      readonly rateLimitEvidenceId: string;
      readonly replayEvidenceId: string;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: Exclude<PublicMutationBootstrapRejectionReason, 'verifier_invalid'>;
    };

type NormalizedPublicMutationBootstrapVerification =
  | Extract<PublicMutationBootstrapVerification, { readonly kind: 'verified' }>
  | { readonly kind: 'rejected'; readonly reason: PublicMutationBootstrapRejectionReason };

export interface RegisteredPublicMutationBootstrapVerifier {
  readonly reference: VersionedDefinitionRef;
  verify(input: {
    readonly protocolEvidence: unknown;
    readonly receivedAt: Instant;
    readonly binding: VersionedDefinitionRef;
    readonly originPolicy: VersionedDefinitionRef;
    readonly csrfPolicy: VersionedDefinitionRef;
    readonly rateLimitPolicy: VersionedDefinitionRef;
    readonly replayPolicy: VersionedDefinitionRef;
  }): PublicMutationBootstrapVerification | Promise<PublicMutationBootstrapVerification>;
}

export interface PublicMutationBootstrapVerifierRegistry {
  resolve(reference: VersionedDefinitionRef): RegisteredPublicMutationBootstrapVerifier | undefined;
}

export interface PublicMutationContinuationProfileSnapshot {
  readonly reference: VersionedDefinitionRef;
  readonly keyVerifier: string;
}

export interface PublicMutationContinuationConfigurationSnapshot {
  readonly version: 1;
  readonly binding: VersionedDefinitionRef;
  readonly publicPolicyRevisionId: PublicPolicyRevisionId;
  readonly operation: {
    readonly name: string;
    readonly version: ContractVersion;
  };
  readonly scope: EventScopeRef;
  readonly purpose: string;
  readonly action: string;
  readonly actionAnchorId: string;
  readonly lifetimeMs: number;
  readonly bootstrapVerifier: VersionedDefinitionRef;
  readonly originPolicy: VersionedDefinitionRef;
  readonly csrfPolicy: VersionedDefinitionRef;
  readonly rateLimitPolicy: VersionedDefinitionRef;
  readonly replayPolicy: VersionedDefinitionRef;
  readonly continuationProfiles: readonly [
    PublicMutationContinuationProfileSnapshot,
    ...PublicMutationContinuationProfileSnapshot[]
  ];
  readonly principalPartitionProfile: PublicMutationContinuationProfileSnapshot;
  readonly bootstrapReplayProfile: PublicMutationContinuationProfileSnapshot;
}

export interface PublicMutationContinuationAlias {
  readonly profile: PublicMutationContinuationProfileSnapshot;
  readonly verifier: string;
}

export interface PublicMutationStoredCeremony {
  readonly ceremonyEvidenceId: CeremonyEvidenceId;
  readonly configuration: PublicMutationContinuationConfigurationSnapshot;
  readonly principalPartitionKey: string;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly state: 'ready' | 'terminal';
  readonly completionReference: string | null;
}

export type PublicMutationContinuationSecurityAuditDisposition =
  | 'bootstrap_rejected'
  | 'mint_issued'
  | 'mint_already_issued'
  | 'continuation_admitted'
  | 'continuation_terminal_replay'
  | 'continuation_stopped'
  | 'proof_terminal'
  | 'proof_replay'
  | 'proof_stopped';

export interface PublicMutationContinuationSecurityAuditInput {
  readonly auditEventId: AuditEventId;
  readonly ceremonyEvidenceId: CeremonyEvidenceId | null;
  readonly configuration: PublicMutationContinuationConfigurationSnapshot;
  readonly disposition: PublicMutationContinuationSecurityAuditDisposition;
  readonly reasonCode: string;
  readonly recordedAt: Instant;
  readonly originEvidenceId: string | null;
  readonly csrfEvidenceId: string | null;
  readonly rateLimitEvidenceId: string | null;
  readonly replayEvidenceId: string | null;
}

export interface PublicMutationContinuationStore {
  recordBootstrapRejection(input: PublicMutationContinuationSecurityAuditInput): void;
  mint(input: {
    readonly ceremonyEvidenceId: CeremonyEvidenceId;
    readonly configuration: PublicMutationContinuationConfigurationSnapshot;
    readonly principalPartitionKey: string;
    readonly bootstrapReplayVerifier: string;
    readonly aliases: readonly [
      PublicMutationContinuationAlias,
      ...PublicMutationContinuationAlias[]
    ];
    readonly createdAt: Instant;
    readonly expiresAt: Instant;
    readonly audit: PublicMutationContinuationSecurityAuditInput;
  }):
    | { readonly kind: 'issued'; readonly ceremony: PublicMutationStoredCeremony }
    | { readonly kind: 'already_issued'; readonly ceremony: PublicMutationStoredCeremony };
  resolve(input: {
    readonly configuration: PublicMutationContinuationConfigurationSnapshot;
    readonly aliases: readonly [
      PublicMutationContinuationAlias,
      ...PublicMutationContinuationAlias[]
    ];
    readonly now: Instant;
    readonly auditEventId: AuditEventId;
  }):
    | { readonly kind: 'ready'; readonly ceremony: PublicMutationStoredCeremony }
    | {
        readonly kind: 'terminal';
        readonly ceremony: PublicMutationStoredCeremony;
        readonly completionReference: string;
      }
    | {
        readonly kind: 'stopped';
        readonly reason: 'not_available' | 'expired' | 'revoked' | 'policy_changed';
      };
}

declare const publicMutationContinuationEvidenceBrand: unique symbol;

/** Runtime authenticity is held only in the boundary's WeakMap. */
export interface PublicMutationContinuationEvidence {
  readonly ceremonyEvidenceId: CeremonyEvidenceId;
  readonly [publicMutationContinuationEvidenceBrand]: true;
}

export interface SealedPublicMutationContinuationMaterial {
  readonly ceremonyEvidenceId: CeremonyEvidenceId;
  readonly configuration: PublicMutationContinuationConfigurationSnapshot;
  readonly principalPartitionKey: string;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
}

export interface PublicMutationContinuationSealReader {
  open(evidence: object): SealedPublicMutationContinuationMaterial | undefined;
  /** Rechecks exact current source registration and trusted expiry, but not the SQL row. */
  openCurrent(evidence: object): SealedPublicMutationContinuationMaterial | undefined;
}

export type PublicMutationContinuationMintResult =
  | {
      readonly kind: 'issued';
      readonly continuation: string;
      readonly expiresAt: Instant;
    }
  | { readonly kind: 'already_issued'; readonly expiresAt: Instant }
  | { readonly kind: 'rejected'; readonly reason: PublicMutationBootstrapRejectionReason }
  | { readonly kind: 'unavailable' };

export type PublicMutationContinuationAdmissionResult =
  | { readonly kind: 'ready'; readonly evidence: PublicMutationContinuationEvidence }
  | { readonly kind: 'terminal'; readonly completionReference: string }
  | {
      readonly kind: 'stopped';
      readonly reason: 'not_available' | 'expired' | 'revoked' | 'policy_changed';
    };

export interface PublicMutationContinuationBoundary {
  readonly sealReader: PublicMutationContinuationSealReader;
  mint(input: { readonly protocolEvidence: unknown }): Promise<PublicMutationContinuationMintResult>;
  admit(input: { readonly continuation: string }): PublicMutationContinuationAdmissionResult;
}

export interface PublicMutationContinuationBoundaryOptions {
  readonly binding: VersionedDefinitionRef;
  readonly policies: PublicMutationContinuationPolicyRegistry;
  readonly bootstrapVerifiers: PublicMutationBootstrapVerifierRegistry;
  readonly store: PublicMutationContinuationStore;
  readonly clock: Clock;
  readonly newCeremonyEvidenceId: () => CeremonyEvidenceId;
  readonly newAuditEventId: () => AuditEventId;
  readonly randomBytes?: (size: number) => Uint8Array;
}

interface NormalizedKeyProfile {
  readonly reference: VersionedDefinitionRef;
  readonly keyBytes: Uint8Array;
}

interface NormalizedPolicy extends Omit<
  PublicMutationContinuationPolicy,
  | 'binding'
  | 'publicPolicyRevisionId'
  | 'operation'
  | 'scope'
  | 'bootstrapVerifier'
  | 'originPolicy'
  | 'csrfPolicy'
  | 'rateLimitPolicy'
  | 'replayPolicy'
  | 'continuationProfiles'
  | 'principalPartitionProfile'
  | 'bootstrapReplayProfile'
> {
  readonly binding: VersionedDefinitionRef;
  readonly publicPolicyRevisionId: PublicPolicyRevisionId;
  readonly operation: { readonly name: string; readonly version: ContractVersion };
  readonly scope: EventScopeRef;
  readonly bootstrapVerifier: VersionedDefinitionRef;
  readonly originPolicy: VersionedDefinitionRef;
  readonly csrfPolicy: VersionedDefinitionRef;
  readonly rateLimitPolicy: VersionedDefinitionRef;
  readonly replayPolicy: VersionedDefinitionRef;
  readonly continuationProfiles: readonly [NormalizedKeyProfile, ...NormalizedKeyProfile[]];
  readonly principalPartitionProfile: NormalizedKeyProfile;
  readonly bootstrapReplayProfile: NormalizedKeyProfile;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function definitionRef(value: VersionedDefinitionRef): VersionedDefinitionRef {
  if (!value || typeof value.key !== 'string' || !stableKeyPattern.test(value.key)) {
    throw new TypeError('public mutation definition key is invalid');
  }
  return Object.freeze({ key: value.key, version: parseContractVersion(value.version) });
}

function keyProfile(value: PublicMutationContinuationKeyProfile): NormalizedKeyProfile {
  if (!(value.keyBytes instanceof Uint8Array) || value.keyBytes.byteLength < 32 || value.keyBytes.byteLength > 128) {
    throw new TypeError('public mutation key profiles require 32 to 128 bytes');
  }
  return Object.freeze({
    reference: definitionRef(value.reference),
    keyBytes: Uint8Array.from(value.keyBytes)
  });
}

function normalizePolicy(value: PublicMutationContinuationPolicy): NormalizedPolicy {
  if (!Number.isSafeInteger(value.lifetimeMs) || value.lifetimeMs <= 0 ||
    value.lifetimeMs > PUBLIC_MUTATION_CONTINUATION_LIMITS.maximumLifetimeMs) {
    throw new TypeError('public mutation continuation lifetime is invalid');
  }
  if (!stableKeyPattern.test(value.operation.name) || !stableKeyPattern.test(value.purpose) ||
    !stableKeyPattern.test(value.action) || !opaqueActionAnchorPattern.test(value.actionAnchorId)) {
    throw new TypeError('public mutation action binding is invalid');
  }
  if (value.continuationProfiles.length === 0 ||
    value.continuationProfiles.length > PUBLIC_MUTATION_CONTINUATION_LIMITS.maximumVerificationProfiles) {
    throw new TypeError('public mutation continuation profile set is invalid');
  }
  const continuationProfiles = value.continuationProfiles.map(keyProfile);
  const profileIdentities = continuationProfiles.map((profile) => canonicalJsonText(profile.reference));
  if (new Set(profileIdentities).size !== profileIdentities.length) {
    throw new TypeError('public mutation continuation profiles must be unique');
  }
  const first = continuationProfiles[0];
  if (!first) throw new TypeError('public mutation continuation needs a primary profile');
  return Object.freeze({
    binding: definitionRef(value.binding),
    publicPolicyRevisionId: parsePublicPolicyRevisionId(value.publicPolicyRevisionId),
    operation: Object.freeze({
      name: value.operation.name,
      version: parseContractVersion(value.operation.version)
    }),
    scope: Object.freeze({
      kind: 'event' as const,
      workspaceId: parseWorkspaceId(value.scope.workspaceId),
      eventId: parseEventId(value.scope.eventId)
    }),
    purpose: value.purpose,
    action: value.action,
    actionAnchorId: value.actionAnchorId,
    lifetimeMs: value.lifetimeMs,
    bootstrapVerifier: definitionRef(value.bootstrapVerifier),
    originPolicy: definitionRef(value.originPolicy),
    csrfPolicy: definitionRef(value.csrfPolicy),
    rateLimitPolicy: definitionRef(value.rateLimitPolicy),
    replayPolicy: definitionRef(value.replayPolicy),
    continuationProfiles: Object.freeze([first, ...continuationProfiles.slice(1)]) as readonly [
      NormalizedKeyProfile,
      ...NormalizedKeyProfile[]
    ],
    principalPartitionProfile: keyProfile(value.principalPartitionProfile),
    bootstrapReplayProfile: keyProfile(value.bootstrapReplayProfile)
  });
}

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function hmac(
  key: Uint8Array,
  namespace: string,
  profile: VersionedDefinitionRef,
  context: unknown,
  material?: Uint8Array
): string {
  const state = createHmac('sha256', key)
    .update(`${namespace}\0`, 'utf8')
    .update(canonicalJsonText(profile), 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJsonText(context), 'utf8');
  if (material) state.update('\0', 'utf8').update(material);
  return state.digest('hex');
}

function profileSnapshot(
  profile: NormalizedKeyProfile,
  namespace: string,
  prefix: 'pck1_' | 'ppk1_' | 'prk1_'
): PublicMutationContinuationProfileSnapshot {
  return Object.freeze({
    reference: profile.reference,
    keyVerifier: `${prefix}${hmac(profile.keyBytes, namespace, profile.reference, { purpose: 'key-verifier' })}`
  });
}

function configurationSnapshot(policy: NormalizedPolicy): PublicMutationContinuationConfigurationSnapshot {
  const continuationProfiles = policy.continuationProfiles.map((profile) =>
    profileSnapshot(
      profile,
      'jooevents.public-mutation.continuation-key.v1',
      'pck1_'
    ));
  const first = continuationProfiles[0];
  if (!first) throw new TypeError('public mutation continuation needs a primary profile');
  return Object.freeze({
    version: 1 as const,
    binding: policy.binding,
    publicPolicyRevisionId: policy.publicPolicyRevisionId,
    operation: policy.operation,
    scope: policy.scope,
    purpose: policy.purpose,
    action: policy.action,
    actionAnchorId: policy.actionAnchorId,
    lifetimeMs: policy.lifetimeMs,
    bootstrapVerifier: policy.bootstrapVerifier,
    originPolicy: policy.originPolicy,
    csrfPolicy: policy.csrfPolicy,
    rateLimitPolicy: policy.rateLimitPolicy,
    replayPolicy: policy.replayPolicy,
    continuationProfiles: Object.freeze([first, ...continuationProfiles.slice(1)]) as readonly [
      PublicMutationContinuationProfileSnapshot,
      ...PublicMutationContinuationProfileSnapshot[]
    ],
    principalPartitionProfile: profileSnapshot(
      policy.principalPartitionProfile,
      'jooevents.public-mutation.principal-partition-key.v1',
      'ppk1_'
    ),
    bootstrapReplayProfile: profileSnapshot(
      policy.bootstrapReplayProfile,
      'jooevents.public-mutation.bootstrap-replay-key.v1',
      'prk1_'
    )
  });
}

function bindingContext(snapshot: PublicMutationContinuationConfigurationSnapshot): unknown {
  return {
    binding: snapshot.binding,
    publicPolicyRevisionId: snapshot.publicPolicyRevisionId,
    operation: snapshot.operation,
    scope: snapshot.scope,
    purpose: snapshot.purpose,
    action: snapshot.action,
    actionAnchorId: snapshot.actionAnchorId
  };
}

function continuationAliases(
  policy: NormalizedPolicy,
  snapshot: PublicMutationContinuationConfigurationSnapshot,
  continuation: string
): readonly [PublicMutationContinuationAlias, ...PublicMutationContinuationAlias[]] {
  const aliases = policy.continuationProfiles.map((profile, index) => Object.freeze({
    profile: snapshot.continuationProfiles[index] as PublicMutationContinuationProfileSnapshot,
    verifier: `pcv1_${hmac(
      profile.keyBytes,
      'jooevents.public-mutation.continuation-verifier.v1',
      profile.reference,
      bindingContext(snapshot),
      new TextEncoder().encode(continuation)
    )}`
  }));
  const first = aliases[0];
  if (!first) throw new TypeError('public mutation continuation needs a verification alias');
  return Object.freeze([first, ...aliases.slice(1)]);
}

function boundedMaterial(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 ||
    value.byteLength > PUBLIC_MUTATION_CONTINUATION_LIMITS.maximumVerifierMaterialBytes) {
    throw new TypeError(`${label} is invalid`);
  }
  return Uint8Array.from(value);
}

function normalizeVerification(value: unknown): NormalizedPublicMutationBootstrapVerification {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    return { kind: 'rejected', reason: 'verifier_invalid' };
  }
  if (value.kind === 'rejected') {
    if (!hasExactKeys(value, ['kind', 'reason']) ||
      !PUBLIC_MUTATION_BOOTSTRAP_REJECTION_REASONS.slice(0, 4).includes(value.reason as never)) {
      return { kind: 'rejected', reason: 'verifier_invalid' };
    }
    return Object.freeze({
      kind: 'rejected',
      reason: value.reason as Exclude<PublicMutationBootstrapRejectionReason, 'verifier_invalid'>
    });
  }
  if (value.kind !== 'verified' || !hasExactKeys(value, [
    'kind',
    'principalPartitionMaterial',
    'bootstrapReplayMaterial',
    'originEvidenceId',
    'csrfEvidenceId',
    'rateLimitEvidenceId',
    'replayEvidenceId'
  ])) {
    return { kind: 'rejected', reason: 'verifier_invalid' };
  }
  try {
    for (const [key, pattern] of Object.entries(opaqueEvidencePatterns)) {
      if (typeof value[key] !== 'string' || !pattern.test(value[key] as string)) throw new TypeError();
    }
    return Object.freeze({
      kind: 'verified',
      principalPartitionMaterial: boundedMaterial(
        value.principalPartitionMaterial,
        'public mutation principal material'
      ),
      bootstrapReplayMaterial: boundedMaterial(
        value.bootstrapReplayMaterial,
        'public mutation replay material'
      ),
      originEvidenceId: value.originEvidenceId as string,
      csrfEvidenceId: value.csrfEvidenceId as string,
      rateLimitEvidenceId: value.rateLimitEvidenceId as string,
      replayEvidenceId: value.replayEvidenceId as string
    });
  } catch {
    return { kind: 'rejected', reason: 'verifier_invalid' };
  }
}

function instantAfter(value: Instant, milliseconds: number): Instant {
  return parseInstant(new Date(Date.parse(value) + milliseconds).toISOString());
}

/**
 * Builds one unactivated, binding-specific security boundary. It mints and verifies
 * evidence only; it has no application-operation dispatch or domain mutation API.
 */
export function createPublicMutationContinuationBoundary(
  options: PublicMutationContinuationBoundaryOptions
): PublicMutationContinuationBoundary {
  const bound = definitionRef(options.binding);
  const seals = new WeakMap<object, SealedPublicMutationContinuationMaterial>();
  const random = options.randomBytes ?? ((size: number) => Uint8Array.from(secureRandomBytes(size)));

  const current = (): { readonly policy: NormalizedPolicy; readonly snapshot: PublicMutationContinuationConfigurationSnapshot; readonly verifier: RegisteredPublicMutationBootstrapVerifier } | undefined => {
    try {
      const candidate = options.policies.resolve(bound);
      if (!candidate) return undefined;
      const policy = normalizePolicy(candidate);
      if (!sameRef(policy.binding, bound)) return undefined;
      const verifier = options.bootstrapVerifiers.resolve(policy.bootstrapVerifier);
      if (!verifier || !sameRef(definitionRef(verifier.reference), policy.bootstrapVerifier)) return undefined;
      return Object.freeze({ policy, snapshot: configurationSnapshot(policy), verifier });
    } catch {
      return undefined;
    }
  };

  const now = (): Instant => parseInstant(options.clock.now());
  const auditId = (): AuditEventId => parseAuditEventId(options.newAuditEventId());

  const sealReader: PublicMutationContinuationSealReader = Object.freeze({
    open(evidence: object) {
      return seals.get(evidence);
    },
    openCurrent(evidence: object) {
      const material = seals.get(evidence);
      if (!material || Date.parse(now()) >= Date.parse(material.expiresAt)) return undefined;
      const registered = current();
      if (!registered || canonicalJsonText(registered.snapshot) !== canonicalJsonText(material.configuration)) {
        return undefined;
      }
      return material;
    }
  });

  return Object.freeze({
    sealReader,
    async mint(input: { readonly protocolEvidence: unknown }): Promise<PublicMutationContinuationMintResult> {
      const registered = current();
      if (!registered) return Object.freeze({ kind: 'unavailable' });
      const receivedAt = now();
      let verification: NormalizedPublicMutationBootstrapVerification;
      try {
        verification = normalizeVerification(await registered.verifier.verify({
          protocolEvidence: input.protocolEvidence,
          receivedAt,
          binding: registered.snapshot.binding,
          originPolicy: registered.snapshot.originPolicy,
          csrfPolicy: registered.snapshot.csrfPolicy,
          rateLimitPolicy: registered.snapshot.rateLimitPolicy,
          replayPolicy: registered.snapshot.replayPolicy
        }));
      } catch {
        verification = { kind: 'rejected', reason: 'verifier_invalid' };
      }
      if (verification.kind === 'rejected') {
        options.store.recordBootstrapRejection({
          auditEventId: auditId(),
          ceremonyEvidenceId: null,
          configuration: registered.snapshot,
          disposition: 'bootstrap_rejected',
          reasonCode: verification.reason,
          recordedAt: receivedAt,
          originEvidenceId: null,
          csrfEvidenceId: null,
          rateLimitEvidenceId: null,
          replayEvidenceId: null
        });
        return Object.freeze({ kind: 'rejected', reason: verification.reason });
      }

      const principalPartitionKey = `ppv1_${hmac(
        registered.policy.principalPartitionProfile.keyBytes,
        'jooevents.public-mutation.principal-partition.v1',
        registered.policy.principalPartitionProfile.reference,
        bindingContext(registered.snapshot),
        verification.principalPartitionMaterial
      )}`;
      const bootstrapReplayVerifier = `prv1_${hmac(
        registered.policy.bootstrapReplayProfile.keyBytes,
        'jooevents.public-mutation.bootstrap-replay-verifier.v1',
        registered.policy.bootstrapReplayProfile.reference,
        bindingContext(registered.snapshot),
        verification.bootstrapReplayMaterial
      )}`;
      const entropy = random(PUBLIC_MUTATION_CONTINUATION_LIMITS.continuationEntropyBytes);
      if (!(entropy instanceof Uint8Array) ||
        entropy.byteLength !== PUBLIC_MUTATION_CONTINUATION_LIMITS.continuationEntropyBytes) {
        throw new TypeError('public mutation continuation entropy source returned an invalid value');
      }
      const continuation = `gsr_${Buffer.from(entropy).toString('base64url')}`;
      if (!rawContinuationPattern.test(continuation)) {
        throw new TypeError('public mutation continuation encoding is invalid');
      }
      const aliases = continuationAliases(registered.policy, registered.snapshot, continuation);
      const expiresAt = instantAfter(receivedAt, registered.policy.lifetimeMs);
      const ceremonyEvidenceId = parseCeremonyEvidenceId(options.newCeremonyEvidenceId());
      const stored = options.store.mint({
        ceremonyEvidenceId,
        configuration: registered.snapshot,
        principalPartitionKey,
        bootstrapReplayVerifier,
        aliases,
        createdAt: receivedAt,
        expiresAt,
        audit: {
          auditEventId: auditId(),
          ceremonyEvidenceId,
          configuration: registered.snapshot,
          disposition: 'mint_issued',
          reasonCode: 'issued',
          recordedAt: receivedAt,
          originEvidenceId: verification.originEvidenceId,
          csrfEvidenceId: verification.csrfEvidenceId,
          rateLimitEvidenceId: verification.rateLimitEvidenceId,
          replayEvidenceId: verification.replayEvidenceId
        }
      });
      return stored.kind === 'issued'
        ? Object.freeze({ kind: 'issued', continuation, expiresAt: stored.ceremony.expiresAt })
        : Object.freeze({ kind: 'already_issued', expiresAt: stored.ceremony.expiresAt });
    },
    admit(input: { readonly continuation: string }): PublicMutationContinuationAdmissionResult {
      const registered = current();
      if (!registered) return Object.freeze({ kind: 'stopped', reason: 'policy_changed' });
      if (typeof input.continuation !== 'string' || !rawContinuationPattern.test(input.continuation)) {
        return Object.freeze({ kind: 'stopped', reason: 'not_available' });
      }
      const result = options.store.resolve({
        configuration: registered.snapshot,
        aliases: continuationAliases(
          registered.policy,
          registered.snapshot,
          input.continuation
        ),
        now: now(),
        auditEventId: auditId()
      });
      if (result.kind === 'terminal') {
        return Object.freeze({
          kind: 'terminal',
          completionReference: result.completionReference
        });
      }
      if (result.kind === 'stopped') return Object.freeze(result);
      const material = Object.freeze({
        ceremonyEvidenceId: result.ceremony.ceremonyEvidenceId,
        configuration: result.ceremony.configuration,
        principalPartitionKey: result.ceremony.principalPartitionKey,
        createdAt: result.ceremony.createdAt,
        expiresAt: result.ceremony.expiresAt
      });
      const evidence = Object.freeze({
        ceremonyEvidenceId: result.ceremony.ceremonyEvidenceId
      }) as PublicMutationContinuationEvidence;
      seals.set(evidence, material);
      return Object.freeze({ kind: 'ready', evidence });
    }
  });
}
