import { describe, expect, test } from 'bun:test';
import {
  planChangesetOperation,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey
} from '@jooevents/changesets';
import { createEvent, createWorkspaceEventSet } from './model';
import { issueEventOrdinaryPolicy } from './policy';
import {
  createEventSettingsOrdinaryChangesetBundle,
  eventSettingsReadPort
} from './settings-changesets';
import { parseEventSettingsCompanion, type EventSettingsState } from './settings';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const eventId = '20000000-0000-4000-8000-000000000002';
const userId = '30000000-0000-4000-8000-000000000003';

function baseline(): EventSettingsState {
  return {
    eventSet: createWorkspaceEventSet({ workspaceId, version: 3, currentEventId: eventId }),
    event: createEvent({
      id: eventId,
      workspaceId,
      name: 'JooConf',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18',
      version: 4,
      createdByUserId: userId,
      createdAt: '2026-08-13T01:00:00.000Z'
    }),
    companion: parseEventSettingsCompanion({
      workspaceId,
      eventId,
      eventVersion: 4,
      location: 'Singapore',
      venueNote: '',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    })
  };
}

describe('Event settings changeset definition', () => {
  test('plans one safe diff with exact Event head and selected Event-set guard', async () => {
    const state = baseline();
    const bundle = createEventSettingsOrdinaryChangesetBundle({
      policy: issueEventOrdinaryPolicy({
        key: 'event.settings.ordinary',
        version: 1,
        risk: 'low',
        approval: 'none'
      })
    });
    const port = { readEventSettings: () => state };
    const snapshot: ChangesetPlanningSnapshot = {
      getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
        if ((key as unknown) !== eventSettingsReadPort) throw new TypeError('undeclared_test_port');
        return port as unknown as Port;
      }
    };
    const operation = await planChangesetOperation({
      registry: bundle.registry,
      kind: 'event.settings.update',
      version: 1,
      authorInput: {
        scope: { workspaceId, eventId },
        request: {
          expectedEventId: eventId,
          expectedEventSetVersion: 3,
          expectedEventVersion: 4,
          name: 'JooConf Live',
          timezone: 'Asia/Singapore',
          startDate: '2027-04-16',
          endDate: '2027-04-19',
          location: 'Suntec City',
          venueNote: 'Use level 3.',
          dayStart: '08:00',
          dayEnd: '18:00',
          slotMinutes: 20
        }
      },
      dependencyGroup: 'event_settings',
      snapshot
    });
    expect(operation).toMatchObject({
      riskTier: 'low',
      aggregateRefs: [{ id: `event:${eventId}`, version: 4 }],
      guardRefs: [{ id: `workspace_event_set:${workspaceId}`, version: 3 }],
      consequences: ['event_settings_changed'],
      safeDiff: {
        action: 'update',
        selection: { eventId, eventSetVersion: 3 },
        before: { eventVersion: 4, location: 'Singapore', dayStart: '09:00', slotMinutes: 30 },
        after: { eventVersion: 5, location: 'Suntec City', dayStart: '08:00', slotMinutes: 20 }
      }
    });
    expect(operation.guardRefs[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(operation)).not.toContain('createdByUserId');
  });
});
