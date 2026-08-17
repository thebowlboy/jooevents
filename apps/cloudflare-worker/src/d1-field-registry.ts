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
  type FieldRegistryOptionSource,
  type FieldRegistrySafeDiff,
  type FieldRegistryScopeDto
} from '@jooevents/contracts';
import {
  FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  FieldRegistryPlanningError,
  applyFieldRegistryMutationPlan,
  fieldRegistryDirectActionForOperation,
  fieldRegistryDirectContributionSchema,
  fieldRegistryStableKeyFor,
  fieldRegistryStateDigest,
  parseFieldRegistryState,
  planFieldRegistryMutation,
  projectFieldRegistrySnapshot,
  sealFieldRegistryDirectPreparation,
  type FieldRegistryAuthorInput,
  type FieldRegistryFormReference,
  type FieldRegistryFormReferenceResolver,
  type FieldRegistryLiveOption,
  type FieldRegistryMutationPlan,
  type FieldRegistryState
} from '@jooevents/field-registry';
import {
  canonicalJsonText,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';

interface AggregateRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly registry_version: number;
  readonly state_json: string;
  readonly state_digest_sha256: string;
  readonly baseline_digest_sha256: string;
}

interface EventSetRow {
  readonly version: number;
  readonly current_event_id: string | null;
}

interface FormHeadRow {
  readonly form_id: string;
  readonly head_version: number;
}

interface VocabularyRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly version: number;
}

type D1ReadSource = Pick<D1Database, 'prepare'> | Pick<D1DatabaseSession, 'prepare'>;

function stateFromRow(row: AggregateRow): FieldRegistryState {
  const state = parseFieldRegistryState(JSON.parse(row.state_json));
  if (canonicalJsonText(state) !== row.state_json
      || fieldRegistryStateDigest(state) !== row.state_digest_sha256
      || state.scope.workspaceId !== row.workspace_id
      || state.scope.eventId !== row.event_id
      || state.version !== row.registry_version
      || !/^[a-f0-9]{64}$/.test(row.baseline_digest_sha256)
      || (state.version === 1 && row.baseline_digest_sha256 !== row.state_digest_sha256)) {
    throw new TypeError('d1_field_registry_data_corrupt');
  }
  return state;
}

async function readAggregate(
  source: D1ReadSource,
  scope: FieldRegistryScopeDto
): Promise<{ readonly row: AggregateRow; readonly state: FieldRegistryState } | undefined> {
  const result = await source.prepare(`SELECT workspace_id,event_id,registry_version,
    state_json,state_digest_sha256,baseline_digest_sha256
    FROM field_registry_aggregates
    WHERE workspace_id = ? AND event_id = ?
    ORDER BY workspace_id,event_id LIMIT 2`).bind(scope.workspaceId, scope.eventId)
    .all<AggregateRow>();
  if (result.results.length > 1) throw new TypeError('d1_field_registry_not_unique');
  const row = result.results[0];
  return row ? Object.freeze({ row, state: stateFromRow(row) }) : undefined;
}

function liveOptions(result: D1Result<VocabularyRow>): readonly FieldRegistryLiveOption[] {
  return Object.freeze(result.results.map((row) => {
    if (typeof row.id !== 'string' || typeof row.name !== 'string'
        || (row.status !== 'active' && row.status !== 'retired')
        || !Number.isSafeInteger(row.version) || row.version <= 0) {
      throw new TypeError('d1_field_registry_vocabulary_invalid');
    }
    return Object.freeze({
      id: row.id,
      label: row.name,
      status: row.status,
      version: row.version
    });
  }));
}

/** Atomic D1 projection for the registered Field Registry snapshot read. */
export function createD1FieldRegistrySnapshotSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readSnapshot(scopeInput: FieldRegistryScopeDto) {
      const scope = {
        workspaceId: parseWorkspaceId(scopeInput.workspaceId),
        eventId: parseEventId(scopeInput.eventId)
      };
      if (scope.workspaceId !== workspaceId) {
        throw new TypeError('d1_field_registry_workspace_mismatch');
      }
      const [aggregateResult, trackResult, formatResult] = await input.database.batch([
        input.database.prepare(`SELECT workspace_id,event_id,registry_version,
          state_json,state_digest_sha256,baseline_digest_sha256
          FROM field_registry_aggregates
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY workspace_id,event_id LIMIT 2`).bind(workspaceId, scope.eventId),
        input.database.prepare(`SELECT id,name,status,version
          FROM program_vocabulary_tracks
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY id COLLATE BINARY`).bind(workspaceId, scope.eventId),
        input.database.prepare(`SELECT id,name,status,version
          FROM program_vocabulary_formats
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY id COLLATE BINARY`).bind(workspaceId, scope.eventId)
      ]);
      const aggregateRows = (aggregateResult as D1Result<AggregateRow>).results;
      if (aggregateRows.length > 1) throw new TypeError('d1_field_registry_not_unique');
      const row = aggregateRows[0];
      if (!row) return undefined;
      const state = stateFromRow(row);
      const options = Object.freeze({
        tracks: liveOptions(trackResult as D1Result<VocabularyRow>),
        formats: liveOptions(formatResult as D1Result<VocabularyRow>)
      });
      return projectFieldRegistrySnapshot({
        state,
        optionSource: Object.freeze({
          readLiveOptions(requestedScope: FieldRegistryScopeDto, source: FieldRegistryOptionSource) {
            if (requestedScope.workspaceId !== scope.workspaceId
                || requestedScope.eventId !== scope.eventId) {
              throw new TypeError('d1_field_registry_option_scope_mismatch');
            }
            return options[source];
          }
        })
      });
    }
  });
}

export interface D1FieldRegistryDirectIds {
  newFieldId(): string;
  newChoiceId(): string;
}

function applicationUuid(value: unknown, label: string): string {
  const parsed = typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
  if (!parsed) throw new TypeError(`d1_field_registry_${label}_invalid`);
  return parsed;
}

function authorInput(input: {
  readonly action: FieldRegistryDraftAction;
  readonly businessInput: unknown;
  readonly state: FieldRegistryState;
  readonly actorUserId: string;
  readonly evaluatedAt: string;
  readonly ids: D1FieldRegistryDirectIds;
}): FieldRegistryAuthorInput {
  const scope = input.state.scope;
  if (input.action === 'add') {
    const request = fieldRegistryAddDraftRequestSchema.parse(input.businessInput);
    const fieldId = applicationUuid(input.ids.newFieldId(), 'field_id');
    const choices = request.field.options.kind === 'custom'
      ? request.field.options.labels.map((label) => {
          const id = applicationUuid(input.ids.newChoiceId(), 'choice_id');
          return { id, key: fieldRegistryStableKeyFor(label, id) };
        }) : [];
    if (new Set([fieldId, ...choices.map((choice) => choice.id)]).size !== choices.length + 1) {
      throw new TypeError('d1_field_registry_ids_not_unique');
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
    const previous = input.state.fields.find((field) => field.id === request.fieldId);
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
      throw new TypeError('d1_field_registry_ids_not_unique');
    }
    return { action: 'edit', scope, request, choiceIdentities };
  }
  if (input.action === 'move') {
    return {
      action: 'move', scope,
      request: fieldRegistryMoveDraftRequestSchema.parse(input.businessInput)
    };
  }
  if (input.action === 'remove') {
    return {
      action: 'remove', scope,
      request: fieldRegistryRemoveDraftRequestSchema.parse(input.businessInput),
      removedAt: input.evaluatedAt,
      removedByUserId: input.actorUserId
    };
  }
  return {
    action: 'restore', scope,
    request: fieldRegistryRestoreDraftRequestSchema.parse(input.businessInput)
  };
}

function safeDiff(plan: FieldRegistryMutationPlan): FieldRegistrySafeDiff {
  const base = {
    registryVersionBefore: plan.expectedRegistryVersion,
    registryVersionAfter: plan.resultingRegistryVersion
  };
  if (plan.action === 'add') {
    return { action: 'add', ...base, before: null, after: plan.after, placement: plan.placement };
  }
  if (plan.action === 'edit') {
    return { action: 'edit', ...base, before: plan.before, after: plan.after };
  }
  if (plan.action === 'move') {
    return {
      action: 'move', ...base, fieldId: plan.fieldId, fieldVersion: plan.fieldVersion,
      beforeIndex: plan.beforeIndex, afterIndex: plan.afterIndex
    };
  }
  if (plan.action === 'remove') {
    return { action: 'remove', ...base, before: plan.before, after: null };
  }
  return { action: 'restore', ...base, before: null, after: plan.after, placement: plan.placement };
}

function resultFor(plan: FieldRegistryMutationPlan): FieldRegistryChangeResult {
  const field = plan.action === 'move'
    ? { id: plan.fieldId, version: plan.fieldVersion, position: plan.afterIndex }
    : plan.action === 'remove'
      ? { id: plan.before.id, version: plan.before.version, position: null }
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

function refusal(
  error: FieldRegistryPlanningError,
  action: FieldRegistryDraftAction,
  author: FieldRegistryAuthorInput
) {
  const stale = [
    'stale_registry', 'field_exists', 'field_missing', 'stale_field', 'field_removed',
    'field_active', 'form_missing', 'form_changed'
  ].includes(error.code);
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

function fieldScopeFor(
  action: FieldRegistryDraftAction,
  businessInput: unknown,
  state: FieldRegistryState
) {
  if (action === 'add') {
    return fieldRegistryAddDraftRequestSchema.parse(businessInput).field.scope;
  }
  const request = action === 'edit'
    ? fieldRegistryEditDraftRequestSchema.parse(businessInput)
    : action === 'move'
      ? fieldRegistryMoveDraftRequestSchema.parse(businessInput)
      : action === 'remove'
        ? fieldRegistryRemoveDraftRequestSchema.parse(businessInput)
        : fieldRegistryRestoreDraftRequestSchema.parse(businessInput);
  return state.fields.find((field) => field.id === request.fieldId)?.scope
    ?? state.removed.find((entry) => entry.field.id === request.fieldId)?.field.scope;
}

function formResolver(reference: FieldRegistryFormReference | undefined): FieldRegistryFormReferenceResolver {
  return Object.freeze({
    resolveFormReference(_scope: FieldRegistryScopeDto, formId: string) {
      return reference?.id === formId ? reference : undefined;
    }
  });
}

async function readFormReferences(
  unitOfWork: D1BufferedUnitOfWork,
  scope: FieldRegistryScopeDto
): Promise<ReadonlyMap<string, FieldRegistryFormReference>> {
  const result = await unitOfWork.readSession.prepare(`SELECT form_id,head_version
    FROM intake_form_heads
    WHERE workspace_id = ? AND event_id = ?
    ORDER BY form_id COLLATE BINARY`)
    .bind(scope.workspaceId, scope.eventId).all<FormHeadRow>();
  const references = new Map<string, FieldRegistryFormReference>();
  for (const row of result.results) {
    if (typeof row.form_id !== 'string' || references.has(row.form_id)
        || !Number.isSafeInteger(row.head_version) || row.head_version <= 0) {
      throw new TypeError('d1_field_registry_form_invalid');
    }
    references.set(row.form_id, Object.freeze({ id: row.form_id, version: row.head_version }));
  }
  return references;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return eventId !== undefined
    && context.scope.subjects.length === 2
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId);
}

interface PreparedFieldRegistryChange {
  readonly plan: FieldRegistryMutationPlan;
  readonly state: FieldRegistryState;
  readonly forms: FieldRegistryFormReferenceResolver;
  phase: 'prepared' | 'applied';
}

/** D1 adapter for the unchanged five direct audited Field Registry operations. */
export class D1FieldRegistryDirectEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  #prepared: PreparedFieldRegistryChange | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly ids: D1FieldRegistryDirectIds;
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    if (capability.key !== FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY.key
        || capability.version !== FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY.version) {
      throw new TypeError('d1_field_registry_capability_mismatch');
    }
    const action = fieldRegistryDirectActionForOperation(
      context.operation.name,
      context.operation.version
    );
    if (!action || context.operation.effect !== 'commit'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId
        || !exactSubjects(context)) {
      throw new TypeError('d1_field_registry_scope_mismatch');
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
        || authority.lane.policy.key !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.key
        || authority.lane.policy.version !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.version
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage')) {
      throw new TypeError('d1_field_registry_authority_mismatch');
    }
    const eventId = parseEventId(context.scope.eventId);
    const scope = Object.freeze({ workspaceId: this.#workspaceId, eventId });
    const eventSet = await this.input.unitOfWork.readSession.prepare(`SELECT version,current_event_id
      FROM event_spine_workspace_sets WHERE workspace_id = ?`)
      .bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== eventId) {
      throw new TypeError('d1_field_registry_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, eventId
    ]);
    const aggregate = await readAggregate(this.input.unitOfWork.readSession, scope);
    if (!aggregate) throw new FieldRegistryPlanningError('wrong_scope');
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM field_registry_aggregates
      WHERE workspace_id = ? AND event_id = ? AND registry_version = ?
        AND state_json = ? AND state_digest_sha256 = ? AND baseline_digest_sha256 = ?)`, [
      aggregate.row.workspace_id,
      aggregate.row.event_id,
      aggregate.row.registry_version,
      aggregate.row.state_json,
      aggregate.row.state_digest_sha256,
      aggregate.row.baseline_digest_sha256
    ]);
    const actorUserId = parseUserId(authority.actor.userId);
    const loadedForms = await readFormReferences(this.input.unitOfWork, scope);
    this.#prepared = undefined;
    return sealFieldRegistryDirectPreparation({
      capability,
      context,
      preparation: { prepare: ({ action: receivedAction, businessInput, context: received }) => {
        if (received !== context || receivedAction !== action) {
          throw new TypeError('d1_field_registry_context_substitution');
        }
        const requestedFieldScope = fieldScopeFor(action, businessInput, aggregate.state);
        const formReference = requestedFieldScope?.kind === 'form'
          ? loadedForms.get(requestedFieldScope.formId)
          : undefined;
        if (formReference) {
          this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM intake_form_heads
            WHERE workspace_id = ? AND event_id = ? AND form_id = ? AND head_version = ?)`, [
            scope.workspaceId,
            scope.eventId,
            formReference.id,
            formReference.version
          ]);
        }
        const forms = formResolver(formReference);
        const author = authorInput({
          action,
          businessInput,
          state: aggregate.state,
          actorUserId,
          evaluatedAt,
          ids: this.input.ids
        });
        try {
          const plan = planFieldRegistryMutation({ state: aggregate.state, author, formReferences: forms });
          const contribution = fieldRegistryDirectContributionSchema.parse({
            result: {
              kind: 'success',
              data: { action, mutation: resultFor(plan), safeDiff: safeDiff(plan) }
            },
            domain: { kind: 'field_registry_direct_change', plan },
            effectContributions: []
          });
          this.#prepared = { plan, state: aggregate.state, forms, phase: 'prepared' };
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
    const candidate = contribution as { readonly kind?: unknown; readonly plan?: unknown };
    if (candidate.kind !== 'field_registry_direct_change') {
      throw new TypeError('d1_field_registry_contribution_invalid');
    }
    const prepared = this.#prepared;
    const plan = candidate.plan as FieldRegistryMutationPlan;
    if (!prepared || prepared.phase !== 'prepared'
        || canonicalJsonText(prepared.plan) !== canonicalJsonText(plan)) {
      throw new TypeError('d1_field_registry_preparation_invalid');
    }
    const applied = applyFieldRegistryMutationPlan({
      state: prepared.state,
      plan: prepared.plan,
      formReferences: prepared.forms
    });
    this.input.unitOfWork.write(`UPDATE field_registry_aggregates
      SET registry_version = ?,state_json = ?,state_digest_sha256 = ?
      WHERE workspace_id = ? AND event_id = ?
        AND registry_version = ? AND state_digest_sha256 = ?`, [
      applied.state.version,
      canonicalJsonText(applied.state),
      fieldRegistryStateDigest(applied.state),
      prepared.plan.scope.workspaceId,
      prepared.plan.scope.eventId,
      prepared.state.version,
      fieldRegistryStateDigest(prepared.state)
    ]);
    prepared.phase = 'applied';
  }

  afterUnitOfWorkCommitted(): void {
    this.#prepared = undefined;
  }
}

export function createD1FieldRegistryDirectEffectDomainRegistration(input: {
  readonly workspaceId: WorkspaceId;
  readonly ids: D1FieldRegistryDirectIds;
}): D1EffectDomainAdapterRegistration {
  return Object.freeze({
    capability: FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
    create: (unitOfWork: D1BufferedUnitOfWork) =>
      new D1FieldRegistryDirectEffectDomainAdapter({
        unitOfWork,
        workspaceId: input.workspaceId,
        ids: input.ids
      })
  });
}
