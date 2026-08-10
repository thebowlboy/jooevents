import type { Database } from 'bun:sqlite';
import { ROLE_PRESETS, normalizeEmail } from '@jooevents/identity-access';

export interface BootstrapResult {
  readonly workspaceId: string;
  readonly workspaceAdminRoleId: string;
  readonly ownerReservationId: string;
  readonly created: boolean;
}

/** Creates installer intent, never a fabricated user or provider identity. */
export function bootstrapEmptyInstall(input: {
  readonly sqlite: Database;
  readonly ownerEmail: string;
  readonly workspaceName: string;
  readonly now: string;
  readonly ids?: { readonly workspaceId: string; readonly roleId: string; readonly reservationId: string; readonly auditId: string };
}): BootstrapResult {
  const existing = input.sqlite.query<{ workspace_id: string; owner_reservation_id: string; role_id: string }, []>(`
    select b.workspace_id, b.owner_reservation_id, r.id as role_id
      from bootstrap_state b
      join roles r on r.workspace_id = b.workspace_id and r.source_preset_key = 'workspace_admin'
     where b.key = 'initial_workspace'
  `).get();
  if (existing) {
    return { workspaceId: existing.workspace_id, workspaceAdminRoleId: existing.role_id, ownerReservationId: existing.owner_reservation_id, created: false };
  }

  const ids = input.ids ?? {
    workspaceId: crypto.randomUUID(),
    roleId: crypto.randomUUID(),
    reservationId: crypto.randomUUID(),
    auditId: crypto.randomUUID()
  };
  const now = Date.parse(input.now);
  const preset = ROLE_PRESETS.find((item) => item.key === 'workspace_admin');
  if (!preset) throw new Error('Workspace Admin preset is missing');

  const run = input.sqlite.transaction(() => {
    input.sqlite.query('insert into workspaces (id, name, state, created_at, updated_at, version) values (?, ?, ?, ?, ?, 1)').run(ids.workspaceId, input.workspaceName, 'active', now, now);
    input.sqlite.query(`insert into roles (id, workspace_id, name, description, source_preset_key, source_preset_version, created_at, updated_at, version)
      values (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(ids.roleId, ids.workspaceId, preset.name, preset.description, preset.key, preset.version, now, now);
    const permissionInsert = input.sqlite.query('insert into role_permissions (role_id, permission_id) values (?, ?)');
    for (const permissionId of preset.permissionIds) permissionInsert.run(ids.roleId, permissionId);
    input.sqlite.query(`insert into access_reservations
      (id, workspace_id, normalized_email, status, created_at, version)
      values (?, ?, ?, 'open', ?, 1)`).run(ids.reservationId, ids.workspaceId, normalizeEmail(input.ownerEmail), now);
    input.sqlite.query(`insert into reservation_role_assignments
      (id, reservation_id, role_id, scope_kind, event_id) values (?, ?, ?, 'workspace', null)`)
      .run(crypto.randomUUID(), ids.reservationId, ids.roleId);
    input.sqlite.query(`insert into audit_events
      (id, actor_type, action, target_type, target_id, workspace_id, evidence_json, correlation_id, occurred_at)
      values (?, 'system', 'bootstrap.workspace.created', 'workspace', ?, ?, ?, ?, ?)`)
      .run(ids.auditId, ids.workspaceId, ids.workspaceId, JSON.stringify({ ownerReservationCreated: true }), `bootstrap:${ids.workspaceId}`, now);
    input.sqlite.query('insert into bootstrap_state (key, workspace_id, owner_reservation_id, completed_at) values (?, ?, ?, ?)')
      .run('initial_workspace', ids.workspaceId, ids.reservationId, now);
  });

  try {
    run();
    return { workspaceId: ids.workspaceId, workspaceAdminRoleId: ids.roleId, ownerReservationId: ids.reservationId, created: true };
  } catch (error) {
    const winner = input.sqlite.query<{ workspace_id: string; owner_reservation_id: string; role_id: string }, []>(`
      select b.workspace_id, b.owner_reservation_id, r.id as role_id
        from bootstrap_state b join roles r on r.workspace_id = b.workspace_id and r.source_preset_key = 'workspace_admin'
       where b.key = 'initial_workspace'
    `).get();
    if (winner) return { workspaceId: winner.workspace_id, workspaceAdminRoleId: winner.role_id, ownerReservationId: winner.owner_reservation_id, created: false };
    throw error;
  }
}
