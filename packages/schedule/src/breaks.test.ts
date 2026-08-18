import { describe, expect, test } from 'bun:test';
import type { ScheduleBreakPlanningInput } from '@jooevents/contracts';
import { createProgramVocabularyState } from '@jooevents/program';
import {
  applyScheduleBreakPlan,
  planScheduleBreakMutation,
  ScheduleBreakPlanningError,
  validateScheduleBreakPlan,
  type ScheduleBreakState
} from './breaks';
import { parseSchedulePlacementScope } from './model';

const ids = {
  workspace: '01890f47-9abc-7def-8123-456789abcdef',
  event: '01890f47-9abc-7def-8123-456789abcdea',
  roomA: '01890f47-9abc-7def-8123-456789abcdeb',
  roomB: '01890f47-9abc-7def-8123-456789abcdec',
  retiredRoom: '01890f47-9abc-7def-8123-456789abcded',
  breakA: '01890f47-9abc-7def-8123-456789abcdee',
  breakB: '01890f47-9abc-7def-8123-456789abcdf0'
} as const;

const scope = parseSchedulePlacementScope({ workspaceId: ids.workspace, eventId: ids.event });
const vocabulary = createProgramVocabularyState({
  scope,
  setVersion: 4,
  rooms: [
    { id: ids.roomA, name: 'Main Hall', capacity: 200, status: 'active', version: 1 },
    { id: ids.roomB, name: 'Studio', capacity: 80, status: 'active', version: 1 },
    { id: ids.retiredRoom, name: 'Old room', capacity: 20, status: 'retired', version: 2 }
  ]
});

function state(overrides: Partial<ScheduleBreakState> = {}): ScheduleBreakState {
  return Object.freeze({
    scope,
    scheduleVersion: 1,
    breaks: Object.freeze([]),
    event: Object.freeze({ version: 1, startDate: '2026-11-01', endDate: '2026-11-02' }),
    ...overrides
  });
}

function addInput(overrides: Partial<ScheduleBreakPlanningInput> = {}): ScheduleBreakPlanningInput {
  return {
    action: 'break_add',
    scope,
    expectedScheduleVersion: 1,
    label: 'Lunch',
    dayKey: '2026-11-01',
    startMin: 180,
    endMin: 240,
    breaks: [
      { id: ids.breakA, roomId: ids.roomA },
      { id: ids.breakB, roomId: ids.roomB }
    ],
    ...overrides
  } as ScheduleBreakPlanningInput;
}

describe('Schedule break domain', () => {
  test('adds multiple rooms atomically, then removes and restores the same retained heads', () => {
    const addedPlan = planScheduleBreakMutation({ planningInput: addInput(), state: state(), vocabulary });
    expect(addedPlan.after.map((head) => head.id)).toEqual([ids.breakA, ids.breakB]);
    expect(addedPlan.scheduleVersion).toEqual({ before: 1, after: 2 });
    const added = applyScheduleBreakPlan({ state: state(), vocabulary, plan: addedPlan });
    expect(added.result.breaks.every((head) => head.status === 'active')).toBe(true);

    const removePlan = planScheduleBreakMutation({
      state: added.state,
      vocabulary,
      planningInput: {
        action: 'break_remove', scope, expectedScheduleVersion: 2,
        breaks: added.state.breaks.map((head) => ({ id: head.id, expectedVersion: head.version }))
      }
    });
    const removed = applyScheduleBreakPlan({ state: added.state, vocabulary, plan: removePlan });
    expect(removed.state.breaks.map((head) => [head.id, head.status, head.version])).toEqual([
      [ids.breakA, 'removed', 2],
      [ids.breakB, 'removed', 2]
    ]);

    const restorePlan = planScheduleBreakMutation({
      state: removed.state,
      vocabulary,
      planningInput: {
        action: 'break_restore', scope, expectedScheduleVersion: 3,
        breaks: removed.state.breaks.map((head) => ({ id: head.id, expectedVersion: head.version }))
      }
    });
    const restored = applyScheduleBreakPlan({ state: removed.state, vocabulary, plan: restorePlan });
    expect(restored.state.breaks.map((head) => [head.id, head.status, head.version])).toEqual([
      [ids.breakA, 'active', 3],
      [ids.breakB, 'active', 3]
    ]);
  });

  test('refuses stale guards, retired rooms, outside days, and altered plans', () => {
    expect(() => planScheduleBreakMutation({
      planningInput: addInput({ expectedScheduleVersion: 2 }), state: state(), vocabulary
    })).toThrow(new ScheduleBreakPlanningError('stale_schedule'));
    expect(() => planScheduleBreakMutation({
      planningInput: addInput({
        breaks: [{ id: ids.breakA, roomId: ids.retiredRoom }]
      }), state: state(), vocabulary
    })).toThrow(new ScheduleBreakPlanningError('room_retired'));
    expect(() => planScheduleBreakMutation({
      planningInput: addInput({ dayKey: '2026-11-03' }), state: state(), vocabulary
    })).toThrow(new ScheduleBreakPlanningError('day_outside_event'));

    const plan = planScheduleBreakMutation({ planningInput: addInput(), state: state(), vocabulary });
    expect(validateScheduleBreakPlan({
      state: state(),
      vocabulary: createProgramVocabularyState({
        scope, setVersion: 5,
        rooms: vocabulary.rooms.map((room) => ({
          id: room.id, name: room.name, capacity: room.capacity,
          status: room.status, version: room.version
        }))
      }),
      plan
    })).toBe('stale_vocabulary');
  });
});
