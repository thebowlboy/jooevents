import {
  programVocabularyChangeResultSchema,
  programVocabularyDraftInputSchema,
  programVocabularyIdSchema,
  programVocabularyNameSchema,
  programVocabularySafeDiffSchema,
  programVocabularyScopeSchema,
  programTrackAccentSchema,
  programVocabularyVersionSchema,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyKind,
  type ProgramVocabularySafeDiff,
  type ProgramVocabularyScopeDto
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
  type ChangesetPlanningSnapshot,
  type ChangesetTransaction,
  type CompensationDerivation,
  type RiskTier
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  mergeReferenceCounts,
  parseProgramVocabularyMutationPlan,
  planProgramVocabularyMutation,
  plannedProgramVocabularyItem,
  programVocabularyAggregateId,
  programVocabularySetGuardId,
  validateProgramVocabularyPlan,
  type PlannedProgramVocabularyItem,
  type ProgramMergeCompensationInput,
  type ProgramMergeCompensationPlan,
  type ProgramMergePlan,
  type ProgramReferenceContributionPlan,
  type ProgramVocabularyAuthorInput,
  type ProgramVocabularyMutationPlan,
  type ProgramVocabularyPlanningErrorCode
} from './domain';
import {
  resolveProgramVocabularyItem,
  type ProgramVocabularyState
} from './model';
import {
  captureRegisteredProgramReferences,
  assertProgramReferenceContributorRegistry,
  programReferenceUsage,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorRegistry,
  type ProgramReferenceSnapshotSource
} from './references';
import {
  assertProgramVocabularyOrdinaryPolicy,
  type ProgramVocabularyOrdinaryPolicy
} from './policy';

export const PROGRAM_VOCABULARY_CHANGESET_KIND = 'program.vocabulary.mutate';
export const PROGRAM_VOCABULARY_CHANGESET_VERSION = 1;

export interface ProgramVocabularyReadPort extends ProgramReferenceSnapshotSource {
  readVocabulary(scope: ProgramVocabularyScopeDto): ProgramVocabularyState | undefined;
}

export interface ProgramVocabularyTransactionPort extends ProgramVocabularyReadPort {
  applyVocabularyPlan(plan: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult;
}

export function createProgramVocabularyValidationView(
  port: ProgramVocabularyReadPort
): ProgramVocabularyReadPort {
  return Object.freeze({
    readVocabulary(scope: ProgramVocabularyScopeDto) {
      return port.readVocabulary(scope);
    },
    readContributor(contributor: ProgramReferenceContributorRef, scope: ProgramVocabularyState['scope']) {
      return port.readContributor(contributor, scope);
    }
  });
}

export const programVocabularyReadPort = defineChangesetReadPort<ProgramVocabularyReadPort>(
  'program_vocabulary.read',
  1
);
export const programVocabularyValidationPort = defineChangesetValidationPort<ProgramVocabularyReadPort>(
  'program_vocabulary.validation',
  1
);
export const programVocabularyTransactionPort = defineChangesetTransactionPort<ProgramVocabularyTransactionPort>(
  'program_vocabulary.transaction',
  1
);

export interface ProgramVocabularyTrialPolicy {
  readonly activation: 'test_only';
  readonly key: string;
  readonly version: number;
  readonly ordinaryRisk: Extract<RiskTier, 'low' | 'normal'>;
  readonly mergeRisk: Extract<RiskTier, 'normal' | 'consequential'>;
}

type ProgramVocabularyChangesetPolicy =
  | ProgramVocabularyTrialPolicy
  | ProgramVocabularyOrdinaryPolicy;

type ProgramVocabularyChangesetDefinition = ChangesetOperationDefinition<
  ProgramVocabularyAuthorInput,
  ProgramVocabularyChangesetPlan,
  ProgramVocabularySafeDiff,
  ProgramVocabularyChangesetPlan,
  ProgramVocabularyChangeResult
>;

export interface ProgramVocabularyChangesetBundle {
  readonly policy: ProgramVocabularyTrialPolicy;
  readonly definition: ProgramVocabularyChangesetDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

export interface ProgramVocabularyOrdinaryChangesetBundle {
  readonly policy: ProgramVocabularyOrdinaryPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedOrdinaryBundles = new WeakSet<object>();

const contributorRefSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  version: programVocabularyVersionSchema
});

const mergeCompensationInputShape: z.ZodType<ProgramMergeCompensationInput> = z.strictObject({
  action: z.literal('merge_compensation'),
  scope: programVocabularyScopeSchema,
  kind: z.enum(['room', 'track', 'format']),
  sourceId: programVocabularyIdSchema,
  targetId: programVocabularyIdSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  expectedSourceVersion: programVocabularyVersionSchema,
  expectedTargetVersion: programVocabularyVersionSchema,
  restoreSource: z.boolean(),
  references: z.array(z.strictObject({
    contributor: contributorRefSchema,
    referenceKeys: z.array(z.string().min(1).max(300).refine((value) => value.trim() === value))
  }))
});

const mergeCompensationInputSchema: z.ZodType<ProgramMergeCompensationInput> =
  mergeCompensationInputShape;

const authorInputSchema = defineChangesetSchema({
  key: 'program.vocabulary.author',
  version: 1,
  schema: z.union([programVocabularyDraftInputSchema, mergeCompensationInputSchema])
});

const plannedItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: z.enum(['active', 'retired']),
    version: programVocabularyVersionSchema,
    capacity: z.number().int().positive().nullable()
  }),
  z.strictObject({
    kind: z.literal('track'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    accent: programTrackAccentSchema,
    status: z.enum(['active', 'retired']),
    version: programVocabularyVersionSchema
  }),
  z.strictObject({
    kind: z.literal('format'),
    id: programVocabularyIdSchema,
    name: programVocabularyNameSchema,
    status: z.enum(['active', 'retired']),
    version: programVocabularyVersionSchema
  })
]);

const referenceTargetSchema = z.strictObject({
  kind: z.enum(['room', 'track', 'format']),
  id: programVocabularyIdSchema
});
const safeDestinationSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  id: z.string().min(1).max(300).refine((value) => value.trim() === value)
});
const referenceContributionSchema = z.strictObject({
  contributor: contributorRefSchema,
  guard: z.strictObject({
    id: z.string().regex(/^program_reference:[A-Za-z0-9._~:-]+$/),
    version: programVocabularyVersionSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  liveRepoints: z.array(z.strictObject({
    referenceKey: z.string().min(1).max(300).refine((value) => value.trim() === value),
    expectedVersion: programVocabularyVersionSchema,
    from: referenceTargetSchema,
    to: referenceTargetSchema,
    destination: safeDestinationSchema
  })),
  historicalPins: z.array(z.strictObject({
    referenceKey: z.string().min(1).max(300).refine((value) => value.trim() === value),
    version: programVocabularyVersionSchema,
    item: referenceTargetSchema,
    destination: safeDestinationSchema
  }))
});

const planBase = {
  scope: programVocabularyScopeSchema,
  expectedSetVersion: programVocabularyVersionSchema,
  setGuardDigest: z.string().regex(/^[a-f0-9]{64}$/)
} as const;
const referencePlanFields = {
  referenceRegistryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  references: z.array(referenceContributionSchema)
} as const;
const mutationPlanSchema: z.ZodType<ProgramVocabularyMutationPlan> = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), ...planBase, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('edit'), ...planBase, before: plannedItemSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('retire'), ...planBase, before: plannedItemSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('restore'), ...planBase, before: plannedItemSchema, after: plannedItemSchema }),
  z.strictObject({ action: z.literal('delete'), ...planBase, before: plannedItemSchema, ...referencePlanFields }),
  z.strictObject({
    action: z.literal('merge'),
    ...planBase,
    sourceBefore: plannedItemSchema,
    sourceAfter: plannedItemSchema,
    target: plannedItemSchema,
    ...referencePlanFields
  }),
  z.strictObject({
    action: z.literal('merge_compensation'),
    ...planBase,
    sourceBefore: plannedItemSchema,
    sourceAfter: plannedItemSchema,
    target: plannedItemSchema,
    restoreSource: z.boolean(),
    ...referencePlanFields
  })
]).superRefine((value, context) => {
  try {
    parseProgramVocabularyMutationPlan(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'mutation plan must be canonical and coherent' });
  }
});

const trialPolicySchema = z.strictObject({
  activation: z.literal('test_only'),
  key: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  version: programVocabularyVersionSchema,
  ordinaryRisk: z.enum(['low', 'normal']),
  mergeRisk: z.enum(['normal', 'consequential'])
});

const ordinaryPolicySchema = z.strictObject({
  activation: z.literal('ordinary'),
  key: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  version: programVocabularyVersionSchema,
  ordinaryRisk: z.enum(['low', 'normal']),
  mergeRisk: z.enum(['normal', 'consequential']),
  approval: z.strictObject({
    ordinary: z.enum(['none', 'distinct_current_human']),
    merge: z.enum(['none', 'distinct_current_human'])
  }),
  definitionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
}).superRefine((policy, context) => {
  const digest = canonicalJsonSha256({
    activation: policy.activation,
    key: policy.key,
    version: policy.version,
    ordinaryRisk: policy.ordinaryRisk,
    mergeRisk: policy.mergeRisk,
    approval: policy.approval
  });
  if (digest !== policy.definitionDigestSha256) {
    context.addIssue({
      code: 'custom',
      path: ['definitionDigestSha256'],
      message: 'Program Vocabulary policy definition digest changed.'
    });
  }
});

const policySchema: z.ZodType<ProgramVocabularyChangesetPolicy> =
  z.discriminatedUnion('activation', [trialPolicySchema, ordinaryPolicySchema]);

const changesetPlanSchema = defineChangesetSchema({
  key: 'program.vocabulary.plan',
  version: 1,
  schema: z.strictObject({ policy: policySchema, mutation: mutationPlanSchema })
});
const safeDiffSchema = defineChangesetSchema({
  key: 'program.vocabulary.safe_diff',
  version: 1,
  schema: programVocabularySafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'program.vocabulary.result',
  version: 1,
  schema: programVocabularyChangeResultSchema
});
const outcomeDetailSchema = defineChangesetSchema({
  key: 'program.vocabulary.stale_detail',
  version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope',
      'stale_set',
      'item_exists',
      'item_missing',
      'stale_item',
      'invalid_transition',
      'delete_referenced',
      'invalid_merge',
      'stale_reference',
      'invalid_plan',
      'policy_changed'
    ]),
    action: z.enum(['create', 'edit', 'retire', 'restore', 'delete', 'merge', 'merge_compensation']),
    kind: z.enum(['room', 'track', 'format']),
    ids: z.array(programVocabularyIdSchema).min(1).max(2)
  })
});

export type ProgramVocabularyChangesetPlan = z.infer<typeof changesetPlanSchema.schema>;

function samePolicy(
  left: ProgramVocabularyChangesetPolicy,
  right: ProgramVocabularyChangesetPolicy
): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

function operationKindAndIds(plan: ProgramVocabularyMutationPlan): {
  readonly kind: ProgramVocabularyKind;
  readonly ids: readonly string[];
} {
  if (plan.action === 'create') return { kind: plan.after.kind, ids: [plan.after.id] };
  if (plan.action === 'merge' || plan.action === 'merge_compensation') {
    return { kind: plan.sourceBefore.kind, ids: [plan.sourceBefore.id, plan.target.id] };
  }
  return { kind: plan.before.kind, ids: [plan.before.id] };
}

function aggregateRefs(plan: ProgramVocabularyMutationPlan): readonly { readonly id: string; readonly version: number }[] {
  if (plan.action === 'create') return [];
  if (plan.action === 'merge' || plan.action === 'merge_compensation') {
    return [
      { id: programVocabularyAggregateId(plan.sourceBefore), version: plan.sourceBefore.version },
      { id: programVocabularyAggregateId(plan.target), version: plan.target.version }
    ];
  }
  return [{ id: programVocabularyAggregateId(plan.before), version: plan.before.version }];
}

function guardRefs(plan: ProgramVocabularyMutationPlan): readonly {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}[] {
  const guards = [{
    id: programVocabularySetGuardId(plan.scope.eventId),
    version: plan.expectedSetVersion,
    digest: plan.setGuardDigest
  }];
  if (plan.action === 'delete' || plan.action === 'merge' || plan.action === 'merge_compensation') {
    guards.push(...plan.references.map((reference) => ({ ...reference.guard })));
  }
  return guards;
}

function safeDiff(plan: ProgramVocabularyMutationPlan): ProgramVocabularySafeDiff {
  if (plan.action === 'create') return { action: 'create', before: null, after: plan.after };
  if (plan.action === 'edit') return { action: 'edit', before: plan.before, after: plan.after };
  if (plan.action === 'retire') return { action: 'retire', before: plan.before, after: plan.after };
  if (plan.action === 'restore') return { action: 'restore', before: plan.before, after: plan.after };
  if (plan.action === 'delete') {
    return {
      action: 'delete',
      before: plan.before,
      after: null,
      usage: {
        current: plan.references.reduce((sum, contributor) => sum + contributor.liveRepoints.length, 0),
        historicalPins: plan.references.reduce((sum, contributor) => sum + contributor.historicalPins.length, 0)
      }
    };
  }
  const counts = mergeReferenceCounts(plan);
  return {
    action: plan.action,
    sourceBefore: plan.sourceBefore,
    sourceAfter: plan.sourceAfter,
    target: plan.target,
    liveRepoints: counts.liveRepoints,
    historicalPinsPreserved: counts.historicalPins
  };
}

function currentState(
  input: ProgramVocabularyAuthorInput,
  snapshot: ChangesetPlanningSnapshot
): { readonly port: ProgramVocabularyReadPort; readonly state: ProgramVocabularyState } {
  return currentStateForScope(input.scope, snapshot);
}

function currentStateForScope(
  scope: ProgramVocabularyScopeDto,
  snapshot: ChangesetPlanningSnapshot
): { readonly port: ProgramVocabularyReadPort; readonly state: ProgramVocabularyState } {
  const port = snapshot.getPort(programVocabularyReadPort);
  const state = port.readVocabulary(scope);
  if (!state) throw new TypeError('program_vocabulary_scope_missing');
  return { port, state };
}

function plannedItemEqual(left: PlannedProgramVocabularyItem, right: PlannedProgramVocabularyItem): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

function contributorIdentity(contributor: ProgramReferenceContributorRef): string {
  return `${contributor.key}@${contributor.version}`;
}

function mergeCompensation(
  plan: ProgramMergePlan,
  state: ProgramVocabularyState,
  port: ProgramVocabularyReadPort,
  registry: ProgramReferenceContributorRegistry
): CompensationDerivation<ProgramVocabularyAuthorInput> {
  const source = resolveProgramVocabularyItem(state, plan.sourceAfter.kind, plan.sourceAfter.id);
  const target = resolveProgramVocabularyItem(state, plan.target.kind, plan.target.id);
  if (!source || !target) return { kind: 'blocked', reasonKey: 'program.merge_item_missing' };
  const references = captureRegisteredProgramReferences({ registry, scope: state.scope, source: port });
  const actualByContributor = new Map(references.contributors.map((entry) => [
    contributorIdentity(entry.contributor),
    new Map(entry.references.map((reference) => [reference.referenceKey, reference]))
  ]));
  const selected: ProgramMergeCompensationInput['references'][number][] = [];
  const conflictKeys = new Set<string>();
  for (const contribution of plan.references) {
    const actual = actualByContributor.get(contributorIdentity(contribution.contributor));
    const referenceKeys: string[] = [];
    for (const repoint of contribution.liveRepoints) {
      const current = actual?.get(repoint.referenceKey);
      if (current?.mode === 'current'
          && current.item.kind === repoint.to.kind
          && current.item.id === repoint.to.id
          && current.version === repoint.expectedVersion + 1) {
        referenceKeys.push(repoint.referenceKey);
      } else {
        conflictKeys.add('program.merge_reference_changed');
      }
    }
    if (referenceKeys.length > 0) selected.push({ contributor: contribution.contributor, referenceKeys });
  }
  const sourceStillHasMergedStatus = source.status === plan.sourceAfter.status;
  const restoreSource = sourceStillHasMergedStatus && plan.sourceBefore.status === 'active';
  if (!sourceStillHasMergedStatus) conflictKeys.add('program.merge_source_changed');
  if (!restoreSource && selected.length === 0) {
    return { kind: 'blocked', reasonKey: 'program.no_safe_merge_compensation' };
  }
  const authorInput: ProgramMergeCompensationInput = Object.freeze({
    action: 'merge_compensation',
    scope: plan.scope,
    kind: plan.sourceBefore.kind,
    sourceId: source.id,
    targetId: target.id,
    expectedSetVersion: state.setVersion,
    expectedSourceVersion: source.version,
    expectedTargetVersion: target.version,
    restoreSource,
    references: Object.freeze(selected.map((entry) => Object.freeze({
      contributor: Object.freeze({ ...entry.contributor }),
      referenceKeys: Object.freeze([...entry.referenceKeys])
    })))
  });
  if (conflictKeys.size > 0) return { kind: 'partial', authorInput, conflicts: [...conflictKeys] };
  if (!plannedItemEqual(plannedProgramVocabularyItem(source), plan.sourceAfter)) {
    return { kind: 'semantic', authorInput, noteKey: 'program.merge_source_semantically_restored' };
  }
  return { kind: 'exact', authorInput };
}

function deriveCompensation(
  wrapped: ProgramVocabularyChangesetPlan,
  snapshot: ChangesetPlanningSnapshot,
  registry: ProgramReferenceContributorRegistry
): CompensationDerivation<ProgramVocabularyAuthorInput> {
  const plan = wrapped.mutation;
  const { port, state } = currentStateForScope(plan.scope, snapshot);
  if (plan.action === 'create') {
    const current = resolveProgramVocabularyItem(state, plan.after.kind, plan.after.id);
    if (!current || !plannedItemEqual(plannedProgramVocabularyItem(current), plan.after)) {
      return { kind: 'blocked', reasonKey: 'program.creation_changed' };
    }
    const references = captureRegisteredProgramReferences({ registry, scope: state.scope, source: port });
    const usage = programReferenceUsage(references, current);
    const common = {
      scope: plan.scope,
      kind: current.kind,
      id: current.id,
      expectedSetVersion: state.setVersion,
      expectedItemVersion: current.version
    };
    if (usage.current === 0 && usage.historicalPins === 0) {
      return { kind: 'exact', authorInput: { action: 'delete', ...common } };
    }
    if (current.status === 'active') {
      return {
        kind: 'semantic',
        authorInput: { action: 'retire', ...common },
        noteKey: 'program.creation_retired_due_to_usage'
      };
    }
    return { kind: 'blocked', reasonKey: 'program.creation_already_retired' };
  }
  if (plan.action === 'edit') {
    const current = resolveProgramVocabularyItem(state, plan.after.kind, plan.after.id);
    if (!current) return { kind: 'blocked', reasonKey: 'program.item_missing' };
    const conflicts: string[] = [];
    let safeFields = 0;
    const name = current.name === plan.after.name
      ? (safeFields += 1, plan.before.name)
      : (conflicts.push('program.name_changed'), current.name);
    if (current.kind === 'room' && plan.after.kind === 'room' && plan.before.kind === 'room') {
      const capacity = current.capacity === plan.after.capacity
        ? (safeFields += 1, plan.before.capacity ?? null)
        : (conflicts.push('program.capacity_changed'), current.capacity);
      if (safeFields === 0) return { kind: 'blocked', reasonKey: 'program.no_safe_edit_compensation' };
      const authorInput: ProgramVocabularyAuthorInput = {
        action: 'edit', scope: plan.scope, kind: 'room', id: current.id,
        expectedSetVersion: state.setVersion, expectedItemVersion: current.version,
        changes: { name, capacity }
      };
      return conflicts.length > 0
        ? { kind: 'partial', authorInput, conflicts }
        : { kind: 'exact', authorInput };
    }
    if (safeFields === 0) return { kind: 'blocked', reasonKey: 'program.no_safe_edit_compensation' };
    const authorInput: ProgramVocabularyAuthorInput = {
      action: 'edit', scope: plan.scope, kind: current.kind, id: current.id,
      expectedSetVersion: state.setVersion, expectedItemVersion: current.version,
      changes: { name }
    } as ProgramVocabularyAuthorInput;
    return conflicts.length > 0
      ? { kind: 'partial', authorInput, conflicts }
      : { kind: 'exact', authorInput };
  }
  if (plan.action === 'retire' || plan.action === 'restore') {
    const current = resolveProgramVocabularyItem(state, plan.after.kind, plan.after.id);
    if (!current || current.status !== plan.after.status) {
      return { kind: 'blocked', reasonKey: 'program.lifecycle_changed' };
    }
    const authorInput: ProgramVocabularyAuthorInput = {
      action: plan.action === 'retire' ? 'restore' : 'retire',
      scope: plan.scope,
      kind: current.kind,
      id: current.id,
      expectedSetVersion: state.setVersion,
      expectedItemVersion: current.version
    };
    return plannedItemEqual(plannedProgramVocabularyItem(current), plan.after)
      ? { kind: 'exact', authorInput }
      : { kind: 'semantic', authorInput, noteKey: 'program.lifecycle_restores_status_only' };
  }
  if (plan.action === 'delete') {
    const current = resolveProgramVocabularyItem(state, plan.before.kind, plan.before.id);
    if (current) return { kind: 'blocked', reasonKey: 'program.deleted_identity_reused' };
    return {
      kind: 'exact',
      authorInput: createInputForDeletedItem(plan.before, plan.scope, state.setVersion)
    };
  }
  if (plan.action === 'merge') return mergeCompensation(plan, state, port, registry);
  return { kind: 'blocked', reasonKey: 'program.nested_merge_compensation_requires_replan' };
}

function createInputForDeletedItem(
  item: PlannedProgramVocabularyItem,
  scope: ProgramVocabularyScopeDto,
  expectedSetVersion: number
): ProgramVocabularyAuthorInput {
  if (item.kind === 'room') {
    return {
      action: 'create', scope, expectedSetVersion,
      item: { kind: 'room', id: item.id, name: item.name, capacity: item.capacity }
    };
  }
  if (item.kind === 'track') {
    return {
      action: 'create', scope, expectedSetVersion,
      item: { kind: 'track', id: item.id, name: item.name }
    };
  }
  return {
    action: 'create', scope, expectedSetVersion,
    item: { kind: 'format', id: item.id, name: item.name }
  };
}

function riskFor(plan: ProgramVocabularyMutationPlan, policy: ProgramVocabularyChangesetPolicy): RiskTier {
  if (plan.action === 'merge' || plan.action === 'merge_compensation') return policy.mergeRisk;
  if (plan.action === 'delete') return 'normal';
  return policy.ordinaryRisk;
}

function outcome(
  code: ProgramVocabularyPlanningErrorCode | 'policy_changed',
  plan: ProgramVocabularyMutationPlan
) {
  const subject = operationKindAndIds(plan);
  return {
    class: 'stale_revision' as const,
    kind: 'program_vocabulary_changed',
    retryable: false,
    subjects: subject.ids.map((id) => ({ type: `program_${subject.kind}`, id })),
    detail: { code, action: plan.action, kind: subject.kind, ids: [...subject.ids] },
    detailSchemaVersion: 1
  };
}

function createBundle(input: {
  readonly referenceRegistry: ProgramReferenceContributorRegistry;
  readonly policy: ProgramVocabularyChangesetPolicy;
}): {
  readonly policy: ProgramVocabularyChangesetPolicy;
  readonly definition: ProgramVocabularyChangesetDefinition;
  readonly registry: ChangesetDefinitionRegistry;
} {
  assertProgramReferenceContributorRegistry(input.referenceRegistry);
  const parsedPolicy = policySchema.parse(input.policy);
  const policy = input.policy.activation === 'ordinary' ? input.policy : parsedPolicy;
  const definition: ProgramVocabularyChangesetDefinition = {
    kind: PROGRAM_VOCABULARY_CHANGESET_KIND,
    version: PROGRAM_VOCABULARY_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: changesetPlanSchema.reference,
      diff: safeDiffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [programVocabularyReadPort],
    validationPorts: [programVocabularyValidationPort],
    transactionPorts: [programVocabularyTransactionPort],
    allowedAggregateKinds: ['program_room', 'program_track', 'program_format'],
    allowedGuardKinds: ['program_vocabulary_set', 'program_reference'],
    allowedRisks: ['low', 'normal', 'consequential'],
    allowedConsequences: ['program_vocabulary_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'program_vocabulary_changed',
      retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'program_vocabulary_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const { port, state } = currentState(authorInput, snapshot);
      const mutation = planProgramVocabularyMutation({
        authorInput,
        state,
        referenceRegistry: input.referenceRegistry,
        referenceSource: port
      });
      return {
        plan: { policy, mutation },
        aggregateRefs: aggregateRefs(mutation),
        guardRefs: guardRefs(mutation),
        riskTier: riskFor(mutation, policy),
        consequences: ['program_vocabulary_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: programVocabularySafeDiffSchema.parse(safeDiff(plan.mutation)),
        representedConsequences: ['program_vocabulary_changed']
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(programVocabularyValidationPort);
      const state = port.readVocabulary(plan.mutation.scope);
      if (!state) return { kind: 'outcome', outcome: outcome('wrong_scope', plan.mutation) };
      if (!samePolicy(plan.policy, policy)) {
        return { kind: 'outcome', outcome: outcome('policy_changed', plan.mutation) };
      }
      const refusal = validateProgramVocabularyPlan(
        state,
        plan.mutation,
        input.referenceRegistry,
        port
      );
      return refusal
        ? { kind: 'outcome', outcome: outcome(refusal, plan.mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(programVocabularyTransactionPort).applyVocabularyPlan(plan.mutation);
      return {
        result,
        facts: [{
          kind: 'program_vocabulary_changed',
          version: 1,
          payload: {
            action: result.action,
            kind: result.kind,
            affectedIds: result.affectedIds,
            setVersion: result.setVersion,
            liveRepoints: result.liveRepoints
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      return deriveCompensation(plan, snapshot, input.referenceRegistry);
    }
  };
  const registry = createChangesetDefinitionRegistry({
    schemas: [authorInputSchema, changesetPlanSchema, safeDiffSchema, resultSchema, outcomeDetailSchema],
    definitions: [definition]
  });
  return Object.freeze({ policy: Object.freeze(policy), definition, registry });
}

export function createProgramVocabularyChangesetBundle(input: {
  readonly referenceRegistry: ProgramReferenceContributorRegistry;
  readonly policy: ProgramVocabularyTrialPolicy;
}): ProgramVocabularyChangesetBundle {
  if (input.policy.activation !== 'test_only') {
    throw new TypeError('program_vocabulary_trial_policy_required');
  }
  return createBundle(input) as ProgramVocabularyChangesetBundle;
}

/** Creates the ordinary definition registry only from module-issued policy evidence. */
export function createProgramVocabularyOrdinaryChangesetBundle(input: {
  readonly referenceRegistry: ProgramReferenceContributorRegistry;
  readonly policy: ProgramVocabularyOrdinaryPolicy;
}): ProgramVocabularyOrdinaryChangesetBundle {
  assertProgramVocabularyOrdinaryPolicy(input.policy);
  const internal = createBundle(input);
  const bundle: ProgramVocabularyOrdinaryChangesetBundle = Object.freeze({
    policy: input.policy,
    registry: internal.registry
  });
  issuedOrdinaryBundles.add(bundle);
  return bundle;
}

/** Rejects copied bundles even when all visible fields are structurally identical. */
export function assertProgramVocabularyOrdinaryChangesetBundle(
  candidate: ProgramVocabularyOrdinaryChangesetBundle
): void {
  if (!issuedOrdinaryBundles.has(candidate)) {
    throw new TypeError('invalid_program_vocabulary_ordinary_bundle');
  }
  assertProgramVocabularyOrdinaryPolicy(candidate.policy);
}
