import type { Database } from 'bun:sqlite';
import {
  createSecretReference,
  createSecretStoreAdapterRef,
  type DirectOperationFeatureContribution,
  type SecretStore
} from '@jooevents/application';
import {
  parseAirtableBaseId,
  parseAirtableCursor,
  parseAirtableFieldId,
  parseAirtableRecordId,
  parseAirtableTableId,
  parseAirtableWebhookId
} from '@jooevents/airtable';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  parseSourceConnectionId,
  type CanonicalJson,
  type SourceConnectionId
} from '@jooevents/kernel';
import {
  AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR,
  AIRTABLE_SECRET_PURPOSES,
  airtableProjectionFeatureContributionSchema,
  SYNC_AREA_KEYS,
  withAirtableWebhookMacSecret,
  type SyncAreaKey
} from '@jooevents/airtable-sync';
import type {
  AirtableInboundBoundaryPort,
  AirtableInboundCursorRepository,
  AirtableInboundCursorState,
  AirtableShadowEvaluation,
  AirtableShadowFieldMapping,
  AirtableShadowSettleClaim,
  AirtableShadowSettleContext,
  AirtableShadowSettleRepository,
  AirtableSettleCandidate,
  AirtableWebhookLifecycleRepository,
  AirtableWebhookMacRegistrationResolver,
  AirtableVerifiedInboxIntake,
  AirtableWebhookIntakeResolver,
  AirtableConnectionLease,
  AirtableOutboundJobRepository,
  AirtableProviderThrottle,
  AirtableReconciliationClaim,
  AirtableReconciliationPageRecord,
  AirtableReconciliationRepository,
  ManagedProvisioningClaim,
  ManagedProvisioningRepository,
  ManagedProvisioningState,
  StoredAirtableOAuthGrant,
  StoredAirtableOAuthAttempt,
  StoredAirtableWebhookMacSecret,
  SnapshotRecordLink
} from '@jooevents/airtable-sync';
import { assessAirtableRecordInventory } from '@jooevents/airtable-sync';

export const AIRTABLE_SYNC_SQL = `
CREATE TABLE airtable_sync_connections (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  public_callback_ref TEXT NOT NULL UNIQUE CHECK(length(public_callback_ref) BETWEEN 32 AND 160),
  provider_account_id TEXT CHECK(
    provider_account_id IS NULL OR length(provider_account_id) BETWEEN 3 AND 128
  ),
  state TEXT NOT NULL CHECK(state IN (
    'draft', 'provisioning', 'active', 'paused', 'needs_reconnect',
    'disconnecting', 'disconnected'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
);

CREATE UNIQUE INDEX airtable_sync_connection_workspace_current
  ON airtable_sync_connections(workspace_id)
  WHERE state <> 'disconnected';

CREATE TABLE airtable_sync_provisioning_runs (
  connection_id TEXT PRIMARY KEY REFERENCES airtable_sync_connections(id),
  phase TEXT NOT NULL CHECK(phase IN (
    'create_base', 'inspect_base', 'create_tables', 'snapshot', 'verify', 'ready', 'attention'
  )),
  manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  state_json TEXT NOT NULL CHECK(json_valid(state_json) AND length(state_json) BETWEEN 2 AND 262144),
  state_version INTEGER NOT NULL CHECK(state_version > 0),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
);

CREATE TABLE airtable_sync_snapshot_links (
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  table_key TEXT NOT NULL CHECK(length(table_key) BETWEEN 1 AND 128),
  subject_key TEXT NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 256),
  provider_table_id TEXT NOT NULL CHECK(length(provider_table_id) BETWEEN 3 AND 128),
  provider_record_id TEXT NOT NULL CHECK(length(provider_record_id) BETWEEN 3 AND 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(connection_id, table_key, subject_key),
  UNIQUE(connection_id, provider_table_id, provider_record_id)
);

CREATE TABLE secret_store_versions (
  reference_id TEXT NOT NULL CHECK(length(reference_id) BETWEEN 16 AND 256),
  version INTEGER NOT NULL CHECK(version > 0),
  adapter_key TEXT NOT NULL CHECK(length(adapter_key) BETWEEN 1 AND 160),
  adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 160),
  scope_binding TEXT NOT NULL CHECK(length(scope_binding) BETWEEN 1 AND 256),
  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 17 AND 1048576),
  is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
  revoked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(reference_id, version),
  CHECK(revoked_at_ms IS NULL OR is_current = 0)
);

CREATE UNIQUE INDEX secret_store_one_current
  ON secret_store_versions(reference_id) WHERE is_current = 1;

CREATE TRIGGER secret_store_versions_no_delete
BEFORE DELETE ON secret_store_versions
BEGIN
  SELECT RAISE(ABORT, 'secret store versions are retained');
END;

CREATE TRIGGER secret_store_versions_identity_immutable
BEFORE UPDATE ON secret_store_versions
WHEN NEW.reference_id IS NOT OLD.reference_id
  OR NEW.version IS NOT OLD.version
  OR NEW.adapter_key IS NOT OLD.adapter_key
  OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.scope_binding IS NOT OLD.scope_binding
  OR NEW.nonce IS NOT OLD.nonce
  OR NEW.ciphertext IS NOT OLD.ciphertext
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'secret store version identity is immutable');
END;

CREATE TABLE airtable_sync_grant_references (
  connection_id TEXT PRIMARY KEY REFERENCES airtable_sync_connections(id),
  secret_reference_id TEXT NOT NULL CHECK(length(secret_reference_id) BETWEEN 16 AND 256),
  secret_reference_version INTEGER NOT NULL CHECK(secret_reference_version > 0),
  secret_adapter_key TEXT NOT NULL CHECK(length(secret_adapter_key) BETWEEN 1 AND 160),
  secret_adapter_version INTEGER NOT NULL CHECK(secret_adapter_version > 0),
  access_expires_at TEXT NOT NULL CHECK(length(access_expires_at) BETWEEN 20 AND 40),
  refresh_expires_at TEXT NOT NULL CHECK(length(refresh_expires_at) BETWEEN 20 AND 40),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
);

CREATE TABLE airtable_sync_oauth_attempts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  state_digest TEXT NOT NULL UNIQUE CHECK(length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  secret_reference_id TEXT NOT NULL CHECK(length(secret_reference_id) BETWEEN 16 AND 256),
  secret_reference_version INTEGER NOT NULL CHECK(secret_reference_version > 0),
  secret_adapter_key TEXT NOT NULL CHECK(length(secret_adapter_key) BETWEEN 1 AND 160),
  secret_adapter_version INTEGER NOT NULL CHECK(secret_adapter_version > 0),
  redirect_uri TEXT NOT NULL CHECK(length(redirect_uri) BETWEEN 8 AND 2048),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'consumed', 'failed')),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
);

CREATE TABLE airtable_sync_mapping_revisions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'assessing', 'active', 'superseded', 'paused')),
  mapping_digest TEXT NOT NULL CHECK(length(mapping_digest) = 64 AND mapping_digest NOT GLOB '*[^0-9a-f]*'),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json) AND length(mapping_json) BETWEEN 2 AND 65536),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  activated_at_ms INTEGER,
  UNIQUE(connection_id, revision)
);

CREATE UNIQUE INDEX airtable_sync_mapping_one_active
  ON airtable_sync_mapping_revisions(connection_id)
  WHERE status = 'active';

CREATE TABLE airtable_sync_record_links (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision > 0),
  area_key TEXT NOT NULL CHECK(length(area_key) BETWEEN 1 AND 80),
  subject_kind TEXT NOT NULL CHECK(length(subject_kind) BETWEEN 1 AND 80),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  provider_table_id TEXT NOT NULL CHECK(length(provider_table_id) BETWEEN 3 AND 128),
  provider_record_id TEXT NOT NULL CHECK(length(provider_record_id) BETWEEN 3 AND 128),
  canonical_version INTEGER NOT NULL CHECK(canonical_version > 0),
  baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json) AND length(baseline_json) BETWEEN 2 AND 65536),
  baseline_digest TEXT NOT NULL CHECK(length(baseline_digest) = 64 AND baseline_digest NOT GLOB '*[^0-9a-f]*'),
  provider_fingerprint TEXT CHECK(
    provider_fingerprint IS NULL OR
    (length(provider_fingerprint) = 64 AND provider_fingerprint NOT GLOB '*[^0-9a-f]*')
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  UNIQUE(connection_id, area_key, subject_kind, subject_id),
  UNIQUE(connection_id, provider_table_id, provider_record_id)
);

CREATE TABLE airtable_sync_projection_work (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision > 0),
  area_key TEXT NOT NULL CHECK(length(area_key) BETWEEN 1 AND 80),
  subject_kind TEXT NOT NULL CHECK(length(subject_kind) BETWEEN 1 AND 80),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  requested_projection_version INTEGER NOT NULL CHECK(requested_projection_version > 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'attention')),
  available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  latest_operation_log_id TEXT,
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL)),
  UNIQUE(connection_id, area_key, subject_kind, subject_id)
);

CREATE INDEX airtable_sync_projection_due
  ON airtable_sync_projection_work(connection_id, available_at_ms, id)
  WHERE status IN ('pending', 'failed', 'running');

CREATE TABLE airtable_sync_connection_runtime (
  connection_id TEXT PRIMARY KEY REFERENCES airtable_sync_connections(id),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
);

CREATE TABLE airtable_sync_provider_throttle (
  provider_base_id TEXT PRIMARY KEY CHECK(length(provider_base_id) BETWEEN 3 AND 128),
  not_before_ms INTEGER NOT NULL CHECK(not_before_ms >= 0),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE airtable_sync_webhook_registrations (
  connection_id TEXT PRIMARY KEY REFERENCES airtable_sync_connections(id),
  provider_base_id TEXT NOT NULL CHECK(length(provider_base_id) BETWEEN 3 AND 128),
  provider_webhook_id TEXT NOT NULL UNIQUE CHECK(length(provider_webhook_id) BETWEEN 3 AND 128),
  mac_secret_reference_id TEXT NOT NULL CHECK(length(mac_secret_reference_id) BETWEEN 16 AND 256),
  mac_secret_reference_version INTEGER NOT NULL CHECK(mac_secret_reference_version > 0),
  mac_secret_adapter_key TEXT NOT NULL CHECK(length(mac_secret_adapter_key) BETWEEN 1 AND 160),
  mac_secret_adapter_version INTEGER NOT NULL CHECK(mac_secret_adapter_version > 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'renewal_due', 'invalid', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
);

CREATE TABLE airtable_sync_webhook_cursors (
  connection_id TEXT PRIMARY KEY REFERENCES airtable_sync_connections(id),
  provider_webhook_id TEXT NOT NULL CHECK(length(provider_webhook_id) BETWEEN 3 AND 128),
  cursor TEXT CHECK(cursor IS NULL OR length(cursor) BETWEEN 1 AND 128),
  last_transaction_number INTEGER NOT NULL CHECK(last_transaction_number >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE airtable_sync_settle_heads (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision > 0),
  provider_table_id TEXT NOT NULL CHECK(length(provider_table_id) BETWEEN 3 AND 128),
  provider_record_id TEXT NOT NULL CHECK(length(provider_record_id) BETWEEN 3 AND 128),
  latest_transaction_number INTEGER NOT NULL CHECK(latest_transaction_number > 0),
  change_kind TEXT NOT NULL CHECK(change_kind IN ('created', 'updated', 'destroyed')),
  changed_field_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(
    json_valid(changed_field_ids_json) AND json_type(changed_field_ids_json) = 'array'
  ),
  provider_source TEXT NOT NULL DEFAULT 'unknown' CHECK(length(provider_source) BETWEEN 1 AND 40),
  provider_actor_id TEXT,
  provider_actor_email TEXT,
  provider_actor_display_name TEXT,
  observed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(observed_at_ms >= 0),
  not_before_ms INTEGER NOT NULL CHECK(not_before_ms >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'observed', 'attention')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  last_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  UNIQUE(connection_id, provider_table_id, provider_record_id),
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
);

CREATE INDEX airtable_sync_settle_due
  ON airtable_sync_settle_heads(connection_id, not_before_ms, id);

CREATE TABLE airtable_sync_shadow_findings (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  settle_id TEXT NOT NULL REFERENCES airtable_sync_settle_heads(id),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision > 0),
  record_link_id TEXT NOT NULL REFERENCES airtable_sync_record_links(id),
  provider_transaction_number INTEGER NOT NULL CHECK(provider_transaction_number > 0),
  settle_revision INTEGER NOT NULL CHECK(settle_revision > 0),
  field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 1 AND 160),
  provider_field_id TEXT NOT NULL CHECK(length(provider_field_id) BETWEEN 3 AND 128),
  mode TEXT NOT NULL CHECK(mode IN (
    'not_shared', 'view_in_airtable', 'editable_in_airtable', 'request_from_airtable'
  )),
  classification TEXT NOT NULL CHECK(classification IN ('ordinary', 'personal', 'sensitive', 'classified')),
  disposition TEXT NOT NULL CHECK(disposition IN (
    'unchanged', 'outbound', 'echo', 'converged', 'apply_inbound',
    'create_request', 'restore', 'forbidden', 'conflict'
  )),
  base_digest TEXT NOT NULL CHECK(length(base_digest) = 64),
  local_digest TEXT NOT NULL CHECK(length(local_digest) = 64),
  remote_digest TEXT NOT NULL CHECK(length(remote_digest) = 64),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
  UNIQUE(settle_id, settle_revision, field_key)
);

CREATE INDEX airtable_sync_shadow_findings_history
  ON airtable_sync_shadow_findings(connection_id, observed_at_ms DESC, id DESC);

CREATE TRIGGER airtable_sync_shadow_findings_no_update
BEFORE UPDATE ON airtable_sync_shadow_findings
BEGIN
  SELECT RAISE(ABORT, 'airtable sync shadow finding is immutable');
END;

CREATE TRIGGER airtable_sync_shadow_findings_no_delete
BEFORE DELETE ON airtable_sync_shadow_findings
BEGIN
  SELECT RAISE(ABORT, 'airtable sync shadow finding is immutable');
END;

CREATE TABLE airtable_sync_conflicts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  record_link_id TEXT NOT NULL REFERENCES airtable_sync_record_links(id),
  field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'superseded')),
  base_digest TEXT NOT NULL CHECK(length(base_digest) = 64),
  local_digest TEXT NOT NULL CHECK(length(local_digest) = 64),
  remote_digest TEXT NOT NULL CHECK(length(remote_digest) = 64),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  resolved_at_ms INTEGER,
  UNIQUE(record_link_id, field_key, status)
);

CREATE TABLE airtable_sync_boundary_observations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  record_link_id TEXT REFERENCES airtable_sync_record_links(id),
  field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK(kind IN ('applied', 'refused_restored', 'request', 'conflict', 'sharing')),
  classification TEXT NOT NULL CHECK(classification IN ('ordinary', 'personal', 'sensitive', 'classified')),
  before_json TEXT,
  after_json TEXT,
  before_payload_ref TEXT,
  after_payload_ref TEXT,
  provider_actor_id TEXT,
  provider_actor_email TEXT,
  provider_actor_display_name TEXT,
  inbox_receipt_id TEXT,
  operation_receipt_id TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  CHECK(
    (classification = 'classified' AND before_json IS NULL AND after_json IS NULL
      AND before_payload_ref IS NOT NULL AND after_payload_ref IS NOT NULL)
    OR
    (classification <> 'classified' AND before_json IS NOT NULL AND after_json IS NOT NULL
      AND json_valid(before_json) AND json_valid(after_json)
      AND before_payload_ref IS NULL AND after_payload_ref IS NULL)
  )
);

CREATE INDEX airtable_sync_boundary_history
  ON airtable_sync_boundary_observations(connection_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER airtable_sync_boundary_observations_no_update
BEFORE UPDATE ON airtable_sync_boundary_observations
BEGIN
  SELECT RAISE(ABORT, 'airtable sync boundary observation is immutable');
END;

CREATE TRIGGER airtable_sync_boundary_observations_no_delete
BEFORE DELETE ON airtable_sync_boundary_observations
BEGIN
  SELECT RAISE(ABORT, 'airtable sync boundary observation is immutable');
END;

CREATE TABLE airtable_sync_reconciliation_runs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision > 0),
  area_key TEXT NOT NULL CHECK(length(area_key) BETWEEN 1 AND 80),
  provider_base_id TEXT NOT NULL CHECK(length(provider_base_id) BETWEEN 3 AND 128),
  provider_table_id TEXT NOT NULL CHECK(length(provider_table_id) BETWEEN 3 AND 128),
  stable_field_id TEXT NOT NULL CHECK(length(stable_field_id) BETWEEN 3 AND 128),
  compared_field_ids_json TEXT NOT NULL CHECK(
    json_valid(compared_field_ids_json) AND json_type(compared_field_ids_json) = 'array'
  ),
  kind TEXT NOT NULL CHECK(kind IN ('lightweight','full','user_requested','retention_recovery')),
  status TEXT NOT NULL CHECK(status IN (
    'pending','running','scanning','assessing','succeeded','attention','failed'
  )),
  provider_offset TEXT,
  available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= 0),
  scanned_records INTEGER NOT NULL DEFAULT 0 CHECK(scanned_records >= 0),
  finding_count INTEGER NOT NULL DEFAULT 0 CHECK(finding_count >= 0),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER,
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
);

CREATE INDEX airtable_sync_reconciliation_due
  ON airtable_sync_reconciliation_runs(connection_id, available_at_ms, id)
  WHERE status IN ('pending','scanning','failed','running');

CREATE UNIQUE INDEX airtable_sync_reconciliation_one_open
  ON airtable_sync_reconciliation_runs(connection_id, area_key)
  WHERE status IN ('pending','running','scanning','assessing','failed');

CREATE TABLE airtable_sync_reconciliation_inventory (
  run_id TEXT NOT NULL REFERENCES airtable_sync_reconciliation_runs(id),
  provider_record_id TEXT NOT NULL CHECK(length(provider_record_id) BETWEEN 3 AND 128),
  subject_key TEXT CHECK(subject_key IS NULL OR length(subject_key) BETWEEN 1 AND 256),
  provider_fingerprint TEXT NOT NULL CHECK(
    length(provider_fingerprint) = 64 AND provider_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
  PRIMARY KEY(run_id, provider_record_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX airtable_sync_reconciliation_inventory_subject
  ON airtable_sync_reconciliation_inventory(run_id, subject_key, provider_record_id);

CREATE TABLE airtable_sync_reconciliation_findings (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  run_id TEXT NOT NULL REFERENCES airtable_sync_reconciliation_runs(id),
  connection_id TEXT NOT NULL REFERENCES airtable_sync_connections(id),
  kind TEXT NOT NULL CHECK(kind IN ('missing','duplicate','orphan','record_id_changed')),
  subject_key TEXT,
  provider_record_id TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
);

CREATE INDEX airtable_sync_reconciliation_findings_history
  ON airtable_sync_reconciliation_findings(connection_id, created_at_ms DESC, id DESC);

CREATE TRIGGER airtable_sync_reconciliation_findings_no_update
BEFORE UPDATE ON airtable_sync_reconciliation_findings
BEGIN
  SELECT RAISE(ABORT, 'airtable sync reconciliation finding is immutable');
END;

CREATE TRIGGER airtable_sync_reconciliation_findings_no_delete
BEFORE DELETE ON airtable_sync_reconciliation_findings
BEGIN
  SELECT RAISE(ABORT, 'airtable sync reconciliation finding is immutable');
END;

CREATE TABLE airtable_sync_health (
  connection_id TEXT PRIMARY KEY REFERENCES airtable_sync_connections(id),
  state TEXT NOT NULL CHECK(state IN (
    'current','pending','needs_review','delayed','paused','needs_reconnect','disconnected'
  )),
  due_work INTEGER NOT NULL DEFAULT 0 CHECK(due_work >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
  schema_drift_count INTEGER NOT NULL DEFAULT 0 CHECK(schema_drift_count >= 0),
  dead_letter_count INTEGER NOT NULL DEFAULT 0 CHECK(dead_letter_count >= 0),
  last_outbound_at_ms INTEGER,
  last_inbound_at_ms INTEGER,
  last_lightweight_at_ms INTEGER,
  last_full_at_ms INTEGER,
  last_full_summary TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function id(value: string, code: string): string {
  if (!UUID.test(value)) throw new TypeError(code);
  return value;
}

function digest(value: string): string {
  if (!DIGEST.test(value)) throw new TypeError('airtable_sync_digest_invalid');
  return value;
}

export function installSQLiteAirtableSync(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(AIRTABLE_SYNC_SQL);
}

export interface AirtableSyncClaimedWork {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly areaKey: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly requestedProjectionVersion: number;
  readonly attempts: number;
  readonly leaseOwner: string;
  readonly leaseVersion: number;
  readonly leaseExpiresAtMs: number;
}

export interface AirtableSyncWake {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly reason: 'outbound_projection' | 'scheduled_discovery';
  readonly wakeId: string;
}

export interface AirtableSyncWakePublisher {
  publish(wake: AirtableSyncWake): Promise<void>;
}

interface WorkRow {
  readonly id: string;
  readonly connection_id: string;
  readonly mapping_revision: number;
  readonly area_key: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly requested_projection_version: number;
  readonly attempts: number;
  readonly lease_owner: string;
  readonly lease_version: number;
  readonly lease_expires_at_ms: number;
}

export interface AirtableOAuthAttemptClaim {
  readonly id: string;
  readonly connectionId: string;
  readonly stored: StoredAirtableOAuthAttempt;
  readonly redirectUri: string;
  readonly workerId: string;
  readonly leaseVersion: number;
}

export interface SQLiteAirtableIntegrationConnection {
  readonly id: string;
  readonly workspaceId: string;
  readonly publicCallbackRef: string;
  readonly state: import('@jooevents/airtable-sync').ConnectionState;
  readonly version: number;
  readonly providerAccountId?: string;
  readonly grant?: StoredAirtableOAuthGrant;
  readonly provisioning?: ManagedProvisioningState;
  readonly mapping?: Readonly<{
    revision: number;
    status: 'draft' | 'assessing' | 'active' | 'superseded' | 'paused';
    value: CanonicalJson;
  }>;
}

export interface AirtableShadowContextSourceInput {
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly recordLinkId: string;
  readonly areaKey: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly mapping: CanonicalJson;
}

export interface AirtableShadowContextSource {
  resolve(input: AirtableShadowContextSourceInput): Promise<Readonly<{
    mappings: readonly AirtableShadowFieldMapping[];
    local: Readonly<Record<string, CanonicalJson>>;
    lastOutbound?: Readonly<Record<string, CanonicalJson>>;
    subjectVersion?: number;
  }> | undefined>;
}

function provisioningState(value: string): ManagedProvisioningState {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null
    || !('connectionId' in parsed) || typeof parsed.connectionId !== 'string'
    || !('phase' in parsed) || ![
      'create_base', 'inspect_base', 'create_tables', 'snapshot', 'verify', 'ready', 'attention'
    ].includes(String(parsed.phase))
    || !('version' in parsed) || !Number.isSafeInteger(parsed.version)
    || !('manifestDigestSha256' in parsed) || typeof parsed.manifestDigestSha256 !== 'string'
    || !('tables' in parsed) || !Array.isArray(parsed.tables)) {
    throw new TypeError('airtable_sync_provisioning_state_invalid');
  }
  return parsed as ManagedProvisioningState;
}

export class SQLiteAirtableSyncRepository implements ManagedProvisioningRepository {
  constructor(private readonly sqlite: Database) {}

  readWorkspaceConnection(workspaceId: string): SQLiteAirtableIntegrationConnection | undefined {
    id(workspaceId, 'airtable_sync_workspace_id_invalid');
    const row = this.sqlite.query<{
      readonly id: string;
      readonly workspace_id: string;
      readonly public_callback_ref: string;
      readonly state: SQLiteAirtableIntegrationConnection['state'];
      readonly version: number;
      readonly provider_account_id: string | null;
      readonly secret_reference_id: string | null;
      readonly secret_reference_version: number | null;
      readonly secret_adapter_key: string | null;
      readonly secret_adapter_version: number | null;
      readonly access_expires_at: string | null;
      readonly refresh_expires_at: string | null;
      readonly scopes_json: string | null;
      readonly provisioning_json: string | null;
      readonly mapping_revision: number | null;
      readonly mapping_status: 'draft' | 'assessing' | 'active' | 'superseded' | 'paused' | null;
      readonly mapping_json: string | null;
    }, [string]>(`
      SELECT connection.id, connection.workspace_id, connection.public_callback_ref,
             connection.state, connection.version,
             connection.provider_account_id,
             grant.secret_reference_id, grant.secret_reference_version,
             grant.secret_adapter_key, grant.secret_adapter_version,
             grant.access_expires_at, grant.refresh_expires_at, grant.scopes_json,
             provisioning.state_json AS provisioning_json,
             mapping.revision AS mapping_revision, mapping.status AS mapping_status,
             mapping.mapping_json
        FROM airtable_sync_connections AS connection
        LEFT JOIN airtable_sync_grant_references AS grant
          ON grant.connection_id = connection.id
        LEFT JOIN airtable_sync_provisioning_runs AS provisioning
          ON provisioning.connection_id = connection.id
        LEFT JOIN airtable_sync_mapping_revisions AS mapping
          ON mapping.connection_id = connection.id
         AND mapping.status IN ('draft','assessing','active','paused')
       WHERE connection.workspace_id = ? AND connection.state <> 'disconnected'
       ORDER BY mapping.revision DESC
       LIMIT 1
    `).get(workspaceId);
    if (!row) return undefined;
    const grant = row.secret_reference_id === null ? undefined : Object.freeze({
      secretReference: createSecretReference({
        id: row.secret_reference_id,
        version: row.secret_reference_version!,
        adapter: createSecretStoreAdapterRef(row.secret_adapter_key!, row.secret_adapter_version!),
        purpose: AIRTABLE_SECRET_PURPOSES.grant,
        scopeBinding: row.id
      }),
      accessExpiresAt: row.access_expires_at!,
      refreshExpiresAt: row.refresh_expires_at!,
      scopes: Object.freeze(JSON.parse(row.scopes_json!))
    }) satisfies StoredAirtableOAuthGrant;
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspace_id,
      publicCallbackRef: row.public_callback_ref,
      state: row.state,
      version: row.version,
      ...(row.provider_account_id === null ? {} : { providerAccountId: row.provider_account_id }),
      ...(grant === undefined ? {} : { grant }),
      ...(row.provisioning_json === null ? {} : { provisioning: provisioningState(row.provisioning_json) }),
      ...(row.mapping_revision === null ? {} : { mapping: Object.freeze({
        revision: row.mapping_revision,
        status: row.mapping_status!,
        value: JSON.parse(row.mapping_json!) as CanonicalJson
      }) })
    });
  }

  retireDraftConnection(input: Readonly<{ workspaceId: string; nowMs: number }>): void {
    id(input.workspaceId, 'airtable_sync_workspace_id_invalid');
    const activeDraft = this.sqlite.query<{ readonly id: string }, [string]>(`
      SELECT id FROM airtable_sync_connections
       WHERE workspace_id = ? AND state = 'draft'
    `).get(input.workspaceId);
    if (!activeDraft) return;
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        UPDATE airtable_sync_oauth_attempts
           SET status = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
               updated_at_ms = ?
         WHERE connection_id = ? AND status IN ('pending','claimed')
      `).run(input.nowMs, activeDraft.id);
      this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state = 'disconnected', version = version + 1, updated_at_ms = ?
         WHERE id = ? AND state = 'draft'
      `).run(input.nowMs, activeDraft.id);
    })();
  }

  activateSelectedBase(input: Readonly<{
    connectionId: string;
    expectedConnectionVersion: number;
    provisioning: ManagedProvisioningState;
    mappingId: string;
    mappingRevision: number;
    manifestVersion: number;
    mappingDigest: string;
    mapping: CanonicalJson;
    nowMs: number;
  }>): boolean {
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state = 'provisioning', version = version + 1, updated_at_ms = ?
         WHERE id = ? AND state = 'draft' AND version = ?
           AND EXISTS (
             SELECT 1 FROM airtable_sync_grant_references WHERE connection_id = ?
           )
      `).run(input.nowMs, input.connectionId, input.expectedConnectionVersion, input.connectionId);
      if (updated.changes !== 1) return false;
      this.createProvisioningRun({ state: input.provisioning, nowMs: input.nowMs });
      this.addMappingRevision({
        id: input.mappingId,
        connectionId: input.connectionId,
        revision: input.mappingRevision,
        manifestVersion: input.manifestVersion,
        status: 'draft',
        mappingDigest: input.mappingDigest,
        mapping: input.mapping,
        nowMs: input.nowMs
      });
      return true;
    })();
  }

  finalizeProvisioningActivation(input: Readonly<{
    connectionId: string;
    expectedConnectionVersion: number;
    mappingRevision: number;
    nowMs: number;
  }>): boolean {
    parseSourceConnectionId(input.connectionId);
    return this.sqlite.transaction(() => {
      const ready = this.sqlite.query<{ readonly ready: number }, [string, number]>(`
        SELECT 1 AS ready
          FROM airtable_sync_provisioning_runs AS provisioning
          JOIN airtable_sync_webhook_registrations AS webhook
            ON webhook.connection_id = provisioning.connection_id
           AND webhook.status = 'active'
         WHERE provisioning.connection_id = ? AND provisioning.phase = 'ready'
           AND EXISTS (
             SELECT 1 FROM airtable_sync_mapping_revisions
              WHERE connection_id = provisioning.connection_id
                AND revision = ? AND status = 'draft'
           )
      `).get(input.connectionId, input.mappingRevision);
      if (!ready) return false;
      const mapping = this.sqlite.query(`
        UPDATE airtable_sync_mapping_revisions
           SET status = 'active', activated_at_ms = ?
         WHERE connection_id = ? AND revision = ? AND status = 'draft'
      `).run(input.nowMs, input.connectionId, input.mappingRevision);
      if (mapping.changes !== 1) return false;
      const connection = this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state = 'active', version = version + 1, updated_at_ms = ?
         WHERE id = ? AND state = 'provisioning' AND version = ?
      `).run(input.nowMs, input.connectionId, input.expectedConnectionVersion);
      if (connection.changes !== 1) throw new Error('airtable_provisioning_activation_raced');
      this.sqlite.query(`
        INSERT INTO airtable_sync_health(
          connection_id, state, due_work, conflict_count, request_count,
          schema_drift_count, dead_letter_count, updated_at_ms
        ) VALUES (?, 'current', 0, 0, 0, 0, 0, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          state = 'current', version = airtable_sync_health.version + 1,
          updated_at_ms = excluded.updated_at_ms
      `).run(input.connectionId, input.nowMs);
      return true;
    })();
  }

  readProvisioningActivation(connectionId: string): Readonly<{
    connectionVersion: number;
    publicCallbackRef: string;
    provisioning: ManagedProvisioningState;
    mappingRevision: number;
    mapping: CanonicalJson;
    webhookActive: boolean;
  }> | undefined {
    parseSourceConnectionId(connectionId);
    const row = this.sqlite.query<{
      readonly version: number;
      readonly public_callback_ref: string;
      readonly state_json: string;
      readonly revision: number;
      readonly mapping_json: string;
      readonly webhook_active: number;
    }, [string]>(`
      SELECT connection.version, connection.public_callback_ref,
             provisioning.state_json, mapping.revision, mapping.mapping_json,
             EXISTS(
               SELECT 1 FROM airtable_sync_webhook_registrations AS webhook
                WHERE webhook.connection_id = connection.id AND webhook.status = 'active'
             ) AS webhook_active
        FROM airtable_sync_connections AS connection
        JOIN airtable_sync_provisioning_runs AS provisioning
          ON provisioning.connection_id = connection.id
        JOIN airtable_sync_mapping_revisions AS mapping
          ON mapping.connection_id = connection.id AND mapping.status = 'draft'
       WHERE connection.id = ? AND connection.state = 'provisioning'
    `).get(connectionId);
    return row ? Object.freeze({
      connectionVersion: row.version,
      publicCallbackRef: row.public_callback_ref,
      provisioning: provisioningState(row.state_json),
      mappingRevision: row.revision,
      mapping: JSON.parse(row.mapping_json) as CanonicalJson,
      webhookActive: row.webhook_active === 1
    }) : undefined;
  }

  replaceActiveMapping(input: Readonly<{
    id: string;
    observationId: string;
    connectionId: string;
    expectedConnectionVersion: number;
    revision: number;
    manifestVersion: number;
    mappingDigest: string;
    mapping: CanonicalJson;
    nowMs: number;
  }>): boolean {
    id(input.id, 'airtable_sync_mapping_id_invalid');
    id(input.observationId, 'airtable_sync_observation_id_invalid');
    return this.sqlite.transaction(() => {
      const connection = this.sqlite.query<{ readonly current: number }, [string, number]>(`
        SELECT 1 AS current FROM airtable_sync_connections
         WHERE id = ? AND version = ? AND state = 'active'
      `).get(input.connectionId, input.expectedConnectionVersion);
      if (!connection) return false;
      const previous = this.sqlite.query(`
        UPDATE airtable_sync_mapping_revisions
           SET status = 'superseded'
         WHERE connection_id = ? AND status = 'active'
      `).run(input.connectionId);
      if (previous.changes !== 1) return false;
      this.addMappingRevision({
        id: input.id,
        connectionId: input.connectionId,
        revision: input.revision,
        manifestVersion: input.manifestVersion,
        status: 'active',
        mappingDigest: input.mappingDigest,
        mapping: input.mapping,
        nowMs: input.nowMs
      });
      this.sqlite.query(`
        UPDATE airtable_sync_record_links SET mapping_revision = ?, updated_at_ms = ?
         WHERE connection_id = ?
      `).run(input.revision, input.nowMs, input.connectionId);
      this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET version = version + 1, updated_at_ms = ?
         WHERE id = ? AND version = ?
      `).run(input.nowMs, input.connectionId, input.expectedConnectionVersion);
      this.sqlite.query(`
        INSERT INTO airtable_sync_boundary_observations(
          id, connection_id, record_link_id, field_key, kind, classification,
          before_json, after_json, occurred_at_ms
        ) VALUES (?, ?, NULL, 'mapping', 'sharing', 'ordinary', '{}', ?, ?)
      `).run(input.observationId, input.connectionId, canonicalJsonText(input.mapping), input.nowMs);
      return true;
    })();
  }

  setConnectionPaused(input: Readonly<{
    connectionId: string;
    expectedVersion: number;
    paused: boolean;
    nowMs: number;
  }>): boolean {
    const from = input.paused ? 'active' : 'paused';
    const to = input.paused ? 'paused' : 'active';
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state = ?, version = version + 1, updated_at_ms = ?
         WHERE id = ? AND state = ? AND version = ?
      `).run(to, input.nowMs, input.connectionId, from, input.expectedVersion);
      if (updated.changes !== 1) return false;
      this.sqlite.query(`
        UPDATE airtable_sync_health
           SET state = ?, version = version + 1, updated_at_ms = ?
         WHERE connection_id = ?
      `).run(input.paused ? 'paused' : 'pending', input.nowMs, input.connectionId);
      return true;
    })();
  }

  markConnectionNeedsReconnect(input: Readonly<{
    connectionId: string;
    expectedVersion: number;
    nowMs: number;
  }>): boolean {
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state='needs_reconnect',version=version+1,updated_at_ms=?
         WHERE id=? AND version=? AND state IN ('active','provisioning')
      `).run(input.nowMs, input.connectionId, input.expectedVersion);
      if (updated.changes !== 1) return false;
      this.sqlite.query(`
        UPDATE airtable_sync_health
           SET state='needs_reconnect',version=version+1,updated_at_ms=?
         WHERE connection_id=?
      `).run(input.nowMs, input.connectionId);
      return true;
    })();
  }

  beginDisconnect(input: Readonly<{
    connectionId: string;
    expectedVersion: number;
    nowMs: number;
  }>): number | undefined {
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state='disconnecting',version=version+1,updated_at_ms=?
         WHERE id=? AND version=? AND state IN ('active','paused','needs_reconnect')
      `).run(input.nowMs, input.connectionId, input.expectedVersion);
      if (updated.changes === 1) return input.expectedVersion + 1;
      const current = this.sqlite.query<{ readonly version: number; readonly state: string }, [string]>(`
        SELECT version,state FROM airtable_sync_connections WHERE id=?
      `).get(input.connectionId);
      return current?.state === 'disconnecting' && current.version === input.expectedVersion
        ? current.version : undefined;
    })();
  }

  disconnectLocal(input: Readonly<{
    connectionId: string;
    expectedVersion: number;
    nowMs: number;
  }>): boolean {
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_connections
           SET state = 'disconnected', version = version + 1, updated_at_ms = ?
         WHERE id = ? AND version = ? AND state IN ('active','paused','needs_reconnect','disconnecting')
      `).run(input.nowMs, input.connectionId, input.expectedVersion);
      if (updated.changes !== 1) return false;
      this.sqlite.query(`
        UPDATE airtable_sync_webhook_registrations
           SET status = 'deleted', version = version + 1, updated_at_ms = ?
         WHERE connection_id = ? AND status <> 'deleted'
      `).run(input.nowMs, input.connectionId);
      this.sqlite.query(`
        UPDATE airtable_sync_health
           SET state = 'disconnected', version = version + 1, updated_at_ms = ?
         WHERE connection_id = ?
      `).run(input.nowMs, input.connectionId);
      return true;
    })();
  }

  readWebhookRegistrationAny(connectionId: string): Readonly<{
    baseId: ReturnType<typeof parseAirtableBaseId>;
    webhookId: ReturnType<typeof parseAirtableWebhookId>;
    expiresAtMs: number;
  }> | undefined {
    const row = this.sqlite.query<{
      readonly provider_base_id: string;
      readonly provider_webhook_id: string;
      readonly expires_at_ms: number;
    }, [string]>(`
      SELECT provider_base_id, provider_webhook_id, expires_at_ms
        FROM airtable_sync_webhook_registrations
       WHERE connection_id = ? AND status IN ('active','renewal_due','invalid')
    `).get(connectionId);
    return row ? Object.freeze({
      baseId: parseAirtableBaseId(row.provider_base_id),
      webhookId: parseAirtableWebhookId(row.provider_webhook_id),
      expiresAtMs: row.expires_at_ms
    }) : undefined;
  }

  scheduleConnectionReconciliation(input: Readonly<{
    workspaceId: string;
    kind: 'lightweight' | 'full' | 'user_requested' | 'retention_recovery';
    nowMs: number;
    newRunId: () => string;
  }>): number {
    const connection = this.readWorkspaceConnection(input.workspaceId);
    if (!connection || (connection.state !== 'active' && connection.state !== 'paused')
      || !connection.mapping || !connection.provisioning?.binding) return 0;
    const rawAreas = typeof connection.mapping.value === 'object'
      && connection.mapping.value !== null && !Array.isArray(connection.mapping.value)
      && 'areas' in connection.mapping.value ? connection.mapping.value.areas : undefined;
    if (!Array.isArray(rawAreas)) return 0;
    const tableForArea: Readonly<Record<string, string>> = Object.freeze({
      events: 'events', people: 'speakers', submissions: 'submissions',
      sessions: 'sessions', schedule: 'sessions', tasks: 'tasks'
    });
    const repository = new SQLiteAirtableReconciliationRepository(this.sqlite);
    let scheduled = 0;
    const scheduledTableIds = new Set<string>();
    const hasConnectedArea = rawAreas.some((candidate) =>
      typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      && 'direction' in candidate && candidate.direction !== 'not_connected'
    );
    const candidates = hasConnectedArea
      ? [{ areaKey: 'events', direction: 'keep_airtable_updated' }, ...rawAreas]
      : rawAreas;
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
        || !('areaKey' in candidate) || !('direction' in candidate)
        || typeof candidate.areaKey !== 'string' || candidate.direction === 'not_connected') continue;
      if (!SYNC_AREA_KEYS.includes(candidate.areaKey as SyncAreaKey)) continue;
      const areaKey = candidate.areaKey === 'schedule' ? 'sessions' : candidate.areaKey;
      const tableKey = tableForArea[areaKey];
      const table = connection.provisioning.binding.tables.find((item) => item.key === tableKey);
      if (!table) continue;
      // Sessions and schedule are two user-facing directions over one managed table.
      // Inventory it once so the same provider records cannot be reported as orphans
      // by a second logical-area scan.
      if (scheduledTableIds.has(table.tableId)) continue;
      scheduledTableIds.add(table.tableId);
      const open = this.sqlite.query<{ readonly open: number }, [string, string, string]>(`
        SELECT 1 AS open FROM airtable_sync_reconciliation_runs
         WHERE connection_id = ? AND area_key = ?
           AND status IN ('pending','running','scanning','assessing','failed')
           AND (? <> 'retention_recovery' OR kind = 'retention_recovery')
      `).get(connection.id, areaKey, input.kind);
      if (open) continue;
      repository.createRun({
        id: input.newRunId(),
        connectionId: connection.id,
        mappingRevision: connection.mapping.revision,
        areaKey: areaKey as SyncAreaKey,
        baseId: connection.provisioning.binding.baseId,
        tableId: table.tableId,
        stableIdFieldId: table.stableIdFieldId,
        comparedFieldIds: table.fields.map((field) => field.fieldId),
        kind: input.kind,
        nowMs: input.nowMs
      });
      scheduled += 1;
    }
    return scheduled;
  }

  hasOpenRetentionRecovery(connectionId: string): boolean {
    parseSourceConnectionId(connectionId);
    return Boolean(this.sqlite.query<{ readonly open: number }, [string]>(`
      SELECT 1 AS open FROM airtable_sync_reconciliation_runs
       WHERE connection_id = ? AND kind = 'retention_recovery'
         AND status IN ('pending','running','scanning','assessing','failed')
       LIMIT 1
    `).get(connectionId));
  }

  enqueueManagedAreaRefresh(input: Readonly<{
    connectionId: string;
    workspaceId: string;
    mappingRevision: number;
    areaKey: SyncAreaKey;
    eventId?: string;
    nowMs: number;
    newWorkId: () => string;
  }>): number {
    const areaKey = input.areaKey === 'schedule' ? 'sessions' : input.areaKey;
    const refresh = listAirtableRefreshSubjects({
      sqlite: this.sqlite,
      workspaceId: input.workspaceId,
      eventId: input.eventId ?? null,
      areaKey
    });
    for (const subject of refresh.rows) {
      this.enqueueProjectionWork({
        id: input.newWorkId(),
        connectionId: input.connectionId,
        mappingRevision: input.mappingRevision,
        areaKey,
        subjectKind: refresh.subjectKind,
        subjectId: subject.subject_id,
        projectionVersion: subject.projection_version,
        availableAtMs: input.nowMs,
        nowMs: input.nowMs
      });
    }
    return refresh.rows.length;
  }

  createConnection(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly publicCallbackRef: string;
    readonly providerAccountId?: string;
    readonly nowMs: number;
  }): void {
    parseSourceConnectionId(input.id);
    id(input.workspaceId, 'airtable_sync_workspace_id_invalid');
    this.sqlite.query(`
      INSERT INTO airtable_sync_connections(
        id, workspace_id, public_callback_ref, provider_account_id, state,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      input.id,
      input.workspaceId,
      input.publicCallbackRef,
      input.providerAccountId ?? null,
      input.nowMs,
      input.nowMs
    );
  }

  createOAuthConnectionAttempt(input: {
    readonly connectionId: string;
    readonly workspaceId: string;
    readonly publicCallbackRef: string;
    readonly attemptId: string;
    readonly stored: StoredAirtableOAuthAttempt;
    readonly redirectUri: string;
    readonly nowMs: number;
  }): void {
    this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{
        readonly workspace_id: string;
        readonly public_callback_ref: string;
        readonly state: string;
      }, [string]>(`
        SELECT workspace_id,public_callback_ref,state
          FROM airtable_sync_connections WHERE id=?
      `).get(input.connectionId);
      if (existing) {
        if (existing.state !== 'needs_reconnect'
            || existing.workspace_id !== input.workspaceId
            || existing.public_callback_ref !== input.publicCallbackRef) {
          throw new TypeError('airtable_oauth_reconnect_anchor_invalid');
        }
      } else {
        this.createConnection({
          id: input.connectionId,
          workspaceId: input.workspaceId,
          publicCallbackRef: input.publicCallbackRef,
          nowMs: input.nowMs
        });
      }
      this.createOAuthAttempt({
        id: input.attemptId,
        connectionId: input.connectionId,
        stored: input.stored,
        redirectUri: input.redirectUri,
        nowMs: input.nowMs
      });
    })();
  }

  bindProviderAccount(input: {
    readonly connectionId: string;
    readonly providerAccountId: string;
    readonly nowMs: number;
  }): boolean {
    parseSourceConnectionId(input.connectionId);
    if (input.providerAccountId.length < 3 || input.providerAccountId.length > 128) {
      throw new TypeError('airtable_provider_account_id_invalid');
    }
    return this.sqlite.query(`
      UPDATE airtable_sync_connections
         SET provider_account_id = ?, version = version + 1, updated_at_ms = ?
       WHERE id = ? AND state = 'draft' AND provider_account_id IS NULL
    `).run(input.providerAccountId, input.nowMs, input.connectionId).changes === 1;
  }

  createProvisioningRun(input: {
    readonly state: ManagedProvisioningState;
    readonly nowMs: number;
  }): void {
    parseSourceConnectionId(input.state.connectionId);
    if (input.state.version !== 1) throw new TypeError('airtable_sync_provisioning_initial_version_invalid');
    this.sqlite.query(`
      INSERT INTO airtable_sync_provisioning_runs(
        connection_id, phase, manifest_version, manifest_digest, state_json,
        state_version, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.state.connectionId,
      input.state.phase,
      input.state.manifestVersion,
      digest(input.state.manifestDigestSha256),
      canonicalJsonText(input.state as unknown as CanonicalJson),
      input.state.version,
      input.nowMs,
      input.nowMs
    );
  }

  saveOAuthGrantReference(input: {
    readonly connectionId: string;
    readonly stored: StoredAirtableOAuthGrant;
    readonly expectedVersion?: number;
    readonly nowMs: number;
  }): boolean {
    parseSourceConnectionId(input.connectionId);
    if (input.expectedVersion === undefined) {
      const result = this.sqlite.query(`
        INSERT INTO airtable_sync_grant_references(
          connection_id, secret_reference_id, secret_reference_version,
          secret_adapter_key, secret_adapter_version, access_expires_at,
          refresh_expires_at, scopes_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO NOTHING
      `).run(
        input.connectionId,
        input.stored.secretReference.id,
        input.stored.secretReference.version,
        input.stored.secretReference.adapter.key,
        input.stored.secretReference.adapter.version,
        input.stored.accessExpiresAt,
        input.stored.refreshExpiresAt,
        JSON.stringify(input.stored.scopes),
        input.nowMs,
        input.nowMs
      );
      return result.changes === 1;
    }
    const result = this.sqlite.query(`
      UPDATE airtable_sync_grant_references
         SET secret_reference_id = ?, secret_reference_version = ?,
             secret_adapter_key = ?, secret_adapter_version = ?,
             access_expires_at = ?, refresh_expires_at = ?, scopes_json = ?,
             version = version + 1, updated_at_ms = ?
       WHERE connection_id = ? AND version = ?
    `).run(
      input.stored.secretReference.id,
      input.stored.secretReference.version,
      input.stored.secretReference.adapter.key,
      input.stored.secretReference.adapter.version,
      input.stored.accessExpiresAt,
      input.stored.refreshExpiresAt,
      JSON.stringify(input.stored.scopes),
      input.nowMs,
      input.connectionId,
      input.expectedVersion
    );
    return result.changes === 1;
  }

  createOAuthAttempt(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly stored: StoredAirtableOAuthAttempt;
    readonly redirectUri: string;
    readonly nowMs: number;
  }): void {
    id(input.id, 'airtable_sync_oauth_attempt_id_invalid');
    parseSourceConnectionId(input.connectionId);
    const redirect = new URL(input.redirectUri);
    if (redirect.protocol !== 'https:' || redirect.hash || redirect.username || redirect.password) {
      throw new TypeError('airtable_sync_oauth_redirect_invalid');
    }
    this.sqlite.query(`
      INSERT INTO airtable_sync_oauth_attempts(
        id, connection_id, state_digest, secret_reference_id,
        secret_reference_version, secret_adapter_key, secret_adapter_version,
        redirect_uri, scopes_json, expires_at_ms, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.id,
      input.connectionId,
      digest(input.stored.stateDigestSha256),
      input.stored.secretReference.id,
      input.stored.secretReference.version,
      input.stored.secretReference.adapter.key,
      input.stored.secretReference.adapter.version,
      input.redirectUri,
      JSON.stringify(input.stored.scopes),
      Date.parse(input.stored.expiresAt),
      input.nowMs,
      input.nowMs
    );
  }

  claimOAuthAttempt(input: {
    readonly stateDigestSha256: string;
    readonly workerId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): AirtableOAuthAttemptClaim | undefined {
    if (!input.workerId || input.workerId.length > 160
      || !Number.isInteger(input.leaseMs) || input.leaseMs < 5_000 || input.leaseMs > 60_000) {
      throw new TypeError('airtable_sync_oauth_claim_invalid');
    }
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_oauth_attempts
           SET status = 'claimed', lease_owner = ?, lease_version = lease_version + 1,
               lease_expires_at_ms = ?, updated_at_ms = ?
         WHERE state_digest = ? AND expires_at_ms >= ?
           AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at_ms <= ?))
      `).run(
        input.workerId,
        input.nowMs + input.leaseMs,
        input.nowMs,
        digest(input.stateDigestSha256),
        input.nowMs,
        input.nowMs
      );
      if (updated.changes !== 1) return undefined;
      const row = this.sqlite.query<{
        readonly id: string;
        readonly connection_id: string;
        readonly state_digest: string;
        readonly secret_reference_id: string;
        readonly secret_reference_version: number;
        readonly secret_adapter_key: string;
        readonly secret_adapter_version: number;
        readonly redirect_uri: string;
        readonly scopes_json: string;
        readonly expires_at_ms: number;
        readonly lease_version: number;
      }, [string]>(`
        SELECT id, connection_id, state_digest, secret_reference_id,
               secret_reference_version, secret_adapter_key, secret_adapter_version,
               redirect_uri, scopes_json, expires_at_ms, lease_version
          FROM airtable_sync_oauth_attempts
         WHERE state_digest = ?
      `).get(input.stateDigestSha256);
      if (!row) throw new Error('airtable_sync_oauth_claim_missing');
      const reference = createSecretReference({
        id: row.secret_reference_id,
        version: row.secret_reference_version,
        adapter: createSecretStoreAdapterRef(row.secret_adapter_key, row.secret_adapter_version),
        purpose: AIRTABLE_SECRET_PURPOSES.attempt,
        scopeBinding: row.connection_id
      });
      return Object.freeze({
        id: row.id,
        connectionId: row.connection_id,
        stored: Object.freeze({
          secretReference: reference,
          stateDigestSha256: row.state_digest,
          scopes: Object.freeze(JSON.parse(row.scopes_json)),
          expiresAt: new Date(row.expires_at_ms).toISOString()
        }),
        redirectUri: row.redirect_uri,
        workerId: input.workerId,
        leaseVersion: row.lease_version
      });
    })();
  }

  finishOAuthAttempt(input: {
    readonly id: string;
    readonly workerId: string;
    readonly leaseVersion: number;
    readonly outcome: 'consumed' | 'failed';
    readonly nowMs: number;
  }): boolean {
    const updated = this.sqlite.query(`
      UPDATE airtable_sync_oauth_attempts
         SET status = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
             updated_at_ms = ?
       WHERE id = ? AND status = 'claimed' AND lease_owner = ? AND lease_version = ?
    `).run(input.outcome, input.nowMs, input.id, input.workerId, input.leaseVersion);
    return updated.changes === 1;
  }

  completeOAuthConnection(input: {
    readonly claim: AirtableOAuthAttemptClaim;
    readonly providerAccountId: string;
    readonly stored: StoredAirtableOAuthGrant;
    readonly nowMs: number;
  }): boolean {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{
        readonly state: string;
        readonly grant_version: number | null;
      }, [string]>(`
        SELECT connection.state,grant.version AS grant_version
          FROM airtable_sync_connections connection
          LEFT JOIN airtable_sync_grant_references grant ON grant.connection_id=connection.id
         WHERE connection.id=?
      `).get(input.claim.connectionId);
      if (existing?.state === 'needs_reconnect' && existing.grant_version !== null) {
        if (!this.saveOAuthGrantReference({
          connectionId: input.claim.connectionId,
          stored: input.stored,
          expectedVersion: existing.grant_version,
          nowMs: input.nowMs
        })) return false;
        const reconnected = this.sqlite.query(`
          UPDATE airtable_sync_connections
             SET state='active',provider_account_id=?,version=version+1,updated_at_ms=?
           WHERE id=? AND state='needs_reconnect'
        `).run(input.providerAccountId, input.nowMs, input.claim.connectionId);
        if (reconnected.changes !== 1) throw new Error('airtable_oauth_reconnect_raced');
        if (!this.finishOAuthAttempt({
          id: input.claim.id,
          workerId: input.claim.workerId,
          leaseVersion: input.claim.leaseVersion,
          outcome: 'consumed',
          nowMs: input.nowMs
        })) throw new Error('airtable_oauth_attempt_completion_raced');
        return true;
      }
      if (!this.saveOAuthGrantReference({
        connectionId: input.claim.connectionId,
        stored: input.stored,
        nowMs: input.nowMs
      })) return false;
      if (!this.bindProviderAccount({
        connectionId: input.claim.connectionId,
        providerAccountId: input.providerAccountId,
        nowMs: input.nowMs
      })) throw new Error('airtable_oauth_provider_binding_raced');
      if (!this.finishOAuthAttempt({
        id: input.claim.id,
        workerId: input.claim.workerId,
        leaseVersion: input.claim.leaseVersion,
        outcome: 'consumed',
        nowMs: input.nowMs
      })) throw new Error('airtable_oauth_attempt_completion_raced');
      return true;
    })();
  }

  async claim(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): Promise<ManagedProvisioningClaim | undefined> {
    parseSourceConnectionId(input.connectionId);
    if (!input.workerId || input.workerId.length > 160
      || !Number.isInteger(input.leaseMs) || input.leaseMs < 5_000 || input.leaseMs > 3_600_000) {
      throw new TypeError('airtable_sync_provisioning_claim_invalid');
    }
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_provisioning_runs
           SET lease_owner = ?,
               lease_version = lease_version + 1,
               lease_expires_at_ms = ?,
               updated_at_ms = ?
         WHERE connection_id = ?
           AND phase NOT IN ('ready', 'attention')
           AND (lease_owner IS NULL OR lease_expires_at_ms <= ?)
      `).run(
        input.workerId,
        input.nowMs + input.leaseMs,
        input.nowMs,
        input.connectionId,
        input.nowMs
      );
      if (updated.changes !== 1) return undefined;
      const row = this.sqlite.query<{
        readonly state_json: string;
        readonly lease_version: number;
      }, [string]>(`
        SELECT state_json, lease_version
          FROM airtable_sync_provisioning_runs
         WHERE connection_id = ?
      `).get(input.connectionId);
      if (!row) throw new Error('airtable_sync_provisioning_claim_missing');
      return Object.freeze({
        state: provisioningState(row.state_json),
        workerId: input.workerId,
        leaseVersion: row.lease_version
      });
    })();
  }

  async complete(input: {
    readonly claim: ManagedProvisioningClaim;
    readonly nextState: ManagedProvisioningState;
    readonly links: readonly SnapshotRecordLink[];
    readonly nowMs: number;
  }): Promise<boolean> {
    if (input.nextState.connectionId !== input.claim.state.connectionId
      || input.nextState.version !== input.claim.state.version + 1) {
      throw new TypeError('airtable_sync_provisioning_completion_invalid');
    }
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_provisioning_runs
           SET phase = ?, manifest_version = ?, manifest_digest = ?, state_json = ?,
               state_version = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
               updated_at_ms = ?
         WHERE connection_id = ? AND state_version = ?
           AND lease_owner = ? AND lease_version = ?
      `).run(
        input.nextState.phase,
        input.nextState.manifestVersion,
        digest(input.nextState.manifestDigestSha256),
        canonicalJsonText(input.nextState as unknown as CanonicalJson),
        input.nextState.version,
        input.nowMs,
        input.nextState.connectionId,
        input.claim.state.version,
        input.claim.workerId,
        input.claim.leaseVersion
      );
      if (updated.changes !== 1) return false;
      for (const link of input.links) {
        const table = input.nextState.binding?.tables.find((candidate) => candidate.key === link.tableKey);
        if (!table) throw new TypeError('airtable_sync_snapshot_link_table_missing');
        this.sqlite.query(`
          INSERT INTO airtable_sync_snapshot_links(
            connection_id, table_key, subject_key, provider_table_id,
            provider_record_id, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connection_id, table_key, subject_key) DO UPDATE SET
            provider_table_id = excluded.provider_table_id,
            provider_record_id = excluded.provider_record_id,
            updated_at_ms = excluded.updated_at_ms
        `).run(
          input.nextState.connectionId,
          link.tableKey,
          link.subjectKey,
          table.tableId,
          link.recordId,
          input.nowMs,
          input.nowMs
        );
      }
      return true;
    })();
  }

  addMappingRevision(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly revision: number;
    readonly manifestVersion: number;
    readonly status: 'draft' | 'assessing' | 'active' | 'superseded' | 'paused';
    readonly mappingDigest: string;
    readonly mapping: CanonicalJson;
    readonly nowMs: number;
  }): void {
    id(input.id, 'airtable_sync_mapping_id_invalid');
    parseSourceConnectionId(input.connectionId);
    this.sqlite.query(`
      INSERT INTO airtable_sync_mapping_revisions(
        id, connection_id, revision, manifest_version, status,
        mapping_digest, mapping_json, created_at_ms, activated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.connectionId,
      input.revision,
      input.manifestVersion,
      input.status,
      digest(input.mappingDigest),
      canonicalJsonText(input.mapping),
      input.nowMs,
      input.status === 'active' ? input.nowMs : null
    );
  }

  upsertRecordLink(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly mappingRevision: number;
    readonly areaKey: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly providerTableId: string;
    readonly providerRecordId: string;
    readonly canonicalVersion: number;
    readonly baseline: CanonicalJson;
    readonly baselineDigest: string;
    readonly providerFingerprint?: string;
    readonly nowMs: number;
  }): void {
    id(input.id, 'airtable_sync_record_link_id_invalid');
    parseSourceConnectionId(input.connectionId);
    this.sqlite.query(`
      INSERT INTO airtable_sync_record_links(
        id, connection_id, mapping_revision, area_key, subject_kind, subject_id,
        provider_table_id, provider_record_id, canonical_version,
        baseline_json, baseline_digest, provider_fingerprint, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, area_key, subject_kind, subject_id) DO UPDATE SET
        mapping_revision = excluded.mapping_revision,
        provider_table_id = excluded.provider_table_id,
        provider_record_id = excluded.provider_record_id,
        canonical_version = excluded.canonical_version,
        baseline_json = excluded.baseline_json,
        baseline_digest = excluded.baseline_digest,
        provider_fingerprint = excluded.provider_fingerprint,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      input.id,
      input.connectionId,
      input.mappingRevision,
      input.areaKey,
      input.subjectKind,
      input.subjectId,
      input.providerTableId,
      input.providerRecordId,
      input.canonicalVersion,
      canonicalJsonText(input.baseline),
      digest(input.baselineDigest),
      input.providerFingerprint ? digest(input.providerFingerprint) : null,
      input.nowMs
    );
  }

  finishSuccessfulProjectionWork(input: {
    readonly id: string;
    readonly workerId: string;
    readonly leaseVersion: number;
    readonly connectionId: string;
    readonly mappingRevision: number;
    readonly areaKey: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly providerTableId: string;
    readonly providerRecordId: string;
    readonly projectionVersion: number;
    readonly projectionFields: Readonly<Record<string, CanonicalJson>>;
    readonly providerFingerprint: string;
    readonly newRecordLinkId: () => string;
    readonly nowMs: number;
  }): boolean {
    return this.sqlite.transaction(() => {
      const finished = this.finishProjectionWork({
        id: input.id,
        workerId: input.workerId,
        leaseVersion: input.leaseVersion,
        outcome: 'succeeded',
        nowMs: input.nowMs
      });
      if (!finished) return false;
      this.upsertRecordLink({
        id: input.newRecordLinkId(),
        connectionId: input.connectionId,
        mappingRevision: input.mappingRevision,
        areaKey: input.areaKey,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        providerTableId: input.providerTableId,
        providerRecordId: input.providerRecordId,
        canonicalVersion: input.projectionVersion,
        baseline: input.projectionFields,
        baselineDigest: canonicalJsonSha256(input.projectionFields),
        providerFingerprint: input.providerFingerprint,
        nowMs: input.nowMs
      });
      this.sqlite.query(`
        UPDATE airtable_sync_health
           SET state = CASE
                 WHEN conflict_count + request_count + schema_drift_count + dead_letter_count > 0
                 THEN 'needs_review'
                 WHEN (SELECT count(*) FROM airtable_sync_projection_work
                        WHERE connection_id = ? AND status IN ('pending','running','failed')) > 0
                 THEN 'pending'
                 ELSE 'current'
               END,
               due_work = (SELECT count(*) FROM airtable_sync_projection_work
                             WHERE connection_id = ? AND status IN ('pending','running','failed')),
               last_outbound_at_ms = ?, version = version + 1, updated_at_ms = ?
         WHERE connection_id = ?
      `).run(
        input.connectionId,
        input.connectionId,
        input.nowMs,
        input.nowMs,
        input.connectionId
      );
      return true;
    })();
  }

  enqueueProjectionWork(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly mappingRevision: number;
    readonly areaKey: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly projectionVersion: number;
    readonly availableAtMs: number;
    readonly nowMs: number;
    readonly sourceOperationLogId?: string;
  }): void {
    id(input.id, 'airtable_sync_work_id_invalid');
    parseSourceConnectionId(input.connectionId);
    this.sqlite.query(`
      INSERT INTO airtable_sync_projection_work(
        id, connection_id, mapping_revision, area_key, subject_kind, subject_id,
        requested_projection_version, status, available_at_ms, created_at_ms, updated_at_ms,
        latest_operation_log_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(connection_id, area_key, subject_kind, subject_id) DO UPDATE SET
        mapping_revision = excluded.mapping_revision,
        requested_projection_version = max(
          airtable_sync_projection_work.requested_projection_version,
          excluded.requested_projection_version
        ),
        status = CASE
          WHEN excluded.requested_projection_version >
            airtable_sync_projection_work.requested_projection_version
          THEN 'pending'
          ELSE airtable_sync_projection_work.status
        END,
        available_at_ms = min(
          airtable_sync_projection_work.available_at_ms,
          excluded.available_at_ms
        ),
        lease_owner = CASE
          WHEN excluded.requested_projection_version >
            airtable_sync_projection_work.requested_projection_version
          THEN NULL
          ELSE airtable_sync_projection_work.lease_owner
        END,
        lease_expires_at_ms = CASE
          WHEN excluded.requested_projection_version >
            airtable_sync_projection_work.requested_projection_version
          THEN NULL
          ELSE airtable_sync_projection_work.lease_expires_at_ms
        END,
        updated_at_ms = excluded.updated_at_ms,
        latest_operation_log_id = coalesce(
          excluded.latest_operation_log_id,
          airtable_sync_projection_work.latest_operation_log_id
        )
    `).run(
      input.id,
      input.connectionId,
      input.mappingRevision,
      input.areaKey,
      input.subjectKind,
      input.subjectId,
      input.projectionVersion,
      input.availableAtMs,
      input.nowMs,
      input.nowMs,
      input.sourceOperationLogId ?? null
    );
  }

  listDueProjectionConnections(input: {
    readonly nowMs: number;
    readonly limit: number;
  }): readonly string[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('airtable_sync_due_connection_limit_invalid');
    }
    return Object.freeze(this.sqlite.query<{ readonly connection_id: string }, [number, number]>(`
      SELECT connection_id
        FROM airtable_sync_projection_work
       WHERE available_at_ms <= ?
         AND (
           status IN ('pending', 'failed')
           OR (status = 'running' AND lease_expires_at_ms <= ?)
         )
       GROUP BY connection_id
       ORDER BY min(available_at_ms), connection_id
       LIMIT ${input.limit}
    `).all(input.nowMs, input.nowMs).map((row) => row.connection_id));
  }

  claimConnectionLease(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): AirtableConnectionLease | undefined {
    parseSourceConnectionId(input.connectionId);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 5_000 || input.leaseMs > 3_600_000) {
      throw new TypeError('airtable_sync_connection_lease_duration_invalid');
    }
    return this.sqlite.transaction(() => {
      this.sqlite.query(`
        INSERT INTO airtable_sync_connection_runtime(
          connection_id, lease_version, updated_at_ms
        ) VALUES (?, 0, ?)
        ON CONFLICT(connection_id) DO NOTHING
      `).run(input.connectionId, input.nowMs);
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_connection_runtime
           SET lease_owner = ?,
               lease_version = lease_version + 1,
               lease_expires_at_ms = ?,
               updated_at_ms = ?
         WHERE connection_id = ?
           AND (lease_owner IS NULL OR lease_expires_at_ms <= ?)
      `).run(
        input.workerId,
        input.nowMs + input.leaseMs,
        input.nowMs,
        input.connectionId,
        input.nowMs
      );
      if (updated.changes !== 1) return undefined;
      const row = this.sqlite.query<{
        readonly lease_version: number;
      }, [string]>(`
        SELECT lease_version
          FROM airtable_sync_connection_runtime
         WHERE connection_id = ?
      `).get(input.connectionId);
      if (!row) throw new Error('airtable_sync_connection_lease_missing');
      return Object.freeze({
        connectionId: input.connectionId,
        workerId: input.workerId,
        fence: row.lease_version
      });
    })();
  }

  releaseConnectionLease(input: {
    readonly lease: AirtableConnectionLease;
    readonly nowMs: number;
  }): boolean {
    return this.sqlite.query(`
      UPDATE airtable_sync_connection_runtime
         SET lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
       WHERE connection_id = ? AND lease_owner = ? AND lease_version = ?
    `).run(
      input.nowMs,
      input.lease.connectionId,
      input.lease.workerId,
      input.lease.fence
    ).changes === 1;
  }

  providerThrottleNotBefore(baseId: string): number {
    return this.sqlite.query<{
      readonly not_before_ms: number;
    }, [string]>(`
      SELECT not_before_ms FROM airtable_sync_provider_throttle
       WHERE provider_base_id = ?
    `).get(baseId)?.not_before_ms ?? 0;
  }

  observeProviderThrottle(input: {
    readonly baseId: string;
    readonly notBeforeMs: number;
    readonly reasonCode: string;
    readonly nowMs: number;
  }): void {
    this.sqlite.query(`
      INSERT INTO airtable_sync_provider_throttle(
        provider_base_id, not_before_ms, reason_code, updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_base_id) DO UPDATE SET
        not_before_ms = max(
          airtable_sync_provider_throttle.not_before_ms,
          excluded.not_before_ms
        ),
        reason_code = excluded.reason_code,
        updated_at_ms = excluded.updated_at_ms
    `).run(input.baseId, input.notBeforeMs, input.reasonCode, input.nowMs);
  }

  saveWebhookRegistration(input: {
    readonly connectionId: string;
    readonly baseId: string;
    readonly webhookId: string;
    readonly macSecret: StoredAirtableWebhookMacSecret;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): void {
    parseSourceConnectionId(input.connectionId);
    parseAirtableBaseId(input.baseId);
    parseAirtableWebhookId(input.webhookId);
    if (input.macSecret.secretReference.purpose !== AIRTABLE_SECRET_PURPOSES.webhookMac
      || input.macSecret.secretReference.scopeBinding !== input.connectionId) {
      throw new TypeError('airtable_webhook_mac_reference_invalid');
    }
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        INSERT INTO airtable_sync_webhook_registrations(
          connection_id, provider_base_id, provider_webhook_id,
          mac_secret_reference_id, mac_secret_reference_version,
          mac_secret_adapter_key, mac_secret_adapter_version,
          expires_at_ms, status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        input.connectionId,
        input.baseId,
        input.webhookId,
        input.macSecret.secretReference.id,
        input.macSecret.secretReference.version,
        input.macSecret.secretReference.adapter.key,
        input.macSecret.secretReference.adapter.version,
        input.expiresAtMs,
        input.nowMs,
        input.nowMs
      );
      this.sqlite.query(`
        INSERT INTO airtable_sync_webhook_cursors(
          connection_id, provider_webhook_id, cursor, last_transaction_number,
          expires_at_ms, updated_at_ms
        ) VALUES (?, ?, NULL, 0, ?, ?)
      `).run(input.connectionId, input.webhookId, input.expiresAtMs, input.nowMs);
    })();
  }

  refreshWebhookRegistration(input: {
    readonly connectionId: string;
    readonly webhookId: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean {
    parseSourceConnectionId(input.connectionId);
    parseAirtableWebhookId(input.webhookId);
    return this.sqlite.transaction(() => {
      const registration = this.sqlite.query(`
        UPDATE airtable_sync_webhook_registrations
           SET expires_at_ms = ?, status = 'active', version = version + 1,
               updated_at_ms = ?
         WHERE connection_id = ? AND provider_webhook_id = ?
           AND status IN ('active', 'renewal_due')
      `).run(input.expiresAtMs, input.nowMs, input.connectionId, input.webhookId);
      if (registration.changes !== 1) return false;
      const cursor = this.sqlite.query(`
        UPDATE airtable_sync_webhook_cursors
           SET expires_at_ms = ?, version = version + 1, updated_at_ms = ?
         WHERE connection_id = ? AND provider_webhook_id = ?
      `).run(input.expiresAtMs, input.nowMs, input.connectionId, input.webhookId);
      if (cursor.changes !== 1) throw new Error('airtable_webhook_cursor_missing');
      return true;
    })();
  }

  deleteWebhookRegistration(input: {
    readonly connectionId: string;
    readonly webhookId: string;
    readonly nowMs: number;
  }): boolean {
    parseSourceConnectionId(input.connectionId);
    parseAirtableWebhookId(input.webhookId);
    return this.sqlite.query(`
      UPDATE airtable_sync_webhook_registrations
         SET status = 'deleted', version = version + 1, updated_at_ms = ?
       WHERE connection_id = ? AND provider_webhook_id = ? AND status <> 'deleted'
    `).run(input.nowMs, input.connectionId, input.webhookId).changes === 1;
  }

  resolveConnectionIdByCallbackRef(callbackRef: string): SourceConnectionId | undefined {
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(callbackRef)) return undefined;
    const row = this.sqlite.query<{ readonly id: string }, [string]>(`
      SELECT connection.id
        FROM airtable_sync_connections AS connection
        JOIN airtable_sync_webhook_registrations AS registration
          ON registration.connection_id = connection.id AND registration.status = 'active'
       WHERE connection.public_callback_ref = ? AND connection.state = 'active'
    `).get(callbackRef);
    return row ? parseSourceConnectionId(row.id) : undefined;
  }

  readWebhookMacRegistration(sourceConnectionId: SourceConnectionId): Readonly<{
    baseId: ReturnType<typeof parseAirtableBaseId>;
    webhookId: ReturnType<typeof parseAirtableWebhookId>;
    stored: StoredAirtableWebhookMacSecret;
  }> | undefined {
    const row = this.sqlite.query<{
      readonly provider_base_id: string;
      readonly provider_webhook_id: string;
      readonly mac_secret_reference_id: string;
      readonly mac_secret_reference_version: number;
      readonly mac_secret_adapter_key: string;
      readonly mac_secret_adapter_version: number;
    }, [string]>(`
      SELECT registration.provider_base_id, registration.provider_webhook_id,
             registration.mac_secret_reference_id, registration.mac_secret_reference_version,
             registration.mac_secret_adapter_key, registration.mac_secret_adapter_version
        FROM airtable_sync_webhook_registrations AS registration
        JOIN airtable_sync_connections AS connection
          ON connection.id = registration.connection_id AND connection.state = 'active'
       WHERE registration.connection_id = ? AND registration.status = 'active'
    `).get(sourceConnectionId);
    if (!row) return undefined;
    return Object.freeze({
      baseId: parseAirtableBaseId(row.provider_base_id),
      webhookId: parseAirtableWebhookId(row.provider_webhook_id),
      stored: Object.freeze({
        secretReference: createSecretReference({
          id: row.mac_secret_reference_id,
          version: row.mac_secret_reference_version,
          adapter: createSecretStoreAdapterRef(
            row.mac_secret_adapter_key,
            row.mac_secret_adapter_version
          ),
          purpose: AIRTABLE_SECRET_PURPOSES.webhookMac,
          scopeBinding: sourceConnectionId
        })
      })
    });
  }

  readInboundCursor(connectionId: string): AirtableInboundCursorState | undefined {
    parseSourceConnectionId(connectionId);
    const row = this.sqlite.query<{
      readonly mapping_revision: number;
      readonly provider_base_id: string;
      readonly provider_webhook_id: string;
      readonly cursor: string | null;
      readonly last_transaction_number: number;
    }, [string]>(`
      SELECT mapping.revision AS mapping_revision,
             registration.provider_base_id,
             registration.provider_webhook_id,
             cursor.cursor,
             cursor.last_transaction_number
        FROM airtable_sync_webhook_registrations AS registration
        JOIN airtable_sync_webhook_cursors AS cursor
          ON cursor.connection_id = registration.connection_id
         AND cursor.provider_webhook_id = registration.provider_webhook_id
        JOIN airtable_sync_connections AS connection
          ON connection.id = registration.connection_id
         AND connection.state = 'active'
        JOIN airtable_sync_mapping_revisions AS mapping
          ON mapping.connection_id = connection.id AND mapping.status = 'active'
       WHERE registration.connection_id = ? AND registration.status = 'active'
    `).get(connectionId);
    if (!row) return undefined;
    return Object.freeze({
      connectionId,
      mappingRevision: row.mapping_revision,
      baseId: parseAirtableBaseId(row.provider_base_id),
      webhookId: parseAirtableWebhookId(row.provider_webhook_id),
      ...(row.cursor === null ? {} : { cursor: parseAirtableCursor(row.cursor) }),
      lastTransactionNumber: row.last_transaction_number
    });
  }

  commitInboundCursorPage(input: {
    readonly state: AirtableInboundCursorState;
    readonly nextCursor: string;
    readonly nextTransactionNumber: number;
    readonly candidates: readonly AirtableSettleCandidate[];
    readonly settleNotBeforeMs: number;
    readonly nowMs: number;
    readonly newSettleId: () => string;
  }): boolean {
    parseAirtableCursor(input.nextCursor);
    for (const candidate of input.candidates) {
      parseAirtableTableId(candidate.tableId);
      parseAirtableRecordId(candidate.recordId);
      candidate.changedFieldIds.forEach(parseAirtableFieldId);
      if (!Number.isSafeInteger(Date.parse(candidate.observedAt))) {
        throw new TypeError('airtable_webhook_observed_at_invalid');
      }
    }
    return this.sqlite.transaction(() => {
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_webhook_cursors
           SET cursor = ?, last_transaction_number = ?, updated_at_ms = ?
         WHERE connection_id = ? AND provider_webhook_id = ?
           AND cursor IS ? AND last_transaction_number = ?
           AND EXISTS (
             SELECT 1 FROM airtable_sync_mapping_revisions
              WHERE connection_id = ? AND revision = ? AND status = 'active'
           )
      `).run(
        input.nextCursor,
        input.nextTransactionNumber,
        input.nowMs,
        input.state.connectionId,
        input.state.webhookId,
        input.state.cursor ?? null,
        input.state.lastTransactionNumber,
        input.state.connectionId,
        input.state.mappingRevision
      );
      if (updated.changes !== 1) return false;
      for (const candidate of input.candidates) {
        this.scheduleSettle({
          id: input.newSettleId(),
          connectionId: input.state.connectionId,
          mappingRevision: input.state.mappingRevision,
          providerTableId: candidate.tableId,
          providerRecordId: candidate.recordId,
          transactionNumber: candidate.transactionNumber,
          changeKind: candidate.kind,
          changedFieldIds: candidate.changedFieldIds,
          providerSource: candidate.source,
          ...(candidate.actor?.id ? { providerActorId: candidate.actor.id } : {}),
          ...(candidate.actor?.email ? { providerActorEmail: candidate.actor.email } : {}),
          ...(candidate.actor?.displayName
            ? { providerActorDisplayName: candidate.actor.displayName }
            : {}),
          observedAtMs: Date.parse(candidate.observedAt),
          notBeforeMs: input.settleNotBeforeMs,
          nowMs: input.nowMs
        });
      }
      return true;
    })();
  }

  claimDueProjectionWork(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
    readonly limit: number;
  }): readonly AirtableSyncClaimedWork[] {
    parseSourceConnectionId(input.connectionId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('airtable_sync_claim_limit_invalid');
    }
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 5_000 || input.leaseMs > 3_600_000) {
      throw new TypeError('airtable_sync_lease_duration_invalid');
    }
    return this.sqlite.transaction(() => {
      const ids = this.sqlite.query<{ readonly id: string }, [string, number, number]>(`
        SELECT id
          FROM airtable_sync_projection_work
         WHERE connection_id = ?
           AND available_at_ms <= ?
           AND (
             status IN ('pending', 'failed')
             OR (status = 'running' AND lease_expires_at_ms <= ?)
           )
         ORDER BY available_at_ms, id
         LIMIT ${input.limit}
      `).all(input.connectionId, input.nowMs, input.nowMs);
      const claimed: AirtableSyncClaimedWork[] = [];
      for (const candidate of ids) {
        const result = this.sqlite.query(`
          UPDATE airtable_sync_projection_work
             SET status = 'running',
                 attempts = attempts + 1,
                 lease_owner = ?,
                 lease_version = lease_version + 1,
                 lease_expires_at_ms = ?,
                 updated_at_ms = ?
           WHERE id = ?
             AND (
               status IN ('pending', 'failed')
               OR (status = 'running' AND lease_expires_at_ms <= ?)
             )
        `).run(
          input.workerId,
          input.nowMs + input.leaseMs,
          input.nowMs,
          candidate.id,
          input.nowMs
        );
        if (result.changes !== 1) continue;
        const row = this.sqlite.query<WorkRow, [string]>(`
          SELECT id, connection_id, mapping_revision, area_key, subject_kind, subject_id,
                 requested_projection_version, attempts, lease_owner, lease_version,
                 lease_expires_at_ms
            FROM airtable_sync_projection_work
           WHERE id = ?
        `).get(candidate.id);
        if (!row) throw new Error('airtable_sync_claimed_work_missing');
        claimed.push(Object.freeze({
          id: row.id,
          connectionId: row.connection_id,
          mappingRevision: row.mapping_revision,
          areaKey: row.area_key,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          requestedProjectionVersion: row.requested_projection_version,
          attempts: row.attempts,
          leaseOwner: row.lease_owner,
          leaseVersion: row.lease_version,
          leaseExpiresAtMs: row.lease_expires_at_ms
        }));
      }
      return Object.freeze(claimed);
    })();
  }

  finishProjectionWork(input: {
    readonly id: string;
    readonly workerId: string;
    readonly leaseVersion: number;
    readonly outcome: 'succeeded' | 'failed' | 'attention';
    readonly nowMs: number;
    readonly nextAttemptAtMs?: number;
    readonly errorCode?: string;
  }): boolean {
    if (input.outcome === 'failed' && input.nextAttemptAtMs === undefined) {
      throw new TypeError('airtable_sync_retry_time_required');
    }
    const result = this.sqlite.query(`
      UPDATE airtable_sync_projection_work
         SET status = ?,
             available_at_ms = ?,
             lease_owner = NULL,
             lease_expires_at_ms = NULL,
             last_error_code = ?,
             updated_at_ms = ?
       WHERE id = ? AND status = 'running'
         AND lease_owner = ? AND lease_version = ?
    `).run(
      input.outcome,
      input.nextAttemptAtMs ?? input.nowMs,
      input.errorCode ?? null,
      input.nowMs,
      input.id,
      input.workerId,
      input.leaseVersion
    );
    return result.changes === 1;
  }

  advanceWebhookCursor(input: {
    readonly connectionId: string;
    readonly providerWebhookId: string;
    readonly cursor: string;
    readonly transactionNumber: number;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean {
    parseSourceConnectionId(input.connectionId);
    const existing = this.sqlite.query<{
      readonly last_transaction_number: number;
    }, [string]>(`
      SELECT last_transaction_number
        FROM airtable_sync_webhook_cursors
       WHERE connection_id = ?
    `).get(input.connectionId);
    if (existing && input.transactionNumber < existing.last_transaction_number) return false;
    const result = this.sqlite.query(`
      INSERT INTO airtable_sync_webhook_cursors(
        connection_id, provider_webhook_id, cursor, last_transaction_number,
        expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        provider_webhook_id = excluded.provider_webhook_id,
        cursor = excluded.cursor,
        last_transaction_number = excluded.last_transaction_number,
        expires_at_ms = excluded.expires_at_ms,
        version = airtable_sync_webhook_cursors.version + 1,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.last_transaction_number >=
        airtable_sync_webhook_cursors.last_transaction_number
    `).run(
      input.connectionId,
      input.providerWebhookId,
      input.cursor,
      input.transactionNumber,
      input.expiresAtMs,
      input.nowMs
    );
    return result.changes === 1;
  }

  scheduleSettle(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly mappingRevision: number;
    readonly providerTableId: string;
    readonly providerRecordId: string;
    readonly transactionNumber: number;
    readonly changeKind?: 'created' | 'updated' | 'destroyed';
    readonly changedFieldIds?: readonly string[];
    readonly providerSource?: string;
    readonly providerActorId?: string;
    readonly providerActorEmail?: string;
    readonly providerActorDisplayName?: string;
    readonly observedAtMs?: number;
    readonly notBeforeMs: number;
    readonly nowMs: number;
  }): void {
    id(input.id, 'airtable_sync_settle_id_invalid');
    parseSourceConnectionId(input.connectionId);
    this.sqlite.query(`
      INSERT INTO airtable_sync_settle_heads(
        id, connection_id, mapping_revision, provider_table_id, provider_record_id,
        latest_transaction_number, change_kind, changed_field_ids_json, provider_source,
        provider_actor_id, provider_actor_email, provider_actor_display_name,
        observed_at_ms, not_before_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, provider_table_id, provider_record_id) DO UPDATE SET
        mapping_revision = excluded.mapping_revision,
        latest_transaction_number = max(
          airtable_sync_settle_heads.latest_transaction_number,
          excluded.latest_transaction_number
        ),
        change_kind = CASE
          WHEN excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
          THEN excluded.change_kind ELSE airtable_sync_settle_heads.change_kind END,
        not_before_ms = max(
          airtable_sync_settle_heads.not_before_ms,
          excluded.not_before_ms
        ),
        changed_field_ids_json = CASE
          WHEN excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
          THEN excluded.changed_field_ids_json ELSE airtable_sync_settle_heads.changed_field_ids_json END,
        provider_source = CASE
          WHEN excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
          THEN excluded.provider_source ELSE airtable_sync_settle_heads.provider_source END,
        provider_actor_id = CASE
          WHEN excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
          THEN excluded.provider_actor_id ELSE airtable_sync_settle_heads.provider_actor_id END,
        provider_actor_email = CASE
          WHEN excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
          THEN excluded.provider_actor_email ELSE airtable_sync_settle_heads.provider_actor_email END,
        provider_actor_display_name = CASE
          WHEN excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
          THEN excluded.provider_actor_display_name ELSE airtable_sync_settle_heads.provider_actor_display_name END,
        observed_at_ms = max(airtable_sync_settle_heads.observed_at_ms, excluded.observed_at_ms),
        status = 'pending',
        lease_owner = NULL,
        lease_expires_at_ms = NULL,
        last_error_code = NULL,
        version = airtable_sync_settle_heads.version + 1,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.latest_transaction_number >= airtable_sync_settle_heads.latest_transaction_number
    `).run(
      input.id,
      input.connectionId,
      input.mappingRevision,
      input.providerTableId,
      input.providerRecordId,
      input.transactionNumber,
      input.changeKind ?? 'updated',
      JSON.stringify([...(input.changedFieldIds ?? [])].sort()),
      input.providerSource ?? 'unknown',
      input.providerActorId ?? null,
      input.providerActorEmail ?? null,
      input.providerActorDisplayName ?? null,
      input.observedAtMs ?? input.nowMs,
      input.notBeforeMs,
      input.nowMs,
      input.nowMs
    );
  }

  listDueSettleHeads(input: {
    readonly connectionId: string;
    readonly nowMs: number;
    readonly limit: number;
  }): readonly {
    readonly id: string;
    readonly providerTableId: string;
    readonly providerRecordId: string;
    readonly transactionNumber: number;
    readonly version: number;
  }[] {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('airtable_sync_settle_limit_invalid');
    }
    return Object.freeze(this.sqlite.query<{
      readonly id: string;
      readonly provider_table_id: string;
      readonly provider_record_id: string;
      readonly latest_transaction_number: number;
      readonly version: number;
    }, [string, number, number]>(`
      SELECT id, provider_table_id, provider_record_id, latest_transaction_number, version
        FROM airtable_sync_settle_heads
       WHERE connection_id = ? AND not_before_ms <= ?
         AND (status = 'pending' OR (status = 'running' AND lease_expires_at_ms <= ?))
       ORDER BY not_before_ms, id
       LIMIT ${input.limit}
    `).all(input.connectionId, input.nowMs, input.nowMs).map((row) => Object.freeze({
      id: row.id,
      providerTableId: row.provider_table_id,
      providerRecordId: row.provider_record_id,
      transactionNumber: row.latest_transaction_number,
      version: row.version
    })));
  }

  claimNextShadowSettle(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): AirtableShadowSettleClaim | undefined {
    parseSourceConnectionId(input.connectionId);
    if (!input.workerId || input.workerId.length > 160
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 5_000
      || input.leaseMs > 3_600_000) {
      throw new TypeError('airtable_shadow_settle_claim_invalid');
    }
    return this.sqlite.transaction(() => {
      const candidate = this.sqlite.query<{ readonly id: string }, [string, number, number]>(`
        SELECT settle.id
          FROM airtable_sync_settle_heads AS settle
          JOIN airtable_sync_connections AS connection
            ON connection.id = settle.connection_id AND connection.state = 'active'
         WHERE settle.connection_id = ? AND settle.not_before_ms <= ?
           AND (
             settle.status = 'pending'
             OR (settle.status = 'running' AND settle.lease_expires_at_ms <= ?)
           )
         ORDER BY settle.not_before_ms, settle.id
         LIMIT 1
      `).get(input.connectionId, input.nowMs, input.nowMs);
      if (!candidate) return undefined;
      const claimed = this.sqlite.query(`
        UPDATE airtable_sync_settle_heads
           SET status = 'running', attempts = attempts + 1,
               lease_owner = ?, lease_version = lease_version + 1,
               lease_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND (
           status = 'pending' OR (status = 'running' AND lease_expires_at_ms <= ?)
         )
      `).run(
        input.workerId,
        input.nowMs + input.leaseMs,
        input.nowMs,
        candidate.id,
        input.nowMs
      );
      if (claimed.changes !== 1) return undefined;
      const row = this.sqlite.query<{
        readonly id: string;
        readonly connection_id: string;
        readonly mapping_revision: number;
        readonly provider_table_id: string;
        readonly provider_record_id: string;
        readonly latest_transaction_number: number;
        readonly version: number;
        readonly change_kind: 'created' | 'updated' | 'destroyed';
        readonly provider_source: string;
        readonly provider_actor_id: string | null;
        readonly provider_actor_email: string | null;
        readonly provider_actor_display_name: string | null;
        readonly observed_at_ms: number;
        readonly lease_owner: string;
        readonly lease_version: number;
      }, [string]>(`
        SELECT id, connection_id, mapping_revision, provider_table_id,
               provider_record_id, latest_transaction_number, version, change_kind,
               provider_source, provider_actor_id, provider_actor_email,
               provider_actor_display_name, observed_at_ms,
               lease_owner, lease_version
          FROM airtable_sync_settle_heads
         WHERE id = ?
      `).get(candidate.id);
      if (!row) throw new Error('airtable_shadow_settle_claim_missing');
      return Object.freeze({
        settleId: row.id,
        connectionId: row.connection_id,
        mappingRevision: row.mapping_revision,
        providerTableId: parseAirtableTableId(row.provider_table_id),
        providerRecordId: parseAirtableRecordId(row.provider_record_id),
        transactionNumber: row.latest_transaction_number,
        settleRevision: row.version,
        changeKind: row.change_kind,
        providerSource: row.provider_source,
        ...(
          row.provider_actor_id || row.provider_actor_email || row.provider_actor_display_name
            ? { providerActor: Object.freeze({
                ...(row.provider_actor_id ? { id: row.provider_actor_id } : {}),
                ...(row.provider_actor_email ? { email: row.provider_actor_email } : {}),
                ...(row.provider_actor_display_name ? { displayName: row.provider_actor_display_name } : {})
              }) }
            : {}
        ),
        observedAtMs: row.observed_at_ms,
        workerId: row.lease_owner,
        leaseVersion: row.lease_version
      });
    })();
  }

  readShadowSettleStorageContext(claim: AirtableShadowSettleClaim): Readonly<{
    baseId: ReturnType<typeof parseAirtableBaseId>;
    recordLinkId: string;
    areaKey: string;
    subjectKind: string;
    subjectId: string;
    mapping: CanonicalJson;
    baseline: Readonly<Record<string, CanonicalJson>>;
  }> | undefined {
    const row = this.sqlite.query<{
      readonly provider_base_id: string;
      readonly record_link_id: string;
      readonly area_key: string;
      readonly subject_kind: string;
      readonly subject_id: string;
      readonly mapping_json: string;
      readonly baseline_json: string;
    }, [string, string, number, number]>(`
      SELECT registration.provider_base_id, link.id AS record_link_id,
             link.area_key, link.subject_kind, link.subject_id,
             mapping.mapping_json, link.baseline_json
        FROM airtable_sync_settle_heads AS settle
        JOIN airtable_sync_webhook_registrations AS registration
          ON registration.connection_id = settle.connection_id
         AND registration.status = 'active'
        JOIN airtable_sync_mapping_revisions AS mapping
          ON mapping.connection_id = settle.connection_id
         AND mapping.revision = settle.mapping_revision
         AND mapping.status = 'active'
        JOIN airtable_sync_record_links AS link
          ON link.connection_id = settle.connection_id
         AND link.mapping_revision = settle.mapping_revision
         AND link.provider_table_id = settle.provider_table_id
         AND link.provider_record_id = settle.provider_record_id
       WHERE settle.id = ? AND settle.lease_owner = ? AND settle.lease_version = ?
         AND settle.status = 'running' AND settle.latest_transaction_number = ?
    `).get(
      claim.settleId,
      claim.workerId,
      claim.leaseVersion,
      claim.transactionNumber
    );
    if (!row) return undefined;
    return Object.freeze({
      baseId: parseAirtableBaseId(row.provider_base_id),
      recordLinkId: row.record_link_id,
      areaKey: row.area_key,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      mapping: JSON.parse(row.mapping_json) as CanonicalJson,
      baseline: Object.freeze(JSON.parse(row.baseline_json)) as Readonly<Record<string, CanonicalJson>>
    });
  }

  completeShadowSettle(input: {
    readonly claim: AirtableShadowSettleClaim;
    readonly outcome:
      | { readonly kind: 'observed'; readonly evaluation: AirtableShadowEvaluation }
      | { readonly kind: 'retry'; readonly code: string; readonly notBeforeMs: number }
      | { readonly kind: 'attention'; readonly code: string };
    readonly nowMs: number;
    readonly newFindingId: () => string;
    readonly newWorkId: () => string;
  }): boolean {
    return this.sqlite.transaction(() => {
      const status = input.outcome.kind === 'observed'
        ? 'observed'
        : input.outcome.kind === 'retry' ? 'pending' : 'attention';
      const completed = this.sqlite.query(`
        UPDATE airtable_sync_settle_heads
           SET status = ?, not_before_ms = ?, last_error_code = ?,
               lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND connection_id = ? AND mapping_revision = ?
           AND latest_transaction_number = ? AND status = 'running'
           AND lease_owner = ? AND lease_version = ?
           AND EXISTS (
             SELECT 1 FROM airtable_sync_mapping_revisions
              WHERE connection_id = ? AND revision = ? AND status = 'active'
           )
      `).run(
        status,
        input.outcome.kind === 'retry' ? input.outcome.notBeforeMs : input.nowMs,
        input.outcome.kind === 'observed' ? null : input.outcome.code,
        input.nowMs,
        input.claim.settleId,
        input.claim.connectionId,
        input.claim.mappingRevision,
        input.claim.transactionNumber,
        input.claim.workerId,
        input.claim.leaseVersion,
        input.claim.connectionId,
        input.claim.mappingRevision
      );
      if (completed.changes !== 1) return false;
      if (input.outcome.kind !== 'observed') return true;
      const link = this.sqlite.query<{
        readonly id: string;
        readonly area_key: string;
        readonly subject_kind: string;
        readonly subject_id: string;
        readonly canonical_version: number;
      }, [string, string, string, number]>(`
        SELECT id, area_key, subject_kind, subject_id, canonical_version
          FROM airtable_sync_record_links
         WHERE connection_id = ? AND provider_table_id = ? AND provider_record_id = ?
           AND mapping_revision = ?
      `).get(
        input.claim.connectionId,
        input.claim.providerTableId,
        input.claim.providerRecordId,
        input.claim.mappingRevision
      );
      if (!link) throw new Error('airtable_shadow_record_link_missing');
      for (const finding of input.outcome.evaluation.fields) {
        const findingId = input.newFindingId();
        id(findingId, 'airtable_shadow_finding_id_invalid');
        this.sqlite.query(`
          INSERT INTO airtable_sync_shadow_findings(
            id, settle_id, connection_id, mapping_revision, record_link_id,
            provider_transaction_number, settle_revision, field_key, provider_field_id, mode,
            classification, disposition, base_digest, local_digest, remote_digest,
            observed_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          findingId,
          input.claim.settleId,
          input.claim.connectionId,
          input.claim.mappingRevision,
          link.id,
          input.claim.transactionNumber,
          input.claim.settleRevision ?? 1,
          finding.fieldKey,
          finding.fieldId,
          finding.mode,
          finding.dataClassification,
          finding.disposition,
          canonicalJsonSha256(finding.base),
          canonicalJsonSha256(finding.local),
          canonicalJsonSha256(finding.remote),
          input.nowMs
        );
      }
      // A provider re-read is the point at which a missed-wake repair can safely
      // distinguish a local-only change from a same-field conflict. Queue the
      // canonical projection only after that comparison has completed.
      if (input.outcome.evaluation.needsOutbound) {
        this.enqueueProjectionWork({
          id: input.newWorkId(),
          connectionId: input.claim.connectionId,
          mappingRevision: input.claim.mappingRevision,
          areaKey: link.area_key,
          subjectKind: link.subject_kind,
          subjectId: link.subject_id,
          projectionVersion: link.canonical_version,
          availableAtMs: input.nowMs,
          nowMs: input.nowMs
        });
      }
      this.sqlite.query(`
        UPDATE airtable_sync_health
           SET state = CASE
                 WHEN conflict_count + request_count + schema_drift_count + dead_letter_count > 0
                 THEN 'needs_review'
                 WHEN (SELECT count(*) FROM airtable_sync_projection_work
                        WHERE connection_id = ? AND status IN ('pending','running','failed')) > 0
                 THEN 'pending'
                 ELSE 'current'
               END,
               due_work = (SELECT count(*) FROM airtable_sync_projection_work
                             WHERE connection_id = ? AND status IN ('pending','running','failed')),
               last_inbound_at_ms = ?, version = version + 1, updated_at_ms = ?
         WHERE connection_id = ?
      `).run(
        input.claim.connectionId,
        input.claim.connectionId,
        input.nowMs,
        input.nowMs,
        input.claim.connectionId
      );
      return true;
    })();
  }

  listShadowFindingSummaries(input: {
    readonly connectionId: string;
    readonly limit: number;
  }): readonly Readonly<{
    fieldKey: string;
    disposition: AirtableShadowEvaluation['fields'][number]['disposition'];
    transactionNumber: number;
    observedAtMs: number;
  }>[] {
    parseSourceConnectionId(input.connectionId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TypeError('airtable_shadow_finding_limit_invalid');
    }
    return Object.freeze(this.sqlite.query<{
      readonly field_key: string;
      readonly disposition: AirtableShadowEvaluation['fields'][number]['disposition'];
      readonly provider_transaction_number: number;
      readonly observed_at_ms: number;
    }, [string]>(`
      SELECT field_key, disposition, provider_transaction_number, observed_at_ms
        FROM airtable_sync_shadow_findings
       WHERE connection_id = ?
       ORDER BY observed_at_ms DESC, id DESC
       LIMIT ${input.limit}
    `).all(input.connectionId).map((row) => Object.freeze({
      fieldKey: row.field_key,
      disposition: row.disposition,
      transactionNumber: row.provider_transaction_number,
      observedAtMs: row.observed_at_ms
    })));
  }

  recordBoundaryObservation(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly recordLinkId?: string;
    readonly fieldKey: string;
    readonly kind: 'applied' | 'refused_restored' | 'request' | 'conflict' | 'sharing';
    readonly classification: 'ordinary' | 'personal' | 'sensitive' | 'classified';
    readonly before?: CanonicalJson;
    readonly after?: CanonicalJson;
    readonly beforePayloadRef?: string;
    readonly afterPayloadRef?: string;
    readonly providerActorId?: string;
    readonly providerActorEmail?: string;
    readonly providerActorDisplayName?: string;
    readonly inboxReceiptId?: string;
    readonly operationReceiptId?: string;
    readonly occurredAtMs: number;
  }): void {
    id(input.id, 'airtable_sync_observation_id_invalid');
    parseSourceConnectionId(input.connectionId);
    const classified = input.classification === 'classified';
    if (
      classified
        ? !input.beforePayloadRef || !input.afterPayloadRef
        : input.before === undefined || input.after === undefined
    ) {
      throw new TypeError('airtable_sync_observation_value_boundary_invalid');
    }
    this.sqlite.query(`
      INSERT INTO airtable_sync_boundary_observations(
        id, connection_id, record_link_id, field_key, kind, classification,
        before_json, after_json, before_payload_ref, after_payload_ref,
        provider_actor_id, provider_actor_email, provider_actor_display_name,
        inbox_receipt_id, operation_receipt_id, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.connectionId,
      input.recordLinkId ?? null,
      input.fieldKey,
      input.kind,
      input.classification,
      classified ? null : canonicalJsonText(input.before),
      classified ? null : canonicalJsonText(input.after),
      input.beforePayloadRef ?? null,
      input.afterPayloadRef ?? null,
      input.providerActorId ?? null,
      input.providerActorEmail ?? null,
      input.providerActorDisplayName ?? null,
      input.inboxReceiptId ?? null,
      input.operationReceiptId ?? null,
      input.occurredAtMs
    );
  }

  openInboundConflict(input: {
    readonly id: string; readonly connectionId: string; readonly recordLinkId: string;
    readonly fieldKey: string; readonly base: CanonicalJson; readonly local: CanonicalJson;
    readonly remote: CanonicalJson; readonly nowMs: number;
  }): void {
    id(input.id, 'airtable_sync_conflict_id_invalid');
    parseSourceConnectionId(input.connectionId);
    this.sqlite.query(`
      INSERT INTO airtable_sync_conflicts(
        id, connection_id, record_link_id, field_key, status,
        base_digest, local_digest, remote_digest, created_at_ms
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
      ON CONFLICT(record_link_id, field_key, status) DO UPDATE SET
        base_digest = excluded.base_digest,
        local_digest = excluded.local_digest,
        remote_digest = excluded.remote_digest,
        version = airtable_sync_conflicts.version + 1
    `).run(
      input.id, input.connectionId, input.recordLinkId, input.fieldKey,
      canonicalJsonSha256(input.base), canonicalJsonSha256(input.local),
      canonicalJsonSha256(input.remote), input.nowMs
    );
  }

  enqueueCanonicalRestore(input: {
    readonly id: string; readonly recordLinkId: string; readonly nowMs: number;
  }): void {
    const row = this.sqlite.query<{
      readonly connection_id: string; readonly mapping_revision: number;
      readonly area_key: string; readonly subject_kind: string; readonly subject_id: string;
      readonly canonical_version: number;
    }, [string]>(`
      SELECT connection_id, mapping_revision, area_key, subject_kind, subject_id, canonical_version
        FROM airtable_sync_record_links WHERE id = ?
    `).get(input.recordLinkId);
    if (!row) throw new TypeError('airtable_sync_restore_record_link_missing');
    this.enqueueProjectionWork({
      id: input.id, connectionId: row.connection_id, mappingRevision: row.mapping_revision,
      areaKey: row.area_key, subjectKind: row.subject_kind, subjectId: row.subject_id,
      projectionVersion: row.canonical_version, availableAtMs: input.nowMs, nowMs: input.nowMs
    });
  }
}

/** Durable boundary history/conflict adapter; provider restoration stays queued. */
export class SQLiteAirtableInboundBoundaryPort implements AirtableInboundBoundaryPort {
  constructor(
    private readonly repository: SQLiteAirtableSyncRepository,
    private readonly options: Readonly<{ nowMs(): number; newId(): string }>
  ) {}

  async conflict(input: Parameters<AirtableInboundBoundaryPort['conflict']>[0]) {
    const nowMs = this.options.nowMs();
    this.repository.openInboundConflict({
      id: this.options.newId(), connectionId: input.claim.connectionId,
      recordLinkId: input.recordLinkId, fieldKey: input.fieldKey,
      base: input.base, local: input.local, remote: input.remote, nowMs
    });
    this.repository.recordBoundaryObservation({
      id: this.options.newId(), connectionId: input.claim.connectionId,
      recordLinkId: input.recordLinkId, fieldKey: input.fieldKey, kind: 'conflict',
      classification: input.classification,
      ...(input.classification === 'classified'
        ? { beforePayloadRef: `sha256:${canonicalJsonSha256(input.base)}`, afterPayloadRef: `sha256:${canonicalJsonSha256(input.remote)}` }
        : { before: input.base, after: input.remote }),
      ...(input.claim.providerActor?.id ? { providerActorId: input.claim.providerActor.id } : {}),
      ...(input.claim.providerActor?.email ? { providerActorEmail: input.claim.providerActor.email } : {}),
      ...(input.claim.providerActor?.displayName
        ? { providerActorDisplayName: input.claim.providerActor.displayName }
        : {}),
      occurredAtMs: nowMs
    });
  }

  async observation(input: Parameters<AirtableInboundBoundaryPort['observation']>[0]) {
    this.repository.recordBoundaryObservation({
      id: this.options.newId(), connectionId: input.claim.connectionId,
      recordLinkId: input.recordLinkId, fieldKey: input.fieldKey, kind: input.kind,
      classification: input.classification,
      ...(input.classification === 'classified'
        ? { beforePayloadRef: `sha256:${canonicalJsonSha256(input.before)}`, afterPayloadRef: `sha256:${canonicalJsonSha256(input.after)}` }
        : { before: input.before, after: input.after }),
      ...(input.claim.providerActor?.id ? { providerActorId: input.claim.providerActor.id } : {}),
      ...(input.claim.providerActor?.email ? { providerActorEmail: input.claim.providerActor.email } : {}),
      ...(input.claim.providerActor?.displayName
        ? { providerActorDisplayName: input.claim.providerActor.displayName }
        : {}),
      ...(input.operationReceiptId ? { operationReceiptId: input.operationReceiptId } : {}),
      occurredAtMs: this.options.nowMs()
    });
  }

  async restoreCanonical(input: Parameters<AirtableInboundBoundaryPort['restoreCanonical']>[0]) {
    this.repository.enqueueCanonicalRestore({
      id: this.options.newId(), recordLinkId: input.recordLinkId, nowMs: this.options.nowMs()
    });
  }
}

export class SQLiteAirtableInboundCursorRepository implements AirtableInboundCursorRepository {
  constructor(
    private readonly repository: SQLiteAirtableSyncRepository,
    private readonly newSettleId: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  async read(connectionId: string) {
    return this.repository.readInboundCursor(connectionId);
  }

  async commitPage(input: Parameters<AirtableInboundCursorRepository['commitPage']>[0]) {
    return this.repository.commitInboundCursorPage({ ...input, newSettleId: this.newSettleId });
  }
}

export class SQLiteAirtableWebhookLifecycleRepository implements AirtableWebhookLifecycleRepository {
  constructor(private readonly repository: SQLiteAirtableSyncRepository) {}

  async saveCreated(input: Parameters<AirtableWebhookLifecycleRepository['saveCreated']>[0]) {
    this.repository.saveWebhookRegistration(input);
  }

  async saveRefreshed(input: Parameters<AirtableWebhookLifecycleRepository['saveRefreshed']>[0]) {
    return this.repository.refreshWebhookRegistration(input);
  }

  async saveDeleted(input: Parameters<AirtableWebhookLifecycleRepository['saveDeleted']>[0]) {
    return this.repository.deleteWebhookRegistration(input);
  }
}

export class SQLiteAirtableWebhookMacRegistrationResolver
implements AirtableWebhookMacRegistrationResolver {
  constructor(
    private readonly repository: SQLiteAirtableSyncRepository,
    private readonly secretStore: SecretStore,
    private readonly maximumNotificationAgeMs = 24 * 60 * 60 * 1_000
  ) {
    if (!Number.isSafeInteger(maximumNotificationAgeMs)
      || maximumNotificationAgeMs < 60_000
      || maximumNotificationAgeMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new TypeError('airtable_webhook_replay_window_invalid');
    }
  }

  async resolve(sourceConnectionId: SourceConnectionId) {
    const registration = this.repository.readWebhookMacRegistration(sourceConnectionId);
    if (!registration) return undefined;
    return Object.freeze({
      baseId: registration.baseId,
      webhookId: registration.webhookId,
      maximumNotificationAgeMs: this.maximumNotificationAgeMs,
      withMacSecret: <Result>(use: (secret: Uint8Array) => Promise<Result>) =>
        withAirtableWebhookMacSecret({
          secretStore: this.secretStore,
          stored: registration.stored,
          connectionId: sourceConnectionId,
          use
        })
    });
  }
}

export class SQLiteAirtableWebhookIntakeResolver implements AirtableWebhookIntakeResolver {
  constructor(
    private readonly repository: SQLiteAirtableSyncRepository,
    private readonly forConnection: (
      sourceConnectionId: SourceConnectionId
    ) => AirtableVerifiedInboxIntake | undefined
  ) {}

  async resolve(callbackRef: string) {
    const sourceConnectionId = this.repository.resolveConnectionIdByCallbackRef(callbackRef);
    return sourceConnectionId ? this.forConnection(sourceConnectionId) : undefined;
  }
}

/** Joins durable settle fencing to a domain-owned current projection reader. */
export class SQLiteAirtableShadowSettleRepository implements AirtableShadowSettleRepository {
  constructor(
    private readonly repository: SQLiteAirtableSyncRepository,
    private readonly source: AirtableShadowContextSource,
    private readonly options: Readonly<{
      leaseMs?: number;
      newFindingId?: () => string;
      newWorkId?: () => string;
    }> = {}
  ) {}

  async claimNext(input: Parameters<AirtableShadowSettleRepository['claimNext']>[0]) {
    return this.repository.claimNextShadowSettle({
      ...input,
      leaseMs: this.options.leaseMs ?? 30_000
    });
  }

  async resolveContext(claim: AirtableShadowSettleClaim): Promise<AirtableShadowSettleContext | undefined> {
    const stored = this.repository.readShadowSettleStorageContext(claim);
    if (!stored) return undefined;
    const current = await this.source.resolve({
      connectionId: claim.connectionId,
      mappingRevision: claim.mappingRevision,
      recordLinkId: stored.recordLinkId,
      areaKey: stored.areaKey,
      subjectKind: stored.subjectKind,
      subjectId: stored.subjectId,
      mapping: stored.mapping
    });
    if (!current) return undefined;
    return Object.freeze({
      baseId: stored.baseId,
      recordLinkId: stored.recordLinkId,
      mappings: Object.freeze([...current.mappings]),
      baseline: stored.baseline,
      local: current.local,
      ...(current.subjectVersion === undefined ? {} : {
        subject: {
          kind: stored.subjectKind === 'task_assignment' ? 'task_assignment' as const : 'engagement' as const,
          id: stored.subjectId,
          expectedVersion: current.subjectVersion
        }
      }),
      ...(current.lastOutbound ? { lastOutbound: current.lastOutbound } : {})
    });
  }

  async complete(input: Parameters<AirtableShadowSettleRepository['complete']>[0]) {
    return this.repository.completeShadowSettle({
      ...input,
      newFindingId: this.options.newFindingId ?? (() => globalThis.crypto.randomUUID()),
      newWorkId: this.options.newWorkId ?? (() => globalThis.crypto.randomUUID())
    });
  }
}

function mappingSubscribesToArea(mappingJson: string, areaKey: string): boolean {
  const parsed: unknown = JSON.parse(mappingJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const mapping = parsed as { readonly areas?: unknown; readonly fields?: unknown };
  if (Array.isArray(mapping.areas)) {
    if (areaKey === 'events') {
      return mapping.areas.some((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        return (candidate as { readonly direction?: unknown }).direction !== 'not_connected';
      });
    }
    return mapping.areas.some((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const area = candidate as { readonly areaKey?: unknown; readonly direction?: unknown };
      const areaMatches = area.areaKey === areaKey
        || areaKey === 'sessions' && area.areaKey === 'schedule';
      return areaMatches && area.direction !== 'not_connected';
    });
  }
  if (Array.isArray(mapping.fields)) {
    return mapping.fields.some((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const field = candidate as { readonly areaKey?: unknown; readonly mode?: unknown };
      return field.areaKey === areaKey && field.mode !== 'not_shared';
    });
  }
  return false;
}

interface AirtableRefreshSubjectRow {
  readonly subject_id: string;
  readonly projection_version: number;
}

function listAirtableRefreshSubjects(input: Readonly<{
  sqlite: Database;
  workspaceId: string;
  eventId: string | null;
  areaKey: SyncAreaKey;
}>): Readonly<{ subjectKind: string; rows: readonly AirtableRefreshSubjectRow[] }> {
  const scope = [input.workspaceId, input.eventId, input.eventId] as const;
  let subjectKind: string;
  let rows: readonly AirtableRefreshSubjectRow[];
  if (input.areaKey === 'events') {
    subjectKind = 'event';
    rows = input.sqlite.query<AirtableRefreshSubjectRow, [string, string | null, string | null]>(`
      SELECT event.id AS subject_id,
             max(event.version,coalesce(settings.event_version,1)) AS projection_version
        FROM event_spine_heads event
        LEFT JOIN event_settings_companions settings
          ON settings.workspace_id=event.workspace_id AND settings.event_id=event.id
       WHERE event.workspace_id=? AND (? IS NULL OR event.id=?)
       ORDER BY event.id LIMIT 10001
    `).all(...scope);
  } else if (input.areaKey === 'people') {
    subjectKind = 'engagement';
    rows = input.sqlite.query<AirtableRefreshSubjectRow, [string, string | null, string | null]>(`
      SELECT id AS subject_id,version AS projection_version FROM engagement_heads
       WHERE workspace_id=? AND (? IS NULL OR event_id=?) ORDER BY id LIMIT 10001
    `).all(...scope);
  } else if (input.areaKey === 'submissions') {
    subjectKind = 'submission';
    rows = input.sqlite.query<AirtableRefreshSubjectRow, [string, string | null, string | null]>(`
      SELECT submission.submission_id AS subject_id,
             1 + coalesce(decision.version,0) AS projection_version
        FROM intake_submission_heads submission
        LEFT JOIN decision_heads decision
          ON decision.workspace_id=submission.workspace_id
         AND decision.event_id=submission.event_id
         AND decision.submission_id=submission.submission_id
       WHERE submission.workspace_id=? AND (? IS NULL OR submission.event_id=?)
       ORDER BY submission.submission_id LIMIT 10001
    `).all(...scope);
  } else {
    subjectKind = 'session';
    rows = input.sqlite.query<AirtableRefreshSubjectRow, [string, string | null, string | null]>(`
      SELECT session.id AS subject_id,
             session.version * 1000000 + coalesce(max(occurrence.version),0) AS projection_version
        FROM sessions session
        LEFT JOIN schedule_occurrences occurrence
          ON occurrence.workspace_id=session.workspace_id
         AND occurrence.event_id=session.event_id
         AND occurrence.session_id=session.id
       WHERE session.workspace_id=? AND (? IS NULL OR session.event_id=?)
       GROUP BY session.workspace_id,session.event_id,session.id,session.version
       ORDER BY session.id LIMIT 10001
    `).all(...scope);
  }
  if (rows.length > 10_000) throw new TypeError('airtable_projection_refresh_bound_exceeded');
  return Object.freeze({ subjectKind, rows: Object.freeze(rows) });
}

/**
 * Disposable proof of the direct-operation contribution join. It performs only SQL
 * while the canonical transaction is active, then attempts opaque wake publication
 * after commit. Wake failure is deliberately non-fatal because scheduled discovery
 * can recover the durable work row.
 */
export class SQLiteAirtableProjectionContributionAdapter {
  readonly #pendingWakes = new Map<string, AirtableSyncWake>();

  constructor(
    private readonly sqlite: Database,
    private readonly newWorkId: () => string,
    private readonly wakes: AirtableSyncWakePublisher,
    private readonly onWakeFailure: (input: {
      readonly wake: AirtableSyncWake;
      readonly error: unknown;
    }) => void = () => undefined
  ) {}

  apply(contribution: DirectOperationFeatureContribution): void {
    if (!this.sqlite.inTransaction) {
      throw new TypeError('airtable_projection_contribution_requires_transaction');
    }
    if (contribution.contributor.key !== AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR.key
      || contribution.contributor.version !== AIRTABLE_PROJECTION_FEATURE_CONTRIBUTOR.version) {
      throw new TypeError('airtable_projection_contributor_mismatch');
    }
    const parsed = airtableProjectionFeatureContributionSchema.parse(contribution.value);
    const mappings = this.sqlite.query<{
      readonly connection_id: string;
      readonly revision: number;
      readonly mapping_json: string;
    }, [string]>(`
      SELECT connection.id AS connection_id, mapping.revision, mapping.mapping_json
        FROM airtable_sync_connections AS connection
        JOIN airtable_sync_mapping_revisions AS mapping
          ON mapping.connection_id = connection.id AND mapping.status = 'active'
       WHERE connection.workspace_id = ? AND connection.state = 'active'
       ORDER BY connection.id
       LIMIT 101
    `).all(parsed.workspaceId);
    if (mappings.length > 100) throw new TypeError('airtable_projection_connection_bound_exceeded');
    const repository = new SQLiteAirtableSyncRepository(this.sqlite);
    const nowMs = Date.parse(parsed.occurredAt);
    if (parsed.inbound) {
      for (const observation of parsed.inbound.observations) {
        const owned = this.sqlite.query<{ readonly count: number }, [string, string, string]>(`
          SELECT count(*) AS count
            FROM airtable_sync_connections AS connection
            JOIN airtable_sync_record_links AS link
              ON link.connection_id = connection.id
           WHERE connection.workspace_id = ?
             AND connection.id = ?
             AND link.id = ?
        `).get(parsed.workspaceId, observation.connectionId, observation.recordLinkId)?.count === 1;
        if (!owned) throw new TypeError('airtable_inbound_observation_scope_mismatch');
        repository.recordBoundaryObservation({
          id: this.newWorkId(),
          connectionId: observation.connectionId,
          recordLinkId: observation.recordLinkId,
          fieldKey: observation.fieldKey,
          kind: observation.kind,
          classification: observation.classification,
          before: observation.before,
          after: observation.after,
          ...(observation.providerActorId
            ? { providerActorId: observation.providerActorId }
            : {}),
          ...(observation.providerActorEmail
            ? { providerActorEmail: observation.providerActorEmail }
            : {}),
          ...(observation.providerActorDisplayName
            ? { providerActorDisplayName: observation.providerActorDisplayName }
            : {}),
          inboxReceiptId: parsed.inbound.inboxReceiptId,
          operationReceiptId: contribution.operationLogId,
          occurredAtMs: observation.observedAtMs
        });
      }
    }
    for (const mapping of mappings) {
      let contributed = false;
      for (const impact of parsed.impacts) {
        if (!mappingSubscribesToArea(mapping.mapping_json, impact.areaKey)) continue;
        repository.enqueueProjectionWork({
          id: this.newWorkId(),
          connectionId: mapping.connection_id,
          mappingRevision: mapping.revision,
          areaKey: impact.areaKey,
          subjectKind: impact.subjectKind,
          subjectId: impact.subjectId,
          projectionVersion: impact.projectionVersion,
          availableAtMs: nowMs,
          nowMs,
          sourceOperationLogId: contribution.operationLogId
        });
        contributed = true;
      }
      const refreshAreas = [...new Set(parsed.refreshAreas ?? [])];
      for (const areaKey of refreshAreas) {
        if (areaKey === 'schedule') continue;
        if (!mappingSubscribesToArea(mapping.mapping_json, areaKey)) continue;
        const refresh = listAirtableRefreshSubjects({
          sqlite: this.sqlite,
          workspaceId: parsed.workspaceId,
          eventId: parsed.eventId,
          areaKey
        });
        for (const subject of refresh.rows) {
          repository.enqueueProjectionWork({
            id: this.newWorkId(),
            connectionId: mapping.connection_id,
            mappingRevision: mapping.revision,
            areaKey,
            subjectKind: refresh.subjectKind,
            subjectId: subject.subject_id,
            projectionVersion: subject.projection_version,
            availableAtMs: nowMs,
            nowMs,
            sourceOperationLogId: contribution.operationLogId
          });
          contributed = true;
        }
      }
      if (contributed) {
        this.#pendingWakes.set(mapping.connection_id, Object.freeze({
          schemaVersion: 1,
          connectionId: mapping.connection_id,
          reason: 'outbound_projection',
          wakeId: `${mapping.connection_id}:${contribution.operationLogId}`
        }));
      }
    }
  }

  async afterUnitOfWorkCommitted(): Promise<void> {
    for (const wake of this.#pendingWakes.values()) {
      try {
        await this.wakes.publish(wake);
      } catch (error) {
        try {
          this.onWakeFailure({ wake, error });
        } catch {
          // Diagnostic hooks cannot turn a committed organizer mutation into failure.
        }
      }
    }
  }

  afterUnitOfWorkFinished(): void {
    this.#pendingWakes.clear();
  }
}

export class SQLiteAirtableProviderThrottle implements AirtableProviderThrottle {
  constructor(private readonly repository: SQLiteAirtableSyncRepository) {}

  async beforeRequest(input: { readonly baseId: string; readonly nowMs: number }) {
    const notBeforeMs = this.repository.providerThrottleNotBefore(input.baseId);
    return notBeforeMs > input.nowMs
      ? { kind: 'delayed' as const, retryAfterMs: notBeforeMs - input.nowMs }
      : { kind: 'ready' as const };
  }

  async observe(input: {
    readonly baseId: string;
    readonly nowMs: number;
    readonly failure: { readonly code: string; readonly retryAfterMs?: number };
  }): Promise<void> {
    if (input.failure.code !== 'rate_limited') return;
    this.repository.observeProviderThrottle({
      baseId: input.baseId,
      notBeforeMs: input.nowMs + Math.max(1_000, input.failure.retryAfterMs ?? 30_000),
      reasonCode: input.failure.code,
      nowMs: input.nowMs
    });
  }
}

export class SQLiteAirtableOutboundJobRepository implements AirtableOutboundJobRepository {
  constructor(
    private readonly repository: SQLiteAirtableSyncRepository,
    private readonly connectionLeaseMs = 30_000,
    private readonly workLeaseMs = 30_000,
    private readonly newRecordLinkId: () => string = () => globalThis.crypto.randomUUID()
  ) {}

  async claimConnection(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
  }) {
    return this.repository.claimConnectionLease({ ...input, leaseMs: this.connectionLeaseMs });
  }

  async releaseConnection(input: {
    readonly lease: AirtableConnectionLease;
    readonly nowMs: number;
  }) {
    return this.repository.releaseConnectionLease(input);
  }

  async claimNext(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
  }) {
    const claimed = this.repository.claimDueProjectionWork({
      ...input,
      leaseMs: this.workLeaseMs,
      limit: 1
    })[0];
    if (claimed === undefined) return undefined;
    if (!SYNC_AREA_KEYS.includes(claimed.areaKey as SyncAreaKey)) {
      throw new TypeError('airtable_sync_claim_area_invalid');
    }
    return Object.freeze({
      workId: claimed.id,
      connectionId: claimed.connectionId,
      mappingRevision: claimed.mappingRevision,
      areaKey: claimed.areaKey as SyncAreaKey,
      subjectKind: claimed.subjectKind,
      subjectId: claimed.subjectId,
      requestedProjectionVersion: claimed.requestedProjectionVersion,
      workerId: claimed.leaseOwner,
      leaseVersion: claimed.leaseVersion
    });
  }

  async complete(input: Parameters<AirtableOutboundJobRepository['complete']>[0]) {
    const outcome = input.outcome;
    if (outcome.kind === 'succeeded') {
      if (!outcome.providerTableId) {
        throw new TypeError('airtable_sync_completion_provider_table_missing');
      }
      return this.repository.finishSuccessfulProjectionWork({
        id: input.claim.workId,
        workerId: input.claim.workerId,
        leaseVersion: input.claim.leaseVersion,
        connectionId: input.claim.connectionId,
        mappingRevision: input.claim.mappingRevision,
        areaKey: input.claim.areaKey,
        subjectKind: input.claim.subjectKind,
        subjectId: input.claim.subjectId,
        providerTableId: outcome.providerTableId,
        providerRecordId: outcome.providerRecordId,
        projectionVersion: outcome.projection.projectionVersion,
        projectionFields: outcome.projection.fields,
        providerFingerprint: outcome.providerFingerprint,
        newRecordLinkId: this.newRecordLinkId,
        nowMs: input.nowMs
      });
    }
    return this.repository.finishProjectionWork({
      id: input.claim.workId,
      workerId: input.claim.workerId,
      leaseVersion: input.claim.leaseVersion,
      outcome: outcome.kind === 'attention' || outcome.kind === 'reconcile_first' ? 'attention'
        : 'failed',
      nowMs: input.nowMs,
      ...(outcome.kind === 'retry' ? { nextAttemptAtMs: outcome.notBeforeMs } : {}),
      errorCode: outcome.code
    });
  }
}

export interface SQLiteAirtableReconciliationRunInput {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly areaKey: SyncAreaKey;
  readonly baseId: string;
  readonly tableId: string;
  readonly stableIdFieldId: string;
  readonly comparedFieldIds: readonly string[];
  readonly kind: 'lightweight' | 'full' | 'user_requested' | 'retention_recovery';
  readonly nowMs: number;
}

export interface SQLiteAirtableSyncHealth {
  readonly connectionId: string;
  readonly state: 'current' | 'pending' | 'needs_review' | 'delayed' | 'paused' | 'needs_reconnect' | 'disconnected';
  readonly dueWork: number;
  readonly conflicts: number;
  readonly requests: number;
  readonly schemaDrift: number;
  readonly deadLetters: number;
  readonly lastOutboundAtMs?: number;
  readonly lastInboundAtMs?: number;
  readonly lastLightweightAtMs?: number;
  readonly lastFullAtMs?: number;
  readonly lastFullSummary?: string;
  readonly version: number;
}

/** Disposable S5 adapter: page inventory first, then one deterministic assessment. */
export class SQLiteAirtableReconciliationRepository implements AirtableReconciliationRepository {
  readonly #core: SQLiteAirtableSyncRepository;

  constructor(private readonly sqlite: Database) {
    this.#core = new SQLiteAirtableSyncRepository(sqlite);
  }

  createRun(input: SQLiteAirtableReconciliationRunInput): void {
    id(input.id, 'airtable_reconciliation_run_id_invalid');
    parseSourceConnectionId(input.connectionId);
    parseAirtableBaseId(input.baseId);
    parseAirtableTableId(input.tableId);
    parseAirtableFieldId(input.stableIdFieldId);
    if (!SYNC_AREA_KEYS.includes(input.areaKey)
      || input.comparedFieldIds.length > 100
      || new Set(input.comparedFieldIds).size !== input.comparedFieldIds.length) {
      throw new TypeError('airtable_reconciliation_run_invalid');
    }
    const comparedFieldIds = input.comparedFieldIds.map(parseAirtableFieldId).sort();
    this.sqlite.query(`
      INSERT INTO airtable_sync_reconciliation_runs(
        id, connection_id, mapping_revision, area_key, provider_base_id,
        provider_table_id, stable_field_id, compared_field_ids_json,
        kind, status, available_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      input.id,
      input.connectionId,
      input.mappingRevision,
      input.areaKey,
      input.baseId,
      input.tableId,
      input.stableIdFieldId,
      JSON.stringify(comparedFieldIds),
      input.kind,
      input.nowMs,
      input.nowMs,
      input.nowMs
    );
  }

  async claimNext(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): Promise<AirtableReconciliationClaim | undefined> {
    parseSourceConnectionId(input.connectionId);
    if (!input.workerId || input.workerId.length > 160
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 5_000 || input.leaseMs > 300_000) {
      throw new TypeError('airtable_reconciliation_claim_invalid');
    }
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query<{
        readonly id: string;
      }, [string, number, number]>(`
        SELECT id
          FROM airtable_sync_reconciliation_runs
         WHERE connection_id = ? AND available_at_ms <= ?
           AND (
             status IN ('pending','scanning','failed')
             OR (status = 'running' AND lease_expires_at_ms <= ?)
           )
         ORDER BY available_at_ms, id
         LIMIT 1
      `).get(input.connectionId, input.nowMs, input.nowMs);
      if (!row) return undefined;
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_reconciliation_runs
           SET status = 'running', lease_owner = ?, lease_version = lease_version + 1,
               lease_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ?
           AND (
             status IN ('pending','scanning','failed')
             OR (status = 'running' AND lease_expires_at_ms <= ?)
           )
      `).run(input.workerId, input.nowMs + input.leaseMs, input.nowMs, row.id, input.nowMs);
      if (updated.changes !== 1) return undefined;
      const claimed = this.sqlite.query<{
        readonly id: string;
        readonly connection_id: string;
        readonly mapping_revision: number;
        readonly area_key: string;
        readonly provider_base_id: string;
        readonly provider_table_id: string;
        readonly stable_field_id: string;
        readonly compared_field_ids_json: string;
        readonly provider_offset: string | null;
        readonly lease_version: number;
      }, [string]>(`
        SELECT id, connection_id, mapping_revision, area_key, provider_base_id,
               provider_table_id, stable_field_id, compared_field_ids_json,
               provider_offset, lease_version
          FROM airtable_sync_reconciliation_runs
         WHERE id = ?
      `).get(row.id);
      if (!claimed) throw new Error('airtable_reconciliation_claim_missing');
      const comparedFieldIds = JSON.parse(claimed.compared_field_ids_json);
      if (!Array.isArray(comparedFieldIds)) throw new TypeError('airtable_reconciliation_fields_invalid');
      return Object.freeze({
        runId: claimed.id,
        connectionId: claimed.connection_id,
        mappingRevision: claimed.mapping_revision,
        areaKey: claimed.area_key,
        baseId: parseAirtableBaseId(claimed.provider_base_id),
        tableId: parseAirtableTableId(claimed.provider_table_id),
        stableIdFieldId: parseAirtableFieldId(claimed.stable_field_id),
        comparedFieldIds: Object.freeze(comparedFieldIds.map(parseAirtableFieldId)),
        ...(claimed.provider_offset ? { providerOffset: claimed.provider_offset } : {}),
        workerId: input.workerId,
        leaseVersion: claimed.lease_version
      });
    })();
  }

  async commitProviderPage(input: {
    readonly claim: AirtableReconciliationClaim;
    readonly records: readonly AirtableReconciliationPageRecord[];
    readonly nextOffset?: string;
    readonly nowMs: number;
  }): Promise<'more' | 'ready_to_assess' | 'lost_fence'> {
    if (input.records.length > 100) throw new TypeError('airtable_reconciliation_page_too_large');
    return this.sqlite.transaction(() => {
      const current = this.sqlite.query<{
        readonly status: string;
        readonly lease_owner: string | null;
        readonly lease_version: number;
      }, [string]>(`
        SELECT status, lease_owner, lease_version
          FROM airtable_sync_reconciliation_runs WHERE id = ?
      `).get(input.claim.runId);
      if (!current || current.status !== 'running'
        || current.lease_owner !== input.claim.workerId
        || current.lease_version !== input.claim.leaseVersion) return 'lost_fence' as const;
      for (const record of input.records) {
        parseAirtableRecordId(record.providerRecordId);
        digest(record.providerFingerprintSha256);
        if (record.subjectKey !== undefined
          && (record.subjectKey.length < 1 || record.subjectKey.length > 256)) {
          throw new TypeError('airtable_reconciliation_subject_invalid');
        }
        this.sqlite.query(`
          INSERT INTO airtable_sync_reconciliation_inventory(
            run_id, provider_record_id, subject_key, provider_fingerprint, observed_at_ms
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(run_id, provider_record_id) DO UPDATE SET
            subject_key = excluded.subject_key,
            provider_fingerprint = excluded.provider_fingerprint,
            observed_at_ms = excluded.observed_at_ms
        `).run(
          input.claim.runId,
          record.providerRecordId,
          record.subjectKey ?? null,
          record.providerFingerprintSha256,
          input.nowMs
        );
      }
      const status = input.nextOffset ? 'scanning' : 'assessing';
      const updated = this.sqlite.query(`
        UPDATE airtable_sync_reconciliation_runs
           SET status = ?, provider_offset = ?,
               scanned_records = scanned_records + ?,
               lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_version = ?
      `).run(
        status,
        input.nextOffset ?? null,
        input.records.length,
        input.nowMs,
        input.claim.runId,
        input.claim.workerId,
        input.claim.leaseVersion
      );
      if (updated.changes !== 1) return 'lost_fence' as const;
      return input.nextOffset ? 'more' as const : 'ready_to_assess' as const;
    })();
  }

  async fail(input: {
    readonly claim: AirtableReconciliationClaim;
    readonly code: string;
    readonly retryAtMs?: number;
    readonly nowMs: number;
  }): Promise<boolean> {
    if (!input.code || input.code.length > 80) throw new TypeError('airtable_reconciliation_error_invalid');
    const retry = input.retryAtMs !== undefined;
    return this.sqlite.query(`
      UPDATE airtable_sync_reconciliation_runs
         SET status = ?, available_at_ms = ?, last_error_code = ?,
             lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?,
             completed_at_ms = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_version = ?
    `).run(
      retry ? 'failed' : 'attention',
      input.retryAtMs ?? input.nowMs,
      input.code,
      input.nowMs,
      retry ? null : input.nowMs,
      input.claim.runId,
      input.claim.workerId,
      input.claim.leaseVersion
    ).changes === 1;
  }

  assessReadyRun(input: {
    readonly runId: string;
    readonly nowMs: number;
    readonly newFindingId: () => string;
    readonly newWorkId: () => string;
    readonly newSettleId?: () => string;
  }): Readonly<{
    findings: number;
    repairsScheduled: number;
    settlesScheduled: number;
    state: 'current' | 'pending' | 'needs_review';
  }> {
    id(input.runId, 'airtable_reconciliation_run_id_invalid');
    return this.sqlite.transaction(() => {
      const run = this.sqlite.query<{
        readonly connection_id: string;
        readonly mapping_revision: number;
        readonly area_key: string;
        readonly provider_table_id: string;
        readonly kind: SQLiteAirtableReconciliationRunInput['kind'];
        readonly status: string;
      }, [string]>(`
        SELECT connection_id, mapping_revision, area_key, provider_table_id, kind, status
          FROM airtable_sync_reconciliation_runs WHERE id = ?
      `).get(input.runId);
      if (!run || run.status !== 'assessing') throw new TypeError('airtable_reconciliation_not_ready');
      const links = this.sqlite.query<{
        readonly id: string;
        readonly subject_kind: string;
        readonly subject_id: string;
        readonly provider_record_id: string;
        readonly canonical_version: number;
      }, [string, number, string, string]>(`
        SELECT id, subject_kind, subject_id, provider_record_id, canonical_version
          FROM airtable_sync_record_links
         WHERE connection_id = ? AND mapping_revision = ? AND area_key = ?
           AND provider_table_id = ?
         ORDER BY subject_id, id
      `).all(run.connection_id, run.mapping_revision, run.area_key, run.provider_table_id);
      const providerRecords = this.sqlite.query<{
        readonly provider_record_id: string;
        readonly subject_key: string | null;
      }, [string]>(`
        SELECT provider_record_id, subject_key
          FROM airtable_sync_reconciliation_inventory
         WHERE run_id = ? ORDER BY provider_record_id
      `).all(input.runId);
      const findings = assessAirtableRecordInventory({
        links: links.map((link) => ({
          recordLinkId: link.id,
          subjectKey: link.subject_id,
          providerRecordId: link.provider_record_id,
          baseline: {}
        })),
        providerRecords: providerRecords.map((record) => ({
          providerRecordId: record.provider_record_id,
          ...(record.subject_key ? { subjectKey: record.subject_key } : {}),
          fields: {}
        }))
      });
      let repairsScheduled = 0;
      for (const finding of findings) {
        const findingId = input.newFindingId();
        id(findingId, 'airtable_reconciliation_finding_id_invalid');
        this.sqlite.query(`
          INSERT INTO airtable_sync_reconciliation_findings(
            id, run_id, connection_id, kind, subject_key,
            provider_record_id, details_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          findingId,
          input.runId,
          run.connection_id,
          finding.kind,
          'subjectKey' in finding ? finding.subjectKey ?? null : null,
          finding.kind === 'orphan' ? finding.providerRecordId
            : finding.kind === 'record_id_changed' ? finding.actualRecordId
              : null,
          canonicalJsonText(finding as unknown as CanonicalJson),
          input.nowMs
        );
        if (finding.kind === 'missing') {
          const link = links.find((candidate) => candidate.id === finding.recordLinkId);
          if (!link) throw new Error('airtable_reconciliation_missing_link');
          this.#core.enqueueProjectionWork({
            id: input.newWorkId(),
            connectionId: run.connection_id,
            mappingRevision: run.mapping_revision,
            areaKey: run.area_key,
            subjectKind: link.subject_kind,
            subjectId: link.subject_id,
            projectionVersion: link.canonical_version,
            availableAtMs: input.nowMs,
            nowMs: input.nowMs
          });
          repairsScheduled += 1;
        }
      }
      let settlesScheduled = 0;
      if (run.kind === 'retention_recovery') {
        const exactProviderRecordBySubject = new Map<string, string>();
        const providerCounts = new Map<string, number>();
        for (const record of providerRecords) {
          if (!record.subject_key) continue;
          providerCounts.set(record.subject_key, (providerCounts.get(record.subject_key) ?? 0) + 1);
          exactProviderRecordBySubject.set(record.subject_key, record.provider_record_id);
        }
        const cursorTransaction = this.sqlite.query<{
          readonly last_transaction_number: number;
        }, [string]>(`
          SELECT last_transaction_number
            FROM airtable_sync_webhook_cursors
           WHERE connection_id = ?
        `).get(run.connection_id)?.last_transaction_number ?? 0;
        for (const link of links) {
          const providerRecordId = exactProviderRecordBySubject.get(link.subject_id);
          if (!providerRecordId
            || providerCounts.get(link.subject_id) !== 1
            || providerRecordId !== link.provider_record_id) continue;
          this.#core.scheduleSettle({
            id: (input.newSettleId ?? input.newWorkId)(),
            connectionId: run.connection_id,
            mappingRevision: run.mapping_revision,
            providerTableId: run.provider_table_id,
            providerRecordId,
            transactionNumber: Math.max(1, cursorTransaction),
            changeKind: 'updated',
            providerSource: 'reconciliation',
            observedAtMs: input.nowMs,
            notBeforeMs: input.nowMs,
            nowMs: input.nowMs
          });
          settlesScheduled += 1;
        }
      }
      const needsReview = findings.some((finding) => finding.kind !== 'missing');
      const state = needsReview ? 'needs_review' as const
        : repairsScheduled > 0 || settlesScheduled > 0 ? 'pending' as const : 'current' as const;
      const summary = findings.length === 0
        ? 'Every managed record matched.'
        : `${findings.length} managed ${findings.length === 1 ? 'record needs' : 'records need'} attention or repair.`;
      this.sqlite.query(`
        UPDATE airtable_sync_reconciliation_runs
           SET status = ?, finding_count = ?, completed_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status = 'assessing'
      `).run(needsReview ? 'attention' : 'succeeded', findings.length, input.nowMs, input.nowMs, input.runId);
      const dueWork = this.sqlite.query<{ readonly count: number }, [string, string]>(`
        SELECT
          (SELECT count(*) FROM airtable_sync_projection_work
            WHERE connection_id = ? AND status IN ('pending','running','failed'))
          +
          (SELECT count(*) FROM airtable_sync_settle_heads
            WHERE connection_id = ? AND status IN ('pending','running')) AS count
      `).get(run.connection_id, run.connection_id)?.count ?? 0;
      const conflicts = this.sqlite.query<{ readonly count: number }, [string]>(`
        SELECT count(*) AS count FROM airtable_sync_conflicts
         WHERE connection_id = ? AND status = 'open'
      `).get(run.connection_id)?.count ?? 0;
      this.sqlite.query(`
        INSERT INTO airtable_sync_health(
          connection_id, state, due_work, conflict_count, request_count,
          schema_drift_count, dead_letter_count, last_lightweight_at_ms, last_full_at_ms,
          last_full_summary, updated_at_ms
        ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          state = excluded.state,
          due_work = excluded.due_work,
          conflict_count = excluded.conflict_count,
          schema_drift_count = excluded.schema_drift_count,
          last_lightweight_at_ms = COALESCE(excluded.last_lightweight_at_ms, airtable_sync_health.last_lightweight_at_ms),
          last_full_at_ms = COALESCE(excluded.last_full_at_ms, airtable_sync_health.last_full_at_ms),
          last_full_summary = CASE WHEN excluded.last_full_at_ms IS NULL
            THEN airtable_sync_health.last_full_summary ELSE excluded.last_full_summary END,
          version = airtable_sync_health.version + 1,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        run.connection_id,
        state,
        dueWork,
        conflicts,
        findings.filter((finding) => finding.kind !== 'missing').length,
        run.kind === 'lightweight' ? input.nowMs : null,
        run.kind === 'lightweight' ? null : input.nowMs,
        summary,
        input.nowMs
      );
      return Object.freeze({
        findings: findings.length,
        repairsScheduled,
        settlesScheduled,
        state
      });
    })();
  }

  readHealth(connectionId: string): SQLiteAirtableSyncHealth | undefined {
    parseSourceConnectionId(connectionId);
    const row = this.sqlite.query<{
      readonly connection_id: string;
      readonly state: SQLiteAirtableSyncHealth['state'];
      readonly due_work: number;
      readonly conflict_count: number;
      readonly request_count: number;
      readonly schema_drift_count: number;
      readonly dead_letter_count: number;
      readonly last_outbound_at_ms: number | null;
      readonly last_inbound_at_ms: number | null;
      readonly last_lightweight_at_ms: number | null;
      readonly last_full_at_ms: number | null;
      readonly last_full_summary: string | null;
      readonly version: number;
    }, [string]>(`
      SELECT connection_id, state, due_work, conflict_count, request_count,
             schema_drift_count, dead_letter_count, last_outbound_at_ms,
             last_inbound_at_ms, last_lightweight_at_ms, last_full_at_ms,
             last_full_summary, version
        FROM airtable_sync_health WHERE connection_id = ?
    `).get(connectionId);
    return row ? Object.freeze({
      connectionId: row.connection_id,
      state: row.state,
      dueWork: row.due_work,
      conflicts: row.conflict_count,
      requests: row.request_count,
      schemaDrift: row.schema_drift_count,
      deadLetters: row.dead_letter_count,
      ...(row.last_outbound_at_ms === null ? {} : { lastOutboundAtMs: row.last_outbound_at_ms }),
      ...(row.last_inbound_at_ms === null ? {} : { lastInboundAtMs: row.last_inbound_at_ms }),
      ...(row.last_lightweight_at_ms === null ? {} : { lastLightweightAtMs: row.last_lightweight_at_ms }),
      ...(row.last_full_at_ms === null ? {} : { lastFullAtMs: row.last_full_at_ms }),
      ...(row.last_full_summary === null ? {} : { lastFullSummary: row.last_full_summary }),
      version: row.version
    }) : undefined;
  }
}
