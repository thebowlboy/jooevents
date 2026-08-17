import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_PROVIDER_SCENARIO_KEYS,
  OUTBOUND_EMAIL_DELIVERY_LEASE_MS,
  computeReviewedEmailEnvelopeDigestSha256,
  createDeterministicFakeEmailProvider,
  createFakeEmailEnvelope,
  isOutboundEmailDispatchSkipped,
  type ImmutableEmailEnvelope
} from '@jooevents/communications';
import type { OutboundEmailDeliveryWorkInput } from '@jooevents/contracts';
import {
  SQLiteOutboundEmailDeliveryLedger,
  insertOutboundEmailDeliveryRegistration,
  installSQLiteOutboundEmailDeliverySchema,
  linkOutboundEmailDeliveryReceipt
} from '@jooevents/persistence/outbound-email-delivery';
import { createOutboundDispatchLoop } from './outbound-dispatch-loop';

/**
 * The sweep must see exactly the deliveries it is allowed to take. It selects
 * `request_started` on purpose — a delivery stranded by a crash has to become
 * recoverable — but an attempt merely awaiting the provider sits in that same
 * state. Ownership is what separates them, and it lives on the delivery head,
 * so these run against the real schema and the real ledger rather than a stub.
 */

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const EVENT_ID = '550e8400-e29b-41d4-a716-446655440001';
const RECEIPT_ID = '018f0f47-7a86-7d36-8a25-9f86589c0001';
const BASE_MS = Date.parse('2026-08-15T00:00:00.000Z');

const digest = (value: string) => value.repeat(64);

function harness(options: {
  readonly sqlite?: Database;
  readonly installSchema?: boolean;
} = {}) {
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;
  const sqlite = options.sqlite ?? new Database(':memory:');
  if (options.installSchema !== false) installSQLiteOutboundEmailDeliverySchema(sqlite);
  const envelope: ImmutableEmailEnvelope = createFakeEmailEnvelope({
    from: 'sender@example.test',
    to: 'recipient@example.test',
    subject: 'Reviewed subject',
    textBody: 'Reviewed body'
  });
  const reviewedEnvelopeDigestSha256 = computeReviewedEmailEnvelopeDigestSha256(envelope);
  const fake = createDeterministicFakeEmailProvider();
  const ledger = new SQLiteOutboundEmailDeliveryLedger(sqlite, {
    newFactId: () => nextId('fact'),
    newPointerId: () => nextId('pointer'),
    newHistoryId: () => nextId('history')
  });

  let nowMs = BASE_MS;
  /** A resolver that can be parked, so a dispatch can be held mid-flight. */
  let park: (() => void) | undefined;
  let parkedDeliveryId: string | undefined;
  const envelopes = {
    async resolve({ deliveryId }: { readonly deliveryId: string }) {
      if (parkedDeliveryId === deliveryId) {
        await new Promise<void>((resolve) => { park = resolve; });
      }
      return envelope;
    }
  };

  function register(deliveryId: string, createdAtMs: number): void {
    const work: OutboundEmailDeliveryWorkInput = {
      contractVersion: 1,
      deliveryId,
      releaseId: nextId('release'),
      dispatchGeneration: 1,
      reviewedMessageDigestSha256: digest('1'),
      reviewedEnvelopeDigestSha256,
      recipientRefId: nextId('recipient'),
      templateRevisionRefId: nextId('template'),
      contentRefId: nextId('content'),
      providerConnectionRevisionId: nextId('connection'),
      externalDeliveryKey: FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      senderProfileRevisionId: nextId('sender'),
      senderPresentationContractKey: 'sender.presentation',
      senderPresentationContractVersion: 1,
      senderPresentationDigestSha256: digest('2'),
      channelAddressId: nextId('channel'),
      channelAddressVersion: 1,
      addressLookupFingerprintProfile: 'address.fingerprint',
      addressLookupFingerprintVersion: 1,
      addressLookupFingerprintSha256: digest('3')
    };
    sqlite.exec('BEGIN IMMEDIATE;');
    try {
      insertOutboundEmailDeliveryRegistration({
        sqlite,
        workspaceId: WORKSPACE_ID,
        eventId: EVENT_ID,
        work,
        evidence: {
          rootFactId: nextId('fact'),
          rootPointerId: nextId('pointer'),
          historyThreadId: nextId('thread'),
          rootHistoryId: nextId('history')
        },
        createdAt: new Date(createdAtMs).toISOString()
      });
      linkOutboundEmailDeliveryReceipt({ sqlite, deliveryId, receiptId: RECEIPT_ID });
      sqlite.exec('COMMIT;');
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
      throw error;
    }
  }

  const loop = createOutboundDispatchLoop({
    sqlite,
    ledger,
    provider: fake.delivery,
    envelopes,
    ids: { newAttemptId: () => nextId('attempt'), newClaimId: () => nextId('claim') },
    clock: { now: () => new Date(nowMs).toISOString() }
  });

  return {
    sqlite,
    ledger,
    loop,
    fake,
    register,
    nextId,
    advance: (ms: number) => { nowMs += ms; },
    now: () => new Date(nowMs).toISOString(),
    parkDispatchOf: (deliveryId: string) => { parkedDeliveryId = deliveryId; },
    releaseParked: () => {
      parkedDeliveryId = undefined;
      park?.();
    }
  };
}

describe('outbound dispatch loop', () => {
  test('a sweep never dispatches a delivery a kick already holds', async () => {
    const context = harness();
    context.register('delivery-a', BASE_MS);
    context.register('delivery-b', BASE_MS);
    context.parkDispatchOf('delivery-a');

    // The kick claims delivery-a and parks with the claim held.
    const kick = context.loop.dispatchOne('delivery-a');
    expect(context.ledger.read('delivery-a')?.leaseClaimId).not.toBeNull();

    // The sweep lands mid-kick. Before the lease it dispatched delivery-a a
    // second time and both sides lost to an attempt conflict after the provider
    // call had already happened.
    const swept = await context.loop.runOnce();
    expect(swept.map((result) => result.deliveryId)).toEqual(['delivery-b']);
    expect(context.ledger.listAttempts('delivery-a')).toHaveLength(0);

    context.releaseParked();
    const kicked = await kick;
    expect(kicked).toMatchObject({ deliveryId: 'delivery-a', state: 'accepted' });
    expect(context.ledger.listAttempts('delivery-a')).toHaveLength(1);
    expect(context.fake.capturedOrdinaryRequests()).toHaveLength(2);
    context.sqlite.close();
  });

  test('a second kick for the same delivery is a typed skip, not a conflict', async () => {
    const context = harness();
    context.register('delivery-a', BASE_MS);
    context.parkDispatchOf('delivery-a');

    const first = context.loop.dispatchOne('delivery-a');
    const second = await context.loop.dispatchOne('delivery-a');
    expect(second).toEqual({
      contractVersion: 1,
      skipped: 'lease_held',
      deliveryId: 'delivery-a'
    });
    expect(isOutboundEmailDispatchSkipped(second)).toBe(true);

    context.releaseParked();
    expect(await first).toMatchObject({ state: 'accepted' });
    expect(context.fake.capturedOrdinaryRequests()).toHaveLength(1);
    context.sqlite.close();
  });

  test('a sweep skips a live lease and takes the same delivery once it has lapsed', async () => {
    const context = harness();
    context.register('delivery-a', BASE_MS);
    const claim = context.ledger.claim({
      deliveryId: 'delivery-a',
      claimId: 'claim-elsewhere',
      now: context.now(),
      leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS
    });
    expect(claim.claimed).toBe(true);

    context.advance(OUTBOUND_EMAIL_DELIVERY_LEASE_MS - 1);
    expect(await context.loop.runOnce()).toEqual([]);
    expect(context.fake.capturedOrdinaryRequests()).toHaveLength(0);

    context.advance(2);
    const swept = await context.loop.runOnce();
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ deliveryId: 'delivery-a', state: 'accepted' });
    context.sqlite.close();
  });

  test("a crashed worker's in-flight delivery is recovered only after its lease expires", async () => {
    const context = harness();
    context.register('delivery-a', BASE_MS);
    // A worker that claimed, started its attempt, and then died: the row is
    // `request_started` with an owner that will never come back.
    const claim = context.ledger.claim({
      deliveryId: 'delivery-a',
      claimId: 'claim-dead-worker',
      now: context.now(),
      leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS
    });
    if (!claim.claimed) throw new Error('the pending delivery should have been claimable');
    context.ledger.recordAttemptStarted({
      deliveryId: 'delivery-a',
      expectedDeliveryVersion: claim.head.version,
      claimId: claim.claimId,
      leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS,
      attemptId: 'attempt-lost',
      attemptKind: 'original',
      adapterKey: context.fake.delivery.adapterKey,
      adapterVersion: context.fake.delivery.adapterVersion,
      capabilities: context.fake.delivery.capabilities,
      providerRequestDigestSha256: digest('4'),
      startedAt: context.now()
    });

    context.advance(OUTBOUND_EMAIL_DELIVERY_LEASE_MS - 1);
    expect(await context.loop.runOnce()).toEqual([]);
    expect(context.ledger.read('delivery-a')?.state).toBe('request_started');

    context.advance(2);
    const recovered = await context.loop.runOnce();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      deliveryId: 'delivery-a',
      attemptId: 'attempt-lost',
      state: 'acceptance_unknown'
    });
    // Recovery closes the stranded attempt; it never resubmits.
    expect(context.fake.capturedOrdinaryRequests()).toHaveLength(0);
    expect(context.ledger.read('delivery-a')).toMatchObject({
      state: 'acceptance_unknown',
      unknownAttemptCount: 1,
      leaseClaimId: null
    });
    context.sqlite.close();
  });

  test('a pending durable delivery resumes after the SQLite process restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-outbound-restart-'));
    const path = join(directory, 'delivery.sqlite');
    try {
      const before = harness({ sqlite: new Database(path) });
      before.register('delivery-after-restart', BASE_MS);
      before.sqlite.close();

      const after = harness({
        sqlite: new Database(path),
        installSchema: false
      });
      const resumed = await after.loop.runOnce();
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({
        deliveryId: 'delivery-after-restart',
        state: 'accepted'
      });
      expect(after.ledger.listAttempts('delivery-after-restart')).toHaveLength(1);
      after.sqlite.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a delivery is claimable again once its attempt settles', async () => {
    const context = harness();
    context.register('delivery-a', BASE_MS);
    const first = await context.loop.dispatchOne('delivery-a');
    expect(first).toMatchObject({ state: 'accepted' });
    expect(context.ledger.read('delivery-a')?.leaseClaimId).toBeNull();
    // Settled is settled: the sweep has nothing left to see.
    expect(await context.loop.runOnce()).toEqual([]);
    context.sqlite.close();
  });
});
describe('a pass keeps moving', () => {
  test('one delivery that throws does not abandon the deliveries queued behind it', async () => {
    // Letting a fault escape discarded the results already dispatched AND every
    // delivery after it — and since the next pass meets the same row first, a
    // single poisoned delivery could hold up every sign-in link indefinitely.
    const { loop, register, sqlite } = harness();
    register('delivery-poison', 1);
    register('delivery-healthy', 2);
    // Quarantine the first row so its dispatch refuses, without touching the
    // second. It is registered earlier, so the pass meets it first.
    sqlite.query(`UPDATE communication_outbound_delivery_heads
                     SET state = 'acceptance_unknown', unknown_attempt_count = 2,
                         attempt_count = 2, marked_resend_exhausted = 1,
                         current_attempt_id = 'attempt-quarantined'
                   WHERE delivery_id = ?`).run('delivery-poison');

    const results = await loop.runOnce();
    expect(results.map((result) => result.deliveryId)).toEqual(['delivery-healthy']);
  });
});
