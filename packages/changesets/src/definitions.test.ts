import { describe, expect, test } from 'bun:test';
import { parseOperationReceiptId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  ChangesetDefinitionValidationError,
  applyPreparedChangeset,
  createChangeset,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  markChangesetCommitted,
  planChangesetOperation,
  prepareChangesetCommit,
  proposeChangeset,
  validateExactCommit,
  type ChangesetOperationDefinition,
  type ChangesetCommitTransaction,
  type ChangesetPlanningSnapshot,
  type ChangesetValidation,
  type FrozenChangesetOperation,
} from '.';

interface Room {
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

interface RoomReadPort {
  get(id: string): Room | undefined;
  guardDigest(): string;
}

interface RoomTransactionPort extends RoomReadPort {
  rename(id: string, expectedVersion: number, name: string): Room;
}

const readPort = defineChangesetReadPort<RoomReadPort>('room.read', 1);
const validationPort = defineChangesetValidationPort<RoomReadPort>('room.validation', 1);
const transactionPort = defineChangesetTransactionPort<RoomTransactionPort>('room.transaction', 1);

function validationPortTypeBoundary(validation: ChangesetValidation): void {
  validation.getPort(validationPort);
  // @ts-expect-error Validators cannot request an apply-phase transaction port.
  validation.getPort(transactionPort);
}
void validationPortTypeBoundary;

let commitSequence = 0;

function authorize(operations: readonly FrozenChangesetOperation[]) {
  commitSequence += 1;
  const created = createChangeset(
    { id: `room-changeset-${commitSequence}`, workspaceId: 'workspace-1' },
    {
      id: `room-revision-${commitSequence}`,
      createdAt: '2026-08-11T00:00:00.000Z',
      proposerPrincipalKey: 'principal:test',
      origin: 'human_ui',
      operations,
      dependencyGroups: [...new Set(operations.map((operation) => operation.dependencyGroup))]
        .map((key) => ({ key, dependsOn: [] })),
      approvalPolicy: { key: 'standard', version: 1 }
    }
  );
  const proposed = proposeChangeset(created, created.version);
  const revision = proposed.revisions.at(-1);
  if (!revision) throw new Error('missing revision');
  const validation = validateExactCommit(proposed, {
    expectedHeadVersion: proposed.version,
    expectedRevisionDigest: revision.digest,
    currentAggregateVersions: new Map(operations.flatMap((operation) =>
      operation.aggregateRefs.map((reference) => [reference.id, reference.version] as const)
    )),
    currentGuardDigests: new Map(operations.flatMap((operation) =>
      operation.guardRefs.map((reference) => [reference.id, reference.digest] as const)
    )),
    currentGuardVersions: new Map(operations.flatMap((operation) =>
      operation.guardRefs.map((reference) => [reference.id, reference.version] as const)
    )),
    now: '2026-08-11T00:01:00.000Z'
  });
  if (validation.kind !== 'ready') throw new Error(`unexpected refusal: ${validation.refusal.kind}`);
  return { authorization: validation.authorization, head: proposed };
}

const authorSchema = defineChangesetSchema({
  key: 'room.rename.author',
  version: 1,
  schema: z.strictObject({ id: z.string().min(1), nextName: z.string().min(1) })
});
const planSchema = defineChangesetSchema({
  key: 'room.rename.plan',
  version: 1,
  schema: z.strictObject({ id: z.string(), beforeName: z.string(), nextName: z.string(), expectedVersion: z.number().int().positive() })
});
const diffSchema = defineChangesetSchema({
  key: 'room.rename.diff',
  version: 1,
  schema: z.strictObject({ before: z.string(), after: z.string(), consequence: z.literal('room_renamed') })
});
const resultSchema = defineChangesetSchema({
  key: 'room.rename.result',
  version: 1,
  schema: z.strictObject({ id: z.string(), version: z.number().int().positive() })
});
const staleDetailSchema = defineChangesetSchema({
  key: 'room.rename.stale_detail',
  version: 1,
  schema: z.strictObject({ expectedVersion: z.number().int().positive() })
});

const definition: ChangesetOperationDefinition<
  z.infer<typeof authorSchema.schema>,
  z.infer<typeof planSchema.schema>,
  z.infer<typeof diffSchema.schema>,
  { readonly id: string; readonly nextName: string; readonly expectedVersion: number },
  z.infer<typeof resultSchema.schema>
> = {
  kind: 'room.rename',
  version: 1,
  schemas: {
    authorInput: authorSchema.reference,
    plan: planSchema.reference,
    diff: diffSchema.reference,
    result: resultSchema.reference
  },
  readPorts: [readPort],
  validationPorts: [validationPort],
  transactionPorts: [transactionPort],
  allowedAggregateKinds: ['room'],
  allowedGuardKinds: ['room_index'],
  allowedRisks: ['normal'],
  allowedConsequences: ['room_renamed'],
  allowedOutcomes: [{
    class: 'stale_revision',
    kind: 'room_changed',
    retryable: false,
    detailSchema: staleDetailSchema.reference
  }],
  allowedFacts: [{ kind: 'room_renamed', version: 1 }],
  allowedEffects: [],
  plan(input, snapshot) {
    const room = snapshot.getPort(readPort).get(input.id);
    if (!room) throw new TypeError('room_missing');
    return {
      plan: { id: room.id, beforeName: room.name, nextName: input.nextName, expectedVersion: room.version },
      aggregateRefs: [{ id: `room:${room.id}`, version: room.version }],
      guardRefs: [{ id: 'room_index:all', version: 1, digest: snapshot.getPort(readPort).guardDigest() }],
      riskTier: 'normal',
      consequences: ['room_renamed']
    };
  },
  projectDiff(plan) {
    return {
      diff: { before: plan.beforeName, after: plan.nextName, consequence: 'room_renamed' },
      representedConsequences: ['room_renamed']
    };
  },
  validateWithin(plan, validation) {
    const current = validation.getPort(validationPort).get(plan.id);
    if (!current || current.version !== plan.expectedVersion) {
      return {
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'room_changed',
          retryable: false,
          subjects: [{ type: 'room', id: plan.id }],
          detail: { expectedVersion: plan.expectedVersion },
          detailSchemaVersion: 1
        }
      };
    }
    return { kind: 'ready', validated: { id: plan.id, nextName: plan.nextName, expectedVersion: plan.expectedVersion } };
  },
  applyWithin(validated, transaction) {
    const room = transaction.getPort(transactionPort).rename(validated.id, validated.expectedVersion, validated.nextName);
    return {
      result: { id: room.id, version: room.version },
      facts: [{ kind: 'room_renamed', version: 1, payload: { id: room.id, version: room.version } }],
      effects: []
    };
  },
  deriveCompensation(plan) {
    return {
      kind: 'semantic',
      authorInput: { id: plan.id, nextName: plan.beforeName },
      noteKey: 'room_name_restore'
    };
  }
};

function registry(definitions: readonly ChangesetOperationDefinition<any, any, any, any, any>[] = [definition]) {
  return createChangesetDefinitionRegistry({
    schemas: [authorSchema, planSchema, diffSchema, resultSchema, staleDetailSchema],
    definitions
  });
}

class RoomStore implements RoomReadPort, RoomTransactionPort {
  readonly rooms = new Map<string, Room>();
  writes = 0;

  constructor(rooms: readonly Room[]) {
    for (const room of rooms) this.rooms.set(room.id, room);
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  guardDigest(): string {
    return 'guard-v1';
  }

  rename(id: string, expectedVersion: number, name: string): Room {
    const current = this.rooms.get(id);
    if (!current || current.version !== expectedVersion) throw new Error('apply_defect_stale');
    const next = { ...current, name, version: current.version + 1 };
    this.rooms.set(id, next);
    this.writes += 1;
    return next;
  }
}

function capabilities(store: RoomStore): { snapshot: ChangesetPlanningSnapshot; transaction: ChangesetCommitTransaction } {
  const readOnlyView: RoomReadPort = Object.freeze({
    get(id: string) {
      return store.get(id);
    },
    guardDigest() {
      return store.guardDigest();
    }
  });
  return {
    snapshot: Object.freeze({
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        if (key !== readPort) throw new TypeError('undeclared_test_read_port');
        return readOnlyView as Port;
      }
    }) as ChangesetPlanningSnapshot,
    transaction: Object.freeze({
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        if (key === validationPort) return readOnlyView as Port;
        if (key === transactionPort) return store as Port;
        throw new TypeError('undeclared_test_commit_port');
      }
    }) as ChangesetCommitTransaction
  };
}

async function planned(store: RoomStore, id: string, nextName: string, dependencyGroup = id) {
  return planChangesetOperation({
    registry: registry(),
    kind: 'room.rename',
    version: 1,
    authorInput: { id, nextName },
    dependencyGroup,
    snapshot: capabilities(store).snapshot
  });
}

describe('changeset definition registry', () => {
  test('schema and definition order produce one stable executable catalog digest', () => {
    const first = registry();
    const second = createChangesetDefinitionRegistry({
      schemas: [staleDetailSchema, resultSchema, diffSchema, planSchema, authorSchema],
      definitions: [definition]
    });
    expect(first.registryDigestSha256).toBe(second.registryDigestSha256);
    expect(first.get('room.rename', 1)).toBe(definition);

    const alternateValidationPort = defineChangesetValidationPort<RoomReadPort>('room.validation.alternate', 1);
    const alternate = registry([{ ...definition, validationPorts: [alternateValidationPort] }]);
    expect(alternate.registryDigestSha256).not.toBe(first.registryDigestSha256);
  });

  test('missing schemas, changed digests, and kind/version collisions fail before planning', () => {
    expect(() => createChangesetDefinitionRegistry({ schemas: [authorSchema], definitions: [definition] }))
      .toThrow(ChangesetDefinitionValidationError);
    expect(() => createChangesetDefinitionRegistry({
      schemas: [{ ...authorSchema, reference: { ...authorSchema.reference, digestSha256: '0'.repeat(64) } }, planSchema, diffSchema, resultSchema, staleDetailSchema],
      definitions: [definition]
    })).toThrow(ChangesetDefinitionValidationError);
    expect(() => createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, staleDetailSchema],
      definitions: [definition, definition]
    })).toThrow(ChangesetDefinitionValidationError);
    expect(() => registry([{
      ...definition,
      kind: 'room.rename.duplicate_validation_port',
      validationPorts: [validationPort, validationPort]
    }])).toThrow(ChangesetDefinitionValidationError);
  });

  test('planning freezes the schema-first plan and proves every consequence appears in the diff', async () => {
    const store = new RoomStore([{ id: 'a', name: 'Before', version: 1 }]);
    const operation = await planned(store, 'a', 'After');
    expect(operation).toMatchObject({
      kind: 'room.rename',
      plan: { id: 'a', beforeName: 'Before', nextName: 'After', expectedVersion: 1 },
      safeDiff: { before: 'Before', after: 'After', consequence: 'room_renamed' },
      aggregateRefs: [{ id: 'room:a', version: 1 }]
    });
    expect(Object.isFrozen(operation.plan)).toBe(true);
  });

  test('all expected validation completes before the first domain write', async () => {
    const store = new RoomStore([
      { id: 'a', name: 'A', version: 1 },
      { id: 'b', name: 'B', version: 1 }
    ]);
    const first = await planned(store, 'a', 'A2');
    const stale = await planned(store, 'b', 'B2');
    store.rooms.set('b', { id: 'b', name: 'B changed', version: 2 });
    const validated = authorize([first, stale]);
    const prepared = await prepareChangesetCommit({
      registry: registry(),
      authorization: validated.authorization,
      transaction: capabilities(store).transaction
    });
    expect(prepared).toMatchObject({ kind: 'outcome', outcome: { class: 'stale_revision', kind: 'room_changed' } });
    expect(store.writes).toBe(0);
    expect(store.get('a')?.name).toBe('A');
    await expect(prepareChangesetCommit({
      registry: registry(),
      authorization: validated.authorization,
      transaction: capabilities(store).transaction
    })).rejects.toThrow('invalid_validated_changeset_commit');
  });

  test('validation cannot resolve an apply-phase transaction port', async () => {
    const store = new RoomStore([{ id: 'a', name: 'A', version: 1 }]);
    let validationViewExposedWrite = false;
    const probingDefinition: typeof definition = {
      ...definition,
      kind: 'room.rename.validation_write_probe',
      validateWithin(_plan, validation) {
        const candidate = validation.getPort(validationPort) as RoomReadPort & {
          readonly rename?: RoomTransactionPort['rename'];
        };
        validationViewExposedWrite = typeof candidate.rename === 'function';
        (validation as unknown as ChangesetCommitTransaction).getPort(transactionPort);
        throw new Error('unreachable');
      }
    };
    const probingRegistry = registry([probingDefinition]);
    const operation = await planChangesetOperation({
      registry: probingRegistry,
      kind: probingDefinition.kind,
      version: probingDefinition.version,
      authorInput: { id: 'a', nextName: 'A2' },
      dependencyGroup: 'a',
      snapshot: capabilities(store).snapshot
    });
    const validated = authorize([operation]);

    await expect(prepareChangesetCommit({
      registry: probingRegistry,
      authorization: validated.authorization,
      transaction: capabilities(store).transaction
    })).rejects.toThrow('undeclared_changeset_validation_port');
    expect(validationViewExposedWrite).toBe(false);
    expect(store.writes).toBe(0);
    expect(store.get('a')?.name).toBe('A');
  });

  test('preparation detaches and deeply freezes the value retained by a validator', async () => {
    const store = new RoomStore([{ id: 'a', name: 'A', version: 1 }]);
    type NestedValidated = {
      readonly payload: {
        readonly id: string;
        readonly nextName: string;
        readonly expectedVersion: number;
      };
    };
    let retained: {
      payload: { id: string; nextName: string; expectedVersion: number };
    } | undefined;
    let applySawFrozenSnapshot = false;
    const aliasDefinition: ChangesetOperationDefinition<
      z.infer<typeof authorSchema.schema>,
      z.infer<typeof planSchema.schema>,
      z.infer<typeof diffSchema.schema>,
      NestedValidated,
      z.infer<typeof resultSchema.schema>
    > = {
      ...definition,
      kind: 'room.rename.retained_alias',
      validateWithin(plan, validation) {
        const current = validation.getPort(validationPort).get(plan.id);
        if (!current || current.version !== plan.expectedVersion) {
          return {
            kind: 'outcome',
            outcome: {
              class: 'stale_revision',
              kind: 'room_changed',
              retryable: false,
              subjects: [{ type: 'room', id: plan.id }],
              detail: { expectedVersion: plan.expectedVersion },
              detailSchemaVersion: 1
            }
          };
        }
        retained = {
          payload: { id: plan.id, nextName: plan.nextName, expectedVersion: plan.expectedVersion }
        };
        return { kind: 'ready', validated: retained };
      },
      applyWithin(validated, transaction) {
        applySawFrozenSnapshot = Object.isFrozen(validated) && Object.isFrozen(validated.payload);
        const room = transaction.getPort(transactionPort).rename(
          validated.payload.id,
          validated.payload.expectedVersion,
          validated.payload.nextName
        );
        return {
          result: { id: room.id, version: room.version },
          facts: [{ kind: 'room_renamed', version: 1, payload: { id: room.id, version: room.version } }],
          effects: []
        };
      }
    };
    const aliasRegistry = registry([aliasDefinition]);
    const operation = await planChangesetOperation({
      registry: aliasRegistry,
      kind: aliasDefinition.kind,
      version: aliasDefinition.version,
      authorInput: { id: 'a', nextName: 'A2' },
      dependencyGroup: 'a',
      snapshot: capabilities(store).snapshot
    });
    const validated = authorize([operation]);
    const prepared = await prepareChangesetCommit({
      registry: aliasRegistry,
      authorization: validated.authorization,
      transaction: capabilities(store).transaction
    });
    if (prepared.kind !== 'ready' || !retained) throw new Error('unexpected preparation result');

    retained.payload.nextName = 'Injected';
    await applyPreparedChangeset(prepared.prepared);

    expect(store.get('a')?.name).toBe('A2');
    expect(applySawFrozenSnapshot).toBe(true);
  });

  test('validation snapshots the exact revision before any asynchronous preparation', async () => {
    const store = new RoomStore([{ id: 'a', name: 'A', version: 1 }]);
    const operation = await planned(store, 'a', 'A2');
    const created = createChangeset(
      { id: 'room-mutable', workspaceId: 'workspace-1' },
      {
        id: 'room-mutable-revision',
        createdAt: '2026-08-11T00:00:00.000Z',
        proposerPrincipalKey: 'principal:test',
        origin: 'human_ui',
        operations: [operation],
        dependencyGroups: [{ key: operation.dependencyGroup, dependsOn: [] }],
        approvalPolicy: { key: 'standard', version: 1 }
      }
    );
    const mutableHead = structuredClone(proposeChangeset(created, created.version));
    const revision = mutableHead.revisions.at(-1);
    if (!revision) throw new Error('missing revision');
    const validation = validateExactCommit(mutableHead, {
      expectedHeadVersion: mutableHead.version,
      expectedRevisionDigest: revision.digest,
      currentAggregateVersions: new Map([['room:a', 1]]),
      currentGuardDigests: new Map([['room_index:all', 'guard-v1']]),
      currentGuardVersions: new Map([['room_index:all', 1]]),
      now: '2026-08-11T00:01:00.000Z'
    });
    if (validation.kind !== 'ready') throw new Error('unexpected refusal');
    (mutableHead.revisions[0]!.operations[0]!.plan as { nextName: string }).nextName = 'Injected';

    const prepared = await prepareChangesetCommit({
      registry: registry(),
      authorization: validation.authorization,
      transaction: capabilities(store).transaction
    });
    if (prepared.kind !== 'ready') throw new Error('unexpected outcome');
    await applyPreparedChangeset(prepared.prepared);
    expect(store.get('a')?.name).toBe('A2');
    expect(() => markChangesetCommitted(
      mutableHead,
      validation.authorization,
      parseOperationReceiptId('00000000-0000-4000-8003-000000000002')
    )).toThrow('invalid_validated_changeset_commit');
  });

  test('prepared contributors apply in order and emit only declared fact/effect kinds', async () => {
    const store = new RoomStore([
      { id: 'a', name: 'A', version: 1 },
      { id: 'b', name: 'B', version: 1 }
    ]);
    const operations = [await planned(store, 'a', 'A2'), await planned(store, 'b', 'B2')];
    const validated = authorize(operations);
    const firstPreparation = prepareChangesetCommit({
      registry: registry(),
      authorization: validated.authorization,
      transaction: capabilities(store).transaction
    });
    await expect(prepareChangesetCommit({
      registry: registry(),
      authorization: validated.authorization,
      transaction: capabilities(store).transaction
    })).rejects.toThrow('invalid_validated_changeset_commit');
    const prepared = await firstPreparation;
    if (prepared.kind !== 'ready') throw new Error('unexpected outcome');
    expect(Object.keys(prepared.prepared)).toEqual([]);
    const contributions = await applyPreparedChangeset(prepared.prepared);
    expect(store.writes).toBe(2);
    expect(contributions).toEqual([
      { result: { id: 'a', version: 2 }, facts: [{ kind: 'room_renamed', version: 1, payload: { id: 'a', version: 2 } }], effects: [] },
      { result: { id: 'b', version: 2 }, facts: [{ kind: 'room_renamed', version: 1, payload: { id: 'b', version: 2 } }], effects: [] }
    ]);
    await expect(applyPreparedChangeset(prepared.prepared)).rejects.toThrow('invalid_prepared_changeset');
    const receiptId = parseOperationReceiptId('00000000-0000-4000-8003-000000000001');
    expect(markChangesetCommitted(
      validated.head,
      validated.authorization,
      receiptId
    ).head.status).toBe('committed');
    expect(() => markChangesetCommitted(
      validated.head,
      validated.authorization,
      receiptId
    )).toThrow('invalid_validated_changeset_commit');
  });
});
