import { describe, expect, test } from 'bun:test';
import { encodeCanonicalJson } from '@jooevents/kernel';
import type {
  DecisionHeadDto,
  DecisionMutationPlanDto,
  DecisionReviewPinDto,
  SubmissionSessionOriginDto
} from '@jooevents/contracts';
import {
  applySessionGraduationFrom,
  applySessionMutationPlan,
  createEmptySessionCatalog,
  findSession,
  planSessionGraduationFrom,
  planSessionMutation,
  validateSessionGraduationFrom,
  type SessionCatalog,
  type SessionGraduationContribution,
  type SessionGraduationPlanningPort,
  type SessionGraduationTransactionPort,
  type SessionGraduationValidationPort
} from '@jooevents/session';
import type { SessionMutationPlanDto } from '@jooevents/contracts';
import {
  DecisionPlanningError,
  DecisionTargetUnavailableError,
  decisionMutationResultFromPlan,
  planDecisionMutation,
  resolveDecisionMutationPlanningInput,
  validateDecisionMutationPlan,
  type DecisionCandidateDto,
  type DecisionTransactionPort,
  type DecisionEnvironment
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa501'
});
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa502';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa503';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa504';
const submissionA = '019c1df7-86b5-769b-bba4-5f7097bfa601';
const submissionB = '019c1df7-86b5-769b-bba4-5f7097bfa602';
const formVersionId = '019c1df7-86b5-769b-bba4-5f7097bfa603';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa701';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa702';
const collectingSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa801';
const spawnedSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa802';
const roundId = '019c1df7-86b5-769b-bba4-5f7097bfa901';
const now = '2026-08-13T09:00:00.000Z';
const later = '2026-08-13T09:30:00.000Z';

const vocabulary = Object.freeze({
  scope,
  setVersion: 1,
  rooms: [],
  tracks: [Object.freeze({
    kind: 'track', id: trackId, scope, name: 'Platform', status: 'active', version: 1,
    accent: 'lavender'
  })],
  formats: [Object.freeze({
    kind: 'format', id: formatId, scope, name: 'Talk', status: 'active', version: 1
  })]
}) as never as Parameters<typeof planSessionMutation>[0]['vocabulary'];

interface MemoryWorld {
  catalog: SessionCatalog;
  readonly heads: Map<string, DecisionHeadDto>;
  readonly origins: Map<string, SubmissionSessionOriginDto>;
  readonly candidates: Map<string, DecisionCandidateDto>;
  readonly reviews: Map<string, DecisionReviewPinDto>;
  readonly placements: Map<string, number>;
}

function candidate(overrides: Partial<DecisionCandidateDto> = {}): DecisionCandidateDto {
  return Object.freeze({
    submissionId: submissionA,
    formVersionId,
    candidateVersion: 7,
    title: 'Sharding the Speaker Graph',
    formatId,
    trackId,
    targetSessionId: null,
    participantPersonIds: Object.freeze([personA, personB]),
    ...overrides
  });
}

function createWorld(): MemoryWorld {
  return {
    catalog: createEmptySessionCatalog(scope),
    heads: new Map(),
    origins: new Map(),
    candidates: new Map(),
    reviews: new Map(),
    placements: new Map()
  };
}

type WorldPort = DecisionTransactionPort
  & SessionGraduationPlanningPort
  & SessionGraduationValidationPort
  & SessionGraduationTransactionPort;

function transactionPort(world: MemoryWorld): WorldPort {
  const port = {
    readDecisionHead: (_: typeof scope, submissionId: string) => world.heads.get(submissionId),
    readSubmissionSessionOrigin: (_: typeof scope, submissionId: string) =>
      world.origins.get(submissionId),
    listSessionOrigins: (_: typeof scope, sessionId: string) =>
      [...world.origins.values()]
        .filter((origin) => origin.sessionId === sessionId)
        .sort((left, right) => left.submissionId < right.submissionId ? -1 : 1),
    countSessionSchedulePlacements: (_: typeof scope, sessionId: string) =>
      world.placements.get(sessionId) ?? 0,
    readDecisionCandidate: (_: typeof scope, submissionId: string) =>
      world.candidates.get(submissionId),
    readDecisionReviewBasis: (_: typeof scope, submissionId: string) =>
      world.reviews.get(submissionId),
    readSessionCatalog: () => world.catalog,
    readSessionVocabulary: () => vocabulary,
    planSessionGraduation: (input: Parameters<typeof planSessionGraduationFrom>[1]) =>
      planSessionGraduationFrom(port, input),
    validateSessionGraduation: (contribution: SessionGraduationContribution) =>
      validateSessionGraduationFrom(port, contribution),
    applySessionPlan(plan: SessionMutationPlanDto) {
      const applied = applySessionMutationPlan({ plan, catalog: world.catalog, vocabulary });
      world.catalog = applied.catalog;
      return applied.result;
    },
    applySessionGraduation: (contribution: SessionGraduationContribution) =>
      applySessionGraduationFrom(port, contribution),
    applyDecisionPlan(plan: DecisionMutationPlanDto) {
      for (const row of plan.rows) {
        world.heads.set(row.submissionId, row.after);
        if (row.origin !== null) world.origins.set(row.submissionId, row.origin);
      }
      return decisionMutationResultFromPlan(plan);
    }
  };
  return port as never;
}

function environment(world: MemoryWorld): DecisionEnvironment & { readonly port: WorldPort } {
  const port = transactionPort(world);
  return { decisions: port, sessions: port, port };
}

function decideRow(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: submissionA,
    state: 'accepted' as const,
    expectedDecisionVersion: null,
    expectedDecisionDigestSha256: null,
    ...overrides
  };
}

function planningInput(rows: readonly Record<string, unknown>[]) {
  return {
    action: 'decide' as const,
    scope,
    actorUserId: userId,
    occurredAt: now,
    decisions: rows.map((row) => ({ graduation: null, ...row }))
  } as never as Parameters<typeof planDecisionMutation>[0]['planningInput'];
}

function seedCollectingSession(world: MemoryWorld, sessionId = collectingSessionId): void {
  const plan = planSessionMutation({
    catalog: world.catalog,
    vocabulary,
    planningInput: {
      action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: world.catalog.version,
      expectedCatalogDigestSha256: world.catalog.digestSha256,
      title: 'Collecting Panel', plannedDurationMinutes: 60,
      lifecycle: 'collecting', formatId, trackId,
      participants: [{
        personId: personA, role: 'speaker', publiclyVisible: true,
        source: { kind: 'submission', id: submissionB, version: 1 }
      }]
    }
  });
  world.catalog = applySessionMutationPlan({ plan, catalog: world.catalog, vocabulary }).catalog;
}

function spawnRouting(world: MemoryWorld, rows: readonly Record<string, unknown>[]) {
  let minted = 0;
  return resolveDecisionMutationPlanningInput({
    authorInput: { action: 'decide', decisions: rows } as never,
    scope,
    actorUserId: userId,
    occurredAt: now,
    environment: environment(world),
    newSessionId: () => {
      minted += 1;
      if (minted > 1) throw new TypeError('unexpected_second_spawn');
      return spawnedSessionId;
    }
  });
}

describe('canonical Decision domain', () => {
  test('accept-spawn plans head, aggregate-only evidence, origin link, and person-deduped roster', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate({
      participantPersonIds: Object.freeze([personA, personA, personB])
    }));
    world.reviews.set(submissionA, Object.freeze({
      roundId, roundVersion: 3,
      standing: Object.freeze({ value: 4.5, n: 12, band: 'top' as const })
    }));
    const resolved = spawnRouting(world, [decideRow()]);
    const plan = planDecisionMutation({ planningInput: resolved, environment: environment(world) });

    const row = plan.rows[0]!;
    expect(row.after).toMatchObject({ state: 'accepted', version: 1, submissionId: submissionA });
    expect(row.evidence.submission).toEqual({
      submissionId: submissionA, formVersionId, candidateVersion: 7
    });
    expect(row.evidence.review).toEqual({
      roundId, roundVersion: 3, standing: { value: 4.5, n: 12, band: 'top' }
    });
    expect(row.evidence.target).toBeNull();
    expect(row.origin).toMatchObject({
      submissionId: submissionA, sessionId: spawnedSessionId, kind: 'spawned'
    });
    expect(row.graduation).toMatchObject({
      before: null,
      after: {
        id: spawnedSessionId,
        lifecycle: 'programmed',
        title: 'Sharding the Speaker Graph',
        plannedDurationMinutes: 30
      }
    });
    expect(row.graduation!.after.roster.participants).toEqual([
      {
        personId: personA, role: 'speaker', position: 0, publiclyVisible: true,
        source: { kind: 'submission', id: submissionA, version: 7 }
      },
      {
        personId: personB, role: 'speaker', position: 1, publiclyVisible: true,
        source: { kind: 'submission', id: submissionA, version: 7 }
      }
    ]);
    // Blind-plan audit: the stored plan carries aggregates only, never reviewer
    // identities, per-reviewer scores, or comments.
    const canonical = Buffer.from(encodeCanonicalJson(plan)).toString('utf8');
    for (const marker of ['reviewerId', 'reviewer', 'comment', 'scores']) {
      expect(canonical.includes(`"${marker}"`)).toBe(false);
    }
  });

  test('routes an omitted graduation by effective target and refuses unavailable targets with both exits', () => {
    const world = createWorld();
    seedCollectingSession(world);
    world.candidates.set(submissionA, candidate({ targetSessionId: collectingSessionId }));
    const resolved = spawnRouting(world, [decideRow()]);
    expect(resolved.decisions[0]!.graduation).toEqual({
      kind: 'attach', sessionId: collectingSessionId
    });

    const graduate = planSessionMutation({
      catalog: world.catalog,
      vocabulary,
      planningInput: {
        action: 'transition', scope, sessionId: collectingSessionId,
        actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: world.catalog.version,
        expectedCatalogDigestSha256: world.catalog.digestSha256,
        expectedSessionVersion: findSession(world.catalog, collectingSessionId)!.version,
        expectedSessionDigestSha256: findSession(world.catalog, collectingSessionId)!.digestSha256,
        to: 'programmed'
      }
    });
    world.catalog = applySessionMutationPlan({
      plan: graduate, catalog: world.catalog, vocabulary
    }).catalog;
    let refusal: unknown;
    try {
      spawnRouting(world, [decideRow()]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DecisionTargetUnavailableError);
    expect((refusal as DecisionTargetUnavailableError).detail).toEqual({
      reason: 'target_graduated', exits: ['retarget', 'spawn']
    });

    world.candidates.set(submissionA, candidate({
      targetSessionId: '019c1df7-86b5-769b-bba4-5f7097bfaaaa'
    }));
    expect(() => spawnRouting(world, [decideRow()])).toThrow('decision_target_unavailable');
  });

  test('attach appends the roster without clobbering, dedups by personId, and pins the resolved target', () => {
    const world = createWorld();
    seedCollectingSession(world);
    const before = findSession(world.catalog, collectingSessionId)!;
    world.candidates.set(submissionA, candidate());
    const plan = planDecisionMutation({
      planningInput: planningInput([decideRow({
        graduation: { kind: 'attach', sessionId: collectingSessionId }
      })]),
      environment: environment(world)
    });
    const row = plan.rows[0]!;
    expect(row.evidence.target).toEqual({
      kind: 'session', id: collectingSessionId, title: 'Collecting Panel',
      version: before.version, lifecycle: 'collecting'
    });
    expect(row.origin).toMatchObject({ kind: 'attached', sessionId: collectingSessionId });
    const roster = row.graduation!.after.roster.participants;
    expect(roster[0]).toEqual(before.roster.participants[0]!);
    expect(roster.map((participant) => participant.personId)).toEqual([personA, personB]);
    expect(row.graduation!.after.lifecycle).toBe('collecting');
  });

  test('waitlist and decline write the head only and re-decides guard on version and digest', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate());
    const env = environment(world);
    const first = planDecisionMutation({
      planningInput: planningInput([decideRow({ state: 'waitlisted' })]),
      environment: env
    });
    expect(first.rows[0]).toMatchObject({ graduation: null, origin: null });
    expect(first.rows[0]!.after.state).toBe('waitlisted');
    env.port.applyDecisionPlan(first);

    const head = world.heads.get(submissionA)!;
    const second = planDecisionMutation({
      planningInput: planningInput([decideRow({
        state: 'declined',
        expectedDecisionVersion: head.version,
        expectedDecisionDigestSha256: head.digestSha256
      })]),
      environment: env
    });
    expect(second.rows[0]!.after).toMatchObject({ state: 'declined', version: 2 });
    expect(() => planDecisionMutation({
      planningInput: planningInput([decideRow({
        state: 'declined',
        expectedDecisionVersion: 99,
        expectedDecisionDigestSha256: head.digestSha256
      })]),
      environment: env
    })).toThrow('stale_decision');
    expect(() => planDecisionMutation({
      planningInput: planningInput([decideRow({ state: 'declined' })]),
      environment: env
    })).toThrow('decision_exists');
  });

  test('bulk decide chains attaches through one sequential view and applies atomically in order', () => {
    const world = createWorld();
    seedCollectingSession(world);
    world.candidates.set(submissionA, candidate());
    world.candidates.set(submissionB, candidate({
      submissionId: submissionB,
      title: 'Second Talk',
      participantPersonIds: Object.freeze([personB])
    }));
    const env = environment(world);
    const plan = planDecisionMutation({
      planningInput: planningInput([
        decideRow({ graduation: { kind: 'attach', sessionId: collectingSessionId } }),
        decideRow({
          submissionId: submissionB,
          graduation: {
            kind: 'attach', sessionId: collectingSessionId, graduateTo: 'programmed'
          }
        })
      ]),
      environment: env
    });
    const [first, second] = plan.rows;
    expect(second!.graduation!.before!.version).toBe(first!.graduation!.after.version);
    expect(second!.graduation!.after.lifecycle).toBe('programmed');
    expect(validateDecisionMutationPlan({ plan, environment: env })).toBeUndefined();

    const port = transactionPort(world);
    for (const row of plan.rows) port.applySessionGraduation(row.graduation!);
    port.applyDecisionPlan(plan);
    const session = findSession(world.catalog, collectingSessionId)!;
    expect(session.lifecycle).toBe('programmed');
    expect(session.roster.participants.map((participant) => participant.personId))
      .toEqual([personA, personB]);
    expect(world.origins.size).toBe(2);
  });

  test('refuses a schema-valid plan that does not replan identically', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate());
    world.reviews.set(submissionA, Object.freeze({
      roundId, roundVersion: 1, standing: null
    }));
    const env = environment(world);
    const plan = planDecisionMutation({
      planningInput: spawnRouting(world, [decideRow()]),
      environment: env
    });
    const tampered = {
      ...plan,
      rows: [{ ...plan.rows[0]!, evidence: { ...plan.rows[0]!.evidence, review: null } }]
    } as DecisionMutationPlanDto;
    expect(validateDecisionMutationPlan({ plan: tampered, environment: env }))
      .toEqual({ kind: 'stale', code: 'invalid_plan', submissionId: submissionA });
  });

    test('spawn refuses an unrepresentable title and a titleless candidate with typed codes', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate({ title: null }));
    const env = environment(world);
    expect(() => planDecisionMutation({
      planningInput: spawnRouting(world, [decideRow()]),
      environment: env
    })).toThrow('title_missing');
    world.candidates.set(submissionA, candidate({ title: 'x'.repeat(400) }));
    let caught: unknown;
    try {
      planDecisionMutation({
        planningInput: spawnRouting(world, [decideRow()]),
        environment: env
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DecisionPlanningError);
    expect((caught as DecisionPlanningError).code).toBe('title_unrepresentable');
  });
});
