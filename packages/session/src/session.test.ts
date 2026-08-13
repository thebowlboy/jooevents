import { describe, expect, test } from 'bun:test';
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
  planSessionMutation,
  sessionRosterCount,
  SessionPlanningError,
  type SessionCatalog
} from './index';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa202';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa302';
const now = '2026-08-13T08:00:00.000Z';
const later = '2026-08-13T08:05:00.000Z';
const scheduleScope = parseSchedulePlacementScope(scope);

function vocabulary(input: { readonly retiredFormat?: boolean; readonly setVersion?: number } = {}) {
  return createProgramVocabularyState({
    scope,
    setVersion: input.setVersion ?? 1,
    formats: [{
      id: formatId,
      name: 'Talk',
      status: input.retiredFormat ? 'retired' : 'active',
      version: input.retiredFormat ? 2 : 1
    }],
    tracks: [{ id: trackId, name: 'Platform', status: 'active', version: 1 }]
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
      .toMatchObject({ id: sessionId, lifecycle: 'collecting' });
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
});
