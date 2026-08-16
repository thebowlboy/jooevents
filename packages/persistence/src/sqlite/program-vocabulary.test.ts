import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation,
  type ProgramReferenceContributorSnapshot,
  type ProgramReferenceRepoint,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import {
  parseEventId,
  parseAggregateVersion,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyError,
  SQLiteProgramVocabularyRepository,
  type ProgramVocabularyMutationAttribution,
  type SQLiteProgramVocabularyContributorAdapter
} from './program-vocabulary';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const otherWorkspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const otherEventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa102');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const otherUserId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa302';
const targetTrackId = '019c1df7-86b5-769b-bba4-5f7097bfa303';
const now = parseInstant('2026-08-12T08:00:00.000Z');
const later = parseInstant('2026-08-12T08:05:00.000Z');
const databases: Database[] = [];
const temporaryDirectories: string[] = [];

const emptyDomainRegistry = createProgramReferenceContributorRegistry({
  expected: [],
  contributors: []
});

function openDatabase(): Database {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE operation_log (
      id TEXT PRIMARY KEY,
      operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL,
      result_json TEXT NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1),
           (?, 'Other workspace', 'active', 1, 1, 1)
  `).run(workspaceId, otherWorkspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1),
           (?, 'active', 'Other Operator', 1, 1, 1)
  `).run(userId, otherUserId);
  return sqlite;
}

function insertEventRoot(
  sqlite: Database,
  scope: { readonly workspaceId: string; readonly eventId: string } = { workspaceId, eventId }
): void {
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(scope.workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Program Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(scope.workspaceId, scope.eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
  `).run(scope.workspaceId, scope.eventId);
  sqlite.query(`
    UPDATE event_spine_workspace_sets
       SET version = 2, current_event_id = ?
     WHERE workspace_id = ?
  `).run(scope.eventId, scope.workspaceId);
}

function attribution(
  actorUserId = userId,
  occurredAt = now
): () => ProgramVocabularyMutationAttribution {
  return () => Object.freeze({ actorUserId, occurredAt });
}

function emptyRepository(sqlite: Database, source = attribution()): SQLiteProgramVocabularyRepository {
  const adapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [],
    adapters: []
  });
  return new SQLiteProgramVocabularyRepository(sqlite, emptyDomainRegistry, adapters, source);
}

function createPlan(
  repository: SQLiteProgramVocabularyRepository,
  input: {
    readonly kind?: 'room' | 'track';
    readonly id?: string;
    readonly name?: string;
  } = {}
): ProgramVocabularyMutationPlan {
  const state = repository.readVocabulary({ workspaceId, eventId });
  if (!state) throw new Error('Event fixture is missing');
  const kind = input.kind ?? 'room';
  const authorInput = kind === 'room'
    ? {
        action: 'create' as const,
        scope: { workspaceId, eventId },
        expectedSetVersion: state.setVersion,
        item: {
          kind: 'room' as const,
          id: input.id ?? roomId,
          name: input.name ?? 'Main Hall',
          capacity: 180
        }
      }
    : {
        action: 'create' as const,
        scope: { workspaceId, eventId },
        expectedSetVersion: state.setVersion,
        item: {
          kind: 'track' as const,
          id: input.id ?? trackId,
          name: input.name ?? 'Platform'
        }
      };
  return planProgramVocabularyMutation({
    state,
    referenceRegistry: emptyDomainRegistry,
    referenceSource: repository,
    authorInput
  });
}

function apply(sqlite: Database, repository: SQLiteProgramVocabularyRepository, plan: ProgramVocabularyMutationPlan) {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = repository.applyVocabularyPlan(plan);
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('ordinary ephemeral SQLite Program Vocabulary repository', () => {
  test('exposes canonical empty version 1 only for a valid Event root and never writes on read', () => {
    const sqlite = openDatabase();
    const repository = emptyRepository(sqlite);
    expect(repository.readVocabulary({ workspaceId, eventId })).toBeUndefined();
    expect(sqlite.query('SELECT count(*) AS count FROM program_vocabulary_sets').get())
      .toEqual({ count: 0 });

    sqlite.exec('BEGIN IMMEDIATE;');
    insertEventRoot(sqlite);
    expect(repository.readVocabulary({ workspaceId, eventId })).toMatchObject({
      scope: { workspaceId, eventId },
      setVersion: parseAggregateVersion(1),
      rooms: [],
      tracks: [],
      formats: []
    });
    expect(repository.readVocabulary({ workspaceId: otherWorkspaceId, eventId })).toBeUndefined();
    expect(sqlite.query('SELECT count(*) AS count FROM program_vocabulary_sets').get())
      .toEqual({ count: 0 });
    sqlite.exec('ROLLBACK;');
    expect(repository.readVocabulary({ workspaceId, eventId })).toBeUndefined();
  });

  test('materializes virtual version 1 as version 2 exactly once with server attribution', () => {
    const sqlite = openDatabase();
    insertEventRoot(sqlite);
    const repository = emptyRepository(sqlite);
    const plan = createPlan(repository);

    expect(() => repository.applyVocabularyPlan(plan)).toThrow('transaction_required');
    expect(apply(sqlite, repository, plan)).toEqual({
      action: 'create',
      kind: 'room',
      affectedIds: [roomId],
      setVersion: 2,
      liveRepoints: 0
    });
    expect(repository.readVocabulary({ workspaceId, eventId })?.rooms).toMatchObject([{
      kind: 'room',
      id: roomId,
      scope: { workspaceId, eventId },
      name: 'Main Hall',
      capacity: 180,
      status: 'active',
      version: parseAggregateVersion(1)
    }]);
    expect(sqlite.query(`
      SELECT set_version, created_by_user_id, created_at_ms,
             updated_by_user_id, updated_at_ms
        FROM program_vocabulary_sets
    `).get()).toEqual({
      set_version: 2,
      created_by_user_id: userId,
      created_at_ms: Date.parse(now),
      updated_by_user_id: userId,
      updated_at_ms: Date.parse(now)
    });
    expect(sqlite.query(`
      SELECT created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
        FROM program_vocabulary_rooms WHERE id = ?
    `).get(roomId)).toEqual({
      created_by_user_id: userId,
      created_at_ms: Date.parse(now),
      updated_by_user_id: userId,
      updated_at_ms: Date.parse(now)
    });

    sqlite.exec('BEGIN IMMEDIATE;');
    expect(() => repository.applyVocabularyPlan(plan)).toThrow('stale_set');
    sqlite.exec('ROLLBACK;');
    expect(sqlite.query('SELECT count(*) AS count FROM program_vocabulary_rooms').get())
      .toEqual({ count: 1 });
  });

  test('updates state with optimistic guards while preserving creation attribution', () => {
    const sqlite = openDatabase();
    insertEventRoot(sqlite);
    const first = emptyRepository(sqlite);
    apply(sqlite, first, createPlan(first));
    const second = emptyRepository(sqlite, attribution(otherUserId, later));
    const state = second.readVocabulary({ workspaceId, eventId });
    if (!state) throw new Error('Vocabulary fixture is missing');
    const edit = planProgramVocabularyMutation({
      state,
      referenceRegistry: emptyDomainRegistry,
      referenceSource: second,
      authorInput: {
        action: 'edit',
        scope: { workspaceId, eventId },
        expectedSetVersion: 2,
        kind: 'room',
        id: roomId,
        expectedItemVersion: 1,
        changes: { name: 'Grand Hall', capacity: 220 }
      }
    });
    expect(apply(sqlite, second, edit).setVersion).toBe(3);
    expect(sqlite.query(`
      SELECT name, capacity, version, created_by_user_id, created_at_ms,
             updated_by_user_id, updated_at_ms
        FROM program_vocabulary_rooms WHERE id = ?
    `).get(roomId)).toEqual({
      name: 'Grand Hall',
      capacity: 220,
      version: 2,
      created_by_user_id: userId,
      created_at_ms: Date.parse(now),
      updated_by_user_id: otherUserId,
      updated_at_ms: Date.parse(later)
    });
    expect(() => sqlite.query(`
      UPDATE program_vocabulary_rooms SET created_by_user_id = ? WHERE id = ?
    `).run(otherUserId, roomId)).toThrow('program vocabulary attribution is invalid');
    expect(() => sqlite.query(`
      UPDATE program_vocabulary_rooms SET updated_at_ms = 1 WHERE id = ?
    `).run(roomId)).toThrow('program vocabulary attribution is invalid');
  });

  test('enforces Event scope, immutable identities, and cross-kind collision guards', () => {
    const sqlite = openDatabase();
    expect(() => sqlite.query(`
      INSERT INTO program_vocabulary_sets (
        workspace_id, event_id, set_version, created_by_user_id,
        created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, 2, ?, 1, ?, 1)
    `).run(workspaceId, eventId, userId, userId)).toThrow('FOREIGN KEY constraint failed');

    insertEventRoot(sqlite);
    const repository = emptyRepository(sqlite);
    apply(sqlite, repository, createPlan(repository));
    expect(() => sqlite.query(`
      UPDATE program_vocabulary_rooms SET id = ? WHERE id = ?
    `).run(trackId, roomId)).toThrow('program vocabulary identity is immutable');
    expect(() => sqlite.query(`
      INSERT INTO program_vocabulary_tracks (
        workspace_id, event_id, id, name, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, 'Collision', 'active', 1, ?, ?, ?, ?)
    `).run(
      workspaceId, eventId, roomId, userId, Date.parse(now), userId, Date.parse(now)
    )).toThrow('program vocabulary ids must be distinct across kinds');
  });

  test('refuses noncanonical stored bytes rather than normalizing or repairing them', () => {
    const sqlite = openDatabase();
    insertEventRoot(sqlite);
    const repository = emptyRepository(sqlite);
    apply(sqlite, repository, createPlan(repository));
    sqlite.exec('PRAGMA ignore_check_constraints = ON;');
    sqlite.query(`
      UPDATE program_vocabulary_rooms SET name = ' Main Hall ' WHERE id = ?
    `).run(roomId);
    sqlite.exec('PRAGMA ignore_check_constraints = OFF;');
    expect(() => repository.readVocabulary({ workspaceId, eventId }))
      .toThrow(SQLiteProgramVocabularyError);

    sqlite.exec('PRAGMA ignore_check_constraints = ON;');
    sqlite.query(`
      UPDATE program_vocabulary_rooms SET name = 'Main Hall'
       WHERE id = ?
    `).run(roomId);
    sqlite.exec('DROP TRIGGER program_vocabulary_rooms_identity_immutable;');
    sqlite.query('UPDATE program_vocabulary_rooms SET id = upper(id) WHERE lower(id) = ?').run(roomId);
    sqlite.exec('PRAGMA ignore_check_constraints = OFF;');
    expect(() => repository.readVocabulary({ workspaceId, eventId }))
      .toThrow('program_vocabulary_data_corrupt');
  });

  test('rolls back materialization and item state when a later write fails', () => {
    const sqlite = openDatabase();
    insertEventRoot(sqlite);
    const repository = emptyRepository(sqlite);
    const plan = createPlan(repository);
    sqlite.exec(`
      CREATE TRIGGER program_vocabulary_test_fail_item
      BEFORE INSERT ON program_vocabulary_rooms
      BEGIN SELECT RAISE(ABORT, 'test later write failure'); END;
    `);
    sqlite.exec('BEGIN IMMEDIATE;');
    expect(() => repository.applyVocabularyPlan(plan)).toThrow('test later write failure');
    sqlite.exec('ROLLBACK;');
    expect(sqlite.query('SELECT count(*) AS count FROM program_vocabulary_sets').get())
      .toEqual({ count: 0 });
    expect(sqlite.query('SELECT count(*) AS count FROM program_vocabulary_rooms').get())
      .toEqual({ count: 0 });
  });

  test('serializes first materialization across two SQLite connections without duplicate state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-program-vocabulary-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'program.sqlite');
    const first = new Database(path, { strict: true, create: true });
    databases.push(first);
    first.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5;
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
    installEventSpineSchema(first);
    installProgramVocabularySchema(first);
    first.query(`
      INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
      VALUES (?, 'Workspace', 'active', 1, 1, 1)
    `).run(workspaceId);
    first.query(`
      INSERT INTO users (id, status, display_name, created_at, updated_at, version)
      VALUES (?, 'active', 'Operator', 1, 1, 1)
    `).run(userId);
    insertEventRoot(first);
    const second = new Database(path, { strict: true });
    databases.push(second);
    second.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5;');
    const firstRepository = emptyRepository(first);
    const secondRepository = emptyRepository(second);
    const firstPlan = createPlan(firstRepository);
    const secondPlan = createPlan(secondRepository);

    first.exec('BEGIN IMMEDIATE;');
    expect(firstRepository.applyVocabularyPlan(firstPlan).setVersion).toBe(2);
    expect(() => second.exec('BEGIN IMMEDIATE;')).toThrow(/database is locked|database is busy/i);
    first.exec('COMMIT;');

    second.exec('BEGIN IMMEDIATE;');
    expect(() => secondRepository.applyVocabularyPlan(secondPlan)).toThrow('stale_set');
    second.exec('ROLLBACK;');
    expect(first.query('SELECT count(*) AS count FROM program_vocabulary_sets').get())
      .toEqual({ count: 1 });
    expect(first.query('SELECT count(*) AS count FROM program_vocabulary_rooms').get())
      .toEqual({ count: 1 });
  });

  test('authenticates contributor registries and rejects missing, async, or wrong-version adapters', () => {
    const sqlite = openDatabase();
    const expected = [{ key: 'schedule.sessions', version: 1 }] as const;
    const domainRegistry = createProgramReferenceContributorRegistry({
      expected,
      contributors: expected
    });
    expect(() => createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite,
      expected,
      adapters: []
    })).toThrow('contributor_registry_invalid');
    expect(() => createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite,
      expected,
      adapters: [{
        contributor: { key: 'schedule.sessions', version: 2 },
        read: () => ({ kind: 'missing' as const }),
        applyRepoints: () => undefined
      }]
    })).toThrow('contributor_registry_invalid');
    expect(() => createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite,
      expected,
      adapters: [{
        contributor: expected[0],
        read: async () => ({ kind: 'missing' as const }),
        applyRepoints: () => undefined
      } as unknown as SQLiteProgramVocabularyContributorAdapter]
    })).toThrow('contributor_registry_invalid');

    const forged = Object.freeze({ adapters: [], source: { readContributor: () => undefined }, applyRepoints: () => undefined });
    expect(() => new SQLiteProgramVocabularyRepository(
      sqlite,
      domainRegistry,
      forged as never,
      attribution()
    )).toThrow('contributor_registry_invalid');
    const other = openDatabase();
    const sealedForOtherHandle = createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite: other,
      expected: [],
      adapters: []
    });
    expect(() => new SQLiteProgramVocabularyRepository(
      sqlite,
      emptyDomainRegistry,
      sealedForOtherHandle,
      attribution()
    )).toThrow('contributor_registry_invalid');
  });

  test('requires an adapter to realize exact merge repoints before domain state can commit', () => {
    const sqlite = openDatabase();
    insertEventRoot(sqlite);
    const expected = [{ key: 'schedule.sessions', version: 1 }] as const;
    const domainRegistry = createProgramReferenceContributorRegistry({
      expected,
      contributors: expected
    });
    let snapshot: ProgramReferenceContributorSnapshot | undefined;
    const adapter = createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite,
      expected,
      adapters: [{
        contributor: expected[0],
        read: () => snapshot
          ? { kind: 'available' as const, snapshot }
          : { kind: 'missing' as const },
        applyRepoints: () => undefined
      }]
    });
    const repository = new SQLiteProgramVocabularyRepository(
      sqlite,
      domainRegistry,
      adapter,
      attribution()
    );
    apply(sqlite, repository, createPlan(repository, {
      kind: 'track', id: trackId, name: 'Platform'
    }));
    apply(sqlite, repository, createPlan(repository, {
      kind: 'track', id: targetTrackId, name: 'Architecture'
    }));
    snapshot = {
      contributor: expected[0],
      scope: { workspaceId, eventId },
      guard: {
        id: 'program_reference:schedule.sessions',
        version: parseAggregateVersion(1),
        digest: 'b'.repeat(64)
      },
      references: [{
        referenceKey: 'session:opening',
        version: parseAggregateVersion(1),
        item: { kind: 'track', id: trackId },
        mode: 'current',
        destination: { kind: 'schedule.session', id: 'opening' }
      }]
    };
    const state = repository.readVocabulary({ workspaceId, eventId });
    if (!state) throw new Error('Vocabulary fixture is missing');
    const merge = planProgramVocabularyMutation({
      state,
      referenceRegistry: domainRegistry,
      referenceSource: repository,
      authorInput: {
        action: 'merge',
        scope: { workspaceId, eventId },
        expectedSetVersion: state.setVersion,
        kind: 'track',
        sourceId: trackId,
        targetId: targetTrackId,
        expectedSourceVersion: 1,
        expectedTargetVersion: 1
      }
    });
    sqlite.exec('BEGIN IMMEDIATE;');
    expect(() => repository.applyVocabularyPlan(merge)).toThrow('stale_reference');
    sqlite.exec('ROLLBACK;');
    expect(repository.readVocabulary({ workspaceId, eventId })?.tracks
      .find((track) => track.id === trackId)?.status).toBe('active');
  });

  test('uses bounded indexed parameterized reads', () => {
    const sqlite = openDatabase();
    const setPlan = sqlite.query<{ readonly detail: string }, [string, string]>(`
      EXPLAIN QUERY PLAN
      SELECT set_version FROM program_vocabulary_sets
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(workspaceId, eventId).map((row) => row.detail).join(' ');
    const roomPlan = sqlite.query<{ readonly detail: string }, [string, string]>(`
      EXPLAIN QUERY PLAN
      SELECT id, name, capacity, status, version FROM program_vocabulary_rooms
       WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY
    `).all(workspaceId, eventId).map((row) => row.detail).join(' ');
    expect(setPlan).toContain('PRIMARY KEY');
    expect(roomPlan).toMatch(/PRIMARY KEY|program_vocabulary_rooms_read/);
  });
});
