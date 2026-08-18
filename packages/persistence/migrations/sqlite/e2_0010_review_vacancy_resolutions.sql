CREATE TABLE review_assignment_vacancy_resolutions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  vacated_assignment_id TEXT NOT NULL CHECK(length(vacated_assignment_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('replacement', 'coverage_accepted')),
  replacement_assignment_id TEXT CHECK(replacement_assignment_id IS NULL OR length(replacement_assignment_id) = 36),
  replacement_reviewer_id TEXT CHECK(replacement_reviewer_id IS NULL OR length(replacement_reviewer_id) = 36),
  resolved_by_user_id TEXT NOT NULL CHECK(length(resolved_by_user_id) = 36),
  resolved_at_ms INTEGER NOT NULL CHECK(resolved_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, vacated_assignment_id),
  UNIQUE (workspace_id, event_id, replacement_assignment_id),
  FOREIGN KEY (workspace_id, event_id, vacated_assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, event_id, replacement_assignment_id, replacement_reviewer_id
  ) REFERENCES review_assignments(workspace_id, event_id, id, reviewer_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (kind = 'replacement' AND replacement_assignment_id IS NOT NULL AND replacement_reviewer_id IS NOT NULL)
    OR (kind = 'coverage_accepted' AND replacement_assignment_id IS NULL AND replacement_reviewer_id IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX review_assignments_vacancy_resolution_reference
  ON review_assignments(workspace_id, event_id, id, reviewer_id);

CREATE TRIGGER review_assignment_vacancy_resolutions_immutable
BEFORE UPDATE ON review_assignment_vacancy_resolutions
BEGIN SELECT RAISE(ABORT, 'review vacancy resolutions are immutable'); END;

CREATE TRIGGER review_assignment_vacancy_resolutions_retained
BEFORE DELETE ON review_assignment_vacancy_resolutions
BEGIN SELECT RAISE(ABORT, 'review vacancy resolutions are retained'); END;
