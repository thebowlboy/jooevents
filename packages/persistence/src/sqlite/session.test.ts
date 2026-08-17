import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  applySessionMutationPlan,
  findSession,
  planSessionCompensation,
  planSessionMutation
} from '@jooevents/session';
import { parseEventId, parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  captureRegisteredProgramReferences,
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation,
  programReferenceUsage
} from '@jooevents/program';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import { installSchedulePlacementSchema } from './schedule-placement';
import {
  SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR,
  SQLiteSessionRepository,
  createSQLiteSessionProgramReferenceAdapter,
  installSessionSchema
} from './session';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const targetTrackId = '019c1df7-86b5-769b-bba4-5f7097bfa403';
const now = parseInstant('2026-08-13T08:00:00.000Z');
const later = parseInstant('2026-08-13T08:05:00.000Z');

function fixture() {
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
    CREATE TABLE operation_log (
      id TEXT PRIMARY KEY, operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL, result_json TEXT NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installSchedulePlacementSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1)
  `).run(userId);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?`)
    .run(eventId, workspaceId);

  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR],
    contributors: [SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR]
  });
  const adapterRegistry = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR],
    adapters: [createSQLiteSessionProgramReferenceAdapter({ sqlite })]
  });
  const program = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    adapterRegistry,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  const items = [
    { kind: 'format' as const, id: formatId, name: 'Talk' },
    { kind: 'track' as const, id: trackId, name: 'Platform' }
  ] as const;
  for (const item of items) {
    const state = program.readVocabulary({ workspaceId, eventId })!;
    const authorInput = item.kind === 'format'
      ? {
          action: 'create' as const,
          scope: { workspaceId, eventId },
          expectedSetVersion: state.setVersion,
          item: { kind: 'format' as const, id: item.id, name: item.name }
        }
      : {
          action: 'create' as const,
          scope: { workspaceId, eventId },
          expectedSetVersion: state.setVersion,
          item: { kind: 'track' as const, id: item.id, name: item.name }
        };
    const plan = planProgramVocabularyMutation({
      state,
      referenceRegistry,
      referenceSource: program,
      authorInput
    });
    sqlite.exec('BEGIN IMMEDIATE;');
    program.applyVocabularyPlan(plan);
    sqlite.exec('COMMIT;');
  }
  return {
    sqlite,
    program,
    referenceRegistry,
    sessions: new SQLiteSessionRepository(sqlite, program)
  };
}

function createPlan(repository: SQLiteSessionRepository) {
  const catalog = repository.readSessionCatalog({ workspaceId, eventId })!;
  return planSessionMutation({
    catalog,
    vocabulary: repository.readSessionVocabulary({ workspaceId, eventId })!,
    planningInput: {
      action: 'create', scope: { workspaceId, eventId }, sessionId,
      actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Persistent Session', plannedDurationMinutes: 45,
      lifecycle: 'collecting', formatId, trackId
    }
  });
}

describe('disposable SQLite Session repository', () => {
  test('contributes independent format and track slots to delete and reviewed merge', () => {
    const h = fixture();
    h.sqlite.exec('BEGIN IMMEDIATE;');
    h.sessions.applySessionPlan(createPlan(h.sessions));
    h.sqlite.exec('COMMIT;');

    const beforeTarget = h.program.readVocabulary({ workspaceId, eventId })!;
    expect(() => planProgramVocabularyMutation({
      state: beforeTarget,
      referenceRegistry: h.referenceRegistry,
      referenceSource: h.program,
      authorInput: {
        action: 'delete', scope: { workspaceId, eventId }, kind: 'track', id: trackId,
        expectedSetVersion: beforeTarget.setVersion, expectedItemVersion: 1
      }
    })).toThrow('delete_referenced');

    const createTarget = planProgramVocabularyMutation({
      state: beforeTarget,
      referenceRegistry: h.referenceRegistry,
      referenceSource: h.program,
      authorInput: {
        action: 'create', scope: { workspaceId, eventId }, expectedSetVersion: beforeTarget.setVersion,
        item: { kind: 'track', id: targetTrackId, name: 'Infrastructure' }
      }
    });
    h.sqlite.exec('BEGIN IMMEDIATE;');
    h.program.applyVocabularyPlan(createTarget);
    h.sqlite.exec('COMMIT;');

    const beforeMerge = h.program.readVocabulary({ workspaceId, eventId })!;
    const merge = planProgramVocabularyMutation({
      state: beforeMerge,
      referenceRegistry: h.referenceRegistry,
      referenceSource: h.program,
      authorInput: {
        action: 'merge', scope: { workspaceId, eventId }, kind: 'track',
        sourceId: trackId, targetId: targetTrackId,
        expectedSetVersion: beforeMerge.setVersion,
        expectedSourceVersion: 1,
        expectedTargetVersion: 1
      }
    });
    if (merge.action !== 'merge') throw new TypeError('expected_session_track_merge');
    expect(merge.references[0]?.liveRepoints).toHaveLength(1);
    h.sqlite.exec('BEGIN IMMEDIATE;');
    expect(h.program.applyVocabularyPlan(merge)).toMatchObject({ action: 'merge', liveRepoints: 1 });
    h.sqlite.exec('COMMIT;');

    const catalog = h.sessions.readSessionCatalog({ workspaceId, eventId })!;
    expect(catalog.version).toBe(3);
    expect(findSession(catalog, sessionId)?.programTarget).toMatchObject({
      setVersion: beforeMerge.setVersion + 1,
      track: { id: targetTrackId, version: 1 }
    });
    expect(h.sqlite.query<{ slot_kind: string; item_id: string; version: number }, []>(`
      SELECT slot_kind,item_id,version FROM session_program_reference_slots
       ORDER BY slot_kind
    `).all()).toEqual([
      { slot_kind: 'format', item_id: formatId, version: 1 },
      { slot_kind: 'track', item_id: targetTrackId, version: 2 }
    ]);
    const references = captureRegisteredProgramReferences({
      registry: h.referenceRegistry,
      scope: beforeMerge.scope,
      source: h.program
    });
    expect(programReferenceUsage(references, { kind: 'track', id: trackId })).toEqual({
      current: 0, historicalPins: 0
    });
    expect(programReferenceUsage(references, { kind: 'track', id: targetTrackId })).toEqual({
      current: 1, historicalPins: 0
    });
    expect(h.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    h.sqlite.close();
  });

  test('commits lifecycle state, refuses replay, and applies exact compensation', () => {
    const { sqlite, sessions } = fixture();
    try {
      const plan = createPlan(sessions);
      expect(() => sessions.applySessionPlan(plan)).toThrow('transaction_required');
      sqlite.exec('BEGIN IMMEDIATE;');
      sessions.applySessionPlan(plan);
      sqlite.exec('COMMIT;');
      const created = sessions.readSessionCatalog({ workspaceId, eventId })!;
      expect(findSession(created, sessionId)).toMatchObject({ lifecycle: 'collecting', plannedDurationMinutes: 45 });

      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => sessions.applySessionPlan(plan)).toThrow('stale_catalog');
      sqlite.exec('ROLLBACK;');
      expect(sqlite.query('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 });

      const compensation = planSessionCompensation({
        original: plan, catalog: created, actorUserId: userId, occurredAt: later
      });
      sqlite.exec('BEGIN IMMEDIATE;');
      sessions.applySessionPlan(compensation);
      sqlite.exec('COMMIT;');
      expect(sessions.readSessionCatalog({ workspaceId, eventId })?.sessions).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  test('rolls back catalog and head together on caller failure', () => {
    const { sqlite, sessions } = fixture();
    try {
      const plan = createPlan(sessions);
      sqlite.exec('BEGIN IMMEDIATE;');
      sessions.applySessionPlan(plan);
      sqlite.exec('ROLLBACK;');
      expect(sessions.readSessionCatalog({ workspaceId, eventId })).toMatchObject({ version: 1, sessions: [] });
      expect(sqlite.query('SELECT count(*) AS count FROM session_catalogs').get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  test('counts live schedule occurrences per Session for the compensation deletion gate', () => {
    const { sqlite, sessions } = fixture();
    try {
      const plan = createPlan(sessions);
      sqlite.exec('BEGIN IMMEDIATE;');
      sessions.applySessionPlan(plan);
      sqlite.exec('COMMIT;');
      expect(sessions.countSessionSchedulePlacements({ workspaceId, eventId }, sessionId)).toBe(0);

      const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
      const occurrenceId = '019c1df7-86b5-769b-bba4-5f7097bfa502';
      const otherSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa503';
      sqlite.exec('BEGIN IMMEDIATE;');
      sqlite.query(`
        INSERT INTO program_vocabulary_rooms (
          workspace_id, event_id, id, name, status, capacity, version,
          created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, 'Main Hall', 'active', NULL, 1, ?, ?, ?, ?)
      `).run(workspaceId, eventId, roomId, userId, Date.parse(now), userId, Date.parse(now));
      sqlite.query(`
        INSERT INTO schedule_placement_sets (
          workspace_id, event_id, schedule_version, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, 2, ?, ?)
      `).run(workspaceId, eventId, userId, Date.parse(now));
      sqlite.query(`
        INSERT INTO schedule_occurrences (
          workspace_id, event_id, id, session_id, room_id, start_at_ms, end_at_ms,
          version, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        workspaceId, eventId, occurrenceId, sessionId, roomId,
        Date.parse(now), Date.parse(later), userId, Date.parse(now)
      );
      sqlite.exec('COMMIT;');
      expect(sessions.countSessionSchedulePlacements({ workspaceId, eventId }, sessionId)).toBe(1);
      expect(sessions.countSessionSchedulePlacements({ workspaceId, eventId }, otherSessionId)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('counts submission-origin and engagement references for guarded new-Session removal', () => {
    const { sqlite, sessions } = fixture();
    try {
      sqlite.exec(`
        CREATE TABLE submission_session_origins (
          workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, submission_id TEXT NOT NULL,
          session_id TEXT NOT NULL, PRIMARY KEY (workspace_id, event_id, submission_id)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE engagement_heads (
          workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, id TEXT NOT NULL,
          session_id TEXT NOT NULL, PRIMARY KEY (workspace_id, event_id, id)
        ) STRICT, WITHOUT ROWID;
      `);
      expect(sessions.countSessionCanonicalReferences({ workspaceId, eventId }, sessionId)).toBe(0);
      sqlite.query(`INSERT INTO submission_session_origins VALUES (?, ?, ?, ?)`)
        .run(workspaceId, eventId, '019c1df7-86b5-769b-bba4-5f7097bfa601', sessionId);
      expect(sessions.countSessionCanonicalReferences({ workspaceId, eventId }, sessionId)).toBe(1);
      sqlite.query(`INSERT INTO engagement_heads VALUES (?, ?, ?, ?)`)
        .run(workspaceId, eventId, '019c1df7-86b5-769b-bba4-5f7097bfa602', sessionId);
      expect(sessions.countSessionCanonicalReferences({ workspaceId, eventId }, sessionId)).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});
