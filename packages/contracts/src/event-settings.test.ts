import { describe, expect, test } from 'bun:test';
import {
  currentEventSettingsReadResultSchema,
  eventSettingsEventRequiredOutcomeSchema,
  eventSettingsSchema,
  eventSettingsScopeSchema,
  eventSettingsWorkspaceIdSchema,
  eventSettingsUpdateInputSchema,
  eventSettingsUpdateOperationResultSchema
} from './event-settings';

const eventId = '019c2582-aee8-7c51-8d2f-0d27f67dc111';
const receiptId = '019c2582-aee8-7c51-8d2f-0d27f67dc114';
const correlationId = '019c2582-aee8-7c51-8d2f-0d27f67dc115';

const before = {
  schemaVersion: 1,
  eventId,
  eventSetVersion: 2,
  eventVersion: 4,
  name: 'JooConf 2027',
  timezone: 'Asia/Singapore',
  startDate: '2027-04-16',
  endDate: '2027-04-18',
  location: 'Singapore',
  venueNote: 'Load-in from 07:00.',
  dayStart: '09:00',
  dayEnd: '18:00',
  slotMinutes: 30
} as const;

const after = {
  ...before,
  eventVersion: 5,
  name: 'JooConf 2027 Live',
  venueNote: 'Load-in from 06:30.\nUse the east entrance.'
} as const;

describe('Event settings wire contracts', () => {
  test('owns workspace scope separately and requires canonical application IDs', () => {
    const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
    expect(eventSettingsScopeSchema.shape.workspaceId).toBe(eventSettingsWorkspaceIdSchema);
    const parsed = eventSettingsScopeSchema.parse({ workspaceId, eventId });
    expect(parsed.workspaceId).toBe(workspaceId);
    expect(parsed.eventId).toBe(eventId);
    expect(eventSettingsScopeSchema.safeParse({
      workspaceId: workspaceId.toUpperCase(),
      eventId
    }).success).toBe(false);
  });

  test('projects exactly the nine tuned settings fields plus current guards', () => {
    expect(eventSettingsSchema.parse(before)).toEqual(before);
    expect(eventSettingsSchema.safeParse({ ...before, publicIndexing: true }).success).toBe(false);
    expect(eventSettingsSchema.safeParse({ ...before, endDate: '2027-04-15' }).success).toBe(false);
    expect(eventSettingsSchema.parse({
      ...before, dayStart: null, dayEnd: null, slotMinutes: null
    })).toMatchObject({ dayStart: null, dayEnd: null, slotMinutes: null });

    expect(currentEventSettingsReadResultSchema.safeParse({
      kind: 'success',
      data: before,
      correlationId
    }).success).toBe(true);
    expect(eventSettingsEventRequiredOutcomeSchema.parse({
      class: 'conflict',
      kind: 'event.settings.event_required',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })).toEqual({
      class: 'conflict',
      kind: 'event.settings.event_required',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    });
  });

  test('normalizes authored text while keeping identity and attribution server-owned', () => {
    const parsed = eventSettingsUpdateInputSchema.parse({
      expectedEventId: eventId,
      expectedEventSetVersion: 2,
      expectedEventVersion: 4,
      name: '  JooConf   2027 Live ',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18',
      location: '  Marina   Bay  ',
      venueNote: '  Load-in from 06:30.\r\nUse the east entrance.  ',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    });
    expect(parsed.name).toBe('JooConf   2027 Live');
    expect(parsed.location).toBe('Marina Bay');
    expect(parsed.venueNote).toBe('Load-in from 06:30.\nUse the east entrance.');
    expect(eventSettingsUpdateInputSchema.safeParse({
      ...parsed,
      workspaceId: eventId
    }).success).toBe(false);
    expect(eventSettingsUpdateInputSchema.safeParse({
      ...parsed,
      updatedByUserId: eventId
    }).success).toBe(false);
    expect(eventSettingsUpdateInputSchema.safeParse({
      ...parsed,
      publicIndexing: true
    }).success).toBe(false);
  });

  test('rejects oversize text, unsafe controls, and malformed Unicode', () => {
    const input = {
      expectedEventId: eventId,
      expectedEventSetVersion: 2,
      expectedEventVersion: 4,
      name: 'JooConf 2027 Live',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18',
      location: 'Marina Bay',
      venueNote: 'Use the east entrance.',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    };
    for (const candidate of [
      { ...input, location: 'x'.repeat(501) },
      { ...input, venueNote: 'x'.repeat(8_001) },
      { ...input, location: 'Hall\u0000A' },
      { ...input, location: 'Hall\nA' },
      { ...input, venueNote: 'Hall\u0007A' },
      { ...input, venueNote: 'Hall\tA' },
      { ...input, venueNote: 'Hall\ud800A' }
    ]) {
      expect(eventSettingsUpdateInputSchema.safeParse(candidate).success).toBe(false);
    }
    expect(eventSettingsUpdateInputSchema.parse({
      ...input,
      venueNote: 'Hall A\r\nHall B'
    }).venueNote).toBe('Hall A\nHall B');
  });

  test('holds the schedule-grid geometry to the closed coherent envelope', () => {
    const input = {
      expectedEventId: eventId,
      expectedEventSetVersion: 2,
      expectedEventVersion: 4,
      name: 'JooConf 2027 Live',
      timezone: 'Asia/Singapore',
      startDate: '2027-04-16',
      endDate: '2027-04-18',
      location: 'Marina Bay',
      venueNote: '',
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    };
    expect(eventSettingsUpdateInputSchema.parse(input)).toMatchObject({
      dayStart: '09:00',
      dayEnd: '18:00',
      slotMinutes: 30
    });
    expect(eventSettingsUpdateInputSchema.parse({
      ...input, dayStart: null, dayEnd: null, slotMinutes: null
    })).toMatchObject({ dayStart: null, dayEnd: null, slotMinutes: null });
    for (const candidate of [
      { ...input, dayStart: null },
      { ...input, dayEnd: null },
      { ...input, slotMinutes: null },
      { ...input, dayStart: '9:00' },
      { ...input, dayStart: '24:00' },
      { ...input, dayEnd: '18:60' },
      { ...input, slotMinutes: 25 },
      { ...input, slotMinutes: 0 },
      { ...input, dayStart: '18:00', dayEnd: '09:00' },
      { ...input, dayStart: '18:00', dayEnd: '18:00' },
      { ...input, dayStart: '09:10', dayEnd: '18:00', slotMinutes: 60 }
    ]) {
      expect(eventSettingsUpdateInputSchema.safeParse(candidate).success).toBe(false);
      const { expectedEventId: _eventId, expectedEventSetVersion: _setVersion,
        expectedEventVersion: _eventVersion, ...valueFields } = candidate;
      expect(eventSettingsSchema.safeParse({
        schemaVersion: 1,
        eventId,
        eventSetVersion: 2,
        eventVersion: 4,
        ...valueFields
      }).success).toBe(false);
    }
    expect(eventSettingsUpdateInputSchema.parse({
      ...input, dayStart: '08:30', dayEnd: '17:30', slotMinutes: 60
    })).toMatchObject({ dayStart: '08:30', dayEnd: '17:30', slotMinutes: 60 });
  });

  test('requires one terminal operation-log receipt for a persisted update', () => {
    const payload = {
      kind: 'success',
      data: {
        schemaVersion: 1,
        action: 'update',
        eventId,
        eventSetVersion: 2,
        eventVersion: 5
      },
      receipt: {
        id: receiptId,
        operationName: 'event.settings.update',
        operationVersion: 1
      },
      correlationId
    } as const;
    expect(eventSettingsUpdateOperationResultSchema.safeParse(payload).success).toBe(true);
    const { receipt: _receipt, ...withoutReceipt } = payload;
    expect(eventSettingsUpdateOperationResultSchema.safeParse(withoutReceipt).success)
      .toBe(false);
  });
});
