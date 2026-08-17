import type { Database } from 'bun:sqlite';
import type {
  AuthorizationRepository,
  MembershipRepository,
  UserId,
  WorkspaceId
} from '@jooevents/identity-access';
import {
  AccessEvidenceError as SQLiteAccessEvidenceError,
  assignmentFromAccessEvidenceRow,
  membershipFromAccessEvidenceRow,
  overrideFromAccessEvidenceRow,
  requiredAccessEvidenceText,
  roleFromAccessEvidenceRows,
  type AssignmentEvidenceRow,
  type MembershipEvidenceRow,
  type OverrideEvidenceRow,
  type RoleEvidenceRow
} from '../access-evidence';

export { SQLiteAccessEvidenceError };

/** Reads current workspace admission evidence without evaluating permission policy. */
export function createSQLiteMembershipRepository(sqlite: Database): MembershipRepository {
  return Object.freeze({
    async find(workspaceId: WorkspaceId, userId: UserId) {
      const rows = sqlite.query<MembershipEvidenceRow, [string, string]>(`
        select id, workspace_id, user_id, status, approved_by_user_id, approved_at,
               created_at, updated_at, version
          from workspace_memberships
         where workspace_id = ? and user_id = ?
         limit 2
      `).all(workspaceId, userId);
      if (rows.length > 1) throw new SQLiteAccessEvidenceError('Membership lookup is not unique.');
      const row = rows[0];
      return row ? membershipFromAccessEvidenceRow(row, workspaceId, userId) : undefined;
    }
  });
}

/** Reads complete current authorization evidence; `evaluateAccess` remains the policy owner. */
export function createSQLiteAuthorizationRepository(sqlite: Database): AuthorizationRepository {
  return Object.freeze({
    async listRoles(workspaceId: WorkspaceId) {
      const rows = sqlite.query<RoleEvidenceRow, [string]>(`
        select r.id, r.workspace_id, r.name, r.description, r.source_preset_key,
               r.source_preset_version, r.archived_at, rp.permission_id
          from roles r
          left join role_permissions rp on rp.role_id = r.id
         where r.workspace_id = ?
         order by r.id collate binary asc, rp.permission_id collate binary asc
      `).all(workspaceId);
      const groups = new Map<string, RoleEvidenceRow[]>();
      for (const row of rows) {
        const id = requiredAccessEvidenceText(row.id, 'roles.id');
        const group = groups.get(id);
        if (group) group.push(row);
        else groups.set(id, [row]);
      }
      return Object.freeze([...groups.values()].map((group) =>
        roleFromAccessEvidenceRows(group, workspaceId)
      ));
    },

    async listAssignments(workspaceId: WorkspaceId, userId: UserId) {
      const rows = sqlite.query<AssignmentEvidenceRow, [string, string]>(`
        select a.id, a.user_id, a.role_id, a.workspace_id, a.scope_kind, a.event_id,
               e.workspace_id as event_workspace_id, r.workspace_id as role_workspace_id,
               a.assigned_by_user_id, a.assigned_at, a.expires_at
          from role_assignments a
          join roles r on r.id = a.role_id
          left join events e on e.id = a.event_id
         where a.workspace_id = ? and a.user_id = ?
         order by a.id collate binary asc
      `).all(workspaceId, userId);
      return Object.freeze(rows.map((row: AssignmentEvidenceRow) =>
        assignmentFromAccessEvidenceRow(row, workspaceId, userId)
      ));
    },

    async listOverrides(workspaceId: WorkspaceId, userId: UserId) {
      const rows = sqlite.query<OverrideEvidenceRow, [string, string]>(`
        select o.id, o.user_id, o.permission_id, o.effect, o.workspace_id,
               o.scope_kind, o.event_id, e.workspace_id as event_workspace_id,
               o.reason, o.decided_by_user_id, o.decided_at, o.expires_at
          from permission_overrides o
          left join events e on e.id = o.event_id
         where o.workspace_id = ? and o.user_id = ?
         order by o.id collate binary asc
      `).all(workspaceId, userId);
      return Object.freeze(rows.map((row: OverrideEvidenceRow) =>
        overrideFromAccessEvidenceRow(row, workspaceId, userId)
      ));
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
