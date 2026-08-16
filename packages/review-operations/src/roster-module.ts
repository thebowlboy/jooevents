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
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  REVIEWER_ROSTER_OPERATION_SCHEMA_REFS,
  reviewerRosterChangeDraftInputSchema,
  reviewerRosterDirectCanonicalResultSchema,
  reviewerRosterDirectOperationResultSchema,
  reviewerRosterMutationPlanSchema,
  reviewerRosterMutationResultSchema,
  reviewerRosterSnapshotCanonicalResultSchema,
  reviewerRosterSnapshotReadInputSchema,
  reviewerRosterSnapshotReadResultSchema,
  reviewerRosterSnapshotSchema
} from '@jooevents/contracts/reviewer-roster';
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
  isApplicationId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  projectReviewerRosterSnapshot,
  type ReviewerRosterReadEnvironment
} from '@jooevents/review/roster';
import { z } from 'zod';
import { createReviewerRosterDirectHandler } from './roster-direct-preparation';

export const REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'reviewer_roster.snapshot.read', version: 1
});
export const REVIEWER_ROSTER_CHANGE_OPERATION = Object.freeze({
  name: 'reviewer_roster.change', version: 1
});

export const REVIEWER_ROSTER_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.reviewer_roster.manage', version: parseContractVersion(1)
});
export const REVIEWER_ROSTER_PERMISSION_IDS = Object.freeze([
  'event.manage'
] satisfies readonly PermissionId[]);
export const REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY = ref(
  'capability.reviewer_roster.direct'
);
export const REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE = ref(
  'request-hash.reviewer_roster.change'
);

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const nullDetailSchema = z.null();
export const reviewerRosterChangedDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'roster_missing', 'stale_roster', 'authority_unavailable',
    'authority_changed', 'reviewer_not_eligible', 'reviewer_exists', 'reviewer_missing',
    'stale_reviewer', 'reviewer_revoked', 'already_revoked', 'not_revoked', 'scope_targets_unavailable',
    'scope_targets_changed', 'scope_target_missing', 'scope_target_retired', 'invalid_plan'
  ]),
  action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
  reviewerId: applicationIdSchema
});

const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
});
export const reviewerRosterDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: reviewerRosterMutationResultSchema }),
    domain: z.strictObject({
      kind: z.literal('reviewer_roster_direct_change'),
      plan: reviewerRosterMutationPlanSchema
    }),
    effectContributions: z.tuple([])
  }).superRefine((value, context) => {
    if (value.result.data.action !== value.domain.plan.action
        || value.result.data.reviewer.reviewerId !== value.domain.plan.after.reviewerId) {
      context.addIssue({ code: 'custom', message: 'Reviewer roster direct contribution is incoherent.' });
    }
  }),
  outcomeContributionSchema
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  readInput: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  readCanonical: schemaRef(
    'schema.reviewer_roster.snapshot-read.canonical-result',
    reviewerRosterSnapshotCanonicalResultSchema
  ),
  readProjected: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  directInput: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.change.inputSchema,
  directContribution: schemaRef(
    'schema.reviewer_roster.change.contribution', reviewerRosterDirectContributionSchema
  ),
  directCanonical: schemaRef(
    'schema.reviewer_roster.change.canonical-result', reviewerRosterDirectCanonicalResultSchema
  ),
  directProjected: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.change.resultSchema,
  changedDetail: schemaRef(
    'schema.reviewer_roster.changed.detail', reviewerRosterChangedDetailSchema
  ),
  nullDetail: schemaRef('schema.reviewer_roster.operation.null-detail', nullDetailSchema)
});

const refs = Object.freeze({
  readContext: ref('context.reviewer_roster.snapshot-read'),
  readAutonomy: ref('autonomy.reviewer_roster.snapshot-read'),
  readCapability: ref('capability.reviewer_roster.snapshot-read'),
  readHandler: ref('handler.reviewer_roster.snapshot-read'),
  readProjection: ref('projection.reviewer_roster.snapshot-read.operator'),
  readTrace: ref('trace.reviewer_roster.snapshot-read'),
  directContext: ref('context.reviewer_roster.change'),
  directAutonomy: ref('autonomy.reviewer_roster.change'),
  directConcurrency: ref('concurrency.reviewer_roster.change'),
  directFamily: ref('reviewer_roster.change.execution-family'),
  directPhase: ref('reviewer_roster.change.phase.single-uow'),
  directTerminalization: ref('reviewer_roster.change.terminalization'),
  directRisk: ref('reviewer_roster.change.risk-resolver'),
  directAutonomyEvidence: ref('reviewer_roster.change.autonomy-evidence'),
  directApproval: ref('reviewer_roster.change.approval-resolver'),
  directPreflight: ref('reviewer_roster.change.autonomy-preflight'),
  directHandler: ref('handler.reviewer_roster.change'),
  directProjection: ref('projection.reviewer_roster.change.operator'),
  audit: ref('audit.reviewer_roster.change'),
  auditRecordProfile: ref('record-profile.reviewer_roster.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

export interface ReviewerRosterCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}
export interface ReviewerRosterCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    ReviewerRosterCurrentEventResolution | Promise<ReviewerRosterCurrentEventResolution>;
}
export interface CreateReviewerRosterOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ReviewerRosterCurrentEventSource;
  readonly rosterRead: ReviewerRosterReadEnvironment;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly directRequestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export function createReviewerRosterOperationModule(
  input: CreateReviewerRosterOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policy.key !== REVIEWER_ROSTER_MANAGE_ACCESS_POLICY.key
      || input.policy.version !== REVIEWER_ROSTER_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('reviewer_roster_operation_policy_catalog_mismatch');
  }
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policy
  });
  const readAutonomy = autonomy(REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION, refs.readAutonomy);
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext,
    operation: REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION,
    effect: 'read', lanes: [lane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const readCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.readCapability,
    openSnapshot(context: ReadInvocationContext) {
      if (context.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
      const snapshot = projectReviewerRosterSnapshot({
        ...input.rosterRead,
        scope: { workspaceId: context.scope.workspaceId, eventId: context.scope.eventId }
      });
      return snapshot
        ? Object.freeze({ kind: 'snapshot', snapshot })
        : Object.freeze({ kind: 'unavailable' });
    }
  });
  const directAutonomy = autonomy(REVIEWER_ROSTER_CHANGE_OPERATION, refs.directAutonomy);
  const directContext = createEffectInvocationContextBuilder({
    reference: refs.directContext,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    effect: 'commit', lanes: [lane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE,
    requestHashSealer: input.directRequestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const directFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.directFamily, phase: refs.directPhase
  });
  const directTerminalization = createTerminalizationResolverRegistration({
    reference: refs.directTerminalization,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    phase: refs.directPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const directPhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.directPhase, family: refs.directFamily,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    effect: 'commit', handler: refs.directHandler,
    handlerCapability: REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.directContribution,
    terminalization: refs.directTerminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const directRisk = createOperationRiskResolverRegistration({
    reference: refs.directRisk,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['reviewer-roster-changed']),
      evidenceIds: Object.freeze(['reviewer_roster.change.risk'])
    })
  });
  const directAutonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.directAutonomyEvidence,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString());
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1, notAfter
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt,
        hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: Object.freeze({
          key: 'reviewer_roster.change.execute', version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const directApproval = createRenewedApprovalResolverRegistration({
    reference: refs.directApproval,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const directPreflight = createAutonomyPreflightRegistration({
    reference: refs.directPreflight,
    operation: REVIEWER_ROSTER_CHANGE_OPERATION,
    policy: refs.directAutonomy,
    riskResolver: refs.directRisk,
    evidenceResolver: refs.directAutonomyEvidence,
    approvalResolver: refs.directApproval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const directHandler = createReviewerRosterDirectHandler({
    reference: refs.directHandler,
    handlerCapability: REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.directContribution,
    canonicalResultSchema: schemas.directCanonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  return Object.freeze({
    id: 'reviewer-roster.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([directFamily]),
      effectPhases: Object.freeze([directPhase]),
      terminalizationResolvers: Object.freeze([directTerminalization]),
      riskResolvers: Object.freeze([directRisk]),
      autonomyEvidenceResolvers: Object.freeze([directAutonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([directApproval]),
      autonomyPreflights: Object.freeze([directPreflight]),
      autonomyPolicies: Object.freeze([readAutonomy, directAutonomy]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: reviewerRosterSnapshotReadInputSchema },
        { reference: schemas.readCanonical, schema: reviewerRosterSnapshotCanonicalResultSchema },
        { reference: schemas.readProjected, schema: reviewerRosterSnapshotReadResultSchema },
        { reference: schemas.directInput, schema: reviewerRosterChangeDraftInputSchema },
        { reference: schemas.directContribution, schema: reviewerRosterDirectContributionSchema },
        { reference: schemas.directCanonical, schema: reviewerRosterDirectCanonicalResultSchema },
        { reference: schemas.directProjected, schema: reviewerRosterDirectOperationResultSchema },
        { reference: schemas.changedDetail, schema: reviewerRosterChangedDetailSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: refs.readHandler,
        readCapability: refs.readCapability,
        canonicalResultSchema: schemas.readCanonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => {
          if (snapshot.kind === 'event_required') {
            return Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() });
          }
          if (snapshot.kind !== 'snapshot') {
            return Object.freeze({ kind: 'outcome' as const, outcome: unavailableOutcome() });
          }
          return Object.freeze({
            kind: 'success' as const,
            data: reviewerRosterSnapshotSchema.parse(snapshot.snapshot)
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.readProjection,
        canonicalResultSchema: schemas.readCanonical,
        projectedResultSchema: schemas.readProjected,
        project: (candidate: unknown) => reviewerRosterSnapshotCanonicalResultSchema.parse(candidate)
      }, {
        reference: refs.directProjection,
        canonicalResultSchema: schemas.directCanonical,
        projectedResultSchema: schemas.directProjected,
        project: (candidate: unknown) => reviewerRosterDirectCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.readTrace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the current event reviewer roster joined to current access authority.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.readAutonomy,
        consequenceTags: [],
        inputSchema: schemas.readInput,
        canonicalResultSchema: schemas.readCanonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'reviewer_roster.event_required', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'reviewer_roster.unavailable', retryable: false, detailSchema: schemas.nullDetail }
        ],
        accessLanes: [lane],
        contextBuilder: refs.readContext,
        readCapability: refs.readCapability,
        handler: refs.readHandler,
        observability: {
          trace: { mode: 'required' as const, target: refs.readTrace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'GET' as const,
          path: '/api/events/current/reviewer-roster', input: 'query' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.readProjection
        }]
      }]),
      effectContextBuilders: Object.freeze([directContext]),
      effectHandlers: Object.freeze([directHandler]),
      effectOperations: Object.freeze([{
        ...REVIEWER_ROSTER_CHANGE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Change the current event reviewer roster.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.directAutonomy,
        consequenceTags: ['reviewer-roster-changed'],
        agentAction: { eligible: true as const, displayLabel: 'Change the reviewer roster', consequences: ['Reviewer roster membership or scope may change.'], externalEffect: 'none' as const },
        inputSchema: schemas.directInput,
        contributionSchema: schemas.directContribution,
        canonicalResultSchema: schemas.directCanonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.nullDetail },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'reviewer_roster.event_required', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'stale_revision' as const, kind: 'reviewer_roster.changed', retryable: false, detailSchema: schemas.changedDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.directContext,
        handlerCapability: REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY,
        handler: refs.directHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.directConcurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.directFamily,
          phase: refs.directPhase,
          terminalization: refs.directTerminalization,
          autonomyPreflight: refs.directPreflight,
          history: {
            summariesByAction: Object.freeze({
              register: 'Added a reviewer',
              set_scope: "Changed a reviewer's scope",
              revoke: 'Revoked a reviewer',
              restore: 'Restored a reviewer'
            })
          }
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const,
          path: '/api/events/current/reviewer-roster/changes', input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.directProjection
        }]
      }])
    })
  });
}

function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: ReviewerRosterCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      const evidenceIds = canonicalEvidenceIds(resolved.evidenceIds);
      if (resolved.eventId === undefined) {
        return Object.freeze({
          workspaceId: input.workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
          resolutionEvidenceIds: evidenceIds
        });
      }
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({
        workspaceId: input.workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: input.workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: evidenceIds
      });
    }
  });
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.trim() !== value) {
      throw new TypeError('reviewer_roster_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort());
}

function autonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition, operation,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function eventRequiredOutcome(): StructuredOutcome {
  return Object.freeze({
    class: 'conflict', kind: 'reviewer_roster.event_required', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function unavailableOutcome(): StructuredOutcome {
  return Object.freeze({
    class: 'conflict', kind: 'reviewer_roster.unavailable', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}
