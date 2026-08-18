import { describe, expect, test } from 'bun:test';
import type {
  ReviewAssignmentDto,
  ReviewCandidateDisplayDto,
  ReviewCandidateSnapshotDto,
  ReviewCatalogDto,
  ReviewDeadlinePinDto,
  ReviewDraftDto,
  ReviewHeadDto,
  ReviewRevisionDto,
  ReviewRosterMemberSnapshotDto,
  ReviewRoundDto,
  ReviewScopeDto,
  ReviewVacancyResolutionDto
} from '@jooevents/contracts/reviews';
import {
  applyReviewMutationPlan,
  createDefaultReviewCriteria,
  createEmptyReviewCatalog,
  expectedReviewAssignmentPairs,
  planReviewMutation,
  projectReviewSafeDiff,
  reviewCandidateSetDigest,
  reviewRosterSetDigest,
  saveReviewDraft,
  validateReviewMutationPlan
} from './domain';
import type {
  ReviewCandidateSet,
  ReviewCandidateDisplaySource,
  ReviewPlanningSource,
  ReviewRosterSet,
  ReviewTransactionRepository
} from './model';
import { projectReviewSnapshot } from './projections';
import { parseApplicationId } from '@jooevents/kernel';
import {
  createEmptyDeadlineCatalog,
  type DeadlineEventTimeSource,
  type DeadlineRepository
} from '@jooevents/deadline';
import type {
  DeadlineCatalogSnapshotDto,
  DeadlineHeadDto,
  DeadlineScopeDto
} from '@jooevents/contracts/deadlines';

const id = (suffix: number) => parseApplicationId(
  'event',
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
);
const at = (hour: number) => `2026-08-13T${hour.toString().padStart(2, '0')}:00:00.000Z`;
const scope: ReviewScopeDto = { workspaceId: id(1), eventId: id(2) };
const actorUserId = id(3);
const roundId = id(4);
const deadlineId = id(5);
const trackId = id(6);
const criterionQuality = id(7);
const criterionFit = id(8);
const candidateA = id(10);
const candidateB = id(11);
const reviewerGeneralist = id(20);
const reviewerTrack = id(21);
const reviewerInvited = id(22);

const candidates: readonly ReviewCandidateSnapshotDto[] = Object.freeze([
  { submissionId: candidateA, version: 1, trackId },
  { submissionId: candidateB, version: 2 }
]);
const reviewers: readonly ReviewRosterMemberSnapshotDto[] = Object.freeze([
  { reviewerId: reviewerGeneralist, version: 1, status: 'active', displayName: 'Generalist', scope: [] },
  { reviewerId: reviewerTrack, version: 1, status: 'active', displayName: 'Track reviewer', scope: [{ kind: 'track', id: trackId }] },
  { reviewerId: reviewerInvited, version: 1, status: 'invited', scope: [] }
]);
const deadlineDate = '2026-08-30';

/** In-memory Deadline collaborator: an empty catalog plus a stable event time basis. */
class MemoryDeadlineCollaborator implements DeadlineRepository, DeadlineEventTimeSource {
  catalog: DeadlineCatalogSnapshotDto = createEmptyDeadlineCatalog(scope);
  readDeadlineCatalog(requested: DeadlineScopeDto): DeadlineCatalogSnapshotDto | undefined {
    return sameScope(requested) ? this.catalog : undefined;
  }
  readDeadline(requested: DeadlineScopeDto, idValue: string): DeadlineHeadDto | undefined {
    return sameScope(requested)
      ? this.catalog.deadlines.find((head) => head.id === idValue)
      : undefined;
  }
  readDeadlineEventTimeBasis(requested: DeadlineScopeDto) {
    return sameScope(requested) ? { timezone: 'UTC', eventVersion: 1 } : undefined;
  }
}
const criteria = [
  { id: criterionQuality, key: 'quality', label: 'Quality', position: 0, weightBps: 6_000, scaleMin: 1 as const, scaleMax: 5 as const },
  { id: criterionFit, key: 'fit', label: 'Fit', position: 1, weightBps: 4_000, scaleMin: 1 as const, scaleMax: 5 as const }
];

class MemoryReviewStore implements
  ReviewTransactionRepository,
  ReviewPlanningSource,
  ReviewCandidateDisplaySource {
  catalog: ReviewCatalogDto = createEmptyReviewCatalog(scope);
  candidateSet: ReviewCandidateSet = { version: 3, candidates };
  rosterSet: ReviewRosterSet = { version: 2, reviewers };
  deadline: ReviewDeadlinePinDto | undefined;
  readonly rounds = new Map<string, ReviewRoundDto>();
  readonly assignments = new Map<string, ReviewAssignmentDto>();
  readonly drafts = new Map<string, ReviewDraftDto>();
  readonly heads = new Map<string, ReviewHeadDto>();
  readonly revisions = new Map<string, ReviewRevisionDto>();
  readonly vacancyResolutions = new Map<string, ReviewVacancyResolutionDto>();

  readCatalog(requested: ReviewScopeDto) { return sameScope(requested) ? this.catalog : undefined; }
  readRound(requested: ReviewScopeDto, idValue: string) { return sameScope(requested) ? this.rounds.get(idValue) : undefined; }
  listAssignments(requested: ReviewScopeDto, requestedRoundId: string) {
    return sameScope(requested)
      ? [...this.assignments.values()].filter((value) => value.roundId === requestedRoundId)
      : [];
  }
  readAssignment(requested: ReviewScopeDto, idValue: string) { return sameScope(requested) ? this.assignments.get(idValue) : undefined; }
  readVacancyResolution(requested: ReviewScopeDto, assignmentId: string) {
    return sameScope(requested) ? this.vacancyResolutions.get(assignmentId) : undefined;
  }
  readDraft(requested: ReviewScopeDto, assignmentId: string) { return sameScope(requested) ? this.drafts.get(assignmentId) : undefined; }
  readReviewHead(requested: ReviewScopeDto, assignmentId: string) { return sameScope(requested) ? this.heads.get(assignmentId) : undefined; }
  readRevision(requested: ReviewScopeDto, revisionId: string) { return sameScope(requested) ? this.revisions.get(revisionId) : undefined; }
  listRevisions(requested: ReviewScopeDto, assignmentId: string) {
    return sameScope(requested)
      ? [...this.revisions.values()].filter((value) => value.assignmentId === assignmentId)
      : [];
  }
  readCandidates(requested: ReviewScopeDto) { return sameScope(requested) ? this.candidateSet : undefined; }
  readCandidate(requested: ReviewScopeDto, submissionId: string) {
    return sameScope(requested)
      ? this.candidateSet.candidates.find((value) => value.submissionId === submissionId)
      : undefined;
  }
  readReviewerRoster(requested: ReviewScopeDto) { return sameScope(requested) ? this.rosterSet : undefined; }
  resolveReviewDeadline(requested: ReviewScopeDto, requestedDeadlineId: string) {
    return sameScope(requested) && this.deadline?.deadlineId === requestedDeadlineId
      ? this.deadline
      : undefined;
  }
  readReviewCandidateDisplay(input: Parameters<ReviewCandidateDisplaySource['readReviewCandidateDisplay']>[0]): ReviewCandidateDisplayDto | undefined {
    if (!sameScope(input.scope)) return undefined;
    const candidate = candidates.find((value) => value.submissionId === input.submissionId);
    if (!candidate) return undefined;
    return {
      submissionId: candidate.submissionId,
      version: candidate.version,
      title: candidate.submissionId === candidateA ? 'Typed systems in practice' : 'A second proposal',
      abstract: 'A source-backed abstract that the authorized Review projection may expose.',
      submittedAt: at(0),
      ...(candidate.trackId === undefined ? {} : { trackId: candidate.trackId }),
      ...(candidate.formatId === undefined ? {} : { formatId: candidate.formatId }),
      ...(candidate.targetSessionId === undefined ? {} : { targetSessionId: candidate.targetSessionId }),
      resources: [{
        resourceId: id(300), name: 'Slides', kind: 'slides', detail: 'PDF, 2 MB'
      }],
      // The projector still withholds this if the round is blind.
      speakers: [{ speakerId: id(301), displayName: 'Ada Reviewer' }]
    };
  }
  applyCatalog(input: { before: ReviewCatalogDto; after: ReviewCatalogDto }) {
    expect(this.catalog.version).toBe(input.before.version);
    this.catalog = input.after;
  }
  insertRound(round: ReviewRoundDto) { this.rounds.set(round.id, round); }
  updateRound(input: { before: ReviewRoundDto; after: ReviewRoundDto }) {
    expect(this.rounds.get(input.before.id)?.version).toBe(input.before.version);
    this.rounds.set(input.after.id, input.after);
  }
  insertAssignments(values: readonly ReviewAssignmentDto[]) {
    for (const value of values) this.assignments.set(value.id, value);
  }
  updateAssignment(input: { before: ReviewAssignmentDto; after: ReviewAssignmentDto }) {
    expect(this.assignments.get(input.before.id)?.version).toBe(input.before.version);
    this.assignments.set(input.after.id, input.after);
  }
  resolveVacancy(input: {
    resolution: ReviewVacancyResolutionDto;
    replacement?: ReviewAssignmentDto;
  }) {
    expect(this.vacancyResolutions.has(input.resolution.vacatedAssignmentId)).toBe(false);
    if (input.replacement) this.assignments.set(input.replacement.id, input.replacement);
    this.vacancyResolutions.set(input.resolution.vacatedAssignmentId, input.resolution);
  }
  saveDraft(input: { expectedVersion: number | null; draft: ReviewDraftDto }) {
    expect(this.drafts.get(input.draft.assignmentId)?.version ?? null).toBe(input.expectedVersion);
    this.drafts.set(input.draft.assignmentId, input.draft);
  }
  insertFirstReview(input: { head: ReviewHeadDto; revision: ReviewRevisionDto }) {
    expect(this.heads.has(input.head.assignmentId)).toBe(false);
    this.revisions.set(input.revision.id, input.revision);
    this.heads.set(input.head.assignmentId, input.head);
  }
  appendReviewRevision(input: { before: ReviewHeadDto; after: ReviewHeadDto; revision: ReviewRevisionDto }) {
    expect(this.heads.get(input.before.assignmentId)?.version).toBe(input.before.version);
    this.revisions.set(input.revision.id, input.revision);
    this.heads.set(input.after.assignmentId, input.after);
  }
}

function sameScope(value: { readonly workspaceId: string; readonly eventId: string }) {
  return value.workspaceId === scope.workspaceId && value.eventId === scope.eventId;
}

function openRound(
  store: MemoryReviewStore,
  deadlines: MemoryDeadlineCollaborator = new MemoryDeadlineCollaborator()
) {
  const pairs = expectedReviewAssignmentPairs({ candidates, reviewers });
  const plan = planReviewMutation({
    action: 'open_round',
    scope,
    expectedCatalogVersion: 1,
    roundId,
    deadlineIdentity: { deadlineId },
    deadlineDate,
    criteria,
    visibility: {
      participantIdentity: 'hidden',
      peerReviewerIdentity: 'hidden',
      peerContentUnlock: 'after_own_commit'
    },
    assignmentIds: pairs.map((pair, index) => ({
      ...pair,
      assignmentId: id(100 + index)
    })),
    attributedByUserId: actorUserId,
    attributedAt: at(1)
  }, { repository: store, sources: store, deadlines });
  if (plan.action !== 'open_round') throw new TypeError('test_open_round_plan_invalid');
  applyReviewMutationPlan({ plan, transaction: store, sources: store });
  return plan;
}

function assignmentFor(store: MemoryReviewStore, reviewerId: string, submissionId: string) {
  const assignment = [...store.assignments.values()].find((candidate) =>
    candidate.reviewerId === reviewerId && candidate.submissionId === submissionId
  );
  if (!assignment) throw new TypeError('test_assignment_missing');
  return assignment;
}

function saveDraft(store: MemoryReviewStore, assignment: ReviewAssignmentDto, reviewerId: string, scoreA: number, scoreB: number, hour: number) {
  return saveReviewDraft({
    scope,
    reviewerId,
    attributedByUserId: actorUserId,
    attributedAt: at(hour),
    businessInput: {
      assignmentId: assignment.id,
      expectedDraftVersion: null,
      scores: [
        { criterionId: criterionQuality, score: scoreA },
        { criterionId: criterionFit, score: scoreB }
      ],
      comment: `Review at ${hour}`
    },
    transaction: store
  }).draft;
}

describe('review core', () => {
  test('provides the fixed one-axis default without inventing criteria in the UI', () => {
    expect(createDefaultReviewCriteria(id(90))).toEqual([{
      id: id(90), key: 'overall', label: 'Overall', position: 0,
      weightBps: 10_000, scaleMin: 1, scaleMax: 5
    }]);
  });

  test('freezes round criteria, source guards, scoped assignments, and a safe diff', () => {
    const store = new MemoryReviewStore();
    const pairs = expectedReviewAssignmentPairs({ candidates, reviewers });
    expect(pairs).toEqual([
      { reviewerId: reviewerGeneralist, submissionId: candidateA },
      { reviewerId: reviewerGeneralist, submissionId: candidateB },
      { reviewerId: reviewerTrack, submissionId: candidateA }
    ]);
    const plan = openRound(store);
    expect(plan.candidateGuard.digestSha256).toBe(reviewCandidateSetDigest(candidates));
    expect(plan.reviewerGuard.digestSha256).toBe(reviewRosterSetDigest(reviewers));
    expect(plan.deadlineContribution).toMatchObject({
      input: { action: 'create', deadlineId, kind: 'review_due', displayDate: deadlineDate },
      before: null,
      after: { id: deadlineId, kind: 'review_due', status: 'active', version: 1 }
    });
    expect(plan.round.deadline).toMatchObject({
      deadlineId, kind: 'review_due', version: 1,
      effectiveAt: '2026-08-31T00:00:00.000Z'
    });
    expect(projectReviewSafeDiff(plan)).toMatchObject({
      action: 'open_round', assignmentCount: 3, reviewerCount: 2, submissionCount: 2,
      anonymized: true,
      deadline: { action: 'create', before: null, after: { id: deadlineId, status: 'active' } }
    });
    expect(store.catalog.version).toBe(2);
    expect(store.assignments.size).toBe(3);
  });

  test('detects source drift between draft and commit validation', () => {
    const store = new MemoryReviewStore();
    const pairs = expectedReviewAssignmentPairs({ candidates, reviewers });
    const plan = planReviewMutation({
      action: 'open_round', scope, expectedCatalogVersion: 1, roundId,
      deadlineIdentity: { deadlineId }, deadlineDate, criteria,
      visibility: { participantIdentity: 'hidden', peerReviewerIdentity: 'hidden', peerContentUnlock: 'after_own_commit' },
      assignmentIds: pairs.map((pair, index) => ({ ...pair, assignmentId: id(120 + index) })),
      attributedByUserId: actorUserId, attributedAt: at(1)
    }, { repository: store, sources: store, deadlines: new MemoryDeadlineCollaborator() });
    store.candidateSet = { version: 4, candidates };
    expect(validateReviewMutationPlan(plan, { repository: store, sources: store }))
      .toBe('candidate_query_changed');
  });

  test('keeps peer scores locked until own commit and appends forward corrections', () => {
    const store = new MemoryReviewStore();
    openRound(store);
    const generalist = assignmentFor(store, reviewerGeneralist, candidateA);
    const track = assignmentFor(store, reviewerTrack, candidateA);
    const generalistDraft = saveDraft(store, generalist, reviewerGeneralist, 5, 4, 2);
    const generalistCommit = planReviewMutation({
      action: 'commit_review', scope, assignmentId: generalist.id,
      expectedAssignmentVersion: generalist.version,
      expectedDraftVersion: generalistDraft.version,
      revisionId: id(200), reviewerId: reviewerGeneralist,
      attributedByUserId: actorUserId, attributedAt: at(3)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: generalistCommit, transaction: store, sources: store });

    const locked = projectReviewSnapshot({
      scope, viewer: { kind: 'reviewer', reviewerId: reviewerTrack },
      standingSubmissionIds: [candidateA],
      environment: { repository: store, sources: store, candidateDisplay: store }
    });
    expect(locked.queue?.find((item) => item.assignmentId === track.id)?.peerScores).toBeUndefined();
    expect(locked.queue?.find((item) => item.assignmentId === track.id)?.candidate.speakers)
      .toBeUndefined();
    expect(locked.plans[0]?.reviewers).toEqual([{
      reviewerId: reviewerTrack,
      displayName: 'Track reviewer',
      assigned: 1,
      done: 0,
      steppedBack: 0,
      awaitingReassignment: 0
    }]);
    // The plan serves the round's own version and its canonical criterion
    // identities verbatim — the read side never invents or renumbers them.
    expect(locked.plans[0]?.version).toBe(store.rounds.get(roundId)!.version);
    expect(locked.plans[0]?.criteria).toEqual(store.rounds.get(roundId)!.criteria);
    expect(locked.standings[candidateA]).toBeUndefined();

    const trackDraft = saveDraft(store, track, reviewerTrack, 3, 4, 4);
    const trackCommit = planReviewMutation({
      action: 'commit_review', scope, assignmentId: track.id,
      expectedAssignmentVersion: track.version,
      expectedDraftVersion: trackDraft.version,
      revisionId: id(201), reviewerId: reviewerTrack,
      attributedByUserId: actorUserId, attributedAt: at(5)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: trackCommit, transaction: store, sources: store });

    const unlocked = projectReviewSnapshot({
      scope, viewer: { kind: 'reviewer', reviewerId: reviewerTrack },
      standingSubmissionIds: [candidateA],
      environment: { repository: store, sources: store, candidateDisplay: store }
    });
    expect(unlocked.queue?.find((item) => item.assignmentId === track.id)?.peerScores).toEqual([4.6]);
    expect(unlocked.queue?.find((item) => item.assignmentId === track.id)?.draft).toBeUndefined();
    expect(unlocked.standings[candidateA]?.band).toBe('few');

    const amend = planReviewMutation({
      action: 'amend_review', scope, assignmentId: track.id,
      expectedAssignmentVersion: track.version,
      expectedReviewVersion: 1,
      expectedCurrentRevisionId: id(201),
      revisionId: id(202), reviewerId: reviewerTrack,
      scores: [
        { criterionId: criterionQuality, score: 4 },
        { criterionId: criterionFit, score: 4 }
      ],
      comment: 'Corrected after unlocking peer content.',
      attributedByUserId: actorUserId, attributedAt: at(6)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: amend, transaction: store, sources: store });
    expect(store.heads.get(track.id)).toMatchObject({ version: 2, currentRevisionId: id(202) });
    expect(store.revisions.get(id(202))).toMatchObject({
      revisionNumber: 2,
      postUnlock: true,
      correctionOfRevisionId: id(201)
    });
    expect(store.revisions.get(id(201))).toBeDefined();
  });

  test('keeps a draft when its owner steps back and refuses destructive round discard', () => {
    const store = new MemoryReviewStore();
    openRound(store);
    const assignment = assignmentFor(store, reviewerGeneralist, candidateB);
    const draft = saveDraft(store, assignment, reviewerGeneralist, 2, 3, 2);
    const stepBack = planReviewMutation({
      action: 'step_back', scope, assignmentId: assignment.id,
      expectedAssignmentVersion: assignment.version,
      reviewerId: reviewerGeneralist,
      attributedByUserId: actorUserId, attributedAt: at(3)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: stepBack, transaction: store, sources: store });
    expect(store.drafts.get(assignment.id)).toEqual(draft);
    const organizer = projectReviewSnapshot({
      scope, viewer: { kind: 'organizer' },
      environment: { repository: store, sources: store, candidateDisplay: store }
    });
    expect(organizer.plans[0]?.reviewers.find((row) =>
      row.reviewerId === reviewerGeneralist
    )?.uncovered).toMatchObject([{
      assignmentId: assignment.id,
      assignmentVersion: 2,
      roundId,
      submissionId: candidateB,
      title: 'A second proposal',
      remainingReviewers: 0,
      replacementCandidates: [{
        reviewerId: reviewerTrack,
        displayName: 'Track reviewer',
        assigned: 1,
        scopeMatch: false,
        conflict: 'Outside this reviewer’s current scope'
      }]
    }]);
    const reviewer = projectReviewSnapshot({
      scope, viewer: { kind: 'reviewer', reviewerId: reviewerGeneralist },
      environment: { repository: store, sources: store, candidateDisplay: store }
    });
    expect(reviewer.plans[0]?.reviewers[0]).toMatchObject({
      reviewerId: reviewerGeneralist,
      steppedBack: 1,
      awaitingReassignment: 1
    });
    expect(reviewer.plans[0]?.reviewers[0]).not.toHaveProperty('uncovered');
    expect(() => planReviewMutation({
      action: 'discard_empty_round', scope, roundId, expectedRoundVersion: 1,
      attributedByUserId: actorUserId, attributedAt: at(4)
    }, { repository: store, sources: store })).toThrow('round_has_work');
  });

  test('resolves one stepped-back slot by replacement without changing the round denominator', () => {
    const store = new MemoryReviewStore();
    openRound(store);
    const vacancy = assignmentFor(store, reviewerGeneralist, candidateB);
    const stepped = planReviewMutation({
      action: 'step_back', scope, assignmentId: vacancy.id,
      expectedAssignmentVersion: vacancy.version, reviewerId: reviewerGeneralist,
      attributedByUserId: actorUserId, attributedAt: at(2)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: stepped, transaction: store, sources: store });

    const replacementReviewerId = id(23);
    store.rosterSet = {
      version: 3,
      reviewers: [...reviewers, {
        reviewerId: replacementReviewerId,
        version: 1,
        status: 'active',
        displayName: 'Low load reviewer',
        scope: []
      }]
    };
    const replacement = planReviewMutation({
      action: 'assign_replacement', scope, assignmentId: vacancy.id,
      expectedAssignmentVersion: 2,
      replacementAssignmentId: id(250),
      replacementReviewerId,
      attributedByUserId: actorUserId,
      attributedAt: at(3)
    }, { repository: store, sources: store });
    expect(projectReviewSafeDiff(replacement)).toEqual({
      action: 'assign_replacement',
      assignmentId: vacancy.id,
      submissionId: candidateB,
      replacementReviewerId
    });
    applyReviewMutationPlan({ plan: replacement, transaction: store, sources: store });

    const snapshot = projectReviewSnapshot({
      scope, viewer: { kind: 'organizer' },
      environment: { repository: store, sources: store, candidateDisplay: store }
    });
    expect(snapshot.plans[0]).toMatchObject({ done: 0, total: 3 });
    expect(snapshot.plans[0]?.reviewers.find((row) => row.reviewerId === reviewerGeneralist))
      .toMatchObject({ assigned: 1, steppedBack: 1, awaitingReassignment: 0 });
    expect(snapshot.plans[0]?.reviewers.find((row) => row.reviewerId === replacementReviewerId))
      .toMatchObject({ assigned: 1, steppedBack: 0, awaitingReassignment: 0 });
    expect(() => planReviewMutation({
      action: 'accept_coverage', scope, assignmentId: vacancy.id,
      expectedAssignmentVersion: 2,
      attributedByUserId: actorUserId,
      attributedAt: at(4)
    }, { repository: store, sources: store })).toThrow('vacancy_resolved');
  });

  test('accepts thin coverage as an explicit retained act and retires only that slot', () => {
    const store = new MemoryReviewStore();
    openRound(store);
    const vacancy = assignmentFor(store, reviewerTrack, candidateA);
    const stepped = planReviewMutation({
      action: 'step_back', scope, assignmentId: vacancy.id,
      expectedAssignmentVersion: vacancy.version, reviewerId: reviewerTrack,
      attributedByUserId: actorUserId, attributedAt: at(2)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: stepped, transaction: store, sources: store });
    const accepted = planReviewMutation({
      action: 'accept_coverage', scope, assignmentId: vacancy.id,
      expectedAssignmentVersion: 2,
      attributedByUserId: actorUserId,
      attributedAt: at(3)
    }, { repository: store, sources: store });
    applyReviewMutationPlan({ plan: accepted, transaction: store, sources: store });
    expect(store.vacancyResolutions.get(vacancy.id)).toMatchObject({
      kind: 'coverage_accepted',
      vacatedAssignmentId: vacancy.id,
      resolvedByUserId: actorUserId
    });
    const snapshot = projectReviewSnapshot({
      scope, viewer: { kind: 'organizer' },
      environment: { repository: store, sources: store, candidateDisplay: store }
    });
    expect(snapshot.plans[0]).toMatchObject({ done: 0, total: 2 });
    expect(snapshot.plans[0]?.reviewers.find((row) => row.reviewerId === reviewerTrack))
      .toMatchObject({ assigned: 0, steppedBack: 1, awaitingReassignment: 0 });
  });
});
