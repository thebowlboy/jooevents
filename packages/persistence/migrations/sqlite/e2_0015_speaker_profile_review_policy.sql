ALTER TABLE event_settings_companions
  ADD COLUMN profile_content_review INTEGER NOT NULL DEFAULT 0
  CHECK(profile_content_review IN (0, 1));

DROP TRIGGER content_approvals_no_update;
DROP TRIGGER content_approvals_no_delete;
DROP INDEX content_approvals_current;

ALTER TABLE content_approvals RENAME TO content_approvals_before_review_policy;

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
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','policy')),
  approved_by_user_id TEXT CHECK(approved_by_user_id IS NULL OR length(approved_by_user_id) = 36),
  policy_key TEXT CHECK(policy_key IS NULL OR policy_key = 'profile_content_review'),
  policy_version INTEGER CHECK(policy_version IS NULL OR policy_version = 1),
  initiated_by_user_id TEXT CHECK(initiated_by_user_id IS NULL OR length(initiated_by_user_id) = 36),
  approved_at_ms INTEGER NOT NULL CHECK(approved_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, person_id, field_key, field_revision, actor_kind),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, person_id, field_key, field_revision, field_digest_sha256)
    REFERENCES speaker_profile_field_revisions(
      workspace_id, person_id, field_key, revision, digest_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (initiated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (actor_kind = 'user'
      AND approved_by_user_id IS NOT NULL
      AND policy_key IS NULL
      AND policy_version IS NULL
      AND initiated_by_user_id IS NULL)
    OR
    (actor_kind = 'policy'
      AND approved_by_user_id IS NULL
      AND policy_key = 'profile_content_review'
      AND policy_version = 1)
  )
) STRICT, WITHOUT ROWID;

INSERT INTO content_approvals (
  workspace_id,event_id,id,person_id,field_key,field_revision,
  field_digest_sha256,actor_kind,approved_by_user_id,policy_key,
  policy_version,initiated_by_user_id,approved_at_ms
)
SELECT workspace_id,event_id,id,person_id,field_key,field_revision,
       field_digest_sha256,'user',approved_by_user_id,NULL,NULL,NULL,approved_at_ms
  FROM content_approvals_before_review_policy
 ORDER BY workspace_id,event_id,id;

DROP TABLE content_approvals_before_review_policy;

CREATE INDEX content_approvals_current
  ON content_approvals(
    workspace_id,event_id,person_id,field_key,field_revision,actor_kind
  );

CREATE TRIGGER content_approvals_no_update
BEFORE UPDATE ON content_approvals
BEGIN SELECT RAISE(ABORT, 'content approvals are immutable'); END;

CREATE TRIGGER content_approvals_no_delete
BEFORE DELETE ON content_approvals
BEGIN SELECT RAISE(ABORT, 'content approvals are immutable'); END;

WITH exact_event_people AS (
  SELECT workspace_id,event_id,person_id FROM engagement_heads
  UNION
  SELECT workspace_id,event_id,person_id FROM speaker_lineup_entries
), current_fields AS (
  SELECT p.workspace_id,p.event_id,h.person_id,h.field_key,
         h.current_revision,h.current_digest_sha256,r.created_at_ms
    FROM exact_event_people p
    JOIN speaker_profile_field_heads h
      ON h.workspace_id = p.workspace_id AND h.person_id = p.person_id
    JOIN speaker_profile_field_revisions r
      ON r.workspace_id = h.workspace_id AND r.person_id = h.person_id
     AND r.field_key = h.field_key AND r.revision = h.current_revision
     AND r.digest_sha256 = h.current_digest_sha256
)
INSERT INTO content_approvals (
  workspace_id,event_id,id,person_id,field_key,field_revision,
  field_digest_sha256,actor_kind,approved_by_user_id,policy_key,
  policy_version,initiated_by_user_id,approved_at_ms
)
SELECT f.workspace_id,f.event_id,
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) ||
       '-4' || substr(lower(hex(randomblob(2))), 2) ||
       '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       f.person_id,f.field_key,f.current_revision,f.current_digest_sha256,
       'policy',NULL,'profile_content_review',1,NULL,f.created_at_ms
  FROM current_fields f
 WHERE NOT EXISTS (
   SELECT 1 FROM content_approvals a
    WHERE a.workspace_id = f.workspace_id AND a.event_id = f.event_id
      AND a.person_id = f.person_id AND a.field_key = f.field_key
      AND a.field_revision = f.current_revision
 )
 ORDER BY f.workspace_id,f.event_id,f.person_id,f.field_key;
