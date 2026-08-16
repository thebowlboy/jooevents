import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createHmacRequestHashSealer, createOperationRegistry } from '@jooevents/application';
import { deadlineChangeInputSchema } from '@jooevents/contracts/deadlines';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  DEADLINE_CATALOG_READ_OPERATION,
  DEADLINE_CHANGE_OPERATION,
  DEADLINE_CURRENT_READ_OPERATION,
  DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_OPERATION_RUNTIME_SCHEMA_REFS,
  DEADLINE_READ_ACCESS_POLICY,
  createDeadlineOperationModule
} from '.';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const profile = Object.freeze({ key: 'deadline-operation-test', version: parseContractVersion(1) });

function module() {
  return createDeadlineOperationModule({
    workspaceId,
    policies: {
      read: DEADLINE_READ_ACCESS_POLICY,
      manage: DEADLINE_MANAGE_ACCESS_POLICY
    },
    currentAuthority: {
      resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
    },
    currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event.none'] }) },
    deadlineRead: { readDeadlineCatalog: () => undefined },
    clock: { now: () => parseInstant('2026-08-13T12:00:00.000Z') },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x61)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`deadline:${raw}`).digest('hex')
        };
      }
    }
  });
}

describe('Deadline operation module', () => {
  test('registers two current-authority reads and one idempotent direct path', async () => {
    const registry = await createOperationRegistry(module().source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${DEADLINE_CATALOG_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/deadlines'
    }, {
      operation: `${DEADLINE_CURRENT_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/deadlines/current'
    }]);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${DEADLINE_CHANGE_OPERATION.name}@1`,
      method: 'POST',
      path: '/api/events/current/deadlines'
    }]);
    const manifest = registry.safeManifest.operations.find((operation) =>
      operation.name === DEADLINE_CHANGE_OPERATION.name
    );
    expect(manifest).toMatchObject({
      effect: 'commit', maxRisk: 'low',
      idempotency: { required: true },
      consequenceTags: ['deadline-changed']
    });
  });

  test('freezes every public and internal schema reference', () => {
    for (const reference of Object.values(DEADLINE_OPERATION_RUNTIME_SCHEMA_REFS)) {
      expect(reference).toMatchObject({ version: 1 });
      expect(reference.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('keeps scope, identities, attribution, receipts, and approval out of browser input', () => {
    const ordinary = { action: 'create', displayDate: '2026-11-01' } as const;
    expect(deadlineChangeInputSchema.safeParse(ordinary).success).toBe(true);
    for (const field of [
      'scope', 'deadlineId', 'clientOwnedId', 'revisionId', 'receiptId',
      'actor', 'approval', 'attributedAt'
    ]) {
      expect(deadlineChangeInputSchema.safeParse({
        ...ordinary,
        [field]: field === 'scope' ? { workspaceId } : crypto.randomUUID()
      }).success).toBe(false);
    }
    expect(deadlineChangeInputSchema.safeParse({
      action: 'update',
      deadlineId: '019c1df7-86b5-769b-bba4-5f7097bfa311',
      expectedVersion: 2,
      displayDate: '2026-11-02'
    }).success).toBe(true);
    expect(deadlineChangeInputSchema.safeParse({
      action: 'clear',
      deadlineId: '019c1df7-86b5-769b-bba4-5f7097bfa311',
      expectedVersion: 2
    }).success).toBe(true);
  });
});
