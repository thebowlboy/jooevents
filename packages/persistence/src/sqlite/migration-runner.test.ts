import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  captureRegisteredProgramReferences,
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation
} from '@jooevents/program';
import { applyEngagementSeedFrom, planEngagementSeedFrom } from '@jooevents/engagement';
import { planSessionMutation } from '@jooevents/session';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import { loadSQLiteFoundationArtifacts, migrateOrValidateSQLite } from './migration-runner';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import {
  SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR,
  SQLiteSessionRepository,
  createSQLiteSessionProgramReferenceAdapter
} from './session';
import { SQLiteEngagementRepository } from './engagement';

const temporaryDirectories: string[] = [];
const opened: OpenSQLiteResult[] = [];

afterEach(() => {
  while (opened.length) opened.pop()?.sqlite.close();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-runner-'));
  temporaryDirectories.push(directory);
  return join(directory, 'database.sqlite');
}

function expectFoundationError(work: () => unknown, code: SQLiteFoundationError['code']): SQLiteFoundationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return error as SQLiteFoundationError;
  }
  throw new Error(`Expected ${code}`);
}

function applicationRows(database: Database, selectedTableNames?: readonly string[]): string {
  const tableNames = selectedTableNames ?? database.query<{ name: string }, []>(`
    select name from pragma_table_list
     where schema = 'main' and type = 'table' and name not like 'sqlite_%'
       and name not in ('schema_migrations', 'schema_epoch_transitions', 'database_instance_metadata')
     order by name
  `).all().map((row) => row.name);
  const rows = tableNames.map((table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const values = database.query<Record<string, unknown>, []>(`select * from ${quoted}`).all()
      .map((row) => JSON.stringify(row))
      .sort();
    return [table, values] as const;
  });
  return JSON.stringify(rows);
}

describe('SQLite epoch-2 retained-baseline runner', () => {
  test('migrates an empty ephemeral database once with a terminal receipt', () => {
    const database = openSQLite(':memory:');
    opened.push(database);
    const terminal = SQLITE_MIGRATION_MANIFEST.migrations.at(-1)!;
    expect(database.migration).toMatchObject({
      status: 'applied',
      coordinate: { schemaEpoch: terminal.schemaEpoch, sequence: terminal.sequence },
      migrationId: terminal.migrationId,
      databaseClass: 'ephemeral',
      schemaFingerprint: SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    });
    expect(database.migration.databaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(database.sqlite.query<{ migration_id: string; receipt_kind: string; checksum_sha256: string }, []>(
      'select migration_id, receipt_kind, checksum_sha256 from schema_migrations order by schema_epoch,sequence'
    ).all()).toEqual(SQLITE_MIGRATION_MANIFEST.migrations.map((migration) => ({
      migration_id: migration.migrationId,
      receipt_kind: 'executed',
      checksum_sha256: migration.checksumSha256
    })));
    expect(database.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('upgrades retained Sessions and backfills one lineup entry per person', () => {
    const path = temporaryDatabasePath();
    let schemaPass = 0;
    const held = new Database(path, { create: true, strict: true });
    held.exec('PRAGMA foreign_keys = ON;');
    expectFoundationError(() => migrateOrValidateSQLite({
      database: held,
      artifacts: loadSQLiteFoundationArtifacts(),
      policy: 'apply',
      databaseClass: 'retained_development',
      isMemory: false,
      fault(point) {
        if (point === 'after_schema_before_receipt' && (schemaPass += 1) === 8) {
          throw new Error('hold_before_e2_0008_receipt');
        }
      }
    }), 'migration_transaction_failed');
    held.close();

    const workspaceId = parseWorkspaceId('019c1df7-86b5-769b-bba4-600000000001');
    const eventId = parseEventId('019c1df7-86b5-769b-bba4-600000000002');
    const userId = parseUserId('019c1df7-86b5-769b-bba4-600000000003');
    const formatId = '019c1df7-86b5-769b-bba4-600000000004';
    const trackId = '019c1df7-86b5-769b-bba4-600000000005';
    const sessionId = '019c1df7-86b5-769b-bba4-600000000006';
    const secondSessionId = '019c1df7-86b5-769b-bba4-600000000007';
    const personA = '019c1df7-86b5-769b-bba4-600000000008';
    const personB = '019c1df7-86b5-769b-bba4-600000000009';
    const submissionA = '019c1df7-86b5-769b-bba4-60000000000a';
    const submissionB = '019c1df7-86b5-769b-bba4-60000000000b';
    const now = parseInstant('2026-08-18T01:00:00.000Z');
    const seed = new Database(path, { create: false, strict: true });
    seed.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    seed.query(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Sequence 7 workspace','active',0,0,1)`).run(workspaceId);
    seed.query(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','Sequence 7 owner',0,0,1)`).run(userId);
    seed.query(`INSERT INTO event_spine_workspace_sets (workspace_id,version,current_event_id)
      VALUES (?,1,NULL)`).run(workspaceId);
    seed.query(`INSERT INTO event_spine_heads (
      workspace_id,id,name,timezone,start_date,end_date,version,created_by_user_id,
      created_at_ms,create_plan_digest_sha256
    ) VALUES (? ,? ,'Retained event','UTC','2026-09-01','2026-09-02',1,?,?,?)`)
      .run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
    seed.query(`INSERT INTO event_spine_scope_roots (workspace_id,event_id) VALUES (?,?)`)
      .run(workspaceId, eventId);
    seed.query(`UPDATE event_spine_workspace_sets SET version = 2,current_event_id = ?
      WHERE workspace_id = ?`).run(eventId, workspaceId);
    seed.exec('COMMIT;');

    const emptyReferences = createProgramReferenceContributorRegistry({ expected: [], contributors: [] });
    const emptyAdapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite: seed, expected: [], adapters: []
    });
    const vocabulary = new SQLiteProgramVocabularyRepository(
      seed,
      emptyReferences,
      emptyAdapters,
      () => ({ actorUserId: userId, occurredAt: now })
    );
    for (const item of [
      { kind: 'format' as const, id: formatId, name: 'Talk' },
      { kind: 'track' as const, id: trackId, name: 'Platform' }
    ]) {
      const state = vocabulary.readVocabulary({ workspaceId, eventId })!;
      const plan = planProgramVocabularyMutation({
        state,
        referenceRegistry: emptyReferences,
        referenceSource: vocabulary,
        authorInput: item.kind === 'format'
          ? {
              action: 'create', scope: { workspaceId, eventId },
              expectedSetVersion: state.setVersion, item
            }
          : {
              action: 'create', scope: { workspaceId, eventId },
              expectedSetVersion: state.setVersion, item
            }
      });
      seed.exec('BEGIN IMMEDIATE;');
      vocabulary.applyVocabularyPlan(plan);
      seed.exec('COMMIT;');
    }
    const sessions = new SQLiteSessionRepository(seed, vocabulary);
    const catalog = sessions.readSessionCatalog({ workspaceId, eventId })!;
    const createSession = planSessionMutation({
      catalog,
      vocabulary: sessions.readSessionVocabulary({ workspaceId, eventId })!,
      planningInput: {
        action: 'create', scope: { workspaceId, eventId }, sessionId,
        actorUserId: userId, occurredAt: now,
        expectedCatalogVersion: catalog.version,
        expectedCatalogDigestSha256: catalog.digestSha256,
        title: 'Retained Session', plannedDurationMinutes: 45,
        lifecycle: 'collecting', formatId, trackId,
        participants: [
          {
            personId: personA, role: 'speaker', publiclyVisible: true,
            source: { kind: 'submission', id: submissionA, version: 1 }
          },
          {
            personId: personB, role: 'speaker', publiclyVisible: false,
            source: { kind: 'submission', id: submissionA, version: 1 }
          }
        ]
      }
    });
    seed.exec('BEGIN IMMEDIATE;');
    sessions.applySessionPlan(createSession);
    seed.exec('COMMIT;');
    const nextCatalog = sessions.readSessionCatalog({ workspaceId, eventId })!;
    const createSecondSession = planSessionMutation({
      catalog: nextCatalog,
      vocabulary: sessions.readSessionVocabulary({ workspaceId, eventId })!,
      planningInput: {
        action: 'create', scope: { workspaceId, eventId }, sessionId: secondSessionId,
        actorUserId: userId, occurredAt: now,
        expectedCatalogVersion: nextCatalog.version,
        expectedCatalogDigestSha256: nextCatalog.digestSha256,
        title: 'Second retained session', plannedDurationMinutes: 30,
        lifecycle: 'collecting', formatId, trackId,
        participants: [{
          personId: personA, role: 'panelist', publiclyVisible: true,
          source: { kind: 'submission', id: submissionB, version: 1 }
        }]
      }
    });
    seed.exec('BEGIN IMMEDIATE;');
    sessions.applySessionPlan(createSecondSession);
    seed.exec('COMMIT;');

    const engagementRepository = new SQLiteEngagementRepository(seed);
    for (const contribution of [
      planEngagementSeedFrom(engagementRepository, {
        scope: { workspaceId, eventId }, sessionId, submissionId: submissionA,
        seededByDecision: { version: 1, digestSha256: 'e'.repeat(64) },
        source: { kind: 'submission', id: submissionA, version: 1 },
        personIds: [personA, personB], invitedAt: now, respondBy: null
      }),
      planEngagementSeedFrom(engagementRepository, {
        scope: { workspaceId, eventId }, sessionId: secondSessionId, submissionId: submissionB,
        seededByDecision: { version: 1, digestSha256: 'f'.repeat(64) },
        source: { kind: 'submission', id: submissionB, version: 1 },
        personIds: [personA], invitedAt: now, respondBy: null
      })
    ]) {
      seed.exec('BEGIN IMMEDIATE;');
      applyEngagementSeedFrom(engagementRepository, contribution);
      seed.exec('COMMIT;');
    }
    expect(seed.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM sqlite_schema
       WHERE type = 'table' AND name = 'session_program_reference_slots'
    `).get()).toEqual({ count: 0 });
    seed.close();

    const upgraded = openSQLite(path, { migrationPolicy: 'apply' });
    opened.push(upgraded);
    expect(upgraded.migration).toMatchObject({
      status: 'applied',
      migrationId: 'e2_0011_signal_accolades',
      coordinate: { schemaEpoch: 2, sequence: 11 }
    });
    expect(upgraded.sqlite.query<{ slot_kind: string; item_id: string; version: number }, []>(`
      SELECT slot_kind,item_id,version FROM session_program_reference_slots
       WHERE workspace_id = '${workspaceId}' AND event_id = '${eventId}' AND session_id = '${sessionId}'
       ORDER BY slot_kind
    `).all()).toEqual([
      { slot_kind: 'format', item_id: formatId, version: 1 },
      { slot_kind: 'track', item_id: trackId, version: 1 }
    ]);
    expect(upgraded.sqlite.query<{
      person_id: string; position: number; category_id: string | null;
      publicly_visible: number; version: number;
    }, []>(`
      SELECT person_id,position,category_id,publicly_visible,version
        FROM speaker_lineup_entries
       WHERE workspace_id = '${workspaceId}' AND event_id = '${eventId}'
       ORDER BY position
    `).all()).toEqual([
      { person_id: personA, position: 0, category_id: null, publicly_visible: 1, version: 1 },
      { person_id: personB, position: 1, category_id: null, publicly_visible: 0, version: 1 }
    ]);
    expect(upgraded.sqlite.query<{ key: string; position: number }, []>(`
      SELECT key,position FROM signal_definition_heads
       WHERE workspace_id = '${workspaceId}' AND event_id = '${eventId}'
       ORDER BY position
    `).all()).toEqual([
      { key: 'accolade.top_pick', position: 0 },
      { key: 'accolade.hidden_gem', position: 1 },
      { key: 'accolade.crowd_draw', position: 2 },
      { key: 'accolade.bold_bet', position: 3 }
    ]);
    const registry = createProgramReferenceContributorRegistry({
      expected: [SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR],
      contributors: [SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR]
    });
    const adapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite: upgraded.sqlite,
      expected: [SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR],
      adapters: [createSQLiteSessionProgramReferenceAdapter({ sqlite: upgraded.sqlite })]
    });
    const upgradedVocabulary = new SQLiteProgramVocabularyRepository(
      upgraded.sqlite,
      registry,
      adapters,
      () => ({ actorUserId: userId, occurredAt: now })
    );
    expect(captureRegisteredProgramReferences({
      registry,
      scope: upgradedVocabulary.readVocabulary({ workspaceId, eventId })!.scope,
      source: upgradedVocabulary
    }).contributors[0]?.references).toHaveLength(4);
    expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
      .toEqual([]);
  });

  test('file creation requires a class and a replay remains one receipt', () => {
    const path = temporaryDatabasePath();
    expectFoundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'database_class_required');

    const first = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    const databaseId = first.migration.databaseId;
    expect(first.migration.status).toBe('applied');
    first.sqlite.close();

    const replay = openSQLite(path);
    opened.push(replay);
    expect(replay.migration).toMatchObject({ status: 'current', databaseClass: 'retained_development', databaseId });
    expect(replay.sqlite.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count)
      .toBe(SQLITE_MIGRATION_MANIFEST.migrations.length);
  });

  test('refuses the API-key prefix migration when sequence 3 already holds a key', () => {
    const path = temporaryDatabasePath();
    let schemaPass = 0;
    const held = new Database(path, { create: true, strict: true });
    held.exec('PRAGMA foreign_keys = ON;');
    expectFoundationError(() => migrateOrValidateSQLite({
      database: held,
      artifacts: loadSQLiteFoundationArtifacts(),
      policy: 'apply',
      databaseClass: 'retained_development',
      isMemory: false,
      fault(point) {
        if (point === 'after_schema_before_receipt' && (schemaPass += 1) === 4) {
          throw new Error('hold_before_e2_0004_receipt');
        }
      }
    }), 'migration_transaction_failed');
    held.close();

    const workspaceId = '01890f47-9abc-7def-8123-000000000101';
    const userId = '01890f47-9abc-7def-8123-000000000102';
    const apiKeyId = '01890f47-9abc-7def-8123-000000000103';
    const seed = new Database(path, { create: false, strict: true });
    seed.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    seed.query(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Prefix migration workspace','active',0,0,1)`).run(workspaceId);
    seed.query(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','Prefix migration owner',0,0,1)`).run(userId);
    seed.query(`INSERT INTO api_keys
      (api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
       may_read,may_submit_plans,created_at_ms,expires_at_ms,standing,version)
      VALUES (?,?,?,'Sequence 3 key',?,'joak1_AAAA',1,0,0,1,'active',1)`)
      .run(apiKeyId, workspaceId, userId, 'a'.repeat(64));
    seed.exec('COMMIT;');
    seed.close();

    const refusal = expectFoundationError(
      () => openSQLite(path, { migrationPolicy: 'apply' }),
      'migration_transaction_failed'
    );
    expect(refusal.details.cause).toBe(
      'e2_0004_api_key_prefix requires an empty api_keys table because issued hash-only credentials cannot be converted'
    );

    const preserved = new Database(path, { create: false, strict: true });
    expect(preserved.query<{ token_hint: string; version: number }, [string]>(
      'SELECT token_hint,version FROM api_keys WHERE api_key_id = ?'
    ).get(apiKeyId)).toEqual({ token_hint: 'joak1_AAAA', version: 1 });
    expect(preserved.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'api_keys'"
    ).get()?.sql).toContain('length(token_hint) = 10');
    expect(preserved.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'api_keys_next'"
    ).get()).toEqual({ count: 0 });
    expect(preserved.query<{ migration_id: string }, []>(
      'SELECT migration_id FROM schema_migrations ORDER BY schema_epoch,sequence'
    ).all().map((row) => row.migration_id)).toEqual(
      SQLITE_MIGRATION_MANIFEST.migrations.slice(0, 3).map((migration) => migration.migrationId)
    );
    expect(preserved.query('PRAGMA foreign_key_check').all()).toEqual([]);
    preserved.close();
  });

  test('preserves issued API keys and immutable scopes when expiry becomes nullable', () => {
    const path = temporaryDatabasePath();
    let schemaPass = 0;
    const held = new Database(path, { create: true, strict: true });
    held.exec('PRAGMA foreign_keys = ON;');
    expectFoundationError(() => migrateOrValidateSQLite({
      database: held,
      artifacts: loadSQLiteFoundationArtifacts(),
      policy: 'apply',
      databaseClass: 'retained_development',
      isMemory: false,
      fault(point) {
        if (point === 'after_schema_before_receipt' && (schemaPass += 1) === 5) {
          throw new Error('hold_before_e2_0005_receipt');
        }
      }
    }), 'migration_transaction_failed');
    held.close();

    const workspaceId = '01890f47-9abc-7def-8123-000000000201';
    const userId = '01890f47-9abc-7def-8123-000000000202';
    const apiKeyId = '01890f47-9abc-7def-8123-000000000203';
    const seed = new Database(path, { create: false, strict: true });
    seed.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    seed.query(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Never-expire migration workspace','active',0,0,1)`).run(workspaceId);
    seed.query(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','Never-expire migration owner',0,0,1)`).run(userId);
    seed.query(`INSERT INTO api_keys
      (api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
       may_read,may_submit_plans,created_at_ms,expires_at_ms,standing,version)
      VALUES (?,?,?,'Issued before nullable expiry',?,'jooak1_AAAA',1,0,0,86400000,'active',1)`)
      .run(apiKeyId, workspaceId, userId, 'a'.repeat(64));
    seed.query(`INSERT INTO api_key_permission_scopes(api_key_id,permission_id)
      VALUES (?,'event.read')`).run(apiKeyId);
    seed.exec('COMMIT;');
    seed.close();

    const migrated = openSQLite(path, { migrationPolicy: 'apply' });
    opened.push(migrated);
    expect(migrated.migration).toMatchObject({
      status: 'applied', migrationId: 'e2_0011_signal_accolades',
      coordinate: { schemaEpoch: 2, sequence: 11 }
    });
    expect(migrated.sqlite.query<{ readonly expires_at_ms: number | null }, [string]>(
      'SELECT expires_at_ms FROM api_keys WHERE api_key_id = ?'
    ).get(apiKeyId)).toEqual({ expires_at_ms: 86_400_000 });
    expect(migrated.sqlite.query<{ readonly permission_id: string }, [string]>(
      'SELECT permission_id FROM api_key_permission_scopes WHERE api_key_id = ?'
    ).get(apiKeyId)).toEqual({ permission_id: 'event.read' });
    expect(migrated.sqlite.query<{ readonly sql: string }, []>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'api_keys'"
    ).get()?.sql).toContain('expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms > created_at_ms)');
    expect(migrated.sqlite.query<{ readonly expires_at_ms: number | null }, []>(`
      INSERT INTO api_keys (
        api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
        may_read,may_submit_plans,created_at_ms,expires_at_ms,standing,version
      ) VALUES (
        '01890f47-9abc-7def-8123-000000000204',
        '${workspaceId}',
        '${userId}',
        'Never expires',
        '${'b'.repeat(64)}',
        'jooak1_BBBB',
        1,0,1,NULL,'active',1
      ) RETURNING expires_at_ms
    `).get()).toEqual({ expires_at_ms: null });
    expect(migrated.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('advances a retained baseline row to spam and the prepared inverse restores its exact schema', () => {
    const path = temporaryDatabasePath();
    let schemaPass = 0;
    const held = new Database(path, { create: true, strict: true });
    held.exec('PRAGMA foreign_keys = ON;');
    expectFoundationError(() => migrateOrValidateSQLite({
      database: held,
      artifacts: loadSQLiteFoundationArtifacts(),
      policy: 'apply',
      databaseClass: 'retained_development',
      isMemory: false,
      fault(point) {
        if (point === 'after_schema_before_receipt' && (schemaPass += 1) === 2) {
          throw new Error('hold_at_e2_0001');
        }
      }
    }), 'migration_transaction_failed');
    held.close();

    const workspaceId = '01890f47-9abc-7def-8123-000000000001';
    const eventId = '01890f47-9abc-7def-8123-000000000002';
    const userId = '01890f47-9abc-7def-8123-000000000003';
    const submissionId = '01890f47-9abc-7def-8123-000000000004';
    const arrivalId = '01890f47-9abc-7def-8123-000000000005';
    const formId = '01890f47-9abc-7def-8123-000000000006';
    const formVersionId = '01890f47-9abc-7def-8123-000000000007';
    const updatedAt = '2026-08-17T00:00:00.000Z';
    const oldHead = {
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      submissionId,
      version: 2,
      state: 'discarded_recoverable',
      setAsideAttribution: null,
      updatedAt
    };
    const seed = new Database(path, { create: false, strict: true });
    seed.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    seed.query(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Migration workspace','active',0,0,1)`).run(workspaceId);
    seed.query(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','Migration owner',0,0,1)`).run(userId);
    seed.query(`INSERT INTO event_spine_workspace_sets (workspace_id,version,current_event_id)
      VALUES (?,1,NULL)`).run(workspaceId);
    seed.query(`INSERT INTO event_spine_heads
      (workspace_id,id,name,timezone,start_date,end_date,version,created_by_user_id,created_at_ms,create_plan_digest_sha256)
      VALUES (?,?,'Migration event','UTC','2026-08-17','2026-08-17',1,?,0,?)`)
      .run(workspaceId, eventId, userId, '1'.repeat(64));
    seed.query('INSERT INTO event_spine_scope_roots (workspace_id,event_id) VALUES (?,?)')
      .run(workspaceId, eventId);
    seed.query(`INSERT INTO submission_triage_event_heads
      (workspace_id,event_id,query_version,query_digest_sha256) VALUES (?,?,2,?)`)
      .run(workspaceId, eventId, '2'.repeat(64));
    seed.query(`INSERT INTO submission_arrival_facts
      (workspace_id,event_id,submission_id,arrival_id,form_id,form_version_id,source,classification,
       submitted_at_ms,recorded_at_ms,fact_json,fact_digest_sha256)
      VALUES (?,?,?,?,?,?,'public_form','on_time',0,0,?,?)`).run(
        workspaceId, eventId, submissionId, arrivalId, formId, formVersionId,
        canonicalJsonText({ id: arrivalId, submissionId, classification: 'on_time' }), '3'.repeat(64)
      );
    seed.query(`INSERT INTO submission_triage_heads
      (workspace_id,event_id,submission_id,head_version,state,updated_at_ms,head_json,head_digest_sha256)
      VALUES (?,?,?,2,'discarded_recoverable',?,?,?)`).run(
        workspaceId, eventId, submissionId, Date.parse(updatedAt),
        canonicalJsonText(oldHead), canonicalJsonSha256(oldHead)
      );
    seed.exec('COMMIT;');
    seed.close();

    const migrated = openSQLite(path, { migrationPolicy: 'apply' });
    opened.push(migrated);
    const row = migrated.sqlite.query<{ state: string; head_json: string; head_digest_sha256: string }, []>(
      'SELECT state,head_json,head_digest_sha256 FROM submission_triage_heads'
    ).get()!;
    const newHead = { ...oldHead, state: 'spam' };
    expect(row).toEqual({
      state: 'spam',
      head_json: canonicalJsonText(newHead),
      head_digest_sha256: canonicalJsonSha256(newHead)
    });
    expect(migrated.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);

    migrated.sqlite.exec(`
      CREATE TEMP TABLE e2_0002_submission_triage_discarded_rows (
        workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,submission_id TEXT NOT NULL,
        head_json TEXT NOT NULL,head_digest_sha256 TEXT NOT NULL,
        PRIMARY KEY(workspace_id,event_id,submission_id)
      ) STRICT, WITHOUT ROWID;
    `);
    migrated.sqlite.query(`INSERT INTO temp.e2_0002_submission_triage_discarded_rows
      (workspace_id,event_id,submission_id,head_json,head_digest_sha256) VALUES (?,?,?,?,?)`).run(
        workspaceId, eventId, submissionId, canonicalJsonText(oldHead), canonicalJsonSha256(oldHead)
      );
    migrated.sqlite.exec('BEGIN IMMEDIATE;');
    migrated.sqlite.exec(readFileSync(new URL(
      '../../migrations/sqlite/rollback/e2_0002_submission_triage_spam.sql', import.meta.url
    ), 'utf8'));
    migrated.sqlite.exec('COMMIT;');
    expect(migrated.sqlite.query<{ state: string }, []>('SELECT state FROM submission_triage_heads').get())
      .toEqual({ state: 'discarded_recoverable' });
  });

  test('validate is non-creating and reports an exact predecessor as migration-required', () => {
    const missing = temporaryDatabasePath();
    expect(existsSync(missing)).toBe(false);
    expectFoundationError(() => openSQLite(missing, { migrationPolicy: 'validate' }), 'database_missing');
    expect(existsSync(missing)).toBe(false);

    const legacyPath = temporaryDatabasePath();
    const legacy = new Database(legacyPath, { create: true, strict: true });
    legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
    legacy.close();
    expectFoundationError(() => openSQLite(legacyPath), 'migration_required');
    expect(existsSync(`${legacyPath}-wal`)).toBe(false);
    expect(existsSync(`${legacyPath}-shm`)).toBe(false);
  });

  test('file classes are closed and checked against durable metadata', () => {
    const ephemeralPath = temporaryDatabasePath();
    expectFoundationError(
      () => openSQLite(ephemeralPath, { migrationPolicy: 'apply', databaseClass: 'ephemeral' }),
      'database_class_mismatch'
    );

    const frozenPath = temporaryDatabasePath();
    const frozen = openSQLite(frozenPath, { migrationPolicy: 'apply', databaseClass: 'frozen_release' });
    expect(frozen.migration.databaseClass).toBe('frozen_release');
    frozen.sqlite.close();
    expectFoundationError(
      () => openSQLite(frozenPath, { databaseClass: 'retained_development' }),
      'database_class_mismatch'
    );
  });

  test('adopts only the exact legacy shape and preserves every application row', () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec('PRAGMA foreign_keys = ON;');
    legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    legacy.query('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)')
      .run('auth_legacy', 'Legacy Owner', 'legacy@example.com', now, now);
    legacy.query('insert into workspaces (id, name, state, created_at, updated_at, version) values (?, ?, ?, ?, ?, 1)')
      .run('workspace_legacy', 'Legacy Workspace', 'active', now, now);
    legacy.query('insert into events (id, workspace_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)')
      .run('event_legacy', 'workspace_legacy', 'Legacy Event', now, now);
    const predecessorTables = legacy.query<{ name: string }, []>(`
      SELECT name FROM pragma_table_list
       WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name
    `).all().map((row) => row.name);
    const before = applicationRows(legacy, predecessorTables);
    legacy.close();

    const adopted = openSQLite(path, { migrationPolicy: 'apply' });
    opened.push(adopted);
    const terminal = SQLITE_MIGRATION_MANIFEST.migrations.at(-1)!;
    expect(adopted.migration).toMatchObject({
      status: 'applied',
      coordinate: { schemaEpoch: terminal.schemaEpoch, sequence: terminal.sequence },
      databaseClass: 'retained_development'
    });
    expect(adopted.sqlite.query<{ receipt_kind: string }, []>(
      'SELECT receipt_kind FROM schema_migrations ORDER BY schema_epoch,sequence'
    ).all().map((row) => row.receipt_kind)).toEqual([
      'legacy_adoption', 'epoch_bridge',
      ...SQLITE_MIGRATION_MANIFEST.migrations.slice(1).map(() => 'executed')
    ]);
    expect(applicationRows(adopted.sqlite, predecessorTables)).toBe(before);
  });

  test('a partial legacy schema refuses without inventing runner receipts', () => {
    const path = temporaryDatabasePath();
    const partial = new Database(path, { create: true, strict: true });
    partial.exec('CREATE TABLE auth_users (id TEXT PRIMARY KEY);');
    partial.close();

    const error = expectFoundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'schema_drift');
    expect(Array.isArray(error.details.differences)).toBe(true);
    const inspection = new Database(path, { readonly: true, create: false, strict: true });
    expect(inspection.query<{ count: number }, []>(
      "select count(*) as count from sqlite_schema where name = 'schema_migrations'"
    ).get()?.count).toBe(0);
    inspection.close();
  });

  test('a partial runner schema is a runner refusal, not legacy adoption', () => {
    const path = temporaryDatabasePath();
    const partial = new Database(path, { create: true, strict: true });
    partial.exec('CREATE TABLE schema_migrations (migration_id TEXT PRIMARY KEY);');
    partial.close();
    expectFoundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'runner_schema_malformed');
  });

  test('matching receipts cannot conceal live schema drift', () => {
    const path = temporaryDatabasePath();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    const drifted = new Database(path, { create: false, strict: true });
    drifted.exec('CREATE TABLE unexpected_state (id TEXT PRIMARY KEY);');
    drifted.close();

    const error = expectFoundationError(() => openSQLite(path), 'schema_drift');
    expect(error.details.actualFingerprint).not.toBe(error.details.expectedFingerprint);
  });

  test('an unknown but physically valid receipt makes the chain malformed', () => {
    const path = temporaryDatabasePath();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.query(`
      insert into schema_migrations
        (migration_id, schema_epoch, sequence, dialect, checksum_sha256, receipt_kind,
         source_fingerprint, result_fingerprint, transition_id, runner_version,
         build_identity, applied_at, duration_ms)
      values ('unknown_e1_0002', 1, 2, 'sqlite', ?, 'executed', ?, ?, null, 1, 'test', 0, 0)
    `).run(
      '0'.repeat(64),
      SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint,
      SQLITE_MIGRATION_MANIFEST.expectedCurrentFullFingerprint
    );
    created.sqlite.close();

    expectFoundationError(() => openSQLite(path), 'receipt_chain_malformed');
  });

  test('migration receipts are append-only at the database boundary', () => {
    const database = openSQLite(':memory:');
    opened.push(database);
    expect(() => database.sqlite.exec("update schema_migrations set build_identity = 'changed';")).toThrow('append-only');
    expect(() => database.sqlite.exec('delete from schema_migrations;')).toThrow('append-only');
    expect(() => database.sqlite.exec("update database_instance_metadata set database_id = '00000000000000000000000000000000';"))
      .toThrow('identity is immutable');
    expect(() => database.sqlite.exec('delete from database_instance_metadata;')).toThrow('identity is durable');
  });

  test('the compatibility boolean maps to the explicit none policy', () => {
    const database = openSQLite(':memory:', { migrate: false });
    opened.push(database);
    expect(database.migration.status).toBe('skipped');
    expect(database.sqlite.query<{ count: number }, []>(
      "select count(*) as count from sqlite_schema where type = 'table' and name not like 'sqlite_%'"
    ).get()?.count).toBe(0);
  });
});
