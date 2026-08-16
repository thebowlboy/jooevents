import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  reviewerRosterChangeDraftInputSchema,
  reviewerRosterMutationInputSchema,
  reviewerRosterMutationResultSchema,
  type ReviewerRosterMutationPlanDto
} from '@jooevents/contracts/reviewer-roster';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  applyReviewerRosterMutationPlan,
  planReviewerRosterMutation,
  ReviewerRosterPlanningError,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import {
  REVIEWER_ROSTER_CHANGE_OPERATION,
  REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
  REVIEWER_ROSTER_PERMISSION_IDS,
  reviewerRosterDirectContributionSchema,
  sealReviewerRosterDirectPreparation
} from '@jooevents/review-operations/roster';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteReviewerRosterRepository } from './reviewer-roster';

function sameReference(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function eventRequired() {
  return reviewerRosterDirectContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'conflict', kind: 'reviewer_roster.event_required', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

function refusal(error: ReviewerRosterPlanningError, input: {
  readonly action: 'register' | 'set_scope' | 'revoke' | 'restore';
  readonly reviewerId: string;
}) {
  return reviewerRosterDirectContributionSchema.parse({
    result: {
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'reviewer_roster.changed', retryable: false,
        subjects: [{ type: 'reviewer', id: input.reviewerId }],
        detail: { code: error.code, action: input.action, reviewerId: input.reviewerId },
        detailSchemaVersion: 1
      }
    },
    domain: null,
    effectContributions: []
  });
}

function resultFor(plan: ReviewerRosterMutationPlanDto) {
  return reviewerRosterMutationResultSchema.parse({
    schemaVersion: 1,
    action: plan.action,
    rosterVersion: plan.roster.afterVersion,
    rosterDigestSha256: plan.roster.afterDigestSha256,
    reviewer: plan.after
  });
}

export class SQLiteReviewerRosterDirectEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  #prepared: {
    readonly plan: ReviewerRosterMutationPlanDto;
    readonly repository: SQLiteReviewerRosterRepository;
  } | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly sources: ReviewerRosterPlanningSource;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
  }) {
    this.input = Object.freeze({ ...input, workspaceId: parseWorkspaceId(input.workspaceId) });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('reviewer_roster_direct_transaction_required');
    }
    if (!sameReference(capability, REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('reviewer_roster_direct_capability_mismatch');
    }
    if (context.operation.name !== REVIEWER_ROSTER_CHANGE_OPERATION.name
        || context.operation.version !== REVIEWER_ROSTER_CHANGE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId) {
      throw new TypeError('reviewer_roster_direct_scope_mismatch');
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
        || !sameReference(authority.lane.policy, REVIEWER_ROSTER_MANAGE_ACCESS_POLICY)
        || !REVIEWER_ROSTER_PERMISSION_IDS.every((permissionId) =>
          authority.grants.some((grant) => grant.kind === 'permission' && grant.key === permissionId))) {
      throw new TypeError('reviewer_roster_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    this.#prepared = undefined;
    return sealReviewerRosterDirectPreparation({
      capability,
      context,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('reviewer_roster_direct_context_substitution');
          }
          const wire = reviewerRosterChangeDraftInputSchema.parse(businessInput);
          const eventId = context.scope.eventId;
          if (eventId === undefined) return eventRequired();
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
            throw new TypeError('reviewer_roster_direct_event_relationship_mismatch');
          }
          const request = reviewerRosterMutationInputSchema.parse({
            ...wire,
            scope: { workspaceId: this.input.workspaceId, eventId: parsedEventId }
          });
          const repository = new SQLiteReviewerRosterRepository(
            this.input.sqlite,
            this.input.sources
          );
          try {
            const plan = planReviewerRosterMutation(request, {
              environment: { repository, sources: this.input.sources },
              attribution: { userId: actorUserId, occurredAt: evaluatedAt }
            });
            const contribution = reviewerRosterDirectContributionSchema.parse({
              result: { kind: 'success', data: resultFor(plan) },
              domain: { kind: 'reviewer_roster_direct_change', plan },
              effectContributions: []
            });
            this.#prepared = { plan, repository };
            return contribution;
          } catch (error) {
            if (error instanceof ReviewerRosterPlanningError) return refusal(error, wire);
            throw error;
          }
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) {
      throw new TypeError('reviewer_roster_direct_transaction_required');
    }
    const prepared = this.#prepared;
    const domain = contribution as { readonly plan?: unknown };
    if (!prepared || canonicalJsonText(prepared.plan) !== canonicalJsonText(domain.plan)) {
      throw new TypeError('reviewer_roster_direct_preparation_invalid');
    }
    reviewerRosterDirectContributionSchema.parse({
      result: { kind: 'success', data: resultFor(prepared.plan) },
      domain: contribution,
      effectContributions: []
    });
    applyReviewerRosterMutationPlan({
      plan: prepared.plan,
      environment: { repository: prepared.repository, sources: this.input.sources }
    });
  }
}

export function createSQLiteReviewerRosterDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteReviewerRosterDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: REVIEWER_ROSTER_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteReviewerRosterDirectEffectDomainAdapter(input)
  });
}
