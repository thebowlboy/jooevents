CREATE TABLE speaker_lineup_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE speaker_lineup_categories (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32 AND name = trim(name)),
  accent TEXT NOT NULL CHECK(accent IN ('lavender', 'sea', 'neutral')),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  position INTEGER NOT NULL CHECK(position >= 0),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, position),
  UNIQUE (workspace_id, event_id, name COLLATE NOCASE),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES speaker_lineup_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE speaker_lineup_entries (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  position INTEGER NOT NULL CHECK(position >= 0),
  category_id TEXT,
  publicly_visible INTEGER NOT NULL CHECK(publicly_visible IN (0, 1)),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, person_id),
  UNIQUE (workspace_id, event_id, position),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES speaker_lineup_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, category_id)
    REFERENCES speaker_lineup_categories(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX speaker_lineup_entries_category
  ON speaker_lineup_entries(workspace_id, event_id, category_id, position, person_id);

CREATE TRIGGER speaker_lineup_sets_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON speaker_lineup_sets
BEGIN SELECT RAISE(ABORT, 'speaker lineup scope is immutable'); END;

CREATE TRIGGER speaker_lineup_sets_version_monotonic
BEFORE UPDATE OF version ON speaker_lineup_sets
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker lineup version must advance once'); END;

CREATE TRIGGER speaker_lineup_categories_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON speaker_lineup_categories
BEGIN SELECT RAISE(ABORT, 'speaker lineup category identity is immutable'); END;

CREATE TRIGGER speaker_lineup_categories_version_monotonic
BEFORE UPDATE OF version ON speaker_lineup_categories
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker lineup category version must advance once'); END;

CREATE TRIGGER speaker_lineup_categories_no_delete
BEFORE DELETE ON speaker_lineup_categories
BEGIN SELECT RAISE(ABORT, 'speaker lineup categories are retained'); END;

CREATE TRIGGER speaker_lineup_entries_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, person_id ON speaker_lineup_entries
BEGIN SELECT RAISE(ABORT, 'speaker lineup entry identity is immutable'); END;

CREATE TRIGGER speaker_lineup_entries_version_monotonic
BEFORE UPDATE OF version ON speaker_lineup_entries
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker lineup entry version must advance once'); END;

CREATE TRIGGER event_spine_scope_roots_create_speaker_lineup
AFTER INSERT ON event_spine_scope_roots
BEGIN
  INSERT INTO speaker_lineup_sets(workspace_id, event_id, version)
  VALUES (NEW.workspace_id, NEW.event_id, 1);
END;

INSERT INTO speaker_lineup_sets (workspace_id, event_id, version)
SELECT workspace_id, event_id, 1
  FROM event_spine_scope_roots
 ORDER BY workspace_id, event_id;

WITH distinct_people AS (
  SELECT workspace_id, event_id, person_id, MIN(invited_at_ms) AS first_invited_at_ms
    FROM engagement_heads
   GROUP BY workspace_id, event_id, person_id
), ordered_people AS (
  SELECT workspace_id, event_id, person_id,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, event_id
           ORDER BY first_invited_at_ms, person_id COLLATE BINARY
         ) - 1 AS position
    FROM distinct_people
)
INSERT INTO speaker_lineup_entries (
  workspace_id, event_id, person_id, position, category_id, publicly_visible, version
)
SELECT people.workspace_id, people.event_id, people.person_id, people.position, NULL,
       CASE WHEN EXISTS (
         SELECT 1
           FROM sessions session, json_each(session.roster_json, '$.participants') participant
          WHERE session.workspace_id = people.workspace_id
            AND session.event_id = people.event_id
            AND json_extract(participant.value, '$.personId') = people.person_id
            AND json_extract(participant.value, '$.publiclyVisible') = 1
       ) THEN 1 ELSE 0 END,
       1
  FROM ordered_people people
 ORDER BY people.workspace_id, people.event_id, people.position;
