CREATE TABLE schedule_breaks (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80 AND label = trim(label)),
  day_key TEXT NOT NULL CHECK(
    length(day_key) = 10
    AND day_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(day_key, '+0 days') = day_key
  ),
  room_id TEXT NOT NULL CHECK(length(room_id) = 36),
  start_min INTEGER NOT NULL CHECK(start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK(end_min BETWEEN 1 AND 1440),
  status TEXT NOT NULL CHECK(status IN ('active', 'removed')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK(start_min < end_min),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES schedule_placement_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, room_id)
    REFERENCES program_vocabulary_rooms(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX schedule_breaks_current_grid
  ON schedule_breaks(workspace_id, event_id, day_key, room_id, start_min, end_min, id)
  WHERE status = 'active';

CREATE TRIGGER schedule_breaks_definition_immutable
BEFORE UPDATE OF workspace_id, event_id, id, label, day_key, room_id, start_min, end_min
ON schedule_breaks
BEGIN
  SELECT RAISE(ABORT, 'schedule break definition is immutable');
END;

CREATE TRIGGER schedule_breaks_version_advances_once
BEFORE UPDATE ON schedule_breaks
WHEN NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'schedule break version must advance once');
END;

CREATE TRIGGER schedule_breaks_no_delete
BEFORE DELETE ON schedule_breaks
BEGIN
  SELECT RAISE(ABORT, 'schedule break heads are retained');
END;
