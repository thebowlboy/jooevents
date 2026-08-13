import { describe, expect, test } from 'bun:test';
import { encodeCanonicalJson } from '@jooevents/kernel';
import type {
  DecisionHeadDto,
  DecisionMutationPlanDto,
  DecisionRestorePlanDto,
  DecisionReviewPinDto,
  SubmissionSessionOriginDto
} from '@jooevents/contracts';
import {
  applySessionGraduationFrom,
  applySessionGraduationReversalFrom,
  applySessionMutationPlan,
  applySessionRestorePlan,
  createEmptySessionCatalog,
  findSession,
  planSessionGraduationFrom,
  planSessionGraduationReversalFrom,
  planSessionMutation,
  validateSessionGraduationFrom,
  validateSessionGraduationReversalFrom,
  type SessionCatalog,
  type SessionGraduationContribution,
  type SessionGraduationPlanningPort,
  type SessionGraduationTransactionPort,
  type SessionGraduationValidationPort
} from '@jooevents/session';
import type { SessionMutationPlanDto, SessionRestorePlanDto } from '@jooevents/contracts';
import {
  createDecisionChangesetBundle,
  decisionReadPort,
  decisionTransactionPort,
  decisionValidationPort,
  DecisionPlanningError,
  DecisionTargetUnavailableError,
  decisionMutationResultFromPlan,
  decisionMutationResultFromRestore,
  isDecisionRestorePlan,
  planDecisionCompensation,
  planDecisionMutation,
  resolveDecisionMutationPlanningInput,
  validateDecisionMutationPlan,
  validateDecisionRestorePlan,
  type DecisionCandidateDto,
  type DecisionChangesetTransactionPort,
  type DecisionEnvironment
} from './index';
import {
  sessionGraduationPlanningPort,
  sessionGraduationTransactionPort,
  sessionGraduationValidationPort
} from '@jooevents/session';

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

type WorldPort = DecisionChangesetTransactionPort
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
    planSessionGraduationReversal: (
      input: Parameters<typeof planSessionGraduationReversalFrom>[1]
    ) => planSessionGraduationReversalFrom(port, input),
    validateSessionGraduation: (contribution: SessionGraduationContribution) =>
      validateSessionGraduationFrom(port, contribution),
    validateSessionGraduationReversal: (plan: SessionRestorePlanDto) =>
      validateSessionGraduationReversalFrom(port, plan),
    applySessionPlan(plan: SessionMutationPlanDto | SessionRestorePlanDto) {
      // Only restore plans carry a top-level `action` discriminant.
      const applied = 'action' in plan
        ? applySessionRestorePlan({ plan, catalog: world.catalog })
        : applySessionMutationPlan({ plan, catalog: world.catalog, vocabulary });
      world.catalog = applied.catalog;
      return applied.result;
    },
    applySessionGraduation: (contribution: SessionGraduationContribution) =>
      applySessionGraduationFrom(port, contribution),
    applySessionGraduationReversal: (plan: SessionRestorePlanDto) =>
      applySessionGraduationReversalFrom(port, plan),
    applyDecisionPlan(plan: DecisionMutationPlanDto | DecisionRestorePlanDto) {
      if (isDecisionRestorePlan(plan)) {
        for (const row of plan.rows) {
          if (row.restore === null) world.heads.delete(row.submissionId);
          else world.heads.set(row.submissionId, row.restore);
          if (row.unlinkOrigin !== null) world.origins.delete(row.submissionId);
        }
        return decisionMutationResultFromRestore(plan);
      }
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

  test('compensation unspawns only while unreferenced, else stays standing with unlink, and detach restores roster-before', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate());
    const env = environment(world);
    const port = transactionPort(world);
    const spawnPlan = planDecisionMutation({
      planningInput: spawnRouting(world, [decideRow()]),
      environment: env
    });
    port.applySessionGraduation(spawnPlan.rows[0]!.graduation!);
    port.applyDecisionPlan(spawnPlan);
    expect(findSession(world.catalog, spawnedSessionId)).toBeDefined();

    // Referenced by a schedule placement: the Session stays standing; only the
    // head reverts and the origin unlinks.
    world.placements.set(spawnedSessionId, 1);
    const standing = planDecisionCompensation({
      original: spawnPlan, environment: env, actorUserId: userId, occurredAt: later
    });
    expect(standing).toMatchObject({
      kind: 'semantic', noteKey: 'decision.session_stays_standing'
    });
    if (standing.kind === 'blocked') throw new TypeError('unexpected_blocked');
    expect(standing.plan.rows[0]).toMatchObject({ restore: null, sessionRestore: null });
    expect(standing.plan.rows[0]!.unlinkOrigin).not.toBeNull();

    // Unreferenced again: exact compensation unspawns and unlinks.
    world.placements.delete(spawnedSessionId);
    const exact = planDecisionCompensation({
      original: spawnPlan, environment: env, actorUserId: userId, occurredAt: later
    });
    expect(exact.kind).toBe('exact');
    if (exact.kind === 'blocked') throw new TypeError('unexpected_blocked');
    port.applyDecisionPlan(exact.plan);
    for (const row of exact.plan.rows) {
      if (row.sessionRestore) port.applySessionGraduationReversal(row.sessionRestore);
    }
    expect(world.heads.size).toBe(0);
    expect(world.origins.size).toBe(0);
    expect(findSession(world.catalog, spawnedSessionId)).toBeUndefined();

    // Detach: an attach reversal restores the exact roster-before image.
    seedCollectingSession(world);
    const rosterBefore = findSession(world.catalog, collectingSessionId)!.roster;
    const attachPlan = planDecisionMutation({
      planningInput: planningInput([decideRow({
        graduation: { kind: 'attach', sessionId: collectingSessionId }
      })]),
      environment: env
    });
    port.applySessionGraduation(attachPlan.rows[0]!.graduation!);
    port.applyDecisionPlan(attachPlan);
    const detach = planDecisionCompensation({
      original: attachPlan, environment: env, actorUserId: userId, occurredAt: later
    });
    expect(detach.kind).toBe('exact');
    if (detach.kind === 'blocked') throw new TypeError('unexpected_blocked');
    port.applyDecisionPlan(detach.plan);
    for (const row of detach.plan.rows) {
      if (row.sessionRestore) port.applySessionGraduationReversal(row.sessionRestore);
    }
    const restored = findSession(world.catalog, collectingSessionId)!;
    expect(restored.roster.participants).toEqual(rosterBefore.participants);
    expect(restored.roster.version).toBe(rosterBefore.version);
    expect(world.heads.has(submissionA)).toBe(false);

    // A moved head blocks compensation instead of guessing.
    const reSpawn = planDecisionMutation({
      planningInput: spawnRouting(world, [decideRow()]),
      environment: env
    });
    port.applySessionGraduation(reSpawn.rows[0]!.graduation!);
    port.applyDecisionPlan(reSpawn);
    world.heads.set(submissionA, {
      ...world.heads.get(submissionA)!,
      digestSha256: 'f'.repeat(64)
    });
    expect(planDecisionCompensation({
      original: reSpawn, environment: env, actorUserId: userId, occurredAt: later
    })).toEqual({ kind: 'blocked', reasonKey: 'decision.changed' });
  });

  test('a placement landing after compensation derives refuses the restore at validation instead of unspawning', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate());
    const env = environment(world);
    const port = transactionPort(world);
    const spawnPlan = planDecisionMutation({
      planningInput: spawnRouting(world, [decideRow()]),
      environment: env
    });
    port.applySessionGraduation(spawnPlan.rows[0]!.graduation!);
    port.applyDecisionPlan(spawnPlan);

    // Derived while unreferenced: an exact unspawn that currently validates.
    const exact = planDecisionCompensation({
      original: spawnPlan, environment: env, actorUserId: userId, occurredAt: later
    });
    expect(exact.kind).toBe('exact');
    if (exact.kind === 'blocked') throw new TypeError('unexpected_blocked');
    expect(validateDecisionRestorePlan({ plan: exact.plan, environment: env })).toBeUndefined();

    // The placement lands between derive and commit. It moves neither the
    // Session digest nor the catalog digest, so only the reference re-check
    // can see it — the plan refuses instead of stranding the occurrence.
    world.placements.set(spawnedSessionId, 1);
    expect(validateDecisionRestorePlan({ plan: exact.plan, environment: env }))
      .toEqual({ kind: 'stale', code: 'session_placed', submissionId: submissionA });
    const bundle = createDecisionChangesetBundle();
    const ports = Object.freeze({ getPort: () => port as never });
    expect(bundle.definition.validateWithin(exact.plan, ports as never)).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'decision.changed',
        retryable: false,
        detail: { code: 'session_placed', submissionId: submissionA }
      }
    });

    // Retry-by-replan: the re-derived compensation keeps the placed Session
    // standing, unlinks only, and validates against the same current state.
    const rederived = planDecisionCompensation({
      original: spawnPlan, environment: env, actorUserId: userId, occurredAt: later
    });
    expect(rederived).toMatchObject({
      kind: 'semantic', noteKey: 'decision.session_stays_standing'
    });
    if (rederived.kind === 'blocked') throw new TypeError('unexpected_blocked');
    expect(rederived.plan.rows[0]).toMatchObject({ sessionRestore: null });
    expect(validateDecisionRestorePlan({ plan: rederived.plan, environment: env }))
      .toBeUndefined();

    // The detach arm is gated identically: an attach reversal derived before
    // the target Session was placed refuses once a placement references it.
    const detachWorld = createWorld();
    seedCollectingSession(detachWorld);
    detachWorld.candidates.set(submissionA, candidate());
    const detachEnv = environment(detachWorld);
    const detachPort = transactionPort(detachWorld);
    const attachPlan = planDecisionMutation({
      planningInput: planningInput([decideRow({
        graduation: { kind: 'attach', sessionId: collectingSessionId }
      })]),
      environment: detachEnv
    });
    detachPort.applySessionGraduation(attachPlan.rows[0]!.graduation!);
    detachPort.applyDecisionPlan(attachPlan);
    const detach = planDecisionCompensation({
      original: attachPlan, environment: detachEnv, actorUserId: userId, occurredAt: later
    });
    expect(detach.kind).toBe('exact');
    if (detach.kind === 'blocked') throw new TypeError('unexpected_blocked');
    expect(validateDecisionRestorePlan({ plan: detach.plan, environment: detachEnv }))
      .toBeUndefined();
    detachWorld.placements.set(collectingSessionId, 1);
    expect(validateDecisionRestorePlan({ plan: detach.plan, environment: detachEnv }))
      .toEqual({ kind: 'stale', code: 'session_placed', submissionId: submissionA });
  });

  test('changeset definition hosts the graduation collaboration and refuses through typed outcomes', () => {
    const bundle = createDecisionChangesetBundle();
    expect(bundle.registry.get('decision.decide', 1)).toBe(bundle.definition);
    expect(bundle.definition.readPorts).toContain(sessionGraduationPlanningPort);
    expect(bundle.definition.validationPorts).toContain(sessionGraduationValidationPort);
    expect(bundle.definition.transactionPorts).toContain(sessionGraduationTransactionPort);
    expect(bundle.definition.allowedRisks).toEqual(['consequential']);
    expect(bundle.definition.allowedEffects).toEqual([]);

    const world = createWorld();
    seedCollectingSession(world);
    world.candidates.set(submissionA, candidate({ targetSessionId: collectingSessionId }));
    const port = transactionPort(world);
    const getPort = (key: unknown) => {
      if (key === decisionReadPort || key === decisionValidationPort
          || key === decisionTransactionPort || key === sessionGraduationPlanningPort
          || key === sessionGraduationValidationPort
          || key === sessionGraduationTransactionPort) return port as never;
      throw new TypeError('undeclared_port');
    };
    const ports = Object.freeze({ getPort });
    const planned = bundle.definition.plan(
      resolveDecisionMutationPlanningInput({
        authorInput: {
          action: 'decide',
          decisions: [{
            submissionId: submissionA, state: 'accepted',
            expectedDecisionVersion: null, expectedDecisionDigestSha256: null,
            graduation: { kind: 'attach', sessionId: collectingSessionId }
          }]
        } as never,
        scope, actorUserId: userId, occurredAt: now,
        environment: { decisions: port, sessions: port },
        newSessionId: () => spawnedSessionId
      }),
      ports as never
    );
    if (planned instanceof Promise) throw new TypeError('unexpected_async_plan');
    expect(planned.riskTier).toBe('consequential');
    expect(planned.consequences).toEqual(['decision_changed', 'session_changed']);
    expect(planned.guardRefs.map((guard) => guard.id)).toEqual([
      `decision_head_absence:${submissionA}`,
      `session_catalog:${scope.eventId}`
    ]);
    expect(planned.aggregateRefs.map((aggregate) => aggregate.id)).toEqual([
      `session:${collectingSessionId}`
    ]);
    const projected = bundle.definition.projectDiff(planned.plan);
    expect(projected.representedConsequences).toEqual(planned.consequences);

    // The collecting target graduates mid-flight: validation refuses with the
    // structured filled-target outcome carrying the two decided exits.
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
    const refused = bundle.definition.validateWithin(planned.plan, ports as never);
    expect(refused).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'decision.target_unavailable',
        retryable: false,
        detail: { reason: 'target_graduated', exits: ['retarget', 'spawn'] }
      }
    });
  });

  test('applyWithin applies the collaborator first, checks pin equality, and merges facts without effects', () => {
    const world = createWorld();
    world.candidates.set(submissionA, candidate());
    const bundle = createDecisionChangesetBundle();
    const port = transactionPort(world);
    const ports = Object.freeze({ getPort: () => port as never });
    const plan = planDecisionMutation({
      planningInput: spawnRouting(world, [decideRow()]),
      environment: { decisions: port, sessions: port }
    });
    const contribution = bundle.definition.applyWithin(plan, ports as never);
    if (contribution instanceof Promise) throw new TypeError('unexpected_async_apply');
    expect(contribution.effects).toEqual([]);
    expect(contribution.facts.map((fact) => fact.kind))
      .toEqual(['decision_changed', 'session_changed']);
    expect(contribution.result).toMatchObject({
      action: 'decide',
      rows: [{
        submissionId: submissionA,
        head: { state: 'accepted', version: 1 },
        origin: { kind: 'spawned', sessionId: spawnedSessionId }
      }]
    });
    expect(world.heads.get(submissionA)?.state).toBe('accepted');
    expect(world.origins.get(submissionA)?.sessionId).toBe(spawnedSessionId);
    expect(findSession(world.catalog, spawnedSessionId)?.lifecycle).toBe('programmed');
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
