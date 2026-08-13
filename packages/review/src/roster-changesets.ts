import {
  reviewerRosterMutationInputSchema,
  reviewerRosterMutationPlanSchema,
  reviewerRosterMutationResultSchema,
  reviewerRosterSafeDiffSchema,
  type ReviewerRosterMutationInput,
  type ReviewerRosterMutationPlanDto,
  type ReviewerRosterMutationResult,
  type ReviewerRosterSafeDiff
} from '@jooevents/contracts/reviewer-roster';
import { reviewIdSchema, reviewInstantSchema } from '@jooevents/contracts/reviews';
import {
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type CompensationDerivation
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  applyReviewerRosterMutationPlan,
  planReviewerRosterMutation,
  projectReviewerRosterSafeDiff,
  reviewerRosterGuardId,
  reviewerRosterMutationFact,
  validateReviewerRosterMutationPlan,
  type ReviewerRosterAttribution,
  type ReviewerRosterPlanningErrorCode
} from './roster-domain';
import {
  parseReviewerRosterState,
  type ReviewerRosterPlanningSource,
  type ReviewerRosterRepository,
  type ReviewerRosterTransactionRepository
} from './roster-model';
import { canonicalJsonSha256 } from '@jooevents/changesets';

export const REVIEWER_ROSTER_CHANGESET_KIND = 'reviewer_roster.mutate';
export const REVIEWER_ROSTER_CHANGESET_VERSION = 1;

export interface ReviewerRosterChangesetAuthorInput {
  readonly request: ReviewerRosterMutationInput;
  readonly attribution: ReviewerRosterAttribution;
}

export interface ReviewerRosterChangesetReadPort
  extends ReviewerRosterRepository, ReviewerRosterPlanningSource {
  readReviewerRosterCompensationAttribution(
    scope: ReviewerRosterMutationInput['scope']
  ): ReviewerRosterAttribution | undefined;
}

export interface ReviewerRosterChangesetTransactionPort
  extends ReviewerRosterTransactionRepository, ReviewerRosterPlanningSource {}

export const reviewerRosterChangesetReadPort =
  defineChangesetReadPort<ReviewerRosterChangesetReadPort>('reviewer_roster.read', 1);
export const reviewerRosterChangesetValidationPort =
  defineChangesetValidationPort<ReviewerRosterChangesetReadPort>('reviewer_roster.validation', 1);
export const reviewerRosterChangesetTransactionPort =
  defineChangesetTransactionPort<ReviewerRosterChangesetTransactionPort>(
    'reviewer_roster.transaction', 1
  );

const attributionSchema = z.strictObject({
  userId: reviewIdSchema,
  occurredAt: reviewInstantSchema
});
const authorInputSchema = defineChangesetSchema({
  key: 'reviewer_roster.author_input',
  version: 1,
  schema: z.strictObject({ request: reviewerRosterMutationInputSchema, attribution: attributionSchema })
});
const planSchema = defineChangesetSchema({
  key: 'reviewer_roster.plan', version: 1, schema: reviewerRosterMutationPlanSchema
});
const diffSchema = defineChangesetSchema({
  key: 'reviewer_roster.safe_diff', version: 1, schema: reviewerRosterSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'reviewer_roster.result', version: 1, schema: reviewerRosterMutationResultSchema
});
const refusalSchema = defineChangesetSchema({
  key: 'reviewer_roster.changed_detail',
  version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope', 'roster_missing', 'stale_roster', 'authority_unavailable',
      'authority_changed', 'reviewer_not_eligible', 'reviewer_exists', 'reviewer_missing',
      'stale_reviewer', 'reviewer_revoked', 'already_revoked', 'not_revoked', 'scope_targets_unavailable',
      'scope_targets_changed', 'scope_target_missing', 'scope_target_retired', 'invalid_plan'
    ]),
    action: z.enum(['register', 'set_scope', 'revoke', 'restore']),
    reviewerId: reviewIdSchema
  })
});

type ReviewerRosterDefinition = ChangesetOperationDefinition<
  ReviewerRosterChangesetAuthorInput,
  ReviewerRosterMutationPlanDto,
  ReviewerRosterSafeDiff,
  ReviewerRosterMutationPlanDto,
  ReviewerRosterMutationResult
>;

export interface ReviewerRosterChangesetBundle {
  readonly definition: ReviewerRosterDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

export function createReviewerRosterChangesetBundle(): ReviewerRosterChangesetBundle {
  const definition: ReviewerRosterDefinition = {
    kind: REVIEWER_ROSTER_CHANGESET_KIND,
    version: REVIEWER_ROSTER_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [reviewerRosterChangesetReadPort],
    validationPorts: [reviewerRosterChangesetValidationPort],
    transactionPorts: [reviewerRosterChangesetTransactionPort],
    allowedAggregateKinds: ['reviewer_roster', 'reviewer'],
    allowedGuardKinds: [
      'reviewer_roster', 'reviewer_authority_set', 'reviewer_authority',
      'reviewer_scope_targets', 'reviewer_scope_target'
    ],
    allowedRisks: ['consequential'],
    allowedConsequences: ['reviewer_roster_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'reviewer_roster_changed',
      retryable: false,
      detailSchema: refusalSchema.reference
    }],
    allowedFacts: [{ kind: 'reviewer_roster_changed', version: 1 }],
    allowedEffects: [],
    plan(input, snapshot) {
      const port = snapshot.getPort(reviewerRosterChangesetReadPort);
      const plan = planReviewerRosterMutation(input.request, {
        environment: { repository: port, sources: port },
        attribution: input.attribution
      });
      return {
        plan,
        aggregateRefs: aggregateRefs(plan),
        guardRefs: guardRefs(plan),
        riskTier: 'consequential',
        consequences: ['reviewer_roster_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: projectReviewerRosterSafeDiff(plan),
        representedConsequences: ['reviewer_roster_changed']
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(reviewerRosterChangesetValidationPort);
      const code = validateReviewerRosterMutationPlan(plan, {
        repository: port,
        sources: port
      });
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const port = transaction.getPort(reviewerRosterChangesetTransactionPort);
      return {
        result: applyReviewerRosterMutationPlan({
          plan,
          environment: { repository: port, sources: port }
        }),
        facts: [reviewerRosterMutationFact(plan)],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot): CompensationDerivation<ReviewerRosterChangesetAuthorInput> {
      return deriveCompensation(plan, snapshot.getPort(reviewerRosterChangesetReadPort));
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorInputSchema, planSchema, diffSchema, resultSchema, refusalSchema],
      definitions: [definition]
    })
  });
}

function aggregateRefs(plan: ReviewerRosterMutationPlanDto) {
  const refs: { id: string; version: number }[] = [{
    id: reviewerRosterGuardId(plan.input.scope.eventId),
    version: plan.roster.beforeVersion
  }];
  if (plan.before) refs.push({ id: `reviewer:${plan.before.reviewerId}`, version: plan.before.version });
  return refs;
}

function guardRefs(plan: ReviewerRosterMutationPlanDto) {
  return [
    {
      id: reviewerRosterGuardId(plan.input.scope.eventId),
      version: plan.roster.beforeVersion,
      digest: plan.roster.beforeDigestSha256
    },
    { ...plan.authoritySetGuard, digest: plan.authoritySetGuard.digestSha256 },
    { ...plan.authorityFactGuard, digest: plan.authorityFactGuard.digestSha256 },
    { ...plan.targetSetGuard, digest: plan.targetSetGuard.digestSha256 },
    ...plan.targetGuards.map((guard) => ({ ...guard, digest: guard.digestSha256 }))
  ].map(({ id, version, digest }) => ({ id, version, digest }));
}

function refusal(code: ReviewerRosterPlanningErrorCode, plan: ReviewerRosterMutationPlanDto) {
  return {
    class: 'stale_revision' as const,
    kind: 'reviewer_roster_changed',
    retryable: false,
    subjects: [{ type: 'reviewer', id: plan.input.reviewerId }],
    detail: { code, action: plan.action, reviewerId: plan.input.reviewerId },
    detailSchemaVersion: 1
  };
}

function deriveCompensation(
  plan: ReviewerRosterMutationPlanDto,
  port: ReviewerRosterChangesetReadPort
): CompensationDerivation<ReviewerRosterChangesetAuthorInput> {
  const stateValue = port.readReviewerRoster(plan.input.scope);
  if (!stateValue) return { kind: 'blocked', reasonKey: 'reviewer_roster.scope_missing' };
  let state;
  try { state = parseReviewerRosterState(stateValue); } catch {
    return { kind: 'blocked', reasonKey: 'reviewer_roster.source_changed' };
  }
  const current = state.reviewers.find((reviewer) => reviewer.reviewerId === plan.after.reviewerId);
  if (state.version !== plan.roster.afterVersion || !current
      || canonicalJsonSha256(current) !== canonicalJsonSha256(plan.after)) {
    return { kind: 'blocked', reasonKey: 'reviewer_roster.later_change' };
  }
  const common = {
    scope: plan.input.scope,
    reviewerId: plan.after.reviewerId,
    expectedReviewerVersion: current.version,
    expectedRosterVersion: state.version,
    expectedRosterDigestSha256: state.digestSha256
  };
  const request: ReviewerRosterMutationInput = plan.action === 'register'
    ? { action: 'revoke', ...common }
    : plan.action === 'set_scope'
      ? { action: 'set_scope', ...common, reviews: plan.before?.reviews ?? [] }
      : plan.action === 'revoke'
        ? { action: 'restore', ...common }
        : { action: 'revoke', ...common };
  const attribution = port.readReviewerRosterCompensationAttribution(plan.input.scope);
  if (!attribution) {
    return { kind: 'blocked', reasonKey: 'reviewer_roster.fresh_attribution_required' };
  }
  return {
    kind: 'exact',
    authorInput: { request, attribution }
  };
}
