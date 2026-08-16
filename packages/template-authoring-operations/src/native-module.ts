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
  structuredOutcomeSchema,
  TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
  templateArtifactMutationInputSchema,
  templateArtifactMutationPlanSchema,
  templateArtifactPublishCanonicalResultSchema,
  templateArtifactPublishDataSchema,
  templateArtifactPublishInputSchema,
  templateArtifactPublishOperationResultSchema,
  templateArtifactReviewDraftCanonicalResultSchema,
  templateArtifactReviewDraftDataSchema,
  templateArtifactReviewDraftOperationResultSchema,
  templateArtifactSafeDiffSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { EVENT_MANAGE_ACCESS_POLICY } from '@jooevents/event-operations';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import { parseEventId, parseInstant, parseWorkspaceId, type Clock, type InvocationId, type WorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import { createTemplateArtifactNativeHandler } from './native-preparation';
export const TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION = Object.freeze({
  name: 'template.artifact.change.draft', version: 1
});
export const TEMPLATE_ARTIFACT_PUBLISH_OPERATION = Object.freeze({ name: 'template.artifact.change', version: 1 });
export const TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY = ref('capability.template.artifact.review-draft');
export const TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY = ref('capability.template.artifact.publish');
export const TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.template.artifact.review-draft');
export const TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE = ref('request-hash.template.artifact.publish');

const nullSchema = z.null();
const staleSchema = z.strictObject({
  code: z.enum(['wrong_scope', 'artifact_missing', 'artifact_kind_changed', 'stale_revision', 'revision_missing', 'no_changes', 'invalid_plan']),
  action: z.enum(['replace', 'revert']),
  artifactId: z.uuid()
});
export const templateArtifactNativeDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: templateArtifactReviewDraftDataSchema }),
    domain: z.strictObject({
      kind: z.literal('template_artifact_review_draft'),
      draftId: z.uuid(), revisionId: z.uuid(), revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      plan: templateArtifactMutationPlanSchema, safeDiff: templateArtifactSafeDiffSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({ result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }), domain: z.null(), effectContributions: z.tuple([]) })
]);
export const templateArtifactNativePublishContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: templateArtifactPublishDataSchema }),
    domain: z.strictObject({
      kind: z.literal('template_artifact_review_publish'),
      draftId: z.uuid(), revisionId: z.uuid(), revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      plan: templateArtifactMutationPlanSchema, safeDiff: templateArtifactSafeDiffSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({ result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }), domain: z.null(), effectContributions: z.tuple([]) })
]);

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
const schemas = Object.freeze({
  draftInput: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.reviewDraft.inputSchema,
  draftContribution: createSafeSchemaManifestRef('schema.template-artifact.review-draft.contribution', templateArtifactNativeDraftContributionSchema),
  draftCanonical: createSafeSchemaManifestRef('schema.template-artifact.review-draft.canonical-result', templateArtifactReviewDraftCanonicalResultSchema),
  draftProjected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.reviewDraft.resultSchema,
  publishInput: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.publish.inputSchema,
  publishContribution: createSafeSchemaManifestRef('schema.template-artifact.publish.contribution', templateArtifactNativePublishContributionSchema),
  publishCanonical: createSafeSchemaManifestRef('schema.template-artifact.publish.canonical-result', templateArtifactPublishCanonicalResultSchema),
  publishProjected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.publish.resultSchema,
  null: createSafeSchemaManifestRef('schema.template-artifact.native.null-detail', nullSchema),
  stale: createSafeSchemaManifestRef('schema.template-artifact.native.changed-detail', staleSchema)
});
const common = Object.freeze({ audit: ref('audit.template-artifact.native'), auditProfile: ref('record-profile.template-artifact.native-audit'), keySource: ref('idempotency.operator-header') });

export interface CreateTemplateArtifactNativeOperationModuleInput {
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

export function createTemplateArtifactNativeOperationModule(input: CreateTemplateArtifactNativeOperationModuleInput): OperationRegistryModule {
  if (input.policy.key !== EVENT_MANAGE_ACCESS_POLICY.key || input.policy.version !== EVENT_MANAGE_ACCESS_POLICY.version) throw new TypeError('template_artifact_native_policy_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy });
  const scope: InvocationScopeResolver = Object.freeze({ async resolve() {
    const current = await input.currentEvent.resolveCurrentEvent(workspaceId);
    const eventId = current.eventId ? parseEventId(current.eventId) : undefined;
    return Object.freeze({ workspaceId, ...(eventId ? { eventId } : {}), subjects: Object.freeze(eventId ? [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }] : [{ kind: 'workspace' as const, id: workspaceId }]), resolutionEvidenceIds: Object.freeze([...new Set(current.evidenceIds)].sort()) });
  } });
  const entries = [
    { key: 'draft' as const, operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION, effect: 'draft' as const, capability: TEMPLATE_ARTIFACT_NATIVE_DRAFT_HANDLER_CAPABILITY, hash: TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE, sealer: input.draftRequestHashSealer, inputRef: schemas.draftInput, inputSchema: templateArtifactMutationInputSchema, contributionRef: schemas.draftContribution, contributionSchema: templateArtifactNativeDraftContributionSchema, canonicalRef: schemas.draftCanonical, canonicalSchema: templateArtifactReviewDraftCanonicalResultSchema, projectedRef: schemas.draftProjected, projectedSchema: templateArtifactReviewDraftOperationResultSchema, path: '/api/events/current/template-artifacts/drafts', risk: 'normal' as const },
    { key: 'publish' as const, operation: TEMPLATE_ARTIFACT_PUBLISH_OPERATION, effect: 'commit' as const, capability: TEMPLATE_ARTIFACT_NATIVE_PUBLISH_HANDLER_CAPABILITY, hash: TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE, sealer: input.publishRequestHashSealer, inputRef: schemas.publishInput, inputSchema: templateArtifactPublishInputSchema, contributionRef: schemas.publishContribution, contributionSchema: templateArtifactNativePublishContributionSchema, canonicalRef: schemas.publishCanonical, canonicalSchema: templateArtifactPublishCanonicalResultSchema, projectedRef: schemas.publishProjected, projectedSchema: templateArtifactPublishOperationResultSchema, path: '/api/events/current/template-artifacts/publish', risk: 'normal' as const }
  ].map((entry) => {
    const refs = { context: ref(`context.template-artifact.native.${entry.key}`), autonomy: ref(`autonomy.template-artifact.native.${entry.key}`), concurrency: ref(`concurrency.template-artifact.native.${entry.key}`), family: ref(`template-artifact.native.${entry.key}.family`), phase: ref(`template-artifact.native.${entry.key}.phase`), terminal: ref(`template-artifact.native.${entry.key}.terminal`), risk: ref(`template-artifact.native.${entry.key}.risk`), evidence: ref(`template-artifact.native.${entry.key}.evidence`), approval: ref(`template-artifact.native.${entry.key}.approval`), preflight: ref(`template-artifact.native.${entry.key}.preflight`), handler: ref(`handler.template-artifact.native.${entry.key}`), projection: ref(`projection.template-artifact.native.${entry.key}`) };
    const autonomy = createOperationAutonomyPolicy({ definition: refs.autonomy, operation: entry.operation, riskFloor: entry.risk, unattendedRiskCeiling: entry.risk, supportedDispositions: ['proceed','safe_retry','reconcile','renewed_approval','replan','compensate','block','attention'], triggerDispositions: { authority_lost:'block', unattended_bounds_exceeded:'renewed_approval', approval_required:'renewed_approval', known_retryable_failure:'safe_retry', ambiguous_external_effect:'reconcile', stale_plan:'replan', compensation_required:'compensate', terminal_failure:'attention' }, requiresSeparateApproval: false });
    const context = createEffectInvocationContextBuilder({ reference: refs.context, operation: entry.operation, effect: entry.effect, lanes: [lane], scopeResolver: scope, authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId, authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile, requestCanonicalizationProfile: input.requestCanonicalizationProfile, requestHashProfile: entry.hash, requestHashSealer: entry.sealer, idempotencyCredentialProfile: input.idempotencyCredentialProfile, idempotencyCredentialSealer: input.idempotencyCredentialSealer, deniedAuthorityOutcome: authorityOutcome });
    const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
    const terminal = createTerminalizationResolverRegistration({ reference: refs.terminal, operation: entry.operation, phase: refs.phase, resolve: ({ result }) => result.kind === 'success' ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const } });
    const phase = createSingleUnitOfWorkPhaseRegistration({ reference: refs.phase, family: refs.family, operation: entry.operation, effect: entry.effect, handler: refs.handler, handlerCapability: entry.capability, contributionSchema: entry.contributionRef, terminalization: refs.terminal, terminalOutcomeKeys: [], contentionOutcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 } });
    const risk = createOperationRiskResolverRegistration({ reference: refs.risk, operation: entry.operation, resolve: () => ({ risk: entry.risk, consequenceTags: Object.freeze([entry.key === 'draft' ? 'template-review-drafted' : 'template-revision-published']), evidenceIds: Object.freeze([`template.artifact.${entry.key}.risk`]) }) });
    const evidence = createAutonomyEvidenceResolverRegistration({ reference: refs.evidence, operation: entry.operation, resolve: ({ subject }) => { const bounds = Object.freeze({ scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0, maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) }); return { evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds, spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt, proposedAction: { key: `template.artifact.${entry.key}.execute`, version: 1, digestSha256: subject.requestHashSha256 }, failure: { kind: 'none' as const } }; } });
    const approval = createRenewedApprovalResolverRegistration({ reference: refs.approval, operation: entry.operation, resolve: () => ({ approverCurrentlyAuthorized: false }) });
    const preflight = createAutonomyPreflightRegistration({ reference: refs.preflight, operation: entry.operation, policy: refs.autonomy, riskResolver: refs.risk, evidenceResolver: refs.evidence, approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1) });
    const handler = createTemplateArtifactNativeHandler({ reference: refs.handler, effect: entry.effect, capability: entry.capability, contributionSchema: entry.contributionRef, canonicalResultSchema: entry.canonicalRef });
    return { entry, refs, autonomy, context, family, terminal, phase, risk, evidence, approval, preflight, handler };
  });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.null }));
  return Object.freeze({ id: 'template-artifact.native-reviewed-operations', source: Object.freeze({
    contextBuilders: Object.freeze([]), readCapabilities: Object.freeze([]), handlers: Object.freeze([]), operations: Object.freeze([]),
    effectExecutionFamilies: Object.freeze(entries.map((v) => v.family)), effectPhases: Object.freeze(entries.map((v) => v.phase)), terminalizationResolvers: Object.freeze(entries.map((v) => v.terminal)), riskResolvers: Object.freeze(entries.map((v) => v.risk)), autonomyEvidenceResolvers: Object.freeze(entries.map((v) => v.evidence)), renewedApprovalResolvers: Object.freeze(entries.map((v) => v.approval)), autonomyPreflights: Object.freeze(entries.map((v) => v.preflight)), autonomyPolicies: Object.freeze(entries.map((v) => v.autonomy)),
    schemas: Object.freeze([
      { reference: schemas.draftInput, schema: templateArtifactMutationInputSchema },
      { reference: schemas.draftContribution, schema: templateArtifactNativeDraftContributionSchema },
      { reference: schemas.draftCanonical, schema: templateArtifactReviewDraftCanonicalResultSchema },
      { reference: schemas.draftProjected, schema: templateArtifactReviewDraftOperationResultSchema },
      { reference: schemas.publishInput, schema: templateArtifactPublishInputSchema },
      { reference: schemas.publishContribution, schema: templateArtifactNativePublishContributionSchema },
      { reference: schemas.publishCanonical, schema: templateArtifactPublishCanonicalResultSchema },
      { reference: schemas.publishProjected, schema: templateArtifactPublishOperationResultSchema },
      { reference: schemas.null, schema: nullSchema },
      { reference: schemas.stale, schema: staleSchema }
    ]),
    effectContextBuilders: Object.freeze(entries.map((v) => v.context)), effectHandlers: Object.freeze(entries.map((v) => v.handler)), projections: Object.freeze(entries.map((v) => ({ reference: v.refs.projection, canonicalResultSchema: v.entry.canonicalRef, projectedResultSchema: v.entry.projectedRef, project: (candidate: unknown) => v.entry.canonicalSchema.parse(candidate) }))), operationAuditTargets: Object.freeze([{ reference: common.audit, kind: 'operation_audit_record' as const, recordProfile: common.auditProfile }]), operationAuditRecordProfiles: Object.freeze([{ reference: common.auditProfile, kind: 'canonical_json' as const, maximumBytes: 262_144 }]),
    effectOperations: Object.freeze(entries.map(({ entry, refs }) => ({ ...entry.operation, lifecycle: { status: 'active' as const }, summary: entry.key === 'draft' ? 'Prepare one owner-native Template revision for review.' : 'Publish one reviewed Template revision.', effect: entry.effect, maxRisk: entry.risk, autonomyPolicy: refs.autonomy, consequenceTags: [entry.key === 'draft' ? 'template-review-drafted' : 'template-revision-published'], inputSchema: entry.inputRef, contributionSchema: entry.contributionRef, canonicalResultSchema: entry.canonicalRef, outcomes: [{ class:'idempotency_conflict' as const, kind:'operation.request_changed', retryable:false, detailSchema:schemas.null }, ...access, { class:'conflict' as const, kind:'template.artifact.event_required', retryable:false, detailSchema:schemas.null }, { class:'stale_revision' as const, kind:'template.artifact_changed', retryable:false, detailSchema:schemas.stale }, { class:'conflict' as const, kind:'template.artifact.draft_changed', retryable:false, detailSchema:schemas.null }, { class:'conflict' as const, kind:'operation.in_progress', retryable:true, detailSchema:schemas.null }, ...autonomyInterventionOutcomeDeclarations(schemas.null)], accessLanes:[lane], contextBuilder:refs.context, handlerCapability:entry.capability, handler:refs.handler, audit:{ mode:'required' as const, target:common.audit }, idempotency:{ keySource:common.keySource, credentialVerifierProfile:input.idempotencyCredentialProfile, requestHashProfile:entry.hash }, concurrency:refs.concurrency, execution: entry.key === 'publish' ? { kind:'single_unit_of_work' as const, profile:'direct_audited' as const, family:refs.family, phase:refs.phase, terminalization:refs.terminal, autonomyPreflight:refs.preflight, history:{ summariesByAction:Object.freeze({ replace:'Updated a template revision', revert:'Restored a template revision' }) } } : { kind:'single_unit_of_work' as const, family:refs.family, phase:refs.phase, terminalization:refs.terminal, autonomyPreflight:refs.preflight }, bindings:[{ surface:'operator_http' as const, method:'POST' as const, path:entry.path, input:'body' as const, browserResumption:{ kind:'none' as const }, projection:refs.projection }] })))
  }) });
}
