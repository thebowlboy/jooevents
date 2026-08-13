import type { ChangesetApplyContribution, GuardRef, VersionRef } from '@jooevents/changesets';
import {
  deadlineDisplayDateSchema,
  deadlineMutationPlanSchema,
  type DeadlineMutationPlanDto,
  type DeadlineMutationResult,
  type DeadlineReferencePinDto,
  type DeadlineSafeDiff,
  type DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import { reviewDeadlinePinSchema, type ReviewDeadlinePinDto } from '@jooevents/contracts/reviews';
import {
  defineChangesetReadPort,
  defineChangesetTransactionPort,
  defineChangesetValidationPort
} from '@jooevents/changesets';
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

export type ReviewDueDeadlineContribution = DeadlineMutationPlanDto;

interface ReviewDueDeadlineChangeBase {
  readonly scope: DeadlineScopeDto;
  readonly attribution: { readonly userId: string; readonly at: string };
}

export type ReviewDueDeadlineChangeInput =
  | (ReviewDueDeadlineChangeBase & {
      readonly currentDeadlineId: null;
      readonly dueOn: string;
      readonly identity: { readonly deadlineId: string };
    })
  | (ReviewDueDeadlineChangeBase & {
      readonly currentDeadlineId: string;
      readonly dueOn: string | null;
    });

export interface ReviewDueDeadlinePlanningPort extends DeadlineRepository,
  DeadlineEventTimeSource, DeadlineReferenceResolver {
  planReviewDueDeadlineChange(input: ReviewDueDeadlineChangeInput): ReviewDueDeadlineContribution;
}

export type ReviewDueDeadlineValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: DeadlinePlanningErrorCode };

export interface ReviewDueDeadlineValidationPort extends DeadlineRepository, DeadlineEventTimeSource {
  validateReviewDueDeadline(contribution: ReviewDueDeadlineContribution): ReviewDueDeadlineValidation;
}

export interface ReviewDueDeadlineAppliedContribution extends
  ChangesetApplyContribution<DeadlineMutationResult> {
  readonly pin: DeadlineReferencePinDto | null;
}

export interface ReviewDueDeadlineTransactionPort extends DeadlineTransactionRepository {
  applyReviewDueDeadline(
    contribution: ReviewDueDeadlineContribution
  ): ReviewDueDeadlineAppliedContribution;
}

export const reviewDueDeadlinePlanningPort = defineChangesetReadPort<ReviewDueDeadlinePlanningPort>(
  'review_due_deadline.planning', 1
);
export const reviewDueDeadlineValidationPort =
  defineChangesetValidationPort<ReviewDueDeadlineValidationPort>(
    'review_due_deadline.validation', 1
  );
export const reviewDueDeadlineTransactionPort =
  defineChangesetTransactionPort<ReviewDueDeadlineTransactionPort>(
    'review_due_deadline.transaction', 1
  );

export function planReviewDueDeadlineChangeFrom(
  port: DeadlineRepository & DeadlineEventTimeSource,
  input: ReviewDueDeadlineChangeInput
): ReviewDueDeadlineContribution {
  const catalog = port.readDeadlineCatalog(input.scope);
  if (!catalog) throw new TypeError('review_due_deadline_scope_missing');
  const action = input.currentDeadlineId === null ? 'create'
    : input.dueOn === null ? 'clear' : 'update';
  const deadlineId = input.currentDeadlineId === null
    ? input.identity.deadlineId
    : input.currentDeadlineId;
  const current = input.currentDeadlineId === null
    ? undefined
    : port.readDeadline(input.scope, input.currentDeadlineId);
  if (action !== 'create' && (!current || current.kind !== 'review_due')) {
    throw new TypeError('review_due_deadline_missing');
  }
  const planningInput = action === 'create'
    ? {
        action, scope: input.scope, deadlineId, kind: 'review_due' as const,
        displayDate: deadlineDisplayDateSchema.parse(input.dueOn),
        attributedByUserId: input.attribution.userId,
        attributedAt: input.attribution.at
      } as const
    : action === 'update'
      ? {
          action, scope: input.scope, deadlineId, kind: 'review_due' as const,
          expectedVersion: current!.version,
          displayDate: deadlineDisplayDateSchema.parse(input.dueOn),
          attributedByUserId: input.attribution.userId,
          attributedAt: input.attribution.at
        } as const
      : {
          action, scope: input.scope, deadlineId, kind: 'review_due' as const,
          expectedVersion: current!.version,
          attributedByUserId: input.attribution.userId,
          attributedAt: input.attribution.at
        } as const;
  const eventTimeBasis = action === 'clear'
    ? undefined
    : port.readDeadlineEventTimeBasis(input.scope);
  if (action !== 'clear' && !eventTimeBasis) {
    throw new TypeError('review_due_deadline_event_time_unavailable');
  }
  return deadlineMutationPlanSchema.parse(planDeadlineMutation({
    planningInput,
    catalog,
    ...(eventTimeBasis ? { eventTimeBasis } : {})
  }));
}

export function validateReviewDueDeadlineFrom(
  port: DeadlineRepository & DeadlineEventTimeSource,
  contribution: ReviewDueDeadlineContribution
): ReviewDueDeadlineValidation {
  const catalog = port.readDeadlineCatalog(contribution.input.scope);
  if (!catalog) return { kind: 'refused', code: 'wrong_scope' };
  if (contribution.input.kind !== 'review_due') return { kind: 'refused', code: 'invalid_plan' };
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

export function applyReviewDueDeadlineFrom(
  port: DeadlineTransactionRepository,
  contribution: ReviewDueDeadlineContribution
): ReviewDueDeadlineAppliedContribution {
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

export function reviewDueDeadlineAggregateRefs(
  contribution: ReviewDueDeadlineContribution
): readonly VersionRef[] {
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

export function reviewDueDeadlineGuardRefs(
  contribution: ReviewDueDeadlineContribution
): readonly GuardRef[] {
  return Object.freeze([{
    id: deadlineCatalogGuardId(contribution.input.scope.eventId),
    version: contribution.catalog.beforeVersion,
    digest: contribution.catalog.beforeDigestSha256
  }]);
}

export function projectReviewDueDeadlineDiff(
  contribution: ReviewDueDeadlineContribution
): DeadlineSafeDiff {
  return projectDeadlineSafeDiff(contribution);
}

export function reviewDueDeadlinePin(
  contribution: ReviewDueDeadlineContribution
): DeadlineReferencePinDto | null {
  return deadlineReferencePin(contribution.after) ?? null;
}

export function reviewDueDeadlineEvidence(
  contribution: ReviewDueDeadlineContribution
): Pick<ReviewDueDeadlineAppliedContribution, 'facts' | 'effects'> {
  return Object.freeze({
    facts: Object.freeze([{
      kind: 'deadline_changed', version: 1,
      payload: deadlineChangedFactPayload(contribution)
    }]),
    effects: Object.freeze([])
  });
}

/**
 * Converts the canonical Deadline reference pin into the Review-owned pin shape
 * (`id` -> `deadlineId`, fixed `kind: 'review_due'`). Review rounds embed this
 * converted pin; the Deadline head stays canonical in the Deadline domain.
 */
export function reviewDeadlinePinFromReference(
  pin: DeadlineReferencePinDto
): ReviewDeadlinePinDto {
  return reviewDeadlinePinSchema.parse({
    deadlineId: pin.id,
    kind: 'review_due',
    version: pin.version,
    digestSha256: pin.digestSha256,
    effectiveAt: pin.effectiveAt
  });
}
