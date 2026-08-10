import type { Database } from 'bun:sqlite';
import type {
  AccessAdministrationStore,
  MembershipCommand,
  MembershipResult,
  ReservationCommand,
  ReservationResult
} from '@jooevents/application';
import {
  PERMISSIONS,
  failure,
  success,
  type AdapterOutcome,
  type ReservedAccessScope
} from '@jooevents/identity-access';

type Row = Record<string, string | number | null>;

function scopeValues(scope: ReservedAccessScope): [string, string | null] {
  return [scope.kind, scope.kind === 'event' ? scope.eventId : null];
}

function validateScope(sqlite: Database, workspaceId: string, scope: ReservedAccessScope) {
  if (scope.kind === 'workspace') return;
  const event = sqlite.query<Row, [string, string]>('select id from events where id = ? and workspace_id = ?').get(scope.eventId, workspaceId);
  if (!event) throw new Error('event_not_in_workspace');
}

function readReservation(sqlite: Database, id: string): ReservationResult | undefined {
  const row = sqlite.query<Row, [string]>('select * from access_reservations where id = ?').get(id);
  if (!row || row.status !== 'open') return undefined;
  return { id: String(row.id), workspaceId: String(row.workspace_id), normalizedEmail: String(row.normalized_email), status: 'open', version: Number(row.version) };
}

function readMembership(sqlite: Database, id: string): MembershipResult | undefined {
  const row = sqlite.query<Row, [string]>('select id, workspace_id, user_id, status, version from workspace_memberships where id = ?').get(id);
  if (!row || !['active', 'suspended', 'deactivated'].includes(String(row.status))) return undefined;
  return { id: String(row.id), workspaceId: String(row.workspace_id), userId: String(row.user_id), status: String(row.status) as MembershipResult['status'], version: Number(row.version) };
}

function priorTarget(sqlite: Database, action: string, idempotencyKey: string): string | undefined {
  return sqlite.query<{ target_id: string }, [string, string]>('select target_id from audit_events where action = ? and correlation_id = ? limit 1').get(action, `idem:${idempotencyKey}`)?.target_id;
}

function validateAccessRows(sqlite: Database, workspaceId: string, roleAssignments: ReservationCommand['roleAssignments'], overrides: ReservationCommand['permissionOverrides']) {
  for (const assignment of roleAssignments) {
    const role = sqlite.query<Row, [string, string]>('select id from roles where id = ? and workspace_id = ? and archived_at is null').get(assignment.roleId, workspaceId);
    if (!role) throw new Error('role_not_in_workspace');
    validateScope(sqlite, workspaceId, assignment.scope);
  }
  for (const override of overrides) {
    const permission = PERMISSIONS.find((item) => item.id === override.permissionId);
    if (!permission || !(permission.allowedScopes as readonly string[]).includes(override.scope.kind)) throw new Error('permission_scope_not_allowed');
    validateScope(sqlite, workspaceId, override.scope);
  }
}

export function createSQLiteAccessAdministration(sqlite: Database): AccessAdministrationStore {
  return {
    async createReservation(command: ReservationCommand & { normalizedEmail: string }): Promise<AdapterOutcome<ReservationResult>> {
      const action = 'access.reservation.created';
      const prior = priorTarget(sqlite, action, command.idempotencyKey);
      if (prior) {
        const existing = readReservation(sqlite, prior);
        if (existing) return success(existing);
      }
      const reservationId = crypto.randomUUID();
      const nowMs = Date.parse(command.now);
      try {
        sqlite.transaction(() => {
          validateAccessRows(sqlite, command.workspaceId, command.roleAssignments, command.permissionOverrides);
          sqlite.query(`insert into access_reservations
            (id, workspace_id, normalized_email, status, expires_at, created_by_user_id, created_at, version)
            values (?, ?, ?, 'open', ?, ?, ?, 1)`)
            .run(reservationId, command.workspaceId, command.normalizedEmail, command.expiresAt ? Date.parse(command.expiresAt) : null, command.actorUserId, nowMs);
          for (const assignment of command.roleAssignments) {
            const [kind, eventId] = scopeValues(assignment.scope);
            sqlite.query('insert into reservation_role_assignments (id, reservation_id, role_id, scope_kind, event_id) values (?, ?, ?, ?, ?)')
              .run(crypto.randomUUID(), reservationId, assignment.roleId, kind, eventId);
          }
          for (const override of command.permissionOverrides) {
            const [kind, eventId] = scopeValues(override.scope);
            sqlite.query(`insert into reservation_permission_overrides
              (id, reservation_id, permission_id, effect, scope_kind, event_id, reason) values (?, ?, ?, ?, ?, ?, ?)`)
              .run(crypto.randomUUID(), reservationId, override.permissionId, override.effect, kind, eventId, override.reason);
          }
          sqlite.query(`insert into audit_events
            (id, actor_type, actor_id, action, target_type, target_id, workspace_id, evidence_json, correlation_id, occurred_at)
            values (?, 'user', ?, ?, 'access_reservation', ?, ?, ?, ?, ?)`)
            .run(crypto.randomUUID(), command.actorUserId, action, reservationId, command.workspaceId, JSON.stringify({ correlationId: command.correlationId }), `idem:${command.idempotencyKey}`, nowMs);
          sqlite.query(`insert into outbox_events
            (id, type, version, payload_json, aggregate_type, aggregate_id, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
            values (?, 'access.invited', 1, ?, 'access_reservation', ?, ?, 'pending', 0, ?, ?, ?)`)
            .run(crypto.randomUUID(), JSON.stringify({ reservationId, workspaceId: command.workspaceId, email: command.normalizedEmail }), reservationId, `access.invited:${command.idempotencyKey}`, nowMs, nowMs, nowMs);
        })();
        return success({ id: reservationId, workspaceId: command.workspaceId, normalizedEmail: command.normalizedEmail, status: 'open', version: 1 });
      } catch (error) {
        return failure({ code: error instanceof Error ? error.message : 'reservation_write_failed', message: 'The access reservation could not be created.', retryable: false });
      }
    },

    async decideMembership(command: MembershipCommand): Promise<AdapterOutcome<MembershipResult>> {
      const action = `membership.${command.action}d`;
      const prior = priorTarget(sqlite, action, command.idempotencyKey);
      if (prior) {
        const existing = readMembership(sqlite, prior);
        if (existing) return success(existing);
      }
      const nowMs = Date.parse(command.now);
      try {
        sqlite.transaction(() => {
          const current = sqlite.query<Row, [string, string]>('select * from workspace_memberships where id = ? and workspace_id = ?').get(command.membershipId, command.workspaceId);
          if (!current) throw new Error('membership_not_found');
          const currentUserId = String(current.user_id);
          if (Number(current.version) !== command.expectedVersion) throw new Error('stale_membership_version');
          if (command.action === 'suspend') {
            const targetIsAdmin = sqlite.query<Row, [string, string, number]>(`select 1 ok from role_assignments a join roles r on r.id = a.role_id
              where a.user_id = ? and a.workspace_id = ? and a.scope_kind = 'workspace' and r.source_preset_key = 'workspace_admin'
                and r.archived_at is null and (a.expires_at is null or a.expires_at > ?) limit 1`).get(String(current.user_id), command.workspaceId, nowMs);
            if (targetIsAdmin) {
              const adminCount = sqlite.query<{ count: number }, [string, number]>(`select count(distinct m.user_id) count from workspace_memberships m
                join role_assignments a on a.user_id = m.user_id and a.workspace_id = m.workspace_id and a.scope_kind = 'workspace'
                join roles r on r.id = a.role_id and r.source_preset_key = 'workspace_admin' and r.archived_at is null
                where m.workspace_id = ? and m.status = 'active' and (a.expires_at is null or a.expires_at > ?)`)
                .get(command.workspaceId, nowMs)?.count ?? 0;
              if (adminCount <= 1) throw new Error('last_workspace_admin');
            }
          }
          if (command.action === 'approve') {
            validateAccessRows(sqlite, command.workspaceId, command.roleAssignments ?? [], command.permissionOverrides ?? []);
            for (const assignment of command.roleAssignments ?? []) {
              const [kind, eventId] = scopeValues(assignment.scope);
              sqlite.query(`insert into role_assignments (id, user_id, role_id, workspace_id, scope_kind, event_id, assigned_by_user_id, assigned_at, version)
                values (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(crypto.randomUUID(), currentUserId, assignment.roleId, command.workspaceId, kind, eventId, command.actorUserId, nowMs);
            }
            for (const override of command.permissionOverrides ?? []) {
              const [kind, eventId] = scopeValues(override.scope);
              sqlite.query(`insert into permission_overrides (id, user_id, permission_id, effect, workspace_id, scope_kind, event_id, reason, decided_by_user_id, decided_at, version)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(crypto.randomUUID(), currentUserId, override.permissionId, override.effect, command.workspaceId, kind, eventId, override.reason, command.actorUserId, nowMs);
            }
          }
          const status = command.action === 'approve' || command.action === 'restore' ? 'active' : command.action === 'suspend' ? 'suspended' : 'deactivated';
          const result = sqlite.query(`update workspace_memberships set status = ?, approved_by_user_id = ?, approved_at = ?, decision_reason = ?, updated_at = ?, version = version + 1 where id = ? and version = ?`)
            .run(status, command.actorUserId, command.action === 'approve' ? nowMs : null, command.reason ?? null, nowMs, command.membershipId, command.expectedVersion);
          if (result.changes !== 1) throw new Error('stale_membership_version');
          if (command.action === 'approve') sqlite.query(`update users set status = 'active', updated_at = ?, version = version + 1 where id = ? and status = 'pending_review'`).run(nowMs, currentUserId);
          sqlite.query(`insert into audit_events
            (id, actor_type, actor_id, action, target_type, target_id, workspace_id, evidence_json, correlation_id, occurred_at)
            values (?, 'user', ?, ?, 'workspace_membership', ?, ?, ?, ?, ?)`)
            .run(crypto.randomUUID(), command.actorUserId, action, command.membershipId, command.workspaceId, JSON.stringify({ reason: command.reason ?? null, correlationId: command.correlationId }), `idem:${command.idempotencyKey}`, nowMs);
          sqlite.query(`insert into outbox_events
            (id, type, version, payload_json, aggregate_type, aggregate_id, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
            values (?, ?, 1, ?, 'workspace_membership', ?, ?, 'pending', 0, ?, ?, ?)`)
            .run(crypto.randomUUID(), `membership.${command.action === 'approve' ? 'approved' : command.action === 'reject' ? 'rejected' : command.action === 'suspend' ? 'suspended' : 'restored'}`, JSON.stringify({ membershipId: command.membershipId, workspaceId: command.workspaceId }), command.membershipId, `membership.${command.action}:${command.idempotencyKey}`, nowMs, nowMs, nowMs);
        })();
        const result = readMembership(sqlite, command.membershipId);
        if (!result) throw new Error('membership_result_missing');
        return success(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'membership_write_failed';
        const current = readMembership(sqlite, command.membershipId);
        return failure({ code, message: code === 'stale_membership_version' ? 'The membership changed before this decision was saved.' : 'The membership decision could not be saved.', retryable: false, ...(current ? { details: { current } } : {}) });
      }
    }
  };
}
