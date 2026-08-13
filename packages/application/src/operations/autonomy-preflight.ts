import {
  AUTONOMY_DISPOSITIONS,
  structuredOutcomeSchema,
  type AutonomyDisposition,
  type OperationEffect,
  type OperationRisk,
  type OperationSurface,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { canonicalJsonText, parseUtcInstant, type UtcInstant } from '@jooevents/kernel';
import {
  evaluateAutonomy,
  type AutonomyBounds,
  type AutonomyDecision,
  type AutonomyInvocation,
  type AutonomyPolicyProfile,
  type OperationAutonomyPolicy,
  type RenewedApprovalEvidence,
  type WorkFailure
} from '../autonomy';
import type { InvocationContext } from './invocation-context';

export type NonProceedAutonomyDisposition = Exclude<AutonomyDisposition, 'proceed'>;

export interface AutonomyResolutionSubject {
  readonly operation: {
    readonly name: string;
    readonly version: number;
    readonly effect: Exclude<OperationEffect, 'read'>;
  };
  readonly surface: OperationSurface;
  readonly authorityKind: AutonomyInvocation['authority']['kind'];
  readonly authorityPrincipalKey: string;
  readonly scopeKeys: readonly string[];
  readonly scopeSubjects: InvocationContext['scope']['subjects'];
  readonly evaluatedAt: UtcInstant;
  readonly requestHashSha256: string;
  readonly maximumRisk: OperationRisk;
  readonly registeredConsequenceTags: readonly string[];
}

export interface ResolvedOperationRisk {
  readonly risk: OperationRisk;
  readonly consequenceTags: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface OperationRiskResolverRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'synchronous_pure_operation_risk';
  readonly operation: { readonly name: string; readonly version: number };
  resolve(subject: AutonomyResolutionSubject): ResolvedOperationRisk;
}

export interface ResolvedAutonomyEnvelope {
  readonly evaluatedAt: UtcInstant;
  readonly hardBounds: AutonomyBounds;
  readonly unattendedBounds?: AutonomyBounds;
  readonly spendMicros: number;
  readonly actionCount: number;
  readonly completesBy: UtcInstant;
  readonly proposedAction: VersionedDefinitionRef & { readonly digestSha256: string };
  readonly failure: WorkFailure;
  readonly profile?: AutonomyPolicyProfile;
}

export interface AutonomyEvidenceResolverRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'synchronous_pure_autonomy_evidence';
  readonly operation: { readonly name: string; readonly version: number };
  resolve(input: {
    readonly subject: AutonomyResolutionSubject;
    readonly risk: ResolvedOperationRisk;
  }): ResolvedAutonomyEnvelope;
}

export interface RenewedApprovalResolution {
  readonly evidence?: RenewedApprovalEvidence;
  readonly approverCurrentlyAuthorized: boolean;
}

export interface RenewedApprovalResolverRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'sealed_exact_renewed_approval';
  readonly operation: { readonly name: string; readonly version: number };
  resolve(input: {
    readonly subject: AutonomyResolutionSubject;
    readonly invocation: AutonomyInvocation;
    readonly policy: OperationAutonomyPolicy;
    readonly profile?: AutonomyPolicyProfile;
    readonly evaluatedAt: UtcInstant;
  }): SealedRenewedApprovalResolution;
}

export interface AutonomyPreflightRegistration {
  readonly reference: VersionedDefinitionRef;
  readonly kind: 'effect_autonomy_preflight';
  readonly operation: { readonly name: string; readonly version: number };
  readonly policy: VersionedDefinitionRef;
  readonly riskResolver: VersionedDefinitionRef;
  readonly evidenceResolver: VersionedDefinitionRef;
  readonly approvalResolver: VersionedDefinitionRef;
  readonly interventionOutcomes: Readonly<Record<NonProceedAutonomyDisposition, StructuredOutcome>>;
}

export interface SealedRenewedApprovalResolution {
  readonly kind: 'sealed_renewed_approval_resolution';
}

export interface SealedAutonomyPreflightDecision {
  readonly kind: 'sealed_autonomy_preflight_decision';
}

export interface SealedAutonomyExecutionDirective {
  readonly kind: 'sealed_autonomy_execution_directive';
}

/**
 * Exact, in-memory evidence retained for an authentic preflight. This is not a
 * persistence contract: downstream internal orchestration must resolve it from
 * the exact invocation/result pair before acting on an intervention.
 */
export interface AutonomyExecutionDirectiveEvidence {
  readonly preflight: VersionedDefinitionRef;
  readonly policy: VersionedDefinitionRef;
  readonly riskResolver: VersionedDefinitionRef;
  readonly evidenceResolver: VersionedDefinitionRef;
  readonly approvalResolver: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly requestHashSha256: string;
  readonly subject: AutonomyResolutionSubject;
  readonly risk: ResolvedOperationRisk;
  readonly envelope: ResolvedAutonomyEnvelope;
  readonly decision: AutonomyDecision;
  readonly approval: RenewedApprovalResolution;
}

interface InternalPreflightDecision {
  readonly registration: AutonomyPreflightRegistration;
  readonly operation: { readonly name: string; readonly version: number };
  readonly requestHashSha256: string;
  readonly disposition: AutonomyDisposition;
  readonly outcome?: StructuredOutcome;
  readonly directive: SealedAutonomyExecutionDirective;
}

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256 = /^[a-f0-9]{64}$/;
const authorityPrincipal = /^[A-Za-z0-9._:-]{1,256}$/;
const riskRank: Readonly<Record<OperationRisk, number>> = { low: 0, normal: 1, consequential: 2 };
const trustedRiskResolvers = new WeakSet<object>();
const trustedEvidenceResolvers = new WeakSet<object>();
const trustedApprovalResolvers = new WeakSet<object>();
const trustedPreflights = new WeakSet<object>();
const sealedApprovalResolutions = new WeakMap<object, RenewedApprovalResolution>();
const sealedPreflightDecisions = new WeakMap<object, InternalPreflightDecision>();
const sealedAutonomyExecutionDirectives = new WeakMap<object, AutonomyExecutionDirectiveEvidence>();

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function assertRef(reference: VersionedDefinitionRef, label: string): void {
  if (reference.key.length > 256 || !stableKey.test(reference.key)
    || !Number.isSafeInteger(reference.version) || reference.version <= 0) {
    throw new TypeError(`${label} must be an exact versioned reference`);
  }
}

function assertOperation(operation: { readonly name: string; readonly version: number }): void {
  if (operation.name.length > 256 || !stableKey.test(operation.name)
    || !Number.isSafeInteger(operation.version) || operation.version <= 0) {
    throw new TypeError('autonomy registration must identify an exact operation version');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { readonly then?: unknown }).then === 'function');
}

function synchronous<Value>(candidate: Value | Promise<Value>, label: string): Value {
  if (isPromiseLike(candidate)) throw new TypeError(`${label} must be synchronous`);
  return candidate;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const permitted = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => permitted.has(key));
}

function boundedStableKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 256 || !stableKey.test(value)) {
    throw new TypeError(`${label} must be a bounded stable key`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !sha256.test(value)) {
    throw new TypeError(`${label} must be an exact lowercase SHA-256 digest`);
  }
  return value;
}

function parseRef(value: unknown, label: string): VersionedDefinitionRef {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['key', 'version'])) {
    throw new TypeError(`${label} must be an exact versioned reference`);
  }
  const reference = value as unknown as VersionedDefinitionRef;
  assertRef(reference, label);
  return Object.freeze({ key: reference.key, version: reference.version });
}

function parseOperation(value: unknown, label: string): { readonly name: string; readonly version: number } {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['name', 'version'])) {
    throw new TypeError(`${label} must identify an exact operation version`);
  }
  const operation = value as { readonly name: string; readonly version: number };
  assertOperation(operation);
  return Object.freeze({ name: operation.name, version: operation.version });
}

function boundedPrincipalKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !authorityPrincipal.test(value)) {
    throw new TypeError(`${label} must be a bounded authority principal key`);
  }
  return value;
}

function sortedUnique(values: readonly string[], label: string, allowEmpty = true): readonly string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)
    || values.some((value) => typeof value !== 'string' || value.length > 256 || !stableKey.test(value))) {
    throw new TypeError(`${label} must contain bounded stable keys`);
  }
  const result = [...new Set(values)].sort();
  if (result.length !== values.length || result.length > 100) throw new TypeError(`${label} must be unique and bounded`);
  return Object.freeze(result);
}

function parseRisk(value: ResolvedOperationRisk, subject: AutonomyResolutionSubject): ResolvedOperationRisk {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['risk', 'consequenceTags', 'evidenceIds'])
    || !Object.hasOwn(riskRank, value.risk as PropertyKey)) {
    throw new TypeError('risk resolver returned invalid risk evidence');
  }
  const risk = value.risk as OperationRisk;
  if (riskRank[risk] > riskRank[subject.maximumRisk]) {
    throw new TypeError('risk resolver exceeded the registered operation maximum');
  }
  const consequenceTags = sortedUnique(value.consequenceTags as readonly string[], 'resolved consequence tags');
  const expectedTags = [...subject.registeredConsequenceTags].sort();
  if (canonicalJsonText(consequenceTags) !== canonicalJsonText(expectedTags)) {
    throw new TypeError('risk resolver cannot rewrite registered consequence tags');
  }
  return deepFreeze({
    risk,
    consequenceTags,
    evidenceIds: sortedUnique(value.evidenceIds as readonly string[], 'risk evidence IDs')
  });
}

function parseBounds(value: unknown, label: string): AutonomyBounds {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['scopeKeys', 'maximumSpendMicros', 'maximumActions', 'notAfter'])) {
    throw new TypeError(`${label} is invalid`);
  }
  return deepFreeze({
    scopeKeys: sortedUnique(value.scopeKeys as readonly string[], `${label}.scopeKeys`, false),
    maximumSpendMicros: nonnegativeInteger(value.maximumSpendMicros, `${label}.maximumSpendMicros`),
    maximumActions: nonnegativeInteger(value.maximumActions, `${label}.maximumActions`),
    notAfter: parseUtcInstant(value.notAfter)
  });
}

function parseFailure(value: unknown): WorkFailure {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError('autonomy failure evidence is invalid');
  }
  if (['none', 'stale_plan', 'compensation_required', 'terminal'].includes(value.kind)) {
    if (!hasExactKeys(value, ['kind'])) throw new TypeError('autonomy failure evidence is invalid');
    return Object.freeze({ kind: value.kind } as WorkFailure);
  }
  if (value.kind === 'known_retryable' || value.kind === 'acceptance_unknown') {
    if (!hasExactKeys(value, ['kind', 'semanticAnchorId'])) {
      throw new TypeError('retry/reconciliation evidence requires one exact semantic anchor');
    }
    return Object.freeze({
      kind: value.kind,
      semanticAnchorId: boundedStableKey(value.semanticAnchorId, 'semantic anchor')
    });
  }
  throw new TypeError('autonomy failure evidence uses an unknown kind');
}

function parseProfile(value: unknown): AutonomyPolicyProfile {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'definition', 'maximumUnattendedRisk', 'maximumSpendMicros', 'maximumActions', 'notAfter'
    ])
    || !isPlainRecord(value.definition)
    || !hasExactKeys(value.definition, ['key', 'version'])) {
    throw new TypeError('autonomy profile evidence is invalid');
  }
  const definition = value.definition as unknown as VersionedDefinitionRef;
  assertRef(definition, 'autonomy profile');
  if (!Object.hasOwn(riskRank, value.maximumUnattendedRisk as PropertyKey)) {
    throw new TypeError('autonomy profile evidence has an invalid risk ceiling');
  }
  return deepFreeze({
    definition: { ...definition },
    maximumUnattendedRisk: value.maximumUnattendedRisk as OperationRisk,
    maximumSpendMicros: nonnegativeInteger(value.maximumSpendMicros, 'autonomy profile spend'),
    maximumActions: nonnegativeInteger(value.maximumActions, 'autonomy profile actions'),
    notAfter: parseUtcInstant(value.notAfter)
  });
}

function parseEnvelope(value: ResolvedAutonomyEnvelope): ResolvedAutonomyEnvelope {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'evaluatedAt', 'hardBounds', 'spendMicros', 'actionCount', 'completesBy',
      'proposedAction', 'failure'
    ], ['unattendedBounds', 'profile'])
    || !isPlainRecord(value.proposedAction)
    || !hasExactKeys(value.proposedAction, ['key', 'version', 'digestSha256'])) {
    throw new TypeError('autonomy evidence resolver returned invalid evidence');
  }
  const proposedAction = value.proposedAction as unknown as VersionedDefinitionRef & {
    readonly digestSha256: string;
  };
  assertRef(proposedAction, 'proposed action');
  if (!sha256.test(proposedAction.digestSha256)) throw new TypeError('proposed action requires an exact digest');
  return deepFreeze({
    evaluatedAt: parseUtcInstant(value.evaluatedAt),
    hardBounds: parseBounds(value.hardBounds, 'hard autonomy bounds'),
    ...(value.unattendedBounds === undefined
      ? {}
      : { unattendedBounds: parseBounds(value.unattendedBounds, 'unattended autonomy bounds') }),
    spendMicros: nonnegativeInteger(value.spendMicros, 'autonomy spend'),
    actionCount: nonnegativeInteger(value.actionCount, 'autonomy action count'),
    completesBy: parseUtcInstant(value.completesBy),
    proposedAction: { ...proposedAction },
    failure: parseFailure(value.failure),
    ...(value.profile === undefined ? {} : { profile: parseProfile(value.profile) })
  });
}

function parseRenewedApprovalEvidence(value: unknown): RenewedApprovalEvidence {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'id', 'policy', 'operation', 'requestOrPlanDigestSha256', 'proposedAction', 'scopeKeys',
      'maximumSpendMicros', 'maximumActions', 'notAfter', 'proposerPrincipalKey',
      'approverPrincipalKey', 'issuedAt', 'expiresAt', 'evidenceIds'
    ], ['profile'])
    || !isPlainRecord(value.proposedAction)
    || !hasExactKeys(value.proposedAction, ['key', 'version', 'digestSha256'])) {
    throw new TypeError('renewed approval resolver returned invalid evidence');
  }
  const proposedAction = value.proposedAction as unknown as VersionedDefinitionRef & {
    readonly digestSha256: string;
  };
  const proposedActionRef = parseRef(
    { key: proposedAction.key, version: proposedAction.version },
    'renewed approval action'
  );
  return deepFreeze({
    id: boundedStableKey(value.id, 'renewed approval evidence ID'),
    policy: parseRef(value.policy, 'renewed approval policy'),
    ...(value.profile === undefined ? {} : { profile: parseRef(value.profile, 'renewed approval profile') }),
    operation: parseOperation(value.operation, 'renewed approval operation'),
    requestOrPlanDigestSha256: exactDigest(value.requestOrPlanDigestSha256, 'renewed approval request digest'),
    proposedAction: {
      ...proposedActionRef,
      digestSha256: exactDigest(proposedAction.digestSha256, 'renewed approval action digest')
    },
    scopeKeys: sortedUnique(value.scopeKeys as readonly string[], 'renewed approval scope keys', false),
    maximumSpendMicros: nonnegativeInteger(value.maximumSpendMicros, 'renewed approval maximum spend'),
    maximumActions: nonnegativeInteger(value.maximumActions, 'renewed approval maximum actions'),
    notAfter: parseUtcInstant(value.notAfter),
    proposerPrincipalKey: boundedPrincipalKey(value.proposerPrincipalKey, 'renewed approval proposer'),
    approverPrincipalKey: boundedPrincipalKey(value.approverPrincipalKey, 'renewed approval approver'),
    issuedAt: parseUtcInstant(value.issuedAt),
    expiresAt: parseUtcInstant(value.expiresAt),
    evidenceIds: sortedUnique(value.evidenceIds as readonly string[], 'renewed approval evidence IDs')
  });
}

function parseApprovalResolution(value: unknown): RenewedApprovalResolution {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['approverCurrentlyAuthorized'], ['evidence'])
    || typeof value.approverCurrentlyAuthorized !== 'boolean') {
    throw new TypeError('renewed approval resolver returned invalid evidence');
  }
  return deepFreeze({
    approverCurrentlyAuthorized: value.approverCurrentlyAuthorized,
    ...(value.evidence === undefined ? {} : { evidence: parseRenewedApprovalEvidence(value.evidence) })
  });
}

function sameOperation(
  left: { readonly name: string; readonly version: number },
  right: { readonly name: string; readonly version: number }
): boolean {
  return left.name === right.name && left.version === right.version;
}

function subjectFor(context: InvocationContext, input: {
  readonly maximumRisk: OperationRisk;
  readonly consequenceTags: readonly string[];
  readonly requestHashSha256: string;
  readonly evaluatedAt: UtcInstant;
}): AutonomyResolutionSubject {
  const authorityKind: AutonomyInvocation['authority']['kind'] = context.provenance.kind === 'operator'
    ? 'human'
    : context.provenance.kind === 'participant'
      ? 'participant'
      : context.provenance.kind === 'public_open'
        ? 'public_open'
        : context.provenance.kind === 'public_ceremony'
          ? 'public_capability'
          : context.provenance.kind === 'external_mcp'
            ? 'external_mcp'
            : context.provenance.kind === 'app_model'
              ? 'app_model'
              : 'registered_machine';
  const scopeKeys = [
    `workspace.${context.scope.workspaceId}`,
    ...(context.scope.eventId === undefined ? [] : [`event.${context.scope.eventId}`])
  ];
  return deepFreeze({
    operation: {
      name: context.operation.name,
      version: context.operation.version,
      effect: context.operation.effect as Exclude<OperationEffect, 'read'>
    },
    surface: context.surface,
    authorityKind,
    authorityPrincipalKey: context.authorityPrincipalKey,
    scopeKeys: scopeKeys.sort(),
    scopeSubjects: structuredClone(context.scope.subjects),
    evaluatedAt: parseUtcInstant(input.evaluatedAt),
    requestHashSha256: input.requestHashSha256,
    maximumRisk: input.maximumRisk,
    registeredConsequenceTags: [...new Set(input.consequenceTags)].sort()
  });
}

function syntheticSubject(input: {
  readonly operation: { readonly name: string; readonly version: number; readonly effect: 'draft' | 'commit' };
  readonly maximumRisk: OperationRisk;
  readonly consequenceTags: readonly string[];
}): AutonomyResolutionSubject {
  return deepFreeze({
    operation: { ...input.operation },
    surface: 'operator_http',
    authorityKind: 'human',
    authorityPrincipalKey: 'principal.synthetic',
    scopeKeys: ['workspace.synthetic'],
    scopeSubjects: [],
    evaluatedAt: '2026-01-01T00:00:00.000Z' as UtcInstant,
    requestHashSha256: 'a'.repeat(64),
    maximumRisk: input.maximumRisk,
    registeredConsequenceTags: [...new Set(input.consequenceTags)].sort()
  });
}

export function autonomyInterventionOutcomeDeclarations(
  detailSchema: SafeSchemaManifestRef
): readonly {
  readonly class: 'policy_violation';
  readonly kind: string;
  readonly retryable: boolean;
  readonly detailSchema: SafeSchemaManifestRef;
}[] {
  return Object.freeze(AUTONOMY_DISPOSITIONS
    .filter((disposition): disposition is NonProceedAutonomyDisposition => disposition !== 'proceed')
    .map((disposition) => deepFreeze({
      class: 'policy_violation' as const,
      kind: `autonomy.${disposition}`,
      retryable: disposition !== 'block',
      detailSchema: { ...detailSchema }
    })));
}

export function autonomyInterventionOutcomes(
  detailSchemaVersion: number
): Readonly<Record<NonProceedAutonomyDisposition, StructuredOutcome>> {
  return deepFreeze(Object.fromEntries(AUTONOMY_DISPOSITIONS
    .filter((disposition): disposition is NonProceedAutonomyDisposition => disposition !== 'proceed')
    .map((disposition) => [disposition, {
      class: 'policy_violation' as const,
      kind: `autonomy.${disposition}`,
      retryable: disposition !== 'block',
      subjects: [],
      detail: null,
      detailSchemaVersion
    }])) as unknown as Readonly<Record<NonProceedAutonomyDisposition, StructuredOutcome>>);
}

export function createOperationRiskResolverRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly resolve: (subject: AutonomyResolutionSubject) => ResolvedOperationRisk | Promise<ResolvedOperationRisk>;
}): OperationRiskResolverRegistration {
  assertRef(input.reference, 'risk resolver');
  assertOperation(input.operation);
  const resolve = input.resolve;
  if (resolve.constructor.name === 'AsyncFunction') throw new TypeError('risk resolver must be synchronous');
  const registration: OperationRiskResolverRegistration = Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    kind: 'synchronous_pure_operation_risk',
    operation: Object.freeze({ ...input.operation }),
    resolve(subject: AutonomyResolutionSubject) {
      return synchronous(resolve(deepFreeze(structuredClone(subject))), 'risk resolver');
    }
  });
  trustedRiskResolvers.add(registration);
  return registration;
}

export function createAutonomyEvidenceResolverRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly resolve: (input: {
    readonly subject: AutonomyResolutionSubject;
    readonly risk: ResolvedOperationRisk;
  }) => ResolvedAutonomyEnvelope | Promise<ResolvedAutonomyEnvelope>;
}): AutonomyEvidenceResolverRegistration {
  assertRef(input.reference, 'autonomy evidence resolver');
  assertOperation(input.operation);
  const resolve = input.resolve;
  if (resolve.constructor.name === 'AsyncFunction') throw new TypeError('autonomy evidence resolver must be synchronous');
  const registration: AutonomyEvidenceResolverRegistration = Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    kind: 'synchronous_pure_autonomy_evidence',
    operation: Object.freeze({ ...input.operation }),
    resolve(value: {
      readonly subject: AutonomyResolutionSubject;
      readonly risk: ResolvedOperationRisk;
    }) {
      return synchronous(resolve(deepFreeze(structuredClone(value))), 'autonomy evidence resolver');
    }
  });
  trustedEvidenceResolvers.add(registration);
  return registration;
}

export function createRenewedApprovalResolverRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly resolve: (input: {
    readonly subject: AutonomyResolutionSubject;
    readonly invocation: AutonomyInvocation;
    readonly policy: OperationAutonomyPolicy;
    readonly profile?: AutonomyPolicyProfile;
    readonly evaluatedAt: UtcInstant;
  }) => RenewedApprovalResolution | Promise<RenewedApprovalResolution>;
}): RenewedApprovalResolverRegistration {
  assertRef(input.reference, 'renewed approval resolver');
  assertOperation(input.operation);
  const resolve = input.resolve;
  if (resolve.constructor.name === 'AsyncFunction') throw new TypeError('renewed approval resolver must be synchronous');
  const registration: RenewedApprovalResolverRegistration = Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    kind: 'sealed_exact_renewed_approval',
    operation: Object.freeze({ ...input.operation }),
    resolve(value: {
      readonly subject: AutonomyResolutionSubject;
      readonly invocation: AutonomyInvocation;
      readonly policy: OperationAutonomyPolicy;
      readonly profile?: AutonomyPolicyProfile;
      readonly evaluatedAt: UtcInstant;
    }) {
      const resolved = parseApprovalResolution(
        synchronous(resolve(deepFreeze(structuredClone(value))), 'renewed approval resolver')
      );
      const sealed: SealedRenewedApprovalResolution = Object.freeze({ kind: 'sealed_renewed_approval_resolution' });
      sealedApprovalResolutions.set(sealed, resolved);
      return sealed;
    }
  });
  trustedApprovalResolvers.add(registration);
  return registration;
}

export function createAutonomyPreflightRegistration(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operation: { readonly name: string; readonly version: number };
  readonly policy: VersionedDefinitionRef;
  readonly riskResolver: VersionedDefinitionRef;
  readonly evidenceResolver: VersionedDefinitionRef;
  readonly approvalResolver: VersionedDefinitionRef;
  readonly interventionOutcomes: Readonly<Record<NonProceedAutonomyDisposition, StructuredOutcome>>;
}): AutonomyPreflightRegistration {
  assertRef(input.reference, 'autonomy preflight');
  assertRef(input.policy, 'autonomy policy');
  assertRef(input.riskResolver, 'risk resolver');
  assertRef(input.evidenceResolver, 'autonomy evidence resolver');
  assertRef(input.approvalResolver, 'renewed approval resolver');
  assertOperation(input.operation);
  const nonProceedDispositions = AUTONOMY_DISPOSITIONS.filter(
    (disposition): disposition is NonProceedAutonomyDisposition => disposition !== 'proceed'
  );
  if (canonicalJsonText(Object.keys(input.interventionOutcomes).sort())
    !== canonicalJsonText([...nonProceedDispositions].sort())) {
    throw new TypeError('autonomy preflight outcomes must use the exact closed disposition set');
  }
  const interventionOutcomes = {} as Record<NonProceedAutonomyDisposition, StructuredOutcome>;
  for (const disposition of nonProceedDispositions) {
    const parsed = structuredOutcomeSchema.safeParse(input.interventionOutcomes[disposition]);
    if (!parsed.success
      || parsed.data.class !== 'policy_violation'
      || parsed.data.kind !== `autonomy.${disposition}`
      || parsed.data.retryable !== (disposition !== 'block')
      || parsed.data.subjects.length !== 0
      || parsed.data.detail !== null) {
      throw new TypeError(`autonomy preflight has no exact outcome for ${disposition}`);
    }
    interventionOutcomes[disposition] = parsed.data;
  }
  const registration = deepFreeze<AutonomyPreflightRegistration>({
    reference: { ...input.reference },
    kind: 'effect_autonomy_preflight',
    operation: { ...input.operation },
    policy: { ...input.policy },
    riskResolver: { ...input.riskResolver },
    evidenceResolver: { ...input.evidenceResolver },
    approvalResolver: { ...input.approvalResolver },
    interventionOutcomes
  });
  trustedPreflights.add(registration);
  return registration;
}

export function isTrustedOperationRiskResolverRegistration(value: unknown): value is OperationRiskResolverRegistration {
  return typeof value === 'object' && value !== null && trustedRiskResolvers.has(value);
}

export function isTrustedAutonomyEvidenceResolverRegistration(value: unknown): value is AutonomyEvidenceResolverRegistration {
  return typeof value === 'object' && value !== null && trustedEvidenceResolvers.has(value);
}

export function isTrustedRenewedApprovalResolverRegistration(value: unknown): value is RenewedApprovalResolverRegistration {
  return typeof value === 'object' && value !== null && trustedApprovalResolvers.has(value);
}

export function isTrustedAutonomyPreflightRegistration(value: unknown): value is AutonomyPreflightRegistration {
  return typeof value === 'object' && value !== null && trustedPreflights.has(value);
}

function resolvePair<Value>(input: {
  readonly label: string;
  readonly resolve: () => Value;
  readonly parse?: (value: Value) => Value;
}): Value {
  const first = input.parse ? input.parse(input.resolve()) : input.resolve();
  const second = input.parse ? input.parse(input.resolve()) : input.resolve();
  if (canonicalJsonText(first) !== canonicalJsonText(second)) {
    throw new TypeError(`${input.label} is nondeterministic`);
  }
  return first;
}

function invocationFor(input: {
  readonly subject: AutonomyResolutionSubject;
  readonly risk: ResolvedOperationRisk;
  readonly envelope: ResolvedAutonomyEnvelope;
}): AutonomyInvocation {
  return deepFreeze({
    operation: { name: input.subject.operation.name, version: input.subject.operation.version },
    surface: input.subject.surface,
    effect: input.subject.operation.effect,
    resolvedRisk: input.risk.risk,
    requestOrPlanDigestSha256: input.subject.requestHashSha256,
    proposedAction: { ...input.envelope.proposedAction },
    scopeKeys: [...input.subject.scopeKeys],
    spendMicros: input.envelope.spendMicros,
    actionCount: input.envelope.actionCount,
    completesBy: input.envelope.completesBy,
    authority: {
      current: true,
      permitted: true,
      principalKey: input.subject.authorityPrincipalKey,
      kind: input.subject.authorityKind,
      hardBounds: structuredClone(input.envelope.hardBounds)
    },
    ...(input.envelope.unattendedBounds === undefined
      ? {}
      : { unattendedBounds: structuredClone(input.envelope.unattendedBounds) }),
    failure: structuredClone(input.envelope.failure),
    consequenceEvidenceIds: [...input.risk.evidenceIds]
  });
}

function approvalPair(input: {
  readonly resolver: RenewedApprovalResolverRegistration;
  readonly value: Parameters<RenewedApprovalResolverRegistration['resolve']>[0];
}): RenewedApprovalResolution {
  const resolve = (): RenewedApprovalResolution => {
    const sealed = input.resolver.resolve(input.value);
    const internal = sealedApprovalResolutions.get(sealed);
    if (!internal) throw new TypeError('renewed approval resolution is not sealed');
    return internal;
  };
  return resolvePair({ label: 'renewed approval resolver', resolve });
}

export function probeAutonomyRegistrations(input: {
  readonly operation: { readonly name: string; readonly version: number; readonly effect: 'draft' | 'commit' };
  readonly maximumRisk: OperationRisk;
  readonly consequenceTags: readonly string[];
  readonly policy: OperationAutonomyPolicy;
  readonly riskResolver: OperationRiskResolverRegistration;
  readonly evidenceResolver: AutonomyEvidenceResolverRegistration;
  readonly approvalResolver: RenewedApprovalResolverRegistration;
}): void {
  const subject = syntheticSubject(input);
  const risk = resolvePair({
    label: 'risk resolver',
    resolve: () => input.riskResolver.resolve(subject),
    parse: (value) => parseRisk(value, subject)
  });
  const envelope = resolvePair({
    label: 'autonomy evidence resolver',
    resolve: () => input.evidenceResolver.resolve({ subject, risk }),
    parse: parseEnvelope
  });
  if (envelope.evaluatedAt !== subject.evaluatedAt) {
    throw new TypeError('autonomy evidence was not evaluated at the trusted transaction time');
  }
  const invocation = invocationFor({ subject, risk, envelope });
  const approval = approvalPair({
    resolver: input.approvalResolver,
    value: {
      subject,
      invocation,
      policy: input.policy,
      ...(envelope.profile === undefined ? {} : { profile: envelope.profile }),
      evaluatedAt: envelope.evaluatedAt
    }
  });
  evaluateAutonomy({
    policy: input.policy,
    invocation,
    ...(envelope.profile === undefined ? {} : { profile: envelope.profile }),
    now: envelope.evaluatedAt,
    ...(approval.evidence === undefined ? {} : { renewedApproval: approval.evidence }),
    approverCurrentlyAuthorized: approval.approverCurrentlyAuthorized
  });
}

export function executeAutonomyPreflight(input: {
  readonly registration: AutonomyPreflightRegistration;
  readonly policy: OperationAutonomyPolicy;
  readonly riskResolver: OperationRiskResolverRegistration;
  readonly evidenceResolver: AutonomyEvidenceResolverRegistration;
  readonly approvalResolver: RenewedApprovalResolverRegistration;
  readonly context: InvocationContext;
  readonly maximumRisk: OperationRisk;
  readonly consequenceTags: readonly string[];
  readonly requestHashSha256: string;
  readonly evaluatedAt: UtcInstant;
}): SealedAutonomyPreflightDecision {
  if (!sha256.test(input.requestHashSha256)) throw new TypeError('autonomy preflight requires a sealed request hash');
  const subject = subjectFor(input.context, input);
  if (!sameOperation(input.registration.operation, subject.operation)
    || !sameOperation(input.policy.operation, subject.operation)) {
    throw new TypeError('autonomy preflight operation mismatch');
  }
  const risk = resolvePair({
    label: 'risk resolver',
    resolve: () => input.riskResolver.resolve(subject),
    parse: (value) => parseRisk(value, subject)
  });
  const envelope = resolvePair({
    label: 'autonomy evidence resolver',
    resolve: () => input.evidenceResolver.resolve({ subject, risk }),
    parse: parseEnvelope
  });
  if (envelope.evaluatedAt !== subject.evaluatedAt) {
    throw new TypeError('autonomy evidence was not evaluated at the trusted transaction time');
  }
  const invocation = invocationFor({ subject, risk, envelope });
  const approval = approvalPair({
    resolver: input.approvalResolver,
    value: {
      subject,
      invocation,
      policy: input.policy,
      ...(envelope.profile === undefined ? {} : { profile: envelope.profile }),
      evaluatedAt: envelope.evaluatedAt
    }
  });
  const decision = evaluateAutonomy({
    policy: input.policy,
    invocation,
    ...(envelope.profile === undefined ? {} : { profile: envelope.profile }),
    now: envelope.evaluatedAt,
    ...(approval.evidence === undefined ? {} : { renewedApproval: approval.evidence }),
    approverCurrentlyAuthorized: approval.approverCurrentlyAuthorized
  });
  if (!input.policy.supportedDispositions.includes(decision.disposition)) {
    throw new TypeError('autonomy policy selected an unregistered disposition');
  }
  const outcome = decision.disposition === 'proceed'
    ? undefined
    : input.registration.interventionOutcomes[decision.disposition];
  if (decision.disposition !== 'proceed' && !outcome) {
    throw new TypeError('autonomy disposition has no registered safe outcome');
  }
  const directive: SealedAutonomyExecutionDirective = Object.freeze({ kind: 'sealed_autonomy_execution_directive' });
  sealedAutonomyExecutionDirectives.set(directive, deepFreeze({
    preflight: { ...input.registration.reference },
    policy: { ...input.registration.policy },
    riskResolver: { ...input.registration.riskResolver },
    evidenceResolver: { ...input.registration.evidenceResolver },
    approvalResolver: { ...input.registration.approvalResolver },
    operation: { name: subject.operation.name, version: subject.operation.version },
    requestHashSha256: input.requestHashSha256,
    subject: structuredClone(subject),
    risk: structuredClone(risk),
    envelope: structuredClone(envelope),
    decision: structuredClone(decision),
    approval: structuredClone(approval)
  }));
  const sealed: SealedAutonomyPreflightDecision = Object.freeze({ kind: 'sealed_autonomy_preflight_decision' });
  sealedPreflightDecisions.set(sealed, deepFreeze({
    registration: input.registration,
    operation: { name: subject.operation.name, version: subject.operation.version },
    requestHashSha256: input.requestHashSha256,
    disposition: decision.disposition,
    ...(outcome === undefined ? {} : { outcome: structuredClone(outcome) }),
    directive
  }));
  return sealed;
}

export function consumeAutonomyPreflightDecision(input: {
  readonly decision: SealedAutonomyPreflightDecision;
  readonly registration: AutonomyPreflightRegistration;
  readonly operation: { readonly name: string; readonly version: number };
  readonly requestHashSha256: string;
}): { readonly disposition: 'proceed'; readonly directive: SealedAutonomyExecutionDirective } | {
  readonly disposition: NonProceedAutonomyDisposition;
  readonly outcome: StructuredOutcome;
  readonly directive: SealedAutonomyExecutionDirective;
} {
  const internal = sealedPreflightDecisions.get(input.decision);
  if (!internal
    || internal.registration !== input.registration
    || !sameOperation(internal.operation, input.operation)
    || internal.requestHashSha256 !== input.requestHashSha256) {
    throw new TypeError('autonomy preflight decision is not authentic for this invocation');
  }
  if (internal.disposition === 'proceed') {
    return Object.freeze({ disposition: 'proceed', directive: internal.directive });
  }
  if (!internal.outcome) throw new TypeError('autonomy intervention is missing its safe outcome');
  return deepFreeze({
    disposition: internal.disposition,
    outcome: structuredClone(internal.outcome),
    directive: internal.directive
  });
}

/** Resolves evidence only from the exact opaque directive minted by this module. */
export function resolveAutonomyExecutionDirectiveEvidence(
  directive: SealedAutonomyExecutionDirective
): AutonomyExecutionDirectiveEvidence {
  const evidence = sealedAutonomyExecutionDirectives.get(directive);
  if (!evidence) throw new TypeError('autonomy execution directive is not authentic');
  return evidence;
}
