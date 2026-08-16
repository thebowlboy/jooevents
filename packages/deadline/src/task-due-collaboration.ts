import {
  deadlineDisplayDateSchema,
  deadlineMutationPlanSchema,
  type DeadlineMutationPlanDto,
  type DeadlineMutationResult,
  type DeadlineReferencePinDto,
  type DeadlineSafeDiff,
  type DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import {
  deadlineChangedFactPayload,
  planDeadlineMutation,
  projectDeadlineSafeDiff,
  validateDeadlineMutationPlan,
  type DeadlineEventTimeSource,
  type DeadlinePlanningErrorCode,
  type DeadlineReferenceResolver,
  type DeadlineRepository,
  type DeadlineTransactionRepository
} from './domain';
import {
  deadlineAggregateId,
  deadlineCatalogGuardId,
  deadlineEventAggregateId,
  deadlineReferencePin
} from './model';

export type TaskDueDeadlineContribution = DeadlineMutationPlanDto;

export interface TaskDueDeadlineCreateInput {
  readonly scope: DeadlineScopeDto;
  readonly dueOn: string;
  readonly identity: { readonly deadlineId: string };
  readonly attribution: { readonly userId: string; readonly at: string };
}

export interface TaskDueDeadlinePlanningPort extends DeadlineRepository,
  DeadlineEventTimeSource, DeadlineReferenceResolver {
  planTaskDueDeadlineCreate(input: TaskDueDeadlineCreateInput): TaskDueDeadlineContribution;
}

export type TaskDueDeadlineValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: DeadlinePlanningErrorCode };

export interface TaskDueDeadlineValidationPort extends TaskDueDeadlinePlanningPort {
  validateTaskDueDeadline(contribution: TaskDueDeadlineContribution): TaskDueDeadlineValidation;
}

export interface TaskDueDeadlineAppliedContribution {
  readonly result: DeadlineMutationResult;
  readonly pin: DeadlineReferencePinDto;
  readonly facts: readonly {
    readonly kind: string;
    readonly version: number;
    readonly payload: ReturnType<typeof deadlineChangedFactPayload>;
  }[];
  readonly effects: readonly never[];
}

export interface TaskDueDeadlineTransactionPort extends DeadlineTransactionRepository {
  applyTaskDueDeadline(
    contribution: TaskDueDeadlineContribution
  ): TaskDueDeadlineAppliedContribution;
}

export interface TaskDueDeadlineAggregateRef {
  readonly id: string;
  readonly version: number;
}

export interface TaskDueDeadlineGuardRef extends TaskDueDeadlineAggregateRef {
  readonly digest: string;
}

export function planTaskDueDeadlineCreateFrom(
  port: DeadlineRepository & DeadlineEventTimeSource,
  input: TaskDueDeadlineCreateInput
): TaskDueDeadlineContribution {
  const catalog = port.readDeadlineCatalog(input.scope);
  if (!catalog) throw new TypeError('task_due_deadline_scope_missing');
  const eventTimeBasis = port.readDeadlineEventTimeBasis(input.scope);
  if (!eventTimeBasis) throw new TypeError('task_due_deadline_event_time_unavailable');
  return deadlineMutationPlanSchema.parse(planDeadlineMutation({
    planningInput: {
      action: 'create',
      scope: input.scope,
      deadlineId: input.identity.deadlineId,
      kind: 'task_due',
      displayDate: deadlineDisplayDateSchema.parse(input.dueOn),
      attributedByUserId: input.attribution.userId,
      attributedAt: input.attribution.at
    },
    catalog,
    eventTimeBasis
  }));
}

export function validateTaskDueDeadlineFrom(
  port: DeadlineRepository & DeadlineEventTimeSource,
  contribution: TaskDueDeadlineContribution
): TaskDueDeadlineValidation {
  const catalog = port.readDeadlineCatalog(contribution.input.scope);
  if (!catalog) return { kind: 'refused', code: 'wrong_scope' };
  if (contribution.input.kind !== 'task_due' || contribution.input.action !== 'create') {
    return { kind: 'refused', code: 'invalid_plan' };
  }
  const eventTimeBasis = port.readDeadlineEventTimeBasis(contribution.input.scope);
  if (!eventTimeBasis) return { kind: 'refused', code: 'event_time_unavailable' };
  const code = validateDeadlineMutationPlan({ plan: contribution, catalog, eventTimeBasis });
  return code ? { kind: 'refused', code } : { kind: 'ready' };
}

export function applyTaskDueDeadlineFrom(
  port: DeadlineTransactionRepository,
  contribution: TaskDueDeadlineContribution
): TaskDueDeadlineAppliedContribution {
  const result = port.applyDeadlinePlan(contribution);
  const pin = deadlineReferencePin(contribution.after);
  if (!pin) throw new TypeError('task_due_deadline_pin_missing');
  return Object.freeze({
    result,
    pin,
    facts: Object.freeze([{
      kind: 'deadline_changed', version: 1,
      payload: deadlineChangedFactPayload(contribution)
    }]),
    effects: Object.freeze([])
  });
}

export function taskDueDeadlineAggregateRefs(
  contribution: TaskDueDeadlineContribution
): readonly TaskDueDeadlineAggregateRef[] {
  if (!contribution.eventTimeBasis) throw new TypeError('task_due_event_basis_missing');
  return Object.freeze([{
    id: deadlineEventAggregateId(contribution.input.scope.eventId),
    version: contribution.eventTimeBasis.eventVersion
  }]);
}

export function taskDueDeadlineGuardRefs(
  contribution: TaskDueDeadlineContribution
): readonly TaskDueDeadlineGuardRef[] {
  return Object.freeze([{
    id: deadlineCatalogGuardId(contribution.input.scope.eventId),
    version: contribution.catalog.beforeVersion,
    digest: contribution.catalog.beforeDigestSha256
  }]);
}

export function projectTaskDueDeadlineDiff(
  contribution: TaskDueDeadlineContribution
): DeadlineSafeDiff {
  return projectDeadlineSafeDiff(contribution);
}

export function taskDueDeadlinePin(
  contribution: TaskDueDeadlineContribution
): DeadlineReferencePinDto {
  const pin = deadlineReferencePin(contribution.after);
  if (!pin) throw new TypeError('task_due_deadline_pin_missing');
  return pin;
}
