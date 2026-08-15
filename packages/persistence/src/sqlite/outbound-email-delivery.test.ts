import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_PROVIDER_SCENARIO_KEYS,
  FAKE_SAFE_EVIDENCE_CATALOG,
  MARKED_RESEND_BODY_NOTE,
  OUTBOUND_EMAIL_DELIVERY_LEASE_MS,
  isOutboundEmailDispatchSkipped,
  computeReviewedEmailEnvelopeDigestSha256,
  createDeterministicFakeEmailProvider,
  createFakeEmailEnvelope,
  createOutboundEmailDeliveryWorker,
  createSafeEvidence,
  deriveMarkedResendEmailEnvelope,
  type EmailDeliveryAdapter,
  type ImmutableEmailEnvelope
} from '@jooevents/communications';
import {
  providerSubmissionOutcomeSchema,
  type OutboundEmailDeliveryWorkInput,
  type ProviderCapabilities
} from '@jooevents/contracts';
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
  #milliseconds: number;
  constructor(startAt = '2026-08-13T00:00:00.000Z') {
    this.#milliseconds = Date.parse(startAt);
  }
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
      ids: { newAttemptId: () => nextId('attempt'), newClaimId: () => nextId('claim') },
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

  test('a lost accepted result survives restart as acceptance unknown and recovery never resubmits', async () => {
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
    // The dead process left a lease behind. Recovery is not immediate and must
    // not be: until that lease lapses, "a worker is on it" is still the honest
    // reading of the row. The restart resumes past expiry.
    const resumed = worker({
      sqlite: reopened,
      provider: fake.delivery,
      envelope,
      clock: new TestClock('2026-08-13T00:02:00.000Z')
    });
    const result = await resumed.worker.dispatch({ deliveryId: message.deliveryId });
    expect(result).toEqual({
      contractVersion: 1,
      deliveryId: message.deliveryId,
      attemptId: expect.any(String),
      state: 'acceptance_unknown',
      // The fake provider carries lookup reconciliation, so the honest next
      // action for a lost result is reconciliation, never a blind resubmit.
      followUp: 'reconcile'
    });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    expect(resumed.ledger.listAttempts(message.deliveryId)[0]).toMatchObject({
      attemptKind: 'original',
      state: 'acceptance_unknown',
      recoveryCode: 'worker_result_lost',
      safeEvidence: null
    });
    expect(resumed.ledger.read(message.deliveryId)).toMatchObject({
      state: 'acceptance_unknown',
      unknownAttemptCount: 1,
      markedResendExhausted: false
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

  test('acceptance unknown with Cloudflare-v1-like no-recovery capabilities earns exactly one marked resend before quarantine', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const reviewedDigest = computeReviewedEmailEnvelopeDigestSha256(envelope);
    const resendEnvelope = deriveMarkedResendEmailEnvelope(envelope);
    const resendDigest = computeReviewedEmailEnvelopeDigestSha256(resendEnvelope);
    const message = work(FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutAfterAcceptance, reviewedDigest);
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const submittedEnvelopes: ImmutableEmailEnvelope[] = [];
    const noRecoveryProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities: {
        idempotency: 'none',
        reconciliation: 'none',
        callbacks: [],
        inboundReplies: false
      },
      prepare: (value) => {
        submittedEnvelopes.push(value.envelope);
        return fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>;
      },
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
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'marked_resend' });
    expect(testWorker.ledger.read(message.deliveryId)).toMatchObject({
      state: 'acceptance_unknown',
      unknownAttemptCount: 1,
      markedResendExhausted: false,
      reviewedEnvelopeDigestSha256: reviewedDigest
    });

    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'manual_resolution_required' });
    expect(submittedEnvelopes).toHaveLength(2);
    expect(submittedEnvelopes[1]!.subject).toBe('[Resend] Reviewed subject');
    expect(submittedEnvelopes[1]!.textBody.split('\n')[0]).toBe(MARKED_RESEND_BODY_NOTE);
    expect(submittedEnvelopes[1]!.textBody.endsWith('\n\nReviewed body')).toBe(true);
    expect(fake.capturedOrdinaryRequests()).toHaveLength(2);
    expect(fake.capturedOrdinaryRequests()[1]).toMatchObject({
      reviewedEnvelopeDigestSha256: resendDigest
    });
    const attempts = testWorker.ledger.listAttempts(message.deliveryId);
    expect(attempts[0]).toMatchObject({
      attemptKind: 'original',
      state: 'acceptance_unknown',
      reviewedEnvelopeDigestSha256: reviewedDigest,
      safeEvidence: { registeredCode: 'delivery.acceptance_unknown' },
      capabilities: { idempotency: 'none', reconciliation: 'none' }
    });
    expect(attempts[1]).toMatchObject({
      attemptKind: 'marked_resend',
      state: 'acceptance_unknown',
      reviewedEnvelopeDigestSha256: resendDigest
    });
    expect(testWorker.ledger.read(message.deliveryId)).toMatchObject({
      state: 'acceptance_unknown',
      unknownAttemptCount: 2,
      markedResendExhausted: true,
      // The reviewed original stays pinned; the resend digest lives on its attempt.
      reviewedEnvelopeDigestSha256: reviewedDigest
    });

    await expect(testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .rejects.toMatchObject({ code: 'delivery_not_dispatchable' });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(2);
    // Governed rows carry digests and refs only — never the resend marking bytes.
    const governed = sqlite.query<{ readonly all_text: string }, []>(`
      SELECT group_concat(text_value, '|') AS all_text FROM (
        SELECT payload_json AS text_value FROM communication_outbound_delivery_facts
        UNION ALL SELECT safe_evidence_json FROM communication_outbound_delivery_attempts
      )
    `).get()?.all_text ?? '';
    expect(governed).not.toContain('[Resend]');
    expect(governed).not.toContain('could not confirm');
    sqlite.close();
  });

  test('a marked resend that lands accepted completes the delivery honestly', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const acceptedOutcome = providerSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'accepted',
      providerMessageId: 'fake_msg_resend_accepted',
      evidence: createSafeEvidence(FAKE_SAFE_EVIDENCE_CATALOG, {
        code: 'delivery.accepted',
        correlationId: 'corr1_resendaccepted'
      })
    });
    let submissions = 0;
    const secondAttemptAcceptsProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities: {
        idempotency: 'none',
        reconciliation: 'none',
        callbacks: [],
        inboundReplies: false
      },
      prepare: (value) => fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>,
      async submit(prepared) {
        submissions += 1;
        if (submissions === 1) {
          return fake.delivery.submit(prepared as ReturnType<typeof fake.delivery.prepare>);
        }
        return acceptedOutcome;
      }
    };
    const testWorker = worker({
      sqlite,
      provider: secondAttemptAcceptsProvider,
      envelope,
      clock: new TestClock()
    });

    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'marked_resend' });
    // Until acceptance evidence lands, the head never reads as accepted.
    expect(testWorker.ledger.read(message.deliveryId)?.state).toBe('acceptance_unknown');

    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'accepted', followUp: 'complete' });
    expect(testWorker.ledger.read(message.deliveryId)).toMatchObject({
      state: 'accepted',
      unknownAttemptCount: 1,
      markedResendExhausted: false
    });
    expect(testWorker.ledger.listAttempts(message.deliveryId)[1]).toMatchObject({
      attemptKind: 'marked_resend',
      state: 'accepted',
      providerMessageId: 'fake_msg_resend_accepted'
    });

    // Accepted is terminal: no further attempt of any kind may start.
    await expect(testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .rejects.toMatchObject({ code: 'delivery_not_dispatchable' });
    expect(submissions).toBe(2);
    sqlite.close();
  });

  test('a crash during the marked resend consumes the single retry on recovery', async () => {
    const fixture = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance,
      computeReviewedEmailEnvelopeDigestSha256(envelope)
    );
    register(fixture.sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const capabilities: ProviderCapabilities = {
      idempotency: 'none',
      reconciliation: 'none',
      callbacks: [],
      inboundReplies: false
    };
    const noRecoveryProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities,
      prepare: (value) => fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>,
      submit: (prepared) => fake.delivery.submit(
        prepared as ReturnType<typeof fake.delivery.prepare>
      )
    };
    const first = worker({
      sqlite: fixture.sqlite,
      provider: noRecoveryProvider,
      envelope,
      clock: new TestClock()
    });
    expect(await first.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'marked_resend' });
    await expect(first.worker.dispatch({
      deliveryId: message.deliveryId,
      afterProviderResult: () => { throw new Error('simulated process loss'); }
    })).rejects.toThrow('simulated process loss');
    expect(first.ledger.read(message.deliveryId)?.state).toBe('request_started');
    expect(fake.capturedOrdinaryRequests()).toHaveLength(2);
    fixture.sqlite.close();

    const reopened = new Database(fixture.path);
    const resumed = worker({
      sqlite: reopened,
      provider: noRecoveryProvider,
      envelope,
      // A restarted process resumes after the lost attempt's lease has lapsed.
      clock: new TestClock('2026-08-13T00:02:00.000Z')
    });
    expect(await resumed.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'manual_resolution_required' });
    expect(resumed.ledger.read(message.deliveryId)).toMatchObject({
      state: 'acceptance_unknown',
      unknownAttemptCount: 2,
      markedResendExhausted: true
    });
    expect(resumed.ledger.listAttempts(message.deliveryId)[1]).toMatchObject({
      attemptKind: 'marked_resend',
      state: 'acceptance_unknown',
      recoveryCode: 'worker_result_lost'
    });
    // Replay after recovery never schedules a second resend.
    await expect(resumed.worker.dispatch({ deliveryId: message.deliveryId }))
      .rejects.toMatchObject({ code: 'delivery_not_dispatchable' });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(2);
    reopened.close();
  });

  test('a failed release integrity check never consumes the marked resend', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const message = work(
      FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance,
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
    const honest = worker({ sqlite, provider: noRecoveryProvider, envelope, clock: new TestClock() });
    expect(await honest.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'marked_resend' });

    const tampered = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Tampered subject',
      textBody: 'Reviewed body'
    });
    const tamperedWorker = createOutboundEmailDeliveryWorker({
      ledger: honest.ledger,
      provider: noRecoveryProvider,
      envelopes: { resolve: () => tampered },
      ids: { newAttemptId: () => nextId('attempt'), newClaimId: () => nextId('claim') },
      clock: new TestClock()
    });
    // The reviewed original is revalidated before any resend derivation.
    await expect(tamperedWorker.dispatch({ deliveryId: message.deliveryId }))
      .rejects.toMatchObject({ code: 'reviewed_envelope_changed' });
    expect(honest.ledger.listAttempts(message.deliveryId)).toHaveLength(1);
    expect(honest.ledger.read(message.deliveryId)).toMatchObject({
      state: 'acceptance_unknown',
      markedResendExhausted: false
    });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    sqlite.close();
  });

  test('a natively idempotent provider retries unmarked after acceptance unknown', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const reviewedDigest = computeReviewedEmailEnvelopeDigestSha256(envelope);
    const message = work(FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance, reviewedDigest);
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const submittedEnvelopes: ImmutableEmailEnvelope[] = [];
    const nativeKeyProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities: {
        idempotency: 'native_key',
        reconciliation: 'none',
        callbacks: [],
        inboundReplies: false
      },
      prepare: (value) => {
        submittedEnvelopes.push(value.envelope);
        return fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>;
      },
      submit: (prepared) => fake.delivery.submit(
        prepared as ReturnType<typeof fake.delivery.prepare>
      )
    };
    const testWorker = worker({ sqlite, provider: nativeKeyProvider, envelope, clock: new TestClock() });
    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'safe_retry' });
    expect(await testWorker.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'safe_retry' });
    // The provider deduplicates on the external delivery key, so the retry is
    // not a visible second delivery and must not carry the resend marking.
    expect(submittedEnvelopes[1]!.subject).toBe('Reviewed subject');
    expect(testWorker.ledger.listAttempts(message.deliveryId)[1]).toMatchObject({
      attemptKind: 'original',
      reviewedEnvelopeDigestSha256: reviewedDigest
    });
    sqlite.close();
  });

  test('the ledger refuses dishonest attempt kinds and unmarked resend digests', async () => {
    const { sqlite } = databaseFile();
    const envelope = createFakeEmailEnvelope({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Reviewed subject',
      textBody: 'Reviewed body'
    });
    const reviewedDigest = computeReviewedEmailEnvelopeDigestSha256(envelope);
    const message = work(FAKE_PROVIDER_SCENARIO_KEYS.ordinary.timeoutBeforeAcceptance, reviewedDigest);
    register(sqlite, message);
    const fake = createDeterministicFakeEmailProvider();
    const capabilities: ProviderCapabilities = {
      idempotency: 'none',
      reconciliation: 'none',
      callbacks: [],
      inboundReplies: false
    };
    const noRecoveryProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities,
      prepare: (value) => fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>,
      submit: (prepared) => fake.delivery.submit(
        prepared as ReturnType<typeof fake.delivery.prepare>
      )
    };
    const testWorker = worker({ sqlite, provider: noRecoveryProvider, envelope, clock: new TestClock() });
    await testWorker.worker.dispatch({ deliveryId: message.deliveryId });
    const head = testWorker.ledger.read(message.deliveryId)!;
    expect(head).toMatchObject({ state: 'acceptance_unknown', unknownAttemptCount: 1 });
    // An attempt may only start under a held claim, so the honesty checks below
    // are reached with the lease this test's writer actually owns.
    const claim = testWorker.ledger.claim({
      deliveryId: message.deliveryId,
      claimId: nextId('claim'),
      now: '2026-08-13T01:00:00.000Z',
      leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS
    });
    if (!claim.claimed) throw new Error('the settled delivery should have been claimable');
    const attemptBase = {
      deliveryId: message.deliveryId,
      expectedDeliveryVersion: head.version,
      claimId: claim.claimId,
      leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS,
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities,
      providerRequestDigestSha256: digest('4'),
      startedAt: '2026-08-13T01:00:00.000Z'
    };
    // Once ambiguity exists, an unmarked attempt through this provider is refused.
    expect(() => testWorker.ledger.recordAttemptStarted({
      ...attemptBase,
      attemptId: nextId('attempt'),
      attemptKind: 'original'
    })).toThrow('outbound_delivery_attempt_kind_conflict');
    // A "marked" resend whose digest equals the reviewed original carries no marking.
    expect(() => testWorker.ledger.recordAttemptStarted({
      ...attemptBase,
      attemptId: nextId('attempt'),
      attemptKind: 'marked_resend',
      resendEnvelopeDigestSha256: reviewedDigest
    })).toThrow('outbound_delivery_resend_envelope_unmarked');
    // A marked resend must pin the derived envelope digest.
    expect(() => testWorker.ledger.recordAttemptStarted({
      ...attemptBase,
      attemptId: nextId('attempt'),
      attemptKind: 'marked_resend'
    })).toThrow();
    expect(testWorker.ledger.listAttempts(message.deliveryId)).toHaveLength(1);

    // An original attempt never carries a resend digest.
    const pristine = work(FAKE_PROVIDER_SCENARIO_KEYS.ordinary.acceptedWithId, reviewedDigest);
    register(sqlite, pristine);
    expect(() => testWorker.ledger.recordAttemptStarted({
      ...attemptBase,
      deliveryId: pristine.deliveryId,
      expectedDeliveryVersion: 1,
      attemptId: nextId('attempt'),
      attemptKind: 'original',
      resendEnvelopeDigestSha256: computeReviewedEmailEnvelopeDigestSha256(
        deriveMarkedResendEmailEnvelope(envelope)
      )
    })).toThrow('outbound_delivery_resend_digest_unexpected');

    // Ambiguity evidence is monotonic and attempt kinds are immutable at the schema.
    expect(() => sqlite.query(`
      UPDATE communication_outbound_delivery_heads SET unknown_attempt_count = 0
       WHERE delivery_id = ?
    `).run(message.deliveryId)).toThrow('outbound delivery acceptance ambiguity evidence is monotonic');
    expect(() => sqlite.query(`
      UPDATE communication_outbound_delivery_attempts SET attempt_kind = 'marked_resend'
       WHERE delivery_id = ?
    `).run(message.deliveryId)).toThrow('outbound delivery attempt evidence is immutable');
    sqlite.close();
  });

  test('two workers racing one delivery: exactly one claims and the loser is a typed skip', async () => {
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
    const ledger = new SQLiteOutboundEmailDeliveryLedger(sqlite, {
      newFactId: () => nextId('fact'),
      newPointerId: () => nextId('pointer'),
      newHistoryId: () => nextId('history')
    });
    // The first worker parks between claiming and submitting — the window a
    // second worker used to walk straight into.
    let releaseFirst: (() => void) | undefined;
    const first = createOutboundEmailDeliveryWorker({
      ledger,
      provider: fake.delivery,
      envelopes: {
        resolve: async () => {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return envelope;
        }
      },
      ids: { newAttemptId: () => nextId('attempt'), newClaimId: () => nextId('claim') },
      clock: new TestClock()
    });
    const second = createOutboundEmailDeliveryWorker({
      ledger,
      provider: fake.delivery,
      envelopes: { resolve: () => envelope },
      ids: { newAttemptId: () => nextId('attempt'), newClaimId: () => nextId('claim') },
      clock: new TestClock()
    });

    const firstRun = first.dispatch({ deliveryId: message.deliveryId });
    const loser = await second.dispatch({ deliveryId: message.deliveryId });
    // Losing is a value, not a throw, and not a delivery failure.
    expect(loser).toEqual({
      contractVersion: 1,
      skipped: 'lease_held',
      deliveryId: message.deliveryId
    });
    expect(isOutboundEmailDispatchSkipped(loser)).toBe(true);
    expect(fake.capturedOrdinaryRequests()).toHaveLength(0);

    releaseFirst!();
    const winner = await firstRun;
    expect(winner).toMatchObject({ state: 'accepted', followUp: 'complete' });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    expect(ledger.listAttempts(message.deliveryId)).toHaveLength(1);
    // The winner released the lease when it settled the delivery.
    expect(ledger.read(message.deliveryId)).toMatchObject({
      state: 'accepted',
      leaseClaimId: null,
      leaseExpiresAt: null
    });
    sqlite.close();
  });

  test('a late writer whose lease was taken neither overwrites the delivery nor discards its answer', async () => {
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
    const testWorker = worker({ sqlite, provider: fake.delivery, envelope, clock: new TestClock() });
    const successorClaimId = nextId('claim');
    const result = await testWorker.worker.dispatch({
      deliveryId: message.deliveryId,
      // Between the provider answering and this worker persisting, its lease
      // lapses and another worker takes the delivery.
      afterProviderResult: () => {
        const taken = testWorker.ledger.claim({
          deliveryId: message.deliveryId,
          claimId: successorClaimId,
          now: '2026-08-13T00:02:00.000Z',
          leaseMs: OUTBOUND_EMAIL_DELIVERY_LEASE_MS
        });
        expect(taken.claimed).toBe(true);
      }
    });

    // The provider really accepted, but this writer no longer owns the delivery,
    // so it may not settle it — and the ledger never reports certainty it lost
    // the right to record.
    expect(result).toMatchObject({ state: 'acceptance_unknown' });
    const fencedHead = testWorker.ledger.read(message.deliveryId)!;
    expect(fencedHead.state).toBe('request_started');
    expect(fencedHead.leaseClaimId).toBe(successorClaimId);
    expect(fencedHead.attemptCount).toBe(1);
    const attempt = testWorker.ledger.listAttempts(message.deliveryId)[0]!;
    expect(attempt.state).toBe('request_started');
    expect(attempt.providerMessageId).toBeNull();

    // The real provider answer is not discarded: it is kept as append-only
    // acceptance-unknown evidence under the existing vocabulary.
    const fenced = sqlite.query<{
      readonly fact_kind: string;
      readonly payload_json: string;
    }, []>(`
      SELECT fact_kind, payload_json FROM communication_outbound_delivery_facts
       WHERE fact_kind = 'outbound_email_attempt_acceptance_unknown'
    `).get()!;
    const payload = JSON.parse(fenced.payload_json) as {
      readonly kind: string;
      readonly observedState: string;
      readonly providerMessageId: string | null;
    };
    expect(payload.kind).toBe('fenced_attempt_observation');
    expect(payload.observedState).toBe('accepted');
    expect(typeof payload.providerMessageId).toBe('string');
    expect(sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count FROM communication_outbound_delivery_history
       WHERE summary_code = 'communication.outbound-email.acceptance-unknown'
    `).get()?.count).toBe(1);

    // The delivery's new owner settles it, from acceptance-unknown outward.
    const settled = testWorker.ledger.recordBoundaryAmbiguity({
      deliveryId: message.deliveryId,
      attemptId: attempt.attemptId,
      claimId: successorClaimId,
      code: 'worker_result_lost',
      completedAt: '2026-08-13T00:02:01.000Z'
    });
    expect(settled.fenced).toBe(false);
    expect(settled.head).toMatchObject({
      state: 'acceptance_unknown',
      unknownAttemptCount: 1,
      leaseClaimId: null
    });
    expect(fake.capturedOrdinaryRequests()).toHaveLength(1);
    sqlite.close();
  });

  test('a reclaimed lease resumes the marked-resend path rather than a fresh original', async () => {
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
    const submitted: ImmutableEmailEnvelope[] = [];
    // Cloudflare-v1-like: no idempotency key honoured, no reconciliation.
    const noRecoveryProvider: EmailDeliveryAdapter = {
      adapterKey: fake.delivery.adapterKey,
      adapterVersion: fake.delivery.adapterVersion,
      capabilities: {
        idempotency: 'none',
        reconciliation: 'none',
        callbacks: [],
        inboundReplies: false
      },
      prepare: (value) => {
        submitted.push(value.envelope);
        return fake.delivery.prepare(value) as ReturnType<EmailDeliveryAdapter['prepare']>;
      },
      submit: (prepared) => fake.delivery.submit(
        prepared as ReturnType<typeof fake.delivery.prepare>
      )
    };
    const crashed = worker({
      sqlite: fixture.sqlite,
      provider: noRecoveryProvider,
      envelope,
      clock: new TestClock()
    });
    await expect(crashed.worker.dispatch({
      deliveryId: message.deliveryId,
      afterProviderResult: () => { throw new Error('simulated process loss'); }
    })).rejects.toThrow('simulated process loss');
    expect(crashed.ledger.read(message.deliveryId)?.state).toBe('request_started');
    expect(submitted).toHaveLength(1);

    // A sweep arriving inside the lease may not touch the attempt at all.
    const early = worker({
      sqlite: fixture.sqlite,
      provider: noRecoveryProvider,
      envelope,
      clock: new TestClock('2026-08-13T00:00:30.000Z')
    });
    expect(await early.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ skipped: 'lease_held' });
    expect(submitted).toHaveLength(1);

    // Past expiry it is recoverable — and recovery itself never resends.
    const reclaimed = worker({
      sqlite: fixture.sqlite,
      provider: noRecoveryProvider,
      envelope,
      clock: new TestClock('2026-08-13T00:02:00.000Z')
    });
    expect(await reclaimed.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'acceptance_unknown', followUp: 'marked_resend' });
    expect(submitted).toHaveLength(1);

    // The send that follows is the single marked resend, not a fresh original,
    // so a lease expiry can never become a silent double delivery.
    expect(await reclaimed.worker.dispatch({ deliveryId: message.deliveryId }))
      .toMatchObject({ state: 'accepted', followUp: 'complete' });
    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.subject).toBe('[Resend] Reviewed subject');
    expect(reclaimed.ledger.listAttempts(message.deliveryId)[1])
      .toMatchObject({ attemptKind: 'marked_resend', state: 'accepted' });
    fixture.sqlite.close();
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
