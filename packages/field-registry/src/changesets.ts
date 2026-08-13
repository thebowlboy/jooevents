import {
  fieldRegistryAddDraftRequestSchema,
  fieldRegistryChangeResultSchema,
  fieldRegistryDigestSchema,
  fieldRegistryDraftActionSchema,
  fieldRegistryEditDraftRequestSchema,
  fieldRegistryFieldDefinitionSchema,
  fieldRegistryIdSchema,
  fieldRegistryMoveDraftRequestSchema,
  fieldRegistryRemoveDraftRequestSchema,
  fieldRegistryRestoreDraftRequestSchema,
  fieldRegistrySafeDiffSchema,
  fieldRegistryScopeSchema,
  fieldRegistryStableKeySchema,
  fieldRegistryVersionSchema,
  type FieldRegistryChangeResult,
  type FieldRegistrySafeDiff,
  type FieldRegistryScopeDto
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type CompensationDerivation
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  FieldRegistryPlanningError,
  applyFieldRegistryMutationPlan,
  fieldRegistryFieldId,
  fieldRegistryGuardDigest,
  planFieldRegistryMutation,
  validateFieldRegistryMutationPlan,
  type FieldRegistryAuthorInput,
  type FieldRegistryFormReferenceResolver,
  type FieldRegistryMutationPlan,
  type FieldRegistryPlanningErrorCode
} from './domain';
import { fieldRegistryAggregateId, parseFieldRegistryState, type FieldRegistryState } from './model';
import {
  assertFieldRegistryOrdinaryPolicy,
  captureFieldRegistryApprovalPolicy,
  type FieldRegistryOrdinaryPolicy
} from './policy';

export const FIELD_REGISTRY_CHANGESET_KIND = 'field_registry.mutate';
export const FIELD_REGISTRY_CHANGESET_VERSION = 1;

export interface FieldRegistryReadPort extends FieldRegistryFormReferenceResolver {
  readFieldRegistry(scope: FieldRegistryScopeDto): FieldRegistryState | undefined;
}

export interface FieldRegistryTransactionPort extends FieldRegistryReadPort {
  applyFieldRegistryPlan(plan: FieldRegistryMutationPlan): FieldRegistryChangeResult;
}

export const fieldRegistryReadPort = defineChangesetReadPort<FieldRegistryReadPort>(
  'field_registry.read', 1
);
export const fieldRegistryValidationPort = defineChangesetValidationPort<FieldRegistryReadPort>(
  'field_registry.validation', 1
);
export const fieldRegistryTransactionPort =
  defineChangesetTransactionPort<FieldRegistryTransactionPort>('field_registry.transaction', 1);

const identityAssignmentSchema = z.strictObject({
  fieldId: fieldRegistryIdSchema,
  fieldKey: fieldRegistryStableKeySchema,
  choices: z.array(z.strictObject({
    id: fieldRegistryIdSchema,
    key: fieldRegistryStableKeySchema
  })).max(200)
});
const authorInputSchema: z.ZodType<FieldRegistryAuthorInput> = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('add'),
    scope: fieldRegistryScopeSchema,
    request: fieldRegistryAddDraftRequestSchema,
    identities: identityAssignmentSchema
  }),
  z.strictObject({
    action: z.literal('edit'),
    scope: fieldRegistryScopeSchema,
    request: fieldRegistryEditDraftRequestSchema,
    choiceIdentities: z.array(z.strictObject({
      id: fieldRegistryIdSchema,
      key: fieldRegistryStableKeySchema
    })).max(200)
  }),
  z.strictObject({
    action: z.literal('move'), scope: fieldRegistryScopeSchema,
    request: fieldRegistryMoveDraftRequestSchema
  }),
  z.strictObject({
    action: z.literal('remove'), scope: fieldRegistryScopeSchema,
    request: fieldRegistryRemoveDraftRequestSchema,
    removedAt: z.iso.datetime({ offset: true }),
    removedByUserId: fieldRegistryIdSchema
  }),
  z.strictObject({
    action: z.literal('restore'), scope: fieldRegistryScopeSchema,
    request: fieldRegistryRestoreDraftRequestSchema
  })
]);

const formPinSchema = z.strictObject({
  id: fieldRegistryIdSchema,
  version: fieldRegistryVersionSchema
}).nullable();
const planBase = {
  scope: fieldRegistryScopeSchema,
  expectedRegistryVersion: fieldRegistryVersionSchema,
  resultingRegistryVersion: fieldRegistryVersionSchema,
  registryGuardDigestSha256: fieldRegistryDigestSchema,
  formPin: formPinSchema
} as const;
const placementSchema = z.strictObject({
  index: z.number().int().nonnegative().safe(),
  group: z.enum(['identity', 'contact', 'presence', 'talk', 'logistics', 'materials', 'other', 'consent']),
  reasonKey: fieldRegistryStableKeySchema
});
const mutationPlanSchema: z.ZodType<FieldRegistryMutationPlan> = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('add'), ...planBase,
    before: z.null(), after: fieldRegistryFieldDefinitionSchema,
    placement: placementSchema
  }),
  z.strictObject({
    action: z.literal('edit'), ...planBase,
    before: fieldRegistryFieldDefinitionSchema, after: fieldRegistryFieldDefinitionSchema
  }),
  z.strictObject({
    action: z.literal('move'), ...planBase,
    fieldId: fieldRegistryIdSchema,
    fieldVersion: fieldRegistryVersionSchema,
    beforeIndex: z.number().int().nonnegative().safe(),
    afterIndex: z.number().int().nonnegative().safe()
  }),
  z.strictObject({
    action: z.literal('remove'), ...planBase,
    before: fieldRegistryFieldDefinitionSchema, after: z.null(),
    removedAt: z.iso.datetime({ offset: true }),
    removedByUserId: fieldRegistryIdSchema
  }),
  z.strictObject({
    action: z.literal('restore'), ...planBase,
    before: z.null(), after: fieldRegistryFieldDefinitionSchema,
    placement: placementSchema
  })
]);

const policySchema: z.ZodType<FieldRegistryOrdinaryPolicy> = z.strictObject({
  activation: z.literal('ordinary'),
  key: fieldRegistryStableKeySchema,
  version: fieldRegistryVersionSchema,
  ordinaryRisk: z.enum(['low', 'normal']),
  approval: z.enum(['none', 'distinct_current_human']),
  definitionDigestSha256: fieldRegistryDigestSchema
});

const authorSchema = defineChangesetSchema({
  key: 'field_registry.author', version: 1, schema: authorInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'field_registry.plan', version: 1,
  schema: z.strictObject({ policy: policySchema, mutation: mutationPlanSchema })
});
const diffSchema = defineChangesetSchema({
  key: 'field_registry.safe_diff', version: 1, schema: fieldRegistrySafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'field_registry.result', version: 1, schema: fieldRegistryChangeResultSchema
});
const refusalCodes = [
  'wrong_scope', 'stale_registry', 'field_exists', 'field_missing', 'stale_field',
  'field_removed', 'field_active', 'form_missing', 'form_changed', 'locked_field',
  'invalid_options', 'invalid_position', 'invalid_plan', 'policy_changed'
] as const;
const outcomeDetailSchema = defineChangesetSchema({
  key: 'field_registry.stale_detail', version: 1,
  schema: z.strictObject({
    code: z.enum(refusalCodes),
    action: fieldRegistryDraftActionSchema,
    fieldId: fieldRegistryIdSchema
  })
});

export interface FieldRegistryChangesetPlan {
  readonly policy: FieldRegistryOrdinaryPolicy;
  readonly mutation: FieldRegistryMutationPlan;
}

type Definition = ChangesetOperationDefinition<
  FieldRegistryAuthorInput,
  FieldRegistryChangesetPlan,
  FieldRegistrySafeDiff,
  FieldRegistryChangesetPlan,
  FieldRegistryChangeResult
>;

export interface FieldRegistryOrdinaryChangesetBundle {
  readonly policy: FieldRegistryOrdinaryPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

function requireState(
  scope: FieldRegistryScopeDto,
  port: FieldRegistryReadPort
): FieldRegistryState {
  const state = port.readFieldRegistry(scope);
  if (!state) throw new FieldRegistryPlanningError('wrong_scope');
  return parseFieldRegistryState(state);
}

function aggregateRefs(plan: FieldRegistryMutationPlan) {
  return [{ id: fieldRegistryAggregateId(plan.scope.eventId), version: plan.expectedRegistryVersion }];
}

function guardRefs(plan: FieldRegistryMutationPlan) {
  return [{
    id: `field_registry_guard:${plan.scope.eventId}`,
    version: plan.expectedRegistryVersion,
    digest: plan.registryGuardDigestSha256
  }];
}

function safeDiff(plan: FieldRegistryMutationPlan): FieldRegistrySafeDiff {
  const base = {
    registryVersionBefore: plan.expectedRegistryVersion,
    registryVersionAfter: plan.resultingRegistryVersion
  };
  if (plan.action === 'add') return {
    action: 'add', ...base, before: null, after: plan.after, placement: plan.placement
  };
  if (plan.action === 'edit') return { action: 'edit', ...base, before: plan.before, after: plan.after };
  if (plan.action === 'move') return {
    action: 'move', ...base,
    fieldId: plan.fieldId, fieldVersion: plan.fieldVersion,
    beforeIndex: plan.beforeIndex, afterIndex: plan.afterIndex
  };
  if (plan.action === 'remove') return { action: 'remove', ...base, before: plan.before, after: null };
  return {
    action: 'restore', ...base, before: null, after: plan.after, placement: plan.placement
  };
}

function refusal(
  code: FieldRegistryPlanningErrorCode | 'policy_changed',
  plan: FieldRegistryMutationPlan
) {
  return {
    class: 'stale_revision' as const,
    kind: 'field_registry.changed',
    retryable: false,
    subjects: [{ type: 'field_registry', id: plan.scope.eventId }],
    detail: { code, action: plan.action, fieldId: fieldRegistryFieldId(plan) },
    detailSchemaVersion: 1
  };
}

export function createFieldRegistryOrdinaryChangesetBundle(input: {
  readonly policy: FieldRegistryOrdinaryPolicy;
}): FieldRegistryOrdinaryChangesetBundle {
  assertFieldRegistryOrdinaryPolicy(input.policy);
  const definition: Definition = {
    kind: FIELD_REGISTRY_CHANGESET_KIND,
    version: FIELD_REGISTRY_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [fieldRegistryReadPort],
    validationPorts: [fieldRegistryValidationPort],
    transactionPorts: [fieldRegistryTransactionPort],
    allowedAggregateKinds: ['field_registry', 'intake_form'],
    allowedGuardKinds: ['field_registry_guard'],
    allowedRisks: ['low', 'normal'],
    allowedConsequences: ['field_registry_changed'],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'field_registry.changed', retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'field_registry_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = authorInputSchema.parse(authorInput);
      const port = snapshot.getPort(fieldRegistryReadPort);
      const mutation = planFieldRegistryMutation({
        state: requireState(author.scope, port), author, formReferences: port
      });
      return {
        plan: { policy: input.policy, mutation },
        aggregateRefs: [
          ...aggregateRefs(mutation),
          ...(mutation.formPin
            ? [{ id: `intake_form:${mutation.formPin.id}`, version: mutation.formPin.version }]
            : [])
        ],
        guardRefs: guardRefs(mutation),
        riskTier: input.policy.ordinaryRisk,
        consequences: ['field_registry_changed']
      };
    },
    projectDiff(plan) {
      return { diff: safeDiff(plan.mutation), representedConsequences: ['field_registry_changed'] };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(fieldRegistryValidationPort);
      if (canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(input.policy)) {
        return { kind: 'outcome', outcome: refusal('policy_changed', plan.mutation) };
      }
      const state = port.readFieldRegistry(plan.mutation.scope);
      if (!state) return { kind: 'outcome', outcome: refusal('wrong_scope', plan.mutation) };
      const code = validateFieldRegistryMutationPlan({
        state, plan: plan.mutation, formReferences: port
      });
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan.mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const port = transaction.getPort(fieldRegistryTransactionPort);
      const result = port.applyFieldRegistryPlan(plan.mutation);
      return {
        result,
        facts: [{
          kind: 'field_registry_changed', version: 1,
          payload: {
            action: result.action,
            fieldId: result.fieldId,
            registryVersion: result.registryVersion,
            fieldVersion: result.fieldVersion,
            position: result.position
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      return deriveCompensation(plan.mutation, snapshot.getPort(fieldRegistryReadPort));
    }
  };
  const bundle = Object.freeze({
    policy: input.policy,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, outcomeDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertFieldRegistryOrdinaryChangesetBundle(
  candidate: FieldRegistryOrdinaryChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) {
    throw new TypeError('invalid_field_registry_ordinary_changeset_bundle');
  }
  assertFieldRegistryOrdinaryPolicy(candidate.policy);
}

function deriveCompensation(
  plan: FieldRegistryMutationPlan,
  port: FieldRegistryReadPort
): CompensationDerivation<FieldRegistryAuthorInput> {
  const state = port.readFieldRegistry(plan.scope);
  if (!state) return { kind: 'blocked', reasonKey: 'field_registry.scope_missing' };
  const current = parseFieldRegistryState(state);
  const id = fieldRegistryFieldId(plan);
  const active = current.fields.find((field) => field.id === id);
  const removed = current.removed.find((candidate) => candidate.field.id === id);
  if (current.version !== plan.resultingRegistryVersion) {
    return { kind: 'blocked', reasonKey: 'field_registry.later_change' };
  }
  if (plan.action === 'add') {
    if (!active || canonicalJsonSha256(active) !== canonicalJsonSha256(plan.after)) {
      return { kind: 'blocked', reasonKey: 'field_registry.field_changed' };
    }
    return { kind: 'blocked', reasonKey: 'field_registry.fresh_removal_attribution_required' };
  }
  if (plan.action === 'remove') {
    if (!removed || canonicalJsonSha256(removed.field) !== canonicalJsonSha256(plan.before)) {
      return { kind: 'blocked', reasonKey: 'field_registry.removal_changed' };
    }
    return {
      kind: 'exact',
      authorInput: {
        action: 'restore', scope: plan.scope,
        request: {
          fieldId: removed.field.id,
          expectedFieldVersion: removed.field.version,
          expectedRegistryVersion: current.version,
          toIndex: removed.lastPosition
        }
      }
    };
  }
  if (plan.action === 'restore') {
    if (!active || canonicalJsonSha256(active) !== canonicalJsonSha256(plan.after)) {
      return { kind: 'blocked', reasonKey: 'field_registry.restore_changed' };
    }
    return { kind: 'blocked', reasonKey: 'field_registry.fresh_removal_attribution_required' };
  }
  if (plan.action === 'move') {
    if (!active || active.position !== plan.afterIndex || active.version !== plan.fieldVersion) {
      return { kind: 'blocked', reasonKey: 'field_registry.order_changed' };
    }
    return {
      kind: 'exact',
      authorInput: {
        action: 'move', scope: plan.scope,
        request: {
          fieldId: active.id,
          expectedFieldVersion: active.version,
          expectedRegistryVersion: current.version,
          toIndex: plan.beforeIndex
        }
      }
    };
  }
  if (!active || canonicalJsonSha256(active) !== canonicalJsonSha256(plan.after)) {
    return { kind: 'blocked', reasonKey: 'field_registry.field_changed' };
  }
  const choiceIdentities = plan.before.options.kind === 'custom'
    ? plan.before.options.choices.map(({ id, key }) => ({ id, key }))
    : [];
  return {
    kind: 'semantic',
    noteKey: 'field_registry.definition_semantically_restored',
    authorInput: {
      action: 'edit', scope: plan.scope,
      request: {
        fieldId: active.id,
        expectedFieldVersion: active.version,
        expectedRegistryVersion: current.version,
        changes: {
          label: plan.before.label,
          help: plan.before.help,
          contexts: plan.before.contexts,
          ...(plan.before.options.kind === 'custom'
            ? { customOptionLabels: plan.before.options.choices.map((choice) => choice.label) }
            : {})
        }
      },
      choiceIdentities
    }
  };
}

export function captureFieldRegistryChangesetApprovalPolicy(input: {
  readonly bundle: FieldRegistryOrdinaryChangesetBundle;
}) {
  assertFieldRegistryOrdinaryChangesetBundle(input.bundle);
  return captureFieldRegistryApprovalPolicy({ policy: input.bundle.policy });
}

export function applyFieldRegistryChangesetPlan(input: {
  readonly port: FieldRegistryReadPort;
  readonly plan: FieldRegistryMutationPlan;
}): FieldRegistryChangeResult {
  const state = requireState(input.plan.scope, input.port);
  return applyFieldRegistryMutationPlan({
    state, plan: input.plan, formReferences: input.port
  }).result;
}

export function currentFieldRegistryGuard(input: {
  readonly port: FieldRegistryReadPort;
  readonly scope: FieldRegistryScopeDto;
}) {
  const state = requireState(input.scope, input.port);
  return Object.freeze({
    id: `field_registry_guard:${state.scope.eventId}`,
    version: state.version,
    digest: fieldRegistryGuardDigest(state)
  });
}
