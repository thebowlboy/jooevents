import {
  createPayloadRef,
  parseAggregateVersion,
  parseContractVersion,
  parseInstant,
  parsePayloadRefId,
  parsePayloadStageId,
  type AggregateVersion,
  type Brand,
  type Clock,
  type ContractVersion,
  type Instant,
  type PayloadRef,
  type PayloadRefId,
  type PayloadStageId
} from '@jooevents/kernel';
import type { ReturnTypeOrPromise } from './operations';

const stableKeyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export type ClassifiedPayloadProfileKind =
  | 'classification'
  | 'schema'
  | 'content'
  | 'integrity'
  | 'descriptor_auth';

export interface ClassifiedPayloadProfileRef<Kind extends ClassifiedPayloadProfileKind = ClassifiedPayloadProfileKind> {
  readonly kind: Kind;
  readonly key: string;
  readonly version: ContractVersion;
}

export interface ClassifiedPayloadProfiles {
  readonly classification: ClassifiedPayloadProfileRef<'classification'>;
  readonly schema: ClassifiedPayloadProfileRef<'schema'>;
  readonly content: ClassifiedPayloadProfileRef<'content'>;
  readonly integrity: ClassifiedPayloadProfileRef<'integrity'>;
  readonly descriptorAuth: ClassifiedPayloadProfileRef<'descriptor_auth'>;
}

export interface StageReconciliationPolicyRef {
  readonly key: string;
  readonly version: ContractVersion;
}

declare const classifiedPayloadDescriptorBrand: unique symbol;

/** Server-only metadata. Safe application results carry only PayloadRef identity. */
export interface ClassifiedPayloadDescriptor {
  readonly [classifiedPayloadDescriptorBrand]: true;
  readonly profiles: ClassifiedPayloadProfiles;
  readonly scopeBinding: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly integrityDigest: string;
}

export type PayloadStageFence = Brand<number, 'PayloadStageFence'>;
export type StageDescriptorAuthenticationTag = Brand<string, 'StageDescriptorAuthenticationTag'>;
export type StageReconciliationCursor = Brand<string, 'StageReconciliationCursor'>;

declare const authenticatedStageDescriptorBrand: unique symbol;

/** Server-only authenticated handle to one immutable staged object revision. */
export interface AuthenticatedPayloadStageDescriptor {
  readonly [authenticatedStageDescriptorBrand]: true;
  readonly stageId: PayloadStageId;
  readonly expectedVersion: AggregateVersion;
  readonly fence: PayloadStageFence;
  readonly expiresAt: Instant;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly authenticationProfile: ClassifiedPayloadProfileRef<'descriptor_auth'>;
  readonly authenticationTag: StageDescriptorAuthenticationTag;
}

export interface PayloadStageReconciliationCandidate {
  readonly stageId: PayloadStageId;
  readonly expectedVersion: AggregateVersion;
  readonly fence: PayloadStageFence;
  readonly expiresAt: Instant;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
}

export interface PayloadStageInspection {
  readonly stage: AuthenticatedPayloadStageDescriptor;
  readonly classified: ClassifiedPayloadDescriptor;
  readonly state: 'staged' | 'adoption_pending' | 'adopted';
  readonly payloadRef?: PayloadRef;
}

export interface PayloadStageAdoptionResult {
  readonly kind: 'adopted' | 'replay';
  readonly payloadRef: PayloadRef;
  readonly continuation: AuthenticatedPayloadStageDescriptor;
}

export interface SafePayloadStageAdoptionResult {
  readonly kind: 'adopted' | 'replay';
  readonly payloadRef: PayloadRef;
}

export interface PayloadStageMarkResult {
  readonly kind: 'marked' | 'replay';
  readonly payloadRef: PayloadRef;
}

export interface PayloadStagePurgeResult {
  readonly kind: 'purged';
  readonly stageId: PayloadStageId;
}

export interface PayloadStageReconciliationPage {
  readonly candidates: readonly PayloadStageReconciliationCandidate[];
  readonly nextCursor?: StageReconciliationCursor;
}

declare const unadoptedStageProofBrand: unique symbol;

/**
 * Process-private, one-shot authority. Its public shape carries no cleanup
 * assertion; only the matching verifier can recover the checked claim.
 */
export interface UnadoptedStageProof {
  readonly [unadoptedStageProofBrand]: true;
}

export type CanonicalPayloadStageOwnership =
  | { readonly kind: 'unadopted' }
  | { readonly kind: 'adopted' }
  | { readonly kind: 'uncertain' };

export interface CanonicalPayloadStageOwnershipLookup {
  /**
   * Resolves the exact current candidate against canonical persistence. An
   * implementation may atomically acquire its durable cleanup claim before it
   * returns `unadopted`.
   */
  resolve(candidate: PayloadStageReconciliationCandidate): ReturnTypeOrPromise<CanonicalPayloadStageOwnership>;
}

export type UnadoptedStageProofIssueResult =
  | { readonly kind: 'issued'; readonly proof: UnadoptedStageProof }
  | { readonly kind: 'adopted' }
  | { readonly kind: 'uncertain' };

export type UnadoptedStageProofVerification =
  | { readonly kind: 'verified' }
  | { readonly kind: 'adopted' }
  | { readonly kind: 'uncertain' };

export interface UnadoptedStageProofVerifier {
  verifyAndConsume(input: {
    readonly candidate: PayloadStageReconciliationCandidate;
    readonly proof: UnadoptedStageProof;
  }): Promise<UnadoptedStageProofVerification>;
}

export interface UnadoptedStageProofAuthority {
  readonly verifier: UnadoptedStageProofVerifier;
  issue(input: {
    readonly candidate: PayloadStageReconciliationCandidate;
    readonly inspection: PayloadStageInspection;
  }): Promise<UnadoptedStageProofIssueResult>;
}

export type ClassifiedPayloadStageErrorCode =
  | 'invalid_descriptor_auth'
  | 'stage_not_found'
  | 'stale_stage_version'
  | 'stale_stage_fence'
  | 'stage_expired'
  | 'descriptor_mismatch'
  | 'adoption_conflict'
  | 'stage_not_purgeable'
  | 'proof_mismatch'
  | 'canonical_stage_adopted'
  | 'canonical_stage_ownership_uncertain'
  | 'unknown_profile'
  | 'profile_in_use'
  | 'invalid_cursor'
  | 'invalid_limit';

export class ClassifiedPayloadStageError extends Error {
  readonly code: ClassifiedPayloadStageErrorCode;

  constructor(code: ClassifiedPayloadStageErrorCode) {
    super(code);
    this.name = 'ClassifiedPayloadStageError';
    this.code = code;
  }
}

export interface ClassifiedPayloadStageStore {
  put(input: {
    readonly descriptor: ClassifiedPayloadDescriptor;
    readonly bytes: Uint8Array;
    readonly expiresAt: Instant;
    readonly reconciliationPolicy: StageReconciliationPolicyRef;
  }): Promise<AuthenticatedPayloadStageDescriptor>;
  inspect(input:
    | { readonly source: 'descriptor'; readonly stage: AuthenticatedPayloadStageDescriptor }
    | { readonly source: 'reconciliation'; readonly candidate: PayloadStageReconciliationCandidate }
  ): Promise<PayloadStageInspection>;
  adopt(input: {
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly expectedDescriptor: ClassifiedPayloadDescriptor;
    readonly payloadRefId: PayloadRefId;
    readonly at: Instant;
  }): Promise<PayloadStageAdoptionResult>;
  markAdopted(input: {
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly payloadRef: PayloadRef;
  }): Promise<PayloadStageMarkResult>;
  purge(input: {
    readonly candidate: PayloadStageReconciliationCandidate;
    readonly proof: UnadoptedStageProof;
  }): Promise<PayloadStagePurgeResult>;
  listReconciliationCandidates(input: {
    readonly cursor?: StageReconciliationCursor;
    readonly limit: number;
  }): Promise<PayloadStageReconciliationPage>;
}

export type PayloadStageOperationalAction = 'put' | 'inspect' | 'adopt' | 'mark' | 'purge';
export type PayloadStageOperationalOutcome = 'succeeded' | 'replayed' | 'refused';

export interface SafePayloadStageOperationalEvent {
  readonly stageId: PayloadStageId;
  readonly action: PayloadStageOperationalAction;
  readonly outcome: PayloadStageOperationalOutcome;
}

export function createClassifiedPayloadProfileRef<Kind extends ClassifiedPayloadProfileKind>(
  kind: Kind,
  key: string,
  version: number
): ClassifiedPayloadProfileRef<Kind> {
  if (!stableKeyPattern.test(key)) throw new TypeError('Classified payload profile key is invalid.');
  return Object.freeze({ kind, key, version: parseContractVersion(version) });
}

export function createStageReconciliationPolicyRef(key: string, version: number): StageReconciliationPolicyRef {
  if (!stableKeyPattern.test(key)) throw new TypeError('Stage reconciliation policy key is invalid.');
  return Object.freeze({ key, version: parseContractVersion(version) });
}

export function createClassifiedPayloadDescriptor(input: {
  readonly profiles: ClassifiedPayloadProfiles;
  readonly scopeBinding: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly integrityDigest: string;
}): ClassifiedPayloadDescriptor {
  if (!input.scopeBinding || input.scopeBinding.length > 256) throw new TypeError('Classified scope binding is invalid.');
  if (!input.contentType || input.contentType.length > 255) throw new TypeError('Classified content type is invalid.');
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) throw new TypeError('Classified byte size is invalid.');
  if (!sha256Pattern.test(input.integrityDigest)) throw new TypeError('Classified integrity digest is invalid.');
  return Object.freeze({
    profiles: Object.freeze({ ...input.profiles }),
    scopeBinding: input.scopeBinding,
    contentType: input.contentType,
    byteSize: input.byteSize,
    integrityDigest: input.integrityDigest
  }) as ClassifiedPayloadDescriptor;
}

export function createPayloadStageFence(value: number): PayloadStageFence {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Payload stage fence must be a positive safe integer.');
  return value as PayloadStageFence;
}

export function createAuthenticatedPayloadStageDescriptor(input: {
  readonly stageId: string;
  readonly expectedVersion: number;
  readonly fence: number;
  readonly expiresAt: string;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly authenticationProfile: ClassifiedPayloadProfileRef<'descriptor_auth'>;
  readonly authenticationTag: string;
}): AuthenticatedPayloadStageDescriptor {
  if (!sha256Pattern.test(input.authenticationTag)) throw new TypeError('Stage authentication tag is invalid.');
  return Object.freeze({
    stageId: parsePayloadStageId(input.stageId),
    expectedVersion: parseAggregateVersion(input.expectedVersion),
    fence: createPayloadStageFence(input.fence),
    expiresAt: parseInstant(input.expiresAt),
    reconciliationPolicy: input.reconciliationPolicy,
    authenticationProfile: input.authenticationProfile,
    authenticationTag: input.authenticationTag as StageDescriptorAuthenticationTag
  }) as AuthenticatedPayloadStageDescriptor;
}

interface UnadoptedStageProofRecord {
  readonly candidate: PayloadStageReconciliationCandidate;
  readonly checkedAt: Instant;
}

function normalizeReconciliationCandidate(
  candidate: PayloadStageReconciliationCandidate
): PayloadStageReconciliationCandidate {
  const policy = candidate.reconciliationPolicy;
  return Object.freeze({
    stageId: parsePayloadStageId(candidate.stageId),
    expectedVersion: parseAggregateVersion(Number(candidate.expectedVersion)),
    fence: createPayloadStageFence(Number(candidate.fence)),
    expiresAt: parseInstant(candidate.expiresAt),
    reconciliationPolicy: createStageReconciliationPolicyRef(policy.key, Number(policy.version))
  });
}

function sameReconciliationCandidate(
  left: PayloadStageReconciliationCandidate,
  right: PayloadStageReconciliationCandidate
): boolean {
  return left.stageId === right.stageId &&
    Number(left.expectedVersion) === Number(right.expectedVersion) &&
    Number(left.fence) === Number(right.fence) &&
    left.expiresAt === right.expiresAt &&
    left.reconciliationPolicy.key === right.reconciliationPolicy.key &&
    Number(left.reconciliationPolicy.version) === Number(right.reconciliationPolicy.version);
}

function closedOwnership(value: unknown): CanonicalPayloadStageOwnership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({ kind: 'uncertain' });
  const keys = Object.keys(value);
  const kind = (value as { readonly kind?: unknown }).kind;
  if (keys.length !== 1 || (kind !== 'unadopted' && kind !== 'adopted' && kind !== 'uncertain')) {
    return Object.freeze({ kind: 'uncertain' });
  }
  return Object.freeze({ kind });
}

/**
 * Creates one process-local cleanup authority. Restart recovery deliberately
 * creates a new authority and therefore must repeat the canonical lookup before
 * it can receive a new proof.
 */
export function createUnadoptedStageProofAuthority(input: {
  readonly clock: Clock;
  readonly ownership: CanonicalPayloadStageOwnershipLookup;
}): UnadoptedStageProofAuthority {
  const readClock = input.clock.now.bind(input.clock);
  const resolveOwnership = input.ownership.resolve.bind(input.ownership);
  const records = new WeakMap<object, UnadoptedStageProofRecord>();

  const lookup = async (
    candidate: PayloadStageReconciliationCandidate
  ): Promise<CanonicalPayloadStageOwnership> => {
    try {
      return closedOwnership(await resolveOwnership(candidate));
    } catch {
      return Object.freeze({ kind: 'uncertain' });
    }
  };

  const verifier: UnadoptedStageProofVerifier = Object.freeze({
    async verifyAndConsume(
      verificationInput: Parameters<UnadoptedStageProofVerifier['verifyAndConsume']>[0]
    ) {
      if (!verificationInput.proof || typeof verificationInput.proof !== 'object') {
        throw new ClassifiedPayloadStageError('proof_mismatch');
      }
      const record = records.get(verificationInput.proof as object);
      if (!record) throw new ClassifiedPayloadStageError('proof_mismatch');
      records.delete(verificationInput.proof as object);

      let candidate: PayloadStageReconciliationCandidate;
      try {
        candidate = normalizeReconciliationCandidate(verificationInput.candidate);
      } catch {
        throw new ClassifiedPayloadStageError('proof_mismatch');
      }
      if (!sameReconciliationCandidate(record.candidate, candidate)) {
        throw new ClassifiedPayloadStageError('proof_mismatch');
      }
      const verifiedAt = parseInstant(readClock());
      if (verifiedAt < candidate.expiresAt || verifiedAt < record.checkedAt) {
        throw new ClassifiedPayloadStageError('stage_not_purgeable');
      }
      const ownership = await lookup(candidate);
      return ownership.kind === 'unadopted'
        ? Object.freeze({ kind: 'verified' as const })
        : ownership;
    }
  });

  return Object.freeze({
    verifier,
    async issue(
      issueInput: Parameters<UnadoptedStageProofAuthority['issue']>[0]
    ): Promise<UnadoptedStageProofIssueResult> {
      let candidate: PayloadStageReconciliationCandidate;
      let inspected: PayloadStageReconciliationCandidate;
      try {
        candidate = normalizeReconciliationCandidate(issueInput.candidate);
        inspected = normalizeReconciliationCandidate({
          stageId: issueInput.inspection.stage.stageId,
          expectedVersion: issueInput.inspection.stage.expectedVersion,
          fence: issueInput.inspection.stage.fence,
          expiresAt: issueInput.inspection.stage.expiresAt,
          reconciliationPolicy: issueInput.inspection.stage.reconciliationPolicy
        });
      } catch {
        throw new ClassifiedPayloadStageError('proof_mismatch');
      }
      if (issueInput.inspection.state !== 'staged' || issueInput.inspection.payloadRef !== undefined) {
        throw new ClassifiedPayloadStageError('stage_not_purgeable');
      }
      if (!sameReconciliationCandidate(candidate, inspected)) {
        throw new ClassifiedPayloadStageError('proof_mismatch');
      }
      const checkedAt = parseInstant(readClock());
      if (checkedAt < candidate.expiresAt) throw new ClassifiedPayloadStageError('stage_not_purgeable');
      const ownership = await lookup(candidate);
      if (ownership.kind !== 'unadopted') return ownership;

      const proof = Object.freeze(Object.create(null)) as UnadoptedStageProof;
      records.set(proof, Object.freeze({ candidate, checkedAt }));
      return Object.freeze({ kind: 'issued', proof });
    }
  });
}

export function createStageReconciliationCursor(value: string): StageReconciliationCursor {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new TypeError('Stage reconciliation cursor is invalid.');
  return value as StageReconciliationCursor;
}

export function toSafePayloadStageAdoptionResult(result: PayloadStageAdoptionResult): SafePayloadStageAdoptionResult {
  return Object.freeze({ kind: result.kind, payloadRef: createPayloadRef(parsePayloadRefId(result.payloadRef.id)) });
}

export function createSafePayloadStageOperationalEvent(input: {
  readonly stageId: string;
  readonly action: PayloadStageOperationalAction;
  readonly outcome: PayloadStageOperationalOutcome;
}): SafePayloadStageOperationalEvent {
  return Object.freeze({ stageId: parsePayloadStageId(input.stageId), action: input.action, outcome: input.outcome });
}

export type SecretReferenceId = Brand<string, 'SecretReferenceId'>;

export interface SecretStoreAdapterRef {
  readonly key: string;
  readonly version: ContractVersion;
}

declare const secretReferenceBrand: unique symbol;

/** Server-only reference. Safe results and logs must not serialize this value. */
export interface SecretReference {
  readonly [secretReferenceBrand]: true;
  readonly id: SecretReferenceId;
  readonly version: AggregateVersion;
  readonly adapter: SecretStoreAdapterRef;
  readonly purpose: string;
  readonly scopeBinding: string;
}

export function createSecretReference(input: {
  readonly id: string;
  readonly version: number;
  readonly adapter: SecretStoreAdapterRef;
  readonly purpose: string;
  readonly scopeBinding: string;
}): SecretReference {
  if (!/^[A-Za-z0-9._:-]{16,256}$/.test(input.id)) throw new TypeError('Secret reference ID is invalid.');
  if (!stableKeyPattern.test(input.purpose)) throw new TypeError('Secret purpose is invalid.');
  if (!input.scopeBinding || input.scopeBinding.length > 256) throw new TypeError('Secret scope binding is invalid.');
  return Object.freeze({
    id: input.id as SecretReferenceId,
    version: parseAggregateVersion(input.version),
    adapter: input.adapter,
    purpose: input.purpose,
    scopeBinding: input.scopeBinding
  }) as SecretReference;
}

export function createSecretStoreAdapterRef(key: string, version: number): SecretStoreAdapterRef {
  if (!stableKeyPattern.test(key)) throw new TypeError('Secret store adapter key is invalid.');
  return Object.freeze({ key, version: parseContractVersion(version) });
}

export interface SecretStore {
  create(input: {
    readonly adapter: SecretStoreAdapterRef;
    readonly purpose: string;
    readonly scopeBinding: string;
    readonly secret: Uint8Array;
  }): Promise<SecretReference>;
  rotate(input: {
    readonly reference: SecretReference;
    readonly expectedVersion: AggregateVersion;
    readonly secret: Uint8Array;
  }): Promise<SecretReference>;
  revoke(input: {
    readonly reference: SecretReference;
    readonly expectedVersion: AggregateVersion;
  }): Promise<void>;
  withSecret<Value>(input: {
    readonly reference: SecretReference;
    readonly purpose: string;
    readonly scopeBinding: string;
    readonly consume: (secret: Uint8Array) => ReturnTypeOrPromise<Value>;
  }): Promise<Value>;
}
