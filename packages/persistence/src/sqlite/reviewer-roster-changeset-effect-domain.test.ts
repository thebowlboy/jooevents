import { describe, expect, test } from 'bun:test';
import {
  COMMIT_CHANGESET_OPERATION,
  DRAFT_CHANGESET_CORRECTION_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  REBUILD_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema
} from '@jooevents/changeset-operations';
import { reviewerRosterChangeDraftOperationResultSchema } from '@jooevents/contracts/reviewer-roster';
import { parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import { REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION } from '@jooevents/review-operations/roster';
import { openRosterFixture, rosterCounts } from './reviewer-roster-draft-effect-domain.test';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = '019c1dfa-86b5-769b-bba4-5f7097bfa121';
const organizerUserId = parseUserId('019c1dfa-86b5-769b-bba4-5f7097bfa221');
const reviewerId = '019c1dfa-86b5-769b-bba4-5f7097bfa224';

type Fixture = ReturnType<typeof openRosterFixture>;

async function draftAndPropose(fixture: Fixture, businessInput: unknown, key: string) {
  const draft = reviewerRosterChangeDraftOperationResultSchema.parse(await fixture.effect({
    operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
    businessInput,
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') {
    throw new TypeError(`roster_changeset_test_draft_failed:${JSON.stringify(draft)}`);
  }
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: 1 },
    key: `${key}-propose`
  }));
  if (proposed.kind !== 'success') {
    throw new TypeError(`roster_changeset_test_propose_failed:${JSON.stringify(proposed)}`);
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

describe('SQLite reviewer-roster changeset effect domain', () => {
  test('commits the drafted registration atomically with its fact and replays idempotently', async () => {
    const fixture = openRosterFixture();
    try {
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'register');
      expect(fixture.roster()).toMatchObject({ version: 1, reviewers: [] });

      const committed = await commit(fixture, registered.selector, 'register-commit');
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      expect(fixture.roster()).toMatchObject({
        version: 2,
        reviewers: [{ reviewerId, state: 'included', version: 1 }]
      });
      expect(JSON.parse(fixture.sqlite.query<{ readonly payload_json: string }, []>(`
        SELECT payload_json FROM reviewer_roster_changeset_domain_facts
      `).get()?.payload_json ?? 'null')).toMatchObject({
        action: 'register',
        reviewerId,
        rosterVersion: 2,
        reviewerVersion: 1
      });
      const after = rosterCounts(fixture);
      expect(after).toMatchObject({
        sets: 1, records: 1, lifecycleLinks: 2, facts: 1, pointers: 1, timeline: 2
      });

      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...registered.selector, expectedHeadVersion: 2 },
        key: 'register-commit'
      })).toEqual(committed);
      expect(rosterCounts(fixture)).toEqual(after);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a commit after the authority set moved, leaving the roster unmoved', async () => {
    const fixture = openRosterFixture();
    try {
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'stale');
      fixture.sources.bumpAuthorityVersion();
      const before = rosterCounts(fixture);
      expect(await commit(fixture, registered.selector, 'stale-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `reviewer_authority_set:${eventId}` }
        }
      });
      expect(rosterCounts(fixture)).toEqual(before);
      expect(fixture.roster()).toMatchObject({ version: 1, reviewers: [] });
      expect(fixture.lifecycle.read(registered.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('derives an exact compensation with fresh attribution instead of blocking', async () => {
    const fixture = openRosterFixture();
    try {
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'compensated');
      const committed = await commit(fixture, registered.selector, 'compensated-commit');
      if (committed.kind !== 'success') throw new TypeError('roster_commit_failed');
      expect(fixture.roster().reviewers).toHaveLength(1);

      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: registered.selector.changesetId,
          sourceRevisionId: registered.selector.revisionId,
          sourceRevisionDigest: registered.selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'compensated-correction'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'exact' }
      });
      if (correction.kind !== 'success' || correction.data.action !== 'correction'
          || correction.data.target === null) {
        throw new TypeError('roster_compensation_target_missing');
      }
      expect(JSON.stringify(correction.data.evidence)).not.toContain(
        'fresh_attribution_required'
      );
      const compensationSelector = {
        changesetId: correction.data.target.changesetId,
        revisionId: correction.data.target.revisionId,
        revisionDigest: correction.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...compensationSelector, expectedHeadVersion: 1 },
        key: 'compensated-correction-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await commit(fixture, compensationSelector, 'compensated-correction-commit'))
        .toMatchObject({ kind: 'success' });
      expect(fixture.roster()).toMatchObject({
        version: 3,
        reviewers: [{ reviewerId, state: 'revoked', version: 2 }]
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rebuilds a stale registration against the moved authority set and commits it', async () => {
    const fixture = openRosterFixture();
    try {
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'rb');
      fixture.sources.bumpAuthorityVersion();
      expect(await commit(fixture, registered.selector, 'rb-stale-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed' }
        }
      });
      expect(fixture.roster()).toMatchObject({ version: 1, reviewers: [] });

      const rebuildInput = {
        changesetId: registered.selector.changesetId,
        expectedHeadVersion: 2,
        sourceRevisionId: registered.selector.revisionId,
        sourceRevisionDigest: registered.selector.revisionDigest,
        groups: ['reviewer_roster']
      };
      const rebuilt = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: rebuildInput,
        key: 'rb-rebuild'
      }));
      expect(rebuilt).toMatchObject({
        kind: 'success',
        data: { action: 'rebuild', sourceRevisionId: registered.selector.revisionId }
      });
      if (rebuilt.kind !== 'success' || rebuilt.data.action !== 'rebuild') {
        throw new TypeError('roster_rebuild_failed');
      }
      const selector = {
        changesetId: rebuilt.data.diff.changesetId,
        revisionId: rebuilt.data.diff.revisionId,
        revisionDigest: rebuilt.data.diff.revisionDigest
      };
      expect(selector.changesetId).toBe(registered.selector.changesetId);
      expect(selector.revisionId).not.toBe(registered.selector.revisionId);
      // Rebuild is still inert and replays the identical terminal receipt.
      expect(fixture.roster()).toMatchObject({ version: 1, reviewers: [] });
      expect(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: rebuildInput,
        key: 'rb-rebuild'
      })).toEqual(rebuilt);

      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 3 },
        key: 'rb-repropose'
      })).toMatchObject({ kind: 'success', data: { action: 'propose' } });
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 4 },
        key: 'rb-commit'
      })).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 5 }
      });
      expect(fixture.roster()).toMatchObject({
        version: 2,
        reviewers: [{ reviewerId, state: 'included', version: 1 }]
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('surfaces a compensation-target id collision as the typed lifecycle refusal', async () => {
    const fixture = openRosterFixture();
    try {
      const foreignChangesetId = '019c1dfa-86b5-769b-bba4-5f7097bfae01';
      fixture.seedForeignChangeset(foreignChangesetId, '019c1dfa-86b5-769b-bba4-5f7097bfae02');
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'coll');
      const committed = await commit(fixture, registered.selector, 'coll-commit');
      if (committed.kind !== 'success') throw new TypeError('roster_collision_source');
      const before = rosterCounts(fixture);
      fixture.forceLifecycleId('newChangesetId', foreignChangesetId);
      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: registered.selector.changesetId,
          sourceRevisionId: registered.selector.revisionId,
          sourceRevisionDigest: registered.selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
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
      expect(rosterCounts(fixture)).toEqual(before);
      expect(fixture.roster()).toMatchObject({
        version: 2,
        reviewers: [{ reviewerId, state: 'included', version: 1 }]
      });
      expect(fixture.sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM changeset_correction_links'
      ).get()?.count).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('surfaces execution-claim contention on lifecycle commit as operation.in_progress', async () => {
    const fixture = openRosterFixture();
    try {
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'contend');
      fixture.setContention(true);
      expect(await commit(fixture, registered.selector, 'contend-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true }
      });
      expect(fixture.roster()).toMatchObject({ version: 1, reviewers: [] });

      fixture.setContention(false);
      const committed = await commit(fixture, registered.selector, 'contend-commit');
      expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      const after = rosterCounts(fixture);
      // Response-loss retry: the identical idempotency key replays the receipt.
      expect(await commit(fixture, registered.selector, 'contend-commit')).toEqual(committed);
      expect(rosterCounts(fixture)).toEqual(after);
    } finally {
      fixture.close();
    }
  });

  test('rolls the roster write back with the receipt after a late failure and retries cleanly', async () => {
    const fixture = openRosterFixture();
    try {
      const registered = await draftAndPropose(fixture, fixture.registerInput(), 'atomic');
      const before = rosterCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER roster_changeset_fail_record
        BEFORE INSERT ON reviewer_roster_records
        BEGIN SELECT RAISE(ABORT, 'injected roster record failure'); END;
      `);
      await expect(commit(fixture, registered.selector, 'atomic-commit'))
        .rejects.toThrow('Operation execution failed during handler.');
      expect(rosterCounts(fixture)).toEqual(before);
      expect(fixture.roster()).toMatchObject({ version: 1, reviewers: [] });
      expect(fixture.lifecycle.read(registered.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });

      fixture.sqlite.exec('DROP TRIGGER roster_changeset_fail_record;');
      expect(await commit(fixture, registered.selector, 'atomic-commit')).toMatchObject({
        kind: 'success'
      });
      expect(fixture.roster()).toMatchObject({ version: 2 });
    } finally {
      fixture.close();
    }
  });

  test('denies foreign changeset owner subjects and cross-workspace scopes', async () => {
    const fixture = openRosterFixture();
    try {
      expect(fixture.subjectRelationships.validateSubject({
        sqlite: fixture.sqlite,
        workspaceId,
        eventId: eventId as never,
        userId: organizerUserId,
        subject: {
          kind: 'domain', domain: 'changeset', entity: 'owner', id: 'reviewer_roster'
        },
        evaluatedAt: '2026-08-13T09:00:00.000Z' as never
      })).toMatchObject({ kind: 'valid' });
      for (const denied of [
        { workspace: workspaceId, subjectId: 'review' },
        {
          workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'),
          subjectId: 'reviewer_roster'
        }
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
