CREATE TABLE session_participant_supports (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  support_kind TEXT NOT NULL CHECK(support_kind IN ('submission', 'editorial')),
  support_key TEXT NOT NULL CHECK(length(support_key) BETWEEN 1 AND 700),
  support_json TEXT NOT NULL CHECK(json_valid(support_json) AND json_type(support_json) = 'object'),
  PRIMARY KEY (workspace_id, event_id, session_id, person_id, support_kind, support_key),
  CHECK(json_extract(support_json, '$.schemaVersion') = 1),
  CHECK(json_extract(support_json, '$.scope.workspaceId') = workspace_id),
  CHECK(json_extract(support_json, '$.scope.eventId') = event_id),
  CHECK(json_extract(support_json, '$.sessionId') = session_id),
  CHECK(json_extract(support_json, '$.personId') = person_id),
  CHECK(json_extract(support_json, '$.kind') = support_kind),
  CHECK(
    (support_kind = 'submission'
      AND json_type(support_json, '$.submissionId') = 'text'
      AND json_extract(support_json, '$.submissionId') = support_key
      AND length(json_extract(support_json, '$.submissionId')) = 36
      AND json_type(support_json, '$.source') IS NULL)
    OR
    (support_kind = 'editorial'
      AND json_type(support_json, '$.submissionId') IS NULL
      AND json_type(support_json, '$.source') = 'object'
      AND json_type(support_json, '$.source.kind') = 'text'
      AND json_extract(support_json, '$.source.kind') <> 'submission'
      AND json_type(support_json, '$.source.id') = 'text'
      AND json_type(support_json, '$.source.version') = 'integer'
      AND json_extract(support_json, '$.source.version') > 0
      AND support_key = json(json_extract(support_json, '$.source')))
  ),
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX session_participant_supports_source
  ON session_participant_supports(
    workspace_id, event_id, support_kind, support_key, session_id, person_id
  );

CREATE TRIGGER session_participant_supports_no_update
BEFORE UPDATE ON session_participant_supports
BEGIN
  SELECT RAISE(ABORT, 'session participant support is immutable');
END;

INSERT INTO session_participant_supports (
  workspace_id, event_id, session_id, person_id, support_kind, support_key, support_json
)
SELECT origin.workspace_id,
       origin.event_id,
       origin.session_id,
       evidence.person_id,
       'submission',
       origin.submission_id,
       json_object(
         'kind', 'submission',
         'personId', evidence.person_id,
         'schemaVersion', 1,
         'scope', json_object(
           'eventId', origin.event_id,
           'workspaceId', origin.workspace_id
         ),
         'sessionId', origin.session_id,
         'submissionId', origin.submission_id
       )
  FROM submission_session_origins origin
  JOIN intake_submission_participant_evidence evidence
    ON evidence.workspace_id = origin.workspace_id
   AND evidence.event_id = origin.event_id
   AND evidence.submission_id = origin.submission_id
 ORDER BY origin.workspace_id, origin.event_id, origin.session_id,
          evidence.person_id, origin.submission_id;

INSERT INTO session_participant_supports (
  workspace_id, event_id, session_id, person_id, support_kind, support_key, support_json
)
SELECT session.workspace_id,
       session.event_id,
       session.id,
       json_extract(participant.value, '$.personId'),
       'editorial',
       json(json_extract(participant.value, '$.source')),
       json_object(
         'kind', 'editorial',
         'personId', json_extract(participant.value, '$.personId'),
         'schemaVersion', 1,
         'scope', json_object(
           'eventId', session.event_id,
           'workspaceId', session.workspace_id
         ),
         'sessionId', session.id,
         'source', json(json_extract(participant.value, '$.source'))
       )
  FROM sessions session, json_each(session.roster_json, '$.participants') participant
 WHERE json_extract(participant.value, '$.source.kind') <> 'submission'
 GROUP BY session.workspace_id, session.event_id, session.id,
          json_extract(participant.value, '$.personId'),
          json(json_extract(participant.value, '$.source'))
 ORDER BY session.workspace_id, session.event_id, session.id,
          json_extract(participant.value, '$.personId'),
          json(json_extract(participant.value, '$.source'));
