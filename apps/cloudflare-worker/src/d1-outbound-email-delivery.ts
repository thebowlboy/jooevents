import {
  providerCapabilitiesSchema,
  providerOpaqueIdSchema,
  providerSha256Schema,
  providerStableKeySchema,
  safeEvidenceSchema,
  type ProviderCapabilities,
  type SafeEvidence
} from '@jooevents/contracts';
import {
  requiredOutboundEmailAttemptKind,
  type OutboundEmailAttemptCompletion,
  type OutboundEmailDeliveryAttempt,
  type OutboundEmailDeliveryAttemptKind,
  type OutboundEmailDeliveryClaimOutcome,
  type OutboundEmailDeliveryHead,
  type OutboundEmailDeliveryLedger,
  type ProviderAttemptResolution
} from '@jooevents/communications';
import { canonicalJsonText, parseInstant } from '@jooevents/kernel';
import { runD1BufferedUnitOfWork, type D1BufferedUnitOfWork } from './d1-atomic-batch';

interface DeliveryHeadRow {
  readonly delivery_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly release_id: string;
  readonly dispatch_generation: number;
  readonly reviewed_message_digest_sha256: string;
  readonly reviewed_envelope_digest_sha256: string;
  readonly recipient_ref_id: string;
  readonly template_revision_ref_id: string;
  readonly content_ref_id: string;
  readonly provider_connection_revision_id: string;
  readonly external_delivery_key: string;
  readonly sender_profile_revision_id: string;
  readonly sender_presentation_contract_key: string;
  readonly sender_presentation_contract_version: number;
  readonly sender_presentation_digest_sha256: string;
  readonly channel_address_id: string;
  readonly channel_address_version: number;
  readonly address_lookup_fingerprint_profile: string;
  readonly address_lookup_fingerprint_version: number;
  readonly address_lookup_fingerprint_sha256: string;
  readonly state: OutboundEmailDeliveryHead['state'];
  readonly version: number;
  readonly attempt_count: number;
  readonly unknown_attempt_count: number;
  readonly marked_resend_exhausted: number;
  readonly current_attempt_id: string | null;
  readonly lease_claim_id: string | null;
  readonly lease_expires_at_ms: number | null;
}

interface DeliveryAnchorRow extends DeliveryHeadRow {
  readonly receipt_id: string | null;
  readonly root_fact_id: string;
  readonly history_thread_id: string;
  readonly root_history_id: string;
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly delivery_id: string;
  readonly attempt_number: number;
  readonly attempt_kind: OutboundEmailDeliveryAttempt['attemptKind'];
  readonly state: OutboundEmailDeliveryAttempt['state'];
  readonly adapter_key: string;
  readonly adapter_version: string;
  readonly idempotency_capability: ProviderCapabilities['idempotency'];
  readonly reconciliation_capability: ProviderCapabilities['reconciliation'];
  readonly callback_capabilities_json: string;
  readonly provider_request_digest_sha256: string;
  readonly reviewed_message_digest_sha256: string;
  readonly reviewed_envelope_digest_sha256: string;
  readonly provider_message_id: string | null;
  readonly provider_outcome_reason: string | null;
  readonly safe_evidence_json: string | null;
  readonly recovery_code: OutboundEmailDeliveryAttempt['recoveryCode'];
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
}

const HEAD_COLUMNS = `delivery_id,workspace_id,event_id,release_id,dispatch_generation,
  reviewed_message_digest_sha256,reviewed_envelope_digest_sha256,
  recipient_ref_id,template_revision_ref_id,content_ref_id,
  provider_connection_revision_id,external_delivery_key,sender_profile_revision_id,
  sender_presentation_contract_key,sender_presentation_contract_version,
  sender_presentation_digest_sha256,channel_address_id,channel_address_version,
  address_lookup_fingerprint_profile,address_lookup_fingerprint_version,
  address_lookup_fingerprint_sha256,state,version,attempt_count,unknown_attempt_count,
  marked_resend_exhausted,current_attempt_id,lease_claim_id,lease_expires_at_ms`;

const ATTEMPT_COLUMNS = `attempt_id,delivery_id,attempt_number,attempt_kind,state,
  adapter_key,adapter_version,idempotency_capability,reconciliation_capability,
  callback_capabilities_json,provider_request_digest_sha256,
  reviewed_message_digest_sha256,reviewed_envelope_digest_sha256,
  provider_message_id,provider_outcome_reason,safe_evidence_json,recovery_code,
  started_at_ms,completed_at_ms`;

function instantMs(value: string): number {
  return Date.parse(parseInstant(value));
}

function headFromRow(row: DeliveryHeadRow): OutboundEmailDeliveryHead {
  return Object.freeze({
    contractVersion: 1,
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    deliveryId: row.delivery_id,
    releaseId: row.release_id,
    dispatchGeneration: row.dispatch_generation,
    reviewedMessageDigestSha256: row.reviewed_message_digest_sha256,
    reviewedEnvelopeDigestSha256: row.reviewed_envelope_digest_sha256,
    recipientRefId: row.recipient_ref_id,
    templateRevisionRefId: row.template_revision_ref_id,
    contentRefId: row.content_ref_id,
    providerConnectionRevisionId: row.provider_connection_revision_id,
    externalDeliveryKey: row.external_delivery_key,
    senderProfileRevisionId: row.sender_profile_revision_id,
    senderPresentationContractKey: row.sender_presentation_contract_key,
    senderPresentationContractVersion: row.sender_presentation_contract_version,
    senderPresentationDigestSha256: row.sender_presentation_digest_sha256,
    channelAddressId: row.channel_address_id,
    channelAddressVersion: row.channel_address_version,
    addressLookupFingerprintProfile: row.address_lookup_fingerprint_profile,
    addressLookupFingerprintVersion: row.address_lookup_fingerprint_version,
    addressLookupFingerprintSha256: row.address_lookup_fingerprint_sha256,
    state: row.state,
    version: row.version,
    attemptCount: row.attempt_count,
    unknownAttemptCount: row.unknown_attempt_count,
    markedResendExhausted: row.marked_resend_exhausted === 1,
    currentAttemptId: row.current_attempt_id,
    leaseClaimId: row.lease_claim_id,
    leaseExpiresAt: row.lease_expires_at_ms === null
      ? null
      : new Date(row.lease_expires_at_ms).toISOString()
  });
}

function attemptFromRow(row: AttemptRow): OutboundEmailDeliveryAttempt {
  const storedCapabilities = JSON.parse(row.callback_capabilities_json) as unknown;
  const capabilities = providerCapabilitiesSchema.parse({
    idempotency: row.idempotency_capability,
    reconciliation: row.reconciliation_capability,
    callbacks: Array.isArray(storedCapabilities)
      ? storedCapabilities
      : (storedCapabilities as { readonly callbacks?: unknown }).callbacks,
    attachments: Array.isArray(storedCapabilities)
      ? false
      : (storedCapabilities as { readonly attachments?: unknown }).attachments,
    calendarMime: Array.isArray(storedCapabilities)
      ? false
      : (storedCapabilities as { readonly calendarMime?: unknown }).calendarMime,
    inboundReplies: false
  });
  return Object.freeze({
    contractVersion: 1,
    deliveryId: row.delivery_id,
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    attemptKind: row.attempt_kind,
    state: row.state,
    adapterKey: row.adapter_key,
    adapterVersion: row.adapter_version,
    capabilities,
    providerRequestDigestSha256: row.provider_request_digest_sha256,
    reviewedMessageDigestSha256: row.reviewed_message_digest_sha256,
    reviewedEnvelopeDigestSha256: row.reviewed_envelope_digest_sha256,
    startedAt: new Date(row.started_at_ms).toISOString(),
    completedAt: row.completed_at_ms === null ? null : new Date(row.completed_at_ms).toISOString(),
    providerMessageId: row.provider_message_id,
    providerOutcomeReason: row.provider_outcome_reason,
    safeEvidence: row.safe_evidence_json === null
      ? null
      : safeEvidenceSchema.parse(JSON.parse(row.safe_evidence_json)),
    recoveryCode: row.recovery_code
  });
}

function summaryCode(state: ProviderAttemptResolution['state']): string {
  switch (state) {
    case 'accepted': return 'communication.outbound-email.accepted';
    case 'known_rejected_safe_retryable': return 'communication.outbound-email.rejected-safe-retryable';
    case 'known_rejected_terminal': return 'communication.outbound-email.rejected-terminal';
    case 'acceptance_unknown': return 'communication.outbound-email.acceptance-unknown';
  }
}

export interface D1OutboundEmailDeliveryLedgerIds {
  newFactId(): string;
  newPointerId(): string;
  newHistoryId(): string;
}

/** D1 implementation of the retained short-transaction delivery ledger. */
export class D1OutboundEmailDeliveryLedger implements OutboundEmailDeliveryLedger {
  constructor(
    private readonly database: D1Database,
    private readonly ids: D1OutboundEmailDeliveryLedgerIds
  ) {}

  async read(deliveryId: string): Promise<OutboundEmailDeliveryHead | undefined> {
    const id = providerOpaqueIdSchema.parse(deliveryId);
    const row = await this.database.withSession('first-primary').prepare(
      `SELECT ${HEAD_COLUMNS} FROM communication_outbound_delivery_heads WHERE delivery_id = ?`
    ).bind(id).first<DeliveryHeadRow>();
    return row ? headFromRow(row) : undefined;
  }

  async claim(input: {
    readonly deliveryId: string;
    readonly claimId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): Promise<OutboundEmailDeliveryClaimOutcome> {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new TypeError('outbound_delivery_lease_duration_invalid');
    }
    const nowMs = instantMs(input.now);
    const expiresAtMs = nowMs + input.leaseMs;
    return runD1BufferedUnitOfWork({
      database: this.database,
      work: async (unitOfWork) => {
        const row = await unitOfWork.readSession.prepare(
          `SELECT ${HEAD_COLUMNS} FROM communication_outbound_delivery_heads WHERE delivery_id = ?`
        ).bind(deliveryId).first<DeliveryHeadRow>();
        if (!row) return Object.freeze({ contractVersion: 1, claimed: false, reason: 'not_found' });
        const head = headFromRow(row);
        if (row.lease_expires_at_ms !== null && row.lease_expires_at_ms > nowMs) {
          return Object.freeze({ contractVersion: 1, claimed: false, reason: 'lease_held', head });
        }
        const claimable = row.state === 'pending' || row.state === 'request_started'
          || row.state === 'known_rejected_safe_retryable'
          || (row.state === 'acceptance_unknown' && row.marked_resend_exhausted === 0);
        if (!claimable) {
          return Object.freeze({ contractVersion: 1, claimed: false, reason: 'not_claimable', head });
        }
        unitOfWork.assertCurrent(`EXISTS (
          SELECT 1 FROM communication_outbound_delivery_heads
           WHERE delivery_id = ? AND version = ?
             AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
             AND (state IN ('pending','request_started','known_rejected_safe_retryable')
               OR (state = 'acceptance_unknown' AND marked_resend_exhausted = 0))
        )`, [deliveryId, row.version, nowMs]);
        unitOfWork.write(`UPDATE communication_outbound_delivery_heads
          SET lease_claim_id = ?,lease_acquired_at_ms = ?,lease_expires_at_ms = ?,
              updated_at_ms = max(updated_at_ms, ?)
          WHERE delivery_id = ?`, [claimId, nowMs, expiresAtMs, nowMs, deliveryId]);
        return Object.freeze({
          contractVersion: 1,
          claimed: true,
          claimId,
          head: Object.freeze({
            ...head,
            leaseClaimId: claimId,
            leaseExpiresAt: new Date(expiresAtMs).toISOString()
          })
        });
      }
    });
  }

  async releaseClaim(input: {
    readonly deliveryId: string;
    readonly claimId: string;
    readonly now: string;
  }): Promise<void> {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    const nowMs = instantMs(input.now);
    await runD1BufferedUnitOfWork({
      database: this.database,
      work: async (unitOfWork) => {
        const row = await unitOfWork.readSession.prepare(
          'SELECT state,lease_claim_id FROM communication_outbound_delivery_heads WHERE delivery_id = ?'
        ).bind(deliveryId).first<{ state: string; lease_claim_id: string | null }>();
        if (!row || row.lease_claim_id !== claimId || row.state === 'request_started') return;
        unitOfWork.assertCurrent(`EXISTS (
          SELECT 1 FROM communication_outbound_delivery_heads
           WHERE delivery_id = ? AND lease_claim_id = ? AND state <> 'request_started'
        )`, [deliveryId, claimId]);
        unitOfWork.write(`UPDATE communication_outbound_delivery_heads
          SET lease_claim_id = NULL,lease_acquired_at_ms = NULL,lease_expires_at_ms = NULL,
              updated_at_ms = max(updated_at_ms, ?)
          WHERE delivery_id = ? AND lease_claim_id = ? AND state <> 'request_started'`,
        [nowMs, deliveryId, claimId]);
      }
    });
  }

  async recordAttemptStarted(input: {
    readonly deliveryId: string;
    readonly expectedDeliveryVersion: number;
    readonly claimId: string;
    readonly leaseMs: number;
    readonly attemptId: string;
    readonly attemptKind: OutboundEmailDeliveryAttemptKind;
    readonly resendEnvelopeDigestSha256?: string;
    readonly adapterKey: string;
    readonly adapterVersion: string;
    readonly capabilities: ProviderCapabilities;
    readonly providerRequestDigestSha256: string;
    readonly startedAt: string;
  }): Promise<OutboundEmailDeliveryAttempt> {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const attemptId = providerOpaqueIdSchema.parse(input.attemptId);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new TypeError('outbound_delivery_lease_duration_invalid');
    }
    const capabilities = providerCapabilitiesSchema.parse(input.capabilities);
    const adapterKey = providerStableKeySchema.parse(input.adapterKey);
    const adapterVersion = providerStableKeySchema.parse(input.adapterVersion);
    const requestDigest = providerSha256Schema.parse(input.providerRequestDigestSha256);
    const resendDigest = input.attemptKind === 'marked_resend'
      ? providerSha256Schema.parse(input.resendEnvelopeDigestSha256)
      : undefined;
    if (input.attemptKind !== 'original' && input.attemptKind !== 'marked_resend') {
      throw new TypeError('outbound_delivery_attempt_kind_invalid');
    }
    if (input.attemptKind === 'original' && input.resendEnvelopeDigestSha256 !== undefined) {
      throw new TypeError('outbound_delivery_resend_digest_unexpected');
    }
    const startedAtMs = instantMs(input.startedAt);
    return runD1BufferedUnitOfWork({
      database: this.database,
      work: async (unitOfWork) => {
        const row = await unitOfWork.readSession.prepare(
          `SELECT ${HEAD_COLUMNS},receipt_id FROM communication_outbound_delivery_heads
            WHERE delivery_id = ?`
        ).bind(deliveryId).first<DeliveryHeadRow & { receipt_id: string | null }>();
        if (!row || row.receipt_id === null) throw new TypeError('outbound_delivery_not_registered');
        if (row.lease_claim_id !== claimId || row.version !== input.expectedDeliveryVersion) {
          throw new TypeError('outbound_delivery_attempt_conflict');
        }
        if (row.state !== 'pending' && row.state !== 'known_rejected_safe_retryable'
            && !(row.state === 'acceptance_unknown' && row.marked_resend_exhausted === 0)) {
          throw new TypeError('outbound_delivery_not_dispatchable');
        }
        if (input.attemptKind !== requiredOutboundEmailAttemptKind(
          { unknownAttemptCount: row.unknown_attempt_count }, capabilities
        )) throw new TypeError('outbound_delivery_attempt_kind_conflict');
        if (resendDigest !== undefined && resendDigest === row.reviewed_envelope_digest_sha256) {
          throw new TypeError('outbound_delivery_resend_envelope_unmarked');
        }
        const attemptNumber = row.attempt_count + 1;
        unitOfWork.assertCurrent(`EXISTS (
          SELECT 1 FROM communication_outbound_delivery_heads
           WHERE delivery_id = ? AND version = ? AND lease_claim_id = ?
             AND (state IN ('pending','known_rejected_safe_retryable')
               OR (state = 'acceptance_unknown' AND marked_resend_exhausted = 0))
        ) AND NOT EXISTS (
          SELECT 1 FROM communication_outbound_delivery_attempts WHERE attempt_id = ?
        )`, [deliveryId, input.expectedDeliveryVersion, claimId, attemptId]);
        unitOfWork.write(`INSERT INTO communication_outbound_delivery_attempts (
          attempt_id,delivery_id,attempt_number,attempt_kind,state,adapter_key,adapter_version,
          idempotency_capability,reconciliation_capability,callback_capabilities_json,
          provider_request_digest_sha256,reviewed_message_digest_sha256,
          reviewed_envelope_digest_sha256,started_at_ms
        ) VALUES (?,?,?,?,'request_started',?,?,?,?,?,?,?,?,?)`, [
          attemptId, deliveryId, attemptNumber, input.attemptKind, adapterKey, adapterVersion,
          capabilities.idempotency, capabilities.reconciliation,
          canonicalJsonText(capabilities.callbacks), requestDigest,
          row.reviewed_message_digest_sha256,
          resendDigest ?? row.reviewed_envelope_digest_sha256, startedAtMs
        ]);
        unitOfWork.write(`UPDATE communication_outbound_delivery_heads
          SET state = 'request_started',current_attempt_id = ?,attempt_count = ?,
              version = version + 1,updated_at_ms = ?,lease_acquired_at_ms = ?,
              lease_expires_at_ms = ?
          WHERE delivery_id = ? AND version = ? AND lease_claim_id = ?`, [
          attemptId, attemptNumber, startedAtMs, startedAtMs, startedAtMs + input.leaseMs,
          deliveryId, input.expectedDeliveryVersion, claimId
        ]);
        return attemptFromRow({
          attempt_id: attemptId,
          delivery_id: deliveryId,
          attempt_number: attemptNumber,
          attempt_kind: input.attemptKind,
          state: 'request_started',
          adapter_key: adapterKey,
          adapter_version: adapterVersion,
          idempotency_capability: capabilities.idempotency,
          reconciliation_capability: capabilities.reconciliation,
          callback_capabilities_json: canonicalJsonText({
            callbacks: capabilities.callbacks,
            attachments: capabilities.attachments,
            calendarMime: capabilities.calendarMime
          }),
          provider_request_digest_sha256: requestDigest,
          reviewed_message_digest_sha256: row.reviewed_message_digest_sha256,
          reviewed_envelope_digest_sha256: resendDigest ?? row.reviewed_envelope_digest_sha256,
          provider_message_id: null,
          provider_outcome_reason: null,
          safe_evidence_json: null,
          recovery_code: null,
          started_at_ms: startedAtMs,
          completed_at_ms: null
        });
      }
    });
  }

  async recordProviderResolution(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly resolution: ProviderAttemptResolution;
    readonly completedAt: string;
  }): Promise<OutboundEmailAttemptCompletion> {
    return this.complete({
      ...input,
      state: input.resolution.state,
      providerMessageId: input.resolution.providerMessageId,
      providerOutcomeReason: input.resolution.providerOutcomeReason,
      safeEvidence: safeEvidenceSchema.parse(input.resolution.safeEvidence),
      recoveryCode: null
    });
  }

  async recordBoundaryAmbiguity(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly code: 'worker_result_lost' | 'provider_boundary_failure';
    readonly completedAt: string;
  }): Promise<OutboundEmailAttemptCompletion> {
    return this.complete({
      ...input,
      state: 'acceptance_unknown',
      providerMessageId: null,
      providerOutcomeReason: null,
      safeEvidence: null,
      recoveryCode: input.code
    });
  }

  private async complete(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly state: ProviderAttemptResolution['state'];
    readonly providerMessageId: string | null;
    readonly providerOutcomeReason: string | null;
    readonly safeEvidence: SafeEvidence | null;
    readonly recoveryCode: OutboundEmailDeliveryAttempt['recoveryCode'];
    readonly completedAt: string;
  }): Promise<OutboundEmailAttemptCompletion> {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const attemptId = providerOpaqueIdSchema.parse(input.attemptId);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    const completedAtMs = instantMs(input.completedAt);
    return runD1BufferedUnitOfWork({
      database: this.database,
      work: async (unitOfWork) => {
        const anchor = await unitOfWork.readSession.prepare(
          `SELECT ${HEAD_COLUMNS},receipt_id,root_fact_id,history_thread_id,root_history_id
             FROM communication_outbound_delivery_heads WHERE delivery_id = ?`
        ).bind(deliveryId).first<DeliveryAnchorRow>();
        const attempt = await unitOfWork.readSession.prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM communication_outbound_delivery_attempts
            WHERE attempt_id = ? AND delivery_id = ?`
        ).bind(attemptId, deliveryId).first<AttemptRow>();
        if (!anchor || anchor.receipt_id === null || !attempt) {
          throw new TypeError('outbound_delivery_attempt_conflict');
        }
        const sequenceRow = await unitOfWork.readSession.prepare(`SELECT
          coalesce(max(sequence), -1) + 1 AS next_sequence
          FROM communication_outbound_delivery_history WHERE thread_id = ?`
        ).bind(anchor.history_thread_id).first<{ next_sequence: number }>();
        if (!sequenceRow) throw new TypeError('outbound_delivery_history_missing');

        const fenced = anchor.lease_claim_id !== claimId;
        if (!fenced && (anchor.state !== 'request_started'
            || anchor.current_attempt_id !== attemptId || attempt.state !== 'request_started')) {
          throw new TypeError('outbound_delivery_attempt_conflict');
        }
        const landedUnknown = input.state === 'acceptance_unknown';
        const exhaustsMarkedResend = landedUnknown && attempt.attempt_kind === 'marked_resend';
        const payload = fenced
          ? {
              contractVersion: 1,
              kind: 'fenced_attempt_observation',
              attemptKind: attempt.attempt_kind,
              observedState: input.state,
              providerMessageId: input.providerMessageId,
              providerOutcomeReason: input.providerOutcomeReason,
              safeEvidence: input.safeEvidence,
              recoveryCode: input.recoveryCode
            }
          : input.safeEvidence === null
            ? {
                contractVersion: 1,
                kind: 'acceptance_unknown',
                attemptKind: attempt.attempt_kind,
                recoveryCode: input.recoveryCode,
                markedResendExhausted: exhaustsMarkedResend
              }
            : {
                contractVersion: 1,
                kind: 'provider_resolution',
                attemptKind: attempt.attempt_kind,
                state: input.state,
                providerMessageId: input.providerMessageId,
                providerOutcomeReason: input.providerOutcomeReason,
                safeEvidence: input.safeEvidence,
                ...(landedUnknown ? { markedResendExhausted: exhaustsMarkedResend } : {})
              };

        if (fenced) {
          unitOfWork.assertCurrent(`EXISTS (
            SELECT 1 FROM communication_outbound_delivery_heads
             WHERE delivery_id = ? AND receipt_id IS NOT NULL
               AND (lease_claim_id IS NULL OR lease_claim_id <> ?)
          )`, [deliveryId, claimId]);
        } else {
          unitOfWork.assertCurrent(`EXISTS (
            SELECT 1 FROM communication_outbound_delivery_heads
             WHERE delivery_id = ? AND state = 'request_started'
               AND current_attempt_id = ? AND lease_claim_id = ?
          ) AND EXISTS (
            SELECT 1 FROM communication_outbound_delivery_attempts
             WHERE attempt_id = ? AND delivery_id = ? AND state = 'request_started'
          )`, [deliveryId, attemptId, claimId, attemptId, deliveryId]);
          unitOfWork.write(`UPDATE communication_outbound_delivery_attempts
            SET state = ?,provider_message_id = ?,provider_outcome_reason = ?,
                safe_evidence_json = ?,recovery_code = ?,completed_at_ms = ?
            WHERE attempt_id = ? AND state = 'request_started'`, [
            input.state, input.providerMessageId, input.providerOutcomeReason,
            input.safeEvidence === null ? null : canonicalJsonText(input.safeEvidence),
            input.recoveryCode, completedAtMs, attemptId
          ]);
          unitOfWork.write(`UPDATE communication_outbound_delivery_heads
            SET state = ?,version = version + 1,updated_at_ms = ?,
                unknown_attempt_count = unknown_attempt_count + ?,
                marked_resend_exhausted = max(marked_resend_exhausted, ?),
                lease_claim_id = NULL,lease_acquired_at_ms = NULL,lease_expires_at_ms = NULL
            WHERE delivery_id = ? AND state = 'request_started'
              AND current_attempt_id = ? AND lease_claim_id = ?`, [
            input.state, completedAtMs, landedUnknown ? 1 : 0,
            exhaustsMarkedResend ? 1 : 0, deliveryId, attemptId, claimId
          ]);
        }
        const factId = providerOpaqueIdSchema.parse(this.ids.newFactId());
        const pointerId = providerOpaqueIdSchema.parse(this.ids.newPointerId());
        const historyId = providerOpaqueIdSchema.parse(this.ids.newHistoryId());
        unitOfWork.assertCurrent(`(
          SELECT coalesce(max(sequence), -1) + 1
            FROM communication_outbound_delivery_history WHERE thread_id = ?
        ) = ?`, [anchor.history_thread_id, sequenceRow.next_sequence]);
        unitOfWork.write(`INSERT INTO communication_outbound_delivery_facts (
          fact_id,receipt_id,workspace_id,event_id,delivery_id,attempt_id,
          fact_kind,fact_version,causation_fact_id,payload_json,occurred_at_ms
        ) VALUES (?,?,?,?,?,?,?,1,?,?,?)`, [
          factId, anchor.receipt_id, anchor.workspace_id, anchor.event_id,
          deliveryId, attemptId,
          fenced || landedUnknown
            ? 'outbound_email_attempt_acceptance_unknown'
            : 'outbound_email_attempt_resolved',
          anchor.root_fact_id, canonicalJsonText(payload), completedAtMs
        ]);
        unitOfWork.write(`INSERT INTO communication_outbound_delivery_outbox (
          pointer_id,receipt_id,fact_id,delivery_id,purpose,created_at_ms
        ) VALUES (?,?,?,?,'communication.outbound-email.attempt-resolved',?)`, [
          pointerId, anchor.receipt_id, factId, deliveryId, completedAtMs
        ]);
        unitOfWork.write(`INSERT INTO communication_outbound_delivery_history (
          history_id,thread_id,sequence,receipt_id,fact_id,delivery_id,
          attempt_id,parent_history_id,summary_code,occurred_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
          historyId, anchor.history_thread_id, sequenceRow.next_sequence,
          anchor.receipt_id, factId, deliveryId, attemptId, anchor.root_history_id,
          fenced ? 'communication.outbound-email.acceptance-unknown' : summaryCode(input.state),
          completedAtMs
        ]);

        const current = headFromRow(anchor);
        const head = fenced ? current : Object.freeze({
          ...current,
          state: input.state,
          version: current.version + 1,
          unknownAttemptCount: current.unknownAttemptCount + (landedUnknown ? 1 : 0),
          markedResendExhausted: current.markedResendExhausted || exhaustsMarkedResend,
          leaseClaimId: null,
          leaseExpiresAt: null
        });
        return Object.freeze({ contractVersion: 1, fenced, head });
      }
    });
  }
}
