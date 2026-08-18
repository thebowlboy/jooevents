CREATE TABLE workspace_people (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  registered_at_ms INTEGER NOT NULL CHECK(registered_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, person_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_people_no_update
BEFORE UPDATE ON workspace_people
BEGIN SELECT RAISE(ABORT, 'workspace Person identity is immutable'); END;

CREATE TRIGGER workspace_people_no_delete
BEFORE DELETE ON workspace_people
BEGIN SELECT RAISE(ABORT, 'workspace People are retained'); END;

INSERT INTO workspace_people (workspace_id, person_id, registered_at_ms)
SELECT workspace_id, person_id, MIN(first_seen_at_ms)
  FROM (
    SELECT workspace_id, person_id, minted_at_ms AS first_seen_at_ms
      FROM participant_identity_family
    UNION ALL
    SELECT workspace_id, person_id, invited_at_ms
      FROM engagement_heads
    UNION ALL
    SELECT workspace_id, person_id, updated_at_ms
      FROM task_assignments
    UNION ALL
    SELECT workspace_id, person_id, 0
      FROM intake_submission_participant_evidence
    UNION ALL
    SELECT workspace_id, person_id, 0
      FROM speaker_lineup_entries
  ) exact_people
 GROUP BY workspace_id, person_id
 ORDER BY workspace_id, person_id;

CREATE TABLE speaker_profile_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, person_id),
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES workspace_people(workspace_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER speaker_profile_heads_identity_immutable
BEFORE UPDATE OF workspace_id, person_id ON speaker_profile_heads
BEGIN SELECT RAISE(ABORT, 'speaker profile identity is immutable'); END;

CREATE TRIGGER speaker_profile_heads_version_advances_once
BEFORE UPDATE OF version ON speaker_profile_heads
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker profile version must advance once'); END;

CREATE TRIGGER speaker_profile_heads_no_delete
BEFORE DELETE ON speaker_profile_heads
BEGIN SELECT RAISE(ABORT, 'speaker profiles are retained'); END;

CREATE TABLE speaker_profile_field_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  field_key TEXT NOT NULL CHECK(field_key IN ('headline','biography','location','links')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, person_id, field_key, revision),
  UNIQUE (workspace_id, person_id, field_key, revision, digest_sha256),
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES speaker_profile_heads(workspace_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (field_key IN ('headline','biography','location') AND json_type(value_json) = 'text')
    OR (field_key = 'links' AND json_type(value_json) = 'array')
  )
) STRICT, WITHOUT ROWID;

CREATE TRIGGER speaker_profile_field_revisions_no_update
BEFORE UPDATE ON speaker_profile_field_revisions
BEGIN SELECT RAISE(ABORT, 'speaker profile field revisions are immutable'); END;

CREATE TRIGGER speaker_profile_field_revisions_no_delete
BEFORE DELETE ON speaker_profile_field_revisions
BEGIN SELECT RAISE(ABORT, 'speaker profile field revisions are immutable'); END;

CREATE TABLE speaker_profile_field_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  field_key TEXT NOT NULL CHECK(field_key IN ('headline','biography','location','links')),
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  current_digest_sha256 TEXT NOT NULL CHECK(
    length(current_digest_sha256) = 64 AND current_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, person_id, field_key),
  FOREIGN KEY (workspace_id, person_id)
    REFERENCES speaker_profile_heads(workspace_id, person_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, person_id, field_key, current_revision, current_digest_sha256)
    REFERENCES speaker_profile_field_revisions(
      workspace_id, person_id, field_key, revision, digest_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER speaker_profile_field_heads_identity_immutable
BEFORE UPDATE OF workspace_id, person_id, field_key ON speaker_profile_field_heads
BEGIN SELECT RAISE(ABORT, 'speaker profile field identity is immutable'); END;

CREATE TRIGGER speaker_profile_field_heads_revision_advances_once
BEFORE UPDATE OF current_revision ON speaker_profile_field_heads
WHEN NEW.current_revision <> OLD.current_revision + 1
BEGIN SELECT RAISE(ABORT, 'speaker profile field revision must advance once'); END;

CREATE TRIGGER speaker_profile_field_heads_no_delete
BEFORE DELETE ON speaker_profile_field_heads
BEGIN SELECT RAISE(ABORT, 'speaker profile field heads are retained'); END;

CREATE TABLE content_approvals (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  field_key TEXT NOT NULL CHECK(field_key IN ('headline','biography','location','links')),
  field_revision INTEGER NOT NULL CHECK(field_revision > 0),
  field_digest_sha256 TEXT NOT NULL CHECK(
    length(field_digest_sha256) = 64 AND field_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  approved_by_user_id TEXT NOT NULL CHECK(length(approved_by_user_id) = 36),
  approved_at_ms INTEGER NOT NULL CHECK(approved_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, person_id, field_key, field_revision),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, person_id, field_key, field_revision, field_digest_sha256)
    REFERENCES speaker_profile_field_revisions(
      workspace_id, person_id, field_key, revision, digest_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX content_approvals_current
  ON content_approvals(workspace_id, event_id, person_id, field_key, field_revision);

CREATE TRIGGER content_approvals_no_update
BEFORE UPDATE ON content_approvals
BEGIN SELECT RAISE(ABORT, 'content approvals are immutable'); END;

CREATE TRIGGER content_approvals_no_delete
BEFORE DELETE ON content_approvals
BEGIN SELECT RAISE(ABORT, 'content approvals are immutable'); END;
