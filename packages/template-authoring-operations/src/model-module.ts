import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type RequestHashSealer
} from '@jooevents/application';
import {
  TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  templateEditClassifyCanonicalResultSchema,
  templateEditClassifyOperationResultSchema,
  templateEditModelChoicesCanonicalResultSchema,
  templateEditModelChoicesDataSchema,
  templateEditModelChoicesInputSchema,
  templateEditModelChoicesOperationResultSchema,
  templateEditRequestSchema,
  templateEditReviseCanonicalResultSchema,
  templateEditReviseOperationResultSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type TemplateEditModelChoiceDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { EVENT_MANAGE_ACCESS_POLICY, EVENT_READ_ACCESS_POLICY } from '@jooevents/event-operations';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import { parseInstant, parseWorkspaceId, type Clock, type InvocationId, type WorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import { createTemplateArtifactDraftHandler } from './preparation';

export const TEMPLATE_EDIT_MODEL_CHOICES_OPERATION = Object.freeze({ name: 'template.edit.model_choices.list', version: 1 });
export const TEMPLATE_EDIT_CLASSIFY_OPERATION = Object.freeze({ name: 'template.edit.classify', version: 1 });
export const TEMPLATE_EDIT_REVISE_OPERATION = Object.freeze({ name: 'template.edit.revise', version: 1 });
export const TEMPLATE_EDIT_MODEL_CHOICES_PATH = '/api/events/current/template-edit/model-choices';
export const TEMPLATE_EDIT_CLASSIFY_PATH = '/api/events/current/template-edit/classifications';
export const TEMPLATE_EDIT_REVISE_PATH = '/api/events/current/template-edit/revisions';
export const TEMPLATE_EDIT_REQUEST_HASH_PROFILE = Object.freeze({ key: 'request-hash.template.edit', version: 1 });
export const TEMPLATE_EDIT_HANDLER_CAPABILITY = Object.freeze({ key: 'capability.template.edit.deterministic-model', version: 1 });

const id = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nullDetail = z.null();
export const templateEditDomainContributionSchema = z.strictObject({
  kind: z.literal('template_edit_model_run'), preparationHandle: id,
  action: z.enum(['classify', 'revise']), workspaceId: id, eventId: id,
  artifactId: id, runId: id, attemptId: id, resultDigestSha256: digest,
  occurredAt: z.iso.datetime({ offset: true })
});
const success = z.union([
  z.strictObject({ result: z.strictObject({ kind: z.literal('success'), data: templateEditClassifyCanonicalResultSchema.options[0].shape.data }), domain: templateEditDomainContributionSchema, receiptChildren: z.tuple([]) }),
  z.strictObject({ result: z.strictObject({ kind: z.literal('success'), data: templateEditReviseCanonicalResultSchema.options[0].shape.data }), domain: templateEditDomainContributionSchema, receiptChildren: z.tuple([]) })
]);
const outcome = z.strictObject({ result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }), domain: z.null(), receiptChildren: z.tuple([]) });
export const templateEditContributionSchema = z.union([success, outcome]);

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef { return createSafeSchemaManifestRef(key, schema); }
function scope(workspaceId: WorkspaceId): InvocationScopeResolver { return Object.freeze({ resolve: () => Object.freeze({ workspaceId, subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]), resolutionEvidenceIds: Object.freeze(['workspace.current']) }) }); }
function denied(reason: CurrentAuthorityDenialReason): StructuredOutcome { return { class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 }; }

export interface CreateTemplateEditOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: { readonly read: VersionedAccessPolicyRef; readonly manage: VersionedAccessPolicyRef };
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly choices: () => readonly TemplateEditModelChoiceDto[];
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export function createTemplateEditOperationModule(input: CreateTemplateEditOperationModuleInput): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.read.key !== EVENT_READ_ACCESS_POLICY.key || input.policies.read.version !== EVENT_READ_ACCESS_POLICY.version
      || input.policies.manage.key !== EVENT_MANAGE_ACCESS_POLICY.key || input.policies.manage.version !== EVENT_MANAGE_ACCESS_POLICY.version) throw new TypeError('template_edit_policy_catalog_mismatch');
  const readLane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policies.read });
  const manageLane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policies.manage });
  const operations = [{ key: 'classify' as const, operation: TEMPLATE_EDIT_CLASSIFY_OPERATION, path: TEMPLATE_EDIT_CLASSIFY_PATH, canonical: templateEditClassifyCanonicalResultSchema, projected: templateEditClassifyOperationResultSchema }, { key: 'revise' as const, operation: TEMPLATE_EDIT_REVISE_OPERATION, path: TEMPLATE_EDIT_REVISE_PATH, canonical: templateEditReviseCanonicalResultSchema, projected: templateEditReviseOperationResultSchema }];
  const operationRefs = (key: 'classify' | 'revise') => Object.freeze({
    context: ref(`context.template.edit.${key}`),
    autonomy: ref(`autonomy.template.edit.${key}`),
    handler: ref(`handler.template.edit.${key}`),
    projection: ref(`projection.template.edit.${key}.operator`),
    family: ref(`family.template.edit.${key}`),
    phase: ref(`phase.template.edit.${key}`),
    terminalization: ref(`terminalization.template.edit.${key}`),
    risk: ref(`risk.template.edit.${key}`),
    evidence: ref(`evidence.template.edit.${key}`),
    approval: ref(`approval.template.edit.${key}`),
    preflight: ref(`preflight.template.edit.${key}`),
    concurrency: ref(`concurrency.template.edit.${key}`)
  });
  const refs = Object.freeze({
    classify: operationRefs('classify'),
    revise: operationRefs('revise')
  });
  const contributionRef = schemaRef('schema.template.edit.contribution', templateEditContributionSchema);
  const nullRef = schemaRef('schema.template.edit.null-detail', nullDetail);
  const auditRef = ref('audit.template.edit'); const recordRef = ref('record-profile.template.edit.audit'); const keySource = ref('idempotency.operator-header');
  const choicesAutonomy = createOperationAutonomyPolicy({ definition: ref('autonomy.template.edit.model-choices'), operation: TEMPLATE_EDIT_MODEL_CHOICES_OPERATION, riskFloor: 'low', unattendedRiskCeiling: 'low', supportedDispositions: ['proceed','safe_retry','reconcile','renewed_approval','replan','compensate','block','attention'], triggerDispositions: { authority_lost:'block', unattended_bounds_exceeded:'renewed_approval', approval_required:'renewed_approval', known_retryable_failure:'safe_retry', ambiguous_external_effect:'reconcile', stale_plan:'replan', compensation_required:'compensate', terminal_failure:'attention' }, requiresSeparateApproval: false });
  const autonomies = operations.map(({ key, operation }) => createOperationAutonomyPolicy({ definition: refs[key].autonomy, operation, riskFloor: 'low', unattendedRiskCeiling: 'low', supportedDispositions: ['proceed','safe_retry','reconcile','renewed_approval','replan','compensate','block','attention'], triggerDispositions: { authority_lost:'block', unattended_bounds_exceeded:'renewed_approval', approval_required:'renewed_approval', known_retryable_failure:'safe_retry', ambiguous_external_effect:'reconcile', stale_plan:'replan', compensation_required:'compensate', terminal_failure:'attention' }, requiresSeparateApproval: false }));
  const contexts = operations.map(({ key, operation }) => createEffectInvocationContextBuilder({ reference: refs[key].context!, operation, effect: 'draft', lanes: [manageLane], scopeResolver: scope(workspaceId), authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId, authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile, requestCanonicalizationProfile: input.requestCanonicalizationProfile, requestHashProfile: TEMPLATE_EDIT_REQUEST_HASH_PROFILE, requestHashSealer: input.requestHashSealer, idempotencyCredentialProfile: input.idempotencyCredentialProfile, idempotencyCredentialSealer: input.idempotencyCredentialSealer, deniedAuthorityOutcome: denied }));
  const families = operations.map(({ key }) => createSingleUnitOfWorkFamilyRegistration({ reference: refs[key].family!, phase: refs[key].phase! }));
  const terminalizations = operations.map(({ key, operation }) => createTerminalizationResolverRegistration({ reference: refs[key].terminalization!, operation, phase: refs[key].phase!, resolve: ({ result }) => result.kind === 'success' ? { kind: 'terminal' } : { kind: 'nonterminal' } }));
  const phases = operations.map(({ key, operation }, index) => createSingleUnitOfWorkPhaseRegistration({ reference: refs[key].phase!, family: refs[key].family!, operation, effect: 'draft', handler: refs[key].handler!, handlerCapability: TEMPLATE_EDIT_HANDLER_CAPABILITY, contributionSchema: contributionRef, terminalization: refs[key].terminalization!, terminalOutcomeKeys: [], contentionOutcome: { class:'conflict', kind:'operation.in_progress', retryable:true, subjects:[], detail:null, detailSchemaVersion:1 } }));
  const risks = operations.map(({ key, operation }) => createOperationRiskResolverRegistration({ reference: refs[key].risk!, operation, resolve: () => ({ risk:'low', consequenceTags:['model-draft-produced'], evidenceIds:[`template.edit.${key}.risk`] }) }));
  const evidences = operations.map(({ key, operation }) => createAutonomyEvidenceResolverRegistration({ reference: refs[key].evidence!, operation, resolve: ({ subject }) => { const bounds = { scopeKeys:[...subject.scopeKeys], maximumSpendMicros:0, maximumActions:1, notAfter:parseInstant(new Date(Date.parse(subject.evaluatedAt)+60_000).toISOString()) }; return { evaluatedAt:subject.evaluatedAt, hardBounds:bounds, unattendedBounds:bounds, spendMicros:0, actionCount:1, completesBy:subject.evaluatedAt, proposedAction:{ key:`template.edit.${key}.execute`, version:1, digestSha256:subject.requestHashSha256 }, failure:{ kind:'none' } }; } }));
  const approvals = operations.map(({ key, operation }) => createRenewedApprovalResolverRegistration({ reference: refs[key].approval!, operation, resolve: () => ({ approverCurrentlyAuthorized:false }) }));
  const preflights = operations.map(({ key, operation }, index) => createAutonomyPreflightRegistration({ reference:refs[key].preflight!, operation, policy:refs[key].autonomy!, riskResolver:refs[key].risk!, evidenceResolver:refs[key].evidence!, approvalResolver:refs[key].approval!, interventionOutcomes:autonomyInterventionOutcomes(1) }));
  const handlers = operations.map(({ key, canonical }) => createTemplateArtifactDraftHandler({ reference:refs[key].handler!, handlerCapability:TEMPLATE_EDIT_HANDLER_CAPABILITY, contributionSchema:contributionRef, canonicalResultSchema:schemaRef(`schema.template.edit.${key}.canonical`, canonical) }));
  const choiceContext = createReadInvocationContextBuilder({ reference:ref('context.template.edit.model-choices'), operation:TEMPLATE_EDIT_MODEL_CHOICES_OPERATION, effect:'read', lanes:[readLane], scopeResolver:scope(workspaceId), authorityResolver:input.currentAuthority, clock:input.clock, newInvocationId:input.ids.newInvocationId, authorityPrincipalKeyProfile:input.authorityPrincipalKeyProfile, scopePartitionProfile:input.scopePartitionProfile, requestCanonicalizationProfile:input.requestCanonicalizationProfile, deniedAuthorityOutcome:denied });
  const choiceCapability: ReadCapabilityRegistration = { reference:ref('capability.template.edit.model-choices'), openSnapshot:() => ({ choices:input.choices() }) };
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class:'access_denied' as const, kind:`authority.${reason}`, retryable:false, detailSchema:nullRef }));
  return Object.freeze({ id:'template-edit.operation', source:Object.freeze({
    effectExecutionFamilies:families, effectPhases:phases, terminalizationResolvers:terminalizations, riskResolvers:risks, autonomyEvidenceResolvers:evidences, renewedApprovalResolvers:approvals, autonomyPreflights:preflights, autonomyPolicies:[choicesAutonomy, ...autonomies],
    schemas:[{reference:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.modelChoices.inputSchema,schema:templateEditModelChoicesInputSchema},{reference:schemaRef('schema.template.edit.model-choices.canonical',templateEditModelChoicesCanonicalResultSchema),schema:templateEditModelChoicesCanonicalResultSchema},{reference:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.modelChoices.resultSchema,schema:templateEditModelChoicesOperationResultSchema},{reference:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.classify.inputSchema,schema:templateEditRequestSchema},{reference:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.classify.resultSchema,schema:templateEditClassifyOperationResultSchema},{reference:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.revise.inputSchema,schema:templateEditRequestSchema},{reference:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.revise.resultSchema,schema:templateEditReviseOperationResultSchema},{reference:contributionRef,schema:templateEditContributionSchema},{reference:nullRef,schema:nullDetail},...operations.map(({key,canonical})=>({reference:schemaRef(`schema.template.edit.${key}.canonical`,canonical),schema:canonical}))],
    contextBuilders:[choiceContext], readCapabilities:[choiceCapability], handlers:[{reference:ref('handler.template.edit.model-choices'),readCapability:choiceCapability.reference,canonicalResultSchema:schemaRef('schema.template.edit.model-choices.canonical',templateEditModelChoicesCanonicalResultSchema),handle:({snapshot}: { snapshot: Readonly<Record<string, unknown>> })=>({kind:'success',data:templateEditModelChoicesDataSchema.parse({schemaVersion:1,choices:snapshot.choices})})}], projections:[{reference:ref('projection.template.edit.model-choices.operator'),canonicalResultSchema:schemaRef('schema.template.edit.model-choices.canonical',templateEditModelChoicesCanonicalResultSchema),projectedResultSchema:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.modelChoices.resultSchema,project:(candidate: unknown)=>templateEditModelChoicesCanonicalResultSchema.parse(candidate)},...operations.map(({key,canonical})=>({reference:refs[key].projection,canonicalResultSchema:schemaRef(`schema.template.edit.${key}.canonical`,canonical),projectedResultSchema:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS[key].resultSchema,project:(candidate:unknown)=>canonical.parse(candidate)}))],
    readOperationalTraceTargets:[{reference:ref('trace.template.edit.model-choices'),kind:'read_operational_trace_record' as const,recordProfile:recordRef}], operationAuditTargets:[{reference:auditRef,kind:'operation_audit_record' as const,recordProfile:recordRef}], operationAuditRecordProfiles:[{reference:recordRef,kind:'canonical_json' as const,maximumBytes:262144}],
    operations:[{...TEMPLATE_EDIT_MODEL_CHOICES_OPERATION,lifecycle:{status:'active' as const},summary:'List server-owned Template edit model profiles.',effect:'read' as const,maxRisk:'low' as const,autonomyPolicy:ref('autonomy.template.edit.model-choices'),consequenceTags:[],inputSchema:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.modelChoices.inputSchema,canonicalResultSchema:schemaRef('schema.template.edit.model-choices.canonical',templateEditModelChoicesCanonicalResultSchema),outcomes:accessOutcomes,accessLanes:[readLane],contextBuilder:choiceContext.reference,readCapability:choiceCapability.reference,handler:ref('handler.template.edit.model-choices'),observability:{trace:{mode:'required' as const,target:ref('trace.template.edit.model-choices')},immutableAudit:{mode:'none' as const}},bindings:[{surface:'operator_http' as const,method:'GET' as const,path:TEMPLATE_EDIT_MODEL_CHOICES_PATH,input:'query' as const,browserResumption:{kind:'none' as const},projection:ref('projection.template.edit.model-choices.operator')}]}],
    effectContextBuilders:contexts,effectHandlers:handlers,effectOperations:operations.map(({key,operation,path})=>({...operation,lifecycle:{status:'active' as const},summary:`Produce a deterministic Template ${key} draft.`,effect:'draft' as const,maxRisk:'low' as const,autonomyPolicy:refs[key].autonomy!,consequenceTags:['model-draft-produced'],inputSchema:TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS[key].inputSchema,contributionSchema:contributionRef,canonicalResultSchema:schemaRef(`schema.template.edit.${key}.canonical`,key==='classify'?templateEditClassifyCanonicalResultSchema:templateEditReviseCanonicalResultSchema),outcomes:[{class:'idempotency_conflict' as const,kind:'operation.request_changed',retryable:false,detailSchema:nullRef},...accessOutcomes,{class:'conflict' as const,kind:'template.artifact.event_required',retryable:false,detailSchema:nullRef},{class:'conflict' as const,kind:'template.artifact.not_found',retryable:false,detailSchema:nullRef},{class:'conflict' as const,kind:'template.edit.model_choice_unknown',retryable:false,detailSchema:nullRef},{class:'conflict' as const,kind:'operation.in_progress',retryable:true,detailSchema:nullRef},...autonomyInterventionOutcomeDeclarations(nullRef)],accessLanes:[manageLane],contextBuilder:refs[key].context!,handlerCapability:TEMPLATE_EDIT_HANDLER_CAPABILITY,handler:refs[key].handler!,audit:{mode:'required' as const,target:auditRef},idempotency:{keySource,credentialVerifierProfile:input.idempotencyCredentialProfile,requestHashProfile:TEMPLATE_EDIT_REQUEST_HASH_PROFILE},concurrency:refs[key].concurrency!,execution:{kind:'single_unit_of_work' as const,family:refs[key].family!,phase:refs[key].phase!,terminalization:refs[key].terminalization!,autonomyPreflight:refs[key].preflight!},bindings:[{surface:'operator_http' as const,method:'POST' as const,path,input:'body' as const,browserResumption:{kind:'none' as const},projection:refs[key].projection!}]}))
  }) });
}
