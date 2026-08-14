import {
  engagementAuthorInputSchema,
  engagementMutationPlanningInputSchema,
  engagementMutationPlanSchema,
  engagementMutationResultSchema,
  engagementRestorePlanSchema,
  engagementSafeDiffSchema,
  type EngagementAuthorInput,
  type EngagementConfirmationDto,
  type EngagementHeadDto,
  type EngagementMutationPlanDto,
  type EngagementMutationPlanningInput,
  type EngagementMutationResult,
  type EngagementRestorePlanDto,
  type EngagementSafeDiffDto,
  type EngagementScopeDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { parseEngagementHead, type EngagementReadPort, type EngagementScope } from './model';

export type EngagementPlanningErrorCode =
  | 'wrong_scope'
  | 'engagement_missing'
  | 'stale_engagement'
  | 'invalid_transition'
  | 'cancellation_already_requested'
  | 'cancellation_not_requested'
  | 'invalid_plan';

export const ENGAGEMENT_PLANNING_ERROR_CODES = Object.freeze([
  'wrong_scope', 'engagement_missing', 'stale_engagement', 'invalid_transition',
  'cancellation_already_requested', 'cancellation_not_requested', 'invalid_plan'
] as const satisfies readonly EngagementPlanningErrorCode[]);

export class EngagementPlanningError extends Error {
  constructor(
    readonly code: EngagementPlanningErrorCode,
    readonly engagementId?: string
  ) {
    super(code);
    this.name = 'EngagementPlanningError';
  }
}

export interface EngagementEnvironment {
  readonly engagements: EngagementReadPort;
}

/**
 * The engagement state machine. Confirmation and decline answer an open
 * invitation only; a cancellation is requested from an invited or confirmed
 * engagement and becomes effective through `accept_cancellation` alone.
 * `cancelled` and `declined` are terminal: nothing confirms after a
 * cancellation or a decline, and nothing re-opens a cancelled engagement.
 */
export function planEngagementMutation(input: {
  readonly planningInput: EngagementMutationPlanningInput;
  readonly environment: EngagementEnvironment;
}): EngagementMutationPlanDto {
  const planningInput = engagementMutationPlanningInputSchema.parse(input.planningInput);
  const scope = planningInput.scope;
  const before = input.environment.engagements.readEngagementHead(
    scope, planningInput.engagementId
  );
  if (!before) throw new EngagementPlanningError('engagement_missing', planningInput.engagementId);
  if (before.scope.workspaceId !== scope.workspaceId || before.scope.eventId !== scope.eventId) {
    throw new EngagementPlanningError('wrong_scope', planningInput.engagementId);
  }
  if (before.version !== planningInput.expectedEngagementVersion) {
    throw new EngagementPlanningError('stale_engagement', planningInput.engagementId);
  }
  const after = respond(before, planningInput);
  return engagementMutationPlanSchema.parse({ input: planningInput, before, after });
}

function respond(
  before: EngagementHeadDto,
  input: EngagementMutationPlanningInput
): EngagementHeadDto {
  const engagementId = input.engagementId;
  if (input.action === 'record_confirmation') {
    if (before.state !== 'invited') {
      throw new EngagementPlanningError('invalid_transition', engagementId);
    }
    if (input.attribution === 'co_speaker' && input.confirmingPersonId === before.personId) {
      throw new EngagementPlanningError('invalid_plan', engagementId);
    }
    const confirmation: EngagementConfirmationDto = {
      attribution: input.attribution,
      personId: input.attribution === 'co_speaker' ? input.confirmingPersonId! : before.personId,
      // The planning schema pins presence to organizer_recorded exactly; the
      // head parse below still refuses an organizer confirmation without it.
      recordedByUserId: input.attribution === 'organizer_recorded' ? (input.actorUserId ?? null) : null,
      confirmedAt: input.occurredAt
    };
    return parseEngagementHead({
      ...before, state: 'confirmed', confirmation, version: before.version + 1
    });
  }
  if (input.action === 'decline') {
    if (before.state !== 'invited') {
      throw new EngagementPlanningError('invalid_transition', engagementId);
    }
    return parseEngagementHead({
      ...before, state: 'declined', cancellationRequest: null, version: before.version + 1
    });
  }
  if (input.action === 'request_cancellation') {
    if (before.state !== 'invited' && before.state !== 'confirmed') {
      throw new EngagementPlanningError('invalid_transition', engagementId);
    }
    if (before.cancellationRequest !== null) {
      throw new EngagementPlanningError('cancellation_already_requested', engagementId);
    }
    return parseEngagementHead({
      ...before,
      cancellationRequest: {
        requestedBy: input.requestedBy,
        requestedAt: input.occurredAt,
        note: input.note ?? null
      },
      version: before.version + 1
    });
  }
  if (before.state !== 'invited' && before.state !== 'confirmed') {
    throw new EngagementPlanningError('invalid_transition', engagementId);
  }
  if (before.cancellationRequest === null) {
    throw new EngagementPlanningError('cancellation_not_requested', engagementId);
  }
  return parseEngagementHead({
    ...before, state: 'cancelled', cancelledAt: input.occurredAt, version: before.version + 1
  });
}

export interface EngagementPlanRefusal {
  readonly code: EngagementPlanningErrorCode;
  readonly engagementId: string;
}

export function validateEngagementMutationPlan(input: {
  readonly plan: EngagementMutationPlanDto;
  readonly environment: EngagementEnvironment;
}): EngagementPlanRefusal | undefined {
  let rebuilt: EngagementMutationPlanDto;
  try {
    rebuilt = planEngagementMutation({
      planningInput: input.plan.input,
      environment: input.environment
    });
  } catch (error) {
    return refusalFromError(error, input.plan.input.engagementId);
  }
  return canonical(rebuilt) === canonical(input.plan)
    ? undefined
    : { code: 'invalid_plan', engagementId: input.plan.input.engagementId };
}

/**
 * Revalidates a compensating restore against current state: the pinned current
 * head must match exactly, so anything that touched the engagement after the
 * original response refuses `stale_engagement` instead of clobbering it.
 */
export function validateEngagementRestorePlan(input: {
  readonly plan: EngagementRestorePlanDto;
  readonly environment: EngagementEnvironment;
}): EngagementPlanRefusal | undefined {
  const plan = engagementRestorePlanSchema.parse(input.plan);
  const current = input.environment.engagements.readEngagementHead(
    plan.scope, plan.expectedCurrent.id
  );
  if (!current || canonical(current) !== canonical(plan.expectedCurrent)) {
    return { code: 'stale_engagement', engagementId: plan.expectedCurrent.id };
  }
  return undefined;
}

export type EngagementCompensationPlan =
  | { readonly kind: 'exact'; readonly plan: EngagementRestorePlanDto }
  | { readonly kind: 'blocked'; readonly reasonKey: string };

/**
 * Compensation restores the exact before image (as a forward version bump) and
 * is available only while the engagement still is exactly as the original
 * response left it; any later movement blocks with `engagement.changed`.
 */
export function planEngagementCompensation(input: {
  readonly original: EngagementMutationPlanDto;
  readonly environment: EngagementEnvironment;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): EngagementCompensationPlan {
  const scope = input.original.input.scope;
  const current = input.environment.engagements.readEngagementHead(
    scope, input.original.input.engagementId
  );
  if (!current || canonical(current) !== canonical(input.original.after)) {
    return { kind: 'blocked', reasonKey: 'engagement.changed' };
  }
  const restore = parseEngagementHead({
    ...input.original.before,
    version: current.version + 1
  });
  return {
    kind: 'exact',
    plan: engagementRestorePlanSchema.parse({
      action: 'restore',
      scope,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      expectedCurrent: current,
      restore
    })
  };
}

export function isEngagementRestorePlan(
  value: EngagementMutationPlanDto | EngagementRestorePlanDto
): value is EngagementRestorePlanDto {
  return 'action' in value && value.action === 'restore';
}

export function engagementMutationResultFromPlan(
  plan: EngagementMutationPlanDto
): EngagementMutationResult {
  return engagementMutationResultSchema.parse({
    action: plan.input.action,
    engagement: plan.after
  });
}

export function engagementMutationResultFromRestore(
  plan: EngagementRestorePlanDto
): EngagementMutationResult {
  return engagementMutationResultSchema.parse({
    action: 'restore',
    engagement: plan.restore
  });
}

export function projectEngagementSafeDiff(
  plan: EngagementMutationPlanDto | EngagementRestorePlanDto
): EngagementSafeDiffDto {
  if (isEngagementRestorePlan(plan)) {
    return engagementSafeDiffSchema.parse({
      action: 'restore',
      before: plan.expectedCurrent,
      after: plan.restore
    });
  }
  return engagementSafeDiffSchema.parse({
    action: plan.input.action,
    before: plan.before,
    after: plan.after
  });
}

/**
 * Resolves the operator wire input into deterministic planning input. No
 * identity is minted here — every response addresses an existing engagement —
 * so resolution attaches server attribution only.
 */
export function resolveEngagementMutationPlanningInput(input: {
  readonly authorInput: EngagementAuthorInput;
  readonly scope: EngagementScopeDto;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): EngagementMutationPlanningInput {
  const wire = engagementAuthorInputSchema.parse(input.authorInput);
  return engagementMutationPlanningInputSchema.parse({
    ...wire,
    scope: input.scope,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt
  });
}

function refusalFromError(error: unknown, fallbackEngagementId: string): EngagementPlanRefusal {
  if (error instanceof EngagementPlanningError) {
    return { code: error.code, engagementId: error.engagementId ?? fallbackEngagementId };
  }
  return { code: 'invalid_plan', engagementId: fallbackEngagementId };
}

export function engagementScopesEqual(left: EngagementScope, right: EngagementScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}
