DROP TRIGGER submission_triage_heads_identity_immutable;
DROP TRIGGER submission_triage_heads_version_guard;
DROP TRIGGER submission_triage_heads_no_delete;
DROP INDEX submission_triage_heads_by_state;

ALTER TABLE submission_triage_heads RENAME TO submission_triage_heads_e2_0002;

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

INSERT INTO submission_triage_heads (
  workspace_id, event_id, submission_id, head_version, state, updated_at_ms,
  head_json, head_digest_sha256
)
SELECT
  workspace_id,
  event_id,
  submission_id,
  head_version,
  CASE state WHEN 'spam' THEN 'discarded_recoverable' ELSE state END,
  updated_at_ms,
  CASE state
    WHEN 'spam' THEN (
      SELECT transformed.head_json
        FROM temp.e2_0002_submission_triage_discarded_rows AS transformed
       WHERE transformed.workspace_id = submission_triage_heads_e2_0002.workspace_id
         AND transformed.event_id = submission_triage_heads_e2_0002.event_id
         AND transformed.submission_id = submission_triage_heads_e2_0002.submission_id
    )
    ELSE head_json
  END,
  CASE state
    WHEN 'spam' THEN (
      SELECT transformed.head_digest_sha256
        FROM temp.e2_0002_submission_triage_discarded_rows AS transformed
       WHERE transformed.workspace_id = submission_triage_heads_e2_0002.workspace_id
         AND transformed.event_id = submission_triage_heads_e2_0002.event_id
         AND transformed.submission_id = submission_triage_heads_e2_0002.submission_id
    )
    ELSE head_digest_sha256
  END
FROM submission_triage_heads_e2_0002;

DROP TABLE submission_triage_heads_e2_0002;
DROP TABLE temp.e2_0002_submission_triage_discarded_rows;

CREATE INDEX submission_triage_heads_by_state
  ON submission_triage_heads(workspace_id, event_id, state, submission_id);

CREATE TRIGGER submission_triage_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, submission_id ON submission_triage_heads
BEGIN SELECT RAISE(ABORT, 'submission triage identity is immutable'); END;
CREATE TRIGGER submission_triage_heads_version_guard
BEFORE UPDATE ON submission_triage_heads
WHEN NEW.head_version != OLD.head_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'submission triage head version is invalid'); END;
CREATE TRIGGER submission_triage_heads_no_delete BEFORE DELETE ON submission_triage_heads
BEGIN SELECT RAISE(ABORT, 'submission triage heads cannot be deleted'); END;
