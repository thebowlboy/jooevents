import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  deadlineChangeDataSchema,
  deadlineChangeInputSchema,
  deadlineIdSchema,
  deadlineMutationPlanSchema,
  type DeadlineChangeInput,
  type DeadlineMutationPlanningInput
} from '@jooevents/contracts/deadlines';
import {
  DeadlinePlanningError,
  planDeadlineMutation
} from '@jooevents/deadline';
import {
  DEADLINE_CHANGE_HANDLER_CAPABILITY,
  DEADLINE_CHANGE_OPERATION,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_MANAGE_PERMISSION_ID,
  deadlineDirectContributionSchema,
  sealDeadlineDirectPreparation
} from '@jooevents/deadline-operations';
import { parseUserId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type { SQLiteEffectDomainAdapter, SQLiteEffectDomainAdapterRegistration } from './foundation-trial-uow';
import { SQLiteDeadlineRepository } from './deadline';
import { SQLiteEventSpineRepository } from './event-spine';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

function sameRef(left: { readonly key: string; readonly version: number }, right: { readonly key: string; readonly version: number }) {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  return context.scope.eventId !== undefined && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) => subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) => subject.kind === 'event' && subject.id === context.scope.eventId);
}

function refusal(error: DeadlinePlanningError, action: DeadlineChangeInput['action'], deadlineId: string) {
  return deadlineDirectContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: error.code === 'deadline_unchanged' ? 'conflict' : 'stale_revision',
      kind: error.code === 'deadline_unchanged' ? 'deadline.no_change' : 'deadline.canonical_changed',
      retryable: false,
      subjects: [{ type: 'deadline', id: deadlineId }],
      detail: error.code === 'deadline_unchanged' ? null : { code: error.code, action, deadlineId },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: []
  });
}

export interface SQLiteDeadlineDirectIds { newDeadlineId(): string }

export class SQLiteDeadlineDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly deadlineRead;
  readonly #workspaceId: WorkspaceId;
  readonly #repository: SQLiteDeadlineRepository;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteDeadlineDirectIds;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#repository = new SQLiteDeadlineRepository(input.sqlite, new SQLiteEventSpineRepository(input.sqlite));
    this.deadlineRead = Object.freeze({
      readDeadlineCatalog: this.#repository.readDeadlineCatalog.bind(this.#repository)
    });
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('deadline_direct_transaction_required');
    if (!sameRef(capability, DEADLINE_CHANGE_HANDLER_CAPABILITY)) throw new TypeError('deadline_direct_capability_mismatch');
    if (context.operation.name !== DEADLINE_CHANGE_OPERATION.name
        || context.operation.version !== DEADLINE_CHANGE_OPERATION.version
        || context.operation.effect !== 'commit' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !exactSubjects(context)) {
      throw new TypeError('deadline_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http'
        || !sameRef(authority.lane.policy, DEADLINE_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === DEADLINE_MANAGE_PERMISSION_ID)) {
      throw new TypeError('deadline_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId!;
    const current = new SQLiteEventSpineRepository(this.input.sqlite).readCurrentEventState(this.#workspaceId);
    const relationship = this.input.eventRelationships.validateEvent({
      sqlite: this.input.sqlite, workspaceId: this.#workspaceId, eventId,
      userId: actorUserId, evaluatedAt
    });
    if (relationship.kind !== 'valid' || current?.currentEvent?.id !== eventId) {
      throw new TypeError('deadline_direct_event_relationship_mismatch');
    }
    return sealDeadlineDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ businessInput, context: received }) => {
        if (received !== context || !this.input.sqlite.inTransaction) throw new TypeError('deadline_direct_context_substitution');
        const wire = deadlineChangeInputSchema.parse(businessInput);
        const deadlineId = wire.action === 'create' ? deadlineIdSchema.parse(this.input.ids.newDeadlineId()) : wire.deadlineId;
        const planningInput: DeadlineMutationPlanningInput = {
          ...wire,
          scope: { workspaceId: this.#workspaceId, eventId },
          deadlineId,
          attributedByUserId: actorUserId,
          attributedAt: evaluatedAt
        };
        const catalog = this.#repository.readDeadlineCatalog({ workspaceId: this.#workspaceId, eventId });
        if (!catalog) throw new TypeError('deadline_direct_catalog_missing');
        try {
          const eventTimeBasis = wire.action === 'clear' ? undefined
            : this.#repository.readDeadlineEventTimeBasis({ workspaceId: this.#workspaceId, eventId });
          const plan = planDeadlineMutation({ planningInput, catalog, ...(eventTimeBasis ? { eventTimeBasis } : {}) });
          return deadlineDirectContributionSchema.parse({
            result: { kind: 'success', data: deadlineChangeDataSchema.parse({
              schemaVersion: 1,
              action: plan.input.action,
              catalogVersion: plan.catalog.afterVersion,
              deadline: plan.after,
              pin: plan.after.status === 'active' ? {
                id: plan.after.id, version: plan.after.version, digestSha256: plan.after.digestSha256,
                effectiveAt: plan.after.effectiveAt, displayDate: plan.after.displayDate,
                gracePolicy: plan.after.gracePolicy
              } : null
            }) },
            domain: { kind: 'deadline_direct_change', plan },
            effectContributions: []
          });
        } catch (error) {
          if (error instanceof DeadlinePlanningError) return refusal(error, wire.action, deadlineId);
          throw error;
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('deadline_direct_transaction_required');
    if ((contribution as { readonly kind?: unknown })?.kind !== 'deadline_direct_change') {
      throw new TypeError('deadline_direct_contribution_invalid');
    }
    const plan = deadlineMutationPlanSchema.parse((contribution as { readonly plan?: unknown }).plan);
    this.#repository.applyDeadlinePlan(plan);
  }
}

export function createSQLiteDeadlineDirectEffectDomainRegistration(input: ConstructorParameters<typeof SQLiteDeadlineDirectEffectDomainAdapter>[0]): SQLiteEffectDomainAdapterRegistration & { readonly deadlineRead: SQLiteDeadlineDirectEffectDomainAdapter['deadlineRead'] } {
  const adapter = new SQLiteDeadlineDirectEffectDomainAdapter(input);
  return Object.freeze({ capability: DEADLINE_CHANGE_HANDLER_CAPABILITY, adapter, deadlineRead: adapter.deadlineRead });
}
