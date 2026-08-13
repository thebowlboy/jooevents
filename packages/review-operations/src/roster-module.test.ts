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
  REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION,
  REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
  REVIEWER_ROSTER_SNAPSHOT_READ_OPERATION,
  createReviewerRosterOperationModule,
  reviewerRosterDiffReadPermissionIds,
  reviewerRosterDraftDomainContributionSchema
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
    requestHashSealer: createHmacRequestHashSealer({
      profile: REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x76)
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
  test('registers one current-authority read and one idempotent draft path', async () => {
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
      operation: REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION.name,
      method: 'POST',
      path: '/api/events/current/reviewer-roster/drafts'
    }]);
    expect(registry.safeManifest.operations.find((operation) =>
      operation.name === REVIEWER_ROSTER_CHANGE_DRAFT_OPERATION.name
    )).toMatchObject({
      effect: 'draft', maxRisk: 'low', idempotency: { required: true },
      consequenceTags: ['changeset-drafted']
    });
  });

  test('uses only current event.manage authority for roster and generic diff reads', () => {
    expect(reviewerRosterDiffReadPermissionIds()).toEqual(['event.manage']);
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

  test('requires exact event.manage diff ownership in stored draft evidence', () => {
    const base = {
      kind: 'reviewer_roster_changeset_draft' as const,
      preparationHandle: crypto.randomUUID(),
      workspaceId,
      eventId: crypto.randomUUID(),
      changesetId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      revisionDigestSha256: 'a'.repeat(64),
      action: 'set_scope' as const,
      reviewerId: crypto.randomUUID(),
      occurredAt: '2026-08-13T12:00:00.000Z'
    };
    expect(reviewerRosterDraftDomainContributionSchema.safeParse({
      ...base, diffReadPermissionIds: ['event.manage']
    }).success).toBe(true);
    expect(reviewerRosterDraftDomainContributionSchema.safeParse({
      ...base, diffReadPermissionIds: ['submission.score']
    }).success).toBe(false);
  });
});
