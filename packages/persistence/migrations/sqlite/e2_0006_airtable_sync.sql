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
