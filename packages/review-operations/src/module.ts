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
  type OperationOutcomeDeclaration,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  REVIEW_OPERATION_SCHEMA_REFS,
  reviewDraftSaveCanonicalResultSchema,
  reviewDraftSaveInputSchema,
  reviewDraftSaveOperationResultSchema,
  reviewDraftSaveResultSchema,
  reviewRoundSetupProjectionSchema,
  reviewRoundSetupReadInputSchema,
  reviewRoundSetupReadResultSchema,
  reviewSnapshotReadInputSchema,
  reviewSnapshotReadResultSchema,
  reviewSnapshotSchema,
  reviewVersionSchema,
  reviewVisibilityPolicySchema,
  type ReviewVisibilityPolicyDto
} from '@jooevents/contracts/reviews';
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
  type ActorRef,
  type Clock,
  type InvocationId,
  type ResolvedScope,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  projectReviewRoundSetup,
  projectReviewSnapshot,
  type ReviewCandidateDisplaySource,
  type ReviewAccoladeSource,
  type ReviewPlanningSource,
  type ReviewProjectionViewer,
  type ReviewRepository
} from '@jooevents/review';
import { z } from 'zod';
import { createReviewEvaluationDraftSaveHandler } from './preparation';

export const REVIEW_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'review.snapshot.read', version: 1
});
export const REVIEW_ROUND_SETUP_READ_OPERATION = Object.freeze({
  name: 'review.round.setup.read', version: 1
});
export const REVIEW_EVALUATION_DRAFT_SAVE_OPERATION = Object.freeze({
  name: 'review.evaluation.draft.save', version: 1
});

export const REVIEW_SNAPSHOT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.review.snapshot', version: parseContractVersion(1)
});
export const REVIEW_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.review.manage', version: parseContractVersion(1)
});
export const REVIEW_STEP_BACK_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.review.step-back', version: parseContractVersion(1)
});
export const REVIEW_EVALUATE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.review.evaluate', version: parseContractVersion(1)
});

export const REVIEW_SNAPSHOT_PERMISSION_IDS = Object.freeze([
  'event.read', 'submission.read'
] satisfies readonly PermissionId[]);
export const REVIEW_MANAGE_PERMISSION_IDS = Object.freeze([
  'event.manage'
] satisfies readonly PermissionId[]);
export const REVIEW_STEP_BACK_PERMISSION_IDS = Object.freeze([
  'submission.score'
] satisfies readonly PermissionId[]);
export const REVIEW_EVALUATE_PERMISSION_IDS = Object.freeze([
  'submission.comment', 'submission.score'
] satisfies readonly PermissionId[]);

/**
 * The three visibility axes (`participantIdentity`, `peerReviewerIdentity`,
 * `peerContentUnlock`) are the canonical round policy; the single `anonymized`
 * boolean is only the round-open operation's ergonomic surface and expands to
 * exactly this mapping. `anonymized: true` hides both identity axes and keeps
 * peer content locked until the reviewer's own commit; `anonymized: false`
 * reveals identities while retaining the anti-anchoring unlock.
 */
export function reviewOpenRoundVisibilityPolicy(anonymized: boolean): ReviewVisibilityPolicyDto {
  return reviewVisibilityPolicySchema.parse(anonymized
    ? {
        participantIdentity: 'hidden',
        peerReviewerIdentity: 'hidden',
        peerContentUnlock: 'after_own_commit'
      }
    : {
        participantIdentity: 'shown',
        peerReviewerIdentity: 'shown',
        peerContentUnlock: 'after_own_commit'
      });
}

export const REVIEW_DRAFT_SAVE_HANDLER_CAPABILITY = ref(
  'capability.review.evaluation-draft-save'
);
export const REVIEW_REQUEST_HASH_PROFILE = ref('request-hash.review.operations');
export const REVIEW_DRAFT_SAVE_REQUEST_HASH_PROFILE = REVIEW_REQUEST_HASH_PROFILE;

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const instantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
});
const nullDetailSchema = z.null();

export const reviewSnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: reviewSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const reviewRoundSetupCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: reviewRoundSetupProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const reviewCanonicalChangedDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'open_round_exists', 'no_assignments',
    'assignment_seed_mismatch', 'deadline_missing', 'round_missing', 'stale_round',
    'round_not_open', 'round_has_work', 'assignment_missing', 'stale_assignment',
    'assignment_not_active', 'not_assigned_reviewer', 'vacancy_resolved',
    'replacement_reviewer_missing', 'replacement_reviewer_not_active',
    'replacement_reviewer_out_of_scope', 'replacement_reviewer_already_assigned',
    'draft_missing', 'stale_draft',
    'review_exists', 'review_missing', 'stale_review', 'revision_missing',
    'invalid_scores', 'candidate_query_changed', 'reviewer_query_changed',
    'deadline_changed', 'invalid_plan'
  ]),
  action: z.enum([
    'open_round', 'discard_empty_round', 'step_back', 'assign_replacement',
    'accept_coverage', 'commit_review', 'amend_review'
  ]),
  subjectId: z.string().trim().min(1).max(512)
});

export const reviewEvaluationDraftSavedDomainContributionSchema = z.strictObject({
  kind: z.literal('review_evaluation_draft_saved'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  assignmentId: applicationIdSchema,
  draftVersion: reviewVersionSchema,
  occurredAt: instantSchema
});

const draftSaveSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: reviewDraftSaveResultSchema }),
  domain: reviewEvaluationDraftSavedDomainContributionSchema,
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const draft = contribution.result.data.draft;
  if (draft.scope.workspaceId !== contribution.domain.workspaceId
      || draft.scope.eventId !== contribution.domain.eventId
      || draft.assignmentId !== contribution.domain.assignmentId
      || draft.version !== contribution.domain.draftVersion
      || draft.updatedAt !== contribution.domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Review save evidence is incoherent.' });
  }
});
const draftSaveOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const allowed = new Set([
    'conflict:review.event_required',
    'conflict:review.viewer_required',
    'stale_revision:review.canonical_changed'
  ]);
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !(outcome.kind === 'review.canonical_changed'
        ? reviewCanonicalChangedDetailSchema
        : nullDetailSchema).safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Review save refusal is invalid.' });
  }
});
export const reviewEvaluationDraftSaveContributionSchema = z.union([
  draftSaveSuccessContributionSchema,
  draftSaveOutcomeContributionSchema
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}
const schemas = Object.freeze({
  snapshotInput: REVIEW_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  snapshotCanonical: schemaRef('schema.review.snapshot-read.canonical-result', reviewSnapshotCanonicalResultSchema),
  snapshotProjected: REVIEW_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  setupInput: REVIEW_OPERATION_SCHEMA_REFS.roundSetupRead.inputSchema,
  setupCanonical: schemaRef('schema.review.round-setup-read.canonical-result', reviewRoundSetupCanonicalResultSchema),
  setupProjected: REVIEW_OPERATION_SCHEMA_REFS.roundSetupRead.resultSchema,
  saveInput: REVIEW_OPERATION_SCHEMA_REFS.draftSave.inputSchema,
  saveContribution: schemaRef('schema.review.evaluation-draft-save.contribution', reviewEvaluationDraftSaveContributionSchema),
  saveCanonical: schemaRef('schema.review.evaluation-draft-save.canonical-result', reviewDraftSaveCanonicalResultSchema),
  saveProjected: REVIEW_OPERATION_SCHEMA_REFS.draftSave.resultSchema,
  staleDetail: schemaRef('schema.review.canonical-changed.detail', reviewCanonicalChangedDetailSchema),
  nullDetail: schemaRef('schema.review.operation.null-detail', nullDetailSchema)
});

export interface ReviewCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}
export interface ReviewCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    ReviewCurrentEventResolution | Promise<ReviewCurrentEventResolution>;
}
export type ReviewViewerResolution =
  | { readonly kind: 'viewer'; readonly viewer: ReviewProjectionViewer }
  | { readonly kind: 'unavailable' };
export interface ReviewViewerResolver {
  resolveViewer(input: {
    readonly scope: ResolvedScope;
    readonly actor: ActorRef;
  }): ReviewViewerResolution | Promise<ReviewViewerResolution>;
}
export interface ReviewOperationPolicies {
  readonly snapshot: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
  readonly stepBack: VersionedAccessPolicyRef;
  readonly evaluate: VersionedAccessPolicyRef;
}
export interface CreateReviewOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: ReviewOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ReviewCurrentEventSource;
  readonly viewer: ReviewViewerResolver;
  readonly repository: ReviewRepository;
  readonly sources: ReviewPlanningSource;
  readonly candidateDisplay: ReviewCandidateDisplaySource;
  readonly accolades: ReviewAccoladeSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export function createReviewOperationModule(
  input: CreateReviewOperationModuleInput
): OperationRegistryModule {
  assertPolicyCatalog(input.policies);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const snapshotLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.snapshot
  });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.manage
  });
  const evaluateLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.evaluate
  });
  const environment = {
    repository: input.repository,
    sources: input.sources,
    candidateDisplay: input.candidateDisplay,
    accolades: input.accolades
  };

  const snapshotRefs = operationRefs('review.snapshot-read');
  const setupRefs = operationRefs('review.round-setup-read');
  const snapshotAutonomy = autonomy(REVIEW_SNAPSHOT_READ_OPERATION, snapshotRefs.autonomy);
  const setupAutonomy = autonomy(REVIEW_ROUND_SETUP_READ_OPERATION, setupRefs.autonomy);
  const snapshotContext = createReadInvocationContextBuilder({
    reference: snapshotRefs.context,
    operation: REVIEW_SNAPSHOT_READ_OPERATION,
    effect: 'read', lanes: [snapshotLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const setupContext = createReadInvocationContextBuilder({
    reference: setupRefs.context,
    operation: REVIEW_ROUND_SETUP_READ_OPERATION,
    effect: 'read', lanes: [manageLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const snapshotCapability: ReadCapabilityRegistration = Object.freeze({
    reference: snapshotRefs.capability,
    async openSnapshot(context: ReadInvocationContext) {
      if (context.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
      const resolved = await input.viewer.resolveViewer({ scope: context.scope, actor: context.actor });
      if (resolved.kind !== 'viewer') return Object.freeze({ kind: 'viewer_required' });
      const scope = { workspaceId: context.scope.workspaceId, eventId: context.scope.eventId };
      const catalog = input.repository.readCatalog(scope);
      if (!catalog) return Object.freeze({ kind: 'catalog_missing' });
      const submissionIds = [...new Set(catalog.rounds.flatMap((round) =>
        input.repository.listAssignments(scope, round.id).map((assignment) => assignment.submissionId)
      ))].sort();
      return Object.freeze({
        kind: 'snapshot',
        track: projectReviewSnapshot({
          scope, viewer: resolved.viewer, standingSubmissionIds: submissionIds,
          standingSlice: 'track', environment
        }),
        all: projectReviewSnapshot({
          scope, viewer: resolved.viewer, standingSubmissionIds: submissionIds,
          standingSlice: 'all', environment
        })
      });
    }
  });
  const setupCapability: ReadCapabilityRegistration = Object.freeze({
    reference: setupRefs.capability,
    openSnapshot(context: ReadInvocationContext) {
      if (context.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
      return Object.freeze({
        kind: 'setup',
        setup: projectReviewRoundSetup({
          scope: { workspaceId: context.scope.workspaceId, eventId: context.scope.eventId },
          sources: input.sources
        })
      });
    }
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));

  const snapshotHandler = Object.freeze({
    reference: snapshotRefs.handler,
    readCapability: snapshotRefs.capability,
    canonicalResultSchema: schemas.snapshotCanonical,
    handle({ businessInput, snapshot }: {
      readonly businessInput: unknown;
      readonly snapshot: Readonly<Record<string, unknown>>;
    }) {
      if (snapshot.kind !== 'snapshot') return readUnavailableOutcome(snapshot.kind);
      const query = reviewSnapshotReadInputSchema.parse(businessInput);
      const selected = reviewSnapshotSchema.parse(
        query.standingSlice === 'all' ? snapshot.all : snapshot.track
      );
      const requested = new Set<string>(query.standingSubmissionIds);
      return Object.freeze({
        kind: 'success' as const,
        data: reviewSnapshotSchema.parse({
          ...selected,
          standings: Object.fromEntries(
            Object.entries(selected.standings).filter(([submissionId]) => requested.has(submissionId))
          )
        })
      });
    }
  });
  const setupHandler = Object.freeze({
    reference: setupRefs.handler,
    readCapability: setupRefs.capability,
    canonicalResultSchema: schemas.setupCanonical,
    handle({ businessInput, snapshot }: {
      readonly businessInput: unknown;
      readonly snapshot: Readonly<Record<string, unknown>>;
    }) {
      reviewRoundSetupReadInputSchema.parse(businessInput);
      if (snapshot.kind !== 'setup') return readUnavailableOutcome(snapshot.kind);
      return Object.freeze({
        kind: 'success' as const,
        data: reviewRoundSetupProjectionSchema.parse(snapshot.setup)
      });
    }
  });

  const effects = [effectRuntime({
      key: 'review.evaluation-draft-save', operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
      lane: evaluateLane, inputSchema: schemas.saveInput,
      projectedSchema: schemas.saveProjected,
      contributionSchema: schemas.saveContribution,
      canonicalSchema: schemas.saveCanonical,
      canonicalParser: reviewDraftSaveCanonicalResultSchema,
      handlerCapability: REVIEW_DRAFT_SAVE_HANDLER_CAPABILITY,
      path: '/api/events/current/review/evaluation-draft',
      requestHashProfile: REVIEW_DRAFT_SAVE_REQUEST_HASH_PROFILE,
      outcomes: saveOutcomes(accessOutcomes)
    }, input, scopeResolver)] as const;

  const recordProfile = Object.freeze({
    reference: ref('record-profile.review.operation-audit'),
    kind: 'canonical_json' as const,
    maximumBytes: 131_072
  });
  const auditTarget = Object.freeze({
    reference: ref('audit.review.operations'),
    kind: 'operation_audit_record' as const,
    recordProfile: recordProfile.reference
  });
  const snapshotTrace = Object.freeze({
    reference: snapshotRefs.trace,
    kind: 'read_operational_trace_record' as const,
    recordProfile: recordProfile.reference
  });
  const setupTrace = Object.freeze({
    reference: setupRefs.trace,
    kind: 'read_operational_trace_record' as const,
    recordProfile: recordProfile.reference
  });

  return Object.freeze({
    id: 'review.operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([
        snapshotAutonomy, setupAutonomy, ...effects.map((value) => value.autonomy)
      ]),
      schemas: Object.freeze([
        { reference: schemas.snapshotInput, schema: reviewSnapshotReadInputSchema },
        { reference: schemas.snapshotCanonical, schema: reviewSnapshotCanonicalResultSchema },
        { reference: schemas.snapshotProjected, schema: reviewSnapshotReadResultSchema },
        { reference: schemas.setupInput, schema: reviewRoundSetupReadInputSchema },
        { reference: schemas.setupCanonical, schema: reviewRoundSetupCanonicalResultSchema },
        { reference: schemas.setupProjected, schema: reviewRoundSetupReadResultSchema },
        { reference: schemas.saveInput, schema: reviewDraftSaveInputSchema },
        { reference: schemas.saveContribution, schema: reviewEvaluationDraftSaveContributionSchema },
        { reference: schemas.saveCanonical, schema: reviewDraftSaveCanonicalResultSchema },
        { reference: schemas.saveProjected, schema: reviewDraftSaveOperationResultSchema },
        { reference: schemas.staleDetail, schema: reviewCanonicalChangedDetailSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([snapshotContext, setupContext]),
      readCapabilities: Object.freeze([snapshotCapability, setupCapability]),
      handlers: Object.freeze([snapshotHandler, setupHandler]),
      projections: Object.freeze([
        projection(snapshotRefs.projection, schemas.snapshotCanonical, schemas.snapshotProjected, reviewSnapshotCanonicalResultSchema),
        projection(setupRefs.projection, schemas.setupCanonical, schemas.setupProjected, reviewRoundSetupCanonicalResultSchema),
        ...effects.map((value) => value.projection)
      ]),
      readOperationalTraceTargets: Object.freeze([snapshotTrace, setupTrace]),
      operationAuditTargets: Object.freeze([auditTarget]),
      operationAuditRecordProfiles: Object.freeze([recordProfile]),
      operations: Object.freeze([
        readOperation({
          operation: REVIEW_SNAPSHOT_READ_OPERATION,
          summary: 'Read the current authority-shaped Review snapshot.',
          autonomyPolicy: snapshotRefs.autonomy,
          inputSchema: schemas.snapshotInput,
          canonicalResultSchema: schemas.snapshotCanonical,
          contextBuilder: snapshotRefs.context,
          readCapability: snapshotRefs.capability,
          handler: snapshotRefs.handler,
          trace: snapshotRefs.trace,
          projection: snapshotRefs.projection,
          accessLane: snapshotLane,
          accessOutcomes,
          path: '/api/events/current/review/snapshot',
          activeBindings: true
        }),
        readOperation({
          operation: REVIEW_ROUND_SETUP_READ_OPERATION,
          summary: 'Read deterministic Review round hand-out counts.',
          autonomyPolicy: setupRefs.autonomy,
          inputSchema: schemas.setupInput,
          canonicalResultSchema: schemas.setupCanonical,
          contextBuilder: setupRefs.context,
          readCapability: setupRefs.capability,
          handler: setupRefs.handler,
          trace: setupRefs.trace,
          projection: setupRefs.projection,
          accessLane: manageLane,
          accessOutcomes,
          path: '/api/events/current/review/round-setup',
          activeBindings: true
        })
      ]),
      effectContextBuilders: Object.freeze(effects.map((value) => value.context)),
      effectHandlers: Object.freeze(effects.map((value) => value.handler)),
      effectOperations: Object.freeze(effects.map((value) => value.definition)),
      effectExecutionFamilies: Object.freeze(effects.map((value) => value.family)),
      effectPhases: Object.freeze(effects.map((value) => value.phase)),
      terminalizationResolvers: Object.freeze(effects.map((value) => value.terminalization)),
      riskResolvers: Object.freeze(effects.map((value) => value.risk)),
      autonomyEvidenceResolvers: Object.freeze(effects.map((value) => value.evidence)),
      renewedApprovalResolvers: Object.freeze(effects.map((value) => value.approval)),
      autonomyPreflights: Object.freeze(effects.map((value) => value.preflight))
    })
  });
}

function assertPolicyCatalog(policies: ReviewOperationPolicies): void {
  const expected = [
    [policies.snapshot, REVIEW_SNAPSHOT_ACCESS_POLICY],
    [policies.manage, REVIEW_MANAGE_ACCESS_POLICY],
    [policies.stepBack, REVIEW_STEP_BACK_ACCESS_POLICY],
    [policies.evaluate, REVIEW_EVALUATE_ACCESS_POLICY]
  ] as const;
  if (expected.some(([actual, required]) =>
    actual.key !== required.key || actual.version !== required.version)) {
    throw new TypeError('review_operation_policy_catalog_mismatch');
  }
}

function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: ReviewCurrentEventSource;
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
      throw new TypeError('review_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort());
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function readUnavailableOutcome(kind: unknown) {
  const suffix = kind === 'viewer_required' ? 'viewer_required'
    : kind === 'catalog_missing' ? 'catalog_missing'
      : 'event_required';
  return Object.freeze({
    kind: 'outcome' as const,
    outcome: {
      class: 'conflict' as const,
      kind: `review.${suffix}`,
      retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
}

function autonomy(
  operation: { readonly name: string; readonly version: number },
  reference: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition: reference,
    operation,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
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

function operationRefs(key: string) {
  return Object.freeze({
    autonomy: ref(`autonomy.${key}`),
    context: ref(`context.${key}`),
    capability: ref(`capability.${key}`),
    handler: ref(`handler.${key}`),
    projection: ref(`projection.${key}.operator`),
    trace: ref(`trace.${key}`)
  });
}

function projection(
  reference: VersionedDefinitionRef,
  canonicalResultSchema: SafeSchemaManifestRef,
  projectedResultSchema: SafeSchemaManifestRef,
  parser: z.ZodType
) {
  return Object.freeze({
    reference,
    canonicalResultSchema,
    projectedResultSchema,
    project: (candidate: unknown) => parser.parse(candidate)
  });
}

function readOperation(input: {
  readonly operation: { readonly name: string; readonly version: number };
  readonly summary: string;
  readonly autonomyPolicy: VersionedDefinitionRef;
  readonly inputSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  readonly contextBuilder: VersionedDefinitionRef;
  readonly readCapability: VersionedDefinitionRef;
  readonly handler: VersionedDefinitionRef;
  readonly trace: VersionedDefinitionRef;
  readonly projection: VersionedDefinitionRef;
  readonly path: string;
  readonly accessLane: ReturnType<typeof parseOperationAccessLane>;
  readonly accessOutcomes: readonly {
    readonly class: 'access_denied'; readonly kind: string; readonly retryable: false;
    readonly detailSchema: SafeSchemaManifestRef;
  }[];
  readonly activeBindings: boolean;
}) {
  return Object.freeze({
    ...input.operation,
    lifecycle: { status: 'active' as const },
    summary: input.summary,
    effect: 'read' as const,
    maxRisk: 'low' as const,
    autonomyPolicy: input.autonomyPolicy,
    consequenceTags: [],
    inputSchema: input.inputSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    outcomes: [
      ...input.accessOutcomes,
      ...['event_required', 'viewer_required', 'catalog_missing'].map((suffix) => ({
        class: 'conflict' as const,
        kind: `review.${suffix}`,
        retryable: false,
        detailSchema: schemas.nullDetail
      }))
    ],
    accessLanes: [input.accessLane],
    contextBuilder: input.contextBuilder,
    readCapability: input.readCapability,
    handler: input.handler,
    observability: {
      trace: { mode: 'required' as const, target: input.trace },
      immutableAudit: { mode: 'none' as const }
    },
    bindings: input.activeBindings ? [{
      surface: 'operator_http' as const,
      method: 'GET' as const,
      path: input.path,
      input: 'query' as const,
      browserResumption: { kind: 'none' as const },
      projection: input.projection
    }] : []
  });
}

function effectRuntime(
  spec: {
    readonly key: string;
    readonly operation: { readonly name: string; readonly version: number };
    readonly lane: ReturnType<typeof parseOperationAccessLane>;
    readonly inputSchema: SafeSchemaManifestRef;
    readonly projectedSchema: SafeSchemaManifestRef;
    readonly contributionSchema: SafeSchemaManifestRef;
    readonly canonicalSchema: SafeSchemaManifestRef;
    readonly canonicalParser: z.ZodType;
    readonly handlerCapability: VersionedDefinitionRef;
    readonly path: string;
    readonly requestHashProfile: VersionedDefinitionRef;
    readonly outcomes: readonly OperationOutcomeDeclaration[];
  },
  input: CreateReviewOperationModuleInput,
  scopeResolver: InvocationScopeResolver
) {
  const refs = Object.freeze({
    autonomy: ref(`autonomy.${spec.key}`),
    context: ref(`context.${spec.key}`),
    family: ref(`${spec.key}.execution-family`),
    phase: ref(`${spec.key}.phase.single-uow`),
    terminalization: ref(`${spec.key}.terminalization`),
    risk: ref(`${spec.key}.risk-resolver`),
    evidence: ref(`${spec.key}.autonomy-evidence`),
    approval: ref(`${spec.key}.approval-resolver`),
    preflight: ref(`${spec.key}.autonomy-preflight`),
    concurrency: ref(`${spec.key}.concurrency`),
    handler: ref(`handler.${spec.key}`),
    projection: ref(`projection.${spec.key}.operator`),
    keySource: ref(`idempotency.${spec.key}.operator-header`)
  });
  const autonomyPolicy = autonomy(spec.operation, refs.autonomy);
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: spec.operation,
    effect: 'commit',
    lanes: [spec.lane],
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: spec.requestHashProfile,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.family, phase: refs.phase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: spec.operation,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: spec.operation,
    effect: 'commit',
    handler: refs.handler,
    handlerCapability: spec.handlerCapability,
    contributionSchema: spec.contributionSchema,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk,
    operation: spec.operation,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['review-draft-saved']),
      evidenceIds: Object.freeze([`${spec.key}.risk`])
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence,
    operation: spec.operation,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]),
        maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt,
        hardBounds: bounds,
        unattendedBounds: bounds,
        spendMicros: 0,
        actionCount: 1,
        completesBy: subject.evaluatedAt,
        proposedAction: Object.freeze({
          key: `${spec.key}.execute`, version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: spec.operation,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: spec.operation,
    policy: refs.autonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.evidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createReviewEvaluationDraftSaveHandler({
    reference: refs.handler,
    handlerCapability: spec.handlerCapability,
    contributionSchema: spec.contributionSchema,
    canonicalResultSchema: spec.canonicalSchema
  });
  const resultProjection = projection(
    refs.projection,
    spec.canonicalSchema,
    spec.projectedSchema,
    spec.canonicalParser
  );
  const auditTarget = ref('audit.review.operations');
  const definition = Object.freeze({
    ...spec.operation,
    lifecycle: { status: 'active' as const },
    summary: 'Save one reviewer evaluation working draft without committing the review.',
    effect: 'commit' as const,
    maxRisk: 'low' as const,
    autonomyPolicy: refs.autonomy,
    consequenceTags: ['review-draft-saved'],
    inputSchema: spec.inputSchema,
    contributionSchema: spec.contributionSchema,
    canonicalResultSchema: spec.canonicalSchema,
    outcomes: spec.outcomes,
    accessLanes: [spec.lane],
    contextBuilder: refs.context,
    handlerCapability: spec.handlerCapability,
    handler: refs.handler,
    audit: { mode: 'required' as const, target: auditTarget },
    idempotency: {
      keySource: refs.keySource,
      credentialVerifierProfile: input.idempotencyCredentialProfile,
      requestHashProfile: spec.requestHashProfile
    },
    concurrency: refs.concurrency,
    execution: {
      kind: 'single_unit_of_work' as const,
      family: refs.family,
      phase: refs.phase,
      terminalization: refs.terminalization,
      autonomyPreflight: refs.preflight
    },
    bindings: [{
      surface: 'operator_http' as const,
      method: 'POST' as const,
      path: spec.path,
      input: 'body' as const,
      browserResumption: { kind: 'none' as const },
      projection: refs.projection
    }]
  });
  return Object.freeze({
    autonomy: autonomyPolicy, context, family, terminalization, phase, risk,
    evidence, approval, preflight, handler, projection: resultProjection, definition
  });
}

function saveOutcomes(
  accessOutcomes: readonly OperationOutcomeDeclaration[]
): readonly OperationOutcomeDeclaration[] {
  return Object.freeze([
    { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.nullDetail },
    ...accessOutcomes,
    { class: 'conflict' as const, kind: 'review.event_required', retryable: false, detailSchema: schemas.nullDetail },
    { class: 'conflict' as const, kind: 'review.viewer_required', retryable: false, detailSchema: schemas.nullDetail },
    { class: 'stale_revision' as const, kind: 'review.canonical_changed', retryable: false, detailSchema: schemas.staleDetail },
    { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.nullDetail },
    ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
  ]);
}
