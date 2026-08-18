import { describe, expect, test } from 'bun:test';
import {
  SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
  schedulePlacementOperationResultSchema,
  schedulePlacementAuthorInputSchema,
  schedulePlacementOccurrenceSchema,
  schedulePlacementInputSchema,
  schedulePlacementReadInputSchema,
  schedulePlacementReadResultSchema,
  schedulePlacementSnapshotSchema
} from './schedule-placement';

const ids = {
  workspace: '01890f47-9abc-7def-8123-456789abcdef',
  event: '01890f47-9abc-7def-8123-456789abcdea',
  occurrence: '01890f47-9abc-7def-8123-456789abcdeb',
  session: '01890f47-9abc-7def-8123-456789abcdec',
  room: '01890f47-9abc-7def-8123-456789abcded'
} as const;

const occurrence = {
  id: ids.occurrence,
  sessionId: ids.session,
  roomId: ids.room,
  startAt: '2026-09-01T09:00:00.000Z',
  endAt: '2026-09-01T09:45:00.000Z',
  version: 1
} as const;

describe('Schedule placement contracts', () => {
  test('accept canonical half-open placement inputs without repairing stored bytes', () => {
    expect(schedulePlacementOccurrenceSchema.parse(occurrence)).toEqual(occurrence);
    expect(schedulePlacementInputSchema.parse({
      action: 'place',
      expectedScheduleVersion: 1,
      sessionId: ids.session,
      roomId: ids.room,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt
    }).action).toBe('place');
  });

  test('freezes exact operator schema identities over canonical numeric read input', () => {
    expect(schedulePlacementReadInputSchema.parse({
      startAt: '2026-09-01T00:00:00.000Z',
      endAt: '2026-09-02T00:00:00.000Z',
      limit: 20
    }).limit).toBe(20);
    expect(schedulePlacementReadInputSchema.safeParse({
      startAt: '2026-09-01T00:00:00.000Z',
      endAt: '2026-09-02T00:00:00.000Z',
      limit: '20'
    }).success).toBe(false);

    expect(SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead).toEqual({
      inputSchema: expect.objectContaining({
        key: 'schema.schedule.placement-snapshot-read.input', version: 1
      }),
      resultSchema: expect.objectContaining({
        key: 'schema.schedule.placement-snapshot-read.operator-result', version: 1
      })
    });
    expect(SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placement).toEqual({
      inputSchema: expect.objectContaining({ key: 'schema.schedule.placement.input', version: 1 }),
      resultSchema: expect.objectContaining({
        key: 'schema.schedule.placement.operator-result', version: 1
      })
    });
    expect(SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema.digestSha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema.digestSha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(schedulePlacementReadResultSchema).toBeDefined();
    expect(schedulePlacementOperationResultSchema).toBeDefined();
  });

  test('refuses non-canonical instants, empty intervals, and extra authority-shaped fields', () => {
    expect(schedulePlacementOccurrenceSchema.safeParse({
      ...occurrence,
      startAt: '2026-09-01T09:00:00Z'
    }).success).toBe(false);
    expect(schedulePlacementOccurrenceSchema.safeParse({
      ...occurrence,
      endAt: occurrence.startAt
    }).success).toBe(false);
    expect(schedulePlacementInputSchema.safeParse({
      action: 'place',
      expectedScheduleVersion: 1,
      sessionId: ids.session,
      roomId: ids.room,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      scope: { workspaceId: ids.workspace, eventId: ids.event },
      actorUserId: ids.workspace
    }).success).toBe(false);
    expect(schedulePlacementInputSchema.safeParse({
      action: 'place',
      expectedScheduleVersion: 1,
      occurrenceId: ids.occurrence,
      sessionId: ids.session,
      roomId: ids.room,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt
    }).success).toBe(false);
  });

  test('requires deterministic occurrence ordering and unique ids', () => {
    const base = {
      schemaVersion: 1 as const,
      scope: { workspaceId: ids.workspace, eventId: ids.event },
      scheduleVersion: 1
    };
    const later = {
      ...occurrence,
      id: '01890f47-9abc-7def-8123-456789abcdee',
      startAt: '2026-09-01T10:00:00.000Z',
      endAt: '2026-09-01T10:45:00.000Z'
    };
    expect(schedulePlacementSnapshotSchema.safeParse({ ...base, occurrences: [occurrence, later] }).success).toBe(true);
    expect(schedulePlacementSnapshotSchema.safeParse({ ...base, occurrences: [later, occurrence] }).success).toBe(false);
    expect(schedulePlacementSnapshotSchema.safeParse({ ...base, occurrences: [occurrence, occurrence] }).success).toBe(false);
  });

  test('accepts one atomic multi-room break action and projects only active retained heads', () => {
    expect(schedulePlacementAuthorInputSchema.parse({
      action: 'break_add',
      expectedScheduleVersion: 3,
      label: 'Lunch',
      dayKey: '2026-09-01',
      startMin: 180,
      endMin: 240,
      roomIds: [ids.room, '01890f47-9abc-7def-8123-456789abcdee']
    }).action).toBe('break_add');
    expect(schedulePlacementAuthorInputSchema.safeParse({
      action: 'break_add', expectedScheduleVersion: 3, label: 'Lunch',
      dayKey: '2026-09-01', startMin: 180, endMin: 240,
      roomIds: [ids.room, ids.room]
    }).success).toBe(false);
    expect(schedulePlacementSnapshotSchema.parse({
      schemaVersion: 1,
      scope: { workspaceId: ids.workspace, eventId: ids.event },
      scheduleVersion: 3,
      occurrences: [],
      breaks: [{
        id: ids.occurrence, label: 'Lunch', dayKey: '2026-09-01', roomId: ids.room,
        startMin: 180, endMin: 240, status: 'active', version: 1
      }]
    }).breaks).toHaveLength(1);
  });
});
