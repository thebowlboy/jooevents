import {
  structuredOutcomeSchema,
  taskAssignmentSchema,
  taskEventSchema,
  taskScopeSchema,
  type TaskAssignmentDto,
  type TaskEventDto
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  defineChangesetSchema,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import {
  type EngagementResponseCollaborationPlan,
  type EngagementResponseCollaborator,
  type EngagementResponseCorePlan,
  isEngagementRestorePlan
} from '@jooevents/engagement';
import { canonicalJsonValue } from '@jooevents/kernel';
import { z } from 'zod';
import {
  deterministicTaskAssignmentId,
  deterministicTaskEventId,
  parseTaskAssignment,
  parseTaskEvent,
  taskCatalogGuardId,
  type TaskReadPort
} from './model';
import {
  taskReadPort,
  taskTransactionPort,
  taskValidationPort
} from './changesets';

const reference = Object.freeze({ key: 'task.engagement-confirmation', version: 1 });
const planSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('materialize'), scope: taskScopeSchema,
    engagementId: z.uuid(), personId: z.uuid(), engagementVersion: z.number().int().positive(),
    catalogVersion: z.number().int().positive(), catalogDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    assignments: z.array(taskAssignmentSchema), events: z.array(taskEventSchema)
  }),
  z.strictObject({
    action: z.literal('waive'), scope: taskScopeSchema,
    engagementId: z.uuid(), personId: z.uuid(), engagementVersion: z.number().int().positive(),
    catalogVersion: z.number().int().positive(), catalogDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.array(z.strictObject({
      before: taskAssignmentSchema, after: taskAssignmentSchema, event: taskEventSchema
    }))
  })
]);
type Plan = z.infer<typeof planSchema>;

const staleDetail = defineChangesetSchema({
  key: 'task.engagement-collaboration.stale-detail', version: 1,
  schema: z.strictObject({ engagementId: z.uuid() })
});

function actor(core: EngagementResponseCorePlan): string {
  if (isEngagementRestorePlan(core)) return core.actorUserId;
  return core.input.actorUserId ?? core.after.confirmation?.personId ?? core.after.personId;
}

function occurredAt(core: EngagementResponseCorePlan): string {
  return isEngagementRestorePlan(core) ? core.occurredAt : core.input.occurredAt;
}

function build(core: EngagementResponseCorePlan, tasks: TaskReadPort): Plan | undefined {
  const scope = isEngagementRestorePlan(core) ? core.scope : core.input.scope;
  const after = isEngagementRestorePlan(core) ? core.restore : core.after;
  const before = isEngagementRestorePlan(core) ? core.expectedCurrent : core.before;
  const catalog = tasks.readTaskCatalog(scope);
  const board = tasks.readTaskBoard(scope);
  if (!catalog || !board || catalog.definitions.length === 0) return undefined;
  const at = occurredAt(core);
  const by = actor(core);
  if (before.state !== 'confirmed' && after.state === 'confirmed') {
    const assignments: TaskAssignmentDto[] = [];
    const events: TaskEventDto[] = [];
    for (const definition of catalog.definitions) {
      if (board.assignments.some((entry) =>
        entry.taskDefinitionId === definition.head.id && entry.engagementId === after.id
      )) continue;
      const assignment = parseTaskAssignment({
        schemaVersion: 1, scope,
        id: deterministicTaskAssignmentId({ scope, taskDefinitionId: definition.head.id, engagementId: after.id }),
        taskDefinitionId: definition.head.id,
        taskDefinitionRevisionId: definition.current.revisionId,
        engagementId: after.id, personId: after.personId, state: 'pending',
        deadline: definition.current.deadline, deadlineOverride: null,
        completionEvidence: null, assignedAt: at, updatedAt: at, version: 1
      });
      assignments.push(assignment);
      events.push(parseTaskEvent({
        schemaVersion: 1, scope,
        id: deterministicTaskEventId({ assignmentId: assignment.id, assignmentVersion: 1, kind: 'assigned' }),
        assignmentId: assignment.id, kind: 'assigned', fromState: null, toState: 'pending',
        actorUserId: by, occurredAt: at, assignmentVersion: 1
      }));
    }
    if (assignments.length === 0) return undefined;
    return planSchema.parse({
      action: 'materialize', scope, engagementId: after.id, personId: after.personId,
      engagementVersion: after.version, catalogVersion: catalog.version,
      catalogDigestSha256: catalog.digestSha256, assignments, events
    });
  }
  if (before.state === 'confirmed' && after.state !== 'confirmed') {
    const rows = board.assignments.filter((entry) =>
      entry.engagementId === before.id
      && (entry.state === 'pending' || entry.state === 'received_pending_check')
    ).map((beforeAssignment) => {
      const afterAssignment = parseTaskAssignment({
        ...beforeAssignment, state: 'waived', version: beforeAssignment.version + 1, updatedAt: at
      });
      return {
        before: beforeAssignment, after: afterAssignment,
        event: parseTaskEvent({
          schemaVersion: 1, scope,
          id: deterministicTaskEventId({ assignmentId: beforeAssignment.id, assignmentVersion: afterAssignment.version, kind: 'waived' }),
          assignmentId: beforeAssignment.id, kind: 'waived', fromState: beforeAssignment.state,
          toState: 'waived', actorUserId: by, occurredAt: at,
          assignmentVersion: afterAssignment.version
        })
      };
    });
    if (rows.length === 0) return undefined;
    return planSchema.parse({
      action: 'waive', scope, engagementId: before.id, personId: before.personId,
      engagementVersion: before.version, catalogVersion: catalog.version,
      catalogDigestSha256: catalog.digestSha256, rows
    });
  }
  return undefined;
}

function contribution(plan: Plan): EngagementResponseCollaborationPlan {
  const assignmentIds = plan.action === 'materialize'
    ? plan.assignments.map((entry) => entry.id)
    : plan.rows.map((entry) => entry.before.id);
  return {
    contributor: reference,
    plan: canonicalJsonValue(plan),
    safeDiff: canonicalJsonValue({
      action: plan.action,
      engagementId: plan.engagementId,
      assignmentIds,
      afterState: plan.action === 'materialize' ? 'pending' : 'waived'
    }),
    aggregateRefs: plan.action === 'waive'
      ? plan.rows.map((entry) => ({ id: `task_assignment:${entry.before.id}`, version: entry.before.version }))
      : [],
    guardRefs: [{
      id: taskCatalogGuardId(plan.scope.eventId),
      version: plan.catalogVersion,
      digest: plan.catalogDigestSha256
    }],
    consequences: [plan.action === 'materialize'
      ? 'task_assignments_materialized' : 'task_assignment_changed']
  };
}

function stale(plan: Plan) {
  return {
    kind: 'outcome' as const,
    outcome: structuredOutcomeSchema.parse({
      class: 'stale_revision', kind: 'task.engagement_reconciliation_changed', retryable: false,
      subjects: [{ type: 'engagement', id: plan.engagementId }],
      detail: { engagementId: plan.engagementId }, detailSchemaVersion: 1
    })
  };
}

const collaborator: EngagementResponseCollaborator = {
  reference,
  readPorts: [taskReadPort], validationPorts: [taskValidationPort],
  transactionPorts: [taskTransactionPort],
  allowedAggregateKinds: ['task_assignment'], allowedGuardKinds: ['task_catalog'],
  allowedConsequences: ['task_assignments_materialized', 'task_assignment_changed'],
  allowedOutcomes: [{
    class: 'stale_revision' as const, kind: 'task.engagement_reconciliation_changed', retryable: false,
    detailSchema: staleDetail.reference
  }],
  allowedFacts: [
    { kind: 'task_assignments_materialized', version: 1 },
    { kind: 'task_assignment_changed', version: 1 }
  ],
  allowedEffects: [], schemas: [staleDetail],
  plan(core, snapshot) {
    const plan = build(core, snapshot.getPort(taskReadPort));
    return plan ? contribution(plan) : undefined;
  },
  validate(core, raw, validation) {
    const plan = planSchema.parse(raw.plan);
    const rebuilt = build(core, validation.getPort(taskValidationPort));
    return rebuilt && canonicalJsonSha256(rebuilt) === canonicalJsonSha256(plan)
      ? { kind: 'ready', validated: canonicalJsonValue(plan) }
      : stale(plan);
  },
  apply(_core, raw, transaction) {
    const plan = planSchema.parse(raw);
    const result = transaction.getPort(taskTransactionPort).applyEngagementReconciliation(plan);
    const kind = plan.action === 'materialize' ? 'task_assignments_materialized' : 'task_assignment_changed';
    return {
      result: canonicalJsonValue(result),
      facts: [{ kind, version: 1, payload: canonicalJsonValue(result) }], effects: []
    };
  }
};

export const TASK_ENGAGEMENT_RESPONSE_COLLABORATOR: EngagementResponseCollaborator =
  Object.freeze(collaborator);

export type TaskEngagementReconciliationPlan = Plan;
