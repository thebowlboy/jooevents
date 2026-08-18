import { describe, expect, test } from 'bun:test';
import { createProgramVocabularyState } from '@jooevents/program';
import { parseSchedulePlacementScope } from '@jooevents/schedule';
import {
  applySessionMutationPlan,
  applyNewSessionRemovalPlan,
  applySessionRestorePlan,
  createEmptySessionCatalog,
  createSchedulePlaceableSessionPort,
  createSessionFormTargetPort,
  findSession,
  planSessionCompensation,
  planSessionGraduationFrom,
  planSessionGraduationReversalFrom,
  planSessionMutation,
  planNewSessionRemoval,
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
  test('stores organizer-authored public copy, updates or clears it under guards, and compensates exactly', () => {
    const empty = createEmptySessionCatalog(scope);
    const create = planSessionMutation({
      catalog: empty,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
        expectedCatalogVersion: empty.version,
        expectedCatalogDigestSha256: empty.digestSha256,
        title: 'Described Session',
        description: '  A practical\n\n  session about dependable systems.  ',
        plannedDurationMinutes: 45, lifecycle: 'programmed', formatId, trackId
      }
    });
    const created = applySessionMutationPlan({ catalog: empty, vocabulary: vocabulary(), plan: create }).catalog;
    const original = findSession(created, sessionId)!;
    expect(original.description).toBe('A practical\n\nsession about dependable systems.');

    const clear = planSessionMutation({
      catalog: created,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'content_update', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: original.version,
        expectedSessionDigestSha256: original.digestSha256,
        title: 'Updated Session',
        description: null
      }
    });
    const cleared = applySessionMutationPlan({ catalog: created, vocabulary: vocabulary(), plan: clear }).catalog;
    expect(findSession(cleared, sessionId)?.title).toBe('Updated Session');
    expect(findSession(cleared, sessionId)?.description).toBeUndefined();

    const compensation = planSessionCompensation({
      original: clear, catalog: cleared, actorUserId: userId, occurredAt: later
    });
    const restored = applySessionRestorePlan({ catalog: cleared, plan: compensation }).catalog;
    expect(findSession(restored, sessionId)?.description).toBe(original.description);
  });

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

  test('removes only the exact unchanged version 1 Session and refuses replay', () => {
    const empty = createEmptySessionCatalog(scope);
    const created = applySessionMutationPlan({ catalog: empty, vocabulary: vocabulary(), plan: createPlan(empty) });
    const current = findSession(created.catalog, sessionId)!;
    const removal = planNewSessionRemoval({ current, catalog: created.catalog, actorUserId: userId, occurredAt: later });
    expect(removal.action).toBe('remove_new_session');
    const removed = applyNewSessionRemovalPlan({ catalog: created.catalog, plan: removal });
    expect(removed.result).toMatchObject({ action: 'remove_new_session', session: null });
    expect(removed.catalog.sessions).toEqual([]);
    expect(() => applyNewSessionRemovalPlan({ catalog: removed.catalog, plan: removal })).toThrow('stale_catalog');

    const changedPlan = planSessionMutation({ catalog: created.catalog, vocabulary: vocabulary(), planningInput: {
      action: 'transition', scope, sessionId, actorUserId: userId, occurredAt: later,
      expectedCatalogVersion: created.catalog.version, expectedCatalogDigestSha256: created.catalog.digestSha256,
      expectedSessionVersion: current.version, expectedSessionDigestSha256: current.digestSha256, to: 'collecting'
    } });
    const changed = applySessionMutationPlan({ catalog: created.catalog, vocabulary: vocabulary(), plan: changedPlan });
    expect(() => planNewSessionRemoval({ current: findSession(changed.catalog, sessionId)!, catalog: changed.catalog,
      actorUserId: userId, occurredAt: later })).toThrow('stale_session');
  });

  test('never treats a Schedule occurrence row as Session identity', () => {
    const source = { readSessionCatalog: () => createEmptySessionCatalog(scope) };
    const occurrence = { sessionId, roomId: trackId, startAt: now, endAt: later };
    expect(occurrence.sessionId).toBe(sessionId);
    expect(createSchedulePlaceableSessionPort(source).readPlaceableSession(scheduleScope, sessionId as never))
      .toBeUndefined();
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
  });

  test('retires one exact roster membership, compacts order, and restores the prior head', () => {
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
          title: 'Membership Panel', plannedDurationMinutes: 60,
          lifecycle: 'programmed', formatId, trackId,
          participants: [
            { personId: personA, role: 'speaker', publiclyVisible: true, source },
            { personId: personB, role: 'panelist', publiclyVisible: false, source }
          ]
        }
      })
    }).catalog;
    const current = findSession(created, sessionId)!;
    const expectedParticipant = current.roster.participants[0]!;
    const removal = planSessionMutation({
      catalog: created,
      vocabulary: vocabulary({ setVersion: 2 }),
      planningInput: {
        action: 'roster_remove', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: current.version,
        expectedSessionDigestSha256: current.digestSha256,
        expectedRosterVersion: current.roster.version,
        expectedParticipant
      }
    });
    expect(removal.after.roster.participants).toEqual([
      { personId: personB, role: 'panelist', position: 0, publiclyVisible: false, source }
    ]);
    expect(removal.after.programTarget).toEqual(current.programTarget);

    expect(() => planSessionMutation({
      catalog: created,
      vocabulary: vocabulary(),
      planningInput: {
        action: 'roster_remove', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: created.version,
        expectedCatalogDigestSha256: created.digestSha256,
        expectedSessionVersion: current.version,
        expectedSessionDigestSha256: current.digestSha256,
        expectedRosterVersion: current.roster.version,
        expectedParticipant: { ...expectedParticipant, publiclyVisible: false }
      }
    })).toThrow('participant_changed');

    const removed = applySessionMutationPlan({
      catalog: created, vocabulary: vocabulary({ setVersion: 2 }), plan: removal
    }).catalog;
    const removedHead = findSession(removed, sessionId)!;
    const receiptRestore = planSessionMutation({
      catalog: removed,
      vocabulary: vocabulary({ setVersion: 3 }),
      planningInput: {
        action: 'roster_restore', scope, sessionId, actorUserId: userId, occurredAt: later,
        expectedCatalogVersion: removed.version,
        expectedCatalogDigestSha256: removed.digestSha256,
        expectedSessionVersion: removedHead.version,
        expectedSessionDigestSha256: removedHead.digestSha256,
        expectedRosterVersion: removedHead.roster.version,
        participant: expectedParticipant
      }
    });
    expect(receiptRestore.after.roster.participants).toEqual(current.roster.participants);
    expect(receiptRestore.after.programTarget).toEqual(current.programTarget);

    const restore = planSessionCompensation({
      original: removal, catalog: removed, actorUserId: userId, occurredAt: later
    });
    const restored = applySessionRestorePlan({ catalog: removed, plan: restore }).catalog;
    expect(findSession(restored, sessionId)!.roster).toEqual(current.roster);
  });

  test('changes one exact participant role and writes a complete guarded roster order', () => {
    const empty = createEmptySessionCatalog(scope);
    const source = { kind: 'submission', id: sessionId, version: 1 };
    let catalog = applySessionMutationPlan({
      catalog: empty, vocabulary: vocabulary(),
      plan: planSessionMutation({ catalog: empty, vocabulary: vocabulary(), planningInput: {
        action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
        expectedCatalogVersion: empty.version, expectedCatalogDigestSha256: empty.digestSha256,
        title: 'Ordered Panel', plannedDurationMinutes: 60, lifecycle: 'programmed',
        formatId, trackId, participants: [
          { personId: personA, role: 'speaker', publiclyVisible: true, source },
          { personId: personB, role: 'panelist', publiclyVisible: false, source }
        ]
      } })
    }).catalog;
    let head = findSession(catalog, sessionId)!;
    const rolePlan = planSessionMutation({ catalog, vocabulary: vocabulary(), planningInput: {
      action: 'roster_role', scope, sessionId, actorUserId: userId, occurredAt: later,
      expectedCatalogVersion: catalog.version, expectedCatalogDigestSha256: catalog.digestSha256,
      expectedSessionVersion: head.version, expectedSessionDigestSha256: head.digestSha256,
      expectedRosterVersion: head.roster.version, expectedParticipant: head.roster.participants[0]!,
      role: 'moderator'
    } });
    expect(rolePlan.after.roster.participants[0]?.role).toBe('moderator');
    catalog = applySessionMutationPlan({ catalog, vocabulary: vocabulary(), plan: rolePlan }).catalog;
    head = findSession(catalog, sessionId)!;
    const reorder = planSessionMutation({ catalog, vocabulary: vocabulary(), planningInput: {
      action: 'roster_reorder', scope, sessionId, actorUserId: userId, occurredAt: later,
      expectedCatalogVersion: catalog.version, expectedCatalogDigestSha256: catalog.digestSha256,
      expectedSessionVersion: head.version, expectedSessionDigestSha256: head.digestSha256,
      expectedRosterVersion: head.roster.version, personIds: [personB, personA]
    } });
    expect(reorder.after.roster.participants.map((entry) => [entry.personId, entry.position]))
      .toEqual([[personB, 0], [personA, 1]]);
    expect(() => planSessionMutation({ catalog, vocabulary: vocabulary(), planningInput: {
      action: 'roster_reorder', scope, sessionId, actorUserId: userId, occurredAt: later,
      expectedCatalogVersion: catalog.version, expectedCatalogDigestSha256: catalog.digestSha256,
      expectedSessionVersion: head.version, expectedSessionDigestSha256: head.digestSha256,
      expectedRosterVersion: head.roster.version, personIds: [personA]
    } })).toThrow('invalid_plan');
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
