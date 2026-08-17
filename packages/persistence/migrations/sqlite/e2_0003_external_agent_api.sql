CREATE TABLE api_keys (
  api_key_id TEXT PRIMARY KEY CHECK(length(api_key_id) = 36 AND api_key_id = lower(api_key_id)),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  token_hint TEXT NOT NULL CHECK(
    length(token_hint) = 10 AND token_hint GLOB 'joak1_[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]'
  ),
  may_read INTEGER NOT NULL CHECK(may_read IN (0, 1)),
  may_submit_plans INTEGER NOT NULL CHECK(may_submit_plans IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
  last_used_at_ms INTEGER CHECK(last_used_at_ms IS NULL OR last_used_at_ms >= created_at_ms),
  standing TEXT NOT NULL CHECK(standing IN ('active', 'revoked')),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  revoked_by_user_id TEXT REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revoke_reason TEXT CHECK(revoke_reason IS NULL OR revoke_reason IN (
    'rotated', 'owner_request', 'admin_request', 'security'
  )),
  rotation_successor_id TEXT REFERENCES api_keys(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK(may_read = 1 OR may_submit_plans = 1),
  CHECK((standing = 'active') = (
    revoked_at_ms IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL
  )),
  CHECK(rotation_successor_id IS NULL OR rotation_successor_id <> api_key_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX api_keys_workspace_owner_created
  ON api_keys(workspace_id, owner_user_id, created_at_ms DESC, api_key_id);
CREATE INDEX api_keys_workspace_standing_expiry
  ON api_keys(workspace_id, standing, expires_at_ms, api_key_id);

CREATE TRIGGER api_keys_identity_immutable
BEFORE UPDATE ON api_keys
WHEN NEW.api_key_id IS NOT OLD.api_key_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.display_name IS NOT OLD.display_name
  OR NEW.token_hash_sha256 IS NOT OLD.token_hash_sha256
  OR NEW.token_hint IS NOT OLD.token_hint
  OR NEW.may_read IS NOT OLD.may_read
  OR NEW.may_submit_plans IS NOT OLD.may_submit_plans
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'api key identity is immutable'); END;

CREATE TRIGGER api_keys_transition_guard
BEFORE UPDATE ON api_keys
WHEN NEW.version <> OLD.version + 1
  OR NEW.expires_at_ms > OLD.expires_at_ms
  OR NEW.last_used_at_ms < OLD.last_used_at_ms
  OR (OLD.standing = 'revoked' AND (
    NEW.standing IS NOT OLD.standing
    OR NEW.revoked_at_ms IS NOT OLD.revoked_at_ms
    OR NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id
    OR NEW.revoke_reason IS NOT OLD.revoke_reason
  ))
  OR (OLD.rotation_successor_id IS NOT NULL
    AND NEW.rotation_successor_id IS NOT OLD.rotation_successor_id)
BEGIN SELECT RAISE(ABORT, 'api key transition is invalid'); END;

CREATE TRIGGER api_keys_no_delete
BEFORE DELETE ON api_keys
BEGIN SELECT RAISE(ABORT, 'api keys are retained'); END;

CREATE TABLE api_key_permission_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  permission_id TEXT NOT NULL CHECK(length(permission_id) BETWEEN 1 AND 120),
  PRIMARY KEY(api_key_id, permission_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER api_key_permission_scopes_no_update
BEFORE UPDATE ON api_key_permission_scopes
BEGIN SELECT RAISE(ABORT, 'api key permission scopes are immutable'); END;
CREATE TRIGGER api_key_permission_scopes_no_delete
BEFORE DELETE ON api_key_permission_scopes
BEGIN SELECT RAISE(ABORT, 'api key permission scopes are immutable'); END;

CREATE TABLE api_key_event_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY(api_key_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER api_key_event_scopes_no_update
BEFORE UPDATE ON api_key_event_scopes
BEGIN SELECT RAISE(ABORT, 'api key event scopes are immutable'); END;
CREATE TRIGGER api_key_event_scopes_no_delete
BEFORE DELETE ON api_key_event_scopes
BEGIN SELECT RAISE(ABORT, 'api key event scopes are immutable'); END;

CREATE TABLE external_api_rate_limit_heads (
  scope_key TEXT PRIMARY KEY CHECK(length(scope_key) BETWEEN 1 AND 200),
  window_started_at_ms INTEGER NOT NULL CHECK(window_started_at_ms BETWEEN 0 AND 8640000000000000),
  window_ms INTEGER NOT NULL CHECK(window_ms BETWEEN 1000 AND 86400000),
  request_count INTEGER NOT NULL CHECK(request_count > 0),
  version INTEGER NOT NULL CHECK(version > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE external_api_inflight_leases (
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 200),
  lease_id TEXT NOT NULL CHECK(length(lease_id) = 36),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(scope_key, lease_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX external_api_inflight_expiry
  ON external_api_inflight_leases(scope_key, expires_at_ms);

CREATE TABLE external_api_idempotency_receipts (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  endpoint_key TEXT NOT NULL CHECK(length(endpoint_key) BETWEEN 1 AND 120),
  key_verifier_sha256 TEXT NOT NULL CHECK(
    length(key_verifier_sha256) = 64 AND key_verifier_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash_sha256 TEXT NOT NULL CHECK(
    length(request_hash_sha256) = 64 AND request_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json) = 'object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(owner_user_id, endpoint_key, key_verifier_sha256)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER external_api_idempotency_receipts_no_update
BEFORE UPDATE ON external_api_idempotency_receipts
BEGIN SELECT RAISE(ABORT, 'external API idempotency receipts are immutable'); END;
CREATE TRIGGER external_api_idempotency_receipts_no_delete
BEFORE DELETE ON external_api_idempotency_receipts
BEGIN SELECT RAISE(ABORT, 'external API idempotency receipts are immutable'); END;
