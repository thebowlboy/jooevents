import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  reviewEvaluationChangeDraftInputSchema,
  reviewMutationPlanningInputSchema,
  reviewMutationResultSchema,
  reviewRoundChangeDraftInputSchema,
  reviewStepBackChangeDraftInputSchema,
  type ReviewCriterionDto,
  type ReviewMutationPlanDto,
  type ReviewMutationResult,
  type ReviewScopeDto
} from '@jooevents/contracts/reviews';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  isApplicationId,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import { reviewDueDeadlinePin } from '@jooevents/deadline';
import {
  applyReviewMutationPlan,
  createDefaultReviewCriteria,
  expectedReviewAssignmentPairs,
  planReviewMutation,
  ReviewPlanningError
} from '@jooevents/review';
import {
  REVIEW_ASSIGNMENT_STEP_BACK_OPERATION,
  REVIEW_DIRECT_HANDLER_CAPABILITY,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_EVALUATE_PERMISSION_IDS,
  REVIEW_EVALUATION_CHANGE_OPERATION,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_MANAGE_PERMISSION_IDS,
  REVIEW_ROUND_CHANGE_OPERATION,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  REVIEW_STEP_BACK_PERMISSION_IDS,
  reviewDirectContributionSchema,
  reviewOpenRoundVisibilityPolicy,
  sealReviewDirectPreparation,
  type ReviewDirectAction
} from '@jooevents/review-operations';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteReviewRepository } from './review';

export interface SQLiteReviewDirectIds {
  newRoundId(): string;
  newDeadlineId(): string;
  newCriterionId(): string;
  newAssignmentId(): string;
  newReviewRevisionId(): string;
}

const ID_METHODS = Object.freeze([
  'newRoundId', 'newDeadlineId', 'newCriterionId', 'newAssignmentId',
  'newReviewRevisionId'
] as const);

const OPERATION_SPECS = Object.freeze([
  Object.freeze({
    operation: REVIEW_ROUND_CHANGE_OPERATION,
    policy: REVIEW_MANAGE_ACCESS_POLICY,
    permissions: REVIEW_MANAGE_PERMISSION_IDS,
    needsReviewer: false,
    actions: Object.freeze(['open_round', 'discard_empty_round'] as const),
    parse: (value: unknown) => reviewRoundChangeDraftInputSchema.parse(value)
  }),
  Object.freeze({
    operation: REVIEW_ASSIGNMENT_STEP_BACK_OPERATION,
    policy: REVIEW_STEP_BACK_ACCESS_POLICY,
    permissions: REVIEW_STEP_BACK_PERMISSION_IDS,
    needsReviewer: true,
    actions: Object.freeze(['step_back'] as const),
    parse: (value: unknown) => reviewStepBackChangeDraftInputSchema.parse(value)
  }),
  Object.freeze({
    operation: REVIEW_EVALUATION_CHANGE_OPERATION,
    policy: REVIEW_EVALUATE_ACCESS_POLICY,
    permissions: REVIEW_EVALUATE_PERMISSION_IDS,
    needsReviewer: true,
    actions: Object.freeze(['commit_review', 'amend_review'] as const),
    parse: (value: unknown) => reviewEvaluationChangeDraftInputSchema.parse(value)
  })
]);

type OperationSpec = (typeof OPERATION_SPECS)[number];

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return context.scope.subjects.length === (eventId === undefined ? 1 : 2)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && (eventId === undefined || context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    ));
}

function applicationId(value: string, label: string): string {
  if (!isApplicationId(value)) throw new TypeError(`review_direct_${label}_invalid`);
  return value;
}

function outcome(kind: 'review.event_required' | 'review.viewer_required') {
  return reviewDirectContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind, retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

function planningRefusal(
  error: ReviewPlanningError,
  action: ReviewDirectAction,
  subjectId: string
) {
  const subjectType = action === 'open_round' || action === 'discard_empty_round'
    ? 'review_round'
    : action === 'step_back'
      ? 'review_assignment'
      : 'review';
  return reviewDirectContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'review.canonical_changed', retryable: false,
        subjects: [{ type: subjectType, id: subjectId }],
        detail: { code: error.code, action, subjectId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

function resultFor(plan: ReviewMutationPlanDto): ReviewMutationResult {
  if (plan.action === 'open_round') {
    return reviewMutationResultSchema.parse({
      action: plan.action,
      round: plan.round,
      assignmentCount: plan.assignments.length
    });
  }
  if (plan.action === 'discard_empty_round') {
    return reviewMutationResultSchema.parse({ action: plan.action, round: plan.after });
  }
  if (plan.action === 'step_back') {
    return reviewMutationResultSchema.parse({ action: plan.action, assignment: plan.after });
  }
  return reviewMutationResultSchema.parse({
    action: plan.action,
    head: plan.after,
    revision: plan.revision
  });
}

export class SQLiteReviewDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #ids: SQLiteReviewDirectIds;
  readonly #issuedIds = new Set<string>();
  #prepared: { readonly plan: ReviewMutationPlanDto } | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteReviewRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteReviewDirectIds;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
    for (const method of ID_METHODS) {
      if (typeof input.ids[method] !== 'function') {
        throw new TypeError('review_direct_id_factory_invalid');
      }
    }
    this.#ids = Object.freeze(Object.fromEntries(
      ID_METHODS.map((method) => [method, input.ids[method].bind(input.ids)])
    ) as unknown as SQLiteReviewDirectIds);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('review_direct_transaction_required');
    if (!sameReference(capability, REVIEW_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('review_direct_capability_mismatch');
    }
    const spec = OPERATION_SPECS.find((candidate) =>
      candidate.operation.name === context.operation.name
      && candidate.operation.version === context.operation.version
    );
    if (!spec || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('review_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !sameReference(authority.lane.policy, spec.policy)
        || !spec.permissions.every((permissionId) => authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === permissionId
        ))) {
      throw new TypeError('review_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const membershipId = authority.principal.membershipId;
    this.#prepared = undefined;
    return sealReviewDirectPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ action, businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !spec.actions.includes(action as never)
              || !this.input.sqlite.inTransaction) {
            throw new TypeError('review_direct_context_substitution');
          }
          const wire = spec.parse(businessInput);
          if (wire.action !== action) throw new TypeError('review_direct_action_mismatch');
          const eventId = context.scope.eventId;
          if (eventId === undefined) return outcome('review.event_required');
          const parsedEventId = parseEventId(eventId);
          const current = new SQLiteEventSpineRepository(this.input.sqlite)
            .readCurrentEventState(this.input.workspaceId);
          const relationship = this.input.eventRelationships.validateEvent({
            sqlite: this.input.sqlite,
            workspaceId: this.input.workspaceId,
            eventId: parsedEventId,
            userId: actorUserId,
            evaluatedAt
          });
          if (relationship.kind !== 'valid'
              || current?.currentEvent?.id !== parsedEventId
              || current.currentEvent.workspaceId !== this.input.workspaceId) {
            throw new TypeError('review_direct_event_relationship_mismatch');
          }
          return this.prepare({
            action,
            businessInput: wire,
            eventId: parsedEventId,
            actorUserId,
            membershipId,
            evaluatedAt
          });
        }
      }
    });
  }

  private prepare(input: {
    readonly action: ReviewDirectAction;
    readonly businessInput: ReturnType<OperationSpec['parse']>;
    readonly eventId: EventId;
    readonly actorUserId: UserId;
    readonly membershipId: string;
    readonly evaluatedAt: Instant;
  }) {
    const scope: ReviewScopeDto = {
      workspaceId: this.input.workspaceId,
      eventId: input.eventId
    };
    const needsReviewer = input.action === 'step_back'
      || input.action === 'commit_review'
      || input.action === 'amend_review';
    const reviewerId = needsReviewer
      ? this.input.repository.resolveActingReviewer(scope, input.membershipId)
      : undefined;
    if (needsReviewer && reviewerId === undefined) return outcome('review.viewer_required');

    const attribution = {
      attributedByUserId: input.actorUserId,
      attributedAt: input.evaluatedAt
    };
    let authorValue: Record<string, unknown>;
    let subjectId: string;
    if (input.action === 'open_round') {
      const wire = reviewRoundChangeDraftInputSchema.parse(input.businessInput);
      if (wire.action !== 'open_round') throw new TypeError('review_direct_action_mismatch');
      const roundId = this.nextId('newRoundId');
      const criteria = wire.criteria ?? createDefaultReviewCriteria(
        this.nextId('newCriterionId') as ReviewCriterionDto['id']
      );
      const candidates = this.input.repository.readCandidates(scope);
      const roster = this.input.repository.readReviewerRoster(scope);
      const pairs = candidates && roster
        ? expectedReviewAssignmentPairs({
            candidates: candidates.candidates,
            reviewers: roster.reviewers
          })
        : [];
      authorValue = {
        action: input.action,
        scope,
        expectedCatalogVersion: this.input.repository.readCatalog(scope)?.version ?? 1,
        roundId,
        deadlineIdentity: { deadlineId: this.nextId('newDeadlineId') },
        deadlineDate: wire.deadlineDate,
        criteria,
        visibility: reviewOpenRoundVisibilityPolicy(wire.anonymized),
        assignmentIds: pairs.map((pair) => ({
          ...pair,
          assignmentId: this.nextId('newAssignmentId')
        })),
        ...attribution
      };
      subjectId = roundId;
    } else if (input.action === 'discard_empty_round') {
      const wire = reviewRoundChangeDraftInputSchema.parse(input.businessInput);
      if (wire.action !== 'discard_empty_round') throw new TypeError('review_direct_action_mismatch');
      const { action: _action, ...change } = wire;
      authorValue = { action: input.action, scope, ...change, ...attribution };
      subjectId = wire.roundId;
    } else if (input.action === 'step_back') {
      const wire = reviewStepBackChangeDraftInputSchema.parse(input.businessInput);
      const { action: _action, ...change } = wire;
      authorValue = { action: input.action, scope, ...change, reviewerId, ...attribution };
      subjectId = wire.assignmentId;
    } else if (input.action === 'commit_review') {
      const wire = reviewEvaluationChangeDraftInputSchema.parse(input.businessInput);
      if (wire.action !== 'commit_review') throw new TypeError('review_direct_action_mismatch');
      const { action: _action, ...change } = wire;
      authorValue = {
        action: input.action,
        scope,
        ...change,
        revisionId: this.nextId('newReviewRevisionId'),
        reviewerId,
        ...attribution
      };
      subjectId = wire.assignmentId;
    } else {
      const wire = reviewEvaluationChangeDraftInputSchema.parse(input.businessInput);
      if (wire.action !== 'amend_review') throw new TypeError('review_direct_action_mismatch');
      const { action: _action, ...change } = wire;
      authorValue = {
        action: input.action,
        scope,
        ...change,
        revisionId: this.nextId('newReviewRevisionId'),
        reviewerId,
        ...attribution
      };
      subjectId = wire.assignmentId;
    }

    try {
      const plan = planReviewMutation(
        reviewMutationPlanningInputSchema.parse(authorValue),
        {
          repository: this.input.repository,
          sources: this.input.repository,
          deadlines: this.input.repository
        }
      );
      const contribution = reviewDirectContributionSchema.parse({
        result: { kind: 'success', data: resultFor(plan) },
        domain: { kind: 'review_direct_change', plan },
        effectContributions: []
      });
      this.#prepared = { plan };
      return contribution;
    } catch (error) {
      if (error instanceof ReviewPlanningError) {
        return planningRefusal(error, input.action, subjectId);
      }
      throw error;
    }
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('review_direct_transaction_required');
    const domain = contribution as { readonly plan?: unknown };
    const prepared = this.#prepared;
    if (!prepared || canonicalJsonText(prepared.plan) !== canonicalJsonText(domain.plan)) {
      throw new TypeError('review_direct_preparation_invalid');
    }
    const plan = prepared.plan;
    reviewDirectContributionSchema.parse({
      result: { kind: 'success', data: resultFor(plan) },
      domain: contribution,
      effectContributions: []
    });
    if (plan.action === 'open_round') {
      const applied = this.input.repository.applyReviewDueDeadline(plan.deadlineContribution);
      if (canonicalJsonSha256(applied.pin)
          !== canonicalJsonSha256(reviewDueDeadlinePin(plan.deadlineContribution))) {
        throw new TypeError('review_due_deadline_apply_pin_changed');
      }
    }
    applyReviewMutationPlan({
      plan,
      transaction: this.input.repository,
      sources: this.input.repository
    });
  }

  private nextId(method: keyof SQLiteReviewDirectIds): string {
    const value = applicationId(this.#ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('review_direct_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createSQLiteReviewDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteReviewDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: REVIEW_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteReviewDirectEffectDomainAdapter(input)
  });
}
