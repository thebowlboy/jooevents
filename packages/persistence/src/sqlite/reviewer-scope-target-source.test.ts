import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import { parseEventId, parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  reviewerScopeTargetFactDigest,
  reviewerScopeTargetSetDigest
} from '@jooevents/review/roster';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import { SQLiteReviewerScopeTargetSource } from './reviewer-scope-target-source';

const workspaceId = parseWorkspaceId('01890f47-9abc-7def-8123-000000000001');
const eventId = parseEventId('01890f47-9abc-7def-8123-000000000002');
const unknownEventId = parseEventId('01890f47-9abc-7def-8123-000000000003');
const userId = parseUserId('01890f47-9abc-7def-8123-000000000004');
const trackAlphaId = '01890f47-9abc-7def-8123-000000000010';
const trackBetaId = '01890f47-9abc-7def-8123-000000000011';
const formatId = '01890f47-9abc-7def-8123-000000000012';
const roomId = '01890f47-9abc-7def-8123-000000000013';
const now = parseInstant('2026-08-13T09:00:00.000Z');
const scope = Object.freeze({ workspaceId, eventId });
const databases: Database[] = [];

const emptyDomainRegistry = createProgramReferenceContributorRegistry({
  expected: [],
  contributors: []
});

function fixture() {
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
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
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
    ) VALUES (?, ?, 'Summit', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
  `).run(workspaceId, eventId);
  const adapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [],
    adapters: []
  });
  const vocabulary = new SQLiteProgramVocabularyRepository(
    sqlite,
    emptyDomainRegistry,
    adapters,
    () => Object.freeze({ actorUserId: userId, occurredAt: now })
  );
  return { sqlite, vocabulary, source: new SQLiteReviewerScopeTargetSource(vocabulary) };
}

function mutate(
  sqlite: Database,
  vocabulary: SQLiteProgramVocabularyRepository,
  authorInput: Parameters<typeof planProgramVocabularyMutation>[0]['authorInput']
): void {
  const state = vocabulary.readVocabulary(scope);
  if (!state) throw new TypeError('vocabulary_fixture_missing');
  const plan: ProgramVocabularyMutationPlan = planProgramVocabularyMutation({
    state,
    referenceRegistry: emptyDomainRegistry,
    referenceSource: vocabulary,
    authorInput
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    vocabulary.applyVocabularyPlan(plan);
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function create(
  sqlite: Database,
  vocabulary: SQLiteProgramVocabularyRepository,
  item:
    | { readonly kind: 'track' | 'format'; readonly id: string; readonly name: string }
    | { readonly kind: 'room'; readonly id: string; readonly name: string; readonly capacity: number }
): void {
  const state = vocabulary.readVocabulary(scope);
  if (!state) throw new TypeError('vocabulary_fixture_missing');
  const base = { action: 'create' as const, scope, expectedSetVersion: state.setVersion };
  mutate(sqlite, vocabulary, item.kind === 'room'
    ? { ...base, item: { kind: 'room', id: item.id, name: item.name, capacity: item.capacity } }
    : item.kind === 'track'
      ? { ...base, item: { kind: 'track', id: item.id, name: item.name } }
      : { ...base, item: { kind: 'format', id: item.id, name: item.name } });
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('SQLite reviewer scope target source', () => {
  test('projects tracks and formats with assignability, item versions, the set version, and true digests', () => {
    const { sqlite, vocabulary, source } = fixture();
    create(sqlite, vocabulary, { kind: 'track', id: trackAlphaId, name: 'Data & AI' });
    create(sqlite, vocabulary, { kind: 'track', id: trackBetaId, name: 'Community' });
    create(sqlite, vocabulary, { kind: 'format', id: formatId, name: 'Talk' });
    create(sqlite, vocabulary, { kind: 'room', id: roomId, name: 'Main Hall', capacity: 180 });
    mutate(sqlite, vocabulary, {
      action: 'retire', scope, kind: 'track', id: trackBetaId,
      expectedSetVersion: vocabulary.readVocabulary(scope)!.setVersion,
      expectedItemVersion: 1
    });

    const set = source.readReviewerScopeTargets(scope);
    expect(set).toBeDefined();
    expect(set!.version).toBe(vocabulary.readVocabulary(scope)!.setVersion);
    expect(set!.targets.map((target) =>
      `${target.ref.kind}:${target.ref.id}:${target.assignability}`
    )).toEqual([
      `track:${trackAlphaId}:assignable`,
      `track:${trackBetaId}:retained_only`,
      `format:${formatId}:assignable`
    ]);
    expect(set!.targets.map((target) => target.version)).toEqual([1, 2, 1]);
    expect(set!.targets.some((target) => target.ref.id === roomId)).toBe(false);
    for (const target of set!.targets) {
      const { digestSha256, ...unsigned } = target;
      expect(digestSha256).toBe(reviewerScopeTargetFactDigest(unsigned));
    }
    const { digestSha256, ...unsigned } = set!;
    expect(digestSha256).toBe(reviewerScopeTargetSetDigest(unsigned));
  });

  test('restoring a retired item makes it assignable again and moves the set version', () => {
    const { sqlite, vocabulary, source } = fixture();
    create(sqlite, vocabulary, { kind: 'format', id: formatId, name: 'Workshop' });
    mutate(sqlite, vocabulary, {
      action: 'retire', scope, kind: 'format', id: formatId,
      expectedSetVersion: vocabulary.readVocabulary(scope)!.setVersion,
      expectedItemVersion: 1
    });
    const retired = source.readReviewerScopeTargets(scope)!;
    expect(retired.targets).toEqual([expect.objectContaining({
      ref: { kind: 'format', id: formatId }, assignability: 'retained_only', version: 2
    })]);
    mutate(sqlite, vocabulary, {
      action: 'restore', scope, kind: 'format', id: formatId,
      expectedSetVersion: vocabulary.readVocabulary(scope)!.setVersion,
      expectedItemVersion: 2
    });
    const restored = source.readReviewerScopeTargets(scope)!;
    expect(restored.targets[0]).toMatchObject({ assignability: 'assignable', version: 3 });
    expect(restored.version).toBe(retired.version + 1);
  });

  test('reads an unknown event as undefined, an established empty scope as an empty set, and never sessions', () => {
    const { source, sqlite, vocabulary } = fixture();
    expect(source.readReviewerScopeTargets({ workspaceId, eventId: unknownEventId }))
      .toBeUndefined();
    const empty = source.readReviewerScopeTargets(scope);
    expect(empty).toMatchObject({ version: 1, targets: [] });
    create(sqlite, vocabulary, { kind: 'track', id: trackAlphaId, name: 'Data & AI' });
    expect(source.readReviewerScopeTargets(scope)!.targets
      .every((target) => target.ref.kind !== 'session')).toBe(true);
    expect(() => new SQLiteReviewerScopeTargetSource(
      undefined as unknown as SQLiteProgramVocabularyRepository
    )).toThrow('reviewer_scope_target_vocabulary_source_invalid');
  });
});
