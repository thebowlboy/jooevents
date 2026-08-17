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
import {
  ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS,
  acceleventsExportConfigSaveInputSchema, acceleventsExportConfigSaveResultSchema,
  createSafeSchemaManifestRef, type StructuredOutcome, type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS, parseOperationAccessLane,
  type CurrentAuthorityDenialReason, type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef, type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import { parseEventId, parseInstant, parseWorkspaceId, type Clock, type InvocationId, type WorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  acceleventsExportConfigCanonicalResultSchema, acceleventsExportConfigContributionSchema,
  createAcceleventsExportConfigHandler
} from './direct-preparation';
import {
  ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY, ACCELEVENTS_EXPORT_CONFIG_PATH,
  type AcceleventsExportCurrentEventSource
} from './policy';

export const ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION = Object.freeze({ name: 'program.export.accelevents.config.save', version: 1 });
export const ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY = ref('capability.program.export.accelevents.configuration-save');
export const ACCELEVENTS_EXPORT_CONFIG_REQUEST_HASH_PROFILE = ref('request-hash.program.export.accelevents.configuration-save');

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
function denied(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return { class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
}
function scope(workspaceId: WorkspaceId, currentEvent: AcceleventsExportCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({ async resolve() {
    const current = await currentEvent.resolveCurrentEvent(workspaceId);
    if (!current.eventId) return { workspaceId, subjects: [{ kind: 'workspace' as const, id: workspaceId }], resolutionEvidenceIds: [...new Set(current.evidenceIds)].sort() };
    const eventId = parseEventId(current.eventId);
    return { workspaceId, eventId, subjects: [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }], resolutionEvidenceIds: [...new Set(current.evidenceIds)].sort() };
  }});
}

export function createAcceleventsExportConfigOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: AcceleventsExportCurrentEventSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policy.key !== ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY.key || input.policy.version !== ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY.version) throw new TypeError('accelevents_export_config_policy_mismatch');
  const refs = {
    context: ref('context.program.export.accelevents.configuration-save'), autonomy: ref('autonomy.program.export.accelevents.configuration-save'),
    handler: ref('handler.program.export.accelevents.configuration-save'), projection: ref('projection.program.export.accelevents.configuration-save.operator'),
    audit: ref('audit.program.export.accelevents.configuration-save'), record: ref('record-profile.program.export.accelevents.operation-log'),
    keySource: ref('idempotency.operator-header'), concurrency: ref('concurrency.program.export.accelevents.configuration-save'),
    family: ref('program.export.accelevents.configuration-save.execution-family'), phase: ref('program.export.accelevents.configuration-save.phase.direct-uow'),
    terminal: ref('program.export.accelevents.configuration-save.terminalization'), risk: ref('program.export.accelevents.configuration-save.risk'),
    evidence: ref('program.export.accelevents.configuration-save.autonomy-evidence'), approval: ref('program.export.accelevents.configuration-save.approval'),
    preflight: ref('program.export.accelevents.configuration-save.autonomy-preflight')
  };
  const schemas = {
    input: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.configSave.inputSchema,
    contribution: createSafeSchemaManifestRef('schema.program.export.accelevents.configuration-save.contribution', acceleventsExportConfigContributionSchema),
    canonical: createSafeSchemaManifestRef('schema.program.export.accelevents.configuration-save.canonical', acceleventsExportConfigCanonicalResultSchema),
    projected: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.configSave.resultSchema,
    null: createSafeSchemaManifestRef('schema.program.export.accelevents.configuration-save.null-detail', z.null()),
    stale: createSafeSchemaManifestRef('schema.program.export.accelevents.configuration-save.stale-detail', z.strictObject({ expectedVersion: z.number().int().nonnegative(), currentVersion: z.number().int().nonnegative() }))
  };
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy });
  const autonomy = createOperationAutonomyPolicy({ definition: refs.autonomy, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, riskFloor: 'low', unattendedRiskCeiling: 'low', supportedDispositions: ['proceed','safe_retry','reconcile','renewed_approval','replan','compensate','block','attention'], triggerDispositions: { authority_lost:'block', unattended_bounds_exceeded:'renewed_approval', approval_required:'renewed_approval', known_retryable_failure:'safe_retry', ambiguous_external_effect:'reconcile', stale_plan:'replan', compensation_required:'compensate', terminal_failure:'attention' }, requiresSeparateApproval: false });
  const context = createEffectInvocationContextBuilder({ reference: refs.context, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, effect: 'commit', lanes: [lane], scopeResolver: scope(workspaceId, input.currentEvent), authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId, authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile, requestCanonicalizationProfile: input.requestCanonicalizationProfile, requestHashProfile: ACCELEVENTS_EXPORT_CONFIG_REQUEST_HASH_PROFILE, requestHashSealer: input.requestHashSealer, idempotencyCredentialProfile: input.idempotencyCredentialProfile, idempotencyCredentialSealer: input.idempotencyCredentialSealer, deniedAuthorityOutcome: denied });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
  const terminal = createTerminalizationResolverRegistration({ reference: refs.terminal, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, phase: refs.phase, resolve: ({ result }) => result.kind === 'success' ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const } });
  const phase = createSingleUnitOfWorkPhaseRegistration({ reference: refs.phase, family: refs.family, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, effect: 'commit', handler: refs.handler, handlerCapability: ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY, contributionSchema: schemas.contribution, terminalization: refs.terminal, terminalOutcomeKeys: [], contentionOutcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 } });
  const risk = createOperationRiskResolverRegistration({ reference: refs.risk, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, resolve: () => ({ risk: 'low', consequenceTags: ['export-configuration-updated'], evidenceIds: ['program.export.accelevents.configuration-save.risk'] }) });
  const evidence = createAutonomyEvidenceResolverRegistration({ reference: refs.evidence, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, resolve: ({ subject }) => { const bounds = Object.freeze({ scopeKeys: [...subject.scopeKeys], maximumSpendMicros: 0, maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) }); return { evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds, spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt, proposedAction: { key: 'program.export.accelevents.configuration-save.execute', version: 1, digestSha256: subject.requestHashSha256 }, failure: { kind: 'none' as const } }; } });
  const approval = createRenewedApprovalResolverRegistration({ reference: refs.approval, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, resolve: () => ({ approverCurrentlyAuthorized: false }) });
  const preflight = createAutonomyPreflightRegistration({ reference: refs.preflight, operation: ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION, policy: refs.autonomy, riskResolver: refs.risk, evidenceResolver: refs.evidence, approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1) });
  const handler = createAcceleventsExportConfigHandler({ reference: refs.handler, handlerCapability: ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY, contributionSchema: schemas.contribution, canonicalResultSchema: schemas.canonical });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.null }));
  return Object.freeze({ id: 'accelevents-export-config.operation', source: Object.freeze({
    effectExecutionFamilies:[family], effectPhases:[phase], terminalizationResolvers:[terminal], riskResolvers:[risk], autonomyEvidenceResolvers:[evidence], renewedApprovalResolvers:[approval], autonomyPreflights:[preflight], autonomyPolicies:[autonomy], contextBuilders:[], readCapabilities:[], handlers:[], operations:[], readOperationalTraceTargets:[],
    schemas:[{reference:schemas.input,schema:acceleventsExportConfigSaveInputSchema},{reference:schemas.contribution,schema:acceleventsExportConfigContributionSchema},{reference:schemas.canonical,schema:acceleventsExportConfigCanonicalResultSchema},{reference:schemas.projected,schema:acceleventsExportConfigSaveResultSchema},{reference:schemas.null,schema:z.null()},{reference:schemas.stale,schema:z.strictObject({expectedVersion:z.number().int().nonnegative(),currentVersion:z.number().int().nonnegative()})}],
    projections:[{reference:refs.projection,canonicalResultSchema:schemas.canonical,projectedResultSchema:schemas.projected,project:(candidate:unknown)=>acceleventsExportConfigCanonicalResultSchema.parse(candidate)}],
    operationAuditTargets:[{reference:refs.audit,kind:'operation_audit_record' as const,recordProfile:refs.record}], operationAuditRecordProfiles:[{reference:refs.record,kind:'canonical_json' as const,maximumBytes:262_144}], effectContextBuilders:[context], effectHandlers:[handler], effectOperations:[{
      ...ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION,lifecycle:{status:'active' as const},summary:'Update the Accelevents export preparation.',effect:'commit' as const,maxRisk:'low' as const,autonomyPolicy:refs.autonomy,consequenceTags:['export-configuration-updated'],inputSchema:schemas.input,contributionSchema:schemas.contribution,canonicalResultSchema:schemas.canonical,
      outcomes:[{class:'idempotency_conflict' as const,kind:'operation.request_changed',retryable:false,detailSchema:schemas.null},...access,{class:'stale_revision' as const,kind:'program.export.accelevents.configuration_changed',retryable:false,detailSchema:schemas.stale},{class:'conflict' as const,kind:'operation.in_progress',retryable:true,detailSchema:schemas.null},...autonomyInterventionOutcomeDeclarations(schemas.null)], accessLanes:[lane],contextBuilder:refs.context,handlerCapability:ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY,handler:refs.handler,audit:{mode:'required' as const,target:refs.audit},idempotency:{keySource:refs.keySource,credentialVerifierProfile:input.idempotencyCredentialProfile,requestHashProfile:ACCELEVENTS_EXPORT_CONFIG_REQUEST_HASH_PROFILE},concurrency:refs.concurrency,execution:{kind:'single_unit_of_work' as const,profile:'direct_audited' as const,family:refs.family,phase:refs.phase,terminalization:refs.terminal,autonomyPreflight:refs.preflight,history:{summary:'Updated Accelevents export preparation'}},bindings:[{surface:'operator_http' as const,method:'POST' as const,path:ACCELEVENTS_EXPORT_CONFIG_PATH,input:'body' as const,browserResumption:{kind:'none' as const},projection:refs.projection}]
    }]
  }) });
}
