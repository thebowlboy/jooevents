import { env } from 'cloudflare:workers';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  CLOUDFLARE_EMAIL_ADAPTER_VERSION,
  CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
  CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST
} from '@jooevents/cloudflare-email';
import { buildCommunicationMessageRelease } from '@jooevents/communications';
import { canonicalJsonText, parseInstant, parsePayloadRefId } from '@jooevents/kernel';
import {
  COMMUNICATION_MESSAGE_RELEASE_ENVELOPE_PURPOSE,
  communicationMessageReleaseEnvelopeBinding
} from '@jooevents/persistence/communication-message-release-classification';
import { beforeAll, describe, expect, test } from 'vitest';
import { D1BufferedClassifiedPayloadStore } from '../src/d1-classified-payload-store';
import {
  classifiedD1CommunicationProfiles,
  loadD1CryptoProfiles
} from '../src/d1-application-runtime';
import { runD1BufferedUnitOfWork } from '../src/d1-atomic-batch';
import {
  dispatchD1OutboundEmailWake,
  type D1OutboundEmailQueueEnvironment
} from '../src/d1-outbound-email-queue';

const uuid = (suffix: number): string =>
  `019c1df8-d4f0-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = uuid(3001);
const eventId = uuid(3002);
const connectionId = uuid(3003);
const connectionRevisionId = uuid(3004);
const releaseId = uuid(3005);
const batchId = uuid(3006);
const deliveryId = uuid(3007);
const payloadRefId = parsePayloadRefId(uuid(3008));
const receiptId = uuid(3009);
const rootFactId = uuid(3010);
const rootPointerId = uuid(3011);
const historyThreadId = uuid(3012);
const rootHistoryId = uuid(3013);
const digest = (character: string) => character.repeat(64);
const now = '2026-08-17T00:00:00.000Z';
const nowMs = Date.parse(now);
const ring = (byte: number): string =>
  `1:${Buffer.alloc(32, byte).toString('base64url')}`;

function baseEnvironment(email: SendEmail): D1OutboundEmailQueueEnvironment {
  return {
    DB: env.DB,
    FILES: env.FILES,
    EMAIL: email,
    JOOEVENTS_REQUEST_HASH_KEYS: ring(0x71),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(0x72),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(0x73),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(0x74)
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  ));
  return [...result].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  const release = buildCommunicationMessageRelease({
    workspaceId,
    eventId,
    releaseId,
    batchId,
    recipientRefId: uuid(3014),
    personRefId: uuid(3015),
    contactRefId: uuid(3016),
    templateRevisionRefId: uuid(3017),
    contentRefId: uuid(3018),
    purposeKey: 'communication.transactional',
    reviewedMessageDigestSha256: digest('1'),
    sender: {
      fromAddress: 'events@mail.jooevents.com',
      fromDisplayName: 'JooEvents',
      senderProfileRevisionId: uuid(3019),
      senderPresentationContractKey: 'sender.presentation',
      senderPresentationContractVersion: 1,
      senderPresentationDigestSha256: digest('2')
    },
    toAddress: 'queue-recipient@example.test',
    subject: 'Encrypted D1 queue proof',
    textBody: 'This message reaches only the injected workerd binding.',
    createdAt: now
  });
  const bytes = new TextEncoder().encode(canonicalJsonText(release.envelope));
  const environment = baseEnvironment({ send: async () => ({ messageId: 'unused' }) } as SendEmail);
  const cryptoProfiles = loadD1CryptoProfiles(environment);
  const selected = classifiedD1CommunicationProfiles(cryptoProfiles);

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 queue workspace','active',?,?,1)`).bind(workspaceId, nowMs, nowMs),
    env.DB.prepare(`INSERT INTO events (id,workspace_id,name,created_at,updated_at)
      VALUES (?,?,'D1 queue event',?,?)`)
      .bind(eventId, workspaceId, nowMs, nowMs),
    env.DB.prepare(`INSERT INTO email_provider_connections (
      connection_id,workspace_id,display_name,adapter_key,lifecycle,head_version,
      current_revision_id,created_at,updated_at
    ) VALUES (?,?,?,?,'active_outbound',1,?,?,?)`).bind(
      connectionId, workspaceId, 'Cloudflare Email Sending',
      CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY, connectionRevisionId, now, now
    ),
    env.DB.prepare(`INSERT INTO email_provider_connection_revisions (
      revision_id,connection_id,revision_number,adapter_key,adapter_version,
      manifest_key,manifest_version,manifest_digest_sha256,config_digest_sha256,
      revision_json,created_at
    ) VALUES (?,?,1,?,?,?,?,?,?,?,?)`).bind(
      connectionRevisionId, connectionId, CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
      CLOUDFLARE_EMAIL_ADAPTER_VERSION,
      CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestKey,
      CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestVersion,
      CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST.manifestDigestSha256,
      digest('3'), '{}', now
    )
  ]);

  await runD1BufferedUnitOfWork({
    database: env.DB,
    work: async (unitOfWork) => {
      const store = new D1BufferedClassifiedPayloadStore({
        unitOfWork,
        encryptionProfile: selected.encryptionProfile,
        retainedEncryptionProfiles: selected.retainedEncryptionProfiles
      });
      const receipt = adoptSynchronousClassifiedPayload({
        store,
        put: {
          payloadRefId,
          binding: communicationMessageReleaseEnvelopeBinding(release),
          purpose: COMMUNICATION_MESSAGE_RELEASE_ENVELOPE_PURPOSE,
          bytes,
          createdAt: parseInstant(now)
        }
      });
      expect(openSynchronousClassifiedPayloadAdoptionReceipt({ receipt, expectedStore: store })
        .payloadRef.id).toBe(payloadRefId);
      unitOfWork.assertCurrent(
        'NOT EXISTS (SELECT 1 FROM communication_message_releases WHERE release_id = ?)',
        [releaseId]
      );
      unitOfWork.write(`INSERT INTO communication_message_releases (
        release_id,workspace_id,event_id,batch_id,recipient_ref_id,person_ref_id,
        contact_ref_id,template_revision_ref_id,content_ref_id,purpose_key,
        reviewed_message_digest_sha256,reviewed_envelope_digest_sha256,
        envelope_payload_ref_id,envelope_byte_size,envelope_digest_sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        release.releaseId, release.workspaceId, release.eventId, release.batchId,
        release.recipientRefId, release.personRefId, release.contactRefId,
        release.templateRevisionRefId, release.contentRefId, release.purposeKey,
        release.reviewedMessageDigestSha256, release.reviewedEnvelopeDigestSha256,
        payloadRefId, bytes.byteLength, await sha256(bytes), release.createdAt
      ]);
    }
  });
  bytes.fill(0);

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_heads (
      delivery_id,workspace_id,event_id,release_id,dispatch_generation,
      reviewed_message_digest_sha256,reviewed_envelope_digest_sha256,
      recipient_ref_id,template_revision_ref_id,content_ref_id,
      provider_connection_revision_id,external_delivery_key,sender_profile_revision_id,
      sender_presentation_contract_key,sender_presentation_contract_version,
      sender_presentation_digest_sha256,channel_address_id,channel_address_version,
      address_lookup_fingerprint_profile,address_lookup_fingerprint_version,
      address_lookup_fingerprint_sha256,state,version,attempt_count,unknown_attempt_count,
      marked_resend_exhausted,current_attempt_id,lease_claim_id,lease_acquired_at_ms,
      lease_expires_at_ms,receipt_id,root_fact_id,root_outbox_pointer_id,
      history_thread_id,root_history_id,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,1,?,?,1,?,1,?,'pending',1,0,0,0,
      NULL,NULL,NULL,NULL,?,?,?,?,?,?,?)`).bind(
      deliveryId, workspaceId, eventId, releaseId,
      release.reviewedMessageDigestSha256, release.reviewedEnvelopeDigestSha256,
      release.recipientRefId, release.templateRevisionRefId, release.contentRefId,
      connectionRevisionId, 'cloudflare-queue-proof', release.envelope.from.address,
      'sender.presentation', digest('2'), uuid(3020),
      'address.fingerprint', digest('4'), receiptId, rootFactId, rootPointerId,
      historyThreadId, rootHistoryId, nowMs, nowMs
    ),
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_facts (
      fact_id,receipt_id,workspace_id,event_id,delivery_id,fact_kind,fact_version,
      payload_json,occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, '{}', ?)`)
      .bind(rootFactId, receiptId, workspaceId, eventId, deliveryId, nowMs),
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_outbox (
      pointer_id,receipt_id,fact_id,delivery_id,purpose,created_at_ms
    ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)`)
      .bind(rootPointerId, receiptId, rootFactId, deliveryId, nowMs),
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_history (
      history_id,thread_id,sequence,receipt_id,fact_id,delivery_id,
      summary_code,occurred_at_ms
    ) VALUES (?, ?, 0, ?, ?, ?, 'communication.outbound-email.requested', ?)`)
      .bind(rootHistoryId, historyThreadId, receiptId, rootFactId, deliveryId, nowMs)
  ]);
});

describe('D1 outbound email Queue composition in workerd', () => {
  test('opens the encrypted release and settles through only the injected binding', async () => {
    const captured: EmailMessageBuilder[] = [];
    const email = {
      async send(message: EmailMessageBuilder) {
        captured.push(message);
        return { messageId: 'workerd-injected-message-id' };
      }
    } as SendEmail;

    const result = await dispatchD1OutboundEmailWake(baseEnvironment(email));

    expect(result).toMatchObject({ considered: 1, skipped: 0, faults: [] });
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]).toMatchObject({ state: 'accepted', followUp: 'complete' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      to: 'queue-recipient@example.test',
      from: { email: 'events@mail.jooevents.com', name: 'JooEvents' },
      subject: 'Encrypted D1 queue proof'
    });
    const state = await env.DB.prepare(`SELECT state,attempt_count,lease_claim_id
      FROM communication_outbound_delivery_heads WHERE delivery_id = ?`
    ).bind(deliveryId).first<{
      state: string;
      attempt_count: number;
      lease_claim_id: string | null;
    }>();
    expect(state).toEqual({ state: 'accepted', attempt_count: 1, lease_claim_id: null });
    expect(await env.DB.prepare(`SELECT count(*) AS count
      FROM communication_outbound_delivery_history WHERE thread_id = ?`
    ).bind(historyThreadId).first<{ count: number }>()).toEqual({ count: 2 });
  });
});
