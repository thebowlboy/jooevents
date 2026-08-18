import { describe, expect, test } from 'bun:test';
import {
  REVIEWER_CAPABILITY_IDS,
  reviewerRosterMutationResultSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerEligibilityFactDto,
  type ReviewerRosterMutationPlanDto,
  type ReviewerRosterRecordDto,
  type ReviewerRosterScopeDto,
  type ReviewerRosterStateDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import {
  createEmptyReviewerRoster,
  createReviewerRosterReviewPlanningSource,
  planReviewerRosterMutation,
  projectReviewerRosterSnapshot,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  reviewerRosterDigest,
  reviewerScopeTargetFactDigest,
  reviewerScopeTargetSetDigest,
  validateReviewerRosterMutationPlan
} from './roster-domain';

const id = (tail: string) =>
  `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as ReviewerRosterRecordDto['reviewerId'];
const scope = { workspaceId: id('1'), eventId: id('2') } as ReviewerRosterScopeDto;
const organizerId = id('3');
const reviewerOne = id('10');
const reviewerTwo = id('11');
const reviewerThree = id('12');
const reservationOne = id('20');
const membershipTwo = id('21');
const membershipThree = id('22');
const trackRetired = id('30');
const formatActive = id('31');
const sessionActive = id('32');
const occurredAt = '2026-08-13T00:00:00.000Z';

describe('reviewer roster domain', () => {
  test('projects truthful invited, active, and revoked states without email identity', () => {
    const roster = rosterState([
      record(reviewerOne, { kind: 'access_reservation', id: reservationOne, version: 2 }, []),
      record(reviewerTwo, { kind: 'workspace_membership', id: membershipTwo, version: 3 }, [
        { kind: 'format', id: formatActive }
      ]),
      record(reviewerThree, { kind: 'workspace_membership', id: membershipThree, version: 4 }, [])
    ]);
    const authority = authoritySet([
      authorityFact({
        rosterSubject: { kind: 'access_reservation', id: reservationOne, version: 2 },
        currentSubject: { kind: 'access_reservation', id: reservationOne, version: 2 },
        state: 'reserved', version: 4, displayName: 'Invited reviewer'
      }),
      authorityFact({
        rosterSubject: { kind: 'workspace_membership', id: membershipTwo, version: 3 },
        currentSubject: { kind: 'workspace_membership', id: membershipTwo, version: 3 },
        state: 'active', version: 8, displayName: 'Active reviewer'
      })
    ], 5);
    const repository = new MemoryRosterPort(roster, authority, targetSet());

    const snapshot = projectReviewerRosterSnapshot({ scope, repository, authority: repository });
    expect(snapshot?.reviewers.map(({ reviewerId, status }) => ({ reviewerId, status }))).toEqual([
      { reviewerId: reviewerOne, status: 'invited' },
      { reviewerId: reviewerTwo, status: 'active' },
      { reviewerId: reviewerThree, status: 'revoked' }
    ]);
    const planning = createReviewerRosterReviewPlanningSource({
      repository,
      authority: repository
    }).readReviewerRoster(scope);
    expect(planning?.reviewers.map(({ reviewerId, status }) => ({ reviewerId, status }))).toEqual([
      { reviewerId: reviewerOne, status: 'invited' },
      { reviewerId: reviewerTwo, status: 'active' }
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('@');
  });

  test('projects exact canonical scope counts from the full Review candidate population', () => {
    const roster = rosterState([]);
    const authority = authoritySet([], 5);
    const repository = new MemoryRosterPort(roster, authority, targetSet());
    const withoutPopulation = projectReviewerRosterSnapshot({
      scope,
      repository,
      authority: repository
    })!;
    const snapshot = projectReviewerRosterSnapshot({
      scope,
      repository,
      authority: repository,
      candidatePopulation: {
        readCandidates(requestedScope) {
          expect(requestedScope).toEqual(scope);
          return {
            version: 17,
            candidates: [
              {
                submissionId: id('40'), version: 1, trackId: trackRetired,
                formatId: formatActive, targetSessionId: sessionActive
              },
              { submissionId: id('41'), version: 1, trackId: trackRetired },
              { submissionId: id('42'), version: 1 }
            ]
          };
        }
      }
    })!;

    expect(snapshot.coveragePopulation).toMatchObject({
      schemaVersion: 1,
      candidateVersion: 17,
      candidateCount: 3,
      counts: [
        { ref: { kind: 'track', id: trackRetired }, submissions: 2 },
        { ref: { kind: 'format', id: formatActive }, submissions: 1 },
        { ref: { kind: 'session', id: sessionActive }, submissions: 1 }
      ]
    });
    expect(snapshot.coveragePopulation?.digestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.version).not.toBe(withoutPopulation.version);
    expect(snapshot.digestSha256).not.toBe(withoutPopulation.digestSha256);
  });

  test('binds Review hand-out versions to exact authority evidence', () => {
    const roster = rosterState([
      record(reviewerTwo, { kind: 'workspace_membership', id: membershipTwo, version: 3 }, [])
    ]);
    const firstFact = authorityFact({
      rosterSubject: { kind: 'workspace_membership', id: membershipTwo, version: 3 },
      currentSubject: { kind: 'workspace_membership', id: membershipTwo, version: 3 },
      state: 'active', version: 8, displayName: 'Same name'
    });
    const port = new MemoryRosterPort(roster, authoritySet([firstFact], 5), targetSet());
    const adapter = createReviewerRosterReviewPlanningSource({ repository: port, authority: port });
    const before = adapter.readReviewerRoster(scope)!;
    port.authority = authoritySet([authorityFact({
      rosterSubject: { kind: 'workspace_membership', id: membershipTwo, version: 4 },
      currentSubject: { kind: 'workspace_membership', id: membershipTwo, version: 4 },
      state: 'active', version: 9, displayName: 'Same name'
    })], 6);
    const after = adapter.readReviewerRoster(scope)!;

    expect(after.reviewers[0]?.status).toBe(before.reviewers[0]?.status);
    expect(after.version).not.toBe(before.version);
    expect(after.reviewers[0]?.version).not.toBe(before.reviewers[0]?.version);
  });

  test('keeps existing retired refs but rejects a newly assigned retired ref', () => {
    const original = record(
      reviewerTwo,
      { kind: 'workspace_membership', id: membershipTwo, version: 3 },
      [{ kind: 'track', id: trackRetired }]
    );
    const roster = rosterState([original]);
    const port = new MemoryRosterPort(roster, authoritySet([authorityFact({
      rosterSubject: original.accessSubject,
      currentSubject: original.accessSubject,
      state: 'active', version: 8
    })], 5), targetSet());
    const plan = planReviewerRosterMutation({
      action: 'set_scope', scope, reviewerId: reviewerTwo,
      expectedReviewerVersion: original.version,
      expectedRosterVersion: roster.version,
      expectedRosterDigestSha256: roster.digestSha256,
      reviews: [
        { kind: 'track', id: trackRetired },
        { kind: 'format', id: formatActive }
      ]
    }, { environment: { repository: port, sources: port }, attribution: { userId: organizerId, occurredAt } });

    expect(plan.after.reviews).toEqual([
      { kind: 'track', id: trackRetired },
      { kind: 'format', id: formatActive }
    ]);
    expect(() => planReviewerRosterMutation({
      action: 'set_scope', scope, reviewerId: reviewerTwo,
      expectedReviewerVersion: original.version,
      expectedRosterVersion: roster.version,
      expectedRosterDigestSha256: roster.digestSha256,
      reviews: [{ kind: 'session', id: id('999') }]
    }, { environment: { repository: port, sources: port }, attribution: { userId: organizerId, occurredAt } }))
      .toThrow('scope_target_missing');
  });

  test('fails a prepared scope change when current authority or target evidence changes', () => {
    const original = record(
      reviewerTwo,
      { kind: 'workspace_membership', id: membershipTwo, version: 3 },
      []
    );
    const roster = rosterState([original]);
    const fact = authorityFact({
      rosterSubject: original.accessSubject,
      currentSubject: original.accessSubject,
      state: 'active', version: 8
    });
    const port = new MemoryRosterPort(roster, authoritySet([fact], 5), targetSet());
    const plan = planReviewerRosterMutation({
      action: 'set_scope', scope, reviewerId: reviewerTwo,
      expectedReviewerVersion: original.version,
      expectedRosterVersion: roster.version,
      expectedRosterDigestSha256: roster.digestSha256,
      reviews: [{ kind: 'session', id: sessionActive }]
    }, { environment: { repository: port, sources: port }, attribution: { userId: organizerId, occurredAt } });

    port.authority = authoritySet([authorityFact({
      rosterSubject: { ...original.accessSubject, version: 4 },
      currentSubject: { ...original.accessSubject, version: 4 },
      state: 'active', version: 9
    })], 6);
    expect(validateReviewerRosterMutationPlan(plan, { repository: port, sources: port }))
      .toBe('authority_changed');

    port.authority = authoritySet([fact], 5);
    port.targets = targetSet(2);
    expect(validateReviewerRosterMutationPlan(plan, { repository: port, sources: port }))
      .toBe('scope_targets_changed');
  });

  test('allows explicit revocation after authority disappears but never restores without eligibility', () => {
    const original = record(
      reviewerTwo,
      { kind: 'workspace_membership', id: membershipTwo, version: 3 },
      []
    );
    const roster = rosterState([original]);
    const port = new MemoryRosterPort(roster, authoritySet([], 6), targetSet());
    const revoke = planReviewerRosterMutation({
      action: 'revoke', scope, reviewerId: reviewerTwo,
      expectedReviewerVersion: original.version,
      expectedRosterVersion: roster.version,
      expectedRosterDigestSha256: roster.digestSha256
    }, { environment: { repository: port, sources: port }, attribution: { userId: organizerId, occurredAt } });
    expect(revoke.after.state).toBe('revoked');
    expect(() => planReviewerRosterMutation({
      action: 'restore', scope, reviewerId: reviewerTwo,
      expectedReviewerVersion: revoke.after.version,
      expectedRosterVersion: revoke.roster.afterVersion,
      expectedRosterDigestSha256: revoke.roster.afterDigestSha256
    }, {
      environment: {
        repository: new MemoryRosterPort({
          schemaVersion: 1, scope, version: revoke.roster.afterVersion,
          digestSha256: revoke.roster.afterDigestSha256, reviewers: [revoke.after]
        }, port.authority, port.targets),
        sources: port
      },
      attribution: { userId: organizerId, occurredAt }
    })).toThrow('reviewer_not_eligible');
  });

  test('refuses a second registration for the same access subject at plan and validate time', () => {
    const subject = { kind: 'workspace_membership', id: membershipTwo, version: 3 } as const;
    const original = record(reviewerTwo, subject, []);
    const roster = rosterState([original]);
    const fact = authorityFact({
      rosterSubject: subject, currentSubject: subject,
      state: 'active', version: 8, displayName: 'Active reviewer'
    });
    const port = new MemoryRosterPort(roster, authoritySet([fact], 5), targetSet());
    const registerAgain = {
      action: 'register' as const, scope, reviewerId: reviewerThree,
      accessSubject: subject, reviews: [],
      expectedRosterVersion: roster.version,
      expectedRosterDigestSha256: roster.digestSha256
    };
    // The duplicate is refused typed at planning; without this guard the plan
    // survives to commit and dies on the retained-records UNIQUE constraint —
    // and a doubly-rostered subject would make the acting-reviewer resolution
    // ambiguous.
    expect(() => planReviewerRosterMutation(registerAgain, {
      environment: { repository: port, sources: port },
      attribution: { userId: organizerId, occurredAt }
    })).toThrow('reviewer_exists');

    // A stored plan drafted before the subject joined revalidates to the same
    // refusal against the current roster.
    const emptyRoster = createEmptyReviewerRoster(scope);
    const emptyPort = new MemoryRosterPort(emptyRoster, authoritySet([fact], 5), targetSet());
    const staleRegister = planReviewerRosterMutation({
      ...registerAgain,
      expectedRosterVersion: emptyRoster.version,
      expectedRosterDigestSha256: emptyRoster.digestSha256
    }, {
      environment: { repository: emptyPort, sources: emptyPort },
      attribution: { userId: organizerId, occurredAt }
    });
    const occupied = rosterState([original]);
    expect(validateReviewerRosterMutationPlan(
      { ...staleRegister, roster: { ...staleRegister.roster,
        beforeVersion: occupied.version, beforeDigestSha256: occupied.digestSha256 } },
      { repository: new MemoryRosterPort(occupied, authoritySet([fact], 5), targetSet()),
        sources: port }
    )).toBe('reviewer_exists');
  });
});

class MemoryRosterPort {
  constructor(
    public roster: ReviewerRosterStateDto,
    public authority: ReviewerAuthoritySetDto,
    public targets: ReviewerScopeTargetSetDto
  ) {}

  readReviewerRoster(readScope: ReviewerRosterScopeDto) {
    return readScope.eventId === scope.eventId ? this.roster : undefined;
  }

  readReviewerAuthority(readScope: ReviewerRosterScopeDto) {
    return readScope.eventId === scope.eventId ? this.authority : undefined;
  }

  readReviewerScopeTargets(readScope: ReviewerRosterScopeDto) {
    return readScope.eventId === scope.eventId ? this.targets : undefined;
  }

  applyReviewerRosterPlan(plan: ReviewerRosterMutationPlanDto) {
    const reviewers = this.roster.reviewers
      .filter((reviewer) => reviewer.reviewerId !== plan.after.reviewerId)
      .concat(plan.after)
      .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
    this.roster = {
      schemaVersion: 1,
      scope,
      version: plan.roster.afterVersion,
      digestSha256: plan.roster.afterDigestSha256,
      reviewers
    };
    return reviewerRosterMutationResultSchema.parse({
      schemaVersion: 1,
      action: plan.action,
      rosterVersion: this.roster.version,
      rosterDigestSha256: this.roster.digestSha256,
      reviewer: plan.after
    });
  }
}

function record(
  reviewerId: ReviewerRosterRecordDto['reviewerId'],
  accessSubject: ReviewerRosterRecordDto['accessSubject'],
  reviews: ReviewerRosterRecordDto['reviews']
): ReviewerRosterRecordDto {
  return {
    schemaVersion: 1, scope, reviewerId, version: 1, accessSubject, reviews,
    state: 'included', addedByUserId: organizerId, addedAt: occurredAt
  };
}

function rosterState(reviewers: readonly ReviewerRosterRecordDto[]): ReviewerRosterStateDto {
  const version = 1;
  return {
    schemaVersion: 1, scope, version,
    digestSha256: reviewerRosterDigest({ scope, version, reviewers }),
    reviewers: [...reviewers]
  };
}

function authorityFact(input: {
  rosterSubject: ReviewerEligibilityFactDto['rosterSubject'];
  currentSubject: ReviewerEligibilityFactDto['rosterSubject'];
  state: 'reserved' | 'active';
  version: number;
  displayName?: string;
}): ReviewerEligibilityFactDto {
  const unsigned = {
    schemaVersion: 1 as const, scope,
    rosterSubject: input.rosterSubject,
    currentSubject: input.currentSubject,
    state: input.state,
    version: input.version,
    capabilityIds: [...REVIEWER_CAPABILITY_IDS] as [
      'event.read', 'speaker.directory.read', 'submission.read',
      'submission.score', 'submission.comment', 'schedule.read'
    ],
    evidenceIds: [`capability-grant:${input.version}`],
    ...(input.displayName === undefined ? {} : { displayName: input.displayName })
  };
  return { ...unsigned, digestSha256: reviewerAuthorityFactDigest(unsigned) };
}

function authoritySet(
  facts: readonly ReviewerEligibilityFactDto[],
  version: number
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

function targetSet(version = 1): ReviewerScopeTargetSetDto {
  const raw = [
    { ref: { kind: 'track' as const, id: trackRetired }, assignability: 'retained_only' as const },
    { ref: { kind: 'format' as const, id: formatActive }, assignability: 'assignable' as const },
    { ref: { kind: 'session' as const, id: sessionActive }, assignability: 'assignable' as const }
  ];
  const targets = raw.map((target, index) => {
    const unsigned = {
      schemaVersion: 1 as const, scope, ref: target.ref,
      version: version + index, assignability: target.assignability
    };
    return { ...unsigned, digestSha256: reviewerScopeTargetFactDigest(unsigned) };
  });
  const unsigned = { schemaVersion: 1 as const, scope, version, targets };
  return { ...unsigned, digestSha256: reviewerScopeTargetSetDigest(unsigned) };
}
