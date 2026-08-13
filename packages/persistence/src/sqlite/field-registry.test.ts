import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  FieldRegistryPlanningError,
  planFieldRegistryMutation
} from '@jooevents/field-registry';
import {
  EventDependencySnapshotError,
  createEventDependencyContributorRegistry
} from '@jooevents/event';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { installEventSpineSchema } from './event-spine';
import { installSQLiteIntakeSchema } from './intake';
import { installProgramVocabularySchema } from './program-vocabulary';
import {
  FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR,
  createSQLiteFieldRegistryEventInitializer,
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema,
  SQLiteFieldRegistryEventDependencySource,
  SQLiteFieldRegistryError,
  SQLiteFieldRegistryRepository,
  SQLiteFieldRegistrySnapshotSource,
  SQLiteIntakeFieldRegistryFormReferenceResolver,
  SQLiteProgramVocabularyFieldOptionSource
} from './field-registry';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfa101';
const absentEventId = '019c1df7-86b5-769b-bba4-5f7097bfa102';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const trackActiveId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const trackRetiredId = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa403';
const customFieldId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const nowMs = Date.parse('2026-08-13T01:00:00.000Z');
const databases: Database[] = [];

function openDatabase(): Database {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
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
    CREATE TABLE foundation_trial_operation_receipts (
      id TEXT PRIMARY KEY, operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL, result_json TEXT NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
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
    ) VALUES (?, ?, 'Field Registry Event', 'UTC', '2026-11-01', '2026-11-02', 1,
      ?, ?, ?)
  `).run(workspaceId, eventId, userId, nowMs, 'a'.repeat(64));
  sqlite.query(`
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
  `).run(workspaceId, eventId);
  sqlite.query(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
     WHERE workspace_id = ?
  `).run(eventId, workspaceId);
  return sqlite;
}

function baselineIds() {
  let counter = 10;
  const next = () => {
    counter += 1;
    return `019c1df7-86b5-769b-bba4-${counter.toString().padStart(12, '0')}`;
  };
  return { newFieldId: next, newChoiceId: next };
}

function initialize(sqlite: Database) {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const state = initializeCanonicalFieldRegistry({
      sqlite,
      scope: { workspaceId, eventId },
      ids: baselineIds()
    });
    sqlite.exec('COMMIT');
    return state;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  }
}

function repository(sqlite: Database) {
  return new SQLiteFieldRegistryRepository(
    sqlite,
    new SQLiteIntakeFieldRegistryFormReferenceResolver(sqlite)
  );
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('disposable SQLite Field Registry', () => {
  test('requires event-transaction seeding and installs the canonical baseline once', () => {
    const sqlite = openDatabase();
    expect(() => initializeCanonicalFieldRegistry({
      sqlite,
      scope: { workspaceId, eventId },
      ids: baselineIds()
    })).toThrow(new SQLiteFieldRegistryError('transaction_required'));

    const state = initialize(sqlite);
    expect(state).toMatchObject({ version: 1, scope: { workspaceId, eventId } });
    expect(state.fields).toHaveLength(19);
    expect(repository(sqlite).readFieldRegistry({ workspaceId, eventId })).toEqual(state);

    sqlite.exec('BEGIN IMMEDIATE');
    expect(() => initializeCanonicalFieldRegistry({
      sqlite,
      scope: { workspaceId, eventId },
      ids: baselineIds()
    })).toThrow(new SQLiteFieldRegistryError('field_registry_exists'));
    sqlite.exec('ROLLBACK');
  });

  test('applies an exact guarded plan atomically and rejects its stale replay', () => {
    const sqlite = openDatabase();
    initialize(sqlite);
    const store = repository(sqlite);
    const state = store.readFieldRegistry({ workspaceId, eventId });
    if (!state) throw new TypeError('registry_fixture_missing');
    const plan = planFieldRegistryMutation({
      state,
      formReferences: store,
      author: {
        action: 'add',
        scope: { workspaceId, eventId },
        request: {
          expectedRegistryVersion: state.version,
          field: {
            kind: 'text', label: 'Company', answerOwner: 'person',
            scope: { kind: 'shared' },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: true, required: false }
            },
            options: { kind: 'none' }
          }
        },
        identities: {
          fieldId: customFieldId,
          fieldKey: 'custom.company',
          choices: []
        }
      }
    });

    sqlite.exec('BEGIN IMMEDIATE');
    const result = store.applyFieldRegistryPlan(plan);
    sqlite.exec('COMMIT');
    expect(result).toMatchObject({
      action: 'add', fieldId: customFieldId, registryVersion: 2, fieldVersion: 1
    });
    expect(store.readFieldRegistry({ workspaceId, eventId })?.fields)
      .toContainEqual(expect.objectContaining({ id: customFieldId, key: 'custom.company' }));

    sqlite.exec('BEGIN IMMEDIATE');
    expect(() => store.applyFieldRegistryPlan(plan))
      .toThrow(new FieldRegistryPlanningError('stale_registry'));
    sqlite.exec('ROLLBACK');
    expect(store.readFieldRegistry({ workspaceId, eventId })?.version).toBe(2);
  });

  test('initializes with the Event UoW and contributes only post-baseline dependencies', () => {
    const sqlite = openDatabase();
    const dependencyRegistry = createEventDependencyContributorRegistry({
      expected: [FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR],
      contributors: [FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR]
    });
    const source = new SQLiteFieldRegistryEventDependencySource(sqlite);
    const dependencyScope = {
      workspaceId: parseWorkspaceId(workspaceId),
      eventId: parseEventId(eventId)
    };
    const absent = dependencyRegistry.capture({
      workspaceId: parseWorkspaceId(workspaceId),
      eventId: parseEventId(absentEventId)
    }, source);
    expect(absent.contributors[0]).toMatchObject({
      guard: { version: 1 }, dependencies: []
    });
    expect(() => dependencyRegistry.capture(dependencyScope, source))
      .toThrow(EventDependencySnapshotError);

    const initializer = createSQLiteFieldRegistryEventInitializer({
      sqlite,
      ids: baselineIds()
    });
    expect(() => initializer.initializeCreatedEvent({ workspaceId, eventId }))
      .toThrow(new SQLiteFieldRegistryError('transaction_required'));
    sqlite.exec('BEGIN IMMEDIATE');
    const baseline = initializer.initializeCreatedEvent({ workspaceId, eventId });
    sqlite.exec('COMMIT');

    const initialEvidence = dependencyRegistry.capture(dependencyScope, source)
      .contributors[0];
    expect(initialEvidence).toMatchObject({
      guard: { version: 1 }, dependencies: []
    });

    const store = repository(sqlite);
    const plan = planFieldRegistryMutation({
      state: baseline,
      formReferences: store,
      author: {
        action: 'add',
        scope: { workspaceId, eventId },
        request: {
          expectedRegistryVersion: 1,
          field: {
            kind: 'text', label: 'Company', answerOwner: 'person',
            scope: { kind: 'shared' },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: true, required: false }
            },
            options: { kind: 'none' }
          }
        },
        identities: {
          fieldId: customFieldId,
          fieldKey: 'custom.company',
          choices: []
        }
      }
    });
    sqlite.exec('BEGIN IMMEDIATE');
    store.applyFieldRegistryPlan(plan);
    sqlite.exec('COMMIT');

    const changedEvidence = dependencyRegistry.capture(dependencyScope, source)
      .contributors[0];
    expect(changedEvidence).toMatchObject({
      guard: { version: 2 },
      dependencies: [{
        referenceKey: `field_registry:${eventId}`,
        version: 2,
        destination: { kind: 'field_registry', id: `field_registry:${eventId}` }
      }]
    });
    expect(changedEvidence?.guard.digest).not.toBe(initialEvidence?.guard.digest);
  });

  test('pins form-scoped fields to the live Intake head version', () => {
    const sqlite = openDatabase();
    initialize(sqlite);
    sqlite.query(`
      INSERT INTO intake_form_catalogs (workspace_id, event_id, catalog_version)
      VALUES (?, ?, 2)
    `).run(workspaceId, eventId);
    sqlite.query(`
      INSERT INTO intake_form_heads (
        workspace_id, event_id, form_id, head_version, status,
        current_published_version_id, head_json, head_digest_sha256,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, 7, 'draft', null, '{}', ?, ?, ?, ?, ?)
    `).run(workspaceId, eventId, formId, 'b'.repeat(64), userId, nowMs, userId, nowMs);
    const store = repository(sqlite);
    const state = store.readFieldRegistry({ workspaceId, eventId });
    if (!state) throw new TypeError('registry_fixture_missing');
    const plan = planFieldRegistryMutation({
      state,
      formReferences: store,
      author: {
        action: 'add', scope: { workspaceId, eventId },
        request: {
          expectedRegistryVersion: 1,
          field: {
            kind: 'textarea', label: 'Session audience', answerOwner: 'talk',
            scope: { kind: 'form', formId },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: false, required: false }
            },
            options: { kind: 'none' }
          }
        },
        identities: {
          fieldId: customFieldId,
          fieldKey: 'custom.session_audience',
          choices: []
        }
      }
    });
    expect(plan.formPin).toEqual({ id: formId, version: 7 });
  });

  test('projects tracks and formats from live Program Vocabulary rows', () => {
    const sqlite = openDatabase();
    initialize(sqlite);
    sqlite.query(`
      INSERT INTO program_vocabulary_sets (
        workspace_id, event_id, set_version, created_by_user_id,
        created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, 2, ?, ?, ?, ?)
    `).run(workspaceId, eventId, userId, nowMs, userId, nowMs);
    sqlite.query(`
      INSERT INTO program_vocabulary_tracks (
        workspace_id, event_id, id, name, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, 'Platform', 'active', 2, ?, ?, ?, ?),
               (?, ?, ?, 'Retired', 'retired', 3, ?, ?, ?, ?)
    `).run(
      workspaceId, eventId, trackActiveId, userId, nowMs, userId, nowMs,
      workspaceId, eventId, trackRetiredId, userId, nowMs, userId, nowMs
    );
    sqlite.query(`
      INSERT INTO program_vocabulary_formats (
        workspace_id, event_id, id, name, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, 'Talk', 'active', 1, ?, ?, ?, ?)
    `).run(workspaceId, eventId, formatId, userId, nowMs, userId, nowMs);

    const snapshot = new SQLiteFieldRegistrySnapshotSource(
      repository(sqlite),
      new SQLiteProgramVocabularyFieldOptionSource(sqlite)
    ).readSnapshot({ workspaceId, eventId });
    expect(snapshot?.fields.find((field) => field.key === 'talk.track')?.resolvedOptions)
      .toEqual([{ id: trackActiveId, label: 'Platform', version: 2 }]);
    expect(snapshot?.fields.find((field) => field.key === 'talk.format')?.resolvedOptions)
      .toEqual([{ id: formatId, label: 'Talk', version: 1 }]);
  });
});
