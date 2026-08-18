import { isApplicationId, parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import { deadlineMutationPlanSchema, deadlineSafeDiffSchema } from './deadlines';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';

export const reviewIdSchema = z.string().refine(isApplicationId, {
  message: 'Review ids must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
export const reviewVersionSchema = z.number().int().positive().safe();
export const reviewSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewInstantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
}, 'Expected a canonical UTC instant.');
export const reviewScopeSchema = z.strictObject({
  workspaceId: reviewIdSchema,
  eventId: reviewIdSchema
});

export const reviewScopeRefSchema = z.strictObject({
  kind: z.enum(['track', 'format', 'session']),
  id: reviewIdSchema
});

export const reviewCriterionSchema = z.strictObject({
  id: reviewIdSchema,
  key: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
  position: z.number().int().nonnegative().safe(),
  weightBps: z.number().int().positive().max(10_000),
  scaleMin: z.literal(1),
  scaleMax: z.literal(5)
});

export const reviewCriteriaSchema = z.array(reviewCriterionSchema).min(1).max(20)
  .superRefine((criteria, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    const positions = new Set<number>();
    let weight = 0;
    for (const [index, criterion] of criteria.entries()) {
      if (ids.has(criterion.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'criterion ids must be unique' });
      if (keys.has(criterion.key)) context.addIssue({ code: 'custom', path: [index, 'key'], message: 'criterion keys must be unique' });
      if (positions.has(criterion.position)) context.addIssue({ code: 'custom', path: [index, 'position'], message: 'criterion positions must be unique' });
      const previous = criteria[index - 1];
      if (previous && compareCriterion(previous, criterion) >= 0) {
        context.addIssue({ code: 'custom', path: [index], message: 'criteria must use canonical position order' });
      }
      ids.add(criterion.id);
      keys.add(criterion.key);
      positions.add(criterion.position);
      weight += criterion.weightBps;
    }
    if (weight !== 10_000) context.addIssue({ code: 'custom', message: 'criterion weights must total 10000 basis points' });
  });

export const reviewCriterionScoreSchema = z.strictObject({
  criterionId: reviewIdSchema,
  score: z.number().int().min(1).max(5)
});
export const reviewCriterionScoresSchema = z.array(reviewCriterionScoreSchema).min(1).max(20)
  .superRefine((scores, context) => {
    for (const [index, score] of scores.entries()) {
      const previous = scores[index - 1];
      if (previous && previous.criterionId >= score.criterionId) {
        context.addIssue({ code: 'custom', path: [index, 'criterionId'], message: 'criterion scores must use unique canonical id order' });
      }
    }
  });

export const reviewDeadlinePinSchema = z.strictObject({
  deadlineId: reviewIdSchema,
  kind: z.literal('review_due'),
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  effectiveAt: reviewInstantSchema
});

export const reviewVisibilityPolicySchema = z.strictObject({
  participantIdentity: z.enum(['hidden', 'shown']),
  peerReviewerIdentity: z.enum(['hidden', 'shown']),
  peerContentUnlock: z.enum(['after_own_commit', 'open'])
});

const roundCommon = {
  schemaVersion: z.literal(1),
  scope: reviewScopeSchema,
  id: reviewIdSchema,
  ordinal: z.number().int().positive().safe(),
  name: z.string().trim().min(1).max(120),
  version: reviewVersionSchema,
  deadline: reviewDeadlinePinSchema,
  criteria: reviewCriteriaSchema,
  visibility: reviewVisibilityPolicySchema,
  openedByUserId: reviewIdSchema,
  openedAt: reviewInstantSchema
} as const;
export const reviewRoundSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...roundCommon, state: z.literal('open') }),
  z.strictObject({
    ...roundCommon,
    state: z.literal('closed'),
    closedByUserId: reviewIdSchema,
    closedAt: reviewInstantSchema
  }),
  z.strictObject({
    ...roundCommon,
    state: z.literal('discarded'),
    discardedByUserId: reviewIdSchema,
    discardedAt: reviewInstantSchema
  })
]);

export const reviewCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewScopeSchema,
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema,
  rounds: z.array(reviewRoundSchema).max(100)
}).superRefine((catalog, context) => {
  for (const [index, round] of catalog.rounds.entries()) {
    const previous = catalog.rounds[index - 1];
    if (previous && compareRound(previous, round) >= 0) {
      context.addIssue({ code: 'custom', path: ['rounds', index], message: 'rounds must use canonical ordinal order' });
    }
    if (round.scope.workspaceId !== catalog.scope.workspaceId || round.scope.eventId !== catalog.scope.eventId) {
      context.addIssue({ code: 'custom', path: ['rounds', index, 'scope'], message: 'round scope must match catalog scope' });
    }
  }
});

export const reviewCandidateSnapshotSchema = z.strictObject({
  submissionId: reviewIdSchema,
  version: reviewVersionSchema,
  trackId: reviewIdSchema.optional(),
  formatId: reviewIdSchema.optional(),
  targetSessionId: reviewIdSchema.optional()
});

/** Viewer-safe content joined separately from the assignment/scoping snapshot. */
export const reviewCandidateSpeakerSchema = z.strictObject({
  speakerId: reviewIdSchema,
  displayName: z.string().trim().min(1).max(160)
});
export const reviewCandidateResourceSchema = z.strictObject({
  resourceId: reviewIdSchema,
  name: z.string().trim().min(1).max(240),
  kind: z.enum(['slides', 'video', 'document', 'link']),
  detail: z.string().trim().min(1).max(500)
});
export const reviewCandidateDisplaySchema = z.strictObject({
  submissionId: reviewIdSchema,
  version: reviewVersionSchema,
  title: z.string().trim().min(1).max(500),
  abstract: z.string().max(50_000),
  submittedAt: reviewInstantSchema,
  trackId: reviewIdSchema.optional(),
  formatId: reviewIdSchema.optional(),
  targetSessionId: reviewIdSchema.optional(),
  resources: z.array(reviewCandidateResourceSchema).max(100),
  /** Absent means the authority/blinding projection did not release identity. */
  speakers: z.array(reviewCandidateSpeakerSchema).max(100).optional()
});

export const reviewRosterMemberSnapshotSchema = z.strictObject({
  reviewerId: reviewIdSchema,
  version: reviewVersionSchema,
  status: z.enum(['invited', 'active']),
  displayName: z.string().trim().min(1).max(160).optional(),
  scope: z.array(reviewScopeRefSchema).max(100)
});

export const reviewAssignmentSchema = z.discriminatedUnion('state', [
  z.strictObject({
    schemaVersion: z.literal(1), scope: reviewScopeSchema, id: reviewIdSchema,
    roundId: reviewIdSchema, submissionId: reviewIdSchema, reviewerId: reviewIdSchema,
    version: reviewVersionSchema, state: z.literal('assigned'), assignedAt: reviewInstantSchema
  }),
  z.strictObject({
    schemaVersion: z.literal(1), scope: reviewScopeSchema, id: reviewIdSchema,
    roundId: reviewIdSchema, submissionId: reviewIdSchema, reviewerId: reviewIdSchema,
    version: reviewVersionSchema, state: z.literal('stepped_back'), assignedAt: reviewInstantSchema,
    steppedBackAt: reviewInstantSchema, steppedBackByUserId: reviewIdSchema
  })
]);

export const reviewDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewScopeSchema,
  assignmentId: reviewIdSchema,
  version: reviewVersionSchema,
  scores: reviewCriterionScoresSchema,
  comment: z.string().max(20_000),
  updatedByReviewerId: reviewIdSchema,
  updatedByUserId: reviewIdSchema,
  updatedAt: reviewInstantSchema
});

export const reviewRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewScopeSchema,
  id: reviewIdSchema,
  assignmentId: reviewIdSchema,
  revisionNumber: reviewVersionSchema,
  scores: reviewCriterionScoresSchema,
  weightedScore: z.number().min(1).max(5),
  comment: z.string().max(20_000),
  committedByReviewerId: reviewIdSchema,
  committedByUserId: reviewIdSchema,
  committedAt: reviewInstantSchema,
  postUnlock: z.boolean(),
  correctionOfRevisionId: reviewIdSchema.optional()
}).superRefine((revision, context) => {
  if (revision.revisionNumber === 1 && (revision.postUnlock || revision.correctionOfRevisionId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'first review revision cannot be post-unlock or a correction' });
  }
  if (revision.revisionNumber > 1 && (!revision.postUnlock || revision.correctionOfRevisionId === undefined)) {
    context.addIssue({ code: 'custom', message: 'review amendments must identify the corrected post-unlock revision' });
  }
});

export const reviewHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: reviewScopeSchema,
  assignmentId: reviewIdSchema,
  version: reviewVersionSchema,
  currentRevisionId: reviewIdSchema,
  firstCommittedAt: reviewInstantSchema,
  peerUnlockedAt: reviewInstantSchema
});

const attributionFields = {
  attributedByUserId: reviewIdSchema,
  attributedAt: reviewInstantSchema
} as const;

/**
 * Opening a round never references a pre-existing deadline: the server mints
 * the `review_due` Deadline identity and the same direct operation creates it
 * atomically from `deadlineDate` through the Deadline collaboration.
 */
export const reviewOpenRoundPlanningInputSchema = z.strictObject({
  action: z.literal('open_round'),
  scope: reviewScopeSchema,
  expectedCatalogVersion: reviewVersionSchema,
  roundId: reviewIdSchema,
  deadlineIdentity: z.strictObject({ deadlineId: reviewIdSchema }),
  deadlineDate: z.iso.date(),
  criteria: reviewCriteriaSchema,
  visibility: reviewVisibilityPolicySchema,
  assignmentIds: z.array(z.strictObject({
    assignmentId: reviewIdSchema,
    reviewerId: reviewIdSchema,
    submissionId: reviewIdSchema
  })).max(20_000),
  ...attributionFields
});

export const reviewDiscardRoundPlanningInputSchema = z.strictObject({
  action: z.literal('discard_empty_round'), scope: reviewScopeSchema,
  roundId: reviewIdSchema, expectedRoundVersion: reviewVersionSchema,
  ...attributionFields
});
export const reviewStepBackPlanningInputSchema = z.strictObject({
  action: z.literal('step_back'), scope: reviewScopeSchema,
  assignmentId: reviewIdSchema, expectedAssignmentVersion: reviewVersionSchema,
  reviewerId: reviewIdSchema, ...attributionFields
});
export const reviewCommitPlanningInputSchema = z.strictObject({
  action: z.literal('commit_review'), scope: reviewScopeSchema,
  assignmentId: reviewIdSchema, expectedAssignmentVersion: reviewVersionSchema,
  expectedDraftVersion: reviewVersionSchema, revisionId: reviewIdSchema,
  reviewerId: reviewIdSchema, ...attributionFields
});
export const reviewAmendPlanningInputSchema = z.strictObject({
  action: z.literal('amend_review'), scope: reviewScopeSchema,
  assignmentId: reviewIdSchema, expectedAssignmentVersion: reviewVersionSchema,
  expectedReviewVersion: reviewVersionSchema, expectedCurrentRevisionId: reviewIdSchema,
  revisionId: reviewIdSchema, reviewerId: reviewIdSchema,
  scores: reviewCriterionScoresSchema, comment: z.string().max(20_000),
  ...attributionFields
});
export const reviewMutationPlanningInputSchema = z.discriminatedUnion('action', [
  reviewOpenRoundPlanningInputSchema,
  reviewDiscardRoundPlanningInputSchema,
  reviewStepBackPlanningInputSchema,
  reviewCommitPlanningInputSchema,
  reviewAmendPlanningInputSchema
]);

export const reviewQueryGuardSchema = z.strictObject({
  id: z.string().trim().min(1).max(512),
  version: reviewVersionSchema,
  digestSha256: reviewSha256Schema
});

/**
 * The open-round plan carries the whole `review_due` Deadline creation as an
 * embedded Deadline mutation contribution; the Deadline is created in the same
 * committed unit of work as the round.
 *
 * There is deliberately no per-deadline guard here: the created Deadline does
 * not exist before execution, so a `review_deadline:<id>` guard could never be
 * satisfied at the in-transaction recheck and would always false-conflict.
 * Concurrent Deadline activity is instead fenced by the Deadline domain's own
 * `deadline_catalog` guard (version + digest) carried by the contribution.
 */
export const reviewOpenRoundPlanSchema = z.strictObject({
  action: z.literal('open_round'), input: reviewOpenRoundPlanningInputSchema,
  catalog: z.strictObject({
    beforeVersion: reviewVersionSchema, beforeDigestSha256: reviewSha256Schema,
    afterVersion: reviewVersionSchema, afterDigestSha256: reviewSha256Schema
  }),
  round: reviewRoundSchema,
  assignments: z.array(reviewAssignmentSchema).max(20_000),
  candidateGuard: reviewQueryGuardSchema,
  reviewerGuard: reviewQueryGuardSchema,
  deadlineContribution: deadlineMutationPlanSchema
});
export const reviewDiscardRoundPlanSchema = z.strictObject({
  action: z.literal('discard_empty_round'), input: reviewDiscardRoundPlanningInputSchema,
  before: reviewRoundSchema, after: reviewRoundSchema,
  catalog: z.strictObject({
    beforeVersion: reviewVersionSchema, beforeDigestSha256: reviewSha256Schema,
    afterVersion: reviewVersionSchema, afterDigestSha256: reviewSha256Schema
  })
});
export const reviewStepBackPlanSchema = z.strictObject({
  action: z.literal('step_back'), input: reviewStepBackPlanningInputSchema,
  before: reviewAssignmentSchema, after: reviewAssignmentSchema
});
export const reviewCommitPlanSchema = z.strictObject({
  action: z.literal('commit_review'), input: reviewCommitPlanningInputSchema,
  assignment: reviewAssignmentSchema, draft: reviewDraftSchema,
  before: z.null(), after: reviewHeadSchema, revision: reviewRevisionSchema
});
export const reviewAmendPlanSchema = z.strictObject({
  action: z.literal('amend_review'), input: reviewAmendPlanningInputSchema,
  assignment: reviewAssignmentSchema, before: reviewHeadSchema, after: reviewHeadSchema,
  priorRevision: reviewRevisionSchema, revision: reviewRevisionSchema
});
export const reviewMutationPlanSchema = z.discriminatedUnion('action', [
  reviewOpenRoundPlanSchema,
  reviewDiscardRoundPlanSchema,
  reviewStepBackPlanSchema,
  reviewCommitPlanSchema,
  reviewAmendPlanSchema
]);

export const reviewSafeDiffSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open_round'), roundId: reviewIdSchema,
    roundName: z.string().trim().min(1).max(120), assignmentCount: z.number().int().nonnegative().safe(),
    reviewerCount: z.number().int().nonnegative().safe(), submissionCount: z.number().int().nonnegative().safe(),
    deadlineEffectiveAt: reviewInstantSchema, anonymized: z.boolean(), criterionLabels: z.array(z.string()),
    deadline: deadlineSafeDiffSchema
  }),
  z.strictObject({ action: z.literal('discard_empty_round'), roundId: reviewIdSchema, roundName: z.string() }),
  z.strictObject({ action: z.literal('step_back'), assignmentId: reviewIdSchema, submissionId: reviewIdSchema }),
  z.strictObject({
    action: z.literal('commit_review'), assignmentId: reviewIdSchema, submissionId: reviewIdSchema,
    weightedScore: z.number().min(1).max(5), commentPresent: z.boolean()
  }),
  z.strictObject({
    action: z.literal('amend_review'), assignmentId: reviewIdSchema, submissionId: reviewIdSchema,
    beforeScore: z.number().min(1).max(5), afterScore: z.number().min(1).max(5),
    commentChanged: z.boolean(), correctionOfRevisionId: reviewIdSchema
  })
]);

export const reviewMutationResultSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open_round'), round: reviewRoundSchema, assignmentCount: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal('discard_empty_round'), round: reviewRoundSchema }),
  z.strictObject({ action: z.literal('step_back'), assignment: reviewAssignmentSchema }),
  z.strictObject({ action: z.literal('commit_review'), head: reviewHeadSchema, revision: reviewRevisionSchema }),
  z.strictObject({ action: z.literal('amend_review'), head: reviewHeadSchema, revision: reviewRevisionSchema })
]);

export const reviewRoundSetupProjectionSchema = z.strictObject({
  activeReviewers: z.number().int().nonnegative().safe(),
  invitedReviewers: z.number().int().nonnegative().safe(),
  submissions: z.number().int().nonnegative().safe(),
  expectedReviews: z.number().int().nonnegative().safe(),
  perReviewer: z.array(z.strictObject({
    reviewerId: reviewIdSchema,
    displayName: z.string().trim().min(1).max(160).optional(),
    assigned: z.number().int().nonnegative().safe()
  }))
});

export const reviewPlanProjectionSchema = z.strictObject({
  id: reviewIdSchema, ordinal: z.number().int().positive(), name: z.string(), state: z.enum(['open', 'closed', 'discarded']),
  /** The canonical round version; round-targeted change drafts pin it as their expected version. */
  version: reviewVersionSchema,
  scaleMax: z.literal(5), deadlineEffectiveAt: reviewInstantSchema,
  /**
   * The round's canonical criterion identities in canonical position order.
   * Evaluation saves score exactly these ids; no surface mints its own.
   */
  criteria: reviewCriteriaSchema,
  anonymized: z.boolean(), antiAnchoring: z.boolean(), done: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  reviewers: z.array(z.strictObject({
    reviewerId: reviewIdSchema, displayName: z.string().optional(), assigned: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(), steppedBack: z.number().int().nonnegative(),
    awaitingReassignment: z.number().int().nonnegative(),
    /** Organizer-only detail behind each uncovered count; identity and contact stay absent. */
    uncovered: z.array(z.strictObject({
      submissionId: reviewIdSchema,
      title: z.string().trim().min(1).max(500),
      remainingReviewers: z.number().int().nonnegative().safe()
    })).optional()
  }))
});

export const reviewRevisionProjectionSchema = z.strictObject({
  revisionId: reviewIdSchema, score: z.number().min(1).max(5), comment: z.string().max(20_000),
  at: reviewInstantSchema, postUnlock: z.boolean(), correctionOfRevisionId: reviewIdSchema.optional()
});
export const reviewQueueItemProjectionSchema = z.strictObject({
  assignmentId: reviewIdSchema, roundId: reviewIdSchema, submissionId: reviewIdSchema,
  assignmentVersion: reviewVersionSchema,
  candidate: reviewCandidateDisplaySchema,
  draft: z.strictObject({ version: reviewVersionSchema, score: z.number().min(1).max(5), comment: z.string().max(20_000) }).optional(),
  committed: z.boolean(), current: reviewRevisionProjectionSchema.optional(),
  revisions: z.array(reviewRevisionProjectionSchema),
  peerScores: z.array(z.number().min(1).max(5)).optional()
}).superRefine((item, context) => {
  if (item.submissionId !== item.candidate.submissionId) {
    context.addIssue({
      code: 'custom', path: ['candidate', 'submissionId'],
      message: 'queue candidate must match its assignment submission'
    });
  }
});

export const reviewStandingSchema = z.strictObject({
  submissionId: reviewIdSchema,
  value: z.number().min(1).max(5), scaleMax: z.literal(5), reviews: z.number().int().positive(),
  n: z.number().int().positive(), median: z.number().min(1).max(5),
  band: z.enum(['top', 'upper', 'mid', 'lower', 'bottom', 'few']),
  phrase: z.string().trim().min(1).max(160),
  slice: z.strictObject({ label: z.string().trim().min(1).max(160).optional(), trackId: reviewIdSchema.optional() }),
  points: z.array(z.number().min(1).max(5)).max(119).optional(),
  bins: z.array(z.number().int().nonnegative()).length(24).optional(),
  dotK: z.number().int().positive().optional()
}).superRefine((standing, context) => {
  if (standing.points !== undefined && standing.bins !== undefined) context.addIssue({ code: 'custom', message: 'standing cannot expose points and bins together' });
  if (standing.points === undefined && standing.bins === undefined) context.addIssue({ code: 'custom', message: 'standing must expose points or bins' });
  if (standing.points !== undefined && standing.points.length !== standing.n - 1) context.addIssue({ code: 'custom', path: ['points'], message: 'standing points must contain every other scored submission' });
  if (standing.bins !== undefined && standing.bins.reduce((sum, count) => sum + count, 0) !== standing.n) context.addIssue({ code: 'custom', path: ['bins'], message: 'standing bins must account for the whole slice' });
  if (standing.n < 8 && standing.band !== 'few') context.addIssue({ code: 'custom', path: ['band'], message: 'sparse standings must not claim rank' });
});

export const reviewSnapshotReadInputSchema = z.strictObject({
  standingSubmissionIds: z.array(reviewIdSchema).max(100).default([]),
  standingSlice: z.enum(['track', 'all']).default('track')
});
export const reviewSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  viewer: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('organizer') }),
    z.strictObject({ kind: z.literal('reviewer'), reviewerId: reviewIdSchema })
  ]),
  plans: z.array(reviewPlanProjectionSchema),
  roundSetup: reviewRoundSetupProjectionSchema.optional(),
  reviewerScope: z.array(reviewScopeRefSchema).optional(),
  queue: z.array(reviewQueueItemProjectionSchema).optional(),
  standings: z.record(reviewIdSchema, reviewStandingSchema)
});

export const reviewRoundSetupReadInputSchema = z.strictObject({});

/**
 * Omitting `criteria` opens the round with the server's single default
 * criterion (key `overall`, full weight, 1–5 scale). Such a round therefore
 * scores exactly one criterion, and its evaluation saves carry exactly one
 * score entry for that served criterion id.
 */
export const reviewOpenRoundChangeDraftInputSchema = z.strictObject({
  action: z.literal('open_round'), deadlineDate: z.iso.date(),
  criteria: reviewCriteriaSchema.optional(), anonymized: z.boolean().default(true)
});
export const reviewDiscardRoundChangeDraftInputSchema = z.strictObject({
  action: z.literal('discard_empty_round'), roundId: reviewIdSchema,
  expectedRoundVersion: reviewVersionSchema
});
export const reviewStepBackChangeDraftInputSchema = z.strictObject({
  action: z.literal('step_back'), assignmentId: reviewIdSchema,
  expectedAssignmentVersion: reviewVersionSchema
});
export const reviewCommitChangeDraftInputSchema = z.strictObject({
  action: z.literal('commit_review'), assignmentId: reviewIdSchema,
  expectedAssignmentVersion: reviewVersionSchema, expectedDraftVersion: reviewVersionSchema
});
export const reviewAmendChangeDraftInputSchema = z.strictObject({
  action: z.literal('amend_review'), assignmentId: reviewIdSchema,
  expectedAssignmentVersion: reviewVersionSchema, expectedReviewVersion: reviewVersionSchema,
  expectedCurrentRevisionId: reviewIdSchema, scores: reviewCriterionScoresSchema,
  comment: z.string().max(20_000)
});
export const reviewChangeDraftInputSchema = z.discriminatedUnion('action', [
  reviewOpenRoundChangeDraftInputSchema,
  reviewDiscardRoundChangeDraftInputSchema,
  reviewStepBackChangeDraftInputSchema,
  reviewCommitChangeDraftInputSchema,
  reviewAmendChangeDraftInputSchema
]);
export const reviewRoundChangeDraftInputSchema = z.discriminatedUnion('action', [
  reviewOpenRoundChangeDraftInputSchema,
  reviewDiscardRoundChangeDraftInputSchema
]);
export const reviewEvaluationChangeDraftInputSchema = z.discriminatedUnion('action', [
  reviewCommitChangeDraftInputSchema,
  reviewAmendChangeDraftInputSchema
]);

export const reviewDraftSaveInputSchema = z.strictObject({
  assignmentId: reviewIdSchema,
  expectedDraftVersion: reviewVersionSchema.nullable(),
  scores: reviewCriterionScoresSchema,
  comment: z.string().max(20_000)
});
export const reviewDraftSaveResultSchema = z.strictObject({ draft: reviewDraftSchema });

export const reviewDraftSaveCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: reviewDraftSaveResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const reviewSnapshotReadResultSchema = createReadOperationResultSchema(reviewSnapshotSchema);
export const reviewRoundSetupReadResultSchema = createReadOperationResultSchema(reviewRoundSetupProjectionSchema);
export const reviewDirectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: reviewMutationResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const reviewDirectOperationResultSchema =
  createEffectfulOperationResultSchema(reviewMutationResultSchema);
export const reviewDraftSaveOperationResultSchema = createEffectfulOperationResultSchema(reviewDraftSaveResultSchema);

export const REVIEW_OPERATION_SCHEMA_REFS = Object.freeze({
  snapshotRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.review.snapshot-read.input',
    inputSchema: reviewSnapshotReadInputSchema,
    resultKey: 'schema.review.snapshot-read.operator-result',
    resultSchema: reviewSnapshotReadResultSchema
  }),
  roundSetupRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.review.round-setup-read.input',
    inputSchema: reviewRoundSetupReadInputSchema,
    resultKey: 'schema.review.round-setup-read.operator-result',
    resultSchema: reviewRoundSetupReadResultSchema
  }),
  draftSave: createOperationSchemaManifestRefs({
    inputKey: 'schema.review.evaluation-draft-save.input',
    inputSchema: reviewDraftSaveInputSchema,
    resultKey: 'schema.review.evaluation-draft-save.operator-result',
    resultSchema: reviewDraftSaveOperationResultSchema
  }),
  roundChange: createOperationSchemaManifestRefs({
    inputKey: 'schema.review.round-change.input',
    inputSchema: reviewRoundChangeDraftInputSchema,
    resultKey: 'schema.review.direct.operator-result',
    resultSchema: reviewDirectOperationResultSchema
  }),
  stepBack: createOperationSchemaManifestRefs({
    inputKey: 'schema.review.step-back.input',
    inputSchema: reviewStepBackChangeDraftInputSchema,
    resultKey: 'schema.review.direct.operator-result',
    resultSchema: reviewDirectOperationResultSchema
  }),
  evaluationChange: createOperationSchemaManifestRefs({
    inputKey: 'schema.review.evaluation-change.input',
    inputSchema: reviewEvaluationChangeDraftInputSchema,
    resultKey: 'schema.review.direct.operator-result',
    resultSchema: reviewDirectOperationResultSchema
  })
});

export type ReviewScopeDto = z.infer<typeof reviewScopeSchema>;
export type ReviewScopeRefDto = z.infer<typeof reviewScopeRefSchema>;
export type ReviewCriterionDto = z.infer<typeof reviewCriterionSchema>;
export type ReviewCriterionScoreDto = z.infer<typeof reviewCriterionScoreSchema>;
export type ReviewDeadlinePinDto = z.infer<typeof reviewDeadlinePinSchema>;
export type ReviewVisibilityPolicyDto = z.infer<typeof reviewVisibilityPolicySchema>;
export type ReviewRoundDto = z.infer<typeof reviewRoundSchema>;
export type ReviewCatalogDto = z.infer<typeof reviewCatalogSchema>;
export type ReviewCandidateSnapshotDto = z.infer<typeof reviewCandidateSnapshotSchema>;
export type ReviewCandidateDisplayDto = z.infer<typeof reviewCandidateDisplaySchema>;
export type ReviewRosterMemberSnapshotDto = z.infer<typeof reviewRosterMemberSnapshotSchema>;
export type ReviewAssignmentDto = z.infer<typeof reviewAssignmentSchema>;
export type ReviewDraftDto = z.infer<typeof reviewDraftSchema>;
export type ReviewRevisionDto = z.infer<typeof reviewRevisionSchema>;
export type ReviewHeadDto = z.infer<typeof reviewHeadSchema>;
export type ReviewMutationPlanningInput = z.infer<typeof reviewMutationPlanningInputSchema>;
export type ReviewMutationPlanDto = z.infer<typeof reviewMutationPlanSchema>;
export type ReviewSafeDiff = z.infer<typeof reviewSafeDiffSchema>;
export type ReviewMutationResult = z.infer<typeof reviewMutationResultSchema>;
export type ReviewDirectOperationResult = z.infer<typeof reviewDirectOperationResultSchema>;
export type ReviewRoundSetupProjection = z.infer<typeof reviewRoundSetupProjectionSchema>;
export type ReviewPlanProjection = z.infer<typeof reviewPlanProjectionSchema>;
export type ReviewQueueItemProjection = z.infer<typeof reviewQueueItemProjectionSchema>;
export type ReviewStanding = z.infer<typeof reviewStandingSchema>;
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
export type ReviewChangeDraftInput = z.infer<typeof reviewChangeDraftInputSchema>;
export type ReviewDraftSaveInput = z.infer<typeof reviewDraftSaveInputSchema>;
export type ReviewDraftSaveResult = z.infer<typeof reviewDraftSaveResultSchema>;

function compareCriterion(left: { position: number; id: string }, right: { position: number; id: string }): number {
  if (left.position !== right.position) return left.position - right.position;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareRound(left: { ordinal: number; id: string }, right: { ordinal: number; id: string }): number {
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
