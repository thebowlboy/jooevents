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
  SESSION_OPERATION_SCHEMA_REFS,
  sessionDirectInputSchema,
  sessionDirectOperationResultSchema,
  sessionDirectResultSchema,
  sessionMutationPlanSchema,
  sessionRemoveNewPlanSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
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
import { createSessionDirectHandler } from './preparation';

export const SESSION_CHANGE_OPERATION = Object.freeze({ name: 'session.change', version: 1 });
export const SESSION_CHANGE_PATH = '/api/events/current/sessions';
export const SESSION_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.session.manage', version: parseContractVersion(1)
});
export const SESSION_MANAGE_PERMISSION_ID: PermissionId = 'schedule.manage';
export const SESSION_DIRECT_HANDLER_CAPABILITY = ref('capability.session.change-direct');
export const SESSION_CHANGE_REQUEST_HASH_PROFILE = ref('request-hash.session.change');

const nullSchema = z.null();
export const sessionChangedDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'session_exists', 'session_missing', 'stale_session',
    'format_missing', 'format_retired', 'track_missing', 'track_retired', 'track_required',
    'participant_missing', 'participant_changed', 'session_placed', 'invalid_transition', 'invalid_plan'
  ]),
  action: z.enum(['create', 'remove_new_session', 'transition', 'retarget', 'roster_visibility', 'roster_remove', 'roster_restore']),
  sessionId: z.uuid()
});
export const SESSION_CHANGED_DETAIL_SCHEMA_VERSION = 1;
export const sessionDirectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: sessionDirectResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const sessionDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: sessionDirectResultSchema }),
    domain: z.strictObject({
      kind: z.literal('session_direct_change'),
      plan: z.union([sessionMutationPlanSchema, sessionRemoveNewPlanSchema])
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(), effectContributions: z.tuple([])
  })
]);

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}
function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

export function sessionChangedOutcome(
  detailInput: z.input<typeof sessionChangedDetailSchema>
): StructuredOutcome {
  const detail = sessionChangedDetailSchema.parse(detailInput);
  return structuredOutcomeSchema.parse({
    class: 'stale_revision',
    kind: 'session.changed',
    retryable: false,
    subjects: [],
    detail,
    detailSchemaVersion: SESSION_CHANGED_DETAIL_SCHEMA_VERSION
  });
}

export interface SessionDirectCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    { readonly eventId?: string; readonly evidenceIds: readonly string[] }
    | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}
export interface CreateSessionDirectOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: SessionDirectCurrentEventSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function eventScope(workspaceId: WorkspaceId, source: SessionDirectCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await source.resolveCurrentEvent(workspaceId);
      const evidenceIds = Object.freeze([...new Set(resolved.evidenceIds)].sort());
      if (resolved.eventId === undefined) return Object.freeze({
        workspaceId, subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: evidenceIds
      });
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({ workspaceId, eventId, subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }
      ]), resolutionEvidenceIds: evidenceIds });
    }
  });
}

export function createSessionDirectOperationModule(
  input: CreateSessionDirectOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== SESSION_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== SESSION_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('session_change_policy_catalog_mismatch');
  }
  const refs = {
    context: ref('context.session.change'), autonomy: ref('autonomy.session.change'),
    handler: ref('handler.session.change'), projection: ref('projection.session.change.operator'),
    audit: ref('audit.session.change'), record: ref('record-profile.session.operation-audit'),
    keySource: ref('idempotency.operator-header'), concurrency: ref('concurrency.session.change'),
    family: ref('session.change.execution-family'), phase: ref('session.change.phase.direct-uow'),
    terminalization: ref('session.change.terminalization'), risk: ref('session.change.risk'),
    evidence: ref('session.change.autonomy-evidence'), approval: ref('session.change.approval'),
    preflight: ref('session.change.autonomy-preflight')
  };
  const schemas = {
    input: SESSION_OPERATION_SCHEMA_REFS.direct.inputSchema,
    contribution: schemaRef('schema.session.change.contribution', sessionDirectContributionSchema),
    canonical: schemaRef('schema.session.change.canonical-result', sessionDirectCanonicalResultSchema),
    projected: SESSION_OPERATION_SCHEMA_REFS.direct.resultSchema,
    null: schemaRef('schema.session.change.null-detail', nullSchema),
    stale: schemaRef('schema.session.change.stale-detail', sessionChangedDetailSchema)
  };
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.managePolicy });
  const policy = createOperationAutonomyPolicy({
    definition: refs.autonomy, operation: SESSION_CHANGE_OPERATION,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    }, requiresSeparateApproval: false
  });
  const context = createEffectInvocationContextBuilder({
    reference: refs.context, operation: SESSION_CHANGE_OPERATION, effect: 'commit', lanes: [lane],
    scopeResolver: eventScope(workspaceId, input.currentEvent), authorityResolver: input.currentAuthority,
    clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: SESSION_CHANGE_REQUEST_HASH_PROFILE, requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization, operation: SESSION_CHANGE_OPERATION, phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const }) : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase, family: refs.family, operation: SESSION_CHANGE_OPERATION,
    effect: 'commit', handler: refs.handler, handlerCapability: SESSION_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution, terminalization: refs.terminalization,
    terminalOutcomeKeys: [], contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk, operation: SESSION_CHANGE_OPERATION,
    resolve: () => ({ risk: 'low', consequenceTags: ['session-changed'], evidenceIds: ['session.change.risk'] })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence, operation: SESSION_CHANGE_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0, maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: { key: 'session.change.execute', version: 1, digestSha256: subject.requestHashSha256 },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval, operation: SESSION_CHANGE_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight, operation: SESSION_CHANGE_OPERATION, policy: refs.autonomy,
    riskResolver: refs.risk, evidenceResolver: refs.evidence, approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createSessionDirectHandler({
    reference: refs.handler, handlerCapability: SESSION_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution, canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'session-change.operation',
    source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase], terminalizationResolvers: [terminalization],
      riskResolvers: [risk], autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [policy], contextBuilders: [], readCapabilities: [],
      handlers: [], operations: [], readOperationalTraceTargets: [],
      schemas: [
        { reference: schemas.input, schema: sessionDirectInputSchema },
        { reference: schemas.contribution, schema: sessionDirectContributionSchema },
        { reference: schemas.canonical, schema: sessionDirectCanonicalResultSchema },
        { reference: schemas.projected, schema: sessionDirectOperationResultSchema },
        { reference: schemas.null, schema: nullSchema },
        { reference: schemas.stale, schema: sessionChangedDetailSchema }
      ],
      projections: [{ reference: refs.projection, canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => sessionDirectCanonicalResultSchema.parse(candidate) }],
      operationAuditTargets: [{ reference: refs.audit, kind: 'operation_audit_record' as const, recordProfile: refs.record }],
      operationAuditRecordProfiles: [{ reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 262_144 }],
      effectContextBuilders: [context], effectHandlers: [handler], effectOperations: [{
        ...SESSION_CHANGE_OPERATION, lifecycle: { status: 'active' as const },
        summary: 'Create or change a Session.', effect: 'commit' as const, maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy, consequenceTags: ['session-changed'], inputSchema: schemas.input,
        agentAction: { eligible: true as const, displayLabel: 'Change a session', consequences: ['Session details, stage, track, or participant visibility may change.'], externalEffect: 'none' as const },
        contributionSchema: schemas.contribution, canonicalResultSchema: schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.null },
          ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'session.changed', retryable: false, detailSchema: schemas.stale },
          { class: 'conflict' as const, kind: 'session.event_required', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.null },
          ...autonomyInterventionOutcomeDeclarations(schemas.null)
        ], accessLanes: [lane], contextBuilder: refs.context,
        handlerCapability: SESSION_DIRECT_HANDLER_CAPABILITY, handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: { keySource: refs.keySource, credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: SESSION_CHANGE_REQUEST_HASH_PROFILE }, concurrency: refs.concurrency,
        execution: { kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const,
          family: refs.family, phase: refs.phase, terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight,
          history: {
            summariesByAction: Object.freeze({
              create: 'Created a session',
              remove_new_session: 'Removed a new session',
              transition: "Changed a session's stage",
              retarget: "Changed a session's format or track",
              roster_visibility: "Changed a participant's public visibility",
              roster_remove: 'Removed a participant from a session',
              roster_restore: 'Restored a participant to a session'
            })
          } },
        bindings: [{ surface: 'operator_http' as const, method: 'POST' as const,
          path: SESSION_CHANGE_PATH, input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.projection }]
      }]
    })
  });
}
