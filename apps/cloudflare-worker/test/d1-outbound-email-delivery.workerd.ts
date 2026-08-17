import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  FAKE_PROVIDER_SCENARIO_KEYS,
  computeReviewedEmailEnvelopeDigestSha256,
  createDeterministicFakeEmailProvider,
  createFakeEmailEnvelope,
  createOutboundEmailDeliveryWorker
} from '@jooevents/communications';
import { D1OutboundEmailDeliveryLedger } from '../src/d1-outbound-email-delivery';

const DELIVERY_ID = 'd1-delivery-test';
const RECEIPT_ID = 'd1-delivery-receipt';
const ROOT_FACT_ID = 'd1-delivery-root-fact';
const ROOT_POINTER_ID = 'd1-delivery-root-pointer';
const THREAD_ID = 'd1-delivery-thread';
const ROOT_HISTORY_ID = 'd1-delivery-root-history';
const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const EVENT_ID = '550e8400-e29b-41d4-a716-446655440001';
const STARTED_AT = Date.parse('2026-08-17T00:00:00.000Z');
const digest = (character: string) => character.repeat(64);
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

const envelope = createFakeEmailEnvelope({
  from: 'events@mail.jooevents.com',
  to: 'recipient@example.test',
  subject: 'Reviewed D1 delivery',
  textBody: 'The provider in this test is deterministic and cannot send mail.'
});

beforeEach(async () => {
  sequence = 0;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM d1_operation_batch_guards`),
    env.DB.prepare(`DELETE FROM communication_outbound_delivery_history`),
    env.DB.prepare(`DELETE FROM communication_outbound_delivery_outbox`),
    env.DB.prepare(`DELETE FROM communication_outbound_delivery_facts`),
    env.DB.prepare(`DELETE FROM communication_outbound_delivery_attempts`),
    env.DB.prepare(`UPDATE communication_outbound_delivery_heads
      SET receipt_id = NULL WHERE delivery_id = ?`).bind(DELIVERY_ID),
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
      NULL,NULL,NULL,NULL,?,?,?,?,?,?,?)
    ON CONFLICT (delivery_id) DO NOTHING`).bind(
      DELIVERY_ID, WORKSPACE_ID, EVENT_ID, 'd1-delivery-release',
      digest('1'), computeReviewedEmailEnvelopeDigestSha256(envelope),
      'd1-delivery-recipient', 'd1-delivery-template', 'd1-delivery-content',
      'd1-delivery-connection', FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      'd1-delivery-sender', 'sender.presentation', digest('2'),
      'd1-delivery-channel', 'address.fingerprint', digest('3'),
      RECEIPT_ID, ROOT_FACT_ID, ROOT_POINTER_ID, THREAD_ID, ROOT_HISTORY_ID,
      STARTED_AT, STARTED_AT
    ),
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_facts (
      fact_id,receipt_id,workspace_id,event_id,delivery_id,fact_kind,fact_version,
      payload_json,occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, '{}', ?)`)
      .bind(ROOT_FACT_ID, RECEIPT_ID, WORKSPACE_ID, EVENT_ID, DELIVERY_ID, STARTED_AT),
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_outbox (
      pointer_id,receipt_id,fact_id,delivery_id,purpose,created_at_ms
    ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)`)
      .bind(ROOT_POINTER_ID, RECEIPT_ID, ROOT_FACT_ID, DELIVERY_ID, STARTED_AT),
    env.DB.prepare(`INSERT INTO communication_outbound_delivery_history (
      history_id,thread_id,sequence,receipt_id,fact_id,delivery_id,
      summary_code,occurred_at_ms
    ) VALUES (?, ?, 0, ?, ?, ?, 'communication.outbound-email.requested', ?)`)
      .bind(ROOT_HISTORY_ID, THREAD_ID, RECEIPT_ID, ROOT_FACT_ID, DELIVERY_ID, STARTED_AT)
  ]);
});

describe('D1 outbound email delivery ledger in workerd', () => {
  test('runs the shared delivery policy through asynchronous atomic D1 boundaries', async () => {
    const ledger = new D1OutboundEmailDeliveryLedger(env.DB, {
      newFactId: () => nextId('fact'),
      newPointerId: () => nextId('pointer'),
      newHistoryId: () => nextId('history')
    });
    const fake = createDeterministicFakeEmailProvider();
    const firstClaim = await ledger.claim({
      deliveryId: DELIVERY_ID,
      claimId: 'probe-claim-owner',
      now: '2026-08-17T00:00:00.000Z',
      leaseMs: 60_000
    });
    expect(firstClaim).toMatchObject({ claimed: true });
    expect(await ledger.claim({
      deliveryId: DELIVERY_ID,
      claimId: 'probe-claim-loser',
      now: '2026-08-17T00:00:00.001Z',
      leaseMs: 60_000
    })).toMatchObject({ claimed: false, reason: 'lease_held' });
    await ledger.releaseClaim({
      deliveryId: DELIVERY_ID,
      claimId: 'probe-claim-owner',
      now: '2026-08-17T00:00:00.002Z'
    });
    const worker = createOutboundEmailDeliveryWorker({
      ledger,
      provider: fake.delivery,
      envelopes: { resolve: async () => envelope },
      ids: {
        newAttemptId: () => nextId('attempt'),
        newClaimId: () => nextId('claim')
      },
      clock: {
        now: () => new Date(STARTED_AT + sequence).toISOString()
      }
    });

    const result = await worker.dispatch({ deliveryId: DELIVERY_ID });

    expect(result).toMatchObject({ state: 'accepted', followUp: 'complete' });
    expect(await ledger.read(DELIVERY_ID)).toMatchObject({
      state: 'accepted',
      attemptCount: 1,
      leaseClaimId: null
    });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    const counts = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM communication_outbound_delivery_attempts) AS attempts,
      (SELECT count(*) FROM communication_outbound_delivery_facts) AS facts,
      (SELECT count(*) FROM communication_outbound_delivery_outbox) AS outbox,
      (SELECT count(*) FROM communication_outbound_delivery_history) AS history,
      (SELECT count(*) FROM d1_operation_batch_guards) AS guards
    `).first<{ attempts: number; facts: number; outbox: number; history: number; guards: number }>();
    expect(counts).toEqual({ attempts: 1, facts: 2, outbox: 2, history: 2, guards: 0 });
  });
});
