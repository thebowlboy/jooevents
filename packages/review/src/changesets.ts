import {
  reviewMutationPlanSchema,
  reviewMutationPlanningInputSchema,
  reviewMutationResultSchema,
  reviewSafeDiffSchema,
  type ReviewMutationPlanDto,
  type ReviewMutationPlanningInput,
  type ReviewMutationResult,
  type ReviewSafeDiff,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  canonicalJsonSha256,
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
  applyReviewMutationPlan,
  planReviewMutation,
  projectReviewSafeDiff,
  reviewCatalogGuardId,
  reviewMutationFact,
  validateReviewMutationPlan,
  type ReviewPlanningErrorCode
} from './domain';
import type {
  ReviewPlanningSource,
  ReviewRepository,
  ReviewTransactionRepository
} from './model';

export const REVIEW_CORE_CHANGESET_KIND = 'review.core.mutate';
export const REVIEW_CORE_CHANGESET_VERSION = 1;

export interface ReviewChangesetReadPort extends ReviewRepository, ReviewPlanningSource {}
export interface ReviewChangesetTransactionPort extends ReviewTransactionRepository, ReviewPlanningSource {}

export const reviewChangesetReadPort = defineChangesetReadPort<ReviewChangesetReadPort>(
  'review_core.read', 1
);
export const reviewChangesetValidationPort = defineChangesetValidationPort<ReviewChangesetReadPort>(
  'review_core.validation', 1
);
export const reviewChangesetTransactionPort =
  defineChangesetTransactionPort<ReviewChangesetTransactionPort>('review_core.transaction', 1);

const authorInputSchema = defineChangesetSchema({
  key: 'review.core.author_input', version: 1, schema: reviewMutationPlanningInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'review.core.plan', version: 1, schema: reviewMutationPlanSchema
});
const diffSchema = defineChangesetSchema({
  key: 'review.core.safe_diff', version: 1, schema: reviewSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'review.core.result', version: 1, schema: reviewMutationResultSchema
});
const staleDetailSchema = defineChangesetSchema({
  key: 'review.core.stale_detail',
  version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope', 'stale_catalog', 'open_round_exists', 'no_assignments',
      'assignment_seed_mismatch', 'deadline_missing', 'round_missing', 'stale_round',
      'round_not_open', 'round_has_work', 'assignment_missing', 'stale_assignment',
      'assignment_not_active', 'not_assigned_reviewer', 'draft_missing', 'stale_draft',
      'review_exists', 'review_missing', 'stale_review', 'revision_missing',
      'invalid_scores', 'candidate_query_changed', 'reviewer_query_changed',
      'deadline_changed', 'invalid_plan'
    ]),
    action: z.enum([
      'open_round', 'discard_empty_round', 'step_back', 'commit_review', 'amend_review'
    ]),
    subjectId: z.string().trim().min(1).max(512)
  })
});

type ReviewCoreDefinition = ChangesetOperationDefinition<
  ReviewMutationPlanningInput,
  ReviewMutationPlanDto,
  ReviewSafeDiff,
  ReviewMutationPlanDto,
  ReviewMutationResult
>;

export interface ReviewChangesetBundle {
  readonly definition: ReviewCoreDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

export function createReviewChangesetBundle(): ReviewChangesetBundle {
  const definition: ReviewCoreDefinition = {
    kind: REVIEW_CORE_CHANGESET_KIND,
    version: REVIEW_CORE_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [reviewChangesetReadPort],
    validationPorts: [reviewChangesetValidationPort],
    transactionPorts: [reviewChangesetTransactionPort],
    allowedAggregateKinds: [
      'review_catalog', 'review_round', 'review_assignment', 'review_draft', 'review_head'
    ],
    allowedGuardKinds: [
      'review_catalog', 'review_candidates', 'review_reviewers', 'review_deadline',
      'review_head_absence'
    ],
    allowedRisks: ['normal'],
    allowedConsequences: [
      'review_round_opened', 'review_round_discarded', 'review_assignment_stepped_back',
      'review_committed', 'review_amended'
    ],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'review_core_changed',
      retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [
      { kind: 'review_round_opened', version: 1 },
      { kind: 'review_round_discarded', version: 1 },
      { kind: 'review_assignment_stepped_back', version: 1 },
      { kind: 'review_committed', version: 1 },
      { kind: 'review_amended', version: 1 }
    ],
    allowedEffects: [],
    plan(input, snapshot) {
      const read = snapshot.getPort(reviewChangesetReadPort);
      const plan = planReviewMutation(input, { repository: read, sources: read });
      return {
        plan,
        aggregateRefs: aggregateRefs(plan),
        guardRefs: guardRefs(plan),
        riskTier: 'normal',
        consequences: [consequenceFor(plan.action)]
      };
    },
    projectDiff(plan) {
      return {
        diff: projectReviewSafeDiff(plan),
        representedConsequences: [consequenceFor(plan.action)]
      };
    },
    validateWithin(plan, validation) {
      const read = validation.getPort(reviewChangesetValidationPort);
      const code = validateReviewMutationPlan(plan, { repository: read, sources: read });
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const repository = transaction.getPort(reviewChangesetTransactionPort);
      const result = applyReviewMutationPlan({ plan, transaction: repository, sources: repository });
      const fact = reviewMutationFact(plan);
      return { result, facts: [fact], effects: [] };
    },
    deriveCompensation(plan): CompensationDerivation<ReviewMutationPlanningInput> {
      if (plan.action === 'commit_review' || plan.action === 'amend_review') {
        return { kind: 'irreversible', remediationKey: 'review.forward_correction_required' };
      }
      return { kind: 'blocked', reasonKey: 'review.explicit_forward_change_required' };
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

function aggregateRefs(plan: ReviewMutationPlanDto): readonly { id: string; version: number }[] {
  if (plan.action === 'open_round') {
    return [{ id: `review_catalog:${plan.input.scope.eventId}`, version: plan.catalog.beforeVersion }];
  }
  if (plan.action === 'discard_empty_round') {
    return [
      { id: `review_catalog:${plan.input.scope.eventId}`, version: plan.catalog.beforeVersion },
      { id: `review_round:${plan.before.id}`, version: plan.before.version }
    ];
  }
  if (plan.action === 'step_back') {
    return [
      { id: `review_assignment:${plan.before.id}`, version: plan.before.version }
    ];
  }
  if (plan.action === 'commit_review') {
    return [
      { id: `review_assignment:${plan.assignment.id}`, version: plan.assignment.version },
      { id: `review_draft:${plan.draft.assignmentId}`, version: plan.draft.version }
    ];
  }
  return [
    { id: `review_assignment:${plan.assignment.id}`, version: plan.assignment.version },
    { id: `review_head:${plan.before.assignmentId}`, version: plan.before.version }
  ];
}

function guardRefs(plan: ReviewMutationPlanDto): readonly {
  id: string;
  version: number;
  digest: string;
}[] {
  if (plan.action === 'open_round') {
    return [
      {
        id: reviewCatalogGuardId(plan.input.scope.eventId),
        version: plan.catalog.beforeVersion,
        digest: plan.catalog.beforeDigestSha256
      },
      { id: plan.candidateGuard.id, version: plan.candidateGuard.version, digest: plan.candidateGuard.digestSha256 },
      { id: plan.reviewerGuard.id, version: plan.reviewerGuard.version, digest: plan.reviewerGuard.digestSha256 },
      { id: plan.deadlineGuard.id, version: plan.deadlineGuard.version, digest: plan.deadlineGuard.digestSha256 }
    ];
  }
  if (plan.action === 'discard_empty_round') {
    return [{
      id: reviewCatalogGuardId(plan.input.scope.eventId),
      version: plan.catalog.beforeVersion,
      digest: plan.catalog.beforeDigestSha256
    }];
  }
  if (plan.action === 'commit_review') {
    return [{
      id: `review_head_absence:${plan.assignment.id}`,
      version: 1,
      digest: absentReviewHeadDigest(plan.input.scope, plan.assignment.id)
    }];
  }
  return [];
}

export function absentReviewHeadDigest(scope: ReviewScopeDto, assignmentId: string): string {
  return canonicalJsonSha256({ scope, assignmentId, state: 'absent' });
}

function consequenceFor(action: ReviewMutationPlanDto['action']): string {
  if (action === 'open_round') return 'review_round_opened';
  if (action === 'discard_empty_round') return 'review_round_discarded';
  if (action === 'step_back') return 'review_assignment_stepped_back';
  return action === 'commit_review' ? 'review_committed' : 'review_amended';
}

function refusal(code: ReviewPlanningErrorCode, plan: ReviewMutationPlanDto) {
  return {
    class: 'stale_revision' as const,
    kind: 'review_core_changed',
    retryable: false,
    subjects: [{ type: subjectType(plan), id: subjectId(plan) }],
    detail: { code, action: plan.action, subjectId: subjectId(plan) },
    detailSchemaVersion: 1
  };
}

function subjectType(plan: ReviewMutationPlanDto): string {
  return plan.action === 'open_round' || plan.action === 'discard_empty_round'
    ? 'review_round'
    : plan.action === 'step_back'
      ? 'review_assignment'
      : 'review';
}

function subjectId(plan: ReviewMutationPlanDto): string {
  if (plan.action === 'open_round') return plan.round.id;
  if (plan.action === 'discard_empty_round') return plan.after.id;
  if (plan.action === 'step_back') return plan.after.id;
  return plan.assignment.id;
}
