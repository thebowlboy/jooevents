import { createHmac } from 'node:crypto';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  ClassifiedPayloadStageError,
  type CanonicalPayloadStageOwnership,
  type ClassifiedPayloadStageStore,
  type PayloadStageInspection,
  type PayloadStageReconciliationCandidate,
  type UnadoptedStageProofAuthority
} from '@jooevents/application';
import {
  type AdoptedVerifiedEnvelopeHandle,
  type SealedAdoptedVerifiedEnvelopeMaterial,
  type SealedVerifiedEnvelopeMaterial,
  type VerifiedIngressDurableIntent,
  type VerifiedIngressDurableIntentRecord,
  type VerifiedEnvelopeHandle,
  type VerifiedEnvelopeSealReader,
  type VerifiedIngressBoundary,
  type VerifiedIngressRecoveryAuthority,
  type VerifiedIngressRejectionReason
} from '@jooevents/application/verified-ingress';
import {
  canonicalJsonText,
  createPayloadRef,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseIntegrationInboxReceiptId,
  parsePayloadRefId,
  parsePayloadStageId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  type EventScopeRef,
  type Instant,
  type PayloadRef,
  type PayloadRefId
} from '@jooevents/kernel';
import {
  EMPTY_VERIFIED_INBOX_STATE,
  definitionRef,
  opaqueKeyedContentBinding,
  parseCanonicalSha256,
  parseInboxAttentionId,
  parseInboxConflictId,
  parseInboxProcessingPointerId,
  parseOpaqueInboxSemanticIdentity,
  reduceVerifiedInbox,
  type DefinitionRef,
  type CanonicalSha256,
  type InboxAttention,
  type InboxConflict,
  type InboxConflictId,
  type InboxProcessingPointer,
  type InboxReceipt,
  type InboxSemanticKey,
  type NonEmptyContentBindings,
  type VerifiedInboxIntake,
  type VerifiedInboxReduction,
  type VerifiedInboxState
} from '@jooevents/reliability';

/** Disposable SQLite proof only. These objects are not part of the retained schema chain. */
export const VERIFIED_INBOX_TRIAL_SQL = `
CREATE TABLE verified_inbox_binding_profiles_trial (
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  key_verifier TEXT NOT NULL CHECK(
    length(key_verifier) = 69
    AND substr(key_verifier, 1, 5) = 'ikv1_'
    AND substr(key_verifier, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (profile_key, profile_version)
) STRICT;

CREATE TRIGGER verified_inbox_binding_profiles_reject_update_trial
BEFORE UPDATE ON verified_inbox_binding_profiles_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox binding profiles are immutable');
END;

CREATE TRIGGER verified_inbox_binding_profiles_reject_delete_trial
BEFORE DELETE ON verified_inbox_binding_profiles_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox binding profiles are immutable');
END;

CREATE TABLE verified_inbox_source_processor_mappings_trial (
  source_connection_id TEXT NOT NULL CHECK(length(source_connection_id) = 36),
  source_connection_revision_id TEXT NOT NULL CHECK(length(source_connection_revision_id) = 36),
  verifier_contract_key TEXT NOT NULL CHECK(length(verifier_contract_key) BETWEEN 1 AND 160),
  verifier_contract_version INTEGER NOT NULL CHECK(verifier_contract_version > 0),
  verifier_revision_id TEXT NOT NULL CHECK(length(verifier_revision_id) = 36),
  processor_key TEXT NOT NULL CHECK(length(processor_key) BETWEEN 1 AND 160),
  processor_version INTEGER NOT NULL CHECK(processor_version > 0),
  processor_digest_sha256 TEXT NOT NULL CHECK(
    length(processor_digest_sha256) = 64
    AND processor_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  job_key TEXT NOT NULL CHECK(length(job_key) BETWEEN 1 AND 160),
  job_version INTEGER NOT NULL CHECK(job_version > 0),
  PRIMARY KEY (source_connection_id, source_connection_revision_id),
  UNIQUE (
    source_connection_id, source_connection_revision_id,
    verifier_contract_key, verifier_contract_version, verifier_revision_id,
    processor_key, processor_version, processor_digest_sha256,
    job_key, job_version
  )
) STRICT;

CREATE TRIGGER verified_inbox_source_processor_mappings_reject_update_trial
BEFORE UPDATE ON verified_inbox_source_processor_mappings_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox source processor mappings are immutable');
END;

CREATE TRIGGER verified_inbox_source_processor_mappings_reject_delete_trial
BEFORE DELETE ON verified_inbox_source_processor_mappings_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox source processor mappings are immutable');
END;

CREATE TABLE verified_inbox_payload_refs_trial (
  payload_ref_id TEXT PRIMARY KEY CHECK(length(payload_ref_id) = 36),
  disposition TEXT NOT NULL CHECK(disposition IN ('adopted', 'quarantined')),
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (payload_ref_id, disposition)
) STRICT;

CREATE TRIGGER verified_inbox_payload_refs_reject_update_trial
BEFORE UPDATE ON verified_inbox_payload_refs_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox payload references are immutable');
END;

CREATE TRIGGER verified_inbox_payload_refs_reject_delete_trial
BEFORE DELETE ON verified_inbox_payload_refs_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox payload references are immutable');
END;

CREATE TABLE verified_inbox_stage_ownership_trial (
  stage_id TEXT PRIMARY KEY CHECK(length(stage_id) = 36),
  stage_expected_version INTEGER NOT NULL CHECK(stage_expected_version > 0),
  stage_fence INTEGER NOT NULL CHECK(stage_fence > 0),
  payload_ref_id TEXT NOT NULL UNIQUE CHECK(length(payload_ref_id) = 36),
  payload_disposition TEXT NOT NULL CHECK(payload_disposition IN ('adopted', 'quarantined')),
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('receipt', 'conflict')),
  outcome_id TEXT NOT NULL UNIQUE CHECK(length(outcome_id) = 36),
  FOREIGN KEY (payload_ref_id, payload_disposition)
    REFERENCES verified_inbox_payload_refs_trial(payload_ref_id, disposition)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_stage_ownership_reject_update_trial
BEFORE UPDATE ON verified_inbox_stage_ownership_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox stage ownership is immutable');
END;

CREATE TRIGGER verified_inbox_stage_ownership_reject_delete_trial
BEFORE DELETE ON verified_inbox_stage_ownership_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox stage ownership is immutable');
END;

CREATE TABLE verified_inbox_intake_intents_trial (
  intent_id TEXT PRIMARY KEY CHECK(length(intent_id) = 36),
  record_version INTEGER NOT NULL CHECK(record_version = 1),
  stage_id TEXT NOT NULL UNIQUE CHECK(length(stage_id) = 36),
  stage_expected_version INTEGER NOT NULL CHECK(stage_expected_version > 0),
  stage_fence INTEGER NOT NULL CHECK(stage_fence > 0),
  payload_ref_id TEXT NOT NULL UNIQUE CHECK(length(payload_ref_id) = 36),
  source_connection_id TEXT NOT NULL CHECK(length(source_connection_id) = 36),
  semantic_identity TEXT NOT NULL CHECK(
    length(semantic_identity) BETWEEN 28 AND 164
    AND substr(semantic_identity, 1, 4) = 'si1_'
    AND substr(semantic_identity, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(record_json) BETWEEN 2 AND 65536),
  authenticator TEXT NOT NULL CHECK(
    length(authenticator) = 69
    AND substr(authenticator, 1, 5) = 'via1_'
    AND substr(authenticator, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (source_connection_id, semantic_identity)
) STRICT;

CREATE TRIGGER verified_inbox_intake_intents_reject_update_trial
BEFORE UPDATE ON verified_inbox_intake_intents_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox intake intents are immutable');
END;

CREATE TABLE verified_inbox_stage_attentions_trial (
  stage_id TEXT PRIMARY KEY CHECK(length(stage_id) = 36),
  stage_expected_version INTEGER NOT NULL CHECK(stage_expected_version > 0),
  stage_fence INTEGER NOT NULL CHECK(stage_fence > 0),
  reason TEXT NOT NULL CHECK(reason IN (
    'stale_registration', 'invalid_intent', 'unowned_adoption_pending',
    'stage_state_mismatch', 'intent_adoption_refused', 'cleanup_ownership_uncertain'
  )),
  recorded_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER verified_inbox_stage_attentions_reject_update_trial
BEFORE UPDATE ON verified_inbox_stage_attentions_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox stage attentions are append-only');
END;

CREATE TRIGGER verified_inbox_stage_attentions_reject_delete_trial
BEFORE DELETE ON verified_inbox_stage_attentions_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox stage attentions are append-only');
END;

CREATE TABLE verified_inbox_stage_cleanup_claims_trial (
  stage_id TEXT PRIMARY KEY CHECK(length(stage_id) = 36),
  stage_expected_version INTEGER NOT NULL CHECK(stage_expected_version > 0),
  stage_fence INTEGER NOT NULL CHECK(stage_fence > 0),
  stage_expires_at_ms INTEGER NOT NULL,
  reconciliation_policy_key TEXT NOT NULL CHECK(length(reconciliation_policy_key) BETWEEN 1 AND 160),
  reconciliation_policy_version INTEGER NOT NULL CHECK(reconciliation_policy_version > 0),
  claimed_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER verified_inbox_stage_cleanup_claims_reject_update_trial
BEFORE UPDATE ON verified_inbox_stage_cleanup_claims_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox stage cleanup claims are immutable');
END;

CREATE TABLE verified_inbox_receipts_trial (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) = 36),
  source_connection_id TEXT NOT NULL CHECK(length(source_connection_id) = 36),
  source_connection_revision_id TEXT NOT NULL CHECK(length(source_connection_revision_id) = 36),
  semantic_identity TEXT NOT NULL CHECK(
    length(semantic_identity) BETWEEN 28 AND 164
    AND substr(semantic_identity, 1, 4) = 'si1_'
    AND substr(semantic_identity, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  verifier_revision_id TEXT NOT NULL CHECK(length(verifier_revision_id) = 36),
  adopted_payload_ref_id TEXT NOT NULL UNIQUE CHECK(length(adopted_payload_ref_id) = 36),
  adopted_payload_disposition TEXT NOT NULL DEFAULT 'adopted'
    CHECK(adopted_payload_disposition = 'adopted'),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  received_at_ms INTEGER NOT NULL,
  UNIQUE (source_connection_id, semantic_identity),
  FOREIGN KEY (adopted_payload_ref_id, adopted_payload_disposition)
    REFERENCES verified_inbox_payload_refs_trial(payload_ref_id, disposition)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_receipts_reject_update_trial
BEFORE UPDATE ON verified_inbox_receipts_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox receipts are immutable');
END;

CREATE TRIGGER verified_inbox_receipts_reject_delete_trial
BEFORE DELETE ON verified_inbox_receipts_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox receipts are immutable');
END;

CREATE TABLE verified_inbox_receipt_processing_contracts_trial (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) = 36),
  source_connection_id TEXT NOT NULL CHECK(length(source_connection_id) = 36),
  source_connection_revision_id TEXT NOT NULL CHECK(length(source_connection_revision_id) = 36),
  verifier_contract_key TEXT NOT NULL CHECK(length(verifier_contract_key) BETWEEN 1 AND 160),
  verifier_contract_version INTEGER NOT NULL CHECK(verifier_contract_version > 0),
  verifier_revision_id TEXT NOT NULL CHECK(length(verifier_revision_id) = 36),
  processor_key TEXT NOT NULL CHECK(length(processor_key) BETWEEN 1 AND 160),
  processor_version INTEGER NOT NULL CHECK(processor_version > 0),
  processor_digest_sha256 TEXT NOT NULL CHECK(
    length(processor_digest_sha256) = 64
    AND processor_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  job_key TEXT NOT NULL CHECK(length(job_key) BETWEEN 1 AND 160),
  job_version INTEGER NOT NULL CHECK(job_version > 0),
  FOREIGN KEY (receipt_id) REFERENCES verified_inbox_receipts_trial(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    source_connection_id, source_connection_revision_id,
    verifier_contract_key, verifier_contract_version, verifier_revision_id,
    processor_key, processor_version, processor_digest_sha256,
    job_key, job_version
  ) REFERENCES verified_inbox_source_processor_mappings_trial (
    source_connection_id, source_connection_revision_id,
    verifier_contract_key, verifier_contract_version, verifier_revision_id,
    processor_key, processor_version, processor_digest_sha256,
    job_key, job_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_receipt_processing_contracts_reject_update_trial
BEFORE UPDATE ON verified_inbox_receipt_processing_contracts_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox receipt processing contracts are immutable');
END;

CREATE TRIGGER verified_inbox_receipt_processing_contracts_reject_delete_trial
BEFORE DELETE ON verified_inbox_receipt_processing_contracts_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox receipt processing contracts are immutable');
END;

CREATE TABLE verified_inbox_conflicts_trial (
  conflict_id TEXT PRIMARY KEY CHECK(length(conflict_id) = 36),
  receipt_id TEXT NOT NULL CHECK(length(receipt_id) = 36),
  source_connection_revision_id TEXT NOT NULL CHECK(length(source_connection_revision_id) = 36),
  verifier_revision_id TEXT NOT NULL CHECK(length(verifier_revision_id) = 36),
  quarantined_payload_ref_id TEXT NOT NULL UNIQUE CHECK(length(quarantined_payload_ref_id) = 36),
  quarantined_payload_disposition TEXT NOT NULL DEFAULT 'quarantined'
    CHECK(quarantined_payload_disposition = 'quarantined'),
  observed_at_ms INTEGER NOT NULL,
  UNIQUE (conflict_id, receipt_id),
  FOREIGN KEY (receipt_id) REFERENCES verified_inbox_receipts_trial(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (quarantined_payload_ref_id, quarantined_payload_disposition)
    REFERENCES verified_inbox_payload_refs_trial(payload_ref_id, disposition)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_conflicts_reject_update_trial
BEFORE UPDATE ON verified_inbox_conflicts_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox conflicts are immutable');
END;

CREATE TRIGGER verified_inbox_conflicts_reject_delete_trial
BEFORE DELETE ON verified_inbox_conflicts_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox conflicts are immutable');
END;

CREATE TABLE verified_inbox_binding_aliases_trial (
  receipt_id TEXT NOT NULL CHECK(length(receipt_id) = 36),
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  binding_value TEXT NOT NULL CHECK(
    length(binding_value) = 47
    AND substr(binding_value, 1, 4) = 'kb1_'
    AND substr(binding_value, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('receipt', 'conflict')),
  outcome_id TEXT NOT NULL CHECK(length(outcome_id) = 36),
  conflict_id TEXT CHECK(conflict_id IS NULL OR length(conflict_id) = 36),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0 AND ordinal <= 8),
  PRIMARY KEY (receipt_id, profile_key, profile_version, binding_value),
  UNIQUE (outcome_kind, outcome_id, ordinal),
  CHECK(
    (outcome_kind = 'receipt' AND outcome_id = receipt_id AND conflict_id IS NULL)
    OR
    (outcome_kind = 'conflict' AND conflict_id IS NOT NULL AND outcome_id = conflict_id)
  ),
  FOREIGN KEY (receipt_id) REFERENCES verified_inbox_receipts_trial(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (profile_key, profile_version)
    REFERENCES verified_inbox_binding_profiles_trial(profile_key, profile_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (conflict_id, receipt_id)
    REFERENCES verified_inbox_conflicts_trial(conflict_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_binding_aliases_reject_update_trial
BEFORE UPDATE ON verified_inbox_binding_aliases_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox binding aliases are immutable');
END;

CREATE TRIGGER verified_inbox_binding_aliases_reject_delete_trial
BEFORE DELETE ON verified_inbox_binding_aliases_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox binding aliases are immutable');
END;

CREATE TABLE verified_inbox_processing_pointers_trial (
  processing_pointer_id TEXT PRIMARY KEY CHECK(length(processing_pointer_id) = 36),
  receipt_id TEXT NOT NULL UNIQUE CHECK(length(receipt_id) = 36),
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (receipt_id) REFERENCES verified_inbox_receipts_trial(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_processing_pointers_reject_update_trial
BEFORE UPDATE ON verified_inbox_processing_pointers_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox processing pointers are immutable');
END;

CREATE TRIGGER verified_inbox_processing_pointers_reject_delete_trial
BEFORE DELETE ON verified_inbox_processing_pointers_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox processing pointers are immutable');
END;

CREATE TABLE verified_inbox_attentions_trial (
  attention_id TEXT PRIMARY KEY CHECK(length(attention_id) = 36),
  conflict_id TEXT NOT NULL UNIQUE CHECK(length(conflict_id) = 36),
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (conflict_id) REFERENCES verified_inbox_conflicts_trial(conflict_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER verified_inbox_attentions_reject_update_trial
BEFORE UPDATE ON verified_inbox_attentions_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox attentions are immutable');
END;

CREATE TRIGGER verified_inbox_attentions_reject_delete_trial
BEFORE DELETE ON verified_inbox_attentions_trial
BEGIN
  SELECT RAISE(ABORT, 'verified inbox attentions are immutable');
END;
`;

interface BindingProfileRow {
  readonly profile_key: string;
  readonly profile_version: number;
  readonly key_verifier: string;
}

interface ReceiptRow {
  readonly receipt_id: string;
  readonly source_connection_id: string;
  readonly source_connection_revision_id: string;
  readonly semantic_identity: string;
  readonly verifier_revision_id: string;
  readonly adopted_payload_ref_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly received_at_ms: number;
}

interface ConflictRow {
  readonly conflict_id: string;
  readonly receipt_id: string;
  readonly source_connection_revision_id: string;
  readonly verifier_revision_id: string;
  readonly quarantined_payload_ref_id: string;
  readonly observed_at_ms: number;
}

interface BindingAliasRow {
  readonly profile_key: string;
  readonly profile_version: number;
  readonly binding_value: string;
}

interface ProcessingPointerRow {
  readonly processing_pointer_id: string;
  readonly receipt_id: string;
  readonly created_at_ms: number;
}

interface AttentionRow {
  readonly attention_id: string;
  readonly conflict_id: string;
  readonly created_at_ms: number;
}

interface PayloadRefRow {
  readonly payload_ref_id: string;
  readonly disposition: 'adopted' | 'quarantined';
}

interface StageOwnershipRow {
  readonly stage_id: string;
  readonly stage_expected_version: number;
  readonly stage_fence: number;
  readonly payload_ref_id: string;
  readonly payload_disposition: 'adopted' | 'quarantined';
  readonly outcome_kind: 'receipt' | 'conflict';
  readonly outcome_id: string;
}

interface IntakeIntentRow {
  readonly intent_id: string;
  readonly record_version: number;
  readonly stage_id: string;
  readonly stage_expected_version: number;
  readonly stage_fence: number;
  readonly payload_ref_id: string;
  readonly source_connection_id: string;
  readonly semantic_identity: string;
  readonly record_json: string;
  readonly authenticator: string;
  readonly created_at_ms: number;
}

interface ProcessingContractRow {
  readonly source_connection_id: string;
  readonly source_connection_revision_id: string;
  readonly verifier_contract_key: string;
  readonly verifier_contract_version: number;
  readonly verifier_revision_id: string;
  readonly processor_key: string;
  readonly processor_version: number;
  readonly processor_digest_sha256: string;
  readonly job_key: string;
  readonly job_version: number;
}

export type VerifiedInboxTrialStageAttentionReason =
  | 'stale_registration'
  | 'invalid_intent'
  | 'unowned_adoption_pending'
  | 'stage_state_mismatch'
  | 'intent_adoption_refused'
  | 'cleanup_ownership_uncertain';

interface StageAttentionRow {
  readonly stage_id: string;
  readonly stage_expected_version: number;
  readonly stage_fence: number;
  readonly reason: VerifiedInboxTrialStageAttentionReason;
  readonly recorded_at_ms: number;
}

type StageCleanupBinding = Pick<
  PayloadStageReconciliationCandidate,
  'stageId' | 'expectedVersion' | 'fence' | 'expiresAt' | 'reconciliationPolicy'
>;

interface AttentionProjectionRow {
  readonly conflict_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
}

interface StoredBindingProfile {
  readonly profile: DefinitionRef<'content_binding'>;
  readonly keyBytes: Uint8Array;
  readonly identity: string;
  readonly verifier: string;
}

export interface VerifiedInboxTrialBindingProfile {
  readonly profile: DefinitionRef<'content_binding'>;
  readonly keyBytes: Uint8Array;
}

/** Source-controlled mapping frozen for one exact connection revision. */
export interface VerifiedInboxTrialProcessingContract {
  readonly sourceConnectionId: ReturnType<typeof parseSourceConnectionId>;
  readonly sourceConnectionRevisionId: ReturnType<typeof parseSourceConnectionRevisionId>;
  readonly verifierContract: {
    readonly key: string;
    readonly version: ReturnType<typeof parseContractVersion>;
  };
  readonly verifierRevisionId: ReturnType<typeof parseVerifierRevisionId>;
  readonly processor: DefinitionRef<'inbox_processor'>;
  readonly processorDigestSha256: CanonicalSha256;
  readonly job: DefinitionRef<'job'>;
}

export interface SQLiteVerifiedInboxTrialOptions {
  /** Primary profile first, followed by every retained profile needed by stored aliases. */
  readonly contentBindingProfiles: readonly [
    VerifiedInboxTrialBindingProfile,
    ...VerifiedInboxTrialBindingProfile[]
  ];
  readonly sealReader: VerifiedEnvelopeSealReader;
  readonly recovery: VerifiedIngressRecoveryAuthority;
  readonly processingContract: VerifiedInboxTrialProcessingContract;
  readonly clock?: { now(): string };
  readonly ids?: Partial<VerifiedInboxTrialIdFactory>;
}

export interface SQLiteVerifiedInboxTrialFaults {
  readonly afterPayloadRefInserted?: (disposition: 'adopted' | 'quarantined') => void;
  readonly afterReceiptInserted?: () => void;
  readonly afterProcessingContractInserted?: () => void;
  readonly afterConflictInserted?: () => void;
  readonly afterBindingAliasInserted?: (insertedCount: number) => void;
  readonly afterProcessingPointerInserted?: () => void;
  readonly afterAttentionInserted?: () => void;
}

export interface VerifiedInboxTrialIdFactory {
  readonly newReceiptId: () => string;
  readonly newProcessingPointerId: () => string;
  readonly newConflictId: () => string;
  readonly newAttentionId: () => string;
  readonly newPayloadRefId: () => string;
  readonly newIntentId: () => string;
}

export type VerifiedInboxTrialPreflightResult =
  | {
      readonly kind: 'known';
      readonly reduction: VerifiedInboxReduction;
    }
  | {
      readonly kind: 'adoption_required';
      readonly predicted: 'new' | 'changed';
      readonly payloadRefId: PayloadRefId;
    }
  | { readonly kind: 'contended' }
  | { readonly kind: 'cleanup_claimed' }
  | { readonly kind: 'stage_expired' };

export type VerifiedInboxTrialFinalizationResult =
  | {
      readonly kind: 'finalized';
      readonly reduction: VerifiedInboxReduction;
      readonly stageOwnership: 'owned';
    }
  | {
      readonly kind: 'requires_attention';
      readonly reason: VerifiedInboxTrialStageAttentionReason;
    };

export type VerifiedInboxTrialStageOwnership =
  | {
      readonly kind: 'owned';
      readonly payloadRef: PayloadRef;
      readonly disposition: 'adopted' | 'quarantined';
    }
  | { readonly kind: 'proven_unowned' };

export type VerifiedInboxTrialIntentRecovery =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'staged';
      readonly handle: VerifiedEnvelopeHandle;
      readonly payloadRefId: PayloadRefId;
    }
  | { readonly kind: 'adoption_pending'; readonly handle: AdoptedVerifiedEnvelopeHandle }
  | {
      readonly kind: 'requires_attention';
      readonly reason: VerifiedInboxTrialStageAttentionReason;
    };

export type VerifiedInboxTrialRunnerResult =
  | { readonly kind: 'rejected'; readonly reason: VerifiedIngressRejectionReason }
  | {
      readonly kind: 'intake';
      readonly reduction: VerifiedInboxReduction;
      readonly stageOwnership: 'not_adopted' | 'owned';
    }
  | {
      readonly kind: 'deferred';
      readonly reason: 'intake_in_progress' | 'stage_reconciliation_in_progress' | 'stage_expired';
    }
  | {
      readonly kind: 'requires_attention';
      readonly reason: VerifiedInboxTrialStageAttentionReason;
    };

export interface VerifiedInboxTrialRunnerFaults {
  readonly afterStagePut?: () => void;
  readonly afterIntentPrepared?: () => void;
  readonly afterStageAdopt?: () => void;
  readonly sqlite?: SQLiteVerifiedInboxTrialFaults;
  readonly afterSqlCommit?: () => void;
}

export interface VerifiedInboxTrialAttentionItem {
  readonly kind: 'verified_inbox_conflict_attention';
  readonly anchorId: InboxConflictId;
  readonly scope: EventScopeRef;
  readonly state: 'quarantined_changed_content';
  readonly availableAction: 'inspect_inbox_conflict';
}

export class SQLiteVerifiedInboxTrialError extends Error {
  constructor(
    readonly code:
      | 'binding_profile_missing'
      | 'binding_profile_key_mismatch'
      | 'scope_mismatch'
      | 'processing_contract_mismatch'
      | 'unsealed_or_stale_ingress'
      | 'stage_ownership_mismatch'
      | 'state_corrupt',
    message: string
  ) {
    super(message);
    this.name = 'SQLiteVerifiedInboxTrialError';
  }
}

function run(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  return sqlite.query(sql).run(...bindings);
}

function profileIdentity(profile: DefinitionRef<'content_binding'>): string {
  return canonicalJsonText({ key: profile.key, version: profile.version });
}

function keyVerifier(profile: DefinitionRef<'content_binding'>, keyBytes: Uint8Array): string {
  const value = createHmac('sha256', keyBytes)
    .update('jooevents.verified-inbox.key-verifier.v1\0', 'utf8')
    .update(profileIdentity(profile), 'utf8')
    .digest('hex');
  return `ikv1_${value}`;
}

function normalizeProfiles(
  values: SQLiteVerifiedInboxTrialOptions['contentBindingProfiles']
): readonly [StoredBindingProfile, ...StoredBindingProfile[]] {
  if (values.length === 0 || values.length > 8) {
    throw new TypeError('one to eight content binding profiles are required');
  }
  const identities = new Set<string>();
  const profiles = values.map((value) => {
    if (value.profile.kind !== 'content_binding') {
      throw new TypeError('content binding profile kind must be content_binding');
    }
    const profile = definitionRef(
      'content_binding',
      String(value.profile.key),
      Number(value.profile.version)
    );
    if (
      !(value.keyBytes instanceof Uint8Array) ||
      value.keyBytes.byteLength < 32 ||
      value.keyBytes.byteLength > 128
    ) {
      throw new TypeError('content binding key must contain 32 to 128 server-only bytes');
    }
    const identity = profileIdentity(profile);
    if (identities.has(identity)) {
      throw new TypeError('content binding profiles must be unique by key and version');
    }
    identities.add(identity);
    const keyBytes = Uint8Array.from(value.keyBytes);
    return Object.freeze({
      profile,
      keyBytes,
      identity,
      verifier: keyVerifier(profile, keyBytes)
    });
  });
  const primary = profiles[0];
  if (primary === undefined) throw new TypeError('a primary content binding profile is required');
  return Object.freeze([primary, ...profiles.slice(1)]) as readonly [
    StoredBindingProfile,
    ...StoredBindingProfile[]
  ];
}

function milliseconds(value: Instant): number {
  return Date.parse(parseInstant(value));
}

function instant(value: number): Instant {
  if (!Number.isSafeInteger(value)) {
    throw new SQLiteVerifiedInboxTrialError('state_corrupt', 'stored inbox instant is invalid');
  }
  return parseInstant(new Date(value).toISOString());
}

function semanticKey(
  sourceConnectionId: ReturnType<typeof parseSourceConnectionId>,
  semanticIdentity: ReturnType<typeof parseOpaqueInboxSemanticIdentity>
): InboxSemanticKey {
  return canonicalJsonText({ semanticIdentity, sourceConnectionId }) as InboxSemanticKey;
}

function nonEmptyBindings(rows: readonly BindingAliasRow[]): NonEmptyContentBindings {
  const bindings = rows.map((row) =>
    opaqueKeyedContentBinding(row.profile_key, row.profile_version, row.binding_value)
  );
  const primary = bindings[0];
  if (primary === undefined) {
    throw new SQLiteVerifiedInboxTrialError(
      'state_corrupt',
      'stored inbox outcome has no content binding'
    );
  }
  return Object.freeze([primary, ...bindings.slice(1)]) as NonEmptyContentBindings;
}

function frozenScope(scope: EventScopeRef): EventScopeRef {
  if (scope.kind !== 'event') throw new TypeError('verified inbox scope must be an event scope');
  return Object.freeze({
    kind: 'event',
    workspaceId: parseWorkspaceId(scope.workspaceId),
    eventId: parseEventId(scope.eventId)
  });
}

function normalizeProcessingContract(
  value: VerifiedInboxTrialProcessingContract
): VerifiedInboxTrialProcessingContract {
  const verifier = definitionRef(
    'verifier_contract',
    value.verifierContract.key,
    Number(value.verifierContract.version)
  );
  return Object.freeze({
    sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId),
    sourceConnectionRevisionId: parseSourceConnectionRevisionId(value.sourceConnectionRevisionId),
    verifierContract: Object.freeze({ key: verifier.key, version: verifier.version }),
    verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId),
    processor: definitionRef(
      'inbox_processor',
      String(value.processor.key),
      Number(value.processor.version)
    ),
    processorDigestSha256: parseCanonicalSha256(value.processorDigestSha256),
    job: definitionRef('job', String(value.job.key), Number(value.job.version))
  });
}

function processingContractValues(contract: VerifiedInboxTrialProcessingContract) {
  return [
    contract.sourceConnectionId,
    contract.sourceConnectionRevisionId,
    contract.verifierContract.key,
    contract.verifierContract.version,
    contract.verifierRevisionId,
    contract.processor.key,
    contract.processor.version,
    contract.processorDigestSha256,
    contract.job.key,
    contract.job.version
  ] as const;
}

function rowMatchesProcessingContract(
  row: ProcessingContractRow,
  contract: VerifiedInboxTrialProcessingContract
): boolean {
  return row.source_connection_id === contract.sourceConnectionId
    && row.source_connection_revision_id === contract.sourceConnectionRevisionId
    && row.verifier_contract_key === contract.verifierContract.key
    && row.verifier_contract_version === contract.verifierContract.version
    && row.verifier_revision_id === contract.verifierRevisionId
    && row.processor_key === contract.processor.key
    && row.processor_version === contract.processor.version
    && row.processor_digest_sha256 === contract.processorDigestSha256
    && row.job_key === contract.job.key
    && row.job_version === contract.job.version;
}

/** Installs an isolated verified-inbox schema into a caller-owned disposable database. */
export function installSQLiteVerifiedInboxTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(VERIFIED_INBOX_TRIAL_SQL);
}

export class SQLiteVerifiedInboxTrialRepository {
  private readonly profiles: readonly [StoredBindingProfile, ...StoredBindingProfile[]];
  private readonly sealReader: VerifiedEnvelopeSealReader;
  private readonly recovery: VerifiedIngressRecoveryAuthority;
  private readonly processingContract: VerifiedInboxTrialProcessingContract;
  private readonly clock: { now(): string };
  private readonly ids: VerifiedInboxTrialIdFactory;

  constructor(
    private readonly sqlite: Database,
    options: SQLiteVerifiedInboxTrialOptions
  ) {
    sqlite.exec('PRAGMA foreign_keys = ON;');
    this.profiles = normalizeProfiles(options.contentBindingProfiles);
    this.sealReader = options.sealReader;
    this.recovery = options.recovery;
    this.processingContract = normalizeProcessingContract(options.processingContract);
    this.clock = options.clock ?? Object.freeze({ now: () => new Date().toISOString() });
    this.ids = Object.freeze({
      newReceiptId: options.ids?.newReceiptId ?? (() => crypto.randomUUID()),
      newProcessingPointerId: options.ids?.newProcessingPointerId ?? (() => crypto.randomUUID()),
      newConflictId: options.ids?.newConflictId ?? (() => crypto.randomUUID()),
      newAttentionId: options.ids?.newAttentionId ?? (() => crypto.randomUUID()),
      newPayloadRefId: options.ids?.newPayloadRefId ?? (() => crypto.randomUUID()),
      newIntentId: options.ids?.newIntentId ?? (() => crypto.randomUUID())
    });
    this.validateAndRegisterProfiles();
    this.validateAndRegisterProcessingContract();
  }

  /** Same/known-changed returns without an intent or stage adoption fence. */
  preflight(handle: VerifiedEnvelopeHandle): VerifiedInboxTrialPreflightResult {
    const transaction = this.sqlite.transaction(() => {
      const material = this.sealReader.openCurrentStaged(handle);
      if (!material) {
        throw new SQLiteVerifiedInboxTrialError(
          'unsealed_or_stale_ingress',
          'verified inbox preflight requires a current authentic staged envelope'
        );
      }
      const payloadRefId = parsePayloadRefId(this.ids.newPayloadRefId());
      const { intake, scope } = this.intakeForMaterial(material, payloadRefId);
      this.assertExistingScope(intake, scope);
      const reduction = reduceVerifiedInbox(this.readState(), intake);
      if (!reduction.created.receipt && !reduction.created.conflict) {
        return Object.freeze({ kind: 'known' as const, reduction });
      }
      const cleanupClaim = this.sqlite.query<{ stage_id: string }, [string]>(`
        SELECT stage_id FROM verified_inbox_stage_cleanup_claims_trial WHERE stage_id = ?
      `).get(material.stage.stageId);
      if (cleanupClaim) return Object.freeze({ kind: 'cleanup_claimed' as const });
      if (parseInstant(this.clock.now()) >= material.stage.expiresAt) {
        return Object.freeze({ kind: 'stage_expired' as const });
      }
      const contended = this.sqlite.query<{ intent_id: string }, [string, string]>(`
        SELECT intent_id
        FROM verified_inbox_intake_intents_trial
        WHERE source_connection_id = ? AND semantic_identity = ?
      `).get(material.sourceConnectionId, material.semanticIdentity);
      if (contended) return Object.freeze({ kind: 'contended' as const });
      const intent = this.recovery.prepare({
        handle,
        intentId: this.ids.newIntentId(),
        payloadRefId
      });
      this.insertIntent(intent);
      return Object.freeze({
        kind: 'adoption_required' as const,
        predicted: reduction.kind === 'new' ? 'new' as const : 'changed' as const,
        payloadRefId
      });
    });
    return transaction.immediate();
  }

  /**
   * Final canonical reduction. The seal is opened and current configuration is
   * rechecked inside BEGIN IMMEDIATE after the stage adoption fence was acquired.
   */
  finalize(
    handle: AdoptedVerifiedEnvelopeHandle,
    faults?: SQLiteVerifiedInboxTrialFaults
  ): VerifiedInboxTrialFinalizationResult {
    const transaction = this.sqlite.transaction(() => {
      const material = this.sealReader.openCurrentAdopted(handle);
      if (!material) {
        throw new SQLiteVerifiedInboxTrialError(
          'unsealed_or_stale_ingress',
          'verified inbox finalization requires a current authentic adopted envelope'
        );
      }
      this.assertAdoptedContinuation(material);
      const retainedAttention = this.readStageAttention(material.adoptedStage);
      if (retainedAttention) {
        return Object.freeze({
          kind: 'requires_attention' as const,
          reason: retainedAttention.reason
        });
      }
      const intentRow = this.readIntentByStage(material.adoptedStage.stageId);
      if (!intentRow) {
        throw new SQLiteVerifiedInboxTrialError(
          'stage_ownership_mismatch',
          'adopted verified ingress has no durable pre-adoption intent'
        );
      }
      const verification = this.recovery.verifyCurrent(this.intentValue(intentRow));
      if (verification.kind !== 'verified') {
        const reason = verification.kind === 'stale_registration'
          ? 'stale_registration' as const
          : 'invalid_intent' as const;
        const retainedReason = this.recordStageAttention(
          material.adoptedStage,
          reason
        );
        return Object.freeze({ kind: 'requires_attention' as const, reason: retainedReason });
      }
      const intent = verification.intent;
      if (!this.intentRowMatches(intentRow, intent)) {
        const reason = this.recordStageAttention(material.adoptedStage, 'invalid_intent');
        return Object.freeze({ kind: 'requires_attention' as const, reason });
      }
      if (!this.materialMatchesIntent(material, intent.record)) {
        const reason = this.recordStageAttention(material.adoptedStage, 'stage_state_mismatch');
        return Object.freeze({
          kind: 'requires_attention' as const,
          reason
        });
      }
      const { intake, scope } = this.intakeForIntent(intent.record);
      this.assertExistingScope(intake, scope);
      const reduction = reduceVerifiedInbox(this.readState(), intake);
      if (reduction.created.receipt) {
        this.persistNew(reduction, scope, material, faults);
        this.insertStageOwnership(material, reduction, 'adopted');
        this.deleteIntent(intent.record.intentId);
        return Object.freeze({ kind: 'finalized' as const, reduction, stageOwnership: 'owned' as const });
      }
      if (reduction.created.conflict) {
        this.persistConflict(reduction, faults);
        this.insertStageOwnership(material, reduction, 'quarantined');
        this.deleteIntent(intent.record.intentId);
        return Object.freeze({ kind: 'finalized' as const, reduction, stageOwnership: 'owned' as const });
      }
      throw new SQLiteVerifiedInboxTrialError(
        'stage_ownership_mismatch',
        'an adopted intent must create exactly one canonical inbox outcome'
      );
    });
    return transaction.immediate();
  }

  private insertIntent(intent: VerifiedIngressDurableIntent): void {
    const record = intent.record;
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_intake_intents_trial
         (intent_id, record_version, stage_id, stage_expected_version, stage_fence,
          payload_ref_id, source_connection_id, semantic_identity, record_json,
          authenticator, created_at_ms)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.intentId,
      record.stage.stageId,
      Number(record.stage.expectedVersion),
      Number(record.stage.fence),
      record.payloadRefId,
      record.configuration.sourceConnectionId,
      record.semanticIdentity,
      canonicalJsonText(record),
      intent.authenticator,
      milliseconds(parseInstant(this.clock.now()))
    );
  }

  private readIntentByStage(stageId: string): IntakeIntentRow | null {
    return this.sqlite.query<IntakeIntentRow, [string]>(`
      SELECT intent_id, record_version, stage_id, stage_expected_version, stage_fence,
             payload_ref_id, source_connection_id, semantic_identity, record_json,
             authenticator, created_at_ms
      FROM verified_inbox_intake_intents_trial
      WHERE stage_id = ?
    `).get(parsePayloadStageId(stageId));
  }

  private intentValue(row: IntakeIntentRow): unknown {
    try {
      return Object.freeze({ record: JSON.parse(row.record_json) as unknown, authenticator: row.authenticator });
    } catch {
      return Object.freeze({ record: null, authenticator: row.authenticator });
    }
  }

  private intentRowMatches(row: IntakeIntentRow, intent: VerifiedIngressDurableIntent): boolean {
    const record = intent.record;
    return row.intent_id === record.intentId && row.record_version === record.version &&
      row.stage_id === record.stage.stageId &&
      row.stage_expected_version === Number(record.stage.expectedVersion) &&
      row.stage_fence === Number(record.stage.fence) &&
      row.payload_ref_id === record.payloadRefId &&
      row.source_connection_id === record.configuration.sourceConnectionId &&
      row.semantic_identity === record.semanticIdentity &&
      row.record_json === canonicalJsonText(record) && row.authenticator === intent.authenticator;
  }

  private materialMatchesIntent(
    material: SealedAdoptedVerifiedEnvelopeMaterial,
    record: VerifiedIngressDurableIntentRecord
  ): boolean {
    return material.sourceConnectionId === record.configuration.sourceConnectionId &&
      material.sourceConnectionRevisionId === record.configuration.sourceConnectionRevisionId &&
      material.verifierRevisionId === record.configuration.verifierRevisionId &&
      canonicalJsonText(material.binding) === canonicalJsonText(record.configuration.binding) &&
      canonicalJsonText(material.scope) === canonicalJsonText(record.configuration.scope) &&
      canonicalJsonText(material.verifierContract) === canonicalJsonText(record.configuration.verifierContract) &&
      canonicalJsonText(material.configuration) === canonicalJsonText(record.configuration) &&
      material.semanticIdentity === record.semanticIdentity &&
      canonicalJsonText(material.contentBindings) === canonicalJsonText(record.contentBindings) &&
      canonicalJsonText(material.stage) === canonicalJsonText(record.stage) &&
      material.payloadRef.id === record.payloadRefId && material.receivedAt === record.receivedAt;
  }

  private deleteIntent(intentId: string): void {
    const result = run(
      this.sqlite,
      'DELETE FROM verified_inbox_intake_intents_trial WHERE intent_id = ?',
      intentId
    );
    if (result.changes !== 1) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'finalized verified inbox intent was not deleted exactly once'
      );
    }
  }

  private readStageAttention(
    stage: StageCleanupBinding
  ): StageAttentionRow | null {
    const stored = this.sqlite.query<StageAttentionRow, [string]>(`
      SELECT stage_id, stage_expected_version, stage_fence, reason, recorded_at_ms
      FROM verified_inbox_stage_attentions_trial
      WHERE stage_id = ?
    `).get(stage.stageId);
    if (stored && (stored.stage_expected_version !== Number(stage.expectedVersion) ||
      stored.stage_fence !== Number(stage.fence))) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'durable stage attention does not match the authenticated stage fence'
      );
    }
    return stored;
  }

  private recordStageAttention(
    stage: StageCleanupBinding,
    reason: StageAttentionRow['reason']
  ): VerifiedInboxTrialStageAttentionReason {
    run(
      this.sqlite,
      `INSERT OR IGNORE INTO verified_inbox_stage_attentions_trial
         (stage_id, stage_expected_version, stage_fence, reason, recorded_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      stage.stageId,
      Number(stage.expectedVersion),
      Number(stage.fence),
      reason,
      milliseconds(parseInstant(this.clock.now()))
    );
    const stored = this.readStageAttention(stage);
    if (!stored) throw new SQLiteVerifiedInboxTrialError('state_corrupt', 'stage attention was not retained');
    return stored.reason;
  }

  resolveStageOwnership(inspection: PayloadStageInspection): VerifiedInboxTrialStageOwnership {
    const stageId = parsePayloadStageId(inspection.stage.stageId);
    const row = this.sqlite.query<StageOwnershipRow, [string]>(`
      SELECT stage_id, stage_expected_version, stage_fence, payload_ref_id,
             payload_disposition, outcome_kind, outcome_id
      FROM verified_inbox_stage_ownership_trial
      WHERE stage_id = ?
    `).get(stageId);
    if (!row) {
      if (inspection.payloadRef) {
        const claimed = this.sqlite.query<{ stage_id: string }, [string]>(`
          SELECT stage_id FROM verified_inbox_stage_ownership_trial WHERE payload_ref_id = ?
        `).get(inspection.payloadRef.id);
        if (claimed) {
          throw new SQLiteVerifiedInboxTrialError(
            'stage_ownership_mismatch',
            'payload reference is canonically owned by a different stage'
          );
        }
      }
      return Object.freeze({ kind: 'proven_unowned' });
    }
    if (
      !inspection.payloadRef ||
      row.payload_ref_id !== inspection.payloadRef.id ||
      row.stage_expected_version !== Number(inspection.stage.expectedVersion) ||
      row.stage_fence !== Number(inspection.stage.fence)
    ) {
      throw new SQLiteVerifiedInboxTrialError(
        'stage_ownership_mismatch',
        'authenticated stage continuation does not match canonical SQL ownership'
      );
    }
    return Object.freeze({
      kind: 'owned',
      payloadRef: createPayloadRef(parsePayloadRefId(row.payload_ref_id)),
      disposition: row.payload_disposition
    });
  }

  async recoverIntent(inspection: PayloadStageInspection): Promise<VerifiedInboxTrialIntentRecovery> {
    const attention = this.readStageAttention(inspection.stage);
    if (attention) {
      return Object.freeze({ kind: 'requires_attention', reason: attention.reason });
    }
    const row = this.readIntentByStage(inspection.stage.stageId);
    if (!row) return Object.freeze({ kind: 'none' });
    const recovered = await this.recovery.reseal({
      intent: this.intentValue(row),
      candidate: Object.freeze({
        stageId: inspection.stage.stageId,
        expectedVersion: inspection.stage.expectedVersion,
        fence: inspection.stage.fence,
        expiresAt: inspection.stage.expiresAt,
        reconciliationPolicy: inspection.stage.reconciliationPolicy
      })
    });
    if (recovered.kind === 'stale_registration' || recovered.kind === 'invalid') {
      const reason = recovered.kind === 'stale_registration'
        ? 'stale_registration' as const
        : 'invalid_intent' as const;
      const transaction = this.sqlite.transaction(() => this.recordStageAttention(inspection.stage, reason));
      const retainedReason = transaction.immediate();
      return Object.freeze({ kind: 'requires_attention', reason: retainedReason });
    }
    const verification = this.recovery.verifyCurrent(this.intentValue(row));
    if (verification.kind !== 'verified' || !this.intentRowMatches(row, verification.intent)) {
      const transaction = this.sqlite.transaction(() =>
        this.recordStageAttention(inspection.stage, 'invalid_intent')
      );
      const reason = transaction.immediate();
      return Object.freeze({ kind: 'requires_attention', reason });
    }
    return recovered.kind === 'staged'
      ? Object.freeze({
          kind: 'staged',
          handle: recovered.handle,
          payloadRefId: verification.intent.record.payloadRefId
        })
      : Object.freeze({ kind: 'adoption_pending', handle: recovered.handle });
  }

  retainUnownedAdoptionPending(inspection: PayloadStageInspection): VerifiedInboxTrialIntentRecovery {
    if (inspection.state !== 'adoption_pending' || !inspection.payloadRef) {
      throw new SQLiteVerifiedInboxTrialError(
        'stage_ownership_mismatch',
        'only an authenticated unowned adoption_pending stage can require intervention'
      );
    }
    const transaction = this.sqlite.transaction(() => {
      if (this.resolveStageOwnership(inspection).kind !== 'proven_unowned' ||
        this.readIntentByStage(inspection.stage.stageId)) {
        throw new SQLiteVerifiedInboxTrialError(
          'stage_ownership_mismatch',
          'owned or intent-anchored stages cannot be recorded as orphaned'
        );
      }
      return this.recordStageAttention(inspection.stage, 'unowned_adoption_pending');
    });
    const reason = transaction.immediate();
    return Object.freeze({ kind: 'requires_attention', reason });
  }

  retainIntentAdoptionRefusal(inspection: PayloadStageInspection): VerifiedInboxTrialIntentRecovery {
    const transaction = this.sqlite.transaction(() => {
      if (this.resolveStageOwnership(inspection).kind !== 'proven_unowned' ||
        !this.readIntentByStage(inspection.stage.stageId)) {
        throw new SQLiteVerifiedInboxTrialError(
          'stage_ownership_mismatch',
          'only an intent-anchored stage without canonical ownership can retain adoption refusal'
        );
      }
      return this.recordStageAttention(inspection.stage, 'intent_adoption_refused');
    });
    const reason = transaction.immediate();
    return Object.freeze({ kind: 'requires_attention', reason });
  }

  /**
   * Exact canonical lookup used only by the application-owned purge authority.
   * The unadopted result and durable cleanup claim are formed atomically.
   */
  resolveStagePurgeOwnership(
    candidate: PayloadStageReconciliationCandidate
  ): CanonicalPayloadStageOwnership {
    let stage: StageCleanupBinding;
    try {
      stage = Object.freeze({
        stageId: parsePayloadStageId(candidate.stageId),
        expectedVersion: candidate.expectedVersion,
        fence: candidate.fence,
        expiresAt: parseInstant(candidate.expiresAt),
        reconciliationPolicy: Object.freeze({
          key: candidate.reconciliationPolicy.key,
          version: candidate.reconciliationPolicy.version
        })
      });
    } catch {
      return Object.freeze({ kind: 'uncertain' });
    }
    const checkedAt = parseInstant(this.clock.now());
    if (checkedAt < stage.expiresAt) return Object.freeze({ kind: 'uncertain' });

    const transaction = this.sqlite.transaction((): CanonicalPayloadStageOwnership => {
      const ownership = this.sqlite.query<{
        stage_expected_version: number;
        stage_fence: number;
      }, [string]>(`
        SELECT stage_expected_version, stage_fence
        FROM verified_inbox_stage_ownership_trial
        WHERE stage_id = ?
      `).get(stage.stageId);
      if (ownership) {
        return ownership.stage_expected_version === Number(stage.expectedVersion) &&
          ownership.stage_fence === Number(stage.fence)
          ? Object.freeze({ kind: 'adopted' as const })
          : Object.freeze({ kind: 'uncertain' as const });
      }
      if (this.readIntentByStage(stage.stageId) !== null || this.readStageAttention(stage) !== null) {
        return Object.freeze({ kind: 'uncertain' as const });
      }

      const existingClaim = this.sqlite.query<{
        stage_expected_version: number;
        stage_fence: number;
        stage_expires_at_ms: number;
        reconciliation_policy_key: string;
        reconciliation_policy_version: number;
      }, [string]>(`
        SELECT stage_expected_version, stage_fence, stage_expires_at_ms,
               reconciliation_policy_key, reconciliation_policy_version
        FROM verified_inbox_stage_cleanup_claims_trial
        WHERE stage_id = ?
      `).get(stage.stageId);
      if (existingClaim) {
        return existingClaim.stage_expected_version === Number(stage.expectedVersion) &&
          existingClaim.stage_fence === Number(stage.fence) &&
          existingClaim.stage_expires_at_ms === milliseconds(stage.expiresAt) &&
          existingClaim.reconciliation_policy_key === stage.reconciliationPolicy.key &&
          existingClaim.reconciliation_policy_version === Number(stage.reconciliationPolicy.version)
          ? Object.freeze({ kind: 'unadopted' as const })
          : Object.freeze({ kind: 'uncertain' as const });
      }

      run(
        this.sqlite,
        `INSERT INTO verified_inbox_stage_cleanup_claims_trial
           (stage_id, stage_expected_version, stage_fence, stage_expires_at_ms,
            reconciliation_policy_key, reconciliation_policy_version, claimed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        stage.stageId,
        Number(stage.expectedVersion),
        Number(stage.fence),
        milliseconds(stage.expiresAt),
        stage.reconciliationPolicy.key,
        Number(stage.reconciliationPolicy.version),
        milliseconds(checkedAt)
      );
      return Object.freeze({ kind: 'unadopted' as const });
    });
    return transaction.immediate();
  }

  retainStageCleanupUncertainty(
    stage: StageCleanupBinding
  ): { readonly kind: 'requires_attention'; readonly reason: VerifiedInboxTrialStageAttentionReason } {
    const transaction = this.sqlite.transaction(() =>
      this.recordStageAttention(stage, 'cleanup_ownership_uncertain')
    );
    const reason = transaction.immediate();
    return Object.freeze({ kind: 'requires_attention', reason });
  }

  releaseStageCleanupClaim(candidate: PayloadStageReconciliationCandidate): void {
    const result = run(
      this.sqlite,
      `DELETE FROM verified_inbox_stage_cleanup_claims_trial
       WHERE stage_id = ? AND stage_expected_version = ? AND stage_fence = ?
         AND stage_expires_at_ms = ? AND reconciliation_policy_key = ?
         AND reconciliation_policy_version = ?`,
      parsePayloadStageId(candidate.stageId),
      Number(candidate.expectedVersion),
      Number(candidate.fence),
      milliseconds(parseInstant(candidate.expiresAt)),
      candidate.reconciliationPolicy.key,
      Number(candidate.reconciliationPolicy.version)
    );
    if (result.changes !== 1) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'the exact stage cleanup claim was not released once'
      );
    }
  }

  private intakeForMaterial(
    material: SealedVerifiedEnvelopeMaterial,
    payloadRefId: PayloadRefId
  ): { readonly intake: VerifiedInboxIntake; readonly scope: EventScopeRef } {
    const scope = frozenScope(material.scope);
    if (material.contentBindings.length !== this.profiles.length) {
      throw new SQLiteVerifiedInboxTrialError(
        'binding_profile_missing',
        'sealed ingress aliases must contain every configured retained profile'
      );
    }
    const bindings = material.contentBindings.map((binding, index) => {
      const expected = this.profiles[index];
      if (
        !expected ||
        binding.profile.key !== expected.profile.key ||
        Number(binding.profile.version) !== Number(expected.profile.version)
      ) {
        throw new SQLiteVerifiedInboxTrialError(
          'binding_profile_missing',
          'sealed ingress alias profiles do not match configured retained profiles'
        );
      }
      if (binding.keyVerifier !== expected.verifier) {
        throw new SQLiteVerifiedInboxTrialError(
          'binding_profile_key_mismatch',
          'sealed ingress alias key does not match the configured server-only key'
        );
      }
      return opaqueKeyedContentBinding(
        String(expected.profile.key),
        Number(expected.profile.version),
        binding.value
      );
    });
    const primary = bindings[0];
    if (!primary) {
      throw new SQLiteVerifiedInboxTrialError(
        'binding_profile_missing',
        'sealed ingress requires at least one content binding'
      );
    }
    const intake: VerifiedInboxIntake = Object.freeze({
      receiptId: parseIntegrationInboxReceiptId(this.ids.newReceiptId()),
      processingPointerId: parseInboxProcessingPointerId(this.ids.newProcessingPointerId()),
      conflictId: parseInboxConflictId(this.ids.newConflictId()),
      attentionId: parseInboxAttentionId(this.ids.newAttentionId()),
      sourceConnectionId: parseSourceConnectionId(material.sourceConnectionId),
      sourceConnectionRevisionId: parseSourceConnectionRevisionId(
        material.sourceConnectionRevisionId
      ),
      semanticIdentity: parseOpaqueInboxSemanticIdentity(material.semanticIdentity),
      verifierRevisionId: parseVerifierRevisionId(material.verifierRevisionId),
      contentBindings: Object.freeze([primary, ...bindings.slice(1)]) as NonEmptyContentBindings,
      preparedPayloadRef: createPayloadRef(parsePayloadRefId(payloadRefId)),
      receivedAt: parseInstant(material.receivedAt)
    });
    return { intake, scope };
  }

  private intakeForIntent(
    record: VerifiedIngressDurableIntentRecord
  ): { readonly intake: VerifiedInboxIntake; readonly scope: EventScopeRef } {
    const scope = frozenScope(record.configuration.scope);
    if (record.contentBindings.length !== this.profiles.length) {
      throw new SQLiteVerifiedInboxTrialError(
        'binding_profile_missing',
        'durable ingress aliases must contain every configured retained profile'
      );
    }
    const bindings = record.contentBindings.map((binding, index) => {
      const expected = this.profiles[index];
      if (!expected || binding.profile.key !== expected.profile.key ||
        Number(binding.profile.version) !== Number(expected.profile.version)) {
        throw new SQLiteVerifiedInboxTrialError(
          'binding_profile_missing',
          'durable ingress alias profiles do not match configured retained profiles'
        );
      }
      if (binding.keyVerifier !== expected.verifier) {
        throw new SQLiteVerifiedInboxTrialError(
          'binding_profile_key_mismatch',
          'durable ingress alias key does not match the configured server-only key'
        );
      }
      return opaqueKeyedContentBinding(
        String(expected.profile.key), Number(expected.profile.version), binding.value
      );
    });
    const primary = bindings[0];
    if (!primary) {
      throw new SQLiteVerifiedInboxTrialError(
        'binding_profile_missing',
        'durable ingress requires at least one content binding'
      );
    }
    return Object.freeze({
      scope,
      intake: Object.freeze({
        receiptId: parseIntegrationInboxReceiptId(this.ids.newReceiptId()),
        processingPointerId: parseInboxProcessingPointerId(this.ids.newProcessingPointerId()),
        conflictId: parseInboxConflictId(this.ids.newConflictId()),
        attentionId: parseInboxAttentionId(this.ids.newAttentionId()),
        sourceConnectionId: parseSourceConnectionId(record.configuration.sourceConnectionId),
        sourceConnectionRevisionId: parseSourceConnectionRevisionId(
          record.configuration.sourceConnectionRevisionId
        ),
        semanticIdentity: parseOpaqueInboxSemanticIdentity(record.semanticIdentity),
        verifierRevisionId: parseVerifierRevisionId(record.configuration.verifierRevisionId),
        contentBindings: Object.freeze([primary, ...bindings.slice(1)]) as NonEmptyContentBindings,
        preparedPayloadRef: createPayloadRef(record.payloadRefId),
        receivedAt: parseInstant(record.receivedAt)
      })
    });
  }

  private assertAdoptedContinuation(material: SealedAdoptedVerifiedEnvelopeMaterial): void {
    const staged = material.stage;
    const adopted = material.adoptedStage;
    if (
      adopted.stageId !== staged.stageId ||
      Number(adopted.expectedVersion) !== Number(staged.expectedVersion) + 1 ||
      Number(adopted.fence) !== Number(staged.fence) + 1 ||
      adopted.expiresAt !== staged.expiresAt ||
      canonicalJsonText(adopted.reconciliationPolicy) !== canonicalJsonText(staged.reconciliationPolicy) ||
      canonicalJsonText(adopted.authenticationProfile) !== canonicalJsonText(staged.authenticationProfile)
    ) {
      throw new SQLiteVerifiedInboxTrialError(
        'stage_ownership_mismatch',
        'adopted ingress seal does not contain the exact next stage fence'
      );
    }
  }

  private insertStageOwnership(
    material: SealedAdoptedVerifiedEnvelopeMaterial,
    reduction: VerifiedInboxReduction,
    disposition: 'adopted' | 'quarantined'
  ): void {
    const outcomeKind = disposition === 'adopted' ? 'receipt' : 'conflict';
    const outcomeId = disposition === 'adopted'
      ? reduction.receipt.id
      : reduction.conflict?.id;
    if (!outcomeId) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'stage ownership requires the exact created inbox outcome'
      );
    }
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_stage_ownership_trial
         (stage_id, stage_expected_version, stage_fence, payload_ref_id,
          payload_disposition, outcome_kind, outcome_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      material.adoptedStage.stageId,
      Number(material.adoptedStage.expectedVersion),
      Number(material.adoptedStage.fence),
      material.payloadRef.id,
      disposition,
      outcomeKind,
      outcomeId
    );
  }

  readState(): VerifiedInboxState {
    const receiptRows = this.sqlite.query<ReceiptRow, []>(`
      SELECT receipt_id, source_connection_id, source_connection_revision_id,
             semantic_identity, verifier_revision_id, adopted_payload_ref_id,
             workspace_id, event_id, received_at_ms
      FROM verified_inbox_receipts_trial
      ORDER BY received_at_ms, receipt_id
    `).all();
    if (receiptRows.length === 0) {
      const strayCount = this.sqlite.query<{ total: number }, []>(`
        SELECT
          (SELECT count(*) FROM verified_inbox_payload_refs_trial)
          + (SELECT count(*) FROM verified_inbox_stage_ownership_trial)
          + (SELECT count(*) FROM verified_inbox_conflicts_trial)
          + (SELECT count(*) FROM verified_inbox_binding_aliases_trial)
          + (SELECT count(*) FROM verified_inbox_receipt_processing_contracts_trial)
          + (SELECT count(*) FROM verified_inbox_processing_pointers_trial)
          + (SELECT count(*) FROM verified_inbox_attentions_trial) AS total
      `).get()?.total ?? 0;
      if (strayCount !== 0) {
        throw new SQLiteVerifiedInboxTrialError(
          'state_corrupt',
          'verified inbox contains children without a receipt'
        );
      }
      return EMPTY_VERIFIED_INBOX_STATE;
    }

    const receipts: InboxReceipt[] = receiptRows.map((row) => {
      const sourceConnectionId = parseSourceConnectionId(row.source_connection_id);
      const semanticIdentity = parseOpaqueInboxSemanticIdentity(row.semantic_identity);
      return Object.freeze({
        id: parseIntegrationInboxReceiptId(row.receipt_id),
        semanticKey: semanticKey(sourceConnectionId, semanticIdentity),
        sourceConnectionId,
        sourceConnectionRevisionId: parseSourceConnectionRevisionId(
          row.source_connection_revision_id
        ),
        semanticIdentity,
        verifierRevisionId: parseVerifierRevisionId(row.verifier_revision_id),
        contentBindings: this.readBindings('receipt', row.receipt_id),
        adoptedPayloadRef: createPayloadRef(parsePayloadRefId(row.adopted_payload_ref_id)),
        receivedAt: instant(row.received_at_ms)
      });
    });
    const processingContractCount = this.sqlite.query<{ total: number }, []>(`
      SELECT count(*) AS total FROM verified_inbox_receipt_processing_contracts_trial
    `).get()?.total ?? 0;
    if (processingContractCount !== receipts.length) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'every verified inbox receipt must freeze exactly one processing contract'
      );
    }

    const conflictRows = this.sqlite.query<ConflictRow, []>(`
      SELECT conflict_id, receipt_id, source_connection_revision_id,
             verifier_revision_id, quarantined_payload_ref_id, observed_at_ms
      FROM verified_inbox_conflicts_trial
      ORDER BY observed_at_ms, conflict_id
    `).all();
    const conflicts: InboxConflict[] = conflictRows.map((row) => Object.freeze({
      id: parseInboxConflictId(row.conflict_id),
      receiptId: parseIntegrationInboxReceiptId(row.receipt_id),
      sourceConnectionRevisionId: parseSourceConnectionRevisionId(
        row.source_connection_revision_id
      ),
      verifierRevisionId: parseVerifierRevisionId(row.verifier_revision_id),
      contentBindings: this.readBindings('conflict', row.conflict_id),
      quarantinedPayloadRef: createPayloadRef(parsePayloadRefId(row.quarantined_payload_ref_id)),
      observedAt: instant(row.observed_at_ms)
    }));

    const processingPointers: InboxProcessingPointer[] = this.sqlite
      .query<ProcessingPointerRow, []>(`
        SELECT processing_pointer_id, receipt_id, created_at_ms
        FROM verified_inbox_processing_pointers_trial
        ORDER BY created_at_ms, processing_pointer_id
      `)
      .all()
      .map((row) => Object.freeze({
        id: parseInboxProcessingPointerId(row.processing_pointer_id),
        receiptId: parseIntegrationInboxReceiptId(row.receipt_id),
        createdAt: instant(row.created_at_ms)
      }));

    const attentions: InboxAttention[] = this.sqlite
      .query<AttentionRow, []>(`
        SELECT attention_id, conflict_id, created_at_ms
        FROM verified_inbox_attentions_trial
        ORDER BY created_at_ms, attention_id
      `)
      .all()
      .map((row) => Object.freeze({
        id: parseInboxAttentionId(row.attention_id),
        conflictId: parseInboxConflictId(row.conflict_id),
        createdAt: instant(row.created_at_ms)
      }));

    const payloadRows = this.sqlite.query<PayloadRefRow, []>(`
      SELECT payload_ref_id, disposition
      FROM verified_inbox_payload_refs_trial
      ORDER BY recorded_at_ms, payload_ref_id
    `).all();
    const adoptedPayloadRefs = payloadRows
      .filter((row) => row.disposition === 'adopted')
      .map((row) => createPayloadRef(parsePayloadRefId(row.payload_ref_id)));
    const quarantinedPayloadRefs = payloadRows
      .filter((row) => row.disposition === 'quarantined')
      .map((row) => createPayloadRef(parsePayloadRefId(row.payload_ref_id)));

    return Object.freeze({
      receipts: Object.freeze(receipts),
      processingPointers: Object.freeze(processingPointers),
      conflicts: Object.freeze(conflicts),
      attentions: Object.freeze(attentions),
      adoptedPayloadRefs: Object.freeze(adoptedPayloadRefs),
      quarantinedPayloadRefs: Object.freeze(quarantinedPayloadRefs)
    });
  }

  readAttention(input: {
    readonly viewerKey: string;
    readonly mayView: (viewerKey: string, scope: EventScopeRef) => boolean;
  }): readonly VerifiedInboxTrialAttentionItem[] {
    if (
      input.viewerKey.length === 0 ||
      input.viewerKey.length > 160 ||
      input.viewerKey.trim() !== input.viewerKey
    ) {
      throw new TypeError('attention viewer key must be bounded and non-empty');
    }
    const rows = this.sqlite.query<AttentionProjectionRow, []>(`
      SELECT c.conflict_id, r.workspace_id, r.event_id
      FROM verified_inbox_attentions_trial a
      JOIN verified_inbox_conflicts_trial c ON c.conflict_id = a.conflict_id
      JOIN verified_inbox_receipts_trial r ON r.receipt_id = c.receipt_id
      ORDER BY a.created_at_ms, a.attention_id
    `).all();

    const result: VerifiedInboxTrialAttentionItem[] = [];
    for (const row of rows) {
      const scope: EventScopeRef = Object.freeze({
        kind: 'event',
        workspaceId: parseWorkspaceId(row.workspace_id),
        eventId: parseEventId(row.event_id)
      });
      if (!input.mayView(input.viewerKey, scope)) continue;
      result.push(Object.freeze({
        kind: 'verified_inbox_conflict_attention',
        anchorId: parseInboxConflictId(row.conflict_id),
        scope,
        state: 'quarantined_changed_content',
        availableAction: 'inspect_inbox_conflict'
      }));
    }
    return Object.freeze(result);
  }

  readProcessingContract(
    receiptId: ReturnType<typeof parseIntegrationInboxReceiptId>
  ): VerifiedInboxTrialProcessingContract | null {
    const row = this.sqlite.query<ProcessingContractRow, [string]>(`
      SELECT source_connection_id, source_connection_revision_id,
             verifier_contract_key, verifier_contract_version, verifier_revision_id,
             processor_key, processor_version, processor_digest_sha256,
             job_key, job_version
      FROM verified_inbox_receipt_processing_contracts_trial
      WHERE receipt_id = ?
    `).get(parseIntegrationInboxReceiptId(receiptId));
    if (!row) return null;
    return normalizeProcessingContract({
      sourceConnectionId: parseSourceConnectionId(row.source_connection_id),
      sourceConnectionRevisionId: parseSourceConnectionRevisionId(
        row.source_connection_revision_id
      ),
      verifierContract: {
        key: row.verifier_contract_key,
        version: parseContractVersion(row.verifier_contract_version)
      },
      verifierRevisionId: parseVerifierRevisionId(row.verifier_revision_id),
      processor: definitionRef(
        'inbox_processor', row.processor_key, row.processor_version
      ),
      processorDigestSha256: parseCanonicalSha256(row.processor_digest_sha256),
      job: definitionRef('job', row.job_key, row.job_version)
    });
  }

  private validateAndRegisterProcessingContract(): void {
    const contract = this.processingContract;
    const transaction = this.sqlite.transaction(() => {
      const row = this.sqlite.query<ProcessingContractRow, [string, string]>(`
        SELECT source_connection_id, source_connection_revision_id,
               verifier_contract_key, verifier_contract_version, verifier_revision_id,
               processor_key, processor_version, processor_digest_sha256,
               job_key, job_version
        FROM verified_inbox_source_processor_mappings_trial
        WHERE source_connection_id = ? AND source_connection_revision_id = ?
      `).get(contract.sourceConnectionId, contract.sourceConnectionRevisionId);
      if (row) {
        if (!rowMatchesProcessingContract(row, contract)) {
          throw new SQLiteVerifiedInboxTrialError(
            'processing_contract_mismatch',
            'an exact source connection revision cannot rotate its inbox processor mapping'
          );
        }
        return;
      }
      run(
        this.sqlite,
        `INSERT INTO verified_inbox_source_processor_mappings_trial (
          source_connection_id, source_connection_revision_id,
          verifier_contract_key, verifier_contract_version, verifier_revision_id,
          processor_key, processor_version, processor_digest_sha256,
          job_key, job_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...processingContractValues(contract)
      );
    });
    transaction.immediate();
  }

  private validateAndRegisterProfiles(): void {
    const transaction = this.sqlite.transaction(() => {
      const configured = new Map(this.profiles.map((profile) => [profile.identity, profile]));
      const rows = this.sqlite.query<BindingProfileRow, []>(`
        SELECT profile_key, profile_version, key_verifier
        FROM verified_inbox_binding_profiles_trial
        ORDER BY profile_key, profile_version
      `).all();
      for (const row of rows) {
        const identity = profileIdentity(
          definitionRef('content_binding', row.profile_key, row.profile_version)
        );
        const supplied = configured.get(identity);
        if (supplied === undefined) {
          throw new SQLiteVerifiedInboxTrialError(
            'binding_profile_missing',
            'every persisted inbox binding profile must retain its server-only key'
          );
        }
        if (supplied.verifier !== row.key_verifier) {
          throw new SQLiteVerifiedInboxTrialError(
            'binding_profile_key_mismatch',
            'persisted inbox binding profile does not match the supplied server-only key'
          );
        }
      }
      const stored = new Set(rows.map((row) =>
        profileIdentity(definitionRef('content_binding', row.profile_key, row.profile_version))
      ));
      for (const profile of this.profiles) {
        if (stored.has(profile.identity)) continue;
        run(
          this.sqlite,
          `INSERT INTO verified_inbox_binding_profiles_trial
             (profile_key, profile_version, key_verifier)
           VALUES (?, ?, ?)`,
          profile.profile.key,
          profile.profile.version,
          profile.verifier
        );
      }
    });
    transaction.immediate();
  }

  private readBindings(
    outcomeKind: 'receipt' | 'conflict',
    outcomeId: string
  ): NonEmptyContentBindings {
    const rows = this.sqlite.query<BindingAliasRow, [string, string]>(`
      SELECT profile_key, profile_version, binding_value
      FROM verified_inbox_binding_aliases_trial
      WHERE outcome_kind = ? AND outcome_id = ?
      ORDER BY ordinal
    `).all(outcomeKind, outcomeId);
    return nonEmptyBindings(rows);
  }

  private assertExistingScope(intake: VerifiedInboxIntake, scope: EventScopeRef): void {
    const row = this.sqlite.query<{ workspace_id: string; event_id: string }, [string, string]>(`
      SELECT workspace_id, event_id
      FROM verified_inbox_receipts_trial
      WHERE source_connection_id = ? AND semantic_identity = ?
    `).get(intake.sourceConnectionId, intake.semanticIdentity);
    if (
      row !== null &&
      (row.workspace_id !== scope.workspaceId || row.event_id !== scope.eventId)
    ) {
      throw new SQLiteVerifiedInboxTrialError(
        'scope_mismatch',
        'existing inbox semantic identity is owned by a different trusted scope'
      );
    }
  }

  private persistNew(
    reduction: VerifiedInboxReduction,
    scope: EventScopeRef,
    material: SealedAdoptedVerifiedEnvelopeMaterial,
    faults: SQLiteVerifiedInboxTrialFaults | undefined
  ): void {
    const receipt = reduction.receipt;
    const pointer = reduction.state.processingPointers.find((candidate) =>
      candidate.receiptId === receipt.id
    );
    if (pointer === undefined) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'new inbox reduction did not create its processing pointer'
      );
    }
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_payload_refs_trial
         (payload_ref_id, disposition, recorded_at_ms)
       VALUES (?, 'adopted', ?)`,
      receipt.adoptedPayloadRef.id,
      milliseconds(receipt.receivedAt)
    );
    faults?.afterPayloadRefInserted?.('adopted');
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_receipts_trial
         (receipt_id, source_connection_id, source_connection_revision_id,
          semantic_identity, verifier_revision_id, adopted_payload_ref_id,
          workspace_id, event_id, received_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.id,
      receipt.sourceConnectionId,
      receipt.sourceConnectionRevisionId,
      receipt.semanticIdentity,
      receipt.verifierRevisionId,
      receipt.adoptedPayloadRef.id,
      scope.workspaceId,
      scope.eventId,
      milliseconds(receipt.receivedAt)
    );
    faults?.afterReceiptInserted?.();
    const contract = this.processingContract;
    if (
      material.sourceConnectionId !== contract.sourceConnectionId
      || material.sourceConnectionRevisionId !== contract.sourceConnectionRevisionId
      || material.verifierRevisionId !== contract.verifierRevisionId
      || material.verifierContract.key !== contract.verifierContract.key
      || material.verifierContract.version !== contract.verifierContract.version
    ) {
      throw new SQLiteVerifiedInboxTrialError(
        'processing_contract_mismatch',
        'verified intake does not match its source-controlled processor mapping'
      );
    }
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_receipt_processing_contracts_trial (
        receipt_id, source_connection_id, source_connection_revision_id,
        verifier_contract_key, verifier_contract_version, verifier_revision_id,
        processor_key, processor_version, processor_digest_sha256,
        job_key, job_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.id,
      ...processingContractValues(contract)
    );
    faults?.afterProcessingContractInserted?.();
    this.insertBindings(receipt.id, 'receipt', receipt.id, null, receipt.contentBindings, faults);
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_processing_pointers_trial
         (processing_pointer_id, receipt_id, created_at_ms)
       VALUES (?, ?, ?)`,
      pointer.id,
      pointer.receiptId,
      milliseconds(pointer.createdAt)
    );
    faults?.afterProcessingPointerInserted?.();
  }

  private persistConflict(
    reduction: VerifiedInboxReduction,
    faults: SQLiteVerifiedInboxTrialFaults | undefined
  ): void {
    const conflict = reduction.conflict;
    if (conflict === null) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'changed inbox reduction did not create its conflict'
      );
    }
    const attention = reduction.state.attentions.find((candidate) =>
      candidate.conflictId === conflict.id
    );
    if (attention === undefined) {
      throw new SQLiteVerifiedInboxTrialError(
        'state_corrupt',
        'changed inbox reduction did not create its attention'
      );
    }
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_payload_refs_trial
         (payload_ref_id, disposition, recorded_at_ms)
       VALUES (?, 'quarantined', ?)`,
      conflict.quarantinedPayloadRef.id,
      milliseconds(conflict.observedAt)
    );
    faults?.afterPayloadRefInserted?.('quarantined');
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_conflicts_trial
         (conflict_id, receipt_id, source_connection_revision_id,
          verifier_revision_id, quarantined_payload_ref_id, observed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      conflict.id,
      conflict.receiptId,
      conflict.sourceConnectionRevisionId,
      conflict.verifierRevisionId,
      conflict.quarantinedPayloadRef.id,
      milliseconds(conflict.observedAt)
    );
    faults?.afterConflictInserted?.();
    this.insertBindings(
      conflict.receiptId,
      'conflict',
      conflict.id,
      conflict.id,
      conflict.contentBindings,
      faults
    );
    run(
      this.sqlite,
      `INSERT INTO verified_inbox_attentions_trial
         (attention_id, conflict_id, created_at_ms)
       VALUES (?, ?, ?)`,
      attention.id,
      attention.conflictId,
      milliseconds(attention.createdAt)
    );
    faults?.afterAttentionInserted?.();
  }

  private insertBindings(
    receiptId: InboxReceipt['id'],
    outcomeKind: 'receipt' | 'conflict',
    outcomeId: string,
    conflictId: InboxConflict['id'] | null,
    bindings: NonEmptyContentBindings,
    faults: SQLiteVerifiedInboxTrialFaults | undefined
  ): void {
    let insertedCount = 0;
    for (const [index, binding] of bindings.entries()) {
      run(
        this.sqlite,
        `INSERT INTO verified_inbox_binding_aliases_trial
           (receipt_id, profile_key, profile_version, binding_value,
            outcome_kind, outcome_id, conflict_id, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        receiptId,
        binding.profile.key,
        binding.profile.version,
        binding.value,
        outcomeKind,
        outcomeId,
        conflictId,
        index + 1
      );
      insertedCount += 1;
      faults?.afterBindingAliasInserted?.(insertedCount);
    }
  }
}

export interface SQLiteVerifiedInboxTrialRunner {
  intake(input: {
    readonly rawEnvelope: Uint8Array;
    readonly protocolEvidence: unknown;
    readonly faults?: VerifiedInboxTrialRunnerFaults;
  }): Promise<VerifiedInboxTrialRunnerResult>;
}

/** Unactivated application runner for the disposable verified-inbox join proof. */
export function createSQLiteVerifiedInboxTrialRunner(input: {
  readonly boundary: VerifiedIngressBoundary;
  readonly repository: SQLiteVerifiedInboxTrialRepository;
}): SQLiteVerifiedInboxTrialRunner {
  return Object.freeze({
    async intake(request: {
      readonly rawEnvelope: Uint8Array;
      readonly protocolEvidence: unknown;
      readonly faults?: VerifiedInboxTrialRunnerFaults;
    }): Promise<VerifiedInboxTrialRunnerResult> {
      const staged = await input.boundary.verifyAndStage({
        rawEnvelope: request.rawEnvelope,
        protocolEvidence: request.protocolEvidence
      });
      if (staged.kind === 'rejected') return staged;
      request.faults?.afterStagePut?.();
      const preflight = input.repository.preflight(staged.handle);
      if (preflight.kind === 'known') {
        return Object.freeze({
          kind: 'intake',
          reduction: preflight.reduction,
          stageOwnership: 'not_adopted'
        });
      }
      if (preflight.kind === 'contended') {
        return Object.freeze({ kind: 'deferred', reason: 'intake_in_progress' });
      }
      if (preflight.kind === 'cleanup_claimed') {
        return Object.freeze({ kind: 'deferred', reason: 'stage_reconciliation_in_progress' });
      }
      if (preflight.kind === 'stage_expired') {
        return Object.freeze({ kind: 'deferred', reason: 'stage_expired' });
      }
      request.faults?.afterIntentPrepared?.();
      const adopted = await input.boundary.adopt({
        handle: staged.handle,
        payloadRefId: preflight.payloadRefId
      });
      request.faults?.afterStageAdopt?.();
      const finalized = input.repository.finalize(adopted, request.faults?.sqlite);
      request.faults?.afterSqlCommit?.();
      if (finalized.kind === 'requires_attention') return finalized;
      await input.boundary.markAdopted(adopted);
      return Object.freeze({
        kind: 'intake',
        reduction: finalized.reduction,
        stageOwnership: finalized.stageOwnership
      });
    }
  });
}

export type VerifiedInboxTrialStageReconciliationResult =
  | { readonly kind: 'marked_owned'; readonly payloadRef: PayloadRef }
  | { readonly kind: 'purged_unowned_staged'; readonly stageId: string }
  | {
      readonly kind: 'recovered_and_marked';
      readonly recoveredFrom: 'staged' | 'adoption_pending';
      readonly payloadRef: PayloadRef;
      readonly reduction: VerifiedInboxReduction;
    }
  | {
      readonly kind: 'requires_attention';
      readonly stageId: string;
      readonly reason: VerifiedInboxTrialStageAttentionReason;
    };

/**
 * Repairs only the classified stage state. It never runs the normal inbox
 * processor or creates an inbox outcome.
 */
export async function reconcileSQLiteVerifiedInboxTrialStage(input: {
  readonly repository: SQLiteVerifiedInboxTrialRepository;
  readonly boundary: VerifiedIngressBoundary;
  readonly stageStore: ClassifiedPayloadStageStore;
  readonly purgeProofAuthority: UnadoptedStageProofAuthority;
  readonly candidate: PayloadStageReconciliationCandidate;
}): Promise<VerifiedInboxTrialStageReconciliationResult> {
  const inspection = await input.stageStore.inspect({
    source: 'reconciliation',
    candidate: input.candidate
  });
  let ownership: VerifiedInboxTrialStageOwnership;
  try {
    ownership = input.repository.resolveStageOwnership(inspection);
  } catch (error) {
    if (!(error instanceof SQLiteVerifiedInboxTrialError) || error.code !== 'stage_ownership_mismatch') throw error;
    const retained = input.repository.retainStageCleanupUncertainty(input.candidate);
    return Object.freeze({
      kind: 'requires_attention',
      stageId: inspection.stage.stageId,
      reason: retained.reason
    });
  }
  if (ownership.kind === 'owned') {
    if (inspection.state !== 'adoption_pending') {
      throw new SQLiteVerifiedInboxTrialError(
        'stage_ownership_mismatch',
        'canonical stage ownership must reconcile from adoption_pending'
      );
    }
    const marked = await input.stageStore.markAdopted({
      stage: inspection.stage,
      payloadRef: ownership.payloadRef
    });
    return Object.freeze({ kind: 'marked_owned', payloadRef: marked.payloadRef });
  }
  const recovery = await input.repository.recoverIntent(inspection);
  if (recovery.kind === 'requires_attention') {
    return Object.freeze({
      kind: 'requires_attention',
      stageId: inspection.stage.stageId,
      reason: recovery.reason
    });
  }
  if (recovery.kind === 'staged' || recovery.kind === 'adoption_pending') {
    const recoveredFrom = recovery.kind;
    let adoptedHandle: AdoptedVerifiedEnvelopeHandle;
    if (recovery.kind === 'staged') {
      try {
        adoptedHandle = await input.boundary.adopt({
          handle: recovery.handle,
          payloadRefId: recovery.payloadRefId
        });
      } catch {
        const retained = input.repository.retainIntentAdoptionRefusal(inspection);
        if (retained.kind !== 'requires_attention') {
          throw new SQLiteVerifiedInboxTrialError('state_corrupt', 'adoption refusal was not retained');
        }
        return Object.freeze({
          kind: 'requires_attention',
          stageId: inspection.stage.stageId,
          reason: retained.reason
        });
      }
    } else {
      adoptedHandle = recovery.handle;
    }
    const finalized = input.repository.finalize(adoptedHandle);
    if (finalized.kind === 'requires_attention') {
      return Object.freeze({
        kind: 'requires_attention',
        stageId: inspection.stage.stageId,
        reason: finalized.reason
      });
    }
    const marked = await input.boundary.markAdopted(adoptedHandle);
    return Object.freeze({
      kind: 'recovered_and_marked',
      recoveredFrom,
      payloadRef: marked,
      reduction: finalized.reduction
    });
  }
  if (inspection.state === 'staged') {
    const issued = await input.purgeProofAuthority.issue({
      candidate: input.candidate,
      inspection
    });
    if (issued.kind !== 'issued') {
      const retained = input.repository.retainStageCleanupUncertainty(input.candidate);
      return Object.freeze({
        kind: 'requires_attention',
        stageId: inspection.stage.stageId,
        reason: retained.reason
      });
    }
    let purged: Awaited<ReturnType<ClassifiedPayloadStageStore['purge']>>;
    try {
      purged = await input.stageStore.purge({
        candidate: input.candidate,
        proof: issued.proof
      });
    } catch (error) {
      if (!(error instanceof ClassifiedPayloadStageError) ||
        (error.code !== 'canonical_stage_adopted' &&
          error.code !== 'canonical_stage_ownership_uncertain')) throw error;
      const retained = input.repository.retainStageCleanupUncertainty(input.candidate);
      return Object.freeze({
        kind: 'requires_attention',
        stageId: inspection.stage.stageId,
        reason: retained.reason
      });
    }
    input.repository.releaseStageCleanupClaim(input.candidate);
    return Object.freeze({ kind: 'purged_unowned_staged', stageId: purged.stageId });
  }
  if (inspection.state !== 'adoption_pending') {
    throw new SQLiteVerifiedInboxTrialError(
      'stage_ownership_mismatch',
      'unexpected unowned classified stage state'
    );
  }
  const attention = input.repository.retainUnownedAdoptionPending(inspection);
  if (attention.kind !== 'requires_attention') {
    throw new SQLiteVerifiedInboxTrialError('state_corrupt', 'orphan attention was not retained');
  }
  return Object.freeze({
    kind: 'requires_attention',
    stageId: inspection.stage.stageId,
    reason: attention.reason
  });
}
