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
  type OutboundEmailDeliveryAttempt,
  type OutboundEmailDeliveryHead,
  type OutboundEmailDeliveryLedger,
  type ProviderAttemptResolution
} from '@jooevents/communications';
import { canonicalJsonText, parseInstant } from '@jooevents/kernel';

/** Fresh/disposable schema. Retained migrations are intentionally coordinated separately. */
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
  current_attempt_id TEXT,
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
    OR (state <> 'pending' AND attempt_count > 0 AND current_attempt_id IS NOT NULL))
) STRICT;

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

CREATE TABLE communication_outbound_delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
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
  readonly current_attempt_id: string | null;
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly delivery_id: string;
  readonly attempt_number: number;
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
    currentAttemptId: row.current_attempt_id
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

const HEAD_SELECT = `
SELECT delivery_id, workspace_id, event_id, release_id, dispatch_generation,
       reviewed_message_digest_sha256, reviewed_envelope_digest_sha256,
       recipient_ref_id, template_revision_ref_id, content_ref_id,
       provider_connection_revision_id, external_delivery_key,
       sender_profile_revision_id, sender_presentation_contract_key,
       sender_presentation_contract_version, sender_presentation_digest_sha256,
       channel_address_id, channel_address_version,
       address_lookup_fingerprint_profile, address_lookup_fingerprint_version,
       address_lookup_fingerprint_sha256, state, version, attempt_count,
       current_attempt_id
  FROM communication_outbound_delivery_heads
 WHERE delivery_id = ?`;

const ATTEMPT_SELECT = `
SELECT attempt_id, delivery_id, attempt_number, state, adapter_key, adapter_version,
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

  recordAttemptStarted(input: {
    readonly deliveryId: string;
    readonly expectedDeliveryVersion: number;
    readonly attemptId: string;
    readonly adapterKey: string;
    readonly adapterVersion: string;
    readonly capabilities: ProviderCapabilities;
    readonly providerRequestDigestSha256: string;
    readonly startedAt: string;
  }): OutboundEmailDeliveryAttempt {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const attemptId = providerOpaqueIdSchema.parse(input.attemptId);
    const adapterKey = providerStableKeySchema.parse(input.adapterKey);
    const adapterVersion = providerStableKeySchema.parse(input.adapterVersion);
    const capabilities = providerCapabilitiesSchema.parse(input.capabilities);
    const requestDigest = providerSha256Schema.parse(input.providerRequestDigestSha256);
    const startedAtMs = instantMs(input.startedAt);
    return this.#transaction(() => {
      const registration = this.sqlite.query<DeliveryHeadRow & {
        readonly receipt_id: string | null;
      }, [string]>(HEAD_SELECT.replace('current_attempt_id', 'current_attempt_id, receipt_id')).get(deliveryId);
      if (!registration || registration.receipt_id === null) throw new TypeError('outbound_delivery_not_registered');
      if (registration.version !== input.expectedDeliveryVersion) throw new TypeError('outbound_delivery_attempt_conflict');
      if (registration.state !== 'pending' && registration.state !== 'known_rejected_safe_retryable') {
        throw new TypeError('outbound_delivery_not_dispatchable');
      }
      const attemptNumber = registration.attempt_count + 1;
      this.sqlite.query<never, [
        string, string, number, string, string, string, string,
        string, string, string, string, number
      ]>(`
        INSERT INTO communication_outbound_delivery_attempts (
          attempt_id, delivery_id, attempt_number, state, adapter_key, adapter_version,
          idempotency_capability, reconciliation_capability, callback_capabilities_json,
          provider_request_digest_sha256, reviewed_message_digest_sha256,
          reviewed_envelope_digest_sha256, started_at_ms
        ) VALUES (?, ?, ?, 'request_started', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, deliveryId, attemptNumber, adapterKey, adapterVersion,
        capabilities.idempotency, capabilities.reconciliation,
        canonicalJsonText(capabilities.callbacks), requestDigest,
        registration.reviewed_message_digest_sha256,
        registration.reviewed_envelope_digest_sha256,
        startedAtMs
      );
      const changed = this.sqlite.query<never, [string, number, number, string, number]>(`
        UPDATE communication_outbound_delivery_heads
           SET state = 'request_started', current_attempt_id = ?, attempt_count = ?,
               version = version + 1, updated_at_ms = ?
         WHERE delivery_id = ? AND version = ?
      `).run(attemptId, attemptNumber, startedAtMs, deliveryId, input.expectedDeliveryVersion);
      if (changed.changes !== 1) throw new TypeError('outbound_delivery_attempt_conflict');
      return this.readAttempt(attemptId)!;
    });
  }

  recordProviderResolution(input: {
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly resolution: ProviderAttemptResolution;
    readonly completedAt: string;
  }): OutboundEmailDeliveryHead {
    const safeEvidence = safeEvidenceSchema.parse(input.resolution.safeEvidence);
    return this.#complete({
      deliveryId: input.deliveryId,
      attemptId: input.attemptId,
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
    readonly code: 'worker_result_lost' | 'provider_boundary_failure';
    readonly completedAt: string;
  }): OutboundEmailDeliveryHead {
    return this.#complete({
      deliveryId: input.deliveryId,
      attemptId: input.attemptId,
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
    readonly state: ProviderAttemptResolution['state'];
    readonly providerMessageId: string | null;
    readonly providerOutcomeReason: string | null;
    readonly safeEvidence: SafeEvidence | null;
    readonly recoveryCode: OutboundEmailDeliveryAttempt['recoveryCode'];
    readonly completedAt: string;
  }): OutboundEmailDeliveryHead {
    const deliveryId = providerOpaqueIdSchema.parse(input.deliveryId);
    const attemptId = providerOpaqueIdSchema.parse(input.attemptId);
    const completedAtMs = instantMs(input.completedAt);
    return this.#transaction(() => {
      const anchor = this.sqlite.query<{
        readonly receipt_id: string | null;
        readonly root_fact_id: string;
        readonly history_thread_id: string;
        readonly root_history_id: string;
        readonly workspace_id: string;
        readonly event_id: string;
        readonly state: string;
        readonly current_attempt_id: string | null;
      }, [string]>(`
        SELECT receipt_id, root_fact_id, history_thread_id, root_history_id,
               workspace_id, event_id, state, current_attempt_id
          FROM communication_outbound_delivery_heads WHERE delivery_id = ?
      `).get(deliveryId);
      if (!anchor || anchor.receipt_id === null || anchor.state !== 'request_started'
        || anchor.current_attempt_id !== attemptId) {
        throw new TypeError('outbound_delivery_attempt_conflict');
      }
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
      const changedHead = this.sqlite.query<never, [string, number, string, string]>(`
        UPDATE communication_outbound_delivery_heads
           SET state = ?, version = version + 1, updated_at_ms = ?
         WHERE delivery_id = ? AND state = 'request_started' AND current_attempt_id = ?
      `).run(input.state, completedAtMs, deliveryId, attemptId);
      if (changedHead.changes !== 1) throw new TypeError('outbound_delivery_attempt_conflict');

      const factId = providerOpaqueIdSchema.parse(this.#ids.newFactId());
      const pointerId = providerOpaqueIdSchema.parse(this.#ids.newPointerId());
      const historyId = providerOpaqueIdSchema.parse(this.#ids.newHistoryId());
      const sequence = this.sqlite.query<{ readonly next_sequence: number }, [string]>(`
        SELECT coalesce(max(sequence), -1) + 1 AS next_sequence
          FROM communication_outbound_delivery_history WHERE thread_id = ?
      `).get(anchor.history_thread_id)?.next_sequence;
      if (sequence === undefined) throw new TypeError('outbound_delivery_history_missing');
      const payload = input.safeEvidence === null
        ? {
            contractVersion: 1,
            kind: 'acceptance_unknown',
            recoveryCode: input.recoveryCode
          }
        : {
            contractVersion: 1,
            kind: 'provider_resolution',
            state: input.state,
            providerMessageId: input.providerMessageId,
            providerOutcomeReason: input.providerOutcomeReason,
            safeEvidence: input.safeEvidence
          };
      this.sqlite.query<never, [string, string, string, string, string, string, string, string, string, number]>(`
        INSERT INTO communication_outbound_delivery_facts (
          fact_id, receipt_id, workspace_id, event_id, delivery_id, attempt_id,
          fact_kind, fact_version, causation_fact_id, payload_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        factId, anchor.receipt_id, anchor.workspace_id, anchor.event_id,
        deliveryId, attemptId,
        input.state === 'acceptance_unknown'
          ? 'outbound_email_attempt_acceptance_unknown'
          : 'outbound_email_attempt_resolved',
        anchor.root_fact_id,
        canonicalJsonText(payload),
        completedAtMs
      );
      this.sqlite.query<never, [string, string, string, string, number]>(`
        INSERT INTO communication_outbound_delivery_outbox (
          pointer_id, receipt_id, fact_id, delivery_id, purpose, created_at_ms
        ) VALUES (?, ?, ?, ?, 'communication.outbound-email.attempt-resolved', ?)
      `).run(pointerId, anchor.receipt_id, factId, deliveryId, completedAtMs);
      this.sqlite.query<never, [string, string, number, string, string, string, string, string, string, number]>(`
        INSERT INTO communication_outbound_delivery_history (
          history_id, thread_id, sequence, receipt_id, fact_id, delivery_id,
          attempt_id, parent_history_id, summary_code, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        historyId, anchor.history_thread_id, sequence, anchor.receipt_id, factId,
        deliveryId, attemptId, anchor.root_history_id, summaryCode(input.state), completedAtMs
      );
      return this.read(deliveryId)!;
    });
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
      root_fact_id, root_outbox_pointer_id, history_thread_id, root_history_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'pending', 1, 0, ?, ?, ?, ?, ?, ?
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
