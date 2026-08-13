import { createHash } from 'node:crypto';
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
  reviewerRosterChangeDraftCanonicalResultSchema,
  reviewerRosterChangeDraftDataSchema,
  reviewerRosterChangeDraftInputSchema,
  reviewerRosterChangeDraftOperationResultSchema,
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
  encodeCanonicalJson,
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
import { createReviewerRosterDraftHandler } from './roster-preparation';

export const REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'reviewer_roster.snapshot.read', version: 1
});
export const REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION = Object.freeze({
  name: 'reviewer_roster.change.draft', version: 1
});

export const REVIEWER_ROSTER_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.reviewer_roster.manage', version: parseContractVersion(1)
});
export const REVIEWER_ROSTER_PERMISSION_IDS = Object.freeze([
  'event.manage'
] satisfies readonly PermissionId[]);
export const REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.reviewer_roster.changeset_draft'
);
export const REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.reviewer_roster.change-draft'
);

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
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

export const reviewerRosterDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('reviewer_roster_changeset_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: sha256Schema,
  action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
  reviewerId: applicationIdSchema,
  diffReadPermissionIds: z.tuple([z.literal('event.manage')]),
  occurredAt: instantSchema
});
export const reviewerRosterDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: instantSchema
});
const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: reviewerRosterChangeDraftDataSchema }),
  domain: reviewerRosterDraftDomainContributionSchema,
  receiptChildren: z.tuple([reviewerRosterDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const { data } = contribution.result;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.reviewerId !== domain.reviewerId
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Reviewer roster draft evidence is incoherent.' });
  }
});
const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
});
export const reviewerRosterDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

const schemas = Object.freeze({
  readInput: schemaRef('schema.reviewer_roster.snapshot-read.input', reviewerRosterSnapshotReadInputSchema),
  readCanonical: schemaRef(
    'schema.reviewer_roster.snapshot-read.canonical-result',
    reviewerRosterSnapshotCanonicalResultSchema
  ),
  readProjected: schemaRef(
    'schema.reviewer_roster.snapshot-read.result', reviewerRosterSnapshotReadResultSchema
  ),
  draftInput: schemaRef(
    'schema.reviewer_roster.change-draft.input', reviewerRosterChangeDraftInputSchema
  ),
  draftContribution: schemaRef(
    'schema.reviewer_roster.change-draft.contribution', reviewerRosterDraftContributionSchema
  ),
  draftCanonical: schemaRef(
    'schema.reviewer_roster.change-draft.canonical-result',
    reviewerRosterChangeDraftCanonicalResultSchema
  ),
  draftProjected: schemaRef(
    'schema.reviewer_roster.change-draft.result', reviewerRosterChangeDraftOperationResultSchema
  ),
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
  draftContext: ref('context.reviewer_roster.change-draft'),
  draftAutonomy: ref('autonomy.reviewer_roster.change-draft'),
  draftConcurrency: ref('concurrency.reviewer_roster.change-draft'),
  draftFamily: ref('reviewer_roster.change-draft.execution-family'),
  draftPhase: ref('reviewer_roster.change-draft.phase.single-uow'),
  draftTerminalization: ref('reviewer_roster.change-draft.terminalization'),
  draftRisk: ref('reviewer_roster.change-draft.risk-resolver'),
  draftAutonomyEvidence: ref('reviewer_roster.change-draft.autonomy-evidence'),
  draftApproval: ref('reviewer_roster.change-draft.approval-resolver'),
  draftPreflight: ref('reviewer_roster.change-draft.autonomy-preflight'),
  draftHandler: ref('handler.reviewer_roster.change-draft'),
  draftProjection: ref('projection.reviewer_roster.change-draft.operator'),
  audit: ref('audit.reviewer_roster.change-draft'),
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
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export function reviewerRosterDiffReadPermissionIds(): readonly PermissionId[] {
  return REVIEWER_ROSTER_PERMISSION_IDS;
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
  const draftAutonomy = autonomy(REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION, refs.draftAutonomy);
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
  const draftContext = createEffectInvocationContextBuilder({
    reference: refs.draftContext,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    effect: 'draft', lanes: [lane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const draftFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.draftFamily, phase: refs.draftPhase
  });
  const draftTerminalization = createTerminalizationResolverRegistration({
    reference: refs.draftTerminalization,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    phase: refs.draftPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const draftPhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.draftPhase, family: refs.draftFamily,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    effect: 'draft', handler: refs.draftHandler,
    handlerCapability: REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.draftContribution,
    terminalization: refs.draftTerminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const draftRisk = createOperationRiskResolverRegistration({
    reference: refs.draftRisk,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['reviewer_roster.change.draft.risk'])
    })
  });
  const draftAutonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.draftAutonomyEvidence,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
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
          key: 'reviewer_roster.change.draft.execute', version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const draftApproval = createRenewedApprovalResolverRegistration({
    reference: refs.draftApproval,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const draftPreflight = createAutonomyPreflightRegistration({
    reference: refs.draftPreflight,
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    policy: refs.draftAutonomy,
    riskResolver: refs.draftRisk,
    evidenceResolver: refs.draftAutonomyEvidence,
    approvalResolver: refs.draftApproval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const draftHandler = createReviewerRosterDraftHandler({
    reference: refs.draftHandler,
    handlerCapability: REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.draftContribution,
    canonicalResultSchema: schemas.draftCanonical
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
      effectExecutionFamilies: Object.freeze([draftFamily]),
      effectPhases: Object.freeze([draftPhase]),
      terminalizationResolvers: Object.freeze([draftTerminalization]),
      riskResolvers: Object.freeze([draftRisk]),
      autonomyEvidenceResolvers: Object.freeze([draftAutonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([draftApproval]),
      autonomyPreflights: Object.freeze([draftPreflight]),
      autonomyPolicies: Object.freeze([readAutonomy, draftAutonomy]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: reviewerRosterSnapshotReadInputSchema },
        { reference: schemas.readCanonical, schema: reviewerRosterSnapshotCanonicalResultSchema },
        { reference: schemas.readProjected, schema: reviewerRosterSnapshotReadResultSchema },
        { reference: schemas.draftInput, schema: reviewerRosterChangeDraftInputSchema },
        { reference: schemas.draftContribution, schema: reviewerRosterDraftContributionSchema },
        { reference: schemas.draftCanonical, schema: reviewerRosterChangeDraftCanonicalResultSchema },
        { reference: schemas.draftProjected, schema: reviewerRosterChangeDraftOperationResultSchema },
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
        reference: refs.draftProjection,
        canonicalResultSchema: schemas.draftCanonical,
        projectedResultSchema: schemas.draftProjected,
        project: (candidate: unknown) => reviewerRosterChangeDraftCanonicalResultSchema.parse(candidate)
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
      effectContextBuilders: Object.freeze([draftContext]),
      effectHandlers: Object.freeze([draftHandler]),
      effectOperations: Object.freeze([{
        ...REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft a reviewer roster registration, scope, revoke, or restore change.',
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.draftAutonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: schemas.draftInput,
        contributionSchema: schemas.draftContribution,
        canonicalResultSchema: schemas.draftCanonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.nullDetail },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'reviewer_roster.event_required', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'stale_revision' as const, kind: 'reviewer_roster.changed', retryable: false, detailSchema: schemas.changedDetail },
          { class: 'conflict' as const, kind: 'changeset.id_collision', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.draftContext,
        handlerCapability: REVIEWER_ROSTER_DRAFT_HANDLER_CAPABILITY,
        handler: refs.draftHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.draftConcurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: refs.draftFamily,
          phase: refs.draftPhase,
          terminalization: refs.draftTerminalization,
          autonomyPreflight: refs.draftPreflight
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const,
          path: '/api/events/current/reviewer-roster/drafts', input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.draftProjection
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

export const REVIEWER_ROSTER_OPERATION_DEFINITION_DIGEST = digest({
  read: REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION,
  draft: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
  permissionIds: REVIEWER_ROSTER_PERMISSION_IDS
});
