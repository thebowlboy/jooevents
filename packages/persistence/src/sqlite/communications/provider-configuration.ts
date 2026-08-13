import type { Database } from 'bun:sqlite';
import {
  emailProviderConnectionDraftInputSchema,
  emailProviderConnectionProjectionSchema,
  emailProviderConnectionRevisionAppendInputSchema,
  emailProviderReadinessCheckInputSchema,
  emailProviderReadinessCheckProjectionSchema,
  emailRoutingPolicyDraftInputSchema,
  emailRoutingPolicyProjectionSchema,
  emailRoutingPolicyRevisionAppendInputSchema,
  emailSenderProfileDraftInputSchema,
  emailSenderProfileProjectionSchema,
  emailSenderProfileRevisionAppendInputSchema,
  organizerCommunicationSafeEvidenceRefSchema,
  type EmailProviderConnectionDraftInput,
  type EmailProviderConnectionProjection,
  type EmailProviderReadinessCheckInput,
  type EmailProviderReadinessCheckProjection,
  type EmailRoutingPolicyDraftInput,
  type EmailRoutingPolicyProjection,
  type EmailRoutingPolicyRevisionAppendInput,
  type EmailSenderProfileDraftInput,
  type EmailSenderProfileProjection,
  type EmailSenderProfileRevisionAppendInput
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';

/** Additive disposable schema. It is intentionally not a retained migration. */
export const SQLITE_EMAIL_PROVIDER_CONFIGURATION_SQL = `
CREATE TABLE email_provider_connections (
  connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 240),
  adapter_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','verifying','active_outbound','draining','retired')),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_connection_revisions (
  revision_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  adapter_key TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
  manifest_digest_sha256 TEXT NOT NULL CHECK(length(manifest_digest_sha256) = 64),
  config_digest_sha256 TEXT NOT NULL CHECK(length(config_digest_sha256) = 64),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, revision_number),
  UNIQUE (connection_id, revision_id),
  FOREIGN KEY (connection_id) REFERENCES email_provider_connections(connection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_connection_secret_refs (
  revision_id TEXT NOT NULL,
  requirement_key TEXT NOT NULL,
  secret_store_key TEXT NOT NULL,
  secret_reference TEXT NOT NULL,
  PRIMARY KEY (revision_id, requirement_key),
  FOREIGN KEY (revision_id) REFERENCES email_provider_connection_revisions(revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE email_sender_profiles (
  sender_profile_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','active','archived')),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, profile_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_sender_profile_revisions (
  revision_id TEXT PRIMARY KEY,
  sender_profile_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (sender_profile_id, revision_number),
  UNIQUE (sender_profile_id, revision_id),
  FOREIGN KEY (sender_profile_id) REFERENCES email_sender_profiles(sender_profile_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_routing_policies (
  routing_policy_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','active','archived')),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, policy_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_routing_policy_revisions (
  revision_id TEXT PRIMARY KEY,
  routing_policy_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (routing_policy_id, revision_number),
  UNIQUE (routing_policy_id, revision_id),
  FOREIGN KEY (routing_policy_id) REFERENCES email_routing_policies(routing_policy_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_readiness_checks (
  readiness_check_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  connection_revision_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability = 'transactional_outbound'),
  check_key TEXT NOT NULL,
  request_digest_sha256 TEXT NOT NULL CHECK(length(request_digest_sha256) = 64),
  expected_config_digest_sha256 TEXT NOT NULL CHECK(length(expected_config_digest_sha256) = 64),
  claimed_head_version INTEGER NOT NULL CHECK(claimed_head_version > 0),
  state TEXT NOT NULL CHECK(state IN ('checking','passed','failed')),
  projection_json TEXT NOT NULL CHECK(json_valid(projection_json) AND json_type(projection_json) = 'object'),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (connection_id, connection_revision_id)
    REFERENCES email_provider_connection_revisions(connection_id, revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE email_provider_readiness_heads (
  connection_revision_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability = 'transactional_outbound'),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  latest_check_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_revision_id, capability),
  FOREIGN KEY (connection_revision_id) REFERENCES email_provider_connection_revisions(revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (latest_check_id) REFERENCES email_provider_readiness_checks(readiness_check_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX email_provider_connections_by_workspace
  ON email_provider_connections(workspace_id, lifecycle, connection_id);

CREATE TRIGGER email_provider_connection_revision_no_update
BEFORE UPDATE ON email_provider_connection_revisions
BEGIN SELECT RAISE(ABORT, 'email provider revisions are immutable'); END;
CREATE TRIGGER email_provider_connection_revision_no_delete
BEFORE DELETE ON email_provider_connection_revisions
BEGIN SELECT RAISE(ABORT, 'email provider revisions are immutable'); END;
CREATE TRIGGER email_provider_connection_secret_ref_no_update
BEFORE UPDATE ON email_provider_connection_secret_refs
BEGIN SELECT RAISE(ABORT, 'email provider secret references are immutable'); END;
CREATE TRIGGER email_provider_connection_secret_ref_no_delete
BEFORE DELETE ON email_provider_connection_secret_refs
BEGIN SELECT RAISE(ABORT, 'email provider secret references are immutable'); END;
CREATE TRIGGER email_provider_connection_head_guard
BEFORE UPDATE ON email_provider_connections
WHEN NEW.connection_id != OLD.connection_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.adapter_key != OLD.adapter_key OR NEW.created_at != OLD.created_at
  OR NEW.head_version != OLD.head_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email provider connection head transition is invalid'); END;
CREATE TRIGGER email_provider_connection_pointer_guard
BEFORE UPDATE OF current_revision_id ON email_provider_connections
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM email_provider_connection_revisions r
  WHERE r.connection_id = NEW.connection_id AND r.revision_id = NEW.current_revision_id
)
BEGIN SELECT RAISE(ABORT, 'email provider current pointer is invalid'); END;
CREATE TRIGGER email_provider_connection_no_delete
BEFORE DELETE ON email_provider_connections
BEGIN SELECT RAISE(ABORT, 'email provider connections cannot be deleted'); END;

CREATE TRIGGER email_sender_profile_revision_no_update BEFORE UPDATE ON email_sender_profile_revisions
BEGIN SELECT RAISE(ABORT, 'email sender revisions are immutable'); END;
CREATE TRIGGER email_sender_profile_revision_no_delete BEFORE DELETE ON email_sender_profile_revisions
BEGIN SELECT RAISE(ABORT, 'email sender revisions are immutable'); END;
CREATE TRIGGER email_sender_profile_head_guard BEFORE UPDATE ON email_sender_profiles
WHEN NEW.sender_profile_id != OLD.sender_profile_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.profile_key != OLD.profile_key OR NEW.created_at != OLD.created_at
  OR NEW.head_version != OLD.head_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email sender profile head transition is invalid'); END;
CREATE TRIGGER email_sender_profile_pointer_guard
BEFORE UPDATE OF current_revision_id ON email_sender_profiles
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM email_sender_profile_revisions r
  WHERE r.sender_profile_id = NEW.sender_profile_id AND r.revision_id = NEW.current_revision_id
)
BEGIN SELECT RAISE(ABORT, 'email sender current pointer is invalid'); END;
CREATE TRIGGER email_sender_profile_no_delete BEFORE DELETE ON email_sender_profiles
BEGIN SELECT RAISE(ABORT, 'email sender profiles cannot be deleted'); END;
CREATE TRIGGER email_routing_policy_revision_no_update BEFORE UPDATE ON email_routing_policy_revisions
BEGIN SELECT RAISE(ABORT, 'email routing revisions are immutable'); END;
CREATE TRIGGER email_routing_policy_revision_no_delete BEFORE DELETE ON email_routing_policy_revisions
BEGIN SELECT RAISE(ABORT, 'email routing revisions are immutable'); END;
CREATE TRIGGER email_routing_policy_head_guard BEFORE UPDATE ON email_routing_policies
WHEN NEW.routing_policy_id != OLD.routing_policy_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.policy_key != OLD.policy_key OR NEW.created_at != OLD.created_at
  OR NEW.head_version != OLD.head_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email routing policy head transition is invalid'); END;
CREATE TRIGGER email_routing_policy_pointer_guard
BEFORE UPDATE OF current_revision_id ON email_routing_policies
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM email_routing_policy_revisions r
  WHERE r.routing_policy_id = NEW.routing_policy_id AND r.revision_id = NEW.current_revision_id
)
BEGIN SELECT RAISE(ABORT, 'email routing current pointer is invalid'); END;
CREATE TRIGGER email_routing_policy_no_delete BEFORE DELETE ON email_routing_policies
BEGIN SELECT RAISE(ABORT, 'email routing policies cannot be deleted'); END;

CREATE TRIGGER email_provider_readiness_check_identity_guard
BEFORE UPDATE ON email_provider_readiness_checks
WHEN NEW.readiness_check_id != OLD.readiness_check_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.connection_revision_id != OLD.connection_revision_id
  OR NEW.capability != OLD.capability
  OR NEW.check_key != OLD.check_key
  OR NEW.request_digest_sha256 != OLD.request_digest_sha256
  OR NEW.expected_config_digest_sha256 != OLD.expected_config_digest_sha256
  OR NEW.claimed_head_version != OLD.claimed_head_version
  OR NEW.started_at != OLD.started_at
  OR OLD.state != 'checking' OR NEW.state = 'checking'
BEGIN SELECT RAISE(ABORT, 'email provider readiness transition is invalid'); END;
CREATE TRIGGER email_provider_readiness_check_no_delete BEFORE DELETE ON email_provider_readiness_checks
BEGIN SELECT RAISE(ABORT, 'email provider readiness checks cannot be deleted'); END;
CREATE TRIGGER email_provider_readiness_head_guard
BEFORE UPDATE ON email_provider_readiness_heads
WHEN NEW.connection_revision_id != OLD.connection_revision_id
  OR NEW.capability != OLD.capability
  OR NEW.head_version != OLD.head_version + 1
  OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'email provider readiness head transition is invalid'); END;
CREATE TRIGGER email_provider_readiness_head_no_delete BEFORE DELETE ON email_provider_readiness_heads
BEGIN SELECT RAISE(ABORT, 'email provider readiness heads cannot be deleted'); END;
`;

export type SQLiteEmailProviderConfigurationErrorCode =
  | 'id_collision'
  | 'stale_head'
  | 'not_found'
  | 'data_corrupt'
  | 'readiness_result_lost';

export class SQLiteEmailProviderConfigurationError extends Error {
  constructor(readonly code: SQLiteEmailProviderConfigurationErrorCode) {
    super(code);
    this.name = 'SQLiteEmailProviderConfigurationError';
  }
}

interface ConnectionRow {
  connection_id: string; workspace_id: string; display_name: string; adapter_key: string;
  lifecycle: string; head_version: number; current_revision_id: string | null;
  created_at: string; updated_at: string;
}
interface RevisionJsonRow { revision_json: string }
interface SenderRow {
  sender_profile_id: string; workspace_id: string; profile_key: string; state: string;
  head_version: number; current_revision_id: string | null; created_at: string; updated_at: string;
}
interface RoutingRow {
  routing_policy_id: string; workspace_id: string; policy_key: string; state: string;
  head_version: number; current_revision_id: string | null; created_at: string; updated_at: string;
}
interface ReadinessRow {
  readiness_check_id: string; request_digest_sha256: string; claimed_head_version: number;
  state: string; projection_json: string;
}
interface ReadinessHeadRow { head_version: number; latest_check_id: string }
interface ConnectionRevisionFenceRow { connection_id: string; config_digest_sha256: string }

function parseCanonicalJson<T>(text: string, parse: (value: unknown) => T): T {
  try {
    const value = parse(JSON.parse(text));
    if (canonicalJsonText(value) !== text) throw new TypeError();
    return value;
  } catch {
    throw new SQLiteEmailProviderConfigurationError('data_corrupt');
  }
}

function atomically<T>(sqlite: Database, callback: () => T): T {
  return sqlite.inTransaction ? callback() : sqlite.transaction(callback).immediate();
}

function mapConstraint(error: unknown): never {
  if (error instanceof SQLiteEmailProviderConfigurationError) throw error;
  throw new SQLiteEmailProviderConfigurationError('id_collision');
}

export function installSQLiteEmailProviderConfigurationSchema(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON');
  atomically(sqlite, () => sqlite.exec(SQLITE_EMAIL_PROVIDER_CONFIGURATION_SQL));
}

/**
 * Stores only safe projections plus opaque classified/secret references. Configuration
 * payloads and secret values never enter these tables.
 */
export class SQLiteEmailProviderConfigurationRepository {
  constructor(private readonly sqlite: Database) {}

  createConnection(raw: EmailProviderConnectionDraftInput): EmailProviderConnectionProjection {
    const input = emailProviderConnectionDraftInputSchema.parse(raw);
    try {
      atomically(this.sqlite, () => {
        this.sqlite.query(`INSERT INTO email_provider_connections (
          connection_id, workspace_id, display_name, adapter_key, lifecycle, head_version,
          current_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', 1, NULL, ?, ?)`).run(
          input.connectionId, input.workspaceId, input.displayName, input.adapterKey,
          input.createdAt, input.createdAt
        );
        this.insertConnectionRevision(input, 1);
      });
    } catch (error) { mapConstraint(error); }
    return this.requireConnection(input.connectionId);
  }

  appendConnectionRevision(
    raw: EmailProviderConnectionDraftInput & { expectedHeadVersion: number }
  ): EmailProviderConnectionProjection {
    const input = emailProviderConnectionRevisionAppendInputSchema.parse(raw);
    atomically(this.sqlite, () => {
      const row = this.sqlite.query<ConnectionRow, [string]>(`
        SELECT * FROM email_provider_connections WHERE connection_id = ?
      `).get(input.connectionId);
      if (row === null) throw new SQLiteEmailProviderConfigurationError('not_found');
      if (
        row.head_version !== input.expectedHeadVersion
        || row.workspace_id !== input.workspaceId
        || row.display_name !== input.displayName
        || row.adapter_key !== input.adapterKey
      ) throw new SQLiteEmailProviderConfigurationError('stale_head');
      try {
        this.insertConnectionRevision(input, row.head_version + 1);
        const updated = this.sqlite.query(`UPDATE email_provider_connections
          SET head_version = ?, updated_at = ?
          WHERE connection_id = ? AND head_version = ?`).run(
          row.head_version + 1, input.createdAt, input.connectionId, row.head_version
        );
        if (updated.changes !== 1) throw new SQLiteEmailProviderConfigurationError('stale_head');
      } catch (error) { mapConstraint(error); }
    });
    return this.requireConnection(input.connectionId);
  }

  getConnection(connectionId: string): EmailProviderConnectionProjection | null {
    const row = this.sqlite.query<ConnectionRow, [string]>(`
      SELECT * FROM email_provider_connections WHERE connection_id = ?
    `).get(connectionId);
    return row === null ? null : this.connectionProjection(row);
  }

  requireConnection(connectionId: string): EmailProviderConnectionProjection {
    const value = this.getConnection(connectionId);
    if (value === null) throw new SQLiteEmailProviderConfigurationError('not_found');
    return value;
  }

  listConnections(workspaceId: string): readonly EmailProviderConnectionProjection[] {
    return Object.freeze(this.sqlite.query<ConnectionRow, [string]>(`
      SELECT * FROM email_provider_connections WHERE workspace_id = ? ORDER BY connection_id
    `).all(workspaceId).map((row) => this.connectionProjection(row)));
  }

  createSenderProfile(raw: EmailSenderProfileDraftInput): EmailSenderProfileProjection {
    const input = emailSenderProfileDraftInputSchema.parse(raw);
    try {
      atomically(this.sqlite, () => {
        this.sqlite.query(`INSERT INTO email_sender_profiles (
          sender_profile_id, workspace_id, profile_key, state, head_version,
          current_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'draft', 1, NULL, ?, ?)`).run(
          input.senderProfileId, input.workspaceId, input.profileKey, input.createdAt, input.createdAt
        );
        this.sqlite.query(`INSERT INTO email_sender_profile_revisions (
          revision_id, sender_profile_id, revision_number, revision_json, created_at
        ) VALUES (?, ?, 1, ?, ?)`).run(
          input.revision.revisionId, input.senderProfileId,
          canonicalJsonText(input.revision), input.createdAt
        );
      });
    } catch (error) { mapConstraint(error); }
    return this.requireSenderProfile(input.senderProfileId);
  }

  appendSenderProfileRevision(
    raw: EmailSenderProfileRevisionAppendInput
  ): EmailSenderProfileProjection {
    const input = emailSenderProfileRevisionAppendInputSchema.parse(raw);
    atomically(this.sqlite, () => {
      const row = this.sqlite.query<SenderRow, [string]>(`
        SELECT * FROM email_sender_profiles WHERE sender_profile_id = ?
      `).get(input.senderProfileId);
      if (row === null) throw new SQLiteEmailProviderConfigurationError('not_found');
      if (
        row.workspace_id !== input.workspaceId
        || row.profile_key !== input.profileKey
        || row.head_version !== input.expectedHeadVersion
      ) throw new SQLiteEmailProviderConfigurationError('stale_head');
      try {
        this.sqlite.query(`INSERT INTO email_sender_profile_revisions (
          revision_id, sender_profile_id, revision_number, revision_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`).run(
          input.revision.revisionId, input.senderProfileId, input.revision.revisionNumber,
          canonicalJsonText(input.revision), input.appendedAt
        );
        const updated = this.sqlite.query(`UPDATE email_sender_profiles
          SET head_version = ?, updated_at = ?
          WHERE sender_profile_id = ? AND head_version = ?`).run(
          input.expectedHeadVersion + 1, input.appendedAt,
          input.senderProfileId, input.expectedHeadVersion
        );
        if (updated.changes !== 1) {
          throw new SQLiteEmailProviderConfigurationError('stale_head');
        }
      } catch (error) { mapConstraint(error); }
    });
    return this.requireSenderProfile(input.senderProfileId);
  }

  getSenderProfile(senderProfileId: string): EmailSenderProfileProjection | null {
    const row = this.sqlite.query<SenderRow, [string]>(`
      SELECT * FROM email_sender_profiles WHERE sender_profile_id = ?
    `).get(senderProfileId);
    if (row === null) return null;
    const revisions = this.sqlite.query<RevisionJsonRow, [string]>(`
      SELECT revision_json FROM email_sender_profile_revisions
      WHERE sender_profile_id = ? ORDER BY revision_number
    `).all(senderProfileId).map((item) => parseCanonicalJson(
      item.revision_json, (value) => emailSenderProfileDraftInputSchema.shape.revision.parse(value)
    ));
    return emailSenderProfileProjectionSchema.parse({
      schemaVersion: 1, senderProfileId: row.sender_profile_id, workspaceId: row.workspace_id,
      profileKey: row.profile_key, state: row.state, headVersion: row.head_version,
      currentRevisionId: row.current_revision_id, candidateRevisions: revisions,
      createdAt: row.created_at, updatedAt: row.updated_at
    });
  }

  requireSenderProfile(senderProfileId: string): EmailSenderProfileProjection {
    const value = this.getSenderProfile(senderProfileId);
    if (value === null) throw new SQLiteEmailProviderConfigurationError('not_found');
    return value;
  }

  createRoutingPolicy(raw: EmailRoutingPolicyDraftInput): EmailRoutingPolicyProjection {
    const input = emailRoutingPolicyDraftInputSchema.parse(raw);
    try {
      atomically(this.sqlite, () => {
        this.sqlite.query(`INSERT INTO email_routing_policies (
          routing_policy_id, workspace_id, policy_key, state, head_version,
          current_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'draft', 1, NULL, ?, ?)`).run(
          input.routingPolicyId, input.workspaceId, input.policyKey, input.createdAt, input.createdAt
        );
        this.sqlite.query(`INSERT INTO email_routing_policy_revisions (
          revision_id, routing_policy_id, revision_number, revision_json, created_at
        ) VALUES (?, ?, 1, ?, ?)`).run(
          input.revision.revisionId, input.routingPolicyId,
          canonicalJsonText(input.revision), input.createdAt
        );
      });
    } catch (error) { mapConstraint(error); }
    return this.requireRoutingPolicy(input.routingPolicyId);
  }

  appendRoutingPolicyRevision(
    raw: EmailRoutingPolicyRevisionAppendInput
  ): EmailRoutingPolicyProjection {
    const input = emailRoutingPolicyRevisionAppendInputSchema.parse(raw);
    atomically(this.sqlite, () => {
      const row = this.sqlite.query<RoutingRow, [string]>(`
        SELECT * FROM email_routing_policies WHERE routing_policy_id = ?
      `).get(input.routingPolicyId);
      if (row === null) throw new SQLiteEmailProviderConfigurationError('not_found');
      if (
        row.workspace_id !== input.workspaceId
        || row.policy_key !== input.policyKey
        || row.head_version !== input.expectedHeadVersion
      ) throw new SQLiteEmailProviderConfigurationError('stale_head');
      try {
        this.sqlite.query(`INSERT INTO email_routing_policy_revisions (
          revision_id, routing_policy_id, revision_number, revision_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`).run(
          input.revision.revisionId, input.routingPolicyId, input.revision.revisionNumber,
          canonicalJsonText(input.revision), input.appendedAt
        );
        const updated = this.sqlite.query(`UPDATE email_routing_policies
          SET head_version = ?, updated_at = ?
          WHERE routing_policy_id = ? AND head_version = ?`).run(
          input.expectedHeadVersion + 1, input.appendedAt,
          input.routingPolicyId, input.expectedHeadVersion
        );
        if (updated.changes !== 1) {
          throw new SQLiteEmailProviderConfigurationError('stale_head');
        }
      } catch (error) { mapConstraint(error); }
    });
    return this.requireRoutingPolicy(input.routingPolicyId);
  }

  getRoutingPolicy(routingPolicyId: string): EmailRoutingPolicyProjection | null {
    const row = this.sqlite.query<RoutingRow, [string]>(`
      SELECT * FROM email_routing_policies WHERE routing_policy_id = ?
    `).get(routingPolicyId);
    if (row === null) return null;
    const revisions = this.sqlite.query<RevisionJsonRow, [string]>(`
      SELECT revision_json FROM email_routing_policy_revisions
      WHERE routing_policy_id = ? ORDER BY revision_number
    `).all(routingPolicyId).map((item) => parseCanonicalJson(
      item.revision_json, (value) => emailRoutingPolicyDraftInputSchema.shape.revision.parse(value)
    ));
    return emailRoutingPolicyProjectionSchema.parse({
      schemaVersion: 1, routingPolicyId: row.routing_policy_id, workspaceId: row.workspace_id,
      policyKey: row.policy_key, state: row.state, headVersion: row.head_version,
      currentRevisionId: row.current_revision_id, candidateRevisions: revisions,
      createdAt: row.created_at, updatedAt: row.updated_at
    });
  }

  requireRoutingPolicy(routingPolicyId: string): EmailRoutingPolicyProjection {
    const value = this.getRoutingPolicy(routingPolicyId);
    if (value === null) throw new SQLiteEmailProviderConfigurationError('not_found');
    return value;
  }

  beginReadinessCheck(
    raw: EmailProviderReadinessCheckInput,
    startedAt: string
  ): EmailProviderReadinessCheckProjection {
    const input = emailProviderReadinessCheckInputSchema.parse(raw);
    return atomically(this.sqlite, () => {
      const existing = this.sqlite.query<ReadinessRow, [string]>(`
        SELECT readiness_check_id, request_digest_sha256, claimed_head_version, state,
          projection_json FROM email_provider_readiness_checks WHERE readiness_check_id = ?
      `).get(input.readinessCheckId);
      if (existing !== null) {
        if (existing.request_digest_sha256 !== input.requestDigestSha256) {
          throw new SQLiteEmailProviderConfigurationError('id_collision');
        }
        return this.parseReadiness(existing.projection_json);
      }
      const revision = this.sqlite.query<ConnectionRevisionFenceRow, [string]>(`
        SELECT connection_id, config_digest_sha256
        FROM email_provider_connection_revisions WHERE revision_id = ?
      `).get(input.connectionRevisionId);
      if (revision === null) throw new SQLiteEmailProviderConfigurationError('not_found');
      if (
        revision.connection_id !== input.connectionId
        || revision.config_digest_sha256 !== input.expectedConfigDigestSha256
      ) throw new SQLiteEmailProviderConfigurationError('stale_head');
      const prior = this.sqlite.query<ReadinessHeadRow, [string, string]>(`
        SELECT head_version, latest_check_id FROM email_provider_readiness_heads
        WHERE connection_revision_id = ? AND capability = ?
      `).get(input.connectionRevisionId, input.capability);
      const claimedHeadVersion = (prior?.head_version ?? 0) + 1;
      const projection = emailProviderReadinessCheckProjectionSchema.parse({
        schemaVersion: 1,
        readinessCheckId: input.readinessCheckId,
        connectionId: input.connectionId,
        connectionRevisionId: input.connectionRevisionId,
        capability: input.capability,
        checkKey: input.checkKey,
        state: 'checking', readiness: null, evidence: null, validUntil: null,
        startedAt, completedAt: null
      });
      try {
        this.sqlite.query(`INSERT INTO email_provider_readiness_checks (
          readiness_check_id, connection_id, connection_revision_id, capability, check_key,
          request_digest_sha256, expected_config_digest_sha256, claimed_head_version,
          state, projection_json, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'checking', ?, ?, NULL)`).run(
          input.readinessCheckId, input.connectionId, input.connectionRevisionId,
          input.capability, input.checkKey, input.requestDigestSha256,
          input.expectedConfigDigestSha256, claimedHeadVersion,
          canonicalJsonText(projection), startedAt
        );
        if (prior === null) {
          this.sqlite.query(`INSERT INTO email_provider_readiness_heads (
            connection_revision_id, capability, head_version, latest_check_id, updated_at
          ) VALUES (?, ?, 1, ?, ?)`).run(
            input.connectionRevisionId, input.capability, input.readinessCheckId, startedAt
          );
        } else {
          const updated = this.sqlite.query(`UPDATE email_provider_readiness_heads
            SET head_version = ?, latest_check_id = ?, updated_at = ?
            WHERE connection_revision_id = ? AND capability = ? AND head_version = ?`).run(
            claimedHeadVersion, input.readinessCheckId, startedAt,
            input.connectionRevisionId, input.capability, prior.head_version
          );
          if (updated.changes !== 1) {
            throw new SQLiteEmailProviderConfigurationError('stale_head');
          }
        }
      } catch (error) { mapConstraint(error); }
      return projection;
    });
  }

  completeReadinessCheck(input: Readonly<{
    readinessCheckId: string;
    readiness: 'ready' | 'degraded' | 'blocked';
    evidence: NonNullable<EmailProviderReadinessCheckProjection['evidence']>;
    validUntil: number | null;
    completedAt: string;
  }>): EmailProviderReadinessCheckProjection {
    const evidence = organizerCommunicationSafeEvidenceRefSchema.parse(input.evidence);
    return atomically(this.sqlite, () => {
      const row = this.sqlite.query<ReadinessRow, [string]>(`
        SELECT readiness_check_id, request_digest_sha256, claimed_head_version, state,
          projection_json FROM email_provider_readiness_checks WHERE readiness_check_id = ?
      `).get(input.readinessCheckId);
      if (row === null) throw new SQLiteEmailProviderConfigurationError('not_found');
      const current = this.parseReadiness(row.projection_json);
      if (current.state !== 'checking') return current;
      const head = this.sqlite.query<ReadinessHeadRow, [string, string]>(`
        SELECT head_version, latest_check_id FROM email_provider_readiness_heads
        WHERE connection_revision_id = ? AND capability = ?
      `).get(current.connectionRevisionId, current.capability);
      if (
        head === null || head.latest_check_id !== current.readinessCheckId
        || head.head_version !== row.claimed_head_version
      ) throw new SQLiteEmailProviderConfigurationError('readiness_result_lost');
      const projection = emailProviderReadinessCheckProjectionSchema.parse({
        ...current,
        state: input.readiness === 'blocked' ? 'failed' : 'passed',
        readiness: input.readiness,
        evidence,
        validUntil: input.validUntil,
        completedAt: input.completedAt
      });
      const updated = this.sqlite.query(`UPDATE email_provider_readiness_checks
        SET state = ?, projection_json = ?, completed_at = ?
        WHERE readiness_check_id = ? AND state = 'checking'`).run(
        projection.state, canonicalJsonText(projection), input.completedAt, input.readinessCheckId
      );
      if (updated.changes !== 1) {
        throw new SQLiteEmailProviderConfigurationError('readiness_result_lost');
      }
      return projection;
    });
  }

  listLatestChecks(connectionRevisionId: string): readonly EmailProviderReadinessCheckProjection[] {
    return Object.freeze(this.sqlite.query<{ projection_json: string }, [string]>(`
      SELECT c.projection_json
      FROM email_provider_readiness_heads h
      JOIN email_provider_readiness_checks c ON c.readiness_check_id = h.latest_check_id
      WHERE h.connection_revision_id = ? ORDER BY h.capability
    `).all(connectionRevisionId).map((row) => this.parseReadiness(row.projection_json)));
  }

  private insertConnectionRevision(
    input: EmailProviderConnectionDraftInput,
    revisionNumber: number
  ): void {
    const supplied = new Set(input.secretReferences.map((item) => item.key));
    const revision = emailProviderConnectionProjectionSchema.shape.candidateRevisions.element.parse({
      revisionId: input.revisionId,
      connectionId: input.connectionId,
      revisionNumber,
      adapterKey: input.adapterKey,
      adapterVersion: input.adapterVersion,
      setupManifestKey: input.manifest.manifestKey,
      setupManifestVersion: input.manifest.manifestVersion,
      setupManifestDigestSha256: input.manifest.manifestDigestSha256,
      configSchemaVersion: input.configSchemaVersion,
      configRef: input.configRef,
      secretRequirements: [...input.manifest.requiredSecretReferences]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((requirement) => ({ key: requirement.key, configured: supplied.has(requirement.key) })),
      configDigestSha256: input.configDigestSha256,
      callbacks: { state: 'not_supported' },
      inbound: { state: 'not_enabled' },
      createdAt: input.createdAt
    });
    this.sqlite.query(`INSERT INTO email_provider_connection_revisions (
      revision_id, connection_id, revision_number, adapter_key, adapter_version,
      manifest_key, manifest_version, manifest_digest_sha256, config_digest_sha256,
      revision_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.revisionId, input.connectionId, revisionNumber, input.adapterKey, input.adapterVersion,
      input.manifest.manifestKey, input.manifest.manifestVersion,
      input.manifest.manifestDigestSha256, input.configDigestSha256,
      canonicalJsonText(revision), input.createdAt
    );
    const insertSecret = this.sqlite.query(`INSERT INTO email_provider_connection_secret_refs (
      revision_id, requirement_key, secret_store_key, secret_reference
    ) VALUES (?, ?, ?, ?)`);
    for (const secret of input.secretReferences) {
      insertSecret.run(input.revisionId, secret.key, secret.secretStoreKey, secret.secretReference);
    }
  }

  private connectionProjection(row: ConnectionRow): EmailProviderConnectionProjection {
    const revisions = this.sqlite.query<RevisionJsonRow, [string]>(`
      SELECT revision_json FROM email_provider_connection_revisions
      WHERE connection_id = ? ORDER BY revision_number
    `).all(row.connection_id).map((item) => parseCanonicalJson(
      item.revision_json,
      (value) => emailProviderConnectionProjectionSchema.shape.candidateRevisions.element.parse(value)
    ));
    return emailProviderConnectionProjectionSchema.parse({
      schemaVersion: 1,
      connectionId: row.connection_id,
      workspaceId: row.workspace_id,
      displayName: row.display_name,
      adapterKey: row.adapter_key,
      lifecycle: row.lifecycle,
      headVersion: row.head_version,
      currentRevisionId: row.current_revision_id,
      candidateRevisions: revisions,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private parseReadiness(text: string): EmailProviderReadinessCheckProjection {
    return parseCanonicalJson(text, (value) => emailProviderReadinessCheckProjectionSchema.parse(value));
  }
}
