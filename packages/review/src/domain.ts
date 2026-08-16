import { canonicalJsonSha256, canonicalJsonValue, type CanonicalJson } from '@jooevents/kernel';
import {
  reviewCatalogSchema,
  reviewCriteriaSchema,
  reviewDraftSaveInputSchema,
  reviewDraftSaveResultSchema,
  reviewMutationPlanSchema,
  reviewMutationPlanningInputSchema,
  reviewMutationResultSchema,
  reviewSafeDiffSchema,
  type ReviewAssignmentDto,
  type ReviewCandidateSnapshotDto,
  type ReviewCatalogDto,
  type ReviewCriterionScoreDto,
  type ReviewCriterionDto,
  type ReviewDraftDto,
  type ReviewDraftSaveInput,
  type ReviewDraftSaveResult,
  type ReviewMutationPlanDto,
  type ReviewMutationPlanningInput,
  type ReviewMutationResult,
  type ReviewRosterMemberSnapshotDto,
  type ReviewRoundDto,
  type ReviewSafeDiff,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  planReviewDueDeadlineChangeFrom,
  projectReviewDueDeadlineDiff,
  reviewDeadlinePinFromReference,
  reviewDueDeadlinePin,
  type DeadlineEventTimeSource,
  type DeadlineRepository,
  type ReviewDueDeadlineContribution
} from '@jooevents/deadline';
import {
  compareAssignments,
  compareCandidates,
  compareReviewers,
  parseReviewAssignment,
  parseReviewCandidate,
  parseReviewCatalog,
  parseReviewDeadlinePin,
  parseReviewDraft,
  parseReviewHead,
  parseReviewRevision,
  parseReviewRosterMember,
  parseReviewRound,
  parseReviewScope,
  sameReviewScope,
  type ReviewPlanningSource,
  type ReviewRepository,
  type ReviewTransactionRepository
} from './model';

export type ReviewPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_catalog'
  | 'open_round_exists'
  | 'no_assignments'
  | 'assignment_seed_mismatch'
  | 'deadline_missing'
  | 'round_missing'
  | 'stale_round'
  | 'round_not_open'
  | 'round_has_work'
  | 'assignment_missing'
  | 'stale_assignment'
  | 'assignment_not_active'
  | 'not_assigned_reviewer'
  | 'draft_missing'
  | 'stale_draft'
  | 'review_exists'
  | 'review_missing'
  | 'stale_review'
  | 'revision_missing'
  | 'invalid_scores'
  | 'candidate_query_changed'
  | 'reviewer_query_changed'
  | 'deadline_changed'
  | 'invalid_plan';

export class ReviewPlanningError extends Error {
  constructor(readonly code: ReviewPlanningErrorCode) {
    super(code);
    this.name = 'ReviewPlanningError';
  }
}

export interface ReviewMutationEnvironment {
  readonly repository: ReviewRepository;
  readonly sources: ReviewPlanningSource;
}

/** The Deadline-domain read capability the open-round collaboration plans against. */
export type ReviewDueDeadlineCollaborator = DeadlineRepository & DeadlineEventTimeSource;

/**
 * Fresh planning additionally needs the Deadline collaborator because opening a
 * round authors a `review_due` Deadline creation in the same plan; the other
 * actions never touch the Deadline domain. Validation and apply revalidate
 * against the exact stored contribution instead of re-planning it, so they only
 * need the base environment.
 */
export interface ReviewMutationPlanningEnvironment extends ReviewMutationEnvironment {
  readonly deadlines?: ReviewDueDeadlineCollaborator;
}

type OpenRoundDeadlineCollaboration =
  | { readonly kind: 'collaborate'; readonly deadlines: ReviewDueDeadlineCollaborator }
  | { readonly kind: 'injected'; readonly contribution: ReviewDueDeadlineContribution };

export function reviewCatalogGuardId(eventId: string): string {
  return `review_catalog:${eventId}`;
}

export function reviewCandidateQueryGuardId(eventId: string): string {
  return `review_candidates:${eventId}`;
}

export function reviewReviewerQueryGuardId(eventId: string): string {
  return `review_reviewers:${eventId}`;
}

export function reviewCatalogDigest(input: {
  readonly scope: ReviewScopeDto;
  readonly version: number;
  readonly rounds: readonly ReviewRoundDto[];
}): string {
  return canonicalJsonSha256({
    schemaVersion: 1,
    scope: input.scope,
    version: input.version,
    rounds: input.rounds
  });
}

export function createEmptyReviewCatalog(scopeInput: ReviewScopeDto): ReviewCatalogDto {
  const scope = parseReviewScope(scopeInput);
  const version = 1;
  const rounds: readonly ReviewRoundDto[] = Object.freeze([]);
  return parseReviewCatalog({
    schemaVersion: 1,
    scope,
    version,
    digestSha256: reviewCatalogDigest({ scope, version, rounds }),
    rounds
  });
}

export function createDefaultReviewCriteria(
  criterionId: ReviewCriterionDto['id']
): ReviewCriterionDto[] {
  return reviewCriteriaSchema.parse([{
    id: criterionId,
    key: 'overall',
    label: 'Overall',
    position: 0,
    weightBps: 10_000,
    scaleMin: 1,
    scaleMax: 5
  }]);
}

export function assertReviewCatalogDigest(catalog: ReviewCatalogDto): void {
  const parsed = reviewCatalogSchema.parse(catalog);
  if (parsed.digestSha256 !== reviewCatalogDigest(parsed)) {
    throw new TypeError('review_catalog_digest_invalid');
  }
}

export function reviewCandidateSetDigest(candidates: readonly ReviewCandidateSnapshotDto[]): string {
  return canonicalJsonSha256([...candidates].map(parseReviewCandidate).sort(compareCandidates));
}

export function reviewRosterSetDigest(reviewers: readonly ReviewRosterMemberSnapshotDto[]): string {
  return canonicalJsonSha256([...reviewers].map(parseReviewRosterMember).sort(compareReviewers));
}

export function reviewerCoversCandidate(
  reviewer: ReviewRosterMemberSnapshotDto,
  candidate: ReviewCandidateSnapshotDto
): boolean {
  if (reviewer.status !== 'active') return false;
  if (reviewer.scope.length === 0) return true;
  return reviewer.scope.some((reference) => {
    if (reference.kind === 'track') return candidate.trackId === reference.id;
    if (reference.kind === 'format') return candidate.formatId === reference.id;
    return candidate.targetSessionId === reference.id;
  });
}

export function expectedReviewAssignmentPairs(input: {
  readonly candidates: readonly ReviewCandidateSnapshotDto[];
  readonly reviewers: readonly ReviewRosterMemberSnapshotDto[];
}): readonly {
  readonly reviewerId: ReviewRosterMemberSnapshotDto['reviewerId'];
  readonly submissionId: ReviewCandidateSnapshotDto['submissionId'];
}[] {
  const candidates = [...input.candidates].map(parseReviewCandidate).sort(compareCandidates);
  const reviewers = [...input.reviewers].map(parseReviewRosterMember).sort(compareReviewers);
  return Object.freeze(reviewers.flatMap((reviewer) => candidates
    .filter((candidate) => reviewerCoversCandidate(reviewer, candidate))
    .map((candidate) => Object.freeze({
      reviewerId: reviewer.reviewerId,
      submissionId: candidate.submissionId
    }))));
}

export function planReviewMutation(
  planningInput: ReviewMutationPlanningInput,
  environment: ReviewMutationPlanningEnvironment
): ReviewMutationPlanDto {
  return planMutation(
    planningInput,
    environment,
    environment.deadlines === undefined
      ? undefined
      : { kind: 'collaborate', deadlines: environment.deadlines }
  );
}

function planMutation(
  planningInput: ReviewMutationPlanningInput,
  environment: ReviewMutationEnvironment,
  collaboration?: OpenRoundDeadlineCollaboration
): ReviewMutationPlanDto {
  const input = reviewMutationPlanningInputSchema.parse(planningInput);
  const scope = parseReviewScope(input.scope);
  const catalog = currentCatalog(scope, environment.repository);
  assertReviewCatalogDigest(catalog);
  if (input.action === 'open_round') {
    if (!collaboration) throw new TypeError('review_open_round_deadline_collaboration_missing');
    return planOpenRound(input, catalog, environment, collaboration);
  }
  if (input.action === 'discard_empty_round') return planDiscardRound(input, catalog, environment.repository);
  if (input.action === 'step_back') return planStepBack(input, environment.repository);
  if (input.action === 'commit_review') return planCommitReview(input, environment.repository);
  return planAmendReview(input, environment.repository);
}

export function validateReviewMutationPlan(
  planInput: ReviewMutationPlanDto,
  environment: ReviewMutationEnvironment
): ReviewPlanningErrorCode | undefined {
  let plan: ReviewMutationPlanDto;
  try {
    plan = reviewMutationPlanSchema.parse(planInput);
    if (plan.action === 'open_round') {
      const candidates = environment.sources.readCandidates(plan.input.scope);
      const reviewers = environment.sources.readReviewerRoster(plan.input.scope);
      if (!candidates || reviewCandidateSetDigest(candidates.candidates) !== plan.candidateGuard.digestSha256
          || candidates.version !== plan.candidateGuard.version) return 'candidate_query_changed';
      if (!reviewers || reviewRosterSetDigest(reviewers.reviewers) !== plan.reviewerGuard.digestSha256
          || reviewers.version !== plan.reviewerGuard.version) return 'reviewer_query_changed';
    }
    // The deadline contribution is revalidated as the exact stored bytes (its
    // freshness is owned by the Deadline collaboration ports); re-planning it
    // here would wrongly refuse once the contribution has been applied first
    // inside the committing transaction.
    const rebuilt = plan.action === 'open_round'
      ? planMutation(plan.input, environment, {
          kind: 'injected',
          contribution: plan.deadlineContribution
        })
      : planMutation(plan.input, environment);
    if (canonicalJsonSha256(rebuilt) !== canonicalJsonSha256(plan)) return 'invalid_plan';
    return undefined;
  } catch (error) {
    return error instanceof ReviewPlanningError ? error.code : 'invalid_plan';
  }
}

export function applyReviewMutationPlan(input: {
  readonly plan: ReviewMutationPlanDto;
  readonly transaction: ReviewTransactionRepository;
  readonly sources: ReviewPlanningSource;
}): ReviewMutationResult {
  const refusal = validateReviewMutationPlan(input.plan, {
    repository: input.transaction,
    sources: input.sources
  });
  if (refusal) throw new ReviewPlanningError(refusal);
  const plan = reviewMutationPlanSchema.parse(input.plan);
  if (plan.action === 'open_round') {
    const before = currentCatalog(plan.input.scope, input.transaction);
    const after = appendRoundToCatalog(before, plan.round, plan.catalog);
    input.transaction.applyCatalog({ before, after });
    input.transaction.insertRound(plan.round);
    input.transaction.insertAssignments(plan.assignments);
    return reviewMutationResultSchema.parse({
      action: plan.action,
      round: plan.round,
      assignmentCount: plan.assignments.length
    });
  }
  if (plan.action === 'discard_empty_round') {
    const beforeCatalog = currentCatalog(plan.input.scope, input.transaction);
    const afterCatalog = replaceRoundInCatalog(beforeCatalog, plan.after, plan.catalog);
    input.transaction.applyCatalog({ before: beforeCatalog, after: afterCatalog });
    input.transaction.updateRound({ before: plan.before, after: plan.after });
    return reviewMutationResultSchema.parse({ action: plan.action, round: plan.after });
  }
  if (plan.action === 'step_back') {
    input.transaction.updateAssignment({ before: plan.before, after: plan.after });
    return reviewMutationResultSchema.parse({ action: plan.action, assignment: plan.after });
  }
  if (plan.action === 'commit_review') {
    input.transaction.insertFirstReview({ head: plan.after, revision: plan.revision });
    return reviewMutationResultSchema.parse({
      action: plan.action,
      head: plan.after,
      revision: plan.revision
    });
  }
  input.transaction.appendReviewRevision({
    before: plan.before,
    after: plan.after,
    revision: plan.revision
  });
  return reviewMutationResultSchema.parse({
    action: plan.action,
    head: plan.after,
    revision: plan.revision
  });
}

export function projectReviewSafeDiff(planInput: ReviewMutationPlanDto): ReviewSafeDiff {
  const plan = reviewMutationPlanSchema.parse(planInput);
  if (plan.action === 'open_round') {
    return reviewSafeDiffSchema.parse({
      action: plan.action,
      roundId: plan.round.id,
      roundName: plan.round.name,
      assignmentCount: plan.assignments.length,
      reviewerCount: new Set(plan.assignments.map((assignment) => assignment.reviewerId)).size,
      submissionCount: new Set(plan.assignments.map((assignment) => assignment.submissionId)).size,
      deadlineEffectiveAt: plan.round.deadline.effectiveAt,
      anonymized: plan.round.visibility.participantIdentity === 'hidden',
      criterionLabels: plan.round.criteria.map((criterion) => criterion.label),
      deadline: projectReviewDueDeadlineDiff(plan.deadlineContribution)
    });
  }
  if (plan.action === 'discard_empty_round') {
    return reviewSafeDiffSchema.parse({
      action: plan.action,
      roundId: plan.after.id,
      roundName: plan.after.name
    });
  }
  if (plan.action === 'step_back') {
    return reviewSafeDiffSchema.parse({
      action: plan.action,
      assignmentId: plan.after.id,
      submissionId: plan.after.submissionId
    });
  }
  if (plan.action === 'commit_review') {
    return reviewSafeDiffSchema.parse({
      action: plan.action,
      assignmentId: plan.assignment.id,
      submissionId: plan.assignment.submissionId,
      weightedScore: plan.revision.weightedScore,
      commentPresent: plan.revision.comment.length > 0
    });
  }
  return reviewSafeDiffSchema.parse({
    action: plan.action,
    assignmentId: plan.assignment.id,
    submissionId: plan.assignment.submissionId,
    beforeScore: plan.priorRevision.weightedScore,
    afterScore: plan.revision.weightedScore,
    commentChanged: plan.priorRevision.comment !== plan.revision.comment,
    correctionOfRevisionId: plan.priorRevision.id
  });
}

export function reviewMutationFact(planInput: ReviewMutationPlanDto): {
  readonly kind: string;
  readonly version: 1;
  readonly payload: CanonicalJson;
} {
  const plan = reviewMutationPlanSchema.parse(planInput);
  if (plan.action === 'open_round') return Object.freeze({
    kind: 'review_round_opened', version: 1,
    payload: canonicalJsonValue({ roundId: plan.round.id, assignmentCount: plan.assignments.length })
  });
  if (plan.action === 'discard_empty_round') return Object.freeze({
    kind: 'review_round_discarded', version: 1,
    payload: canonicalJsonValue({ roundId: plan.after.id, version: plan.after.version })
  });
  if (plan.action === 'step_back') return Object.freeze({
    kind: 'review_assignment_stepped_back', version: 1,
    payload: canonicalJsonValue({ assignmentId: plan.after.id, version: plan.after.version })
  });
  return Object.freeze({
    kind: plan.action === 'commit_review' ? 'review_committed' : 'review_amended',
    version: 1,
    payload: canonicalJsonValue({
      assignmentId: plan.assignment.id,
      revisionId: plan.revision.id,
      revisionNumber: plan.revision.revisionNumber,
      reviewVersion: plan.after.version
    })
  });
}

export function saveReviewDraft(input: {
  readonly scope: ReviewScopeDto;
  readonly reviewerId: string;
  readonly attributedByUserId: string;
  readonly attributedAt: string;
  readonly businessInput: ReviewDraftSaveInput;
  readonly transaction: ReviewTransactionRepository;
}): ReviewDraftSaveResult {
  const scope = parseReviewScope(input.scope);
  const business = reviewDraftSaveInputSchema.parse(input.businessInput);
  const assignment = requiredAssignment(scope, business.assignmentId, input.transaction);
  assertAssignedReviewer(assignment, input.reviewerId);
  const round = requiredOpenRound(scope, assignment.roundId, input.transaction);
  if (input.transaction.readReviewHead(scope, assignment.id)) throw new ReviewPlanningError('review_exists');
  const existing = input.transaction.readDraft(scope, assignment.id);
  if (business.expectedDraftVersion === null ? existing !== undefined
    : existing?.version !== business.expectedDraftVersion) {
    throw new ReviewPlanningError('stale_draft');
  }
  const scores = validScores(round, business.scores);
  const draft = parseReviewDraft({
    schemaVersion: 1,
    scope,
    assignmentId: assignment.id,
    version: (existing?.version ?? 0) + 1,
    scores,
    comment: business.comment,
    updatedByReviewerId: input.reviewerId,
    updatedByUserId: input.attributedByUserId,
    updatedAt: input.attributedAt
  });
  input.transaction.saveDraft({ expectedVersion: business.expectedDraftVersion, draft });
  return reviewDraftSaveResultSchema.parse({ draft });
}

/** Pure later-arrival hand-out planner; a later registered consumer owns invocation. */
export function ensureArrivalAssignments(input: {
  readonly scope: ReviewScopeDto;
  readonly roundId: string;
  readonly candidate: ReviewCandidateSnapshotDto;
  readonly assignmentIds: readonly { readonly reviewerId: string; readonly assignmentId: string }[];
  readonly assignedAt: string;
  readonly repository: ReviewRepository;
  readonly sources: ReviewPlanningSource;
}): readonly ReviewAssignmentDto[] {
  const scope = parseReviewScope(input.scope);
  requiredOpenRound(scope, input.roundId, input.repository);
  const roster = input.sources.readReviewerRoster(scope);
  if (!roster) throw new ReviewPlanningError('wrong_scope');
  const candidate = parseReviewCandidate(input.candidate);
  const existing = new Set(input.repository.listAssignments(scope, input.roundId)
    .filter((assignment) => assignment.submissionId === candidate.submissionId)
    .map((assignment) => assignment.reviewerId));
  const expected = roster.reviewers.map(parseReviewRosterMember)
    .filter((reviewer) => reviewerCoversCandidate(reviewer, candidate) && !existing.has(reviewer.reviewerId))
    .sort(compareReviewers);
  const seeds = new Map(input.assignmentIds.map((seed) => [seed.reviewerId, seed.assignmentId]));
  if (seeds.size !== input.assignmentIds.length || seeds.size !== expected.length
      || expected.some((reviewer) => !seeds.has(reviewer.reviewerId))) {
    throw new ReviewPlanningError('assignment_seed_mismatch');
  }
  return Object.freeze(expected.map((reviewer) => parseReviewAssignment({
    schemaVersion: 1,
    scope,
    id: seeds.get(reviewer.reviewerId),
    roundId: input.roundId,
    submissionId: candidate.submissionId,
    reviewerId: reviewer.reviewerId,
    version: 1,
    state: 'assigned',
    assignedAt: input.assignedAt
  })).sort(compareAssignments));
}

function planOpenRound(
  input: Extract<ReviewMutationPlanningInput, { action: 'open_round' }>,
  catalog: ReviewCatalogDto,
  environment: ReviewMutationEnvironment,
  collaboration: OpenRoundDeadlineCollaboration
): ReviewMutationPlanDto {
  if (catalog.version !== input.expectedCatalogVersion) throw new ReviewPlanningError('stale_catalog');
  if (catalog.rounds.some((round) => round.state === 'open')) throw new ReviewPlanningError('open_round_exists');
  const candidateSet = environment.sources.readCandidates(input.scope);
  const rosterSet = environment.sources.readReviewerRoster(input.scope);
  if (!candidateSet || !rosterSet) throw new ReviewPlanningError('wrong_scope');
  const contribution = collaboration.kind === 'collaborate'
    ? planReviewDueDeadlineChangeFrom(collaboration.deadlines, {
        scope: input.scope,
        currentDeadlineId: null,
        dueOn: input.deadlineDate,
        identity: { deadlineId: input.deadlineIdentity.deadlineId },
        attribution: { userId: input.attributedByUserId, at: input.attributedAt }
      })
    : collaboration.contribution;
  assertOpenRoundDeadlineContribution(input, contribution);
  const pin = reviewDueDeadlinePin(contribution);
  if (pin === null) throw new ReviewPlanningError('invalid_plan');
  const candidates = [...candidateSet.candidates].map(parseReviewCandidate).sort(compareCandidates);
  const reviewers = [...rosterSet.reviewers].map(parseReviewRosterMember).sort(compareReviewers);
  const expected = expectedReviewAssignmentPairs({ candidates, reviewers });
  if (expected.length === 0) throw new ReviewPlanningError('no_assignments');
  const seeds = assignmentSeedMap(input.assignmentIds);
  if (seeds.size !== expected.length || expected.some((pair) => !seeds.has(pairKey(pair)))) {
    throw new ReviewPlanningError('assignment_seed_mismatch');
  }
  const ordinal = (catalog.rounds.at(-1)?.ordinal ?? 0) + 1;
  const round = parseReviewRound({
    schemaVersion: 1,
    scope: input.scope,
    id: input.roundId,
    ordinal,
    name: `Round ${ordinal}`,
    state: 'open',
    version: 1,
    deadline: parseReviewDeadlinePin(reviewDeadlinePinFromReference(pin)),
    criteria: input.criteria,
    visibility: input.visibility,
    openedByUserId: input.attributedByUserId,
    openedAt: input.attributedAt
  });
  const assignments = expected.map((pair) => parseReviewAssignment({
    schemaVersion: 1,
    scope: input.scope,
    id: seeds.get(pairKey(pair)),
    roundId: round.id,
    submissionId: pair.submissionId,
    reviewerId: pair.reviewerId,
    version: 1,
    state: 'assigned',
    assignedAt: input.attributedAt
  })).sort(compareAssignments);
  const nextVersion = catalog.version + 1;
  const rounds = Object.freeze([...catalog.rounds, round]);
  return reviewMutationPlanSchema.parse({
    action: input.action,
    input,
    catalog: {
      beforeVersion: catalog.version,
      beforeDigestSha256: catalog.digestSha256,
      afterVersion: nextVersion,
      afterDigestSha256: reviewCatalogDigest({ scope: input.scope, version: nextVersion, rounds })
    },
    round,
    assignments,
    candidateGuard: {
      id: reviewCandidateQueryGuardId(input.scope.eventId),
      version: candidateSet.version,
      digestSha256: reviewCandidateSetDigest(candidates)
    },
    reviewerGuard: {
      id: reviewReviewerQueryGuardId(input.scope.eventId),
      version: rosterSet.version,
      digestSha256: reviewRosterSetDigest(reviewers)
    },
    deadlineContribution: contribution
  });
}

/**
 * The embedded contribution must be exactly the server-authored `review_due`
 * creation for this round-open intent; anything else is a forged or drifted
 * plan, never a data race.
 */
function assertOpenRoundDeadlineContribution(
  input: Extract<ReviewMutationPlanningInput, { action: 'open_round' }>,
  contribution: ReviewDueDeadlineContribution
): void {
  if (contribution.input.action !== 'create') throw new ReviewPlanningError('invalid_plan');
  const creation = contribution.input;
  if (creation.scope.workspaceId !== input.scope.workspaceId
      || creation.scope.eventId !== input.scope.eventId
      || creation.deadlineId !== input.deadlineIdentity.deadlineId
      || creation.kind !== 'review_due'
      || creation.displayDate !== input.deadlineDate
      || creation.attributedByUserId !== input.attributedByUserId
      || creation.attributedAt !== input.attributedAt
      || contribution.before !== null
      || contribution.after.status !== 'active'
      || contribution.after.kind !== 'review_due') {
    throw new ReviewPlanningError('invalid_plan');
  }
}

function planDiscardRound(
  input: Extract<ReviewMutationPlanningInput, { action: 'discard_empty_round' }>,
  catalog: ReviewCatalogDto,
  repository: ReviewRepository
): ReviewMutationPlanDto {
  const before = requiredRound(input.scope, input.roundId, repository);
  if (before.version !== input.expectedRoundVersion) throw new ReviewPlanningError('stale_round');
  if (before.state !== 'open') throw new ReviewPlanningError('round_not_open');
  for (const assignment of repository.listAssignments(input.scope, before.id)) {
    if (repository.readDraft(input.scope, assignment.id)
        || repository.readReviewHead(input.scope, assignment.id)) {
      throw new ReviewPlanningError('round_has_work');
    }
  }
  const after = parseReviewRound({
    ...before,
    state: 'discarded',
    version: before.version + 1,
    discardedByUserId: input.attributedByUserId,
    discardedAt: input.attributedAt
  });
  const nextVersion = catalog.version + 1;
  const rounds = catalog.rounds.map((round) => round.id === after.id ? after : round);
  return reviewMutationPlanSchema.parse({
    action: input.action,
    input,
    before,
    after,
    catalog: {
      beforeVersion: catalog.version,
      beforeDigestSha256: catalog.digestSha256,
      afterVersion: nextVersion,
      afterDigestSha256: reviewCatalogDigest({ scope: input.scope, version: nextVersion, rounds })
    }
  });
}

function planStepBack(
  input: Extract<ReviewMutationPlanningInput, { action: 'step_back' }>,
  repository: ReviewRepository
): ReviewMutationPlanDto {
  const before = requiredAssignment(input.scope, input.assignmentId, repository);
  if (before.version !== input.expectedAssignmentVersion) throw new ReviewPlanningError('stale_assignment');
  assertAssignedReviewer(before, input.reviewerId);
  requiredOpenRound(input.scope, before.roundId, repository);
  if (repository.readReviewHead(input.scope, before.id)) throw new ReviewPlanningError('review_exists');
  const after = parseReviewAssignment({
    ...before,
    state: 'stepped_back',
    version: before.version + 1,
    steppedBackAt: input.attributedAt,
    steppedBackByUserId: input.attributedByUserId
  });
  return reviewMutationPlanSchema.parse({ action: input.action, input, before, after });
}

function planCommitReview(
  input: Extract<ReviewMutationPlanningInput, { action: 'commit_review' }>,
  repository: ReviewRepository
): ReviewMutationPlanDto {
  const assignment = requiredAssignment(input.scope, input.assignmentId, repository);
  if (assignment.version !== input.expectedAssignmentVersion) throw new ReviewPlanningError('stale_assignment');
  assertAssignedReviewer(assignment, input.reviewerId);
  const round = requiredOpenRound(input.scope, assignment.roundId, repository);
  if (repository.readReviewHead(input.scope, assignment.id)) throw new ReviewPlanningError('review_exists');
  const draft = repository.readDraft(input.scope, assignment.id);
  if (!draft) throw new ReviewPlanningError('draft_missing');
  if (draft.version !== input.expectedDraftVersion) throw new ReviewPlanningError('stale_draft');
  const scores = validScores(round, draft.scores);
  const revision = parseReviewRevision({
    schemaVersion: 1,
    scope: input.scope,
    id: input.revisionId,
    assignmentId: assignment.id,
    revisionNumber: 1,
    scores,
    weightedScore: weightedReviewScore(round, scores),
    comment: draft.comment,
    committedByReviewerId: input.reviewerId,
    committedByUserId: input.attributedByUserId,
    committedAt: input.attributedAt,
    postUnlock: false
  });
  const after = parseReviewHead({
    schemaVersion: 1,
    scope: input.scope,
    assignmentId: assignment.id,
    version: 1,
    currentRevisionId: revision.id,
    firstCommittedAt: input.attributedAt,
    peerUnlockedAt: input.attributedAt
  });
  return reviewMutationPlanSchema.parse({
    action: input.action,
    input,
    assignment,
    draft,
    before: null,
    after,
    revision
  });
}

function planAmendReview(
  input: Extract<ReviewMutationPlanningInput, { action: 'amend_review' }>,
  repository: ReviewRepository
): ReviewMutationPlanDto {
  const assignment = requiredAssignment(input.scope, input.assignmentId, repository);
  if (assignment.version !== input.expectedAssignmentVersion) throw new ReviewPlanningError('stale_assignment');
  assertAssignedReviewer(assignment, input.reviewerId);
  const round = requiredOpenRound(input.scope, assignment.roundId, repository);
  const before = repository.readReviewHead(input.scope, assignment.id);
  if (!before) throw new ReviewPlanningError('review_missing');
  if (before.version !== input.expectedReviewVersion
      || before.currentRevisionId !== input.expectedCurrentRevisionId) {
    throw new ReviewPlanningError('stale_review');
  }
  const priorRevision = repository.readRevision(input.scope, before.currentRevisionId);
  if (!priorRevision || priorRevision.assignmentId !== assignment.id) {
    throw new ReviewPlanningError('revision_missing');
  }
  const scores = validScores(round, input.scores);
  const revision = parseReviewRevision({
    schemaVersion: 1,
    scope: input.scope,
    id: input.revisionId,
    assignmentId: assignment.id,
    revisionNumber: priorRevision.revisionNumber + 1,
    scores,
    weightedScore: weightedReviewScore(round, scores),
    comment: input.comment,
    committedByReviewerId: input.reviewerId,
    committedByUserId: input.attributedByUserId,
    committedAt: input.attributedAt,
    postUnlock: true,
    correctionOfRevisionId: priorRevision.id
  });
  const after = parseReviewHead({
    ...before,
    version: before.version + 1,
    currentRevisionId: revision.id
  });
  return reviewMutationPlanSchema.parse({
    action: input.action,
    input,
    assignment,
    before,
    after,
    priorRevision,
    revision
  });
}

export function weightedReviewScore(
  round: ReviewRoundDto,
  scoresInput: readonly ReviewCriterionScoreDto[]
): number {
  const scores = validScores(round, scoresInput);
  const values = new Map(scores.map((score) => [score.criterionId, score.score]));
  const weighted = round.criteria.reduce((sum, criterion) => {
    return sum + (values.get(criterion.id)! * criterion.weightBps);
  }, 0) / 10_000;
  return Math.round(weighted * 100) / 100;
}

function validScores(
  round: ReviewRoundDto,
  scoresInput: readonly ReviewCriterionScoreDto[]
): readonly ReviewCriterionScoreDto[] {
  const scores = [...scoresInput].sort((left, right) =>
    left.criterionId < right.criterionId ? -1 : left.criterionId > right.criterionId ? 1 : 0
  );
  const expected = [...round.criteria].map((criterion) => criterion.id).sort();
  if (scores.length !== expected.length
      || scores.some((score, index) => score.criterionId !== expected[index])) {
    throw new ReviewPlanningError('invalid_scores');
  }
  return Object.freeze(scores);
}

function currentCatalog(scope: ReviewScopeDto, repository: ReviewRepository): ReviewCatalogDto {
  const catalog = repository.readCatalog(scope);
  if (!catalog || !sameReviewScope(catalog.scope, scope)) throw new ReviewPlanningError('wrong_scope');
  return parseReviewCatalog(catalog);
}

function requiredRound(scope: ReviewScopeDto, roundId: string, repository: ReviewRepository): ReviewRoundDto {
  const round = repository.readRound(scope, roundId);
  if (!round || !sameReviewScope(round.scope, scope)) throw new ReviewPlanningError('round_missing');
  return parseReviewRound(round);
}

function requiredOpenRound(scope: ReviewScopeDto, roundId: string, repository: ReviewRepository): ReviewRoundDto {
  const round = requiredRound(scope, roundId, repository);
  if (round.state !== 'open') throw new ReviewPlanningError('round_not_open');
  return round;
}

function requiredAssignment(
  scope: ReviewScopeDto,
  assignmentId: string,
  repository: ReviewRepository
): ReviewAssignmentDto {
  const assignment = repository.readAssignment(scope, assignmentId);
  if (!assignment || !sameReviewScope(assignment.scope, scope)) {
    throw new ReviewPlanningError('assignment_missing');
  }
  return parseReviewAssignment(assignment);
}

function assertAssignedReviewer(assignment: ReviewAssignmentDto, reviewerId: string): void {
  if (assignment.reviewerId !== reviewerId) throw new ReviewPlanningError('not_assigned_reviewer');
  if (assignment.state !== 'assigned') throw new ReviewPlanningError('assignment_not_active');
}

function assignmentSeedMap(
  seeds: readonly { assignmentId: string; reviewerId: string; submissionId: string }[]
): Map<string, string> {
  const result = new Map<string, string>();
  const ids = new Set<string>();
  for (const seed of seeds) {
    const key = pairKey(seed);
    if (result.has(key) || ids.has(seed.assignmentId)) throw new ReviewPlanningError('assignment_seed_mismatch');
    result.set(key, seed.assignmentId);
    ids.add(seed.assignmentId);
  }
  return result;
}

function pairKey(pair: { readonly reviewerId: string; readonly submissionId: string }): string {
  return `${pair.reviewerId}:${pair.submissionId}`;
}

function appendRoundToCatalog(
  before: ReviewCatalogDto,
  round: ReviewRoundDto,
  versions: Extract<ReviewMutationPlanDto, { action: 'open_round' }>['catalog']
): ReviewCatalogDto {
  if (before.version !== versions.beforeVersion || before.digestSha256 !== versions.beforeDigestSha256) {
    throw new ReviewPlanningError('stale_catalog');
  }
  return parseReviewCatalog({
    schemaVersion: 1,
    scope: before.scope,
    version: versions.afterVersion,
    digestSha256: versions.afterDigestSha256,
    rounds: [...before.rounds, round]
  });
}

function replaceRoundInCatalog(
  before: ReviewCatalogDto,
  round: ReviewRoundDto,
  versions: Extract<ReviewMutationPlanDto, { action: 'discard_empty_round' }>['catalog']
): ReviewCatalogDto {
  if (before.version !== versions.beforeVersion || before.digestSha256 !== versions.beforeDigestSha256) {
    throw new ReviewPlanningError('stale_catalog');
  }
  return parseReviewCatalog({
    schemaVersion: 1,
    scope: before.scope,
    version: versions.afterVersion,
    digestSha256: versions.afterDigestSha256,
    rounds: before.rounds.map((candidate) => candidate.id === round.id ? round : candidate)
  });
}
