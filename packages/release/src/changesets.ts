import {
  releaseMutationPlanSchema,
  releaseMutationResultSchema,
  releasePlanningErrorCodeSchema,
  releasePlanningInputSchema,
  releaseActionSchema,
  releaseIdSchema,
  releaseSafeDiffSchema,
  type ReleaseMutationPlanDto,
  type ReleaseMutationResultDto,
  type ReleasePlanningErrorCode,
  type ReleasePlanningInput,
  type ReleaseSurfaceSuccessorPlanDto,
  type ReleaseSafeDiffDto,
  type SurfaceHeadDto
} from '@jooevents/contracts';
import {
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type GuardRef,
  type VersionRef
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  isProgramPlan,
  isStyleSetPlan,
  isSurfaceAllowlistPlan,
  isSurfacePublishPlan,
  planReleaseCompensation,
  planReleaseMutation,
  programReleaseChainGuardId,
  projectReleaseSafeDiff,
  releaseChainGuard,
  styleSetReleaseChainGuardId,
  surfaceHeadGuard,
  surfaceHeadGuardId,
  validateReleaseMutationPlan
} from './domain';
import type { ReleaseReadPort } from './model';

export const RELEASE_CHANGESET_KIND = 'release.publish';
export const RELEASE_CHANGESET_VERSION = 1;

/** Stable changeset-owner identity for every release changeset. */
export const RELEASE_CHANGESET_OWNER_ID = 'release' as const;

/** The single wrapped commit fact this owner emits per committed changeset. */
export const RELEASE_CHANGESET_COMMIT_FACT_KIND = 'release_changed' as const;

/** Module-exported identity surface for routing and policy composition. */
export const releaseChangesets = Object.freeze({
  ownerId: RELEASE_CHANGESET_OWNER_ID,
  kind: RELEASE_CHANGESET_KIND,
  version: RELEASE_CHANGESET_VERSION
});

export type ReleaseChangesetReadPort = ReleaseReadPort;

export interface ReleaseChangesetTransactionPort extends ReleaseChangesetReadPort {
  /** Writes one validated release plan: immutable release rows plus head pointer moves. */
  applyReleasePlan(plan: ReleaseMutationPlanDto): ReleaseMutationResultDto;
}

/**
 * Successor-collaboration transaction seam for the hosting intake commit: the
 * form-republish changeset applies its planned successor surface releases
 * atomically inside its own unit of work through the intake-owned
 * surface-successor collaboration ports (`@jooevents/intake` defines the port
 * identities beside its hosting definition; the composing persistence bridge
 * implements them with this domain's plan/validate/apply functions). The
 * release domain never mounts an implicit side effect.
 */
export interface ReleaseSurfaceSuccessorTransactionPort extends ReleaseChangesetReadPort {
  applyReleaseSurfaceSuccessorPlan(
    plan: ReleaseSurfaceSuccessorPlanDto
  ): readonly SurfaceHeadDto[];
}

export const releaseReadPort = defineChangesetReadPort<ReleaseChangesetReadPort>('release.read', 1);
export const releaseValidationPort =
  defineChangesetValidationPort<ReleaseChangesetReadPort>('release.validation', 1);
export const releaseTransactionPort =
  defineChangesetTransactionPort<ReleaseChangesetTransactionPort>('release.transaction', 1);

// Version 2: the surface framing-allowlist arm joined the planning union.
const authorInputSchema = defineChangesetSchema({
  key: 'release.planning_input', version: 2,
  schema: releasePlanningInputSchema
});
// Version 2: program plans carry the rollback participant-suppression record
// (owner revocation rule applied to the rollback successor path).
// Version 3: surface heads carry the framing allowlist and the allowlist plan
// joined the union.
const planSchema = defineChangesetSchema({
  key: 'release.plan', version: 3,
  schema: releaseMutationPlanSchema
});
// Version 3: the surface_allowlist arm and the head allowlist field.
const diffSchema = defineChangesetSchema({
  key: 'release.safe_diff', version: 3, schema: releaseSafeDiffSchema
});
// Version 2: the surface_allowlist arm and the head allowlist field.
const resultSchema = defineChangesetSchema({
  key: 'release.result', version: 2, schema: releaseMutationResultSchema
});
export const releaseStaleDetailSchema = z.strictObject({
  code: releasePlanningErrorCodeSchema,
  action: releaseActionSchema,
  subjectId: releaseIdSchema.nullable()
});
// Version 2: the action vocabulary gained surface_allowlist.
const staleDetailSchema = defineChangesetSchema({
  key: 'release.stale_detail', version: 2, schema: releaseStaleDetailSchema
});

type ReleaseDefinition = ChangesetOperationDefinition<
  ReleasePlanningInput,
  ReleaseMutationPlanDto,
  ReleaseSafeDiffDto,
  ReleaseMutationPlanDto,
  ReleaseMutationResultDto
>;

export interface ReleaseChangesetBundle {
  readonly definition: ReleaseDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

/**
 * The one `release.publish` changeset. Every arm is `consequential`: it moves
 * what the public can see. `publish_schedule` refuses while block-severity
 * schedule conflicts exist and freezes the audited name declassifications into
 * the reviewed plan; commit writes the immutable release and emits facts only.
 * No model output and no serving path ever writes a release row outside this
 * owner (the intake-hosted successor collaboration applies release-domain
 * plans through its own reviewed commit).
 */
export function createReleaseChangesetBundle(): ReleaseChangesetBundle {
  const definition: ReleaseDefinition = {
    kind: RELEASE_CHANGESET_KIND,
    version: RELEASE_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [releaseReadPort],
    validationPorts: [releaseValidationPort],
    transactionPorts: [releaseTransactionPort],
    // Chains and heads are fenced by guards (they must fence absence too);
    // immutable releases themselves can never drift, so no aggregate refs.
    allowedAggregateKinds: [],
    allowedGuardKinds: ['program_release_chain', 'style_set_release_chain', 'surface_head_state'],
    allowedRisks: ['consequential'],
    allowedConsequences: [RELEASE_CHANGESET_COMMIT_FACT_KIND],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'release.changed', retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [{ kind: RELEASE_CHANGESET_COMMIT_FACT_KIND, version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const port = snapshot.getPort(releaseReadPort);
      const plan = planReleaseMutation({ planningInput: authorInput, port });
      return {
        plan,
        aggregateRefs: noAggregateRefs(),
        guardRefs: planGuardRefs(plan),
        riskTier: 'consequential',
        consequences: [RELEASE_CHANGESET_COMMIT_FACT_KIND]
      };
    },
    projectDiff(plan) {
      return {
        diff: releaseSafeDiffSchema.parse(projectReleaseSafeDiff(plan)),
        representedConsequences: [RELEASE_CHANGESET_COMMIT_FACT_KIND]
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(releaseValidationPort);
      const refusal = validateReleaseMutationPlan({ plan, port });
      return refusal
        ? { kind: 'outcome', outcome: refusalOutcome(refusal, plan) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(releaseTransactionPort).applyReleasePlan(plan);
      return {
        result,
        facts: [{ kind: RELEASE_CHANGESET_COMMIT_FACT_KIND, version: 1, payload: result }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      const port = snapshot.getPort(releaseReadPort);
      const derived = planReleaseCompensation({
        original: plan,
        port,
        actorUserId: plan.input.actorUserId,
        occurredAt: plan.input.occurredAt
      });
      return derived.kind === 'blocked'
        ? { kind: 'blocked', reasonKey: derived.reasonKey }
        : { kind: 'exact', authorInput: derived.authorInput };
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

function planGuardRefs(plan: ReleaseMutationPlanDto): readonly GuardRef[] {
  const eventId = plan.input.scope.eventId;
  if (isProgramPlan(plan)) {
    const guard = releaseChainGuard(plan.chainBefore ?? undefined);
    return Object.freeze([{ id: programReleaseChainGuardId(eventId), ...guard }]);
  }
  if (isStyleSetPlan(plan)) {
    const guard = releaseChainGuard(plan.chainBefore ?? undefined);
    return Object.freeze([{ id: styleSetReleaseChainGuardId(eventId), ...guard }]);
  }
  const guard = surfaceHeadGuard(plan.headBefore ?? undefined);
  return Object.freeze([{ id: surfaceHeadGuardId(eventId, plan.input.kind), ...guard }]);
}

function noAggregateRefs(): readonly VersionRef[] {
  return Object.freeze([]);
}

function refusalOutcome(code: ReleasePlanningErrorCode, plan: ReleaseMutationPlanDto) {
  const subjectId = isProgramPlan(plan) || isStyleSetPlan(plan) || isSurfacePublishPlan(plan)
    ? plan.release.id
    : isSurfaceAllowlistPlan(plan)
      ? plan.headBefore.activeReleaseId
      : plan.input.targetReleaseId;
  return Object.freeze({
    class: 'stale_revision' as const,
    kind: 'release.changed',
    retryable: false,
    subjects: [{ type: 'release', id: subjectId }],
    detail: Object.freeze({ code, action: plan.input.action, subjectId }),
    detailSchemaVersion: 2
  });
}
