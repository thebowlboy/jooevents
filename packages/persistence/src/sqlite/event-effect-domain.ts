import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { eventCreateInputSchema, eventSelectInputSchema } from '@jooevents/contracts';
import {
  EventPlanningError,
  eventCreateResult,
  eventSelectResult,
  parseEventCreatePlan,
  parseEventSelectPlan,
  planEventCreation,
  planEventSelection,
  type EventCreatePlan,
  type EventSelectPlan
} from '@jooevents/event';
import {
  EVENT_CREATE_HANDLER_CAPABILITY,
  EVENT_CREATE_OPERATION,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_SELECT_HANDLER_CAPABILITY,
  EVENT_SELECT_OPERATION,
  eventCreateContributionSchema,
  eventCreateDomainContributionSchema,
  eventSelectContributionSchema,
  eventSelectDomainContributionSchema,
  sealEventSelectPreparation,
  sealEventCreatePreparation
} from '@jooevents/event-operations';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSpineRepository } from './event-spine';

export interface SQLiteEventEffectDomainIds {
  newEventId(): string;
}

export interface SQLiteCreatedEventInitializer {
  initializeCreatedEvent(scope: {
    readonly workspaceId: WorkspaceId;
    readonly eventId: ReturnType<typeof parseEventId>;
  }): unknown;
}

interface PreparedEventCreate {
  readonly context: EffectInvocationContext;
  readonly plan: EventCreatePlan;
  phase: 'prepared' | 'applied';
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

/** Commits Event creation and all required Event-root initialization in one direct unit of work. */
export class SQLiteEventEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #repository: SQLiteEventSpineRepository;
  #prepared: PreparedEventCreate | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly ids: SQLiteEventEffectDomainIds;
    readonly createdEventInitializer?: SQLiteCreatedEventInitializer;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    if (typeof input.ids.newEventId !== 'function') {
      throw new TypeError('event_effect_id_factory_invalid');
    }
    if (input.createdEventInitializer !== undefined
        && typeof input.createdEventInitializer.initializeCreatedEvent !== 'function') {
      throw new TypeError('event_effect_initializer_invalid');
    }
    this.#repository = new SQLiteEventSpineRepository(input.sqlite);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('event_effect_transaction_required');
    if (!sameRef(capability, EVENT_CREATE_HANDLER_CAPABILITY)) {
      throw new TypeError('event_effect_capability_mismatch');
    }
    if (
      context.operation.name !== EVENT_CREATE_OPERATION.name
      || context.operation.version !== EVENT_CREATE_OPERATION.version
      || context.operation.effect !== 'commit'
      || context.surface !== 'operator_http'
      || context.scope.workspaceId !== this.#workspaceId
      || context.scope.eventId !== undefined
      || context.scope.subjects.length !== 1
      || context.scope.subjects[0]?.kind !== 'workspace'
      || context.scope.subjects[0].id !== this.#workspaceId
    ) throw new TypeError('event_effect_scope_mismatch');

    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (
      authority.actor.kind !== 'workspace_user'
      || authority.principal.kind !== 'workspace_user'
      || authority.actor.userId !== authority.principal.userId
      || context.actor.kind !== 'workspace_user'
      || context.actor.userId !== authority.actor.userId
      || authority.lane.kind !== 'operator'
      || authority.lane.surface !== 'operator_http'
      || !sameRef(authority.lane.policy, EVENT_MANAGE_ACCESS_POLICY)
      || !authority.grants.some((grant) =>
        grant.kind === 'permission' && grant.key === 'event.manage'
      )
    ) throw new TypeError('event_effect_authority_mismatch');

    const actorUserId = parseUserId(authority.actor.userId);
    this.#prepared = undefined;
    return sealEventCreatePreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('event_effect_context_substitution');
          }
          let plan: EventCreatePlan;
          try {
            plan = planEventCreation({
              eventSet: this.#repository.requireEventSet(this.#workspaceId),
              authorInput: eventCreateInputSchema.parse(businessInput),
              server: {
                workspaceId: this.#workspaceId,
                eventId: parseEventId(this.input.ids.newEventId()),
                createdByUserId: actorUserId,
                createdAt: evaluatedAt
              }
            });
          } catch (error) {
            if (error instanceof EventPlanningError) this.#prepared = undefined;
            throw error;
          }
          const contribution = eventCreateContributionSchema.parse({
            result: { kind: 'success', data: eventCreateResult(plan) },
            domain: { kind: 'event_create', plan },
            effectContributions: []
          });
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('event_effect_success_contribution_invalid');
          }
          this.#prepared = { context, plan, phase: 'prepared' };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('event_effect_transaction_required');
    const parsed = eventCreateDomainContributionSchema.parse(contribution);
    const prepared = this.#prepared;
    const plan = parseEventCreatePlan(parsed.plan);
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(plan) !== canonicalJsonText(prepared.plan)) {
      throw new TypeError('event_effect_preparation_invalid');
    }
    this.#repository.commitEventCreatePlan(plan);
    this.input.createdEventInitializer?.initializeCreatedEvent({
      workspaceId: this.#workspaceId,
      eventId: parseEventId(plan.after.id)
    });
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createSQLiteEventEffectDomainRegistration(input: ConstructorParameters<
  typeof SQLiteEventEffectDomainAdapter
>[0]): SQLiteEffectDomainAdapterRegistration & {
  readonly adapter: SQLiteEventEffectDomainAdapter;
} {
  return Object.freeze({
    capability: EVENT_CREATE_HANDLER_CAPABILITY,
    adapter: new SQLiteEventEffectDomainAdapter(input)
  });
}

interface PreparedEventSelect {
  readonly context: EffectInvocationContext;
  readonly plan: EventSelectPlan;
  phase: 'prepared' | 'applied';
}

/** Commits a workspace-current Event selection through the shared Event-set guard. */
export class SQLiteEventSelectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #repository: SQLiteEventSpineRepository;
  #prepared: PreparedEventSelect | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#repository = new SQLiteEventSpineRepository(input.sqlite);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('event_select_transaction_required');
    if (!sameRef(capability, EVENT_SELECT_HANDLER_CAPABILITY)) {
      throw new TypeError('event_select_capability_mismatch');
    }
    if (
      context.operation.name !== EVENT_SELECT_OPERATION.name
      || context.operation.version !== EVENT_SELECT_OPERATION.version
      || context.operation.effect !== 'commit'
      || context.surface !== 'operator_http'
      || context.scope.workspaceId !== this.#workspaceId
      || context.scope.eventId !== undefined
      || context.scope.subjects.length !== 1
      || context.scope.subjects[0]?.kind !== 'workspace'
      || context.scope.subjects[0].id !== this.#workspaceId
    ) throw new TypeError('event_select_scope_mismatch');

    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    if (
      authority.actor.kind !== 'workspace_user'
      || authority.principal.kind !== 'workspace_user'
      || authority.actor.userId !== authority.principal.userId
      || context.actor.kind !== 'workspace_user'
      || context.actor.userId !== authority.actor.userId
      || authority.lane.kind !== 'operator'
      || authority.lane.surface !== 'operator_http'
      || !sameRef(authority.lane.policy, EVENT_MANAGE_ACCESS_POLICY)
      || !authority.grants.some((grant) =>
        grant.kind === 'permission' && grant.key === 'event.manage'
      )
    ) throw new TypeError('event_select_authority_mismatch');

    this.#prepared = undefined;
    return sealEventSelectPreparation({
      capability,
      preparation: {
        prepare: ({ businessInput, context: receivedContext }) => {
          if (receivedContext !== context || !this.input.sqlite.inTransaction) {
            throw new TypeError('event_select_context_substitution');
          }
          const wire = eventSelectInputSchema.parse(businessInput);
          const plan = planEventSelection({
            eventSet: this.#repository.requireEventSet(this.#workspaceId),
            targetEvent: this.#repository.readEventHead({
              workspaceId: this.#workspaceId,
              eventId: wire.eventId
            }),
            authorInput: wire
          });
          const contribution = eventSelectContributionSchema.parse({
            result: { kind: 'success', data: eventSelectResult(plan) },
            domain: { kind: 'event_select', plan },
            effectContributions: []
          });
          if (contribution.result.kind !== 'success' || contribution.domain === null) {
            throw new TypeError('event_select_success_contribution_invalid');
          }
          this.#prepared = { context, plan, phase: 'prepared' };
          return contribution;
        }
      }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('event_select_transaction_required');
    const parsed = eventSelectDomainContributionSchema.parse(contribution);
    const plan = parseEventSelectPlan(parsed.plan);
    const prepared = this.#prepared;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(plan) !== canonicalJsonText(prepared.plan)) {
      throw new TypeError('event_select_preparation_invalid');
    }
    this.#repository.commitEventSelectPlan(plan);
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createSQLiteEventSelectEffectDomainRegistration(input: ConstructorParameters<
  typeof SQLiteEventSelectEffectDomainAdapter
>[0]): SQLiteEffectDomainAdapterRegistration & {
  readonly adapter: SQLiteEventSelectEffectDomainAdapter;
} {
  return Object.freeze({
    capability: EVENT_SELECT_HANDLER_CAPABILITY,
    adapter: new SQLiteEventSelectEffectDomainAdapter(input)
  });
}
