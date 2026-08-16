import type { Database } from 'bun:sqlite';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  fieldRegistryAddDraftRequestSchema,
  fieldRegistryEditDraftRequestSchema,
  fieldRegistryMoveDraftRequestSchema,
  fieldRegistryRemoveDraftRequestSchema,
  fieldRegistryRestoreDraftRequestSchema,
  type FieldRegistryChangeResult,
  type FieldRegistryDraftAction,
  type FieldRegistrySafeDiff
} from '@jooevents/contracts';
import {
  FieldRegistryPlanningError,
  fieldRegistryStableKeyFor,
  planFieldRegistryMutation,
  type FieldRegistryAuthorInput,
  type FieldRegistryMutationPlan
} from '@jooevents/field-registry';
import {
  FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  fieldRegistryDirectActionForOperation,
  fieldRegistryDirectContributionSchema,
  sealFieldRegistryDirectPreparation
} from '@jooevents/field-registry';
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
import {
  SQLiteFieldRegistryRepository,
  SQLiteIntakeFieldRegistryFormReferenceResolver
} from './field-registry';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

export interface SQLiteFieldRegistryDirectIds {
  newFieldId(): string;
  newChoiceId(): string;
}

function exactCapability(value: { readonly key: string; readonly version: number }): boolean {
  return value.key === FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY.key
    && value.version === FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY.version;
}

function applicationUuid(value: unknown, label: string): string {
  const parsed = typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
  if (!parsed) throw new TypeError(`field_registry_direct_${label}_invalid`);
  return parsed;
}

function authorInput(input: {
  readonly action: FieldRegistryDraftAction;
  readonly businessInput: unknown;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actorUserId: string;
  readonly evaluatedAt: string;
  readonly repository: SQLiteFieldRegistryRepository;
  readonly ids: SQLiteFieldRegistryDirectIds;
}): FieldRegistryAuthorInput {
  const scope = { workspaceId: input.workspaceId, eventId: input.eventId };
  if (input.action === 'add') {
    const request = fieldRegistryAddDraftRequestSchema.parse(input.businessInput);
    const fieldId = applicationUuid(input.ids.newFieldId(), 'field_id');
    const choices = request.field.options.kind === 'custom'
      ? request.field.options.labels.map((label) => {
          const id = applicationUuid(input.ids.newChoiceId(), 'choice_id');
          return { id, key: fieldRegistryStableKeyFor(label, id) };
        }) : [];
    if (new Set([fieldId, ...choices.map((choice) => choice.id)]).size !== choices.length + 1) {
      throw new TypeError('field_registry_direct_ids_not_unique');
    }
    return {
      action: 'add', scope, request,
      identities: {
        fieldId,
        fieldKey: fieldRegistryStableKeyFor(request.field.label, fieldId),
        choices
      }
    };
  }
  if (input.action === 'edit') {
    const request = fieldRegistryEditDraftRequestSchema.parse(input.businessInput);
    const previous = input.repository.readFieldRegistry(scope)?.fields
      .find((field) => field.id === request.fieldId);
    const priorByLabel = new Map(previous?.options.kind === 'custom'
      ? previous.options.choices.map((choice) => [choice.label.toLocaleLowerCase('en-US'), choice])
      : []);
    const choiceIdentities = request.changes.customOptionLabels?.map((label) => {
      const prior = priorByLabel.get(label.toLocaleLowerCase('en-US'));
      if (prior) return { id: prior.id, key: prior.key };
      const id = applicationUuid(input.ids.newChoiceId(), 'choice_id');
      return { id, key: fieldRegistryStableKeyFor(label, id) };
    }) ?? [];
    if (new Set(choiceIdentities.map((choice) => choice.id)).size !== choiceIdentities.length) {
      throw new TypeError('field_registry_direct_ids_not_unique');
    }
    return { action: 'edit', scope, request, choiceIdentities };
  }
  if (input.action === 'move') {
    return { action: 'move', scope, request: fieldRegistryMoveDraftRequestSchema.parse(input.businessInput) };
  }
  if (input.action === 'remove') {
    return {
      action: 'remove', scope,
      request: fieldRegistryRemoveDraftRequestSchema.parse(input.businessInput),
      removedAt: input.evaluatedAt,
      removedByUserId: input.actorUserId
    };
  }
  return { action: 'restore', scope, request: fieldRegistryRestoreDraftRequestSchema.parse(input.businessInput) };
}

function safeDiff(plan: FieldRegistryMutationPlan): FieldRegistrySafeDiff {
  const base = {
    registryVersionBefore: plan.expectedRegistryVersion,
    registryVersionAfter: plan.resultingRegistryVersion
  };
  if (plan.action === 'add') return { action: 'add', ...base, before: null, after: plan.after, placement: plan.placement };
  if (plan.action === 'edit') return { action: 'edit', ...base, before: plan.before, after: plan.after };
  if (plan.action === 'move') return { action: 'move', ...base, fieldId: plan.fieldId, fieldVersion: plan.fieldVersion, beforeIndex: plan.beforeIndex, afterIndex: plan.afterIndex };
  if (plan.action === 'remove') return { action: 'remove', ...base, before: plan.before, after: null };
  return { action: 'restore', ...base, before: null, after: plan.after, placement: plan.placement };
}

function resultFor(plan: FieldRegistryMutationPlan): FieldRegistryChangeResult {
  const field = plan.action === 'move' ? { id: plan.fieldId, version: plan.fieldVersion, position: plan.afterIndex }
    : plan.action === 'remove' ? { id: plan.before.id, version: plan.before.version, position: null }
      : { id: plan.after.id, version: plan.after.version, position: plan.after.position };
  return {
    schemaVersion: 1,
    action: plan.action,
    fieldId: field.id,
    registryVersion: plan.resultingRegistryVersion,
    fieldVersion: field.version,
    position: field.position
  };
}

function fieldId(author: FieldRegistryAuthorInput): string {
  return author.action === 'add' ? author.identities.fieldId : author.request.fieldId;
}

function refusal(error: FieldRegistryPlanningError, action: FieldRegistryDraftAction, author: FieldRegistryAuthorInput) {
  const stale = ['stale_registry', 'field_exists', 'field_missing', 'stale_field', 'field_removed', 'field_active', 'form_missing', 'form_changed'].includes(error.code);
  return fieldRegistryDirectContributionSchema.parse({
    result: { kind: 'outcome', outcome: {
      class: stale ? 'stale_revision' : 'policy_violation',
      kind: stale ? 'field_registry.changed' : 'field_registry.change_refused',
      retryable: false,
      subjects: [{ type: 'field_registry_field', id: fieldId(author) }],
      detail: { code: error.code, action, fieldId: fieldId(author) },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: []
  });
}

export class SQLiteFieldRegistryDirectEffectDomainAdapter implements SQLiteEffectDomainAdapter {
  #prepared: { readonly plan: FieldRegistryMutationPlan; readonly repository: SQLiteFieldRegistryRepository } | undefined;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventRelationships: SQLiteOperatorEventRelationshipSource;
    readonly ids: SQLiteFieldRegistryDirectIds;
  }) {}

  openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot {
    if (!this.input.sqlite.inTransaction) throw new TypeError('field_registry_direct_transaction_required');
    if (!exactCapability(capability)) throw new TypeError('field_registry_direct_capability_mismatch');
    const action = fieldRegistryDirectActionForOperation(context.operation.name, context.operation.version);
    if (!action || context.operation.effect !== 'commit' || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.input.workspaceId) {
      throw new TypeError('field_registry_direct_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user' || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user' || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator' || authority.lane.surface !== 'operator_http'
        || authority.lane.policy.key !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) => grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('field_registry_direct_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    this.#prepared = undefined;
    return sealFieldRegistryDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ action: receivedAction, businessInput, context: received }) => {
        if (received !== context || receivedAction !== action || !this.input.sqlite.inTransaction) {
          throw new TypeError('field_registry_direct_context_substitution');
        }
        const eventId = context.scope.eventId;
        if (eventId === undefined) {
          return fieldRegistryDirectContributionSchema.parse({
            result: { kind: 'outcome', outcome: { class: 'conflict', kind: 'field_registry.event_required', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } },
            domain: null,
            effectContributions: []
          });
        }
        const workspaceId = parseWorkspaceId(this.input.workspaceId);
        const parsedEventId = parseEventId(eventId);
        const current = new SQLiteEventSpineRepository(this.input.sqlite).readCurrentEventState(workspaceId);
        const relationship = this.input.eventRelationships.validateEvent({ sqlite: this.input.sqlite, workspaceId, eventId: parsedEventId, userId: actorUserId, evaluatedAt });
        if (relationship.kind !== 'valid' || current?.currentEvent?.id !== parsedEventId) {
          throw new TypeError('field_registry_direct_event_relationship_mismatch');
        }
        const repository = new SQLiteFieldRegistryRepository(
          this.input.sqlite,
          new SQLiteIntakeFieldRegistryFormReferenceResolver(this.input.sqlite)
        );
        const author = authorInput({ action, businessInput, workspaceId, eventId: parsedEventId, actorUserId, evaluatedAt, repository, ids: this.input.ids });
        try {
          const state = repository.readFieldRegistry({ workspaceId, eventId: parsedEventId });
          if (!state) throw new FieldRegistryPlanningError('wrong_scope');
          const plan = planFieldRegistryMutation({ state, author, formReferences: repository });
          const contribution = fieldRegistryDirectContributionSchema.parse({
            result: { kind: 'success', data: { action, mutation: resultFor(plan), safeDiff: safeDiff(plan) } },
            domain: { kind: 'field_registry_direct_change', plan },
            effectContributions: []
          });
          this.#prepared = { plan, repository };
          return contribution;
        } catch (error) {
          if (error instanceof FieldRegistryPlanningError && error.code !== 'wrong_scope') {
            return refusal(error, action, author);
          }
          throw error;
        }
      } }
    });
  }

  applyDomainContribution(contribution: unknown): void {
    if (!this.input.sqlite.inTransaction) throw new TypeError('field_registry_direct_transaction_required');
    const parsed = fieldRegistryDirectContributionSchema.parse({
      result: { kind: 'success', data: {
        action: (contribution as { readonly plan: FieldRegistryMutationPlan }).plan.action,
        mutation: resultFor((contribution as { readonly plan: FieldRegistryMutationPlan }).plan),
        safeDiff: safeDiff((contribution as { readonly plan: FieldRegistryMutationPlan }).plan)
      } },
      domain: contribution,
      effectContributions: []
    });
    if (parsed.result.kind !== 'success' || parsed.domain === null) throw new TypeError('field_registry_direct_contribution_invalid');
    const prepared = this.#prepared;
    if (!prepared || canonicalJsonText(prepared.plan) !== canonicalJsonText(parsed.domain.plan)) {
      throw new TypeError('field_registry_direct_preparation_invalid');
    }
    prepared.repository.applyFieldRegistryPlan(prepared.plan);
  }
}

export function createSQLiteFieldRegistryDirectEffectDomainRegistration(
  input: ConstructorParameters<typeof SQLiteFieldRegistryDirectEffectDomainAdapter>[0]
): SQLiteEffectDomainAdapterRegistration {
  return Object.freeze({
    capability: FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
    adapter: new SQLiteFieldRegistryDirectEffectDomainAdapter(input)
  });
}
