import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type {
  DeadlineCatalogSnapshotDto,
  DeadlineHeadDto,
  DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import type {
  ReviewCandidateSnapshotDto,
  ReviewRosterMemberSnapshotDto,
  ReviewScopeDto
} from '@jooevents/contracts/reviews';
import { createEmptyDeadlineCatalog } from '@jooevents/deadline';
import {
  applyReviewMutationPlan,
  expectedReviewAssignmentPairs,
  planReviewMutation,
  saveReviewDraft,
  type ReviewDueDeadlineCollaborator,
  type ReviewPlanningSource
} from '@jooevents/review';
import { parseApplicationId } from '@jooevents/kernel';
import {
  installReviewTrialSchema,
  SQLiteReviewTrialRepository
} from './review-trial';

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
const submissionA = id(10);
const submissionB = id(11);
const reviewerA = id(20);
const reviewerB = id(21);

const candidates: readonly ReviewCandidateSnapshotDto[] = [
  { submissionId: submissionA, version: 1, trackId },
  { submissionId: submissionB, version: 1 }
];
const reviewers: readonly ReviewRosterMemberSnapshotDto[] = [
  { reviewerId: reviewerA, version: 1, status: 'active', scope: [] },
  { reviewerId: reviewerB, version: 1, status: 'active', scope: [{ kind: 'track', id: trackId }] }
];
const deadlineDate = '2026-08-31';
const source: ReviewPlanningSource = {
  readCandidates: (requested) => sameScope(requested) ? { version: 1, candidates } : undefined,
  readCandidate: (requested, submissionId) => sameScope(requested)
    ? candidates.find((candidate) => candidate.submissionId === submissionId)
    : undefined,
  readReviewerRoster: (requested) => sameScope(requested) ? { version: 1, reviewers } : undefined,
  resolveReviewDeadline: () => undefined
};

/** In-memory Deadline collaborator; the SQLite-backed join lives in review-deadline-collaboration.test.ts. */
function memoryDeadlineCollaborator(): ReviewDueDeadlineCollaborator {
  const catalog: DeadlineCatalogSnapshotDto = createEmptyDeadlineCatalog(scope);
  return {
    readDeadlineCatalog: (requested: DeadlineScopeDto) => sameScope(requested) ? catalog : undefined,
    readDeadline: (requested: DeadlineScopeDto, idValue: string): DeadlineHeadDto | undefined =>
      sameScope(requested) ? catalog.deadlines.find((head) => head.id === idValue) : undefined,
    readDeadlineEventTimeBasis: (requested: DeadlineScopeDto) =>
      sameScope(requested) ? { timezone: 'UTC', eventVersion: 1 } : undefined
  };
}

function sameScope(value: { readonly workspaceId: string; readonly eventId: string }) {
  return value.workspaceId === scope.workspaceId && value.eventId === scope.eventId;
}

function setup() {
  const sqlite = new Database(':memory:', { strict: true });
  installReviewTrialSchema(sqlite);
  const repository = new SQLiteReviewTrialRepository(sqlite);
  return { sqlite, repository };
}

function openRound(target: ReturnType<typeof setup>) {
  const pairs = expectedReviewAssignmentPairs({ candidates, reviewers });
  const plan = planReviewMutation({
    action: 'open_round', scope, expectedCatalogVersion: 1,
    roundId, deadlineIdentity: { deadlineId }, deadlineDate,
    criteria: [
      { id: criterionQuality, key: 'quality', label: 'Quality', position: 0, weightBps: 6_000, scaleMin: 1, scaleMax: 5 },
      { id: criterionFit, key: 'fit', label: 'Fit', position: 1, weightBps: 4_000, scaleMin: 1, scaleMax: 5 }
    ],
    visibility: {
      participantIdentity: 'hidden', peerReviewerIdentity: 'hidden',
      peerContentUnlock: 'after_own_commit'
    },
    assignmentIds: pairs.map((pair, index) => ({ ...pair, assignmentId: id(100 + index) })),
    attributedByUserId: actorUserId,
    attributedAt: at(1)
  }, { repository: target.repository, sources: source, deadlines: memoryDeadlineCollaborator() });
  if (plan.action !== 'open_round') throw new TypeError('test_open_plan_invalid');
  target.sqlite.transaction(() => applyReviewMutationPlan({
    plan, transaction: target.repository, sources: source
  })).immediate();
  return plan;
}

describe('SQLite Review disposable trial', () => {
  test('round-trips a rich round, drafts, immutable review history, and forward correction', () => {
    const target = setup();
    const opened = openRound(target);
    const reopened = new SQLiteReviewTrialRepository(target.sqlite);
    const catalog = reopened.readCatalog(scope);
    expect(catalog?.version).toBe(2);
    expect(catalog?.rounds).toEqual([opened.round]);
    expect(reopened.listAssignments(scope, roundId)).toHaveLength(3);

    const assignment = reopened.listAssignments(scope, roundId)
      .find((candidate) => candidate.reviewerId === reviewerA && candidate.submissionId === submissionA);
    if (!assignment) throw new TypeError('test_assignment_missing');
    const draft = target.sqlite.transaction(() => saveReviewDraft({
      scope, reviewerId: reviewerA, attributedByUserId: actorUserId, attributedAt: at(2),
      businessInput: {
        assignmentId: assignment.id,
        expectedDraftVersion: null,
        scores: [
          { criterionId: criterionQuality, score: 5 },
          { criterionId: criterionFit, score: 4 }
        ],
        comment: 'A durable in-progress review.'
      },
      transaction: reopened
    })).immediate().draft;
    expect(new SQLiteReviewTrialRepository(target.sqlite).readDraft(scope, assignment.id)).toEqual(draft);

    const commit = planReviewMutation({
      action: 'commit_review', scope, assignmentId: assignment.id,
      expectedAssignmentVersion: assignment.version,
      expectedDraftVersion: draft.version,
      revisionId: id(200), reviewerId: reviewerA,
      attributedByUserId: actorUserId, attributedAt: at(3)
    }, { repository: reopened, sources: source });
    target.sqlite.transaction(() => applyReviewMutationPlan({
      plan: commit, transaction: reopened, sources: source
    })).immediate();

    const amend = planReviewMutation({
      action: 'amend_review', scope, assignmentId: assignment.id,
      expectedAssignmentVersion: assignment.version,
      expectedReviewVersion: 1,
      expectedCurrentRevisionId: id(200),
      revisionId: id(201), reviewerId: reviewerA,
      scores: [
        { criterionId: criterionQuality, score: 4 },
        { criterionId: criterionFit, score: 4 }
      ],
      comment: 'Forward correction after peer unlock.',
      attributedByUserId: actorUserId, attributedAt: at(4)
    }, { repository: reopened, sources: source });
    target.sqlite.transaction(() => applyReviewMutationPlan({
      plan: amend, transaction: reopened, sources: source
    })).immediate();

    const revisions = new SQLiteReviewTrialRepository(target.sqlite)
      .listRevisions(scope, assignment.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({
      revisionNumber: 2,
      postUnlock: true,
      correctionOfRevisionId: id(200)
    });
    expect(() => target.sqlite.query(`
      UPDATE review_revisions SET comment = 'rewritten' WHERE id = ?
    `).run(id(200))).toThrow('review revisions are immutable');
    target.sqlite.close();
  });

  test('requires a transaction and rolls all state back on a downstream failure', () => {
    const target = setup();
    openRound(target);
    const assignment = target.repository.listAssignments(scope, roundId)[0]!;
    const stepBack = planReviewMutation({
      action: 'step_back', scope, assignmentId: assignment.id,
      expectedAssignmentVersion: assignment.version,
      reviewerId: assignment.reviewerId,
      attributedByUserId: actorUserId, attributedAt: at(2)
    }, { repository: target.repository, sources: source });
    expect(() => applyReviewMutationPlan({
      plan: stepBack, transaction: target.repository, sources: source
    })).toThrow('transaction_required');
    expect(() => target.sqlite.transaction(() => {
      applyReviewMutationPlan({ plan: stepBack, transaction: target.repository, sources: source });
      throw new Error('force rollback');
    }).immediate()).toThrow('force rollback');
    expect(target.repository.readAssignment(scope, assignment.id)?.state).toBe('assigned');
    target.sqlite.close();
  });
});
