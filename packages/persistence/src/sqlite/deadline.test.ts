import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { planEventCreation } from '@jooevents/event';
import {
  DeadlinePlanningError,
  planDeadlineMutation,
  type FormCloseDeadlineContribution
} from '@jooevents/deadline';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import { installDeadlineSchema, SQLiteDeadlineRepository } from './deadline';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfa111';
const otherEventId = '019c1df7-86b5-769b-bba4-5f7097bfa112';
const deadlineId = '019c1df7-86b5-769b-bba4-5f7097bfa311';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa211';
const scope = { workspaceId, eventId } as const;

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
    INSERT INTO users VALUES ('${userId}', 'active', 'Owner', 1, 1, 1);
  `);
  installEventSpineSchema(sqlite);
  installDeadlineSchema(sqlite);
  const spine = new SQLiteEventSpineRepository(sqlite);
  transaction(sqlite, () => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Deadline Test',
        timezone: 'America/New_York',
        startDate: '2027-04-16',
        endDate: '2027-04-18'
      },
      server: {
        workspaceId, eventId, createdByUserId: userId,
        createdAt: '2026-08-13T01:00:00.000Z'
      }
    }));
  });
  return { sqlite, spine, deadlines: new SQLiteDeadlineRepository(sqlite, spine) };
}

function createContribution(
  repository: SQLiteDeadlineRepository,
  displayDate = '2026-11-01'
): FormCloseDeadlineContribution {
  return repository.planFormCloseDeadlineChange({
    scope,
    currentDeadlineId: null,
    closesAt: displayDate,
    identity: { deadlineId },
    attribution: { userId, at: '2026-08-13T02:00:00.000Z' }
  });
}

describe('trial SQLite canonical Deadline repository', () => {
  test('creates through the Form contribution, reads exact pin, and rejects replay identity reuse', () => {
    const h = setup();
    try {
      expect(h.deadlines.readDeadlineCatalog(scope)).toMatchObject({ version: 1, deadlines: [] });
      const contribution = createContribution(h.deadlines);
      expect(contribution.after).toMatchObject({
        status: 'active', version: 1, displayDate: '2026-11-01',
        effectiveAt: '2026-11-02T05:00:00.000Z'
      });
      const applied = transaction(h.sqlite, () => h.deadlines.applyFormCloseDeadline(contribution));
      expect(applied.pin).toMatchObject({ id: deadlineId, version: 1, displayDate: '2026-11-01' });
      expect(applied.facts).toEqual([{
        kind: 'deadline_changed', version: 1,
        payload: {
          action: 'create', deadlineId, version: 1, status: 'active',
          displayDate: '2026-11-01', effectiveAt: '2026-11-02T05:00:00.000Z'
        }
      }]);
      if (applied.pin === null) throw new TypeError('created_deadline_pin_missing');
      expect(h.deadlines.resolveCurrentDeadline(scope, { deadlineId })).toEqual(applied.pin);
      expect(h.deadlines.resolveCurrentDeadline(
        { workspaceId, eventId: otherEventId }, { deadlineId }
      )).toBeUndefined();
      expect(() => transaction(h.sqlite, () => h.deadlines.applyDeadlinePlan(contribution)))
        .toThrow('stale_catalog');
      expect(() => createContribution(h.deadlines)).toThrow('deadline_exists');
    } finally {
      h.sqlite.close();
    }
  });

  test('retains cleared identity, makes current resolution unavailable, and refuses no-op/recreate', () => {
    const h = setup();
    try {
      transaction(h.sqlite, () => h.deadlines.applyFormCloseDeadline(createContribution(h.deadlines)));
      expect(() => h.deadlines.planFormCloseDeadlineChange({
        scope, currentDeadlineId: deadlineId, closesAt: '2026-11-01',
        attribution: { userId, at: '2026-08-13T02:01:00.000Z' }
      })).toThrow('deadline_unchanged');
      const clear = h.deadlines.planFormCloseDeadlineChange({
        scope, currentDeadlineId: deadlineId, closesAt: null,
        attribution: { userId, at: '2026-08-13T02:02:00.000Z' }
      });
      transaction(h.sqlite, () => h.deadlines.applyFormCloseDeadline(clear));
      expect(h.deadlines.readDeadline(scope, deadlineId)).toMatchObject({
        id: deadlineId, status: 'cleared', version: 2
      });
      expect(h.deadlines.resolveCurrentDeadline(scope, { deadlineId })).toBeUndefined();
      expect(() => createContribution(h.deadlines)).toThrow('deadline_exists');
      expect(() => h.sqlite.run(`DELETE FROM deadlines WHERE id = ?`, [deadlineId]))
        .toThrow('deadline identity is retained');
    } finally {
      h.sqlite.close();
    }
  });

  test('rolls back a Deadline write when a later Form participant fails', () => {
    const h = setup();
    try {
      transaction(h.sqlite, () => h.deadlines.applyDeadlinePlan(createContribution(h.deadlines)));
      const clear = h.deadlines.planFormCloseDeadlineChange({
        scope, currentDeadlineId: deadlineId, closesAt: null,
        attribution: { userId, at: '2026-08-13T02:03:00.000Z' }
      });
      expect(() => transaction(h.sqlite, () => {
        h.deadlines.applyFormCloseDeadline(clear);
        throw new Error('injected later Form failure');
      })).toThrow('injected later Form failure');
      expect(h.deadlines.readDeadline(scope, deadlineId)).toMatchObject({
        status: 'active', version: 1
      });
    } finally {
      h.sqlite.close();
    }
  });

  test('rolls back a head update when its catalog CAS fails late', () => {
    const h = setup();
    try {
      transaction(h.sqlite, () => h.deadlines.applyDeadlinePlan(createContribution(h.deadlines)));
      const update = h.deadlines.planFormCloseDeadlineChange({
        scope, currentDeadlineId: deadlineId, closesAt: '2026-11-02',
        attribution: { userId, at: '2026-08-13T02:04:00.000Z' }
      });
      h.sqlite.exec(`
        CREATE TRIGGER inject_deadline_catalog_failure
        BEFORE UPDATE ON deadline_catalogs
        BEGIN SELECT RAISE(ABORT, 'injected catalog failure'); END;
      `);
      expect(() => transaction(h.sqlite, () => h.deadlines.applyDeadlinePlan(update)))
        .toThrow('injected catalog failure');
      expect(h.deadlines.readDeadline(scope, deadlineId)).toMatchObject({
        version: 1, displayDate: '2026-11-01'
      });
    } finally {
      h.sqlite.close();
    }
  });

  test('freezes Event version/timezone and refuses a planned update after drift', () => {
    const h = setup();
    try {
      transaction(h.sqlite, () => h.deadlines.applyDeadlinePlan(createContribution(h.deadlines)));
      const update = h.deadlines.planFormCloseDeadlineChange({
        scope, currentDeadlineId: deadlineId, closesAt: '2026-11-02',
        attribution: { userId, at: '2026-08-13T02:05:00.000Z' }
      });
      h.sqlite.run(`
        UPDATE event_spine_heads SET timezone = 'Asia/Singapore', version = version + 1
         WHERE workspace_id = ? AND id = ?
      `, [workspaceId, eventId]);
      expect(h.deadlines.validateFormCloseDeadline(update)).toEqual({
        kind: 'refused', code: 'event_time_changed'
      });
      expect(() => transaction(h.sqlite, () => h.deadlines.applyDeadlinePlan(update)))
        .toThrow(new DeadlinePlanningError('event_time_changed'));
    } finally {
      h.sqlite.close();
    }
  });
});

function transaction<Value>(sqlite: Database, run: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const value = run();
    sqlite.exec('COMMIT;');
    return value;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}
