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
