import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  fieldRegistryAddDraftRequestSchema,
  fieldRegistryChangeResultSchema,
  fieldRegistryContextsSchema,
  fieldRegistryEditDraftRequestSchema,
  fieldRegistryFieldDefinitionSchema,
  fieldRegistryIdSchema,
  fieldRegistryMoveDraftRequestSchema,
  fieldRegistryRemoveDraftRequestSchema,
  fieldRegistryRestoreDraftRequestSchema,
  fieldRegistryScopeSchema,
  fieldRegistryStableKeySchema,
  type FieldRegistryAddDraftRequest,
  type FieldRegistryChangeResult,
  type FieldRegistryChoiceDto,
  type FieldRegistryDraftAction,
  type FieldRegistryEditDraftRequest,
  type FieldRegistryFieldAuthor,
  type FieldRegistryFieldDefinitionDto,
  type FieldRegistryMoveDraftRequest,
  type FieldRegistryRemoveDraftRequest,
  type FieldRegistryRestoreDraftRequest,
  type FieldRegistryScopeDto
} from '@jooevents/contracts';

import { suggestFieldRegistryPlacement, type FieldRegistryPlacementSuggestion } from './placement';
import {
  fieldRegistryStateDigest,
  parseFieldRegistryState,
  type FieldRegistryState
} from './model';

export type FieldRegistryPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_registry'
  | 'field_exists'
  | 'field_missing'
  | 'stale_field'
  | 'field_removed'
  | 'field_active'
  | 'form_missing'
  | 'form_changed'
  | 'locked_field'
  | 'invalid_options'
  | 'invalid_position'
  | 'invalid_plan';

export class FieldRegistryPlanningError extends Error {
  constructor(readonly code: FieldRegistryPlanningErrorCode) {
    super(code);
  }
}

export interface FieldRegistryIdentityAssignment {
  readonly fieldId: string;
  readonly fieldKey: string;
  readonly choices: readonly { readonly id: string; readonly key: string }[];
}

export interface FieldRegistryFormReference {
  readonly id: string;
  readonly version: number;
}

export interface FieldRegistryFormReferenceResolver {
  resolveFormReference(
    scope: FieldRegistryScopeDto,
    formId: string
  ): FieldRegistryFormReference | undefined;
}

export interface FieldRegistryReadPort extends FieldRegistryFormReferenceResolver {
  readFieldRegistry(scope: FieldRegistryScopeDto): FieldRegistryState | undefined;
}

export interface FieldRegistryTransactionPort extends FieldRegistryReadPort {
  applyFieldRegistryPlan(plan: FieldRegistryMutationPlan): FieldRegistryChangeResult;
}

export type FieldRegistryAuthorInput =
  | {
      readonly action: 'add';
      readonly scope: FieldRegistryScopeDto;
      readonly request: FieldRegistryAddDraftRequest;
      readonly identities: FieldRegistryIdentityAssignment;
    }
  | {
      readonly action: 'edit';
      readonly scope: FieldRegistryScopeDto;
      readonly request: FieldRegistryEditDraftRequest;
      readonly choiceIdentities: readonly { readonly id: string; readonly key: string }[];
    }
  | {
      readonly action: 'move';
      readonly scope: FieldRegistryScopeDto;
      readonly request: FieldRegistryMoveDraftRequest;
    }
  | {
      readonly action: 'remove';
      readonly scope: FieldRegistryScopeDto;
      readonly request: FieldRegistryRemoveDraftRequest;
      readonly removedAt: string;
      readonly removedByUserId: string;
    }
  | {
      readonly action: 'restore';
      readonly scope: FieldRegistryScopeDto;
      readonly request: FieldRegistryRestoreDraftRequest;
    };

interface PlanBase {
  readonly scope: FieldRegistryScopeDto;
  readonly expectedRegistryVersion: number;
  readonly resultingRegistryVersion: number;
  readonly registryGuardDigestSha256: string;
  readonly formPin: FieldRegistryFormReference | null;
}

export type FieldRegistryMutationPlan =
  | (PlanBase & {
      readonly action: 'add';
      readonly before: null;
      readonly after: FieldRegistryFieldDefinitionDto;
      readonly placement: FieldRegistryPlacementSuggestion;
    })
  | (PlanBase & {
      readonly action: 'edit';
      readonly before: FieldRegistryFieldDefinitionDto;
      readonly after: FieldRegistryFieldDefinitionDto;
    })
  | (PlanBase & {
      readonly action: 'move';
      readonly fieldId: string;
      readonly fieldVersion: number;
      readonly beforeIndex: number;
      readonly afterIndex: number;
    })
  | (PlanBase & {
      readonly action: 'remove';
      readonly before: FieldRegistryFieldDefinitionDto;
      readonly after: null;
      readonly removedAt: string;
      readonly removedByUserId: string;
    })
  | (PlanBase & {
      readonly action: 'restore';
      readonly before: null;
      readonly after: FieldRegistryFieldDefinitionDto;
      readonly placement: FieldRegistryPlacementSuggestion;
    });

function sameScope(left: FieldRegistryScopeDto, right: FieldRegistryScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function registryApplicationIds(state: FieldRegistryState): Set<string> {
  const ids = new Set<string>();
  for (const field of [
    ...state.fields,
    ...state.removed.map((removed) => removed.field)
  ]) {
    ids.add(field.id);
    if (field.options.kind === 'custom') {
      for (const choice of field.options.choices) ids.add(choice.id);
    }
  }
  return ids;
}

export function fieldRegistryGuardDigest(state: FieldRegistryState): string {
  return fieldRegistryStateDigest(state);
}

function formPin(
  scope: FieldRegistryScopeDto,
  fieldScope: FieldRegistryFieldDefinitionDto['scope'] | FieldRegistryFieldAuthor['scope'],
  references: FieldRegistryFormReferenceResolver
): FieldRegistryFormReference | null {
  if (fieldScope.kind === 'shared') return null;
  const reference = references.resolveFormReference(scope, fieldScope.formId);
  if (!reference || reference.id !== fieldScope.formId) {
    throw new FieldRegistryPlanningError('form_missing');
  }
  return Object.freeze({ id: fieldRegistryIdSchema.parse(reference.id), version: reference.version });
}

export function fieldRegistryStableKeyFor(label: string, id: string): string {
  const normalized = label.normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 100);
  const suffix = id.replace(/-/gu, '').slice(0, 12);
  return fieldRegistryStableKeySchema.parse(`custom.${normalized || 'field'}_${suffix}`);
}

function customChoices(input: {
  readonly labels: readonly string[];
  readonly identities: readonly { readonly id: string; readonly key: string }[];
  readonly previous?: readonly FieldRegistryChoiceDto[];
}): readonly FieldRegistryChoiceDto[] {
  if (input.labels.length !== input.identities.length) {
    throw new FieldRegistryPlanningError('invalid_options');
  }
  const priorByLabel = new Map(
    (input.previous ?? []).map((choice) => [choice.label.toLocaleLowerCase('en-US'), choice])
  );
  const choices = input.labels.map((label, position) => {
    const prior = priorByLabel.get(label.toLocaleLowerCase('en-US'));
    const identity = input.identities[position];
    if (!identity) throw new FieldRegistryPlanningError('invalid_options');
    return {
      id: fieldRegistryIdSchema.parse(prior?.id ?? identity.id),
      key: fieldRegistryStableKeySchema.parse(prior?.key ?? identity.key),
      label,
      position
    };
  });
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length
      || new Set(choices.map((choice) => choice.key)).size !== choices.length) {
    throw new FieldRegistryPlanningError('invalid_options');
  }
  return choices;
}

function fieldFromAuthor(input: {
  readonly author: FieldRegistryFieldAuthor;
  readonly identity: FieldRegistryIdentityAssignment;
  readonly group: FieldRegistryFieldDefinitionDto['group'];
  readonly position: number;
}): FieldRegistryFieldDefinitionDto {
  const options = input.author.options.kind === 'custom'
    ? {
        kind: 'custom' as const,
        choices: customChoices({ labels: input.author.options.labels, identities: input.identity.choices })
      }
    : input.author.options;
  return fieldRegistryFieldDefinitionSchema.parse({
    id: input.identity.fieldId,
    key: input.identity.fieldKey,
    version: 1,
    kind: input.author.kind,
    label: input.author.label,
    help: input.author.help ?? null,
    answerOwner: input.author.answerOwner,
    mapsTo: null,
    purpose: { kind: 'ordinary' },
    scope: input.author.scope,
    group: input.group,
    position: input.position,
    contexts: input.author.contexts,
    options,
    constraints: { removal: 'allowed', applyVisibility: 'editable' },
    fileUpload: input.author.kind === 'file' ? 'disabled' : 'not_applicable'
  });
}

function base(
  state: FieldRegistryState,
  expectedRegistryVersion: number,
  formReference: FieldRegistryFormReference | null
): PlanBase {
  if (state.version !== expectedRegistryVersion) {
    throw new FieldRegistryPlanningError('stale_registry');
  }
  return {
    scope: state.scope,
    expectedRegistryVersion,
    resultingRegistryVersion: expectedRegistryVersion + 1,
    registryGuardDigestSha256: fieldRegistryGuardDigest(state),
    formPin: formReference
  };
}

function activeField(
  state: FieldRegistryState,
  fieldId: string,
  expectedFieldVersion: number
): FieldRegistryFieldDefinitionDto {
  const field = state.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    if (state.removed.some((candidate) => candidate.field.id === fieldId)) {
      throw new FieldRegistryPlanningError('field_removed');
    }
    throw new FieldRegistryPlanningError('field_missing');
  }
  if (field.version !== expectedFieldVersion) {
    throw new FieldRegistryPlanningError('stale_field');
  }
  return field;
}

export function planFieldRegistryMutation(input: {
  readonly state: FieldRegistryState;
  readonly author: FieldRegistryAuthorInput;
  readonly formReferences: FieldRegistryFormReferenceResolver;
}): FieldRegistryMutationPlan {
  const state = parseFieldRegistryState(input.state);
  const scope = fieldRegistryScopeSchema.parse(input.author.scope);
  if (!sameScope(state.scope, scope)) throw new FieldRegistryPlanningError('wrong_scope');
  if (state.version !== input.author.request.expectedRegistryVersion) {
    throw new FieldRegistryPlanningError('stale_registry');
  }

  if (input.author.action === 'add') {
    const author = input.author;
    const request = fieldRegistryAddDraftRequestSchema.parse(input.author.request);
    const reservedIds = registryApplicationIds(state);
    if (reservedIds.has(author.identities.fieldId)
        || state.fields.some((field) => field.key === author.identities.fieldKey)
        || state.removed.some((removed) => removed.field.key === author.identities.fieldKey)) {
      throw new FieldRegistryPlanningError('field_exists');
    }
    if (author.identities.choices.some((choice, index) =>
      reservedIds.has(choice.id)
      || choice.id === author.identities.fieldId
      || author.identities.choices.findIndex((candidate) => candidate.id === choice.id) !== index
    )) throw new FieldRegistryPlanningError('invalid_options');
    const placement = suggestFieldRegistryPlacement(request.field, state.fields);
    const pin = formPin(scope, request.field.scope, input.formReferences);
    return Object.freeze({
      action: 'add' as const,
      ...base(state, request.expectedRegistryVersion, pin),
      before: null,
      after: fieldFromAuthor({
        author: request.field,
        identity: {
          ...author.identities,
          fieldKey: author.identities.fieldKey
            || fieldRegistryStableKeyFor(request.field.label, author.identities.fieldId)
        },
        group: placement.group,
        position: placement.index
      }),
      placement
    });
  }

  if (input.author.action === 'edit') {
    const request = fieldRegistryEditDraftRequestSchema.parse(input.author.request);
    const before = activeField(state, request.fieldId, request.expectedFieldVersion);
    const changes = request.changes;
    const contexts = changes.contexts ?? before.contexts;
    if (before.constraints.applyVisibility === 'required_visible' && !contexts.apply.visible) {
      throw new FieldRegistryPlanningError('locked_field');
    }
    let options: FieldRegistryFieldDefinitionDto['options'] = before.options;
    if (changes.customOptionLabels) {
      if (before.options.kind !== 'custom') throw new FieldRegistryPlanningError('invalid_options');
      const previousChoices = before.options.choices;
      const nextChoices = [...customChoices({
        labels: changes.customOptionLabels,
        identities: input.author.choiceIdentities,
        previous: previousChoices
      })];
      options = {
        kind: 'custom',
        choices: nextChoices
      };
      const reservedIds = registryApplicationIds(state);
      if (nextChoices.some((choice, index) =>
        (reservedIds.has(choice.id)
          && !previousChoices.some((prior) =>
            prior.id === choice.id
            && prior.label.toLocaleLowerCase('en-US') === choice.label.toLocaleLowerCase('en-US')
          ))
        || choice.id === before.id
        || nextChoices.findIndex((candidate) => candidate.id === choice.id) !== index
      )) throw new FieldRegistryPlanningError('invalid_options');
    }
    const after = fieldRegistryFieldDefinitionSchema.parse({
      ...before,
      version: before.version + 1,
      label: changes.label ?? before.label,
      help: changes.help === undefined ? before.help : changes.help,
      contexts: fieldRegistryContextsSchema.parse(contexts),
      options
    });
    return Object.freeze({
      action: 'edit' as const,
      ...base(state, request.expectedRegistryVersion, formPin(scope, before.scope, input.formReferences)),
      before,
      after
    });
  }

  if (input.author.action === 'move') {
    const request = fieldRegistryMoveDraftRequestSchema.parse(input.author.request);
    const field = activeField(state, request.fieldId, request.expectedFieldVersion);
    if (request.toIndex >= state.fields.length) throw new FieldRegistryPlanningError('invalid_position');
    return Object.freeze({
      action: 'move' as const,
      ...base(state, request.expectedRegistryVersion, formPin(scope, field.scope, input.formReferences)),
      fieldId: field.id,
      fieldVersion: field.version,
      beforeIndex: field.position,
      afterIndex: request.toIndex
    });
  }

  if (input.author.action === 'remove') {
    const request = fieldRegistryRemoveDraftRequestSchema.parse(input.author.request);
    const before = activeField(state, request.fieldId, request.expectedFieldVersion);
    if (before.constraints.removal === 'forbidden') {
      throw new FieldRegistryPlanningError('locked_field');
    }
    return Object.freeze({
      action: 'remove' as const,
      ...base(state, request.expectedRegistryVersion, formPin(scope, before.scope, input.formReferences)),
      before,
      after: null,
      removedAt: input.author.removedAt,
      removedByUserId: fieldRegistryIdSchema.parse(input.author.removedByUserId)
    });
  }

  const request = fieldRegistryRestoreDraftRequestSchema.parse(input.author.request);
  if (state.fields.some((candidate) => candidate.id === request.fieldId)) {
    throw new FieldRegistryPlanningError('field_active');
  }
  const removed = state.removed.find((candidate) => candidate.field.id === request.fieldId);
  if (!removed) throw new FieldRegistryPlanningError('field_missing');
  if (removed.field.version !== request.expectedFieldVersion) {
    throw new FieldRegistryPlanningError('stale_field');
  }
  if (request.toIndex > state.fields.length) throw new FieldRegistryPlanningError('invalid_position');
  const after = fieldRegistryFieldDefinitionSchema.parse({
    ...removed.field,
    version: removed.field.version + 1,
    position: request.toIndex
  });
  return Object.freeze({
    action: 'restore' as const,
    ...base(
      state,
      request.expectedRegistryVersion,
      formPin(scope, removed.field.scope, input.formReferences)
    ),
    before: null,
    after,
    placement: Object.freeze({
      index: request.toIndex,
      group: after.group,
      reasonKey: 'field_registry.placement.restore'
    })
  });
}

function planIdentity(plan: FieldRegistryMutationPlan): string {
  if (plan.action === 'move') return plan.fieldId;
  return plan.action === 'remove' ? plan.before.id : plan.after.id;
}

export function validateFieldRegistryMutationPlan(input: {
  readonly state: FieldRegistryState;
  readonly plan: FieldRegistryMutationPlan;
  readonly formReferences: FieldRegistryFormReferenceResolver;
}): FieldRegistryPlanningErrorCode | undefined {
  const current = parseFieldRegistryState(input.state);
  if (!sameScope(current.scope, input.plan.scope)) return 'wrong_scope';
  if (current.version !== input.plan.expectedRegistryVersion) return 'stale_registry';
  if (input.plan.formPin) {
    const form = input.formReferences.resolveFormReference(
      input.plan.scope,
      input.plan.formPin.id
    );
    if (!form) return 'form_missing';
    if (form.id !== input.plan.formPin.id || form.version !== input.plan.formPin.version) {
      return 'form_changed';
    }
  }
  let replanned: FieldRegistryMutationPlan;
  try {
    const plan = input.plan;
    const author: FieldRegistryAuthorInput = plan.action === 'add'
      ? {
          action: 'add', scope: plan.scope,
          request: { expectedRegistryVersion: plan.expectedRegistryVersion, field: {
            kind: plan.after.kind, label: plan.after.label,
            ...(plan.after.help ? { help: plan.after.help } : {}),
            answerOwner: plan.after.answerOwner,
            scope: plan.after.scope,
            contexts: plan.after.contexts,
            options: plan.after.options.kind === 'custom'
              ? { kind: 'custom', labels: plan.after.options.choices.map((choice) => choice.label) }
              : plan.after.options
          } },
          identities: {
            fieldId: plan.after.id,
            fieldKey: plan.after.key,
            choices: plan.after.options.kind === 'custom'
              ? plan.after.options.choices.map(({ id, key }) => ({ id, key }))
              : []
          }
        }
      : plan.action === 'edit'
        ? {
            action: 'edit', scope: plan.scope,
            request: {
              fieldId: plan.before.id,
              expectedFieldVersion: plan.before.version,
              expectedRegistryVersion: plan.expectedRegistryVersion,
              changes: {
                label: plan.after.label,
                help: plan.after.help,
                contexts: plan.after.contexts,
                ...(plan.after.options.kind === 'custom'
                  ? { customOptionLabels: plan.after.options.choices.map((choice) => choice.label) }
                  : {})
              }
            },
            choiceIdentities: plan.after.options.kind === 'custom'
              ? plan.after.options.choices.map(({ id, key }) => ({ id, key }))
              : []
          }
        : plan.action === 'move'
          ? {
              action: 'move', scope: plan.scope,
              request: {
                fieldId: plan.fieldId, expectedFieldVersion: plan.fieldVersion,
                expectedRegistryVersion: plan.expectedRegistryVersion, toIndex: plan.afterIndex
              }
            }
          : plan.action === 'remove'
            ? {
                action: 'remove', scope: plan.scope,
                request: {
                  fieldId: plan.before.id, expectedFieldVersion: plan.before.version,
                  expectedRegistryVersion: plan.expectedRegistryVersion
                },
                removedAt: plan.removedAt,
                removedByUserId: plan.removedByUserId
              }
            : {
                action: 'restore', scope: plan.scope,
                request: {
                  fieldId: plan.after.id, expectedFieldVersion: plan.after.version - 1,
                  expectedRegistryVersion: plan.expectedRegistryVersion, toIndex: plan.after.position
                }
              };
    replanned = planFieldRegistryMutation({
      state: input.state,
      author,
      formReferences: input.formReferences
    });
  } catch (error) {
    return error instanceof FieldRegistryPlanningError ? error.code : 'invalid_plan';
  }
  return canonicalJsonSha256(replanned) === canonicalJsonSha256(input.plan)
    ? undefined
    : 'invalid_plan';
}

function reorder(
  fields: readonly FieldRegistryFieldDefinitionDto[],
  fieldId: string,
  toIndex: number
): readonly FieldRegistryFieldDefinitionDto[] {
  const ordered = [...fields];
  const from = ordered.findIndex((field) => field.id === fieldId);
  if (from < 0 || toIndex < 0 || toIndex >= ordered.length) {
    throw new FieldRegistryPlanningError('invalid_position');
  }
  const [field] = ordered.splice(from, 1);
  if (!field) throw new FieldRegistryPlanningError('field_missing');
  ordered.splice(toIndex, 0, field);
  return ordered.map((candidate, position) => ({ ...candidate, position }));
}

export function applyFieldRegistryMutationPlan(input: {
  readonly state: FieldRegistryState;
  readonly plan: FieldRegistryMutationPlan;
  readonly formReferences: FieldRegistryFormReferenceResolver;
}): { readonly state: FieldRegistryState; readonly result: FieldRegistryChangeResult } {
  const code = validateFieldRegistryMutationPlan(input);
  if (code) throw new FieldRegistryPlanningError(code);
  const current = parseFieldRegistryState(input.state);
  const plan = input.plan;
  let fields = [...current.fields];
  let removed = [...current.removed];
  if (plan.action === 'add') {
    fields.splice(plan.after.position, 0, plan.after);
    fields = fields.map((field, position) => ({ ...field, position }));
  } else if (plan.action === 'edit') {
    fields = fields.map((field) => field.id === plan.after.id ? plan.after : field);
  } else if (plan.action === 'move') {
    fields = [...reorder(fields, plan.fieldId, plan.afterIndex)];
  } else if (plan.action === 'remove') {
    fields = fields.filter((field) => field.id !== plan.before.id)
      .map((field, position) => ({ ...field, position }));
    removed.push({
      field: plan.before,
      removedAt: plan.removedAt,
      removedByUserId: plan.removedByUserId,
      lastPosition: plan.before.position
    });
  } else {
    removed = removed.filter((candidate) => candidate.field.id !== plan.after.id);
    fields.splice(plan.after.position, 0, plan.after);
    fields = fields.map((field, position) => ({ ...field, position }));
  }
  const state = parseFieldRegistryState({
    scope: current.scope,
    version: plan.resultingRegistryVersion,
    fields,
    removed
  });
  const fieldId = planIdentity(plan);
  const active = state.fields.find((field) => field.id === fieldId);
  const tombstone = state.removed.find((candidate) => candidate.field.id === fieldId);
  const result = fieldRegistryChangeResultSchema.parse({
    schemaVersion: 1,
    action: plan.action,
    fieldId,
    registryVersion: state.version,
    fieldVersion: active?.version ?? tombstone?.field.version,
    position: active?.position ?? null
  });
  return Object.freeze({ state, result });
}

export function fieldRegistryFieldId(plan: FieldRegistryMutationPlan): string {
  return planIdentity(plan);
}

export function fieldRegistryAction(plan: FieldRegistryMutationPlan): FieldRegistryDraftAction {
  return plan.action;
}
