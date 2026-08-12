PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  migration_id TEXT PRIMARY KEY,
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  dialect TEXT NOT NULL CHECK (dialect = 'sqlite'),
  checksum_sha256 TEXT NOT NULL
    CHECK (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_kind TEXT NOT NULL
    CHECK (receipt_kind IN ('executed', 'legacy_adoption', 'epoch_bridge')),
  source_fingerprint TEXT NOT NULL
    CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_fingerprint TEXT NOT NULL
    CHECK (length(result_fingerprint) = 64 AND result_fingerprint NOT GLOB '*[^0-9a-f]*'),
  transition_id TEXT UNIQUE,
  runner_version INTEGER NOT NULL CHECK (runner_version > 0),
  build_identity TEXT NOT NULL CHECK (length(build_identity) BETWEEN 1 AND 120),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (schema_epoch, sequence, dialect),
  CHECK (
    (receipt_kind = 'epoch_bridge' AND transition_id IS NOT NULL) OR
    (receipt_kind IN ('executed', 'legacy_adoption') AND transition_id IS NULL)
  ),
  FOREIGN KEY (transition_id) REFERENCES schema_epoch_transitions(id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE schema_epoch_transitions (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  dialect TEXT NOT NULL CHECK (dialect = 'sqlite'),
  source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  source_receipt_set_digest TEXT NOT NULL
    CHECK (length(source_receipt_set_digest) = 64 AND source_receipt_set_digest NOT GLOB '*[^0-9a-f]*'),
  source_fingerprint TEXT NOT NULL
    CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  destination_epoch INTEGER NOT NULL CHECK (destination_epoch > source_epoch),
  destination_migration_id TEXT NOT NULL,
  destination_baseline_checksum TEXT NOT NULL
    CHECK (length(destination_baseline_checksum) = 64 AND destination_baseline_checksum NOT GLOB '*[^0-9a-f]*'),
  destination_fingerprint TEXT NOT NULL
    CHECK (length(destination_fingerprint) = 64 AND destination_fingerprint NOT GLOB '*[^0-9a-f]*'),
  bridge_artifact_id TEXT NOT NULL,
  bridge_artifact_checksum TEXT NOT NULL
    CHECK (length(bridge_artifact_checksum) = 64 AND bridge_artifact_checksum NOT GLOB '*[^0-9a-f]*'),
  atomicity TEXT NOT NULL CHECK (atomicity = 'transactional'),
  verifier_set_digest TEXT NOT NULL
    CHECK (length(verifier_set_digest) = 64 AND verifier_set_digest NOT GLOB '*[^0-9a-f]*'),
  runner_version INTEGER NOT NULL CHECK (runner_version > 0),
  build_identity TEXT NOT NULL CHECK (length(build_identity) BETWEEN 1 AND 120),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (lineage_id, dialect, destination_epoch),
  FOREIGN KEY (destination_migration_id) REFERENCES schema_migrations(migration_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE database_instance_metadata (
  singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
  application_key TEXT NOT NULL CHECK (application_key = 'jooevents'),
  database_id TEXT NOT NULL UNIQUE
    CHECK (length(database_id) = 32 AND database_id NOT GLOB '*[^0-9a-f]*'),
  database_class TEXT NOT NULL
    CHECK (database_class IN ('ephemeral', 'retained_development', 'frozen_release')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  classification_changed_at INTEGER NOT NULL CHECK (classification_changed_at >= created_at)
);

CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

CREATE TRIGGER schema_epoch_transitions_no_update
BEFORE UPDATE ON schema_epoch_transitions
BEGIN
  SELECT RAISE(ABORT, 'schema_epoch_transitions is append-only');
END;

CREATE TRIGGER schema_epoch_transitions_no_delete
BEFORE DELETE ON schema_epoch_transitions
BEGIN
  SELECT RAISE(ABORT, 'schema_epoch_transitions is append-only');
END;

CREATE TRIGGER database_instance_metadata_no_delete
BEFORE DELETE ON database_instance_metadata
BEGIN
  SELECT RAISE(ABORT, 'database_instance_metadata identity is durable');
END;

CREATE TRIGGER database_instance_metadata_identity_guard
BEFORE UPDATE ON database_instance_metadata
WHEN
  NEW.singleton_key <> OLD.singleton_key OR
  NEW.application_key <> OLD.application_key OR
  NEW.database_id <> OLD.database_id OR
  NEW.created_at <> OLD.created_at OR
  NEW.classification_changed_at < OLD.classification_changed_at OR
  NOT (
    NEW.database_class = OLD.database_class OR
    (OLD.database_class = 'retained_development' AND NEW.database_class = 'frozen_release')
  )
BEGIN
  SELECT RAISE(ABORT, 'database_instance_metadata identity is immutable');
END;
