import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createHmacRequestHashSealer, createOperationRegistry } from '@jooevents/application';
import { reviewerRosterChangeDraftInputSchema } from '@jooevents/contracts/reviewer-roster';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  REVIEWER_ROSTER_CHANGE_OPERATION,
  REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
  REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION,
  createReviewerRosterOperationModule
} from './roster';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const profile = Object.freeze({ key: 'reviewer-roster-operation-test', version: parseContractVersion(1) });

function module() {
  return createReviewerRosterOperationModule({
    workspaceId,
    policy: REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
    currentAuthority: {
      resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
    },
    currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event.none'] }) },
    rosterRead: {
      repository: { readReviewerRoster: () => undefined },
      authority: { readReviewerAuthority: () => undefined }
    },
    clock: { now: () => parseInstant('2026-08-13T12:00:00.000Z') },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    directRequestHashSealer: createHmacRequestHashSealer({
      profile: REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x77)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`reviewer-roster:${raw}`).digest('hex')
        };
      }
    }
  });
}

describe('reviewer roster operation module', () => {
  test('registers one current-authority read and one direct mutation path', async () => {
    let registry;
    try {
      registry = await createOperationRegistry(module().source);
    } catch (error) {
      if (error && typeof error === 'object' && 'issues' in error) {
        console.error(JSON.stringify(error.issues, null, 2));
      }
      throw error;
    }
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: binding.operationName,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION.name,
      method: 'GET',
      path: '/api/events/current/reviewer-roster'
    }]);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: binding.operationName,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: REVIEWER_ROSTER_CHANGE_OPERATION.name,
      method: 'POST',
      path: '/api/events/current/reviewer-roster/changes'
    }]);
    expect(registry.safeManifest.operations.find((operation) =>
      operation.name === REVIEWER_ROSTER_CHANGE_OPERATION.name
    )).toMatchObject({
      effect: 'commit', maxRisk: 'low', idempotency: { required: true },
      consequenceTags: ['reviewer-roster-changed']
    });
  });

  test('uses only current event.manage authority for reads and mutations', () => {
    const source = module().source;
    expect(source.operations?.[0]?.accessLanes).toEqual(source.effectOperations?.[0]?.accessLanes);
  });

  test('keeps current scope, email identity, and attribution out of browser input', () => {
    const ordinary = {
      action: 'register' as const,
      reviewerId: crypto.randomUUID(),
      accessSubject: {
        kind: 'access_reservation' as const,
        id: crypto.randomUUID(),
        version: 1
      },
      reviews: [],
      expectedRosterVersion: 1,
      expectedRosterDigestSha256: 'a'.repeat(64)
    };
    expect(reviewerRosterChangeDraftInputSchema.safeParse(ordinary).success).toBe(true);
    for (const field of ['scope', 'email', 'attributedByUserId', 'attributedAt']) {
      expect(reviewerRosterChangeDraftInputSchema.safeParse({
        ...ordinary,
        [field]: field === 'scope' ? { workspaceId, eventId: crypto.randomUUID() } : 'unsafe'
      }).success).toBe(false);
    }
  });
});
