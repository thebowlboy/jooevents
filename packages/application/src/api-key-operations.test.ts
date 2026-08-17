import { describe, expect, test } from 'bun:test';
import {
  API_KEY_MANAGE_ACCESS_POLICY,
  createApiKeyOperationModule
} from './api-key-operations';
import {
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry
} from './operations';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';

const workspaceId = parseWorkspaceId('019c2f20-0000-7000-8000-000000000001');
const profile = Object.freeze({
  key: 'key-profile.workspace-api-key.test',
  version: parseContractVersion(1)
});

function module(mountMutations = true) {
  return createApiKeyOperationModule({
    workspaceId,
    policy: API_KEY_MANAGE_ACCESS_POLICY,
    currentAuthority: {
      resolve: () => ({ kind: 'denied' as const, reason: 'not_authorized' as const })
    },
    read: {
      read: async () => ({
        schemaVersion: 1,
        timezone: 'UTC',
        keys: [],
        permissions: [{
          id: 'event.read',
          group: 'events',
          groupLabel: 'Events',
          label: 'View events',
          description: 'View event configuration and operational state.',
          risk: 'routine',
          held: false
        }],
        profiles: [
          {
            key: 'full',
            label: 'Full access',
            description: 'Everything currently held.',
            proposesChanges: true,
            permissionIds: 'everything-held'
          },
          {
            key: 'assistant',
            label: 'Assistant',
            description: 'Program assistance.',
            proposesChanges: true,
            permissionIds: ['event.read']
          },
          {
            key: 'dashboard',
            label: 'Dashboard',
            description: 'Dashboard reads.',
            proposesChanges: false,
            permissionIds: ['event.read']
          },
          {
            key: 'schedule',
            label: 'Schedule display',
            description: 'Schedule reads.',
            proposesChanges: false,
            permissionIds: ['event.read']
          }
        ],
        events: [],
        expiry: { defaultDays: 90, maxDays: 365, rotationGraceHours: 168 }
      })
    },
    clock: { now: () => parseInstant('2026-08-17T15:00:00.000Z') },
    ids: {
      newInvocationId: () => parseInvocationId(
        '019c2f20-0000-7000-8000-000000000002'
      )
    },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x51)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x52)
    }),
    mountMutations
  });
}

describe('API key registered operations', () => {
  test('can mount the human inventory without advertising uncomposed secret mutations', async () => {
    const readOnly = module(false);
    const registry = await createOperationRegistry(readOnly.source);

    expect(registry.safeManifest.operations.map((operation) => operation.name)).toEqual([
      'workspace.api_key.list'
    ]);
    expect(registry.operatorHttpBindings.map((binding) => binding.path)).toEqual([
      '/api/workspace/api-keys'
    ]);
    expect(registry.operatorHttpEffectBindings).toEqual([]);
    expect(readOnly.source.effectHandlers).toEqual([]);
  });

  test('keeps all four human-only operations in the complete composition', async () => {
    const registry = await createOperationRegistry(module().source);
    expect(registry.safeManifest.operations.map((operation) => operation.name)).toEqual([
      'workspace.api_key.create',
      'workspace.api_key.list',
      'workspace.api_key.revoke',
      'workspace.api_key.rotate'
    ]);
    expect(registry.operatorHttpEffectBindings).toHaveLength(3);
    expect(registry.appModelEffectBindings).toEqual([]);
  });
});
