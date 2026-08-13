import { describe, expect, test } from 'bun:test';
import { parseInstant, parseInvocationId } from '@jooevents/kernel';
import { OperationExecutionError } from './executor';
import { composeOperationRegistryModules, createApplicationOperationRuntime } from './runtime';
import type { EffectUnitOfWorkPort, OperationRegistrySource } from './types';

const emptySource: OperationRegistrySource = {
  autonomyPolicies: [],
  schemas: [],
  contextBuilders: [],
  readCapabilities: [],
  handlers: [],
  projections: [],
  operations: []
};

const unopenedUnitOfWork: EffectUnitOfWorkPort = {
  findTerminalReceipt() {
    throw new Error('unexpected receipt lookup');
  },
  recordShortOperationAudit() {
    throw new Error('unexpected audit append');
  },
  runInUnitOfWork() {
    throw new Error('unexpected transaction');
  }
};

describe('application operation runtime', () => {
  test('joins modules deterministically and snapshots their registration arrays', () => {
    const mutableOperations: OperationRegistrySource['operations'][number][] = [];
    const first = { ...emptySource, operations: mutableOperations };
    const composed = composeOperationRegistryModules([
      { id: 'zeta', source: emptySource },
      { id: 'alpha', source: first }
    ]);
    mutableOperations.push({} as OperationRegistrySource['operations'][number]);

    expect(composed.operations).toEqual([]);
    expect(Object.isFrozen(composed)).toBe(true);
    expect(Object.isFrozen(composed.operations)).toBe(true);
    expect(() => composeOperationRegistryModules([
      { id: 'same', source: emptySource },
      { id: 'same', source: emptySource }
    ])).toThrow('Duplicate operation registry module ID');
    expect(() => composeOperationRegistryModules([
      { id: 'Invalid ID', source: emptySource }
    ])).toThrow('Invalid operation registry module ID');
  });

  test('binds an immutable empty registry without enabling an undeclared operation', async () => {
    const runtime = await createApplicationOperationRuntime({
      source: emptySource,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-12T00:00:00.000Z') },
        newInvocationId: () => parseInvocationId('018f0f47-7a86-7d36-8a25-9f86589c7001')
      },
      unitOfWork: unopenedUnitOfWork
    });

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.registry.safeManifest.operations).toEqual([]);
    expect(runtime.registry.operatorHttpBindings).toEqual([]);
    expect(runtime.registry.operatorHttpEffectBindings).toEqual([]);

    await expect(runtime.readExecutor.execute({
      operationName: 'undeclared.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: '018f0f47-7a86-7d36-8a25-9f86589c7002',
      businessInput: {},
      verifiedEvidence: {}
    })).rejects.toMatchObject({ phase: 'binding' } satisfies Partial<OperationExecutionError>);

    await expect(runtime.effectBuilder.build({
      operationName: 'undeclared.commit',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: '018f0f47-7a86-7d36-8a25-9f86589c7003',
      businessInput: {},
      verifiedEvidence: {},
      rawIdempotencyKey: 'not-used'
    })).rejects.toMatchObject({ phase: 'binding' } satisfies Partial<OperationExecutionError>);
  });
});
