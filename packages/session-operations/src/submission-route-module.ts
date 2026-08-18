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
  SESSION_SUBMISSION_ROUTE_SCHEMA_REFS,
  sessionSubmissionRouteContributionSchema,
  sessionSubmissionRouteInputSchema,
  sessionSubmissionRouteOperationResultSchema,
  sessionSubmissionRouteResultDataSchema,
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

export const SESSION_SUBMISSION_ROUTE_OPERATION = Object.freeze({
  name: 'session.submission.route', version: 1
});
export const SESSION_SUBMISSION_ROUTE_PATH = '/api/events/current/session-submission-routes';
export const SESSION_SUBMISSION_ROUTE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.session.submission-route', version: parseContractVersion(1)
});
export const SESSION_SUBMISSION_ROUTE_PERMISSION_ID: PermissionId = 'schedule.manage';
export const SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY = ref('capability.session.submission-route-direct');
export const SESSION_SUBMISSION_ROUTE_REQUEST_HASH_PROFILE = ref('request-hash.session.submission-route');

const nullSchema = z.null();
export const sessionSubmissionRouteChangedDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'session_missing', 'stale_session',
    'submission_missing', 'submission_not_accepted', 'submission_already_routed',
    'submission_has_no_participants', 'origin_changed', 'support_changed', 'engagement_advanced',
    'invalid_plan'
  ]),
  submissionId: z.uuid()
});
const canonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: sessionSubmissionRouteResultDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
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
export function sessionSubmissionRouteChangedOutcome(input: z.input<typeof sessionSubmissionRouteChangedDetailSchema>): StructuredOutcome {
  const detail = sessionSubmissionRouteChangedDetailSchema.parse(input);
  return structuredOutcomeSchema.parse({
    class: 'stale_revision', kind: 'session.submission_route_changed', retryable: false,
    subjects: [], detail, detailSchemaVersion: 1
  });
}

export interface CreateSessionSubmissionRouteOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: {
    resolveCurrentEvent(workspaceId: WorkspaceId):
      { readonly eventId?: string; readonly evidenceIds: readonly string[] }
      | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
  };
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function eventScope(
  workspaceId: WorkspaceId,
  source: CreateSessionSubmissionRouteOperationModuleInput['currentEvent']
): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await source.resolveCurrentEvent(workspaceId);
      const evidenceIds = Object.freeze([...new Set(resolved.evidenceIds)].sort());
      if (resolved.eventId === undefined) return Object.freeze({
        workspaceId,
        subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: evidenceIds
      });
      return Object.freeze({
        workspaceId,
        eventId: parseEventId(resolved.eventId),
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: workspaceId },
          { kind: 'event' as const, id: parseEventId(resolved.eventId) }
        ]),
        resolutionEvidenceIds: evidenceIds
      });
    }
  });
}

export function createSessionSubmissionRouteOperationModule(
  input: CreateSessionSubmissionRouteOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const refs = {
    context: ref('context.session.submission-route'),
    autonomy: ref('autonomy.session.submission-route'),
    handler: ref('handler.session.submission-route'),
    projection: ref('projection.session.submission-route.operator'),
    audit: ref('audit.session.submission-route'),
    record: ref('record-profile.session.submission-route-audit'),
    keySource: ref('idempotency.operator-header'),
    concurrency: ref('concurrency.session.submission-route'),
    family: ref('session.submission-route.execution-family'),
    phase: ref('session.submission-route.phase.direct-uow'),
    terminalization: ref('session.submission-route.terminalization'),
    risk: ref('session.submission-route.risk'),
    evidence: ref('session.submission-route.autonomy-evidence'),
    approval: ref('session.submission-route.approval'),
    preflight: ref('session.submission-route.autonomy-preflight')
  };
  const schemas = {
    input: SESSION_SUBMISSION_ROUTE_SCHEMA_REFS.inputSchema,
    contribution: schemaRef('schema.session.submission-route.contribution', sessionSubmissionRouteContributionSchema),
    canonical: schemaRef('schema.session.submission-route.canonical-result', canonicalResultSchema),
    projected: SESSION_SUBMISSION_ROUTE_SCHEMA_REFS.resultSchema,
    null: schemaRef('schema.session.submission-route.null-detail', nullSchema),
    stale: schemaRef('schema.session.submission-route.stale-detail', sessionSubmissionRouteChangedDetailSchema)
  };
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: SESSION_SUBMISSION_ROUTE_ACCESS_POLICY
  });
  const policy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    effect: 'commit', lanes: [lane],
    scopeResolver: eventScope(workspaceId, input.currentEvent),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: SESSION_SUBMISSION_ROUTE_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    effect: 'commit', handler: refs.handler,
    handlerCapability: SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    resolve: () => ({
      risk: 'low', consequenceTags: ['session-submission-route-changed'],
      evidenceIds: ['session.submission-route.risk']
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt,
        hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: {
          key: 'session.submission-route.execute', version: 1,
          digestSha256: subject.requestHashSha256
        },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: SESSION_SUBMISSION_ROUTE_OPERATION,
    policy: refs.autonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.evidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createSessionDirectHandler({
    reference: refs.handler,
    handlerCapability: SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'session-submission-route.operation',
    source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase],
      terminalizationResolvers: [terminalization], riskResolvers: [risk],
      autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [policy],
      contextBuilders: [], readCapabilities: [], handlers: [], operations: [],
      readOperationalTraceTargets: [],
      schemas: [
        { reference: schemas.input, schema: sessionSubmissionRouteInputSchema },
        { reference: schemas.contribution, schema: sessionSubmissionRouteContributionSchema },
        { reference: schemas.canonical, schema: canonicalResultSchema },
        { reference: schemas.projected, schema: sessionSubmissionRouteOperationResultSchema },
        { reference: schemas.null, schema: nullSchema },
        { reference: schemas.stale, schema: sessionSubmissionRouteChangedDetailSchema }
      ],
      projections: [{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => canonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: refs.audit, kind: 'operation_audit_record' as const,
        recordProfile: refs.record
      }],
      operationAuditRecordProfiles: [{
        reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 524_288
      }],
      effectContextBuilders: [context], effectHandlers: [handler],
      effectOperations: [{
        ...SESSION_SUBMISSION_ROUTE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Attach, move, or restore an accepted submission route.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['session-submission-route-changed'],
        inputSchema: schemas.input,
        agentAction: {
          eligible: true as const,
          displayLabel: 'Route an accepted submission',
          consequences: ['A Session roster and the submission’s program route may change.'],
          externalEffect: 'none' as const
        },
        contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.null },
          ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'session.submission_route_changed', retryable: false, detailSchema: schemas.stale },
          { class: 'conflict' as const, kind: 'session.event_required', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.null },
          ...autonomyInterventionOutcomeDeclarations(schemas.null)
        ],
        accessLanes: [lane], contextBuilder: refs.context,
        handlerCapability: SESSION_SUBMISSION_ROUTE_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: SESSION_SUBMISSION_ROUTE_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.family,
          phase: refs.phase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight,
          history: { summariesByAction: Object.freeze({
            attach_unlinked: 'Attached an accepted submission to a session',
            restore_route: 'Restored an accepted submission route',
            move: 'Moved an accepted submission to another session',
            restore_move: 'Restored an accepted submission move'
          }) }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: SESSION_SUBMISSION_ROUTE_PATH,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }]
    })
  });
}
