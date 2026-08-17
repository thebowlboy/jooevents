import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { engagementAuthorInputSchema, engagementMutationPlanSchema } from '@jooevents/contracts';
import {
  EngagementPlanningError,
  planEngagementMutation,
  resolveEngagementMutationPlanningInput
} from '@jooevents/engagement';
import {
  ENGAGEMENT_CHANGE_OPERATION,
  ENGAGEMENT_DIRECT_HANDLER_CAPABILITY,
  ENGAGEMENT_MANAGE_ACCESS_POLICY,
  engagementDirectContributionSchema,
  sealEngagementDirectPreparation
} from '@jooevents/engagement-operations';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { TASK_ENGAGEMENT_RESPONSE_COLLABORATOR, taskEngagementReadPort } from '@jooevents/tasks';
import { SQLiteEngagementRepository } from './engagement';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { SQLiteTaskRepository } from './tasks';
import type { SQLiteVerifiedInboxAttributionResolver } from './verified-inbox-attribution';

const same = (
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
) => left.key === right.key && left.version === right.version;

function exact(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === context.scope.eventId);
}

export class SQLiteEngagementDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly verifiedInboxAttribution?: SQLiteVerifiedInboxAttributionResolver;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction
        || !same(capability, ENGAGEMENT_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('engagement_direct_capability_mismatch');
    }
    if (context.operation.name !== ENGAGEMENT_CHANGE_OPERATION.name
        || context.operation.version !== ENGAGEMENT_CHANGE_OPERATION.version
        || context.operation.effect !== 'commit'
        || (context.surface !== 'operator_http' && context.surface !== 'provider_ingress')
        || context.scope.workspaceId !== this.#workspaceId
        || !exact(context)) {
      throw new TypeError('engagement_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    const operator = authority.actor.kind === 'workspace_user'
      && authority.principal.kind === 'workspace_user'
      && authority.actor.userId === authority.principal.userId
      && context.actor.kind === 'workspace_user' && context.actor.userId === authority.actor.userId
      && authority.lane.kind === 'operator' && authority.lane.surface === 'operator_http';
    const inbox = authority.actor.kind === 'verified_inbox_processing'
      && authority.principal.kind === 'verified_inbox_processing'
      && context.actor.kind === 'verified_inbox_processing'
      && authority.actor.inboxReceiptId === authority.principal.inboxReceiptId
      && context.actor.inboxReceiptId === authority.actor.inboxReceiptId
      && authority.lane.kind === 'verified_inbox' && authority.lane.surface === 'provider_ingress';
    if ((!operator && !inbox)
        || !same(authority.lane.policy, ENGAGEMENT_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('engagement_direct_authority_mismatch');
    }
    const scope = { workspaceId: this.#workspaceId, eventId: context.scope.eventId! };
    const actorUserId = authority.actor.kind === 'workspace_user'
      ? parseUserId(authority.actor.userId)
      : authority.actor.kind === 'verified_inbox_processing'
        ? this.input.verifiedInboxAttribution?.resolve({
          sourceConnectionId: authority.actor.sourceConnectionId,
          workspaceId: this.#workspaceId, eventId: scope.eventId, evaluatedAt: occurredAt
        }) : undefined;
    if (!actorUserId) throw new TypeError('engagement_direct_verified_inbox_attribution_missing');
    const current = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventState(this.#workspaceId);
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite,
      workspaceId: this.#workspaceId,
      eventId: scope.eventId,
      userId: actorUserId,
      evaluatedAt: occurredAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== scope.eventId) {
      throw new TypeError('engagement_direct_event_relationship_mismatch');
    }
    const engagements = new SQLiteEngagementRepository(this.input.sqlite);
    const tasks = new SQLiteTaskRepository(this.input.sqlite);
    return sealEngagementDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('engagement_direct_context_substitution');
        }
        const wire = engagementAuthorInputSchema.parse(businessInput);
        try {
          const planningInput = resolveEngagementMutationPlanningInput({
            authorInput: wire,
            scope,
            actorUserId,
            occurredAt
          });
          const plan = planEngagementMutation({
            planningInput,
            environment: { engagements }
          });
          const collaboration = TASK_ENGAGEMENT_RESPONSE_COLLABORATOR.plan(plan, {
            getPort(key) {
              if ((key as unknown) === taskEngagementReadPort) return tasks as never;
              throw new TypeError('engagement_direct_undeclared_read_port');
            }
          });
          return engagementDirectContributionSchema.parse({
            result: { kind: 'success', data: {
              action: plan.input.action,
              engagement: plan.after
            } },
            domain: {
              kind: 'engagement_direct',
              plan,
              ...(collaboration === undefined ? {} : { taskPlan: collaboration.plan })
            },
            effectContributions: []
          });
        } catch (error) {
          if (!(error instanceof EngagementPlanningError)) throw error;
          return engagementDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: 'stale_revision', kind: 'engagement.changed', retryable: false,
              subjects: [],
              detail: {
                code: error.code,
                engagementId: error.engagementId ?? wire.engagementId
              },
              detailSchemaVersion: 1
            } }, domain: null, effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction
        || (contribution as { readonly kind?: unknown })?.kind !== 'engagement_direct') {
      throw new TypeError('engagement_direct_contribution_invalid');
    }
    const candidate = contribution as { readonly plan?: unknown; readonly taskPlan?: unknown };
    const plan = engagementMutationPlanSchema.parse(candidate.plan);
    new SQLiteEngagementRepository(this.input.sqlite).applyEngagementPlan(plan);
    if (candidate.taskPlan !== undefined) {
      new SQLiteTaskRepository(this.input.sqlite).applyEngagementReconciliation(candidate.taskPlan as never);
    }
  }
}

export function createSQLiteEngagementDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteEngagementDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: ENGAGEMENT_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteEngagementDirectEffectDomainAdapter(input)
  });
}
