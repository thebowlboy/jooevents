import { describe, expect, test } from 'bun:test';
import { encodeCanonicalJson } from '@jooevents/kernel';
import type { EngagementHeadDto, EngagementMutationPlanningInput } from '@jooevents/contracts';
import {
  applyEngagementSeedFrom,
  applyEngagementSeedReversalFrom,
  createEngagementChangesetBundle,
  deterministicEngagementId,
  engagementAggregateId,
  engagementMutationResultFromPlan,
  engagementReadPort,
  engagementSeedResultFromPlan,
  engagementTransactionPort,
  engagementValidationPort,
  EngagementPlanningError,
  EngagementSeedError,
  isCancellationRequested,
  isEngagementRestorePlan,
  planEngagementCompensation,
  planEngagementMutation,
  planEngagementSeedFrom,
  planEngagementSeedReversalFrom,
  resolveEngagementMutationPlanningInput,
  validateEngagementMutationPlan,
  validateEngagementSeedFrom,
  validateEngagementSeedReversalFrom,
  type EngagementChangesetTransactionPort,
  type EngagementSeedTransactionPort
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const otherSubmissionId = '019c1df7-86b5-769b-bba4-5f7097bfa502';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa601';
const now = '2026-08-14T08:00:00.000Z';
const later = '2026-08-14T09:00:00.000Z';

const source = Object.freeze({ kind: 'submission', id: submissionId, version: 7 });
const seededBy = Object.freeze({ version: 1, digestSha256: 'b'.repeat(64) });
const otherSeededBy = Object.freeze({ version: 1, digestSha256: 'c'.repeat(64) });

interface MemoryWorld {
  readonly heads: Map<string, EngagementHeadDto>;
}

type WorldPort = EngagementChangesetTransactionPort & EngagementSeedTransactionPort;

function worldPort(world: MemoryWorld): WorldPort {
  return {
    readEngagementHead: (_scope, engagementId) => world.heads.get(engagementId),
    readSessionPersonEngagement: (_scope, session, person) =>
      [...world.heads.values()].find(
        (head) => head.sessionId === session && head.personId === person
      ),
    listSeededEngagements: (_scope, session, submission) =>
      [...world.heads.values()]
        .filter((head) => head.sessionId === session && head.submissionId === submission)
        .sort((left, right) => left.personId < right.personId ? -1 : 1),
    applyEngagementPlan(plan) {
      if (isEngagementRestorePlan(plan)) {
        world.heads.set(plan.restore.id, plan.restore);
        return { action: 'restore', engagement: plan.restore };
      }
      world.heads.set(plan.after.id, plan.after);
      return engagementMutationResultFromPlan(plan);
    },
    applyEngagementSeed(contribution) {
      for (const row of contribution.rows) world.heads.set(row.head.id, row.head);
      return engagementSeedResultFromPlan(contribution);
    },
    applyEngagementSeedReversal(plan) {
      for (const row of plan.rows) world.heads.delete(row.expectedCurrent.id);
      return {
        action: 'seed_reversal',
        sessionId: plan.sessionId,
        submissionId: plan.submissionId,
        seeded: [],
        skippedPersonIds: [],
        removedPersonIds: plan.rows.map((row) => row.personId)
      };
    }
  };
}

function seedWorld(): { world: MemoryWorld; port: WorldPort } {
  const world: MemoryWorld = { heads: new Map() };
  const port = worldPort(world);
  const contribution = planEngagementSeedFrom(port, {
    scope, sessionId, submissionId, seededByDecision: seededBy, source,
    personIds: [personB, personA],
    invitedAt: now,
    respondBy: null
  });
  applyEngagementSeedFrom(port, contribution);
  return { world, port };
}

function headOf(port: WorldPort, personId: string): EngagementHeadDto {
  return port.readSessionPersonEngagement(scope, sessionId, personId)!;
}

function planningInput(
  overrides: Partial<Record<string, unknown>> & { readonly action: string }
): EngagementMutationPlanningInput {
  return {
    scope, actorUserId: userId, occurredAt: later,
    ...overrides
  } as EngagementMutationPlanningInput;
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}

describe('engagement identity', () => {
  test('the (sessionId, personId) pair derives one stable canonical id', () => {
    const id = deterministicEngagementId(scope, sessionId, personA);
    expect(id).toBe(deterministicEngagementId(scope, sessionId, personA));
    expect(id).not.toBe(deterministicEngagementId(scope, sessionId, personB));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(engagementAggregateId(id)).toBe(`engagement_head:${id}`);
  });
});

describe('engagement seed collaboration', () => {
  test('seeds one invited row per person and is idempotent under replay', () => {
    const { port } = seedWorld();
    expect(headOf(port, personA)).toMatchObject({
      state: 'invited', version: 1, submissionId, sessionId
    });
    const replay = planEngagementSeedFrom(port, {
      scope, sessionId, submissionId, seededByDecision: seededBy, source,
      personIds: [personA, personB],
      invitedAt: now,
      respondBy: null
    });
    expect(replay.rows).toHaveLength(0);
    expect(replay.skippedPersonIds).toEqual([personA, personB]);
    applyEngagementSeedFrom(port, replay);
    expect(headOf(port, personA).version).toBe(1);
  });

  test('a later acceptance seeds only new pairs and skips existing ones untouched', () => {
    const { port } = seedWorld();
    const personC = '019c1df7-86b5-769b-bba4-5f7097bfa403';
    const attach = planEngagementSeedFrom(port, {
      scope, sessionId, submissionId: otherSubmissionId,
      seededByDecision: otherSeededBy,
      source: { kind: 'submission', id: otherSubmissionId, version: 3 },
      personIds: [personA, personC],
      invitedAt: later,
      respondBy: null
    });
    expect(attach.rows.map((row) => row.personId)).toEqual([personC]);
    expect(attach.skippedPersonIds).toEqual([personA]);
    applyEngagementSeedFrom(port, attach);
    expect(headOf(port, personA).submissionId).toBe(submissionId);
    expect(headOf(port, personC).submissionId).toBe(otherSubmissionId);
  });

  test('seed validation refuses a plan whose world moved', () => {
    const { port } = seedWorld();
    const stale = planEngagementSeedFrom(worldPort({ heads: new Map() }), {
      scope, sessionId, submissionId, seededByDecision: seededBy, source,
      personIds: [personA, personB],
      invitedAt: now,
      respondBy: null
    });
    expect(validateEngagementSeedFrom(port, stale)).toEqual({ kind: 'refused', code: 'seed_stale' });
    const current = planEngagementSeedFrom(port, {
      scope, sessionId, submissionId, seededByDecision: seededBy, source,
      personIds: [personA, personB],
      invitedAt: now,
      respondBy: null
    });
    expect(validateEngagementSeedFrom(port, current)).toEqual({ kind: 'ready' });
  });

  test('reversal removes exactly the seeded rows and refuses once one advanced', () => {
    const { port } = seedWorld();
    const reversal = planEngagementSeedReversalFrom(port, {
      scope, sessionId, submissionId, seededByDecision: seededBy
    });
    expect(reversal.rows.map((row) => row.personId)).toEqual([personA, personB]);
    expect(validateEngagementSeedReversalFrom(port, reversal)).toEqual({ kind: 'ready' });

    const confirm = planEngagementMutation({
      planningInput: planningInput({
        action: 'record_confirmation',
        engagementId: headOf(port, personA).id,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      }),
      environment: { engagements: port }
    });
    port.applyEngagementPlan(confirm);
    expect(() => planEngagementSeedReversalFrom(port, {
      scope, sessionId, submissionId, seededByDecision: seededBy
    })).toThrow(EngagementSeedError);
    expect(validateEngagementSeedReversalFrom(port, reversal))
      .toEqual({ kind: 'refused', code: 'engagement_advanced' });
  });

  test('reversal selects only the reverted acceptance\'s own rows by their decision pin', () => {
    // A previous acceptance of the SAME submission seeded (S, A) and (S, B);
    // a stays-standing compensation preserved them. A re-acceptance then
    // seeded nothing (both pairs existed). Reversing the re-acceptance must
    // remove nothing — the survivors carry the first acceptance's pin.
    const { port } = seedWorld();
    const reversal = planEngagementSeedReversalFrom(port, {
      scope, sessionId, submissionId, seededByDecision: otherSeededBy
    });
    expect(reversal.rows).toEqual([]);
    applyEngagementSeedReversalFrom(port, reversal);
    expect(headOf(port, personA)).toMatchObject({ state: 'invited', version: 1 });
    expect(headOf(port, personB)).toMatchObject({ state: 'invited', version: 1 });

    // Even an ADVANCED survivor never blocks the re-acceptance's reversal:
    // it is outside that compensation's blast radius entirely.
    port.applyEngagementPlan(planEngagementMutation({
      planningInput: planningInput({
        action: 'record_confirmation',
        engagementId: headOf(port, personA).id,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      }),
      environment: { engagements: port }
    }));
    expect(planEngagementSeedReversalFrom(port, {
      scope, sessionId, submissionId, seededByDecision: otherSeededBy
    }).rows).toEqual([]);
    // The first acceptance's own reversal still refuses on its advanced row.
    expect(() => planEngagementSeedReversalFrom(port, {
      scope, sessionId, submissionId, seededByDecision: seededBy
    })).toThrow('engagement_advanced');
  });

  test('reversal of one submission leaves another submission\'s rows standing', () => {
    const { port } = seedWorld();
    const personC = '019c1df7-86b5-769b-bba4-5f7097bfa403';
    applyEngagementSeedFrom(port, planEngagementSeedFrom(port, {
      scope, sessionId, submissionId: otherSubmissionId,
      seededByDecision: otherSeededBy,
      source: { kind: 'submission', id: otherSubmissionId, version: 3 },
      personIds: [personC],
      invitedAt: later,
      respondBy: null
    }));
    const reversal = planEngagementSeedReversalFrom(port, {
      scope, sessionId, submissionId, seededByDecision: seededBy
    });
    applyEngagementSeedReversalFrom(port, reversal);
    expect(port.readSessionPersonEngagement(scope, sessionId, personA)).toBeUndefined();
    expect(port.readSessionPersonEngagement(scope, sessionId, personB)).toBeUndefined();
    expect(headOf(port, personC)).toMatchObject({ state: 'invited', submissionId: otherSubmissionId });
  });
});

describe('engagement state machine', () => {
  test('confirmation, decline, and the cancellation pair advance the head one fenced step', () => {
    const { port } = seedWorld();
    const invited = headOf(port, personA);
    const confirmed = planEngagementMutation({
      planningInput: planningInput({
        action: 'record_confirmation',
        engagementId: invited.id,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      }),
      environment: { engagements: port }
    });
    expect(confirmed.after).toMatchObject({
      state: 'confirmed',
      version: 2,
      confirmation: { attribution: 'organizer_recorded', personId: personA, recordedByUserId: userId }
    });
    port.applyEngagementPlan(confirmed);

    const requested = planEngagementMutation({
      planningInput: planningInput({
        action: 'request_cancellation',
        engagementId: invited.id,
        expectedEngagementVersion: 2,
        requestedBy: 'speaker',
        note: 'Travel fell through.'
      }),
      environment: { engagements: port }
    });
    port.applyEngagementPlan(requested);
    expect(isCancellationRequested(headOf(port, personA))).toBe(true);
    expect(() => planEngagementMutation({
      planningInput: planningInput({
        action: 'request_cancellation',
        engagementId: invited.id,
        expectedEngagementVersion: 3,
        requestedBy: 'organizer'
      }),
      environment: { engagements: port }
    })).toThrow('cancellation_already_requested');

    const cancelled = planEngagementMutation({
      planningInput: planningInput({
        action: 'accept_cancellation',
        engagementId: invited.id,
        expectedEngagementVersion: 3
      }),
      environment: { engagements: port }
    });
    expect(cancelled.after).toMatchObject({ state: 'cancelled', cancelledAt: later, version: 4 });
    port.applyEngagementPlan(cancelled);
    expect(isCancellationRequested(headOf(port, personA))).toBe(false);
  });

  test('refuses confirm-after-cancelled and every other illegal transition', () => {
    const { port } = seedWorld();
    const engagementId = headOf(port, personA).id;
    for (const [expectedVersion, action, extras] of [
      [1, 'request_cancellation', { requestedBy: 'speaker' }],
      [2, 'accept_cancellation', {}]
    ] as const) {
      port.applyEngagementPlan(planEngagementMutation({
        planningInput: planningInput({
          action, engagementId, expectedEngagementVersion: expectedVersion, ...extras
        }),
        environment: { engagements: port }
      }));
    }
    expect(headOf(port, personA).state).toBe('cancelled');
    for (const attempt of [
      { action: 'record_confirmation', attribution: 'self' },
      { action: 'decline' },
      { action: 'request_cancellation', requestedBy: 'organizer' },
      { action: 'accept_cancellation' }
    ] as const) {
      expect(() => planEngagementMutation({
        planningInput: planningInput({
          ...attempt, engagementId, expectedEngagementVersion: 3
        }),
        environment: { engagements: port }
      })).toThrow('invalid_transition');
    }

    const declined = headOf(port, personB);
    port.applyEngagementPlan(planEngagementMutation({
      planningInput: planningInput({
        action: 'decline', engagementId: declined.id, expectedEngagementVersion: 1
      }),
      environment: { engagements: port }
    }));
    expect(() => planEngagementMutation({
      planningInput: planningInput({
        action: 'record_confirmation',
        engagementId: declined.id,
        expectedEngagementVersion: 2,
        attribution: 'organizer_recorded'
      }),
      environment: { engagements: port }
    })).toThrow('invalid_transition');
    // Declined is terminal before any request check: no cancellation flow exists there.
    expect(() => planEngagementMutation({
      planningInput: planningInput({
        action: 'accept_cancellation', engagementId: declined.id, expectedEngagementVersion: 2
      }),
      environment: { engagements: port }
    })).toThrow('invalid_transition');
    // The request fence surfaces from a live state without a stored request.
    const fresh = seedWorld().port;
    expect(() => planEngagementMutation({
      planningInput: planningInput({
        action: 'accept_cancellation',
        engagementId: headOf(fresh, personA).id,
        expectedEngagementVersion: 1
      }),
      environment: { engagements: fresh }
    })).toThrow('cancellation_not_requested');
  });

  test('stale fences and missing heads refuse with typed codes', () => {
    const { port } = seedWorld();
    const engagementId = headOf(port, personA).id;
    expect(() => planEngagementMutation({
      planningInput: planningInput({
        action: 'decline', engagementId, expectedEngagementVersion: 9
      }),
      environment: { engagements: port }
    })).toThrow('stale_engagement');
    expect(() => planEngagementMutation({
      planningInput: planningInput({
        action: 'decline',
        engagementId: '019c1df7-86b5-769b-bba4-5f7097bfaff0',
        expectedEngagementVersion: 1
      }),
      environment: { engagements: port }
    })).toThrow('engagement_missing');
    try {
      planEngagementMutation({
        planningInput: planningInput({
          action: 'decline', engagementId, expectedEngagementVersion: 9
        }),
        environment: { engagements: port }
      });
      throw new TypeError('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(EngagementPlanningError);
      expect((error as EngagementPlanningError).code).toBe('stale_engagement');
    }
  });

  test('resolution attaches server attribution and lowercases the wire id', () => {
    const { port } = seedWorld();
    const engagementId = headOf(port, personA).id;
    const resolved = resolveEngagementMutationPlanningInput({
      authorInput: {
        action: 'decline',
        engagementId: engagementId.toUpperCase(),
        expectedEngagementVersion: 1
      },
      scope,
      actorUserId: userId,
      occurredAt: later
    });
    expect(resolved).toMatchObject({ engagementId, scope, actorUserId: userId, occurredAt: later });
    expect(validateEngagementMutationPlan({
      plan: planEngagementMutation({ planningInput: resolved, environment: { engagements: port } }),
      environment: { engagements: port }
    })).toBeUndefined();
  });

  test('the operator resolver refuses fabricated participant-attributed confirmations', () => {
    const { port } = seedWorld();
    const engagementId = headOf(port, personA).id;
    // An operator can never mint a `self` or `co_speaker` confirmation whose
    // head would erase the recording user; the wire admits organizer_recorded
    // only, and the resolved head names the recorder.
    for (const attribution of ['self', 'co_speaker'] as const) {
      expect(() => resolveEngagementMutationPlanningInput({
        authorInput: {
          action: 'record_confirmation',
          engagementId,
          expectedEngagementVersion: 1,
          attribution
        } as never,
        scope,
        actorUserId: userId,
        occurredAt: later
      })).toThrow();
    }
    const resolved = resolveEngagementMutationPlanningInput({
      authorInput: {
        action: 'record_confirmation',
        engagementId,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      },
      scope,
      actorUserId: userId,
      occurredAt: later
    });
    const plan = planEngagementMutation({
      planningInput: resolved, environment: { engagements: port }
    });
    expect(plan.after.confirmation).toMatchObject({
      attribution: 'organizer_recorded', personId: personA, recordedByUserId: userId
    });
  });
});

describe('engagement compensation', () => {
  test('restores the exact before image while untouched and blocks after movement', () => {
    const { port } = seedWorld();
    const engagementId = headOf(port, personA).id;
    const confirm = planEngagementMutation({
      planningInput: planningInput({
        action: 'record_confirmation',
        engagementId,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      }),
      environment: { engagements: port }
    });
    port.applyEngagementPlan(confirm);
    const compensation = planEngagementCompensation({
      original: confirm,
      environment: { engagements: port },
      actorUserId: userId,
      occurredAt: later
    });
    if (compensation.kind !== 'exact') throw new TypeError('expected_exact');
    expect(compensation.plan.restore).toMatchObject({ state: 'invited', version: 3 });
    port.applyEngagementPlan(compensation.plan);
    expect(headOf(port, personA)).toMatchObject({
      state: 'invited', version: 3, confirmation: null
    });

    const reconfirm = planEngagementMutation({
      planningInput: planningInput({
        action: 'record_confirmation',
        engagementId,
        expectedEngagementVersion: 3,
        attribution: 'organizer_recorded'
      }),
      environment: { engagements: port }
    });
    port.applyEngagementPlan(reconfirm);
    port.applyEngagementPlan(planEngagementMutation({
      planningInput: planningInput({
        action: 'request_cancellation',
        engagementId,
        expectedEngagementVersion: 4,
        requestedBy: 'speaker'
      }),
      environment: { engagements: port }
    }));
    expect(planEngagementCompensation({
      original: reconfirm,
      environment: { engagements: port },
      actorUserId: userId,
      occurredAt: later
    })).toEqual({ kind: 'blocked', reasonKey: 'engagement.changed' });
  });
});

describe('engagement changeset bundle', () => {
  test('plans, validates, applies, and derives compensation through the declared ports', () => {
    const { port } = seedWorld();
    const bundle = createEngagementChangesetBundle();
    const snapshot = Object.freeze({
      getPort<Port>(key: unknown): Port {
        if (key !== engagementReadPort) throw new TypeError('undeclared_read_port');
        return port as unknown as Port;
      }
    });
    const commitTransaction = Object.freeze({
      getPort<Port>(key: unknown): Port {
        if (key !== engagementValidationPort && key !== engagementTransactionPort) {
          throw new TypeError('undeclared_transaction_port');
        }
        return port as unknown as Port;
      }
    });
    const engagementId = headOf(port, personA).id;
    const planned = bundle.definition.plan(planningInput({
      action: 'record_confirmation',
      engagementId,
      expectedEngagementVersion: 1,
      attribution: 'organizer_recorded'
    }), snapshot as never);
    if (planned instanceof Promise) throw new TypeError('unexpected_async_plan');
    expect(planned.riskTier).toBe('consequential');
    expect(planned.aggregateRefs).toEqual([
      { id: engagementAggregateId(engagementId), version: 1 }
    ]);
    expect(planned.guardRefs).toEqual([]);
    const diff = bundle.definition.projectDiff(planned.plan);
    expect(diff.diff.action).toBe('record_confirmation');

    const validation = bundle.definition.validateWithin(planned.plan, commitTransaction as never);
    if (validation instanceof Promise) throw new TypeError('unexpected_async_validate');
    expect(validation.kind).toBe('ready');
    const applied = bundle.definition.applyWithin(planned.plan, commitTransaction as never);
    if (applied instanceof Promise) throw new TypeError('unexpected_async_apply');
    expect(applied.facts).toEqual([
      {
        kind: 'engagement_changed',
        version: 1,
        payload: { action: 'record_confirmation', engagement: headOf(port, personA) }
      }
    ]);
    expect(applied.effects).toEqual([]);

    const stale = bundle.definition.validateWithin(planned.plan, commitTransaction as never);
    if (stale instanceof Promise) throw new TypeError('unexpected_async_validate');
    if (stale.kind !== 'outcome') throw new TypeError('expected_outcome');
    expect(stale.outcome).toMatchObject({
      class: 'stale_revision', kind: 'engagement.changed'
    });

    const derived = bundle.definition.deriveCompensation(planned.plan, snapshot as never);
    if (derived instanceof Promise) throw new TypeError('unexpected_async_compensation');
    if (derived.kind !== 'exact') throw new TypeError('expected_exact');
    expect(canonical(derived.authorInput)).toContain('"action":"restore"');
    const restorePlanned = bundle.definition.plan(derived.authorInput, snapshot as never);
    if (restorePlanned instanceof Promise) throw new TypeError('unexpected_async_plan');
    const restoreApplied = bundle.definition.applyWithin(
      restorePlanned.plan, commitTransaction as never
    );
    if (restoreApplied instanceof Promise) throw new TypeError('unexpected_async_apply');
    expect(restoreApplied.result).toMatchObject({ action: 'restore' });
    expect(headOf(port, personA)).toMatchObject({ state: 'invited', version: 3 });
    expect(bundle.definition.deriveCompensation(restorePlanned.plan, snapshot as never))
      .toEqual({ kind: 'blocked', reasonKey: 'engagement.compensation_of_compensation' });
  });

  test('owner identity and fact grammar are the exported module surface', () => {
    const bundle = createEngagementChangesetBundle();
    expect(bundle.definition.kind).toBe('engagement.respond');
    expect(bundle.definition.allowedAggregateKinds).toEqual(['engagement_head']);
    expect(bundle.definition.allowedGuardKinds).toEqual([]);
    expect(bundle.definition.allowedEffects).toEqual([]);
  });
});
