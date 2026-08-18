import { describe, expect, test } from 'bun:test';
import { createEvent, createWorkspaceEventSet } from './model';
import {
  EventSettingsPlanningError,
  deriveEventSettingsUpdateCompensation,
  parseEventSettingsCompanion,
  planEventSettingsUpdate,
  projectEventSettings,
  validateEventSettingsUpdatePlan,
  type EventSettingsState
} from './settings';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const EVENT_ID = '20000000-0000-4000-8000-000000000002';
const OTHER_EVENT_ID = '20000000-0000-4000-8000-000000000003';
const USER_ID = '30000000-0000-4000-8000-000000000003';

function state(input: {
  eventId?: string;
  eventSetVersion?: number;
  eventVersion?: number;
  name?: string;
  timezone?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  venueNote?: string;
  dayStart?: string | null;
  dayEnd?: string | null;
  slotMinutes?: number | null;
  profileContentReview?: boolean;
} = {}): EventSettingsState {
  const eventId = input.eventId ?? EVENT_ID;
  const eventVersion = input.eventVersion ?? 4;
  return {
    eventSet: createWorkspaceEventSet({
      workspaceId: WORKSPACE_ID,
      version: input.eventSetVersion ?? 7,
      currentEventId: eventId
    }),
    event: createEvent({
      id: eventId,
      workspaceId: WORKSPACE_ID,
      name: input.name ?? 'JooConf 2027',
      timezone: input.timezone ?? 'Asia/Singapore',
      startDate: input.startDate ?? '2027-03-10',
      endDate: input.endDate ?? '2027-03-12',
      version: eventVersion,
      createdByUserId: USER_ID,
      createdAt: '2026-08-13T01:00:00.000Z'
    }),
    companion: parseEventSettingsCompanion({
      workspaceId: WORKSPACE_ID,
      eventId,
      eventVersion,
      location: input.location ?? 'Marina Bay',
      venueNote: input.venueNote ?? 'Hall A',
      dayStart: input.dayStart === undefined ? '09:00' : input.dayStart,
      dayEnd: input.dayEnd === undefined ? '18:00' : input.dayEnd,
      slotMinutes: input.slotMinutes === undefined ? 30 : input.slotMinutes,
      profileContentReview: input.profileContentReview ?? false
    })
  };
}

function author(current = state()) {
  return {
    scope: { workspaceId: WORKSPACE_ID, eventId: current.event.id },
    request: {
      expectedEventId: current.event.id,
      expectedEventSetVersion: current.eventSet.version,
      expectedEventVersion: current.event.version,
      name: '  JooConf   Live  ',
      timezone: 'Asia/Singapore',
      startDate: '2027-03-11',
      endDate: '2027-03-13',
      location: '  Suntec   City  ',
      venueNote: 'Doors open at 08:00\r\nUse level 3.',
      dayStart: '08:30',
      dayEnd: '17:30',
      slotMinutes: 30 as const
    }
  };
}

describe('Event settings planning', () => {
  test('projects the Event spine and required companion as one exact settings view', () => {
    expect(projectEventSettings(state())).toEqual({
      schemaVersion: 1,
      eventId: EVENT_ID,
      eventSetVersion: 7,
      eventVersion: 4,
      profileContentReview: false,
      name: 'JooConf 2027',
      timezone: 'Asia/Singapore',
      startDate: '2027-03-10',
      endDate: '2027-03-12',
      location: 'Marina Bay',
      venueNote: 'Hall A',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    });
    expect(projectEventSettings(state({ dayStart: null, dayEnd: null, slotMinutes: null })))
      .toMatchObject({ dayStart: null, dayEnd: null, slotMinutes: null });
    expect(() => parseEventSettingsCompanion({
      workspaceId: WORKSPACE_ID,
      eventId: EVENT_ID,
      eventVersion: 4,
      location: 'Marina Bay',
      venueNote: 'Hall A',
      dayStart: '09:00',
      dayEnd: null,
      slotMinutes: 30,
      profileContentReview: false
    })).toThrow(new TypeError('invalid_event_settings_companion'));
  });

  test('plans normalized settings while pinning selection, Event-set digest, and Event head', () => {
    const current = state();
    const plan = planEventSettingsUpdate({ state: current, authorInput: author(current) });
    expect(plan).toMatchObject({
      action: 'update',
      scope: { workspaceId: WORKSPACE_ID, eventId: EVENT_ID },
      selection: { eventId: EVENT_ID, eventSetVersion: 7 },
      expectedEventVersion: 4,
      resultingEventVersion: 5,
      after: {
        eventId: EVENT_ID,
        eventSetVersion: 7,
        eventVersion: 5,
        name: 'JooConf Live',
        location: 'Suntec City',
        venueNote: 'Doors open at 08:00\nUse level 3.',
        dayStart: '08:30',
        dayEnd: '17:30',
        slotMinutes: 30
      }
    });
    expect(plan.selection.eventSetGuardDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validateEventSettingsUpdatePlan(current, plan)).toBeNull();
  });

  test('fails closed on selection, Event-set, head, or companion drift', () => {
    const current = state();
    const plan = planEventSettingsUpdate({ state: current, authorInput: author(current) });
    expect(validateEventSettingsUpdatePlan(state({ eventSetVersion: 8 }), plan))
      .toBe('stale_event_set');
    expect(validateEventSettingsUpdatePlan(state({ eventVersion: 5 }), plan))
      .toBe('stale_event');
    expect(validateEventSettingsUpdatePlan(state({ location: 'Changed elsewhere' }), plan))
      .toBe('settings_changed');
    expect(validateEventSettingsUpdatePlan(state({ slotMinutes: 60 }), plan))
      .toBe('settings_changed');
    expect(validateEventSettingsUpdatePlan(state({ eventId: OTHER_EVENT_ID }), plan))
      .not.toBeNull();
  });

  test('plans a geometry-only change and an honest clearing of the grid window', () => {
    const current = state();
    const base = author(current);
    const geometryOnly = planEventSettingsUpdate({
      state: current,
      authorInput: {
        scope: base.scope,
        request: {
          ...base.request,
          name: 'JooConf 2027',
          startDate: '2027-03-10',
          endDate: '2027-03-12',
          location: 'Marina Bay',
          venueNote: 'Hall A',
          dayStart: '10:00',
          dayEnd: '16:00',
          slotMinutes: 20
        }
      }
    });
    expect(geometryOnly.after).toMatchObject({
      dayStart: '10:00', dayEnd: '16:00', slotMinutes: 20
    });
    expect(validateEventSettingsUpdatePlan(current, geometryOnly)).toBeNull();

    const cleared = planEventSettingsUpdate({
      state: current,
      authorInput: {
        scope: base.scope,
        request: {
          ...base.request,
          name: 'JooConf 2027',
          startDate: '2027-03-10',
          endDate: '2027-03-12',
          location: 'Marina Bay',
          venueNote: 'Hall A',
          dayStart: null,
          dayEnd: null,
          slotMinutes: null
        }
      }
    });
    expect(cleared.after).toMatchObject({ dayStart: null, dayEnd: null, slotMinutes: null });
    expect(validateEventSettingsUpdatePlan(current, cleared)).toBeNull();
  });

  test('refuses no-op drafts and only derives an exact correction at the committed state', () => {
    const current = state();
    expect(() => planEventSettingsUpdate({
      state: current,
      authorInput: {
        scope: { workspaceId: WORKSPACE_ID, eventId: EVENT_ID },
        request: {
          expectedEventId: EVENT_ID,
          expectedEventSetVersion: 7,
          expectedEventVersion: 4,
          name: 'JooConf 2027',
          timezone: 'Asia/Singapore',
          startDate: '2027-03-10',
          endDate: '2027-03-12',
          location: 'Marina Bay',
          venueNote: 'Hall A',
          dayStart: '09:00',
          dayEnd: '18:00',
          slotMinutes: 30
        }
      }
    })).toThrow(new EventSettingsPlanningError('no_changes'));

    const plan = planEventSettingsUpdate({ state: current, authorInput: author(current) });
    const committed = state({
      eventVersion: 5,
      name: plan.after.name,
      timezone: plan.after.timezone,
      startDate: plan.after.startDate,
      endDate: plan.after.endDate,
      location: plan.after.location,
      venueNote: plan.after.venueNote,
      dayStart: plan.after.dayStart,
      dayEnd: plan.after.dayEnd,
      slotMinutes: plan.after.slotMinutes
    });
    expect(deriveEventSettingsUpdateCompensation({ state: committed, sourcePlan: plan }))
      .toMatchObject({
        kind: 'exact',
        authorInput: {
          request: {
            expectedEventVersion: 5,
            name: 'JooConf 2027',
            location: 'Marina Bay',
            venueNote: 'Hall A',
            dayStart: '09:00',
            dayEnd: '18:00',
            slotMinutes: 30
          }
        }
      });
    expect(deriveEventSettingsUpdateCompensation({
      state: state({ eventVersion: 6, location: plan.after.location, venueNote: plan.after.venueNote }),
      sourcePlan: plan
    })).toEqual({ kind: 'blocked', reasonKey: 'event_settings.later_change' });
  });
});
