import { describe, expect, test } from 'bun:test';
import {
  COMMIT_CHANGESET_OPERATION,
  DRAFT_CHANGESET_CORRECTION_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  REBUILD_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  changesetLifecycleRefusalOutcome
} from '@jooevents/changeset-operations';
import {
  reviewChangeDraftOperationResultSchema,
  reviewDraftSaveOperationResultSchema
} from '@jooevents/contracts/reviews';
import { parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
  REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
  REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
  REVIEW_STEP_BACK_DRAFT_OPERATION
} from '@jooevents/review-operations';
import { durableCounts, openFixture } from './review-draft-effect-domain.test';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df9-86b5-769b-bba4-5f7097bfa121');
const organizerUserId = parseUserId('019c1df9-86b5-769b-bba4-5f7097bfa221');
const scope = Object.freeze({ workspaceId, eventId });

type Fixture = ReturnType<typeof openFixture>;

function lifecycleCounts(fixture: Fixture) {
  const count = (table: string) =>
    fixture.sqlite.query<{ readonly count: number }, []>(
      `SELECT count(*) AS count FROM ${table}`
    ).get()?.count ?? -1;
  return {
    ...durableCounts(fixture),
    lifecycleLinks: count('review_changeset_receipt_links'),
    facts: count('review_changeset_domain_facts'),
    pointers: count('review_changeset_outbox_pointers'),
    timeline: count('review_changeset_timeline'),
    commitLinks: count('changeset_commit_links')
  };
}

async function draftAndPropose(
  fixture: Fixture,
  operation: { readonly name: string; readonly version: number },
  businessInput: unknown,
  key: string
) {
  const draft = reviewChangeDraftOperationResultSchema.parse(await fixture.effect({
    operation, businessInput, key: `${key}-draft`
  }));
  if (draft.kind !== 'success') {
    throw new TypeError(`review_changeset_test_draft_failed:${JSON.stringify(draft)}`);
  }
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: draft.data.headVersion },
    key: `${key}-propose`
  }));
  if (proposed.kind !== 'success') {
    throw new TypeError(`review_changeset_test_propose_failed:${JSON.stringify(proposed)}`);
  }
  return { draft, selector };
}

async function commit(
  fixture: Fixture,
  selector: {
    readonly changesetId: string;
    readonly revisionId: string;
    readonly revisionDigest: string;
  },
  key: string
) {
  return changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: COMMIT_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: 2 },
    key
  }));
}

async function openRoundThroughAdapters(fixture: Fixture, key: string) {
  const opened = await draftAndPropose(
    fixture,
    REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
    { action: 'open_round', deadlineDate: '2026-08-31' },
    key
  );
  const committed = await commit(fixture, opened.selector, `${key}-commit`);
  if (committed.kind !== 'success') {
    throw new TypeError(`review_changeset_test_open_failed:${JSON.stringify(committed)}`);
  }
  const catalog = fixture.repository.readCatalog(scope);
  const round = catalog?.rounds.find((candidate) => candidate.state === 'open');
  if (!round) throw new TypeError('review_changeset_test_round_missing');
  const assignment = fixture.repository.listAssignments(scope, round.id)[0];
  if (!assignment) throw new TypeError('review_changeset_test_assignment_missing');
  return { round, assignment, committed, selector: opened.selector };
}

describe('SQLite Review changeset effect domain', () => {
  test('commits open_round atomically with its review_due Deadline and replays idempotently', async () => {
    const fixture = openFixture();
    try {
      const opened = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-08-31' },
        'open'
      );
      expect(fixture.repository.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(1);

      const committed = await commit(fixture, opened.selector, 'open-commit');
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      const catalog = fixture.repository.readCatalog(scope);
      expect(catalog).toMatchObject({ version: 2 });
      const round = catalog?.rounds[0];
      expect(round).toMatchObject({
        state: 'open',
        deadline: { kind: 'review_due', version: 1, effectiveAt: '2026-09-01T00:00:00.000Z' }
      });
      expect(fixture.repository.readDeadline(scope, round!.deadline.deadlineId)).toMatchObject({
        kind: 'review_due', status: 'active', version: 1, displayDate: '2026-08-31'
      });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(2);
      expect(fixture.repository.listAssignments(scope, round!.id)).toHaveLength(1);

      const payload = JSON.parse(
        fixture.sqlite.query<{ readonly payload_json: string }, []>(`
          SELECT payload_json FROM review_changeset_domain_facts
        `).get()?.payload_json ?? 'null'
      ) as { readonly contributions: readonly { readonly facts: readonly { kind: string }[] }[] };
      expect(payload.contributions).toHaveLength(1);
      expect(payload.contributions[0]?.facts.map((fact) => fact.kind)).toEqual([
        'review_round_opened', 'deadline_changed'
      ]);
      const after = lifecycleCounts(fixture);
      expect(after).toMatchObject({
        rounds: 1, assignments: 1, deadlines: 1,
        lifecycleLinks: 2, facts: 1, pointers: 1, timeline: 2, commitLinks: 1
      });

      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...opened.selector, expectedHeadVersion: 2 },
        key: 'open-commit'
      })).toEqual(committed);
      expect(lifecycleCounts(fixture)).toEqual(after);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a stale Deadline catalog guard without writing either domain', async () => {
    const fixture = openFixture();
    try {
      const opened = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-08-31' },
        'stale-deadline'
      );
      const strayDeadlineId = '019c1df9-86b5-769b-bba4-5f7097bfab01';
      const plan = fixture.repository.planReviewDueDeadlineChange({
        scope,
        currentDeadlineId: null,
        dueOn: '2026-10-01',
        identity: { deadlineId: strayDeadlineId },
        attribution: { userId: organizerUserId, at: '2026-08-13T09:03:00.000Z' }
      });
      fixture.sqlite.exec('BEGIN IMMEDIATE;');
      fixture.repository.applyReviewDueDeadline(plan);
      fixture.sqlite.exec('COMMIT;');
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(2);

      const before = lifecycleCounts(fixture);
      expect(await commit(fixture, opened.selector, 'stale-deadline-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed' }
        }
      });
      expect(lifecycleCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
      expect(fixture.lifecycle.read(opened.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('the one-open-round double guard surfaces the racing commit as a structured refusal', async () => {
    const fixture = openFixture();
    try {
      const first = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-08-31' },
        'race-a'
      );
      const second = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-09-15' },
        'race-b'
      );
      expect(await commit(fixture, first.selector, 'race-a-commit')).toMatchObject({
        kind: 'success'
      });
      const before = lifecycleCounts(fixture);
      expect(await commit(fixture, second.selector, 'race-b-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: {
            code: 'base_version_changed',
            subjectId: `review_catalog:${eventId}`,
            expected: 1,
            actual: 2
          }
        }
      });
      expect(lifecycleCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCatalog(scope)?.rounds).toHaveLength(1);
      expect(fixture.lifecycle.read(second.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });

      // The same conflict is caught even earlier when drafting after the commit.
      expect(await fixture.effect({
        operation: REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        businessInput: { action: 'open_round', deadlineDate: '2026-09-20' },
        key: 'race-c-draft'
      })).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'review.canonical_changed',
          detail: { code: 'open_round_exists', action: 'open_round' }
        }
      });
    } finally {
      fixture.close();
    }
  });

  test('carries the reviewer evaluation loop end to end: save, commit, guard the head, amend, step back', async () => {
    const fixture = openFixture();
    try {
      const { round, assignment } = await openRoundThroughAdapters(fixture, 'loop');
      const criterionId = round.criteria[0]!.id;

      fixture.actAs('reviewer');
      const saved = reviewDraftSaveOperationResultSchema.parse(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: {
          assignmentId: assignment.id,
          expectedDraftVersion: null,
          scores: [{ criterionId, score: 4 }],
          comment: 'Strong systems narrative.'
        },
        key: 'loop-save'
      }));
      expect(saved).toMatchObject({ kind: 'success', data: { draft: { version: 1 } } });

      const commitDraft = await draftAndPropose(
        fixture,
        REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        {
          action: 'commit_review',
          assignmentId: assignment.id,
          expectedAssignmentVersion: 1,
          expectedDraftVersion: 1
        },
        'loop-commit-review'
      );
      expect(await commit(fixture, commitDraft.selector, 'loop-commit-review-commit'))
        .toMatchObject({ kind: 'success' });
      const head = fixture.repository.readReviewHead(scope, assignment.id);
      expect(head).toMatchObject({ version: 1 });

      // The committed head guards further first commits and step-backs.
      expect(await fixture.effect({
        operation: REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'commit_review',
          assignmentId: assignment.id,
          expectedAssignmentVersion: 1,
          expectedDraftVersion: 1
        },
        key: 'loop-commit-again'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'review_exists', action: 'commit_review' } }
      });
      expect(await fixture.effect({
        operation: REVIEW_STEP_BACK_DRAFT_OPERATION,
        businessInput: {
          action: 'step_back', assignmentId: assignment.id, expectedAssignmentVersion: 1
        },
        key: 'loop-step-back'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { code: 'review_exists', action: 'step_back' } }
      });

      const amendDraft = await draftAndPropose(
        fixture,
        REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        {
          action: 'amend_review',
          assignmentId: assignment.id,
          expectedAssignmentVersion: 1,
          expectedReviewVersion: 1,
          expectedCurrentRevisionId: head!.currentRevisionId,
          scores: [{ criterionId, score: 5 }],
          comment: 'Even stronger on the second read.'
        },
        'loop-amend'
      );
      expect(await commit(fixture, amendDraft.selector, 'loop-amend-commit'))
        .toMatchObject({ kind: 'success' });
      expect(fixture.repository.readReviewHead(scope, assignment.id)).toMatchObject({
        version: 2
      });
      expect(fixture.repository.listRevisions(scope, assignment.id)).toHaveLength(2);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rolls back the created Deadline when the Review round write fails and retries cleanly', async () => {
    const fixture = openFixture();
    try {
      const opened = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-08-31' },
        'atomic'
      );
      const before = lifecycleCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER review_changeset_fail_round
        BEFORE INSERT ON review_rounds
        BEGIN SELECT RAISE(ABORT, 'injected review round failure'); END;
      `);
      await expect(commit(fixture, opened.selector, 'atomic-commit'))
        .rejects.toThrow('Operation execution failed during handler.');
      expect(lifecycleCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(1);
      expect(fixture.repository.readDeadline(scope, '019c1df9-86b5-769b-bba4-5f7097bfab02'))
        .toBeUndefined();
      expect(fixture.lifecycle.read(opened.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });

      fixture.sqlite.exec('DROP TRIGGER review_changeset_fail_round;');
      expect(await commit(fixture, opened.selector, 'atomic-commit')).toMatchObject({
        kind: 'success'
      });
      expect(fixture.repository.readCatalog(scope)?.version).toBe(2);
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(2);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rebuilds a stale proposal against moved candidates and commits round plus Deadline', async () => {
    const fixture = openFixture();
    try {
      const opened = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-08-31' },
        'rebuild'
      );
      // Move the candidate facts under the proposal: same (reviewer, submission)
      // pair, changed submission facts, so the drafted candidate guard is stale
      // but the stored author intent still plans.
      const row = fixture.triage.rows[0]!;
      fixture.triage.rows = [{
        ...row,
        summary: { ...row.summary, submittedAt: '2026-08-12T11:00:00.000Z' },
        detail: { ...row.detail, submittedAt: '2026-08-12T11:00:00.000Z' }
      }];
      const before = lifecycleCounts(fixture);
      expect(await commit(fixture, opened.selector, 'rebuild-stale-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed' }
        }
      });
      expect(lifecycleCounts(fixture)).toEqual(before);

      const rebuildInput = {
        changesetId: opened.selector.changesetId,
        expectedHeadVersion: 2,
        sourceRevisionId: opened.selector.revisionId,
        sourceRevisionDigest: opened.selector.revisionDigest,
        groups: ['review']
      };
      const rebuilt = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: rebuildInput,
        key: 'rebuild-rebuild'
      }));
      expect(rebuilt).toMatchObject({
        kind: 'success',
        data: { action: 'rebuild', sourceRevisionId: opened.selector.revisionId }
      });
      if (rebuilt.kind !== 'success' || rebuilt.data.action !== 'rebuild') {
        throw new TypeError('review_changeset_test_rebuild_failed');
      }
      const selector = {
        changesetId: rebuilt.data.diff.changesetId,
        revisionId: rebuilt.data.diff.revisionId,
        revisionDigest: rebuilt.data.diff.revisionDigest
      };
      expect(selector.changesetId).toBe(opened.selector.changesetId);
      expect(selector.revisionId).not.toBe(opened.selector.revisionId);
      expect(fixture.sqlite.query<{
        readonly action: string;
        readonly revision_id: string;
      }, [string]>(`
        SELECT action, revision_id FROM review_changeset_receipt_links WHERE receipt_id = ?
      `).get(rebuilt.receipt.id)).toEqual({
        action: 'rebuild',
        revision_id: selector.revisionId
      });
      // Rebuild is still inert and replays the identical terminal receipt.
      expect(fixture.repository.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(1);
      expect(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: rebuildInput,
        key: 'rebuild-rebuild'
      })).toEqual(rebuilt);

      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 3 },
        key: 'rebuild-repropose'
      })).toMatchObject({ kind: 'success', data: { action: 'propose' } });
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 4 },
        key: 'rebuild-commit'
      }));
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 5 }
      });
      const catalog = fixture.repository.readCatalog(scope);
      expect(catalog).toMatchObject({ version: 2 });
      expect(catalog?.rounds[0]).toMatchObject({ state: 'open', deadline: { kind: 'review_due' } });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(2);
      expect(fixture.repository.listAssignments(scope, catalog!.rounds[0]!.id)).toHaveLength(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('links a blocked correction for a committed round and replays it identically', async () => {
    const fixture = openFixture();
    try {
      const opened = await openRoundThroughAdapters(fixture, 'corr');
      if (opened.committed.kind !== 'success') throw new TypeError('review_correction_source');
      const before = lifecycleCounts(fixture);
      const correctionInput = {
        sourceChangesetId: opened.selector.changesetId,
        sourceRevisionId: opened.selector.revisionId,
        sourceRevisionDigest: opened.selector.revisionDigest,
        sourceCommitReceiptId: opened.committed.receipt.id
      };
      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: correctionInput,
        key: 'corr-correction'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'blocked',
          target: null,
          evidence: {
            kind: 'blocked',
            blockers: [{ reasonKey: 'review.explicit_forward_change_required' }]
          }
        }
      });
      if (correction.kind !== 'success') throw new TypeError('review_correction_failed');
      // The blocked link anchors receipt evidence on the exact source revision.
      expect(fixture.sqlite.query<{
        readonly action: string;
        readonly revision_id: string;
      }, [string]>(`
        SELECT action, revision_id FROM review_changeset_receipt_links WHERE receipt_id = ?
      `).get(correction.receipt.id)).toEqual({
        action: 'correction',
        revision_id: opened.selector.revisionId
      });
      expect(fixture.sqlite.query<{
        readonly result_kind: string;
        readonly target_changeset_id: string | null;
      }, []>(`
        SELECT result_kind, target_changeset_id FROM changeset_correction_links
      `).all()).toEqual([{ result_kind: 'blocked', target_changeset_id: null }]);
      const after = lifecycleCounts(fixture);
      expect(after).toEqual({
        ...before,
        receipts: before.receipts + 1,
        lifecycleLinks: before.lifecycleLinks + 1,
        timeline: before.timeline + 1
      });
      // No compensation changeset was minted and neither domain moved.
      expect(fixture.repository.readCatalog(scope)).toMatchObject({ version: 2 });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(2);
      expect(fixture.lifecycle.read(opened.selector.changesetId)).toMatchObject({
        head: { status: 'committed', version: 3 }
      });

      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: correctionInput,
        key: 'corr-correction'
      })).toEqual(correction);
      expect(lifecycleCounts(fixture)).toEqual(after);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('surfaces a correction-link id collision as the typed lifecycle refusal', async () => {
    const fixture = openFixture();
    try {
      const opened = await openRoundThroughAdapters(fixture, 'coll');
      if (opened.committed.kind !== 'success') throw new TypeError('review_collision_source');
      const attemptId = '019c1df9-86b5-769b-bba4-5f7097bfac01';
      fixture.seedCorrectionLink({
        sourceChangesetId: opened.selector.changesetId,
        sourceRevisionId: opened.selector.revisionId,
        sourceRevisionDigest: opened.selector.revisionDigest,
        sourceCommitReceiptId: opened.committed.receipt.id,
        correctionAttemptId: attemptId
      });
      const before = lifecycleCounts(fixture);
      fixture.forceLifecycleId('newCorrectionAttemptId', attemptId);
      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: opened.selector.changesetId,
          sourceRevisionId: opened.selector.revisionId,
          sourceRevisionDigest: opened.selector.revisionDigest,
          sourceCommitReceiptId: opened.committed.receipt.id
        },
        key: 'coll-correction'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'conflict',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'id_collision' }
        }
      });
      expect(lifecycleCounts(fixture)).toEqual(before);
      expect(fixture.sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM changeset_correction_links'
      ).get()?.count).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('surfaces execution-claim contention on lifecycle commit as operation.in_progress', async () => {
    const fixture = openFixture();
    try {
      const opened = await draftAndPropose(
        fixture,
        REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
        { action: 'open_round', deadlineDate: '2026-08-31' },
        'contend'
      );
      fixture.setContention(true);
      expect(await commit(fixture, opened.selector, 'contend-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true }
      });
      expect(fixture.repository.readCatalog(scope)).toMatchObject({ version: 1, rounds: [] });
      expect(fixture.repository.readDeadlineCatalog(scope)?.version).toBe(1);

      fixture.setContention(false);
      const committed = await commit(fixture, opened.selector, 'contend-commit');
      expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      const after = lifecycleCounts(fixture);
      // Response-loss retry: the identical idempotency key replays the receipt.
      expect(await commit(fixture, opened.selector, 'contend-commit')).toEqual(committed);
      expect(lifecycleCounts(fixture)).toEqual(after);
    } finally {
      fixture.close();
    }
  });

  test('refuses a partially privileged operator exactly like an absent changeset', async () => {
    const fixture = openFixture();
    try {
      const { round, assignment } = await openRoundThroughAdapters(fixture, 'tier');
      const criterionId = round.criteria[0]!.id;
      fixture.actAs('reviewer');
      expect(reviewDraftSaveOperationResultSchema.parse(await fixture.effect({
        operation: REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
        businessInput: {
          assignmentId: assignment.id,
          expectedDraftVersion: null,
          scores: [{ criterionId, score: 4 }],
          comment: 'Tiered.'
        },
        key: 'tier-save'
      }))).toMatchObject({ kind: 'success' });
      const draft = reviewChangeDraftOperationResultSchema.parse(await fixture.effect({
        operation: REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'commit_review',
          assignmentId: assignment.id,
          expectedAssignmentVersion: 1,
          expectedDraftVersion: 1
        },
        key: 'tier-draft'
      }));
      if (draft.kind !== 'success') throw new TypeError('review_tier_draft_failed');
      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };

      // The organizer holds event.manage but not the record's evaluate union.
      // The refusal must be the canonical typed scope_changed outcome — the
      // exact shape a missing or cross-scope record produces — so a partially
      // privileged operator cannot use the error shape as an existence oracle.
      const hiddenRecordOutcome = changesetLifecycleRefusalOutcome({ kind: 'scope_changed' });
      fixture.actAs('organizer');
      const before = lifecycleCounts(fixture);
      const shortfallPropose = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'tier-shortfall-propose'
      }));
      expect(shortfallPropose).toMatchObject({ kind: 'outcome', terminal: false });
      if (shortfallPropose.kind !== 'outcome') throw new TypeError('review_tier_propose_shape');
      expect(shortfallPropose.outcome).toEqual(hiddenRecordOutcome);
      expect(lifecycleCounts(fixture)).toEqual(before);

      fixture.actAs('reviewer');
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'tier-propose'
      })).toMatchObject({ kind: 'success' });

      fixture.actAs('organizer');
      const shortfallCommit = await commit(fixture, selector, 'tier-shortfall-commit');
      expect(shortfallCommit).toMatchObject({ kind: 'outcome', terminal: false });
      if (shortfallCommit.kind !== 'outcome') throw new TypeError('review_tier_commit_shape');
      expect(shortfallCommit.outcome).toEqual(hiddenRecordOutcome);
      expect(fixture.repository.readReviewHead(scope, assignment.id)).toBeUndefined();

      // The record is untouched: its owner still commits it.
      fixture.actAs('reviewer');
      expect(await commit(fixture, selector, 'tier-commit')).toMatchObject({ kind: 'success' });
      expect(fixture.repository.readReviewHead(scope, assignment.id)).toMatchObject({
        version: 1
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('denies foreign changeset owner subjects and cross-workspace scopes', async () => {
    const fixture = openFixture();
    try {
      expect(fixture.subjectRelationships.validateSubject({
        sqlite: fixture.sqlite,
        workspaceId,
        eventId: eventId as never,
        userId: organizerUserId,
        subject: { kind: 'domain', domain: 'changeset', entity: 'owner', id: 'review' },
        evaluatedAt: '2026-08-13T09:00:00.000Z' as never
      })).toMatchObject({ kind: 'valid' });
      for (const denied of [
        { workspace: workspaceId, subjectId: 'session' },
        { workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'), subjectId: 'review' }
      ] as const) {
        expect(fixture.subjectRelationships.validateSubject({
          sqlite: fixture.sqlite,
          workspaceId: denied.workspace,
          eventId: eventId as never,
          userId: organizerUserId,
          subject: { kind: 'domain', domain: 'changeset', entity: 'owner', id: denied.subjectId },
          evaluatedAt: '2026-08-13T09:00:00.000Z' as never
        })).toMatchObject({ kind: 'denied', reason: 'cross_scope' });
      }
    } finally {
      fixture.close();
    }
  });
});
