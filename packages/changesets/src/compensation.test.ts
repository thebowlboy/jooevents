import { describe, expect, test } from 'bun:test';
import { parseOperationReceiptId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  applyPreparedChangeset,
  createChangeset,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetValidationPort,
  defineChangesetTransactionPort,
  markChangesetCommitted,
  planChangesetCompensation,
  planChangesetOperation,
  prepareChangesetCommit,
  proposeChangeset,
  validateExactCommit,
  type ChangesetDefinitionRegistry,
  type ChangesetCommitTransaction,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot,
  type CommittedChangesetSource,
  type CompensationDerivation,
  type DependencyGroup,
  type FrozenChangesetOperation
} from '.';

type MutableField = 'title' | 'color';

interface RecordValue {
  readonly id: string;
  readonly title: string;
  readonly color: string;
  readonly note: string;
  readonly version: number;
}

interface RecordReadPort {
  get(id: string): RecordValue | undefined;
  guardDigest(): string;
}

interface RecordTransactionPort extends RecordReadPort {
  update(
    id: string,
    expectedVersion: number,
    updates: readonly { readonly field: MutableField; readonly value: string }[]
  ): RecordValue;
}

interface SecretReadPort {
  read(): string;
}

const recordReadPort = defineChangesetReadPort<RecordReadPort>('record.read', 1);
const secretReadPort = defineChangesetReadPort<SecretReadPort>('secret.read', 1);
const recordValidationPort = defineChangesetValidationPort<RecordReadPort>('record.validation', 1);
const recordTransactionPort = defineChangesetTransactionPort<RecordTransactionPort>('record.transaction', 1);

const fieldSchema = z.enum(['title', 'color']);
const updateSchema = z.strictObject({ field: fieldSchema, value: z.string().min(1) });
const changeSchema = z.strictObject({
  field: fieldSchema,
  before: z.string().min(1),
  after: z.string().min(1)
});
const authorSchema = defineChangesetSchema({
  key: 'record.change.author',
  version: 1,
  schema: z.strictObject({ id: z.string().min(1), updates: z.array(updateSchema).min(1) })
});
const planSchema = defineChangesetSchema({
  key: 'record.change.plan',
  version: 1,
  schema: z.strictObject({
    id: z.string().min(1),
    changes: z.array(changeSchema).min(1),
    expectedVersion: z.number().int().positive()
  })
});
const diffSchema = defineChangesetSchema({
  key: 'record.change.diff',
  version: 1,
  schema: z.strictObject({
    changes: z.array(changeSchema).min(1),
    consequence: z.literal('record_changed')
  })
});
const resultSchema = defineChangesetSchema({
  key: 'record.change.result',
  version: 1,
  schema: z.strictObject({ id: z.string().min(1), version: z.number().int().positive() })
});
const staleDetailSchema = defineChangesetSchema({
  key: 'record.change.stale_detail',
  version: 1,
  schema: z.strictObject({ expectedVersion: z.number().int().positive() })
});

type AuthorInput = z.infer<typeof authorSchema.schema>;
type RecordPlan = z.infer<typeof planSchema.schema>;
type RecordDiff = z.infer<typeof diffSchema.schema>;
type RecordResult = z.infer<typeof resultSchema.schema>;
type Derive = (
  plan: RecordPlan,
  snapshot: ChangesetPlanningSnapshot
) => CompensationDerivation<AuthorInput>;

class RecordStore implements RecordReadPort, RecordTransactionPort {
  readonly records = new Map<string, RecordValue>();
  readonly applicationOrder: string[] = [];
  private guardVersion = 1;

  constructor(records: readonly RecordValue[]) {
    for (const record of records) this.records.set(record.id, record);
  }

  get(id: string): RecordValue | undefined {
    return this.records.get(id);
  }

  guardDigest(): string {
    return `record-guard-${this.guardVersion}`;
  }

  update(
    id: string,
    expectedVersion: number,
    updates: readonly { readonly field: MutableField; readonly value: string }[]
  ): RecordValue {
    const current = this.records.get(id);
    if (!current || current.version !== expectedVersion) throw new TypeError('record_stale');
    let next = current;
    for (const update of updates) next = { ...next, [update.field]: update.value };
    next = { ...next, version: current.version + 1 };
    this.records.set(id, next);
    this.applicationOrder.push(id);
    this.guardVersion += 1;
    return next;
  }

  edit(id: string, patch: Partial<Pick<RecordValue, 'title' | 'color' | 'note'>>): void {
    const current = this.records.get(id);
    if (!current) throw new TypeError('record_missing');
    this.records.set(id, { ...current, ...patch, version: current.version + 1 });
    this.guardVersion += 1;
  }
}

function snapshot(store: RecordStore): ChangesetPlanningSnapshot {
  return { getPort: <Port>() => store as unknown as Port };
}

function transaction(store: RecordStore): ChangesetCommitTransaction {
  return {
    getPort: <Port>() => store as unknown as Port
  };
}

const defaultDerive: Derive = (plan, currentSnapshot) => {
  const current = currentSnapshot.getPort(recordReadPort).get(plan.id);
  if (!current) return { kind: 'blocked', reasonKey: 'record.missing' };

  const updates: AuthorInput['updates'][number][] = [];
  const conflicts: string[] = [];
  let semantic = false;
  for (const change of plan.changes) {
    const currentValue = current[change.field];
    if (currentValue === change.after) {
      updates.push({ field: change.field, value: change.before });
    } else if (currentValue.toLocaleLowerCase() === change.after.toLocaleLowerCase()) {
      semantic = true;
      updates.push({ field: change.field, value: change.before });
    } else {
      conflicts.push(`record.${change.field}_changed_since_source`);
    }
  }
  if (updates.length === 0) return { kind: 'blocked', reasonKey: 'record.no_safe_compensation' };
  const authorInput = { id: plan.id, updates };
  if (conflicts.length > 0) return { kind: 'partial', authorInput, conflicts };
  if (semantic) return { kind: 'semantic', authorInput, noteKey: 'record.semantic_match' };
  return { kind: 'exact', authorInput };
};

function definition(kind: string, derive: Derive = defaultDerive): ChangesetOperationDefinition<
  AuthorInput,
  RecordPlan,
  RecordDiff,
  RecordPlan,
  RecordResult
> {
  return {
    kind,
    version: 1,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [recordReadPort],
    validationPorts: [recordValidationPort],
    transactionPorts: [recordTransactionPort],
    allowedAggregateKinds: ['record'],
    allowedGuardKinds: ['record_index'],
    allowedRisks: ['normal'],
    allowedConsequences: ['record_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'record_changed',
      retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'record_changed', version: 1 }],
    allowedEffects: [],
    plan(input, currentSnapshot) {
      if (new Set(input.updates.map((update) => update.field)).size !== input.updates.length) {
        throw new TypeError('duplicate_record_field');
      }
      const current = currentSnapshot.getPort(recordReadPort).get(input.id);
      if (!current) throw new TypeError('record_missing');
      return {
        plan: {
          id: current.id,
          changes: input.updates.map((update) => ({
            field: update.field,
            before: current[update.field],
            after: update.value
          })),
          expectedVersion: current.version
        },
        aggregateRefs: [{ id: `record:${current.id}`, version: current.version }],
        guardRefs: [{
          id: 'record_index:all',
          version: 1,
          digest: currentSnapshot.getPort(recordReadPort).guardDigest()
        }],
        riskTier: 'normal',
        consequences: ['record_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: { changes: plan.changes, consequence: 'record_changed' },
        representedConsequences: ['record_changed']
      };
    },
    validateWithin(plan, currentTransaction) {
      const current = currentTransaction.getPort(recordValidationPort).get(plan.id);
      if (!current || current.version !== plan.expectedVersion) {
        return {
          kind: 'outcome',
          outcome: {
            class: 'stale_revision',
            kind: 'record_changed',
            retryable: false,
            subjects: [{ type: 'record', id: plan.id }],
            detail: { expectedVersion: plan.expectedVersion },
            detailSchemaVersion: 1
          }
        };
      }
      return { kind: 'ready', validated: plan };
    },
    applyWithin(plan, currentTransaction) {
      const updated = currentTransaction.getPort(recordTransactionPort).update(
        plan.id,
        plan.expectedVersion,
        plan.changes.map((change) => ({ field: change.field, value: change.after }))
      );
      return {
        result: { id: updated.id, version: updated.version },
        facts: [{
          kind: 'record_changed',
          version: 1,
          payload: { id: updated.id, version: updated.version }
        }],
        effects: []
      };
    },
    deriveCompensation: derive
  };
}

const reversibleDefinition = definition('record.change');
const irreversibleDefinition = definition('record.notify', () => ({
  kind: 'irreversible',
  remediationKey: 'record.manual_followup'
}));
const mixedSemanticDefinition = definition('record.mixed_semantic', (plan) => ({
  kind: 'semantic',
  authorInput: {
    id: plan.id,
    updates: plan.changes.map((change) => ({ field: change.field, value: change.before }))
  },
  noteKey: 'record.semantic_match'
}));
const mixedPartialDefinition = definition('record.mixed_partial', (plan) => ({
  kind: 'partial',
  authorInput: {
    id: plan.id,
    updates: plan.changes.map((change) => ({ field: change.field, value: change.before }))
  },
  conflicts: ['record.later_work_preserved']
}));
const mixedBlockedDefinition = definition('record.mixed_blocked', () => ({
  kind: 'blocked',
  reasonKey: 'record.correction_requires_review'
}));
const undeclaredPortDefinition = definition('record.undeclared', (plan, currentSnapshot) => {
  currentSnapshot.getPort(secretReadPort).read();
  return { kind: 'exact', authorInput: { id: plan.id, updates: [] } };
});

const schemas = [authorSchema, planSchema, diffSchema, resultSchema, staleDetailSchema];

function registry(definitions: readonly ChangesetOperationDefinition<any, any, any, any, any>[] = [reversibleDefinition]): ChangesetDefinitionRegistry {
  return createChangesetDefinitionRegistry({ schemas, definitions });
}

async function plannedOperation(input: {
  readonly registry: ChangesetDefinitionRegistry;
  readonly store: RecordStore;
  readonly kind?: string;
  readonly id: string;
  readonly updates: AuthorInput['updates'];
  readonly group: string;
}): Promise<FrozenChangesetOperation> {
  return planChangesetOperation({
    registry: input.registry,
    kind: input.kind ?? 'record.change',
    version: 1,
    authorInput: { id: input.id, updates: input.updates },
    dependencyGroup: input.group,
    snapshot: snapshot(input.store)
  });
}

let applySequence = 0;

async function apply(
  registryValue: ChangesetDefinitionRegistry,
  store: RecordStore,
  operations: readonly FrozenChangesetOperation[],
  dependencyGroups: readonly DependencyGroup[] = [...new Set(
    operations.map((operation) => operation.dependencyGroup)
  )].map((key) => ({ key, dependsOn: [] }))
): Promise<CommittedChangesetSource> {
  applySequence += 1;
  const draftHead = createChangeset(
    { id: `changeset-apply-${applySequence}`, workspaceId: 'workspace-1', eventId: 'event-1' },
    {
      id: `revision-apply-${applySequence}`,
      createdAt: '2026-08-11T01:00:00.000Z',
      proposerPrincipalKey: 'principal:test-author',
      origin: 'human_ui',
      operations,
      dependencyGroups,
      approvalPolicy: { key: 'standard', version: 1 }
    }
  );
  const proposed = proposeChangeset(draftHead, draftHead.version);
  const revision = proposed.revisions.at(-1);
  if (!revision) throw new TypeError('revision_missing');
  const validation = validateExactCommit(proposed, {
    expectedHeadVersion: proposed.version,
    expectedRevisionDigest: revision.digest,
    currentAggregateVersions: new Map(operations.flatMap((operation) =>
      operation.aggregateRefs.map((reference) => [reference.id, reference.version] as const)
    )),
    currentGuardVersions: new Map(operations.flatMap((operation) =>
      operation.guardRefs.map((reference) => [reference.id, reference.version] as const)
    )),
    currentGuardDigests: new Map(operations.flatMap((operation) =>
      operation.guardRefs.map((reference) => [reference.id, reference.digest] as const)
    )),
    now: '2026-08-11T01:01:00.000Z',
    approvalRequirement: 'none'
  });
  if (validation.kind !== 'ready') throw new TypeError(`unexpected_commit_refusal:${validation.refusal.kind}`);
  const prepared = await prepareChangesetCommit({
    registry: registryValue,
    authorization: validation.authorization,
    transaction: transaction(store)
  });
  if (prepared.kind !== 'ready') throw new TypeError('unexpected_stale_operation');
  await applyPreparedChangeset(prepared.prepared);
  const receiptId = parseOperationReceiptId(
    `00000000-0000-4000-8000-${String(applySequence).padStart(12, '0')}`
  );
  return markChangesetCommitted(proposed, validation.authorization, receiptId).source;
}

function record(id: string): RecordValue {
  return { id, title: `Title ${id}`, color: `Color ${id}`, note: `Note ${id}`, version: 1 };
}

describe('changeset compensation planning', () => {
  test('replans current state in reverse dependency/application order and preserves unrelated later edits', async () => {
    const registryValue = registry();
    const store = new RecordStore([record('a'), record('b'), record('c')]);
    const operations = [
      await plannedOperation({ registry: registryValue, store, id: 'a', updates: [{ field: 'title', value: 'A source' }], group: 'base' }),
      await plannedOperation({ registry: registryValue, store, id: 'b', updates: [{ field: 'title', value: 'B source' }], group: 'dependent' }),
      await plannedOperation({ registry: registryValue, store, id: 'c', updates: [{ field: 'color', value: 'C source' }], group: 'dependent' })
    ];
    const source = await apply(registryValue, store, operations, [
      { key: 'base', dependsOn: [] },
      { key: 'dependent', dependsOn: ['base'] }
    ]);
    store.edit('a', { note: 'Later unrelated note' });
    store.applicationOrder.length = 0;

    await expect(planChangesetCompensation({
      registry: registryValue,
      source: structuredClone(source) as unknown as CommittedChangesetSource,
      snapshot: snapshot(store)
    })).rejects.toThrow('invalid_committed_changeset_source');

    const result = await planChangesetCompensation({
      registry: registryValue,
      source,
      snapshot: snapshot(store)
    });
    expect(result.kind).toBe('exact');
    if (result.kind !== 'exact') throw new TypeError('expected_exact_compensation');
    expect(result.draft.source).toEqual({
      changesetId: source.changesetId,
      id: source.revisionId,
      digest: source.revisionDigest,
      commitReceiptId: source.commitReceiptId
    });
    expect(result.draft.dependencyGroups).toEqual([
      { key: 'dependent', dependsOn: [] },
      { key: 'base', dependsOn: ['dependent'] }
    ]);
    expect(result.draft.operations.map((operation) => operation.plan)).toEqual([
      { id: 'c', changes: [{ field: 'color', before: 'C source', after: 'Color c' }], expectedVersion: 2 },
      { id: 'b', changes: [{ field: 'title', before: 'B source', after: 'Title b' }], expectedVersion: 2 },
      { id: 'a', changes: [{ field: 'title', before: 'A source', after: 'Title a' }], expectedVersion: 3 }
    ]);
    expect(result.draft.operations.map((operation) => operation.compensationLineage?.sourceOperationIndex)).toEqual([2, 1, 0]);
    expect(result.draft.operations.every((operation) =>
      operation.compensationLineage?.sourceRevisionDigest === source.revisionDigest
    )).toBe(true);

    const compensation = createChangeset(
      { id: 'changeset-compensation', workspaceId: 'workspace-1', eventId: 'event-1' },
      {
        id: 'revision-compensation',
        createdAt: '2026-08-11T02:00:00.000Z',
        proposerPrincipalKey: 'principal:author',
        origin: 'human_ui',
        operations: result.draft.operations,
        dependencyGroups: result.draft.dependencyGroups,
        approvalPolicy: { key: 'standard', version: 1 }
      }
    );
    expect(compensation.revisions[0]?.operations[0]?.compensationLineage).toEqual({
      sourceRevisionId: source.revisionId,
      sourceRevisionDigest: source.revisionDigest,
      sourceOperationIndex: 2,
      sourceOperationKind: 'record.change',
      sourceOperationVersion: 1,
      sourceDependencyGroup: 'dependent'
    });

    await apply(registryValue, store, result.draft.operations);
    expect(store.applicationOrder).toEqual(['c', 'b', 'a']);
    expect(store.get('a')).toMatchObject({ title: 'Title a', note: 'Later unrelated note' });
    expect(store.get('b')?.title).toBe('Title b');
    expect(store.get('c')?.color).toBe('Color c');
  });

  test('returns an honest partial draft and leaves conflicting later work intact', async () => {
    const registryValue = registry();
    const store = new RecordStore([record('a')]);
    const operation = await plannedOperation({
      registry: registryValue,
      store,
      id: 'a',
      updates: [
        { field: 'title', value: 'Source title' },
        { field: 'color', value: 'Source color' }
      ],
      group: 'record'
    });
    const source = await apply(registryValue, store, [operation]);
    store.edit('a', { title: 'Later human title' });

    const result = await planChangesetCompensation({
      registry: registryValue,
      source,
      snapshot: snapshot(store)
    });
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new TypeError('expected_partial_compensation');
    expect(result.conflicts).toEqual([{
      lineage: {
        sourceRevisionId: source.revisionId,
        sourceRevisionDigest: source.revisionDigest,
        sourceOperationIndex: 0,
        sourceOperationKind: 'record.change',
        sourceOperationVersion: 1,
        sourceDependencyGroup: 'record'
      },
      conflictKeys: ['record.title_changed_since_source']
    }]);
    expect(result.draft.operations[0]?.plan).toEqual({
      id: 'a',
      changes: [{ field: 'color', before: 'Source color', after: 'Color a' }],
      expectedVersion: 3
    });

    await apply(registryValue, store, result.draft.operations);
    expect(store.get('a')).toMatchObject({ title: 'Later human title', color: 'Color a' });
  });

  test('distinguishes semantic compensation, impossible compensation, and irreversible work', async () => {
    const reversibleRegistry = registry();
    const semanticStore = new RecordStore([record('a')]);
    const semanticOperation = await plannedOperation({
      registry: reversibleRegistry,
      store: semanticStore,
      id: 'a',
      updates: [{ field: 'title', value: 'Source title' }],
      group: 'record'
    });
    const semanticSource = await apply(reversibleRegistry, semanticStore, [semanticOperation]);
    semanticStore.edit('a', { title: 'SOURCE TITLE' });
    const semantic = await planChangesetCompensation({
      registry: reversibleRegistry,
      source: semanticSource,
      snapshot: snapshot(semanticStore)
    });
    expect(semantic).toMatchObject({
      kind: 'semantic',
      notes: [{ noteKey: 'record.semantic_match' }]
    });

    const blockedStore = new RecordStore([record('b')]);
    const blockedOperation = await plannedOperation({
      registry: reversibleRegistry,
      store: blockedStore,
      id: 'b',
      updates: [{ field: 'title', value: 'Source title' }],
      group: 'record'
    });
    const blockedSource = await apply(reversibleRegistry, blockedStore, [blockedOperation]);
    blockedStore.edit('b', { title: 'Later human title' });
    const blocked = await planChangesetCompensation({
      registry: reversibleRegistry,
      source: blockedSource,
      snapshot: snapshot(blockedStore)
    });
    expect(blocked).toMatchObject({
      kind: 'blocked',
      blockers: [{ reasonKey: 'record.no_safe_compensation' }],
      remediations: []
    });
    expect('draft' in blocked).toBe(false);

    const irreversibleRegistry = registry([irreversibleDefinition]);
    const irreversibleStore = new RecordStore([record('c')]);
    const irreversibleOperation = await plannedOperation({
      registry: irreversibleRegistry,
      store: irreversibleStore,
      kind: 'record.notify',
      id: 'c',
      updates: [{ field: 'title', value: 'Notification sent' }],
      group: 'record'
    });
    const irreversibleSource = await apply(irreversibleRegistry, irreversibleStore, [irreversibleOperation]);
    const irreversible = await planChangesetCompensation({
      registry: irreversibleRegistry,
      source: irreversibleSource,
      snapshot: snapshot(irreversibleStore)
    });
    expect(irreversible).toMatchObject({
      kind: 'irreversible',
      draft: null,
      remediations: [{ remediationKey: 'record.manual_followup' }],
      conflicts: [],
      notes: []
    });
  });

  test('retains one canonical correction finding for every source operation when one blocks the draft', async () => {
    const registryValue = registry([
      mixedSemanticDefinition,
      mixedPartialDefinition,
      mixedBlockedDefinition
    ]);
    const store = new RecordStore([record('a'), record('b'), record('c')]);
    const operations = [
      await plannedOperation({
        registry: registryValue,
        store,
        kind: mixedSemanticDefinition.kind,
        id: 'a',
        updates: [{ field: 'title', value: 'A source' }],
        group: 'semantic'
      }),
      await plannedOperation({
        registry: registryValue,
        store,
        kind: mixedPartialDefinition.kind,
        id: 'b',
        updates: [{ field: 'title', value: 'B source' }],
        group: 'partial'
      }),
      await plannedOperation({
        registry: registryValue,
        store,
        kind: mixedBlockedDefinition.kind,
        id: 'c',
        updates: [{ field: 'title', value: 'C source' }],
        group: 'blocked'
      })
    ];
    const source = await apply(registryValue, store, operations);
    const result = await planChangesetCompensation({
      registry: registryValue,
      source,
      snapshot: snapshot(store)
    });

    expect(result).toMatchObject({
      kind: 'blocked',
      notes: [{ noteKey: 'record.semantic_match' }],
      conflicts: [{ conflictKeys: ['record.later_work_preserved'] }],
      blockers: [{ reasonKey: 'record.correction_requires_review' }],
      operationEvidence: [
        { kind: 'semantic', draftable: true, noteKey: 'record.semantic_match' },
        { kind: 'partial', draftable: true, conflictKeys: ['record.later_work_preserved'] },
        { kind: 'blocked', draftable: false, reasonKey: 'record.correction_requires_review' }
      ]
    });
    expect(result.operationEvidence.map((entry) => entry.lineage.sourceOperationIndex)).toEqual([0, 1, 2]);
    expect(Object.isFrozen(result.operationEvidence)).toBe(true);
  });

  test('a compensating draft uses fresh bases and guards and can itself go stale before commit', async () => {
    const registryValue = registry();
    const store = new RecordStore([record('a')]);
    const operation = await plannedOperation({
      registry: registryValue,
      store,
      id: 'a',
      updates: [{ field: 'title', value: 'Source title' }],
      group: 'record'
    });
    const source = await apply(registryValue, store, [operation]);
    const result = await planChangesetCompensation({
      registry: registryValue,
      source,
      snapshot: snapshot(store)
    });
    if (result.kind !== 'exact') throw new TypeError('expected_exact_compensation');
    const compensationOperation = result.draft.operations[0];
    if (!compensationOperation) throw new TypeError('compensation_operation_missing');
    expect(compensationOperation.aggregateRefs).toEqual([{ id: 'record:a', version: 2 }]);
    expect(compensationOperation.guardRefs).toEqual([{
      id: 'record_index:all',
      version: 1,
      digest: store.guardDigest()
    }]);

    let compensation = createChangeset(
      { id: 'changeset-compensation', workspaceId: 'workspace-1', eventId: 'event-1' },
      {
        id: 'revision-compensation',
        createdAt: '2026-08-11T02:00:00.000Z',
        proposerPrincipalKey: 'principal:author',
        origin: 'human_ui',
        operations: result.draft.operations,
        dependencyGroups: result.draft.dependencyGroups,
        approvalPolicy: { key: 'standard', version: 1 }
      }
    );
    compensation = proposeChangeset(compensation, compensation.version);
    const revision = compensation.revisions.at(-1);
    if (!revision) throw new TypeError('compensation_revision_missing');
    const common = {
      expectedHeadVersion: compensation.version,
      expectedRevisionDigest: revision.digest,
      now: '2026-08-11T02:01:00.000Z',
      approvalRequirement: 'none' as const
    };
    expect(validateExactCommit(compensation, {
      ...common,
      currentAggregateVersions: new Map([['record:a', 2]]),
      currentGuardVersions: new Map([['record_index:all', compensationOperation.guardRefs[0]!.version]]),
      currentGuardDigests: new Map([['record_index:all', compensationOperation.guardRefs[0]!.digest]])
    }).kind).toBe('ready');

    expect(validateExactCommit(compensation, {
      ...common,
      currentAggregateVersions: new Map([['record:a', 3]]),
      currentGuardVersions: new Map([['record_index:all', compensationOperation.guardRefs[0]!.version]]),
      currentGuardDigests: new Map([['record_index:all', compensationOperation.guardRefs[0]!.digest]])
    })).toEqual({
      kind: 'refused',
      refusal: { kind: 'base_version_changed', id: 'record:a', expected: 2, actual: 3 }
    });
    expect(validateExactCommit(compensation, {
      ...common,
      currentAggregateVersions: new Map([['record:a', 2]]),
      currentGuardVersions: new Map([['record_index:all', compensationOperation.guardRefs[0]!.version]]),
      currentGuardDigests: new Map([['record_index:all', 'later-guard']])
    })).toEqual({ kind: 'refused', refusal: { kind: 'guard_changed', id: 'record_index:all' } });
  });

  test('compensation derivation cannot reach an undeclared read port', async () => {
    const registryValue = registry([undeclaredPortDefinition]);
    const store = new RecordStore([record('a')]);
    const operation = await plannedOperation({
      registry: registryValue,
      store,
      kind: 'record.undeclared',
      id: 'a',
      updates: [{ field: 'title', value: 'Source title' }],
      group: 'record'
    });
    const source = await apply(registryValue, store, [operation]);
    let backingPortReads = 0;
    const backingSnapshot: ChangesetPlanningSnapshot = {
      getPort<Port>(): Port {
        backingPortReads += 1;
        return store as unknown as Port;
      }
    };

    await expect(planChangesetCompensation({
      registry: registryValue,
      source,
      snapshot: backingSnapshot
    })).rejects.toThrow('undeclared_changeset_read_port');
    expect(backingPortReads).toBe(0);
  });
});
