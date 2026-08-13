import {
  deadlineChangedFactPayloadSchema,
  deadlineMutationPlanSchema,
  deadlineMutationPlanningInputSchema,
  deadlineMutationResultSchema,
  deadlineSafeDiffSchema,
  type DeadlineCatalogSnapshotDto,
  type DeadlineChangedFactPayload,
  type DeadlineEventTimeBasisDto,
  type DeadlineHeadDto,
  type DeadlineMutationPlanDto,
  type DeadlineMutationPlanningInput,
  type DeadlineMutationResult,
  type DeadlineReferencePinDto,
  type DeadlineSafeDiff,
  type DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import { canonicalJsonSha256 } from '@jooevents/changesets';
import {
  compareDeadlineHeads,
  deadlineCatalogDigest,
  deadlineHeadDigest,
  deadlineReferencePin,
  parseDeadlineCatalog,
  parseDeadlineHead,
  sameDeadlineScope,
  deepFreeze
} from './model';
import { DeadlineBoundaryResolutionError, resolveDeadlineCalendarBoundary } from './time';

export type DeadlinePlanningErrorCode =
  | 'wrong_scope'
  | 'stale_catalog'
  | 'deadline_exists'
  | 'deadline_missing'
  | 'stale_deadline'
  | 'deadline_cleared'
  | 'deadline_unchanged'
  | 'event_time_unavailable'
  | 'event_time_changed'
  | 'invalid_display_date'
  | 'invalid_event_timezone'
  | 'boundary_nonexistent'
  | 'boundary_ambiguous'
  | 'invalid_plan';

export class DeadlinePlanningError extends Error {
  constructor(readonly code: DeadlinePlanningErrorCode) {
    super(code);
    this.name = 'DeadlinePlanningError';
  }
}

export interface DeadlineRepository {
  readDeadlineCatalog(scope: DeadlineScopeDto): DeadlineCatalogSnapshotDto | undefined;
  readDeadline(scope: DeadlineScopeDto, deadlineId: string): DeadlineHeadDto | undefined;
}

export interface DeadlineEventTimeSource {
  readDeadlineEventTimeBasis(scope: DeadlineScopeDto): DeadlineEventTimeBasisDto | undefined;
}

export interface DeadlineReferenceResolver {
  resolveCurrentDeadline(
    scope: DeadlineScopeDto,
    reference: { readonly deadlineId: string }
  ): DeadlineReferencePinDto | undefined;
}

export interface DeadlineTransactionRepository extends DeadlineRepository {
  applyDeadlinePlan(plan: DeadlineMutationPlanDto): DeadlineMutationResult;
}

export function resolveCurrentDeadlineFrom(
  repository: DeadlineRepository,
  scope: DeadlineScopeDto,
  reference: { readonly deadlineId: string }
): DeadlineReferencePinDto | undefined {
  const head = repository.readDeadline(scope, reference.deadlineId);
  if (!head || !sameDeadlineScope(head.scope, scope) || head.status !== 'active') return undefined;
  return deadlineReferencePin(head);
}

export function planDeadlineMutation(input: {
  readonly planningInput: DeadlineMutationPlanningInput;
  readonly catalog: DeadlineCatalogSnapshotDto;
  readonly eventTimeBasis?: DeadlineEventTimeBasisDto;
}): DeadlineMutationPlanDto {
  const catalog = parseDeadlineCatalog(input.catalog);
  const planning = deadlineMutationPlanningInputSchema.parse(input.planningInput);
  if (!sameDeadlineScope(catalog.scope, planning.scope)) {
    throw new DeadlinePlanningError('wrong_scope');
  }
  const current = catalog.deadlines.find((head) => head.id === planning.deadlineId);
  if (planning.action === 'create' && current) throw new DeadlinePlanningError('deadline_exists');
  if (planning.action !== 'create' && !current) throw new DeadlinePlanningError('deadline_missing');
  if (planning.action !== 'create' && current!.kind !== planning.kind) {
    throw new DeadlinePlanningError('invalid_plan');
  }
  if (planning.action !== 'create' && current!.version !== planning.expectedVersion) {
    throw new DeadlinePlanningError('stale_deadline');
  }
  if (planning.action === 'clear' && current!.status === 'cleared') {
    throw new DeadlinePlanningError('deadline_cleared');
  }
  let eventTimeBasis: DeadlineEventTimeBasisDto | null = null;
  let after: DeadlineHeadDto;
  if (planning.action === 'clear') {
    const before = current!;
    after = createHead({
      ...baseNext(before, planning.attributedByUserId, planning.attributedAt),
      status: 'cleared', displayDate: null, effectiveAt: null, boundary: null
    });
  } else {
    if (!input.eventTimeBasis) throw new DeadlinePlanningError('event_time_unavailable');
    eventTimeBasis = input.eventTimeBasis;
    let resolved: ReturnType<typeof resolveDeadlineCalendarBoundary>;
    try {
      resolved = resolveDeadlineCalendarBoundary({
        displayDate: planning.displayDate,
        eventTimeBasis
      });
    } catch (error) {
      if (error instanceof DeadlineBoundaryResolutionError) {
        throw new DeadlinePlanningError(error.code);
      }
      throw error;
    }
    const base = current
      ? baseNext(current, planning.attributedByUserId, planning.attributedAt)
      : {
          schemaVersion: 1 as const,
          id: planning.deadlineId,
          scope: planning.scope,
          kind: planning.kind,
          version: 1,
          gracePolicy: 'soft' as const,
          createdByUserId: planning.attributedByUserId,
          createdAt: planning.attributedAt,
          updatedByUserId: planning.attributedByUserId,
          updatedAt: planning.attributedAt
        };
    after = createHead({
      ...base,
      status: 'active',
      displayDate: resolved.displayDate,
      effectiveAt: resolved.effectiveAt,
      boundary: resolved.boundary
    });
    if (planning.action === 'update' && current?.status === 'active'
        && current.displayDate === after.displayDate
        && current.effectiveAt === after.effectiveAt
        && current.boundary.profile.digestSha256 === after.boundary.profile.digestSha256
        && current.boundary.eventTimezone === after.boundary.eventTimezone
        && current.boundary.eventVersion === after.boundary.eventVersion) {
      throw new DeadlinePlanningError('deadline_unchanged');
    }
  }
  const deadlines = [
    ...catalog.deadlines.filter((head) => head.id !== planning.deadlineId),
    after
  ].sort(compareDeadlineHeads);
  const afterCatalog = {
    schemaVersion: 1 as const,
    scope: catalog.scope,
    version: catalog.version + 1,
    deadlines
  };
  return deadlineMutationPlanSchema.parse(deepFreeze({
    input: planning,
    before: current ?? null,
    after,
    eventTimeBasis,
    catalog: {
      beforeVersion: catalog.version,
      beforeDigestSha256: catalog.digestSha256,
      afterVersion: afterCatalog.version,
      afterDigestSha256: deadlineCatalogDigest(afterCatalog)
    }
  }));
}

export function validateDeadlineMutationPlan(input: {
  readonly plan: DeadlineMutationPlanDto;
  readonly catalog: DeadlineCatalogSnapshotDto;
  readonly eventTimeBasis?: DeadlineEventTimeBasisDto;
}): DeadlinePlanningErrorCode | undefined {
  const catalog = parseDeadlineCatalog(input.catalog);
  if (!sameDeadlineScope(catalog.scope, input.plan.input.scope)) return 'wrong_scope';
  if (catalog.version !== input.plan.catalog.beforeVersion
      || catalog.digestSha256 !== input.plan.catalog.beforeDigestSha256) return 'stale_catalog';
  if (input.plan.eventTimeBasis !== null) {
    if (!input.eventTimeBasis) return 'event_time_unavailable';
    if (input.eventTimeBasis.timezone !== input.plan.eventTimeBasis.timezone
        || input.eventTimeBasis.eventVersion !== input.plan.eventTimeBasis.eventVersion) {
      return 'event_time_changed';
    }
  }
  try {
    const rebuilt = planDeadlineMutation({
      planningInput: input.plan.input,
      catalog,
      ...(input.eventTimeBasis ? { eventTimeBasis: input.eventTimeBasis } : {})
    });
    return canonicalJsonSha256(rebuilt) === canonicalJsonSha256(input.plan)
      ? undefined
      : 'invalid_plan';
  } catch (error) {
    return error instanceof DeadlinePlanningError ? error.code : 'invalid_plan';
  }
}

export function applyDeadlinePlanToCatalog(input: {
  readonly plan: DeadlineMutationPlanDto;
  readonly catalog: DeadlineCatalogSnapshotDto;
  readonly eventTimeBasis?: DeadlineEventTimeBasisDto;
}): { readonly catalog: DeadlineCatalogSnapshotDto; readonly result: DeadlineMutationResult } {
  const refusal = validateDeadlineMutationPlan(input);
  if (refusal) throw new DeadlinePlanningError(refusal);
  const deadlines = [
    ...input.catalog.deadlines.filter((head) => head.id !== input.plan.after.id),
    input.plan.after
  ].sort(compareDeadlineHeads);
  const catalog = parseDeadlineCatalog({
    schemaVersion: 1,
    scope: input.plan.input.scope,
    version: input.plan.catalog.afterVersion,
    digestSha256: input.plan.catalog.afterDigestSha256,
    deadlines
  });
  const result = deadlineMutationResultSchema.parse({
    action: input.plan.input.action,
    catalogVersion: catalog.version,
    deadline: input.plan.after,
    pin: deadlineReferencePin(input.plan.after) ?? null
  });
  return deepFreeze({ catalog, result });
}

export function projectDeadlineSafeDiff(plan: DeadlineMutationPlanDto): DeadlineSafeDiff {
  const image = (head: DeadlineHeadDto) => ({
    id: head.id, status: head.status, version: head.version,
    displayDate: head.displayDate, effectiveAt: head.effectiveAt, gracePolicy: head.gracePolicy
  });
  return deadlineSafeDiffSchema.parse(deepFreeze({
    action: plan.input.action,
    before: plan.before ? image(plan.before) : null,
    after: image(plan.after),
    representedConsequences: ['deadline_changed']
  }));
}

export function deadlineChangedFactPayload(plan: DeadlineMutationPlanDto): DeadlineChangedFactPayload {
  return deadlineChangedFactPayloadSchema.parse({
    action: plan.input.action,
    deadlineId: plan.after.id,
    version: plan.after.version,
    status: plan.after.status,
    displayDate: plan.after.displayDate,
    effectiveAt: plan.after.effectiveAt
  });
}

function baseNext(head: DeadlineHeadDto, userId: string, at: string) {
  return {
    schemaVersion: 1 as const, id: head.id, scope: head.scope, kind: head.kind,
    version: head.version + 1, gracePolicy: head.gracePolicy,
    createdByUserId: head.createdByUserId, createdAt: head.createdAt,
    updatedByUserId: userId, updatedAt: at
  };
}

function createHead(input: Omit<DeadlineHeadDto, 'digestSha256'>): DeadlineHeadDto {
  return parseDeadlineHead({ ...input, digestSha256: deadlineHeadDigest(input) });
}
