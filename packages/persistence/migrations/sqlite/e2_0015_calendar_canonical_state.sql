CREATE TABLE _calendar_e2_0015_validation (
  invalid INTEGER NOT NULL CHECK(invalid = 0)
) STRICT;
CREATE TRIGGER _calendar_e2_0015_validation_abort
BEFORE INSERT ON _calendar_e2_0015_validation WHEN NEW.invalid != 0
BEGIN SELECT RAISE(ABORT, 'calendar migration source authority is ambiguous or cross-scoped'); END;
INSERT INTO _calendar_e2_0015_validation(invalid)
SELECT 1 WHERE EXISTS (
  SELECT 1
    FROM sessions session, json_each(session.roster_json,'$.participants') participant
   GROUP BY session.workspace_id,session.event_id,session.id,
            json_extract(participant.value,'$.personId')
  HAVING count(*) > 1
);
INSERT INTO _calendar_e2_0015_validation(invalid)
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM sessions
   WHERE json_extract(head_json,'$.scope.workspaceId') IS NOT workspace_id
      OR json_extract(head_json,'$.scope.eventId') IS NOT event_id
  UNION ALL
  SELECT 1 FROM engagement_heads
   WHERE json_extract(head_json,'$.scope.workspaceId') IS NOT workspace_id
      OR json_extract(head_json,'$.scope.eventId') IS NOT event_id
);
DROP TRIGGER _calendar_e2_0015_validation_abort;
DROP TABLE _calendar_e2_0015_validation;

CREATE TABLE calendar_commitment_facts (
  intake_position INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL UNIQUE CHECK(length(fact_id) = 36 AND fact_id = lower(fact_id)),
  operation_log_id TEXT NOT NULL CHECK(length(operation_log_id) = 36),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 999),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  fact_kind TEXT NOT NULL CHECK(fact_kind IN (
    'occurrence_changed','engagement_changed','session_changed','room_changed','deadline_changed'
  )),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
  canonical_fact_sha256 TEXT NOT NULL CHECK(
    length(canonical_fact_sha256) = 64 AND canonical_fact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE(operation_log_id, ordinal),
  FOREIGN KEY(operation_log_id) REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX calendar_commitment_facts_pending
  ON calendar_commitment_facts(workspace_id,event_id,intake_position);

CREATE TRIGGER calendar_commitment_facts_scope_guard
BEFORE INSERT ON calendar_commitment_facts
WHEN NOT EXISTS (
  SELECT 1 FROM operation_log log
   WHERE log.id = NEW.operation_log_id
     AND log.workspace_id = NEW.workspace_id
     AND log.event_id = NEW.event_id
)
BEGIN SELECT RAISE(ABORT, 'calendar fact scope must match operation log'); END;
CREATE TRIGGER calendar_commitment_facts_no_update BEFORE UPDATE ON calendar_commitment_facts
BEGIN SELECT RAISE(ABORT, 'calendar commitment facts are immutable'); END;
CREATE TRIGGER calendar_commitment_facts_no_delete BEFORE DELETE ON calendar_commitment_facts
BEGIN SELECT RAISE(ABORT, 'calendar commitment facts are immutable'); END;

CREATE TABLE calendar_commitment_cursors (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  last_intake_position INTEGER NOT NULL CHECK(last_intake_position >= 0),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('ready','poisoned','stalled')),
  attention_code TEXT CHECK(attention_code IS NULL OR attention_code IN (
    'calendar_projection_poison_fact','calendar_projection_stalled_cursor'
  )),
  attention_fact_id TEXT CHECK(attention_fact_id IS NULL OR length(attention_fact_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id),
  CHECK((state = 'ready') = (attention_code IS NULL AND attention_fact_id IS NULL)),
  CHECK(state != 'poisoned' OR attention_fact_id IS NOT NULL),
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER calendar_commitment_cursors_scope_immutable
BEFORE UPDATE OF workspace_id,event_id ON calendar_commitment_cursors
BEGIN SELECT RAISE(ABORT, 'calendar cursor scope is immutable'); END;
CREATE TRIGGER calendar_commitment_cursors_version_advances_once
BEFORE UPDATE ON calendar_commitment_cursors WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'calendar cursor version must advance once'); END;
CREATE TRIGGER calendar_commitment_cursors_no_delete BEFORE DELETE ON calendar_commitment_cursors
BEGIN SELECT RAISE(ABORT, 'calendar cursors are retained'); END;

CREATE TABLE calendar_commitment_source_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('session','occurrence','engagement','room','deadline')),
  source_id TEXT NOT NULL CHECK(length(source_id) = 36),
  session_id TEXT CHECK(session_id IS NULL OR length(session_id) = 36),
  person_id TEXT CHECK(person_id IS NULL OR length(person_id) = 36),
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  source_state TEXT NOT NULL CHECK(source_state IN (
    'active','cleared','retired','deleted','confirmed','invited','declined','cancelled','removed',
    'draft','collecting','programmed'
  )),
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  last_intake_position INTEGER CHECK(last_intake_position IS NULL OR last_intake_position > 0),
  provenance_profile TEXT NOT NULL CHECK(provenance_profile IN (
    'calendar.migration-anchor','calendar.commitment-fact'
  )),
  provenance_version INTEGER NOT NULL CHECK(provenance_version = 1),
  PRIMARY KEY(workspace_id,event_id,source_kind,source_id),
  CHECK((provenance_profile = 'calendar.migration-anchor') = (last_intake_position IS NULL)),
  CHECK(source_kind NOT IN ('session','engagement') OR (
    json_extract(head_json,'$.scope.workspaceId') = workspace_id
    AND json_extract(head_json,'$.scope.eventId') = event_id
  )),
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(last_intake_position) REFERENCES calendar_commitment_facts(intake_position)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX calendar_commitment_source_heads_session
  ON calendar_commitment_source_heads(workspace_id,event_id,session_id,source_kind,source_id);
CREATE INDEX calendar_commitment_source_heads_person
  ON calendar_commitment_source_heads(workspace_id,event_id,person_id,session_id,source_kind,source_id)
  WHERE person_id IS NOT NULL;
CREATE TRIGGER calendar_commitment_source_heads_session_roster_unique
BEFORE INSERT ON calendar_commitment_source_heads
WHEN NEW.source_kind = 'session' AND EXISTS (
  SELECT 1 FROM json_each(NEW.head_json,'$.roster.participants') participant
   GROUP BY json_extract(participant.value,'$.personId') HAVING count(*) > 1
)
BEGIN SELECT RAISE(ABORT, 'calendar session source roster is ambiguous'); END;
CREATE TRIGGER calendar_commitment_source_heads_session_roster_unique_update
BEFORE UPDATE OF head_json ON calendar_commitment_source_heads
WHEN NEW.source_kind = 'session' AND EXISTS (
  SELECT 1 FROM json_each(NEW.head_json,'$.roster.participants') participant
   GROUP BY json_extract(participant.value,'$.personId') HAVING count(*) > 1
)
BEGIN SELECT RAISE(ABORT, 'calendar session source roster is ambiguous'); END;

CREATE TABLE calendar_commitments (
  commitment_id TEXT PRIMARY KEY CHECK(length(commitment_id) = 36 AND commitment_id = lower(commitment_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  occurrence_id TEXT NOT NULL CHECK(length(occurrence_id) = 36),
  uid TEXT NOT NULL UNIQUE CHECK(length(uid) BETWEEN 16 AND 512),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  last_dtstamp_ms INTEGER NOT NULL CHECK(last_dtstamp_ms BETWEEN 0 AND 8640000000000000),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('deliverable','embargoed','cancelled')),
  embargoed INTEGER NOT NULL CHECK(embargoed IN (0,1)),
  embargo_version INTEGER NOT NULL CHECK(embargo_version >= 0),
  session_version INTEGER NOT NULL CHECK(session_version > 0),
  engagement_version INTEGER NOT NULL CHECK(engagement_version > 0),
  occurrence_version INTEGER NOT NULL CHECK(occurrence_version > 0),
  session_title TEXT NOT NULL CHECK(length(session_title) BETWEEN 1 AND 300),
  start_at_ms INTEGER NOT NULL CHECK(start_at_ms BETWEEN 0 AND 8640000000000000),
  end_at_ms INTEGER NOT NULL CHECK(end_at_ms BETWEEN 0 AND 8640000000000000),
  room_id TEXT NOT NULL CHECK(length(room_id) = 36),
  room_name TEXT CHECK(room_name IS NULL OR length(room_name) BETWEEN 1 AND 200),
  last_projected_intake_position INTEGER CHECK(
    last_projected_intake_position IS NULL OR last_projected_intake_position > 0
  ),
  provenance_profile TEXT NOT NULL CHECK(provenance_profile IN (
    'calendar.backfill-identity','calendar.commitment-projector'
  )),
  provenance_version INTEGER NOT NULL CHECK(provenance_version = 1),
  reincarnation_generation_id TEXT,
  reincarnation_intake_position INTEGER CHECK(
    reincarnation_intake_position IS NULL OR reincarnation_intake_position > 0
  ),
  last_released_request_sha256 TEXT CHECK(
    last_released_request_sha256 IS NULL OR (
      length(last_released_request_sha256) = 64
      AND last_released_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_released_cancel_sha256 TEXT CHECK(
    last_released_cancel_sha256 IS NULL OR (
      length(last_released_cancel_sha256) = 64
      AND last_released_cancel_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  UNIQUE(workspace_id,event_id,person_id,session_id,occurrence_id),
  CHECK(start_at_ms < end_at_ms),
  CHECK((lifecycle = 'embargoed') = (embargoed = 1)),
  CHECK((provenance_profile = 'calendar.backfill-identity') = (last_projected_intake_position IS NULL)),
  CHECK((reincarnation_generation_id IS NULL) = (reincarnation_intake_position IS NULL)),
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(last_projected_intake_position) REFERENCES calendar_commitment_facts(intake_position)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX calendar_commitments_person_calendar
  ON calendar_commitments(workspace_id,event_id,person_id,start_at_ms,commitment_id);
CREATE INDEX calendar_commitments_session
  ON calendar_commitments(workspace_id,event_id,session_id,person_id,commitment_id);
CREATE INDEX calendar_commitments_occurrence
  ON calendar_commitments(workspace_id,event_id,occurrence_id,person_id,commitment_id);
CREATE INDEX calendar_commitments_room
  ON calendar_commitments(workspace_id,event_id,room_id,start_at_ms,commitment_id);

CREATE TABLE calendar_notice_generations (
  generation_id TEXT PRIMARY KEY CHECK(length(generation_id) = 36 AND generation_id = lower(generation_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  generation_number INTEGER NOT NULL CHECK(generation_number > 0),
  state TEXT NOT NULL CHECK(state IN ('open','sealed','released')),
  opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms BETWEEN 0 AND 8640000000000000),
  opened_intake_position INTEGER NOT NULL CHECK(opened_intake_position > 0),
  seal_at_ms INTEGER NOT NULL CHECK(seal_at_ms >= opened_at_ms),
  held INTEGER NOT NULL CHECK(held IN (0,1)),
  seal_reason TEXT CHECK(seal_reason IS NULL OR seal_reason IN (
    'window_expired','near_event_bypass','manual_release'
  )),
  sealed_at_ms INTEGER CHECK(sealed_at_ms IS NULL OR sealed_at_ms >= opened_at_ms),
  sealed_intake_position INTEGER CHECK(sealed_intake_position IS NULL OR sealed_intake_position > 0),
  communication_release_id TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  UNIQUE(workspace_id,event_id,person_id,generation_number),
  CHECK((state = 'open') = (seal_reason IS NULL AND sealed_at_ms IS NULL AND sealed_intake_position IS NULL)),
  CHECK((state = 'released') = (communication_release_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(opened_intake_position) REFERENCES calendar_commitment_facts(intake_position)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(sealed_intake_position) REFERENCES calendar_commitment_facts(intake_position)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX calendar_notice_generations_one_open
  ON calendar_notice_generations(workspace_id,event_id,person_id) WHERE state = 'open';
CREATE INDEX calendar_notice_generations_due
  ON calendar_notice_generations(workspace_id,event_id,state,held,seal_at_ms,generation_id);
CREATE TRIGGER calendar_notice_generations_scope_immutable
BEFORE UPDATE OF generation_id,workspace_id,event_id,person_id,generation_number,opened_at_ms,
  opened_intake_position,seal_at_ms ON calendar_notice_generations
BEGIN SELECT RAISE(ABORT, 'calendar generation identity and boundary are immutable'); END;
CREATE TRIGGER calendar_notice_generations_version_advances_once
BEFORE UPDATE ON calendar_notice_generations WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'calendar generation version must advance once'); END;
CREATE TRIGGER calendar_notice_generations_no_delete BEFORE DELETE ON calendar_notice_generations
BEGIN SELECT RAISE(ABORT, 'calendar generations are retained'); END;

CREATE TABLE calendar_notice_generation_items (
  generation_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  before_method TEXT CHECK(before_method IS NULL OR before_method IN ('REQUEST','CANCEL')),
  before_sequence INTEGER CHECK(before_sequence IS NULL OR before_sequence >= 0),
  after_method TEXT NOT NULL CHECK(after_method IN ('REQUEST','CANCEL')),
  after_sequence INTEGER NOT NULL CHECK(after_sequence >= 0),
  net_method TEXT NOT NULL CHECK(net_method IN ('REQUEST','CANCEL','NONE')),
  artifact_sha256 TEXT CHECK(
    artifact_sha256 IS NULL OR (
      length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY(generation_id,commitment_id),
  FOREIGN KEY(generation_id) REFERENCES calendar_notice_generations(generation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(commitment_id) REFERENCES calendar_commitments(commitment_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER calendar_notice_generation_items_no_update
BEFORE UPDATE ON calendar_notice_generation_items
WHEN NOT EXISTS (
  SELECT 1 FROM calendar_notice_generations generation
   WHERE generation.generation_id = OLD.generation_id AND generation.state = 'open'
)
BEGIN SELECT RAISE(ABORT, 'sealed calendar generation items are immutable'); END;
CREATE TRIGGER calendar_notice_generation_items_no_delete
BEFORE DELETE ON calendar_notice_generation_items
BEGIN SELECT RAISE(ABORT, 'calendar generation items are immutable'); END;

CREATE TABLE calendar_delivery_preferences (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  mode TEXT NOT NULL CHECK(mode IN ('invite_primary','feed_primary')),
  deadline_opt_in INTEGER NOT NULL CHECK(deadline_opt_in IN (0,1)),
  version INTEGER NOT NULL CHECK(version > 0),
  operation_log_id TEXT NOT NULL CHECK(length(operation_log_id) = 36),
  changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,person_id),
  CHECK(mode != 'invite_primary' OR deadline_opt_in = 1),
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(operation_log_id) REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER calendar_delivery_preferences_scope_immutable
BEFORE UPDATE OF workspace_id,event_id,person_id ON calendar_delivery_preferences
BEGIN SELECT RAISE(ABORT, 'calendar preference scope is immutable'); END;
CREATE TRIGGER calendar_delivery_preferences_version_advances_once
BEFORE UPDATE ON calendar_delivery_preferences WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'calendar preference version must advance once'); END;
CREATE TRIGGER calendar_delivery_preferences_no_delete
BEFORE DELETE ON calendar_delivery_preferences
BEGIN SELECT RAISE(ABORT, 'calendar preference rows are retained; reset by writing the default'); END;

CREATE TABLE calendar_feeds (
  feed_id TEXT PRIMARY KEY CHECK(length(feed_id) = 36 AND feed_id = lower(feed_id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  lookup_profile TEXT NOT NULL CHECK(length(lookup_profile) BETWEEN 1 AND 160),
  lookup_version INTEGER NOT NULL CHECK(lookup_version > 0),
  lookup_keyed_sha256 TEXT NOT NULL CHECK(
    length(lookup_keyed_sha256) = 64 AND lookup_keyed_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  rotated_at_ms INTEGER CHECK(rotated_at_ms IS NULL OR rotated_at_ms >= created_at_ms),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  UNIQUE(workspace_id,event_id,person_id),
  UNIQUE(workspace_id,lookup_profile,lookup_version,lookup_keyed_sha256),
  CHECK((state = 'revoked') = (revoked_at_ms IS NOT NULL)),
  FOREIGN KEY(workspace_id,event_id) REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX calendar_feeds_person
  ON calendar_feeds(workspace_id,event_id,person_id,state);
CREATE TRIGGER calendar_feeds_scope_immutable
BEFORE UPDATE OF feed_id,workspace_id,event_id,person_id,created_at_ms ON calendar_feeds
BEGIN SELECT RAISE(ABORT, 'calendar feed identity and scope are immutable'); END;
CREATE TRIGGER calendar_feeds_version_advances_once
BEFORE UPDATE ON calendar_feeds WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'calendar feed version must advance once'); END;
CREATE TRIGGER calendar_feeds_no_delete BEFORE DELETE ON calendar_feeds
BEGIN SELECT RAISE(ABORT, 'calendar feed heads are retained'); END;

INSERT INTO calendar_commitment_source_heads (
  workspace_id,event_id,source_kind,source_id,session_id,person_id,source_version,
  source_state,head_json,last_intake_position,provenance_profile,provenance_version
)
SELECT workspace_id,event_id,'session',id,id,NULL,version,lifecycle,head_json,NULL,
       'calendar.migration-anchor',1
  FROM sessions;

INSERT INTO calendar_commitment_source_heads (
  workspace_id,event_id,source_kind,source_id,session_id,person_id,source_version,
  source_state,head_json,last_intake_position,provenance_profile,provenance_version
)
SELECT workspace_id,event_id,'occurrence',id,session_id,NULL,version,'active',
       json_object(
         'id',id,'scope',json_object('workspaceId',workspace_id,'eventId',event_id),
         'sessionId',session_id,'roomId',room_id,'startAt',strftime('%Y-%m-%dT%H:%M:%fZ',start_at_ms/1000.0),
         'endAt',strftime('%Y-%m-%dT%H:%M:%fZ',end_at_ms/1000.0),'version',version
       ),NULL,'calendar.migration-anchor',1
  FROM schedule_occurrences;

INSERT INTO calendar_commitment_source_heads (
  workspace_id,event_id,source_kind,source_id,session_id,person_id,source_version,
  source_state,head_json,last_intake_position,provenance_profile,provenance_version
)
SELECT workspace_id,event_id,'engagement',id,session_id,person_id,version,state,head_json,NULL,
       'calendar.migration-anchor',1
  FROM engagement_heads;

INSERT INTO calendar_commitment_source_heads (
  workspace_id,event_id,source_kind,source_id,session_id,person_id,source_version,
  source_state,head_json,last_intake_position,provenance_profile,provenance_version
)
SELECT workspace_id,event_id,'room',id,NULL,NULL,version,status,
       json_object('id',id,'name',name,'status',status,'version',version),NULL,
       'calendar.migration-anchor',1
  FROM program_vocabulary_rooms;

INSERT INTO calendar_commitments (
  commitment_id,workspace_id,event_id,person_id,session_id,occurrence_id,uid,sequence,
  last_dtstamp_ms,lifecycle,embargoed,embargo_version,session_version,engagement_version,
  occurrence_version,session_title,start_at_ms,end_at_ms,room_id,room_name,
  last_projected_intake_position,provenance_profile,provenance_version
)
SELECT lower(
         substr(replace(e.person_id,'-',''),1,8) || '-' ||
         substr(replace(s.id,'-',''),-4) || '-5' ||
         substr(replace(o.id,'-',''),-3) || '-a' ||
         substr(replace(e.person_id,'-',''),-3) || '-' ||
         substr(replace(s.id,'-',''),-6) || substr(replace(o.id,'-',''),-6)
       ),
       s.workspace_id,s.event_id,e.person_id,s.id,o.id,
       'urn:uuid:' || lower(
         substr(replace(e.person_id,'-',''),1,8) || '-' ||
         substr(replace(s.id,'-',''),-4) || '-5' ||
         substr(replace(o.id,'-',''),-3) || '-a' ||
         substr(replace(e.person_id,'-',''),-3) || '-' ||
         substr(replace(s.id,'-',''),-6) || substr(replace(o.id,'-',''),-6)
       ),
       0,CAST(unixepoch() * 1000 AS INTEGER),'deliverable',0,0,
       s.version,e.version,o.version,s.title,o.start_at_ms,o.end_at_ms,
       o.room_id,r.name,NULL,'calendar.backfill-identity',1
  FROM sessions s
  JOIN engagement_heads e
    ON e.workspace_id=s.workspace_id AND e.event_id=s.event_id
   AND e.session_id=s.id AND e.state='confirmed'
  JOIN json_each(s.roster_json,'$.participants') participant
    ON json_extract(participant.value,'$.personId')=e.person_id
  JOIN schedule_occurrences o
    ON o.workspace_id=s.workspace_id AND o.event_id=s.event_id AND o.session_id=s.id
  JOIN program_vocabulary_rooms r
    ON r.workspace_id=o.workspace_id AND r.event_id=o.event_id AND r.id=o.room_id
 ORDER BY s.workspace_id,s.event_id,e.person_id,s.id,o.id;
