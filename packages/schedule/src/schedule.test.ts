import { describe, expect, test } from 'bun:test';
import { createProgramVocabularyState } from '@jooevents/program';
import type { SchedulePlacementPlanningInput } from '@jooevents/contracts';
import {
  SchedulePlacementPlanningError,
  applySchedulePlacementPlan,
  planSchedulePlacementMutation,
  validateSchedulePlacementPlan
} from './domain';
import {
  parseSchedulePlacementScope,
  parseSchedulePlacementState,
  parseScheduleSessionId,
  type ProgrammedSessionIdentityPort,
  type SchedulePlacementScope,
  type ScheduleSessionId
} from './model';

const ids = {
  workspace: '01890f47-9abc-7def-8123-456789abcdef',
  event: '01890f47-9abc-7def-8123-456789abcdea',
  room: '01890f47-9abc-7def-8123-456789abcdeb',
  retiredRoom: '01890f47-9abc-7def-8123-456789abcdec',
  track: '01890f47-9abc-7def-8123-456789abcdf1',
  sessionA: '01890f47-9abc-7def-8123-456789abcded',
  sessionB: '01890f47-9abc-7def-8123-456789abcdee',
  occurrenceA: '01890f47-9abc-7def-8123-456789abcdef',
  occurrenceB: '01890f47-9abc-7def-8123-456789abcdf0'
} as const;

const scope = parseSchedulePlacementScope({ workspaceId: ids.workspace, eventId: ids.event });
const sessions: ProgrammedSessionIdentityPort = Object.freeze({
  readProgrammedSession(requestScope: SchedulePlacementScope, sessionId: ScheduleSessionId) {
    if (requestScope.workspaceId !== scope.workspaceId || requestScope.eventId !== scope.eventId) return undefined;
    if (sessionId !== ids.sessionA && sessionId !== ids.sessionB) return undefined;
    return Object.freeze({ scope, id: parseScheduleSessionId(sessionId), lifecycle: 'programmed' as const });
  }
});
const vocabulary = createProgramVocabularyState({
  scope,
  setVersion: 2,
  rooms: [
    { id: ids.room, name: 'Main Hall', capacity: 200, status: 'active', version: 1 },
    { id: ids.retiredRoom, name: 'Old Hall', capacity: 50, status: 'retired', version: 2 }
  ]
});

function emptyState() {
  return parseSchedulePlacementState({ schemaVersion: 1, scope, scheduleVersion: 1, occurrences: [] });
}

function placePlanningInput(overrides: Partial<SchedulePlacementPlanningInput> = {}): SchedulePlacementPlanningInput {
  return {
    action: 'place',
    scope,
    expectedScheduleVersion: 1,
    occurrenceId: ids.occurrenceA,
    sessionId: ids.sessionA,
    roomId: ids.room,
    startAt: '2026-09-01T09:00:00.000Z',
    endAt: '2026-09-01T10:00:00.000Z',
    ...overrides
  } as SchedulePlacementPlanningInput;
}

describe('Schedule placement domain', () => {
  test('plans and applies one placement, then permits a boundary-adjacent placement', () => {
    const first = planSchedulePlacementMutation({ planningInput: placePlanningInput(), state: emptyState(), sessions, vocabulary });
    expect(first.before).toBeNull();
    expect(first.after?.version).toBe(1);
    const applied = applySchedulePlacementPlan({ state: emptyState(), sessions, vocabulary, plan: first });
    expect(Number(applied.state.scheduleVersion)).toBe(2);
    expect(applied.result.occurrence?.id).toBe(ids.occurrenceA);

    const adjacent = planSchedulePlacementMutation({
      state: applied.state,
      sessions,
      vocabulary,
      planningInput: placePlanningInput({
        expectedScheduleVersion: 2,
        occurrenceId: ids.occurrenceB,
        sessionId: ids.sessionB,
        startAt: '2026-09-01T10:00:00.000Z',
        endAt: '2026-09-01T10:30:00.000Z'
      })
    });
    expect(adjacent.after?.startAt).toBe('2026-09-01T10:00:00.000Z');
  });

  test('blocks a half-open room overlap with deterministic typed detail', () => {
    const first = planSchedulePlacementMutation({ planningInput: placePlanningInput(), state: emptyState(), sessions, vocabulary });
    const state = applySchedulePlacementPlan({ state: emptyState(), sessions, vocabulary, plan: first }).state;
    try {
      planSchedulePlacementMutation({
        state,
        sessions,
        vocabulary,
        planningInput: placePlanningInput({
          expectedScheduleVersion: 2,
          occurrenceId: ids.occurrenceB,
          sessionId: ids.sessionB,
          startAt: '2026-09-01T09:30:00.000Z',
          endAt: '2026-09-01T10:30:00.000Z'
        })
      });
      throw new Error('expected overlap refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulePlacementPlanningError);
      expect((error as SchedulePlacementPlanningError).code).toBe('room_overlap');
      expect((error as SchedulePlacementPlanningError).conflict?.conflicts.map((entry) => entry.occurrenceId))
        .toEqual([ids.occurrenceA]);
    }
  });

  test('refuses canonical placement of an unclassified session when the event has active tracks', () => {
    const trackedVocabulary = createProgramVocabularyState({
      scope,
      setVersion: 2,
      rooms: [{ id: ids.room, name: 'Main Hall', capacity: 200, status: 'active', version: 1 }],
      tracks: [{ id: ids.track, name: 'Platform', status: 'active', version: 1 }]
    });
    expect(() => planSchedulePlacementMutation({
      planningInput: placePlanningInput(),
      state: emptyState(),
      vocabulary: trackedVocabulary,
      sessions: {
        readPlaceableSession: () => Object.freeze({
          scope,
          id: parseScheduleSessionId(ids.sessionA),
          lifecycle: 'collecting' as const,
          trackId: null
        })
      }
    })).toThrow('session_track_required');
  });

  test('refuses stale set, stale occurrence, missing session, and retired room', () => {
    expect(() => planSchedulePlacementMutation({
      planningInput: placePlanningInput({ expectedScheduleVersion: 2 }), state: emptyState(), sessions, vocabulary
    })).toThrow('stale_schedule');
    expect(() => planSchedulePlacementMutation({
      planningInput: placePlanningInput({ sessionId: '01890f47-9abc-7def-8123-456789abcdf1' }),
      state: emptyState(), sessions, vocabulary
    })).toThrow('session_missing');
    expect(() => planSchedulePlacementMutation({
      planningInput: placePlanningInput({ roomId: ids.retiredRoom }), state: emptyState(), sessions, vocabulary
    })).toThrow('room_retired');

    const planned = planSchedulePlacementMutation({ planningInput: placePlanningInput(), state: emptyState(), sessions, vocabulary });
    const state = applySchedulePlacementPlan({ state: emptyState(), sessions, vocabulary, plan: planned }).state;
    expect(() => planSchedulePlacementMutation({
      state, sessions, vocabulary,
      planningInput: {
        action: 'move', scope, expectedScheduleVersion: 2, expectedOccurrenceVersion: 2,
        occurrenceId: ids.occurrenceA, roomId: ids.room,
        startAt: '2026-09-01T10:00:00.000Z', endAt: '2026-09-01T11:00:00.000Z'
      }
    })).toThrow('stale_occurrence');
  });

  test('exact plans refuse after query-set state changes', () => {
    const plan = planSchedulePlacementMutation({ planningInput: placePlanningInput(), state: emptyState(), sessions, vocabulary });
    const changed = parseSchedulePlacementState({
      schemaVersion: 1,
      scope,
      scheduleVersion: 2,
      occurrences: [{
        id: ids.occurrenceB,
        sessionId: ids.sessionB,
        roomId: ids.room,
        startAt: '2026-09-01T11:00:00.000Z',
        endAt: '2026-09-01T11:30:00.000Z',
        version: 1
      }]
    });
    expect(validateSchedulePlacementPlan({ state: changed, sessions, vocabulary, plan })).toBe('stale_schedule');
    const bypassedGuard = parseSchedulePlacementState({
      schemaVersion: 1,
      scope,
      scheduleVersion: 1,
      occurrences: [{
        id: ids.occurrenceB,
        sessionId: ids.sessionB,
        roomId: ids.room,
        startAt: '2026-09-01T11:00:00.000Z',
        endAt: '2026-09-01T11:30:00.000Z',
        version: 1
      }]
    });
    expect(validateSchedulePlacementPlan({ state: bypassedGuard, sessions, vocabulary, plan }))
      .toBe('stale_room_query');
  });
});
