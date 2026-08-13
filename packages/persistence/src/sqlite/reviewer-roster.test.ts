import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ChangesetPlanningSnapshot } from '@jooevents/changesets';
import {
  REVIEWER_CAPABILITY_IDS,
  type ReviewerAuthoritySetDto,
  type ReviewerAuthoritySubjectRefDto,
  type ReviewerEligibilityFactDto,
  type ReviewerRosterScopeDto,
  type ReviewerScopeRefDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import { parseApplicationId } from '@jooevents/kernel';
import {
  applyReviewerRosterMutationPlan,
  createReviewerRosterChangesetBundle,
  planReviewerRosterMutation,
  projectReviewerRosterSnapshot,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerRosterChangesetReadPort,
  reviewerScopeTargetFactDigest,
  reviewerScopeTargetSetDigest,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import {
  installReviewerRosterSchema,
  SQLiteReviewerRosterRepository
} from './reviewer-roster';

const id = (suffix: number) => parseApplicationId(
  'user',
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
);
const scope = { workspaceId: id(1), eventId: id(2) } as ReviewerRosterScopeDto;
const unknownScope = { workspaceId: id(1), eventId: id(3) } as ReviewerRosterScopeDto;
const organizerId = id(4);
const reservationA = id(10);
const membershipB = id(11);
const reviewerA = id(20);
const reviewerB = id(21);
const reviewerDuplicate = id(22);
const trackActive = id(30);
const trackRetired = id(31);
const attribution = { userId: organizerId, occurredAt: '2026-08-13T01:00:00.000Z' };

function authorityFact(
  state: 'reserved' | 'active',
  subjectId: ReturnType<typeof id>,
  displayName: string
): ReviewerEligibilityFactDto {
  const kind: 'access_reservation' | 'workspace_membership' = state === 'reserved'
    ? 'access_reservation'
    : 'workspace_membership';
  const unsigned = {
    schemaVersion: 1 as const, scope,
    rosterSubject: { kind, id: subjectId, version: 1 },
    currentSubject: { kind, id: subjectId, version: 1 },
    state, version: 1,
    capabilityIds: [...REVIEWER_CAPABILITY_IDS] as [
      'event.read', 'speaker.directory.read', 'submission.read',
      'submission.score', 'submission.comment', 'schedule.read'
    ],
    evidenceIds: [`authority:${subjectId}`], displayName
  };
  return { ...unsigned, digestSha256: reviewerAuthorityFactDigest(unsigned) };
}

function authoritySet(): ReviewerAuthoritySetDto {
  const facts = [
    authorityFact('reserved', reservationA, 'Ada Invite'),
    authorityFact('active', membershipB, 'Bryn Active')
  ];
  const unsigned = { schemaVersion: 1 as const, scope, version: 1, facts };
  return { ...unsigned, digestSha256: reviewerAuthoritySetDigest(unsigned) };
}

function targetSet(): ReviewerScopeTargetSetDto {
  const targets = [
    { ref: { kind: 'track' as const, id: trackActive }, assignability: 'assignable' as const },
    { ref: { kind: 'track' as const, id: trackRetired }, assignability: 'retained_only' as const }
  ].map((item, index) => {
    const unsigned = {
      schemaVersion: 1 as const, scope, ref: item.ref,
      version: index + 1, assignability: item.assignability
    };
    return { ...unsigned, digestSha256: reviewerScopeTargetFactDigest(unsigned) };
  });
  const unsigned = { schemaVersion: 1 as const, scope, version: 1, targets };
  return { ...unsigned, digestSha256: reviewerScopeTargetSetDigest(unsigned) };
}

const sources: ReviewerRosterPlanningSource = Object.freeze({
  readReviewerAuthority: () => authoritySet(),
  readReviewerScopeTargets: () => targetSet()
});

function setup(compensation?: () => typeof attribution | undefined) {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE event_spine_scope_roots (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO event_spine_scope_roots (workspace_id, event_id)
      VALUES ('${scope.workspaceId}', '${scope.eventId}');
  `);
  installReviewerRosterSchema(sqlite);
  const repository = new SQLiteReviewerRosterRepository(sqlite, sources, compensation);
  return { sqlite, repository };
}

function mutate(
  target: ReturnType<typeof setup>,
  request: Parameters<typeof planReviewerRosterMutation>[0]
) {
  const plan = planReviewerRosterMutation(request, {
    environment: { repository: target.repository, sources: target.repository },
    attribution
  });
  target.sqlite.transaction(() => applyReviewerRosterMutationPlan({
    plan,
    environment: { repository: target.repository, sources: target.repository }
  })).immediate();
  return plan;
}

function register(
  target: ReturnType<typeof setup>,
  reviewerId: ReturnType<typeof id>,
  accessSubject: ReviewerAuthoritySubjectRefDto,
  reviews: ReviewerScopeRefDto[]
) {
  const roster = target.repository.readReviewerRoster(scope)!;
  return mutate(target, {
    action: 'register', scope, reviewerId, accessSubject, reviews,
    expectedRosterVersion: roster.version,
    expectedRosterDigestSha256: roster.digestSha256
  });
}

function snapshotFor(port: SQLiteReviewerRosterRepository): ChangesetPlanningSnapshot {
  return Object.freeze({
    getPort: <Port>(key: { readonly key: string; readonly version: number }): Port => {
      if (key !== reviewerRosterChangesetReadPort) {
        throw new TypeError('unexpected_reviewer_roster_read_port');
      }
      return port as unknown as Port;
    }
  });
}

describe('SQLite reviewer roster repository', () => {
  test('round-trips register, set_scope, revoke, and restore through the roster domain', () => {
    const target = setup();
    expect(target.repository.readReviewerRoster(scope)).toMatchObject({ version: 1, reviewers: [] });
    register(target, reviewerA, { kind: 'access_reservation', id: reservationA, version: 1 }, []);
    register(target, reviewerB, { kind: 'workspace_membership', id: membershipB, version: 1 }, [
      { kind: 'track', id: trackActive }
    ]);
    mutate(target, {
      action: 'set_scope', scope, reviewerId: reviewerB,
      expectedReviewerVersion: 1, reviews: [],
      expectedRosterVersion: target.repository.readReviewerRoster(scope)!.version,
      expectedRosterDigestSha256: target.repository.readReviewerRoster(scope)!.digestSha256
    });
    mutate(target, {
      action: 'revoke', scope, reviewerId: reviewerA,
      expectedReviewerVersion: 1,
      expectedRosterVersion: target.repository.readReviewerRoster(scope)!.version,
      expectedRosterDigestSha256: target.repository.readReviewerRoster(scope)!.digestSha256
    });
    mutate(target, {
      action: 'restore', scope, reviewerId: reviewerA,
      expectedReviewerVersion: 2,
      expectedRosterVersion: target.repository.readReviewerRoster(scope)!.version,
      expectedRosterDigestSha256: target.repository.readReviewerRoster(scope)!.digestSha256
    });

    const reopened = new SQLiteReviewerRosterRepository(target.sqlite, sources);
    const roster = reopened.readReviewerRoster(scope)!;
    expect(roster.version).toBe(6);
    expect(roster.reviewers.map((reviewer) => [reviewer.reviewerId, reviewer.state, reviewer.version]))
      .toEqual([[reviewerA, 'included', 3], [reviewerB, 'included', 2]]);
    expect(roster.reviewers[1]?.reviews).toEqual([]);
    const snapshot = projectReviewerRosterSnapshot({
      scope, repository: reopened, authority: reopened
    });
    expect(snapshot?.reviewers.map((reviewer) => [reviewer.reviewerId, reviewer.status])).toEqual([
      [reviewerA, 'invited'],
      [reviewerB, 'active']
    ]);
    target.sqlite.close();
  });

  test('retains records, keeps identity immutable, and refuses duplicate access subjects', () => {
    const target = setup();
    register(target, reviewerA, { kind: 'access_reservation', id: reservationA, version: 1 }, []);
    expect(() => target.sqlite.query(`
      UPDATE reviewer_roster_records SET reviewer_id = ? WHERE reviewer_id = ?
    `).run(reviewerDuplicate, reviewerA)).toThrow('reviewer roster identity is immutable');
    expect(() => target.sqlite.query(`
      DELETE FROM reviewer_roster_records WHERE reviewer_id = ?
    `).run(reviewerA)).toThrow('reviewer roster records are retained');
    // Planning refuses the duplicate subject typed before any write reaches
    // the retained-records UNIQUE constraint, which stays behind it as the
    // storage backstop.
    expect(() => register(
      target, reviewerDuplicate, { kind: 'access_reservation', id: reservationA, version: 1 }, []
    )).toThrow('reviewer_exists');
    expect(target.repository.readReviewerRoster(scope)?.reviewers).toHaveLength(1);
    target.sqlite.close();
  });

  test('binds writes to a transaction, an established scope root, and fresh state', () => {
    const target = setup();
    const plan = planReviewerRosterMutation({
      action: 'register', scope, reviewerId: reviewerA,
      accessSubject: { kind: 'access_reservation', id: reservationA, version: 1 },
      reviews: [],
      expectedRosterVersion: 1,
      expectedRosterDigestSha256: target.repository.readReviewerRoster(scope)!.digestSha256
    }, {
      environment: { repository: target.repository, sources: target.repository },
      attribution
    });
    expect(() => target.repository.applyReviewerRosterPlan(plan)).toThrow('transaction_required');

    target.sqlite.exec('BEGIN IMMEDIATE');
    target.repository.applyReviewerRosterPlan(plan);
    target.sqlite.exec('ROLLBACK');
    expect(target.repository.readReviewerRoster(scope)?.version).toBe(1);

    target.sqlite.transaction(() => target.repository.applyReviewerRosterPlan(plan)).immediate();
    expect(target.repository.readReviewerRoster(scope)?.version).toBe(2);
    expect(() => target.sqlite.transaction(
      () => target.repository.applyReviewerRosterPlan(plan)
    ).immediate()).toThrow('stale_roster');

    // The unknown scope reads as an empty roster, but its plan cannot commit
    // without an established event scope root.
    const unknownSources: ReviewerRosterPlanningSource = Object.freeze({
      readReviewerAuthority: () => {
        const facts = [{
          ...authorityFact('reserved', reservationA, 'Ada Invite'),
          scope: unknownScope,
          rosterSubject: { kind: 'access_reservation' as const, id: reservationA, version: 1 },
          currentSubject: { kind: 'access_reservation' as const, id: reservationA, version: 1 }
        }].map((fact) => {
          const { digestSha256: _digest, ...unsigned } = fact;
          return { ...unsigned, digestSha256: reviewerAuthorityFactDigest(unsigned) };
        });
        const unsigned = { schemaVersion: 1 as const, scope: unknownScope, version: 1, facts };
        return { ...unsigned, digestSha256: reviewerAuthoritySetDigest(unsigned) };
      },
      readReviewerScopeTargets: () => {
        const unsigned = {
          schemaVersion: 1 as const, scope: unknownScope, version: 1, targets: []
        };
        return { ...unsigned, digestSha256: reviewerScopeTargetSetDigest(unsigned) };
      }
    });
    const unknownRepository = new SQLiteReviewerRosterRepository(target.sqlite, unknownSources);
    const unknownPlan = planReviewerRosterMutation({
      action: 'register', scope: unknownScope, reviewerId: reviewerA,
      accessSubject: { kind: 'access_reservation', id: reservationA, version: 1 },
      reviews: [],
      expectedRosterVersion: 1,
      expectedRosterDigestSha256: unknownRepository.readReviewerRoster(unknownScope)!.digestSha256
    }, {
      environment: { repository: unknownRepository, sources: unknownRepository },
      attribution
    });
    expect(() => target.sqlite.transaction(
      () => unknownRepository.applyReviewerRosterPlan(unknownPlan)
    ).immediate()).toThrow('identity_collision');
    target.sqlite.close();
  });

  test('compensation stays blocked without the attribution resolver and derives exactly with it', () => {
    const target = setup(() => attribution);
    const plan = register(
      target, reviewerA, { kind: 'access_reservation', id: reservationA, version: 1 }, []
    );
    const bundle = createReviewerRosterChangesetBundle();
    const unattributed = new SQLiteReviewerRosterRepository(target.sqlite, sources);
    expect(bundle.definition.deriveCompensation(plan, snapshotFor(unattributed))).toEqual({
      kind: 'blocked',
      reasonKey: 'reviewer_roster.fresh_attribution_required'
    });
    expect(unattributed.readReviewerRosterCompensationAttribution(scope)).toBeUndefined();
    expect(target.repository.readReviewerRosterCompensationAttribution(scope)).toEqual(attribution);
    const derivation = bundle.definition.deriveCompensation(plan, snapshotFor(target.repository));
    expect(derivation).toMatchObject({
      kind: 'exact',
      authorInput: {
        request: { action: 'revoke', reviewerId: reviewerA },
        attribution
      }
    });
    target.sqlite.close();
  });
});
