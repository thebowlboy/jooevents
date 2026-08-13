import { describe, expect, test } from 'bun:test';
import {
  reviewDraftSaveOperationResultSchema,
  reviewMutationPlanningInputSchema
} from '@jooevents/contracts/reviews';
import { CURRENT_AUTHORITY_DENIAL_REASONS } from '@jooevents/identity-access';
import { parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import { applyReviewMutationPlan, planReviewMutation } from '@jooevents/review';
import { REVIEW_EVALUATION_DRAFT_SAVE_OPERATION } from '@jooevents/review-operations';
import { durableCounts, openFixture } from './review-draft-effect-domain.test';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df9-86b5-769b-bba4-5f7097bfa121');
const reviewerUserId = parseUserId('019c1df9-86b5-769b-bba4-5f7097bfa223');
const reviewerId = '019c1df9-86b5-769b-bba4-5f7097bfa225';
const roundId = '019c1df9-86b5-769b-bba4-5f7097bfac01';
const deadlineId = '019c1df9-86b5-769b-bba4-5f7097bfac02';
const criterionId = '019c1df9-86b5-769b-bba4-5f7097bfac03';
const assignmentId = '019c1df9-86b5-769b-bba4-5f7097bfac04';
const strayId = '019c1df9-86b5-769b-bba4-5f7097bfac05';
const scope = Object.freeze({ workspaceId, eventId });

type Fixture = ReturnType<typeof openFixture>;

function saveCounts(fixture: Fixture) {
  return {
    ...durableCounts(fixture),
    saveLinks: fixture.sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM review_evaluation_draft_save_receipt_links'
    ).get()?.count ?? -1
  };
}

function openRound(fixture: Fixture) {
  fixture.seedOpenRound({ roundId, deadlineId, criterionId, assignmentId });
  fixture.actAs('reviewer');
}

function saveInput(overrides: Record<string, unknown> = {}) {
  return {
    assignmentId,
    expectedDraftVersion: null,
    scores: [{ criterionId, score: 4 }],
    comment: 'Clear, well-argued proposal.',
    ...overrides
  };
}

describe('SQLite Review evaluation draft-save effect domain', () => {
  test('saves and updates the reviewer draft terminally and replays the identical receipt', async () => {
    const fixture = openFixture();
    try {
      openRound(fixture);
      const created = reviewDraftSaveOperationResultSchema.parse(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput(),
        key: 'save-v1'
      }));
      expect(created).toMatchObject({
        kind: 'success',
        data: {
          draft: {
            assignmentId,
            version: 1,
            updatedByReviewerId: reviewerId,
            updatedByUserId: reviewerUserId
          }
        }
      });
      expect(fixture.repository.readDraft(scope, assignmentId)).toMatchObject({ version: 1 });
      const afterFirst = saveCounts(fixture);
      expect(afterFirst).toMatchObject({ saveLinks: 1, drafts: 1 });

      // Response-loss retry replays the identical terminal receipt without rewriting.
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput(),
        key: 'save-v1'
      })).toEqual(created);
      expect(saveCounts(fixture)).toEqual(afterFirst);

      const updated = reviewDraftSaveOperationResultSchema.parse(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput({
          expectedDraftVersion: 1,
          scores: [{ criterionId, score: 5 }],
          comment: 'Raised after clarification.'
        }),
        key: 'save-v2'
      }));
      expect(updated).toMatchObject({ kind: 'success', data: { draft: { version: 2 } } });
      expect(fixture.repository.readDraft(scope, assignmentId)).toMatchObject({
        version: 2, comment: 'Raised after clarification.'
      });
      expect(saveCounts(fixture)).toMatchObject({ saveLinks: 2, drafts: 1 });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('returns viewer_required for an actor without an active reviewer binding', async () => {
    const fixture = openFixture();
    try {
      fixture.seedOpenRound({ roundId, deadlineId, criterionId, assignmentId });
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput(),
        key: 'organizer-save'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'review.viewer_required' }
      });
      expect(saveCounts(fixture)).toMatchObject({ saveLinks: 0, drafts: 0 });
    } finally {
      fixture.close();
    }
  });

  test('refuses each reachable planning code as the typed review.canonical_changed outcome', async () => {
    const fixture = openFixture();
    try {
      openRound(fixture);
      const cases = [
        {
          key: 'missing-assignment',
          code: 'assignment_missing',
          input: saveInput({ assignmentId: strayId })
        },
        {
          key: 'stale-draft',
          code: 'stale_draft',
          input: saveInput({ expectedDraftVersion: 4 })
        },
        {
          key: 'invalid-scores',
          code: 'invalid_scores',
          input: saveInput({ scores: [{ criterionId: strayId, score: 4 }] })
        }
      ] as const;
      for (const scenario of cases) {
        expect(await fixture.effect({
          operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
          businessInput: scenario.input,
          key: scenario.key
        })).toMatchObject({
          kind: 'outcome',
          terminal: false,
          outcome: {
            class: 'stale_revision',
            kind: 'review.canonical_changed',
            detail: { code: scenario.code, action: 'commit_review' }
          }
        });
      }
      expect(saveCounts(fixture)).toMatchObject({ saveLinks: 0, drafts: 0, receipts: 0 });

      // A committed review closes the draft-save lane for its assignment.
      fixture.seedSavedDraft(assignmentId, criterionId);
      const plan = planReviewMutation(reviewMutationPlanningInputSchema.parse({
        action: 'commit_review',
        scope,
        assignmentId,
        expectedAssignmentVersion: 1,
        expectedDraftVersion: 1,
        revisionId: '019c1df9-86b5-769b-bba4-5f7097bfac06',
        reviewerId,
        attributedByUserId: reviewerUserId,
        attributedAt: '2026-08-13T09:10:00.000Z'
      }), { repository: fixture.repository, sources: fixture.repository });
      fixture.sqlite.exec('BEGIN IMMEDIATE;');
      applyReviewMutationPlan({
        plan, transaction: fixture.repository, sources: fixture.repository
      });
      fixture.sqlite.exec('COMMIT;');
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput({ expectedDraftVersion: 1 }),
        key: 'review-exists'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'review_exists', action: 'commit_review' } }
      });
    } finally {
      fixture.close();
    }
  });

  test('surfaces every current-authority denial reason on the evaluate lane without writing', async () => {
    const fixture = openFixture();
    try {
      openRound(fixture);
      for (const reason of CURRENT_AUTHORITY_DENIAL_REASONS) {
        fixture.deny(reason);
        expect(await fixture.effect({
          operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
          businessInput: saveInput(),
          key: `denied-${reason}`
        })).toMatchObject({
          kind: 'outcome',
          outcome: { class: 'access_denied', kind: `authority.${reason}` }
        });
      }
      fixture.deny(undefined);
      expect(saveCounts(fixture)).toMatchObject({ saveLinks: 0, drafts: 0, receipts: 0 });
    } finally {
      fixture.close();
    }
  });

  test('surfaces execution-claim contention as operation.in_progress', async () => {
    const fixture = openFixture();
    try {
      openRound(fixture);
      fixture.setContention(true);
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput(),
        key: 'contended-save'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true }
      });
      fixture.setContention(false);
      expect(saveCounts(fixture)).toMatchObject({ saveLinks: 0, drafts: 0, receipts: 0 });
    } finally {
      fixture.close();
    }
  });

  test('rolls the saved draft back with the receipt when evidence persistence fails', async () => {
    const fixture = openFixture();
    try {
      openRound(fixture);
      const before = saveCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER review_save_fail_link
        BEFORE INSERT ON review_evaluation_draft_save_receipt_links
        BEGIN SELECT RAISE(ABORT, 'injected save evidence failure'); END;
      `);
      await expect(fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput(),
        key: 'atomic-save'
      })).rejects.toThrow();
      expect(saveCounts(fixture)).toEqual(before);
      expect(fixture.repository.readDraft(scope, assignmentId)).toBeUndefined();

      fixture.sqlite.exec('DROP TRIGGER review_save_fail_link;');
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: saveInput(),
        key: 'atomic-save'
      })).toMatchObject({ kind: 'success' });
      expect(fixture.repository.readDraft(scope, assignmentId)).toMatchObject({ version: 1 });
    } finally {
      fixture.close();
    }
  });
});
