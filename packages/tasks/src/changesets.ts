import {
  taskAssignmentRestorePlanSchema,
  taskAuthorInputSchema,
  taskMutationPlanSchema,
  taskMutationResultSchema,
  taskSafeDiffSchema,
  type TaskAssignmentRestorePlanDto,
  type TaskAuthorInput,
  type TaskMutationPlanDto,
  type TaskMutationResultDto,
  type TaskSafeDiffDto
} from '@jooevents/contracts';
import {
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type CompensationDerivation,
  type GuardRef,
  type VersionRef
} from '@jooevents/changesets';
import {
  taskDueDeadlineAggregateRefs,
  taskDueDeadlineGuardRefs,
  taskDueDeadlinePlanningPort,
  taskDueDeadlineTransactionPort,
  taskDueDeadlineValidationPort
} from '@jooevents/deadline';
import { z } from 'zod';
import {
  applyTaskMutation,
  deriveTaskAssignmentRestore,
  planTaskMutation,
  projectTaskSafeDiff,
  validateTaskMutation,
  validateTaskRestore,
  TaskPlanningError,
  type TaskPlanningErrorCode
} from './domain';
import {
  taskAssignmentAggregateId,
  taskCatalogGuardId,
  taskDefinitionAggregateId,
  type TaskMembershipSource,
  type TaskReadPort,
  type TaskTransactionPort
} from './model';

export const TASK_CHANGESET_KIND = 'task.mutate';
export const TASK_CHANGESET_VERSION = 1;
export const TASK_CHANGESET_OWNER_ID = 'task' as const;

export const taskReadPort = defineChangesetReadPort<TaskReadPort>('task.read', 1);
export const taskValidationPort = defineChangesetValidationPort<TaskReadPort>('task.validation', 1);
export const taskTransactionPort = defineChangesetTransactionPort<TaskTransactionPort>(
  'task.transaction', 1
);
export const taskMembershipReadPort = defineChangesetReadPort<TaskMembershipSource>(
  'task.membership.read', 1
);
export const taskMembershipValidationPort = defineChangesetValidationPort<TaskMembershipSource>(
  'task.membership.validation', 1
);

type TaskChangesetAuthorInput = TaskAuthorInput | TaskAssignmentRestorePlanDto;
type TaskChangesetPlan = TaskMutationPlanDto | TaskAssignmentRestorePlanDto;

const authorSchema = defineChangesetSchema({
  key: 'task.author_input', version: 1,
  schema: z.union([taskAuthorInputSchema, taskAssignmentRestorePlanSchema])
});
const planSchema = defineChangesetSchema({
  key: 'task.plan', version: 1,
  schema: z.union([taskMutationPlanSchema, taskAssignmentRestorePlanSchema])
});
const diffSchema = defineChangesetSchema({
  key: 'task.safe_diff', version: 1, schema: taskSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'task.result', version: 1, schema: taskMutationResultSchema
});
const staleDetailSchema = defineChangesetSchema({
  key: 'task.stale_detail', version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope', 'stale_catalog', 'definition_exists', 'assignment_missing',
      'stale_assignment', 'invalid_transition', 'membership_changed',
      'deadline_changed', 'invalid_plan'
    ]),
    action: z.enum([
      'create_definition', 'waive_assignment', 'accept_fulfillment', 'restore_assignment'
    ]),
    subjectId: z.string().min(1).max(512)
  })
});

type Definition = ChangesetOperationDefinition<
  TaskChangesetAuthorInput,
  TaskChangesetPlan,
  TaskSafeDiffDto,
  TaskChangesetPlan,
  TaskMutationResultDto
>;

export interface TaskChangesetBundle {
  readonly definition: Definition;
  readonly registry: ChangesetDefinitionRegistry;
}

function isRestore(plan: TaskChangesetPlan): plan is TaskAssignmentRestorePlanDto {
  return plan.action === 'restore_assignment';
}

export function createTaskChangesetBundle(): TaskChangesetBundle {
  const definition: Definition = {
    kind: TASK_CHANGESET_KIND,
    version: TASK_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [taskReadPort, taskMembershipReadPort, taskDueDeadlinePlanningPort],
    validationPorts: [
      taskValidationPort, taskMembershipValidationPort, taskDueDeadlineValidationPort
    ],
    transactionPorts: [taskTransactionPort, taskDueDeadlineTransactionPort],
    allowedAggregateKinds: ['task_definition', 'task_assignment', 'event'],
    allowedGuardKinds: ['task_catalog', 'task_membership', 'deadline_catalog'],
    allowedRisks: ['normal'],
    allowedConsequences: [
      'deadline_changed', 'task_definition_created', 'task_assignments_materialized',
      'task_assignment_changed'
    ],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'task.changed', retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [
      { kind: 'deadline_changed', version: 1 },
      { kind: 'task_definition_created', version: 1 },
      { kind: 'task_assignments_materialized', version: 1 },
      { kind: 'task_assignment_changed', version: 1 }
    ],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      if (authorInput.action === 'restore_assignment') {
        const code = validateTaskRestore(authorInput, snapshot.getPort(taskReadPort));
        if (code) throw new TaskPlanningError(code, authorInput.expectedCurrent.id);
        return {
          plan: authorInput,
          aggregateRefs: aggregateRefs(authorInput),
          guardRefs: [],
          riskTier: 'normal',
          consequences: ['task_assignment_changed']
        };
      }
      const mutation = planTaskMutation(authorInput, {
        tasks: snapshot.getPort(taskReadPort),
        memberships: snapshot.getPort(taskMembershipReadPort),
        deadlines: snapshot.getPort(taskDueDeadlinePlanningPort)
      });
      return {
        plan: mutation,
        aggregateRefs: aggregateRefs(mutation),
        guardRefs: guardRefs(mutation),
        riskTier: 'normal',
        consequences: consequences(mutation)
      };
    },
    projectDiff(plan) {
      return {
        diff: projectTaskSafeDiff(plan),
        representedConsequences: consequences(plan)
      };
    },
    validateWithin(plan, validation) {
      if (isRestore(plan)) {
        const code = validateTaskRestore(plan, validation.getPort(taskValidationPort));
        return code
          ? { kind: 'outcome', outcome: refusal(code, plan) }
          : { kind: 'ready', validated: plan };
      }
      if (plan.action === 'create_definition') {
        const deadline = validation.getPort(taskDueDeadlineValidationPort)
          .validateTaskDueDeadline(plan.deadlineContribution);
        if (deadline.kind === 'refused') {
          return { kind: 'outcome', outcome: refusal('deadline_changed', plan) };
        }
      }
      const code = validateTaskMutation(plan, {
        tasks: validation.getPort(taskValidationPort),
        memberships: validation.getPort(taskMembershipValidationPort),
        deadlines: validation.getPort(taskDueDeadlineValidationPort)
      });
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const deadlineApplied = plan.action === 'create_definition'
        ? transaction.getPort(taskDueDeadlineTransactionPort)
            .applyTaskDueDeadline(plan.deadlineContribution)
        : null;
      const result = applyTaskMutation(plan, transaction.getPort(taskTransactionPort));
      if (plan.action === 'create_definition') {
        return {
          result,
          facts: [
            ...(deadlineApplied?.facts ?? []),
            {
              kind: 'task_definition_created', version: 1,
              payload: {
                taskDefinitionId: plan.definition.head.id,
                revisionId: plan.definition.current.revisionId,
                deadlineId: plan.definition.current.deadline.reference.id
              }
            },
            {
              kind: 'task_assignments_materialized', version: 1,
              payload: {
                taskDefinitionId: plan.definition.head.id,
                assignmentIds: plan.assignments.map((entry) => entry.id)
              }
            }
          ],
          effects: [...(deadlineApplied?.effects ?? [])]
        };
      }
      return {
        result,
        facts: [{
          kind: 'task_assignment_changed', version: 1,
          payload: {
            assignmentId: isRestore(plan) ? plan.restore.id : plan.after.id,
            action: plan.action,
            state: isRestore(plan) ? plan.restore.state : plan.after.state
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot): CompensationDerivation<TaskChangesetAuthorInput> {
      if (plan.action === 'create_definition') {
        return { kind: 'irreversible', remediationKey: 'task.definition_forward_correction_required' };
      }
      if (isRestore(plan)) {
        return { kind: 'blocked', reasonKey: 'task.compensation_of_compensation' };
      }
      const restore = deriveTaskAssignmentRestore({
        original: plan,
        tasks: snapshot.getPort(taskReadPort),
        actorUserId: plan.input.actorUserId,
        occurredAt: plan.input.occurredAt
      });
      return restore
        ? { kind: 'exact', authorInput: restore }
        : { kind: 'blocked', reasonKey: 'task.assignment_changed' };
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, staleDetailSchema],
      definitions: [definition]
    })
  });
}

function aggregateRefs(plan: TaskChangesetPlan): readonly VersionRef[] {
  if (plan.action === 'create_definition') {
    return Object.freeze([
      ...taskDueDeadlineAggregateRefs(plan.deadlineContribution)
    ]);
  }
  const assignment = isRestore(plan) ? plan.expectedCurrent : plan.before;
  return Object.freeze([{
    id: taskAssignmentAggregateId(assignment.id),
    version: assignment.version
  }]);
}

function guardRefs(plan: TaskChangesetPlan): readonly GuardRef[] {
  if (plan.action !== 'create_definition') return Object.freeze([]);
  return Object.freeze([
    {
      id: taskCatalogGuardId(plan.input.scope.eventId),
      version: plan.catalog.beforeVersion,
      digest: plan.catalog.beforeDigestSha256
    },
    {
      id: plan.membershipGuard.id,
      version: plan.membershipGuard.version,
      digest: plan.membershipGuard.digestSha256
    },
    ...taskDueDeadlineGuardRefs(plan.deadlineContribution)
  ]);
}

function consequences(plan: TaskChangesetPlan): readonly string[] {
  return plan.action === 'create_definition'
    ? ['deadline_changed', 'task_definition_created', 'task_assignments_materialized']
    : ['task_assignment_changed'];
}

function refusal(code: TaskPlanningErrorCode, plan: TaskChangesetPlan) {
  const subjectId = plan.action === 'create_definition'
    ? plan.input.taskDefinitionId
    : isRestore(plan) ? plan.expectedCurrent.id : plan.before.id;
  const scope = plan.action === 'restore_assignment' ? plan.scope : plan.input.scope;
  return Object.freeze({
    class: 'stale_revision' as const,
    kind: 'task.changed',
    retryable: false,
    subjects: [{ type: 'event' as const, id: scope.eventId }],
    detail: { code, action: plan.action, subjectId },
    detailSchemaVersion: 1
  });
}
