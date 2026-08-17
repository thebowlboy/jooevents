import {
  PERMISSIONS,
  ROLE_PRESETS,
  type AccessScope,
  type PermissionId,
  type PermissionOverride,
  type Role,
  type RoleAssignment,
  type RolePresetKey,
  type WorkspaceMembership
} from '@jooevents/identity-access';

export type AccessEvidenceValue = string | number | bigint | Uint8Array | null;

export interface MembershipEvidenceRow {
  readonly id: AccessEvidenceValue;
  readonly workspace_id: AccessEvidenceValue;
  readonly user_id: AccessEvidenceValue;
  readonly status: AccessEvidenceValue;
  readonly approved_by_user_id: AccessEvidenceValue;
  readonly approved_at: AccessEvidenceValue;
  readonly created_at: AccessEvidenceValue;
  readonly updated_at: AccessEvidenceValue;
  readonly version: AccessEvidenceValue;
}

export interface RoleEvidenceRow {
  readonly id: AccessEvidenceValue;
  readonly workspace_id: AccessEvidenceValue;
  readonly name: AccessEvidenceValue;
  readonly description: AccessEvidenceValue;
  readonly source_preset_key: AccessEvidenceValue;
  readonly source_preset_version: AccessEvidenceValue;
  readonly archived_at: AccessEvidenceValue;
  readonly permission_id: AccessEvidenceValue;
}

export interface AssignmentEvidenceRow {
  readonly id: AccessEvidenceValue;
  readonly user_id: AccessEvidenceValue;
  readonly role_id: AccessEvidenceValue;
  readonly workspace_id: AccessEvidenceValue;
  readonly scope_kind: AccessEvidenceValue;
  readonly event_id: AccessEvidenceValue;
  readonly event_workspace_id: AccessEvidenceValue;
  readonly role_workspace_id: AccessEvidenceValue;
  readonly assigned_by_user_id: AccessEvidenceValue;
  readonly assigned_at: AccessEvidenceValue;
  readonly expires_at: AccessEvidenceValue;
}

export interface OverrideEvidenceRow {
  readonly id: AccessEvidenceValue;
  readonly user_id: AccessEvidenceValue;
  readonly permission_id: AccessEvidenceValue;
  readonly effect: AccessEvidenceValue;
  readonly workspace_id: AccessEvidenceValue;
  readonly scope_kind: AccessEvidenceValue;
  readonly event_id: AccessEvidenceValue;
  readonly event_workspace_id: AccessEvidenceValue;
  readonly reason: AccessEvidenceValue;
  readonly decided_by_user_id: AccessEvidenceValue;
  readonly decided_at: AccessEvidenceValue;
  readonly expires_at: AccessEvidenceValue;
}

const permissionIds = new Set<string>(PERMISSIONS.map((permission) => permission.id));
const presetKeys = new Set<string>(ROLE_PRESETS.map((preset) => preset.key));
const membershipStatuses = new Set<WorkspaceMembership['status']>([
  'invited', 'pending_review', 'active', 'suspended', 'deactivated'
]);

export class AccessEvidenceError extends Error {
  readonly code = 'malformed_access_evidence';

  constructor(message: string) {
    super(message);
    this.name = 'AccessEvidenceError';
  }
}

function malformed(message: string): never {
  throw new AccessEvidenceError(message);
}

export function requiredAccessEvidenceText(value: AccessEvidenceValue, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    malformed(`${field} must be a non-empty string.`);
  }
  return value;
}

function text(value: AccessEvidenceValue, field: string): string {
  if (typeof value !== 'string') malformed(`${field} must be a string.`);
  return value;
}

function optionalText(value: AccessEvidenceValue, field: string): string | undefined {
  return value === null ? undefined : requiredAccessEvidenceText(value, field);
}

function nonNegativeInteger(value: AccessEvidenceValue, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: AccessEvidenceValue, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) malformed(`${field} must be positive.`);
  return parsed;
}

function instant(value: AccessEvidenceValue, field: string): string {
  const result = new Date(nonNegativeInteger(value, field));
  if (!Number.isFinite(result.getTime())) malformed(`${field} is outside the supported instant range.`);
  return result.toISOString();
}

function optionalInstant(value: AccessEvidenceValue, field: string): string | undefined {
  return value === null ? undefined : instant(value, field);
}

function permissionId(value: AccessEvidenceValue, field: string): PermissionId {
  const id = requiredAccessEvidenceText(value, field);
  if (!permissionIds.has(id)) malformed(`${field} is not in the deployed permission catalog.`);
  return id as PermissionId;
}

function accessScope(input: {
  readonly workspaceId: string;
  readonly scopeKind: AccessEvidenceValue;
  readonly eventId: AccessEvidenceValue;
  readonly eventWorkspaceId: AccessEvidenceValue;
  readonly field: string;
}): AccessScope {
  if (input.scopeKind === 'workspace') {
    if (input.eventId !== null || input.eventWorkspaceId !== null) {
      malformed(`${input.field} workspace scope carries event evidence.`);
    }
    return Object.freeze({ kind: 'workspace', workspaceId: input.workspaceId });
  }
  if (input.scopeKind !== 'event') malformed(`${input.field} has an unknown scope kind.`);
  const eventId = requiredAccessEvidenceText(input.eventId, `${input.field}.event_id`);
  const eventWorkspaceId = requiredAccessEvidenceText(
    input.eventWorkspaceId,
    `${input.field}.event_workspace_id`
  );
  if (eventWorkspaceId !== input.workspaceId) {
    malformed(`${input.field} event does not belong to its declared workspace.`);
  }
  return Object.freeze({ kind: 'event', workspaceId: input.workspaceId, eventId });
}

export function membershipFromAccessEvidenceRow(
  row: MembershipEvidenceRow,
  expectedWorkspaceId: string,
  expectedUserId: string
): WorkspaceMembership {
  const workspaceId = requiredAccessEvidenceText(row.workspace_id, 'workspace_memberships.workspace_id');
  const userId = requiredAccessEvidenceText(row.user_id, 'workspace_memberships.user_id');
  if (workspaceId !== expectedWorkspaceId || userId !== expectedUserId) {
    malformed('Membership lookup returned evidence outside the requested principal and workspace.');
  }
  const status = requiredAccessEvidenceText(row.status, 'workspace_memberships.status');
  if (!membershipStatuses.has(status as WorkspaceMembership['status'])) {
    malformed('workspace_memberships.status is unknown.');
  }
  return Object.freeze({
    id: requiredAccessEvidenceText(row.id, 'workspace_memberships.id'),
    workspaceId,
    userId,
    status: status as WorkspaceMembership['status'],
    ...(optionalText(row.approved_by_user_id, 'workspace_memberships.approved_by_user_id')
      ? { approvedByUserId: requiredAccessEvidenceText(row.approved_by_user_id, 'workspace_memberships.approved_by_user_id') }
      : {}),
    ...(optionalInstant(row.approved_at, 'workspace_memberships.approved_at')
      ? { approvedAt: instant(row.approved_at, 'workspace_memberships.approved_at') }
      : {}),
    createdAt: instant(row.created_at, 'workspace_memberships.created_at'),
    updatedAt: instant(row.updated_at, 'workspace_memberships.updated_at'),
    version: positiveInteger(row.version, 'workspace_memberships.version')
  });
}

export function roleFromAccessEvidenceRows(
  rows: readonly RoleEvidenceRow[],
  expectedWorkspaceId: string
): Role {
  const first = rows[0];
  if (!first) malformed('Role evidence group is empty.');
  const id = requiredAccessEvidenceText(first.id, 'roles.id');
  const workspaceId = requiredAccessEvidenceText(first.workspace_id, 'roles.workspace_id');
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
    if (requiredAccessEvidenceText(row.id, 'roles.id') !== id
        || requiredAccessEvidenceText(row.workspace_id, 'roles.workspace_id') !== workspaceId) {
      malformed('Role permission rows do not share one role identity.');
    }
    if (row.permission_id !== null) {
      permissions.push(permissionId(row.permission_id, 'role_permissions.permission_id'));
    }
  }
  return Object.freeze({
    id,
    workspaceId,
    name: requiredAccessEvidenceText(first.name, 'roles.name'),
    description: text(first.description, 'roles.description'),
    permissionIds: Object.freeze(permissions),
    ...(presetKey !== undefined ? { sourcePresetKey: presetKey as RolePresetKey } : {}),
    ...(presetVersion !== undefined ? { sourcePresetVersion: presetVersion } : {}),
    ...(optionalInstant(first.archived_at, 'roles.archived_at')
      ? { archivedAt: instant(first.archived_at, 'roles.archived_at') }
      : {})
  });
}

export function assignmentFromAccessEvidenceRow(
  row: AssignmentEvidenceRow,
  expectedWorkspaceId: string,
  expectedUserId: string
): RoleAssignment {
  const workspaceId = requiredAccessEvidenceText(row.workspace_id, 'role_assignments.workspace_id');
  const userId = requiredAccessEvidenceText(row.user_id, 'role_assignments.user_id');
  if (workspaceId !== expectedWorkspaceId || userId !== expectedUserId) {
    malformed('Role-assignment lookup returned evidence outside the requested principal and workspace.');
  }
  if (requiredAccessEvidenceText(row.role_workspace_id, 'roles.workspace_id') !== workspaceId) {
    malformed('Role assignment references a role from another workspace.');
  }
  const assignedByUserId = optionalText(row.assigned_by_user_id, 'role_assignments.assigned_by_user_id');
  return Object.freeze({
    id: requiredAccessEvidenceText(row.id, 'role_assignments.id'),
    userId,
    roleId: requiredAccessEvidenceText(row.role_id, 'role_assignments.role_id'),
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

export function overrideFromAccessEvidenceRow(
  row: OverrideEvidenceRow,
  expectedWorkspaceId: string,
  expectedUserId: string
): PermissionOverride {
  const workspaceId = requiredAccessEvidenceText(row.workspace_id, 'permission_overrides.workspace_id');
  const userId = requiredAccessEvidenceText(row.user_id, 'permission_overrides.user_id');
  if (workspaceId !== expectedWorkspaceId || userId !== expectedUserId) {
    malformed('Permission-override lookup returned evidence outside the requested principal and workspace.');
  }
  if (row.effect !== 'grant' && row.effect !== 'deny') {
    malformed('permission_overrides.effect is unknown.');
  }
  const decidedByUserId = optionalText(row.decided_by_user_id, 'permission_overrides.decided_by_user_id');
  return Object.freeze({
    id: requiredAccessEvidenceText(row.id, 'permission_overrides.id'),
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
    reason: requiredAccessEvidenceText(row.reason, 'permission_overrides.reason'),
    ...(decidedByUserId !== undefined ? { decidedByUserId } : {}),
    decidedAt: instant(row.decided_at, 'permission_overrides.decided_at'),
    ...(optionalInstant(row.expires_at, 'permission_overrides.expires_at')
      ? { expiresAt: instant(row.expires_at, 'permission_overrides.expires_at') }
      : {})
  });
}
