import {
  decisionIdSchema,
  decisionMutationPlanSchema,
  decisionMutationPlanningInputSchema,
  decisionMutationResultSchema,
  decisionRestorePlanSchema,
  decisionSafeDiffSchema,
  decisionTargetUnavailableDetailSchema,
  type DecisionMutationPlanDto,
  type DecisionMutationPlanningInput,
  type DecisionMutationResult,
  type DecisionRestorePlanDto,
  type DecisionSafeDiffDto
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
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
import {
  sessionGraduationAggregateRefs,
  sessionGraduationGuardRefs,
  sessionGraduationPin,
  sessionGraduationPlanningPort,
  sessionGraduationTransactionPort,
  sessionGraduationValidationPort,
  sessionCatalogGuardId,
  sessionAggregateId
} from '@jooevents/session';
import { z } from 'zod';
import {
  DECISION_PLANNING_ERROR_CODES,
  isDecisionRestorePlan,
  planDecisionCompensation,
  planDecisionMutation,
  projectDecisionSafeDiff,
  validateDecisionMutationPlan,
  validateDecisionRestorePlan,
  DecisionPlanningError,
  type DecisionEnvironment,
  type DecisionPlanRefusal
} from './domain';
import {
  absentDecisionHeadDigest,
  decisionAggregateId,
  decisionHeadAbsenceGuardId,
  type DecisionChangesetReadPort,
  type DecisionChangesetTransactionPort
} from './model';

export const DECISION_CHANGESET_KIND = 'decision.decide';
export const DECISION_CHANGESET_VERSION = 1;

type DecisionChangesetAuthorInput = DecisionMutationPlanningInput | DecisionRestorePlanDto;
type DecisionChangesetPlan = DecisionMutationPlanDto | DecisionRestorePlanDto;

export const decisionReadPort = defineChangesetReadPort<DecisionChangesetReadPort>(
  'decision.read', 1
);
export const decisionValidationPort = defineChangesetValidationPort<DecisionChangesetReadPort>(
  'decision.validation', 1
);
export const decisionTransactionPort = defineChangesetTransactionPort<DecisionChangesetTransactionPort>(
  'decision.transaction', 1
);

const authorInputSchema = defineChangesetSchema({
  key: 'decision.planning_input', version: 1,
  schema: z.union([decisionMutationPlanningInputSchema, decisionRestorePlanSchema])
});
const planSchema = defineChangesetSchema({
  key: 'decision.plan', version: 1,
  schema: z.union([decisionMutationPlanSchema, decisionRestorePlanSchema])
});
const diffSchema = defineChangesetSchema({
  key: 'decision.safe_diff', version: 1, schema: decisionSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'decision.result', version: 1, schema: decisionMutationResultSchema
});
export const decisionStaleDetailSchema = z.strictObject({
  code: z.enum(DECISION_PLANNING_ERROR_CODES),
  submissionId: decisionIdSchema
});
const staleDetailSchema = defineChangesetSchema({
  key: 'decision.stale_detail', version: 1, schema: decisionStaleDetailSchema
});
const targetUnavailableDetailSchema = defineChangesetSchema({
  key: 'decision.target_unavailable_detail', version: 1,
  schema: decisionTargetUnavailableDetailSchema
});

type DecisionDefinition = ChangesetOperationDefinition<
  DecisionChangesetAuthorInput,
  DecisionChangesetPlan,
  DecisionSafeDiffDto,
  DecisionChangesetPlan,
  DecisionMutationResult
>;

export interface DecisionChangesetBundle {
  readonly definition: DecisionDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

/**
 * The one `decision.decide` changeset: Decision heads, submission→Session
 * origin links, and the hosted Session graduation collaboration commit in a
 * single unit of work. Accepted rows carry a Session contribution (spawn or
 * roster attach) applied through the Session graduation transaction port
 * before this owner's head/origin writes; waitlisted and declined rows write
 * the head only. The transaction emits facts only — no messaging effect of any
 * kind is produced here, so deciding never notifies anyone by itself.
 */
export function createDecisionChangesetBundle(): DecisionChangesetBundle {
  const definition: DecisionDefinition = {
    kind: DECISION_CHANGESET_KIND,
    version: DECISION_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [decisionReadPort, sessionGraduationPlanningPort],
    validationPorts: [decisionValidationPort, sessionGraduationValidationPort],
    transactionPorts: [decisionTransactionPort, sessionGraduationTransactionPort],
    allowedAggregateKinds: ['decision_head', 'session'],
    // An undecided submission has no Decision head, so first decides fence on
    // the published `decision_head_absence` guard; graduations fence on the
    // whole `session_catalog` guard because a spawned Session cannot carry a
    // per-session guard before it exists. The whole-catalog false-conflict
    // cost is accepted deliberately; the refusal is retry-by-replan.
    allowedGuardKinds: ['decision_head_absence', 'session_catalog'],
    allowedRisks: ['consequential'],
    allowedConsequences: ['decision_changed', 'session_changed'],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'decision.changed', retryable: false,
      detailSchema: staleDetailSchema.reference
    }, {
      class: 'conflict', kind: 'decision.target_unavailable', retryable: false,
      detailSchema: targetUnavailableDetailSchema.reference
    }],
    allowedFacts: [
      { kind: 'decision_changed', version: 1 },
      { kind: 'session_changed', version: 1 }
    ],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const environment: DecisionEnvironment = {
        decisions: snapshot.getPort(decisionReadPort),
        sessions: snapshot.getPort(sessionGraduationPlanningPort)
      };
      if (isRestoreAuthorInput(authorInput)) {
        const refusal = validateDecisionRestorePlan({ plan: authorInput, environment });
        if (refusal) {
          throw new DecisionPlanningError(
            refusal.kind === 'stale' ? refusal.code : 'invalid_plan',
            refusal.submissionId
          );
        }
        return {
          plan: authorInput,
          aggregateRefs: restoreAggregateRefs(authorInput),
          guardRefs: restoreGuardRefs(authorInput),
          riskTier: 'consequential',
          consequences: consequencesFor(authorInput)
        };
      }
      const plan = planDecisionMutation({ planningInput: authorInput, environment });
      return {
        plan,
        aggregateRefs: decideAggregateRefs(plan),
        guardRefs: decideGuardRefs(plan),
        riskTier: 'consequential',
        consequences: consequencesFor(plan)
      };
    },
    projectDiff(plan) {
      return {
        diff: projectDecisionSafeDiff(plan),
        representedConsequences: consequencesFor(plan)
      };
    },
    validateWithin(plan, validation) {
      const environment: DecisionEnvironment = {
        decisions: validation.getPort(decisionValidationPort),
        sessions: validation.getPort(sessionGraduationValidationPort)
      };
      const refusal = isDecisionRestorePlan(plan)
        ? validateDecisionRestorePlan({ plan, environment })
        : validateDecisionMutationPlan({ plan, environment });
      return refusal
        ? { kind: 'outcome', outcome: refusalOutcome(refusal) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const decisions = transaction.getPort(decisionTransactionPort);
      const graduations = transaction.getPort(sessionGraduationTransactionPort);
      if (isDecisionRestorePlan(plan)) {
        // Reverse of the decide order: origin links unlink before a spawned
        // Session row may be removed by its graduation reversal.
        const result = decisions.applyDecisionPlan(plan);
        const sessionFacts = plan.rows.flatMap((row) => {
          if (row.sessionRestore === null) return [];
          const reverted = graduations.applySessionGraduationReversal(row.sessionRestore);
          return [{ kind: 'session_changed', version: 1, payload: reverted }];
        });
        return {
          result,
          facts: [
            { kind: 'decision_changed', version: 1, payload: result },
            ...sessionFacts
          ],
          effects: []
        };
      }
      // The Session graduation contributions apply first so every origin link
      // written below references a Session row that exists in this transaction.
      const sessionContributions = plan.rows.flatMap((row) => {
        if (row.graduation === null) return [];
        const applied = graduations.applySessionGraduation(row.graduation);
        if (canonicalJsonSha256(applied.pin)
            !== canonicalJsonSha256(sessionGraduationPin(row.graduation))) {
          throw new TypeError('decision_graduation_apply_pin_changed');
        }
        return [applied];
      });
      const result = decisions.applyDecisionPlan(plan);
      return {
        result,
        facts: [
          { kind: 'decision_changed', version: 1, payload: result },
          ...sessionContributions.flatMap((contribution) => contribution.facts)
        ],
        effects: sessionContributions.flatMap((contribution) => contribution.effects)
      };
    },
    deriveCompensation(plan, snapshot): CompensationDerivation<DecisionChangesetAuthorInput> {
      if (isDecisionRestorePlan(plan)) {
        return { kind: 'blocked', reasonKey: 'decision.compensation_of_compensation' };
      }
      const environment: DecisionEnvironment = {
        decisions: snapshot.getPort(decisionReadPort),
        sessions: snapshot.getPort(sessionGraduationPlanningPort)
      };
      const derived = planDecisionCompensation({
        original: plan,
        environment,
        actorUserId: plan.input.actorUserId,
        occurredAt: plan.input.occurredAt
      });
      if (derived.kind === 'blocked') return { kind: 'blocked', reasonKey: derived.reasonKey };
      return derived.kind === 'exact'
        ? { kind: 'exact', authorInput: derived.plan }
        : { kind: 'semantic', authorInput: derived.plan, noteKey: derived.noteKey };
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [
        authorInputSchema, planSchema, diffSchema, resultSchema,
        staleDetailSchema, targetUnavailableDetailSchema
      ],
      definitions: [definition]
    })
  });
}

function isRestoreAuthorInput(
  value: DecisionChangesetAuthorInput
): value is DecisionRestorePlanDto {
  return value.action === 'restore';
}

function consequencesFor(plan: DecisionChangesetPlan): readonly string[] {
  const touchesSessions = isDecisionRestorePlan(plan)
    ? plan.rows.some((row) => row.sessionRestore !== null)
    : plan.rows.some((row) => row.graduation !== null);
  return touchesSessions ? ['decision_changed', 'session_changed'] : ['decision_changed'];
}

/** First occurrence per aggregate/guard id wins: it pins the current state. */
function dedupById<Ref extends { readonly id: string }>(refs: readonly Ref[]): readonly Ref[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function decideAggregateRefs(plan: DecisionMutationPlanDto): readonly VersionRef[] {
  return dedupById(plan.rows.flatMap((row) => [
    ...(row.before === null
      ? []
      : [{ id: decisionAggregateId(row.submissionId), version: row.before.version }]),
    ...(row.graduation === null ? [] : sessionGraduationAggregateRefs(row.graduation))
  ]));
}

function decideGuardRefs(plan: DecisionMutationPlanDto): readonly GuardRef[] {
  const scope = plan.input.scope;
  const firstGraduation = plan.rows.find((row) => row.graduation !== null)?.graduation;
  return dedupById([
    ...plan.rows.flatMap((row) => row.before !== null ? [] : [{
      id: decisionHeadAbsenceGuardId(row.submissionId),
      version: 1,
      digest: absentDecisionHeadDigest(scope, row.submissionId)
    }]),
    ...(firstGraduation ? sessionGraduationGuardRefs(firstGraduation) : [])
  ]);
}

function restoreAggregateRefs(plan: DecisionRestorePlanDto): readonly VersionRef[] {
  return dedupById(plan.rows.flatMap((row) => [
    { id: decisionAggregateId(row.submissionId), version: row.expectedCurrent.version },
    ...(row.sessionRestore === null ? [] : [{
      id: sessionAggregateId(row.sessionRestore.expectedCurrent.id),
      version: row.sessionRestore.expectedCurrent.version
    }])
  ]));
}

function restoreGuardRefs(plan: DecisionRestorePlanDto): readonly GuardRef[] {
  const firstSessionRestore = plan.rows.find(
    (row) => row.sessionRestore !== null
  )?.sessionRestore;
  if (!firstSessionRestore) return [];
  return [{
    id: sessionCatalogGuardId(firstSessionRestore.scope.eventId),
    version: firstSessionRestore.expectedCatalogVersion,
    digest: firstSessionRestore.expectedCatalogDigestSha256
  }];
}

function refusalOutcome(refusal: DecisionPlanRefusal) {
  if (refusal.kind === 'target_unavailable') {
    return Object.freeze({
      class: 'conflict' as const,
      kind: 'decision.target_unavailable',
      retryable: false,
      subjects: [
        { type: 'submission', id: refusal.submissionId },
        { type: 'session', id: refusal.sessionId }
      ],
      detail: refusal.detail,
      detailSchemaVersion: 1
    });
  }
  return Object.freeze({
    class: 'stale_revision' as const,
    kind: 'decision.changed',
    retryable: false,
    subjects: [{ type: 'submission', id: refusal.submissionId }],
    detail: Object.freeze({ code: refusal.code, submissionId: refusal.submissionId }),
    detailSchemaVersion: 1
  });
}
