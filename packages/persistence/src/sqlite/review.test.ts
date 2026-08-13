import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  REVIEWER_CAPABILITY_IDS,
  type ReviewerAuthoritySetDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import {
  reviewMutationPlanningInputSchema,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  submissionTriageSourceRowSchema,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import { planEventCreation } from '@jooevents/event';
import { parseApplicationId } from '@jooevents/kernel';
import {
  applyReviewMutationPlan,
  expectedReviewAssignmentPairs,
  planReviewMutation,
  ReviewPlanningError,
  saveReviewDraft,
  validateReviewMutationPlan
} from '@jooevents/review';
import {
  planReviewerRosterMutation,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerScopeTargetSetDigest,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import type { SubmissionTriageScope, SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import { installDeadlineSchema } from './deadline';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import { installReviewSchema, SQLiteReviewError, SQLiteReviewRepository } from './review';
import { installReviewerRosterSchema, SQLiteReviewerRosterRepository } from './reviewer-roster';

const applicationId = (value: string) => parseApplicationId('event', value);
const workspaceId = applicationId('550e8400-e29b-41d4-a716-446655440000');
const eventId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa121');
const userId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa221');
const reviewerUserId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa222');
const membershipId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa223');
const reviewerId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa224');
const submissionId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa301');
const formId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa302');
const formVersionId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa303');
const fieldId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa304');
const roundId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa401');
const deadlineId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa402');
const criterionId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa403');
const assignmentId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa404');
const reviewRevisionId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa405');
const amendRevisionId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa406');
const strayId = applicationId('019c1df8-86b5-769b-bba4-5f7097bfa407');
const scope: ReviewScopeDto = Object.freeze({ workspaceId, eventId });
const now = '2026-08-13T09:00:00.000Z';

function sourceRow(submission: string): SubmissionTriageSourceRowDto {
  return submissionTriageSourceRowSchema.parse({
    schemaVersion: 1,
    scope,
    source: 'public_form',
    summary: {
      schemaVersion: 1,
      id: submission,
      formId,
      formVersionId,
      target: { kind: 'general_pool' },
      title: `Proposal ${submission.slice(-2)}`,
      primaryParticipantName: 'José Sørensen',
      submittedAt: '2026-08-12T10:00:00.000Z'
    },
    detail: {
      schemaVersion: 1,
      submissionId: submission,
      formId,
      formVersionId,
      submittedAt: '2026-08-12T10:00:00.000Z',
      participantCount: 1,
      answers: [{
        kind: 'textarea', fieldId, fieldLabel: 'Abstract', value: 'Durable event systems'
      }],
      affirmedConsentFieldIds: []
    },
    abstract: 'Durable event systems',
    track: null,
    format: null
  });
}

class TriageSource implements SubmissionTriageSourcePort {
  rows: SubmissionTriageSourceRowDto[] = [sourceRow(submissionId)];

  listSourceRows(requested: SubmissionTriageScope): readonly SubmissionTriageSourceRowDto[] {
    return requested.workspaceId === workspaceId && requested.eventId === eventId
      ? this.rows
      : [];
  }

  readSourceRow(requested: SubmissionTriageScope, submission: string) {
    return this.listSourceRows(requested).find((row) => row.summary.id === submission);
  }
}

function rosterSources(): ReviewerRosterPlanningSource {
  const factUnsigned = {
    schemaVersion: 1 as const,
    scope,
    rosterSubject: { kind: 'workspace_membership' as const, id: membershipId, version: 1 },
    currentSubject: { kind: 'workspace_membership' as const, id: membershipId, version: 1 },
    state: 'active' as const,
    version: 1,
    capabilityIds: [...REVIEWER_CAPABILITY_IDS],
    evidenceIds: [`workspace_membership:${membershipId}:v1`],
    displayName: 'Reviewer One'
  };
  const fact = {
    ...factUnsigned,
    digestSha256: reviewerAuthorityFactDigest(factUnsigned as never)
  };
  const setUnsigned = { schemaVersion: 1 as const, scope, version: 1, facts: [fact] };
  const authority = {
    ...setUnsigned,
    digestSha256: reviewerAuthoritySetDigest(setUnsigned as never)
  } as unknown as ReviewerAuthoritySetDto;
  const targetsUnsigned = { schemaVersion: 1 as const, scope, version: 1, targets: [] };
  const targets = {
    ...targetsUnsigned,
    digestSha256: reviewerScopeTargetSetDigest(targetsUnsigned as never)
  } as unknown as ReviewerScopeTargetSetDto;
  return Object.freeze({
    readReviewerAuthority: (requested: { workspaceId: string; eventId: string }) =>
      requested.workspaceId === workspaceId && requested.eventId === eventId
        ? authority
        : undefined,
    readReviewerScopeTargets: (requested: { workspaceId: string; eventId: string }) =>
      requested.workspaceId === workspaceId && requested.eventId === eventId
        ? targets
        : undefined
  });
}

function transaction<Value>(sqlite: Database, run: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const value = run();
    sqlite.exec('COMMIT;');
    return value;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function setup() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO workspaces VALUES ('${workspaceId}', 'Workspace', 'active', 1, 1, 1);
    INSERT INTO users VALUES ('${userId}', 'active', 'Organizer', 1, 1, 1);
    INSERT INTO users VALUES ('${reviewerUserId}', 'active', 'Reviewer', 1, 1, 1);
  `);
  installEventSpineSchema(sqlite);
  installDeadlineSchema(sqlite);
  installReviewerRosterSchema(sqlite);
  installReviewSchema(sqlite);
  const spine = new SQLiteEventSpineRepository(sqlite);
  transaction(sqlite, () => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Review Event',
        timezone: 'UTC',
        startDate: '2026-11-01',
        endDate: '2026-11-02'
      },
      server: {
        workspaceId, eventId, createdByUserId: userId,
        createdAt: '2026-08-13T01:00:00.000Z'
      }
    }));
  });
  const triage = new TriageSource();
  const sources = rosterSources();
  const reviews = new SQLiteReviewRepository(sqlite, { triage, roster: sources });
  const rosterRepository = new SQLiteReviewerRosterRepository(sqlite, sources);
  const roster = rosterRepository.readReviewerRoster(scope);
  if (!roster) throw new TypeError('review_test_roster_missing');
  const registerPlan = planReviewerRosterMutation({
    action: 'register',
    scope,
    reviewerId,
    accessSubject: { kind: 'workspace_membership', id: membershipId, version: 1 },
    reviews: [],
    expectedRosterVersion: roster.version,
    expectedRosterDigestSha256: roster.digestSha256
  }, {
    environment: { repository: rosterRepository, sources },
    attribution: { userId, occurredAt: now }
  });
  transaction(sqlite, () => rosterRepository.applyReviewerRosterPlan(registerPlan));
  return { sqlite, reviews, triage, close: () => sqlite.close() };
}

function openRoundInput(fixture: ReturnType<typeof setup>, overrides: {
  readonly assignmentIds?: readonly {
    readonly assignmentId: string;
    readonly reviewerId: string;
    readonly submissionId: string;
  }[];
} = {}) {
  const candidates = fixture.reviews.readCandidates(scope);
  const roster = fixture.reviews.readReviewerRoster(scope);
  if (!candidates || !roster) throw new TypeError('review_test_sources_missing');
  const pairs = expectedReviewAssignmentPairs({
    candidates: candidates.candidates,
    reviewers: roster.reviewers
  });
  return reviewMutationPlanningInputSchema.parse({
    action: 'open_round',
    scope,
    expectedCatalogVersion: fixture.reviews.readCatalog(scope)?.version ?? 1,
    roundId,
    deadlineIdentity: { deadlineId },
    deadlineDate: '2026-08-31',
    criteria: [{
      id: criterionId, key: 'overall', label: 'Overall',
      position: 0, weightBps: 10_000, scaleMin: 1, scaleMax: 5
    }],
    visibility: {
      participantIdentity: 'hidden',
      peerReviewerIdentity: 'hidden',
      peerContentUnlock: 'after_own_commit'
    },
    assignmentIds: overrides.assignmentIds ?? pairs.map((pair) => ({
      ...pair, assignmentId
    })),
    attributedByUserId: userId,
    attributedAt: now
  });
}

function openRound(fixture: ReturnType<typeof setup>) {
  const plan = planReviewMutation(openRoundInput(fixture), {
    repository: fixture.reviews,
    sources: fixture.reviews,
    deadlines: fixture.reviews
  });
  if (plan.action !== 'open_round') throw new TypeError('review_test_plan_action');
  transaction(fixture.sqlite, () => {
    fixture.reviews.applyReviewDueDeadline(plan.deadlineContribution);
    applyReviewMutationPlan({
      plan,
      transaction: fixture.reviews,
      sources: fixture.reviews
    });
  });
  return plan;
}

describe('SQLiteReviewRepository', () => {
  test('opens a round with its review_due Deadline through the composed planning sources', () => {
    const fixture = setup();
    try {
      expect(fixture.reviews.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
      expect(fixture.reviews.readCatalog({ workspaceId, eventId: strayId })).toBeUndefined();
      const plan = openRound(fixture);
      expect(plan.action).toBe('open_round');

      const catalog = fixture.reviews.readCatalog(scope);
      expect(catalog).toMatchObject({
        version: 2,
        rounds: [{
          id: roundId,
          state: 'open',
          deadline: { deadlineId, kind: 'review_due', version: 1 }
        }]
      });
      expect(fixture.reviews.listAssignments(scope, roundId)).toMatchObject([{
        id: assignmentId, reviewerId, submissionId, state: 'assigned', version: 1
      }]);
      expect(fixture.reviews.readDeadline(scope, deadlineId)).toMatchObject({
        kind: 'review_due', status: 'active', version: 1
      });
      expect(fixture.reviews.resolveReviewDeadline(scope, deadlineId)).toMatchObject({
        deadlineId, kind: 'review_due', version: 1,
        effectiveAt: '2026-09-01T00:00:00.000Z'
      });
      expect(fixture.reviews.resolveReviewDeadline(scope, strayId)).toBeUndefined();
      expect(validateReviewMutationPlan(plan, {
        repository: fixture.reviews,
        sources: fixture.reviews
      })).toBe('stale_catalog');
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a second open round at planning and at the review_one_open_round index', () => {
    const fixture = setup();
    try {
      openRound(fixture);
      expect(() => planReviewMutation(reviewMutationPlanningInputSchema.parse({
        ...openRoundInput(fixture),
        roundId: strayId,
        deadlineIdentity: { deadlineId: strayId }
      }), {
        repository: fixture.reviews,
        sources: fixture.reviews,
        deadlines: fixture.reviews
      })).toThrow(new ReviewPlanningError('open_round_exists'));

      const round = fixture.reviews.readRound(scope, roundId);
      if (!round) throw new TypeError('review_test_round_missing');
      transaction(fixture.sqlite, () => {
        const second = { ...round, id: strayId, ordinal: round.ordinal + 1 };
        expect(() => fixture.reviews.insertRound(second)).toThrow(SQLiteReviewError);
        try {
          fixture.reviews.insertRound(second);
        } catch (error) {
          expect((error as SQLiteReviewError).code).toBe('identity_collision');
        }
      });
      expect(fixture.reviews.readCatalog(scope)?.rounds).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  test('proves assignment_seed_mismatch for a missing and a duplicated (reviewerId, submissionId) pair', () => {
    const fixture = setup();
    try {
      const environment = {
        repository: fixture.reviews,
        sources: fixture.reviews,
        deadlines: fixture.reviews
      };
      expect(() => planReviewMutation(
        openRoundInput(fixture, { assignmentIds: [] }),
        environment
      )).toThrow(new ReviewPlanningError('assignment_seed_mismatch'));
      const pair = { reviewerId, submissionId };
      expect(() => planReviewMutation(
        openRoundInput(fixture, {
          assignmentIds: [
            { ...pair, assignmentId },
            { ...pair, assignmentId: strayId }
          ]
        }),
        environment
      )).toThrow(new ReviewPlanningError('assignment_seed_mismatch'));
      expect(() => planReviewMutation(
        openRoundInput(fixture, {
          assignmentIds: [
            { ...pair, assignmentId },
            { reviewerId: strayId, submissionId, assignmentId: strayId }
          ]
        }),
        environment
      )).toThrow(new ReviewPlanningError('assignment_seed_mismatch'));
      expect(fixture.reviews.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
    } finally {
      fixture.close();
    }
  });

  test('commits and amends a review through the composed repository and keeps rows immutable', () => {
    const fixture = setup();
    try {
      openRound(fixture);
      transaction(fixture.sqlite, () => saveReviewDraft({
        scope,
        reviewerId,
        attributedByUserId: reviewerUserId,
        attributedAt: now,
        businessInput: {
          assignmentId,
          expectedDraftVersion: null,
          scores: [{ criterionId, score: 4 }],
          comment: 'Solid systems talk.'
        },
        transaction: fixture.reviews
      }));
      expect(fixture.reviews.readDraft(scope, assignmentId)).toMatchObject({ version: 1 });

      const commitPlan = planReviewMutation(reviewMutationPlanningInputSchema.parse({
        action: 'commit_review',
        scope,
        assignmentId,
        expectedAssignmentVersion: 1,
        expectedDraftVersion: 1,
        revisionId: reviewRevisionId,
        reviewerId,
        attributedByUserId: reviewerUserId,
        attributedAt: now
      }), { repository: fixture.reviews, sources: fixture.reviews });
      transaction(fixture.sqlite, () => applyReviewMutationPlan({
        plan: commitPlan,
        transaction: fixture.reviews,
        sources: fixture.reviews
      }));
      expect(fixture.reviews.readReviewHead(scope, assignmentId)).toMatchObject({
        version: 1, currentRevisionId: reviewRevisionId
      });

      const amendPlan = planReviewMutation(reviewMutationPlanningInputSchema.parse({
        action: 'amend_review',
        scope,
        assignmentId,
        expectedAssignmentVersion: 1,
        expectedReviewVersion: 1,
        expectedCurrentRevisionId: reviewRevisionId,
        revisionId: amendRevisionId,
        reviewerId,
        scores: [{ criterionId, score: 5 }],
        comment: 'Even better on re-read.',
        attributedByUserId: reviewerUserId,
        attributedAt: '2026-08-13T10:00:00.000Z'
      }), { repository: fixture.reviews, sources: fixture.reviews });
      transaction(fixture.sqlite, () => applyReviewMutationPlan({
        plan: amendPlan,
        transaction: fixture.reviews,
        sources: fixture.reviews
      }));
      expect(fixture.reviews.readReviewHead(scope, assignmentId)).toMatchObject({
        version: 2, currentRevisionId: amendRevisionId
      });
      expect(fixture.reviews.listRevisions(scope, assignmentId)).toHaveLength(2);

      expect(() => fixture.sqlite.exec(
        `UPDATE review_revisions SET comment = 'tampered' WHERE id = '${reviewRevisionId}'`
      )).toThrow('review revisions are immutable');
      expect(() => fixture.sqlite.exec(
        `DELETE FROM review_rounds WHERE id = '${roundId}'`
      )).toThrow('review rounds are retained');
      expect(() => fixture.sqlite.exec(
        `DELETE FROM review_drafts WHERE assignment_id = '${assignmentId}'`
      )).toThrow('review drafts are retained');
      expect(() => fixture.sqlite.exec(
        `UPDATE review_rounds SET ordinal = 9 WHERE id = '${roundId}'`
      )).toThrow('review round identity and pins are immutable');
    } finally {
      fixture.close();
    }
  });

  test('resolves the acting reviewer only for the exact active workspace-membership binding', () => {
    const fixture = setup();
    try {
      expect(fixture.reviews.resolveActingReviewer(scope, membershipId)).toBe(reviewerId);
      expect(fixture.reviews.resolveActingReviewer(scope, strayId)).toBeUndefined();
      expect(fixture.reviews.resolveActingReviewer(
        { workspaceId, eventId: strayId },
        membershipId
      )).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});
