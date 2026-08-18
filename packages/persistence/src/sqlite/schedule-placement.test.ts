import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  captureRegisteredProgramReferences,
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation,
  programReferenceUsage,
  resolveProgramVocabularyItem,
  type ProgramMergeCompensationInput,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import {
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  planSchedulePlacementMutation,
  planScheduleBreakMutation,
  parseSchedulePlacementScope,
  parseScheduleSessionId,
  type ProgrammedSessionIdentityPort,
  type SchedulePlacementScope,
  type ScheduleSessionId
} from '@jooevents/schedule';
import type { SchedulePlacementPlanningInput } from '@jooevents/contracts';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import {
  createSQLiteScheduleRoomReferenceAdapter,
  installSchedulePlacementSchema,
  SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
  SQLiteSchedulePlacementRepository
} from './schedule-placement';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const otherEventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa102');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const sourceRoomId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const targetRoomId = '019c1df7-86b5-769b-bba4-5f7097bfa302';
const occurrenceId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const occurrence2Id = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const breakId = '019c1df7-86b5-769b-bba4-5f7097bfa403';
const break2Id = '019c1df7-86b5-769b-bba4-5f7097bfa404';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const session2Id = '019c1df7-86b5-769b-bba4-5f7097bfa502';
const now = parseInstant('2026-08-12T09:00:00.000Z');

function setup() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO workspaces VALUES ('${workspaceId}', 'Workspace', 'active', 1, 1, 1);
    INSERT INTO users VALUES ('${userId}', 'active', 'Operator', 1, 1, 1);
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSchedulePlacementSchema(sqlite);
  insertEventRoot(sqlite, eventId);
  insertEventRoot(sqlite, otherEventId, false);

  const scheduleAdapter = createSQLiteScheduleRoomReferenceAdapter({ sqlite });
  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR],
    contributors: [SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR]
  });
  const contributorRegistry = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR],
    adapters: [scheduleAdapter]
  });
  const vocabulary = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    contributorRegistry,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  createRoom(sqlite, vocabulary, sourceRoomId, 'Main Hall');
  createRoom(sqlite, vocabulary, targetRoomId, 'Studio');
  const scope = parseSchedulePlacementScope({ workspaceId, eventId });
  const sessions: ProgrammedSessionIdentityPort = Object.freeze({
    readProgrammedSession(requestScope: SchedulePlacementScope, requestedSessionId: ScheduleSessionId) {
      if (requestScope.workspaceId !== scope.workspaceId || requestScope.eventId !== scope.eventId) return undefined;
      if (requestedSessionId !== sessionId && requestedSessionId !== session2Id) return undefined;
      return Object.freeze({ scope, id: parseScheduleSessionId(requestedSessionId), lifecycle: 'programmed' as const });
    }
  });
  const schedule = new SQLiteSchedulePlacementRepository(
    sqlite,
    sessions,
    vocabulary,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  return { sqlite, vocabulary, referenceRegistry, schedule, scope };
}

describe('SQLite schedule placement', () => {
  test('adds multiple break heads atomically and retains exact remove/restore state', () => {
    const h = setup();
    const state = h.schedule.readBreakState(h.scope)!;
    const vocabulary = h.schedule.readVocabulary(h.scope)!;
    const add = planScheduleBreakMutation({
      state,
      vocabulary,
      planningInput: {
        action: 'break_add', scope: h.scope, expectedScheduleVersion: 1,
        label: 'Lunch', dayKey: '2026-11-01', startMin: 180, endMin: 240,
        breaks: [
          { id: breakId, roomId: sourceRoomId },
          { id: break2Id, roomId: targetRoomId }
        ]
      }
    });
    transaction(h.sqlite, () => h.schedule.applyBreakPlan(add));
    expect(h.schedule.readSchedule(h.scope)).toMatchObject({
      scheduleVersion: 2,
      breaks: [
        { id: breakId, status: 'active', version: 1 },
        { id: break2Id, status: 'active', version: 1 }
      ]
    });

    const current = h.schedule.readBreakState(h.scope)!;
    const remove = planScheduleBreakMutation({
      state: current,
      vocabulary: h.schedule.readVocabulary(h.scope)!,
      planningInput: {
        action: 'break_remove', scope: h.scope, expectedScheduleVersion: 2,
        breaks: current.breaks.map((head) => ({ id: head.id, expectedVersion: head.version }))
      }
    });
    transaction(h.sqlite, () => h.schedule.applyBreakPlan(remove));
    expect(h.schedule.readSchedule(h.scope)?.breaks).toEqual([]);
    expect(h.sqlite.query<{ id: string; status: string; version: number }, []>(`
      SELECT id,status,version FROM schedule_breaks ORDER BY id
    `).all()).toEqual([
      { id: breakId, status: 'removed', version: 2 },
      { id: break2Id, status: 'removed', version: 2 }
    ]);
    expect(() => h.sqlite.query(`DELETE FROM schedule_breaks WHERE id = ?`).run(breakId))
      .toThrow('schedule break heads are retained');
    expect(() => h.sqlite.query(`
      UPDATE schedule_breaks
         SET label = 'Late lunch', version = version + 1
       WHERE id = ?
    `).run(breakId)).toThrow('schedule break definition is immutable');

    const removed = h.schedule.readBreakState(h.scope)!;
    const restore = planScheduleBreakMutation({
      state: removed,
      vocabulary: h.schedule.readVocabulary(h.scope)!,
      planningInput: {
        action: 'break_restore', scope: h.scope, expectedScheduleVersion: 3,
        breaks: removed.breaks.map((head) => ({ id: head.id, expectedVersion: head.version }))
      }
    });
    transaction(h.sqlite, () => h.schedule.applyBreakPlan(restore));
    expect(h.schedule.readSchedule(h.scope)?.breaks.map((head) => [head.id, head.version]))
      .toEqual([[breakId, 3], [break2Id, 3]]);
    h.sqlite.close();
  });

  test('places through an exact transaction and blocks an overlapping room interval', () => {
    const h = setup();
    const plan = placementPlan(h, {
      action: 'place', scope: h.scope, expectedScheduleVersion: 1,
      occurrenceId, sessionId, roomId: sourceRoomId,
      startAt: '2026-11-01T09:00:00.000Z', endAt: '2026-11-01T10:00:00.000Z'
    });
    transaction(h.sqlite, () => h.schedule.applyPlacementPlan(plan));
    expect(h.schedule.readSchedule(h.scope)).toMatchObject({
      scheduleVersion: 2,
      occurrences: [{ id: occurrenceId, roomId: sourceRoomId, version: 1 }]
    });
    expect(() => placementPlan(h, {
      action: 'place', scope: h.scope, expectedScheduleVersion: 2,
      occurrenceId: occurrence2Id, sessionId: session2Id, roomId: sourceRoomId,
      startAt: '2026-11-01T09:30:00.000Z', endAt: '2026-11-01T10:30:00.000Z'
    })).toThrow('room_overlap');
    expect(h.schedule.readOccurrenceRange({
      scope: h.scope,
      startAt: parseInstant('2026-11-01T09:30:00.000Z'),
      endAt: parseInstant('2026-11-01T10:30:00.000Z'),
      limit: 20
    }).map((occurrence) => String(occurrence.id))).toEqual([occurrenceId]);
    h.sqlite.close();
  });

  test('Program Vocabulary sees usage, blocks delete, repoints merge, and repoints compensation', () => {
    const h = setup();
    const plan = placementPlan(h, {
      action: 'place', scope: h.scope, expectedScheduleVersion: 1,
      occurrenceId, sessionId, roomId: sourceRoomId,
      startAt: '2026-11-01T09:00:00.000Z', endAt: '2026-11-01T10:00:00.000Z'
    });
    transaction(h.sqlite, () => h.schedule.applyPlacementPlan(plan));

    const references = captureRegisteredProgramReferences({
      registry: h.referenceRegistry,
      scope: h.scope,
      source: h.vocabulary
    });
    expect(programReferenceUsage(references, { kind: 'room', id: sourceRoomId }))
      .toEqual({ current: 1, historicalPins: 0 });
    expect(() => vocabularyPlan(h, {
      action: 'delete', scope: h.scope, kind: 'room', id: sourceRoomId,
      expectedSetVersion: 3, expectedItemVersion: 1
    })).toThrow('delete_referenced');

    const merge = vocabularyPlan(h, {
      action: 'merge', scope: h.scope, kind: 'room', sourceId: sourceRoomId, targetId: targetRoomId,
      expectedSetVersion: 3, expectedSourceVersion: 1, expectedTargetVersion: 1
    });
    transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(merge));
    expect(h.schedule.readSchedule(h.scope)).toMatchObject({
      scheduleVersion: 3,
      occurrences: [{ roomId: targetRoomId, version: 2 }]
    });

    const state = h.vocabulary.readVocabulary(h.scope)!;
    const compensationInput: ProgramMergeCompensationInput = {
      action: 'merge_compensation', scope: h.scope, kind: 'room',
      sourceId: sourceRoomId, targetId: targetRoomId,
      expectedSetVersion: state.setVersion,
      expectedSourceVersion: resolveProgramVocabularyItem(state, 'room', sourceRoomId)!.version,
      expectedTargetVersion: resolveProgramVocabularyItem(state, 'room', targetRoomId)!.version,
      restoreSource: true,
      references: [{
        contributor: SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
        referenceKeys: [`schedule_occurrence:${occurrenceId}:room`]
      }]
    };
    const compensation = vocabularyPlan(h, compensationInput);
    transaction(h.sqlite, () => h.vocabulary.applyVocabularyPlan(compensation));
    expect(h.schedule.readSchedule(h.scope)).toMatchObject({
      scheduleVersion: 4,
      occurrences: [{ roomId: sourceRoomId, version: 3 }]
    });
    expect(h.vocabulary.readVocabulary(h.scope)?.rooms.find((room) => room.id === sourceRoomId)?.status)
      .toBe('active');
    h.sqlite.close();
  });

  test('stale guards and a late SQL failure roll back every occurrence write', () => {
    const h = setup();
    const first = placementPlan(h, {
      action: 'place', scope: h.scope, expectedScheduleVersion: 1,
      occurrenceId, sessionId, roomId: sourceRoomId,
      startAt: '2026-11-01T09:00:00.000Z', endAt: '2026-11-01T10:00:00.000Z'
    });
    transaction(h.sqlite, () => h.schedule.applyPlacementPlan(first));
    const move = placementPlan(h, {
      action: 'move', scope: h.scope, expectedScheduleVersion: 2,
      occurrenceId, expectedOccurrenceVersion: 1, roomId: sourceRoomId,
      startAt: '2026-11-01T10:00:00.000Z', endAt: '2026-11-01T11:00:00.000Z'
    });
    h.sqlite.exec(`
      CREATE TRIGGER schedule_test_fail_guard
      BEFORE UPDATE ON schedule_placement_sets
      BEGIN SELECT RAISE(ABORT, 'injected schedule guard failure'); END;
    `);
    expect(() => transaction(h.sqlite, () => h.schedule.applyPlacementPlan(move))).toThrow(
      'injected schedule guard failure'
    );
    expect(h.schedule.readSchedule(h.scope)).toMatchObject({
      scheduleVersion: 2,
      occurrences: [{ startAt: '2026-11-01T09:00:00.000Z', version: 1 }]
    });
    h.sqlite.exec('DROP TRIGGER schedule_test_fail_guard;');

    const adjacent = placementPlan(h, {
      action: 'place', scope: h.scope, expectedScheduleVersion: 2,
      occurrenceId: occurrence2Id, sessionId: session2Id, roomId: sourceRoomId,
      startAt: '2026-11-01T10:00:00.000Z', endAt: '2026-11-01T10:30:00.000Z'
    });
    transaction(h.sqlite, () => h.schedule.applyPlacementPlan(adjacent));
    expect(() => transaction(h.sqlite, () => h.schedule.applyPlacementPlan(move))).toThrow('stale_schedule');
    expect(h.schedule.readSchedule(h.scope)?.occurrences).toHaveLength(2);
    h.sqlite.close();
  });
});

function placementPlan(
  h: ReturnType<typeof setup>,
  planningInput: SchedulePlacementPlanningInput
) {
  return planSchedulePlacementMutation({
    planningInput,
    state: h.schedule.readSchedule(h.scope)!,
    sessions: h.schedule,
    vocabulary: h.vocabulary.readVocabulary(h.scope)!
  });
}

function vocabularyPlan(
  h: ReturnType<typeof setup>,
  authorInput: Parameters<typeof planProgramVocabularyMutation>[0]['authorInput']
): ProgramVocabularyMutationPlan {
  return planProgramVocabularyMutation({
    authorInput,
    state: h.vocabulary.readVocabulary(h.scope)!,
    referenceRegistry: h.referenceRegistry,
    referenceSource: h.vocabulary
  });
}

function createRoom(
  sqlite: Database,
  vocabulary: SQLiteProgramVocabularyRepository,
  id: string,
  name: string
): void {
  const scope = { workspaceId, eventId };
  const state = vocabulary.readVocabulary(scope)!;
  const plan = planProgramVocabularyMutation({
    state,
    referenceRegistry: vocabulary.referenceRegistry,
    referenceSource: vocabulary,
    authorInput: {
      action: 'create', scope, expectedSetVersion: state.setVersion,
      item: { kind: 'room', id, name, capacity: null }
    }
  });
  transaction(sqlite, () => vocabulary.applyVocabularyPlan(plan));
}

function insertEventRoot(sqlite: Database, id: string, current = true): void {
  if (current) {
    sqlite.query(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, null)
    `).run(workspaceId);
  }
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Schedule Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, id, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, id);
  if (current) {
    sqlite.query(`
      UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?
    `).run(id, workspaceId);
  }
}

function transaction<Result>(sqlite: Database, work: () => Result): Result {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}
