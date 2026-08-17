import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWorkPort,
  type OperationRegistrySource
} from '@jooevents/application';
import { safeOperationManifestSchema } from '@jooevents/contracts';
import { parseInstant, parseInvocationId } from '@jooevents/kernel';
import {
  createOperatorOperationsHttpAdapter,
  isServerOwnedOperationPath
} from './operator-operations';

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

describe('operator operations HTTP composition', () => {
  test('serves only the registry-owned browser-safe manifest', async () => {
    const operationRuntime = await runtime();
    const app = createOperatorOperationsHttpAdapter({
      operations: operationRuntime,
      evidence: { verify: () => ({ kind: 'rejected', reason: 'unauthenticated' }) }
    });

    const response = await app.request('/api/operations/manifest');
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('etag')).toBe(`"${operationRuntime.registry.manifestDigestSha256}"`);
    expect(safeOperationManifestSchema.parse(payload)).toEqual(operationRuntime.registry.safeManifest);
    expect(JSON.stringify(payload)).not.toContain('internalManifest');
    expect((await app.request('/api/undeclared')).status).toBe(404);
  });

  test('refuses a caller-composed runtime even when its fields look valid', async () => {
    const operationRuntime = await runtime();
    expect(() => createOperatorOperationsHttpAdapter({
      operations: { ...operationRuntime },
      evidence: { verify: () => ({ kind: 'rejected', reason: 'unauthenticated' }) }
    })).toThrow('Untrusted application operation runtime');
  });

  test('reserves every server-owned operator/public protocol root and subtree', () => {
    for (const path of [
      '/api/auth', '/api/auth/session',
      '/api/entry', '/api/entry/admission',
      '/api/me/access-context', '/api/openapi.json',
      '/api/communications/email-readiness/check',
      '/api/communications/email-diagnostic/send-test',
      '/api/communications/email-deliverability/check',
      '/api/communications/email-setup-guide',
      '/api/integrations/airtable',
      '/api/integrations/airtable/base',
      '/api/operations/manifest', '/api/operations/manifest/v2',
      '/api/public', '/api/public/forms/example'
    ]) {
      expect(isServerOwnedOperationPath(path)).toBe(true);
    }
    expect(isServerOwnedOperationPath('/api/events/current')).toBe(false);
    expect(isServerOwnedOperationPath('/api/communications/email-readiness')).toBe(false);
    expect(isServerOwnedOperationPath('/api/program-vocabulary')).toBe(false);
    expect(isServerOwnedOperationPath('/api/workspace/api-key-secrets/example')).toBe(true);
    expect(isServerOwnedOperationPath('/api/v1/me')).toBe(true);
  });
});
