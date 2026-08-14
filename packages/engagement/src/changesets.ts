import {
  engagementIdSchema,
  engagementMutationPlanSchema,
  engagementMutationPlanningInputSchema,
  engagementMutationResultSchema,
  engagementRestorePlanSchema,
  engagementSafeDiffSchema,
  type EngagementMutationPlanDto,
  type EngagementMutationPlanningInput,
  type EngagementMutationResult,
  type EngagementRestorePlanDto,
  type EngagementSafeDiffDto
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
import { z } from 'zod';
import {
  ENGAGEMENT_PLANNING_ERROR_CODES,
  isEngagementRestorePlan,
  planEngagementCompensation,
  planEngagementMutation,
  projectEngagementSafeDiff,
  validateEngagementMutationPlan,
  validateEngagementRestorePlan,
  EngagementPlanningError,
  type EngagementEnvironment,
  type EngagementPlanRefusal
} from './domain';
import { engagementAggregateId, type EngagementReadPort } from './model';

export const ENGAGEMENT_CHANGESET_KIND = 'engagement.respond';
export const ENGAGEMENT_CHANGESET_VERSION = 1;

/** Stable changeset-owner identity for every engagement response changeset. */
export const ENGAGEMENT_CHANGESET_OWNER_ID = 'engagement' as const;

/** The single wrapped commit fact this owner emits per committed changeset. */
export const ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND = 'engagement_changed' as const;

/** Module-exported identity surface for routing and policy composition. */
export const engagementChangesets = Object.freeze({
  ownerId: ENGAGEMENT_CHANGESET_OWNER_ID,
  kind: ENGAGEMENT_CHANGESET_KIND,
  version: ENGAGEMENT_CHANGESET_VERSION
});

type EngagementChangesetAuthorInput = EngagementMutationPlanningInput | EngagementRestorePlanDto;
type EngagementChangesetPlan = EngagementMutationPlanDto | EngagementRestorePlanDto;

export type EngagementChangesetReadPort = EngagementReadPort;

export interface EngagementChangesetTransactionPort extends EngagementChangesetReadPort {
  /** Writes one engagement head image for one validated response or restore plan. */
  applyEngagementPlan(
    plan: EngagementMutationPlanDto | EngagementRestorePlanDto
  ): EngagementMutationResult;
}

export const engagementReadPort = defineChangesetReadPort<EngagementChangesetReadPort>(
  'engagement.read', 1
);
export const engagementValidationPort = defineChangesetValidationPort<EngagementChangesetReadPort>(
  'engagement.validation', 1
);
export const engagementTransactionPort =
  defineChangesetTransactionPort<EngagementChangesetTransactionPort>(
    'engagement.transaction', 1
  );

const authorInputSchema = defineChangesetSchema({
  key: 'engagement.planning_input', version: 1,
  schema: z.union([engagementMutationPlanningInputSchema, engagementRestorePlanSchema])
});
const planSchema = defineChangesetSchema({
  key: 'engagement.plan', version: 1,
  schema: z.union([engagementMutationPlanSchema, engagementRestorePlanSchema])
});
const diffSchema = defineChangesetSchema({
  key: 'engagement.safe_diff', version: 1, schema: engagementSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'engagement.result', version: 1, schema: engagementMutationResultSchema
});
export const engagementStaleDetailSchema = z.strictObject({
  code: z.enum(ENGAGEMENT_PLANNING_ERROR_CODES),
  engagementId: engagementIdSchema
});
const staleDetailSchema = defineChangesetSchema({
  key: 'engagement.stale_detail', version: 1, schema: engagementStaleDetailSchema
});

type EngagementDefinition = ChangesetOperationDefinition<
  EngagementChangesetAuthorInput,
  EngagementChangesetPlan,
  EngagementSafeDiffDto,
  EngagementChangesetPlan,
  EngagementMutationResult
>;

export interface EngagementChangesetBundle {
  readonly definition: EngagementDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

/**
 * The one `engagement.respond` changeset: exactly one response act on one
 * engagement head per commit, fenced on the head's expected version. The
 * transaction emits facts only — no messaging effect of any kind is produced
 * here, so responding never notifies anyone by itself. Seeding is not a
 * response: `invited` rows are written exclusively by the acceptance-shaped
 * hosting commit through the seed collaboration, never through this owner.
 */
export function createEngagementChangesetBundle(): EngagementChangesetBundle {
  const definition: EngagementDefinition = {
    kind: ENGAGEMENT_CHANGESET_KIND,
    version: ENGAGEMENT_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [engagementReadPort],
    validationPorts: [engagementValidationPort],
    transactionPorts: [engagementTransactionPort],
    allowedAggregateKinds: ['engagement_head'],
    // Every response addresses an existing head, so the aggregate version ref
    // is the whole fence; no absence or catalog guard exists in this domain.
    allowedGuardKinds: [],
    allowedRisks: ['consequential'],
    allowedConsequences: ['engagement_changed'],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'engagement.changed', retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [{ kind: ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const environment: EngagementEnvironment = {
        engagements: snapshot.getPort(engagementReadPort)
      };
      if (isRestoreAuthorInput(authorInput)) {
        const refusal = validateEngagementRestorePlan({ plan: authorInput, environment });
        if (refusal) throw new EngagementPlanningError(refusal.code, refusal.engagementId);
        return {
          plan: authorInput,
          aggregateRefs: restoreAggregateRefs(authorInput),
          guardRefs: noGuardRefs(),
          riskTier: 'consequential',
          consequences: [ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND]
        };
      }
      const plan = planEngagementMutation({ planningInput: authorInput, environment });
      return {
        plan,
        aggregateRefs: mutationAggregateRefs(plan),
        guardRefs: noGuardRefs(),
        riskTier: 'consequential',
        consequences: [ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND]
      };
    },
    projectDiff(plan) {
      return {
        diff: projectEngagementSafeDiff(plan),
        representedConsequences: [ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND]
      };
    },
    validateWithin(plan, validation) {
      const environment: EngagementEnvironment = {
        engagements: validation.getPort(engagementValidationPort)
      };
      const refusal = isEngagementRestorePlan(plan)
        ? validateEngagementRestorePlan({ plan, environment })
        : validateEngagementMutationPlan({ plan, environment });
      return refusal
        ? { kind: 'outcome', outcome: refusalOutcome(refusal) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const engagements = transaction.getPort(engagementTransactionPort);
      const result = engagements.applyEngagementPlan(plan);
      return {
        result,
        facts: [{ kind: ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, version: 1, payload: result }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot): CompensationDerivation<EngagementChangesetAuthorInput> {
      if (isEngagementRestorePlan(plan)) {
        return { kind: 'blocked', reasonKey: 'engagement.compensation_of_compensation' };
      }
      const environment: EngagementEnvironment = {
        engagements: snapshot.getPort(engagementReadPort)
      };
      const derived = planEngagementCompensation({
        original: plan,
        environment,
        actorUserId: plan.input.actorUserId,
        occurredAt: plan.input.occurredAt
      });
      return derived.kind === 'blocked'
        ? { kind: 'blocked', reasonKey: derived.reasonKey }
        : { kind: 'exact', authorInput: derived.plan };
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

function isRestoreAuthorInput(
  value: EngagementChangesetAuthorInput
): value is EngagementRestorePlanDto {
  return value.action === 'restore';
}

function mutationAggregateRefs(plan: EngagementMutationPlanDto): readonly VersionRef[] {
  return Object.freeze([{
    id: engagementAggregateId(plan.before.id),
    version: plan.before.version
  }]);
}

function restoreAggregateRefs(plan: EngagementRestorePlanDto): readonly VersionRef[] {
  return Object.freeze([{
    id: engagementAggregateId(plan.expectedCurrent.id),
    version: plan.expectedCurrent.version
  }]);
}

function noGuardRefs(): readonly GuardRef[] {
  return Object.freeze([]);
}

function refusalOutcome(refusal: EngagementPlanRefusal) {
  return Object.freeze({
    class: 'stale_revision' as const,
    kind: 'engagement.changed',
    retryable: false,
    subjects: [{ type: 'engagement', id: refusal.engagementId }],
    detail: Object.freeze({ code: refusal.code, engagementId: refusal.engagementId }),
    detailSchemaVersion: 1
  });
}
