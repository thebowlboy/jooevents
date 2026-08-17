import {
  WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
  WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE,
  WORKSPACE_INVITATION_RECIPIENT_PURPOSE
} from '@jooevents/application';
import { ImmutableClassifiedPayloadRecordCodec } from '@jooevents/application/immutable-classified-payload-record';
import type { ImmutableClassifiedPayloadRecordCodecOptions } from '@jooevents/application/immutable-classified-payload-record';
import {
  workspaceTeamCanonicalEmailSchema,
  workspaceTeamSnapshotSchema,
  type WorkspaceTeamMemberView,
  type WorkspaceTeamRoleKey,
  type WorkspaceTeamSnapshot
} from '@jooevents/contracts/workspace-team';
import {
  WORKSPACE_TEAM_ROLES,
  workspaceTeamRoleView,
  type WorkspaceTeamInvitationState,
  type WorkspaceTeamMemberState
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
  type WorkspaceId
} from '@jooevents/kernel';
import { readD1ClassifiedPayloadRecords } from './d1-classified-payload-store';

interface WorkspaceRow { readonly id: string }
interface HeadRow { readonly team_version: number; readonly team_digest_sha256: string }
interface RoleRow {
  readonly id: string;
  readonly role_key: string;
  readonly preset_version: number;
  readonly role_version: number;
}
interface MemberRow {
  readonly membership_id: string;
  readonly membership_version: number;
  readonly membership_status: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly display_email: string | null;
  readonly assignment_id: string | null;
  readonly assignment_version: number | null;
  readonly role_id: string | null;
  readonly role_key: string | null;
  readonly role_preset_version: number | null;
  readonly expires_at: number | null;
  readonly workspace_assignment_count: number;
  readonly other_access_count: number;
}
interface InvitationRow {
  readonly reservation_id: string;
  readonly reservation_version: number;
  readonly lookup_binding: string;
  readonly payload_ref_id: string;
  readonly recipient_hint: string;
  readonly role_id: string;
  readonly role_key: string;
  readonly role_preset_version: number;
}

export class D1WorkspaceTeamReadError extends Error {
  readonly name = 'D1WorkspaceTeamReadError';

  constructor(readonly code:
    | 'workspace_missing'
    | 'team_head_missing'
    | 'role_unavailable'
    | 'team_data_corrupt'
  ) {
    super(code);
  }
}

function roleKey(value: string): WorkspaceTeamRoleKey {
  const role = WORKSPACE_TEAM_ROLES.find((candidate) => candidate.key === value);
  if (!role) throw new D1WorkspaceTeamReadError('team_data_corrupt');
  return role.key;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new D1WorkspaceTeamReadError('team_data_corrupt');
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseRecipient(bytes: Uint8Array): string {
  try {
    const candidate = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as unknown;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || Object.keys(candidate).join(',') !== 'email') {
      throw new TypeError('workspace_invitation_recipient_invalid');
    }
    return workspaceTeamCanonicalEmailSchema.parse(
      (candidate as { readonly email?: unknown }).email
    );
  } catch {
    throw new D1WorkspaceTeamReadError('team_data_corrupt');
  } finally {
    bytes.fill(0);
  }
}

function applicationId(value: string) {
  if (!isApplicationId(value)) throw new D1WorkspaceTeamReadError('team_data_corrupt');
  return value;
}

/** Reads and verifies one classified workspace-Team projection from D1. */
export async function readD1WorkspaceTeamSnapshot(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly nowEpochMs: number;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
}): Promise<WorkspaceTeamSnapshot> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!Number.isSafeInteger(input.nowEpochMs) || input.nowEpochMs < 0) {
    throw new TypeError('d1_workspace_team_time_invalid');
  }
  const session = input.database.withSession('first-primary');
  const [workspaceResult, headResult, roleResult, memberResult, invitationResult] =
    await session.batch([
      session.prepare('SELECT id FROM workspaces WHERE id = ? LIMIT 2').bind(workspaceId),
      session.prepare(`SELECT team_version,team_digest_sha256 FROM workspace_team_heads
        WHERE workspace_id = ? LIMIT 2`).bind(workspaceId),
      session.prepare(`SELECT id,source_preset_key AS role_key,
        source_preset_version AS preset_version,version AS role_version
        FROM roles WHERE workspace_id = ? AND archived_at IS NULL
          AND source_preset_key IS NOT NULL
        ORDER BY source_preset_key COLLATE BINARY`).bind(workspaceId),
      session.prepare(`SELECT m.id AS membership_id,m.version AS membership_version,
        m.status AS membership_status,m.user_id,u.display_name,
        (SELECT e.display_email FROM user_emails e
          WHERE e.user_id = u.id AND e.is_primary = 1 AND e.revoked_at IS NULL
          ORDER BY e.id COLLATE BINARY LIMIT 1) AS display_email,
        (SELECT a.id FROM role_assignments a
          WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id
            AND a.scope_kind = 'workspace' AND a.event_id IS NULL
            AND (a.expires_at IS NULL OR a.expires_at > ?)
          ORDER BY a.id COLLATE BINARY LIMIT 1) AS assignment_id,
        (SELECT a.version FROM role_assignments a
          WHERE a.id = (SELECT a2.id FROM role_assignments a2
            WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
              AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
              AND (a2.expires_at IS NULL OR a2.expires_at > ?)
            ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS assignment_version,
        (SELECT a.role_id FROM role_assignments a
          WHERE a.id = (SELECT a2.id FROM role_assignments a2
            WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
              AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
              AND (a2.expires_at IS NULL OR a2.expires_at > ?)
            ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS role_id,
        (SELECT r.source_preset_key FROM role_assignments a JOIN roles r ON r.id = a.role_id
          WHERE a.id = (SELECT a2.id FROM role_assignments a2
            WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
              AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
              AND (a2.expires_at IS NULL OR a2.expires_at > ?)
            ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS role_key,
        (SELECT r.source_preset_version FROM role_assignments a JOIN roles r ON r.id = a.role_id
          WHERE a.id = (SELECT a2.id FROM role_assignments a2
            WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
              AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
              AND (a2.expires_at IS NULL OR a2.expires_at > ?)
            ORDER BY a2.id COLLATE BINARY LIMIT 1)) AS role_preset_version,
        (SELECT a.expires_at FROM role_assignments a
          WHERE a.id = (SELECT a2.id FROM role_assignments a2
            WHERE a2.workspace_id = m.workspace_id AND a2.user_id = m.user_id
              AND a2.scope_kind = 'workspace' AND a2.event_id IS NULL
              AND (a2.expires_at IS NULL OR a2.expires_at > ?)
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
        WHERE m.workspace_id = ? AND m.status IN ('active','pending_review')
        ORDER BY m.id COLLATE BINARY`).bind(
          input.nowEpochMs,
          input.nowEpochMs,
          input.nowEpochMs,
          input.nowEpochMs,
          input.nowEpochMs,
          input.nowEpochMs,
          workspaceId
        ),
      session.prepare(`SELECT r.id AS reservation_id,r.version AS reservation_version,
        recipient.lookup_binding,recipient.payload_ref_id,recipient.recipient_hint,
        assignment.role_id,role.source_preset_key AS role_key,
        role.source_preset_version AS role_preset_version
        FROM access_reservations r
        JOIN workspace_team_invitation_recipients recipient ON recipient.reservation_id = r.id
        JOIN reservation_role_assignments assignment ON assignment.reservation_id = r.id
          AND assignment.scope_kind = 'workspace' AND assignment.event_id IS NULL
        JOIN roles role ON role.id = assignment.role_id
        WHERE r.workspace_id = ? AND r.status = 'open'
        ORDER BY r.id COLLATE BINARY`).bind(workspaceId)
    ]);

  const workspaces = (workspaceResult as D1Result<WorkspaceRow>).results;
  const heads = (headResult as D1Result<HeadRow>).results;
  if (workspaces.length !== 1 || workspaces[0]?.id !== workspaceId) {
    throw new D1WorkspaceTeamReadError('workspace_missing');
  }
  if (heads.length !== 1) throw new D1WorkspaceTeamReadError('team_head_missing');
  const head = heads[0]!;
  const roles = new Map<WorkspaceTeamRoleKey, { readonly id: string; readonly version: number }>();
  for (const row of (roleResult as D1Result<RoleRow>).results) {
    const key = roleKey(row.role_key);
    if (row.preset_version !== 1 || roles.has(key) || !isApplicationId(row.id)) {
      throw new D1WorkspaceTeamReadError('team_data_corrupt');
    }
    roles.set(key, Object.freeze({ id: row.id, version: positiveInteger(row.role_version) }));
  }
  if (roles.size !== WORKSPACE_TEAM_ROLES.length) {
    throw new D1WorkspaceTeamReadError('role_unavailable');
  }

  const memberViews: WorkspaceTeamMemberView[] = [];
  const members: WorkspaceTeamMemberState[] = [];
  for (const row of (memberResult as D1Result<MemberRow>).results) {
    if (row.membership_status === 'pending_review' && row.workspace_assignment_count === 0) {
      continue;
    }
    if (!row.assignment_id || !row.assignment_version || !row.role_id || !row.role_key
        || row.role_preset_version !== 1 || row.workspace_assignment_count !== 1
        || row.display_email === null || !isApplicationId(row.assignment_id)
        || !isApplicationId(row.role_id)) {
      throw new D1WorkspaceTeamReadError('team_data_corrupt');
    }
    const membershipId = parseMembershipId(row.membership_id);
    const userId = parseUserId(row.user_id);
    const key = roleKey(row.role_key);
    const membershipVersion = positiveInteger(row.membership_version);
    const state = Object.freeze({
      kind: 'member' as const,
      membershipId,
      membershipVersion,
      workspaceId,
      userId,
      status: row.membership_status === 'active' ? 'active' as const : 'pending_review' as const,
      primaryRole: Object.freeze({
        assignmentId: row.assignment_id,
        assignmentVersion: positiveInteger(row.assignment_version),
        roleId: row.role_id,
        roleKey: key,
        ...(row.expires_at === null
          ? {}
          : { expiresAt: parseInstant(new Date(row.expires_at).toISOString()) })
      }),
      hasAdditionalAccess: row.other_access_count > 0
    });
    members.push(state);
    memberViews.push({
      id: membershipId,
      kind: 'member',
      userId,
      name: row.display_name,
      email: workspaceTeamCanonicalEmailSchema.parse(row.display_email),
      role: workspaceTeamRoleView(key),
      status: state.status,
      version: membershipVersion,
      hasAdditionalAccess: state.hasAdditionalAccess
    });
  }

  const invitationRows = (invitationResult as D1Result<InvitationRow>).results;
  const reservationCounts = new Map<string, number>();
  for (const row of invitationRows) {
    reservationCounts.set(
      row.reservation_id,
      (reservationCounts.get(row.reservation_id) ?? 0) + 1
    );
  }
  const records = await readD1ClassifiedPayloadRecords(
    session,
    invitationRows.map((row) => parsePayloadRefId(row.payload_ref_id))
  );
  const recordById = new Map(records.map((record) => [record.payloadRefId, record]));
  const codec = new ImmutableClassifiedPayloadRecordCodec(input.classifiedPayload);
  const invitations: WorkspaceTeamInvitationState[] = [];
  for (const row of invitationRows) {
    if (reservationCounts.get(row.reservation_id) !== 1 || row.role_preset_version !== 1
        || !isApplicationId(row.role_id) || !/^[a-f0-9]{64}$/.test(row.lookup_binding)
        || !/^recipient-[a-f0-9]{12}$/.test(row.recipient_hint)) {
      throw new D1WorkspaceTeamReadError('team_data_corrupt');
    }
    const reservationId = applicationId(row.reservation_id);
    const payloadRefId = parsePayloadRefId(row.payload_ref_id);
    const record = recordById.get(payloadRefId);
    if (!record) throw new D1WorkspaceTeamReadError('team_data_corrupt');
    const email = parseRecipient(codec.read(record, {
      payloadRef: createPayloadRef(payloadRefId),
      expectedBinding: {
        profiles: WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
        scopeBinding: `workspace:${workspaceId}/reservation:${reservationId}`,
        contentType: WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE
      },
      purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE
    }));
    const key = roleKey(row.role_key);
    const invitation = Object.freeze({
      kind: 'invitation' as const,
      reservationId,
      reservationVersion: positiveInteger(row.reservation_version),
      workspaceId,
      status: 'open' as const,
      lookupBinding: row.lookup_binding,
      payloadRefId,
      recipientHint: row.recipient_hint,
      roleId: row.role_id,
      roleKey: key
    });
    invitations.push(invitation);
    memberViews.push({
      id: reservationId,
      kind: 'invitation',
      name: 'Pending invitation',
      email,
      role: workspaceTeamRoleView(key),
      status: 'invited',
      delivery: 'awaiting_activation',
      version: invitation.reservationVersion,
      hasAdditionalAccess: false
    });
  }

  const currentDigest = await sha256(canonicalJsonText({
    schemaVersion: 1,
    roles: WORKSPACE_TEAM_ROLES.map((role) => ({ ...role, id: roles.get(role.key)?.id })),
    members: members.map((member) => ({
      membershipId: member.membershipId,
      version: member.membershipVersion,
      status: member.status,
      userId: member.userId,
      role: member.primaryRole,
      hasAdditionalAccess: member.hasAdditionalAccess
    })),
    invitations: invitations.map((invitation) => ({
      reservationId: invitation.reservationId,
      version: invitation.reservationVersion,
      lookupBinding: invitation.lookupBinding,
      payloadRefId: invitation.payloadRefId,
      roleId: invitation.roleId,
      roleKey: invitation.roleKey
    }))
  }));
  if (!/^[a-f0-9]{64}$/.test(head.team_digest_sha256)
      || head.team_digest_sha256 !== currentDigest) {
    throw new D1WorkspaceTeamReadError('team_data_corrupt');
  }
  memberViews.sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
  );
  return workspaceTeamSnapshotSchema.parse({
    schemaVersion: 1,
    version: positiveInteger(head.team_version),
    digestSha256: currentDigest,
    roles: WORKSPACE_TEAM_ROLES,
    members: memberViews
  });
}

export function createD1WorkspaceTeamReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly nowEpochMs: () => number;
  readonly classifiedPayload: ImmutableClassifiedPayloadRecordCodecOptions;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    readWorkspaceTeam(requestedWorkspaceId: WorkspaceId) {
      if (requestedWorkspaceId !== workspaceId) {
        throw new TypeError('d1_workspace_team_workspace_mismatch');
      }
      return readD1WorkspaceTeamSnapshot({
        database: input.database,
        workspaceId,
        nowEpochMs: input.nowEpochMs(),
        classifiedPayload: input.classifiedPayload
      });
    }
  });
}
