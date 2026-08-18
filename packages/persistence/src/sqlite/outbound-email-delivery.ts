import type { Database } from 'bun:sqlite';
import {
  outboundEmailDeliveryWorkInputSchema,
  providerCapabilitiesSchema,
  providerOpaqueIdSchema,
  providerSha256Schema,
  providerStableKeySchema,
  safeEvidenceSchema,
  type OutboundEmailDeliveryWorkInput,
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

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const SQLITE_OUTBOUND_EMAIL_DELIVERY_SQL = `
CREATE TABLE communication_outbound_delivery_heads (
  delivery_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL CHECK(dispatch_generation > 0),
  reviewed_message_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_message_digest_sha256) = 64),
  reviewed_envelope_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_envelope_digest_sha256) = 64),
  recipient_ref_id TEXT NOT NULL,
  template_revision_ref_id TEXT NOT NULL,
  content_ref_id TEXT NOT NULL,
  provider_connection_revision_id TEXT NOT NULL,
  external_delivery_key TEXT NOT NULL,
  sender_profile_revision_id TEXT NOT NULL,
  sender_presentation_contract_key TEXT NOT NULL,
  sender_presentation_contract_version INTEGER NOT NULL CHECK(sender_presentation_contract_version > 0),
  sender_presentation_digest_sha256 TEXT NOT NULL CHECK(length(sender_presentation_digest_sha256) = 64),
  channel_address_id TEXT NOT NULL,
  channel_address_version INTEGER NOT NULL CHECK(channel_address_version > 0),
  address_lookup_fingerprint_profile TEXT NOT NULL,
  address_lookup_fingerprint_version INTEGER NOT NULL CHECK(address_lookup_fingerprint_version > 0),
  address_lookup_fingerprint_sha256 TEXT NOT NULL CHECK(length(address_lookup_fingerprint_sha256) = 64),
  state TEXT NOT NULL CHECK(state IN (
    'pending', 'request_started', 'accepted', 'known_rejected_safe_retryable',
    'known_rejected_terminal', 'acceptance_unknown'
  )),
  version INTEGER NOT NULL CHECK(version > 0),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  unknown_attempt_count INTEGER NOT NULL
    CHECK(unknown_attempt_count >= 0 AND unknown_attempt_count <= attempt_count),
  marked_resend_exhausted INTEGER NOT NULL CHECK(marked_resend_exhausted IN (0, 1)),
  current_attempt_id TEXT,
  -- Durable ownership of a dispatch. \`state = 'request_started'\` says an attempt
  -- exists; only a live lease says a worker is still on it. Without this column
  -- pair a recovery sweep cannot tell a healthy in-flight attempt from one
  -- abandoned by a dead process, and takes both.
  lease_claim_id TEXT,
  lease_acquired_at_ms INTEGER CHECK(lease_acquired_at_ms IS NULL OR lease_acquired_at_ms >= 0),
  lease_expires_at_ms INTEGER CHECK(lease_expires_at_ms IS NULL OR lease_expires_at_ms > lease_acquired_at_ms),
  receipt_id TEXT,
  root_fact_id TEXT NOT NULL,
  root_outbox_pointer_id TEXT NOT NULL,
  history_thread_id TEXT NOT NULL,
  root_history_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  UNIQUE(workspace_id, event_id, release_id, dispatch_generation),
  UNIQUE(root_fact_id),
  UNIQUE(root_outbox_pointer_id),
  UNIQUE(history_thread_id),
  UNIQUE(root_history_id),
  CHECK((state = 'pending' AND attempt_count = 0 AND current_attempt_id IS NULL)
    OR (state <> 'pending' AND attempt_count > 0 AND current_attempt_id IS NOT NULL)),
  CHECK(marked_resend_exhausted = 0 OR unknown_attempt_count >= 2),
  CHECK((lease_claim_id IS NULL AND lease_acquired_at_ms IS NULL AND lease_expires_at_ms IS NULL)
    OR (lease_claim_id IS NOT NULL AND lease_acquired_at_ms IS NOT NULL
        AND lease_expires_at_ms IS NOT NULL)),
  -- An attempt may only be in flight under a claim, so an unowned
  -- \`request_started\` row cannot exist and every recovery is decided by expiry.
  CHECK(state <> 'request_started' OR lease_claim_id IS NOT NULL)
) STRICT;

-- The claimable set the sweep is allowed to see: a state it may take, whose
-- lease is absent or lapsed, oldest first.
CREATE INDEX communication_outbound_delivery_heads_claimable_idx
  ON communication_outbound_delivery_heads(state, lease_expires_at_ms, created_at_ms);

CREATE TRIGGER communication_outbound_delivery_heads_no_delete
BEFORE DELETE ON communication_outbound_delivery_heads
BEGIN
  SELECT RAISE(ABORT, 'outbound delivery heads cannot be deleted');
END;

CREATE TRIGGER communication_outbound_delivery_heads_refs_immutable
BEFORE UPDATE ON communication_outbound_delivery_heads
WHEN NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.release_id IS NOT OLD.release_id
  OR NEW.dispatch_generation IS NOT OLD.dispatch_generation
  OR NEW.reviewed_message_digest_sha256 IS NOT OLD.reviewed_message_digest_sha256
  OR NEW.reviewed_envelope_digest_sha256 IS NOT OLD.reviewed_envelope_digest_sha256
  OR NEW.recipient_ref_id IS NOT OLD.recipient_ref_id
  OR NEW.template_revision_ref_id IS NOT OLD.template_revision_ref_id
  OR NEW.content_ref_id IS NOT OLD.content_ref_id
  OR NEW.provider_connection_revision_id IS NOT OLD.provider_connection_revision_id
  OR NEW.external_delivery_key IS NOT OLD.external_delivery_key
  OR NEW.sender_profile_revision_id IS NOT OLD.sender_profile_revision_id
  OR NEW.sender_presentation_contract_key IS NOT OLD.sender_presentation_contract_key
  OR NEW.sender_presentation_contract_version IS NOT OLD.sender_presentation_contract_version
  OR NEW.sender_presentation_digest_sha256 IS NOT OLD.sender_presentation_digest_sha256
  OR NEW.channel_address_id IS NOT OLD.channel_address_id
  OR NEW.channel_address_version IS NOT OLD.channel_address_version
  OR NEW.address_lookup_fingerprint_profile IS NOT OLD.address_lookup_fingerprint_profile
  OR NEW.address_lookup_fingerprint_version IS NOT OLD.address_lookup_fingerprint_version
  OR NEW.address_lookup_fingerprint_sha256 IS NOT OLD.address_lookup_fingerprint_sha256
  OR NEW.root_fact_id IS NOT OLD.root_fact_id
  OR NEW.root_outbox_pointer_id IS NOT OLD.root_outbox_pointer_id
  OR NEW.history_thread_id IS NOT OLD.history_thread_id
  OR NEW.root_history_id IS NOT OLD.root_history_id
BEGIN
  SELECT RAISE(ABORT, 'outbound delivery governed references are immutable');
END;

CREATE TRIGGER communication_outbound_delivery_heads_ambiguity_monotonic
BEFORE UPDATE ON communication_outbound_delivery_heads
WHEN NEW.unknown_attempt_count < OLD.unknown_attempt_count
  OR NEW.marked_resend_exhausted < OLD.marked_resend_exhausted
BEGIN
  SELECT RAISE(ABORT, 'outbound delivery acceptance ambiguity evidence is monotonic');
END;

CREATE TABLE communication_outbound_delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  attempt_kind TEXT NOT NULL CHECK(attempt_kind IN ('original', 'marked_resend')),
  state TEXT NOT NULL CHECK(state IN (
    'request_started', 'accepted', 'known_rejected_safe_retryable',
    'known_rejected_terminal', 'acceptance_unknown'
  )),
  adapter_key TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  idempotency_capability TEXT NOT NULL CHECK(idempotency_capability IN ('native_key', 'provider_lookup', 'none')),
  reconciliation_capability TEXT NOT NULL CHECK(reconciliation_capability IN ('lookup', 'callback_only', 'none')),
  callback_capabilities_json TEXT NOT NULL CHECK(json_valid(callback_capabilities_json)),
  provider_request_digest_sha256 TEXT NOT NULL CHECK(length(provider_request_digest_sha256) = 64),
  reviewed_message_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_message_digest_sha256) = 64),
  reviewed_envelope_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_envelope_digest_sha256) = 64),
  provider_message_id TEXT,
  provider_outcome_reason TEXT,
  safe_evidence_json TEXT CHECK(safe_evidence_json IS NULL OR json_valid(safe_evidence_json)),
  recovery_code TEXT CHECK(recovery_code IS NULL OR recovery_code IN ('worker_result_lost', 'provider_boundary_failure')),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
  completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  UNIQUE(delivery_id, attempt_number),
  FOREIGN KEY(delivery_id) REFERENCES communication_outbound_delivery_heads(delivery_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK((state = 'request_started' AND completed_at_ms IS NULL
      AND provider_message_id IS NULL AND provider_outcome_reason IS NULL
      AND safe_evidence_json IS NULL AND recovery_code IS NULL)
    OR (state <> 'request_started' AND completed_at_ms IS NOT NULL)),
  CHECK(NOT (safe_evidence_json IS NOT NULL AND recovery_code IS NOT NULL)),
  CHECK(state = 'accepted' OR provider_message_id IS NULL)
) STRICT;

CREATE TRIGGER communication_outbound_delivery_attempts_one_resolution
BEFORE UPDATE ON communication_outbound_delivery_attempts
WHEN OLD.state <> 'request_started'
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.delivery_id IS NOT OLD.delivery_id
  OR NEW.attempt_number IS NOT OLD.attempt_number
  OR NEW.attempt_kind IS NOT OLD.attempt_kind
  OR NEW.adapter_key IS NOT OLD.adapter_key
  OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.idempotency_capability IS NOT OLD.idempotency_capability
  OR NEW.reconciliation_capability IS NOT OLD.reconciliation_capability
  OR NEW.callback_capabilities_json IS NOT OLD.callback_capabilities_json
  OR NEW.provider_request_digest_sha256 IS NOT OLD.provider_request_digest_sha256
  OR NEW.reviewed_message_digest_sha256 IS NOT OLD.reviewed_message_digest_sha256
  OR NEW.reviewed_envelope_digest_sha256 IS NOT OLD.reviewed_envelope_digest_sha256
  OR NEW.started_at_ms IS NOT OLD.started_at_ms
BEGIN
  SELECT RAISE(ABORT, 'outbound delivery attempt evidence is immutable');
END;

CREATE TRIGGER communication_outbound_delivery_attempts_no_delete
BEFORE DELETE ON communication_outbound_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'outbound delivery attempts cannot be deleted');
END;

CREATE TABLE communication_outbound_delivery_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_id TEXT,
  fact_kind TEXT NOT NULL CHECK(fact_kind IN (
    'outbound_email_delivery_requested',
    'outbound_email_attempt_resolved',
    'outbound_email_attempt_acceptance_unknown'
  )),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  causation_fact_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  FOREIGN KEY(delivery_id) REFERENCES communication_outbound_delivery_heads(delivery_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE communication_outbound_delivery_outbox (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN (
    'communication.outbound-email.dispatch',
    'communication.outbound-email.attempt-resolved'
  )),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  FOREIGN KEY(fact_id) REFERENCES communication_outbound_delivery_facts(fact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(delivery_id) REFERENCES communication_outbound_delivery_heads(delivery_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE communication_outbound_delivery_history (
  history_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  receipt_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_id TEXT,
  parent_history_id TEXT,
  summary_code TEXT NOT NULL CHECK(summary_code IN (
    'communication.outbound-email.requested',
    'communication.outbound-email.accepted',
    'communication.outbound-email.rejected-safe-retryable',
    'communication.outbound-email.rejected-terminal',
    'communication.outbound-email.acceptance-unknown'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  UNIQUE(thread_id, sequence),
  FOREIGN KEY(fact_id) REFERENCES communication_outbound_delivery_facts(fact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(delivery_id) REFERENCES communication_outbound_delivery_heads(delivery_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER communication_outbound_delivery_facts_no_update
BEFORE UPDATE ON communication_outbound_delivery_facts BEGIN
  SELECT RAISE(ABORT, 'outbound delivery facts are immutable');
END;
CREATE TRIGGER communication_outbound_delivery_facts_no_delete
BEFORE DELETE ON communication_outbound_delivery_facts BEGIN
  SELECT RAISE(ABORT, 'outbound delivery facts are immutable');
END;
CREATE TRIGGER communication_outbound_delivery_outbox_no_update
BEFORE UPDATE ON communication_outbound_delivery_outbox BEGIN
  SELECT RAISE(ABORT, 'outbound delivery outbox pointers are immutable');
END;
CREATE TRIGGER communication_outbound_delivery_outbox_no_delete
BEFORE DELETE ON communication_outbound_delivery_outbox BEGIN
  SELECT RAISE(ABORT, 'outbound delivery outbox pointers are immutable');
END;
CREATE TRIGGER communication_outbound_delivery_history_no_update
BEFORE UPDATE ON communication_outbound_delivery_history BEGIN
  SELECT RAISE(ABORT, 'outbound delivery history is immutable');
END;
CREATE TRIGGER communication_outbound_delivery_history_no_delete
BEFORE DELETE ON communication_outbound_delivery_history BEGIN
  SELECT RAISE(ABORT, 'outbound delivery history is immutable');
END;
`;

export function installSQLiteOutboundEmailDeliverySchema(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_OUTBOUND_EMAIL_DELIVERY_SQL);
}

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

export interface SQLiteOutboundEmailDeliveryLedgerIds {
  newFactId(): string;
  newPointerId(): string;
  newHistoryId(): string;
}

export interface OutboundEmailDeliveryRegistrationEvidenceIds {
  readonly rootFactId: string;
  readonly rootPointerId: string;
  readonly historyThreadId: string;
  readonly rootHistoryId: string;
}

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
  const callbacks = JSON.parse(row.callback_capabilities_json) as unknown;
  const capabilities = providerCapabilitiesSchema.parse({
    idempotency: row.idempotency_capability,
    reconciliation: row.reconciliation_capability,
    callbacks,
    inboundReplies: false
  });
  const safeEvidence = row.safe_evidence_json === null
    ? null
    : safeEvidenceSchema.parse(JSON.parse(row.safe_evidence_json));
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
    safeEvidence,
    recoveryCode: row.recovery_code
  });
}

const HEAD_COLUMNS = `delivery_id, workspace_id, event_id, release_id, dispatch_generation,
       reviewed_message_digest_sha256, reviewed_envelope_digest_sha256,
       recipient_ref_id, template_revision_ref_id, content_ref_id,
       provider_connection_revision_id, external_delivery_key,
       sender_profile_revision_id, sender_presentation_contract_key,
       sender_presentation_contract_version, sender_presentation_digest_sha256,
       channel_address_id, channel_address_version,
       address_lookup_fingerprint_profile, address_lookup_fingerprint_version,
       address_lookup_fingerprint_sha256, state, version, attempt_count,
       unknown_attempt_count, marked_resend_exhausted,
       current_attempt_id, lease_claim_id, lease_expires_at_ms`;

const HEAD_SELECT = `
SELECT ${HEAD_COLUMNS}
  FROM communication_outbound_delivery_heads
 WHERE delivery_id = ?`;

const HEAD_SELECT_WITH_RECEIPT = `
SELECT ${HEAD_COLUMNS}, receipt_id
  FROM communication_outbound_delivery_heads
 WHERE delivery_id = ?`;

const ATTEMPT_SELECT = `
SELECT attempt_id, delivery_id, attempt_number, attempt_kind, state, adapter_key, adapter_version,
       idempotency_capability, reconciliation_capability, callback_capabilities_json,
       provider_request_digest_sha256, reviewed_message_digest_sha256,
       reviewed_envelope_digest_sha256, provider_message_id, provider_outcome_reason,
       safe_evidence_json, recovery_code, started_at_ms, completed_at_ms
  FROM communication_outbound_delivery_attempts
 WHERE attempt_id = ?`;

function summaryCode(state: ProviderAttemptResolution['state']): string {
  switch (state) {
    case 'accepted': return 'communication.outbound-email.accepted';
    case 'known_rejected_safe_retryable': return 'communication.outbound-email.rejected-safe-retryable';
    case 'known_rejected_terminal': return 'communication.outbound-email.rejected-terminal';
    case 'acceptance_unknown': return 'communication.outbound-email.acceptance-unknown';
  }
  throw new TypeError('outbound_delivery_state_invalid');
}

export class SQLiteOutboundEmailDeliveryLedger implements OutboundEmailDeliveryLedger {
  readonly #ids: SQLiteOutboundEmailDeliveryLedgerIds;

  public constructor(
    private readonly sqlite: Database,
    ids: SQLiteOutboundEmailDeliveryLedgerIds
  ) {
    this.#ids = Object.freeze({
      newFactId: ids.newFactId.bind(ids),
      newPointerId: ids.newPointerId.bind(ids),
      newHistoryId: ids.newHistoryId.bind(ids)
    });
  }

  read(deliveryId: string): OutboundEmailDeliveryHead | undefined {
    const id = providerOpaqueIdSchema.parse(deliveryId);
    const row = this.sqlite.query<DeliveryHeadRow, [string]>(HEAD_SELECT).get(id);
    return row ? headFromRow(row) : undefined;
  }

  readAttempt(attemptId: string): OutboundEmailDeliveryAttempt | undefined {
    const id = providerOpaqueIdSchema.parse(attemptId);
    const row = this.sqlite.query<AttemptRow, [string]>(ATTEMPT_SELECT).get(id);
    return row ? attemptFromRow(row) : undefined;
  }

  listAttempts(deliveryId: string): readonly OutboundEmailDeliveryAttempt[] {
    const id = providerOpaqueIdSchema.parse(deliveryId);
    const rows = this.sqlite.query<AttemptRow, [string]>(`${ATTEMPT_SELECT.replace('WHERE attempt_id = ?', '')}
      WHERE delivery_id = ? ORDER BY attempt_number`).all(id);
    return Object.freeze(rows.map(attemptFromRow));
  }

  /**
   * One conditional update decides ownership. Zero rows changed means somebody
   * else owns the delivery — never an exception. The classifying read runs only
   * on that miss, to separate ordinary contention from a delivery that no lease
   * could make dispatchable.
   */
  claim(input: {
    readonly deliveryId: string;
    readonly claimId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): OutboundEmailDeliveryClaimOutcome {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new TypeError('outbound_delivery_lease_duration_invalid');
    }
    const nowMs = instantMs(input.now);
    const expiresAtMs = nowMs + input.leaseMs;
    return this.#transaction(() => {
      const claimed = this.sqlite.query<never, [string, number, number, number, string, number]>(`
        UPDATE communication_outbound_delivery_heads
           SET lease_claim_id = ?, lease_acquired_at_ms = ?, lease_expires_at_ms = ?,
               updated_at_ms = max(updated_at_ms, ?)
         WHERE delivery_id = ?
           AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)
           AND (state = 'pending'
             OR state = 'request_started'
             OR state = 'known_rejected_safe_retryable'
             OR (state = 'acceptance_unknown' AND marked_resend_exhausted = 0))
      `).run(claimId, nowMs, expiresAtMs, nowMs, deliveryId, nowMs);
      const row = this.sqlite.query<DeliveryHeadRow, [string]>(HEAD_SELECT).get(deliveryId);
      if (!row) return Object.freeze({ contractVersion: 1, claimed: false, reason: 'not_found' });
      const head = headFromRow(row);
      if (claimed.changes === 1) {
        return Object.freeze({ contractVersion: 1, claimed: true, claimId, head });
      }
      return Object.freeze({
        contractVersion: 1,
        claimed: false,
        reason: row.lease_expires_at_ms !== null && row.lease_expires_at_ms > nowMs
          ? 'lease_held'
          : 'not_claimable',
        head
      });
    });
  }

  releaseClaim(input: {
    readonly deliveryId: string;
    readonly claimId: string;
    readonly now: string;
  }): void {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    const nowMs = instantMs(input.now);
    this.#transaction(() => {
      // A claim that already lapsed and was taken by someone else must not be
      // cleared out from under its new owner, and an in-flight attempt keeps its
      // lease so recovery stays governed by expiry.
      this.sqlite.query<never, [number, string, string]>(`
        UPDATE communication_outbound_delivery_heads
           SET lease_claim_id = NULL, lease_acquired_at_ms = NULL, lease_expires_at_ms = NULL,
               updated_at_ms = max(updated_at_ms, ?)
         WHERE delivery_id = ? AND lease_claim_id = ? AND state <> 'request_started'
      `).run(nowMs, deliveryId, claimId);
    });
  }

  recordAttemptStarted(input: {
    readonly deliveryId: string;
    readonly expectedDeliveryVersion: number;
    readonly claimId: string;
    readonly leaseMs: number;
    readonly attemptId: string;
    readonly attemptKind: OutboundEmailDeliveryAttemptKind;
    readonly authorizedMarkedResend?: boolean;
    readonly resendEnvelopeDigestSha256?: string;
    readonly adapterKey: string;
    readonly adapterVersion: string;
    readonly capabilities: ProviderCapabilities;
    readonly providerRequestDigestSha256: string;
    readonly startedAt: string;
  }): OutboundEmailDeliveryAttempt {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const attemptId = providerOpaqueIdSchema.parse(input.attemptId);
    const attemptKind = input.attemptKind;
    if (attemptKind !== 'original' && attemptKind !== 'marked_resend') {
      throw new TypeError('outbound_delivery_attempt_kind_invalid');
    }
    const adapterKey = providerStableKeySchema.parse(input.adapterKey);
    const adapterVersion = providerStableKeySchema.parse(input.adapterVersion);
    const capabilities = providerCapabilitiesSchema.parse(input.capabilities);
    const requestDigest = providerSha256Schema.parse(input.providerRequestDigestSha256);
    const resendDigest = attemptKind === 'marked_resend'
      ? providerSha256Schema.parse(input.resendEnvelopeDigestSha256)
      : undefined;
    if (attemptKind === 'original' && input.resendEnvelopeDigestSha256 !== undefined) {
      throw new TypeError('outbound_delivery_resend_digest_unexpected');
    }
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new TypeError('outbound_delivery_lease_duration_invalid');
    }
    const startedAtMs = instantMs(input.startedAt);
    return this.#transaction(() => {
      const registration = this.sqlite.query<DeliveryHeadRow & {
        readonly receipt_id: string | null;
      }, [string]>(HEAD_SELECT_WITH_RECEIPT).get(deliveryId);
      if (!registration || registration.receipt_id === null) throw new TypeError('outbound_delivery_not_registered');
      if (registration.lease_claim_id !== claimId) throw new TypeError('outbound_delivery_attempt_conflict');
      if (registration.version !== input.expectedDeliveryVersion) throw new TypeError('outbound_delivery_attempt_conflict');
      if (registration.state !== 'pending' && registration.state !== 'known_rejected_safe_retryable'
        && !(registration.state === 'acceptance_unknown' && registration.marked_resend_exhausted === 0)) {
        throw new TypeError('outbound_delivery_not_dispatchable');
      }
      const authorizedMarkedResend = input.authorizedMarkedResend === true;
      if (input.authorizedMarkedResend !== undefined
          && input.authorizedMarkedResend !== true) {
        throw new TypeError('outbound_delivery_marked_resend_authorization_invalid');
      }
      if (authorizedMarkedResend) {
        if (attemptKind !== 'marked_resend'
            || registration.state !== 'known_rejected_safe_retryable') {
          throw new TypeError('outbound_delivery_marked_resend_authorization_invalid');
        }
        const eligible = this.sqlite.query<{ readonly eligible: number }, [string]>(`
          SELECT 1 AS eligible
            FROM communication_outbound_delivery_heads h
            JOIN communication_message_releases r ON r.release_id=h.release_id
            JOIN communication_current_channel_addresses c
              ON c.workspace_id=h.workspace_id AND c.event_id=h.event_id
             AND c.contact_ref_id=r.contact_ref_id
            JOIN communication_channel_address_versions a
              ON a.workspace_id=c.workspace_id AND a.event_id=c.event_id
             AND a.address_ref_id=c.address_ref_id AND a.address_version=c.address_version
           WHERE h.delivery_id=?
             AND (
               EXISTS (
                 SELECT 1 FROM communication_delivery_observations o
                  WHERE o.delivery_id=h.delivery_id AND o.observation_kind='permanent_bounce'
               )
               OR EXISTS (
                 SELECT 1
                   FROM communication_outbound_delivery_attempts prior,
                        json_each(prior.safe_evidence_json, '$.registeredFacts') fact
                  WHERE prior.delivery_id=h.delivery_id
                    AND json_extract(fact.value, '$.factKey')='cloudflare.observation'
                    AND json_extract(fact.value, '$.valueKind')='enum'
                    AND json_extract(fact.value, '$.enumValue')='accepted_permanent_bounce'
               )
             )
             AND (a.address_ref_id<>h.channel_address_id
               OR a.address_version<>h.channel_address_version
               OR a.lookup_keyed_value<>h.address_lookup_fingerprint_sha256)
             AND NOT EXISTS (
               SELECT 1 FROM communication_current_address_suppressions s
                WHERE s.workspace_id=h.workspace_id
                  AND s.lookup_profile=a.lookup_profile
                  AND s.lookup_version=a.lookup_version
                  AND s.lookup_keyed_value=a.lookup_keyed_value
                  AND s.state='suppressed'
             )
        `).get(deliveryId);
        if (eligible === undefined) {
          throw new TypeError('outbound_delivery_marked_resend_authorization_invalid');
        }
      }
      if (!authorizedMarkedResend && attemptKind !== requiredOutboundEmailAttemptKind(
        { unknownAttemptCount: registration.unknown_attempt_count },
        capabilities
      )) {
        throw new TypeError('outbound_delivery_attempt_kind_conflict');
      }
      if (resendDigest !== undefined && resendDigest === registration.reviewed_envelope_digest_sha256) {
        throw new TypeError('outbound_delivery_resend_envelope_unmarked');
      }
      const attemptNumber = registration.attempt_count + 1;
      this.sqlite.query<never, [
        string, string, number, string, string, string, string, string,
        string, string, string, string, number
      ]>(`
        INSERT INTO communication_outbound_delivery_attempts (
          attempt_id, delivery_id, attempt_number, attempt_kind, state, adapter_key, adapter_version,
          idempotency_capability, reconciliation_capability, callback_capabilities_json,
          provider_request_digest_sha256, reviewed_message_digest_sha256,
          reviewed_envelope_digest_sha256, started_at_ms
        ) VALUES (?, ?, ?, ?, 'request_started', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, deliveryId, attemptNumber, attemptKind, adapterKey, adapterVersion,
        capabilities.idempotency, capabilities.reconciliation,
        canonicalJsonText(capabilities.callbacks), requestDigest,
        registration.reviewed_message_digest_sha256,
        resendDigest ?? registration.reviewed_envelope_digest_sha256,
        startedAtMs
      );
      // The lease is renewed from the attempt's own start, so the whole provider
      // request runs under a full lease rather than whatever remained of the
      // claim taken before the envelope was resolved.
      const changed = this.sqlite.query<never, [string, number, number, number, number, string, number, string]>(`
        UPDATE communication_outbound_delivery_heads
           SET state = 'request_started', current_attempt_id = ?, attempt_count = ?,
               version = version + 1, updated_at_ms = ?,
               lease_acquired_at_ms = ?, lease_expires_at_ms = ?
         WHERE delivery_id = ? AND version = ? AND lease_claim_id = ?
      `).run(
        attemptId, attemptNumber, startedAtMs, startedAtMs, startedAtMs + input.leaseMs,
        deliveryId, input.expectedDeliveryVersion, claimId
      );
      if (changed.changes !== 1) throw new TypeError('outbound_delivery_attempt_conflict');
      return this.readAttempt(attemptId)!;
    });
  }

  recordProviderResolution(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly resolution: ProviderAttemptResolution;
    readonly completedAt: string;
  }): OutboundEmailAttemptCompletion {
    const safeEvidence = safeEvidenceSchema.parse(input.resolution.safeEvidence);
    return this.#complete({
      deliveryId: input.deliveryId,
      attemptId: input.attemptId,
      claimId: input.claimId,
      state: input.resolution.state,
      providerMessageId: input.resolution.providerMessageId,
      providerOutcomeReason: input.resolution.providerOutcomeReason,
      safeEvidence,
      recoveryCode: null,
      completedAt: input.completedAt
    });
  }

  recordBoundaryAmbiguity(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly code: 'worker_result_lost' | 'provider_boundary_failure';
    readonly completedAt: string;
  }): OutboundEmailAttemptCompletion {
    return this.#complete({
      deliveryId: input.deliveryId,
      attemptId: input.attemptId,
      claimId: input.claimId,
      state: 'acceptance_unknown',
      providerMessageId: null,
      providerOutcomeReason: null,
      safeEvidence: null,
      recoveryCode: input.code,
      completedAt: input.completedAt
    });
  }

  #complete(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly claimId: string;
    readonly state: ProviderAttemptResolution['state'];
    readonly providerMessageId: string | null;
    readonly providerOutcomeReason: string | null;
    readonly safeEvidence: SafeEvidence | null;
    readonly recoveryCode: OutboundEmailDeliveryAttempt['recoveryCode'];
    readonly completedAt: string;
  }): OutboundEmailAttemptCompletion {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const attemptId = providerOpaqueIdSchema.parse(input.attemptId);
    const completedAtMs = instantMs(input.completedAt);
    const claimId = providerOpaqueIdSchema.parse(input.claimId);
    return this.#transaction(() => {
      const anchor = this.sqlite.query<{
        readonly receipt_id: string | null;
        readonly root_fact_id: string;
        readonly history_thread_id: string;
        readonly root_history_id: string;
        readonly workspace_id: string;
        readonly event_id: string;
        readonly channel_address_id: string;
        readonly channel_address_version: number;
        readonly address_lookup_fingerprint_profile: string;
        readonly address_lookup_fingerprint_version: number;
        readonly address_lookup_fingerprint_sha256: string;
        readonly state: string;
        readonly current_attempt_id: string | null;
        readonly lease_claim_id: string | null;
      }, [string]>(`
        SELECT receipt_id, root_fact_id, history_thread_id, root_history_id,
               workspace_id, event_id, channel_address_id, channel_address_version,
               address_lookup_fingerprint_profile,address_lookup_fingerprint_version,
               address_lookup_fingerprint_sha256,state,current_attempt_id,lease_claim_id
          FROM communication_outbound_delivery_heads WHERE delivery_id = ?
      `).get(deliveryId);
      if (!anchor || anchor.receipt_id === null) {
        throw new TypeError('outbound_delivery_attempt_conflict');
      }
      const startedAttempt = this.sqlite.query<{
        readonly attempt_kind: OutboundEmailDeliveryAttemptKind;
      }, [string, string]>(`
        SELECT attempt_kind FROM communication_outbound_delivery_attempts
         WHERE attempt_id = ? AND delivery_id = ?
      `).get(attemptId, deliveryId);
      if (!startedAttempt) throw new TypeError('outbound_delivery_attempt_conflict');
      // Fence: this writer's lease lapsed and someone else took the delivery.
      // Its provider answer is real and must not be thrown away, but it can no
      // longer decide effective state — so it is kept as append-only
      // acceptance-unknown evidence and the current owner keeps the delivery.
      if (anchor.lease_claim_id !== claimId) {
        this.#appendAttemptEvidence({
          anchor,
          deliveryId,
          attemptId,
          factKind: 'outbound_email_attempt_acceptance_unknown',
          summary: 'communication.outbound-email.acceptance-unknown',
          payload: {
            contractVersion: 1,
            kind: 'fenced_attempt_observation',
            attemptKind: startedAttempt.attempt_kind,
            observedState: input.state,
            providerMessageId: input.providerMessageId,
            providerOutcomeReason: input.providerOutcomeReason,
            safeEvidence: input.safeEvidence,
            recoveryCode: input.recoveryCode
          },
          occurredAtMs: completedAtMs
        });
        return Object.freeze({
          contractVersion: 1,
          fenced: true,
          head: this.read(deliveryId)!
        });
      }
      if (anchor.state !== 'request_started' || anchor.current_attempt_id !== attemptId) {
        throw new TypeError('outbound_delivery_attempt_conflict');
      }
      const landedUnknown = input.state === 'acceptance_unknown';
      // The single automatic marked retry is consumed when it also lands with
      // unknown acceptance; the head is then quarantined for manual resolution.
      const exhaustsMarkedResend = landedUnknown
        && startedAttempt.attempt_kind === 'marked_resend';
      const changedAttempt = this.sqlite.query<never, [
        string, string | null, string | null, string | null, string | null, number, string
      ]>(`
        UPDATE communication_outbound_delivery_attempts
           SET state = ?, provider_message_id = ?, provider_outcome_reason = ?,
               safe_evidence_json = ?, recovery_code = ?, completed_at_ms = ?
         WHERE attempt_id = ? AND state = 'request_started'
      `).run(
        input.state,
        input.providerMessageId,
        input.providerOutcomeReason,
        input.safeEvidence === null ? null : canonicalJsonText(input.safeEvidence),
        input.recoveryCode,
        completedAtMs,
        attemptId
      );
      if (changedAttempt.changes !== 1) throw new TypeError('outbound_delivery_attempt_conflict');
      // Settling releases the lease with the same statement that settles state,
      // and re-checks the claim in SQL so no writer can win the read and lose
      // the write.
      const changedHead = this.sqlite.query<never, [string, number, number, number, string, string, string]>(`
        UPDATE communication_outbound_delivery_heads
           SET state = ?, version = version + 1, updated_at_ms = ?,
               unknown_attempt_count = unknown_attempt_count + ?,
               marked_resend_exhausted = max(marked_resend_exhausted, ?),
               lease_claim_id = NULL, lease_acquired_at_ms = NULL, lease_expires_at_ms = NULL
         WHERE delivery_id = ? AND state = 'request_started' AND current_attempt_id = ?
           AND lease_claim_id = ?
      `).run(
        input.state,
        completedAtMs,
        landedUnknown ? 1 : 0,
        exhaustsMarkedResend ? 1 : 0,
        deliveryId,
        attemptId,
        claimId
      );
      if (changedHead.changes !== 1) throw new TypeError('outbound_delivery_attempt_conflict');

      const synchronousPermanentBounce = input.safeEvidence?.registeredFacts.some((fact) =>
        fact.factKey === 'cloudflare.observation'
          && fact.valueKind === 'enum'
          && fact.enumValue === 'accepted_permanent_bounce'
      ) === true;
      if (synchronousPermanentBounce && input.safeEvidence !== null) {
        const suppressionFactId = providerOpaqueIdSchema.parse(this.#ids.newFactId());
        this.sqlite.query(`
          INSERT INTO communication_address_suppression_facts (
            suppression_fact_id,workspace_id,source_event_id,address_ref_id,address_version,
            lookup_profile,lookup_version,lookup_keyed_value,state,reason,attempt_id,
            occurred_at_ms,safe_evidence_json
          ) VALUES (?,?,?,?,?,?,?,?,'suppressed','provider_permanent_bounce',?,?,?)
        `).run(
          suppressionFactId, anchor.workspace_id, anchor.event_id,
          anchor.channel_address_id, anchor.channel_address_version,
          anchor.address_lookup_fingerprint_profile,
          anchor.address_lookup_fingerprint_version,
          anchor.address_lookup_fingerprint_sha256,
          attemptId, completedAtMs, canonicalJsonText(input.safeEvidence)
        );
        this.sqlite.query(`
          INSERT INTO communication_current_address_suppressions (
            workspace_id,lookup_profile,lookup_version,lookup_keyed_value,
            current_fact_id,state,version,updated_at_ms
          ) VALUES (?,?,?,?,?,'suppressed',1,?)
          ON CONFLICT(workspace_id,lookup_profile,lookup_version,lookup_keyed_value)
          DO UPDATE SET current_fact_id=excluded.current_fact_id,state='suppressed',
                        version=communication_current_address_suppressions.version+1,
                        updated_at_ms=max(communication_current_address_suppressions.updated_at_ms,
                                          excluded.updated_at_ms)
        `).run(
          anchor.workspace_id, anchor.address_lookup_fingerprint_profile,
          anchor.address_lookup_fingerprint_version,
          anchor.address_lookup_fingerprint_sha256,suppressionFactId,completedAtMs
        );
      }

      const payload = input.safeEvidence === null
        ? {
            contractVersion: 1,
            kind: 'acceptance_unknown',
            attemptKind: startedAttempt.attempt_kind,
            recoveryCode: input.recoveryCode,
            markedResendExhausted: exhaustsMarkedResend
          }
        : {
            contractVersion: 1,
            kind: 'provider_resolution',
            attemptKind: startedAttempt.attempt_kind,
            state: input.state,
            providerMessageId: input.providerMessageId,
            providerOutcomeReason: input.providerOutcomeReason,
            safeEvidence: input.safeEvidence,
            ...(landedUnknown ? { markedResendExhausted: exhaustsMarkedResend } : {})
          };
      this.#appendAttemptEvidence({
        anchor,
        deliveryId,
        attemptId,
        factKind: input.state === 'acceptance_unknown'
          ? 'outbound_email_attempt_acceptance_unknown'
          : 'outbound_email_attempt_resolved',
        summary: summaryCode(input.state),
        payload,
        occurredAtMs: completedAtMs
      });
      return Object.freeze({ contractVersion: 1, fenced: false, head: this.read(deliveryId)! });
    });
  }

  /** Appends the fact, outbox pointer, and history entry for one attempt observation. */
  #appendAttemptEvidence(input: {
    readonly anchor: {
      readonly receipt_id: string | null;
      readonly root_fact_id: string;
      readonly history_thread_id: string;
      readonly root_history_id: string;
      readonly workspace_id: string;
      readonly event_id: string;
    };
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly factKind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly occurredAtMs: number;
  }): void {
    const receiptId = input.anchor.receipt_id;
    if (receiptId === null) throw new TypeError('outbound_delivery_attempt_conflict');
    const factId = providerOpaqueIdSchema.parse(this.#ids.newFactId());
    const pointerId = providerOpaqueIdSchema.parse(this.#ids.newPointerId());
    const historyId = providerOpaqueIdSchema.parse(this.#ids.newHistoryId());
    const sequence = this.sqlite.query<{ readonly next_sequence: number }, [string]>(`
      SELECT coalesce(max(sequence), -1) + 1 AS next_sequence
        FROM communication_outbound_delivery_history WHERE thread_id = ?
    `).get(input.anchor.history_thread_id)?.next_sequence;
    if (sequence === undefined) throw new TypeError('outbound_delivery_history_missing');
    this.sqlite.query<never, [string, string, string, string, string, string, string, string, string, number]>(`
      INSERT INTO communication_outbound_delivery_facts (
        fact_id, receipt_id, workspace_id, event_id, delivery_id, attempt_id,
        fact_kind, fact_version, causation_fact_id, payload_json, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      factId, receiptId, input.anchor.workspace_id, input.anchor.event_id,
      input.deliveryId, input.attemptId, input.factKind,
      input.anchor.root_fact_id,
      canonicalJsonText(input.payload),
      input.occurredAtMs
    );
    this.sqlite.query<never, [string, string, string, string, number]>(`
      INSERT INTO communication_outbound_delivery_outbox (
        pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
      ) VALUES (?, ?, ?, ?, 'communication.outbound-email.attempt-resolved', ?)
    `).run(pointerId, receiptId, factId, input.deliveryId, input.occurredAtMs);
    this.sqlite.query<never, [string, string, number, string, string, string, string, string, string, number]>(`
      INSERT INTO communication_outbound_delivery_history (
        history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
        attempt_id, parent_history_id, summary_code, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      historyId, input.anchor.history_thread_id, sequence, receiptId, factId,
      input.deliveryId, input.attemptId, input.anchor.root_history_id, input.summary,
      input.occurredAtMs
    );
  }

  #transaction<Value>(work: () => Value): Value {
    if (this.sqlite.inTransaction) throw new TypeError('outbound_delivery_ledger_requires_own_transaction');
    let began = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      began = true;
      const value = work();
      this.sqlite.exec('COMMIT;');
      return value;
    } catch (error) {
      if (began && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    }
  }
}

export function insertOutboundEmailDeliveryRegistration(input: {
  readonly sqlite: Database;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly work: OutboundEmailDeliveryWorkInput;
  readonly evidence: OutboundEmailDeliveryRegistrationEvidenceIds;
  readonly createdAt: string;
}): void {
  if (!input.sqlite.inTransaction) throw new TypeError('outbound_delivery_registration_transaction_required');
  const work = outboundEmailDeliveryWorkInputSchema.parse(input.work);
  const createdAtMs = instantMs(input.createdAt);
  const evidence = {
    rootFactId: providerOpaqueIdSchema.parse(input.evidence.rootFactId),
    rootPointerId: providerOpaqueIdSchema.parse(input.evidence.rootPointerId),
    historyThreadId: providerOpaqueIdSchema.parse(input.evidence.historyThreadId),
    rootHistoryId: providerOpaqueIdSchema.parse(input.evidence.rootHistoryId)
  };
  input.sqlite.query<never, [
    string, string, string, string, number, string, string, string, string, string,
    string, string, string, string, number, string, string, number, string,
    number, string, string, string, string, string, number, number
  ]>(`
    INSERT INTO communication_outbound_delivery_heads (
      delivery_id, workspace_id, event_id, release_id, dispatch_generation,
      reviewed_message_digest_sha256, reviewed_envelope_digest_sha256,
      recipient_ref_id, template_revision_ref_id, content_ref_id,
      provider_connection_revision_id, external_delivery_key,
      sender_profile_revision_id, sender_presentation_contract_key,
      sender_presentation_contract_version, sender_presentation_digest_sha256,
      channel_address_id, channel_address_version,
      address_lookup_fingerprint_profile, address_lookup_fingerprint_version,
      address_lookup_fingerprint_sha256, state, version, attempt_count,
      unknown_attempt_count, marked_resend_exhausted,
      root_fact_id, root_outbox_pointer_id, history_thread_id, root_history_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'pending', 1, 0, 0, 0, ?, ?, ?, ?, ?, ?
    )
  `).run(
    work.deliveryId, input.workspaceId, input.eventId, work.releaseId,
    work.dispatchGeneration, work.reviewedMessageDigestSha256,
    work.reviewedEnvelopeDigestSha256, work.recipientRefId,
    work.templateRevisionRefId, work.contentRefId,
    work.providerConnectionRevisionId, work.externalDeliveryKey,
    work.senderProfileRevisionId, work.senderPresentationContractKey,
    work.senderPresentationContractVersion, work.senderPresentationDigestSha256,
    work.channelAddressId, work.channelAddressVersion,
    work.addressLookupFingerprintProfile, work.addressLookupFingerprintVersion,
    work.addressLookupFingerprintSha256,
    evidence.rootFactId, evidence.rootPointerId, evidence.historyThreadId,
    evidence.rootHistoryId, createdAtMs, createdAtMs
  );
}

export function linkOutboundEmailDeliveryReceipt(input: {
  readonly sqlite: Database;
  readonly deliveryId: string;
  readonly receiptId: string;
}): void {
  if (!input.sqlite.inTransaction) throw new TypeError('outbound_delivery_registration_transaction_required');
  const changed = input.sqlite.query<never, [string, string]>(`
    UPDATE communication_outbound_delivery_heads SET receipt_id = ?
     WHERE delivery_id = ? AND receipt_id IS NULL
  `).run(input.receiptId, providerOpaqueIdSchema.parse(input.deliveryId));
  if (changed.changes !== 1) throw new TypeError('outbound_delivery_receipt_conflict');
}
