import { createCloudflareWorkersEmailProvider } from '@jooevents/cloudflare-email';
import {
  createOutboundEmailDeliveryWorker,
  isOutboundEmailDispatchSkipped,
  type OutboundEmailDispatchResult
} from '@jooevents/communications';
import {
  classifiedD1CommunicationProfiles,
  loadD1CryptoProfiles,
  type D1ApplicationRuntimeEnvironment
} from './d1-application-runtime';
import { createD1OutboundEmailEnvelopeResolver } from './d1-message-release-resolver';
import { D1OutboundEmailDeliveryLedger } from './d1-outbound-email-delivery';

const MAXIMUM_DELIVERIES_PER_WAKE = 25;

interface CandidateRow { readonly delivery_id: string }

export interface D1OutboundEmailWakeResult {
  readonly considered: number;
  readonly dispatched: readonly OutboundEmailDispatchResult[];
  readonly skipped: number;
  readonly faults: readonly Readonly<{ deliveryId: string; errorName: string }>[];
}

export type D1OutboundEmailQueueEnvironment = D1ApplicationRuntimeEnvironment & {
  readonly EMAIL: SendEmail;
};

/**
 * Drains one bounded set of original/recovery deliveries. Safe retries and
 * marked resends remain deliberate actions; a Cron wake never invents one.
 */
export async function dispatchD1OutboundEmailWake(
  environment: D1OutboundEmailQueueEnvironment
): Promise<D1OutboundEmailWakeResult> {
  const provider = createCloudflareWorkersEmailProvider({
    binding: {
      send(message) {
        return environment.EMAIL.send(message as EmailMessageBuilder);
      }
    }
  }).delivery;
  const cryptoProfiles = loadD1CryptoProfiles(environment);
  const candidates = await environment.DB.withSession('first-primary').prepare(`
    SELECT head.delivery_id
      FROM communication_outbound_delivery_heads AS head
      JOIN email_provider_connection_revisions AS revision
        ON revision.revision_id = head.provider_connection_revision_id
      JOIN email_provider_connections AS connection
        ON connection.connection_id = revision.connection_id
       AND connection.workspace_id = head.workspace_id
     WHERE head.state IN ('pending','request_started')
       AND (head.lease_expires_at_ms IS NULL OR head.lease_expires_at_ms <= ?)
       AND connection.lifecycle IN ('active_outbound','draining')
       AND revision.adapter_key = ? AND revision.adapter_version = ?
     ORDER BY head.created_at_ms,head.delivery_id
     LIMIT ?
  `).bind(
    Date.now(), provider.adapterKey, provider.adapterVersion, MAXIMUM_DELIVERIES_PER_WAKE
  ).all<CandidateRow>();
  const ledger = new D1OutboundEmailDeliveryLedger(environment.DB, {
    newFactId: () => crypto.randomUUID(),
    newPointerId: () => crypto.randomUUID(),
    newHistoryId: () => crypto.randomUUID()
  });
  const selected = classifiedD1CommunicationProfiles(cryptoProfiles);
  const worker = createOutboundEmailDeliveryWorker({
    ledger,
    provider,
    envelopes: createD1OutboundEmailEnvelopeResolver({
      database: environment.DB,
      classifiedPayload: {
        encryptionProfile: selected.encryptionProfile,
        retainedEncryptionProfiles: selected.retainedEncryptionProfiles
      }
    }),
    ids: {
      newAttemptId: () => crypto.randomUUID(),
      newClaimId: () => crypto.randomUUID()
    },
    clock: { now: () => new Date().toISOString() }
  });
  const dispatched: OutboundEmailDispatchResult[] = [];
  const faults: Array<Readonly<{ deliveryId: string; errorName: string }>> = [];
  let skipped = 0;
  for (const candidate of candidates.results) {
    try {
      const outcome = await worker.dispatch({ deliveryId: candidate.delivery_id });
      if (isOutboundEmailDispatchSkipped(outcome)) skipped += 1;
      else dispatched.push(outcome);
    } catch (error) {
      faults.push(Object.freeze({
        deliveryId: candidate.delivery_id,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      }));
    }
  }
  return Object.freeze({
    considered: candidates.results.length,
    dispatched: Object.freeze(dispatched),
    skipped,
    faults: Object.freeze(faults)
  });
}
