import { describe, expect, test } from 'bun:test';
import type { SessionRestorePlanDto } from '@jooevents/contracts';
import { createProgramVocabularyState } from '@jooevents/program';
import { parseSchedulePlacementScope } from '@jooevents/schedule';
import {
  applySessionMutationPlan,
  applySessionRestorePlan,
  createEmptySessionCatalog,
  createSchedulePlaceableSessionPort,
  createSessionChangesetBundle,
  createSessionFormTargetPort,
  findSession,
  planSessionCompensation,
  planSessionGraduationFrom,
  planSessionGraduationReversalFrom,
  planSessionMutation,
  projectSessionGraduationDiff,
  sessionGraduationAggregateRefs,
  sessionGraduationFactPayload,
  sessionGraduationGuardRefs,
  sessionGraduationPin,
  sessionHeadDigest,
  sessionRosterCount,
  sessionRosterDigest,
  SessionPlanningError,
  validateSessionGraduationFrom,
  validateSessionGraduationReversalFrom,
  type SessionCatalog
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa202';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa302';
const otherTrackId = '019c1df7-86b5-769b-bba4-5f7097bfa303';
const now = '2026-08-13T08:00:00.000Z';
const later = '2026-08-13T08:05:00.000Z';
const scheduleScope = parseSchedulePlacementScope(scope);

function vocabulary(input: {
  readonly retiredFormat?: boolean;
  readonly setVersion?: number;
  readonly tracks?: 'none' | 'one' | 'two';
} = {}) {
  return createProgramVocabularyState({
    scope,
    setVersion: input.setVersion ?? 1,
    formats: [{
      id: formatId,
      name: 'Talk',
      status: input.retiredFormat ? 'retired' : 'active',
      version: input.retiredFormat ? 2 : 1
    }],
    tracks: input.tracks === 'none' ? [] : [
      { id: trackId, name: 'Platform', status: 'active', version: 1 },
      ...(input.tracks === 'two'
        ? [{ id: otherTrackId, name: 'Practice', status: 'active' as const, version: 1 }]
        : [])
    ]
  });
}

function createPlan(catalog: SessionCatalog, lifecycle: 'draft' | 'collecting' | 'programmed' = 'draft') {
  return planSessionMutation({
    catalog,
    vocabulary: vocabulary(),
    planningInput: {
      action: 'create',
      scope,
      sessionId,
      actorUserId: userId,
      occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Canonical Session',
      plannedDurationMinutes: 45,
      lifecycle,
      formatId,
      trackId
    }
  });
}

describe('canonical Session foundation', () => {
  test('makes track omission safe at the lifecycle boundary and repairs legacy heads', () => {
    const empty = createEmptySessionCatalog(scope);
    const baseInput = {
      action: 'create' as const,
      scope,
      sessionId,
      actorUserId: userId,
      occurredAt: now,
      expectedCatalogVersion: empty.version,
      expectedCatalogDigestSha256: empty.digestSha256,
      title: 'Classification boundary',
      plannedDurationMinutes: 45,
      formatId,
      trackId: null
    };

    const sole = planSessionMutation({
      catalog: empty,
      vocabulary: vocabulary(),
      planningInput: { ...baseInput, lifecycle: 'programmed' }
    });
    expect(sole.after.programTarget.track?.id).toBe(trackId);

    expect(() => planSessionMutation({
      catalog: empty,
      vocabulary: vocabulary({ tracks: 'two' }),
      planningInput: { ...baseInput, lifecycle: 'programmed' }
    })).toThrow('track_required');
    expect(planSessionMutation({
      catalog: empty,
      vocabulary: vocabulary({ tracks: 'two' }),
      planningInput: { ...baseInput, lifecycle: 'draft' }
    }).after.programTarget.track).toBeNull();

    const legacyPlan = planSessionMutation({
      catalog: empty,
      vocabulary: vocabulary({ tracks: 'none' }),
      planningInput: { ...baseInput, lifecycle: 'programmed' }
    });
    const legacyCatalog = applySessionMutationPlan({
      catalog: empty,
      vocabulary: vocabulary({ tracks: 'none' }),
      plan: legacyPlan
    }).catalog;
    const legacy = findSession(legacyCatalog, sessionId)!;
    const repaired = planSessionMutation({
      catalog: legacyCatalog,
      vocabulary: vocabulary({ tracks: 'two', setVersion: 2 }),
      planningInput: {
        action: 'retarget', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: legacyCatalog.version,
        expectedCatalogDigestSha256: legacyCatalog.digestSha256,
        expectedSessionVersion: legacy.version,
        expectedSessionDigestSha256: legacy.digestSha256,
        formatId,
        trackId: otherTrackId
      }
    });
    expect(repaired.before?.programTarget.track).toBeNull();
    expect(repaired.after.programTarget.track?.id).toBe(otherTrackId);
  });

  test('retains exact active Program Vocabulary evidence and exposes lifecycle-bounded adapters', () => {
    const empty = createEmptySessionCatalog(scope);
    const created = applySessionMutationPlan({
      catalog: empty,
      vocabulary: vocabulary(),
      plan: createPlan(empty)
    }).catalog;
    const draft = findSession(created, sessionId)!;
    expect(draft.programTarget).toMatchObject({
      setVersion: 1,
      format: { id: formatId, name: 'Talk', status: 'active', version: 1 },
      track: { id: trackId, name: 'Platform', status: 'active', version: 1 }
    });
    expect(sessionRosterCount(draft)).toBe(0);

    const source = { readSessionCatalog: () => created };
    expect(createSessionFormTargetPort(source).resolveCollectingSession(
      scope, { kind: 'session', sessionId }
    )).toBeUndefined();
    expect(createSchedulePlaceableSessionPort(source).readPlaceableSession(scheduleScope, sessionId as never))
      .toBeUndefined();

    const transition = planSessionMutation({
      catalog: created,
      vocabulary: vocabulary({ setVersion: 2 }),
      planningInput: {
        action: 'transition', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: draft.version,
        expectedSessionDigestSha256: draft.digestSha256,
        to: 'collecting'
      }
    });
    const collecting = applySessionMutationPlan({
      catalog: created, vocabulary: vocabulary({ setVersion: 2 }), plan: transition
    }).catalog;
    const collectingSource = { readSessionCatalog: () => collecting };
    expect(findSession(collecting, sessionId)?.programTarget.setVersion).toBe(2);
    expect(createSessionFormTargetPort(collectingSource).resolveCollectingSession(
      scope, { kind: 'session', sessionId }
    )).toMatchObject({ id: sessionId, title: 'Canonical Session', lifecycle: 'collecting', version: 2 });
    expect(createSchedulePlaceableSessionPort(collectingSource).readPlaceableSession(scheduleScope, sessionId as never))
      .toMatchObject({ id: sessionId, lifecycle: 'collecting', trackId });
  });

  test('permits only forward ordinary lifecycle transitions and refuses retired current references', () => {
    const empty = createEmptySessionCatalog(scope);
    const collectingPlan = createPlan(empty, 'collecting');
    const collectingCatalog = applySessionMutationPlan({
      catalog: empty, vocabulary: vocabulary(), plan: collectingPlan
    }).catalog;
    const collecting = findSession(collectingCatalog, sessionId)!;
    const programPlan = planSessionMutation({
      catalog: collectingCatalog,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'transition', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: collectingCatalog.version,
        expectedCatalogDigestSha256: collectingCatalog.digestSha256,
        expectedSessionVersion: collecting.version,
        expectedSessionDigestSha256: collecting.digestSha256,
        to: 'programmed'
      }
    });
    const programmedCatalog = applySessionMutationPlan({
      catalog: collectingCatalog, vocabulary: vocabulary(), plan: programPlan
    }).catalog;
    expect(findSession(programmedCatalog, sessionId)?.lifecycle).toBe('programmed');
    expect(() => planSessionMutation({
      catalog: programmedCatalog,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'transition', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: programmedCatalog.version,
        expectedCatalogDigestSha256: programmedCatalog.digestSha256,
        expectedSessionVersion: findSession(programmedCatalog, sessionId)!.version,
        expectedSessionDigestSha256: findSession(programmedCatalog, sessionId)!.digestSha256,
        to: 'programmed'
      }
    })).toThrow('invalid_transition');
    expect(() => planSessionMutation({
      catalog: collectingCatalog,
      vocabulary: vocabulary({ retiredFormat: true, setVersion: 2 }),
      planningInput: programPlan.input
    })).toThrow('format_retired');
  });

  test('guards stale plans, restores exact prior meaning, and refuses replay without a second write', () => {
    const empty = createEmptySessionCatalog(scope);
    const plan = createPlan(empty, 'programmed');
    const applied = applySessionMutationPlan({ catalog: empty, vocabulary: vocabulary(), plan });
    expect(() => applySessionMutationPlan({ catalog: applied.catalog, vocabulary: vocabulary(), plan }))
      .toThrow('stale_catalog');

    const compensation = planSessionCompensation({
      original: plan,
      catalog: applied.catalog,
      actorUserId: userId,
      occurredAt: later
    });
    const restored = applySessionRestorePlan({ catalog: applied.catalog, plan: compensation });
    expect(restored.catalog.sessions).toEqual([]);
    expect(() => applySessionRestorePlan({ catalog: restored.catalog, plan: compensation }))
      .toThrow('stale_catalog');
  });

  test('never treats a Schedule occurrence row as Session identity', () => {
    const source = { readSessionCatalog: () => createEmptySessionCatalog(scope) };
    const occurrence = { sessionId, roomId: trackId, startAt: now, endAt: later };
    expect(occurrence.sessionId).toBe(sessionId);
    expect(createSchedulePlaceableSessionPort(source).readPlaceableSession(scheduleScope, sessionId as never))
      .toBeUndefined();
  });

  test('registers the Session mutation definition in the generic changeset registry', () => {
    const bundle = createSessionChangesetBundle();
    expect(bundle.registry.get('session.mutate', 1)).toBe(bundle.definition);
  });

  test('blocks deriving the compensating delete of a create while the Session is placed', () => {
    const bundle = createSessionChangesetBundle();
    const empty = createEmptySessionCatalog(scope);
    const plan = createPlan(empty, 'programmed');
    const catalog = applySessionMutationPlan({ catalog: empty, vocabulary: vocabulary(), plan }).catalog;
    let placements = 1;
    const port = {
      readSessionCatalog: () => catalog,
      readSessionVocabulary: () => vocabulary(),
      countSessionSchedulePlacements: (_: typeof scope, id: string) =>
        id === sessionId ? placements : 0
    };
    const snapshot = { getPort: <Port>() => port as unknown as Port };

    expect(bundle.definition.deriveCompensation(plan, snapshot))
      .toEqual({ kind: 'blocked', reasonKey: 'session.placed' });

    placements = 0;
    expect(bundle.definition.deriveCompensation(plan, snapshot)).toMatchObject({
      kind: 'exact',
      authorInput: { action: 'restore', expectedCurrent: { id: sessionId }, restore: null }
    });
  });

  test('keeps prior-image compensation ungated while the Session is placed', () => {
    const bundle = createSessionChangesetBundle();
    const empty = createEmptySessionCatalog(scope);
    const created = applySessionMutationPlan({
      catalog: empty, vocabulary: vocabulary(), plan: createPlan(empty, 'collecting')
    }).catalog;
    const collecting = findSession(created, sessionId)!;
    const transition = planSessionMutation({
      catalog: created,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'transition', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: collecting.version,
        expectedSessionDigestSha256: collecting.digestSha256,
        to: 'programmed'
      }
    });
    const catalog = applySessionMutationPlan({
      catalog: created, vocabulary: vocabulary(), plan: transition
    }).catalog;
    const port = {
      readSessionCatalog: () => catalog,
      readSessionVocabulary: () => vocabulary(),
      countSessionSchedulePlacements: () => 1
    };
    const derived = bundle.definition.deriveCompensation(transition, {
      getPort: <Port>() => port as unknown as Port
    });
    expect(derived).toMatchObject({
      kind: 'exact',
      authorInput: { action: 'restore', restore: { lifecycle: 'collecting' } }
    });
    const restorePlan = (derived as { readonly authorInput: SessionRestorePlanDto }).authorInput;
    expect(bundle.definition.validateWithin(restorePlan, {
      getPort: <Port>() => port as unknown as Port
    })).toEqual({ kind: 'ready', validated: restorePlan });
  });

  test('refuses a stored deleting restore at replan and commit validate after a placement lands', () => {
    const bundle = createSessionChangesetBundle();
    const empty = createEmptySessionCatalog(scope);
    const plan = createPlan(empty, 'programmed');
    const catalog = applySessionMutationPlan({ catalog: empty, vocabulary: vocabulary(), plan }).catalog;
    let placements = 0;
    const port = {
      readSessionCatalog: () => catalog,
      readSessionVocabulary: () => vocabulary(),
      countSessionSchedulePlacements: (_: typeof scope, id: string) =>
        id === sessionId ? placements : 0
    };
    const snapshot = { getPort: <Port>() => port as unknown as Port };
    const validation = { getPort: <Port>() => port as unknown as Port };

    const derived = bundle.definition.deriveCompensation(plan, snapshot);
    expect(derived).toMatchObject({ kind: 'exact' });
    const restorePlan = (derived as { readonly authorInput: SessionRestorePlanDto }).authorInput;
    expect(bundle.definition.plan(restorePlan, snapshot)).toMatchObject({ plan: restorePlan });
    expect(bundle.definition.validateWithin(restorePlan, validation))
      .toEqual({ kind: 'ready', validated: restorePlan });

    // The placement lands after the compensation was derived and proposed. It
    // moves neither the Session digest nor the catalog digest, so only the
    // reference gate can refuse the delete.
    placements = 1;
    expect(() => bundle.definition.plan(restorePlan, snapshot)).toThrow('session_placed');
    expect(bundle.definition.validateWithin(restorePlan, validation)).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'session.changed',
        retryable: false,
        subjects: [{ type: 'session', id: sessionId }],
        detail: { code: 'session_placed', action: 'restore', sessionId },
        detailSchemaVersion: 3
      }
    });
  });

  test('seeds create-time participants with person-keyed dedup and canonical positions', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 7 };
    const plan = planSessionMutation({
      catalog: empty,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
        expectedCatalogVersion: empty.version,
        expectedCatalogDigestSha256: empty.digestSha256,
        title: 'Seeded Session', plannedDurationMinutes: 30,
        lifecycle: 'programmed', formatId, trackId: null,
        participants: [
          { personId: personA, role: 'speaker', publiclyVisible: true, source },
          { personId: personA, role: 'panelist', publiclyVisible: true, source },
          { personId: personB, role: 'speaker', publiclyVisible: false, source }
        ]
      }
    });
    expect(plan.after.roster.participants).toEqual([
      { personId: personA, role: 'speaker', position: 0, publiclyVisible: true, source },
      { personId: personB, role: 'speaker', position: 1, publiclyVisible: false, source }
    ]);
    const applied = applySessionMutationPlan({ catalog: empty, vocabulary: vocabulary(), plan });
    expect(sessionRosterCount(findSession(applied.catalog, sessionId)!)).toBe(2);
  });

  test('appends roster under person-keyed dedup, never clobbers, and graduates in place', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 1 };
    const created = applySessionMutationPlan({
      catalog: empty,
      vocabulary: vocabulary(),
      plan: planSessionMutation({
        catalog: empty,
        vocabulary: vocabulary(),
        planningInput: {
          action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
          expectedCatalogVersion: empty.version,
          expectedCatalogDigestSha256: empty.digestSha256,
          title: 'Collecting Panel', plannedDurationMinutes: 60,
          lifecycle: 'collecting', formatId, trackId,
          participants: [{ personId: personA, role: 'speaker', publiclyVisible: true, source }]
        }
      })
    }).catalog;
    const collecting = findSession(created, sessionId)!;

    const appendPlan = planSessionMutation({
      catalog: created,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'roster_append', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: collecting.version,
        expectedSessionDigestSha256: collecting.digestSha256,
        participants: [
          { personId: personA, role: 'moderator', publiclyVisible: true, source },
          { personId: personB, role: 'speaker', publiclyVisible: true, source }
        ],
        graduateTo: 'programmed'
      }
    });
    expect(appendPlan.after.roster.participants).toEqual([
      { personId: personA, role: 'speaker', position: 0, publiclyVisible: true, source },
      { personId: personB, role: 'speaker', position: 1, publiclyVisible: true, source }
    ]);
    expect(appendPlan.after.roster.version).toBe(collecting.roster.version + 1);
    expect(appendPlan.after.lifecycle).toBe('programmed');
    const graduated = applySessionMutationPlan({
      catalog: created, vocabulary: vocabulary(), plan: appendPlan
    }).catalog;
    const programmed = findSession(graduated, sessionId)!;
    expect(programmed.version).toBe(collecting.version + 1);

    const idempotent = planSessionMutation({
      catalog: graduated,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'roster_append', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: graduated.version,
        expectedCatalogDigestSha256: graduated.digestSha256,
        expectedSessionVersion: programmed.version,
        expectedSessionDigestSha256: programmed.digestSha256,
        participants: [{ personId: personB, role: 'panelist', publiclyVisible: false, source }]
      }
    });
    expect(idempotent.after.roster).toEqual(programmed.roster);
    expect(idempotent.after.version).toBe(programmed.version + 1);

    expect(() => planSessionMutation({
      catalog: graduated,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'roster_append', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: graduated.version,
        expectedCatalogDigestSha256: graduated.digestSha256,
        expectedSessionVersion: programmed.version,
        expectedSessionDigestSha256: programmed.digestSha256,
        participants: [{ personId: personB, role: 'panelist', publiclyVisible: false, source }],
        graduateTo: 'programmed'
      }
    })).toThrow('invalid_transition');

    const compensation = planSessionCompensation({
      original: appendPlan, catalog: graduated, actorUserId: userId, occurredAt: later
    });
    const restored = applySessionRestorePlan({ catalog: graduated, plan: compensation });
    const rolledBack = findSession(restored.catalog, sessionId)!;
    expect(rolledBack.lifecycle).toBe('collecting');
    expect(rolledBack.roster.participants).toEqual(collecting.roster.participants);
    expect(rolledBack.roster.version).toBe(collecting.roster.version);
  });

  test('switches one participant visibility flag in place and compensates exactly', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 1 };
    const created = applySessionMutationPlan({
      catalog: empty,
      vocabulary: vocabulary(),
      plan: planSessionMutation({
        catalog: empty,
        vocabulary: vocabulary(),
        planningInput: {
          action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
          expectedCatalogVersion: empty.version,
          expectedCatalogDigestSha256: empty.digestSha256,
          title: 'Visible Panel', plannedDurationMinutes: 60,
          lifecycle: 'programmed', formatId, trackId,
          participants: [
            { personId: personA, role: 'speaker', publiclyVisible: true, source },
            { personId: personB, role: 'speaker', publiclyVisible: true, source }
          ]
        }
      })
    }).catalog;
    const programmed = findSession(created, sessionId)!;

    const hidePlan = planSessionMutation({
      catalog: created,
      // The off-switch never refreshes Program Vocabulary evidence, so a moved
      // set must not disturb the retained pins.
      vocabulary: vocabulary({ setVersion: 2 }),
      planningInput: {
        action: 'roster_visibility', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: programmed.version,
        expectedSessionDigestSha256: programmed.digestSha256,
        personId: personA,
        publiclyVisible: false
      }
    });
    expect(hidePlan.after.roster.participants).toEqual([
      { personId: personA, role: 'speaker', position: 0, publiclyVisible: false, source },
      { personId: personB, role: 'speaker', position: 1, publiclyVisible: true, source }
    ]);
    expect(hidePlan.after.roster.version).toBe(programmed.roster.version + 1);
    expect(hidePlan.after.version).toBe(programmed.version + 1);
    expect(hidePlan.after.lifecycle).toBe('programmed');
    expect(hidePlan.after.programTarget).toEqual(programmed.programTarget);

    const hidden = applySessionMutationPlan({
      catalog: created, vocabulary: vocabulary({ setVersion: 2 }), plan: hidePlan
    }).catalog;
    const hiddenHead = findSession(hidden, sessionId)!;

    const idempotent = planSessionMutation({
      catalog: hidden,
      vocabulary: vocabulary({ setVersion: 2 }),
      planningInput: {
        action: 'roster_visibility', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: hidden.version,
        expectedCatalogDigestSha256: hidden.digestSha256,
        expectedSessionVersion: hiddenHead.version,
        expectedSessionDigestSha256: hiddenHead.digestSha256,
        personId: personA,
        publiclyVisible: false
      }
    });
    expect(idempotent.after.roster).toEqual(hiddenHead.roster);
    expect(idempotent.after.version).toBe(hiddenHead.version + 1);

    expect(() => planSessionMutation({
      catalog: hidden,
      vocabulary: vocabulary({ setVersion: 2 }),
      planningInput: {
        action: 'roster_visibility', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: hidden.version,
        expectedCatalogDigestSha256: hidden.digestSha256,
        expectedSessionVersion: hiddenHead.version,
        expectedSessionDigestSha256: hiddenHead.digestSha256,
        personId: '019c1df7-86b5-769b-bba4-5f7097bfa999',
        publiclyVisible: false
      }
    })).toThrow('participant_missing');

    expect(() => planSessionMutation({
      catalog: hidden,
      vocabulary: vocabulary({ setVersion: 2 }),
      planningInput: {
        action: 'roster_visibility', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: hidden.version,
        expectedCatalogDigestSha256: hidden.digestSha256,
        expectedSessionVersion: programmed.version,
        expectedSessionDigestSha256: programmed.digestSha256,
        personId: personA,
        publiclyVisible: true
      }
    })).toThrow('stale_session');

    const bundle = createSessionChangesetBundle();
    const port = {
      readSessionCatalog: () => hidden,
      readSessionVocabulary: () => vocabulary({ setVersion: 2 }),
      countSessionSchedulePlacements: () => 1
    };
    const snapshot = { getPort: <Port>() => port as unknown as Port };
    const derived = bundle.definition.deriveCompensation(hidePlan, snapshot);
    expect(derived).toMatchObject({ kind: 'exact', authorInput: { action: 'restore' } });
    const restored = applySessionRestorePlan({
      catalog: hidden,
      plan: (derived as { readonly authorInput: SessionRestorePlanDto }).authorInput
    });
    const visibleAgain = findSession(restored.catalog, sessionId)!;
    expect(visibleAgain.roster.participants).toEqual(programmed.roster.participants);
    expect(visibleAgain.roster.version).toBe(programmed.roster.version);
  });

  test('roster visibility plans fence only the catalog guard, never the vocabulary set', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 1 };
    const created = applySessionMutationPlan({
      catalog: empty,
      vocabulary: vocabulary(),
      plan: planSessionMutation({
        catalog: empty,
        vocabulary: vocabulary(),
        planningInput: {
          action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
          expectedCatalogVersion: empty.version,
          expectedCatalogDigestSha256: empty.digestSha256,
          title: 'Guarded Panel', plannedDurationMinutes: 60,
          lifecycle: 'programmed', formatId, trackId,
          participants: [{ personId: personA, role: 'speaker', publiclyVisible: true, source }]
        }
      })
    }).catalog;
    const programmed = findSession(created, sessionId)!;
    const bundle = createSessionChangesetBundle();
    const port = {
      readSessionCatalog: () => created,
      readSessionVocabulary: () => vocabulary(),
      countSessionSchedulePlacements: () => 0
    };
    const planned = bundle.definition.plan({
      action: 'roster_visibility', scope, sessionId, actorUserId: userId, occurredAt: later,
      expectedCatalogVersion: created.version,
      expectedCatalogDigestSha256: created.digestSha256,
      expectedSessionVersion: programmed.version,
      expectedSessionDigestSha256: programmed.digestSha256,
      personId: personA,
      publiclyVisible: false
    }, { getPort: <Port>() => port as unknown as Port });
    if (planned instanceof Promise) throw new Error('expected a synchronous plan');
    expect(planned.guardRefs).toEqual([{
      id: `session_catalog:${scope.eventId}`,
      version: created.version,
      digest: created.digestSha256
    }]);
    expect(planned.aggregateRefs).toEqual([
      { id: `session:${sessionId}`, version: programmed.version }
    ]);
  });

  test('graduation collaboration plans spawn and attach, pins the applied head, and reverses', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 3 };
    let catalog = empty;
    const port = {
      readSessionCatalog: () => catalog,
      readSessionVocabulary: () => vocabulary(),
      countSessionSchedulePlacements: () => 0
    };
    const spawn = planSessionGraduationFrom(port, {
      kind: 'spawn',
      scope,
      attribution: { userId, at: now },
      identity: { sessionId },
      title: 'Spawned Session',
      plannedDurationMinutes: 30,
      lifecycle: 'programmed',
      formatId,
      trackId: null,
      participants: [{ personId: personA, role: 'speaker', publiclyVisible: true, source }]
    });
    expect(validateSessionGraduationFrom(port, spawn)).toEqual({ kind: 'ready' });
    expect(sessionGraduationAggregateRefs(spawn)).toEqual([]);
    expect(sessionGraduationGuardRefs(spawn)).toEqual([{
      id: `session_catalog:${scope.eventId}`,
      version: empty.version,
      digest: empty.digestSha256
    }]);
    expect(projectSessionGraduationDiff(spawn)).toEqual({
      action: 'create', before: null, after: spawn.after
    });
    catalog = applySessionMutationPlan({ catalog, vocabulary: vocabulary(), plan: spawn }).catalog;
    expect(sessionGraduationPin(spawn)).toEqual({
      sessionId, version: 1, digestSha256: spawn.after.digestSha256, lifecycle: 'programmed'
    });
    expect(sessionGraduationFactPayload(spawn)).toEqual({
      action: 'create', catalogVersion: catalog.version, session: spawn.after
    });

    const attach = planSessionGraduationFrom(port, {
      kind: 'attach',
      scope,
      attribution: { userId, at: later },
      sessionId,
      participants: [{ personId: personB, role: 'panelist', publiclyVisible: true, source }]
    });
    expect(attach.after.roster.participants.map((participant) => participant.personId))
      .toEqual([personA, personB]);
    expect(sessionGraduationAggregateRefs(attach)).toEqual([
      { id: `session:${sessionId}`, version: 1 }
    ]);
    const beforeAttach = catalog;
    catalog = applySessionMutationPlan({ catalog, vocabulary: vocabulary(), plan: attach }).catalog;
    expect(validateSessionGraduationFrom({ ...port, readSessionCatalog: () => beforeAttach }, attach))
      .toEqual({ kind: 'ready' });

    const reversal = planSessionGraduationReversalFrom(port, {
      original: attach, attribution: { userId, at: later }
    });
    expect(validateSessionGraduationReversalFrom(port, reversal)).toEqual({ kind: 'ready' });
    catalog = applySessionRestorePlan({ catalog, plan: reversal }).catalog;
    expect(findSession(catalog, sessionId)!.roster.participants.map((participant) => participant.personId))
      .toEqual([personA]);
  });

  test('refuses a schema-valid roster tamper that does not replan identically', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 1 };
    const created = applySessionMutationPlan({
      catalog: empty, vocabulary: vocabulary(), plan: createPlan(empty, 'collecting')
    }).catalog;
    const collecting = findSession(created, sessionId)!;
    const plan = planSessionMutation({
      catalog: created,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'roster_append', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: collecting.version,
        expectedSessionDigestSha256: collecting.digestSha256,
        participants: [{ personId: personA, role: 'speaker', publiclyVisible: true, source }]
      }
    });
    const tamperedRosterUnsigned = {
      version: plan.after.roster.version,
      participants: [{ ...plan.after.roster.participants[0]!, publiclyVisible: false }]
    };
    const tamperedRoster = {
      ...tamperedRosterUnsigned,
      digestSha256: sessionRosterDigest(tamperedRosterUnsigned)
    };
    const { digestSha256: _afterDigest, ...unsignedAfter } = plan.after;
    const tamperedAfterUnsigned = { ...unsignedAfter, roster: tamperedRoster };
    const tampered = {
      ...plan,
      after: { ...tamperedAfterUnsigned, digestSha256: sessionHeadDigest(tamperedAfterUnsigned) }
    };
    expect(() => applySessionMutationPlan({
      catalog: created, vocabulary: vocabulary(), plan: tampered as typeof plan
    })).toThrow('invalid_plan');
  });
});
