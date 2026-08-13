import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createHmacRequestHashSealer, createOperationRegistry } from '@jooevents/application';
import {
  reviewOpenRoundChangeDraftInputSchema,
  reviewRoundOpenAtomicJoinRequirementSchema
} from '@jooevents/contracts/reviews';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  REVIEW_DRAFT_SAVE_REQUEST_HASH_PROFILE,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION,
  REVIEW_EVALUATION_DRAFT_SAVE_OPERATION,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_ROUND_CHANGE_DRAFT_OPERATION,
  REVIEW_ROUND_SETUP_READ_OPERATION,
  REVIEW_SNAPSHOT_ACCESS_POLICY,
  REVIEW_SNAPSHOT_READ_OPERATION,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  REVIEW_STEP_BACK_DRAFT_OPERATION,
  createReviewOperationModule,
  reviewChangesetDraftDomainContributionSchema,
  reviewDiffReadPermissionIdsForAction
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
  test('registers six operations with only their declared operator bindings', async () => {
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
      REVIEW_EVALUATION_CHANGE_DRAFT_OPERATION.name,
      REVIEW_EVALUATION_DRAFT_SAVE_OPERATION.name,
      REVIEW_ROUND_CHANGE_DRAFT_OPERATION.name,
      REVIEW_ROUND_SETUP_READ_OPERATION.name,
      REVIEW_SNAPSHOT_READ_OPERATION.name,
      REVIEW_STEP_BACK_DRAFT_OPERATION.name
    ].sort());
    expect(registry.operatorHttpBindings.map((binding) => binding.path)).toEqual([
      '/api/events/current/review/round-setup',
      '/api/events/current/review/snapshot'
    ]);
    expect(registry.operatorHttpEffectBindings.map((binding) => binding.path)).toEqual([
      '/api/events/current/review/evaluation-draft',
      '/api/events/current/review/evaluation-drafts',
      '/api/events/current/review/round-drafts',
      '/api/events/current/review/step-back-drafts'
    ]);
  });

  test('keeps date intent untrusted and makes the atomic Deadline join blocker typed', () => {
    expect(reviewOpenRoundChangeDraftInputSchema.parse({
      action: 'open_round', deadlineDate: '2026-09-01'
    })).toEqual({ action: 'open_round', deadlineDate: '2026-09-01', anonymized: true });
    expect(reviewOpenRoundChangeDraftInputSchema.safeParse({
      action: 'open_round', deadlineId: crypto.randomUUID()
    }).success).toBe(false);
    expect(reviewRoundOpenAtomicJoinRequirementSchema.parse({
      schemaVersion: 1,
      kind: 'review_due_round_atomic_join',
      deadlineKind: 'review_due',
      deadlineDate: '2026-09-01',
      atomic: true
    })).toMatchObject({ atomic: true, deadlineKind: 'review_due' });
  });

  test('carries exact split grants for generic changeset diff ownership', () => {
    expect(reviewDiffReadPermissionIdsForAction('open_round')).toEqual(['event.manage']);
    expect(reviewDiffReadPermissionIdsForAction('step_back')).toEqual(['submission.score']);
    expect(reviewDiffReadPermissionIdsForAction('commit_review'))
      .toEqual(['submission.comment', 'submission.score']);
    const base = {
      kind: 'review_changeset_draft' as const,
      preparationHandle: crypto.randomUUID(),
      workspaceId,
      eventId: crypto.randomUUID(),
      changesetId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      revisionDigestSha256: 'a'.repeat(64),
      recordDigestSha256: 'b'.repeat(64),
      action: 'commit_review' as const,
      occurredAt: '2026-08-13T12:00:00.000Z'
    };
    expect(reviewChangesetDraftDomainContributionSchema.safeParse({
      ...base,
      diffReadPermissionIds: ['submission.comment', 'submission.score']
    }).success).toBe(true);
    expect(reviewChangesetDraftDomainContributionSchema.safeParse({
      ...base,
      diffReadPermissionIds: ['event.manage']
    }).success).toBe(false);
  });
});
