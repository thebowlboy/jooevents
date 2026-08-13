import { describe, expect, test } from 'bun:test';
import {
  createHmacRequestHashSealer,
  createOperationRegistry,
  type EffectInvocationContext
} from '@jooevents/application';
import {
  parseOperationAccessLane,
  type CurrentAuthorityResolver
} from '@jooevents/identity-access';
import {
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createOutboundEmailDeliveryOperationModule,
  DISPATCH_MESSAGE_RELEASE_OPERATION,
  OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY
} from './module';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('550e8400-e29b-41d4-a716-446655440001'),
  job: parseJobId('018f0f47-7a86-7d36-8a25-9f86589c0001'),
  capability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0002'),
  citation: parseAuthorityCitationId('018f0f47-7a86-7d36-8a25-9f86589c0003')
};

const profile = {
  key: 'profile.communication.operation-test',
  version: parseContractVersion(1)
} as const;
const lane = parseOperationAccessLane({
  kind: 'registered_job',
  surface: 'application_job',
  policy: OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY
});

const authority: CurrentAuthorityResolver<EffectInvocationContext['evidence']> = {
  resolve: (resolution) => ({
    kind: 'authorized',
    authority: {
      actor: {
        kind: 'system_job',
        jobId: ids.job,
        registeredCapabilityRevisionId: ids.capability
      },
      principal: {
        kind: 'registered_job',
        jobId: ids.job,
        capabilityRevisionId: ids.capability,
        authorityCitationId: ids.citation
      },
      lane,
      scope: resolution.scope,
      grants: [{ kind: 'registered_capability', key: ids.capability }],
      evidenceIds: ['job-current:test'],
      authorityCitationIds: [ids.citation],
      evaluatedAt: resolution.evaluatedAt
    }
  })
};

describe('outbound email delivery registered operation', () => {
  test('compiles as an internal registered-job binding with no callable surface', async () => {
    const module = createOutboundEmailDeliveryOperationModule({
      policy: OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY,
      scopeResolver: {
        resolve: () => ({
          workspaceId: ids.workspace,
          eventId: ids.event,
          subjects: [
            { kind: 'workspace', id: ids.workspace },
            { kind: 'event', id: ids.event }
          ],
          resolutionEvidenceIds: ['job-scope:test']
        })
      },
      currentAuthority: authority,
      registeredJob: {
        job: { key: 'communication.message-dispatch', version: 1 },
        inputProjection: { key: 'communication.message-dispatch.input', version: 1 },
        capabilityRevisionId: ids.capability,
        authorityCitation: { key: 'communication.message-dispatch.authority', version: 1 }
      },
      clock: { now: () => parseInstant('2026-08-13T00:00:00.000Z') },
      newInvocationId: () => parseInvocationId('018f0f47-7a86-7d36-8a25-9f86589c0004'),
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: { key: 'request-hash.communication.test', version: 1 },
        keyBytes: new Uint8Array(32).fill(0x41)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: async () => ({ verifierProfile: profile, verifierSha256: 'a'.repeat(64) })
      }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings).toEqual([]);
    expect(registry.publicHttpEffectBindings).toEqual([]);
    expect(registry.appModelEffectBindings).toEqual([]);
    expect(registry.internalManifest.bindings).toEqual([expect.objectContaining({
      kind: 'registered_job',
      selector: { key: 'communication.message-dispatch', version: 1 },
      operation: DISPATCH_MESSAGE_RELEASE_OPERATION
    })]);
  });
});
