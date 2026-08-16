import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  taskAssignmentRestorePlanSchema,
  taskMutationPlanSchema,
  taskMutationResultSchema,
  taskSafeDiffSchema,
  type TaskAssignmentDto,
  type TaskEventDto,
  type TaskAssignmentRestorePlanDto,
  type TaskAuthorInput,
  type TaskMutationPlanDto,
  type TaskMutationResultDto,
  type TaskSafeDiffDto,
  type TaskScopeDto
} from '@jooevents/contracts';

import {
  taskDueDeadlinePin,
  type TaskDueDeadlinePlanningPort
} from '@jooevents/deadline';
import {
  createEmptyTaskCatalog,
  deterministicTaskAssignmentId,
  deterministicTaskEventId,
  parseTaskAssignment,
  parseTaskDefinition,
  parseTaskEvent,
  taskCatalogDigest,
  taskMembershipGuardId,
  taskRevisionDigest,
  type TaskMembershipSource,
  type TaskReadPort,
  type TaskTransactionPort
} from './model';

export type TaskPlanningErrorCode =
  | 'wrong_scope' | 'stale_catalog' | 'definition_exists' | 'assignment_missing'
  | 'stale_assignment' | 'invalid_transition' | 'membership_changed'
  | 'deadline_changed' | 'invalid_plan';

export class TaskPlanningError extends TypeError {
  constructor(readonly code: TaskPlanningErrorCode, readonly subjectId?: string) {
    super(code);
    this.name = 'TaskPlanningError';
  }
}

export interface TaskPlanningEnvironment {
  readonly tasks: TaskReadPort;
  readonly memberships: TaskMembershipSource;
  readonly deadlines: TaskDueDeadlinePlanningPort;
}

function membershipEvidence(environment: TaskPlanningEnvironment, scope: TaskScopeDto) {
  return [...environment.memberships.listConfirmedTaskEngagements(scope)]
    .sort((a, b) => a.engagementId.localeCompare(b.engagementId));
}

function membershipGuard(scope: TaskScopeDto, evidence: readonly unknown[]) {
  return {
    id: taskMembershipGuardId(scope.eventId),
    version: 1,
    digestSha256: canonicalJsonSha256({ scope, rule: 'all_confirmed_speakers@1', evidence })
  };
}

export function planTaskMutation(
  input: TaskAuthorInput,
  environment: TaskPlanningEnvironment
): TaskMutationPlanDto {
  return input.action === 'create_definition'
    ? planCreate(input, environment)
    : planTransition(input, environment);
}

function planCreate(
  input: Extract<TaskAuthorInput, { action: 'create_definition' }>,
  environment: TaskPlanningEnvironment
): TaskMutationPlanDto {
  const catalog = environment.tasks.readTaskCatalog(input.scope)
    ?? createEmptyTaskCatalog(input.scope);
  if (catalog.definitions.some((entry) => entry.head.id === input.taskDefinitionId)) {
    throw new TaskPlanningError('definition_exists', input.taskDefinitionId);
  }
  const engagements = membershipEvidence(environment, input.scope);
  const deadlineContribution = environment.deadlines.planTaskDueDeadlineCreate({
    scope: input.scope,
    dueOn: input.dueOn,
    identity: { deadlineId: input.deadlineId },
    attribution: { userId: input.actorUserId, at: input.occurredAt }
  });
  const deadline = { kind: 'task_due' as const, reference: taskDueDeadlinePin(deadlineContribution) };
  const revisionWithoutDigest = {
    schemaVersion: 1 as const,
    scope: input.scope,
    taskDefinitionId: input.taskDefinitionId,
    revisionId: input.revisionId,
    number: 1,
    predecessorRevisionId: null,
    predecessorDigestSha256: null,
    name: input.name,
    description: input.description,
    subjectKind: 'engagement' as const,
    completionMode: input.completionMode,
    required: input.required,
    visibility: 'assigned_participants' as const,
    assignmentRule: { kind: 'all_confirmed_speakers' as const, version: 1 as const },
    deadline,
    createdByUserId: input.actorUserId,
    createdAt: input.occurredAt
  };
  const current = { ...revisionWithoutDigest, digestSha256: taskRevisionDigest(revisionWithoutDigest) };
  const definition = parseTaskDefinition({
    head: {
      schemaVersion: 1,
      scope: input.scope,
      id: input.taskDefinitionId,
      currentRevisionId: input.revisionId,
      currentRevisionNumber: 1,
      version: 1
    },
    current
  });
  const assignments = engagements.map((engagement) => parseTaskAssignment({
    schemaVersion: 1,
    scope: input.scope,
    id: deterministicTaskAssignmentId({
      scope: input.scope,
      taskDefinitionId: input.taskDefinitionId,
      engagementId: engagement.engagementId
    }),
    taskDefinitionId: input.taskDefinitionId,
    taskDefinitionRevisionId: input.revisionId,
    engagementId: engagement.engagementId,
    personId: engagement.personId,
    state: 'pending',
    deadline,
    deadlineOverride: null,
    completionEvidence: null,
    assignedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    version: 1
  }));
  const events = assignments.map((assignment) => parseTaskEvent({
    schemaVersion: 1,
    scope: input.scope,
    id: deterministicTaskEventId({ assignmentId: assignment.id, assignmentVersion: 1, kind: 'assigned' }),
    assignmentId: assignment.id,
    kind: 'assigned',
    fromState: null,
    toState: 'pending',
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    assignmentVersion: 1
  }));
  const afterVersion = catalog.version + 1;
  const afterDefinitions = [...catalog.definitions, definition]
    .sort((a, b) => a.head.id.localeCompare(b.head.id));
  return taskMutationPlanSchema.parse({
    action: 'create_definition',
    input,
    catalog: {
      beforeVersion: catalog.version,
      beforeDigestSha256: catalog.digestSha256,
      afterVersion,
      afterDigestSha256: taskCatalogDigest({
        schemaVersion: 1,
        scope: input.scope,
        version: afterVersion,
        definitions: afterDefinitions
      })
    },
    membershipGuard: membershipGuard(input.scope, engagements),
    engagementEvidence: engagements,
    deadlineContribution,
    definition,
    assignments,
    events
  });
}

function planTransition(
  input: Exclude<TaskAuthorInput, { action: 'create_definition' }>,
  environment: TaskPlanningEnvironment
): TaskMutationPlanDto {
  const before = environment.tasks.readTaskAssignment(input.scope, input.assignmentId);
  if (!before) throw new TaskPlanningError('assignment_missing', input.assignmentId);
  if (before.version !== input.expectedVersion) {
    throw new TaskPlanningError('stale_assignment', input.assignmentId);
  }
  if (input.action === 'waive_assignment'
      && !['pending', 'received_pending_check'].includes(before.state)) {
    throw new TaskPlanningError('invalid_transition', input.assignmentId);
  }
  if (input.action === 'accept_fulfillment' && before.state !== 'received_pending_check') {
    throw new TaskPlanningError('invalid_transition', input.assignmentId);
  }
  const nextState = input.action === 'waive_assignment'
    ? 'waived' as const
    : (Date.parse(input.occurredAt) > Date.parse(
        (before.deadlineOverride ?? before.deadline).reference.effectiveAt
      ) ? 'late_complete' as const : 'complete' as const);
  const after = parseTaskAssignment({
    ...before,
    state: nextState,
    updatedAt: input.occurredAt,
    version: before.version + 1
  });
  const kind = input.action === 'waive_assignment' ? 'waived' as const : 'fulfillment_accepted' as const;
  return taskMutationPlanSchema.parse({
    action: input.action,
    input,
    before,
    after,
    event: {
      schemaVersion: 1,
      scope: input.scope,
      id: deterministicTaskEventId({ assignmentId: before.id, assignmentVersion: after.version, kind }),
      assignmentId: before.id,
      kind,
      fromState: before.state,
      toState: after.state,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      assignmentVersion: after.version
    }
  });
}

export function validateTaskMutation(
  plan: TaskMutationPlanDto,
  environment: TaskPlanningEnvironment
): TaskPlanningErrorCode | undefined {
  if (plan.action === 'create_definition') {
    const catalog = environment.tasks.readTaskCatalog(plan.input.scope)
      ?? createEmptyTaskCatalog(plan.input.scope);
    if (catalog.version !== plan.catalog.beforeVersion
        || catalog.digestSha256 !== plan.catalog.beforeDigestSha256) {
      return 'stale_catalog';
    }
    const currentMembership = membershipEvidence(environment, plan.input.scope);
    const currentGuard = membershipGuard(plan.input.scope, currentMembership);
    if (currentGuard.digestSha256 !== plan.membershipGuard.digestSha256) {
      return 'membership_changed';
    }
  }
  let rebuilt: TaskMutationPlanDto;
  try {
    rebuilt = planTaskMutation(plan.input, environment);
  } catch (error) {
    return error instanceof TaskPlanningError ? error.code : 'invalid_plan';
  }
  return canonicalJsonSha256(rebuilt) === canonicalJsonSha256(plan) ? undefined : 'invalid_plan';
}

export function projectTaskSafeDiff(
  plan: TaskMutationPlanDto | TaskAssignmentRestorePlanDto
): TaskSafeDiffDto {
  if (plan.action === 'create_definition') {
    return taskSafeDiffSchema.parse({
      action: plan.action,
      definition: {
        id: plan.definition.head.id,
        name: plan.definition.current.name,
        completionMode: plan.definition.current.completionMode,
        required: plan.definition.current.required,
        dueOn: plan.definition.current.deadline.reference.displayDate,
        assignmentRule: plan.definition.current.assignmentRule
      },
      assignments: plan.assignments.map((entry) => ({
        assignmentId: entry.id,
        engagementId: entry.engagementId
      })),
      representedConsequences: [
        'deadline_changed', 'task_definition_created', 'task_assignments_materialized'
      ]
    });
  }
  const before = plan.action === 'restore_assignment' ? plan.expectedCurrent : plan.before;
  const after = plan.action === 'restore_assignment' ? plan.restore : plan.after;
  return taskSafeDiffSchema.parse({
    action: plan.action,
    assignmentId: before.id,
    taskDefinitionId: before.taskDefinitionId,
    engagementId: before.engagementId,
    beforeState: before.state,
    afterState: after.state,
    representedConsequences: ['task_assignment_changed']
  });
}

export function validateTaskRestore(
  planInput: TaskAssignmentRestorePlanDto,
  tasks: TaskReadPort
): TaskPlanningErrorCode | undefined {
  const plan = taskAssignmentRestorePlanSchema.parse(planInput);
  const current = tasks.readTaskAssignment(plan.scope, plan.expectedCurrent.id);
  return current && canonicalJsonSha256(current) === canonicalJsonSha256(plan.expectedCurrent)
    ? undefined : 'stale_assignment';
}

export function deriveTaskAssignmentRestore(input: {
  readonly original: Exclude<TaskMutationPlanDto, { action: 'create_definition' }>;
  readonly tasks: TaskReadPort;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): TaskAssignmentRestorePlanDto | undefined {
  const current = input.tasks.readTaskAssignment(input.original.input.scope, input.original.after.id);
  if (!current || canonicalJsonSha256(current) !== canonicalJsonSha256(input.original.after)) return undefined;
  const restore = parseTaskAssignment({
    ...input.original.before,
    version: current.version + 1,
    updatedAt: input.occurredAt
  });
  return taskAssignmentRestorePlanSchema.parse({
    action: 'restore_assignment',
    scope: input.original.input.scope,
    expectedCurrent: current,
    restore,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    event: {
      schemaVersion: 1,
      scope: input.original.input.scope,
      id: deterministicTaskEventId({ assignmentId: current.id, assignmentVersion: restore.version, kind: 'restored' }),
      assignmentId: current.id,
      kind: 'restored',
      fromState: current.state,
      toState: restore.state,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      assignmentVersion: restore.version
    }
  });
}

/** Derive a direct Undo from the immutable event that produced the current row. */
export function planTaskAssignmentRestore(input: {
  readonly current: TaskAssignmentDto;
  readonly latestEvent: TaskEventDto;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): TaskAssignmentRestorePlanDto {
  const { current, latestEvent } = input;
  if (latestEvent.assignmentId !== current.id
      || latestEvent.assignmentVersion !== current.version
      || latestEvent.toState !== current.state
      || !['waived', 'fulfillment_accepted'].includes(latestEvent.kind)
      || latestEvent.fromState === null) {
    throw new TaskPlanningError('invalid_transition', current.id);
  }
  const restore = parseTaskAssignment({
    ...current,
    state: latestEvent.fromState,
    version: current.version + 1,
    updatedAt: input.occurredAt
  });
  return taskAssignmentRestorePlanSchema.parse({
    action: 'restore_assignment', scope: current.scope, expectedCurrent: current, restore,
    actorUserId: input.actorUserId, occurredAt: input.occurredAt,
    event: {
      schemaVersion: 1, scope: current.scope,
      id: deterministicTaskEventId({ assignmentId: current.id, assignmentVersion: restore.version, kind: 'restored' }),
      assignmentId: current.id, kind: 'restored', fromState: current.state,
      toState: restore.state, actorUserId: input.actorUserId,
      occurredAt: input.occurredAt, assignmentVersion: restore.version
    }
  });
}

export function applyTaskMutation(
  plan: TaskMutationPlanDto | TaskAssignmentRestorePlanDto,
  transaction: TaskTransactionPort
): TaskMutationResultDto {
  return taskMutationResultSchema.parse(transaction.applyTaskPlan(plan));
}
