CREATE TABLE session_program_reference_slots (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  slot_kind TEXT NOT NULL CHECK(slot_kind IN ('format', 'track')),
  item_id TEXT NOT NULL CHECK(length(item_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, session_id, slot_kind),
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX session_program_reference_slots_item
  ON session_program_reference_slots(workspace_id, event_id, slot_kind, item_id, session_id);

INSERT INTO session_program_reference_slots
  (workspace_id, event_id, session_id, slot_kind, item_id, version)
SELECT workspace_id, event_id, id, 'format', format_id, 1
  FROM sessions
 ORDER BY workspace_id, event_id, id;

INSERT INTO session_program_reference_slots
  (workspace_id, event_id, session_id, slot_kind, item_id, version)
SELECT workspace_id, event_id, id, 'track', track_id, 1
  FROM sessions
 WHERE track_id IS NOT NULL
 ORDER BY workspace_id, event_id, id;

CREATE TRIGGER session_program_reference_slots_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, session_id, slot_kind
  ON session_program_reference_slots
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot identity is immutable');
END;

CREATE TRIGGER session_program_reference_slots_version_monotonic
BEFORE UPDATE ON session_program_reference_slots
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot versions advance by one');
END;

CREATE TRIGGER session_program_reference_slots_insert_matches_head
BEFORE INSERT ON session_program_reference_slots
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.workspace_id = NEW.workspace_id AND s.event_id = NEW.event_id
     AND s.id = NEW.session_id
     AND ((NEW.slot_kind = 'format' AND s.format_id = NEW.item_id)
       OR (NEW.slot_kind = 'track' AND s.track_id = NEW.item_id))
)
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot must match its head');
END;

CREATE TRIGGER session_program_reference_slots_update_matches_head
BEFORE UPDATE OF item_id ON session_program_reference_slots
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.workspace_id = NEW.workspace_id AND s.event_id = NEW.event_id
     AND s.id = NEW.session_id
     AND ((NEW.slot_kind = 'format' AND s.format_id = NEW.item_id)
       OR (NEW.slot_kind = 'track' AND s.track_id = NEW.item_id))
)
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot must match its head');
END;

CREATE TRIGGER session_program_reference_slots_delete_follows_head
BEFORE DELETE ON session_program_reference_slots
WHEN EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.workspace_id = OLD.workspace_id AND s.event_id = OLD.event_id
     AND s.id = OLD.session_id
     AND ((OLD.slot_kind = 'format' AND s.format_id = OLD.item_id)
       OR (OLD.slot_kind = 'track' AND s.track_id = OLD.item_id))
)
BEGIN
  SELECT RAISE(ABORT, 'current session program reference slot cannot be deleted');
END;

CREATE TRIGGER sessions_program_reference_slots_after_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_program_reference_slots
    (workspace_id, event_id, session_id, slot_kind, item_id, version)
  VALUES (NEW.workspace_id, NEW.event_id, NEW.id, 'format', NEW.format_id, 1);
  INSERT INTO session_program_reference_slots
    (workspace_id, event_id, session_id, slot_kind, item_id, version)
  SELECT NEW.workspace_id, NEW.event_id, NEW.id, 'track', NEW.track_id, 1
   WHERE NEW.track_id IS NOT NULL;
END;

CREATE TRIGGER sessions_program_reference_format_after_update
AFTER UPDATE OF format_id ON sessions
WHEN NEW.format_id <> OLD.format_id
BEGIN
  UPDATE session_program_reference_slots
     SET item_id = NEW.format_id, version = version + 1
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND session_id = NEW.id AND slot_kind = 'format' AND item_id = OLD.format_id;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'session format reference slot is corrupt') END;
END;

CREATE TRIGGER sessions_program_reference_track_after_update
AFTER UPDATE OF track_id ON sessions
WHEN NEW.track_id IS NOT OLD.track_id
BEGIN
  DELETE FROM session_program_reference_slots
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND session_id = NEW.id AND slot_kind = 'track' AND NEW.track_id IS NULL;
  SELECT CASE WHEN NEW.track_id IS NULL AND changes() <> 1
    THEN RAISE(ABORT, 'session track reference slot is corrupt') END;
  UPDATE session_program_reference_slots
     SET item_id = NEW.track_id, version = version + 1
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND session_id = NEW.id AND slot_kind = 'track'
     AND OLD.track_id IS NOT NULL AND NEW.track_id IS NOT NULL;
  SELECT CASE WHEN OLD.track_id IS NOT NULL AND NEW.track_id IS NOT NULL AND changes() <> 1
    THEN RAISE(ABORT, 'session track reference slot is corrupt') END;
  INSERT INTO session_program_reference_slots
    (workspace_id, event_id, session_id, slot_kind, item_id, version)
  SELECT NEW.workspace_id, NEW.event_id, NEW.id, 'track', NEW.track_id, 1
   WHERE OLD.track_id IS NULL AND NEW.track_id IS NOT NULL;
END;
