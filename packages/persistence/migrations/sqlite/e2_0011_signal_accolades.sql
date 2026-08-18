CREATE TABLE signal_definition_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  key TEXT NOT NULL CHECK(
    length(key) BETWEEN 3 AND 120
    AND key GLOB '[a-z]*'
    AND key NOT GLOB '*[^a-z0-9._-]*'
  ),
  version INTEGER NOT NULL CHECK(version > 0),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120 AND label = trim(label)),
  short_label TEXT CHECK(short_label IS NULL OR (length(short_label) BETWEEN 1 AND 80 AND short_label = trim(short_label))),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 500 AND description = trim(description)),
  subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json) AND json_type(subjects_json) = 'array'),
  family TEXT NOT NULL CHECK(family IN ('quality', 'draw', 'integrity', 'logistics')),
  value_kind TEXT NOT NULL CHECK(value_kind IN ('unit_score', 'scale', 'count', 'label', 'flag', 'ref', 'json')),
  direction TEXT NOT NULL CHECK(direction IN ('higher_is_better', 'higher_is_worse', 'neutral')),
  display_json TEXT NOT NULL CHECK(json_valid(display_json) AND json_type(display_json) = 'object'),
  visibility TEXT NOT NULL CHECK(visibility IN ('organizer', 'chair', 'reviewer')),
  allowed_provenance_json TEXT NOT NULL CHECK(json_valid(allowed_provenance_json) AND json_type(allowed_provenance_json) = 'array'),
  write_caps_json TEXT CHECK(write_caps_json IS NULL OR (json_valid(write_caps_json) AND json_type(write_caps_json) = 'object')),
  policy_eligible INTEGER NOT NULL CHECK(policy_eligible IN (0, 1)),
  created_by_kind TEXT NOT NULL CHECK(created_by_kind IN ('system_seed', 'workspace_user', 'agent_action')),
  created_by_user_id TEXT CHECK(created_by_user_id IS NULL OR length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, key, version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE signal_definition_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  key TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY (workspace_id, event_id, key),
  UNIQUE (workspace_id, event_id, position),
  FOREIGN KEY (workspace_id, event_id, key, current_version)
    REFERENCES signal_definition_revisions(workspace_id, event_id, key, version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE signal_observations (
  id TEXT NOT NULL CHECK(length(id) = 36),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('submission', 'person', 'engagement')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) = 36),
  definition_key TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK(definition_version > 0),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  rationale TEXT CHECK(rationale IS NULL OR length(rationale) <= 20000),
  provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('heuristic', 'agent', 'human', 'import')),
  actor_reviewer_id TEXT CHECK(actor_reviewer_id IS NULL OR length(actor_reviewer_id) = 36),
  actor_user_id TEXT CHECK(actor_user_id IS NULL OR length(actor_user_id) = 36),
  review_plan_id TEXT CHECK(review_plan_id IS NULL OR length(review_plan_id) = 36),
  computed_at_ms INTEGER NOT NULL CHECK(computed_at_ms BETWEEN 0 AND 8640000000000000),
  supersedes_id TEXT CHECK(supersedes_id IS NULL OR length(supersedes_id) = 36),
  input_versions_json TEXT NOT NULL CHECK(json_valid(input_versions_json) AND json_type(input_versions_json) = 'object'),
  CHECK(
    (provenance_kind = 'human'
      AND actor_reviewer_id IS NOT NULL
      AND actor_user_id IS NOT NULL
      AND review_plan_id IS NOT NULL)
    OR
    (provenance_kind <> 'human'
      AND actor_reviewer_id IS NULL
      AND actor_user_id IS NULL
      AND review_plan_id IS NULL)
  ),
  CHECK(supersedes_id IS NULL OR supersedes_id <> id),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, supersedes_id),
  FOREIGN KEY (workspace_id, event_id, definition_key, definition_version)
    REFERENCES signal_definition_revisions(workspace_id, event_id, key, version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, supersedes_id)
    REFERENCES signal_observations(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE signal_observation_retractions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  observation_id TEXT NOT NULL CHECK(length(observation_id) = 36),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason = trim(reason)),
  retracted_by_user_id TEXT NOT NULL CHECK(length(retracted_by_user_id) = 36),
  retracted_at_ms INTEGER NOT NULL CHECK(retracted_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, observation_id),
  FOREIGN KEY (workspace_id, event_id, observation_id)
    REFERENCES signal_observations(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX signal_observations_current_lookup
  ON signal_observations(
    workspace_id, event_id, subject_kind, subject_id, definition_key,
    provenance_kind, actor_reviewer_id, review_plan_id, computed_at_ms, id
  );

CREATE INDEX signal_observations_actor_plan_cap
  ON signal_observations(
    workspace_id, event_id, definition_key, provenance_kind,
    actor_reviewer_id, review_plan_id, subject_id
  );

CREATE TRIGGER signal_definition_revisions_immutable
BEFORE UPDATE ON signal_definition_revisions
BEGIN SELECT RAISE(ABORT, 'signal definition revisions are immutable'); END;

CREATE TRIGGER signal_definition_revisions_retained
BEFORE DELETE ON signal_definition_revisions
BEGIN SELECT RAISE(ABORT, 'signal definition revisions are retained'); END;

CREATE TRIGGER signal_definition_heads_scope_key_immutable
BEFORE UPDATE OF workspace_id, event_id, key ON signal_definition_heads
BEGIN SELECT RAISE(ABORT, 'signal definition identity is immutable'); END;

CREATE TRIGGER signal_definition_heads_version_monotonic
BEFORE UPDATE OF current_version ON signal_definition_heads
WHEN NEW.current_version <> OLD.current_version + 1
BEGIN SELECT RAISE(ABORT, 'signal definition version must advance once'); END;

CREATE TRIGGER signal_definition_heads_retained
BEFORE DELETE ON signal_definition_heads
BEGIN SELECT RAISE(ABORT, 'signal definitions are retained'); END;

CREATE TRIGGER signal_observations_immutable
BEFORE UPDATE ON signal_observations
BEGIN SELECT RAISE(ABORT, 'signal observations are immutable'); END;

CREATE TRIGGER signal_observations_retained
BEFORE DELETE ON signal_observations
BEGIN SELECT RAISE(ABORT, 'signal observations are retained'); END;

CREATE TRIGGER signal_observation_retractions_immutable
BEFORE UPDATE ON signal_observation_retractions
BEGIN SELECT RAISE(ABORT, 'signal observation retractions are immutable'); END;

CREATE TRIGGER signal_observation_retractions_retained
BEFORE DELETE ON signal_observation_retractions
BEGIN SELECT RAISE(ABORT, 'signal observation retractions are retained'); END;

CREATE TRIGGER event_spine_scope_roots_seed_signal_accolades
AFTER INSERT ON event_spine_scope_roots
BEGIN
  INSERT INTO signal_definition_revisions (
    workspace_id, event_id, key, version, label, short_label, description,
    subjects_json, family, value_kind, direction, display_json, visibility,
    allowed_provenance_json, write_caps_json, policy_eligible,
    created_by_kind, created_by_user_id, created_at_ms
  ) VALUES
    (NEW.workspace_id, NEW.event_id, 'accolade.top_pick', 1, 'Top pick', NULL,
     'One of this reviewer''s strongest choices for the program.', '["submission"]',
     'quality', 'flag', 'neutral', '{"icon":"star","format":"Top pick"}',
     'reviewer', '["human"]', '{"perActorPerPlan":3}', 0, 'system_seed', NULL, 0),
    (NEW.workspace_id, NEW.event_id, 'accolade.hidden_gem', 1, 'Hidden gem', NULL,
     'An easy-to-miss submission this reviewer believes deserves attention.', '["submission"]',
     'quality', 'flag', 'neutral', '{"icon":"gem","format":"Hidden gem"}',
     'reviewer', '["human"]', '{"perActorPerPlan":3}', 0, 'system_seed', NULL, 0),
    (NEW.workspace_id, NEW.event_id, 'accolade.crowd_draw', 1, 'Crowd draw', NULL,
     'A submission this reviewer expects will attract a strong audience.', '["submission"]',
     'quality', 'flag', 'neutral', '{"icon":"flame","format":"Crowd draw"}',
     'reviewer', '["human"]', NULL, 0, 'system_seed', NULL, 0),
    (NEW.workspace_id, NEW.event_id, 'accolade.bold_bet', 1, 'Bold bet', NULL,
     'A distinctive submission this reviewer believes is worth taking a chance on.', '["submission"]',
     'quality', 'flag', 'neutral', '{"icon":"zap","format":"Bold bet"}',
     'reviewer', '["human"]', NULL, 0, 'system_seed', NULL, 0);
  INSERT INTO signal_definition_heads (
    workspace_id, event_id, key, current_version, status, shown, position
  ) VALUES
    (NEW.workspace_id, NEW.event_id, 'accolade.top_pick', 1, 'active', 1, 0),
    (NEW.workspace_id, NEW.event_id, 'accolade.hidden_gem', 1, 'active', 1, 1),
    (NEW.workspace_id, NEW.event_id, 'accolade.crowd_draw', 1, 'active', 1, 2),
    (NEW.workspace_id, NEW.event_id, 'accolade.bold_bet', 1, 'active', 1, 3);
END;

INSERT INTO signal_definition_revisions (
  workspace_id, event_id, key, version, label, short_label, description,
  subjects_json, family, value_kind, direction, display_json, visibility,
  allowed_provenance_json, write_caps_json, policy_eligible,
  created_by_kind, created_by_user_id, created_at_ms
)
SELECT root.workspace_id, root.event_id, seed.key, 1, seed.label, NULL,
       seed.description, '["submission"]', 'quality', 'flag', 'neutral',
       seed.display_json, 'reviewer', '["human"]', seed.write_caps_json, 0,
       'system_seed', NULL, 0
  FROM event_spine_scope_roots root
 CROSS JOIN (
   SELECT 'accolade.top_pick' AS key, 'Top pick' AS label,
          'One of this reviewer''s strongest choices for the program.' AS description,
          '{"icon":"star","format":"Top pick"}' AS display_json,
          '{"perActorPerPlan":3}' AS write_caps_json
   UNION ALL SELECT 'accolade.hidden_gem', 'Hidden gem',
          'An easy-to-miss submission this reviewer believes deserves attention.',
          '{"icon":"gem","format":"Hidden gem"}', '{"perActorPerPlan":3}'
   UNION ALL SELECT 'accolade.crowd_draw', 'Crowd draw',
          'A submission this reviewer expects will attract a strong audience.',
          '{"icon":"flame","format":"Crowd draw"}', NULL
   UNION ALL SELECT 'accolade.bold_bet', 'Bold bet',
          'A distinctive submission this reviewer believes is worth taking a chance on.',
          '{"icon":"zap","format":"Bold bet"}', NULL
 ) seed
 ORDER BY root.workspace_id, root.event_id, seed.key;

INSERT INTO signal_definition_heads (
  workspace_id, event_id, key, current_version, status, shown, position
)
SELECT root.workspace_id, root.event_id, seed.key, 1, 'active', 1, seed.position
  FROM event_spine_scope_roots root
 CROSS JOIN (
   SELECT 'accolade.top_pick' AS key, 0 AS position
   UNION ALL SELECT 'accolade.hidden_gem', 1
   UNION ALL SELECT 'accolade.crowd_draw', 2
   UNION ALL SELECT 'accolade.bold_bet', 3
 ) seed
 ORDER BY root.workspace_id, root.event_id, seed.position;
