PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE e2_0004_api_key_prefix_guard (
  existing_key_count INTEGER NOT NULL CHECK(existing_key_count = 0)
) STRICT;
INSERT INTO temp.e2_0004_api_key_prefix_guard(existing_key_count)
SELECT count(*) FROM api_keys;
DROP TABLE temp.e2_0004_api_key_prefix_guard;

CREATE TABLE api_keys_next (
  api_key_id TEXT PRIMARY KEY CHECK(length(api_key_id) = 36 AND api_key_id = lower(api_key_id)),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  token_hint TEXT NOT NULL CHECK(
    length(token_hint) = 11 AND token_hint GLOB 'jooak1_[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]'
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
  rotation_successor_id TEXT REFERENCES api_keys_next(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK(may_read = 1 OR may_submit_plans = 1),
  CHECK((standing = 'active') = (
    revoked_at_ms IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL
  )),
  CHECK(rotation_successor_id IS NULL OR rotation_successor_id <> api_key_id)
) STRICT, WITHOUT ROWID;

INSERT INTO api_keys_next (
  api_key_id, workspace_id, owner_user_id, display_name,
  token_hash_sha256, token_hint, may_read, may_submit_plans,
  created_at_ms, expires_at_ms, last_used_at_ms, standing,
  revoked_at_ms, revoked_by_user_id, revoke_reason,
  rotation_successor_id, version
)
SELECT
  api_key_id, workspace_id, owner_user_id, display_name,
  token_hash_sha256, 'jooak1_' || substr(token_hint, 7), may_read, may_submit_plans,
  created_at_ms, expires_at_ms, last_used_at_ms, standing,
  revoked_at_ms, revoked_by_user_id, revoke_reason,
  rotation_successor_id, version
FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_next RENAME TO api_keys;

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
