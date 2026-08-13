import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  applyPreparedChangesetSynchronous,
  createChangeset,
  markChangesetCommitted,
  planChangesetOperationSynchronous,
  prepareChangesetCommitSynchronous,
  proposeChangeset,
  validateExactCommit,
  type ChangesetHead
} from '@jooevents/changesets';
import type {
  ReviewCandidateSnapshotDto,
  ReviewMutationPlanningInput,
  ReviewRosterMemberSnapshotDto,
  ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  reviewDeadlinePinFromReference,
  reviewDueDeadlinePlanningPort,
  reviewDueDeadlineTransactionPort,
  reviewDueDeadlineValidationPort
} from '@jooevents/deadline';
import { planEventCreation } from '@jooevents/event';
import { canonicalJsonText, parseApplicationId, parseOperationReceiptId } from '@jooevents/kernel';
import {
  REVIEW_CORE_CHANGESET_KIND,
  REVIEW_CORE_CHANGESET_VERSION,
  createReviewChangesetBundle,
  expectedReviewAssignmentPairs,
  reviewCandidateSetDigest,
  reviewChangesetReadPort,
  reviewChangesetTransactionPort,
  reviewChangesetValidationPort,
  reviewRosterSetDigest,
  type ReviewChangesetTransactionPort
} from '@jooevents/review';
import { installDeadlineSchema, SQLiteDeadlineRepository } from './deadline';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import { installReviewTrialSchema, SQLiteReviewTrialRepository } from './review-trial';

const applicationId = (value: string) => parseApplicationId('event', value);
const workspaceId = applicationId('550e8400-e29b-41d4-a716-446655440000');
const eventId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa121');
const userId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa221');
const roundId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa401');
const deadlineId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa402');
const criterionId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa403');
const submissionId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa404');
const reviewerId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa405');
const otherDeadlineId = applicationId('019c1df7-86b5-769b-bba4-5f7097bfa406');
const scope: ReviewScopeDto = { workspaceId, eventId };
const deadlineDate = '2026-08-31';
const openedAt = '2026-08-13T09:00:00.000Z';

const candidates: readonly ReviewCandidateSnapshotDto[] = [
  { submissionId, version: 1 }
];
const reviewers: readonly ReviewRosterMemberSnapshotDto[] = [
  { reviewerId, version: 1, status: 'active', scope: [] }
];

/** Disposable replay evidence proving the commit ceremony is idempotent. */
const REPLAY_SQL = `
CREATE TABLE review_open_trial_commit_replays (
  commit_key TEXT PRIMARY KEY CHECK(length(commit_key) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE CHECK(length(receipt_id) = 36),
  changeset_id TEXT NOT NULL CHECK(length(changeset_id) = 36),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_digest_sha256 TEXT NOT NULL CHECK(length(revision_digest_sha256) = 64),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;
`;

interface Fixture {
  readonly sqlite: Database;
  readonly reviews: SQLiteReviewTrialRepository;
  readonly deadlines: SQLiteDeadlineRepository;
  readonly reviewPort: ReviewChangesetTransactionPort;
  readonly close: () => void;
}

function setup(): Fixture {
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
  `);
  installEventSpineSchema(sqlite);
  installDeadlineSchema(sqlite);
  installReviewTrialSchema(sqlite);
  sqlite.exec(REPLAY_SQL);
  const spine = new SQLiteEventSpineRepository(sqlite);
  transaction(sqlite, () => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Review Round Event',
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
  const reviews = new SQLiteReviewTrialRepository(sqlite);
  const deadlines = new SQLiteDeadlineRepository(sqlite, spine);
  const reviewPort: ReviewChangesetTransactionPort = {
    readCatalog: (requested) => reviews.readCatalog(requested),
    readRound: (requested, id) => reviews.readRound(requested, id),
    listAssignments: (requested, id) => reviews.listAssignments(requested, id),
    readAssignment: (requested, id) => reviews.readAssignment(requested, id),
    readDraft: (requested, id) => reviews.readDraft(requested, id),
    readReviewHead: (requested, id) => reviews.readReviewHead(requested, id),
    readRevision: (requested, id) => reviews.readRevision(requested, id),
    listRevisions: (requested, id) => reviews.listRevisions(requested, id),
    applyCatalog: (input) => reviews.applyCatalog(input),
    insertRound: (round) => reviews.insertRound(round),
    updateRound: (input) => reviews.updateRound(input),
    insertAssignments: (assignments) => reviews.insertAssignments(assignments),
    updateAssignment: (input) => reviews.updateAssignment(input),
    saveDraft: (input) => reviews.saveDraft(input),
    insertFirstReview: (input) => reviews.insertFirstReview(input),
    appendReviewRevision: (input) => reviews.appendReviewRevision(input),
    readCandidates: (requested) => sameScope(requested) ? { version: 1, candidates } : undefined,
    readCandidate: (requested, submission) => sameScope(requested)
      ? candidates.find((candidate) => candidate.submissionId === submission)
      : undefined,
    readReviewerRoster: (requested) => sameScope(requested) ? { version: 1, reviewers } : undefined,
    resolveReviewDeadline: (requested, requestedDeadlineId) => {
      const head = deadlines.readDeadline(requested, requestedDeadlineId);
      if (!head || head.kind !== 'review_due' || head.status !== 'active') return undefined;
      const pin = deadlines.resolveCurrentDeadline(requested, { deadlineId: requestedDeadlineId });
      return pin ? reviewDeadlinePinFromReference(pin) : undefined;
    }
  };
  return { sqlite, reviews, deadlines, reviewPort, close: () => sqlite.close() };
}

function sameScope(value: { readonly workspaceId: string; readonly eventId: string }) {
  return value.workspaceId === workspaceId && value.eventId === eventId;
}

function openRoundInput(): ReviewMutationPlanningInput {
  const pairs = expectedReviewAssignmentPairs({ candidates, reviewers });
  return {
    action: 'open_round',
    scope,
    expectedCatalogVersion: 1,
    roundId,
    deadlineIdentity: { deadlineId },
    deadlineDate,
    criteria: [{
      id: criterionId, key: 'overall', label: 'Overall',
      position: 0, weightBps: 10_000, scaleMin: 1, scaleMax: 5
    }],
    visibility: {
      participantIdentity: 'hidden',
      peerReviewerIdentity: 'hidden',
      peerContentUnlock: 'after_own_commit'
    },
    assignmentIds: pairs.map((pair, index) => ({
      ...pair,
      assignmentId: applicationId(
        `019c1df7-86b5-769b-bba4-5f7097bfa5${index.toString(16).padStart(2, '0')}`
      )
    })),
    attributedByUserId: userId,
    attributedAt: openedAt
  };
}

const bundle = createReviewChangesetBundle();

function draftAndPropose(fixture: Fixture, ids: {
  readonly changesetId: string;
  readonly revisionId: string;
}): ChangesetHead {
  const operation = planChangesetOperationSynchronous({
    registry: bundle.registry,
    kind: REVIEW_CORE_CHANGESET_KIND,
    version: REVIEW_CORE_CHANGESET_VERSION,
    authorInput: openRoundInput(),
    dependencyGroup: 'review',
    snapshot: {
      getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
        if ((key as unknown) === reviewChangesetReadPort) {
          return fixture.reviewPort as unknown as Port;
        }
        if ((key as unknown) === reviewDueDeadlinePlanningPort) {
          return fixture.deadlines as unknown as Port;
        }
        throw new TypeError('unexpected_review_collaboration_read_port');
      }
    }
  });
  const draft = createChangeset({ id: ids.changesetId, workspaceId, eventId }, {
    id: ids.revisionId,
    createdAt: openedAt,
    proposerPrincipalKey: 'principal:organizer',
    origin: 'human_ui',
    operations: [operation],
    dependencyGroups: [{ key: 'review', dependsOn: [] }],
    approvalPolicy: { key: 'review-open-round', version: 1 }
  });
  return proposeChangeset(draft, draft.version);
}

function currentEvidence(fixture: Fixture) {
  const catalog = fixture.reviews.readCatalog(scope);
  const deadlineCatalog = fixture.deadlines.readDeadlineCatalog(scope);
  const eventBasis = fixture.deadlines.readDeadlineEventTimeBasis(scope);
  if (!catalog || !deadlineCatalog || !eventBasis) throw new TypeError('trial_state_missing');
  return {
    aggregateVersions: new Map<string, number>([
      [`review_catalog:${eventId}`, catalog.version],
      [`event:${eventId}`, eventBasis.eventVersion]
    ]),
    guardVersions: new Map<string, number>([
      [`review_catalog:${eventId}`, catalog.version],
      [`review_candidates:${eventId}`, 1],
      [`review_reviewers:${eventId}`, 1],
      [`deadline_catalog:${eventId}`, deadlineCatalog.version]
    ]),
    guardDigests: new Map<string, string>([
      [`review_catalog:${eventId}`, catalog.digestSha256],
      [`review_candidates:${eventId}`, reviewCandidateSetDigest(candidates)],
      [`review_reviewers:${eventId}`, reviewRosterSetDigest(reviewers)],
      [`deadline_catalog:${eventId}`, deadlineCatalog.digestSha256]
    ])
  };
}

type CommitResult =
  | { readonly kind: 'committed'; readonly head: ChangesetHead; readonly facts: readonly unknown[] }
  | { readonly kind: 'replayed'; readonly receiptId: string; readonly facts: readonly unknown[] }
  | { readonly kind: 'refused'; readonly reason: string };

function commitProposed(fixture: Fixture, input: {
  readonly commitKey: string;
  readonly proposed: ChangesetHead;
  readonly receiptId: string;
  readonly occurredAt: string;
}): CommitResult {
  const replay = fixture.sqlite.query<{
    receipt_id: string; changeset_id: string; revision_id: string;
    revision_digest_sha256: string; facts_json: string
  }, [string]>(`
    SELECT receipt_id, changeset_id, revision_id, revision_digest_sha256, facts_json
      FROM review_open_trial_commit_replays WHERE commit_key = ? LIMIT 1
  `).get(input.commitKey);
  const revision = input.proposed.revisions.at(-1);
  if (!revision) throw new TypeError('trial_revision_missing');
  if (replay) {
    if (replay.changeset_id !== input.proposed.id
        || replay.revision_id !== revision.id
        || replay.revision_digest_sha256 !== revision.digest) {
      return { kind: 'refused', reason: 'replay_request_changed' };
    }
    return {
      kind: 'replayed',
      receiptId: replay.receipt_id,
      facts: JSON.parse(replay.facts_json) as unknown[]
    };
  }
  const evidence = currentEvidence(fixture);
  const validation = validateExactCommit(input.proposed, {
    expectedHeadVersion: input.proposed.version,
    expectedRevisionDigest: revision.digest,
    currentAggregateVersions: evidence.aggregateVersions,
    currentGuardVersions: evidence.guardVersions,
    currentGuardDigests: evidence.guardDigests,
    now: input.occurredAt,
    approvalRequirement: 'none'
  });
  if (validation.kind !== 'ready') {
    return { kind: 'refused', reason: validation.refusal.kind };
  }
  return fixture.sqlite.transaction(() => {
    const prepared = prepareChangesetCommitSynchronous({
      registry: bundle.registry,
      authorization: validation.authorization,
      transaction: {
        getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
          if ((key as unknown) === reviewChangesetValidationPort
              || (key as unknown) === reviewChangesetTransactionPort) {
            return fixture.reviewPort as unknown as Port;
          }
          if ((key as unknown) === reviewDueDeadlineValidationPort
              || (key as unknown) === reviewDueDeadlineTransactionPort) {
            return fixture.deadlines as unknown as Port;
          }
          throw new TypeError('unexpected_review_collaboration_commit_port');
        }
      }
    });
    if (prepared.kind !== 'ready') {
      return { kind: 'refused' as const, reason: prepared.outcome.kind };
    }
    const contributions = applyPreparedChangesetSynchronous(prepared.prepared);
    const contribution = contributions[0];
    if (!contribution) throw new TypeError('trial_contribution_missing');
    const receiptId = parseOperationReceiptId(input.receiptId);
    const marked = markChangesetCommitted(input.proposed, validation.authorization, receiptId);
    fixture.sqlite.query(`
      INSERT INTO review_open_trial_commit_replays(
        commit_key, receipt_id, changeset_id, revision_id, revision_digest_sha256,
        result_json, facts_json, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.commitKey, receiptId, input.proposed.id, revision.id, revision.digest,
      canonicalJsonText(contribution.result), canonicalJsonText(contribution.facts),
      Date.parse(input.occurredAt)
    );
    return { kind: 'committed' as const, head: marked.head, facts: contribution.facts };
  }).immediate();
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

describe('SQLite Review round and canonical review_due Deadline collaboration', () => {
  test('opens the round and creates its review_due Deadline in one committed unit of work, then replays idempotently', () => {
    const fixture = setup();
    try {
      const proposed = draftAndPropose(fixture, {
        changesetId: '019c1df7-86b5-769b-bba4-5f7097bfa601',
        revisionId: '019c1df7-86b5-769b-bba4-5f7097bfa602'
      });
      expect(proposed.status).toBe('proposed');
      expect(fixture.deadlines.readDeadline(scope, deadlineId)).toBeUndefined();
      expect(fixture.deadlines.readDeadlineCatalog(scope)?.version).toBe(1);

      const committed = commitProposed(fixture, {
        commitKey: 'open-round',
        proposed,
        receiptId: '019c1df7-86b5-769b-bba4-5f7097bfa603',
        occurredAt: '2026-08-13T09:01:00.000Z'
      });
      expect(committed.kind).toBe('committed');
      if (committed.kind !== 'committed') throw new TypeError('expected_commit');
      expect(committed.head.status).toBe('committed');

      const reopenedReviews = new SQLiteReviewTrialRepository(fixture.sqlite);
      const catalog = reopenedReviews.readCatalog(scope);
      expect(catalog?.version).toBe(2);
      expect(catalog?.rounds).toHaveLength(1);
      expect(catalog?.rounds[0]).toMatchObject({
        id: roundId,
        state: 'open',
        deadline: {
          deadlineId,
          kind: 'review_due',
          version: 1,
          effectiveAt: '2026-09-01T00:00:00.000Z'
        }
      });
      expect(reopenedReviews.listAssignments(scope, roundId)).toHaveLength(1);
      expect(fixture.deadlines.readDeadline(scope, deadlineId)).toMatchObject({
        id: deadlineId,
        kind: 'review_due',
        status: 'active',
        version: 1,
        displayDate: deadlineDate,
        effectiveAt: '2026-09-01T00:00:00.000Z'
      });
      expect(fixture.deadlines.readDeadlineCatalog(scope)).toMatchObject({
        version: 2,
        deadlines: [{ id: deadlineId, kind: 'review_due', version: 1 }]
      });
      expect(committed.facts).toEqual([
        {
          kind: 'review_round_opened', version: 1,
          payload: { roundId, assignmentCount: 1 }
        },
        {
          kind: 'deadline_changed', version: 1,
          payload: {
            action: 'create', deadlineId, version: 1, status: 'active',
            displayDate: deadlineDate, effectiveAt: '2026-09-01T00:00:00.000Z'
          }
        }
      ]);

      const replayed = commitProposed(fixture, {
        commitKey: 'open-round',
        proposed,
        receiptId: '019c1df7-86b5-769b-bba4-5f7097bfa603',
        occurredAt: '2026-08-13T09:02:00.000Z'
      });
      expect(replayed).toMatchObject({
        kind: 'replayed',
        receiptId: '019c1df7-86b5-769b-bba4-5f7097bfa603'
      });
      if (replayed.kind !== 'replayed') throw new TypeError('expected_replay');
      expect(replayed.facts).toEqual(committed.facts as unknown[]);
      expect(fixture.reviews.readCatalog(scope)?.version).toBe(2);
      expect(fixture.deadlines.readDeadlineCatalog(scope)?.version).toBe(2);
      expect(fixture.reviews.readCatalog(scope)?.rounds).toHaveLength(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a stale Deadline catalog without writing either domain', () => {
    const fixture = setup();
    try {
      const proposed = draftAndPropose(fixture, {
        changesetId: '019c1df7-86b5-769b-bba4-5f7097bfa611',
        revisionId: '019c1df7-86b5-769b-bba4-5f7097bfa612'
      });
      // A concurrent Deadline commit advances the deadline catalog after propose.
      transaction(fixture.sqlite, () => fixture.deadlines.applyFormCloseDeadline(
        fixture.deadlines.planFormCloseDeadlineChange({
          scope,
          currentDeadlineId: null,
          closesAt: '2026-10-01',
          identity: { deadlineId: otherDeadlineId },
          attribution: { userId, at: '2026-08-13T09:03:00.000Z' }
        })
      ));
      expect(fixture.deadlines.readDeadlineCatalog(scope)?.version).toBe(2);

      const refused = commitProposed(fixture, {
        commitKey: 'open-round-stale',
        proposed,
        receiptId: '019c1df7-86b5-769b-bba4-5f7097bfa613',
        occurredAt: '2026-08-13T09:04:00.000Z'
      });
      expect(refused).toEqual({ kind: 'refused', reason: 'guard_changed' });
      expect(proposed.status).toBe('proposed');
      expect(fixture.reviews.readCatalog(scope)?.version).toBe(1);
      expect(fixture.reviews.readCatalog(scope)?.rounds).toEqual([]);
      expect(fixture.reviews.readRound(scope, roundId)).toBeUndefined();
      expect(fixture.deadlines.readDeadline(scope, deadlineId)).toBeUndefined();
      expect(fixture.sqlite.query(`SELECT count(*) AS count FROM review_open_trial_commit_replays`)
        .get() as { count: number }).toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });

  test('rolls the created Deadline back when the later Review round write fails and the changeset stays proposed', () => {
    const fixture = setup();
    try {
      const proposed = draftAndPropose(fixture, {
        changesetId: '019c1df7-86b5-769b-bba4-5f7097bfa621',
        revisionId: '019c1df7-86b5-769b-bba4-5f7097bfa622'
      });
      fixture.sqlite.exec(`
        CREATE TRIGGER review_deadline_collaboration_fail_round
        BEFORE INSERT ON review_rounds
        BEGIN SELECT RAISE(ABORT, 'injected later Review round failure'); END;
      `);
      // The trial repository wraps the injected SQLite abort in its own typed
      // error; the rollback proof is the untouched state asserted below.
      expect(() => commitProposed(fixture, {
        commitKey: 'open-round-rollback',
        proposed,
        receiptId: '019c1df7-86b5-769b-bba4-5f7097bfa623',
        occurredAt: '2026-08-13T09:05:00.000Z'
      })).toThrow('identity_collision');
      expect(proposed.status).toBe('proposed');
      expect(fixture.deadlines.readDeadline(scope, deadlineId)).toBeUndefined();
      expect(fixture.deadlines.readDeadlineCatalog(scope)?.version).toBe(1);
      expect(fixture.reviews.readCatalog(scope)?.version).toBe(1);
      expect(fixture.reviews.readRound(scope, roundId)).toBeUndefined();
      expect(fixture.sqlite.query(`SELECT count(*) AS count FROM review_open_trial_commit_replays`)
        .get() as { count: number }).toEqual({ count: 0 });

      // The untouched proposed changeset commits cleanly once the failure clears.
      fixture.sqlite.exec('DROP TRIGGER review_deadline_collaboration_fail_round;');
      const committed = commitProposed(fixture, {
        commitKey: 'open-round-rollback',
        proposed,
        receiptId: '019c1df7-86b5-769b-bba4-5f7097bfa623',
        occurredAt: '2026-08-13T09:06:00.000Z'
      });
      expect(committed.kind).toBe('committed');
      expect(fixture.deadlines.readDeadline(scope, deadlineId)?.kind).toBe('review_due');
      expect(fixture.reviews.readCatalog(scope)?.version).toBe(2);
    } finally {
      fixture.close();
    }
  });
});
