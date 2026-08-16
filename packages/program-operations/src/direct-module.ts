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
  PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  programVocabularyChangeResultSchema,
  programVocabularyCreateDraftRequestSchema,
  programVocabularyDeleteDraftRequestSchema,
  programVocabularyDirectCanonicalResultSchema,
  programVocabularyDirectOperationResultSchema,
  programVocabularyEditDraftRequestSchema,
  programVocabularyRestoreDraftRequestSchema,
  programVocabularyRetireDraftRequestSchema,
  structuredOutcomeSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseProgramVocabularyMutationPlan, type ProgramVocabularyMutationPlan } from '@jooevents/program';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type PermissionId,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  createProgramVocabularyDirectHandler,
  type ProgramVocabularyDirectAction
} from './direct-preparation';

export const PROGRAM_VOCABULARY_CREATE_OPERATION = Object.freeze({ name: 'program_vocabulary.create', version: 1 });
export const PROGRAM_VOCABULARY_EDIT_OPERATION = Object.freeze({ name: 'program_vocabulary.edit', version: 1 });
export const PROGRAM_VOCABULARY_RETIRE_OPERATION = Object.freeze({ name: 'program_vocabulary.retire', version: 1 });
export const PROGRAM_VOCABULARY_RESTORE_OPERATION = Object.freeze({ name: 'program_vocabulary.restore', version: 1 });
export const PROGRAM_VOCABULARY_DELETE_OPERATION = Object.freeze({ name: 'program_vocabulary.delete', version: 1 });
export const PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY = ref('capability.program_vocabulary.direct');
export const PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE = ref('request-hash.program_vocabulary.direct');
export const PROGRAM_VOCABULARY_DIRECT_PERMISSION_ID: PermissionId = 'program.vocabulary.manage';

const specs = Object.freeze([
  { action: 'create' as const, operation: PROGRAM_VOCABULARY_CREATE_OPERATION, input: programVocabularyCreateDraftRequestSchema, inputRef: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct.create.inputSchema, path: '/api/events/current/program-vocabulary/create' },
  { action: 'edit' as const, operation: PROGRAM_VOCABULARY_EDIT_OPERATION, input: programVocabularyEditDraftRequestSchema, inputRef: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct.edit.inputSchema, path: '/api/events/current/program-vocabulary/edit' },
  { action: 'retire' as const, operation: PROGRAM_VOCABULARY_RETIRE_OPERATION, input: programVocabularyRetireDraftRequestSchema, inputRef: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct.retire.inputSchema, path: '/api/events/current/program-vocabulary/retire' },
  { action: 'restore' as const, operation: PROGRAM_VOCABULARY_RESTORE_OPERATION, input: programVocabularyRestoreDraftRequestSchema, inputRef: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct.restore.inputSchema, path: '/api/events/current/program-vocabulary/restore' },
  { action: 'delete' as const, operation: PROGRAM_VOCABULARY_DELETE_OPERATION, input: programVocabularyDeleteDraftRequestSchema, inputRef: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct.delete.inputSchema, path: '/api/events/current/program-vocabulary/delete' }
]);

const planSchema = z.custom<ProgramVocabularyMutationPlan>((value) => {
  try {
    const plan = parseProgramVocabularyMutationPlan(value);
    return plan.action !== 'merge' && plan.action !== 'merge_compensation';
  } catch { return false; }
}, { message: 'invalid_program_vocabulary_direct_plan' });

export const programVocabularyDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: programVocabularyChangeResultSchema }),
    domain: z.strictObject({ kind: z.literal('program_vocabulary_direct_change'), plan: planSchema }),
    effectContributions: z.tuple([])
  }).superRefine((value, context) => {
    if (value.result.data.action !== value.domain.plan.action) {
      context.addIssue({ code: 'custom', message: 'Program Vocabulary action mismatch.' });
    }
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

const nullDetail = z.null();
const staleDetail = z.strictObject({
  code: z.enum(['wrong_scope', 'stale_set', 'item_exists', 'item_missing', 'stale_item', 'invalid_transition', 'delete_referenced', 'stale_reference', 'invalid_plan']),
  action: z.enum(['create', 'edit', 'retire', 'restore', 'delete']),
  kind: z.enum(['room', 'track', 'format']),
  id: z.string().uuid()
});
const contributionRef = createSafeSchemaManifestRef(
  'schema.program_vocabulary.direct.contribution', programVocabularyDirectContributionSchema
);
const canonicalRef = createSafeSchemaManifestRef(
  'schema.program_vocabulary.direct.canonical-result', programVocabularyDirectCanonicalResultSchema
);
const projectedRef = PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct.create.resultSchema;
const nullRef = createSafeSchemaManifestRef('schema.program_vocabulary.direct.null-detail', nullDetail);
const staleRef = createSafeSchemaManifestRef('schema.program_vocabulary.direct.stale-detail', staleDetail);
const handlerRef = ref('handler.program_vocabulary.direct');
const projectionRef = ref('projection.program_vocabulary.direct.operator');
const auditRef = ref('audit.program_vocabulary.direct');
const auditProfileRef = ref('record-profile.program_vocabulary.direct-audit');
const keySourceRef = ref('idempotency.operator-header');

export interface ProgramVocabularyDirectCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): {
    readonly eventId?: string;
    readonly evidenceIds: readonly string[];
  } | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}

export interface CreateProgramVocabularyDirectOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ProgramVocabularyDirectCurrentEventSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({ class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 });
}

function scopeResolver(workspaceId: WorkspaceId, source: ProgramVocabularyDirectCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await source.resolveCurrentEvent(workspaceId);
      const evidenceIds = Object.freeze([...new Set(resolved.evidenceIds)].sort());
      const eventId = resolved.eventId === undefined ? undefined : parseEventId(resolved.eventId);
      return Object.freeze({
        workspaceId,
        ...(eventId ? { eventId } : {}),
        subjects: Object.freeze(eventId
          ? [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }]
          : [{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: evidenceIds
      });
    }
  });
}

export function createProgramVocabularyDirectOperationModule(
  input: CreateProgramVocabularyDirectOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== 'authority.program_vocabulary.manage'
      || input.managePolicy.version !== parseContractVersion(1)) {
    throw new TypeError('program_vocabulary_direct_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.managePolicy });
  const scope = scopeResolver(workspaceId, input.currentEvent);
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: nullRef
  }));
  const contention = Object.freeze({ class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 });

  const built = specs.map((spec) => {
    const refs = {
      context: ref(`context.program_vocabulary.${spec.action}`),
      family: ref(`program_vocabulary.${spec.action}.execution-family`),
      phase: ref(`program_vocabulary.${spec.action}.phase.direct-uow`),
      terminalization: ref(`program_vocabulary.${spec.action}.terminalization`),
      risk: ref(`program_vocabulary.${spec.action}.risk-resolver`),
      autonomy: ref(`autonomy.program_vocabulary.${spec.action}`),
      evidence: ref(`program_vocabulary.${spec.action}.autonomy-evidence`),
      approval: ref(`program_vocabulary.${spec.action}.approval-resolver`),
      preflight: ref(`program_vocabulary.${spec.action}.autonomy-preflight`),
      concurrency: ref(`concurrency.program_vocabulary.${spec.action}`)
    };
    const context = createEffectInvocationContextBuilder({
      reference: refs.context, operation: spec.operation, effect: 'commit', lanes: [lane], scopeResolver: scope,
      authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
    const terminalization = createTerminalizationResolverRegistration({
      reference: refs.terminalization, operation: spec.operation, phase: refs.phase,
      resolve: ({ result }) => result.kind === 'success' ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const }
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.phase, family: refs.family, operation: spec.operation, effect: 'commit',
      handler: handlerRef, handlerCapability: PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY,
      contributionSchema: contributionRef, terminalization: refs.terminalization,
      terminalOutcomeKeys: [], contentionOutcome: contention
    });
    const autonomy = createOperationAutonomyPolicy({
      definition: refs.autonomy, operation: spec.operation, riskFloor: 'low', unattendedRiskCeiling: 'low',
      supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
      triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval', approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry', ambiguous_external_effect: 'reconcile', stale_plan: 'replan', compensation_required: 'compensate', terminal_failure: 'attention' },
      requiresSeparateApproval: false
    });
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk, operation: spec.operation,
      resolve: () => ({ risk: 'low' as const, consequenceTags: Object.freeze(['program-vocabulary-changed']), evidenceIds: Object.freeze([`program_vocabulary.${spec.action}.risk`]) })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence, operation: spec.operation,
      resolve: ({ subject }) => {
        const bounds = Object.freeze({ scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0, maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) });
        return Object.freeze({ evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds, spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt, proposedAction: Object.freeze({ key: `program_vocabulary.${spec.action}.execute`, version: 1, digestSha256: subject.requestHashSha256 }), failure: Object.freeze({ kind: 'none' as const }) });
      }
    });
    const approval = createRenewedApprovalResolverRegistration({ reference: refs.approval, operation: spec.operation, resolve: () => ({ approverCurrentlyAuthorized: false }) });
    const preflight = createAutonomyPreflightRegistration({ reference: refs.preflight, operation: spec.operation, policy: refs.autonomy, riskResolver: refs.risk, evidenceResolver: refs.evidence, approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1) });
    return { spec, refs, context, family, terminalization, phase, autonomy, risk, evidence, approval, preflight };
  });

  const handler = createProgramVocabularyDirectHandler({
    reference: handlerRef,
    handlerCapability: PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: contributionRef,
    canonicalResultSchema: canonicalRef,
    actionForOperation(name, version) {
      return specs.find((spec) => spec.operation.name === name && spec.operation.version === version)?.action;
    }
  });
  const summaries = Object.freeze(Object.fromEntries(
    (['create', 'edit', 'retire', 'restore', 'delete'] as const).flatMap((action) =>
      (['room', 'track', 'format'] as const).map((kind) => [
        `${action}:${kind}`,
        `${action === 'create' ? 'Created' : action === 'edit' ? 'Updated' : action === 'retire' ? 'Retired' : action === 'restore' ? 'Restored' : 'Deleted'} a ${kind}`
      ])
    )
  ));

  return Object.freeze({
    id: 'program-vocabulary.direct-operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(built.map((entry) => entry.family)),
      effectPhases: Object.freeze(built.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(built.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(built.map((entry) => entry.risk)),
      autonomyEvidenceResolvers: Object.freeze(built.map((entry) => entry.evidence)),
      renewedApprovalResolvers: Object.freeze(built.map((entry) => entry.approval)),
      autonomyPreflights: Object.freeze(built.map((entry) => entry.preflight)),
      autonomyPolicies: Object.freeze(built.map((entry) => entry.autonomy)),
      schemas: Object.freeze([
        ...specs.map((spec) => ({ reference: spec.inputRef, schema: spec.input })),
        { reference: contributionRef, schema: programVocabularyDirectContributionSchema },
        { reference: canonicalRef, schema: programVocabularyDirectCanonicalResultSchema },
        { reference: projectedRef, schema: programVocabularyDirectOperationResultSchema },
        { reference: nullRef, schema: nullDetail },
        { reference: staleRef, schema: staleDetail }
      ]),
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      operations: Object.freeze([]),
      effectContextBuilders: Object.freeze(built.map((entry) => entry.context)),
      effectHandlers: Object.freeze([handler]),
      projections: Object.freeze([{ reference: projectionRef, canonicalResultSchema: canonicalRef, projectedResultSchema: projectedRef, project: (candidate: unknown) => programVocabularyDirectCanonicalResultSchema.parse(candidate) }]),
      operationAuditTargets: Object.freeze([{ reference: auditRef, kind: 'operation_audit_record' as const, recordProfile: auditProfileRef }]),
      operationAuditRecordProfiles: Object.freeze([{ reference: auditProfileRef, kind: 'canonical_json' as const, maximumBytes: 65_536 }]),
      effectOperations: Object.freeze(built.map(({ spec, refs }) => ({
        ...spec.operation, lifecycle: { status: 'active' as const }, summary: `${spec.action} one Program Vocabulary item.`, effect: 'commit' as const,
        maxRisk: 'low' as const, autonomyPolicy: refs.autonomy, consequenceTags: ['program-vocabulary-changed'],
        agentAction: { eligible: true as const, displayLabel: `${spec.action} a program item`, consequences: ['The event program vocabulary may change.'], externalEffect: 'none' as const },
        inputSchema: spec.inputRef, contributionSchema: contributionRef, canonicalResultSchema: canonicalRef,
        outcomes: [{ class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: nullRef }, ...accessOutcomes,
          { class: 'conflict' as const, kind: 'program_vocabulary.event_required', retryable: false, detailSchema: nullRef },
          { class: 'stale_revision' as const, kind: 'program_vocabulary.changed', retryable: false, detailSchema: staleRef },
          { class: 'policy_violation' as const, kind: 'program_vocabulary.change_refused', retryable: false, detailSchema: staleRef },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: nullRef }, ...autonomyInterventionOutcomeDeclarations(nullRef)],
        accessLanes: [lane], contextBuilder: refs.context, handlerCapability: PROGRAM_VOCABULARY_DIRECT_HANDLER_CAPABILITY, handler: handlerRef,
        audit: { mode: 'required' as const, target: auditRef },
        idempotency: { keySource: keySourceRef, credentialVerifierProfile: input.idempotencyCredentialProfile, requestHashProfile: PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE },
        concurrency: refs.concurrency,
        execution: { kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const, family: refs.family, phase: refs.phase, terminalization: refs.terminalization, autonomyPreflight: refs.preflight, history: { summariesByActionAndKind: summaries } },
        bindings: [{ surface: 'operator_http' as const, method: 'POST' as const, path: spec.path, input: 'body' as const, browserResumption: { kind: 'none' as const }, projection: projectionRef }]
      })))
    })
  });
}
