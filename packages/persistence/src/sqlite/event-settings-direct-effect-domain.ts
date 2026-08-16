import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
  EVENT_SETTINGS_UPDATE_OPERATION,
  eventSettingsDirectUpdatePlanSchema,
  sealEventSettingsDirectUpdateSnapshot
} from '@jooevents/event-operations';
import { parseEventId, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type {
  SQLiteEffectDomainAdapter,
  SQLiteEffectDomainAdapterRegistration
} from './foundation-trial-uow';
import { SQLiteEventSettingsRepository } from './event-settings';

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY.key
    && value.version === EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId
    )
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId
    );
}

export class SQLiteEventSettingsDirectEffectDomainAdapter
implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #repository: SQLiteEventSettingsRepository;

  constructor(private readonly sqlite: Database, workspaceId: WorkspaceId) {
    this.#workspaceId = parseWorkspaceId(workspaceId);
    this.#repository = new SQLiteEventSettingsRepository(sqlite);
  }

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.sqlite.inTransaction) {
      throw new TypeError('event_settings_direct_transaction_required');
    }
    if (!exactCapability(capability)) {
      throw new TypeError('event_settings_direct_capability_mismatch');
    }
    if (context.operation.name !== EVENT_SETTINGS_UPDATE_OPERATION.name
        || context.operation.version !== EVENT_SETTINGS_UPDATE_OPERATION.version
        || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('event_settings_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== EVENT_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== EVENT_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) {
      throw new TypeError('event_settings_direct_authority_mismatch');
    }
    const eventId = parseEventId(context.scope.eventId);
    return sealEventSettingsDirectUpdateSnapshot({
      capability,
      context,
      state: this.#repository.readEventSettings({
        workspaceId: this.#workspaceId,
        eventId
      })
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.sqlite.inTransaction) {
      throw new TypeError('event_settings_direct_transaction_required');
    }
    const parsed = eventSettingsDirectUpdatePlanSchema.parse(
      (contribution as { readonly kind?: unknown; readonly plan?: unknown })?.plan
    );
    if ((contribution as { readonly kind?: unknown })?.kind !== 'event_settings_direct_update') {
      throw new TypeError('event_settings_direct_contribution_invalid');
    }
    this.#repository.applyEventSettingsUpdatePlan(
      parsed
    );
  }
}

export function createSQLiteEventSettingsDirectEffectDomainRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
}): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
    adapter: new SQLiteEventSettingsDirectEffectDomainAdapter(input.sqlite, input.workspaceId)
  });
}
