import {
  autonomyInterventionOutcomeDeclarations, autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration, createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder, createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration, createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration, createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type IdempotencyCredentialSealer, type InvocationEvidence, type InvocationScopeResolver,
  type OperationRegistryModule, type RequestHashSealer
} from '@jooevents/application';
import { createSafeSchemaManifestRef, structuredOutcomeSchema, type StructuredOutcome, type VersionedDefinitionRef } from '@jooevents/contracts';
import {
  REVIEW_OPERATION_SCHEMA_REFS, reviewDirectCanonicalResultSchema, reviewDirectOperationResultSchema,
  reviewEvaluationChangeDraftInputSchema, reviewMutationPlanSchema, reviewMutationResultSchema,
  reviewRoundChangeDraftInputSchema, reviewStepBackChangeDraftInputSchema
} from '@jooevents/contracts/reviews';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS, parseOperationAccessLane,
  type CurrentAuthorityDenialReason, type CurrentAuthorityResolver, type PermissionId,
  type VersionedAccessPolicyRef, type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import { parseEventId, parseInstant, parseWorkspaceId, type Clock, type InvocationId, type WorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import { createReviewDirectHandler, type ReviewDirectAction } from './direct-preparation';

export const REVIEW_ROUND_CHANGE_OPERATION = Object.freeze({ name: 'review.round.change', version: 1 });
export const REVIEW_ASSIGNMENT_STEP_BACK_OPERATION = Object.freeze({ name: 'review.assignment.step_back', version: 1 });
export const REVIEW_EVALUATION_CHANGE_OPERATION = Object.freeze({ name: 'review.evaluation.change', version: 1 });
export const REVIEW_DIRECT_HANDLER_CAPABILITY = ref('capability.review.direct');
export const REVIEW_DIRECT_REQUEST_HASH_PROFILE = ref('request-hash.review.direct');

const nullSchema = z.null();
const staleSchema = z.strictObject({ code: z.string().trim().min(1).max(80), action: z.enum(['open_round', 'discard_empty_round', 'step_back', 'commit_review', 'amend_review']), subjectId: z.string().trim().min(1).max(512) });
export const reviewDirectContributionSchema = z.union([
  z.strictObject({ result: z.strictObject({ kind: z.literal('success'), data: reviewMutationResultSchema }), domain: z.strictObject({ kind: z.literal('review_direct_change'), plan: reviewMutationPlanSchema }), effectContributions: z.tuple([]) }).superRefine((value, context) => {
    if (value.result.data.action !== value.domain.plan.action) context.addIssue({ code: 'custom', message: 'Review action mismatch.' });
  }),
  z.strictObject({ result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }), domain: z.null(), effectContributions: z.tuple([]) })
]);

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
const refs = {
  contribution: createSafeSchemaManifestRef('schema.review.direct.contribution', reviewDirectContributionSchema),
  canonical: createSafeSchemaManifestRef('schema.review.direct.canonical-result', reviewDirectCanonicalResultSchema),
  projected: REVIEW_OPERATION_SCHEMA_REFS.roundChange.resultSchema,
  null: createSafeSchemaManifestRef('schema.review.direct.null-detail', nullSchema),
  stale: createSafeSchemaManifestRef('schema.review.direct.stale-detail', staleSchema),
  handler: ref('handler.review.direct'), projection: ref('projection.review.direct.operator'),
  audit: ref('audit.review.direct'), auditProfile: ref('record-profile.review.direct-audit'),
  keySource: ref('idempotency.operator-header')
};

const specs = Object.freeze([
  { key: 'round' as const, operation: REVIEW_ROUND_CHANGE_OPERATION, input: reviewRoundChangeDraftInputSchema, inputRef: REVIEW_OPERATION_SCHEMA_REFS.roundChange.inputSchema, path: '/api/events/current/review/rounds', policy: 'manage' as const, permissions: ['event.manage'] as readonly PermissionId[], actions: ['open_round', 'discard_empty_round'] as readonly ReviewDirectAction[] },
  { key: 'assignment' as const, operation: REVIEW_ASSIGNMENT_STEP_BACK_OPERATION, input: reviewStepBackChangeDraftInputSchema, inputRef: REVIEW_OPERATION_SCHEMA_REFS.stepBack.inputSchema, path: '/api/events/current/review/assignments/step-back', policy: 'stepBack' as const, permissions: ['submission.score'] as readonly PermissionId[], actions: ['step_back'] as readonly ReviewDirectAction[] },
  { key: 'evaluation' as const, operation: REVIEW_EVALUATION_CHANGE_OPERATION, input: reviewEvaluationChangeDraftInputSchema, inputRef: REVIEW_OPERATION_SCHEMA_REFS.evaluationChange.inputSchema, path: '/api/events/current/review/evaluations', policy: 'evaluate' as const, permissions: ['submission.comment', 'submission.score'] as readonly PermissionId[], actions: ['commit_review', 'amend_review'] as readonly ReviewDirectAction[] }
]);

export interface ReviewDirectCurrentEventSource { resolveCurrentEvent(workspaceId: WorkspaceId): { readonly eventId?: string; readonly evidenceIds: readonly string[] } | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }> }
export interface CreateReviewDirectOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: { readonly manage: VersionedAccessPolicyRef; readonly stepBack: VersionedAccessPolicyRef; readonly evaluate: VersionedAccessPolicyRef };
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ReviewDirectCurrentEventSource;
  readonly clock: Clock; readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef; readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef; readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef; readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

const authorityOutcome = (reason: CurrentAuthorityDenialReason): StructuredOutcome => Object.freeze({ class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 });
function scopeResolver(workspaceId: WorkspaceId, source: ReviewDirectCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({ async resolve() { const value = await source.resolveCurrentEvent(workspaceId); const eventId = value.eventId ? parseEventId(value.eventId) : undefined; return Object.freeze({ workspaceId, ...(eventId ? { eventId } : {}), subjects: Object.freeze(eventId ? [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }] : [{ kind: 'workspace' as const, id: workspaceId }]), resolutionEvidenceIds: Object.freeze([...new Set(value.evidenceIds)].sort()) }); } });
}

export function createReviewDirectOperationModule(input: CreateReviewDirectOperationModuleInput): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const scope = scopeResolver(workspaceId, input.currentEvent);
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: refs.null }));
  const contention = Object.freeze({ class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 });
  const built = specs.map((spec) => {
    const local = { context: ref(`context.review.${spec.key}-change`), autonomy: ref(`autonomy.review.${spec.key}-change`), family: ref(`review.${spec.key}-change.execution-family`), phase: ref(`review.${spec.key}-change.phase.direct-uow`), terminal: ref(`review.${spec.key}-change.terminalization`), risk: ref(`review.${spec.key}-change.risk`), evidence: ref(`review.${spec.key}-change.evidence`), approval: ref(`review.${spec.key}-change.approval`), preflight: ref(`review.${spec.key}-change.preflight`), concurrency: ref(`concurrency.review.${spec.key}-change`) };
    const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policies[spec.policy] });
    const context = createEffectInvocationContextBuilder({ reference: local.context, operation: spec.operation, effect: 'commit', lanes: [lane], scopeResolver: scope, authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId, authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile, requestCanonicalizationProfile: input.requestCanonicalizationProfile, requestHashProfile: REVIEW_DIRECT_REQUEST_HASH_PROFILE, requestHashSealer: input.requestHashSealer, idempotencyCredentialProfile: input.idempotencyCredentialProfile, idempotencyCredentialSealer: input.idempotencyCredentialSealer, deniedAuthorityOutcome: authorityOutcome });
    const family = createSingleUnitOfWorkFamilyRegistration({ reference: local.family, phase: local.phase });
    const terminal = createTerminalizationResolverRegistration({ reference: local.terminal, operation: spec.operation, phase: local.phase, resolve: ({ result }) => result.kind === 'success' ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const } });
    const phase = createSingleUnitOfWorkPhaseRegistration({ reference: local.phase, family: local.family, operation: spec.operation, effect: 'commit', handler: refs.handler, handlerCapability: REVIEW_DIRECT_HANDLER_CAPABILITY, contributionSchema: refs.contribution, terminalization: local.terminal, terminalOutcomeKeys: [], contentionOutcome: contention });
    const autonomy = createOperationAutonomyPolicy({ definition: local.autonomy, operation: spec.operation, riskFloor: 'normal', unattendedRiskCeiling: 'normal', supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'], triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval', approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry', ambiguous_external_effect: 'reconcile', stale_plan: 'replan', compensation_required: 'compensate', terminal_failure: 'attention' }, requiresSeparateApproval: false });
    const risk = createOperationRiskResolverRegistration({ reference: local.risk, operation: spec.operation, resolve: () => ({ risk: 'normal' as const, consequenceTags: Object.freeze(['review-changed']), evidenceIds: Object.freeze([`review.${spec.key}.risk`]) }) });
    const evidence = createAutonomyEvidenceResolverRegistration({ reference: local.evidence, operation: spec.operation, resolve: ({ subject }) => { const bounds = Object.freeze({ scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0, maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) }); return Object.freeze({ evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds, spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt, proposedAction: Object.freeze({ key: `review.${spec.key}.execute`, version: 1, digestSha256: subject.requestHashSha256 }), failure: Object.freeze({ kind: 'none' as const }) }); } });
    const approval = createRenewedApprovalResolverRegistration({ reference: local.approval, operation: spec.operation, resolve: () => ({ approverCurrentlyAuthorized: false }) });
    const preflight = createAutonomyPreflightRegistration({ reference: local.preflight, operation: spec.operation, policy: local.autonomy, riskResolver: local.risk, evidenceResolver: local.evidence, approvalResolver: local.approval, interventionOutcomes: autonomyInterventionOutcomes(1) });
    return { spec, local, lane, context, family, terminal, phase, autonomy, risk, evidence, approval, preflight };
  });
  const handler = createReviewDirectHandler({ reference: refs.handler, handlerCapability: REVIEW_DIRECT_HANDLER_CAPABILITY, contributionSchema: refs.contribution, canonicalResultSchema: refs.canonical, actionForOperation(name, version, businessInput) { const spec = specs.find((candidate) => candidate.operation.name === name && candidate.operation.version === version); if (!spec) return undefined; const action = (businessInput as { action?: unknown })?.action; return typeof action === 'string' && spec.actions.includes(action as ReviewDirectAction) ? action as ReviewDirectAction : undefined; } });
  const history = Object.freeze({ open_round: 'Opened a review round', discard_empty_round: 'Discarded an empty review round', step_back: 'Stepped back a review assignment', commit_review: 'Submitted a review', amend_review: 'Amended a review' });
  return Object.freeze({ id: 'review.direct-operations', source: Object.freeze({
    contextBuilders: Object.freeze([]), readCapabilities: Object.freeze([]), handlers: Object.freeze([]), operations: Object.freeze([]),
    effectExecutionFamilies: Object.freeze(built.map((v) => v.family)), effectPhases: Object.freeze(built.map((v) => v.phase)), terminalizationResolvers: Object.freeze(built.map((v) => v.terminal)), riskResolvers: Object.freeze(built.map((v) => v.risk)), autonomyEvidenceResolvers: Object.freeze(built.map((v) => v.evidence)), renewedApprovalResolvers: Object.freeze(built.map((v) => v.approval)), autonomyPreflights: Object.freeze(built.map((v) => v.preflight)), autonomyPolicies: Object.freeze(built.map((v) => v.autonomy)),
    schemas: Object.freeze([...specs.map((spec) => ({ reference: spec.inputRef, schema: spec.input })), { reference: refs.contribution, schema: reviewDirectContributionSchema }, { reference: refs.canonical, schema: reviewDirectCanonicalResultSchema }, { reference: refs.projected, schema: reviewDirectOperationResultSchema }, { reference: refs.null, schema: nullSchema }, { reference: refs.stale, schema: staleSchema }]),
    effectContextBuilders: Object.freeze(built.map((v) => v.context)), effectHandlers: Object.freeze([handler]), projections: Object.freeze([{ reference: refs.projection, canonicalResultSchema: refs.canonical, projectedResultSchema: refs.projected, project: (candidate: unknown) => reviewDirectCanonicalResultSchema.parse(candidate) }]), operationAuditTargets: Object.freeze([{ reference: refs.audit, kind: 'operation_audit_record' as const, recordProfile: refs.auditProfile }]), operationAuditRecordProfiles: Object.freeze([{ reference: refs.auditProfile, kind: 'canonical_json' as const, maximumBytes: 65_536 }]),
    effectOperations: Object.freeze(built.map(({ spec, local, lane }) => ({ ...spec.operation, lifecycle: { status: 'active' as const }, summary: `Change Review ${spec.key} state.`, effect: 'commit' as const, maxRisk: 'normal' as const, autonomyPolicy: local.autonomy, consequenceTags: ['review-changed'], agentAction: { eligible: true as const, displayLabel: `Change review ${spec.key.replaceAll('_', ' ')}`, consequences: ['Review workflow or evaluation state may change.'], externalEffect: 'none' as const }, inputSchema: spec.inputRef, contributionSchema: refs.contribution, canonicalResultSchema: refs.canonical, outcomes: [{ class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: refs.null }, ...access, { class: 'conflict' as const, kind: 'review.event_required', retryable: false, detailSchema: refs.null }, { class: 'conflict' as const, kind: 'review.viewer_required', retryable: false, detailSchema: refs.null }, { class: 'stale_revision' as const, kind: 'review.canonical_changed', retryable: false, detailSchema: refs.stale }, { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: refs.null }, ...autonomyInterventionOutcomeDeclarations(refs.null)], accessLanes: [lane], contextBuilder: local.context, handlerCapability: REVIEW_DIRECT_HANDLER_CAPABILITY, handler: refs.handler, audit: { mode: 'required' as const, target: refs.audit }, idempotency: { keySource: refs.keySource, credentialVerifierProfile: input.idempotencyCredentialProfile, requestHashProfile: REVIEW_DIRECT_REQUEST_HASH_PROFILE }, concurrency: local.concurrency, execution: { kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const, family: local.family, phase: local.phase, terminalization: local.terminal, autonomyPreflight: local.preflight, history: { summariesByAction: history } }, bindings: [{ surface: 'operator_http' as const, method: 'POST' as const, path: spec.path, input: 'body' as const, browserResumption: { kind: 'none' as const }, projection: refs.projection }] })))
  }) });
}
