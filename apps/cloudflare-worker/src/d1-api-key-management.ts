import {
  createApiKeyManagementProfiles,
  createApiKeyManagementPermissionViews,
  type ApiKeyManagementReadPort
} from '@jooevents/application';
import {
  apiKeyListDataSchema,
  type ApiKeyListDataDto,
  type ApiKeyViewDto
} from '@jooevents/contracts';
import {
  API_KEY_DEFAULT_POLICY,
  PERMISSIONS,
  evaluateAccess,
  parseApiKeyPolicy,
  type ApiKeyPolicy,
  type PermissionId
} from '@jooevents/identity-access';
import {
  parseApiKeyId,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  assignmentFromAccessEvidenceRow,
  membershipFromAccessEvidenceRow,
  overrideFromAccessEvidenceRow,
  roleFromAccessEvidenceRows,
  type AssignmentEvidenceRow,
  type MembershipEvidenceRow,
  type OverrideEvidenceRow,
  type RoleEvidenceRow
} from '@jooevents/persistence/access-evidence';

interface ApiKeyRow {
  readonly api_key_id: string;
  readonly owner_user_id: string;
  readonly owner_display_name: string;
  readonly display_name: string;
  readonly token_hint: string;
  readonly may_read: number;
  readonly may_submit_plans: number;
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly last_used_at_ms: number | null;
  readonly standing: string;
  readonly revoked_at_ms: number | null;
  readonly revoke_reason: string | null;
  readonly version: number;
}
interface ApiKeyPermissionRow { readonly api_key_id: string; readonly permission_id: string }
interface ApiKeyEventRow { readonly api_key_id: string; readonly event_id: string }
interface EventRow { readonly id: string; readonly name: string }
interface TimezoneRow { readonly timezone: string }

const permissionIds = new Set(PERMISSIONS.map((permission) => permission.id));

export class D1ApiKeyManagementReadError extends Error {
  readonly name = 'D1ApiKeyManagementReadError';

  constructor(readonly code: 'membership_corrupt' | 'authority_corrupt' | 'key_data_corrupt') {
    super(code);
  }
}

function boolean(value: number): boolean {
  if (value !== 0 && value !== 1) throw new D1ApiKeyManagementReadError('key_data_corrupt');
  return value === 1;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new D1ApiKeyManagementReadError('key_data_corrupt');
  }
  return value;
}

function instant(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1ApiKeyManagementReadError('key_data_corrupt');
  }
  return parseInstant(new Date(value).toISOString());
}

function permissionId(value: string, code: 'authority_corrupt' | 'key_data_corrupt'): PermissionId {
  if (!permissionIds.has(value as PermissionId)) throw new D1ApiKeyManagementReadError(code);
  return value as PermissionId;
}

function grouped<Row extends { readonly api_key_id: string }, Value>(
  rows: readonly Row[],
  project: (row: Row) => Value
): Map<string, Value[]> {
  const result = new Map<string, Value[]>();
  for (const row of rows) {
    const values = result.get(row.api_key_id);
    if (values) values.push(project(row));
    else result.set(row.api_key_id, [project(row)]);
  }
  return result;
}

function uniqueSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

/** Reads one human-authorized API-key management projection from a D1 primary snapshot. */
export function createD1ApiKeyManagementReadPort(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly nowEpochMs: () => number;
  readonly policy?: ApiKeyPolicy;
}): ApiKeyManagementReadPort {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const policy = parseApiKeyPolicy(input.policy ?? API_KEY_DEFAULT_POLICY);

  return Object.freeze({
    async read(viewerUserId: UserId): Promise<ApiKeyListDataDto> {
      const userId = parseUserId(viewerUserId);
      const nowEpochMs = input.nowEpochMs();
      if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
        throw new TypeError('d1_api_key_management_time_invalid');
      }
      const session = input.database.withSession('first-primary');
      const [membershipResult, roleResult, assignmentResult, overrideResult, keyResult,
        keyPermissionResult, keyEventResult, eventResult, timezoneResult] =
        await session.batch([
          session.prepare(`SELECT id,workspace_id,user_id,status,approved_by_user_id,
            approved_at,created_at,updated_at,version FROM workspace_memberships
            WHERE workspace_id = ? AND user_id = ? LIMIT 2`).bind(workspaceId, userId),
          session.prepare(`SELECT role.id,role.workspace_id,role.name,role.description,
            role.source_preset_key,role.source_preset_version,role.archived_at,
            permission.permission_id
            FROM roles role LEFT JOIN role_permissions permission ON permission.role_id = role.id
            WHERE role.workspace_id = ?
            ORDER BY role.id COLLATE BINARY,permission.permission_id COLLATE BINARY`)
            .bind(workspaceId),
          session.prepare(`SELECT assignment.id,assignment.user_id,assignment.role_id,
            assignment.workspace_id,assignment.scope_kind,assignment.event_id,
            event.workspace_id AS event_workspace_id,role.workspace_id AS role_workspace_id,
            assignment.assigned_by_user_id,assignment.assigned_at,assignment.expires_at
            FROM role_assignments assignment JOIN roles role ON role.id = assignment.role_id
            LEFT JOIN events event ON event.id = assignment.event_id
            WHERE assignment.workspace_id = ? AND assignment.user_id = ?
            ORDER BY assignment.id COLLATE BINARY`).bind(workspaceId, userId),
          session.prepare(`SELECT override.id,override.user_id,override.permission_id,
            override.effect,override.workspace_id,override.scope_kind,override.event_id,
            event.workspace_id AS event_workspace_id,override.reason,
            override.decided_by_user_id,override.decided_at,override.expires_at
            FROM permission_overrides override LEFT JOIN events event ON event.id = override.event_id
            WHERE override.workspace_id = ? AND override.user_id = ?
            ORDER BY override.id COLLATE BINARY`).bind(workspaceId, userId),
          session.prepare(`SELECT key.api_key_id,key.owner_user_id,
            owner.display_name AS owner_display_name,key.display_name,key.token_hint,
            key.may_read,key.may_submit_plans,key.created_at_ms,key.expires_at_ms,
            key.last_used_at_ms,key.standing,key.revoked_at_ms,key.revoke_reason,key.version
            FROM api_keys key JOIN users owner ON owner.id = key.owner_user_id
            WHERE key.workspace_id = ?
            ORDER BY key.created_at_ms DESC,key.api_key_id COLLATE BINARY`).bind(workspaceId),
          session.prepare(`SELECT scope.api_key_id,scope.permission_id
            FROM api_key_permission_scopes scope JOIN api_keys key ON key.api_key_id = scope.api_key_id
            WHERE key.workspace_id = ?
            ORDER BY scope.api_key_id COLLATE BINARY,scope.permission_id COLLATE BINARY`)
            .bind(workspaceId),
          session.prepare(`SELECT scope.api_key_id,scope.event_id
            FROM api_key_event_scopes scope JOIN api_keys key ON key.api_key_id = scope.api_key_id
            WHERE key.workspace_id = ?
            ORDER BY scope.api_key_id COLLATE BINARY,scope.event_id COLLATE BINARY`)
            .bind(workspaceId),
          session.prepare(`SELECT id,name FROM event_spine_heads
            WHERE workspace_id = ? ORDER BY name COLLATE BINARY,id COLLATE BINARY`)
            .bind(workspaceId),
          session.prepare(`SELECT head.timezone FROM event_spine_workspace_sets selection
            JOIN event_spine_heads head ON head.workspace_id = selection.workspace_id
              AND head.id = selection.current_event_id
            WHERE selection.workspace_id = ? LIMIT 2`).bind(workspaceId)
        ]);

      const memberships = (membershipResult as D1Result<MembershipEvidenceRow>).results;
      if (memberships.length > 1) throw new D1ApiKeyManagementReadError('membership_corrupt');
      const membership = memberships[0]
        ? membershipFromAccessEvidenceRow(memberships[0], workspaceId, userId)
        : undefined;
      const roleGroups = new Map<string, RoleEvidenceRow[]>();
      for (const row of (roleResult as D1Result<RoleEvidenceRow>).results) {
        if (typeof row.id !== 'string') throw new D1ApiKeyManagementReadError('authority_corrupt');
        const rows = roleGroups.get(row.id);
        if (rows) rows.push(row);
        else roleGroups.set(row.id, [row]);
      }
      const roles = [...roleGroups.values()].map((rows) =>
        roleFromAccessEvidenceRows(rows, workspaceId)
      );
      const assignments = (assignmentResult as D1Result<AssignmentEvidenceRow>).results.map(
        (row) => assignmentFromAccessEvidenceRow(row, workspaceId, userId)
      );
      const overrides = (overrideResult as D1Result<OverrideEvidenceRow>).results.map(
        (row) => overrideFromAccessEvidenceRow(row, workspaceId, userId)
      );
      const now = parseInstant(new Date(nowEpochMs).toISOString());
      const held = new Set<PermissionId>(PERMISSIONS
        .filter((permission) => evaluateAccess({
          userId,
          permissionId: permission.id,
          requestedScope: { kind: 'workspace', workspaceId },
          ...(membership ? { membership } : {}),
          roles,
          assignments,
          overrides,
          now
        }).allowed)
        .map((permission) => permission.id));
      const mayAdminister = held.has('access.roles.manage');

      const keyPermissions = grouped(
        (keyPermissionResult as D1Result<ApiKeyPermissionRow>).results,
        (row) => permissionId(row.permission_id, 'key_data_corrupt')
      );
      const keyEvents = grouped(
        (keyEventResult as D1Result<ApiKeyEventRow>).results,
        (row) => parseEventId(row.event_id)
      );
      const allKeys = (keyResult as D1Result<ApiKeyRow>).results;
      if (allKeys.length > 10_000) throw new D1ApiKeyManagementReadError('key_data_corrupt');
      const knownKeyIds = new Set(allKeys.map((row) => row.api_key_id));
      if ([...keyPermissions.keys(), ...keyEvents.keys()].some((id) => !knownKeyIds.has(id))) {
        throw new D1ApiKeyManagementReadError('key_data_corrupt');
      }
      const keys: ApiKeyViewDto[] = [];
      for (const row of allKeys) {
        if (!mayAdminister && row.owner_user_id !== userId) continue;
        const permissions = keyPermissions.get(row.api_key_id) ?? [];
        const events = keyEvents.get(row.api_key_id) ?? [];
        if (!uniqueSorted(permissions) || !uniqueSorted(events)) {
          throw new D1ApiKeyManagementReadError('key_data_corrupt');
        }
        keys.push({
          id: parseApiKeyId(row.api_key_id),
          ownerUserId: parseUserId(row.owner_user_id),
          ownerDisplayName: row.owner_display_name,
          name: row.display_name,
          tokenHint: row.token_hint,
          reads: boolean(row.may_read),
          proposesChanges: boolean(row.may_submit_plans),
          permissionIds: permissions,
          eventIds: events,
          createdAt: instant(row.created_at_ms)!,
          expiresAt: instant(row.expires_at_ms),
          lastUsedAt: instant(row.last_used_at_ms),
          standing: row.standing as ApiKeyViewDto['standing'],
          revokedAt: instant(row.revoked_at_ms),
          revokeReason: row.revoke_reason as ApiKeyViewDto['revokeReason'],
          version: positiveInteger(row.version)
        });
      }

      const timezoneRows = (timezoneResult as D1Result<TimezoneRow>).results;
      if (timezoneRows.length > 1) throw new D1ApiKeyManagementReadError('key_data_corrupt');
      const events = (eventResult as D1Result<EventRow>).results.map((event) => ({
        id: parseEventId(event.id),
        name: event.name
      }));
      return apiKeyListDataSchema.parse({
        schemaVersion: 1,
        timezone: timezoneRows[0]?.timezone ?? 'UTC',
        keys,
        permissions: createApiKeyManagementPermissionViews(held),
        profiles: createApiKeyManagementProfiles(),
        events,
        expiry: {
          defaultDays: policy.defaultTtlDays,
          maxDays: policy.maximumTtlDays,
          rotationGraceHours: policy.rotationGraceHours
        }
      });
    }
  });
}
