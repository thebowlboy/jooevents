import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer
} from '@jooevents/application';
import { taskMutationOperationResultSchema } from '@jooevents/contracts';
import { planEventCreation } from '@jooevents/event';
import {
  canonicalJsonText,
  parseContractVersion,
  parseEventId,
  parseIntegrationInboxReceiptId,
  parseInstant,
  parseInvocationId,
  parseSourceConnectionId,
  parseUserId,
  parseVerifierRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  TASK_MANAGE_ACCESS_POLICY,
  TASK_MUTATION_OPERATION,
  TASK_MUTATION_REQUEST_HASH_PROFILE,
  createTaskMutationOperationModule
} from '@jooevents/task-operations';
import {
  deterministicTaskEventId,
  deriveTaskAssignmentRestore,
  parseTaskAssignment,
  parseTaskEvent,
  planTaskMutation,
  validateTaskMutation
} from '@jooevents/tasks';
import { installDeadlineSchema, SQLiteDeadlineRepository } from './deadline';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import { createSQLiteTaskDirectEffectDomainRegistration } from './task-direct-effect-domain';
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
const profile = Object.freeze({ key: 'task-airtable-test', version: parseContractVersion(1) });

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

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
  installFoundationTrialUnitOfWorkSchema(sqlite);
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

function providerEffect(fixture: ReturnType<typeof setup>) {
  let invocationId = 0x700;
  let operationLogId = 0x800;
  let correlationId = 0x900;
  const sourceConnectionId = parseSourceConnectionId(uuid(0xa01));
  const typedWorkspaceId = parseWorkspaceId(workspaceId);
  const typedEventId = parseEventId(eventId);
  const typedUserId = parseUserId(userId);
  const executionTime = parseInstant('2026-08-15T11:00:00.000Z');
  const authority: Parameters<typeof createTaskMutationOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (input.evidence.kind !== 'verified_inbox') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      return Object.freeze({ kind: 'authorized' as const, authority: Object.freeze({
        actor: Object.freeze({
          kind: 'verified_inbox_processing' as const,
          inboxReceiptId: input.evidence.inboxReceiptId,
          sourceConnectionId
        }),
        principal: Object.freeze({
          kind: 'verified_inbox_processing' as const,
          inboxReceiptId: input.evidence.inboxReceiptId,
          verifierRevisionId: parseVerifierRevisionId(uuid(0xa02))
        }),
        lane: input.lane,
        scope: input.scope,
        grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: 'event.manage' })]),
        evidenceIds: Object.freeze(['airtable.inbox.current']),
        authorityCitationIds: Object.freeze([]),
        evaluatedAt: input.evaluatedAt
      }) });
    }
  };
  const module = createTaskMutationOperationModule({
    workspaceId: typedWorkspaceId,
    managePolicy: TASK_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent: () => Object.freeze({
        eventId: typedEventId,
        evidenceIds: Object.freeze(['event.current.selection'])
      })
    },
    clock: { now: () => executionTime },
    ids: { newInvocationId: () => parseInvocationId(uuid(invocationId++)) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: TASK_MUTATION_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x74)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw: string) {
        return Object.freeze({
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`task-airtable:${raw}`).digest('hex')
        });
      }
    },
    enableVerifiedInbox: true
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    createSQLiteTaskDirectEffectDomainRegistration({
      sqlite: fixture.sqlite,
      workspaceId: typedWorkspaceId,
      eventRelationships: {
        validateEvent: () => Object.freeze({
          kind: 'valid' as const,
          evidenceIds: Object.freeze(['airtable.connection.owner.current'])
        })
      },
      ids: {
        newTaskDefinitionId: () => uuid(0xb01),
        newTaskDefinitionRevisionId: () => uuid(0xb02),
        newDeadlineId: () => uuid(0xb03)
      },
      verifiedInboxAttribution: {
        resolve: (input) => input.sourceConnectionId === sourceConnectionId ? typedUserId : undefined
      }
    })
  ]);
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(fixture.sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => executionTime
  });
  return async (businessInput: unknown, idempotencyKey: string) => {
    const runtime = await createApplicationOperationRuntime({
      source: composeOperationRegistryModules([module]),
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => executionTime },
        newInvocationId: () => parseInvocationId(uuid(invocationId++))
      },
      unitOfWork,
      newOperationLogId: () => uuid(operationLogId++)
    });
    const invocation = await runtime.effectBuilder.build({
      operationName: TASK_MUTATION_OPERATION.name,
      operationVersion: TASK_MUTATION_OPERATION.version,
      surface: 'provider_ingress',
      correlationId: uuid(correlationId++),
      businessInput,
      verifiedEvidence: Object.freeze({
        kind: 'verified_inbox' as const,
        surface: 'provider_ingress' as const,
        client: Object.freeze({ key: 'airtable.settle' }),
        inboxReceiptId: parseIntegrationInboxReceiptId(uuid(0xa03))
      }),
      rawIdempotencyKey: idempotencyKey
    });
    return taskMutationOperationResultSchema.parse(await runtime.effectExecutor.execute(invocation));
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
  test('verified Airtable inbox accepts then restores one received fulfillment through task.mutation', async () => {
    const fixture = setup();
    try {
      const create = createPlan(fixture);
      if (create.action !== 'create_definition') throw new TypeError('wrong_plan');
      transaction(fixture.sqlite, () => {
        fixture.deadlines.applyTaskDueDeadline(create.deadlineContribution);
        fixture.tasks.applyTaskPlan(create);
      });
      const pending = create.assignments[0]!;
      const receivedAt = '2026-08-15T10:00:00.000Z';
      const received = parseTaskAssignment({
        ...pending,
        state: 'received_pending_check',
        completionEvidence: { kind: 'acknowledged', acknowledgedAt: receivedAt },
        updatedAt: receivedAt,
        version: 2
      });
      const receivedEvent = parseTaskEvent({
        schemaVersion: 1,
        scope,
        id: deterministicTaskEventId({
          assignmentId: received.id,
          assignmentVersion: received.version,
          kind: 'fulfillment_received'
        }),
        assignmentId: received.id,
        kind: 'fulfillment_received',
        fromState: 'pending',
        toState: 'received_pending_check',
        actorUserId: userId,
        occurredAt: receivedAt,
        assignmentVersion: received.version
      });
      transaction(fixture.sqlite, () => {
        fixture.sqlite.query(`
          UPDATE task_assignments
             SET state=?, version=?, assignment_json=?, updated_at_ms=?
           WHERE workspace_id=? AND event_id=? AND id=? AND version=1
        `).run(
          received.state,
          received.version,
          canonicalJsonText(received),
          Date.parse(receivedAt),
          workspaceId,
          eventId,
          received.id
        );
        fixture.sqlite.query(`
          INSERT INTO task_events (
            workspace_id,event_id,id,assignment_id,kind,assignment_version,event_json,occurred_at_ms
          ) VALUES (?,?,?,?,?,?,?,?)
        `).run(
          workspaceId,
          eventId,
          receivedEvent.id,
          received.id,
          receivedEvent.kind,
          receivedEvent.assignmentVersion,
          canonicalJsonText(receivedEvent),
          Date.parse(receivedAt)
        );
      });

      const execute = providerEffect(fixture);
      expect(await execute({
        action: 'accept_fulfillment', assignmentId: received.id, expectedVersion: 2
      }, 'airtable-task-complete')).toMatchObject({
        kind: 'success', data: { action: 'accept_fulfillment', assignment: { state: 'complete', version: 3 } }
      });
      expect(await execute({
        action: 'restore_assignment', assignmentId: received.id, expectedVersion: 3
      }, 'airtable-task-restore')).toMatchObject({
        kind: 'success', data: { action: 'restore_assignment', assignment: {
          state: 'received_pending_check', version: 4
        } }
      });
      expect(fixture.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM operation_log WHERE surface='provider_ingress'"
      ).get()).toEqual({ count: 2 });
    } finally {
      fixture.sqlite.close();
    }
  });

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
