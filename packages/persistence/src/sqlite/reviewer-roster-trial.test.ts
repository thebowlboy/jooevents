import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  REVIEWER_CAPABILITY_IDS,
  type ReviewerAuthoritySetDto,
  type ReviewerEligibilityFactDto,
  type ReviewerRosterRecordDto,
  type ReviewerRosterScopeDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import { parseApplicationId } from '@jooevents/kernel';
import {
  applyReviewerRosterMutationPlan,
  createReviewerRosterReviewPlanningSource,
  planReviewerRosterMutation,
  projectReviewerRosterSnapshot,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerScopeTargetFactDigest,
  reviewerScopeTargetSetDigest
} from '@jooevents/review/roster';
import {
  SQLiteReviewerRosterTrialRepository,
  installReviewerRosterTrialSchema
} from './reviewer-roster-trial';
import {
  SQLiteReviewerRosterReviewedCommitTrial,
  installReviewerRosterReviewedCommitTrialSchema
} from './reviewer-roster-reviewed-commit-trial';

const id = (suffix: number) => parseApplicationId(
  'user',
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
);
const scope = { workspaceId: id(1), eventId: id(2) } as ReviewerRosterScopeDto;
const organizerId = id(3);
const reservationA = id(10);
const membershipB = id(11);
const membershipC = id(12);
const membershipLost = id(13);
const reviewerA = id(20);
const reviewerB = id(21);
const reviewerC = id(22);
const reviewerLost = id(23);
const trackActive = id(30);
const trackRetired = id(31);
const formatActive = id(32);
const sessionCollecting = id(33);
const sessionProgrammed = id(34);

describe('SQLite reviewer roster disposable trial', () => {
  test('round-trips a rich roster with invited, active, revoked, lost-authority, generalist, and mixed scopes', () => {
    const target = setup();
    const authority = authoritySet([
      authorityFact('reserved', reservationA, reservationA, 1, 'Ada Invite'),
      authorityFact('active', membershipB, membershipB, 2, 'Bryn Active'),
      authorityFact('active', membershipC, membershipC, 3, 'Casey Revoked'),
      authorityFact('active', membershipLost, membershipLost, 4, 'Drew Temporary')
    ], 1);
    target.sqlite.transaction(() => {
      target.repository.replaceReviewerAuthoritySet(authority);
      target.repository.replaceReviewerScopeTargetSet(targets());
    }).immediate();

    register(target, reviewerA, { kind: 'access_reservation', id: reservationA, version: 1 }, []);
    register(target, reviewerB, { kind: 'workspace_membership', id: membershipB, version: 1 }, [
      { kind: 'track', id: trackActive },
      { kind: 'format', id: formatActive },
      { kind: 'session', id: sessionCollecting }
    ]);
    register(target, reviewerC, { kind: 'workspace_membership', id: membershipC, version: 1 }, [
      { kind: 'track', id: trackActive }
    ]);
    register(target, reviewerLost, { kind: 'workspace_membership', id: membershipLost, version: 1 }, [
      { kind: 'session', id: sessionProgrammed }
    ]);
    mutate(target, {
      action: 'revoke', scope, reviewerId: reviewerC,
      expectedReviewerVersion: 1,
      expectedRosterVersion: target.repository.readReviewerRoster(scope)!.version,
      expectedRosterDigestSha256: target.repository.readReviewerRoster(scope)!.digestSha256
    });
    target.sqlite.transaction(() => {
      target.repository.replaceReviewerAuthoritySet(authoritySet(authority.facts.slice(0, 3), 2));
    }).immediate();

    const reopened = new SQLiteReviewerRosterTrialRepository(target.sqlite);
    const snapshot = projectReviewerRosterSnapshot({ scope, repository: reopened, authority: reopened });
    expect(snapshot?.reviewers.map((reviewer) => [reviewer.reviewerId, reviewer.status])).toEqual([
      [reviewerA, 'invited'],
      [reviewerB, 'active'],
      [reviewerC, 'revoked'],
      [reviewerLost, 'revoked']
    ]);
    expect(snapshot?.reviewers[0]?.reviews).toEqual([]);
    expect(snapshot?.reviewers[1]?.reviews).toEqual([
      { kind: 'track', id: trackActive },
      { kind: 'format', id: formatActive },
      { kind: 'session', id: sessionCollecting }
    ]);
    expect(createReviewerRosterReviewPlanningSource({ repository: reopened, authority: reopened })
      .readReviewerRoster(scope)?.reviewers.map((reviewer) => reviewer.reviewerId))
      .toEqual([reviewerA, reviewerB]);
    target.sqlite.close();
  });

  test('commits through the generic changeset engine with exact permission, atomic evidence, replay, and compensation', () => {
    const compensationAttribution = {
      userId: organizerId,
      occurredAt: '2026-08-13T02:00:00.000Z'
    };
    const target = setup(() => compensationAttribution);
    target.sqlite.transaction(() => {
      target.repository.replaceReviewerAuthoritySet(authoritySet([
        authorityFact('active', membershipB, membershipB, 1, 'Bryn Active')
      ], 1));
      target.repository.replaceReviewerScopeTargetSet(targets());
    }).immediate();
    const reviewed = new SQLiteReviewerRosterReviewedCommitTrial(target.sqlite, target.repository);
    const empty = target.repository.readReviewerRoster(scope)!;
    const proposed = reviewed.draft({
      request: {
        action: 'register', scope, reviewerId: reviewerB,
        accessSubject: { kind: 'workspace_membership', id: membershipB, version: 1 },
        reviews: [{ kind: 'track', id: trackActive }],
        expectedRosterVersion: empty.version,
        expectedRosterDigestSha256: empty.digestSha256
      },
      attribution: { userId: organizerId, occurredAt: '2026-08-13T01:00:00.000Z' },
      ids: { changesetId: id(100), revisionId: id(101) },
      proposerPrincipalKey: 'principal:organizer'
    });

    expect(reviewed.commit({
      commitKey: 'register-bryn-denied', proposed,
      receiptId: id(102), timelineId: id(103), permissionIds: ['event.read'],
      occurredAt: '2026-08-13T01:01:00.000Z'
    })).toEqual({ kind: 'refused', reason: 'access_denied' });
    const committed = reviewed.commit({
      commitKey: 'register-bryn', proposed,
      receiptId: id(102), timelineId: id(103), permissionIds: ['event.manage'],
      occurredAt: '2026-08-13T01:01:00.000Z'
    });
    expect(committed.kind).toBe('committed');
    expect(target.repository.readReviewerRoster(scope)?.reviewers).toHaveLength(1);
    expect(target.sqlite.query(`SELECT count(*) AS count FROM reviewer_roster_trial_timeline`)
      .get() as { count: number }).toEqual({ count: 1 });

    const replay = reviewed.commit({
      commitKey: 'register-bryn', proposed,
      receiptId: id(102), timelineId: id(103), permissionIds: ['event.manage'],
      occurredAt: '2026-08-13T01:01:00.000Z'
    });
    expect(replay).toMatchObject({ kind: 'replayed', receiptId: id(102) });
    expect(target.repository.readReviewerRoster(scope)?.version).toBe(2);

    if (committed.kind !== 'committed') throw new TypeError('expected_commit');
    const compensation = reviewed.planCompensation(committed.source);
    expect(compensation.kind).toBe('exact');
    if (compensation.kind !== 'exact') throw new TypeError('expected_exact_compensation');
    const compensationHead = reviewed.draftCompensation({
      operations: compensation.draft.operations,
      dependencyGroups: compensation.draft.dependencyGroups,
      scope,
      ids: { changesetId: id(104), revisionId: id(105) },
      proposerPrincipalKey: 'principal:organizer',
      occurredAt: compensationAttribution.occurredAt
    });
    expect(reviewed.commit({
      commitKey: 'undo-register-bryn', proposed: compensationHead,
      receiptId: id(106), timelineId: id(107), permissionIds: ['event.manage'],
      occurredAt: '2026-08-13T02:01:00.000Z'
    }).kind).toBe('committed');
    expect(target.repository.readReviewerRoster(scope)?.reviewers[0]?.state).toBe('revoked');
    target.sqlite.close();
  });

  test('rolls roster state and evidence back together after a downstream failure', () => {
    const target = setup();
    target.sqlite.transaction(() => {
      target.repository.replaceReviewerAuthoritySet(authoritySet([
        authorityFact('active', membershipB, membershipB, 1, 'Bryn Active')
      ], 1));
      target.repository.replaceReviewerScopeTargetSet(targets());
    }).immediate();
    const reviewed = new SQLiteReviewerRosterReviewedCommitTrial(target.sqlite, target.repository);
    const empty = target.repository.readReviewerRoster(scope)!;
    const proposed = reviewed.draft({
      request: {
        action: 'register', scope, reviewerId: reviewerB,
        accessSubject: { kind: 'workspace_membership', id: membershipB, version: 1 },
        reviews: [], expectedRosterVersion: empty.version,
        expectedRosterDigestSha256: empty.digestSha256
      },
      attribution: { userId: organizerId, occurredAt: '2026-08-13T03:00:00.000Z' },
      ids: { changesetId: id(200), revisionId: id(201) },
      proposerPrincipalKey: 'principal:organizer'
    });
    expect(() => reviewed.commit({
      commitKey: 'forced-failure', proposed,
      receiptId: id(202), timelineId: id(203), permissionIds: ['event.manage'],
      occurredAt: '2026-08-13T03:01:00.000Z', failAfterApplyForTest: true
    })).toThrow('reviewer_roster_trial_forced_rollback');
    expect(target.repository.readReviewerRoster(scope)?.reviewers).toEqual([]);
    expect(target.repository.readReviewerRoster(scope)?.version).toBe(1);
    expect(target.sqlite.query(`SELECT count(*) AS count FROM reviewer_roster_trial_commit_replays`)
      .get() as { count: number }).toEqual({ count: 0 });
    target.sqlite.close();
  });
});

function setup(compensation?: () => { userId: string; occurredAt: string }) {
  const sqlite = new Database(':memory:', { strict: true });
  installReviewerRosterTrialSchema(sqlite);
  installReviewerRosterReviewedCommitTrialSchema(sqlite);
  const repository = new SQLiteReviewerRosterTrialRepository(sqlite, compensation);
  return { sqlite, repository };
}

function register(
  target: ReturnType<typeof setup>,
  reviewerId: ReturnType<typeof id>,
  accessSubject: ReviewerRosterRecordDto['accessSubject'],
  reviews: ReviewerRosterRecordDto['reviews']
) {
  const roster = target.repository.readReviewerRoster(scope)!;
  mutate(target, {
    action: 'register', scope, reviewerId, accessSubject, reviews,
    expectedRosterVersion: roster.version,
    expectedRosterDigestSha256: roster.digestSha256
  });
}

function mutate(
  target: ReturnType<typeof setup>,
  request: Parameters<typeof planReviewerRosterMutation>[0]
) {
  const plan = planReviewerRosterMutation(request, {
    environment: { repository: target.repository, sources: target.repository },
    attribution: { userId: organizerId, occurredAt: '2026-08-13T00:00:00.000Z' }
  });
  target.sqlite.transaction(() => applyReviewerRosterMutationPlan({
    plan,
    environment: { repository: target.repository, sources: target.repository }
  })).immediate();
}

function authorityFact(
  state: 'reserved' | 'active',
  rosterSubjectId: ReturnType<typeof id>,
  currentSubjectId: ReturnType<typeof id>,
  version: number,
  displayName: string
): ReviewerEligibilityFactDto {
  const kind: 'access_reservation' | 'workspace_membership' = state === 'reserved'
    ? 'access_reservation'
    : 'workspace_membership';
  const unsigned = {
    schemaVersion: 1 as const, scope,
    rosterSubject: { kind, id: rosterSubjectId, version: 1 },
    currentSubject: { kind, id: currentSubjectId, version: 1 },
    state, version,
    capabilityIds: [...REVIEWER_CAPABILITY_IDS] as [
      'event.read', 'speaker.directory.read', 'submission.read',
      'submission.score', 'submission.comment', 'schedule.read'
    ],
    evidenceIds: [`authority:${version}`], displayName
  };
  return { ...unsigned, digestSha256: reviewerAuthorityFactDigest(unsigned) };
}

function authoritySet(
  facts: readonly ReviewerEligibilityFactDto[], version: number
): ReviewerAuthoritySetDto {
  const ordered = [...facts].sort((left, right) => {
    if (left.rosterSubject.kind !== right.rosterSubject.kind) {
      return left.rosterSubject.kind.localeCompare(right.rosterSubject.kind);
    }
    return left.rosterSubject.id.localeCompare(right.rosterSubject.id);
  });
  const unsigned = { schemaVersion: 1 as const, scope, version, facts: ordered };
  return { ...unsigned, digestSha256: reviewerAuthoritySetDigest(unsigned) };
}

function targets(): ReviewerScopeTargetSetDto {
  const raw = [
    { ref: { kind: 'track' as const, id: trackActive }, assignability: 'assignable' as const },
    { ref: { kind: 'track' as const, id: trackRetired }, assignability: 'retained_only' as const },
    { ref: { kind: 'format' as const, id: formatActive }, assignability: 'assignable' as const },
    { ref: { kind: 'session' as const, id: sessionCollecting }, assignability: 'assignable' as const },
    { ref: { kind: 'session' as const, id: sessionProgrammed }, assignability: 'assignable' as const }
  ];
  const targets = raw.map((item, index) => {
    const unsigned = {
      schemaVersion: 1 as const, scope, ref: item.ref,
      version: index + 1, assignability: item.assignability
    };
    return { ...unsigned, digestSha256: reviewerScopeTargetFactDigest(unsigned) };
  });
  const unsigned = { schemaVersion: 1 as const, scope, version: 1, targets };
  return { ...unsigned, digestSha256: reviewerScopeTargetSetDigest(unsigned) };
}
