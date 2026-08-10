import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrapEmptyInstall } from './bootstrap';
import { openSQLite, type OpenSQLiteResult } from './database';
import { createSQLiteAccessAdministration } from './access-administration';

const now = '2026-08-09T08:00:00.000Z';
const opened: OpenSQLiteResult[] = [];

function fixture() {
  const db = openSQLite(':memory:');
  opened.push(db);
  bootstrapEmptyInstall({ sqlite: db.sqlite, ownerEmail: 'owner@example.com', workspaceName: 'Summit Operations', now, ids: { workspaceId: 'workspace_summit', roleId: 'role_workspace_admin', reservationId: 'reservation_owner', auditId: 'audit_bootstrap' } });
  const timestamp = Date.parse(now);
  db.sqlite.query(`insert into users (id, status, display_name, created_at, updated_at, version) values ('user_admin', 'active', 'Admin', ?, ?, 1), ('user_grace', 'pending_review', 'Grace Hopper', ?, ?, 1)`).run(timestamp, timestamp, timestamp, timestamp);
  db.sqlite.query(`insert into workspace_memberships (id, workspace_id, user_id, status, created_at, updated_at, version) values ('membership_admin', 'workspace_summit', 'user_admin', 'active', ?, ?, 1), ('membership_grace', 'workspace_summit', 'user_grace', 'pending_review', ?, ?, 1)`).run(timestamp, timestamp, timestamp, timestamp);
  db.sqlite.query(`insert into role_assignments (id, user_id, role_id, workspace_id, scope_kind, assigned_by_user_id, assigned_at, version) values ('assignment_admin', 'user_admin', 'role_workspace_admin', 'workspace_summit', 'workspace', 'user_admin', ?, 1)`).run(timestamp);
  return db;
}

afterEach(() => { while (opened.length) opened.pop()?.sqlite.close(); });

describe('SQLite access administration', () => {
  test('creates one idempotent reservation with exact copied access and durable effects', async () => {
    const db = fixture();
    const store = createSQLiteAccessAdministration(db.sqlite);
    const command = {
      workspaceId: 'workspace_summit', email: 'Ada@Example.com', normalizedEmail: 'ada@example.com',
      roleAssignments: [{ roleId: 'role_workspace_admin', scope: { kind: 'workspace' as const } }], permissionOverrides: [],
      actorUserId: 'user_admin', idempotencyKey: 'invite-ada', correlationId: 'corr_invite_ada', now
    };
    const first = await store.createReservation(command);
    const second = await store.createReservation(command);
    expect(first.kind).toBe('success');
    expect(second).toEqual(first);
    expect(db.sqlite.query<{ count: number }, []>("select count(*) count from access_reservations where normalized_email = 'ada@example.com'").get()?.count).toBe(1);
    expect(db.sqlite.query<{ count: number }, []>("select count(*) count from outbox_events where type = 'access.invited'").get()?.count).toBe(1);
  });

  test('approval is optimistic, auditable, and writes notification in the same transaction', async () => {
    const db = fixture();
    const store = createSQLiteAccessAdministration(db.sqlite);
    const command = {
      action: 'approve' as const, membershipId: 'membership_grace', workspaceId: 'workspace_summit', expectedVersion: 1,
      roleAssignments: [], permissionOverrides: [], actorUserId: 'user_admin', idempotencyKey: 'approve-grace', correlationId: 'corr_approve_grace', now
    };
    const result = await store.decideMembership(command);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data).toMatchObject({ status: 'active', version: 2 });
    const stale = await store.decideMembership({ ...command, idempotencyKey: 'approve-grace-stale' });
    expect(stale.kind).toBe('error');
    if (stale.kind === 'error') expect(stale.error.code).toBe('stale_membership_version');
    expect(db.sqlite.query<{ type: string }, []>("select type from outbox_events where aggregate_id = 'membership_grace'").get()?.type).toBe('membership.approved');
  });

  test('refuses to suspend the last effective workspace administrator', async () => {
    const db = fixture();
    const result = await createSQLiteAccessAdministration(db.sqlite).decideMembership({
      action: 'suspend', membershipId: 'membership_admin', workspaceId: 'workspace_summit', expectedVersion: 1,
      reason: 'Test last-admin guard', actorUserId: 'user_admin', idempotencyKey: 'suspend-admin', correlationId: 'corr_suspend_admin', now
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error.code).toBe('last_workspace_admin');
    expect(db.sqlite.query<{ status: string }, []>("select status from workspace_memberships where id = 'membership_admin'").get()?.status).toBe('active');
  });
});
