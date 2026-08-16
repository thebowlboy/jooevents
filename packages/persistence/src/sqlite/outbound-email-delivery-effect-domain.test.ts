import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type EffectAuthorityRecheckSource,
  type EffectInvocationContext
} from '@jooevents/application';
import {
  createOutboundEmailDeliveryOperationModule,
  OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY
} from '@jooevents/communication-operations';
import {
  computeReviewedEmailEnvelopeDigestSha256,
  createFakeEmailEnvelope
} from '@jooevents/communications';
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
import { installFoundationTrialUnitOfWorkSchema } from './foundation-trial-uow';
import {
  createSQLiteEffectDomainAdapterRegistry,
  SQLiteEffectUnitOfWorkPort
} from './sqlite-effect-unit-of-work';
import {
  createSQLiteOutboundEmailDeliveryEffectDomainRegistration
} from './outbound-email-delivery-effect-domain';
import {
  installSQLiteOutboundEmailDeliverySchema,
  SQLiteOutboundEmailDeliveryLedger
} from './outbound-email-delivery';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('550e8400-e29b-41d4-a716-446655440001'),
  job: parseJobId('018f0f47-7a86-7d36-8a25-9f86589c0001'),
  capability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0002'),
  citation: parseAuthorityCitationId('018f0f47-7a86-7d36-8a25-9f86589c0003')
};
const profile = {
  key: 'profile.communication.joined-test',
  version: parseContractVersion(1)
};
let sequence = 10;
function nextUuid(): string {
  return `018f0f47-7a86-7d36-8a25-${String(++sequence).padStart(12, '0')}`;
}

function authority(): EffectAuthorityRecheckSource {
  return {
    now: () => parseInstant('2026-08-13T00:00:00.000Z'),
    resolveAuthority: (resolution) => {
      if (resolution.evidence.kind !== 'registered_job'
        || resolution.evidence.jobId !== ids.job) {
        return { kind: 'denied', reason: 'lane_mismatch' };
      }
      return {
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
          lane: resolution.lane,
          scope: resolution.scope,
          grants: [{ kind: 'registered_capability', key: ids.capability }],
          evidenceIds: ['job-current:test'],
          authorityCitationIds: [ids.citation],
          evaluatedAt: resolution.evaluatedAt
        }
      };
    }
  };
}

function operationInput() {
  const envelope = createFakeEmailEnvelope({
    from: 'sender@example.test',
    to: 'private-recipient@example.test',
    subject: 'Reviewed subject',
    textBody: 'private reviewed body'
  });
  return {
    envelope,
    input: {
      contractVersion: 1 as const,
      deliveryId: 'delivery-joined-1',
      releaseId: 'release-joined-1',
      dispatchGeneration: 1,
      reviewedMessageDigestSha256: '1'.repeat(64),
      reviewedEnvelopeDigestSha256: computeReviewedEmailEnvelopeDigestSha256(envelope),
      recipientRefId: 'recipient-ref-joined-1',
      templateRevisionRefId: 'template-ref-joined-1',
      contentRefId: 'content-ref-joined-1',
      providerConnectionRevisionId: 'connection-ref-joined-1',
      externalDeliveryKey: 'external-delivery-joined-1',
      senderProfileRevisionId: 'sender-ref-joined-1',
      senderPresentationContractKey: 'sender.presentation',
      senderPresentationContractVersion: 1,
      senderPresentationDigestSha256: '2'.repeat(64),
      channelAddressId: 'channel-address-joined-1',
      channelAddressVersion: 1,
      addressLookupFingerprintProfile: 'address.fingerprint',
      addressLookupFingerprintVersion: 1,
      addressLookupFingerprintSha256: '3'.repeat(64)
    }
  };
}

describe('registered outbound email delivery operation joined to SQLite', () => {
  test('commits the work anchor, receipt, fact, outbox, and one root history atomically', async () => {
    const sqlite = new Database(':memory:');
    installFoundationTrialUnitOfWorkSchema(sqlite);
    installSQLiteOutboundEmailDeliverySchema(sqlite);
    const source = operationInput();
    const module = createOutboundEmailDeliveryOperationModule({
      policy: OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY,
      scopeResolver: {
        resolve: ({ evidence }) => {
          if (evidence.kind !== 'registered_job') throw new TypeError('registered job required');
          return {
            workspaceId: ids.workspace,
            eventId: ids.event,
            subjects: [
              { kind: 'workspace', id: ids.workspace },
              { kind: 'event', id: ids.event }
            ],
            resolutionEvidenceIds: [`job-scope:${evidence.jobId}`]
          };
        }
      },
      currentAuthority: { resolve: authority().resolveAuthority },
      registeredJob: {
        job: { key: 'communication.message-dispatch', version: 1 },
        inputProjection: { key: 'communication.message-dispatch.input', version: 1 },
        capabilityRevisionId: ids.capability,
        authorityCitation: { key: 'communication.message-dispatch.authority', version: 1 }
      },
      clock: { now: () => parseInstant('2026-08-13T00:00:00.000Z') },
      newInvocationId: () => parseInvocationId(nextUuid()),
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: {
          key: 'request-hash.communication.outbound-email-delivery.dispatch',
          version: 1
        },
        keyBytes: new Uint8Array(32).fill(0x42)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: async () => ({ verifierProfile: profile, verifierSha256: '4'.repeat(64) })
      }
    });
    const domain = createSQLiteOutboundEmailDeliveryEffectDomainRegistration({
      sqlite,
      ids: {
        newPreparationHandle: nextUuid,
        newFactId: () => `fact-${nextUuid()}`,
        newPointerId: () => `pointer-${nextUuid()}`,
        newHistoryThreadId: () => `thread-${nextUuid()}`,
        newHistoryId: () => `history-${nextUuid()}`
      }
    });
    const unitOfWork = new SQLiteEffectUnitOfWorkPort(
      sqlite,
      createSQLiteEffectDomainAdapterRegistry([domain]),
      authority()
    );
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-13T00:00:00.000Z') },
        newInvocationId: () => parseInvocationId(nextUuid())
      },
      unitOfWork,
      effectBuilder: {
        registeredJobAnchorResolver: {
          resolve: () => ({ registeredIdempotencyIdentity: 'dispatch:release-joined-1:1' })
        }
      },
      newOperationLogId: nextUuid
    });
    const invocation = await runtime.effectBuilder.buildRegisteredJob({
      job: { key: 'communication.message-dispatch', version: 1 },
      jobId: ids.job,
      correlationId: nextUuid(),
      businessInput: source.input
    });
    const first = await runtime.effectExecutor.execute(invocation);
    expect(first).toMatchObject({
      kind: 'success',
      data: { deliveryId: source.input.deliveryId, disposition: 'created' }
    });
    const ledger = new SQLiteOutboundEmailDeliveryLedger(sqlite, {
      newFactId: () => 'unused-fact',
      newPointerId: () => 'unused-pointer',
      newHistoryId: () => 'unused-history'
    });
    expect(ledger.read(source.input.deliveryId)).toMatchObject({
      state: 'pending',
      attemptCount: 0,
      reviewedMessageDigestSha256: source.input.reviewedMessageDigestSha256
    });
    for (const table of [
      'operation_log',
      'communication_outbound_delivery_facts',
      'communication_outbound_delivery_outbox',
      'communication_outbound_delivery_history'
    ]) {
      expect(sqlite.query<{ readonly count: number }, []>(
        `SELECT count(*) AS count FROM ${table}`
      ).get()?.count).toBe(1);
    }
    const durableText = sqlite.query<{ readonly payload_json: string }, []>(
      'SELECT payload_json FROM communication_outbound_delivery_facts'
    ).get()?.payload_json ?? '';
    expect(durableText).not.toContain('private-recipient@example.test');
    expect(durableText).not.toContain('private reviewed body');

    const replayInvocation = await runtime.effectBuilder.buildRegisteredJob({
      job: { key: 'communication.message-dispatch', version: 1 },
      jobId: ids.job,
      correlationId: nextUuid(),
      businessInput: source.input
    });
    const replay = await runtime.effectExecutor.execute(replayInvocation);
    expect(replay).toMatchObject({ kind: 'success', data: { disposition: 'created' } });
    expect(sqlite.query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM communication_outbound_delivery_heads'
    ).get()?.count).toBe(1);
    sqlite.close();
  });
});
