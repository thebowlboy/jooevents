import type {
  AutonomyDisposition,
  AutonomyTrigger,
  OperationEffect,
  OperationRisk,
  OperationSurface,
  VersionedDefinitionRef
} from '@jooevents/contracts';
import { AUTONOMY_DISPOSITIONS, AUTONOMY_TRIGGERS } from '@jooevents/contracts';
import { parseUtcInstant, type UtcInstant } from '@jooevents/kernel';

export { AUTONOMY_DISPOSITIONS, AUTONOMY_TRIGGERS };
export type { AutonomyDisposition, AutonomyTrigger };

export interface AutonomyBounds {
  readonly scopeKeys: readonly string[];
  readonly maximumSpendMicros: number;
  readonly maximumActions: number;
  readonly notAfter: UtcInstant;
}

export interface OperationAutonomyPolicy {
  readonly definition: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly riskFloor: OperationRisk;
  readonly unattendedRiskCeiling: OperationRisk;
  readonly supportedDispositions: readonly AutonomyDisposition[];
  readonly triggerDispositions: Readonly<Record<AutonomyTrigger, Exclude<AutonomyDisposition, 'proceed'>>>;
  readonly requiresSeparateApproval: boolean;
}

/** A setting can only narrow the code-owned policy; it cannot add authority. */
export interface AutonomyPolicyProfile {
  readonly definition: VersionedDefinitionRef;
  readonly maximumUnattendedRisk: OperationRisk;
  readonly maximumSpendMicros: number;
  readonly maximumActions: number;
  readonly notAfter: UtcInstant;
}

export type WorkFailure =
  | { readonly kind: 'none' }
  | { readonly kind: 'known_retryable'; readonly semanticAnchorId?: string }
  | { readonly kind: 'acceptance_unknown'; readonly semanticAnchorId: string }
  | { readonly kind: 'stale_plan' }
  | { readonly kind: 'compensation_required' }
  | { readonly kind: 'terminal' };

export interface AutonomyAuthority {
  readonly current: boolean;
  readonly permitted: boolean;
  readonly principalKey: string;
  readonly kind: 'human' | 'participant' | 'public_open' | 'public_capability' | 'external_mcp' | 'app_model' | 'registered_machine';
  readonly hardBounds: AutonomyBounds;
}

export interface AutonomyInvocation {
  readonly operation: { readonly name: string; readonly version: number };
  readonly surface: OperationSurface;
  readonly effect: OperationEffect;
  readonly resolvedRisk: OperationRisk;
  readonly requestOrPlanDigestSha256: string;
  readonly proposedAction: VersionedDefinitionRef & { readonly digestSha256: string };
  readonly scopeKeys: readonly string[];
  readonly spendMicros: number;
  readonly actionCount: number;
  readonly completesBy: UtcInstant;
  readonly authority: AutonomyAuthority;
  readonly unattendedBounds?: AutonomyBounds;
  readonly failure: WorkFailure;
  readonly consequenceEvidenceIds: readonly string[];
}

export interface RenewedApprovalEvidence {
  readonly id: string;
  readonly policy: VersionedDefinitionRef;
  /** The exact tightening profile selected when approval was requested. */
  readonly profile?: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly requestOrPlanDigestSha256: string;
  readonly proposedAction: VersionedDefinitionRef & { readonly digestSha256: string };
  readonly scopeKeys: readonly string[];
  readonly maximumSpendMicros: number;
  readonly maximumActions: number;
  readonly notAfter: UtcInstant;
  readonly proposerPrincipalKey: string;
  readonly approverPrincipalKey: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly evidenceIds: readonly string[];
}

export interface InterventionRequest {
  readonly trigger: AutonomyTrigger;
  readonly policy: VersionedDefinitionRef;
  /** Omitted only when no workspace/event tightening profile was selected. */
  readonly profile?: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly requestOrPlanDigestSha256: string;
  readonly proposedAction: VersionedDefinitionRef & { readonly digestSha256: string };
  readonly scopeKeys: readonly string[];
  readonly requestedSpendMicros: number;
  readonly requestedActions: number;
  readonly notAfter: UtcInstant;
  readonly proposerPrincipalKey: string;
  readonly evidenceIds: readonly string[];
}

export type AutonomyDecision =
  | { readonly disposition: 'proceed' }
  | { readonly disposition: 'safe_retry'; readonly semanticAnchorId: string }
  | { readonly disposition: 'reconcile'; readonly semanticAnchorId: string }
  | { readonly disposition: 'renewed_approval'; readonly request: InterventionRequest }
  | { readonly disposition: 'replan' | 'compensate' | 'block' | 'attention'; readonly trigger: AutonomyTrigger };

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256 = /^[a-f0-9]{64}$/;
const riskRank: Readonly<Record<OperationRisk, number>> = { low: 0, normal: 1, consequential: 2 };
const trustedOperationAutonomyPolicies = new WeakSet<object>();

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function assertVersionedRef(reference: VersionedDefinitionRef, label: string): void {
  if (!stableKey.test(reference.key) || !Number.isSafeInteger(reference.version) || reference.version <= 0) {
    throw new TypeError(`${label} must be a stable versioned reference`);
  }
}

function assertOperation(operation: { readonly name: string; readonly version: number }, label: string): void {
  if (!stableKey.test(operation.name) || !Number.isSafeInteger(operation.version) || operation.version <= 0) {
    throw new TypeError(`${label} must identify an exact operation version`);
  }
}

function assertDigest(value: string, label: string): void {
  if (!sha256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
}

function normalizedUnique(values: readonly string[], label: string, allowEmpty = false): readonly string[] {
  if ((!allowEmpty && values.length === 0) || values.some((value) => !stableKey.test(value))) {
    throw new TypeError(`${label} must contain stable scope/evidence keys`);
  }
  const result = [...new Set(values)].sort();
  if (result.length !== values.length) throw new TypeError(`${label} contains duplicates`);
  return Object.freeze(result);
}

function assertNonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}

function assertBounds(bounds: AutonomyBounds, label: string): AutonomyBounds {
  const scopeKeys = normalizedUnique(bounds.scopeKeys, `${label}.scopeKeys`);
  assertNonnegative(bounds.maximumSpendMicros, `${label}.maximumSpendMicros`);
  assertNonnegative(bounds.maximumActions, `${label}.maximumActions`);
  const notAfter = parseUtcInstant(bounds.notAfter);
  return Object.freeze({ ...bounds, scopeKeys, notAfter });
}

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameOperation(
  left: { readonly name: string; readonly version: number },
  right: { readonly name: string; readonly version: number }
): boolean {
  return left.name === right.name && left.version === right.version;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

function minimumRisk(left: OperationRisk, right: OperationRisk): OperationRisk {
  return riskRank[left] <= riskRank[right] ? left : right;
}

function maximumRisk(left: OperationRisk, right: OperationRisk): OperationRisk {
  return riskRank[left] >= riskRank[right] ? left : right;
}

function earlier(left: UtcInstant, right: UtcInstant): UtcInstant {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function triggerDecision(
  policy: OperationAutonomyPolicy,
  trigger: AutonomyTrigger,
  invocation: AutonomyInvocation,
  profile?: AutonomyPolicyProfile
): AutonomyDecision {
  const disposition = policy.triggerDispositions[trigger];
  if (disposition === 'renewed_approval') {
    return {
      disposition,
      request: Object.freeze({
        trigger,
        policy: policy.definition,
        ...(profile === undefined ? {} : { profile: profile.definition }),
        operation: invocation.operation,
        requestOrPlanDigestSha256: invocation.requestOrPlanDigestSha256,
        proposedAction: invocation.proposedAction,
        scopeKeys: Object.freeze([...invocation.scopeKeys].sort()),
        requestedSpendMicros: invocation.spendMicros,
        requestedActions: invocation.actionCount,
        notAfter: invocation.completesBy,
        proposerPrincipalKey: invocation.authority.principalKey,
        evidenceIds: Object.freeze([...invocation.consequenceEvidenceIds].sort())
      })
    };
  }
  if (disposition === 'safe_retry') {
    if (invocation.failure.kind !== 'known_retryable' || !invocation.failure.semanticAnchorId) {
      return { disposition: 'attention', trigger };
    }
    return { disposition, semanticAnchorId: invocation.failure.semanticAnchorId };
  }
  if (disposition === 'reconcile') {
    if (invocation.failure.kind !== 'acceptance_unknown') return { disposition: 'attention', trigger };
    return { disposition, semanticAnchorId: invocation.failure.semanticAnchorId };
  }
  return { disposition, trigger };
}

export function validateOperationAutonomyPolicy(policy: OperationAutonomyPolicy): void {
  assertVersionedRef(policy.definition, 'autonomy policy');
  assertOperation(policy.operation, 'autonomy policy operation');
  if (!Object.hasOwn(riskRank, policy.riskFloor) || !Object.hasOwn(riskRank, policy.unattendedRiskCeiling)) {
    throw new TypeError('autonomy policy risk values must use the closed risk vocabulary');
  }
  const supported = new Set(policy.supportedDispositions);
  if (
    supported.size !== policy.supportedDispositions.length
    || supported.size === 0
    || policy.supportedDispositions.some((value) => !AUTONOMY_DISPOSITIONS.includes(value))
  ) {
    throw new TypeError('autonomy policy dispositions must be unique and nonempty');
  }
  if (!supported.has('proceed')) throw new TypeError('autonomy policy must explicitly support proceeding inside bounds');
  if (typeof policy.requiresSeparateApproval !== 'boolean') {
    throw new TypeError('autonomy policy approval requirement must be boolean');
  }
  const triggerKeys = Object.keys(policy.triggerDispositions);
  if (
    triggerKeys.length !== AUTONOMY_TRIGGERS.length
    || triggerKeys.some((trigger) => !AUTONOMY_TRIGGERS.includes(trigger as AutonomyTrigger))
  ) {
    throw new TypeError('autonomy policy triggers must use the complete closed vocabulary');
  }
  for (const trigger of AUTONOMY_TRIGGERS) {
    const disposition: unknown = policy.triggerDispositions[trigger];
    if (
      disposition === 'proceed'
      || !AUTONOMY_DISPOSITIONS.some((candidate) => candidate === disposition)
      || !supported.has(disposition as AutonomyDisposition)
    ) {
      throw new TypeError(`trigger ${trigger} selects an unsupported disposition`);
    }
  }
  if (policy.triggerDispositions.authority_lost !== 'block') {
    throw new TypeError('lost authority is a non-lowerable block');
  }
  if (policy.triggerDispositions.ambiguous_external_effect === 'safe_retry') {
    throw new TypeError('ambiguous external effects cannot select blind retry');
  }
  if (!['renewed_approval', 'block'].includes(policy.triggerDispositions.approval_required)) {
    throw new TypeError('approval-required work must pause for exact approval or block');
  }
}

/** Creates the immutable, provenance-marked policy definitions accepted by the operation registry. */
export function createOperationAutonomyPolicy(policy: OperationAutonomyPolicy): OperationAutonomyPolicy {
  validateOperationAutonomyPolicy(policy);
  const supported = new Set(policy.supportedDispositions);
  const sealed = deepFreeze<OperationAutonomyPolicy>({
    definition: { ...policy.definition },
    operation: { ...policy.operation },
    riskFloor: policy.riskFloor,
    unattendedRiskCeiling: policy.unattendedRiskCeiling,
    supportedDispositions: AUTONOMY_DISPOSITIONS.filter((disposition) => supported.has(disposition)),
    triggerDispositions: Object.fromEntries(
      AUTONOMY_TRIGGERS.map((trigger) => [trigger, policy.triggerDispositions[trigger]])
    ) as Readonly<Record<AutonomyTrigger, Exclude<AutonomyDisposition, 'proceed'>>>,
    requiresSeparateApproval: policy.requiresSeparateApproval
  });
  trustedOperationAutonomyPolicies.add(sealed);
  return sealed;
}

export function isTrustedOperationAutonomyPolicy(value: unknown): value is OperationAutonomyPolicy {
  return value !== null && typeof value === 'object' && trustedOperationAutonomyPolicies.has(value);
}

export function validateAutonomyPolicyProfile(profile: AutonomyPolicyProfile): AutonomyPolicyProfile {
  assertVersionedRef(profile.definition, 'autonomy profile');
  if (!Object.hasOwn(riskRank, profile.maximumUnattendedRisk)) {
    throw new TypeError('autonomy profile risk ceiling must use the closed risk vocabulary');
  }
  assertNonnegative(profile.maximumSpendMicros, 'autonomy profile maximumSpendMicros');
  assertNonnegative(profile.maximumActions, 'autonomy profile maximumActions');
  return Object.freeze({ ...profile, notAfter: parseUtcInstant(profile.notAfter) });
}

function approvalMatches(input: {
  readonly approval: RenewedApprovalEvidence | undefined;
  readonly policy: OperationAutonomyPolicy;
  readonly profile: AutonomyPolicyProfile | undefined;
  readonly invocation: AutonomyInvocation;
  readonly now: UtcInstant;
  readonly approverCurrentlyAuthorized: boolean;
}): boolean {
  const approval = input.approval;
  if (!approval || !input.approverCurrentlyAuthorized) return false;
  try {
    assertVersionedRef(approval.policy, 'renewed approval policy');
    if (approval.profile !== undefined) assertVersionedRef(approval.profile, 'renewed approval profile');
    assertOperation(approval.operation, 'renewed approval operation');
    assertDigest(approval.requestOrPlanDigestSha256, 'renewed approval request/plan digest');
    assertVersionedRef(approval.proposedAction, 'renewed approval action');
    assertDigest(approval.proposedAction.digestSha256, 'renewed approval action digest');
    normalizedUnique(approval.scopeKeys, 'renewed approval scope keys');
    normalizedUnique(approval.evidenceIds, 'renewed approval evidence IDs', true);
    assertNonnegative(approval.maximumSpendMicros, 'renewed approval maximum spend');
    assertNonnegative(approval.maximumActions, 'renewed approval maximum actions');
    parseUtcInstant(approval.issuedAt);
    parseUtcInstant(approval.expiresAt);
    parseUtcInstant(approval.notAfter);
  } catch {
    return false;
  }
  const scopes = [...input.invocation.scopeKeys].sort();
  const evidence = [...input.invocation.consequenceEvidenceIds].sort();
  return sameRef(approval.policy, input.policy.definition)
    && ((approval.profile === undefined && input.profile === undefined)
      || (approval.profile !== undefined
        && input.profile !== undefined
        && sameRef(approval.profile, input.profile.definition)))
    && sameOperation(approval.operation, input.invocation.operation)
    && approval.requestOrPlanDigestSha256 === input.invocation.requestOrPlanDigestSha256
    && sameRef(approval.proposedAction, input.invocation.proposedAction)
    && approval.proposedAction.digestSha256 === input.invocation.proposedAction.digestSha256
    && sameSet([...approval.scopeKeys].sort(), scopes)
    && approval.maximumSpendMicros === input.invocation.spendMicros
    && approval.maximumActions === input.invocation.actionCount
    && approval.notAfter === input.invocation.completesBy
    && approval.proposerPrincipalKey === input.invocation.authority.principalKey
    && approval.approverPrincipalKey !== approval.proposerPrincipalKey
    && Date.parse(approval.issuedAt) <= Date.parse(input.now)
    && Date.parse(approval.expiresAt) > Date.parse(input.now)
    && Date.parse(approval.expiresAt) <= Date.parse(approval.notAfter)
    && sameSet([...approval.evidenceIds].sort(), evidence);
}

export function evaluateAutonomy(input: {
  readonly policy: OperationAutonomyPolicy;
  readonly invocation: AutonomyInvocation;
  readonly profile?: AutonomyPolicyProfile;
  readonly now: UtcInstant;
  readonly renewedApproval?: RenewedApprovalEvidence;
  readonly approverCurrentlyAuthorized?: boolean;
}): AutonomyDecision {
  validateOperationAutonomyPolicy(input.policy);
  const now = parseUtcInstant(input.now);
  const invocation = input.invocation;
  assertOperation(invocation.operation, 'invocation operation');
  if (!sameOperation(input.policy.operation, invocation.operation)) throw new TypeError('autonomy policy operation mismatch');
  assertDigest(invocation.requestOrPlanDigestSha256, 'request/plan digest');
  assertVersionedRef(invocation.proposedAction, 'proposed action');
  assertDigest(invocation.proposedAction.digestSha256, 'proposed action digest');
  const scopes = normalizedUnique(invocation.scopeKeys, 'invocation.scopeKeys');
  const evidenceIds = normalizedUnique(invocation.consequenceEvidenceIds, 'invocation.consequenceEvidenceIds', true);
  assertNonnegative(invocation.spendMicros, 'invocation.spendMicros');
  assertNonnegative(invocation.actionCount, 'invocation.actionCount');
  const completesBy = parseUtcInstant(invocation.completesBy);
  const hardBounds = assertBounds(invocation.authority.hardBounds, 'authority hard bounds');
  const unattendedBounds = invocation.unattendedBounds
    ? assertBounds(invocation.unattendedBounds, 'unattended bounds')
    : hardBounds;
  const profile = input.profile ? validateAutonomyPolicyProfile(input.profile) : undefined;

  if (invocation.surface === 'app_model' && invocation.effect === 'commit') {
    return { disposition: 'block', trigger: 'authority_lost' };
  }
  const authorityKindMatchesSurface = (
    (invocation.surface === 'operator_http' && invocation.authority.kind === 'human')
    || (invocation.surface === 'participant_http' && invocation.authority.kind === 'participant')
    || (invocation.surface === 'public_http' && (
      invocation.authority.kind === 'public_capability'
      || (invocation.authority.kind === 'public_open' && invocation.effect === 'read')
    ))
    || (invocation.surface === 'external_mcp' && invocation.authority.kind === 'external_mcp')
    || (invocation.surface === 'app_model' && invocation.authority.kind === 'app_model')
    || (invocation.surface === 'application_job' && invocation.authority.kind === 'registered_machine')
    || (invocation.surface === 'provider_ingress' && invocation.authority.kind === 'registered_machine')
  );
  if (!authorityKindMatchesSurface) return { disposition: 'block', trigger: 'authority_lost' };
  if (!invocation.authority.current || !invocation.authority.permitted) {
    return triggerDecision(input.policy, 'authority_lost', invocation, profile);
  }
  const outsideHardAuthority = !isSubset(scopes, hardBounds.scopeKeys)
    || invocation.spendMicros > hardBounds.maximumSpendMicros
    || invocation.actionCount > hardBounds.maximumActions
    || Date.parse(completesBy) > Date.parse(hardBounds.notAfter)
    || Date.parse(now) >= Date.parse(hardBounds.notAfter);
  if (outsideHardAuthority) return { disposition: 'block', trigger: 'authority_lost' };

  if (invocation.failure.kind === 'acceptance_unknown') {
    return triggerDecision(input.policy, 'ambiguous_external_effect', invocation, profile);
  }
  if (invocation.failure.kind === 'stale_plan') return triggerDecision(input.policy, 'stale_plan', invocation, profile);
  if (invocation.failure.kind === 'compensation_required') {
    return triggerDecision(input.policy, 'compensation_required', invocation, profile);
  }
  if (invocation.failure.kind === 'terminal') return triggerDecision(input.policy, 'terminal_failure', invocation, profile);

  const profileCeiling = profile?.maximumUnattendedRisk ?? input.policy.unattendedRiskCeiling;
  const effectiveCeiling = minimumRisk(input.policy.unattendedRiskCeiling, profileCeiling);
  const effectiveRisk = maximumRisk(input.policy.riskFloor, invocation.resolvedRisk);
  const effectiveSpend = Math.min(unattendedBounds.maximumSpendMicros, profile?.maximumSpendMicros ?? Number.MAX_SAFE_INTEGER);
  const effectiveActions = Math.min(unattendedBounds.maximumActions, profile?.maximumActions ?? Number.MAX_SAFE_INTEGER);
  const effectiveNotAfter = earlier(unattendedBounds.notAfter, profile?.notAfter ?? hardBounds.notAfter);
  const outsideUnattendedBounds = !isSubset(scopes, unattendedBounds.scopeKeys)
    || invocation.spendMicros > effectiveSpend
    || invocation.actionCount > effectiveActions
    || Date.parse(completesBy) > Date.parse(effectiveNotAfter)
    || Date.parse(now) >= Date.parse(effectiveNotAfter);
  const requiresApproval = outsideUnattendedBounds
    || riskRank[effectiveRisk] > riskRank[effectiveCeiling]
    || input.policy.requiresSeparateApproval;
  if (requiresApproval && !approvalMatches({
    approval: input.renewedApproval,
    policy: input.policy,
    profile,
    invocation: { ...invocation, scopeKeys: scopes, consequenceEvidenceIds: evidenceIds, completesBy },
    now,
    approverCurrentlyAuthorized: input.approverCurrentlyAuthorized === true
  })) {
    const trigger = outsideUnattendedBounds ? 'unattended_bounds_exceeded' : 'approval_required';
    return triggerDecision(input.policy, trigger, invocation, profile);
  }

  if (invocation.failure.kind === 'known_retryable') {
    return triggerDecision(input.policy, 'known_retryable_failure', invocation, profile);
  }
  return { disposition: 'proceed' };
}
