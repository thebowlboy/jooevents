import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createHmacRequestHashSealer, createOperationRegistry } from '@jooevents/application';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  REVIEW_DRAFT_SAVE_REQUEST_HASH_PROFILE,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_ROUND_SETUP_READ_OPERATION,
  REVIEW_SNAPSHOT_ACCESS_POLICY,
  REVIEW_SNAPSHOT_READ_OPERATION,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  createReviewOperationModule,
  reviewOpenRoundVisibilityPolicy,
  reviewSnapshotCanonicalResultSchema
} from '.';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const profile = Object.freeze({ key: 'review-operation-test', version: parseContractVersion(1) });

function operationModule() {
  return createReviewOperationModule({
    workspaceId,
    policies: {
      snapshot: REVIEW_SNAPSHOT_ACCESS_POLICY,
      manage: REVIEW_MANAGE_ACCESS_POLICY,
      stepBack: REVIEW_STEP_BACK_ACCESS_POLICY,
      evaluate: REVIEW_EVALUATE_ACCESS_POLICY
    },
    currentAuthority: {
      resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
    },
    currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event.none'] }) },
    viewer: { resolveViewer: () => ({ kind: 'unavailable' as const }) },
    repository: {
      readCatalog: () => undefined,
      readRound: () => undefined,
      listAssignments: () => [],
      readAssignment: () => undefined,
      readDraft: () => undefined,
      readReviewHead: () => undefined,
      readRevision: () => undefined,
      listRevisions: () => []
    },
    sources: {
      readCandidates: () => undefined,
      readCandidate: () => undefined,
      readReviewerRoster: () => undefined,
      resolveReviewDeadline: () => undefined
    },
    candidateDisplay: { readReviewCandidateDisplay: () => undefined },
    clock: { now: () => parseInstant('2026-08-13T12:00:00.000Z') },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: REVIEW_DRAFT_SAVE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x72)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`review:${raw}`).digest('hex')
        };
      }
    }
  });
}

describe('Review operation module', () => {
  test('registers reads and the retained evaluation working-draft save', async () => {
    let registry;
    try {
      registry = await createOperationRegistry(operationModule().source);
    } catch (error) {
      if (error && typeof error === 'object' && 'issues' in error) {
        console.error(JSON.stringify(error.issues, null, 2));
      }
      throw error;
    }
    expect(registry.safeManifest.operations.map((operation) => operation.name).sort()).toEqual([
      REVIEW_EVALUATION_DRAFT_SAVE_OPERATION.name,
      REVIEW_ROUND_SETUP_READ_OPERATION.name,
      REVIEW_SNAPSHOT_READ_OPERATION.name
    ].sort());
    expect(registry.operatorHttpBindings.map((binding) => binding.path)).toEqual([
      '/api/events/current/review/round-setup',
      '/api/events/current/review/snapshot'
    ]);
    expect(registry.operatorHttpEffectBindings.map((binding) => binding.path)).toEqual([
      '/api/events/current/review/evaluation-draft'
    ]);
  });

  test('expands anonymized to the canonical visibility axes', () => {
    expect(reviewOpenRoundVisibilityPolicy(true)).toEqual({
      participantIdentity: 'hidden',
      peerReviewerIdentity: 'hidden',
      peerContentUnlock: 'after_own_commit'
    });
    expect(reviewOpenRoundVisibilityPolicy(false)).toEqual({
      participantIdentity: 'shown',
      peerReviewerIdentity: 'shown',
      peerContentUnlock: 'after_own_commit'
    });
  });

  test('snapshot serving requires round version and criterion identities on every plan', () => {
    const plan = {
      id: crypto.randomUUID(),
      ordinal: 1,
      name: 'Round 1',
      state: 'open',
      version: 1,
      scaleMax: 5,
      criteria: [{
        id: crypto.randomUUID(), key: 'overall', label: 'Overall',
        position: 0, weightBps: 10_000, scaleMin: 1, scaleMax: 5
      }],
      deadlineEffectiveAt: '2026-08-31T00:00:00.000Z',
      anonymized: true,
      antiAnchoring: true,
      done: 0,
      total: 0,
      reviewers: []
    };
    const snapshot = (planValue: unknown) => ({
      kind: 'success',
      data: {
        schemaVersion: 1,
        viewer: { kind: 'organizer' },
        plans: [planValue],
        standings: {}
      }
    });
    expect(reviewSnapshotCanonicalResultSchema.safeParse(snapshot(plan)).success).toBe(true);
    const { criteria: _criteria, ...planWithoutCriteria } = plan;
    expect(reviewSnapshotCanonicalResultSchema.safeParse(snapshot(planWithoutCriteria)).success)
      .toBe(false);
  });
});
