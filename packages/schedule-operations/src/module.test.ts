import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createHmacRequestHashSealer, createOperationRegistry } from '@jooevents/application';
import { schedulePlacementInputSchema } from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_OPERATION,
  SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
  SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
  createSchedulePlacementOperationModule,
  createSchedulePlacementDirectOperationModule,
  schedulePlacementReadQueryInputSchema
} from '.';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const profile = Object.freeze({ key: 'schedule-operation-test', version: parseContractVersion(1) });

function module() {
  return createSchedulePlacementOperationModule({
    workspaceId,
    policies: {
      read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
      manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
    },
    currentAuthority: {
      resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
    },
    currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event.none'] }) },
    scheduleRead: { readSchedule: () => undefined },
    clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x61)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`schedule:${raw}`).digest('hex')
        };
      }
    }
  });
}

function directModule() {
  const input = moduleInput();
  return createSchedulePlacementDirectOperationModule({
    ...input,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x62)
    })
  });
}

function moduleInput() {
  return {
    workspaceId,
    policies: { read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY, manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY },
    currentAuthority: { resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const }) },
    currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event.none'] }) },
    scheduleRead: { readSchedule: () => undefined },
    clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile, scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE, keyBytes: new Uint8Array(32).fill(0x61)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: { seal(raw: string) { return { verifierProfile: profile,
      verifierSha256: createHash('sha256').update(`schedule:${raw}`).digest('hex') }; } }
  };
}

describe('Schedule placement operation module', () => {
	test('registers the direct audited placement operation on the canonical POST path', async () => {
		const registry = await createOperationRegistry(directModule().source);
		expect(registry.operatorHttpEffectBindings.map((binding) => ({
			operation: `${binding.operationName}@${binding.operationVersion}`, path: binding.path
		}))).toEqual([{ operation: `${SCHEDULE_PLACEMENT_OPERATION.name}@1`,
			path: '/api/events/current/schedule/placements' }]);
		expect(directModule().source.effectOperations?.[0]?.execution).toMatchObject({ profile: 'direct_audited' });
	});
  test('registers only the placement read path in the read module', async () => {
    const registry = await createOperationRegistry(module().source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/schedule/placements'
    }]);
    expect(registry.operatorHttpEffectBindings).toEqual([]);
  });

  test('registers the canonical numeric read input now decoded by the shared GET adapter', () => {
    expect(schedulePlacementReadQueryInputSchema.parse({
      startAt: '2026-11-01T08:00:00.000Z',
      endAt: '2026-11-01T18:00:00.000Z',
      limit: 20
    })).toEqual({
      startAt: '2026-11-01T08:00:00.000Z',
      endAt: '2026-11-01T18:00:00.000Z',
      limit: 20
    });
    for (const limit of ['', '20', 0, 2_001]) {
      expect(schedulePlacementReadQueryInputSchema.safeParse({
        startAt: '2026-11-01T08:00:00.000Z',
        endAt: '2026-11-01T18:00:00.000Z',
        limit
      }).success).toBe(false);
    }
    expect(schedulePlacementReadQueryInputSchema.safeParse({
      startAt: '2026-11-01T08:00:00.000Z',
      endAt: '2026-11-01T18:00:00.000Z',
      limit: [20, 30]
    }).success).toBe(false);
    expect(schedulePlacementReadQueryInputSchema.safeParse({
      startAt: '2026-11-01T08:00:00.000Z',
      endAt: '2026-11-01T18:00:00.000Z',
      limit: 20,
      scope: { workspaceId: crypto.randomUUID() }
    }).success).toBe(false);
  });

  test('keeps server-owned placement and lifecycle authority out of browser draft input', () => {
    const ordinary = {
      action: 'place',
      expectedScheduleVersion: 1,
      roomId: '019c1df7-86b5-769b-bba4-5f7097bfa301',
      sessionId: '019c1df7-86b5-769b-bba4-5f7097bfa501',
      startAt: '2026-11-01T09:00:00.000Z',
      endAt: '2026-11-01T10:00:00.000Z'
    } as const;
    expect(schedulePlacementInputSchema.safeParse(ordinary).success).toBe(true);
    for (const field of [
      'scope', 'actor', 'occurrenceId', 'clientOwnedId', 'revisionId',
      'receiptId', 'approval', 'occurredAt'
    ]) {
      expect(schedulePlacementInputSchema.safeParse({
        ...ordinary,
        [field]: field === 'scope' ? { workspaceId } : crypto.randomUUID()
      }).success).toBe(false);
    }
  });
});
