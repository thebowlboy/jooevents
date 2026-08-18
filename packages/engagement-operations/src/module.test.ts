import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createOperationRegistry, getCompiledEffectOperation } from '@jooevents/application';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  ENGAGEMENT_CHANGE_OPERATION,
  ENGAGEMENT_MANAGE_ACCESS_POLICY,
  ENGAGEMENT_REQUEST_HASH_PROFILE,
  ENGAGEMENT_READ_ACCESS_POLICY,
  ENGAGEMENT_SNAPSHOT_READ_OPERATION,
  SPEAKER_LINEUP_SNAPSHOT_READ_OPERATION,
  createEngagementDirectOperationModule,
  createEngagementOperationModule,
  engagementDirectContributionSchema
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
      engagements: { readEngagementSnapshot: () => undefined },
      lineups: { readSpeakerLineupSnapshot: () => undefined }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([
      {
        operation: `${ENGAGEMENT_SNAPSHOT_READ_OPERATION.name}@1`,
        method: 'GET',
        path: '/api/events/current/engagements'
      },
      {
        operation: `${SPEAKER_LINEUP_SNAPSHOT_READ_OPERATION.name}@1`,
        method: 'GET',
        path: '/api/events/current/speaker-lineup'
      }
    ]);
    expect(registry.safeManifest.operations[0]).toMatchObject({
      effect: 'read', maxRisk: 'low', consequenceTags: []
    });
  });

  test('registers the direct response on the persistence-pinned wire identity with typed refusals', async () => {
    expect(ENGAGEMENT_CHANGE_OPERATION).toEqual({
      name: 'engagement.change', version: 1
    });
    const module = createEngagementDirectOperationModule({
      workspaceId: scope.workspaceId,
      managePolicy: ENGAGEMENT_MANAGE_ACCESS_POLICY,
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
          profile: ENGAGEMENT_REQUEST_HASH_PROFILE,
          requestHashSha256: 'a'.repeat(64)
        })
      } as never,
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: (raw: string) => Object.freeze({
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`engagement-key:${raw}`).digest('hex')
        })
      },
      enableVerifiedInbox: true
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path,
      input: binding.input
    }))).toEqual([{
      operation: `${ENGAGEMENT_CHANGE_OPERATION.name}@1`,
      method: 'POST',
      path: '/api/events/current/engagements',
      input: 'body'
    }]);
    const manifest = registry.safeManifest.operations.find(
      (operation) => operation.name === ENGAGEMENT_CHANGE_OPERATION.name
    );
    expect(manifest).toMatchObject({ effect: 'commit', consequenceTags: ['engagement-changed'] });
    const outcomeKeys = (manifest as { outcomes: readonly { class: string; kind: string }[] })
      .outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`);
    expect(outcomeKeys).toContain('stale_revision:engagement.changed');
    expect(outcomeKeys).toContain('conflict:engagement.event_required');
    expect(manifest?.enabledBindings.map((binding) => binding.surface)).toEqual(['operator_http']);
    expect(JSON.stringify(manifest)).not.toContain('provider_ingress');
    expect(getCompiledEffectOperation(
      registry,
      ENGAGEMENT_CHANGE_OPERATION.name,
      ENGAGEMENT_CHANGE_OPERATION.version,
      'provider_ingress'
    )?.binding).toMatchObject({ surface: 'provider_ingress' });
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
      effectContributions: []
    });
    expect(engagementDirectContributionSchema.safeParse(outcome(
      'engagement.event_required', null
    )).success).toBe(true);
    expect(engagementDirectContributionSchema.safeParse(outcome(
      'engagement.changed',
      { code: 'stale_engagement', engagementId: uuid('601') },
      'stale_revision'
    )).success).toBe(true);
    expect(engagementDirectContributionSchema.safeParse(outcome(
      'engagement.changed', null, 'stale_revision'
    )).success).toBe(false);
    expect(engagementDirectContributionSchema.safeParse(outcome(
      'operation.id_collision', null
    )).success).toBe(false);
    expect(engagementDirectContributionSchema.safeParse(outcome(
      'engagement.notify', null
    )).success).toBe(false);
  });

});
