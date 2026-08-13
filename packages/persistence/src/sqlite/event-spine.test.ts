import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  eventCreatePlanDigest,
  eventCreateResult,
  planEventCreation,
  type EventCreatePlan
} from '@jooevents/event';
import {
  canonicalJsonText,
  parseAggregateVersion,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { installFoundationTrialUnitOfWorkSchema } from './foundation-trial-uow';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema,
  SQLiteEventSpineError,
  SQLiteEventSpineRepository
} from './event-spine';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const otherWorkspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa111');
const otherEventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa112');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa211');
const version1 = parseAggregateVersion(1);
const version2 = parseAggregateVersion(2);
const createdAt = '2026-08-12T08:30:00.000Z';
const evaluatedAt = parseInstant(createdAt);
const receiptId = '019c1df7-86b5-769b-bba4-5f7097bfa311';
const createOperation = Object.freeze({ name: 'event.create', version: 1 });

function openDatabase(): Database {
  const sqlite = new Database(':memory:', { strict: true });
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
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(otherWorkspaceId, 'Other workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Event owner', 1, 1, 1);
  return sqlite;
}

function bootstrap(sqlite: Database, workspace = workspaceId): SQLiteEventSpineRepository {
  const repository = new SQLiteEventSpineRepository(sqlite);
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    repository.bootstrapWorkspaceEventSet(workspace);
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
  return repository;
}

function plan(repository: SQLiteEventSpineRepository, id = eventId): EventCreatePlan {
  return planEventCreation({
    eventSet: repository.requireEventSet(workspaceId),
    authorInput: {
      expectedEventSetVersion: 1,
      name: '  JooEvents  Summit  ',
      timezone: 'Asia/Singapore',
      startDate: '2026-11-04',
      endDate: '2026-11-06'
    },
    server: {
      workspaceId,
      eventId: id,
      createdByUserId: userId,
      createdAt
    }
  });
}

function insertReceiptParent(
  sqlite: Database,
  sourcePlan: EventCreatePlan,
  id = receiptId
): void {
  const resultJson = JSON.stringify({
    kind: 'success',
    data: eventCreateResult(sourcePlan),
    receipt: { id, operationName: 'event.create', operationVersion: 1 },
    correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa312'
  });
  sqlite.query(`
    INSERT INTO foundation_trial_operation_receipts (
      id, scope_partition_key, authority_principal_key, operation_name,
      operation_version, surface, idempotency_verifier_profile_key,
      idempotency_verifier_profile_version, idempotency_key_verifier,
      request_hash, result_json
    ) VALUES (?, ?, ?, ?, 1, 'operator_http', ?, 1, ?, ?, ?)
  `).run(
    id,
    'a'.repeat(64),
    'event-test-principal',
    'event.create',
    'event-test.idempotency',
    'b'.repeat(64),
    'c'.repeat(64),
    resultJson
  );
}

describe('ephemeral SQLite Event spine', () => {
  test('bootstraps an idempotent no-event set only inside a caller transaction', () => {
    const sqlite = openDatabase();
    const repository = new SQLiteEventSpineRepository(sqlite);
    try {
      expect(() => repository.bootstrapWorkspaceEventSet(workspaceId))
        .toThrow('transaction_required');

      sqlite.exec('BEGIN IMMEDIATE;');
      const first = repository.bootstrapWorkspaceEventSet(workspaceId);
      const repeated = repository.bootstrapWorkspaceEventSet(workspaceId);
      sqlite.exec('COMMIT;');

      expect(first).toEqual({ workspaceId, version: version1, currentEventId: null });
      expect(repeated).toEqual(first);
      expect(repository.readCurrentEventProjection(workspaceId)).toEqual({
        schemaVersion: 1,
        kind: 'no_event',
        eventSetVersion: 1
      });

      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => repository.bootstrapWorkspaceEventSet(
        '550e8400-e29b-41d4-a716-446655440099'
      )).toThrow('FOREIGN KEY constraint failed');
      sqlite.exec('ROLLBACK;');
    } finally {
      sqlite.close();
    }
  });

  test('applies one exact create plan and reads a deterministic current-event projection', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      const creation = plan(repository);
      expect(() => repository.commitEventCreatePlan(creation)).toThrow('transaction_required');

      sqlite.exec('BEGIN IMMEDIATE;');
      const applied = repository.commitEventCreatePlan(creation);
      sqlite.exec('COMMIT;');

      expect(applied.eventSet).toEqual({
        workspaceId,
        version: version2,
        currentEventId: eventId
      });
      expect(repository.readEventHead({ workspaceId, eventId })).toEqual(creation.after);
      expect(repository.readCurrentEventProjection(workspaceId)).toEqual({
        schemaVersion: 1,
        kind: 'current_event',
        eventSetVersion: 2,
        event: {
          id: eventId,
          name: 'JooEvents Summit',
          timezone: 'Asia/Singapore',
          startDate: '2026-11-04',
          endDate: '2026-11-06',
          version: version1
        }
      });
      expect(repository.readEventHead({ workspaceId: otherWorkspaceId, eventId })).toBeUndefined();
      expect(repository.readEventSet('550e8400-e29b-41d4-a716-446655440099')).toBeUndefined();

      expect(() => sqlite.query('DELETE FROM event_spine_scope_roots WHERE event_id = ?')
        .run(eventId)).toThrow('event scope root links are immutable');
      expect(() => sqlite.query(`
        UPDATE event_spine_scope_roots
           SET workspace_id = workspace_id
         WHERE event_id = ?
      `).run(eventId)).toThrow('event scope root links are immutable');
    } finally {
      sqlite.close();
    }
  });

  test('fails a stale create before a second head is stored and rolls back partial work', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      const first = plan(repository);
      const competing = plan(repository, otherEventId);
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(first);
      expect(() => repository.commitEventCreatePlan(competing)).toThrow('stale_event_set');
      sqlite.exec('COMMIT;');

      expect(repository.readEventHead({ workspaceId, eventId })).toEqual(first.after);
      expect(repository.readEventHead({ workspaceId, eventId: otherEventId })).toBeUndefined();

      const rollbackDatabase = openDatabase();
      try {
        const rollbackRepository = bootstrap(rollbackDatabase);
        const rollbackPlan = plan(rollbackRepository);
        rollbackDatabase.exec('BEGIN IMMEDIATE;');
        rollbackRepository.commitEventCreatePlan(rollbackPlan);
        rollbackDatabase.exec('ROLLBACK;');
        expect(rollbackRepository.requireEventSet(workspaceId)).toEqual({
          workspaceId,
          version: version1,
          currentEventId: null
        });
        expect(rollbackRepository.readEventHead({ workspaceId, eventId })).toBeUndefined();
        expect(rollbackDatabase.query<{ readonly count: number }, []>(
          'SELECT count(*) AS count FROM event_spine_scope_roots'
        ).get()?.count).toBe(0);
      } finally {
        rollbackDatabase.close();
      }
    } finally {
      sqlite.close();
    }
  });

  test('refuses a noncanonical runtime plan before storing an Event head', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      const sourcePlan = plan(repository);
      const noncanonicalPlan = {
        ...sourcePlan,
        after: { ...sourcePlan.after, name: 'JooEvents  Summit' }
      } as EventCreatePlan;
      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => repository.commitEventCreatePlan(noncanonicalPlan))
        .toThrow('event_head_data_corrupt');
      sqlite.exec('COMMIT;');
      expect(repository.requireEventSet(workspaceId)).toEqual({
        workspaceId,
        version: version1,
        currentEventId: null
      });
      expect(repository.readEventHead({ workspaceId, eventId })).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test('enforces cross-workspace selection and creator attribution with foreign keys', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      bootstrap(sqlite, otherWorkspaceId);
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(plan(repository));
      expect(() => sqlite.query(`
        UPDATE event_spine_workspace_sets
           SET current_event_id = ?
         WHERE workspace_id = ?
      `).run(eventId, otherWorkspaceId)).toThrow('FOREIGN KEY constraint failed');
      sqlite.exec('ROLLBACK;');

      sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => sqlite.query(`
        INSERT INTO event_spine_heads (
          workspace_id, id, name, timezone, start_date, end_date,
          version, created_by_user_id, created_at_ms, create_plan_digest_sha256
        ) VALUES (?, ?, 'Invalid owner', 'UTC', '2026-11-04', '2026-11-05', 1, ?, ?, ?)
      `).run(
        workspaceId,
        otherEventId,
        '019c1df7-86b5-769b-bba4-5f7097bfa299',
        Date.parse(createdAt),
        'a'.repeat(64)
      ))
        .toThrow('FOREIGN KEY constraint failed');
      sqlite.exec('ROLLBACK;');
    } finally {
      sqlite.close();
    }
  });

  test('fails closed when stored head or current selection data is corrupt or missing', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      sqlite.query(`
        INSERT INTO event_spine_heads (
          workspace_id, id, name, timezone, start_date, end_date,
          version, created_by_user_id, created_at_ms, create_plan_digest_sha256
        ) VALUES (?, ?, 'Corrupt timezone', 'Mars/Olympus', '2026-11-04', '2026-11-05', 1, ?, ?, ?)
      `).run(workspaceId, eventId, userId, Date.parse(createdAt), 'a'.repeat(64));
      sqlite.query(`
        INSERT INTO event_spine_scope_roots (workspace_id, event_id)
        VALUES (?, ?)
      `).run(workspaceId, eventId);
      expect(() => repository.readEventHead({ workspaceId, eventId }))
        .toThrow('event_head_data_corrupt');

      sqlite.exec('PRAGMA foreign_keys = OFF;');
      sqlite.query(`
        UPDATE event_spine_workspace_sets
           SET version = 2, current_event_id = ?
         WHERE workspace_id = ?
      `).run(otherEventId, workspaceId);
      sqlite.exec('PRAGMA foreign_keys = ON;');
      expect(() => repository.readCurrentEventState(workspaceId)).toThrow('current_event_missing');

      sqlite.exec('PRAGMA foreign_keys = OFF;');
      sqlite.query(`
        UPDATE event_spine_workspace_sets
           SET current_event_id = ?
         WHERE workspace_id = ?
      `).run(eventId.toUpperCase(), workspaceId);
      sqlite.exec('PRAGMA foreign_keys = ON;');
      expect(() => repository.readEventSet(workspaceId)).toThrow('event_set_data_corrupt');
    } finally {
      sqlite.close();
    }
  });

  test('validates authority relationships from the caller transaction handle only', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    const source = createSQLiteEventSpineOperatorEventRelationshipSource();
    try {
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(plan(repository));
      const valid = source.validateEvent({
        sqlite,
        workspaceId,
        eventId,
        userId,
        evaluatedAt
      });
      const missing = source.validateEvent({
        sqlite,
        workspaceId,
        eventId: otherEventId,
        userId,
        evaluatedAt
      });
      sqlite.exec('ROLLBACK;');

      expect(valid).toEqual({
        kind: 'valid',
        evidenceIds: [
          `event-spine-root:${eventId}@1`,
          `event-spine-set:${workspaceId}`
        ]
      });
      expect(missing).toEqual({ kind: 'denied', reason: 'missing' });
      expect(source.validateEvent({
        sqlite,
        workspaceId,
        eventId,
        userId,
        evaluatedAt
      })).toEqual({ kind: 'denied', reason: 'missing' });

      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(plan(repository));
      sqlite.exec('COMMIT;');
      expect(source.validateEvent({
        sqlite,
        workspaceId,
        eventId,
        userId,
        evaluatedAt
      })).toEqual({
        kind: 'valid',
        evidenceIds: [
          `event-spine-root:${eventId}@1`,
          `event-spine-set:${workspaceId}`
        ]
      });
    } finally {
      sqlite.close();
    }
  });

  test('retains and reconstructs the complete immutable source create plan', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      const sourcePlan = plan(repository);
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(sourcePlan);
      insertReceiptParent(sqlite, sourcePlan);
      repository.linkEventCreateReceipt({ receiptId, plan: sourcePlan, operation: createOperation });
      sqlite.exec('COMMIT;');

      expect(repository.readEventCreatePlan(receiptId)).toEqual(sourcePlan);
      expect(() => sqlite.query(`
        UPDATE event_spine_create_plans SET plan_digest_sha256 = ? WHERE receipt_id = ?
      `).run('f'.repeat(64), receiptId)).toThrow('event create plans are immutable');
      expect(() => sqlite.query(`
        DELETE FROM event_spine_create_plans WHERE receipt_id = ?
      `).run(receiptId)).toThrow('event create plans are immutable');
    } finally {
      sqlite.close();
    }

    const corruptDatabase = openDatabase();
    const corruptRepository = bootstrap(corruptDatabase);
    try {
      const sourcePlan = plan(corruptRepository);
      corruptDatabase.exec('BEGIN IMMEDIATE;');
      corruptRepository.commitEventCreatePlan(sourcePlan);
      insertReceiptParent(corruptDatabase, sourcePlan);
      corruptDatabase.query(`
        INSERT INTO event_spine_create_links (receipt_id, workspace_id, event_id)
        VALUES (?, ?, ?)
      `).run(receiptId, workspaceId, eventId);
      corruptDatabase.query(`
        INSERT INTO event_spine_create_plans (
          receipt_id, workspace_id, event_id, plan_digest_sha256, plan_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        receiptId,
        workspaceId,
        eventId,
        eventCreatePlanDigest(sourcePlan),
        ` ${canonicalJsonText(sourcePlan)}`
      );
      corruptDatabase.exec('COMMIT;');
      expect(() => corruptRepository.readEventCreatePlan(receiptId))
        .toThrow('source_plan_corrupt');
    } finally {
      corruptDatabase.close();
    }
  });

  test('rejects receipt evidence whose coherent source plan differs from the applied head', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      const appliedPlan = plan(repository);
      const differentPlan = planEventCreation({
        eventSet: repository.requireEventSet(workspaceId),
        authorInput: {
          expectedEventSetVersion: 1,
          name: 'Different evidence',
          timezone: 'Asia/Singapore',
          startDate: '2026-11-04',
          endDate: '2026-11-06'
        },
        server: {
          workspaceId,
          eventId,
          createdByUserId: userId,
          createdAt
        }
      });
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(appliedPlan);
      insertReceiptParent(sqlite, differentPlan);
      expect(() => repository.linkEventCreateReceipt({
        receiptId,
        plan: differentPlan,
        operation: createOperation
      }))
        .toThrow('source_plan_corrupt');
      sqlite.exec('ROLLBACK;');
      expect(sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM event_spine_create_plans'
      ).get()?.count).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('rejects a matching Event result owned by another operation identity', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      const sourcePlan = plan(repository);
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(sourcePlan);
      insertReceiptParent(sqlite, sourcePlan);
      expect(() => repository.linkEventCreateReceipt({
        receiptId,
        plan: sourcePlan,
        operation: { name: 'another.event.create', version: 1 }
      })).toThrow('source_plan_corrupt');
      sqlite.exec('ROLLBACK;');
    } finally {
      sqlite.close();
    }
  });

  test('rejects a timeline whose fact belongs to another workspace/event', () => {
    const sqlite = openDatabase();
    const repository = bootstrap(sqlite);
    try {
      bootstrap(sqlite, otherWorkspaceId);
      const primaryPlan = plan(repository);
      const otherPlan = planEventCreation({
        eventSet: repository.requireEventSet(otherWorkspaceId),
        authorInput: {
          expectedEventSetVersion: 1,
          name: 'Other event',
          timezone: 'UTC',
          startDate: '2026-11-04',
          endDate: '2026-11-06'
        },
        server: {
          workspaceId: otherWorkspaceId,
          eventId: otherEventId,
          createdByUserId: userId,
          createdAt
        }
      });
      sqlite.exec('BEGIN IMMEDIATE;');
      repository.commitEventCreatePlan(primaryPlan);
      const otherRepository = new SQLiteEventSpineRepository(sqlite);
      otherRepository.commitEventCreatePlan(otherPlan);
      insertReceiptParent(sqlite, primaryPlan);
      repository.linkEventCreateReceipt({
        receiptId,
        plan: primaryPlan,
        operation: createOperation
      });
      const factId = '019c1df7-86b5-769b-bba4-5f7097bfa411';
      sqlite.query(`
        INSERT INTO event_spine_domain_facts (
          fact_id, receipt_id, workspace_id, event_id,
          fact_kind, fact_version, payload_json
        ) VALUES (?, ?, ?, ?, 'event_created', 1, '{}')
      `).run(factId, receiptId, workspaceId, eventId);
      expect(() => sqlite.query(`
        INSERT INTO event_spine_timeline_projection (
          timeline_id, receipt_id, fact_id, workspace_id,
          event_id, occurred_at_ms, source_kind
        ) VALUES (?, ?, ?, ?, ?, ?, 'domain_fact')
      `).run(
        '019c1df7-86b5-769b-bba4-5f7097bfa511',
        receiptId,
        factId,
        otherWorkspaceId,
        otherEventId,
        Date.parse(createdAt)
      )).toThrow('FOREIGN KEY constraint failed');
      sqlite.exec('ROLLBACK;');
    } finally {
      sqlite.close();
    }
  });

  test('uses bounded primary-key lookups for set and head queries', () => {
    const sqlite = openDatabase();
    try {
      const setPlan = sqlite.query<{ readonly detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT workspace_id, version, current_event_id
          FROM event_spine_workspace_sets
         WHERE workspace_id = ?
         ORDER BY workspace_id
         LIMIT 2
      `).all(workspaceId).map((row) => row.detail).join(' ');
      const headPlan = sqlite.query<{ readonly detail: string }, [string, string]>(`
        EXPLAIN QUERY PLAN
        SELECT workspace_id, id
          FROM event_spine_heads
         WHERE workspace_id = ? AND id = ?
         ORDER BY workspace_id, id
         LIMIT 2
      `).all(workspaceId, eventId).map((row) => row.detail).join(' ');
      expect(setPlan).toContain('PRIMARY KEY');
      expect(headPlan).toContain('SEARCH event_spine_heads USING INDEX');
    } finally {
      sqlite.close();
    }
  });
});
