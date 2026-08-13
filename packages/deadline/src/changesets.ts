import {
  deadlineMutationPlanSchema,
  deadlineMutationPlanningInputSchema,
  deadlineMutationResultSchema,
  deadlineSafeDiffSchema,
  deadlineScopeSchema,
  type DeadlineMutationPlanDto,
  type DeadlineMutationPlanningInput,
  type DeadlineMutationResult,
  type DeadlineSafeDiff
} from '@jooevents/contracts/deadlines';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  deadlineChangedFactPayload,
  planDeadlineMutation,
  projectDeadlineSafeDiff,
  validateDeadlineMutationPlan,
  type DeadlineEventTimeSource,
  type DeadlinePlanningErrorCode,
  type DeadlineRepository,
  type DeadlineTransactionRepository
} from './domain';
import {
  deadlineAggregateId,
  deadlineCatalogGuardId,
  deadlineEventAggregateId,
  sameDeadlineScope
} from './model';

export const DEADLINE_CHANGESET_KIND = 'deadline.cfp_close.mutate';
export const DEADLINE_CHANGESET_VERSION = 1;

export interface DeadlinePlanningAttribution {
  readonly userId: string;
  readonly at: string;
}

export interface DeadlinePlanningAttributionSource {
  readDeadlinePlanningAttribution(): DeadlinePlanningAttribution;
}

export interface DeadlineChangesetReadPort extends DeadlineRepository, DeadlineEventTimeSource {}
export interface DeadlineChangesetTransactionPort extends DeadlineTransactionRepository {}

export const deadlineChangesetReadPort = defineChangesetReadPort<DeadlineChangesetReadPort>(
  'deadline_changeset.read', 1
);
export const deadlinePlanningAttributionReadPort =
  defineChangesetReadPort<DeadlinePlanningAttributionSource>(
    'deadline_changeset.attribution', 1
  );
export const deadlineChangesetValidationPort =
  defineChangesetValidationPort<DeadlineChangesetReadPort>(
    'deadline_changeset.validation', 1
  );
export const deadlineChangesetTransactionPort =
  defineChangesetTransactionPort<DeadlineChangesetTransactionPort>(
    'deadline_changeset.transaction', 1
  );

export interface DeadlineCompensationAuthorInput {
  readonly action: 'compensate';
  readonly sourcePlan: DeadlineMutationPlanDto;
}

export type DeadlineChangesetAuthorInput =
  | DeadlineMutationPlanningInput
  | DeadlineCompensationAuthorInput;

export interface DeadlineChangesetPlan {
  readonly mutation: DeadlineMutationPlanDto;
  readonly correctionOf: DeadlineMutationPlanDto | null;
}

const authorInputSchema = defineChangesetSchema({
  key: 'deadline.cfp_close.author',
  version: 1,
  schema: z.union([
    deadlineMutationPlanningInputSchema,
    z.strictObject({ action: z.literal('compensate'), sourcePlan: deadlineMutationPlanSchema })
  ])
});
const planSchema = defineChangesetSchema({
  key: 'deadline.cfp_close.plan',
  version: 1,
  schema: z.strictObject({
    mutation: deadlineMutationPlanSchema,
    correctionOf: deadlineMutationPlanSchema.nullable()
  })
});

export function parseDeadlineChangesetPlan(value: unknown): DeadlineChangesetPlan {
  return planSchema.schema.parse(value);
}
const diffSchema = defineChangesetSchema({
  key: 'deadline.cfp_close.safe_diff', version: 1, schema: deadlineSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'deadline.cfp_close.result', version: 1, schema: deadlineMutationResultSchema
});
const staleDetailSchema = defineChangesetSchema({
  key: 'deadline.cfp_close.stale_detail',
  version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope', 'stale_catalog', 'deadline_exists', 'deadline_missing',
      'stale_deadline', 'deadline_cleared', 'deadline_unchanged',
      'event_time_unavailable', 'event_time_changed', 'invalid_display_date',
      'invalid_event_timezone', 'boundary_nonexistent', 'boundary_ambiguous',
      'invalid_plan'
    ]),
    action: z.enum(['create', 'update', 'clear']),
    deadlineId: z.uuid()
  })
});

type DeadlineDefinition = ChangesetOperationDefinition<
  DeadlineChangesetAuthorInput,
  DeadlineChangesetPlan,
  DeadlineSafeDiff,
  DeadlineChangesetPlan,
  DeadlineMutationResult
>;

export interface DeadlineChangesetBundle {
  readonly definition: DeadlineDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

export function createDeadlineChangesetBundle(): DeadlineChangesetBundle {
  const definition: DeadlineDefinition = {
    kind: DEADLINE_CHANGESET_KIND,
    version: DEADLINE_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [deadlineChangesetReadPort, deadlinePlanningAttributionReadPort],
    validationPorts: [deadlineChangesetValidationPort],
    transactionPorts: [deadlineChangesetTransactionPort],
    allowedAggregateKinds: ['deadline', 'event'],
    allowedGuardKinds: ['deadline_catalog'],
    allowedRisks: ['low'],
    allowedConsequences: ['deadline_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'deadline.canonical_changed',
      retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'deadline_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const read = snapshot.getPort(deadlineChangesetReadPort);
      const wrapped = authorInput.action === 'compensate'
        ? planCompensation(authorInput.sourcePlan, read, snapshot)
        : planOrdinary(authorInput, read);
      return {
        plan: wrapped,
        aggregateRefs: aggregateRefs(wrapped.mutation),
        guardRefs: [{
          id: deadlineCatalogGuardId(wrapped.mutation.input.scope.eventId),
          version: wrapped.mutation.catalog.beforeVersion,
          digest: wrapped.mutation.catalog.beforeDigestSha256
        }],
        riskTier: 'low',
        consequences: ['deadline_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: projectDeadlineSafeDiff(plan.mutation),
        representedConsequences: ['deadline_changed']
      };
    },
    validateWithin(plan, validation) {
      const read = validation.getPort(deadlineChangesetValidationPort);
      const catalog = read.readDeadlineCatalog(plan.mutation.input.scope);
      if (!catalog) return { kind: 'outcome', outcome: refusal('wrong_scope', plan.mutation) };
      const eventTimeBasis = plan.mutation.eventTimeBasis === null
        ? undefined
        : read.readDeadlineEventTimeBasis(plan.mutation.input.scope);
      const code = validateDeadlineMutationPlan({
        plan: plan.mutation,
        catalog,
        ...(eventTimeBasis ? { eventTimeBasis } : {})
      });
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan.mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(deadlineChangesetTransactionPort)
        .applyDeadlinePlan(plan.mutation);
      return {
        result,
        facts: [{
          kind: 'deadline_changed', version: 1,
          payload: deadlineChangedFactPayload(plan.mutation)
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      if (plan.correctionOf !== null) {
        return { kind: 'blocked', reasonKey: 'deadline.nested_compensation' };
      }
      const read = snapshot.getPort(deadlineChangesetReadPort);
      const current = read.readDeadline(plan.mutation.input.scope, plan.mutation.after.id);
      if (!current || !sameDeadlineScope(current.scope, plan.mutation.input.scope)
          || canonicalJsonSha256(current) !== canonicalJsonSha256(plan.mutation.after)) {
        return { kind: 'blocked', reasonKey: 'deadline.head_changed' };
      }
      return {
        kind: 'exact',
        authorInput: { action: 'compensate', sourcePlan: plan.mutation }
      };
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorInputSchema, planSchema, diffSchema, resultSchema, staleDetailSchema],
      definitions: [definition]
    })
  });
}

function planOrdinary(
  input: DeadlineMutationPlanningInput,
  read: DeadlineChangesetReadPort
): DeadlineChangesetPlan {
  const catalog = read.readDeadlineCatalog(input.scope);
  if (!catalog) throw new TypeError('deadline_scope_missing');
  const eventTimeBasis = input.action === 'clear'
    ? undefined
    : read.readDeadlineEventTimeBasis(input.scope);
  return Object.freeze({
    mutation: planDeadlineMutation({
      planningInput: input,
      catalog,
      ...(eventTimeBasis ? { eventTimeBasis } : {})
    }),
    correctionOf: null
  });
}

function planCompensation(
  sourcePlan: DeadlineMutationPlanDto,
  read: DeadlineChangesetReadPort,
  snapshot: ChangesetPlanningSnapshot
): DeadlineChangesetPlan {
  const scope = deadlineScopeSchema.parse(sourcePlan.input.scope);
  const catalog = read.readDeadlineCatalog(scope);
  const current = read.readDeadline(scope, sourcePlan.after.id);
  if (!catalog || !current
      || canonicalJsonSha256(current) !== canonicalJsonSha256(sourcePlan.after)) {
    throw new TypeError('deadline_compensation_head_changed');
  }
  const attribution = snapshot.getPort(deadlinePlanningAttributionReadPort)
    .readDeadlinePlanningAttribution();
  const planningInput: DeadlineMutationPlanningInput = sourcePlan.input.action === 'create'
      || sourcePlan.before?.status === 'cleared'
    ? {
        action: 'clear', scope, deadlineId: current.id, expectedVersion: current.version,
        attributedByUserId: attribution.userId, attributedAt: attribution.at
      }
    : {
        action: 'update', scope, deadlineId: current.id, expectedVersion: current.version,
        displayDate: sourcePlan.before!.displayDate,
        attributedByUserId: attribution.userId, attributedAt: attribution.at
      };
  const eventTimeBasis = planningInput.action === 'clear'
    ? undefined
    : read.readDeadlineEventTimeBasis(scope);
  return Object.freeze({
    mutation: planDeadlineMutation({
      planningInput,
      catalog,
      ...(eventTimeBasis ? { eventTimeBasis } : {})
    }),
    correctionOf: sourcePlan
  });
}

function aggregateRefs(plan: DeadlineMutationPlanDto) {
  return Object.freeze([
    ...(plan.before ? [{ id: deadlineAggregateId(plan.before.id), version: plan.before.version }] : []),
    ...(plan.eventTimeBasis ? [{
      id: deadlineEventAggregateId(plan.input.scope.eventId),
      version: plan.eventTimeBasis.eventVersion
    }] : [])
  ]);
}

function refusal(code: DeadlinePlanningErrorCode, plan: DeadlineMutationPlanDto) {
  return {
    class: 'stale_revision' as const,
    kind: 'deadline.canonical_changed',
    retryable: false,
    subjects: [{ type: 'deadline', id: plan.after.id }],
    detail: { code, action: plan.input.action, deadlineId: plan.after.id },
    detailSchemaVersion: 1
  };
}
