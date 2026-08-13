import type { Database } from 'bun:sqlite';
import {
  PERMISSIONS,
  ROLE_PRESETS,
  type AccessScope,
  type AuthorizationRepository,
  type MembershipRepository,
  type PermissionId,
  type PermissionOverride,
  type Role,
  type RoleAssignment,
  type RolePresetKey,
  type UserId,
  type WorkspaceId,
  type WorkspaceMembership
} from '@jooevents/identity-access';

type SQLiteValue = string | number | bigint | Uint8Array | null;

interface MembershipRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly status: SQLiteValue;
  readonly approved_by_user_id: SQLiteValue;
  readonly approved_at: SQLiteValue;
  readonly created_at: SQLiteValue;
  readonly updated_at: SQLiteValue;
  readonly version: SQLiteValue;
}

interface RoleRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly name: SQLiteValue;
  readonly description: SQLiteValue;
  readonly source_preset_key: SQLiteValue;
  readonly source_preset_version: SQLiteValue;
  readonly archived_at: SQLiteValue;
  readonly permission_id: SQLiteValue;
}

interface AssignmentRow {
  readonly id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly role_id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly scope_kind: SQLiteValue;
  readonly event_id: SQLiteValue;
  readonly event_workspace_id: SQLiteValue;
  readonly role_workspace_id: SQLiteValue;
  readonly assigned_by_user_id: SQLiteValue;
  readonly assigned_at: SQLiteValue;
  readonly expires_at: SQLiteValue;
}

interface OverrideRow {
  readonly id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly permission_id: SQLiteValue;
  readonly effect: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly scope_kind: SQLiteValue;
  readonly event_id: SQLiteValue;
  readonly event_workspace_id: SQLiteValue;
  readonly reason: SQLiteValue;
  readonly decided_by_user_id: SQLiteValue;
  readonly decided_at: SQLiteValue;
  readonly expires_at: SQLiteValue;
}

const permissionIds = new Set<string>(PERMISSIONS.map((permission) => permission.id));
const presetKeys = new Set<string>(ROLE_PRESETS.map((preset) => preset.key));
const membershipStatuses = new Set<WorkspaceMembership['status']>([
  'invited',
  'pending_review',
  'active',
  'suspended',
  'deactivated'
]);

export class SQLiteAccessEvidenceError extends Error {
  readonly code = 'malformed_access_evidence';

  constructor(message: string) {
    super(message);
    this.name = 'SQLiteAccessEvidenceError';
  }
}

function malformed(message: string): never {
  throw new SQLiteAccessEvidenceError(message);
}

function requiredText(value: SQLiteValue, field: string): string {
  if (typeof value !== 'string' || value.length === 0) malformed(`${field} must be a non-empty string.`);
  return value;
}

function text(value: SQLiteValue, field: string): string {
  if (typeof value !== 'string') malformed(`${field} must be a string.`);
  return value;
}

function optionalText(value: SQLiteValue, field: string): string | undefined {
  return value === null ? undefined : requiredText(value, field);
}

function nonNegativeInteger(value: SQLiteValue, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: SQLiteValue, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) malformed(`${field} must be positive.`);
  return parsed;
}

function instant(value: SQLiteValue, field: string): string {
  const milliseconds = nonNegativeInteger(value, field);
  const result = new Date(milliseconds);
  if (!Number.isFinite(result.getTime())) malformed(`${field} is outside the supported instant range.`);
  return result.toISOString();
}

function optionalInstant(value: SQLiteValue, field: string): string | undefined {
  return value === null ? undefined : instant(value, field);
}

function permissionId(value: SQLiteValue, field: string): PermissionId {
  const id = requiredText(value, field);
  if (!permissionIds.has(id)) malformed(`${field} is not in the deployed permission catalog.`);
  return id as PermissionId;
}

function accessScope(input: {
  readonly workspaceId: string;
  readonly scopeKind: SQLiteValue;
  readonly eventId: SQLiteValue;
  readonly eventWorkspaceId: SQLiteValue;
  readonly field: string;
}): AccessScope {
  if (input.scopeKind === 'workspace') {
    if (input.eventId !== null || input.eventWorkspaceId !== null) {
      malformed(`${input.field} workspace scope carries event evidence.`);
    }
    return Object.freeze({ kind: 'workspace', workspaceId: input.workspaceId });
  }
  if (input.scopeKind !== 'event') malformed(`${input.field} has an unknown scope kind.`);
  const eventId = requiredText(input.eventId, `${input.field}.event_id`);
  const eventWorkspaceId = requiredText(
    input.eventWorkspaceId,
    `${input.field}.event_workspace_id`
  );
  if (eventWorkspaceId !== input.workspaceId) {
    malformed(`${input.field} event does not belong to its declared workspace.`);
  }
  return Object.freeze({ kind: 'event', workspaceId: input.workspaceId, eventId });
}

function membershipFromRow(
  row: MembershipRow,
  expectedWorkspaceId: string,
  expectedUserId: string
): WorkspaceMembership {
  const workspaceId = requiredText(row.workspace_id, 'workspace_memberships.workspace_id');
  const userId = requiredText(row.user_id, 'workspace_memberships.user_id');
  if (workspaceId !== expectedWorkspaceId || userId !== expectedUserId) {
    malformed('Membership lookup returned evidence outside the requested principal and workspace.');
  }
  const status = requiredText(row.status, 'workspace_memberships.status');
  if (!membershipStatuses.has(status as WorkspaceMembership['status'])) {
    malformed('workspace_memberships.status is unknown.');
  }

  return Object.freeze({
    id: requiredText(row.id, 'workspace_memberships.id'),
    workspaceId,
    userId,
    status: status as WorkspaceMembership['status'],
    ...(optionalText(row.approved_by_user_id, 'workspace_memberships.approved_by_user_id')
      ? { approvedByUserId: requiredText(row.approved_by_user_id, 'workspace_memberships.approved_by_user_id') }
      : {}),
    ...(optionalInstant(row.approved_at, 'workspace_memberships.approved_at')
      ? { approvedAt: instant(row.approved_at, 'workspace_memberships.approved_at') }
      : {}),
    createdAt: instant(row.created_at, 'workspace_memberships.created_at'),
    updatedAt: instant(row.updated_at, 'workspace_memberships.updated_at'),
    version: positiveInteger(row.version, 'workspace_memberships.version')
  });
}

function roleFromRows(rows: readonly RoleRow[], expectedWorkspaceId: string): Role {
  const first = rows[0];
  if (!first) malformed('Role evidence group is empty.');
  const id = requiredText(first.id, 'roles.id');
  const workspaceId = requiredText(first.workspace_id, 'roles.workspace_id');
  if (workspaceId !== expectedWorkspaceId) malformed('Role lookup crossed workspace scope.');

  const presetKey = optionalText(first.source_preset_key, 'roles.source_preset_key');
  const presetVersion = first.source_preset_version === null
    ? undefined
    : positiveInteger(first.source_preset_version, 'roles.source_preset_version');
  if ((presetKey === undefined) !== (presetVersion === undefined)) {
    malformed('Role preset key and version must be present together.');
  }
  if (presetKey !== undefined && !presetKeys.has(presetKey)) {
    malformed('roles.source_preset_key is not in the deployed preset catalog.');
  }

  const permissions: PermissionId[] = [];
  for (const row of rows) {
    if (
      requiredText(row.id, 'roles.id') !== id ||
      requiredText(row.workspace_id, 'roles.workspace_id') !== workspaceId
    ) {
      malformed('Role permission rows do not share one role identity.');
    }
    if (row.permission_id !== null) {
      permissions.push(permissionId(row.permission_id, 'role_permissions.permission_id'));
    }
  }

  return Object.freeze({
    id,
    workspaceId,
    name: requiredText(first.name, 'roles.name'),
    description: text(first.description, 'roles.description'),
    permissionIds: Object.freeze(permissions),
    ...(presetKey !== undefined ? { sourcePresetKey: presetKey as RolePresetKey } : {}),
    ...(presetVersion !== undefined ? { sourcePresetVersion: presetVersion } : {}),
    ...(optionalInstant(first.archived_at, 'roles.archived_at')
      ? { archivedAt: instant(first.archived_at, 'roles.archived_at') }
      : {})
  });
}

function assignmentFromRow(
  row: AssignmentRow,
  expectedWorkspaceId: string,
  expectedUserId: string
): RoleAssignment {
  const workspaceId = requiredText(row.workspace_id, 'role_assignments.workspace_id');
  const userId = requiredText(row.user_id, 'role_assignments.user_id');
  if (workspaceId !== expectedWorkspaceId || userId !== expectedUserId) {
    malformed('Role-assignment lookup returned evidence outside the requested principal and workspace.');
  }
  if (requiredText(row.role_workspace_id, 'roles.workspace_id') !== workspaceId) {
    malformed('Role assignment references a role from another workspace.');
  }
  const assignedByUserId = optionalText(
    row.assigned_by_user_id,
    'role_assignments.assigned_by_user_id'
  );

  return Object.freeze({
    id: requiredText(row.id, 'role_assignments.id'),
    userId,
    roleId: requiredText(row.role_id, 'role_assignments.role_id'),
    scope: accessScope({
      workspaceId,
      scopeKind: row.scope_kind,
      eventId: row.event_id,
      eventWorkspaceId: row.event_workspace_id,
      field: 'role_assignments.scope'
    }),
    ...(assignedByUserId !== undefined ? { assignedByUserId } : {}),
    assignedAt: instant(row.assigned_at, 'role_assignments.assigned_at'),
    ...(optionalInstant(row.expires_at, 'role_assignments.expires_at')
      ? { expiresAt: instant(row.expires_at, 'role_assignments.expires_at') }
      : {})
  });
}

function overrideFromRow(
  row: OverrideRow,
  expectedWorkspaceId: string,
  expectedUserId: string
): PermissionOverride {
  const workspaceId = requiredText(row.workspace_id, 'permission_overrides.workspace_id');
  const userId = requiredText(row.user_id, 'permission_overrides.user_id');
  if (workspaceId !== expectedWorkspaceId || userId !== expectedUserId) {
    malformed('Permission-override lookup returned evidence outside the requested principal and workspace.');
  }
  if (row.effect !== 'grant' && row.effect !== 'deny') {
    malformed('permission_overrides.effect is unknown.');
  }
  const decidedByUserId = optionalText(
    row.decided_by_user_id,
    'permission_overrides.decided_by_user_id'
  );

  return Object.freeze({
    id: requiredText(row.id, 'permission_overrides.id'),
    userId,
    permissionId: permissionId(row.permission_id, 'permission_overrides.permission_id'),
    effect: row.effect,
    scope: accessScope({
      workspaceId,
      scopeKind: row.scope_kind,
      eventId: row.event_id,
      eventWorkspaceId: row.event_workspace_id,
      field: 'permission_overrides.scope'
    }),
    reason: requiredText(row.reason, 'permission_overrides.reason'),
    ...(decidedByUserId !== undefined ? { decidedByUserId } : {}),
    decidedAt: instant(row.decided_at, 'permission_overrides.decided_at'),
    ...(optionalInstant(row.expires_at, 'permission_overrides.expires_at')
      ? { expiresAt: instant(row.expires_at, 'permission_overrides.expires_at') }
      : {})
  });
}

/** Reads current workspace admission evidence without evaluating permission policy. */
export function createSQLiteMembershipRepository(sqlite: Database): MembershipRepository {
  return Object.freeze({
    async find(workspaceId: WorkspaceId, userId: UserId) {
      const rows = sqlite.query<MembershipRow, [string, string]>(`
        select id, workspace_id, user_id, status, approved_by_user_id, approved_at,
               created_at, updated_at, version
          from workspace_memberships
         where workspace_id = ? and user_id = ?
         limit 2
      `).all(workspaceId, userId);
      if (rows.length > 1) malformed('Membership lookup is not unique.');
      const row = rows[0];
      return row ? membershipFromRow(row, workspaceId, userId) : undefined;
    }
  });
}

/** Reads complete current authorization evidence; `evaluateAccess` remains the policy owner. */
export function createSQLiteAuthorizationRepository(sqlite: Database): AuthorizationRepository {
  return Object.freeze({
    async listRoles(workspaceId: WorkspaceId) {
      const rows = sqlite.query<RoleRow, [string]>(`
        select r.id, r.workspace_id, r.name, r.description, r.source_preset_key,
               r.source_preset_version, r.archived_at, rp.permission_id
          from roles r
          left join role_permissions rp on rp.role_id = r.id
         where r.workspace_id = ?
         order by r.id collate binary asc, rp.permission_id collate binary asc
      `).all(workspaceId);
      const groups = new Map<string, RoleRow[]>();
      for (const row of rows) {
        const id = requiredText(row.id, 'roles.id');
        const group = groups.get(id);
        if (group) group.push(row);
        else groups.set(id, [row]);
      }
      return Object.freeze([...groups.values()].map((group) => roleFromRows(group, workspaceId)));
    },

    async listAssignments(workspaceId: WorkspaceId, userId: UserId) {
      const rows = sqlite.query<AssignmentRow, [string, string]>(`
        select a.id, a.user_id, a.role_id, a.workspace_id, a.scope_kind, a.event_id,
               e.workspace_id as event_workspace_id, r.workspace_id as role_workspace_id,
               a.assigned_by_user_id, a.assigned_at, a.expires_at
          from role_assignments a
          join roles r on r.id = a.role_id
          left join events e on e.id = a.event_id
         where a.workspace_id = ? and a.user_id = ?
         order by a.id collate binary asc
      `).all(workspaceId, userId);
      return Object.freeze(rows.map((row) => assignmentFromRow(row, workspaceId, userId)));
    },

    async listOverrides(workspaceId: WorkspaceId, userId: UserId) {
      const rows = sqlite.query<OverrideRow, [string, string]>(`
        select o.id, o.user_id, o.permission_id, o.effect, o.workspace_id,
               o.scope_kind, o.event_id, e.workspace_id as event_workspace_id,
               o.reason, o.decided_by_user_id, o.decided_at, o.expires_at
          from permission_overrides o
          left join events e on e.id = o.event_id
         where o.workspace_id = ? and o.user_id = ?
         order by o.id collate binary asc
      `).all(workspaceId, userId);
      return Object.freeze(rows.map((row) => overrideFromRow(row, workspaceId, userId)));
    }
  });
}

export interface SQLiteAccessRepositories {
  readonly memberships: MembershipRepository;
  readonly authorization: AuthorizationRepository;
}

export function createSQLiteAccessRepositories(sqlite: Database): SQLiteAccessRepositories {
  return Object.freeze({
    memberships: createSQLiteMembershipRepository(sqlite),
    authorization: createSQLiteAuthorizationRepository(sqlite)
  });
}
