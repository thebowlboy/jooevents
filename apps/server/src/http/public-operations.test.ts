import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWorkPort,
  type OperationRegistrySource
} from '@jooevents/application';
import { parseInstant, parseInvocationId } from '@jooevents/kernel';
import {
  createPublicOperationsHttpAdapter,
  isPublicOperationPath
} from './public-operations';

const source: OperationRegistrySource = {
  autonomyPolicies: [],
  schemas: [],
  contextBuilders: [],
  readCapabilities: [],
  handlers: [],
  projections: [],
  operations: []
};

const unopened: EffectUnitOfWorkPort = {
  findTerminalReceipt() { throw new Error('unexpected receipt lookup'); },
  recordShortOperationAudit() { throw new Error('unexpected audit append'); },
  runInUnitOfWork() { throw new Error('unexpected transaction'); }
};

async function runtime() {
  return createApplicationOperationRuntime({
    source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => parseInstant('2026-08-12T00:00:00.000Z') },
      newInvocationId: () => parseInvocationId('018f0f47-7a86-7d36-8a25-9f86589c7001')
    },
    unitOfWork: unopened
  });
}

describe('public operations HTTP composition', () => {
  test('accepts only registry-owned public paths and is not an ordinary route mount', async () => {
    expect(isPublicOperationPath('/api/public/forms/current')).toBe(true);
    expect(isPublicOperationPath('/api/public')).toBe(false);
    expect(isPublicOperationPath('/api/events/current')).toBe(false);

    const operations = await runtime();
    const app = createPublicOperationsHttpAdapter({
      operations,
      evidence: { verify: () => ({ kind: 'rejected', reason: 'unauthenticated' }) }
    });
    expect((await app.request('/api/public/forms/current')).status).toBe(404);
    expect((await app.request('/api/operations/manifest')).status).toBe(404);
  });

  test('refuses a caller-composed runtime', async () => {
    const operations = await runtime();
    expect(() => createPublicOperationsHttpAdapter({
      operations: { ...operations },
      evidence: { verify: () => ({ kind: 'rejected', reason: 'unauthenticated' }) }
    })).toThrow('Untrusted application operation runtime');
  });
});
