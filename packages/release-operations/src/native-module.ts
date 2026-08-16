import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  RELEASE_OPERATION_SCHEMA_REFS,
  releaseAuthorInputSchema,
  releaseMutationPlanSchema,
  releaseMutationResultSchema,
  releasePublishCanonicalResultSchema,
  releasePublishInputSchema,
  releasePublishOperationResultSchema,
  releaseReviewDraftCanonicalResultSchema,
  releaseReviewDraftDataSchema,
  releaseReviewDraftOperationResultSchema,
  releaseSafeDiffSchema,
  structuredOutcomeSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import { parseEventId, parseInstant, parseWorkspaceId, type Clock, type InvocationId, type WorkspaceId } from '@jooevents/kernel';
import { releaseStaleDetailSchema } from '@jooevents/release';
import { z } from 'zod';
import { createReleaseNativeHandler } from './native-preparation';
import { RELEASE_CHANGE_DRAFT_OPERATION, RELEASE_DRAFT_ACCESS_POLICY, RELEASE_DRAFT_PERMISSION_ID } from './policy';

export const RELEASE_PUBLISH_OPERATION = Object.freeze({ name: 'release.publish', version: 1 });
export const RELEASE_NATIVE_DRAFT_HANDLER_CAPABILITY = ref('capability.release.review-draft');
export const RELEASE_NATIVE_PUBLISH_HANDLER_CAPABILITY = ref('capability.release.publish');
export const RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.release.review-draft');
export const RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE = ref('request-hash.release.publish');

const nullSchema = z.null();
export const releaseNativeDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: releaseReviewDraftDataSchema }),
    domain: z.strictObject({
      kind: z.literal('release_review_draft'),
      draftId: z.uuid(), revisionId: z.uuid(), revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      plan: releaseMutationPlanSchema, safeDiff: releaseSafeDiffSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({ result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }), domain: z.null(), effectContributions: z.tuple([]) })
]);
export const releaseNativePublishContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: releaseMutationResultSchema }),
    domain: z.strictObject({
      kind: z.literal('release_review_publish'), draftId: z.uuid(), revisionId: z.uuid(),
      revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/), plan: releaseMutationPlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({ result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }), domain: z.null(), effectContributions: z.tuple([]) })
]);

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
const schemas = {
  draftInput: RELEASE_OPERATION_SCHEMA_REFS.reviewDraft.inputSchema,
  draftContribution: createSafeSchemaManifestRef('schema.release.review-draft.contribution', releaseNativeDraftContributionSchema),
  draftCanonical: createSafeSchemaManifestRef('schema.release.review-draft.canonical-result', releaseReviewDraftCanonicalResultSchema),
  draftProjected: RELEASE_OPERATION_SCHEMA_REFS.reviewDraft.resultSchema,
  publishInput: RELEASE_OPERATION_SCHEMA_REFS.publish.inputSchema,
  publishContribution: createSafeSchemaManifestRef('schema.release.publish.contribution', releaseNativePublishContributionSchema),
  publishCanonical: createSafeSchemaManifestRef('schema.release.publish.canonical-result', releasePublishCanonicalResultSchema),
  publishProjected: RELEASE_OPERATION_SCHEMA_REFS.publish.resultSchema,
  null: createSafeSchemaManifestRef('schema.release.native.null-detail', nullSchema),
  stale: createSafeSchemaManifestRef('schema.release.native.changed-detail', releaseStaleDetailSchema, 3)
};
const common = { audit: ref('audit.release.native'), auditProfile: ref('record-profile.release.native-audit'), keySource: ref('idempotency.operator-header') };

export interface CreateReleaseNativeOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: { resolveCurrentEvent(workspaceId: WorkspaceId): { readonly eventId?: string; readonly evidenceIds: readonly string[] } | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }> };
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly draftRequestHashSealer: RequestHashSealer;
  readonly publishRequestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return { class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
}

export function createReleaseNativeOperationModule(input: CreateReleaseNativeOperationModuleInput): OperationRegistryModule {
  if (input.policy.key !== RELEASE_DRAFT_ACCESS_POLICY.key || input.policy.version !== RELEASE_DRAFT_ACCESS_POLICY.version) throw new TypeError('release_native_policy_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy });
  const scope: InvocationScopeResolver = Object.freeze({ async resolve() {
    const current = await input.currentEvent.resolveCurrentEvent(workspaceId);
    const eventId = current.eventId ? parseEventId(current.eventId) : undefined;
    return Object.freeze({ workspaceId, ...(eventId ? { eventId } : {}), subjects: Object.freeze(eventId ? [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }] : [{ kind: 'workspace' as const, id: workspaceId }]), resolutionEvidenceIds: Object.freeze([...new Set(current.evidenceIds)].sort()) });
  } });
  const entries = [
    { key: 'draft', operation: RELEASE_CHANGE_DRAFT_OPERATION, effect: 'draft' as const, capability: RELEASE_NATIVE_DRAFT_HANDLER_CAPABILITY, hash: RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE, sealer: input.draftRequestHashSealer, input: schemas.draftInput, contribution: schemas.draftContribution, canonical: schemas.draftCanonical, projected: schemas.draftProjected, path: '/api/events/current/releases/drafts', risk: 'normal' as const },
    { key: 'publish', operation: RELEASE_PUBLISH_OPERATION, effect: 'commit' as const, capability: RELEASE_NATIVE_PUBLISH_HANDLER_CAPABILITY, hash: RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE, sealer: input.publishRequestHashSealer, input: schemas.publishInput, contribution: schemas.publishContribution, canonical: schemas.publishCanonical, projected: schemas.publishProjected, path: '/api/events/current/releases/publish', risk: 'consequential' as const }
  ].map((entry) => {
    const refs = { context: ref(`context.release.native.${entry.key}`), autonomy: ref(`autonomy.release.native.${entry.key}`), concurrency: ref(`concurrency.release.native.${entry.key}`), family: ref(`release.native.${entry.key}.family`), phase: ref(`release.native.${entry.key}.phase`), terminal: ref(`release.native.${entry.key}.terminal`), risk: ref(`release.native.${entry.key}.risk`), evidence: ref(`release.native.${entry.key}.evidence`), approval: ref(`release.native.${entry.key}.approval`), preflight: ref(`release.native.${entry.key}.preflight`), handler: ref(`handler.release.native.${entry.key}`), projection: ref(`projection.release.native.${entry.key}`) };
    const autonomy = createOperationAutonomyPolicy({ definition: refs.autonomy, operation: entry.operation, riskFloor: entry.risk, unattendedRiskCeiling: entry.risk, supportedDispositions: ['proceed','safe_retry','reconcile','renewed_approval','replan','compensate','block','attention'], triggerDispositions: { authority_lost:'block', unattended_bounds_exceeded:'renewed_approval', approval_required:'renewed_approval', known_retryable_failure:'safe_retry', ambiguous_external_effect:'reconcile', stale_plan:'replan', compensation_required:'compensate', terminal_failure:'attention' }, requiresSeparateApproval: false });
    const context = createEffectInvocationContextBuilder({ reference: refs.context, operation: entry.operation, effect: entry.effect, lanes: [lane], scopeResolver: scope, authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId, authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile, requestCanonicalizationProfile: input.requestCanonicalizationProfile, requestHashProfile: entry.hash, requestHashSealer: entry.sealer, idempotencyCredentialProfile: input.idempotencyCredentialProfile, idempotencyCredentialSealer: input.idempotencyCredentialSealer, deniedAuthorityOutcome: authorityOutcome });
    const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
    const terminal = createTerminalizationResolverRegistration({ reference: refs.terminal, operation: entry.operation, phase: refs.phase, resolve: ({ result }) => result.kind === 'success' ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const } });
    const phase = createSingleUnitOfWorkPhaseRegistration({ reference: refs.phase, family: refs.family, operation: entry.operation, effect: entry.effect, handler: refs.handler, handlerCapability: entry.capability, contributionSchema: entry.contribution, terminalization: refs.terminal, terminalOutcomeKeys: [], contentionOutcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 } });
    const risk = createOperationRiskResolverRegistration({ reference: refs.risk, operation: entry.operation, resolve: () => ({ risk: entry.risk, consequenceTags: Object.freeze([entry.key === 'draft' ? 'release-review-drafted' : 'release-published']), evidenceIds: Object.freeze([`release.${entry.key}.risk`]) }) });
    const evidence = createAutonomyEvidenceResolverRegistration({ reference: refs.evidence, operation: entry.operation, resolve: ({ subject }) => { const bounds = Object.freeze({ scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0, maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) }); return { evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds, spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt, proposedAction: { key: `release.${entry.key}.execute`, version: 1, digestSha256: subject.requestHashSha256 }, failure: { kind: 'none' as const } }; } });
    const approval = createRenewedApprovalResolverRegistration({ reference: refs.approval, operation: entry.operation, resolve: () => ({ approverCurrentlyAuthorized: false }) });
    const preflight = createAutonomyPreflightRegistration({ reference: refs.preflight, operation: entry.operation, policy: refs.autonomy, riskResolver: refs.risk, evidenceResolver: refs.evidence, approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1) });
    const handler = createReleaseNativeHandler({ reference: refs.handler, effect: entry.effect, capability: entry.capability, contributionSchema: entry.contribution, canonicalResultSchema: entry.canonical });
    return { entry, refs, autonomy, context, family, terminal, phase, risk, evidence, approval, preflight, handler };
  });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.null }));
  const summaries = Object.freeze({ publish_schedule:'Published the schedule', program_rollback:'Rolled back the published program', style_set_publish:'Published the event style', surface_publish:'Published a public surface', surface_rollback:'Rolled back a public surface', surface_allowlist:"Updated a public surface's embed access" });
  return Object.freeze({ id: 'release.native-reviewed-operations', source: Object.freeze({
    contextBuilders: Object.freeze([]), readCapabilities: Object.freeze([]), handlers: Object.freeze([]), operations: Object.freeze([]),
    effectExecutionFamilies: Object.freeze(entries.map((v) => v.family)), effectPhases: Object.freeze(entries.map((v) => v.phase)), terminalizationResolvers: Object.freeze(entries.map((v) => v.terminal)), riskResolvers: Object.freeze(entries.map((v) => v.risk)), autonomyEvidenceResolvers: Object.freeze(entries.map((v) => v.evidence)), renewedApprovalResolvers: Object.freeze(entries.map((v) => v.approval)), autonomyPreflights: Object.freeze(entries.map((v) => v.preflight)), autonomyPolicies: Object.freeze(entries.map((v) => v.autonomy)),
    schemas: Object.freeze([{ reference: schemas.draftInput, schema: releaseAuthorInputSchema }, { reference: schemas.draftContribution, schema: releaseNativeDraftContributionSchema }, { reference: schemas.draftCanonical, schema: releaseReviewDraftCanonicalResultSchema }, { reference: schemas.draftProjected, schema: releaseReviewDraftOperationResultSchema }, { reference: schemas.publishInput, schema: releasePublishInputSchema }, { reference: schemas.publishContribution, schema: releaseNativePublishContributionSchema }, { reference: schemas.publishCanonical, schema: releasePublishCanonicalResultSchema }, { reference: schemas.publishProjected, schema: releasePublishOperationResultSchema }, { reference: schemas.null, schema: nullSchema }, { reference: schemas.stale, schema: releaseStaleDetailSchema }]),
    effectContextBuilders: Object.freeze(entries.map((v) => v.context)), effectHandlers: Object.freeze(entries.map((v) => v.handler)), projections: Object.freeze(entries.map((v) => ({ reference: v.refs.projection, canonicalResultSchema: v.entry.canonical, projectedResultSchema: v.entry.projected, project: (candidate: unknown) => v.entry.key === 'draft' ? releaseReviewDraftCanonicalResultSchema.parse(candidate) : releasePublishCanonicalResultSchema.parse(candidate) }))), operationAuditTargets: Object.freeze([{ reference: common.audit, kind: 'operation_audit_record' as const, recordProfile: common.auditProfile }]), operationAuditRecordProfiles: Object.freeze([{ reference: common.auditProfile, kind: 'canonical_json' as const, maximumBytes: 262_144 }]),
    effectOperations: Object.freeze(entries.map(({ entry, refs }) => ({ ...entry.operation, lifecycle: { status: 'active' as const }, summary: entry.key === 'draft' ? 'Prepare one owner-native Release revision for review.' : 'Publish one reviewed Release revision.', effect: entry.effect, maxRisk: entry.risk, autonomyPolicy: refs.autonomy, consequenceTags: [entry.key === 'draft' ? 'release-review-drafted' : 'release-published'], inputSchema: entry.input, contributionSchema: entry.contribution, canonicalResultSchema: entry.canonical, outcomes: [{ class:'idempotency_conflict' as const, kind:'operation.request_changed', retryable:false, detailSchema:schemas.null }, ...access, { class:'conflict' as const, kind:'release.event_required', retryable:false, detailSchema:schemas.null }, { class:'stale_revision' as const, kind:'release.changed', retryable:false, detailSchema:schemas.stale }, { class:'conflict' as const, kind:'release.draft_changed', retryable:false, detailSchema:schemas.null }, { class:'conflict' as const, kind:'operation.in_progress', retryable:true, detailSchema:schemas.null }, ...autonomyInterventionOutcomeDeclarations(schemas.null)], accessLanes:[lane], contextBuilder:refs.context, handlerCapability:entry.capability, handler:refs.handler, audit:{ mode:'required' as const, target:common.audit }, idempotency:{ keySource:common.keySource, credentialVerifierProfile:input.idempotencyCredentialProfile, requestHashProfile:entry.hash }, concurrency:refs.concurrency, execution: entry.key === 'publish' ? { kind:'single_unit_of_work' as const, profile:'direct_audited' as const, family:refs.family, phase:refs.phase, terminalization:refs.terminal, autonomyPreflight:refs.preflight, history:{ summariesByAction:summaries } } : { kind:'single_unit_of_work' as const, family:refs.family, phase:refs.phase, terminalization:refs.terminal, autonomyPreflight:refs.preflight }, bindings:[{ surface:'operator_http' as const, method:'POST' as const, path:entry.path, input:'body' as const, browserResumption:{ kind:'none' as const }, projection:refs.projection }] })))
  }) });
}
