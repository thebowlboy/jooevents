import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_PROVIDER_SCENARIO_KEYS,
  computeReviewedEmailEnvelopeDigestSha256,
  createDeterministicFakeEmailProvider,
  createFakeEmailEnvelope,
  createOutboundEmailDeliveryWorker,
  type EmailDeliveryAdapter
} from '@jooevents/communications';
import type { OutboundEmailDeliveryWorkInput } from '@jooevents/contracts';
import { installSQLiteOutboundEmailDeliverySchema, insertOutboundEmailDeliveryRegistration,
  linkOutboundEmailDeliveryReceipt, SQLiteOutboundEmailDeliveryLedger } from './outbound-email-delivery';

const roots: string[] = [];
afterEach(() => {
  // The OS temp tree is intentionally left for ordinary platform cleanup; database
  // handles are closed in each test and no fixture enters the repository.
  roots.length = 0;
});

const digest = (value: string) => value.repeat(64);
let id = 0;
const nextId = (prefix: string) => `${prefix}-${++id}`;

class TestClock {
  #milliseconds = Date.parse('2026-08-13T00:00:00.000Z');
  now(): string { return new Date(this.#milliseconds++).toISOString(); }
}

function work(
  scenario: string,
  reviewedEnvelopeDigestSha256: string,
  deliveryId = nextId('delivery')
): OutboundEmailDeliveryWorkInput {
  return {
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
    externalDeliveryKey: scenario,
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
}

function databaseFile(): { readonly path: string; readonly sqlite: Database } {
  const root = mkdtempSync(join(tmpdir(), 'jooevents-outbound-email-'));
  roots.push(root);
  const path = join(root, 'delivery.sqlite');
  const sqlite = new Database(path, { create: true });
  installSQLiteOutboundEmailDeliverySchema(sqlite);
  return { path, sqlite };
}

function register(sqlite: Database, message: OutboundEmailDeliveryWorkInput): void {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    insertOutboundEmailDeliveryRegistration({
      sqlite,
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
      eventId: '550e8400-e29b-41d4-a716-446655440001',
      work: message,
      evidence: {
        rootFactId: nextId('fact'),
        rootPointerId: nextId('pointer'),
        historyThreadId: nextId('thread'),
        rootHistoryId: nextId('history')
      },
      createdAt: '2026-08-13T00:00:00.000Z'
    });
    linkOutboundEmailDeliveryReceipt({
      sqlite,
      deliveryId: message.deliveryId,
      receiptId: '018f0f47-7a86-7d36-8a25-9f86589c0001'
    });
    const head = sqlite.query<{
      readonly root_fact_id: string;
      readonly root_outbox_pointer_id: string;
      readonly history_thread_id: string;
      readonly root_history_id: string;
    }, [string]>(`
      SELECT root_fact_id, root_outbox_pointer_id, history_thread_id, root_history_id
        FROM communication_outbound_delivery_heads WHERE delivery_id = ?
    `).get(message.deliveryId)!;
    sqlite.query(`
      INSERT INTO communication_outbound_delivery_facts (
        fact_id, receipt_id, workspace_id, event_id, delivery_id, fact_kind,
        fact_version, payload_json, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'outbound_email_delivery_requested', 1, ?, ?)
    `).run(
      head.root_fact_id,
      '018f0f47-7a86-7d36-8a25-9f86589c0001',
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
      message.deliveryId,
      JSON.stringify({
        reviewedMessageDigestSha256: message.reviewedMessageDigestSha256,
        recipientRefId: message.recipientRefId,
        templateRevisionRefId: message.templateRevisionRefId,
        contentRefId: message.contentRefId
      }),
      Date.parse('2026-08-13T00:00:00.000Z')
    );
    sqlite.query(`
      INSERT INTO communication_outbound_delivery_outbox (
        pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
      ) VALUES (?, ?, ?, ?, 'communication.outbound-email.dispatch', ?)
    `).run(
      head.root_outbox_pointer_id,
      '018f0f47-7a86-7d36-8a25-9f86589c0001',
      head.root_fact_id,
      message.deliveryId,
      Date.parse('2026-08-13T00:00:00.000Z')
    );
    sqlite.query(`
      INSERT INTO communication_outbound_delivery_history (
        history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
        summary_code, occurred_at_ms
      ) VALUES (?, ?, 0, ?, ?, ?, 'communication.outbound-email.requested', ?)
    `).run(
      head.root_history_id,
      head.history_thread_id,
      '018f0f47-7a86-7d36-8a25-9f86589c0001',
      head.root_fact_id,
      message.deliveryId,
      Date.parse('2026-08-13T00:00:00.000Z')
    );
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function rowCount(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()!.count;
}

function worker(input: {
  readonly sqlite: Database;
  readonly provider: EmailDeliveryAdapter;
  readonly envelope: ReturnType<typeof createFakeEmailEnvelope>;
  readonly clock: TestClock;
}) {
  const ledger = new SQLiteOutboundEmailDeliveryLedger(input.sqlite, {
    newFactId: () => nextId('fact'),
    newPointerId: () => nextId('pointer'),
    newHistoryId: () => nextId('history')
  });
  return {
    ledger,
    worker: createOutboundEmailDeliveryWorker({
      ledger,
      provider: input.provider,
      envelopes: { resolve: () => input.envelope },
      ids: { newAttemptId: () => nextId('attempt') },
      clock: input.clock
    })
  };
}

describe('SQLite outbound email delivery ledger', () => {
  test('records intent before provider I/O and persists normalized accepted evidence', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    let observedState: string | undefined;
    const guardedProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities: fake.delivery.capabilities,
      prepare: (value) => fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>,
      async submit(prepared) {
        expect(sqlite.inTransaction).toBe(false);
        observedState = sqlite.query<{ readonly state: string }, [string]>(
          'SELECT state FROM communication_outbound_delivery_heads WHERE delivery_id = ?'
        ).get(message.deliveryId)?.state;
        return fake.delivery.submit(prepared as ReturnType<typeof fake.delivery.prepare>);
      }
    };
    const testWorker = worker({ sqlite, provider: guardedProvider, envelope, clock: new TestClock() });
    const result = await testWorker.worker.dispatch({ deliveryId: message.deliveryId });
    expect(observedState).toBe('request_started');
    expect(result).toMatchObject({ state: 'accepted', followUp: 'complete' });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    expect(testWorker.ledger.read(message.deliveryId)?.state).toBe('accepted');
    expect(testWorker.ledger.listAttempts(message.deliveryId)[0]).toMatchObject({
      state: 'accepted',
      safeEvidence: { registeredCode: 'delivery.accepted' }
    });
    expect(rowCount(sqlite, 'communication_outbound_delivery_facts')).toBe(2);
    expect(rowCount(sqlite, 'communication_outbound_delivery_outbox')).toBe(2);
    expect(rowCount(sqlite, 'communication_outbound_delivery_history')).toBe(2);
    expect(sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count FROM communication_outbound_delivery_history
       WHERE parent_history_id IS NULL
    `).get()?.count).toBe(1);
    sqlite.close();
  });

  test('a lost accepted result survives restart as acceptance unknown and is never resubmitted', async () => {
    const fixture = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(fixture.sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const first = worker({
      sqlite: fixture.sqlite,
      provider: fake.delivery,
      envelope,
      clock: new TestClock()
    });
    await expect(first.worker.dispatch({
      deliveryId: message.deliveryId,
      afterProviderResult: () => { throw new Error('simulated process loss'); }
    })).rejects.toThrow('simulated process loss');
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    expect(first.ledger.read(message.deliveryId)?.state).toBe('request_started');
    fixture.sqlite.close();

    const reopened = new Database(fixture.path);
    const resumed = worker({ sqlite: reopened, provider: fake.delivery, envelope, clock: new TestClock() });
    const result = await resumed.worker.dispatch({ deliveryId: message.deliveryId });
    expect(result).toEqual({
      contractVersion: 1,
      deliveryId: message.deliveryId,
      attemptId: expect.any(String),
      state: 'acceptance_unknown',
      followUp: 'manual_resolution_required'
    });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    expect(resumed.ledger.listAttempts(message.deliveryId)[0]).toMatchObject({
      state: 'acceptance_unknown',
      recoveryCode: 'worker_result_lost',
      safeEvidence: null
    });
    expect(rowCount(reopened, 'communication_outbound_delivery_history')).toBe(2);
    reopened.close();
  });

  test('known-safe rejection alone permits a second attempt', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedSafeRetryable,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const testWorker = worker({ sqlite, provider: fake.delivery, envelope, clock: new TestClock() });
    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'known_rejected_safe_retryable', followUp: 'safe_retry' });
    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'known_rejected_safe_retryable', followUp: 'safe_retry' });
    expect(testWorker.ledger.listAttempts(message.deliveryId)).toHaveLength(2);
    expect(fake.capturedOrdinaryRequests()).toHaveLength(2);
    sqlite.close();
  });

  test('acceptance unknown with Cloudflare-v1-like no-recovery capabilities blocks resubmission', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutAfterAcceptance,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const noRecoveryProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities: {
        idempotency: 'none',
        reconciliation: 'none',
        callbacks: [],
        inboundReplies: false
      },
      prepare: (value) => fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>,
      submit: (prepared) => fake.delivery.submit(
        prepared as ReturnType<typeof fake.delivery.prepare>
      )
    };
    const testWorker = worker({
      sqlite,
      provider: noRecoveryProvider,
      envelope,
      clock: new TestClock()
    });
    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'manual_resolution_required' });
    expect(testWorker.ledger.listAttempts(message.deliveryId)[0]).toMatchObject({
      state: 'acceptance_unknown',
      safeEvidence: { registeredCode: 'delivery.acceptance_unknown' },
      capabilities: { idempotency: 'none', reconciliation: 'none' }
    });
    await expect(testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .rejects.toMatchObject({ code: 'delivery_not_dispatchable' });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    sqlite.close();
  });

  test('stored governed rows never contain the recipient address or body bytes', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'secret-recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'classified body marker'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.rejectedTerminal,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const testWorker = worker({ sqlite, provider: fake.delivery, envelope, clock: new TestClock() });
    await testWorker.worker.dispatch({ deliveryId: message.deliveryId });
    const joined = sqlite.query<{ readonly all_text: string }, []>(`
      SELECT group_concat(text_value, '|') AS all_text FROM (
        SELECT payload_json AS text_value FROM communication_outbound_delivery_facts
        UNION ALL SELECT safe_evidence_json FROM communication_outbound_delivery_attempts
        UNION ALL SELECT recipient_ref_id FROM communication_outbound_delivery_heads
      )
    `).get()?.all_text ?? '';
    expect(joined).not.toContain('secret-recipient@example.test');
    expect(joined).not.toContain('classified body marker');
    sqlite.close();
  });
});
