import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createOperationRegistry } from '@jooevents/application';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  ENGAGEMENT_CHANGE_DRAFT_OPERATION,
  ENGAGEMENT_DRAFT_ACCESS_POLICY,
  ENGAGEMENT_DRAFT_APPROVAL_POLICY,
  ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE,
  ENGAGEMENT_READ_ACCESS_POLICY,
  ENGAGEMENT_SNAPSHOT_READ_OPERATION,
  createEngagementDraftOperationModule,
  createEngagementOperationModule,
  engagementDraftContributionSchema
} from '.';

const scope = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101')
});
const profile = Object.freeze({ key: 'engagement-operation-test', version: parseContractVersion(1) });
const uuid = (last: string) => `019c1df7-86b5-769b-bba4-5f7097bfa${last}`;

describe('Engagement operation modules', () => {
  test('registers the current-event, current-authority engagement snapshot read', async () => {
    const module = createEngagementOperationModule({
      workspaceId: scope.workspaceId,
      readPolicy: ENGAGEMENT_READ_ACCESS_POLICY,
      currentAuthority: {
        resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
      },
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      clock: { now: () => parseInstant('2026-08-14T12:00:00.000Z') },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      engagements: { readEngagementSnapshot: () => undefined }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${ENGAGEMENT_SNAPSHOT_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/engagements'
    }]);
    expect(registry.safeManifest.operations[0]).toMatchObject({
      effect: 'read', maxRisk: 'low', consequenceTags: []
    });
  });

  test('registers the response draft on the persistence-pinned wire identity with typed refusals', async () => {
    // The persistence draft adapter refuses any other injected identity, and
    // its receipt tables CHECK exactly this name and version.
    expect(ENGAGEMENT_CHANGE_DRAFT_OPERATION).toEqual({
      name: 'engagement.change.draft', version: 1
    });
    expect(ENGAGEMENT_DRAFT_APPROVAL_POLICY.requirement).toBe('none');
    const module = createEngagementDraftOperationModule({
      workspaceId: scope.workspaceId,
      draftPolicy: ENGAGEMENT_DRAFT_ACCESS_POLICY,
      currentAuthority: {
        resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
      },
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      clock: { now: () => parseInstant('2026-08-14T12:00:00.000Z') },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: {
        seal: () => Object.freeze({
          profile: ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE,
          requestHashSha256: 'a'.repeat(64)
        })
      } as never,
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: (raw: string) => Object.freeze({
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`engagement-key:${raw}`).digest('hex')
        })
      }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path,
      input: binding.input
    }))).toEqual([{
      operation: `${ENGAGEMENT_CHANGE_DRAFT_OPERATION.name}@1`,
      method: 'POST',
      path: '/api/events/current/engagements/drafts',
      input: 'body'
    }]);
    const manifest = registry.safeManifest.operations.find(
      (operation) => operation.name === ENGAGEMENT_CHANGE_DRAFT_OPERATION.name
    );
    expect(manifest).toMatchObject({ effect: 'draft', consequenceTags: ['changeset-drafted'] });
    const outcomeKeys = (manifest as { outcomes: readonly { class: string; kind: string }[] })
      .outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`);
    expect(outcomeKeys).toContain('stale_revision:engagement.changed');
    expect(outcomeKeys).toContain('conflict:engagement.event_required');
    expect(outcomeKeys).toContain('conflict:changeset.id_collision');
  });

  test('refusal contribution accepts only the declared typed outcomes with matching details', () => {
    const outcome = (kind: string, detail: unknown, klass = 'conflict') => ({
      result: {
        kind: 'outcome',
        outcome: {
          class: klass, kind, retryable: false,
          subjects: [], detail, detailSchemaVersion: 1
        }
      },
      domain: null,
      receiptChildren: []
    });
    expect(engagementDraftContributionSchema.safeParse(outcome(
      'engagement.event_required', null
    )).success).toBe(true);
    expect(engagementDraftContributionSchema.safeParse(outcome(
      'engagement.changed',
      { code: 'stale_engagement', engagementId: uuid('601') },
      'stale_revision'
    )).success).toBe(true);
    expect(engagementDraftContributionSchema.safeParse(outcome(
      'engagement.changed', null, 'stale_revision'
    )).success).toBe(false);
    expect(engagementDraftContributionSchema.safeParse(outcome(
      'changeset.id_collision', null
    )).success).toBe(true);
    expect(engagementDraftContributionSchema.safeParse(outcome(
      'engagement.notify', null
    )).success).toBe(false);
  });

  test('success contribution accepts exactly the adapter-authored coherent evidence shape', () => {
    const engagementId = uuid('601');
    const submissionId = uuid('602');
    const head = (state: 'invited' | 'confirmed', version: number) => ({
      schemaVersion: 1,
      id: engagementId,
      scope: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      sessionId: uuid('603'),
      personId: uuid('604'),
      submissionId,
      seededByDecision: { version: 1, digestSha256: 'b'.repeat(64) },
      state,
      invitedAt: '2026-08-14T11:00:00.000Z',
      respondBy: null,
      confirmation: state === 'confirmed'
        ? {
            attribution: 'organizer_recorded',
            personId: uuid('604'),
            recordedByUserId: uuid('605'),
            confirmedAt: '2026-08-14T12:00:00.000Z'
          }
        : null,
      cancellationRequest: null,
      cancelledAt: null,
      source: { kind: 'submission', id: submissionId, version: 1 },
      version
    });
    const contribution = (mutate: (value: {
      domain: { engagementId: string; action: string };
      receiptChildren: [{ occurredAt: string }];
    }) => void = () => {}) => {
      const value = {
        result: {
          kind: 'success',
          data: {
            schemaVersion: 1,
            action: 'record_confirmation',
            changesetId: uuid('606'),
            headVersion: 1,
            status: 'draft',
            revision: { id: uuid('607'), number: 1, digestSha256: 'c'.repeat(64) },
            riskTier: 'consequential',
            approvalPolicy: ENGAGEMENT_DRAFT_APPROVAL_POLICY,
            safeDiff: {
              action: 'record_confirmation',
              before: head('invited', 1),
              after: head('confirmed', 2)
            }
          }
        },
        domain: {
          kind: 'engagement_changeset_draft',
          preparationHandle: uuid('608'),
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          changesetId: uuid('606'),
          revisionId: uuid('607'),
          revisionDigestSha256: 'c'.repeat(64),
          recordDigestSha256: 'd'.repeat(64),
          action: 'record_confirmation',
          engagementId,
          occurredAt: '2026-08-14T12:00:00.000Z'
        },
        receiptChildren: [{
          kind: 'timeline',
          timelineId: uuid('609'),
          sourceKind: 'changeset_revision',
          workspaceId: scope.workspaceId,
          eventId: scope.eventId,
          changesetId: uuid('606'),
          revisionId: uuid('607'),
          occurredAt: '2026-08-14T12:00:00.000Z'
        }] as unknown as [{ occurredAt: string }]
      };
      mutate(value as never);
      return value;
    };
    expect(engagementDraftContributionSchema.safeParse(contribution()).success).toBe(true);
    // A domain link naming a different engagement than the diff is incoherent.
    expect(engagementDraftContributionSchema.safeParse(contribution((value) => {
      value.domain.engagementId = uuid('60a');
    })).success).toBe(false);
    // The timeline child must carry the domain's occurredAt.
    expect(engagementDraftContributionSchema.safeParse(contribution((value) => {
      value.receiptChildren[0].occurredAt = '2026-08-14T13:00:00.000Z';
    })).success).toBe(false);
    // The domain action must match the drafted action.
    expect(engagementDraftContributionSchema.safeParse(contribution((value) => {
      value.domain.action = 'decline';
    })).success).toBe(false);
  });
});
