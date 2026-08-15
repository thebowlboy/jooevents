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
import { canonicalJsonValue } from '@jooevents/kernel';
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
import {
  EMPTY_ENGAGEMENT_RESPONSE_COLLABORATIONS,
  type EngagementResponseCollaborationPlan,
  type EngagementResponseCollaborationRegistry,
  type EngagementResponseCorePlan
} from './response-collaboration';

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
export interface EngagementChangesetPlan {
  readonly core: EngagementResponseCorePlan;
  readonly collaborations: readonly EngagementResponseCollaborationPlan[];
}

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
  schema: z.strictObject({
    core: z.union([engagementMutationPlanSchema, engagementRestorePlanSchema]),
    collaborations: z.array(z.strictObject({
      contributor: z.strictObject({ key: z.string().min(1), version: z.number().int().positive() }),
      plan: z.json(), safeDiff: z.json(),
      aggregateRefs: z.array(z.strictObject({ id: z.string().min(1), version: z.number().int().nonnegative() })),
      guardRefs: z.array(z.strictObject({
        id: z.string().min(1), version: z.number().int().nonnegative(), digest: z.string().min(1)
      })),
      consequences: z.array(z.string().min(1))
    })).max(32)
  })
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
export function createEngagementChangesetBundle(
  collaborationRegistry: EngagementResponseCollaborationRegistry =
    EMPTY_ENGAGEMENT_RESPONSE_COLLABORATIONS
): EngagementChangesetBundle {
  const collaborators = [...collaborationRegistry.collaborators]
    .sort((left, right) => `${left.reference.key}@${left.reference.version}`
      .localeCompare(`${right.reference.key}@${right.reference.version}`));
  const definition: EngagementDefinition = {
    kind: ENGAGEMENT_CHANGESET_KIND,
    version: ENGAGEMENT_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [engagementReadPort, ...collaborators.flatMap((entry) => entry.readPorts)],
    validationPorts: [engagementValidationPort, ...collaborators.flatMap((entry) => entry.validationPorts)],
    transactionPorts: [engagementTransactionPort, ...collaborators.flatMap((entry) => entry.transactionPorts)],
    allowedAggregateKinds: ['engagement_head', ...new Set(collaborators.flatMap((entry) => entry.allowedAggregateKinds))],
    // Every response addresses an existing head, so the aggregate version ref
    // is the whole fence; no absence or catalog guard exists in this domain.
    allowedGuardKinds: [...new Set(collaborators.flatMap((entry) => entry.allowedGuardKinds))],
    allowedRisks: ['consequential'],
    allowedConsequences: ['engagement_changed', ...new Set(collaborators.flatMap((entry) => entry.allowedConsequences))],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'engagement.changed', retryable: false,
      detailSchema: staleDetailSchema.reference
    }, ...collaborators.flatMap((entry) => entry.allowedOutcomes)],
    allowedFacts: [{ kind: ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, version: 1 }, ...collaborators.flatMap((entry) => entry.allowedFacts)],
    allowedEffects: collaborators.flatMap((entry) => entry.allowedEffects),
    plan(authorInput, snapshot) {
      const environment: EngagementEnvironment = {
        engagements: snapshot.getPort(engagementReadPort)
      };
      if (isRestoreAuthorInput(authorInput)) {
        const refusal = validateEngagementRestorePlan({ plan: authorInput, environment });
        if (refusal) throw new EngagementPlanningError(refusal.code, refusal.engagementId);
        const plan = withCollaborations(authorInput, snapshot, collaborators);
        return {
          plan,
          aggregateRefs: [...restoreAggregateRefs(authorInput), ...plan.collaborations.flatMap((entry) => entry.aggregateRefs)],
          guardRefs: plan.collaborations.flatMap((entry) => entry.guardRefs),
          riskTier: 'consequential',
          consequences: [ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, ...plan.collaborations.flatMap((entry) => entry.consequences)]
        };
      }
      const plan = planEngagementMutation({ planningInput: authorInput, environment });
      const combined = withCollaborations(plan, snapshot, collaborators);
      return {
        plan: combined,
        aggregateRefs: [...mutationAggregateRefs(plan), ...combined.collaborations.flatMap((entry) => entry.aggregateRefs)],
        guardRefs: combined.collaborations.flatMap((entry) => entry.guardRefs),
        riskTier: 'consequential',
        consequences: [ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, ...combined.collaborations.flatMap((entry) => entry.consequences)]
      };
    },
    projectDiff(plan) {
      return {
        diff: engagementSafeDiffSchema.parse({
          ...projectEngagementSafeDiff(plan.core),
          ...(plan.collaborations.length === 0 ? {} : {
            collaborations: plan.collaborations.map((entry) => ({
              contributor: entry.contributor,
              safeDiff: entry.safeDiff,
              representedConsequences: entry.consequences
            }))
          })
        }),
        representedConsequences: [ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, ...plan.collaborations.flatMap((entry) => entry.consequences)]
      };
    },
    validateWithin(plan, validation) {
      const environment: EngagementEnvironment = {
        engagements: validation.getPort(engagementValidationPort)
      };
      const refusal = isEngagementRestorePlan(plan.core)
        ? validateEngagementRestorePlan({ plan: plan.core, environment })
        : validateEngagementMutationPlan({ plan: plan.core, environment });
      if (refusal) return { kind: 'outcome', outcome: refusalOutcome(refusal) };
      for (const contribution of plan.collaborations) {
        const collaborator = collaborators.find((entry) => sameReference(entry.reference, contribution.contributor));
        if (!collaborator) throw new TypeError('engagement_collaborator_missing');
        const result = collaborator.validate(plan.core, contribution, validation);
        if (result.kind === 'outcome') return result;
        if (JSON.stringify(canonicalJsonValue(result.validated))
            !== JSON.stringify(canonicalJsonValue(contribution.plan))) {
          throw new TypeError('engagement_collaborator_validation_substitution');
        }
      }
      return { kind: 'ready', validated: plan };
    },
    applyWithin(validated, transaction) {
      const engagements = transaction.getPort(engagementTransactionPort);
      const coreResult = engagements.applyEngagementPlan(validated.core);
      const collaborationResults = validated.collaborations.map((entry) => {
        const collaborator = collaborators.find((candidate) => sameReference(candidate.reference, entry.contributor));
        if (!collaborator) throw new TypeError('engagement_collaborator_missing');
        return { contributor: entry.contributor, applied: collaborator.apply(validated.core, entry.plan, transaction) };
      });
      const result = engagementMutationResultSchema.parse({
        ...coreResult,
        ...(collaborationResults.length === 0 ? {} : {
          collaborations: collaborationResults.map((entry) => ({
            contributor: entry.contributor, result: entry.applied.result
          }))
        })
      });
      return {
        result,
        facts: [
          { kind: ENGAGEMENT_CHANGESET_COMMIT_FACT_KIND, version: 1, payload: canonicalJsonValue(result) },
          ...collaborationResults.flatMap((entry) => entry.applied.facts)
        ],
        effects: collaborationResults.flatMap((entry) => entry.applied.effects)
      };
    },
    deriveCompensation(plan, snapshot): CompensationDerivation<EngagementChangesetAuthorInput> {
      if (isEngagementRestorePlan(plan.core)) {
        return { kind: 'blocked', reasonKey: 'engagement.compensation_of_compensation' };
      }
      const environment: EngagementEnvironment = {
        engagements: snapshot.getPort(engagementReadPort)
      };
      // Only operator-resolved plans enter the changeset lane; participant
      // acts are guarded operations and never appear here.
      if (plan.core.input.actorUserId === undefined) {
        throw new TypeError('engagement_compensation_actor_missing');
      }
      const derived = planEngagementCompensation({
        original: plan.core,
        environment,
        actorUserId: plan.core.input.actorUserId,
        occurredAt: plan.core.input.occurredAt
      });
      return derived.kind === 'blocked'
        ? { kind: 'blocked', reasonKey: derived.reasonKey }
        : { kind: 'exact', authorInput: derived.plan };
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorInputSchema, planSchema, diffSchema, resultSchema, staleDetailSchema, ...collaborators.flatMap((entry) => entry.schemas)],
      definitions: [definition]
    })
  });
}

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean { return left.key === right.key && left.version === right.version; }

function withCollaborations(
  core: EngagementResponseCorePlan,
  snapshot: import('@jooevents/changesets').ChangesetPlanningSnapshot,
  collaborators: readonly import('./response-collaboration').EngagementResponseCollaborator[]
): EngagementChangesetPlan {
  return Object.freeze({
    core,
    collaborations: Object.freeze(collaborators.flatMap((collaborator) => {
      const planned = collaborator.plan(core, snapshot);
      return planned ? [planned] : [];
    }))
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
