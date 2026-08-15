import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { planEventCreation } from '@jooevents/event';
import {
  deriveTaskAssignmentRestore,
  planTaskMutation,
  validateTaskMutation
} from '@jooevents/tasks';
import { installDeadlineSchema, SQLiteDeadlineRepository } from './deadline';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import { installTaskSchema, SQLiteTaskRepository } from './tasks';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfba01';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfba02';
const taskDefinitionId = '019c1df7-86b5-769b-bba4-5f7097bfba03';
const revisionId = '019c1df7-86b5-769b-bba4-5f7097bfba04';
const deadlineId = '019c1df7-86b5-769b-bba4-5f7097bfba05';
const engagementA = '019c1df7-86b5-769b-bba4-5f7097bfba06';
const engagementB = '019c1df7-86b5-769b-bba4-5f7097bfba07';
const engagementC = '019c1df7-86b5-769b-bba4-5f7097bfba08';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfba09';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfba0a';
const personC = '019c1df7-86b5-769b-bba4-5f7097bfba0b';
const scope = { workspaceId, eventId } as const;
const occurredAt = '2026-08-15T09:00:00.000Z';

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
    INSERT INTO users VALUES ('${userId}', 'active', 'Organizer', 1, 1, 1);
  `);
  installEventSpineSchema(sqlite);
  const spine = new SQLiteEventSpineRepository(sqlite);
  transaction(sqlite, () => {
    spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet: spine.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Task Test',
        timezone: 'Asia/Singapore',
        startDate: '2027-03-03',
        endDate: '2027-03-05'
      },
      server: { workspaceId, eventId, createdByUserId: userId, createdAt: occurredAt }
    }));
  });
  installDeadlineSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE engagement_heads (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('invited','confirmed','declined','cancelled')),
      version INTEGER NOT NULL CHECK(version > 0),
      PRIMARY KEY(workspace_id,event_id,id),
      FOREIGN KEY(workspace_id,event_id)
        REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO engagement_heads VALUES
      ('${workspaceId}','${eventId}','${engagementA}','${personA}','confirmed',2),
      ('${workspaceId}','${eventId}','${engagementB}','${personB}','confirmed',3),
      ('${workspaceId}','${eventId}','${engagementC}','${personC}','invited',1);
  `);
  installTaskSchema(sqlite);
  return {
    sqlite,
    deadlines: new SQLiteDeadlineRepository(sqlite, spine),
    tasks: new SQLiteTaskRepository(sqlite)
  };
}

function createPlan(fixture: ReturnType<typeof setup>) {
  return planTaskMutation({
    action: 'create_definition',
    scope,
    taskDefinitionId,
    revisionId,
    deadlineId,
    name: 'Upload your headshot',
    description: 'Send the image used on the public speaker page.',
    completionMode: 'file_upload',
    required: true,
    dueOn: '2027-02-20',
    actorUserId: userId,
    occurredAt
  }, {
    tasks: fixture.tasks,
    memberships: fixture.tasks,
    deadlines: fixture.deadlines
  });
}

describe('ephemeral SQLite canonical Tasks repository', () => {
  test('atomically creates one task_due definition and materializes exactly confirmed speakers', () => {
    const fixture = setup();
    try {
      const plan = createPlan(fixture);
      expect(plan.action).toBe('create_definition');
      if (plan.action !== 'create_definition') throw new TypeError('wrong_plan');
      expect(plan.engagementEvidence.map((entry) => entry.engagementId))
        .toEqual([engagementA, engagementB]);
      expect(plan.assignments).toHaveLength(2);
      expect(plan.definition.current.deadline).toMatchObject({
        kind: 'task_due',
        reference: { id: deadlineId, displayDate: '2027-02-20' }
      });

      transaction(fixture.sqlite, () => {
        fixture.deadlines.applyTaskDueDeadline(plan.deadlineContribution);
        fixture.tasks.applyTaskPlan(plan);
      });
      expect(fixture.tasks.readTaskBoard(scope)).toMatchObject({
        catalogVersion: 2,
        definitions: [{ current: { name: 'Upload your headshot' } }],
        assignments: [
          { engagementId: engagementA, state: 'pending' },
          { engagementId: engagementB, state: 'pending' }
        ]
      });
      expect(fixture.deadlines.readDeadline(scope, deadlineId)).toMatchObject({
        kind: 'task_due', status: 'active', displayDate: '2027-02-20'
      });
      expect(fixture.sqlite.query('SELECT count(*) AS count FROM task_events').get())
        .toEqual({ count: 2 });
    } finally {
      fixture.sqlite.close();
    }
  });

  test('rolls the Deadline back when the later Task write fails', () => {
    const fixture = setup();
    try {
      const plan = createPlan(fixture);
      if (plan.action !== 'create_definition') throw new TypeError('wrong_plan');
      fixture.sqlite.exec(`
        CREATE TRIGGER inject_task_failure BEFORE INSERT ON task_definition_heads
        BEGIN SELECT RAISE(ABORT, 'injected task failure'); END;
      `);
      expect(() => transaction(fixture.sqlite, () => {
        fixture.deadlines.applyTaskDueDeadline(plan.deadlineContribution);
        fixture.tasks.applyTaskPlan(plan);
      })).toThrow('definition_conflict');
      expect(fixture.deadlines.readDeadline(scope, deadlineId)).toBeUndefined();
      expect(fixture.tasks.readTaskCatalog(scope)).toMatchObject({ version: 1, definitions: [] });
    } finally {
      fixture.sqlite.close();
    }
  });

  test('detects confirmed-membership drift before commit', () => {
    const fixture = setup();
    try {
      const plan = createPlan(fixture);
      fixture.sqlite.query(`
        UPDATE engagement_heads SET state='confirmed',version=2
         WHERE workspace_id=? AND event_id=? AND id=?
      `).run(workspaceId, eventId, engagementC);
      expect(validateTaskMutation(plan, {
        tasks: fixture.tasks,
        memberships: fixture.tasks,
        deadlines: fixture.deadlines
      })).toBe('membership_changed');
    } finally {
      fixture.sqlite.close();
    }
  });

  test('waives through a fenced transition and derives an exact forward restore', () => {
    const fixture = setup();
    try {
      const create = createPlan(fixture);
      if (create.action !== 'create_definition') throw new TypeError('wrong_plan');
      transaction(fixture.sqlite, () => {
        fixture.deadlines.applyTaskDueDeadline(create.deadlineContribution);
        fixture.tasks.applyTaskPlan(create);
      });
      const before = create.assignments[0]!;
      const waive = planTaskMutation({
        action: 'waive_assignment',
        scope,
        assignmentId: before.id,
        expectedVersion: before.version,
        actorUserId: userId,
        occurredAt: '2026-08-15T10:00:00.000Z'
      }, { tasks: fixture.tasks, memberships: fixture.tasks, deadlines: fixture.deadlines });
      if (waive.action === 'create_definition') throw new TypeError('wrong_plan');
      transaction(fixture.sqlite, () => fixture.tasks.applyTaskPlan(waive));
      expect(fixture.tasks.readTaskAssignment(scope, before.id)).toMatchObject({
        state: 'waived', version: 2
      });
      const restore = deriveTaskAssignmentRestore({
        original: waive,
        tasks: fixture.tasks,
        actorUserId: userId,
        occurredAt: '2026-08-15T10:01:00.000Z'
      });
      expect(restore).toBeDefined();
      transaction(fixture.sqlite, () => fixture.tasks.applyTaskPlan(restore!));
      expect(fixture.tasks.readTaskAssignment(scope, before.id)).toMatchObject({
        state: 'pending', version: 3
      });
      expect(fixture.sqlite.query('SELECT kind FROM task_events WHERE assignment_id=? ORDER BY assignment_version')
        .all(before.id)).toEqual([
          { kind: 'assigned' }, { kind: 'waived' }, { kind: 'restored' }
        ]);
    } finally {
      fixture.sqlite.close();
    }
  });
});

function transaction<Value>(sqlite: Database, operation: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  }
}
