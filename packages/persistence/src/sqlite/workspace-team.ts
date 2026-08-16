import type { Database } from 'bun:sqlite';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import {
  adoptSynchronousClassifiedPayload,
  openSynchronousClassifiedPayloadAdoptionReceipt,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  workspaceTeamCanonicalEmailSchema,
  workspaceTeamSnapshotSchema,
  type WorkspaceTeamMemberView,
  type WorkspaceTeamRoleKey,
  type WorkspaceTeamSnapshot
} from '@jooevents/contracts/workspace-team';
import {
  ROLE_PRESETS,
  WORKSPACE_TEAM_ROLES,
  workspaceTeamRoleView,
  type AuthenticatedWorkspaceInvitationMailboxEvidenceSource,
  type AuthenticatedWorkspaceInvitationLookup,
  type WorkspaceTeamInvitationState,
  type WorkspaceTeamMemberState,
  type WorkspaceTeamMutationPlan,
  type WorkspaceTeamPlanningSnapshot
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  createPayloadRef,
  isApplicationId,
  parseInstant,
  parseMembershipId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type WorkspaceId
} from '@jooevents/kernel';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const WORKSPACE_TEAM_SQL = `
CREATE TABLE workspace_team_heads (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  team_version INTEGER NOT NULL CHECK(team_version > 0),
  team_digest_sha256 TEXT NOT NULL CHECK(
    length(team_digest_sha256) = 64 AND team_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE(workspace_id, team_version, team_digest_sha256)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_invitation_recipients (
  reservation_id TEXT PRIMARY KEY REFERENCES access_reservations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload_ref_id TEXT NOT NULL UNIQUE REFERENCES classified_payload_records(payload_ref_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  lookup_binding TEXT NOT NULL CHECK(length(lookup_binding) = 64),
  recipient_hint TEXT NOT NULL CHECK(
    length(recipient_hint) = 22 AND recipient_hint GLOB 'recipient-[0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE(workspace_id, lookup_binding)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_invitation_release_intents (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES access_reservations(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('awaiting_activation', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  cancelled_at_ms INTEGER CHECK(cancelled_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK((status = 'awaiting_activation' AND cancelled_at_ms IS NULL)
     OR (status = 'cancelled' AND cancelled_at_ms IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_session_revocation_intents (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL UNIQUE REFERENCES workspace_memberships(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status = 'awaiting_activation'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_team_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('invite_recorded', 'role_changed', 'access_revoked')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('member', 'invitation')),
  subject_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workspace_team_head_scope_immutable
BEFORE UPDATE OF workspace_id ON workspace_team_heads
BEGIN SELECT RAISE(ABORT, 'workspace team scope is immutable'); END;
CREATE TRIGGER workspace_team_head_version_monotonic
BEFORE UPDATE ON workspace_team_heads
WHEN NEW.team_version != OLD.team_version + 1
BEGIN SELECT RAISE(ABORT, 'workspace team version must advance once'); END;

CREATE TRIGGER workspace_team_invitation_recipients_no_update
BEFORE UPDATE ON workspace_team_invitation_recipients
BEGIN SELECT RAISE(ABORT, 'workspace invitation recipient is immutable'); END;
CREATE TRIGGER workspace_team_invitation_recipients_no_delete
BEFORE DELETE ON workspace_team_invitation_recipients
BEGIN SELECT RAISE(ABORT, 'workspace invitation recipient is immutable'); END;
CREATE TRIGGER workspace_team_history_no_update
BEFORE UPDATE ON workspace_team_history
BEGIN SELECT RAISE(ABORT, 'workspace team history is immutable'); END;
CREATE TRIGGER workspace_team_history_no_delete
BEFORE DELETE ON workspace_team_history
BEGIN SELECT RAISE(ABORT, 'workspace team history is immutable'); END;
`;

export const WORKSPACE_INVITATION_CLASSIFIED_PROFILES: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef('classification', 'classification.workspace_invitation_recipient', 1),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.workspace_invitation_recipient', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.workspace_invitation_recipient', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor_auth.workspace_invitation_recipient', 1)
});

export const WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE = 'application/vnd.jooevents.workspace-invitation-recipient+json';
export const WORKSPACE_INVITATION_RECIPIENT_PURPOSE = 'workspace_invitation.recipient';

export class SQLiteWorkspaceTeamError extends Error {
  constructor(readonly code:
    | 'transaction_required'
    | 'workspace_missing'
    | 'team_head_missing'
    | 'team_data_corrupt'
    | 'stale_team'
    | 'stale_subject'
    | 'subject_missing'
    | 'role_unavailable'
    | 'history_id_required'
  , cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteWorkspaceTeamError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value)).digest('hex');
}

function applicationId(value: string): string {
  if (!isApplicationId(value)) throw new SQLiteWorkspaceTeamError('team_data_corrupt');
  return value;
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteWorkspaceTeamError('transaction_required');
}

export function installWorkspaceTeamSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteWorkspaceTeamError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(WORKSPACE_TEAM_SQL)).immediate();
}

export function ensureWorkspaceTeamRoles(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly now: Instant;
  readonly newRoleId: (roleKey: WorkspaceTeamRoleKey) => string;
}): void {
  requireTransaction(input.sqlite);
  const timestamp = Date.parse(parseInstant(input.now));
  for (const preset of ROLE_PRESETS) {
    const existing = input.sqlite.query<{ id: string }, [string, string, number]>(`
      SELECT id FROM roles
       WHERE workspace_id = ? AND source_preset_key = ? AND source_preset_version = ?
         AND archived_at IS NULL
       LIMIT 2
    `).all(input.workspaceId, preset.key, preset.version);
    if (existing.length > 1) throw new SQLiteWorkspaceTeamError('team_data_corrupt');
    let roleId = existing[0]?.id;
    if (!roleId) {
      roleId = input.newRoleId(preset.key);
      input.sqlite.query(`
        INSERT INTO roles (
          id, workspace_id, name, description, source_preset_key, source_preset_version,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(roleId, input.workspaceId, preset.name, preset.description, preset.key,
        preset.version, timestamp, timestamp);
      const insertPermission = input.sqlite.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
      );
      for (const permission of preset.permissionIds) insertPermission.run(roleId, permission);
    }
  }
}

interface RawRole { id: string; key: string; version: number; role_version: number }
interface RawMember {
  membership_id: string; membership_version: number; membership_status: string;
  user_id: string; display_name: string; display_email: string | null;
  assignment_id: string | null; assignment_version: number | null;
  role_id: string | null; role_key: string | null; role_preset_version: number | null;
  expires_at: number | null; workspace_assignment_count: number; other_access_count: number;
}
interface RawInvitation {
  reservation_id: string; reservation_version: number; lookup_binding: string;
  payload_ref_id: string; recipient_hint: string; role_id: string; role_key: string;
  role_preset_version: number;
}

function parseRoleKey(value: string): WorkspaceTeamRoleKey {
  const match = WORKSPACE_TEAM_ROLES.find((role) => role.key === value);
  if (!match) throw new SQLiteWorkspaceTeamError('team_data_corrupt');
  return match.key;
}

function rawRoles(sqlite: Database, workspaceId: WorkspaceId): ReadonlyMap<WorkspaceTeamRoleKey, { id: string; version: number }> {
  const rows = sqlite.query<RawRole, [string]>(`
    SELECT id, source_preset_key AS key, source_preset_version AS version, version AS role_version
      FROM roles
     WHERE workspace_id = ? AND archived_at IS NULL AND source_preset_key IS NOT NULL
     ORDER BY source_preset_key COLLATE BINARY
  `).all(workspaceId);
  const result = new Map<WorkspaceTeamRoleKey, { id: string; version: number }>();
  for (const row of rows) {
    const key = parseRoleKey(row.key);
    if (row.version !== 1 || result.has(key)) throw new SQLiteWorkspaceTeamError('team_data_corrupt');
    result.set(key, { id: row.id, version: row.role_version });
  }
  if (result.size !== WORKSPACE_TEAM_ROLES.length) throw new SQLiteWorkspaceTeamError('role_unavailable');
  return result;
}

function rawMembers(sqlite: Database, workspaceId: WorkspaceId): readonly WorkspaceTeamMemberState[] {
  const rows = sqlite.query<RawMember, [string]>(`
    SELECT m.id AS membership_id, m.version AS membership_version,
           m.status AS membership_status, m.user_id, u.display_name,
           (SELECT e.display_email FROM user_emails e
             WHERE e.user_id = u.id AND e.is_primary = 1 AND e.revoked_at IS NULL LIMIT 1
           ) AS display_email,
           (SELECT a.id FROM role_assignments a JOIN roles r ON r.id = a.role_id
             WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id
               AND a.scope_kind = 'workspace' AND a.event_id IS NULL
               AND (a.expires_at IS NULL OR a.expires_at > unixepoch() * 1000)
             ORDER BY a.id COLLATE BINARY LIMIT 1) AS assignment_id,
           (SELECT a.version FROM role_assignments a
             WHERE a.id = (SELECT a2.id FROM role_assignments a2
               WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
                 AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
               ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS assignment_version,
           (SELECT a.role_id FROM role_assignments a
             WHERE a.id = (SELECT a2.id FROM role_assignments a2
               WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
                 AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
               ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS role_id,
           (SELECT r.source_preset_key FROM role_assignments a JOIN roles r ON r.id = a.role_id
             WHERE a.id = (SELECT a2.id FROM role_assignments a2
               WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
                 AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
               ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS role_key,
           (SELECT r.source_preset_version FROM role_assignments a JOIN roles r ON r.id = a.role_id
             WHERE a.id = (SELECT a2.id FROM role_assignments a2
               WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
                 AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
               ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS role_preset_version,
           (SELECT a.expires_at FROM role_assignments a
             WHERE a.id = (SELECT a2.id FROM role_assignments a2
               WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
                 AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
               ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS expires_at,
           (SELECT count(*) FROM role_assignments a
             WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id
               AND a.scope_kind = 'workspace' AND a.event_id IS NULL) AS workspace_assignment_count,
           ((SELECT count(*) FROM role_assignments a
              WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id
                AND NOT (a.scope_kind = 'workspace' AND a.event_id IS NULL))
             + (SELECT count(*) FROM permission_overrides o
                 WHERE o.workspace_id = m.workspace_id AND o.user_id = m.user_id)) AS other_access_count
      FROM workspace_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND m.status IN ('active', 'pending_review')
     ORDER BY m.id COLLATE BINARY
  `).all(workspaceId);
  return Object.freeze(rows.flatMap((row) => {
    // Open admission records a pending_review membership with no workspace role
    // assignment; it joins the Team aggregate when approval assigns its role.
    // Only an admitted state without exactly one usable primary role is corrupt.
    if (row.membership_status === 'pending_review' && row.workspace_assignment_count === 0) {
      return [];
    }
    if (!row.assignment_id || !row.assignment_version || !row.role_id || !row.role_key
        || row.role_preset_version !== 1 || row.workspace_assignment_count !== 1) {
      throw new SQLiteWorkspaceTeamError('team_data_corrupt');
    }
    return Object.freeze({
      kind: 'member' as const,
      membershipId: parseMembershipId(row.membership_id),
      membershipVersion: row.membership_version,
      workspaceId,
      userId: parseUserId(row.user_id),
      status: row.membership_status === 'active' ? 'active' as const : 'pending_review' as const,
      primaryRole: Object.freeze({
        assignmentId: row.assignment_id,
        assignmentVersion: row.assignment_version,
        roleId: row.role_id,
        roleKey: parseRoleKey(row.role_key),
        ...(row.expires_at === null ? {} : { expiresAt: parseInstant(new Date(row.expires_at).toISOString()) })
      }),
      hasAdditionalAccess: row.other_access_count > 0
    });
  }));
}

function rawInvitations(sqlite: Database, workspaceId: WorkspaceId): readonly WorkspaceTeamInvitationState[] {
  const rows = sqlite.query<RawInvitation, [string]>(`
    SELECT r.id AS reservation_id, r.version AS reservation_version,
           recipient.lookup_binding, recipient.payload_ref_id, recipient.recipient_hint,
           assignment.role_id, role.source_preset_key AS role_key,
           role.source_preset_version AS role_preset_version
      FROM access_reservations r
      JOIN workspace_team_invitation_recipients recipient ON recipient.reservation_id = r.id
      JOIN reservation_role_assignments assignment ON assignment.reservation_id = r.id
        AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
      JOIN roles role ON role.id = assignment.role_id
     WHERE r.workspace_id = ? AND r.status = 'open'
     ORDER BY r.id COLLATE BINARY
  `).all(workspaceId);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.reservation_id, (counts.get(row.reservation_id) ?? 0) + 1);
  return Object.freeze(rows.map((row) => {
    if (counts.get(row.reservation_id) !== 1 || row.role_preset_version !== 1) {
      throw new SQLiteWorkspaceTeamError('team_data_corrupt');
    }
    return Object.freeze({
      kind: 'invitation' as const,
      reservationId: applicationId(row.reservation_id),
      reservationVersion: row.reservation_version,
      workspaceId,
      status: 'open' as const,
      lookupBinding: row.lookup_binding,
      payloadRefId: row.payload_ref_id,
      recipientHint: row.recipient_hint,
      roleId: row.role_id,
      roleKey: parseRoleKey(row.role_key)
    });
  }));
}

function stateDigest(input: {
  readonly roles: ReadonlyMap<WorkspaceTeamRoleKey, { id: string; version: number }>;
  readonly members: readonly WorkspaceTeamMemberState[];
  readonly invitations: readonly WorkspaceTeamInvitationState[];
}): string {
  return digest({
    schemaVersion: 1,
    roles: WORKSPACE_TEAM_ROLES.map((role) => ({ ...role, id: input.roles.get(role.key)?.id })),
    members: input.members.map((member) => ({
      membershipId: member.membershipId, version: member.membershipVersion,
      status: member.status, userId: member.userId, role: member.primaryRole,
      hasAdditionalAccess: member.hasAdditionalAccess
    })),
    invitations: input.invitations.map((invitation) => ({
      reservationId: invitation.reservationId, version: invitation.reservationVersion,
      lookupBinding: invitation.lookupBinding, payloadRefId: invitation.payloadRefId,
      roleId: invitation.roleId, roleKey: invitation.roleKey
    }))
  });
}

export class SQLiteWorkspaceTeamRepository {
  constructor(
    private readonly sqlite: Database,
    private readonly classifiedStore: SynchronousClassifiedPayloadStore
  ) {}

  initialize(workspaceId: WorkspaceId): WorkspaceTeamPlanningSnapshot {
    requireTransaction(this.sqlite);
    const state = this.readCurrentState(workspaceId, false);
    const result = this.sqlite.query(`
      INSERT OR IGNORE INTO workspace_team_heads (workspace_id, team_version, team_digest_sha256)
      VALUES (?, 1, ?)
    `).run(workspaceId, state.digestSha256);
    if (result.changes !== 1) return this.readPlanningSnapshot(workspaceId);
    return Object.freeze({ ...state, version: 1 });
  }

  readPlanningSnapshot(workspaceId: WorkspaceId): WorkspaceTeamPlanningSnapshot {
    return this.readCurrentState(workspaceId, true);
  }

  /** Captures the exact aggregate guard before identity admission changes its source rows. */
  captureProvisioningGuard(workspaceId: WorkspaceId): WorkspaceTeamProvisioningGuard {
    requireTransaction(this.sqlite);
    const before = this.readPlanningSnapshot(workspaceId);
    const guard = Object.freeze({}) as WorkspaceTeamProvisioningGuard;
    workspaceTeamProvisioningGuards.set(guard, Object.freeze({ repository: this, before }));
    return guard;
  }

  /**
   * Advances the Team guard in the same transaction as a provisioning mutation.
   * A no-op/converged admission preserves the current version.
   */
  synchronizeProvisioningMutation(
    guard: WorkspaceTeamProvisioningGuard
  ): WorkspaceTeamPlanningSnapshot {
    requireTransaction(this.sqlite);
    const captured = workspaceTeamProvisioningGuards.get(guard);
    if (!captured || captured.repository !== this) {
      throw new TypeError('workspace_team_provisioning_guard_invalid');
    }
    workspaceTeamProvisioningGuards.delete(guard);
    const after = this.readCurrentState(captured.before.workspaceId, true, false);
    if (after.digestSha256 === captured.before.digestSha256) {
      return Object.freeze({ ...after, version: captured.before.version });
    }
    const nextVersion = captured.before.version + 1;
    if (!Number.isSafeInteger(nextVersion)) {
      throw new SQLiteWorkspaceTeamError('team_data_corrupt');
    }
    const result = this.sqlite.query(`
      UPDATE workspace_team_heads
         SET team_version = ?, team_digest_sha256 = ?
       WHERE workspace_id = ? AND team_version = ? AND team_digest_sha256 = ?
    `).run(
      nextVersion,
      after.digestSha256,
      captured.before.workspaceId,
      captured.before.version,
      captured.before.digestSha256
    );
    if (result.changes !== 1) throw new SQLiteWorkspaceTeamError('stale_team');
    return Object.freeze({ ...after, version: nextVersion });
  }

  private readCurrentState(
    workspaceId: WorkspaceId,
    requireHead: boolean,
    validateHead = true
  ): WorkspaceTeamPlanningSnapshot {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const exists = this.sqlite.query<{ id: string }, [string]>(
      'SELECT id FROM workspaces WHERE id = ?'
    ).get(parsedWorkspaceId);
    if (!exists) throw new SQLiteWorkspaceTeamError('workspace_missing');
    const roles = rawRoles(this.sqlite, parsedWorkspaceId);
    const members = rawMembers(this.sqlite, parsedWorkspaceId);
    const invitations = rawInvitations(this.sqlite, parsedWorkspaceId);
    const currentDigest = stateDigest({ roles, members, invitations });
    const head = this.sqlite.query<{ team_version: number; team_digest_sha256: string }, [string]>(`
      SELECT team_version, team_digest_sha256 FROM workspace_team_heads WHERE workspace_id = ?
    `).get(parsedWorkspaceId);
    if (!head) {
      if (requireHead) throw new SQLiteWorkspaceTeamError('team_head_missing');
      return Object.freeze({
        workspaceId: parsedWorkspaceId, version: 1, digestSha256: currentDigest,
        roles, members, invitations
      });
    }
    if (validateHead && head.team_digest_sha256 !== currentDigest) {
      throw new SQLiteWorkspaceTeamError('team_data_corrupt');
    }
    return Object.freeze({
      workspaceId: parsedWorkspaceId,
      version: head.team_version,
      digestSha256: currentDigest,
      roles,
      members,
      invitations
    });
  }

  readProjection(workspaceId: WorkspaceId): WorkspaceTeamSnapshot {
    const state = this.readPlanningSnapshot(workspaceId);
    const members: WorkspaceTeamMemberView[] = [];
    for (const member of state.members) {
      const raw = this.sqlite.query<{ display_name: string; display_email: string }, [string]>(`
        SELECT u.display_name, e.display_email
          FROM workspace_memberships m JOIN users u ON u.id = m.user_id
          JOIN user_emails e ON e.user_id = u.id AND e.is_primary = 1 AND e.revoked_at IS NULL
         WHERE m.id = ?
      `).get(member.membershipId);
      if (!raw) throw new SQLiteWorkspaceTeamError('team_data_corrupt');
      members.push({
        id: member.membershipId, kind: 'member', userId: member.userId,
        name: raw.display_name, email: workspaceTeamCanonicalEmailSchema.parse(raw.display_email),
        role: workspaceTeamRoleView(member.primaryRole.roleKey), status: member.status,
        version: member.membershipVersion, hasAdditionalAccess: member.hasAdditionalAccess
      });
    }
    for (const invitation of state.invitations) {
      const email = this.openRecipient(invitation);
      if (!isApplicationId(invitation.reservationId)) {
        throw new SQLiteWorkspaceTeamError('team_data_corrupt');
      }
      members.push({
        id: invitation.reservationId, kind: 'invitation', name: 'Pending invitation',
        email, role: workspaceTeamRoleView(invitation.roleKey), status: 'invited',
        delivery: 'awaiting_activation', version: invitation.reservationVersion,
        hasAdditionalAccess: false
      });
    }
    members.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    return workspaceTeamSnapshotSchema.parse({
      schemaVersion: 1, version: state.version, digestSha256: state.digestSha256,
      roles: WORKSPACE_TEAM_ROLES, members
    });
  }

  private openRecipient(invitation: WorkspaceTeamInvitationState): string {
    const bytes = this.classifiedStore.read({
      payloadRef: createPayloadRef(parsePayloadRefId(invitation.payloadRefId)),
      expectedBinding: {
        profiles: WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
        scopeBinding: `workspace:${invitation.workspaceId}/reservation:${invitation.reservationId}`,
        contentType: WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE
      },
      purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE
    });
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || Object.keys(parsed).join(',') !== 'email') throw new TypeError();
      return workspaceTeamCanonicalEmailSchema.parse((parsed as { email?: unknown }).email);
    } catch (error) {
      throw new SQLiteWorkspaceTeamError('team_data_corrupt', error);
    } finally {
      bytes.fill(0);
    }
  }

  applyPlan(plan: WorkspaceTeamMutationPlan): void {
    requireTransaction(this.sqlite);
    if (!plan.historyId) throw new SQLiteWorkspaceTeamError('history_id_required');
    const before = this.readPlanningSnapshot(plan.workspaceId);
    if (before.version !== plan.expectedTeamVersion
        || before.digestSha256 !== plan.expectedTeamDigestSha256) {
      throw new SQLiteWorkspaceTeamError('stale_team');
    }
    if (plan.action === 'invite') this.applyInvite(plan);
    else if (plan.action === 'change_role') this.applyRoleChange(plan);
    else this.applyRemoval(plan);
    const roles = rawRoles(this.sqlite, plan.workspaceId);
    const members = rawMembers(this.sqlite, plan.workspaceId);
    const invitations = rawInvitations(this.sqlite, plan.workspaceId);
    const afterDigest = stateDigest({ roles, members, invitations });
    const update = this.sqlite.query(`
      UPDATE workspace_team_heads SET team_version = ?, team_digest_sha256 = ?
       WHERE workspace_id = ? AND team_version = ? AND team_digest_sha256 = ?
    `).run(plan.resultingTeamVersion, afterDigest, plan.workspaceId,
      plan.expectedTeamVersion, plan.expectedTeamDigestSha256);
    if (update.changes !== 1) throw new SQLiteWorkspaceTeamError('stale_team');
    const subject = plan.action === 'invite'
      ? { kind: 'invitation', id: plan.reservationId }
      : plan.subject.kind === 'member'
        ? { kind: 'member', id: plan.subject.membershipId }
        : { kind: 'invitation', id: plan.subject.reservationId };
    const evidence = plan.action === 'invite'
      ? { schemaVersion: 1, action: 'invite_recorded', roleKey: plan.roleKey,
          recipientHint: plan.recipientHint, delivery: 'awaiting_activation' }
      : plan.action === 'change_role'
        ? { schemaVersion: 1, action: 'role_changed', beforeRoleKey: plan.beforeRoleKey,
            afterRoleKey: plan.afterRoleKey }
        : { schemaVersion: 1, action: 'access_revoked', beforeRoleKey: plan.beforeRoleKey,
            sessionRevocation: plan.subject.kind === 'member' ? 'awaiting_activation' : 'not_applicable' };
    this.sqlite.query(`
      INSERT INTO workspace_team_history (
        id, workspace_id, action, subject_kind, subject_id, actor_user_id,
        evidence_json, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(plan.historyId, plan.workspaceId, evidence.action, subject.kind, subject.id,
      plan.action === 'invite' ? plan.createdByUserId : plan.actorUserId,
      canonicalJsonText(evidence), Date.parse(plan.action === 'invite'
        ? plan.createdAt : plan.action === 'change_role' ? plan.changedAt : plan.removedAt));
  }

  /** Exact direct-operation transaction-port alias; mutation semantics remain single-owned. */
  applyWorkspaceTeamPlan(plan: WorkspaceTeamMutationPlan): void {
    this.applyPlan(plan);
  }

  /** Exact direct-operation read-port alias. */
  readWorkspaceTeam(workspaceId: string): WorkspaceTeamPlanningSnapshot | undefined {
    try {
      return this.readPlanningSnapshot(parseWorkspaceId(workspaceId));
    } catch (error) {
      if (error instanceof SQLiteWorkspaceTeamError
          && (error.code === 'workspace_missing' || error.code === 'team_head_missing')) {
        return undefined;
      }
      throw error;
    }
  }

  private applyInvite(plan: Extract<WorkspaceTeamMutationPlan, { action: 'invite' }>): void {
    const role = this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT id FROM roles WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
    `).get(plan.roleId, plan.workspaceId);
    if (!role) throw new SQLiteWorkspaceTeamError('role_unavailable');
    this.sqlite.query(`
      INSERT INTO access_reservations (
        id, workspace_id, normalized_email, status, created_by_user_id, created_at, version
      ) VALUES (?, ?, ?, 'open', ?, ?, 1)
    `).run(plan.reservationId, plan.workspaceId, plan.lookupBinding,
      plan.createdByUserId, Date.parse(plan.createdAt));
    this.sqlite.query(`
      INSERT INTO reservation_role_assignments (
        id, reservation_id, role_id, scope_kind, event_id
      ) VALUES (?, ?, ?, 'workspace', NULL)
    `).run(plan.reservationRoleAssignmentId, plan.reservationId, plan.roleId);
    this.sqlite.query(`
      INSERT INTO workspace_team_invitation_recipients (
        reservation_id, workspace_id, payload_ref_id, lookup_binding, recipient_hint, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(plan.reservationId, plan.workspaceId, plan.payloadRefId,
      plan.lookupBinding, plan.recipientHint, Date.parse(plan.createdAt));
    this.sqlite.query(`
      INSERT INTO workspace_team_invitation_release_intents (
        id, reservation_id, workspace_id, status, created_at_ms
      ) VALUES (?, ?, ?, 'awaiting_activation', ?)
    `).run(plan.releaseIntentId, plan.reservationId, plan.workspaceId, Date.parse(plan.createdAt));
  }

  private applyRoleChange(plan: Extract<WorkspaceTeamMutationPlan, { action: 'change_role' }>): void {
    if (plan.subject.kind === 'member') {
      const subject = plan.subject;
      const member = this.readPlanningSnapshot(plan.workspaceId).members.find(
        (candidate) => candidate.membershipId === subject.membershipId
      );
      if (!member) throw new SQLiteWorkspaceTeamError('subject_missing');
      if (member.membershipVersion !== subject.version
          || member.primaryRole.roleId !== plan.beforeRoleId) {
        throw new SQLiteWorkspaceTeamError('stale_subject');
      }
      const result = this.sqlite.query(`
        UPDATE role_assignments SET role_id = ?, assigned_by_user_id = ?, assigned_at = ?, version = version + 1
         WHERE id = ? AND version = ? AND role_id = ? AND workspace_id = ? AND user_id = ?
      `).run(plan.afterRoleId, plan.actorUserId, Date.parse(plan.changedAt),
        member.primaryRole.assignmentId, member.primaryRole.assignmentVersion,
        plan.beforeRoleId, plan.workspaceId, member.userId);
      if (result.changes !== 1) throw new SQLiteWorkspaceTeamError('stale_subject');
      this.sqlite.query(`UPDATE workspace_memberships SET version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`).run(
        Date.parse(plan.changedAt), subject.membershipId, subject.version
      );
    } else {
      const subject = plan.subject;
      const invitation = this.readPlanningSnapshot(plan.workspaceId).invitations.find(
        (candidate) => candidate.reservationId === subject.reservationId
      );
      if (!invitation || invitation.reservationVersion !== subject.version
          || invitation.roleId !== plan.beforeRoleId) {
        throw new SQLiteWorkspaceTeamError('stale_subject');
      }
      this.sqlite.query(`UPDATE reservation_role_assignments SET role_id = ?
        WHERE reservation_id = ? AND role_id = ?`).run(
        plan.afterRoleId, subject.reservationId, plan.beforeRoleId
      );
      this.sqlite.query(`UPDATE access_reservations SET version = version + 1
        WHERE id = ? AND version = ?`).run(subject.reservationId, subject.version);
    }
  }

  private applyRemoval(plan: Extract<WorkspaceTeamMutationPlan, { action: 'remove' }>): void {
    if (plan.subject.kind === 'member') {
      const subject = plan.subject;
      const member = this.readPlanningSnapshot(plan.workspaceId).members.find(
        (candidate) => candidate.membershipId === subject.membershipId
      );
      if (!member || member.membershipVersion !== subject.version
          || !plan.sessionRevocationIntentId) throw new SQLiteWorkspaceTeamError('stale_subject');
      const result = this.sqlite.query(`
        UPDATE workspace_memberships
           SET status = 'deactivated', updated_at = ?, version = version + 1
         WHERE id = ? AND workspace_id = ? AND version = ? AND status IN ('active','pending_review')
      `).run(Date.parse(plan.removedAt), subject.membershipId,
        plan.workspaceId, subject.version);
      if (result.changes !== 1) throw new SQLiteWorkspaceTeamError('stale_subject');
      this.sqlite.query(`
        INSERT INTO workspace_team_session_revocation_intents (
          id, membership_id, workspace_id, user_id, status, created_at_ms
        ) VALUES (?, ?, ?, ?, 'awaiting_activation', ?)
      `).run(plan.sessionRevocationIntentId, member.membershipId, plan.workspaceId,
        member.userId, Date.parse(plan.removedAt));
    } else {
      const result = this.sqlite.query(`
        UPDATE access_reservations SET status = 'revoked', version = version + 1
         WHERE id = ? AND workspace_id = ? AND version = ? AND status = 'open'
      `).run(plan.subject.reservationId, plan.workspaceId, plan.subject.version);
      if (result.changes !== 1) throw new SQLiteWorkspaceTeamError('stale_subject');
      this.sqlite.query(`
        UPDATE workspace_team_invitation_release_intents
           SET status = 'cancelled', cancelled_at_ms = ?
         WHERE reservation_id = ? AND workspace_id = ? AND status = 'awaiting_activation'
      `).run(Date.parse(plan.removedAt), plan.subject.reservationId, plan.workspaceId);
    }
  }
}

declare const workspaceTeamProvisioningGuardBrand: unique symbol;

/** Opaque transaction-local guard; only its issuing repository can consume it. */
export interface WorkspaceTeamProvisioningGuard {
  readonly [workspaceTeamProvisioningGuardBrand]: true;
}

const workspaceTeamProvisioningGuards = new WeakMap<
  WorkspaceTeamProvisioningGuard,
  {
    readonly repository: SQLiteWorkspaceTeamRepository;
    readonly before: WorkspaceTeamPlanningSnapshot;
  }
>();

export interface WorkspaceTeamProvisioningSynchronizationPort {
  captureWithinTransaction(workspaceId: string): WorkspaceTeamProvisioningGuard;
  synchronizeWithinTransaction(guard: WorkspaceTeamProvisioningGuard): void;
}

/** Exact admission bridge; it owns no transaction and cannot be used outside one. */
export function createWorkspaceTeamProvisioningSynchronizationPort(
  repository: SQLiteWorkspaceTeamRepository
): WorkspaceTeamProvisioningSynchronizationPort {
  if (!(repository instanceof SQLiteWorkspaceTeamRepository)) {
    throw new TypeError('workspace_team_provisioning_repository_invalid');
  }
  return Object.freeze({
    captureWithinTransaction(workspaceId: string) {
      return repository.captureProvisioningGuard(parseWorkspaceId(workspaceId));
    },
    synchronizeWithinTransaction(guard: WorkspaceTeamProvisioningGuard) {
      repository.synchronizeProvisioningMutation(guard);
    }
  });
}

export function workspaceInvitationLookupBinding(input: {
  readonly keyBytes: Uint8Array;
  readonly workspaceId: WorkspaceId;
  readonly normalizedEmail: string;
}): string {
  if (!(input.keyBytes instanceof Uint8Array) || input.keyBytes.byteLength < 32) {
    throw new TypeError('workspace_invitation_lookup_key_invalid');
  }
  return createHmac('sha256', input.keyBytes)
    .update(canonicalJsonText({ workspaceId: input.workspaceId, normalizedEmail: input.normalizedEmail }))
    .digest('hex');
}

export function workspaceInvitationRecipientHint(lookupBinding: string): string {
  if (!/^[a-f0-9]{64}$/.test(lookupBinding)) throw new TypeError('workspace_invitation_lookup_binding_invalid');
  return `recipient-${lookupBinding.slice(0, 12)}`;
}

/**
 * Adopts the normalized mailbox into classified storage inside the caller's
 * transaction. Returned planning material contains no recoverable address.
 */
export function adoptWorkspaceInvitationRecipient(input: {
  readonly store: SynchronousClassifiedPayloadStore;
  readonly workspaceId: WorkspaceId;
  readonly reservationId: string;
  readonly payloadRefId: string;
  readonly normalizedEmail: string;
  readonly lookupKeyBytes: Uint8Array;
  readonly createdAt: Instant;
}): Readonly<{
  payloadRefId: string;
  lookupBinding: string;
  hint: string;
}> {
  const email = workspaceTeamCanonicalEmailSchema.parse(input.normalizedEmail);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!isApplicationId(input.reservationId)) throw new TypeError('workspace_invitation_id_invalid');
  const payloadRefId = parsePayloadRefId(input.payloadRefId);
  const lookupBinding = workspaceInvitationLookupBinding({
    keyBytes: input.lookupKeyBytes, workspaceId, normalizedEmail: email
  });
  const bytes = new TextEncoder().encode(canonicalJsonText({ email }));
  const binding = {
    profiles: WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
    scopeBinding: `workspace:${workspaceId}/reservation:${input.reservationId}`,
    contentType: WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE
  };
  try {
    const receipt = adoptSynchronousClassifiedPayload({
      store: input.store,
      put: {
        payloadRefId,
        binding,
        purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE,
        bytes,
        createdAt: parseInstant(input.createdAt)
      }
    });
    openSynchronousClassifiedPayloadAdoptionReceipt({
      receipt,
      expectedStore: input.store,
      expected: { binding, purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE, bytes }
    });
  } finally {
    bytes.fill(0);
  }
  return Object.freeze({
    payloadRefId,
    lookupBinding,
    hint: workspaceInvitationRecipientHint(lookupBinding)
  });
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function createSQLiteAuthenticatedWorkspaceInvitationLookup(input: {
  readonly sqlite: Database;
  readonly lookupKeyBytes: Uint8Array;
  readonly mailboxEvidence: AuthenticatedWorkspaceInvitationMailboxEvidenceSource;
}): AuthenticatedWorkspaceInvitationLookup {
  const keyBytes = Uint8Array.from(input.lookupKeyBytes);
  if (keyBytes.byteLength < 32) throw new TypeError('workspace_invitation_lookup_key_invalid');
  return Object.freeze({
    findOpen({ workspaceId, mailbox }:
      Parameters<AuthenticatedWorkspaceInvitationLookup['findOpen']>[0]) {
      const evidence = input.mailboxEvidence.open(mailbox);
      if (!evidence || !evidence.provider || !evidence.issuer || !evidence.subject
          || !workspaceTeamCanonicalEmailSchema.safeParse(evidence.normalizedEmail).success
          || !Number.isFinite(Date.parse(evidence.observedAt))) {
        return undefined;
      }
      const expected = workspaceInvitationLookupBinding({
        keyBytes, workspaceId, normalizedEmail: evidence.normalizedEmail
      });
      const rows = input.sqlite.query<{
        reservation_id: string; reservation_version: number; lookup_binding: string; role_key: string;
      }, [string]>(`
        SELECT r.id AS reservation_id, r.version AS reservation_version,
               recipient.lookup_binding, role.source_preset_key AS role_key
          FROM access_reservations r
          JOIN workspace_team_invitation_recipients recipient ON recipient.reservation_id = r.id
          JOIN reservation_role_assignments assignment ON assignment.reservation_id = r.id
            AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
          JOIN roles role ON role.id = assignment.role_id
         WHERE r.workspace_id = ? AND r.status = 'open'
      `).all(workspaceId).filter((row) => equalHex(row.lookup_binding, expected));
      if (rows.length > 1) throw new SQLiteWorkspaceTeamError('team_data_corrupt');
      const row = rows[0];
      return row ? Object.freeze({
        workspaceId,
        reservationId: applicationId(row.reservation_id),
        reservationVersion: row.reservation_version,
        roleKey: parseRoleKey(row.role_key)
      }) : undefined;
    }
  });
}
