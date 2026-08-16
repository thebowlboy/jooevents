import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { decisionAuthorInputSchema, decisionMutationPlanSchema } from '@jooevents/contracts';
import {
  DecisionPlanningError,
  DecisionTargetUnavailableError,
  decisionMutationResultFromPlan,
  planDecisionMutation,
  resolveDecisionMutationPlanningInput
} from '@jooevents/decision';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import {
  DECISION_DECIDE_OPERATION,
  DECISION_DIRECT_HANDLER_CAPABILITY,
  DECISION_MANAGE_ACCESS_POLICY,
  decisionDirectContributionSchema,
  sealDecisionDirectPreparation
} from '@jooevents/decision-operations';
import type { SQLiteDecisionRepository } from './decision';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

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

export class SQLiteDecisionDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly repository: SQLiteDecisionRepository;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly newSessionId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction
        || !same(capability, DECISION_DIRECT_HANDLER_CAPABILITY)) {
      throw new TypeError('decision_direct_capability_mismatch');
    }
    if (context.operation.name !== DECISION_DECIDE_OPERATION.name
        || context.operation.version !== DECISION_DECIDE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exact(context)) {
      throw new TypeError('decision_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const occurredAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !same(authority.lane.policy, DECISION_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('decision_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const scope = { workspaceId: this.#workspaceId, eventId: context.scope.eventId! };
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
      throw new TypeError('decision_direct_event_relationship_mismatch');
    }
    return sealDecisionDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) {
          throw new TypeError('decision_direct_context_substitution');
        }
        const authorInput = decisionAuthorInputSchema.parse(businessInput);
        try {
          const planningInput = resolveDecisionMutationPlanningInput({
            authorInput,
            scope,
            actorUserId,
            occurredAt,
            environment: {
              decisions: this.input.repository,
              sessions: this.input.repository
            },
            newSessionId: this.input.newSessionId
          });
          const plan = planDecisionMutation({
            planningInput,
            environment: {
              decisions: this.input.repository,
              sessions: this.input.repository
            }
          });
          return decisionDirectContributionSchema.parse({
            result: { kind: 'success', data: decisionMutationResultFromPlan(plan) },
            domain: { kind: 'decision_direct', plan },
            effectContributions: []
          });
        } catch (error) {
          if (error instanceof DecisionTargetUnavailableError) {
            return decisionDirectContributionSchema.parse({
              result: { kind: 'outcome', outcome: {
                class: 'conflict', kind: 'decision.target_unavailable', retryable: false,
                subjects: [], detail: error.detail, detailSchemaVersion: 1
              } }, domain: null, effectContributions: []
            });
          }
          if (!(error instanceof DecisionPlanningError)) throw error;
          return decisionDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: {
              class: 'stale_revision', kind: 'decision.changed', retryable: false,
              subjects: [],
              detail: {
                code: error.code,
                submissionId: error.submissionId ?? authorInput.decisions[0]?.submissionId ?? scope.eventId
              },
              detailSchemaVersion: 2
            } }, domain: null, effectContributions: []
          });
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction
        || (contribution as { readonly kind?: unknown })?.kind !== 'decision_direct') {
      throw new TypeError('decision_direct_contribution_invalid');
    }
    const plan = decisionMutationPlanSchema.parse(
      (contribution as { readonly plan?: unknown }).plan
    );
    for (const row of plan.rows) {
      if (row.graduation !== null) this.input.repository.applySessionGraduation(row.graduation);
    }
    this.input.repository.applyDecisionPlan(plan);
  }
}

export function createSQLiteDecisionDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteDecisionDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: DECISION_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteDecisionDirectEffectDomainAdapter(input)
  });
}
