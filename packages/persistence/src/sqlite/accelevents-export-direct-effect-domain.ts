import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  type EffectHandlerSnapshot, type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY,
  ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY,
  ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION,
  acceleventsExportConfigPlanSchema,
  sealAcceleventsExportConfigSnapshot
} from '@jooevents/program-export-operations';
import { parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import type { SQLiteIntakeRepository } from './intake';
import { SQLiteAcceleventsExportRepository } from './accelevents-export';
import type { SQLiteEffectDomainAdapter, SQLiteEffectDomainAdapterRegistration } from './foundation-trial-uow';

const same = (left: { readonly key: string; readonly version: number }, right: { readonly key: string; readonly version: number }) => left.key === right.key && left.version === right.version;

export class SQLiteAcceleventsExportDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #repository: SQLiteAcceleventsExportRepository;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly intake: Pick<SQLiteIntakeRepository, 'readSubmissionContact'>;
    readonly newConfigurationId: () => string;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
    this.#repository = new SQLiteAcceleventsExportRepository(input.sqlite, input.intake);
  }

  openHandlerSnapshot(capability: { readonly key: string; readonly version: number }, context: EffectInvocationContext, authorityRecheck: SealedEffectAuthorityRecheckResult): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction || !same(capability, ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY)) throw new TypeError('accelevents_export_config_capability_mismatch');
    if (context.operation.name !== ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION.name
        || context.operation.version !== ACCELEVENTS_EXPORT_CONFIG_SAVE_OPERATION.version
        || context.operation.effect !== 'commit' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !context.scope.eventId
        || context.scope.subjects.length !== 2
        || !context.scope.subjects.some((subject) => subject.kind === 'workspace' && subject.id === this.#workspaceId)
        || !context.scope.subjects.some((subject) => subject.kind === 'event' && subject.id === context.scope.eventId)) {
      throw new TypeError('accelevents_export_config_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http' || !same(authority.lane.policy, ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY)
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('accelevents_export_config_authority_mismatch');
    }
    return sealAcceleventsExportConfigSnapshot({
      capability,
      context,
      source: this.#repository.readSource({ workspaceId: this.#workspaceId, eventId: context.scope.eventId }),
      configurationId: this.input.newConfigurationId()
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('accelevents_export_config_transaction_required');
    const plan = acceleventsExportConfigPlanSchema.parse(contribution);
    this.#repository.saveConfiguration({
      scope: { workspaceId: this.#workspaceId, eventId: plan.request.eventId },
      request: plan.request,
      configurationId: plan.configurationId,
      actorUserId: plan.actorUserId,
      updatedAt: plan.updatedAt
    });
  }
}

export function createSQLiteAcceleventsExportDirectEffectDomainRegistration(input: ConstructorParameters<typeof SQLiteAcceleventsExportDirectEffectDomainAdapter>[0]): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({ capability: ACCELEVENTS_EXPORT_CONFIG_HANDLER_CAPABILITY, adapter: new SQLiteAcceleventsExportDirectEffectDomainAdapter(input) });
}
