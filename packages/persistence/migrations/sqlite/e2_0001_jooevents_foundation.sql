-- epoch-2 clean identity/access foundation
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_accounts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(id), access_token TEXT, refresh_token TEXT,
  id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER,
  scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(provider_id, account_id)
);
CREATE INDEX IF NOT EXISTS auth_accounts_user_idx ON auth_accounts(user_id);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES auth_users(id),
  expires_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_verifications (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications(identifier);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CHECK(state IN ('active', 'archived'))
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
  primary_email_id TEXT, avatar_asset_id TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CHECK(status IN ('pending_review', 'active', 'suspended', 'deactivated'))
);
CREATE TABLE IF NOT EXISTS auth_user_links (
  auth_user_id TEXT PRIMARY KEY REFERENCES auth_users(id), user_id TEXT UNIQUE REFERENCES users(id),
  provisioning_state TEXT NOT NULL, last_error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(provisioning_state IN ('pending', 'ready', 'failed'))
);
CREATE TABLE IF NOT EXISTS user_emails (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), normalized_email TEXT NOT NULL,
  display_email TEXT NOT NULL, verified INTEGER NOT NULL, source TEXT NOT NULL,
  is_primary INTEGER NOT NULL, verified_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL,
  CHECK(source IN ('auth_provider', 'admin', 'user'))
);
CREATE UNIQUE INDEX IF NOT EXISTS user_emails_live_verified_owner_unique
  ON user_emails(normalized_email) WHERE verified = 1 AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_emails_primary_unique
  ON user_emails(user_id) WHERE is_primary = 1 AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_emails_user_idx ON user_emails(user_id);
CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL,
  issuer TEXT NOT NULL, subject TEXT NOT NULL, email_snapshot TEXT,
  email_verified_snapshot INTEGER NOT NULL, display_name_snapshot TEXT, avatar_url_snapshot TEXT,
  linked_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
  UNIQUE(provider, issuer, subject)
);
CREATE INDEX IF NOT EXISTS external_identities_user_idx ON external_identities(user_id);
CREATE TABLE IF NOT EXISTS workspace_memberships (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
  approved_by_user_id TEXT, approved_at INTEGER, decision_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id, user_id),
  CHECK(status IN ('invited', 'pending_review', 'active', 'suspended', 'deactivated'))
);
CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx ON workspace_memberships(user_id, workspace_id);
CREATE INDEX IF NOT EXISTS workspace_memberships_status_idx ON workspace_memberships(workspace_id, status);
CREATE TABLE IF NOT EXISTS access_reservations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  normalized_email TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER,
  created_by_user_id TEXT, consumed_by_user_id TEXT, consumed_at INTEGER,
  created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CHECK(status IN ('open', 'consumed', 'revoked', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS access_reservations_live_unique
  ON access_reservations(workspace_id, normalized_email) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS access_reservations_lookup_idx ON access_reservations(workspace_id, normalized_email);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
  description TEXT NOT NULL, source_preset_key TEXT, source_preset_version INTEGER,
  archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_live_name_unique ON roles(workspace_id, name) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id), permission_id TEXT NOT NULL,
  PRIMARY KEY(role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS reservation_role_assignments (
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES access_reservations(id),
  role_id TEXT NOT NULL REFERENCES roles(id), scope_kind TEXT NOT NULL, event_id TEXT,
  CHECK((scope_kind = 'workspace' AND event_id IS NULL) OR (scope_kind = 'event' AND event_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS reservation_permission_overrides (
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES access_reservations(id),
  permission_id TEXT NOT NULL, effect TEXT NOT NULL, scope_kind TEXT NOT NULL,
  event_id TEXT, reason TEXT NOT NULL,
  CHECK(effect IN ('grant', 'deny')),
  CHECK((scope_kind = 'workspace' AND event_id IS NULL) OR (scope_kind = 'event' AND event_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), role_id TEXT NOT NULL REFERENCES roles(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), scope_kind TEXT NOT NULL, event_id TEXT,
  assigned_by_user_id TEXT, assigned_at INTEGER NOT NULL, expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK((scope_kind = 'workspace' AND event_id IS NULL) OR (scope_kind = 'event' AND event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS role_assignments_access_idx ON role_assignments(user_id, workspace_id);
CREATE TABLE IF NOT EXISTS permission_overrides (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), permission_id TEXT NOT NULL,
  effect TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), scope_kind TEXT NOT NULL,
  event_id TEXT, reason TEXT NOT NULL, decided_by_user_id TEXT, decided_at INTEGER NOT NULL,
  expires_at INTEGER, version INTEGER NOT NULL DEFAULT 1,
  CHECK(effect IN ('grant', 'deny')),
  CHECK((scope_kind = 'workspace' AND event_id IS NULL) OR (scope_kind = 'event' AND event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS permission_overrides_access_idx ON permission_overrides(user_id, workspace_id);
CREATE TABLE IF NOT EXISTS identity_link_requests (
  id TEXT PRIMARY KEY, target_user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL,
  normalized_target_email TEXT NOT NULL, state TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_link_requests_active_unique
  ON identity_link_requests(target_user_id, provider, normalized_target_email)
  WHERE state NOT IN ('linked', 'expired', 'cancelled', 'failed');
CREATE TABLE IF NOT EXISTS identity_link_evidence (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES identity_link_requests(id), kind TEXT NOT NULL,
  provider TEXT, issuer TEXT, subject TEXT, authenticated_at INTEGER, observed_at INTEGER NOT NULL,
  redacted_metadata_json TEXT, UNIQUE(request_id, kind)
);
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), purpose TEXT NOT NULL,
  storage_provider TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL, checksum_sha256 TEXT NOT NULL, width INTEGER, height INTEGER,
  source_provider TEXT, source_url TEXT, source_fingerprint TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS avatar_import_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
  source_provider TEXT NOT NULL, source_url TEXT NOT NULL, source_fingerprint TEXT,
  expected_current_asset_id TEXT, replace_asset_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, last_error_code TEXT, lease_owner TEXT, lease_expires_at INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(status IN ('pending', 'running', 'succeeded', 'failed'))
);
CREATE INDEX IF NOT EXISTS avatar_jobs_due_idx ON avatar_import_jobs(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL,
  sensitive_payload_json TEXT, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, lease_owner TEXT, lease_expires_at INTEGER,
  last_error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(status IN ('pending', 'running', 'succeeded', 'failed'))
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox_events(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL, workspace_id TEXT, event_id TEXT,
  evidence_json TEXT NOT NULL, correlation_id TEXT NOT NULL, occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_workspace_time_idx ON audit_events(workspace_id, occurred_at);
CREATE TABLE IF NOT EXISTS bootstrap_state (
  key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_reservation_id TEXT NOT NULL REFERENCES access_reservations(id), completed_at INTEGER NOT NULL
);

-- artifact: foundation-uow
CREATE TABLE operation_log (
  id TEXT PRIMARY KEY CHECK(
    length(id) = 36
    AND id NOT GLOB '*[^0-9a-f-]*'
  ),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 160),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  registry_digest_sha256 TEXT NOT NULL CHECK(length(registry_digest_sha256) = 64 AND registry_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  surface TEXT NOT NULL CHECK(surface IN ('operator_http', 'participant_http', 'public_http', 'external_mcp', 'app_model', 'application_job', 'provider_ingress')),
  actor_json TEXT NOT NULL CHECK(
    length(actor_json) BETWEEN 2 AND 4096
    AND json_valid(actor_json)
    AND json_type(actor_json) = 'object'
  ),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT CHECK(event_id IS NULL OR length(event_id) = 36),
  subjects_json TEXT NOT NULL CHECK(
    length(subjects_json) BETWEEN 2 AND 4096
    AND
    json_valid(subjects_json)
    AND json_type(subjects_json) = 'array'
    AND json_array_length(subjects_json) BETWEEN 1 AND 16
  ),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 240),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  correlation_id TEXT NOT NULL CHECK(
    length(correlation_id) = 36
    AND correlation_id NOT GLOB '*[^0-9a-f-]*'
  ),
  scope_partition_key TEXT NOT NULL CHECK(length(scope_partition_key) = 64 AND scope_partition_key NOT GLOB '*[^0-9a-f]*'),
  idempotency_verifier_profile_key TEXT NOT NULL CHECK(length(idempotency_verifier_profile_key) BETWEEN 1 AND 160),
  idempotency_verifier_profile_version INTEGER NOT NULL CHECK(idempotency_verifier_profile_version > 0),
  idempotency_key_verifier TEXT NOT NULL CHECK(length(idempotency_key_verifier) = 64 AND idempotency_key_verifier NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(
    length(result_json) BETWEEN 2 AND 65536
    AND json_valid(result_json)
    AND json_extract(result_json, '$.receipt.id') = id
    AND json_extract(result_json, '$.receipt.operationName') = operation_name
    AND json_extract(result_json, '$.receipt.operationVersion') = operation_version
    AND (
      json_extract(result_json, '$.kind') = 'success'
      OR (
        json_extract(result_json, '$.kind') = 'outcome'
        AND json_extract(result_json, '$.terminal') = 1
      )
    )
  ),
  action_batch_id TEXT,
  action_step_id TEXT,
  CHECK((action_batch_id IS NULL) = (action_step_id IS NULL)),
  UNIQUE (
    scope_partition_key,
    authority_principal_key,
    operation_name,
    operation_version,
    surface,
    idempotency_verifier_profile_key,
    idempotency_verifier_profile_version,
    idempotency_key_verifier
  )
);

CREATE INDEX operation_log_workspace_history
  ON operation_log(workspace_id, occurred_at_ms DESC, id DESC);
CREATE INDEX operation_log_event_history
  ON operation_log(workspace_id, event_id, occurred_at_ms DESC, id DESC)
  WHERE event_id IS NOT NULL;
CREATE INDEX operation_log_actor_history
  ON operation_log(authority_principal_key, occurred_at_ms DESC, id DESC);

CREATE TRIGGER operation_log_no_update
BEFORE UPDATE ON operation_log
BEGIN
  SELECT RAISE(ABORT, 'operation log is immutable');
END;

CREATE TRIGGER operation_log_no_delete
BEFORE DELETE ON operation_log
BEGIN
  SELECT RAISE(ABORT, 'operation log is immutable');
END;

-- artifact: agent-action-runs
CREATE TABLE agent_action_batches (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_extract(plan_json, '$.batchId') = id),
  plan_digest_sha256 TEXT NOT NULL UNIQUE CHECK(length(plan_digest_sha256) = 64 AND plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  registry_digest_sha256 TEXT NOT NULL CHECK(length(registry_digest_sha256) = 64 AND registry_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_surface TEXT NOT NULL CHECK(source_surface IN ('external_mcp', 'app_model')),
  source_principal_id TEXT NOT NULL CHECK(length(source_principal_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT CHECK(event_id IS NULL OR length(event_id) = 36),
  bounds_json TEXT NOT NULL CHECK(json_valid(bounds_json) AND json_type(bounds_json) = 'object'),
  status TEXT NOT NULL CHECK(status IN ('awaiting_approval','rejected','queued','running','paused','cancel_requested','cancelled','failed','succeeded')),
  version INTEGER NOT NULL CHECK(version > 0),
  current_ordinal INTEGER NOT NULL CHECK(current_ordinal > 0),
  approved_plan_digest_sha256 TEXT,
  approved_by_principal_id TEXT,
  approved_at_ms INTEGER,
  approval_expires_at_ms INTEGER,
  approval_policy_key TEXT,
  approval_policy_version INTEGER,
  approved_bounds_json TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  safe_status_detail_json TEXT CHECK(safe_status_detail_json IS NULL OR json_valid(safe_status_detail_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL)),
  CHECK(
    (approved_plan_digest_sha256 IS NULL AND approved_by_principal_id IS NULL AND approved_at_ms IS NULL
      AND approval_expires_at_ms IS NULL AND approval_policy_key IS NULL
      AND approval_policy_version IS NULL AND approved_bounds_json IS NULL)
    OR
    (approved_plan_digest_sha256 IS NOT NULL AND approved_by_principal_id IS NOT NULL AND approved_at_ms IS NOT NULL
      AND approval_expires_at_ms IS NOT NULL AND approval_policy_key IS NOT NULL
      AND approval_policy_version > 0 AND json_valid(approved_bounds_json))
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE agent_action_steps (
  batch_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 160),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  contract_digest_sha256 TEXT NOT NULL CHECK(length(contract_digest_sha256) = 64 AND contract_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  request_hash_sha256 TEXT NOT NULL CHECK(length(request_hash_sha256) = 64 AND request_hash_sha256 NOT GLOB '*[^0-9a-f]*'),
  guards_json TEXT NOT NULL CHECK(json_valid(guards_json) AND json_type(guards_json) = 'array'),
  subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json) AND json_type(subjects_json) = 'array'),
  display_label TEXT NOT NULL CHECK(length(display_label) BETWEEN 1 AND 160),
  consequences_json TEXT NOT NULL CHECK(json_valid(consequences_json) AND json_type(consequences_json) = 'array'),
  external_effect TEXT NOT NULL CHECK(external_effect IN ('none','reconcilable')),
  semantic_idempotency_key TEXT NOT NULL CHECK(length(semantic_idempotency_key) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_external','needs_attention','cancelled','succeeded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_safe_outcome_json TEXT CHECK(last_safe_outcome_json IS NULL OR json_valid(last_safe_outcome_json)),
  terminal_log_id TEXT,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(batch_id, id),
  UNIQUE(batch_id, ordinal),
  UNIQUE(semantic_idempotency_key),
  UNIQUE(batch_id, id, ordinal),
  FOREIGN KEY(batch_id) REFERENCES agent_action_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(terminal_log_id) REFERENCES operation_log(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX agent_action_batches_status_updated
  ON agent_action_batches(status, updated_at_ms DESC, id);
CREATE INDEX agent_action_steps_next
  ON agent_action_steps(batch_id, status, ordinal);

CREATE TRIGGER agent_action_batches_frozen_plan
BEFORE UPDATE ON agent_action_batches
WHEN NEW.plan_json IS NOT OLD.plan_json
  OR NEW.plan_digest_sha256 IS NOT OLD.plan_digest_sha256
  OR NEW.registry_digest_sha256 IS NOT OLD.registry_digest_sha256
  OR NEW.source_surface IS NOT OLD.source_surface
  OR NEW.source_principal_id IS NOT OLD.source_principal_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.bounds_json IS NOT OLD.bounds_json
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'agent action batch plan is immutable'); END;

CREATE TRIGGER agent_action_steps_frozen_plan
BEFORE UPDATE ON agent_action_steps
WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.id IS NOT OLD.id OR NEW.ordinal IS NOT OLD.ordinal
  OR NEW.operation_name IS NOT OLD.operation_name OR NEW.operation_version IS NOT OLD.operation_version
  OR NEW.contract_digest_sha256 IS NOT OLD.contract_digest_sha256 OR NEW.input_json IS NOT OLD.input_json
  OR NEW.request_hash_sha256 IS NOT OLD.request_hash_sha256 OR NEW.guards_json IS NOT OLD.guards_json
  OR NEW.subjects_json IS NOT OLD.subjects_json OR NEW.display_label IS NOT OLD.display_label
  OR NEW.consequences_json IS NOT OLD.consequences_json OR NEW.external_effect IS NOT OLD.external_effect
  OR NEW.semantic_idempotency_key IS NOT OLD.semantic_idempotency_key
BEGIN SELECT RAISE(ABORT, 'agent action step plan is immutable'); END;

-- artifact: event-spine
CREATE TABLE event_spine_workspace_sets (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  current_event_id TEXT CHECK(current_event_id IS NULL OR length(current_event_id) = 36),
  UNIQUE (workspace_id, current_event_id),
  FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, current_event_id)
    REFERENCES event_spine_heads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 255 AND timezone = trim(timezone)),
  start_date TEXT NOT NULL CHECK(
    length(start_date) = 10
    AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(start_date, '+0 days') = start_date
  ),
  end_date TEXT NOT NULL CHECK(
    length(end_date) = 10
    AND end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(end_date, '+0 days') = end_date
    AND end_date >= start_date
  ),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  create_plan_digest_sha256 TEXT NOT NULL CHECK(
    length(create_plan_digest_sha256) = 64
    AND create_plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, id, create_plan_digest_sha256),
  FOREIGN KEY (workspace_id)
    REFERENCES event_spine_workspace_sets(workspace_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_scope_roots (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_heads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_spine_scope_roots_no_update
BEFORE UPDATE ON event_spine_scope_roots
BEGIN
  SELECT RAISE(ABORT, 'event scope root links are immutable');
END;

CREATE TRIGGER event_spine_scope_roots_no_delete
BEFORE DELETE ON event_spine_scope_roots
BEGIN
  SELECT RAISE(ABORT, 'event scope root links are immutable');
END;

-- artifact: event-settings-domain
CREATE TABLE event_settings_companions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  event_version INTEGER NOT NULL CHECK(event_version > 0),
  location TEXT NOT NULL CHECK(length(location) <= 500),
  venue_note TEXT NOT NULL CHECK(length(venue_note) <= 8000),
  day_start TEXT CHECK(
    day_start IS NULL
    OR day_start GLOB '[01][0-9]:[0-5][0-9]'
    OR day_start GLOB '2[0-3]:[0-5][0-9]'
  ),
  day_end TEXT CHECK(
    day_end IS NULL
    OR day_end GLOB '[01][0-9]:[0-5][0-9]'
    OR day_end GLOB '2[0-3]:[0-5][0-9]'
  ),
  slot_minutes INTEGER CHECK(slot_minutes IS NULL OR slot_minutes IN (5, 10, 15, 20, 30, 60)),
  CHECK((day_start IS NULL) = (day_end IS NULL) AND (day_start IS NULL) = (slot_minutes IS NULL)),
  CHECK(day_start IS NULL OR day_end > day_start),
  CHECK(
    day_start IS NULL
    OR ((CAST(substr(day_end, 1, 2) AS INTEGER) * 60 + CAST(substr(day_end, 4, 2) AS INTEGER))
      - (CAST(substr(day_start, 1, 2) AS INTEGER) * 60 + CAST(substr(day_start, 4, 2) AS INTEGER)))
      % slot_minutes = 0
  ),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, event_id, event_version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_settings_companions_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON event_settings_companions
BEGIN
  SELECT RAISE(ABORT, 'event settings scope is immutable');
END;

CREATE TRIGGER event_settings_companions_version_advances_once
BEFORE UPDATE OF event_version ON event_settings_companions
WHEN NEW.event_version != OLD.event_version + 1
BEGIN
  SELECT RAISE(ABORT, 'event settings version must advance once');
END;

CREATE TRIGGER event_settings_companions_no_delete
BEFORE DELETE ON event_settings_companions
BEGIN
  SELECT RAISE(ABORT, 'event settings companions are retained with the Event root');
END;

-- artifact: template-authoring-domain
CREATE TABLE template_artifact_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) = 36),
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('message','surface','theme')),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number > 0),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY(workspace_id,event_id,artifact_id),
  UNIQUE(workspace_id,event_id,current_revision_id),
  CHECK(version = current_revision_number),
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,current_revision_id)
    REFERENCES template_artifact_revisions(workspace_id,event_id,revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE template_artifact_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) = 36),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  predecessor_revision_id TEXT,
  predecessor_digest_sha256 TEXT,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('message','surface','theme')),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,revision_id),
  UNIQUE(workspace_id,event_id,artifact_id,revision_number),
  UNIQUE(workspace_id,event_id,artifact_id,digest_sha256,revision_number),
  CHECK((revision_number = 1) = (predecessor_revision_id IS NULL)),
  CHECK((predecessor_revision_id IS NULL) = (predecessor_digest_sha256 IS NULL)),
  CHECK(json_extract(revision_json, '$.artifactId') = artifact_id),
  CHECK(json_extract(revision_json, '$.revisionId') = revision_id),
  CHECK(json_extract(revision_json, '$.number') = revision_number),
  CHECK(json_extract(revision_json, '$.document.kind') = artifact_kind),
  CHECK(json_extract(revision_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY(workspace_id,event_id,artifact_id)
    REFERENCES template_artifact_heads(workspace_id,event_id,artifact_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,event_id,predecessor_revision_id)
    REFERENCES template_artifact_revisions(workspace_id,event_id,revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX template_artifact_heads_kind
  ON template_artifact_heads(workspace_id,event_id,artifact_kind,artifact_id);
CREATE INDEX template_artifact_revisions_history
  ON template_artifact_revisions(workspace_id,event_id,artifact_id,revision_number);

CREATE TRIGGER template_artifact_revisions_no_update
BEFORE UPDATE ON template_artifact_revisions
BEGIN SELECT RAISE(ABORT, 'template artifact revisions are immutable'); END;
CREATE TRIGGER template_artifact_revisions_no_delete
BEFORE DELETE ON template_artifact_revisions
BEGIN SELECT RAISE(ABORT, 'template artifact revisions are immutable'); END;
CREATE TRIGGER template_artifact_heads_scope_immutable
BEFORE UPDATE OF workspace_id,event_id,artifact_id,artifact_kind ON template_artifact_heads
BEGIN SELECT RAISE(ABORT, 'template artifact head identity is immutable'); END;
CREATE TRIGGER template_artifact_heads_advance_once
BEFORE UPDATE ON template_artifact_heads
WHEN NEW.version != OLD.version + 1
  OR NEW.current_revision_number != OLD.current_revision_number + 1
BEGIN SELECT RAISE(ABORT, 'template artifact heads advance exactly once'); END;
CREATE TRIGGER template_artifact_heads_no_delete
BEFORE DELETE ON template_artifact_heads
BEGIN SELECT RAISE(ABORT, 'template artifact heads are retained with the event'); END;

-- artifact: template-artifact-native-effect
CREATE TABLE template_artifact_review_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) = 36),
  action TEXT NOT NULL CHECK(action IN ('replace','revert')),
  status TEXT NOT NULL CHECK(status IN ('draft','published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(length(head_revision_digest_sha256) = 64 AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(published_by_user_id IS NULL OR length(published_by_user_id) = 36),
  published_at_ms INTEGER CHECK(published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,id,head_revision_id,head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY(workspace_id,event_id,artifact_id) REFERENCES template_artifact_heads(workspace_id,event_id,artifact_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(published_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE template_artifact_review_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,draft_id,id),
  UNIQUE(workspace_id,event_id,draft_id,id,digest_sha256),
  FOREIGN KEY(workspace_id,event_id,draft_id) REFERENCES template_artifact_review_drafts(workspace_id,event_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER template_artifact_review_revisions_no_update BEFORE UPDATE ON template_artifact_review_revisions BEGIN SELECT RAISE(ABORT, 'template artifact review revisions are immutable'); END;
CREATE TRIGGER template_artifact_review_revisions_no_delete BEFORE DELETE ON template_artifact_review_revisions BEGIN SELECT RAISE(ABORT, 'template artifact review revisions are immutable'); END;
CREATE TRIGGER template_artifact_review_drafts_no_delete BEFORE DELETE ON template_artifact_review_drafts BEGIN SELECT RAISE(ABORT, 'template artifact review drafts are retained'); END;

-- artifact: template-edit-effect
CREATE TABLE template_edit_model_receipts (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('classify','revise')),
  run_id TEXT NOT NULL UNIQUE CHECK(length(run_id) = 36),
  attempt_id TEXT NOT NULL UNIQUE CHECK(length(attempt_id) = 36),
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  profile_digest_sha256 TEXT NOT NULL CHECK(
    length(profile_digest_sha256) = 64
    AND profile_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  scaffold_key TEXT,
  scaffold_version INTEGER,
  scaffold_digest_sha256 TEXT,
  result_digest_sha256 TEXT NOT NULL CHECK(
    length(result_digest_sha256) = 64
    AND result_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  operation_name TEXT NOT NULL CHECK(operation_name IN (
    'template.edit.classify','template.edit.revise'
  )),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (action = 'classify' AND scaffold_key IS NULL
      AND scaffold_version IS NULL AND scaffold_digest_sha256 IS NULL)
    OR
    (action = 'revise' AND scaffold_key IS NOT NULL
      AND scaffold_version IS NOT NULL AND scaffold_version > 0
      AND length(scaffold_digest_sha256) = 64
      AND scaffold_digest_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK(json_extract(result_json, '$.artifactId') = artifact_id),
  FOREIGN KEY(receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,artifact_id)
    REFERENCES template_artifact_heads(workspace_id,event_id,artifact_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER template_edit_model_receipts_no_update
BEFORE UPDATE ON template_edit_model_receipts
BEGIN SELECT RAISE(ABORT, 'template edit model receipts are immutable'); END;
CREATE TRIGGER template_edit_model_receipts_no_delete
BEFORE DELETE ON template_edit_model_receipts
BEGIN SELECT RAISE(ABORT, 'template edit model receipts are immutable'); END;

-- artifact: deadline-domain
CREATE TABLE deadline_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE deadlines (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('cfp_close', 'review_due', 'task_due')),
  status TEXT NOT NULL CHECK(status IN ('active', 'cleared')),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  grace_policy TEXT NOT NULL CHECK(grace_policy = 'soft'),
  display_date TEXT CHECK(
    display_date IS NULL OR (
      length(display_date) = 10
      AND display_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(display_date, '+0 days') = display_date
    )
  ),
  effective_at_ms INTEGER CHECK(
    effective_at_ms IS NULL OR effective_at_ms BETWEEN 0 AND 8640000000000000
  ),
  boundary_profile_key TEXT,
  boundary_profile_version INTEGER,
  boundary_profile_digest_sha256 TEXT,
  event_timezone TEXT,
  event_version INTEGER,
  local_boundary_date TEXT CHECK(
    local_boundary_date IS NULL OR (
      length(local_boundary_date) = 10
      AND local_boundary_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(local_boundary_date, '+0 days') = local_boundary_date
    )
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  CHECK(
    (status = 'active'
      AND display_date IS NOT NULL AND effective_at_ms IS NOT NULL
      AND boundary_profile_key = 'deadline.calendar-date.event-local-end-exclusive'
      AND boundary_profile_version = 1
      AND length(boundary_profile_digest_sha256) = 64
      AND boundary_profile_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND event_timezone IS NOT NULL AND length(event_timezone) BETWEEN 1 AND 255
      AND event_version > 0 AND local_boundary_date IS NOT NULL)
    OR
    (status = 'cleared'
      AND display_date IS NULL AND effective_at_ms IS NULL
      AND boundary_profile_key IS NULL AND boundary_profile_version IS NULL
      AND boundary_profile_digest_sha256 IS NULL AND event_timezone IS NULL
      AND event_version IS NULL AND local_boundary_date IS NULL)
  ),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES deadline_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX deadlines_status_order
  ON deadlines(workspace_id, event_id, status, id);

CREATE TRIGGER deadlines_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, kind, created_by_user_id, created_at_ms ON deadlines
BEGIN
  SELECT RAISE(ABORT, 'deadline identity is immutable');
END;

CREATE TRIGGER deadlines_no_delete
BEFORE DELETE ON deadlines
BEGIN
  SELECT RAISE(ABORT, 'deadline identity is retained');
END;

-- artifact: program-vocabulary-domain
CREATE TABLE program_vocabulary_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  set_version INTEGER NOT NULL CHECK(set_version >= 2),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_rooms (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  capacity INTEGER CHECK(capacity IS NULL OR capacity > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_tracks (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_formats (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX program_vocabulary_rooms_read
  ON program_vocabulary_rooms(workspace_id, event_id, id);
CREATE INDEX program_vocabulary_tracks_read
  ON program_vocabulary_tracks(workspace_id, event_id, id);
CREATE INDEX program_vocabulary_formats_read
  ON program_vocabulary_formats(workspace_id, event_id, id);

CREATE TRIGGER program_vocabulary_sets_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON program_vocabulary_sets
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary scope is immutable');
END;

CREATE TRIGGER program_vocabulary_sets_attribution_guard
BEFORE UPDATE ON program_vocabulary_sets
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_rooms_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_rooms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary identity is immutable');
END;

CREATE TRIGGER program_vocabulary_rooms_attribution_guard
BEFORE UPDATE ON program_vocabulary_rooms
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_tracks_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_tracks
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary identity is immutable');
END;

CREATE TRIGGER program_vocabulary_tracks_attribution_guard
BEFORE UPDATE ON program_vocabulary_tracks
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_formats_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_formats
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary identity is immutable');
END;

CREATE TRIGGER program_vocabulary_formats_attribution_guard
BEFORE UPDATE ON program_vocabulary_formats
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_rooms_distinct_id_insert
BEFORE INSERT ON program_vocabulary_rooms
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_tracks_distinct_id_insert
BEFORE INSERT ON program_vocabulary_tracks
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_formats_distinct_id_insert
BEFORE INSERT ON program_vocabulary_formats
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_rooms_distinct_id_update
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_rooms
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_tracks_distinct_id_update
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_tracks
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_formats_distinct_id_update
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_formats
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

-- artifact: program-vocabulary-merge-effect
CREATE TABLE program_vocabulary_merge_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(
    length(head_revision_digest_sha256) = 64
    AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(
    published_by_user_id IS NULL OR length(published_by_user_id) = 36
  ),
  published_at_ms INTEGER CHECK(
    published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, id, head_revision_id, head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_merge_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(
    json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id, id),
  UNIQUE (workspace_id, event_id, draft_id, id, digest_sha256),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES program_vocabulary_merge_drafts(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER program_vocabulary_merge_revisions_no_update
BEFORE UPDATE ON program_vocabulary_merge_revisions
BEGIN SELECT RAISE(ABORT, 'program vocabulary merge revisions are immutable'); END;
CREATE TRIGGER program_vocabulary_merge_revisions_no_delete
BEFORE DELETE ON program_vocabulary_merge_revisions
BEGIN SELECT RAISE(ABORT, 'program vocabulary merge revisions are immutable'); END;
CREATE TRIGGER program_vocabulary_merge_drafts_no_delete
BEFORE DELETE ON program_vocabulary_merge_drafts
BEGIN SELECT RAISE(ABORT, 'program vocabulary merge drafts are retained'); END;

-- artifact: schedule-placement-domain
CREATE TABLE schedule_placement_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  schedule_version INTEGER NOT NULL CHECK(schedule_version >= 2),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE schedule_occurrences (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  room_id TEXT NOT NULL CHECK(length(room_id) = 36),
  start_at_ms INTEGER NOT NULL CHECK(start_at_ms BETWEEN 0 AND 8640000000000000),
  end_at_ms INTEGER NOT NULL CHECK(end_at_ms BETWEEN 0 AND 8640000000000000),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK(start_at_ms < end_at_ms),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES schedule_placement_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, room_id)
    REFERENCES program_vocabulary_rooms(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX schedule_occurrences_range
  ON schedule_occurrences(workspace_id, event_id, start_at_ms, end_at_ms, id);
CREATE INDEX schedule_occurrences_room_overlap
  ON schedule_occurrences(workspace_id, event_id, room_id, start_at_ms, end_at_ms, id);

CREATE TRIGGER schedule_placement_sets_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON schedule_placement_sets
BEGIN
  SELECT RAISE(ABORT, 'schedule scope is immutable');
END;

CREATE TRIGGER schedule_occurrences_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, session_id ON schedule_occurrences
BEGIN
  SELECT RAISE(ABORT, 'schedule occurrence identity is immutable');
END;

-- artifact: classified-payload-store
CREATE TABLE classified_payload_records (
  payload_ref_id TEXT PRIMARY KEY
    CHECK(length(payload_ref_id) = 36 AND payload_ref_id = lower(payload_ref_id)),
  record_schema_version INTEGER NOT NULL CHECK(record_schema_version = 1),
  encryption_profile_key TEXT NOT NULL
    CHECK(length(encryption_profile_key) BETWEEN 1 AND 160
      AND encryption_profile_key = lower(encryption_profile_key)
      AND encryption_profile_key = trim(encryption_profile_key)),
  encryption_profile_version INTEGER NOT NULL CHECK(encryption_profile_version > 0),
  classification_profile_key TEXT NOT NULL
    CHECK(length(classification_profile_key) BETWEEN 1 AND 160
      AND classification_profile_key = lower(classification_profile_key)
      AND classification_profile_key = trim(classification_profile_key)),
  classification_profile_version INTEGER NOT NULL CHECK(classification_profile_version > 0),
  schema_profile_key TEXT NOT NULL
    CHECK(length(schema_profile_key) BETWEEN 1 AND 160
      AND schema_profile_key = lower(schema_profile_key)
      AND schema_profile_key = trim(schema_profile_key)),
  schema_profile_version INTEGER NOT NULL CHECK(schema_profile_version > 0),
  content_profile_key TEXT NOT NULL
    CHECK(length(content_profile_key) BETWEEN 1 AND 160
      AND content_profile_key = lower(content_profile_key)
      AND content_profile_key = trim(content_profile_key)),
  content_profile_version INTEGER NOT NULL CHECK(content_profile_version > 0),
  integrity_profile_key TEXT NOT NULL CHECK(integrity_profile_key = 'integrity.sha256'),
  integrity_profile_version INTEGER NOT NULL CHECK(integrity_profile_version = 1),
  descriptor_auth_profile_key TEXT NOT NULL
    CHECK(length(descriptor_auth_profile_key) BETWEEN 1 AND 160
      AND descriptor_auth_profile_key = lower(descriptor_auth_profile_key)
      AND descriptor_auth_profile_key = trim(descriptor_auth_profile_key)),
  descriptor_auth_profile_version INTEGER NOT NULL CHECK(descriptor_auth_profile_version > 0),
  scope_binding TEXT NOT NULL CHECK(length(scope_binding) BETWEEN 1 AND 256),
  purpose TEXT NOT NULL
    CHECK(length(purpose) BETWEEN 1 AND 160 AND purpose = lower(purpose) AND purpose = trim(purpose)),
  content_type TEXT NOT NULL
    CHECK(length(content_type) BETWEEN 3 AND 191 AND content_type = lower(content_type)
      AND content_type = trim(content_type)),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  integrity_digest_sha256 TEXT NOT NULL
    CHECK(length(integrity_digest_sha256) = 64
      AND integrity_digest_sha256 = lower(integrity_digest_sha256)),
  authenticated_data_digest_sha256 TEXT NOT NULL
    CHECK(length(authenticated_data_digest_sha256) = 64
      AND authenticated_data_digest_sha256 = lower(authenticated_data_digest_sha256)),
  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK(length(ciphertext) = byte_size),
  authentication_tag BLOB NOT NULL CHECK(length(authentication_tag) = 16),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE (encryption_profile_key, encryption_profile_version, nonce)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER classified_payload_records_reject_update
BEFORE UPDATE ON classified_payload_records
BEGIN
  SELECT RAISE(ABORT, 'classified payload records are immutable');
END;

CREATE TRIGGER classified_payload_records_reject_delete
BEFORE DELETE ON classified_payload_records
BEGIN
  SELECT RAISE(ABORT, 'classified payload records are immutable');
END;

-- artifact: communication-organizer-authoring
CREATE TABLE communication_authoring_payloads (
  payload_ref_id TEXT PRIMARY KEY NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  owner_key TEXT NOT NULL CHECK(length(owner_key) BETWEEN 1 AND 256),
  payload_kind TEXT NOT NULL CHECK(payload_kind IN (
    'template_content','template_field_bindings','template_field_fallback',
    'message_content','message_audience_draft'
  )),
  payload_schema_key TEXT NOT NULL,
  payload_schema_version INTEGER NOT NULL CHECK(payload_schema_version = 1),
  classification_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id,event_id,owner_key,payload_ref_id)
);
CREATE INDEX communication_authoring_payloads_scope_kind
  ON communication_authoring_payloads(workspace_id,event_id,owner_key,payload_kind,payload_ref_id);
CREATE TRIGGER communication_authoring_payloads_immutable_update
BEFORE UPDATE ON communication_authoring_payloads
BEGIN SELECT RAISE(ABORT, 'communication authoring payload metadata is immutable'); END;
CREATE TRIGGER communication_authoring_payloads_immutable_delete
BEFORE DELETE ON communication_authoring_payloads
BEGIN SELECT RAISE(ABORT, 'communication authoring payload metadata is immutable'); END;

CREATE TABLE communication_purposes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL,
  purpose_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','archived')),
  current_revision_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,purpose_id),
  UNIQUE(workspace_id,event_id,purpose_key)
);
CREATE TABLE communication_purpose_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL,
  purpose_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
  label TEXT NOT NULL,
  communication_class TEXT NOT NULL,
  policy_digest_sha256 TEXT NOT NULL CHECK(length(policy_digest_sha256) = 64),
  description TEXT NOT NULL,
  allowed_audience_sources_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,revision_id),
  UNIQUE(workspace_id,event_id,purpose_id,revision_number),
  FOREIGN KEY(workspace_id,event_id,purpose_id)
    REFERENCES communication_purposes(workspace_id,event_id,purpose_id)
);

CREATE TABLE message_templates (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','archived')),
  purpose_revision_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,template_id),
  UNIQUE(workspace_id,event_id,template_key)
);
CREATE TABLE message_template_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
  content_payload_ref_id TEXT NOT NULL REFERENCES communication_authoring_payloads(payload_ref_id),
  field_bindings_payload_ref_id TEXT NOT NULL REFERENCES communication_authoring_payloads(payload_ref_id),
  renderer_key TEXT NOT NULL,
  renderer_version INTEGER NOT NULL CHECK(renderer_version > 0),
  renderer_digest_sha256 TEXT NOT NULL CHECK(length(renderer_digest_sha256) = 64),
  merge_registry_key TEXT NOT NULL,
  merge_registry_version INTEGER NOT NULL CHECK(merge_registry_version > 0),
  merge_registry_digest_sha256 TEXT NOT NULL CHECK(length(merge_registry_digest_sha256) = 64),
  PRIMARY KEY(workspace_id,event_id,template_revision_id),
  UNIQUE(workspace_id,event_id,template_id,revision_number),
  FOREIGN KEY(workspace_id,event_id,template_id)
    REFERENCES message_templates(workspace_id,event_id,template_id)
);

CREATE TABLE communication_drafts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('active','proposed','discarded')),
  channel TEXT NOT NULL CHECK(channel = 'email'),
  purpose_revision_id TEXT NOT NULL,
  template_revision_id TEXT NULL,
  authoring_state TEXT NOT NULL CHECK(authoring_state IN ('uninitialized','ready')),
  content_payload_ref_id TEXT NOT NULL,
  audience_payload_ref_id TEXT NOT NULL,
  subject TEXT NULL,
  provenance_json TEXT NOT NULL,
  discard_reason_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,draft_id),
  FOREIGN KEY(workspace_id,event_id,purpose_revision_id)
    REFERENCES communication_purpose_revisions(workspace_id,event_id,revision_id),
  FOREIGN KEY(workspace_id,event_id,template_revision_id)
    REFERENCES message_template_revisions(workspace_id,event_id,template_revision_id),
  CHECK(
    (authoring_state = 'uninitialized'
      AND content_payload_ref_id = 'je.communication.message-draft.empty-content/v1'
      AND audience_payload_ref_id = 'je.communication.message-draft.empty-audience/v1'
      AND subject IS NULL
      AND state != 'proposed')
    OR
    (authoring_state = 'ready'
      AND content_payload_ref_id != 'je.communication.message-draft.empty-content/v1'
      AND audience_payload_ref_id != 'je.communication.message-draft.empty-audience/v1'
      AND subject IS NOT NULL)
  )
);
CREATE INDEX communication_drafts_owner_page
  ON communication_drafts(workspace_id,event_id,owner_key,updated_at DESC,draft_id DESC);

-- artifact: communication-organizer-authoring-effect
CREATE TABLE organizer_communication_authoring_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  operation_name TEXT NOT NULL CHECK(operation_name IN (
    'store_communication_authoring_payload',
    'create_message_draft',
    'revise_message_batch',
    'discard_message_draft'
  )),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  payload_ref_id TEXT,
  draft_id TEXT,
  entity_version INTEGER NOT NULL CHECK(entity_version > 0),
  request_hash TEXT NOT NULL CHECK(
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (operation_name = 'store_communication_authoring_payload'
      AND payload_ref_id IS NOT NULL AND draft_id IS NULL AND entity_version = 1)
    OR
    (operation_name IN ('create_message_draft','revise_message_batch','discard_message_draft')
      AND payload_ref_id IS NULL AND draft_id IS NOT NULL)
  ),
  FOREIGN KEY(receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(payload_ref_id)
    REFERENCES communication_authoring_payloads(payload_ref_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,draft_id)
    REFERENCES communication_drafts(workspace_id,event_id,draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(payload_ref_id),
  UNIQUE(workspace_id,event_id,draft_id,entity_version),
  UNIQUE(receipt_id,workspace_id,event_id,operation_name,entity_version)
) STRICT, WITHOUT ROWID;

CREATE TABLE organizer_communication_authoring_timeline (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) = 36),
  receipt_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'operation_receipt'),
  FOREIGN KEY(receipt_id)
    REFERENCES organizer_communication_authoring_receipt_links(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER organizer_communication_authoring_receipt_payload_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.payload_ref_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_authoring_payloads p
   WHERE p.payload_ref_id = NEW.payload_ref_id
     AND p.workspace_id = NEW.workspace_id
     AND p.event_id = NEW.event_id
     AND p.owner_key = NEW.authority_principal_key
)
BEGIN SELECT RAISE(ABORT, 'organizer communication payload receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_draft_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_drafts d
   WHERE d.workspace_id = NEW.workspace_id
     AND d.event_id = NEW.event_id
     AND d.draft_id = NEW.draft_id
     AND d.owner_key = NEW.authority_principal_key
     AND d.version = NEW.entity_version
)
BEGIN SELECT RAISE(ABORT, 'organizer communication draft receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_links_no_update
BEFORE UPDATE ON organizer_communication_authoring_receipt_links
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring receipt links are immutable'); END;
CREATE TRIGGER organizer_communication_authoring_receipt_links_no_delete
BEFORE DELETE ON organizer_communication_authoring_receipt_links
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring receipt links are immutable'); END;
CREATE TRIGGER organizer_communication_authoring_timeline_no_update
BEFORE UPDATE ON organizer_communication_authoring_timeline
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring timeline is immutable'); END;
CREATE TRIGGER organizer_communication_authoring_timeline_no_delete
BEFORE DELETE ON organizer_communication_authoring_timeline
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring timeline is immutable'); END;

-- artifact: communication-organizer-audience-preview
CREATE TABLE communication_audience_scope_state (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK(state_version > 0),
  PRIMARY KEY(workspace_id,event_id)
);

CREATE TABLE communication_current_audience_contacts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subject_ref_id TEXT NOT NULL,
  subject_version INTEGER NOT NULL CHECK(subject_version > 0),
  person_ref_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  safe_label TEXT NOT NULL,
  membership_evidence_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,subject_ref_id),
  UNIQUE(workspace_id,event_id,contact_ref_id)
);

CREATE TABLE communication_registered_audience_recipes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL CHECK(recipe_version > 0),
  recipe_digest_sha256 TEXT NOT NULL CHECK(length(recipe_digest_sha256)=64),
  source_definition_key TEXT NOT NULL,
  source_definition_version INTEGER NOT NULL CHECK(source_definition_version > 0),
  source_definition_digest_sha256 TEXT NOT NULL CHECK(length(source_definition_digest_sha256)=64),
  option_id TEXT NOT NULL,
  option_version INTEGER NOT NULL CHECK(option_version > 0),
  purpose_id TEXT NOT NULL,
  option_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,recipe_id,recipe_version),
  UNIQUE(workspace_id,event_id,option_id,option_version)
);
CREATE INDEX communication_registered_audience_options_page
  ON communication_registered_audience_recipes(workspace_id,event_id,option_id,option_version);

CREATE TABLE communication_registered_audience_members (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  subject_ref_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,recipe_id,recipe_version,subject_ref_id),
  FOREIGN KEY(workspace_id,event_id,recipe_id,recipe_version)
    REFERENCES communication_registered_audience_recipes(workspace_id,event_id,recipe_id,recipe_version),
  FOREIGN KEY(workspace_id,event_id,subject_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,subject_ref_id)
);

CREATE TABLE communication_registered_audience_source_versions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64),
  PRIMARY KEY(workspace_id,event_id,recipe_id,recipe_version,source_key),
  FOREIGN KEY(workspace_id,event_id,recipe_id,recipe_version)
    REFERENCES communication_registered_audience_recipes(workspace_id,event_id,recipe_id,recipe_version)
);

CREATE TABLE communication_channel_address_versions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  address_ref_id TEXT NOT NULL,
  address_version INTEGER NOT NULL CHECK(address_version > 0),
  contact_ref_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel='email'),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','revoked')),
  lifecycle_evidence_json TEXT NOT NULL,
  lookup_profile TEXT NOT NULL,
  lookup_version INTEGER NOT NULL CHECK(lookup_version > 0),
  lookup_keyed_value TEXT NOT NULL CHECK(length(lookup_keyed_value)=64),
  classified_payload_ref_id TEXT NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  payload_ref_version INTEGER NOT NULL CHECK(payload_ref_version=1),
  classification TEXT NOT NULL CHECK(classification='communication.contact.email'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,address_ref_id,address_version),
  UNIQUE(workspace_id,event_id,contact_ref_id,address_ref_id,address_version),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,contact_ref_id)
);

CREATE TABLE communication_current_channel_addresses (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  address_ref_id TEXT NOT NULL,
  address_version INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,event_id,contact_ref_id),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,contact_ref_id),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id,address_ref_id,address_version)
    REFERENCES communication_channel_address_versions(
      workspace_id,event_id,contact_ref_id,address_ref_id,address_version
    )
);

CREATE TABLE communication_current_address_policies (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purpose_revision_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  purpose_revision_json TEXT NOT NULL,
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('no_eligible_address','evaluated')),
  address_ref_id TEXT NULL,
  address_version INTEGER NULL,
  policy_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,purpose_revision_id,contact_ref_id),
  CHECK(
    (resolution_kind='no_eligible_address' AND address_ref_id IS NULL AND address_version IS NULL)
    OR
    (resolution_kind='evaluated' AND address_ref_id IS NOT NULL AND address_version IS NOT NULL)
  ),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id)
    REFERENCES communication_current_audience_contacts(workspace_id,event_id,contact_ref_id),
  FOREIGN KEY(workspace_id,event_id,contact_ref_id,address_ref_id,address_version)
    REFERENCES communication_channel_address_versions(
      workspace_id,event_id,contact_ref_id,address_ref_id,address_version
    )
);

CREATE TABLE communication_message_preview_snapshots (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  audience_spec_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  preview_generation INTEGER NOT NULL CHECK(preview_generation > 0),
  preview_digest_profile TEXT NOT NULL,
  preview_digest_version INTEGER NOT NULL CHECK(preview_digest_version > 0),
  preview_digest_sha256 TEXT NOT NULL CHECK(length(preview_digest_sha256)=64),
  guard_digest_sha256 TEXT NOT NULL CHECK(length(guard_digest_sha256)=64),
  summary_json TEXT NOT NULL,
  snapshot_payload_ref_id TEXT NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  snapshot_byte_size INTEGER NOT NULL CHECK(snapshot_byte_size > 0),
  snapshot_digest_sha256 TEXT NOT NULL CHECK(length(snapshot_digest_sha256)=64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,event_id,audience_spec_id),
  UNIQUE(workspace_id,event_id,draft_id,draft_version,preview_generation),
  UNIQUE(workspace_id,event_id,audience_spec_id,draft_id,draft_version,preview_generation,
    preview_digest_profile,preview_digest_version,preview_digest_sha256)
);
CREATE INDEX communication_message_preview_owner_exact
  ON communication_message_preview_snapshots(
    workspace_id,event_id,owner_key,draft_id,draft_version,preview_generation,audience_spec_id
  );

CREATE TRIGGER communication_registered_audience_recipes_immutable_update
BEFORE UPDATE ON communication_registered_audience_recipes
BEGIN SELECT RAISE(ABORT, 'registered audience recipes are immutable'); END;
CREATE TRIGGER communication_channel_address_versions_immutable_update
BEFORE UPDATE ON communication_channel_address_versions
BEGIN SELECT RAISE(ABORT, 'channel address versions are immutable'); END;
CREATE TRIGGER communication_message_preview_snapshots_immutable_update
BEFORE UPDATE ON communication_message_preview_snapshots
BEGIN SELECT RAISE(ABORT, 'message preview snapshots are immutable'); END;
CREATE TRIGGER communication_message_preview_snapshots_immutable_delete
BEFORE DELETE ON communication_message_preview_snapshots
BEGIN SELECT RAISE(ABORT, 'message preview snapshots are immutable'); END;

-- artifact: communication-email-provider-configuration
CREATE TABLE email_provider_connections (
  connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 240),
  adapter_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','verifying','active_outbound','draining','retired')),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_connection_revisions (
  revision_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  adapter_key TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
  manifest_digest_sha256 TEXT NOT NULL CHECK(length(manifest_digest_sha256) = 64),
  config_digest_sha256 TEXT NOT NULL CHECK(length(config_digest_sha256) = 64),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, revision_number),
  UNIQUE (connection_id, revision_id),
  FOREIGN KEY (connection_id) REFERENCES email_provider_connections(connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_connection_secret_refs (
  revision_id TEXT NOT NULL,
  requirement_key TEXT NOT NULL,
  secret_store_key TEXT NOT NULL,
  secret_reference TEXT NOT NULL,
  PRIMARY KEY (revision_id, requirement_key),
  FOREIGN KEY (revision_id) REFERENCES email_provider_connection_revisions(revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE email_sender_profiles (
  sender_profile_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','active','archived')),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, profile_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_sender_profile_revisions (
  revision_id TEXT PRIMARY KEY,
  sender_profile_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (sender_profile_id, revision_number),
  UNIQUE (sender_profile_id, revision_id),
  FOREIGN KEY (sender_profile_id) REFERENCES email_sender_profiles(sender_profile_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_routing_policies (
  routing_policy_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','active','archived')),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, policy_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_routing_policy_revisions (
  revision_id TEXT PRIMARY KEY,
  routing_policy_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (routing_policy_id, revision_number),
  UNIQUE (routing_policy_id, revision_id),
  FOREIGN KEY (routing_policy_id) REFERENCES email_routing_policies(routing_policy_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_readiness_checks (
  readiness_check_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  connection_revision_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability = 'transactional_outbound'),
  check_key TEXT NOT NULL,
  request_digest_sha256 TEXT NOT NULL CHECK(length(request_digest_sha256) = 64),
  expected_config_digest_sha256 TEXT NOT NULL CHECK(length(expected_config_digest_sha256) = 64),
  claimed_head_version INTEGER NOT NULL CHECK(claimed_head_version > 0),
  state TEXT NOT NULL CHECK(state IN ('checking','passed','failed')),
  projection_json TEXT NOT NULL CHECK(json_valid(projection_json) AND json_type(projection_json) = 'object'),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (connection_id, connection_revision_id)
    REFERENCES email_provider_connection_revisions(connection_id, revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_readiness_heads (
  connection_revision_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability = 'transactional_outbound'),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  latest_check_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_revision_id, capability),
  FOREIGN KEY (connection_revision_id) REFERENCES email_provider_connection_revisions(revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (latest_check_id) REFERENCES email_provider_readiness_checks(readiness_check_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX email_provider_connections_by_workspace
  ON email_provider_connections(workspace_id, lifecycle, connection_id);

CREATE TRIGGER email_provider_connection_revision_no_update
BEFORE UPDATE ON email_provider_connection_revisions
BEGIN SELECT RAISE(ABORT, 'email provider revisions are immutable'); END;
CREATE TRIGGER email_provider_connection_revision_no_delete
BEFORE DELETE ON email_provider_connection_revisions
BEGIN SELECT RAISE(ABORT, 'email provider revisions are immutable'); END;
CREATE TRIGGER email_provider_connection_secret_ref_no_update
BEFORE UPDATE ON email_provider_connection_secret_refs
BEGIN SELECT RAISE(ABORT, 'email provider secret references are immutable'); END;
CREATE TRIGGER email_provider_connection_secret_ref_no_delete
BEFORE DELETE ON email_provider_connection_secret_refs
BEGIN SELECT RAISE(ABORT, 'email provider secret references are immutable'); END;
CREATE TRIGGER email_provider_connection_head_guard
BEFORE UPDATE ON email_provider_connections
WHEN NEW.connection_id != OLD.connection_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.adapter_key != OLD.adapter_key OR NEW.created_at != OLD.created_at
  OR NEW.head_version != OLD.head_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email provider connection head transition is invalid'); END;
CREATE TRIGGER email_provider_connection_pointer_guard
BEFORE UPDATE OF current_revision_id ON email_provider_connections
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM email_provider_connection_revisions r
  WHERE r.connection_id = NEW.connection_id AND r.revision_id = NEW.current_revision_id
)
BEGIN SELECT RAISE(ABORT, 'email provider current pointer is invalid'); END;
CREATE TRIGGER email_provider_connection_no_delete
BEFORE DELETE ON email_provider_connections
BEGIN SELECT RAISE(ABORT, 'email provider connections cannot be deleted'); END;

CREATE TRIGGER email_sender_profile_revision_no_update BEFORE UPDATE ON email_sender_profile_revisions
BEGIN SELECT RAISE(ABORT, 'email sender revisions are immutable'); END;
CREATE TRIGGER email_sender_profile_revision_no_delete BEFORE DELETE ON email_sender_profile_revisions
BEGIN SELECT RAISE(ABORT, 'email sender revisions are immutable'); END;
CREATE TRIGGER email_sender_profile_head_guard BEFORE UPDATE ON email_sender_profiles
WHEN NEW.sender_profile_id != OLD.sender_profile_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.profile_key != OLD.profile_key OR NEW.created_at != OLD.created_at
  OR NEW.head_version != OLD.head_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email sender profile head transition is invalid'); END;
CREATE TRIGGER email_sender_profile_pointer_guard
BEFORE UPDATE OF current_revision_id ON email_sender_profiles
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM email_sender_profile_revisions r
  WHERE r.sender_profile_id = NEW.sender_profile_id AND r.revision_id = NEW.current_revision_id
)
BEGIN SELECT RAISE(ABORT, 'email sender current pointer is invalid'); END;
CREATE TRIGGER email_sender_profile_no_delete BEFORE DELETE ON email_sender_profiles
BEGIN SELECT RAISE(ABORT, 'email sender profiles cannot be deleted'); END;
CREATE TRIGGER email_routing_policy_revision_no_update BEFORE UPDATE ON email_routing_policy_revisions
BEGIN SELECT RAISE(ABORT, 'email routing revisions are immutable'); END;
CREATE TRIGGER email_routing_policy_revision_no_delete BEFORE DELETE ON email_routing_policy_revisions
BEGIN SELECT RAISE(ABORT, 'email routing revisions are immutable'); END;
CREATE TRIGGER email_routing_policy_head_guard BEFORE UPDATE ON email_routing_policies
WHEN NEW.routing_policy_id != OLD.routing_policy_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.policy_key != OLD.policy_key OR NEW.created_at != OLD.created_at
  OR NEW.head_version != OLD.head_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email routing policy head transition is invalid'); END;
CREATE TRIGGER email_routing_policy_pointer_guard
BEFORE UPDATE OF current_revision_id ON email_routing_policies
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM email_routing_policy_revisions r
  WHERE r.routing_policy_id = NEW.routing_policy_id AND r.revision_id = NEW.current_revision_id
)
BEGIN SELECT RAISE(ABORT, 'email routing current pointer is invalid'); END;
CREATE TRIGGER email_routing_policy_no_delete BEFORE DELETE ON email_routing_policies
BEGIN SELECT RAISE(ABORT, 'email routing policies cannot be deleted'); END;

CREATE TRIGGER email_provider_readiness_check_identity_guard
BEFORE UPDATE ON email_provider_readiness_checks
WHEN NEW.readiness_check_id != OLD.readiness_check_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.connection_revision_id != OLD.connection_revision_id
  OR NEW.capability != OLD.capability
  OR NEW.check_key != OLD.check_key
  OR NEW.request_digest_sha256 != OLD.request_digest_sha256
  OR NEW.expected_config_digest_sha256 != OLD.expected_config_digest_sha256
  OR NEW.claimed_head_version != OLD.claimed_head_version
  OR NEW.started_at != OLD.started_at
  OR OLD.state != 'checking' OR NEW.state = 'checking'
BEGIN SELECT RAISE(ABORT, 'email provider readiness transition is invalid'); END;
CREATE TRIGGER email_provider_readiness_check_no_delete BEFORE DELETE ON email_provider_readiness_checks
BEGIN SELECT RAISE(ABORT, 'email provider readiness checks cannot be deleted'); END;
CREATE TRIGGER email_provider_readiness_head_guard
BEFORE UPDATE ON email_provider_readiness_heads
WHEN NEW.connection_revision_id != OLD.connection_revision_id
  OR NEW.capability != OLD.capability
  OR NEW.head_version != OLD.head_version + 1
  OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email provider readiness head transition is invalid'); END;
CREATE TRIGGER email_provider_readiness_head_no_delete BEFORE DELETE ON email_provider_readiness_heads
BEGIN SELECT RAISE(ABORT, 'email provider readiness heads cannot be deleted'); END;

-- artifact: communication-workspace-sender-identity
CREATE TABLE workspace_mail_sender_identity (
  workspace_id TEXT PRIMARY KEY,
  head_version INTEGER NOT NULL CHECK(head_version > 1),
  display_name TEXT CHECK(
    display_name IS NULL
    OR (
      length(display_name) BETWEEN 1 AND 200
      AND display_name = trim(display_name)
      AND instr(display_name, char(10)) = 0
      AND instr(display_name, char(13)) = 0
      AND instr(display_name, char(0)) = 0
    )
  ),
  reply_to_address TEXT CHECK(
    reply_to_address IS NULL
    OR (
      length(reply_to_address) BETWEEN 3 AND 320
      AND reply_to_address = trim(reply_to_address)
      AND instr(reply_to_address, char(10)) = 0
      AND instr(reply_to_address, char(13)) = 0
      AND instr(reply_to_address, char(0)) = 0
      AND instr(reply_to_address, ',') = 0
      AND instr(reply_to_address, ';') = 0
      AND instr(reply_to_address, '<') = 0
      AND instr(reply_to_address, '>') = 0
    )
  ),
  updated_at TEXT NOT NULL,
  -- The acting principal, honestly typed: a browser edit names a workspace
  -- user; an agent edit on the app_model lane names its run and has no user.
  updated_by_actor_key TEXT NOT NULL CHECK(length(updated_by_actor_key) BETWEEN 1 AND 256),
  updated_by_user_id TEXT,
  CHECK((updated_by_user_id IS NOT NULL) = (updated_by_actor_key GLOB 'workspace_user:*')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_mail_sender_identity_version_advances_once
BEFORE UPDATE OF head_version ON workspace_mail_sender_identity
WHEN NEW.head_version != OLD.head_version + 1
BEGIN SELECT RAISE(ABORT, 'workspace sender identity version must advance once'); END;

CREATE TRIGGER workspace_mail_sender_identity_scope_immutable
BEFORE UPDATE OF workspace_id ON workspace_mail_sender_identity
BEGIN SELECT RAISE(ABORT, 'workspace sender identity scope is immutable'); END;

CREATE TRIGGER workspace_mail_sender_identity_no_delete
BEFORE DELETE ON workspace_mail_sender_identity
BEGIN SELECT RAISE(ABORT, 'workspace sender identity rows are retained'); END;

-- artifact: workspace-team-domain
CREATE TABLE workspace_team_heads (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  team_version INTEGER NOT NULL CHECK(team_version > 0),
  team_digest_sha256 TEXT NOT NULL CHECK(
    length(team_digest_sha256) = 64 AND team_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE(workspace_id, team_version, team_digest_sha256)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_invitation_recipients (
  reservation_id TEXT PRIMARY KEY REFERENCES access_reservations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload_ref_id TEXT NOT NULL UNIQUE REFERENCES classified_payload_records(payload_ref_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  lookup_binding TEXT NOT NULL CHECK(length(lookup_binding) = 64),
  recipient_hint TEXT NOT NULL CHECK(
    length(recipient_hint) = 22 AND recipient_hint GLOB 'recipient-[0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE(workspace_id, lookup_binding)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_invitation_release_intents (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES access_reservations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('awaiting_activation', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  cancelled_at_ms INTEGER CHECK(cancelled_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK((status = 'awaiting_activation' AND cancelled_at_ms IS NULL)
     OR (status = 'cancelled' AND cancelled_at_ms IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_session_revocation_intents (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL UNIQUE REFERENCES workspace_memberships(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status = 'awaiting_activation'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('invite_recorded', 'role_changed', 'access_revoked')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('member', 'invitation')),
  subject_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_team_head_scope_immutable
BEFORE UPDATE OF workspace_id ON workspace_team_heads
BEGIN SELECT RAISE(ABORT, 'workspace team scope is immutable'); END;
CREATE TRIGGER workspace_team_head_version_monotonic
BEFORE UPDATE ON workspace_team_heads
WHEN NEW.team_version != OLD.team_version + 1
BEGIN SELECT RAISE(ABORT, 'workspace team version must advance once'); END;

CREATE TRIGGER workspace_team_invitation_recipients_no_update
BEFORE UPDATE ON workspace_team_invitation_recipients
BEGIN SELECT RAISE(ABORT, 'workspace invitation recipient is immutable'); END;
CREATE TRIGGER workspace_team_invitation_recipients_no_delete
BEFORE DELETE ON workspace_team_invitation_recipients
BEGIN SELECT RAISE(ABORT, 'workspace invitation recipient is immutable'); END;
CREATE TRIGGER workspace_team_history_no_update
BEFORE UPDATE ON workspace_team_history
BEGIN SELECT RAISE(ABORT, 'workspace team history is immutable'); END;
CREATE TRIGGER workspace_team_history_no_delete
BEFORE DELETE ON workspace_team_history
BEGIN SELECT RAISE(ABORT, 'workspace team history is immutable'); END;

-- artifact: intake-domain
CREATE TABLE intake_form_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36 AND workspace_id = lower(workspace_id)),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36 AND event_id = lower(event_id)),
  catalog_version INTEGER NOT NULL CHECK(catalog_version >= 2),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL CHECK(length(form_id) = 36 AND form_id = lower(form_id)),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'open', 'closed')),
  current_published_version_id TEXT CHECK(
    current_published_version_id IS NULL
    OR (length(current_published_version_id) = 36 AND current_published_version_id = lower(current_published_version_id))
  ),
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, form_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES intake_form_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_versions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL CHECK(length(form_version_id) = 36 AND form_version_id = lower(form_version_id)),
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  source_definition_version INTEGER NOT NULL CHECK(source_definition_version > 0),
  version_json TEXT NOT NULL CHECK(json_valid(version_json) AND json_type(version_json) = 'object'),
  version_digest_sha256 TEXT NOT NULL CHECK(
    length(version_digest_sha256) = 64 AND version_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  published_by_user_id TEXT NOT NULL CHECK(length(published_by_user_id) = 36),
  published_at_ms INTEGER NOT NULL CHECK(published_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, form_version_id),
  UNIQUE (workspace_id, event_id, form_id, version_number),
  UNIQUE (workspace_id, event_id, form_id, form_version_id),
  FOREIGN KEY (workspace_id, event_id, form_id)
    REFERENCES intake_form_heads(workspace_id, event_id, form_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_program_reference_slots (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  slot_key TEXT NOT NULL CHECK(length(slot_key) BETWEEN 1 AND 300),
  slot_kind TEXT NOT NULL CHECK(slot_kind IN ('target', 'option_exposure', 'rule_condition')),
  field_id TEXT,
  rule_id TEXT,
  origin_item_id TEXT NOT NULL CHECK(length(origin_item_id) = 36 AND origin_item_id = lower(origin_item_id)),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('track', 'format')),
  item_id TEXT NOT NULL CHECK(length(item_id) = 36 AND item_id = lower(item_id)),
  slot_version INTEGER NOT NULL CHECK(slot_version > 0),
  PRIMARY KEY (workspace_id, event_id, slot_key),
  CHECK(
    (slot_kind = 'target' AND field_id IS NULL AND rule_id IS NULL)
    OR (slot_kind = 'option_exposure' AND field_id IS NOT NULL AND rule_id IS NULL)
    OR (slot_kind = 'rule_condition' AND field_id IS NOT NULL AND rule_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, event_id, form_id)
    REFERENCES intake_form_heads(workspace_id, event_id, form_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX intake_form_program_reference_slots_by_form
  ON intake_form_program_reference_slots(
    workspace_id, event_id, form_id, slot_kind, field_id, rule_id, slot_key
  );

CREATE TABLE intake_application_draft_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36 AND draft_id = lower(draft_id)),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  authority_partition_digest_sha256 TEXT NOT NULL CHECK(
    length(authority_partition_digest_sha256) = 64
    AND authority_partition_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  status TEXT NOT NULL CHECK(status IN ('in_progress', 'submitted')),
  submitted_submission_id TEXT,
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id),
  UNIQUE (draft_id),
  CHECK((status = 'in_progress' AND submitted_submission_id IS NULL)
     OR (status = 'submitted' AND submitted_submission_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, event_id, form_id, form_version_id)
    REFERENCES intake_form_versions(workspace_id, event_id, form_id, form_version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_application_draft_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36 AND revision_id = lower(revision_id)),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  request_digest_sha256 TEXT NOT NULL CHECK(
    length(request_digest_sha256) = 64 AND request_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256) = 64 AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  saved_at_ms INTEGER NOT NULL CHECK(saved_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, revision_id),
  UNIQUE (workspace_id, event_id, draft_id, revision_number),
  UNIQUE (workspace_id, event_id, draft_id, revision_id),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES intake_application_draft_heads(workspace_id, event_id, draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36 AND submission_id = lower(submission_id)),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  draft_id TEXT UNIQUE,
  submit_evidence_id TEXT NOT NULL UNIQUE,
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  submitted_at_ms INTEGER NOT NULL CHECK(submitted_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  UNIQUE (submission_id),
  CHECK(
    (draft_id IS NOT NULL AND json_extract(head_json, '$.source') = 'public_form')
    OR (draft_id IS NULL AND json_extract(head_json, '$.source') = 'direct_entry')
  ),
  FOREIGN KEY (workspace_id, event_id, form_id, form_version_id)
    REFERENCES intake_form_versions(workspace_id, event_id, form_id, form_version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES intake_application_draft_heads(workspace_id, event_id, draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_submit_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_direct_entry_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) = 36 AND evidence_id = lower(evidence_id)),
  entered_by_user_id TEXT NOT NULL CHECK(length(entered_by_user_id) = 36),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (entered_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_participant_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  participant_identity_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_consent_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id, field_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX intake_form_heads_list
  ON intake_form_heads(workspace_id, event_id, form_id);
CREATE INDEX intake_submission_heads_list
  ON intake_submission_heads(workspace_id, event_id, submission_id);

CREATE TRIGGER intake_form_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, form_id, created_by_user_id, created_at_ms
ON intake_form_heads BEGIN SELECT RAISE(ABORT, 'intake form identity is immutable'); END;
CREATE TRIGGER intake_form_heads_version_guard
BEFORE UPDATE ON intake_form_heads
WHEN NEW.head_version != OLD.head_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'intake form version is invalid'); END;
CREATE TRIGGER intake_form_versions_no_update BEFORE UPDATE ON intake_form_versions
BEGIN SELECT RAISE(ABORT, 'intake form versions are immutable'); END;
CREATE TRIGGER intake_form_versions_no_delete BEFORE DELETE ON intake_form_versions
BEGIN SELECT RAISE(ABORT, 'intake form versions are immutable'); END;
CREATE TRIGGER intake_application_draft_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, draft_id, form_id, form_version_id,
  authority_partition_digest_sha256, created_at_ms
ON intake_application_draft_heads
BEGIN SELECT RAISE(ABORT, 'intake application identity is immutable'); END;
CREATE TRIGGER intake_application_draft_heads_version_guard
BEFORE UPDATE ON intake_application_draft_heads
WHEN NEW.draft_version != OLD.draft_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'intake application version is invalid'); END;
CREATE TRIGGER intake_application_draft_revisions_no_update BEFORE UPDATE ON intake_application_draft_revisions
BEGIN SELECT RAISE(ABORT, 'intake application revisions are immutable'); END;
CREATE TRIGGER intake_application_draft_revisions_no_delete BEFORE DELETE ON intake_application_draft_revisions
BEGIN SELECT RAISE(ABORT, 'intake application revisions are immutable'); END;
CREATE TRIGGER intake_submission_heads_no_update BEFORE UPDATE ON intake_submission_heads
BEGIN SELECT RAISE(ABORT, 'intake submissions are immutable'); END;
CREATE TRIGGER intake_submission_heads_no_delete BEFORE DELETE ON intake_submission_heads
BEGIN SELECT RAISE(ABORT, 'intake submissions are immutable'); END;
CREATE TRIGGER intake_submission_submit_evidence_no_update BEFORE UPDATE ON intake_submission_submit_evidence
BEGIN SELECT RAISE(ABORT, 'intake submit evidence is immutable'); END;
CREATE TRIGGER intake_submission_submit_evidence_no_delete BEFORE DELETE ON intake_submission_submit_evidence
BEGIN SELECT RAISE(ABORT, 'intake submit evidence is immutable'); END;
CREATE TRIGGER intake_submission_direct_entry_evidence_no_update BEFORE UPDATE ON intake_submission_direct_entry_evidence
BEGIN SELECT RAISE(ABORT, 'intake direct entry evidence is immutable'); END;
CREATE TRIGGER intake_submission_direct_entry_evidence_no_delete BEFORE DELETE ON intake_submission_direct_entry_evidence
BEGIN SELECT RAISE(ABORT, 'intake direct entry evidence is immutable'); END;
CREATE TRIGGER intake_submission_participant_evidence_no_update BEFORE UPDATE ON intake_submission_participant_evidence
BEGIN SELECT RAISE(ABORT, 'intake participant evidence is immutable'); END;
CREATE TRIGGER intake_submission_participant_evidence_no_delete BEFORE DELETE ON intake_submission_participant_evidence
BEGIN SELECT RAISE(ABORT, 'intake participant evidence is immutable'); END;
CREATE TRIGGER intake_submission_consent_evidence_no_update BEFORE UPDATE ON intake_submission_consent_evidence
BEGIN SELECT RAISE(ABORT, 'intake consent evidence is immutable'); END;
CREATE TRIGGER intake_submission_consent_evidence_no_delete BEFORE DELETE ON intake_submission_consent_evidence
BEGIN SELECT RAISE(ABORT, 'intake consent evidence is immutable'); END;

-- artifact: release-domain
CREATE TABLE program_releases (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number > 0),
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('publish', 'rollback')),
  restored_from_release_id TEXT CHECK(
    restored_from_release_id IS NULL OR length(restored_from_release_id) = 36
  ),
  predecessor_release_id TEXT CHECK(
    predecessor_release_id IS NULL OR length(predecessor_release_id) = 36
  ),
  predecessor_digest_sha256 TEXT CHECK(
    predecessor_digest_sha256 IS NULL OR (
      length(predecessor_digest_sha256) = 64
      AND predecessor_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  released_by_user_id TEXT NOT NULL CHECK(length(released_by_user_id) = 36),
  released_at_ms INTEGER NOT NULL CHECK(released_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, number),
  UNIQUE (workspace_id, event_id, predecessor_release_id),
  CHECK((origin_kind = 'rollback') = (restored_from_release_id IS NOT NULL)),
  CHECK((number = 1) = (predecessor_release_id IS NULL)),
  CHECK((predecessor_release_id IS NULL) = (predecessor_digest_sha256 IS NULL)),
  CHECK(restored_from_release_id IS NULL OR restored_from_release_id <> id),
  CHECK(predecessor_release_id IS NULL OR predecessor_release_id <> id),
  CHECK(json_extract(release_json, '$.id') = id),
  CHECK(json_extract(release_json, '$.number') = number),
  CHECK(json_extract(release_json, '$.origin.kind') = origin_kind),
  CHECK(json_extract(release_json, '$.digestSha256') = digest_sha256),
  CHECK(json_extract(release_json, '$.releasedByUserId') = released_by_user_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, predecessor_release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, restored_from_release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX program_releases_chain
  ON program_releases(workspace_id, event_id, number);

CREATE TABLE program_release_names (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  release_id TEXT NOT NULL CHECK(length(release_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  display_name TEXT NOT NULL CHECK(
    length(display_name) BETWEEN 1 AND 300 AND display_name = trim(display_name)
  ),
  PRIMARY KEY (workspace_id, event_id, release_id, person_id),
  FOREIGN KEY (workspace_id, event_id, release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE style_set_releases (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number > 0),
  predecessor_release_id TEXT CHECK(
    predecessor_release_id IS NULL OR length(predecessor_release_id) = 36
  ),
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  released_by_user_id TEXT NOT NULL CHECK(length(released_by_user_id) = 36),
  released_at_ms INTEGER NOT NULL CHECK(released_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, number),
  CHECK((number = 1) = (predecessor_release_id IS NULL)),
  CHECK(json_extract(release_json, '$.id') = id),
  CHECK(json_extract(release_json, '$.number') = number),
  CHECK(json_extract(release_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, predecessor_release_id)
    REFERENCES style_set_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE surface_releases (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('schedule', 'speakers', 'apply')),
  number INTEGER NOT NULL CHECK(number > 0),
  predecessor_release_id TEXT CHECK(
    predecessor_release_id IS NULL OR length(predecessor_release_id) = 36
  ),
  style_set_release_id TEXT NOT NULL CHECK(length(style_set_release_id) = 36),
  form_id TEXT CHECK(form_id IS NULL OR length(form_id) = 36),
  form_version_id TEXT CHECK(form_version_id IS NULL OR length(form_version_id) = 36),
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  released_by_user_id TEXT NOT NULL CHECK(length(released_by_user_id) = 36),
  released_at_ms INTEGER NOT NULL CHECK(released_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, kind, number),
  CHECK((kind = 'apply') = (form_id IS NOT NULL)),
  CHECK((form_id IS NULL) = (form_version_id IS NULL)),
  CHECK(json_extract(release_json, '$.id') = id),
  CHECK(json_extract(release_json, '$.kind') = kind),
  CHECK(json_extract(release_json, '$.number') = number),
  CHECK(json_extract(release_json, '$.styleSetReleaseId') = style_set_release_id),
  CHECK(json_extract(release_json, '$.formRef.formVersionId') IS form_version_id),
  CHECK(json_extract(release_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, predecessor_release_id)
    REFERENCES surface_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, style_set_release_id)
    REFERENCES style_set_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE surface_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('schedule', 'speakers', 'apply')),
  active_release_id TEXT NOT NULL CHECK(length(active_release_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, kind),
  CHECK(json_extract(head_json, '$.kind') = kind),
  CHECK(json_extract(head_json, '$.activeReleaseId') = active_release_id),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(json_type(head_json, '$.allowedFrameOrigins') = 'array'),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, active_release_id)
    REFERENCES surface_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER program_releases_no_update
BEFORE UPDATE ON program_releases
BEGIN SELECT RAISE(ABORT, 'program releases are immutable'); END;
CREATE TRIGGER program_releases_no_delete
BEFORE DELETE ON program_releases
BEGIN SELECT RAISE(ABORT, 'program releases are immutable'); END;
CREATE TRIGGER program_release_names_no_update
BEFORE UPDATE ON program_release_names
BEGIN SELECT RAISE(ABORT, 'released names are immutable'); END;
CREATE TRIGGER program_release_names_no_delete
BEFORE DELETE ON program_release_names
BEGIN SELECT RAISE(ABORT, 'released names are immutable'); END;
CREATE TRIGGER program_release_names_authorized_only
BEFORE INSERT ON program_release_names
WHEN NOT EXISTS (
  SELECT 1
    FROM program_releases releases, json_each(releases.release_json, '$.nameDeclassifications') entry
   WHERE releases.workspace_id = NEW.workspace_id
     AND releases.event_id = NEW.event_id
     AND releases.id = NEW.release_id
     AND json_extract(entry.value, '$.personId') = NEW.person_id
     AND json_extract(entry.value, '$.displayName') = NEW.display_name
)
BEGIN SELECT RAISE(ABORT, 'released name copy is not authorized by its release'); END;
CREATE TRIGGER style_set_releases_no_update
BEFORE UPDATE ON style_set_releases
BEGIN SELECT RAISE(ABORT, 'style set releases are immutable'); END;
CREATE TRIGGER style_set_releases_no_delete
BEFORE DELETE ON style_set_releases
BEGIN SELECT RAISE(ABORT, 'style set releases are immutable'); END;
CREATE TRIGGER surface_releases_no_update
BEFORE UPDATE ON surface_releases
BEGIN SELECT RAISE(ABORT, 'surface releases are immutable'); END;
CREATE TRIGGER surface_releases_no_delete
BEFORE DELETE ON surface_releases
BEGIN SELECT RAISE(ABORT, 'surface releases are immutable'); END;
CREATE TRIGGER surface_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, kind ON surface_heads
BEGIN SELECT RAISE(ABORT, 'surface head identity is immutable'); END;
CREATE TRIGGER surface_heads_version_monotonic
BEFORE UPDATE ON surface_heads
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'surface head versions advance by one'); END;
CREATE TRIGGER surface_heads_no_delete
BEFORE DELETE ON surface_heads
BEGIN SELECT RAISE(ABORT, 'surface heads are never deleted'); END;

-- artifact: release-native-effect
CREATE TABLE release_review_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  action TEXT NOT NULL CHECK(action IN (
    'publish_schedule', 'program_rollback', 'style_set_publish',
    'surface_publish', 'surface_rollback', 'surface_allowlist'
  )),
  status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(
    length(head_revision_digest_sha256) = 64
    AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(
    published_by_user_id IS NULL OR length(published_by_user_id) = 36
  ),
  published_at_ms INTEGER CHECK(
    published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, id, head_revision_id, head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE release_review_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(
    json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id, id),
  UNIQUE (workspace_id, event_id, draft_id, id, digest_sha256),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES release_review_drafts(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER release_review_revisions_no_update
BEFORE UPDATE ON release_review_revisions
BEGIN SELECT RAISE(ABORT, 'release review revisions are immutable'); END;
CREATE TRIGGER release_review_revisions_no_delete
BEFORE DELETE ON release_review_revisions
BEGIN SELECT RAISE(ABORT, 'release review revisions are immutable'); END;
CREATE TRIGGER release_review_drafts_no_delete
BEFORE DELETE ON release_review_drafts
BEGIN SELECT RAISE(ABORT, 'release review drafts are retained'); END;

-- artifact: intake-form-write-effect
CREATE TABLE intake_form_version_review_drafts (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  action TEXT NOT NULL CHECK(action IN ('publish', 'publish_and_open')),
  status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
  head_revision_id TEXT NOT NULL CHECK(length(head_revision_id) = 36),
  head_revision_digest_sha256 TEXT NOT NULL CHECK(
    length(head_revision_digest_sha256) = 64
    AND head_revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  published_by_user_id TEXT CHECK(published_by_user_id IS NULL OR length(published_by_user_id) = 36),
  published_at_ms INTEGER CHECK(published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, id, head_revision_id, head_revision_digest_sha256),
  CHECK((status = 'published') = (published_by_user_id IS NOT NULL)),
  CHECK((published_by_user_id IS NULL) = (published_at_ms IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_version_review_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number = 1),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  review_json TEXT NOT NULL CHECK(json_valid(review_json) AND json_type(review_json) = 'object'),
  safe_diff_json TEXT NOT NULL CHECK(json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'),
  authored_by_user_id TEXT NOT NULL CHECK(length(authored_by_user_id) = 36),
  authored_at_ms INTEGER NOT NULL CHECK(authored_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id, id),
  UNIQUE (workspace_id, event_id, draft_id, id, digest_sha256),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES intake_form_version_review_drafts(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authored_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_form_version_review_revisions_no_update
BEFORE UPDATE ON intake_form_version_review_revisions
BEGIN SELECT RAISE(ABORT, 'Form version review revisions are immutable'); END;
CREATE TRIGGER intake_form_version_review_revisions_no_delete
BEFORE DELETE ON intake_form_version_review_revisions
BEGIN SELECT RAISE(ABORT, 'Form version review revisions are immutable'); END;
CREATE TRIGGER intake_form_version_review_drafts_no_delete
BEFORE DELETE ON intake_form_version_review_drafts
BEGIN SELECT RAISE(ABORT, 'Form version review drafts are retained'); END;

-- artifact: submission-triage-domain
CREATE TABLE submission_triage_event_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36 AND workspace_id = lower(workspace_id)),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36 AND event_id = lower(event_id)),
  query_version INTEGER NOT NULL CHECK(query_version > 0),
  query_digest_sha256 TEXT NOT NULL CHECK(
    length(query_digest_sha256) = 64 AND query_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE submission_arrival_facts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36 AND submission_id = lower(submission_id)),
  arrival_id TEXT NOT NULL CHECK(length(arrival_id) = 36 AND arrival_id = lower(arrival_id)),
  form_id TEXT NOT NULL CHECK(length(form_id) = 36 AND form_id = lower(form_id)),
  form_version_id TEXT NOT NULL CHECK(length(form_version_id) = 36 AND form_version_id = lower(form_version_id)),
  source TEXT NOT NULL CHECK(source IN ('public_form', 'direct_entry', 'import', 'email')),
  classification TEXT NOT NULL CHECK(classification IN ('on_time', 'late')),
  submitted_at_ms INTEGER NOT NULL CHECK(submitted_at_ms BETWEEN 0 AND 8640000000000000),
  recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms BETWEEN 0 AND 8640000000000000),
  fact_json TEXT NOT NULL CHECK(
    json_valid(fact_json) AND json_type(fact_json) = 'object'
    AND json_extract(fact_json, '$.submissionId') = submission_id
    AND json_extract(fact_json, '$.id') = arrival_id
    AND json_extract(fact_json, '$.classification') = classification
  ),
  fact_digest_sha256 TEXT NOT NULL CHECK(
    length(fact_digest_sha256) = 64 AND fact_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  UNIQUE (arrival_id),
  UNIQUE (workspace_id, event_id, submission_id, fact_digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES submission_triage_event_heads(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE submission_triage_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  state TEXT NOT NULL CHECK(state IN ('inbox', 'set_aside', 'discarded_recoverable')),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  head_json TEXT NOT NULL CHECK(
    json_valid(head_json) AND json_type(head_json) = 'object'
    AND json_extract(head_json, '$.submissionId') = submission_id
    AND json_extract(head_json, '$.version') = head_version
    AND json_extract(head_json, '$.state') = state
  ),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  UNIQUE (workspace_id, event_id, submission_id, head_version, head_digest_sha256),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES submission_arrival_facts(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX submission_triage_heads_by_state
  ON submission_triage_heads(workspace_id, event_id, state, submission_id);

CREATE TRIGGER submission_arrival_facts_no_update BEFORE UPDATE ON submission_arrival_facts
BEGIN SELECT RAISE(ABORT, 'submission arrival facts are immutable'); END;
CREATE TRIGGER submission_arrival_facts_no_delete BEFORE DELETE ON submission_arrival_facts
BEGIN SELECT RAISE(ABORT, 'submission arrival facts are immutable'); END;
CREATE TRIGGER submission_triage_event_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id ON submission_triage_event_heads
BEGIN SELECT RAISE(ABORT, 'submission triage event identity is immutable'); END;
CREATE TRIGGER submission_triage_event_heads_version_guard
BEFORE UPDATE ON submission_triage_event_heads
WHEN NEW.query_version != OLD.query_version + 1
BEGIN SELECT RAISE(ABORT, 'submission triage query version is invalid'); END;
CREATE TRIGGER submission_triage_event_heads_no_delete BEFORE DELETE ON submission_triage_event_heads
BEGIN SELECT RAISE(ABORT, 'submission triage event heads cannot be deleted'); END;
CREATE TRIGGER submission_triage_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, submission_id ON submission_triage_heads
BEGIN SELECT RAISE(ABORT, 'submission triage identity is immutable'); END;
CREATE TRIGGER submission_triage_heads_version_guard
BEFORE UPDATE ON submission_triage_heads
WHEN NEW.head_version != OLD.head_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'submission triage head version is invalid'); END;
CREATE TRIGGER submission_triage_heads_no_delete BEFORE DELETE ON submission_triage_heads
BEGIN SELECT RAISE(ABORT, 'submission triage heads cannot be deleted'); END;

-- artifact: field-registry-domain
CREATE TABLE field_registry_aggregates (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  registry_version INTEGER NOT NULL CHECK(registry_version > 0),
  state_json TEXT NOT NULL CHECK(
    json_valid(state_json)
    AND json_extract(state_json, '$.scope.workspaceId') = workspace_id
    AND json_extract(state_json, '$.scope.eventId') = event_id
    AND json_extract(state_json, '$.version') = registry_version
  ),
  state_digest_sha256 TEXT NOT NULL CHECK(
    length(state_digest_sha256) = 64
    AND state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  baseline_digest_sha256 TEXT NOT NULL CHECK(
    length(baseline_digest_sha256) = 64
    AND baseline_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (registry_version > 1 OR baseline_digest_sha256 = state_digest_sha256)
  ),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, event_id, registry_version, state_digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER field_registry_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON field_registry_aggregates
BEGIN SELECT RAISE(ABORT, 'field registry scope is immutable'); END;

CREATE TRIGGER field_registry_baseline_immutable
BEFORE UPDATE OF baseline_digest_sha256 ON field_registry_aggregates
BEGIN SELECT RAISE(ABORT, 'field registry baseline is immutable'); END;

CREATE TRIGGER field_registry_version_monotonic
BEFORE UPDATE ON field_registry_aggregates
WHEN NEW.registry_version != OLD.registry_version + 1
BEGIN SELECT RAISE(ABORT, 'field registry version must advance exactly once'); END;

-- artifact: read-audit
CREATE TABLE _trial_read_immutable_audits (
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  event_kind TEXT NOT NULL CHECK(event_kind = 'read_immutable_audit'),
  audit_target_key TEXT NOT NULL CHECK(length(audit_target_key) BETWEEN 1 AND 160),
  audit_target_version INTEGER NOT NULL CHECK(audit_target_version > 0),
  record_profile_key TEXT NOT NULL CHECK(length(record_profile_key) BETWEEN 1 AND 160),
  record_profile_version INTEGER NOT NULL CHECK(record_profile_version > 0),
  canonical_record_bytes BLOB NOT NULL CHECK(
    typeof(canonical_record_bytes) = 'blob'
    AND length(canonical_record_bytes) BETWEEN 2 AND 131072
    AND json_valid(CAST(canonical_record_bytes AS TEXT))
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.eventId') = event_id
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordKind') = event_kind
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.auditTarget.key') = audit_target_key
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.auditTarget.version') = audit_target_version
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordProfile.key') = record_profile_key
    AND json_extract(CAST(canonical_record_bytes AS TEXT), '$.recordProfile.version') = record_profile_version
  ),
  PRIMARY KEY (event_id, event_kind)
) WITHOUT ROWID;

CREATE TRIGGER _trial_read_immutable_audits_no_update
BEFORE UPDATE ON _trial_read_immutable_audits
BEGIN
  SELECT RAISE(ABORT, 'read immutable audit records are append-only');
END;

CREATE TRIGGER _trial_read_immutable_audits_no_delete
BEFORE DELETE ON _trial_read_immutable_audits
BEGIN
  SELECT RAISE(ABORT, 'read immutable audit records are append-only');
END;

-- artifact: reliability-fact-effect
CREATE TABLE _trial_reliability_aggregates (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  aggregate_kind TEXT NOT NULL CHECK(length(aggregate_kind) BETWEEN 1 AND 160),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 0),
  last_fact_sequence INTEGER NOT NULL CHECK(last_fact_sequence >= 0),
  PRIMARY KEY (workspace_id, event_id, aggregate_kind, aggregate_id)
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_operation_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) = 36),
  producer_kind TEXT NOT NULL CHECK(producer_kind = 'operation'),
  producer_key TEXT NOT NULL CHECK(length(producer_key) BETWEEN 1 AND 160),
  producer_version INTEGER NOT NULL CHECK(producer_version > 0),
  contribution_digest_sha256 TEXT NOT NULL CHECK(
    length(contribution_digest_sha256) = 64
    AND contribution_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  resulting_aggregate_version INTEGER NOT NULL CHECK(resulting_aggregate_version > 0),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0)
);

CREATE TABLE _trial_reliability_timeline (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) = 36),
  receipt_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json)),
  causation_json TEXT NOT NULL CHECK(json_valid(causation_json)),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'domain_fact', 'effect_specification', 'outbox_pointer'
  )),
  source_id TEXT NOT NULL CHECK(length(source_id) = 36),
  definition_kind TEXT NOT NULL CHECK(definition_kind IN (
    'domain_fact', 'effect', 'outbox_pointer'
  )),
  definition_key TEXT NOT NULL CHECK(length(definition_key) BETWEEN 1 AND 160),
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  definition_digest_sha256 TEXT,
  CHECK(
    (source_kind = 'outbox_pointer' AND definition_kind = 'outbox_pointer'
      AND definition_digest_sha256 IS NULL)
    OR
    (source_kind = 'domain_fact' AND definition_kind = 'domain_fact'
      AND length(definition_digest_sha256) = 64
      AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*')
    OR
    (source_kind = 'effect_specification' AND definition_kind = 'effect'
      AND length(definition_digest_sha256) = 64
      AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  UNIQUE (timeline_id, receipt_id, source_kind, source_id),
  UNIQUE (receipt_id, source_kind, source_id),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_domain_facts (
  fact_id TEXT PRIMARY KEY CHECK(length(fact_id) = 36),
  receipt_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL UNIQUE,
  timeline_source_kind TEXT NOT NULL DEFAULT 'domain_fact' CHECK(timeline_source_kind = 'domain_fact'),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  definition_key TEXT NOT NULL CHECK(length(definition_key) BETWEEN 1 AND 160),
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  definition_digest_sha256 TEXT NOT NULL CHECK(
    length(definition_digest_sha256) = 64
    AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  producer_kind TEXT NOT NULL CHECK(producer_kind = 'operation'),
  producer_key TEXT NOT NULL CHECK(length(producer_key) BETWEEN 1 AND 160),
  producer_version INTEGER NOT NULL CHECK(producer_version > 0),
  metadata_schema_key TEXT NOT NULL CHECK(length(metadata_schema_key) BETWEEN 1 AND 160),
  metadata_schema_version INTEGER NOT NULL CHECK(metadata_schema_version > 0),
  metadata_schema_digest_sha256 TEXT NOT NULL CHECK(length(metadata_schema_digest_sha256) = 64),
  aggregate_kind TEXT NOT NULL CHECK(length(aggregate_kind) BETWEEN 1 AND 160),
  aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) = 36),
  aggregate_sequence INTEGER NOT NULL CHECK(aggregate_sequence > 0),
  resulting_aggregate_version INTEGER NOT NULL CHECK(resulting_aggregate_version > 0),
  safe_references_json TEXT NOT NULL CHECK(json_valid(safe_references_json)),
  classified_payload_refs_json TEXT NOT NULL CHECK(json_valid(classified_payload_refs_json)),
  UNIQUE (
    workspace_id, event_id, aggregate_kind, aggregate_id, aggregate_sequence
  ),
  UNIQUE (
    workspace_id, event_id, aggregate_kind, aggregate_id, resulting_aggregate_version
  ),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (timeline_id, receipt_id, timeline_source_kind, fact_id)
    REFERENCES _trial_reliability_timeline(
      timeline_id, receipt_id, source_kind, source_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_effect_specifications (
  effect_specification_id TEXT PRIMARY KEY CHECK(length(effect_specification_id) = 36),
  receipt_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL UNIQUE,
  timeline_source_kind TEXT NOT NULL DEFAULT 'effect_specification'
    CHECK(timeline_source_kind = 'effect_specification'),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  definition_key TEXT NOT NULL CHECK(length(definition_key) BETWEEN 1 AND 160),
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  definition_digest_sha256 TEXT NOT NULL CHECK(length(definition_digest_sha256) = 64),
  producer_kind TEXT NOT NULL CHECK(producer_kind = 'operation'),
  producer_key TEXT NOT NULL CHECK(length(producer_key) BETWEEN 1 AND 160),
  producer_version INTEGER NOT NULL CHECK(producer_version > 0),
  specification_schema_key TEXT NOT NULL CHECK(length(specification_schema_key) BETWEEN 1 AND 160),
  specification_schema_version INTEGER NOT NULL CHECK(specification_schema_version > 0),
  specification_schema_digest_sha256 TEXT NOT NULL CHECK(length(specification_schema_digest_sha256) = 64),
  target_job_key TEXT NOT NULL CHECK(length(target_job_key) BETWEEN 1 AND 160),
  target_job_version INTEGER NOT NULL CHECK(target_job_version > 0),
  target_job_digest_sha256 TEXT NOT NULL CHECK(length(target_job_digest_sha256) = 64),
  target_operation_key TEXT NOT NULL CHECK(length(target_operation_key) BETWEEN 1 AND 160),
  target_operation_version INTEGER NOT NULL CHECK(target_operation_version > 0),
  target_capability_revision_id TEXT NOT NULL CHECK(length(target_capability_revision_id) = 36),
  effect_authority_definition_key TEXT NOT NULL CHECK(length(effect_authority_definition_key) BETWEEN 1 AND 160),
  effect_authority_definition_version INTEGER NOT NULL CHECK(effect_authority_definition_version > 0),
  effect_authority_citation_id TEXT NOT NULL CHECK(length(effect_authority_citation_id) = 36),
  job_authority_definition_key TEXT NOT NULL CHECK(length(job_authority_definition_key) BETWEEN 1 AND 160),
  job_authority_definition_version INTEGER NOT NULL CHECK(job_authority_definition_version > 0),
  safe_references_json TEXT NOT NULL CHECK(json_valid(safe_references_json)),
  classified_payload_refs_json TEXT NOT NULL CHECK(json_valid(classified_payload_refs_json)),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (timeline_id, receipt_id, timeline_source_kind, effect_specification_id)
    REFERENCES _trial_reliability_timeline(
      timeline_id, receipt_id, source_kind, source_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE _trial_reliability_outbox_pointers (
  pointer_id TEXT PRIMARY KEY CHECK(length(pointer_id) = 36),
  receipt_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL UNIQUE,
  timeline_source_kind TEXT NOT NULL DEFAULT 'outbox_pointer'
    CHECK(timeline_source_kind = 'outbox_pointer'),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('domain_fact', 'effect_specification')),
  source_id TEXT NOT NULL CHECK(length(source_id) = 36),
  target_job_key TEXT,
  target_job_version INTEGER,
  target_job_digest_sha256 TEXT,
  CHECK(
    (source_kind = 'domain_fact' AND target_job_key IS NULL
      AND target_job_version IS NULL AND target_job_digest_sha256 IS NULL)
    OR
    (source_kind = 'effect_specification'
      AND length(target_job_key) BETWEEN 1 AND 160
      AND target_job_version > 0
      AND length(target_job_digest_sha256) = 64)
  ),
  UNIQUE (receipt_id, source_kind, source_id),
  FOREIGN KEY (receipt_id)
    REFERENCES _trial_reliability_operation_receipts(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (timeline_id, receipt_id, timeline_source_kind, pointer_id)
    REFERENCES _trial_reliability_timeline(
      timeline_id, receipt_id, source_kind, source_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER _trial_reliability_aggregates_exact_advance
BEFORE UPDATE ON _trial_reliability_aggregates
WHEN NOT (
  NEW.workspace_id = OLD.workspace_id
  AND NEW.event_id = OLD.event_id
  AND NEW.aggregate_kind = OLD.aggregate_kind
  AND NEW.aggregate_id = OLD.aggregate_id
  AND NEW.version = OLD.version + 1
  AND NEW.last_fact_sequence = OLD.last_fact_sequence + 1
)
BEGIN
  SELECT RAISE(ABORT, 'trial aggregate requires one exact version and fact-sequence advance');
END;

CREATE TRIGGER _trial_reliability_aggregates_no_delete
BEFORE DELETE ON _trial_reliability_aggregates
BEGIN
  SELECT RAISE(ABORT, 'trial aggregates cannot be deleted');
END;

CREATE TRIGGER _trial_reliability_facts_require_exact_head_and_producer
BEFORE INSERT ON _trial_reliability_domain_facts
WHEN NOT EXISTS (
  SELECT 1 FROM _trial_reliability_aggregates
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND aggregate_kind = NEW.aggregate_kind AND aggregate_id = NEW.aggregate_id
     AND version = NEW.resulting_aggregate_version
     AND last_fact_sequence = NEW.aggregate_sequence
) OR NOT EXISTS (
  SELECT 1 FROM _trial_reliability_operation_receipts
   WHERE receipt_id = NEW.receipt_id
     AND producer_kind = NEW.producer_kind
     AND producer_key = NEW.producer_key
     AND producer_version = NEW.producer_version
     AND resulting_aggregate_version = NEW.resulting_aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'trial fact requires exact aggregate head, sequence, producer, and receipt');
END;

CREATE TRIGGER _trial_reliability_effects_require_exact_producer
BEFORE INSERT ON _trial_reliability_effect_specifications
WHEN NOT EXISTS (
  SELECT 1 FROM _trial_reliability_operation_receipts
   WHERE receipt_id = NEW.receipt_id
     AND producer_kind = NEW.producer_kind
     AND producer_key = NEW.producer_key
     AND producer_version = NEW.producer_version
)
BEGIN
  SELECT RAISE(ABORT, 'trial effect requires the exact receipt producer');
END;

CREATE TRIGGER _trial_reliability_pointers_require_fact
BEFORE INSERT ON _trial_reliability_outbox_pointers
WHEN NEW.source_kind = 'domain_fact' AND NOT EXISTS (
  SELECT 1 FROM _trial_reliability_domain_facts
   WHERE fact_id = NEW.source_id AND receipt_id = NEW.receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'trial fact pointer requires its exact committed fact');
END;

CREATE TRIGGER _trial_reliability_pointers_require_effect
BEFORE INSERT ON _trial_reliability_outbox_pointers
WHEN NEW.source_kind = 'effect_specification' AND NOT EXISTS (
  SELECT 1 FROM _trial_reliability_effect_specifications
   WHERE effect_specification_id = NEW.source_id
     AND receipt_id = NEW.receipt_id
     AND target_job_key = NEW.target_job_key
     AND target_job_version = NEW.target_job_version
     AND target_job_digest_sha256 = NEW.target_job_digest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'trial effect pointer requires its exact authorized effect target');
END;

CREATE TRIGGER _trial_reliability_receipts_no_update
BEFORE UPDATE ON _trial_reliability_operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'trial operation receipts are immutable');
END;
CREATE TRIGGER _trial_reliability_receipts_no_delete
BEFORE DELETE ON _trial_reliability_operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'trial operation receipts are immutable');
END;

CREATE TRIGGER _trial_reliability_timeline_no_update
BEFORE UPDATE ON _trial_reliability_timeline
BEGIN
  SELECT RAISE(ABORT, 'trial timeline rows are immutable');
END;
CREATE TRIGGER _trial_reliability_timeline_no_delete
BEFORE DELETE ON _trial_reliability_timeline
BEGIN
  SELECT RAISE(ABORT, 'trial timeline rows are immutable');
END;

CREATE TRIGGER _trial_reliability_facts_no_update
BEFORE UPDATE ON _trial_reliability_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'trial domain facts are immutable');
END;
CREATE TRIGGER _trial_reliability_facts_no_delete
BEFORE DELETE ON _trial_reliability_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'trial domain facts are immutable');
END;

CREATE TRIGGER _trial_reliability_effects_no_update
BEFORE UPDATE ON _trial_reliability_effect_specifications
BEGIN
  SELECT RAISE(ABORT, 'trial effect specifications are immutable');
END;
CREATE TRIGGER _trial_reliability_effects_no_delete
BEFORE DELETE ON _trial_reliability_effect_specifications
BEGIN
  SELECT RAISE(ABORT, 'trial effect specifications are immutable');
END;

CREATE TRIGGER _trial_reliability_pointers_no_update
BEFORE UPDATE ON _trial_reliability_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'trial outbox pointers are immutable');
END;
CREATE TRIGGER _trial_reliability_pointers_no_delete
BEFORE DELETE ON _trial_reliability_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'trial outbox pointers are immutable');
END;

-- artifact: reliability-consumer
CREATE TABLE reliability_domain_facts_trial (
      fact_id TEXT PRIMARY KEY,
      source_identity TEXT NOT NULL UNIQUE,
      definition_key TEXT NOT NULL,
      definition_version INTEGER NOT NULL CHECK (definition_version > 0),
      aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      UNIQUE (definition_key, definition_version, source_identity)
    ) STRICT;

    CREATE TABLE reliability_outbox_pointers_trial (
      pointer_key TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL UNIQUE,
      available_at_ms INTEGER NOT NULL,
      FOREIGN KEY (source_fact_id)
        REFERENCES reliability_domain_facts_trial(fact_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE reliability_consumer_deliveries_trial (
      delivery_id TEXT PRIMARY KEY,
      semantic_key TEXT NOT NULL UNIQUE,
      pointer_key TEXT NOT NULL,
      consumer_key TEXT NOT NULL,
      consumer_version INTEGER NOT NULL CHECK (consumer_version > 0),
      definition_digest_sha256 TEXT NOT NULL
        CHECK (length(definition_digest_sha256) = 64
          AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      target_operation_key TEXT NOT NULL,
      target_operation_version INTEGER NOT NULL CHECK (target_operation_version > 0),
      input_projection_key TEXT NOT NULL,
      input_projection_version INTEGER NOT NULL CHECK (input_projection_version > 0),
      capability_revision_id TEXT NOT NULL,
      authority_citation_key TEXT NOT NULL,
      authority_citation_version INTEGER NOT NULL CHECK (authority_citation_version > 0),
      maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts > 0),
      lease_duration_ms INTEGER NOT NULL CHECK (lease_duration_ms > 0),
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'leased', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled')),
      version INTEGER NOT NULL CHECK (version > 0),
      current_fence INTEGER CHECK (current_fence IS NULL OR current_fence > 0),
      lease_owner_key TEXT,
      lease_attempt_id TEXT,
      lease_expires_at_ms INTEGER,
      next_action_at_ms INTEGER,
      FOREIGN KEY (pointer_key)
        REFERENCES reliability_outbox_pointers_trial(pointer_key)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      UNIQUE (pointer_key, consumer_key, consumer_version),
      CHECK (
        (state = 'leased'
          AND current_fence IS NOT NULL
          AND lease_owner_key IS NOT NULL
          AND lease_attempt_id IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL
          AND next_action_at_ms IS NULL)
        OR
        (state <> 'leased'
          AND lease_owner_key IS NULL
          AND lease_attempt_id IS NULL
          AND lease_expires_at_ms IS NULL)
      ),
      CHECK (
        (state IN ('pending', 'retry_wait') AND next_action_at_ms IS NOT NULL)
        OR
        (state IN ('leased', 'succeeded', 'dead_lettered', 'cancelled')
          AND next_action_at_ms IS NULL)
      )
    ) STRICT;

    CREATE TABLE reliability_consumer_attempts_trial (
      delivery_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      fence INTEGER NOT NULL CHECK (fence > 0),
      owner_key TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms > started_at_ms),
      PRIMARY KEY (delivery_id, attempt_id),
      UNIQUE (attempt_id),
      UNIQUE (delivery_id, attempt_number),
      UNIQUE (delivery_id, fence),
      FOREIGN KEY (delivery_id)
        REFERENCES reliability_consumer_deliveries_trial(delivery_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE reliability_consumer_attempt_completions_trial (
      delivery_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      completion_state TEXT NOT NULL
        CHECK (completion_state IN ('succeeded', 'retry_scheduled', 'dead_lettered', 'cancelled', 'lost_fence')),
      completed_at_ms INTEGER NOT NULL,
      failure_code TEXT,
      failure_classification TEXT
        CHECK (failure_classification IS NULL OR failure_classification IN ('transient', 'permanent', 'ambiguous')),
      PRIMARY KEY (delivery_id, attempt_id),
      FOREIGN KEY (delivery_id, attempt_id)
        REFERENCES reliability_consumer_attempts_trial(delivery_id, attempt_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      CHECK (
        (completion_state IN ('retry_scheduled', 'dead_lettered')
          AND failure_code IS NOT NULL AND failure_classification IS NOT NULL)
        OR
        (completion_state IN ('succeeded', 'cancelled', 'lost_fence')
          AND failure_code IS NULL AND failure_classification IS NULL)
      )
    ) STRICT;

    CREATE TABLE reliability_projection_results_trial (
      delivery_id TEXT PRIMARY KEY,
      projection_key TEXT NOT NULL,
      projected_value INTEGER NOT NULL,
      applied_at_ms INTEGER NOT NULL,
      FOREIGN KEY (delivery_id)
        REFERENCES reliability_consumer_deliveries_trial(delivery_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE INDEX reliability_deliveries_due_trial
      ON reliability_consumer_deliveries_trial(state, next_action_at_ms, delivery_id);
    CREATE INDEX reliability_deliveries_pointer_trial
      ON reliability_consumer_deliveries_trial(pointer_key, consumer_key, consumer_version);
    CREATE INDEX reliability_attempts_delivery_trial
      ON reliability_consumer_attempts_trial(delivery_id, attempt_number);

-- artifact: reliability-consumer-immutability
CREATE TRIGGER reliability_domain_facts_trial_reject_update
    BEFORE UPDATE ON reliability_domain_facts_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_domain_facts_trial_immutable');
    END;

    CREATE TRIGGER reliability_domain_facts_trial_reject_delete
    BEFORE DELETE ON reliability_domain_facts_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_domain_facts_trial_immutable');
    END;
  

    CREATE TRIGGER reliability_outbox_pointers_trial_reject_update
    BEFORE UPDATE ON reliability_outbox_pointers_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_outbox_pointers_trial_immutable');
    END;

    CREATE TRIGGER reliability_outbox_pointers_trial_reject_delete
    BEFORE DELETE ON reliability_outbox_pointers_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_outbox_pointers_trial_immutable');
    END;
  

    CREATE TRIGGER reliability_consumer_attempts_trial_reject_update
    BEFORE UPDATE ON reliability_consumer_attempts_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_consumer_attempts_trial_immutable');
    END;

    CREATE TRIGGER reliability_consumer_attempts_trial_reject_delete
    BEFORE DELETE ON reliability_consumer_attempts_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_consumer_attempts_trial_immutable');
    END;
  

    CREATE TRIGGER reliability_consumer_attempt_completions_trial_reject_update
    BEFORE UPDATE ON reliability_consumer_attempt_completions_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_consumer_attempt_completions_trial_immutable');
    END;

    CREATE TRIGGER reliability_consumer_attempt_completions_trial_reject_delete
    BEFORE DELETE ON reliability_consumer_attempt_completions_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_consumer_attempt_completions_trial_immutable');
    END;
  

    CREATE TRIGGER reliability_projection_results_trial_reject_update
    BEFORE UPDATE ON reliability_projection_results_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_projection_results_trial_immutable');
    END;

    CREATE TRIGGER reliability_projection_results_trial_reject_delete
    BEFORE DELETE ON reliability_projection_results_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_projection_results_trial_immutable');
    END;

-- artifact: registered-consumer
CREATE TABLE registered_consumer_source_payloads_trial (
      pointer_key TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('domain_fact', 'effect', 'job')),
      source_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK(source_version > 0),
      source_identity TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
      payload_schema_key TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL CHECK(payload_schema_version > 0),
      payload_schema_digest_sha256 TEXT NOT NULL
        CHECK(length(payload_schema_digest_sha256) = 64
          AND payload_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      FOREIGN KEY (pointer_key) REFERENCES reliability_outbox_pointers_trial(pointer_key)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TRIGGER registered_consumer_source_payloads_trial_reject_update
    BEFORE UPDATE ON registered_consumer_source_payloads_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_consumer_source_payload_immutable');
    END;

    CREATE TRIGGER registered_consumer_source_payloads_trial_reject_delete
    BEFORE DELETE ON registered_consumer_source_payloads_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_consumer_source_payload_immutable');
    END;

-- artifact: reliability-job
CREATE TABLE reliability_jobs_trial (
      job_id TEXT PRIMARY KEY,
      definition_key TEXT NOT NULL,
      definition_version INTEGER NOT NULL CHECK(definition_version > 0),
      definition_digest_sha256 TEXT NOT NULL CHECK(length(definition_digest_sha256) = 64 AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      registered_idempotency_identity TEXT NOT NULL CHECK(length(registered_idempotency_identity) BETWEEN 1 AND 240),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('domain_fact', 'effect', 'job', 'inbox_receipt')),
      source_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK(source_version > 0),
      source_identity TEXT NOT NULL,
      source_aggregate_version INTEGER NOT NULL CHECK(source_aggregate_version > 0),
      input_ref_id TEXT NOT NULL,
      input_schema_key TEXT NOT NULL,
      input_schema_version INTEGER NOT NULL CHECK(input_schema_version > 0),
      input_schema_digest_sha256 TEXT NOT NULL CHECK(length(input_schema_digest_sha256) = 64 AND input_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      result_schema_key TEXT NOT NULL,
      result_schema_version INTEGER NOT NULL CHECK(result_schema_version > 0),
      result_schema_digest_sha256 TEXT NOT NULL CHECK(length(result_schema_digest_sha256) = 64 AND result_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      error_schema_key TEXT NOT NULL,
      error_schema_version INTEGER NOT NULL CHECK(error_schema_version > 0),
      error_schema_digest_sha256 TEXT NOT NULL CHECK(length(error_schema_digest_sha256) = 64 AND error_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      registered_source_key TEXT NOT NULL,
      registered_source_version INTEGER NOT NULL CHECK(registered_source_version > 0),
      scope_causation_key TEXT NOT NULL,
      scope_causation_version INTEGER NOT NULL CHECK(scope_causation_version > 0),
      input_projection_key TEXT NOT NULL,
      input_projection_version INTEGER NOT NULL CHECK(input_projection_version > 0),
      target_operation_key TEXT NOT NULL,
      target_operation_version INTEGER NOT NULL CHECK(target_operation_version > 0),
      capability_revision_id TEXT NOT NULL,
      authority_citation_key TEXT NOT NULL,
      authority_citation_version INTEGER NOT NULL CHECK(authority_citation_version > 0),
      authority_citation_id TEXT NOT NULL,
      backoff_key TEXT NOT NULL,
      backoff_version INTEGER NOT NULL CHECK(backoff_version > 0),
      cancellation_key TEXT NOT NULL,
      cancellation_version INTEGER NOT NULL CHECK(cancellation_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      disposition_policy_key TEXT NOT NULL,
      disposition_policy_version INTEGER NOT NULL CHECK(disposition_policy_version > 0),
      disposition_policy_digest_sha256 TEXT NOT NULL CHECK(length(disposition_policy_digest_sha256) = 64 AND disposition_policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      external_retry_policy TEXT NOT NULL CHECK(external_retry_policy IN ('forbidden', 'anchor_inspection_only')),
      maximum_attempts INTEGER NOT NULL CHECK(maximum_attempts > 0),
      lease_duration_ms INTEGER NOT NULL CHECK(lease_duration_ms > 0),
      timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
      state TEXT NOT NULL CHECK(state IN ('pending', 'leased', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled')),
      version INTEGER NOT NULL CHECK(version > 0),
      current_fence INTEGER CHECK(current_fence IS NULL OR current_fence > 0),
      lease_owner_key TEXT,
      lease_attempt_id TEXT,
      lease_expires_at_ms INTEGER,
      next_action_at_ms INTEGER,
      UNIQUE(definition_key, definition_version, registered_idempotency_identity),
      CHECK(
        (state = 'leased' AND current_fence IS NOT NULL AND lease_owner_key IS NOT NULL
          AND lease_attempt_id IS NOT NULL AND lease_expires_at_ms IS NOT NULL
          AND next_action_at_ms IS NULL)
        OR
        (state <> 'leased' AND lease_owner_key IS NULL AND lease_attempt_id IS NULL
          AND lease_expires_at_ms IS NULL)
      ),
      CHECK(
        (state IN ('pending', 'retry_wait') AND next_action_at_ms IS NOT NULL)
        OR
        (state IN ('leased', 'succeeded', 'dead_lettered', 'cancelled') AND next_action_at_ms IS NULL)
      )
    ) STRICT;

    CREATE TABLE reliability_job_attempts_trial (
      job_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
      fence INTEGER NOT NULL CHECK(fence > 0),
      owner_key TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL CHECK(lease_expires_at_ms > started_at_ms),
      definition_digest_sha256 TEXT NOT NULL CHECK(length(definition_digest_sha256) = 64 AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_projection_key TEXT NOT NULL,
      input_projection_version INTEGER NOT NULL CHECK(input_projection_version > 0),
      target_operation_key TEXT NOT NULL,
      target_operation_version INTEGER NOT NULL CHECK(target_operation_version > 0),
      capability_revision_id TEXT NOT NULL,
      authority_citation_key TEXT NOT NULL,
      authority_citation_version INTEGER NOT NULL CHECK(authority_citation_version > 0),
      PRIMARY KEY(job_id, invocation_id),
      UNIQUE(invocation_id),
      UNIQUE(job_id, attempt_number),
      UNIQUE(job_id, fence),
      FOREIGN KEY(job_id) REFERENCES reliability_jobs_trial(job_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE reliability_job_attempt_completions_trial (
      job_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      completion_state TEXT NOT NULL CHECK(completion_state IN ('succeeded', 'retry_scheduled', 'dead_lettered', 'cancelled', 'lost_fence')),
      completed_at_ms INTEGER NOT NULL,
      result_ref_id TEXT,
      receipt_id TEXT,
      failure_code TEXT,
      failure_classification TEXT CHECK(failure_classification IS NULL OR failure_classification IN ('transient', 'permanent', 'ambiguous')),
      PRIMARY KEY(job_id, invocation_id),
      FOREIGN KEY(job_id, invocation_id) REFERENCES reliability_job_attempts_trial(job_id, invocation_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      FOREIGN KEY(receipt_id) REFERENCES operation_log(id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      CHECK(
        (completion_state IN ('retry_scheduled', 'dead_lettered') AND failure_code IS NOT NULL AND failure_classification IS NOT NULL)
        OR
        (completion_state IN ('succeeded', 'cancelled', 'lost_fence') AND failure_code IS NULL AND failure_classification IS NULL)
      ),
      CHECK(completion_state <> 'retry_scheduled' OR receipt_id IS NULL),
      CHECK(completion_state = 'succeeded' OR result_ref_id IS NULL)
    ) STRICT;

    CREATE TABLE reliability_job_dispositions_trial (
      job_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      policy_digest_sha256 TEXT NOT NULL CHECK(length(policy_digest_sha256) = 64 AND policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      cause TEXT NOT NULL CHECK(cause IN ('operation_nonterminal', 'known_pre_submission_failure', 'ambiguous_failure', 'lease_expired', 'timeout')),
      disposition TEXT NOT NULL CHECK(disposition IN ('safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention')),
      reason_code TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      next_action_at_ms INTEGER,
      PRIMARY KEY(job_id, invocation_id),
      FOREIGN KEY(job_id, invocation_id) REFERENCES reliability_job_attempt_completions_trial(job_id, invocation_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      CHECK((disposition = 'safe_retry' AND next_action_at_ms IS NOT NULL)
        OR (disposition <> 'safe_retry' AND next_action_at_ms IS NULL))
    ) STRICT;

    CREATE INDEX reliability_jobs_due_trial
      ON reliability_jobs_trial(state, next_action_at_ms, job_id);
    CREATE INDEX reliability_job_attempts_by_job_trial
      ON reliability_job_attempts_trial(job_id, attempt_number);

    CREATE TRIGGER reliability_jobs_trial_reject_delete
    BEFORE DELETE ON reliability_jobs_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_jobs_trial_history_required');
    END;

    CREATE TRIGGER reliability_jobs_trial_reject_binding_update
    BEFORE UPDATE ON reliability_jobs_trial
    WHEN OLD.job_id IS NOT NEW.job_id
      OR OLD.definition_key IS NOT NEW.definition_key
      OR OLD.definition_version IS NOT NEW.definition_version
      OR OLD.definition_digest_sha256 IS NOT NEW.definition_digest_sha256
      OR OLD.registered_idempotency_identity IS NOT NEW.registered_idempotency_identity
      OR OLD.source_kind IS NOT NEW.source_kind
      OR OLD.source_key IS NOT NEW.source_key
      OR OLD.source_version IS NOT NEW.source_version
      OR OLD.source_identity IS NOT NEW.source_identity
      OR OLD.source_aggregate_version IS NOT NEW.source_aggregate_version
      OR OLD.input_ref_id IS NOT NEW.input_ref_id
      OR OLD.input_schema_key IS NOT NEW.input_schema_key
      OR OLD.input_schema_version IS NOT NEW.input_schema_version
      OR OLD.input_schema_digest_sha256 IS NOT NEW.input_schema_digest_sha256
      OR OLD.result_schema_key IS NOT NEW.result_schema_key
      OR OLD.result_schema_version IS NOT NEW.result_schema_version
      OR OLD.result_schema_digest_sha256 IS NOT NEW.result_schema_digest_sha256
      OR OLD.error_schema_key IS NOT NEW.error_schema_key
      OR OLD.error_schema_version IS NOT NEW.error_schema_version
      OR OLD.error_schema_digest_sha256 IS NOT NEW.error_schema_digest_sha256
      OR OLD.registered_source_key IS NOT NEW.registered_source_key
      OR OLD.registered_source_version IS NOT NEW.registered_source_version
      OR OLD.scope_causation_key IS NOT NEW.scope_causation_key
      OR OLD.scope_causation_version IS NOT NEW.scope_causation_version
      OR OLD.input_projection_key IS NOT NEW.input_projection_key
      OR OLD.input_projection_version IS NOT NEW.input_projection_version
      OR OLD.target_operation_key IS NOT NEW.target_operation_key
      OR OLD.target_operation_version IS NOT NEW.target_operation_version
      OR OLD.capability_revision_id IS NOT NEW.capability_revision_id
      OR OLD.authority_citation_key IS NOT NEW.authority_citation_key
      OR OLD.authority_citation_version IS NOT NEW.authority_citation_version
      OR OLD.authority_citation_id IS NOT NEW.authority_citation_id
      OR OLD.backoff_key IS NOT NEW.backoff_key
      OR OLD.backoff_version IS NOT NEW.backoff_version
      OR OLD.cancellation_key IS NOT NEW.cancellation_key
      OR OLD.cancellation_version IS NOT NEW.cancellation_version
      OR OLD.workspace_id IS NOT NEW.workspace_id
      OR OLD.event_id IS NOT NEW.event_id
      OR OLD.disposition_policy_key IS NOT NEW.disposition_policy_key
      OR OLD.disposition_policy_version IS NOT NEW.disposition_policy_version
      OR OLD.disposition_policy_digest_sha256 IS NOT NEW.disposition_policy_digest_sha256
      OR OLD.external_retry_policy IS NOT NEW.external_retry_policy
      OR OLD.maximum_attempts IS NOT NEW.maximum_attempts
      OR OLD.lease_duration_ms IS NOT NEW.lease_duration_ms
      OR OLD.timeout_ms IS NOT NEW.timeout_ms
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_binding_immutable');
    END;

-- artifact: reliability-job-immutability
CREATE TRIGGER reliability_job_attempts_trial_reject_update
    BEFORE UPDATE ON reliability_job_attempts_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_attempts_trial_immutable');
    END;

    CREATE TRIGGER reliability_job_attempts_trial_reject_delete
    BEFORE DELETE ON reliability_job_attempts_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_attempts_trial_immutable');
    END;
  

    CREATE TRIGGER reliability_job_attempt_completions_trial_reject_update
    BEFORE UPDATE ON reliability_job_attempt_completions_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_attempt_completions_trial_immutable');
    END;

    CREATE TRIGGER reliability_job_attempt_completions_trial_reject_delete
    BEFORE DELETE ON reliability_job_attempt_completions_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_attempt_completions_trial_immutable');
    END;
  

    CREATE TRIGGER reliability_job_dispositions_trial_reject_update
    BEFORE UPDATE ON reliability_job_dispositions_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_dispositions_trial_immutable');
    END;

    CREATE TRIGGER reliability_job_dispositions_trial_reject_delete
    BEFORE DELETE ON reliability_job_dispositions_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_dispositions_trial_immutable');
    END;

-- artifact: registered-job
CREATE TABLE registered_job_inputs_trial (
      payload_ref_id TEXT PRIMARY KEY,
      job_key TEXT NOT NULL,
      job_version INTEGER NOT NULL CHECK(job_version > 0),
      schema_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      schema_digest_sha256 TEXT NOT NULL
        CHECK(length(schema_digest_sha256) = 64
          AND schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_json TEXT NOT NULL CHECK(json_valid(input_json))
    ) STRICT;

    CREATE TRIGGER registered_job_inputs_trial_reject_update
    BEFORE UPDATE ON registered_job_inputs_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_job_input_immutable');
    END;

    CREATE TRIGGER registered_job_inputs_trial_reject_delete
    BEFORE DELETE ON registered_job_inputs_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_job_input_immutable');
    END;

-- artifact: model-durability
CREATE TABLE model_profile_revisions_trial (
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  adapter_key TEXT NOT NULL CHECK(length(adapter_key) BETWEEN 1 AND 160),
  adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
  default_execution_mode TEXT NOT NULL CHECK(default_execution_mode IN ('batch', 'fast')),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  PRIMARY KEY (profile_key, revision_version),
  UNIQUE (profile_key, revision_version, digest)
) WITHOUT ROWID;

CREATE TRIGGER model_profile_revisions_immutable_update_trial
BEFORE UPDATE ON model_profile_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model profile revisions are immutable');
END;

CREATE TRIGGER model_profile_revisions_immutable_delete_trial
BEFORE DELETE ON model_profile_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model profile revisions are immutable');
END;

CREATE TABLE model_profile_current_trial (
  profile_key TEXT PRIMARY KEY,
  pointer_version INTEGER NOT NULL CHECK(pointer_version > 0),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64 AND revision_digest NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (profile_key, revision_version, revision_digest)
    REFERENCES model_profile_revisions_trial(profile_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE model_scaffold_revisions_trial (
  scaffold_key TEXT NOT NULL CHECK(length(scaffold_key) BETWEEN 1 AND 160),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 160),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  PRIMARY KEY (scaffold_key, revision_version),
  UNIQUE (scaffold_key, revision_version, digest)
) WITHOUT ROWID;

CREATE TRIGGER model_scaffold_revisions_immutable_update_trial
BEFORE UPDATE ON model_scaffold_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model scaffold revisions are immutable');
END;

CREATE TRIGGER model_scaffold_revisions_immutable_delete_trial
BEFORE DELETE ON model_scaffold_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model scaffold revisions are immutable');
END;

CREATE TABLE model_scaffold_current_trial (
  scaffold_key TEXT PRIMARY KEY,
  pointer_version INTEGER NOT NULL CHECK(pointer_version > 0),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64 AND revision_digest NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (scaffold_key, revision_version, revision_digest)
    REFERENCES model_scaffold_revisions_trial(scaffold_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE model_binding_profiles_trial (
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  key_verification_digest TEXT NOT NULL
    CHECK(length(key_verification_digest) = 64 AND key_verification_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (profile_key, profile_version)
) WITHOUT ROWID;

CREATE TRIGGER model_binding_profiles_immutable_update_trial
BEFORE UPDATE ON model_binding_profiles_trial
BEGIN
  SELECT RAISE(ABORT, 'model binding profiles are immutable');
END;

CREATE TRIGGER model_binding_profiles_immutable_delete_trial
BEFORE DELETE ON model_binding_profiles_trial
BEGIN
  SELECT RAISE(ABORT, 'model binding profiles are immutable');
END;

CREATE TABLE model_runs_trial (
  run_id TEXT PRIMARY KEY CHECK(length(run_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN (
    'queued', 'running', 'waiting_for_tool', 'reconciling', 'cancel_requested',
    'attention', 'succeeded', 'failed', 'cancelled', 'exhausted'
  )),
  profile_key TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  profile_digest TEXT NOT NULL CHECK(length(profile_digest) = 64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
  profile_adapter_key TEXT NOT NULL CHECK(length(profile_adapter_key) BETWEEN 1 AND 160),
  profile_adapter_version INTEGER NOT NULL CHECK(profile_adapter_version > 0),
  scaffold_key TEXT NOT NULL,
  scaffold_version INTEGER NOT NULL CHECK(scaffold_version > 0),
  scaffold_digest TEXT NOT NULL CHECK(length(scaffold_digest) = 64 AND scaffold_digest NOT GLOB '*[^0-9a-f]*'),
  active_attempt_id TEXT,
  active_attempt_fence INTEGER CHECK(active_attempt_fence IS NULL OR active_attempt_fence > 0),
  result_payload_ref_id TEXT CHECK(result_payload_ref_id IS NULL OR length(result_payload_ref_id) = 36),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  CHECK((active_attempt_id IS NULL) = (active_attempt_fence IS NULL)),
  FOREIGN KEY (profile_key, profile_version, profile_digest)
    REFERENCES model_profile_revisions_trial(profile_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (scaffold_key, scaffold_version, scaffold_digest)
    REFERENCES model_scaffold_revisions_trial(scaffold_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE model_attempts_trial (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) = 36),
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  fence INTEGER NOT NULL CHECK(fence > 0),
  request_binding TEXT NOT NULL CHECK(
    length(request_binding) = 69 AND substr(request_binding, 1, 5) = 'mrb1_'
    AND substr(request_binding, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  request_binding_profile_key TEXT NOT NULL,
  request_binding_profile_version INTEGER NOT NULL CHECK(request_binding_profile_version > 0),
  normalized_request_payload_ref_id TEXT NOT NULL CHECK(length(normalized_request_payload_ref_id) = 36),
  request_binding_attempt_id TEXT NOT NULL CHECK(length(request_binding_attempt_id) = 36),
  adapter_key TEXT NOT NULL CHECK(length(adapter_key) BETWEEN 1 AND 160),
  adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('batch', 'fast')),
  state TEXT NOT NULL CHECK(state IN (
    'started', 'succeeded', 'tool_requests', 'schema_invalid',
    'known_failure', 'acceptance_unknown', 'cancelled'
  )),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE (run_id, attempt_number),
  UNIQUE (run_id, fence),
  FOREIGN KEY (run_id) REFERENCES model_runs_trial(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (request_binding_profile_key, request_binding_profile_version)
    REFERENCES model_binding_profiles_trial(profile_key, profile_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE model_tool_calls_trial (
  tool_call_id TEXT PRIMARY KEY CHECK(length(tool_call_id) = 36),
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  provider_call_id TEXT NOT NULL CHECK(length(provider_call_id) BETWEEN 1 AND 300),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 200),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  input_payload_ref_id TEXT NOT NULL CHECK(length(input_payload_ref_id) = 36),
  input_binding TEXT NOT NULL CHECK(
    length(input_binding) = 69 AND substr(input_binding, 1, 5) = 'mtb1_'
    AND substr(input_binding, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  input_binding_profile_key TEXT NOT NULL,
  input_binding_profile_version INTEGER NOT NULL CHECK(input_binding_profile_version > 0),
  operation_receipt_id TEXT,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE (attempt_id, sequence),
  UNIQUE (attempt_id, provider_call_id),
  FOREIGN KEY (run_id) REFERENCES model_runs_trial(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES model_attempts_trial(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (input_binding_profile_key, input_binding_profile_version)
    REFERENCES model_binding_profiles_trial(profile_key, profile_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE model_attempt_payload_adoptions_trial (
  payload_ref_id TEXT PRIMARY KEY CHECK(length(payload_ref_id) = 36),
  run_id TEXT NOT NULL CHECK(length(run_id) = 36),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) = 36),
  attempt_fence INTEGER NOT NULL CHECK(attempt_fence > 0),
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('model_result', 'model_tool_input')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  model_tool_call_id TEXT,
  provider_call_id TEXT,
  operation_name TEXT,
  operation_version INTEGER CHECK(operation_version IS NULL OR operation_version > 0),
  stage_id TEXT NOT NULL CHECK(length(stage_id) = 36),
  stage_expected_version INTEGER NOT NULL CHECK(stage_expected_version > 0),
  stage_fence INTEGER NOT NULL CHECK(stage_fence > 0),
  stage_expires_at_ms INTEGER NOT NULL,
  reconciliation_policy_key TEXT NOT NULL,
  reconciliation_policy_version INTEGER NOT NULL CHECK(reconciliation_policy_version > 0),
  authentication_profile_key TEXT NOT NULL,
  authentication_profile_version INTEGER NOT NULL CHECK(authentication_profile_version > 0),
  authentication_tag TEXT NOT NULL CHECK(length(authentication_tag) = 64 AND authentication_tag NOT GLOB '*[^0-9a-f]*'),
  classification_profile_key TEXT NOT NULL,
  classification_profile_version INTEGER NOT NULL CHECK(classification_profile_version > 0),
  schema_profile_key TEXT NOT NULL,
  schema_profile_version INTEGER NOT NULL CHECK(schema_profile_version > 0),
  content_profile_key TEXT NOT NULL,
  content_profile_version INTEGER NOT NULL CHECK(content_profile_version > 0),
  integrity_profile_key TEXT NOT NULL,
  integrity_profile_version INTEGER NOT NULL CHECK(integrity_profile_version > 0),
  descriptor_auth_profile_key TEXT NOT NULL,
  descriptor_auth_profile_version INTEGER NOT NULL CHECK(descriptor_auth_profile_version > 0),
  scope_binding TEXT NOT NULL CHECK(length(scope_binding) BETWEEN 1 AND 256),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 255),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  integrity_digest TEXT NOT NULL CHECK(length(integrity_digest) = 64 AND integrity_digest NOT GLOB '*[^0-9a-f]*'),
  reduction_committed INTEGER NOT NULL DEFAULT 0 CHECK(reduction_committed IN (0, 1)),
  marked_adopted INTEGER NOT NULL DEFAULT 0 CHECK(marked_adopted IN (0, 1)),
  UNIQUE (run_id, attempt_id, attempt_fence, owner_kind, ordinal),
  UNIQUE (stage_id),
  CHECK(
    (owner_kind = 'model_result' AND ordinal = 0 AND model_tool_call_id IS NULL
      AND provider_call_id IS NULL AND operation_name IS NULL AND operation_version IS NULL)
    OR
    (owner_kind = 'model_tool_input' AND ordinal > 0 AND model_tool_call_id IS NOT NULL
      AND provider_call_id IS NOT NULL AND operation_name IS NOT NULL AND operation_version IS NOT NULL)
  ),
  CHECK(marked_adopted <= reduction_committed),
  FOREIGN KEY (run_id) REFERENCES model_runs_trial(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES model_attempts_trial(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER model_attempt_payload_adoptions_identity_immutable_trial
BEFORE UPDATE ON model_attempt_payload_adoptions_trial
WHEN NEW.payload_ref_id != OLD.payload_ref_id
  OR NEW.run_id != OLD.run_id
  OR NEW.attempt_id != OLD.attempt_id
  OR NEW.attempt_fence != OLD.attempt_fence
  OR NEW.owner_kind != OLD.owner_kind
  OR NEW.ordinal != OLD.ordinal
  OR NEW.stage_id != OLD.stage_id
  OR NEW.scope_binding != OLD.scope_binding
  OR NEW.integrity_digest != OLD.integrity_digest
BEGIN
  SELECT RAISE(ABORT, 'model payload adoption identity is immutable');
END;

CREATE TABLE deterministic_fake_attempts_trial (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) = 36),
  request_binding TEXT NOT NULL CHECK(
    length(request_binding) = 69 AND substr(request_binding, 1, 5) = 'mrb1_'
    AND substr(request_binding, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN (
    'succeeded', 'tool_requests', 'schema_invalid', 'known_failure',
    'acceptance_unknown', 'cancelled'
  )),
  cancelled INTEGER NOT NULL CHECK(cancelled IN (0, 1)),
  output_payload_ref_id TEXT CHECK(output_payload_ref_id IS NULL OR length(output_payload_ref_id) = 36),
  safe_code TEXT,
  retryability TEXT CHECK(retryability IS NULL OR retryability IN ('never', 'policy')),
  recovery TEXT CHECK(recovery IS NULL OR recovery IN ('lookup', 'idempotent_reuse', 'manual')),
  usage_present INTEGER NOT NULL CHECK(usage_present IN (0, 1)),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR (
    typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 9007199254740991
  )),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR (
    typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 9007199254740991
  )),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR (
    typeof(cached_input_tokens) = 'integer' AND cached_input_tokens BETWEEN 0 AND 9007199254740991
  )),
  cost_micros INTEGER CHECK(cost_micros IS NULL OR (
    typeof(cost_micros) = 'integer' AND cost_micros BETWEEN 0 AND 9007199254740991
  )),
  adapter_key TEXT,
  adapter_version INTEGER CHECK(adapter_version IS NULL OR adapter_version > 0),
  provider_request_id TEXT,
  idempotency_supported INTEGER CHECK(idempotency_supported IS NULL OR idempotency_supported IN (0, 1)),
  execution_mode TEXT CHECK(execution_mode IS NULL OR execution_mode IN ('batch', 'fast')),
  resolved_controls_json TEXT CHECK(resolved_controls_json IS NULL OR json_valid(resolved_controls_json)),
  CHECK((adapter_key IS NULL) = (adapter_version IS NULL)),
  CHECK((adapter_key IS NULL) = (idempotency_supported IS NULL))
) WITHOUT ROWID;

CREATE TABLE deterministic_fake_tool_requests_trial (
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  provider_call_id TEXT NOT NULL CHECK(length(provider_call_id) BETWEEN 1 AND 300),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 200),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  input_payload_ref_id TEXT NOT NULL CHECK(length(input_payload_ref_id) = 36),
  PRIMARY KEY (attempt_id, sequence),
  UNIQUE (attempt_id, provider_call_id),
  FOREIGN KEY (attempt_id) REFERENCES deterministic_fake_attempts_trial(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

-- artifact: verified-inbox
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

-- artifact: verified-inbox-processing
CREATE TABLE verified_inbox_processing_heads_trial (
      processing_ref TEXT NOT NULL UNIQUE CHECK(
        length(processing_ref) = 49 AND substr(processing_ref, 1, 6) = 'vipr1_'
      ),
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) = 36),
      processing_pointer_id TEXT NOT NULL UNIQUE CHECK(length(processing_pointer_id) = 36),
      enqueue_identity TEXT NOT NULL UNIQUE CHECK(
        length(enqueue_identity) = 49 AND substr(enqueue_identity, 1, 6) = 'vije1_'
      ),
      processor_key TEXT NOT NULL,
      processor_version INTEGER NOT NULL CHECK(processor_version > 0),
      processor_digest_sha256 TEXT NOT NULL CHECK(
        length(processor_digest_sha256) = 64
        AND processor_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      job_id TEXT NOT NULL UNIQUE CHECK(length(job_id) = 36),
      dependency_policy_key TEXT NOT NULL,
      dependency_policy_version INTEGER NOT NULL CHECK(dependency_policy_version > 0),
      dependency_policy_digest_sha256 TEXT NOT NULL CHECK(
        length(dependency_policy_digest_sha256) = 64
        AND dependency_policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      dependency_maximum_attempts INTEGER NOT NULL CHECK(dependency_maximum_attempts > 0),
      dependency_maximum_elapsed_ms INTEGER NOT NULL CHECK(dependency_maximum_elapsed_ms > 0),
      dependency_retry_delay_ms INTEGER NOT NULL CHECK(dependency_retry_delay_ms > 0),
      dependency_exhaustion TEXT NOT NULL CHECK(dependency_exhaustion IN ('attention', 'block')),
      enqueued_at_ms INTEGER NOT NULL,
      dependency_deadline_at_ms INTEGER NOT NULL CHECK(dependency_deadline_at_ms > enqueued_at_ms),
      state TEXT NOT NULL CHECK(state IN ('queued', 'succeeded', 'attention', 'blocked')),
      version INTEGER NOT NULL CHECK(version > 0),
      terminal_receipt_id TEXT,
      resolved_at_ms INTEGER,
      FOREIGN KEY (receipt_id) REFERENCES verified_inbox_receipt_processing_contracts_trial(receipt_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (processing_pointer_id) REFERENCES verified_inbox_processing_pointers_trial(processing_pointer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (job_id) REFERENCES reliability_jobs_trial(job_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (terminal_receipt_id) REFERENCES operation_log(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK(
        (state = 'queued' AND terminal_receipt_id IS NULL AND resolved_at_ms IS NULL)
        OR (state = 'succeeded' AND terminal_receipt_id IS NOT NULL AND resolved_at_ms IS NOT NULL)
        OR (state IN ('attention', 'blocked') AND terminal_receipt_id IS NULL AND resolved_at_ms IS NOT NULL)
      )
    ) STRICT;

    CREATE TRIGGER verified_inbox_processing_heads_reject_binding_update_trial
    BEFORE UPDATE ON verified_inbox_processing_heads_trial
    WHEN OLD.processing_ref IS NOT NEW.processing_ref
      OR OLD.receipt_id IS NOT NEW.receipt_id
      OR OLD.processing_pointer_id IS NOT NEW.processing_pointer_id
      OR OLD.enqueue_identity IS NOT NEW.enqueue_identity
      OR OLD.processor_key IS NOT NEW.processor_key
      OR OLD.processor_version IS NOT NEW.processor_version
      OR OLD.processor_digest_sha256 IS NOT NEW.processor_digest_sha256
      OR OLD.job_id IS NOT NEW.job_id
      OR OLD.dependency_policy_key IS NOT NEW.dependency_policy_key
      OR OLD.dependency_policy_version IS NOT NEW.dependency_policy_version
      OR OLD.dependency_policy_digest_sha256 IS NOT NEW.dependency_policy_digest_sha256
      OR OLD.dependency_maximum_attempts IS NOT NEW.dependency_maximum_attempts
      OR OLD.dependency_maximum_elapsed_ms IS NOT NEW.dependency_maximum_elapsed_ms
      OR OLD.dependency_retry_delay_ms IS NOT NEW.dependency_retry_delay_ms
      OR OLD.dependency_exhaustion IS NOT NEW.dependency_exhaustion
      OR OLD.enqueued_at_ms IS NOT NEW.enqueued_at_ms
      OR OLD.dependency_deadline_at_ms IS NOT NEW.dependency_deadline_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox processing binding is immutable');
    END;

    CREATE TRIGGER verified_inbox_processing_heads_reject_transition_trial
    BEFORE UPDATE ON verified_inbox_processing_heads_trial
    WHEN OLD.state <> 'queued'
      OR NEW.state NOT IN ('succeeded', 'attention', 'blocked')
      OR NEW.version <> OLD.version + 1
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox processing transition is invalid');
    END;

    CREATE TRIGGER verified_inbox_processing_heads_reject_delete_trial
    BEFORE DELETE ON verified_inbox_processing_heads_trial
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox processing heads are retained');
    END;

    CREATE TABLE verified_inbox_processing_dependency_events_trial (
      job_id TEXT NOT NULL CHECK(length(job_id) = 36),
      invocation_id TEXT NOT NULL CHECK(length(invocation_id) = 36),
      processing_ref TEXT NOT NULL,
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      policy_digest_sha256 TEXT NOT NULL CHECK(
        length(policy_digest_sha256) = 64
        AND policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      disposition TEXT NOT NULL CHECK(disposition IN ('defer', 'attention', 'block')),
      reason_code TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      next_action_at_ms INTEGER,
      PRIMARY KEY (job_id, invocation_id),
      FOREIGN KEY (job_id, invocation_id)
        REFERENCES reliability_job_attempt_completions_trial(job_id, invocation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (processing_ref) REFERENCES verified_inbox_processing_heads_trial(processing_ref)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK(
        (disposition = 'defer' AND next_action_at_ms IS NOT NULL)
        OR (disposition <> 'defer' AND next_action_at_ms IS NULL)
      )
    ) STRICT;

    CREATE TRIGGER verified_inbox_processing_dependency_events_reject_update_trial
    BEFORE UPDATE ON verified_inbox_processing_dependency_events_trial
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox dependency evidence is append-only');
    END;

    CREATE TRIGGER verified_inbox_processing_dependency_events_reject_delete_trial
    BEFORE DELETE ON verified_inbox_processing_dependency_events_trial
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox dependency evidence is append-only');
    END;

    CREATE INDEX verified_inbox_processing_discovery_trial
      ON verified_inbox_processing_pointers_trial(created_at_ms, processing_pointer_id);

-- artifact: public-mutation-continuation
CREATE TABLE public_mutation_continuations_trial (
      ceremony_evidence_id TEXT PRIMARY KEY,
      binding_key TEXT NOT NULL,
      binding_version INTEGER NOT NULL CHECK (binding_version > 0),
      public_policy_revision_id TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL CHECK (operation_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      purpose_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      resource_bindings_json TEXT NOT NULL CHECK(
        json_valid(resource_bindings_json)
        AND json_type(resource_bindings_json) = 'array'
        AND json_array_length(resource_bindings_json) BETWEEN 1 AND 8
      ),
      action_anchor_id TEXT NOT NULL CHECK (
        action_anchor_id GLOB 'pma_*'
        OR (
          length(action_anchor_id) = 36
          AND action_anchor_id = lower(action_anchor_id)
          AND substr(action_anchor_id, 9, 1) = '-'
          AND substr(action_anchor_id, 14, 1) = '-'
          AND substr(action_anchor_id, 19, 1) = '-'
          AND substr(action_anchor_id, 24, 1) = '-'
          AND substr(action_anchor_id, 15, 1) IN ('4', '7')
          AND substr(action_anchor_id, 20, 1) IN ('8', '9', 'a', 'b')
          AND replace(action_anchor_id, '-', '') NOT GLOB '*[^0-9a-f]*'
        )
      ),
      lifetime_ms INTEGER NOT NULL CHECK (lifetime_ms > 0 AND lifetime_ms <= 900000),
      bootstrap_verifier_key TEXT NOT NULL,
      bootstrap_verifier_version INTEGER NOT NULL CHECK (bootstrap_verifier_version > 0),
      origin_policy_key TEXT NOT NULL,
      origin_policy_version INTEGER NOT NULL CHECK (origin_policy_version > 0),
      csrf_policy_key TEXT NOT NULL,
      csrf_policy_version INTEGER NOT NULL CHECK (csrf_policy_version > 0),
      rate_limit_policy_key TEXT NOT NULL,
      rate_limit_policy_version INTEGER NOT NULL CHECK (rate_limit_policy_version > 0),
      replay_policy_key TEXT NOT NULL,
      replay_policy_version INTEGER NOT NULL CHECK (replay_policy_version > 0),
      principal_profile_key TEXT NOT NULL,
      principal_profile_version INTEGER NOT NULL CHECK (principal_profile_version > 0),
      principal_key_verifier TEXT NOT NULL CHECK (principal_key_verifier GLOB 'ppk1_*'),
      replay_profile_key TEXT NOT NULL,
      replay_profile_version INTEGER NOT NULL CHECK (replay_profile_version > 0),
      replay_key_verifier TEXT NOT NULL CHECK (replay_key_verifier GLOB 'prk1_*'),
      principal_partition_key TEXT NOT NULL CHECK (principal_partition_key GLOB 'ppv1_*'),
      bootstrap_replay_verifier TEXT NOT NULL UNIQUE CHECK (bootstrap_replay_verifier GLOB 'prv1_*'),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
      revoked_at_ms INTEGER,
      state TEXT NOT NULL CHECK (state IN ('ready', 'terminal')),
      completion_reference TEXT UNIQUE,
      CHECK ((state = 'ready' AND completion_reference IS NULL) OR
             (state = 'terminal' AND completion_reference IS NOT NULL)),
      CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
      UNIQUE (action_anchor_id),
      UNIQUE (
        principal_partition_key, public_policy_revision_id, operation_name,
        operation_version, workspace_id, event_id, purpose_key, action_key, action_anchor_id
      ),
      FOREIGN KEY (ceremony_evidence_id, completion_reference)
        REFERENCES public_mutation_effect_proofs_trial(ceremony_evidence_id, completion_reference)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE public_mutation_continuation_aliases_trial (
      ceremony_evidence_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 8),
      profile_key TEXT NOT NULL,
      profile_version INTEGER NOT NULL CHECK (profile_version > 0),
      key_verifier TEXT NOT NULL CHECK (key_verifier GLOB 'pck1_*'),
      continuation_verifier TEXT NOT NULL UNIQUE CHECK (continuation_verifier GLOB 'pcv1_*'),
      PRIMARY KEY (ceremony_evidence_id, ordinal),
      UNIQUE (ceremony_evidence_id, profile_key, profile_version),
      FOREIGN KEY (ceremony_evidence_id)
        REFERENCES public_mutation_continuations_trial(ceremony_evidence_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE public_mutation_security_audits_trial (
      audit_event_id TEXT PRIMARY KEY,
      ceremony_evidence_id TEXT,
      binding_key TEXT NOT NULL,
      binding_version INTEGER NOT NULL CHECK (binding_version > 0),
      public_policy_revision_id TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL CHECK (operation_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      purpose_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      resource_bindings_json TEXT NOT NULL CHECK(
        json_valid(resource_bindings_json)
        AND json_type(resource_bindings_json) = 'array'
        AND json_array_length(resource_bindings_json) BETWEEN 1 AND 8
      ),
      action_anchor_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN (
        'bootstrap_rejected', 'mint_issued', 'mint_already_issued',
        'continuation_admitted', 'continuation_terminal_replay', 'continuation_stopped',
        'proof_terminal', 'proof_replay', 'proof_stopped'
      )),
      reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 160),
      recorded_at_ms INTEGER NOT NULL,
      origin_evidence_id TEXT,
      csrf_evidence_id TEXT,
      rate_limit_evidence_id TEXT,
      replay_evidence_id TEXT,
      FOREIGN KEY (ceremony_evidence_id)
        REFERENCES public_mutation_continuations_trial(ceremony_evidence_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE public_mutation_effect_proofs_trial (
      ceremony_evidence_id TEXT PRIMARY KEY,
      completion_reference TEXT NOT NULL UNIQUE CHECK (completion_reference GLOB 'pcr_*'),
      committed_at_ms INTEGER NOT NULL,
      UNIQUE (ceremony_evidence_id, completion_reference),
      FOREIGN KEY (ceremony_evidence_id)
        REFERENCES public_mutation_continuations_trial(ceremony_evidence_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TRIGGER public_mutation_continuation_aliases_immutable_trial
    BEFORE UPDATE ON public_mutation_continuation_aliases_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_alias_immutable');
    END;
    CREATE TRIGGER public_mutation_continuation_aliases_delete_immutable_trial
    BEFORE DELETE ON public_mutation_continuation_aliases_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_alias_immutable');
    END;
    CREATE TRIGGER public_mutation_security_audits_immutable_trial
    BEFORE UPDATE ON public_mutation_security_audits_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_security_audit_immutable');
    END;
    CREATE TRIGGER public_mutation_security_audits_delete_immutable_trial
    BEFORE DELETE ON public_mutation_security_audits_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_security_audit_immutable');
    END;
    CREATE TRIGGER public_mutation_effect_proofs_immutable_trial
    BEFORE UPDATE ON public_mutation_effect_proofs_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_effect_proof_immutable');
    END;
    CREATE TRIGGER public_mutation_effect_proofs_delete_immutable_trial
    BEFORE DELETE ON public_mutation_effect_proofs_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_effect_proof_immutable');
    END;
    CREATE TRIGGER public_mutation_continuations_delete_immutable_trial
    BEFORE DELETE ON public_mutation_continuations_trial BEGIN
      SELECT RAISE(ABORT, 'public_mutation_ceremony_immutable');
    END;
    CREATE TRIGGER public_mutation_continuations_identity_immutable_trial
    BEFORE UPDATE ON public_mutation_continuations_trial
    WHEN OLD.ceremony_evidence_id != NEW.ceremony_evidence_id
      OR OLD.binding_key != NEW.binding_key
      OR OLD.binding_version != NEW.binding_version
      OR OLD.public_policy_revision_id != NEW.public_policy_revision_id
      OR OLD.operation_name != NEW.operation_name
      OR OLD.operation_version != NEW.operation_version
      OR OLD.workspace_id != NEW.workspace_id
      OR OLD.event_id != NEW.event_id
      OR OLD.purpose_key != NEW.purpose_key
      OR OLD.action_key != NEW.action_key
      OR OLD.resource_bindings_json != NEW.resource_bindings_json
      OR OLD.action_anchor_id != NEW.action_anchor_id
      OR OLD.lifetime_ms != NEW.lifetime_ms
      OR OLD.bootstrap_verifier_key != NEW.bootstrap_verifier_key
      OR OLD.bootstrap_verifier_version != NEW.bootstrap_verifier_version
      OR OLD.origin_policy_key != NEW.origin_policy_key
      OR OLD.origin_policy_version != NEW.origin_policy_version
      OR OLD.csrf_policy_key != NEW.csrf_policy_key
      OR OLD.csrf_policy_version != NEW.csrf_policy_version
      OR OLD.rate_limit_policy_key != NEW.rate_limit_policy_key
      OR OLD.rate_limit_policy_version != NEW.rate_limit_policy_version
      OR OLD.replay_policy_key != NEW.replay_policy_key
      OR OLD.replay_policy_version != NEW.replay_policy_version
      OR OLD.principal_profile_key != NEW.principal_profile_key
      OR OLD.principal_profile_version != NEW.principal_profile_version
      OR OLD.principal_key_verifier != NEW.principal_key_verifier
      OR OLD.replay_profile_key != NEW.replay_profile_key
      OR OLD.replay_profile_version != NEW.replay_profile_version
      OR OLD.replay_key_verifier != NEW.replay_key_verifier
      OR OLD.principal_partition_key != NEW.principal_partition_key
      OR OLD.bootstrap_replay_verifier != NEW.bootstrap_replay_verifier
      OR OLD.created_at_ms != NEW.created_at_ms
      OR OLD.expires_at_ms != NEW.expires_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'public_mutation_ceremony_identity_immutable');
    END;
    CREATE TRIGGER public_mutation_continuations_state_monotonic_trial
    BEFORE UPDATE ON public_mutation_continuations_trial
    WHEN (OLD.state = 'terminal' AND (NEW.state != OLD.state OR NEW.completion_reference != OLD.completion_reference))
      OR (OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms != OLD.revoked_at_ms)
      OR (OLD.revoked_at_ms IS NULL AND NEW.revoked_at_ms IS NULL
          AND OLD.state = NEW.state AND OLD.completion_reference IS NEW.completion_reference)
    BEGIN
      SELECT CASE
        WHEN OLD.state = 'terminal' AND (NEW.state != OLD.state OR NEW.completion_reference != OLD.completion_reference)
          THEN RAISE(ABORT, 'public_mutation_terminal_immutable')
        WHEN OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms != OLD.revoked_at_ms
          THEN RAISE(ABORT, 'public_mutation_revocation_immutable')
      END;
    END;

-- artifact: public-mutation-effect-completion
CREATE TABLE public_mutation_registered_effect_completions (
    ceremony_evidence_id TEXT PRIMARY KEY,
    completion_reference TEXT NOT NULL UNIQUE CHECK (completion_reference GLOB 'pcr_*'),
    receipt_id TEXT NOT NULL UNIQUE,
    scope_partition_key TEXT NOT NULL,
    authority_principal_key TEXT NOT NULL,
    operation_name TEXT NOT NULL,
    operation_version INTEGER NOT NULL CHECK (operation_version > 0),
    surface TEXT NOT NULL,
    idempotency_profile_key TEXT NOT NULL,
    idempotency_profile_version INTEGER NOT NULL CHECK (idempotency_profile_version > 0),
    idempotency_key_verifier TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    configuration_digest_sha256 TEXT NOT NULL CHECK (
      length(configuration_digest_sha256) = 64
      AND configuration_digest_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    principal_partition_key TEXT NOT NULL CHECK (principal_partition_key GLOB 'ppv1_*'),
    completed_at_ms INTEGER NOT NULL,
    FOREIGN KEY (ceremony_evidence_id, completion_reference)
      REFERENCES public_mutation_effect_proofs_trial(ceremony_evidence_id, completion_reference)
      ON UPDATE NO ACTION ON DELETE NO ACTION,
    FOREIGN KEY (receipt_id)
      REFERENCES operation_log(id)
      ON UPDATE NO ACTION ON DELETE NO ACTION
  ) STRICT;

  CREATE TRIGGER public_mutation_registered_effect_completions_immutable
  BEFORE UPDATE ON public_mutation_registered_effect_completions BEGIN
    SELECT RAISE(ABORT, 'public_mutation_registered_effect_completion_immutable');
  END;

  CREATE TRIGGER public_mutation_registered_effect_completions_delete_immutable
  BEFORE DELETE ON public_mutation_registered_effect_completions BEGIN
    SELECT RAISE(ABORT, 'public_mutation_registered_effect_completion_immutable');
  END;

-- artifact: intake-public-mutation-effect
CREATE TABLE intake_public_mutation_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  ceremony_evidence_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('begin', 'save', 'submit')),
  plan_digest_sha256 TEXT NOT NULL CHECK(
    length(plan_digest_sha256) = 64 AND plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operation_name TEXT NOT NULL CHECK(operation_name = 'application.public.mutate'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  participant_attribution_evidence_json TEXT,
  CHECK(
    (action = 'submit' AND participant_attribution_evidence_json IS NOT NULL
      AND json_valid(participant_attribution_evidence_json)
      AND json_type(participant_attribution_evidence_json) = 'array'
      AND json_array_length(participant_attribution_evidence_json) BETWEEN 1 AND 16)
    OR (action IN ('begin', 'save') AND participant_attribution_evidence_json IS NULL)
  ),
  UNIQUE(ceremony_evidence_id, receipt_id),
  UNIQUE(receipt_id, workspace_id, event_id, action, plan_digest_sha256, occurred_at_ms),
  FOREIGN KEY(receipt_id) REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, event_id, draft_id)
    REFERENCES intake_application_draft_heads(workspace_id, event_id, draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_public_mutation_facts (
  fact_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_kind TEXT NOT NULL CHECK(fact_kind IN ('application_draft_changed', 'application_submitted')),
  action TEXT NOT NULL CHECK(action IN ('begin', 'save', 'submit')),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  plan_digest_sha256 TEXT NOT NULL,
  source_plan_json TEXT NOT NULL CHECK(json_valid(source_plan_json) AND json_type(source_plan_json) = 'object'),
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(fact_id, receipt_id),
  UNIQUE(fact_id, receipt_id, workspace_id, event_id, action, occurred_at_ms),
  FOREIGN KEY(
    receipt_id, workspace_id, event_id, action, plan_digest_sha256, occurred_at_ms
  )
    REFERENCES intake_public_mutation_receipt_links(
      receipt_id, workspace_id, event_id, action, plan_digest_sha256, occurred_at_ms
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_public_mutation_pointers (
  pointer_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY(fact_id, receipt_id)
    REFERENCES intake_public_mutation_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_public_mutation_timeline (
  timeline_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('begin', 'save', 'submit')),
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  occurred_at_ms INTEGER NOT NULL,
  FOREIGN KEY(fact_id, receipt_id, workspace_id, event_id, action, occurred_at_ms)
    REFERENCES intake_public_mutation_facts(
      fact_id, receipt_id, workspace_id, event_id, action, occurred_at_ms
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_public_mutation_receipt_links_no_update BEFORE UPDATE
ON intake_public_mutation_receipt_links BEGIN SELECT RAISE(ABORT, 'intake receipt link immutable'); END;
CREATE TRIGGER intake_public_mutation_receipt_links_no_delete BEFORE DELETE
ON intake_public_mutation_receipt_links BEGIN SELECT RAISE(ABORT, 'intake receipt link immutable'); END;
CREATE TRIGGER intake_public_mutation_facts_no_update BEFORE UPDATE
ON intake_public_mutation_facts BEGIN SELECT RAISE(ABORT, 'intake fact immutable'); END;
CREATE TRIGGER intake_public_mutation_facts_no_delete BEFORE DELETE
ON intake_public_mutation_facts BEGIN SELECT RAISE(ABORT, 'intake fact immutable'); END;
CREATE TRIGGER intake_public_mutation_pointers_no_update BEFORE UPDATE
ON intake_public_mutation_pointers BEGIN SELECT RAISE(ABORT, 'intake pointer immutable'); END;
CREATE TRIGGER intake_public_mutation_pointers_no_delete BEFORE DELETE
ON intake_public_mutation_pointers BEGIN SELECT RAISE(ABORT, 'intake pointer immutable'); END;
CREATE TRIGGER intake_public_mutation_timeline_no_update BEFORE UPDATE
ON intake_public_mutation_timeline BEGIN SELECT RAISE(ABORT, 'intake timeline immutable'); END;
CREATE TRIGGER intake_public_mutation_timeline_no_delete BEFORE DELETE
ON intake_public_mutation_timeline BEGIN SELECT RAISE(ABORT, 'intake timeline immutable'); END;

-- artifact: intake-participant-attribution-conformance
CREATE TABLE intake_participant_attribution_conformance (
  ceremony_evidence_id TEXT PRIMARY KEY,
  authority_partition_digest_sha256 TEXT NOT NULL CHECK(
    length(authority_partition_digest_sha256) = 64
    AND authority_partition_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  person_id TEXT NOT NULL UNIQUE CHECK(length(person_id) = 36 AND person_id = lower(person_id)),
  participant_identity_id TEXT NOT NULL UNIQUE
    CHECK(length(participant_identity_id) = 36 AND participant_identity_id = lower(participant_identity_id)),
  evidence_ids_json TEXT NOT NULL CHECK(
    json_valid(evidence_ids_json) AND json_type(evidence_ids_json) = 'array'
    AND json_array_length(evidence_ids_json) BETWEEN 1 AND 16
  )
) STRICT, WITHOUT ROWID;

CREATE TRIGGER intake_participant_attribution_conformance_role_collision
BEFORE INSERT ON intake_participant_attribution_conformance
WHEN NEW.person_id = NEW.participant_identity_id
  OR EXISTS (
    SELECT 1 FROM intake_participant_attribution_conformance
     WHERE person_id = NEW.participant_identity_id
        OR participant_identity_id = NEW.person_id
  )
BEGIN SELECT RAISE(ABORT, 'intake participant attribution role collision'); END;

CREATE TRIGGER intake_participant_attribution_conformance_no_update
BEFORE UPDATE ON intake_participant_attribution_conformance
BEGIN SELECT RAISE(ABORT, 'intake participant attribution is immutable'); END;
CREATE TRIGGER intake_participant_attribution_conformance_no_delete
BEFORE DELETE ON intake_participant_attribution_conformance
BEGIN SELECT RAISE(ABORT, 'intake participant attribution is immutable'); END;

-- artifact: session-domain
CREATE TABLE session_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE sessions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300 AND title = trim(title)),
  planned_duration_minutes INTEGER NOT NULL CHECK(
    planned_duration_minutes BETWEEN 5 AND 1440 AND planned_duration_minutes % 5 = 0
  ),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'collecting', 'programmed')),
  format_id TEXT NOT NULL CHECK(length(format_id) = 36),
  track_id TEXT CHECK(track_id IS NULL OR length(track_id) = 36),
  program_set_version INTEGER NOT NULL CHECK(program_set_version > 0),
  program_set_digest_sha256 TEXT NOT NULL CHECK(
    length(program_set_digest_sha256) = 64 AND program_set_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  roster_version INTEGER NOT NULL CHECK(roster_version > 0),
  roster_digest_sha256 TEXT NOT NULL CHECK(
    length(roster_digest_sha256) = 64 AND roster_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  roster_json TEXT NOT NULL CHECK(json_valid(roster_json)),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(json_extract(head_json, '$.digestSha256') = digest_sha256),
  CHECK(json_extract(head_json, '$.lifecycle') = lifecycle),
  CHECK(json_extract(head_json, '$.programTarget.format.id') = format_id),
  CHECK(json_extract(head_json, '$.programTarget.track.id') IS track_id),
  CHECK(json_extract(head_json, '$.roster.version') = roster_version),
  CHECK(json_extract(head_json, '$.roster.digestSha256') = roster_digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES session_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, format_id)
    REFERENCES program_vocabulary_formats(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, track_id)
    REFERENCES program_vocabulary_tracks(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX sessions_lifecycle_title
  ON sessions(workspace_id, event_id, lifecycle, title, id);
CREATE INDEX sessions_format
  ON sessions(workspace_id, event_id, format_id, id);
CREATE INDEX sessions_track
  ON sessions(workspace_id, event_id, track_id, id);

CREATE TRIGGER sessions_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, created_by_user_id, created_at_ms ON sessions
BEGIN
  SELECT RAISE(ABORT, 'session identity is immutable');
END;

-- artifact: reviewer-roster-domain
CREATE TABLE reviewer_roster_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_records (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('included', 'revoked')),
  access_subject_kind TEXT NOT NULL CHECK(access_subject_kind IN ('access_reservation', 'workspace_membership')),
  access_subject_id TEXT NOT NULL CHECK(length(access_subject_id) = 36),
  access_subject_version INTEGER NOT NULL CHECK(access_subject_version > 0),
  added_by_user_id TEXT NOT NULL CHECK(length(added_by_user_id) = 36),
  added_at_ms INTEGER NOT NULL CHECK(added_at_ms BETWEEN 0 AND 8640000000000000),
  revoked_by_user_id TEXT CHECK(revoked_by_user_id IS NULL OR length(revoked_by_user_id) = 36),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, reviewer_id),
  UNIQUE (workspace_id, event_id, access_subject_kind, access_subject_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES reviewer_roster_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'included' AND revoked_by_user_id IS NULL AND revoked_at_ms IS NULL)
    OR (state = 'revoked' AND revoked_by_user_id IS NOT NULL AND revoked_at_ms IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_scopes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('track', 'format', 'session')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) = 36),
  PRIMARY KEY (workspace_id, event_id, reviewer_id, ref_kind, ref_id),
  FOREIGN KEY (workspace_id, event_id, reviewer_id)
    REFERENCES reviewer_roster_records(workspace_id, event_id, reviewer_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER reviewer_roster_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, reviewer_id, access_subject_kind, access_subject_id
ON reviewer_roster_records
BEGIN SELECT RAISE(ABORT, 'reviewer roster identity is immutable'); END;

CREATE TRIGGER reviewer_roster_records_retained
BEFORE DELETE ON reviewer_roster_records
BEGIN SELECT RAISE(ABORT, 'reviewer roster records are retained'); END;

-- artifact: review-domain
CREATE TABLE review_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_rounds (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'discarded')),
  version INTEGER NOT NULL CHECK(version > 0),
  deadline_id TEXT NOT NULL CHECK(length(deadline_id) = 36),
  deadline_kind TEXT NOT NULL CHECK(deadline_kind = 'review_due'),
  deadline_version INTEGER NOT NULL CHECK(deadline_version > 0),
  deadline_digest_sha256 TEXT NOT NULL CHECK(length(deadline_digest_sha256) = 64 AND deadline_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  deadline_effective_at_ms INTEGER NOT NULL CHECK(deadline_effective_at_ms BETWEEN 0 AND 8640000000000000),
  participant_identity TEXT NOT NULL CHECK(participant_identity IN ('hidden', 'shown')),
  peer_reviewer_identity TEXT NOT NULL CHECK(peer_reviewer_identity IN ('hidden', 'shown')),
  peer_content_unlock TEXT NOT NULL CHECK(peer_content_unlock IN ('after_own_commit', 'open')),
  opened_by_user_id TEXT NOT NULL CHECK(length(opened_by_user_id) = 36),
  opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms BETWEEN 0 AND 8640000000000000),
  closed_by_user_id TEXT CHECK(closed_by_user_id IS NULL OR length(closed_by_user_id) = 36),
  closed_at_ms INTEGER CHECK(closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 8640000000000000),
  discarded_by_user_id TEXT CHECK(discarded_by_user_id IS NULL OR length(discarded_by_user_id) = 36),
  discarded_at_ms INTEGER CHECK(discarded_at_ms IS NULL OR discarded_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, ordinal),
  UNIQUE (id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES review_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'open' AND closed_by_user_id IS NULL AND closed_at_ms IS NULL AND discarded_by_user_id IS NULL AND discarded_at_ms IS NULL)
    OR (state = 'closed' AND closed_by_user_id IS NOT NULL AND closed_at_ms IS NOT NULL AND discarded_by_user_id IS NULL AND discarded_at_ms IS NULL)
    OR (state = 'discarded' AND discarded_by_user_id IS NOT NULL AND discarded_at_ms IS NOT NULL AND closed_by_user_id IS NULL AND closed_at_ms IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX review_one_open_round
  ON review_rounds(workspace_id, event_id) WHERE state = 'open';

CREATE TABLE review_round_criteria (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 160),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  description TEXT CHECK(description IS NULL OR length(description) BETWEEN 1 AND 500),
  position INTEGER NOT NULL CHECK(position >= 0),
  weight_bps INTEGER NOT NULL CHECK(weight_bps BETWEEN 1 AND 10000),
  scale_min INTEGER NOT NULL CHECK(scale_min = 1),
  scale_max INTEGER NOT NULL CHECK(scale_max = 5),
  PRIMARY KEY (workspace_id, event_id, round_id, id),
  UNIQUE (workspace_id, event_id, round_id, key),
  UNIQUE (workspace_id, event_id, round_id, position),
  FOREIGN KEY (workspace_id, event_id, round_id)
    REFERENCES review_rounds(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_assignments (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  round_id TEXT NOT NULL CHECK(length(round_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('assigned', 'stepped_back')),
  assigned_at_ms INTEGER NOT NULL CHECK(assigned_at_ms BETWEEN 0 AND 8640000000000000),
  stepped_back_at_ms INTEGER CHECK(stepped_back_at_ms IS NULL OR stepped_back_at_ms BETWEEN 0 AND 8640000000000000),
  stepped_back_by_user_id TEXT CHECK(stepped_back_by_user_id IS NULL OR length(stepped_back_by_user_id) = 36),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, event_id, round_id, submission_id, reviewer_id),
  FOREIGN KEY (workspace_id, event_id, round_id)
    REFERENCES review_rounds(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'assigned' AND stepped_back_at_ms IS NULL AND stepped_back_by_user_id IS NULL)
    OR (state = 'stepped_back' AND stepped_back_at_ms IS NOT NULL AND stepped_back_by_user_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE review_drafts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  comment TEXT NOT NULL CHECK(length(comment) <= 20000),
  updated_by_reviewer_id TEXT NOT NULL CHECK(length(updated_by_reviewer_id) = 36),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, assignment_id),
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  weighted_score REAL NOT NULL CHECK(weighted_score BETWEEN 1 AND 5),
  comment TEXT NOT NULL CHECK(length(comment) <= 20000),
  committed_by_reviewer_id TEXT NOT NULL CHECK(length(committed_by_reviewer_id) = 36),
  committed_by_user_id TEXT NOT NULL CHECK(length(committed_by_user_id) = 36),
  committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms BETWEEN 0 AND 8640000000000000),
  post_unlock INTEGER NOT NULL CHECK(post_unlock IN (0, 1)),
  correction_of_revision_id TEXT CHECK(correction_of_revision_id IS NULL OR length(correction_of_revision_id) = 36),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, event_id, assignment_id, revision_number),
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (correction_of_revision_id) REFERENCES review_revisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (revision_number = 1 AND post_unlock = 0 AND correction_of_revision_id IS NULL)
    OR (revision_number > 1 AND post_unlock = 1 AND correction_of_revision_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE review_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  first_committed_at_ms INTEGER NOT NULL CHECK(first_committed_at_ms BETWEEN 0 AND 8640000000000000),
  peer_unlocked_at_ms INTEGER NOT NULL CHECK(peer_unlocked_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, assignment_id),
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (current_revision_id) REFERENCES review_revisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER review_round_criteria_immutable BEFORE UPDATE ON review_round_criteria
BEGIN SELECT RAISE(ABORT, 'review criteria are immutable'); END;
CREATE TRIGGER review_round_criteria_retained BEFORE DELETE ON review_round_criteria
BEGIN SELECT RAISE(ABORT, 'review criteria are retained'); END;
CREATE TRIGGER review_revisions_immutable BEFORE UPDATE ON review_revisions
BEGIN SELECT RAISE(ABORT, 'review revisions are immutable'); END;
CREATE TRIGGER review_revisions_retained BEFORE DELETE ON review_revisions
BEGIN SELECT RAISE(ABORT, 'review revisions are retained'); END;
CREATE TRIGGER review_rounds_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, ordinal, deadline_id, deadline_kind,
  deadline_version, deadline_digest_sha256, deadline_effective_at_ms, opened_by_user_id,
  opened_at_ms ON review_rounds
BEGIN SELECT RAISE(ABORT, 'review round identity and pins are immutable'); END;
CREATE TRIGGER review_assignments_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, round_id, submission_id, reviewer_id,
  assigned_at_ms ON review_assignments
BEGIN SELECT RAISE(ABORT, 'review assignment identity is immutable'); END;
CREATE TRIGGER review_catalogs_retained BEFORE DELETE ON review_catalogs
BEGIN SELECT RAISE(ABORT, 'review catalogs are retained'); END;
CREATE TRIGGER review_rounds_retained BEFORE DELETE ON review_rounds
BEGIN SELECT RAISE(ABORT, 'review rounds are retained'); END;
CREATE TRIGGER review_assignments_retained BEFORE DELETE ON review_assignments
BEGIN SELECT RAISE(ABORT, 'review assignments are retained'); END;
CREATE TRIGGER review_drafts_retained BEFORE DELETE ON review_drafts
BEGIN SELECT RAISE(ABORT, 'review drafts are retained'); END;
CREATE TRIGGER review_heads_retained BEFORE DELETE ON review_heads
BEGIN SELECT RAISE(ABORT, 'review heads are retained'); END;

-- artifact: review-evaluation-draft-save-effect
CREATE TABLE review_evaluation_draft_save_receipt_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  operation_name TEXT NOT NULL CHECK(operation_name = 'review.evaluation.draft.save'),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(workspace_id, event_id, assignment_id, draft_version)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER review_evaluation_draft_save_receipt_links_no_update
BEFORE UPDATE ON review_evaluation_draft_save_receipt_links
BEGIN SELECT RAISE(ABORT, 'review draft-save receipt links are immutable'); END;
CREATE TRIGGER review_evaluation_draft_save_receipt_links_no_delete
BEFORE DELETE ON review_evaluation_draft_save_receipt_links
BEGIN SELECT RAISE(ABORT, 'review draft-save receipt links are immutable'); END;

-- artifact: decision-domain
CREATE TABLE decision_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'waitlisted', 'declined', 'withdrawn')),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  decided_by_user_id TEXT NOT NULL CHECK(length(decided_by_user_id) = 36),
  decided_at_ms INTEGER NOT NULL CHECK(decided_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  CHECK(json_extract(head_json, '$.submissionId') = submission_id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(json_extract(head_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (decided_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX decision_heads_state
  ON decision_heads(workspace_id, event_id, state, submission_id);

CREATE TABLE submission_session_origins (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('spawned', 'attached')),
  linked_by_user_id TEXT NOT NULL CHECK(length(linked_by_user_id) = 36),
  linked_at_ms INTEGER NOT NULL CHECK(linked_at_ms BETWEEN 0 AND 8640000000000000),
  origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  CHECK(json_extract(origin_json, '$.submissionId') = submission_id),
  CHECK(json_extract(origin_json, '$.sessionId') = session_id),
  CHECK(json_extract(origin_json, '$.kind') = kind),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES decision_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (linked_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX submission_session_origins_session
  ON submission_session_origins(workspace_id, event_id, session_id, submission_id);

CREATE TRIGGER decision_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, submission_id ON decision_heads
BEGIN
  SELECT RAISE(ABORT, 'decision head identity is immutable');
END;

CREATE TRIGGER submission_session_origins_immutable
BEFORE UPDATE ON submission_session_origins
BEGIN
  SELECT RAISE(ABORT, 'submission session origins are immutable; compensation unlinks by delete');
END;

-- artifact: engagement-domain
CREATE TABLE engagement_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  submission_id TEXT CHECK(submission_id IS NULL OR length(submission_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('invited', 'confirmed', 'declined', 'cancelled')),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  invited_at_ms INTEGER NOT NULL CHECK(invited_at_ms BETWEEN 0 AND 8640000000000000),
  cancelled_at_ms INTEGER CHECK(
    cancelled_at_ms IS NULL OR cancelled_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, session_id, person_id),
  CHECK((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.sessionId') = session_id),
  CHECK(json_extract(head_json, '$.personId') = person_id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(
    (submission_id IS NULL AND json_extract(head_json, '$.submissionId') IS NULL)
    OR json_extract(head_json, '$.submissionId') = submission_id
  ),
  CHECK((submission_id IS NULL) = (json_extract(head_json, '$.seededByDecision') IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX engagement_heads_person
  ON engagement_heads(workspace_id, event_id, person_id, session_id);

CREATE INDEX engagement_heads_submission
  ON engagement_heads(workspace_id, event_id, submission_id, session_id, person_id)
  WHERE submission_id IS NOT NULL;

CREATE TRIGGER engagement_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, session_id, person_id, submission_id
ON engagement_heads
BEGIN
  SELECT RAISE(ABORT, 'engagement identity is immutable');
END;

CREATE TRIGGER engagement_heads_seed_provenance_immutable
BEFORE UPDATE OF head_json ON engagement_heads
WHEN json_extract(OLD.head_json, '$.seededByDecision')
  IS NOT json_extract(NEW.head_json, '$.seededByDecision')
BEGIN
  SELECT RAISE(ABORT, 'engagement seed provenance is immutable');
END;

-- artifact: task-domain
CREATE TABLE task_definition_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(workspace_id,event_id),
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_definition_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number > 0),
  version INTEGER NOT NULL CHECK(version = current_revision_number),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,current_revision_id),
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES task_definition_catalogs(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,current_revision_id)
    REFERENCES task_definition_revisions(workspace_id,event_id,revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE task_definition_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  task_definition_id TEXT NOT NULL CHECK(length(task_definition_id) = 36),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  deadline_id TEXT NOT NULL CHECK(length(deadline_id) = 36),
  completion_mode TEXT NOT NULL CHECK(completion_mode IN (
    'acknowledge','file_upload','form','external_action'
  )),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('engagement','session','group')),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,revision_id),
  UNIQUE(workspace_id,event_id,task_definition_id,revision_number),
  CHECK(json_extract(revision_json,'$.taskDefinitionId') = task_definition_id),
  CHECK(json_extract(revision_json,'$.revisionId') = revision_id),
  CHECK(json_extract(revision_json,'$.number') = revision_number),
  CHECK(json_extract(revision_json,'$.deadline.reference.id') = deadline_id),
  CHECK(json_extract(revision_json,'$.completionMode') = completion_mode),
  CHECK(json_extract(revision_json,'$.subjectKind') = subject_kind),
  CHECK(json_extract(revision_json,'$.digestSha256') = digest_sha256),
  FOREIGN KEY(workspace_id,event_id,task_definition_id)
    REFERENCES task_definition_heads(workspace_id,event_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,event_id,deadline_id)
    REFERENCES deadlines(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_assignments (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  task_definition_id TEXT NOT NULL CHECK(length(task_definition_id) = 36),
  task_definition_revision_id TEXT NOT NULL CHECK(length(task_definition_revision_id) = 36),
  engagement_id TEXT NOT NULL CHECK(length(engagement_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  state TEXT NOT NULL CHECK(state IN (
    'pending','received_pending_check','complete','waived','late_complete'
  )),
  version INTEGER NOT NULL CHECK(version > 0),
  assignment_json TEXT NOT NULL CHECK(json_valid(assignment_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,task_definition_id,engagement_id),
  CHECK(json_extract(assignment_json,'$.id') = id),
  CHECK(json_extract(assignment_json,'$.taskDefinitionId') = task_definition_id),
  CHECK(json_extract(assignment_json,'$.taskDefinitionRevisionId') = task_definition_revision_id),
  CHECK(json_extract(assignment_json,'$.engagementId') = engagement_id),
  CHECK(json_extract(assignment_json,'$.personId') = person_id),
  CHECK(json_extract(assignment_json,'$.state') = state),
  CHECK(json_extract(assignment_json,'$.version') = version),
  FOREIGN KEY(workspace_id,event_id,task_definition_id)
    REFERENCES task_definition_heads(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,task_definition_revision_id)
    REFERENCES task_definition_revisions(workspace_id,event_id,revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,engagement_id)
    REFERENCES engagement_heads(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_events (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN (
    'assigned','fulfillment_received','fulfillment_accepted','waived','restored','extended','reminded'
  )),
  assignment_version INTEGER NOT NULL CHECK(assignment_version > 0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,assignment_id,assignment_version),
  CHECK(json_extract(event_json,'$.id') = id),
  CHECK(json_extract(event_json,'$.assignmentId') = assignment_id),
  CHECK(json_extract(event_json,'$.kind') = kind),
  CHECK(json_extract(event_json,'$.assignmentVersion') = assignment_version),
  FOREIGN KEY(workspace_id,event_id,assignment_id)
    REFERENCES task_assignments(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX task_assignments_definition
  ON task_assignments(workspace_id,event_id,task_definition_id,engagement_id);
CREATE INDEX task_assignments_engagement
  ON task_assignments(workspace_id,event_id,engagement_id,task_definition_id);
CREATE INDEX task_assignments_state
  ON task_assignments(workspace_id,event_id,state,id);
CREATE INDEX task_events_history
  ON task_events(workspace_id,event_id,assignment_id,assignment_version);

CREATE TRIGGER task_definition_revisions_no_update BEFORE UPDATE ON task_definition_revisions
BEGIN SELECT RAISE(ABORT, 'task definition revisions are immutable'); END;
CREATE TRIGGER task_definition_revisions_no_delete BEFORE DELETE ON task_definition_revisions
BEGIN SELECT RAISE(ABORT, 'task definition revisions are immutable'); END;
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
CREATE TRIGGER task_definition_heads_no_delete BEFORE DELETE ON task_definition_heads
BEGIN SELECT RAISE(ABORT, 'task definitions are retained'); END;
CREATE TRIGGER task_assignments_identity_immutable
BEFORE UPDATE OF workspace_id,event_id,id,task_definition_id,task_definition_revision_id,
  engagement_id,person_id ON task_assignments
BEGIN SELECT RAISE(ABORT, 'task assignment identity is immutable'); END;

-- artifact: communication-outbound-delivery
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
  -- Durable ownership of a dispatch. `state = 'request_started'` says an attempt
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
  -- `request_started` row cannot exist and every recovery is decided by expiry.
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

-- artifact: communication-message-releases
CREATE TABLE communication_message_releases (
  release_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  recipient_ref_id TEXT NOT NULL,
  person_ref_id TEXT NOT NULL,
  contact_ref_id TEXT NOT NULL,
  template_revision_ref_id TEXT NOT NULL,
  content_ref_id TEXT NOT NULL,
  purpose_key TEXT NOT NULL,
  reviewed_message_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_message_digest_sha256) = 64),
  reviewed_envelope_digest_sha256 TEXT NOT NULL CHECK(length(reviewed_envelope_digest_sha256) = 64),
  envelope_payload_ref_id TEXT NOT NULL REFERENCES classified_payload_records(payload_ref_id),
  envelope_byte_size INTEGER NOT NULL CHECK(envelope_byte_size > 0),
  envelope_digest_sha256 TEXT NOT NULL CHECK(length(envelope_digest_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, event_id, batch_id, recipient_ref_id),
  UNIQUE(envelope_payload_ref_id)
) STRICT;

CREATE INDEX communication_message_releases_batch
  ON communication_message_releases(workspace_id, event_id, batch_id, release_id);

CREATE TRIGGER communication_message_releases_no_update
BEFORE UPDATE ON communication_message_releases
BEGIN SELECT RAISE(ABORT, 'communication message releases are immutable'); END;
CREATE TRIGGER communication_message_releases_no_delete
BEFORE DELETE ON communication_message_releases
BEGIN SELECT RAISE(ABORT, 'communication message releases are immutable'); END;

-- artifact: communication-release-native-effect
CREATE TABLE communication_release_commits (
  commit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  plan_digest_sha256 TEXT NOT NULL CHECK(length(plan_digest_sha256) = 64),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE(workspace_id, event_id, batch_id)
) STRICT;

CREATE TABLE communication_release_effect_specs (
  spec_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  work_digest_sha256 TEXT NOT NULL CHECK(length(work_digest_sha256) = 64),
  UNIQUE(batch_id, release_id),
  UNIQUE(delivery_id)
) STRICT;

CREATE TRIGGER communication_release_effect_specs_no_update
BEFORE UPDATE ON communication_release_effect_specs
BEGIN SELECT RAISE(ABORT, 'communication release effect specs are immutable'); END;
CREATE TRIGGER communication_release_effect_specs_no_delete
BEFORE DELETE ON communication_release_effect_specs
BEGIN SELECT RAISE(ABORT, 'communication release effect specs are immutable'); END;
CREATE TRIGGER communication_release_commits_no_update
BEFORE UPDATE ON communication_release_commits
BEGIN SELECT RAISE(ABORT, 'communication release commits are immutable'); END;
CREATE TRIGGER communication_release_commits_no_delete
BEFORE DELETE ON communication_release_commits
BEGIN SELECT RAISE(ABORT, 'communication release commits are immutable'); END;

-- artifact: participant-access
CREATE TABLE participant_identity_family (
  participant_identity_id TEXT PRIMARY KEY CHECK(
    length(participant_identity_id) = 36 AND participant_identity_id = lower(participant_identity_id)
  ),
  person_id TEXT NOT NULL UNIQUE CHECK(length(person_id) = 36 AND person_id = lower(person_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  normalized_email TEXT NOT NULL CHECK(length(normalized_email) BETWEEN 3 AND 320),
  display_email TEXT NOT NULL CHECK(length(display_email) BETWEEN 3 AND 320),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  standing TEXT NOT NULL CHECK(standing IN ('active', 'revoked')),
  origin TEXT NOT NULL CHECK(origin IN ('portal_ceremony', 'adopted_attribution')),
  minted_at_ms INTEGER NOT NULL CHECK(minted_at_ms BETWEEN 0 AND 8640000000000000),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= minted_at_ms),
  UNIQUE(workspace_id, event_id, normalized_email),
  CHECK((standing = 'revoked') = (revoked_at_ms IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TRIGGER participant_identity_family_role_collision
BEFORE INSERT ON participant_identity_family
WHEN NEW.person_id = NEW.participant_identity_id
  OR EXISTS (
    SELECT 1 FROM participant_identity_family
     WHERE person_id = NEW.participant_identity_id
        OR participant_identity_id = NEW.person_id
  )
BEGIN SELECT RAISE(ABORT, 'participant identity role collision'); END;

CREATE TRIGGER participant_identity_family_pair_immutable
BEFORE UPDATE ON participant_identity_family
WHEN NEW.participant_identity_id IS NOT OLD.participant_identity_id
  OR NEW.person_id IS NOT OLD.person_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.normalized_email IS NOT OLD.normalized_email
  OR NEW.display_email IS NOT OLD.display_email
  OR NEW.origin IS NOT OLD.origin
  OR NEW.minted_at_ms IS NOT OLD.minted_at_ms
BEGIN SELECT RAISE(ABORT, 'participant identity pair is immutable'); END;

CREATE TRIGGER participant_identity_family_no_delete
BEFORE DELETE ON participant_identity_family
BEGIN SELECT RAISE(ABORT, 'participant identities are never deleted'); END;

CREATE TABLE participant_sign_in_challenges (
  challenge_id TEXT PRIMARY KEY CHECK(
    length(challenge_id) = 36 AND challenge_id = lower(challenge_id)
  ),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  method TEXT NOT NULL CHECK(method IN ('magic_link')),
  normalized_email TEXT NOT NULL CHECK(length(normalized_email) BETWEEN 3 AND 320),
  display_email TEXT NOT NULL CHECK(length(display_email) BETWEEN 3 AND 320),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK(state IN ('issued', 'used', 'superseded', 'expired')),
  requested_at_ms INTEGER NOT NULL CHECK(requested_at_ms BETWEEN 0 AND 8640000000000000),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > requested_at_ms),
  closed_at_ms INTEGER CHECK(closed_at_ms IS NULL OR closed_at_ms >= requested_at_ms),
  superseded_by_challenge_id TEXT CHECK(
    superseded_by_challenge_id IS NULL OR (
      length(superseded_by_challenge_id) = 36
      AND superseded_by_challenge_id <> challenge_id
    )
  ),
  receipt_id TEXT NOT NULL CHECK(length(receipt_id) = 36),
  delivery_id TEXT UNIQUE CHECK(delivery_id IS NULL OR length(delivery_id) BETWEEN 1 AND 256),
  CHECK((state = 'issued') = (closed_at_ms IS NULL)),
  CHECK((state = 'superseded') = (superseded_by_challenge_id IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX participant_sign_in_challenges_address_lane
  ON participant_sign_in_challenges(workspace_id, event_id, normalized_email, state);

CREATE TRIGGER participant_sign_in_challenges_transitions
BEFORE UPDATE ON participant_sign_in_challenges
WHEN NEW.challenge_id IS NOT OLD.challenge_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.method IS NOT OLD.method
  OR NEW.normalized_email IS NOT OLD.normalized_email
  OR NEW.display_email IS NOT OLD.display_email
  OR NEW.token_hash_sha256 IS NOT OLD.token_hash_sha256
  OR NEW.requested_at_ms IS NOT OLD.requested_at_ms
  OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
  OR NEW.receipt_id IS NOT OLD.receipt_id
  OR (OLD.state <> 'issued' AND NEW.state IS NOT OLD.state)
  OR (OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS NOT OLD.delivery_id)
BEGIN SELECT RAISE(ABORT, 'participant challenge evidence is immutable'); END;

CREATE TRIGGER participant_sign_in_challenges_no_delete
BEFORE DELETE ON participant_sign_in_challenges
BEGIN SELECT RAISE(ABORT, 'participant challenges are never deleted'); END;

CREATE TABLE participant_sessions (
  session_id TEXT PRIMARY KEY CHECK(length(session_id) = 36 AND session_id = lower(session_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  participant_identity_id TEXT NOT NULL
    REFERENCES participant_identity_family(participant_identity_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  last_seen_at_ms INTEGER NOT NULL CHECK(last_seen_at_ms >= created_at_ms),
  sliding_expires_at_ms INTEGER NOT NULL CHECK(sliding_expires_at_ms > created_at_ms),
  absolute_expires_at_ms INTEGER NOT NULL CHECK(absolute_expires_at_ms >= sliding_expires_at_ms),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  revoke_reason TEXT CHECK(revoke_reason IS NULL OR revoke_reason IN ('signed_out')),
  CHECK((revoked_at_ms IS NULL) = (revoke_reason IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX participant_sessions_identity
  ON participant_sessions(participant_identity_id, created_at_ms);

CREATE TRIGGER participant_sessions_identity_immutable
BEFORE UPDATE ON participant_sessions
WHEN NEW.session_id IS NOT OLD.session_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.participant_identity_id IS NOT OLD.participant_identity_id
  OR NEW.person_id IS NOT OLD.person_id
  OR NEW.token_hash_sha256 IS NOT OLD.token_hash_sha256
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR NEW.absolute_expires_at_ms IS NOT OLD.absolute_expires_at_ms
  OR NEW.last_seen_at_ms < OLD.last_seen_at_ms
  OR (OLD.revoked_at_ms IS NOT NULL AND (
    NEW.revoked_at_ms IS NOT OLD.revoked_at_ms OR NEW.revoke_reason IS NOT OLD.revoke_reason
  ))
BEGIN SELECT RAISE(ABORT, 'participant session identity is immutable'); END;

CREATE TRIGGER participant_sessions_no_delete
BEFORE DELETE ON participant_sessions
BEGIN SELECT RAISE(ABORT, 'participant sessions are never deleted'); END;

-- artifact: participant-portal-effect
CREATE TABLE participant_portal_activity (
  activity_id TEXT PRIMARY KEY CHECK(
    length(activity_id) = 36 AND activity_id = lower(activity_id)
  ),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN (
    'submitted', 'edited', 'withdrawn', 'status_communicated',
    'appeal_submitted', 'engagement_invited', 'engagement_responded', 'task_completed'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  acting_person_id TEXT CHECK(acting_person_id IS NULL OR length(acting_person_id) = 36),
  summary_for_actor TEXT NOT NULL CHECK(length(summary_for_actor) BETWEEN 1 AND 1000),
  summary_for_others TEXT NOT NULL CHECK(length(summary_for_others) BETWEEN 1 AND 1000)
) STRICT, WITHOUT ROWID;

CREATE INDEX participant_portal_activity_submission
  ON participant_portal_activity(workspace_id, event_id, submission_id, occurred_at_ms);

CREATE TRIGGER participant_portal_activity_no_update
BEFORE UPDATE ON participant_portal_activity
BEGIN SELECT RAISE(ABORT, 'participant portal activity is append-only'); END;
CREATE TRIGGER participant_portal_activity_no_delete
BEFORE DELETE ON participant_portal_activity
BEGIN SELECT RAISE(ABORT, 'participant portal activity is append-only'); END;

-- artifact: files-domain
CREATE TABLE file_upload_intents (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  uploader_kind TEXT NOT NULL CHECK(uploader_kind IN ('operator_user', 'participant')),
  uploader_id TEXT NOT NULL CHECK(length(uploader_id) = 36),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'engagement_material', 'submission_material', 'session_material',
    'resource_share_material', 'request_fulfillment'
  )),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.apple.keynote', 'application/zip'
  )),
  declared_byte_size INTEGER NOT NULL CHECK(declared_byte_size > 0),
  maximum_byte_size INTEGER NOT NULL CHECK(maximum_byte_size > 0),
  storage_provider TEXT NOT NULL CHECK(length(storage_provider) BETWEEN 1 AND 64),
  storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK(state IN ('pending', 'stored', 'confirmed', 'discarded')),
  stored_byte_size INTEGER CHECK(stored_byte_size IS NULL OR stored_byte_size > 0),
  stored_sha256 TEXT CHECK(stored_sha256 IS NULL OR length(stored_sha256) = 64),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, storage_key),
  CHECK((stored_byte_size IS NULL) = (stored_sha256 IS NULL)),
  CHECK(state NOT IN ('stored', 'confirmed') OR stored_sha256 IS NOT NULL),
  CHECK(state <> 'pending' OR stored_sha256 IS NULL),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.contentType') = content_type),
  CHECK(json_extract(head_json, '$.storageKey') = storage_key),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_upload_intents_uploader
  ON file_upload_intents(workspace_id, event_id, uploader_kind, uploader_id, state);

CREATE TRIGGER file_upload_intents_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, uploader_kind, uploader_id,
  purpose, storage_provider, storage_key, created_at_ms
ON file_upload_intents
BEGIN
  SELECT RAISE(ABORT, 'file upload intent identity is immutable');
END;

CREATE TABLE file_assets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  uploader_kind TEXT NOT NULL CHECK(uploader_kind IN ('operator_user', 'participant')),
  uploader_id TEXT NOT NULL CHECK(length(uploader_id) = 36),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'engagement_material', 'submission_material', 'session_material',
    'resource_share_material', 'request_fulfillment'
  )),
  display_filename TEXT NOT NULL CHECK(length(display_filename) BETWEEN 1 AND 200),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.apple.keynote', 'application/zip'
  )),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  storage_provider TEXT NOT NULL CHECK(length(storage_provider) BETWEEN 1 AND 64),
  storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 512),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('uploaded', 'pending_scan', 'available', 'blocked')),
  scan_provider TEXT NOT NULL CHECK(length(scan_provider) BETWEEN 1 AND 64),
  scan_verdict TEXT NOT NULL CHECK(scan_verdict IN ('pending', 'released', 'blocked')),
  scan_checked_at_ms INTEGER CHECK(
    scan_checked_at_ms IS NULL OR scan_checked_at_ms BETWEEN 0 AND 8640000000000000
  ),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, storage_key),
  CHECK((lifecycle = 'blocked') = (scan_verdict = 'blocked')),
  CHECK(NOT (lifecycle = 'available' AND scan_verdict = 'pending')),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.lifecycle') = lifecycle),
  CHECK(json_extract(head_json, '$.contentType') = content_type),
  CHECK(json_extract(head_json, '$.sha256') = sha256),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_assets_uploader
  ON file_assets(workspace_id, event_id, uploader_kind, uploader_id);

CREATE TRIGGER file_assets_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, uploader_kind, uploader_id, purpose,
  content_type, byte_size, sha256, storage_provider, storage_key, created_at_ms
ON file_assets
BEGIN
  SELECT RAISE(ABORT, 'file asset identity is immutable');
END;

CREATE TABLE file_attachments (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN (
    'engagement', 'submission', 'session', 'resource_share'
  )),
  subject_id TEXT NOT NULL CHECK(length(subject_id) = 36),
  content_kind TEXT NOT NULL CHECK(content_kind IN ('asset', 'link')),
  asset_id TEXT CHECK(asset_id IS NULL OR length(asset_id) = 36),
  link_provider TEXT CHECK(link_provider IS NULL OR link_provider IN ('drive', 'dropbox', 'url')),
  link_label TEXT CHECK(link_label IS NULL OR length(link_label) BETWEEN 1 AND 200),
  link_url TEXT CHECK(link_url IS NULL OR (length(link_url) <= 2048 AND link_url LIKE 'https://%')),
  attached_by_kind TEXT NOT NULL CHECK(attached_by_kind IN ('operator_user', 'participant')),
  attached_by_id TEXT NOT NULL CHECK(length(attached_by_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('attached', 'detached')),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  attached_at_ms INTEGER NOT NULL CHECK(attached_at_ms BETWEEN 0 AND 8640000000000000),
  detached_at_ms INTEGER CHECK(
    detached_at_ms IS NULL OR detached_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK((content_kind = 'asset') = (asset_id IS NOT NULL)),
  CHECK((content_kind = 'link') = (link_url IS NOT NULL)),
  CHECK((link_provider IS NULL) = (link_url IS NULL)),
  CHECK((link_label IS NULL) = (link_url IS NULL)),
  CHECK((state = 'detached') = (detached_at_ms IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, asset_id)
    REFERENCES file_assets(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_attachments_subject
  ON file_attachments(workspace_id, event_id, subject_kind, subject_id, state);

CREATE INDEX file_attachments_asset
  ON file_attachments(workspace_id, event_id, asset_id, state)
  WHERE asset_id IS NOT NULL;

CREATE TRIGGER file_attachments_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, subject_kind, subject_id, content_kind,
  asset_id, link_provider, link_label, link_url, attached_by_kind, attached_by_id,
  attached_at_ms
ON file_attachments
BEGIN
  SELECT RAISE(ABORT, 'file attachment identity is immutable');
END;

CREATE TABLE resource_shares (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  audience_kind TEXT NOT NULL CHECK(audience_kind IN ('all_confirmed', 'track', 'engagement')),
  audience_id TEXT CHECK(audience_id IS NULL OR length(audience_id) = 36),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  revoked_at_ms INTEGER CHECK(
    revoked_at_ms IS NULL OR revoked_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK((audience_kind = 'all_confirmed') = (audience_id IS NULL)),
  CHECK((state = 'revoked') = (revoked_at_ms IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER resource_shares_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, audience_kind, audience_id,
  created_by_user_id, created_at_ms
ON resource_shares
BEGIN
  SELECT RAISE(ABORT, 'resource share identity is immutable');
END;

CREATE TABLE file_requests (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  engagement_id TEXT NOT NULL CHECK(length(engagement_id) = 36),
  what TEXT NOT NULL CHECK(length(what) BETWEEN 1 AND 200),
  deadline_id TEXT CHECK(deadline_id IS NULL OR length(deadline_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('open', 'fulfilled', 'withdrawn')),
  fulfilling_attachment_id TEXT CHECK(
    fulfilling_attachment_id IS NULL OR length(fulfilling_attachment_id) = 36
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK((state = 'fulfilled') = (fulfilling_attachment_id IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, engagement_id)
    REFERENCES engagement_heads(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, deadline_id)
    REFERENCES deadlines(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, fulfilling_attachment_id)
    REFERENCES file_attachments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX file_requests_engagement
  ON file_requests(workspace_id, event_id, engagement_id, state);

CREATE TRIGGER file_requests_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, engagement_id, what, deadline_id,
  created_by_user_id, created_at_ms
ON file_requests
BEGIN
  SELECT RAISE(ABORT, 'file request identity is immutable');
END;
