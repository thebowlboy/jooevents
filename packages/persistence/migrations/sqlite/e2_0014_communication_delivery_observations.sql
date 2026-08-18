CREATE TEMP TABLE e2_0013_receipt_rebuild_validation (
  singleton_key INTEGER PRIMARY KEY CHECK(singleton_key = 1),
  source_receipt_count INTEGER NOT NULL,
  source_timeline_count INTEGER NOT NULL,
  source_timeline_join_count INTEGER NOT NULL,
  target_receipt_count INTEGER NOT NULL DEFAULT -1,
  target_timeline_count INTEGER NOT NULL DEFAULT -1,
  target_timeline_join_count INTEGER NOT NULL DEFAULT -1,
  CHECK(
    target_receipt_count = -1
    OR (
      source_receipt_count = target_receipt_count
      AND source_timeline_count = target_timeline_count
      AND source_timeline_join_count = source_timeline_count
      AND target_timeline_join_count = target_timeline_count
    )
  )
) STRICT;

INSERT INTO e2_0013_receipt_rebuild_validation (
  singleton_key,source_receipt_count,source_timeline_count,source_timeline_join_count
)
SELECT 1,
  (SELECT count(*) FROM organizer_communication_authoring_receipt_links),
  (SELECT count(*) FROM organizer_communication_authoring_timeline),
  (SELECT count(*)
     FROM organizer_communication_authoring_timeline t
     JOIN organizer_communication_authoring_receipt_links r ON r.receipt_id=t.receipt_id);

PRAGMA defer_foreign_keys = ON;

CREATE TABLE organizer_communication_authoring_receipt_links_v2 (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  operation_name TEXT NOT NULL CHECK(operation_name IN (
    'store_communication_authoring_payload',
    'create_message_draft',
    'message_template.create',
    'revise_message_batch',
    'discard_message_draft'
  )),
  operation_version INTEGER NOT NULL CHECK(operation_version = 1),
  payload_ref_id TEXT,
  draft_id TEXT,
  template_id TEXT,
  entity_version INTEGER NOT NULL CHECK(entity_version > 0),
  request_hash TEXT NOT NULL CHECK(
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK(
    (operation_name = 'store_communication_authoring_payload'
      AND payload_ref_id IS NOT NULL AND draft_id IS NULL AND template_id IS NULL
      AND entity_version = 1)
    OR
    (operation_name IN ('create_message_draft','revise_message_batch','discard_message_draft')
      AND payload_ref_id IS NULL AND draft_id IS NOT NULL AND template_id IS NULL)
    OR
    (operation_name = 'message_template.create'
      AND payload_ref_id IS NULL AND draft_id IS NULL AND template_id IS NOT NULL
      AND entity_version = 1)
  ),
  FOREIGN KEY(receipt_id) REFERENCES operation_log(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(payload_ref_id) REFERENCES communication_authoring_payloads(payload_ref_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,draft_id)
    REFERENCES communication_drafts(workspace_id,event_id,draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,template_id)
    REFERENCES message_templates(workspace_id,event_id,template_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE(payload_ref_id),
  UNIQUE(workspace_id,event_id,draft_id,entity_version),
  UNIQUE(workspace_id,event_id,template_id,entity_version),
  UNIQUE(receipt_id,workspace_id,event_id,operation_name,entity_version)
) STRICT, WITHOUT ROWID;

CREATE TABLE organizer_communication_authoring_timeline_v2 (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) = 36),
  receipt_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'operation_receipt'),
  FOREIGN KEY(receipt_id)
    REFERENCES organizer_communication_authoring_receipt_links_v2(receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

INSERT INTO organizer_communication_authoring_receipt_links_v2 (
  receipt_id,workspace_id,event_id,authority_principal_key,operation_name,
  operation_version,payload_ref_id,draft_id,template_id,entity_version,
  request_hash,occurred_at_ms
)
SELECT receipt_id,workspace_id,event_id,authority_principal_key,operation_name,
  operation_version,payload_ref_id,draft_id,NULL,entity_version,request_hash,occurred_at_ms
FROM organizer_communication_authoring_receipt_links;

INSERT INTO organizer_communication_authoring_timeline_v2 (
  timeline_id,receipt_id,occurred_at_ms,source_kind
)
SELECT timeline_id,receipt_id,occurred_at_ms,source_kind
FROM organizer_communication_authoring_timeline;

DROP TABLE organizer_communication_authoring_timeline;
DROP TABLE organizer_communication_authoring_receipt_links;
ALTER TABLE organizer_communication_authoring_receipt_links_v2
  RENAME TO organizer_communication_authoring_receipt_links;
ALTER TABLE organizer_communication_authoring_timeline_v2
  RENAME TO organizer_communication_authoring_timeline;

CREATE TRIGGER organizer_communication_authoring_receipt_payload_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.payload_ref_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_authoring_payloads p
   WHERE p.payload_ref_id = NEW.payload_ref_id
     AND p.workspace_id = NEW.workspace_id
     AND p.event_id = NEW.event_id
     AND p.owner_key = NEW.authority_principal_key
)
BEGIN SELECT RAISE(ABORT, 'organizer communication payload receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_draft_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_drafts d
   WHERE d.workspace_id = NEW.workspace_id
     AND d.event_id = NEW.event_id
     AND d.draft_id = NEW.draft_id
     AND d.owner_key = NEW.authority_principal_key
     AND d.version = NEW.entity_version
)
BEGIN SELECT RAISE(ABORT, 'organizer communication draft receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_template_scope_guard
BEFORE INSERT ON organizer_communication_authoring_receipt_links
WHEN NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM message_templates t
   WHERE t.workspace_id = NEW.workspace_id
     AND t.event_id = NEW.event_id
     AND t.template_id = NEW.template_id
)
BEGIN SELECT RAISE(ABORT, 'organizer communication template receipt scope mismatch'); END;

CREATE TRIGGER organizer_communication_authoring_receipt_links_no_update
BEFORE UPDATE ON organizer_communication_authoring_receipt_links
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring receipt links are immutable'); END;
CREATE TRIGGER organizer_communication_authoring_receipt_links_no_delete
BEFORE DELETE ON organizer_communication_authoring_receipt_links
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring receipt links are immutable'); END;
CREATE TRIGGER organizer_communication_authoring_timeline_no_update
BEFORE UPDATE ON organizer_communication_authoring_timeline
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring timeline is immutable'); END;
CREATE TRIGGER organizer_communication_authoring_timeline_no_delete
BEFORE DELETE ON organizer_communication_authoring_timeline
BEGIN SELECT RAISE(ABORT, 'organizer communication authoring timeline is immutable'); END;

UPDATE e2_0013_receipt_rebuild_validation
SET target_receipt_count = (SELECT count(*) FROM organizer_communication_authoring_receipt_links),
    target_timeline_count = (SELECT count(*) FROM organizer_communication_authoring_timeline),
    target_timeline_join_count = (
      SELECT count(*)
        FROM organizer_communication_authoring_timeline t
        JOIN organizer_communication_authoring_receipt_links r ON r.receipt_id=t.receipt_id
    )
WHERE singleton_key = 1;

DROP TABLE e2_0013_receipt_rebuild_validation;

CREATE TABLE communication_delivery_observations (
  observation_id TEXT PRIMARY KEY CHECK(length(observation_id) = 36),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  delivery_id TEXT NOT NULL,
  attempt_id TEXT,
  provider_connection_revision_id TEXT NOT NULL,
  adapter_key TEXT NOT NULL CHECK(length(adapter_key) BETWEEN 1 AND 160),
  provider_message_id TEXT,
  provider_message_fingerprint_sha256 TEXT NOT NULL CHECK(
    length(provider_message_fingerprint_sha256) = 64
    AND provider_message_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_event_key TEXT NOT NULL CHECK(length(provider_event_key) BETWEEN 1 AND 512),
  provider_event_digest_sha256 TEXT NOT NULL CHECK(
    length(provider_event_digest_sha256) = 64
    AND provider_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observation_kind TEXT NOT NULL CHECK(observation_kind IN (
    'delivered','permanent_bounce','delivery_failed'
  )),
  evidence_source TEXT NOT NULL CHECK(evidence_source IN (
    'synchronous_response','provider_lookup','verified_ingress'
  )),
  evidence_quality TEXT NOT NULL CHECK(evidence_quality IN (
    'provider_conclusive','provider_reported'
  )),
  provider_observed_at_ms INTEGER CHECK(
    provider_observed_at_ms IS NULL OR provider_observed_at_ms BETWEEN 0 AND 8640000000000000
  ),
  ingested_at_ms INTEGER NOT NULL CHECK(ingested_at_ms BETWEEN 0 AND 8640000000000000),
  safe_evidence_json TEXT NOT NULL CHECK(json_valid(safe_evidence_json)),
  raw_payload_ref_id TEXT,
  UNIQUE(provider_connection_revision_id,provider_event_key),
  UNIQUE(workspace_id,event_id,observation_id),
  FOREIGN KEY(delivery_id) REFERENCES communication_outbound_delivery_heads(delivery_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id) REFERENCES communication_outbound_delivery_attempts(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(raw_payload_ref_id) REFERENCES classified_payload_records(payload_ref_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX communication_delivery_observations_timeline
  ON communication_delivery_observations(
    delivery_id,provider_observed_at_ms,ingested_at_ms,observation_id
  );
CREATE INDEX communication_delivery_observations_attention
  ON communication_delivery_observations(
    workspace_id,event_id,observation_kind,ingested_at_ms DESC,observation_id DESC
  );

CREATE TRIGGER communication_delivery_observations_attempt_guard
BEFORE INSERT ON communication_delivery_observations
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM communication_outbound_delivery_attempts a
   WHERE a.attempt_id=NEW.attempt_id AND a.delivery_id=NEW.delivery_id
)
BEGIN SELECT RAISE(ABORT, 'communication delivery observation attempt mismatch'); END;
CREATE TRIGGER communication_delivery_observations_no_update
BEFORE UPDATE ON communication_delivery_observations
BEGIN SELECT RAISE(ABORT, 'communication delivery observations are immutable'); END;
CREATE TRIGGER communication_delivery_observations_no_delete
BEFORE DELETE ON communication_delivery_observations
BEGIN SELECT RAISE(ABORT, 'communication delivery observations are immutable'); END;

CREATE TABLE communication_address_suppression_facts (
  suppression_fact_id TEXT PRIMARY KEY CHECK(length(suppression_fact_id) = 36),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  source_event_id TEXT NOT NULL CHECK(length(source_event_id) = 36),
  address_ref_id TEXT NOT NULL,
  address_version INTEGER NOT NULL CHECK(address_version > 0),
  lookup_profile TEXT NOT NULL CHECK(length(lookup_profile) BETWEEN 1 AND 160),
  lookup_version INTEGER NOT NULL CHECK(lookup_version > 0),
  lookup_keyed_value TEXT NOT NULL CHECK(
    length(lookup_keyed_value) = 64 AND lookup_keyed_value NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK(state IN ('suppressed','clear')),
  reason TEXT NOT NULL CHECK(reason IN (
    'provider_permanent_bounce','provider_suppression','explicit_organizer_action'
  )),
  observation_id TEXT,
  attempt_id TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  safe_evidence_json TEXT NOT NULL CHECK(json_valid(safe_evidence_json)),
  UNIQUE(workspace_id,lookup_profile,lookup_version,lookup_keyed_value,suppression_fact_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,source_event_id,address_ref_id,address_version)
    REFERENCES communication_channel_address_versions(
      workspace_id,event_id,address_ref_id,address_version
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,source_event_id,observation_id)
    REFERENCES communication_delivery_observations(workspace_id,event_id,observation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id) REFERENCES communication_outbound_delivery_attempts(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(reason != 'provider_permanent_bounce'
    OR ((observation_id IS NOT NULL) <> (attempt_id IS NOT NULL)))
) STRICT;

CREATE TRIGGER communication_address_suppression_attempt_guard
BEFORE INSERT ON communication_address_suppression_facts
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM communication_outbound_delivery_attempts a
    JOIN communication_outbound_delivery_heads h ON h.delivery_id=a.delivery_id
   WHERE a.attempt_id=NEW.attempt_id
     AND h.workspace_id=NEW.workspace_id AND h.event_id=NEW.source_event_id
     AND h.channel_address_id=NEW.address_ref_id
     AND h.channel_address_version=NEW.address_version
     AND h.address_lookup_fingerprint_profile=NEW.lookup_profile
     AND h.address_lookup_fingerprint_version=NEW.lookup_version
     AND h.address_lookup_fingerprint_sha256=NEW.lookup_keyed_value
)
BEGIN SELECT RAISE(ABORT, 'communication address suppression attempt mismatch'); END;

CREATE TRIGGER communication_address_suppression_observation_guard
BEFORE INSERT ON communication_address_suppression_facts
WHEN NEW.observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM communication_delivery_observations o
    JOIN communication_outbound_delivery_heads h ON h.delivery_id=o.delivery_id
   WHERE o.observation_id=NEW.observation_id
     AND o.workspace_id=NEW.workspace_id AND o.event_id=NEW.source_event_id
     AND h.channel_address_id=NEW.address_ref_id
     AND h.channel_address_version=NEW.address_version
     AND h.address_lookup_fingerprint_profile=NEW.lookup_profile
     AND h.address_lookup_fingerprint_version=NEW.lookup_version
     AND h.address_lookup_fingerprint_sha256=NEW.lookup_keyed_value
)
BEGIN SELECT RAISE(ABORT, 'communication address suppression observation mismatch'); END;

CREATE TABLE communication_current_address_suppressions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  lookup_profile TEXT NOT NULL CHECK(length(lookup_profile) BETWEEN 1 AND 160),
  lookup_version INTEGER NOT NULL CHECK(lookup_version > 0),
  lookup_keyed_value TEXT NOT NULL CHECK(
    length(lookup_keyed_value) = 64 AND lookup_keyed_value NOT GLOB '*[^0-9a-f]*'
  ),
  current_fact_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('suppressed','clear')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,lookup_profile,lookup_version,lookup_keyed_value),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lookup_profile,lookup_version,lookup_keyed_value,current_fact_id)
    REFERENCES communication_address_suppression_facts(
      workspace_id,lookup_profile,lookup_version,lookup_keyed_value,suppression_fact_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX communication_address_suppression_facts_history
  ON communication_address_suppression_facts(
    workspace_id,lookup_profile,lookup_version,lookup_keyed_value,occurred_at_ms,suppression_fact_id
  );

CREATE TRIGGER communication_address_suppression_facts_no_update
BEFORE UPDATE ON communication_address_suppression_facts
BEGIN SELECT RAISE(ABORT, 'communication address suppression facts are immutable'); END;
CREATE TRIGGER communication_address_suppression_facts_no_delete
BEFORE DELETE ON communication_address_suppression_facts
BEGIN SELECT RAISE(ABORT, 'communication address suppression facts are immutable'); END;
CREATE TRIGGER communication_current_address_suppressions_transition_guard
BEFORE UPDATE ON communication_current_address_suppressions
WHEN NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.lookup_profile IS NOT OLD.lookup_profile
  OR NEW.lookup_version IS NOT OLD.lookup_version
  OR NEW.lookup_keyed_value IS NOT OLD.lookup_keyed_value
  OR NEW.version != OLD.version + 1
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'communication address suppression transition is invalid'); END;
CREATE TRIGGER communication_current_address_suppressions_no_delete
BEFORE DELETE ON communication_current_address_suppressions
BEGIN SELECT RAISE(ABORT, 'communication address suppression heads are retained'); END;
