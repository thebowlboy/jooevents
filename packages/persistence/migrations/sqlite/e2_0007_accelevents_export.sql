CREATE TABLE accelevents_export_configuration (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND id = lower(id)),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36 AND workspace_id = lower(workspace_id)),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36 AND event_id = lower(event_id)),
  selected_release_id TEXT CHECK(
    selected_release_id IS NULL OR
    (length(selected_release_id) = 36 AND selected_release_id = lower(selected_release_id))
  ),
  session_type TEXT CHECK(session_type IS NULL OR session_type IN ('IN_PERSON', 'VIRTUAL', 'HYBRID')),
  format_mappings_json TEXT NOT NULL DEFAULT '{"items":[],"schemaVersion":1}' CHECK(
    json_valid(format_mappings_json)
    AND json_type(format_mappings_json) = 'object'
    AND json_extract(format_mappings_json, '$.schemaVersion') = 1
    AND json_type(format_mappings_json, '$.items') = 'array'
  ),
  speaker_names_json TEXT NOT NULL DEFAULT '{"items":[],"schemaVersion":1}' CHECK(
    json_valid(speaker_names_json)
    AND json_type(speaker_names_json) = 'object'
    AND json_extract(speaker_names_json, '$.schemaVersion') = 1
    AND json_type(speaker_names_json, '$.items') = 'array'
  ),
  room_bindings_json TEXT NOT NULL DEFAULT '{"items":[],"schemaVersion":1}' CHECK(
    json_valid(room_bindings_json)
    AND json_type(room_bindings_json) = 'object'
    AND json_extract(room_bindings_json, '$.schemaVersion') = 1
    AND json_type(room_bindings_json, '$.items') = 'array'
  ),
  primary_speakers_json TEXT NOT NULL DEFAULT '{"items":[],"schemaVersion":1}' CHECK(
    json_valid(primary_speakers_json)
    AND json_type(primary_speakers_json) = 'object'
    AND json_extract(primary_speakers_json, '$.schemaVersion') = 1
    AND json_type(primary_speakers_json, '$.items') = 'array'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36 AND updated_by_user_id = lower(updated_by_user_id)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, selected_release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

-- Supports the configuration read/save guard by exact event scope and enforces one mutable head per event.
CREATE UNIQUE INDEX accelevents_export_configuration_by_event
  ON accelevents_export_configuration(workspace_id, event_id);

CREATE TRIGGER accelevents_export_configuration_identity_immutable
BEFORE UPDATE OF id, workspace_id, event_id ON accelevents_export_configuration
BEGIN
  SELECT RAISE(ABORT, 'Accelevents export configuration identity is immutable');
END;

CREATE TRIGGER accelevents_export_configuration_version_monotonic
BEFORE UPDATE ON accelevents_export_configuration
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'Accelevents export configuration versions advance by one');
END;

CREATE TRIGGER accelevents_export_configuration_no_delete
BEFORE DELETE ON accelevents_export_configuration
BEGIN
  SELECT RAISE(ABORT, 'Accelevents export configurations are retained');
END;
