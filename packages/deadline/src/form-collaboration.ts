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

export type FormCloseDeadlineContribution = DeadlineMutationPlanDto;

interface FormCloseDeadlineChangeBase {
  readonly scope: DeadlineScopeDto;
  readonly attribution: { readonly userId: string; readonly at: string };
}

export type FormCloseDeadlineChangeInput =
  | (FormCloseDeadlineChangeBase & {
      readonly currentDeadlineId: null;
      readonly closesAt: string;
      readonly identity: { readonly deadlineId: string };
    })
  | (FormCloseDeadlineChangeBase & {
      readonly currentDeadlineId: string;
      readonly closesAt: string | null;
    });

export interface FormCloseDeadlinePlanningPort extends DeadlineRepository,
  DeadlineEventTimeSource, DeadlineReferenceResolver {
  planFormCloseDeadlineChange(input: FormCloseDeadlineChangeInput): FormCloseDeadlineContribution;
}

export type FormCloseDeadlineValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: DeadlinePlanningErrorCode };

export interface FormCloseDeadlineValidationPort extends DeadlineRepository, DeadlineEventTimeSource {
  validateFormCloseDeadline(contribution: FormCloseDeadlineContribution): FormCloseDeadlineValidation;
}

export interface FormCloseDeadlineAppliedContribution {
  readonly result: DeadlineMutationResult;
  readonly facts: readonly {
    readonly kind: string;
    readonly version: number;
    readonly payload: ReturnType<typeof deadlineChangedFactPayload>;
  }[];
  readonly effects: readonly never[];
  readonly pin: DeadlineReferencePinDto | null;
}

export interface FormCloseDeadlineTransactionPort extends DeadlineTransactionRepository {
  applyFormCloseDeadline(
    contribution: FormCloseDeadlineContribution
  ): FormCloseDeadlineAppliedContribution;
}

export function planFormCloseDeadlineChangeFrom(
  port: DeadlineRepository & DeadlineEventTimeSource,
  input: FormCloseDeadlineChangeInput
): FormCloseDeadlineContribution {
  const catalog = port.readDeadlineCatalog(input.scope);
  if (!catalog) throw new TypeError('form_close_deadline_scope_missing');
  const action = input.currentDeadlineId === null ? 'create'
    : input.closesAt === null ? 'clear' : 'update';
  const deadlineId = input.currentDeadlineId === null
    ? input.identity.deadlineId
    : input.currentDeadlineId;
  const current = input.currentDeadlineId === null
    ? undefined
    : port.readDeadline(input.scope, input.currentDeadlineId);
  if (action !== 'create' && !current) throw new TypeError('form_close_deadline_missing');
  const planningInput = action === 'create'
    ? {
        action, scope: input.scope, deadlineId,
        displayDate: deadlineDisplayDateSchema.parse(input.closesAt),
        attributedByUserId: input.attribution.userId,
        attributedAt: input.attribution.at
      } as const
    : action === 'update'
      ? {
          action, scope: input.scope, deadlineId, expectedVersion: current!.version,
          displayDate: deadlineDisplayDateSchema.parse(input.closesAt),
          attributedByUserId: input.attribution.userId,
          attributedAt: input.attribution.at
        } as const
      : {
          action, scope: input.scope, deadlineId, expectedVersion: current!.version,
          attributedByUserId: input.attribution.userId,
          attributedAt: input.attribution.at
        } as const;
  const eventTimeBasis = action === 'clear'
    ? undefined
    : port.readDeadlineEventTimeBasis(input.scope);
  if (action !== 'clear' && !eventTimeBasis) {
    throw new TypeError('form_close_deadline_event_time_unavailable');
  }
  return deadlineMutationPlanSchema.parse(planDeadlineMutation({
    planningInput,
    catalog,
    ...(eventTimeBasis ? { eventTimeBasis } : {})
  }));
}

export function validateFormCloseDeadlineFrom(
  port: DeadlineRepository & DeadlineEventTimeSource,
  contribution: FormCloseDeadlineContribution
): FormCloseDeadlineValidation {
  const catalog = port.readDeadlineCatalog(contribution.input.scope);
  if (!catalog) return { kind: 'refused', code: 'wrong_scope' };
  const eventTimeBasis = contribution.eventTimeBasis === null
    ? undefined
    : port.readDeadlineEventTimeBasis(contribution.input.scope);
  const code = validateDeadlineMutationPlan({
    plan: contribution,
    catalog,
    ...(eventTimeBasis ? { eventTimeBasis } : {})
  });
  return code ? { kind: 'refused', code } : { kind: 'ready' };
}

export function applyFormCloseDeadlineFrom(
  port: DeadlineTransactionRepository,
  contribution: FormCloseDeadlineContribution
): FormCloseDeadlineAppliedContribution {
  const result = port.applyDeadlinePlan(contribution);
  return Object.freeze({
    result,
    pin: deadlineReferencePin(contribution.after) ?? null,
    facts: Object.freeze([{
      kind: 'deadline_changed', version: 1,
      payload: deadlineChangedFactPayload(contribution)
    }]),
    effects: Object.freeze([])
  });
}

export function formCloseDeadlineAggregateRefs(
  contribution: FormCloseDeadlineContribution
): readonly { readonly id: string; readonly version: number }[] {
  return Object.freeze([
    ...(contribution.before
      ? [{ id: deadlineAggregateId(contribution.before.id), version: contribution.before.version }]
      : []),
    ...(contribution.eventTimeBasis
      ? [{
          id: deadlineEventAggregateId(contribution.input.scope.eventId),
          version: contribution.eventTimeBasis.eventVersion
        }]
      : [])
  ]);
}

export function formCloseDeadlineGuardRefs(
  contribution: FormCloseDeadlineContribution
): readonly { readonly id: string; readonly version: number; readonly digest: string }[] {
  return Object.freeze([{
    id: deadlineCatalogGuardId(contribution.input.scope.eventId),
    version: contribution.catalog.beforeVersion,
    digest: contribution.catalog.beforeDigestSha256
  }]);
}

export function projectFormCloseDeadlineDiff(
  contribution: FormCloseDeadlineContribution
): DeadlineSafeDiff {
  return projectDeadlineSafeDiff(contribution);
}

export function formCloseDeadlinePin(
  contribution: FormCloseDeadlineContribution
): DeadlineReferencePinDto | null {
  return deadlineReferencePin(contribution.after) ?? null;
}

export function formCloseDeadlineEvidence(
  contribution: FormCloseDeadlineContribution
): Pick<FormCloseDeadlineAppliedContribution, 'facts' | 'effects'> {
  return Object.freeze({
    facts: Object.freeze([{
      kind: 'deadline_changed', version: 1,
      payload: deadlineChangedFactPayload(contribution)
    }]),
    effects: Object.freeze([])
  });
}
