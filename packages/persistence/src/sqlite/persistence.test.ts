import { afterEach, describe, expect, test } from 'bun:test';
import { planSignIn, type ExternalIdentityClaims } from '@jooevents/identity-access';
import { bootstrapEmptyInstall } from './bootstrap';
import { openSQLite, type OpenSQLiteResult } from './database';
import { createSQLiteProvisioningStore } from './provisioning-store';

const now = '2026-08-09T08:00:00.000Z';
const opened: OpenSQLiteResult[] = [];

function database(): OpenSQLiteResult {
  const result = openSQLite(':memory:');
  opened.push(result);
  return result;
}

function addAuthUser(db: OpenSQLiteResult, authUserId: string, email: string) {
  const timestamp = Date.parse(now);
  db.sqlite.query(`insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)`)
    .run(authUserId, email.split('@')[0] ?? 'Person', email, timestamp, timestamp);
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('SQLite identity/access foundation', () => {
  test('bootstraps once with an owner reservation and copied explicit permissions', () => {
    const db = database();
    const ids = { workspaceId: 'workspace_summit', roleId: 'role_workspace_admin', reservationId: 'reservation_owner', auditId: 'audit_bootstrap' };
    const first = bootstrapEmptyInstall({ sqlite: db.sqlite, ownerEmail: 'Owner@Example.com', workspaceName: 'Summit Operations', now, ids });
    const second = bootstrapEmptyInstall({ sqlite: db.sqlite, ownerEmail: 'changed@example.com', workspaceName: 'Ignored', now });

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    const permissionCount = db.sqlite.query<{ count: number }, []>('select count(*) count from role_permissions where role_id = \'role_workspace_admin\'').get()?.count;
    expect(permissionCount).toBeGreaterThan(10);
    expect(db.sqlite.query<{ normalized_email: string }, []>('select normalized_email from access_reservations').get()?.normalized_email).toBe('owner@example.com');
  });

  test('commits preapproved person, membership, role, identity, audit, avatar job, and ready mapping together', async () => {
    const db = database();
    bootstrapEmptyInstall({
      sqlite: db.sqlite,
      ownerEmail: 'ada@example.com',
      workspaceName: 'Summit Operations',
      now,
      ids: { workspaceId: 'workspace_summit', roleId: 'role_workspace_admin', reservationId: 'reservation_ada', auditId: 'audit_bootstrap' }
    });
    addAuthUser(db, 'auth_ada', 'ada@example.com');
    const claims: ExternalIdentityClaims = {
      provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-subject-ada',
      email: 'Ada@Example.com', emailVerified: true, displayName: 'Ada Lovelace', observedAt: now,
      avatar: { provider: 'google', url: 'https://lh3.googleusercontent.com/a/ada', observedAt: now }
    };
    const store = createSQLiteProvisioningStore(db.sqlite);
    const evidence = await store.loadSignInEvidence({ workspaceId: 'workspace_summit', claims });
    const plan = planSignIn({ workspaceId: 'workspace_summit', claims, ...evidence, now });
    const result = await store.commitSignInPlan({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', plan, correlationId: 'corr_ada', now });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data.membership.status).toBe('active');
    expect(db.sqlite.query<{ provisioning_state: string }, []>('select provisioning_state from auth_user_links where auth_user_id = \'auth_ada\'').get()?.provisioning_state).toBe('ready');
    expect(db.sqlite.query<{ count: number }, []>('select count(*) count from role_assignments').get()?.count).toBe(1);
    expect(db.sqlite.query<{ count: number }, []>('select count(*) count from avatar_import_jobs').get()?.count).toBe(1);
    expect(db.sqlite.query<{ status: string }, []>('select status from access_reservations where id = \'reservation_ada\'').get()?.status).toBe('consumed');
  });

  test('rolls back the whole application transaction when a reserved role is invalid', async () => {
    const db = database();
    bootstrapEmptyInstall({ sqlite: db.sqlite, ownerEmail: 'owner@example.com', workspaceName: 'Summit Operations', now, ids: { workspaceId: 'workspace_summit', roleId: 'role_workspace_admin', reservationId: 'reservation_owner', auditId: 'audit_bootstrap' } });
    addAuthUser(db, 'auth_grace', 'grace@example.com');
    const claims: ExternalIdentityClaims = { provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-subject-grace', email: 'grace@example.com', emailVerified: true, displayName: 'Grace Hopper', observedAt: now };
    const plan = planSignIn({ workspaceId: 'workspace_summit', claims, reservation: {
      id: 'reservation_forged', workspaceId: 'workspace_summit', normalizedEmail: 'grace@example.com',
      roleAssignments: [{ roleId: 'role_from_another_workspace', scope: { kind: 'workspace' } }],
      permissionOverrides: [], status: 'open', createdByUserId: 'user_admin', createdAt: now
    }, now });
    db.sqlite.query(`insert into access_reservations (id, workspace_id, normalized_email, status, created_at, version) values ('reservation_forged', 'workspace_summit', 'grace@example.com', 'open', ?, 1)`).run(Date.parse(now));
    const store = createSQLiteProvisioningStore(db.sqlite);
    const result = await store.commitSignInPlan({ authUserId: 'auth_grace', workspaceId: 'workspace_summit', plan, correlationId: 'corr_grace', now });

    expect(result.kind).toBe('error');
    expect(db.sqlite.query<{ count: number }, []>("select count(*) count from users where display_name = 'Grace Hopper'").get()?.count).toBe(0);
    expect(db.sqlite.query<{ count: number }, []>("select count(*) count from external_identities where subject = 'google-subject-grace'").get()?.count).toBe(0);
  });

  test('pending admission writes a durable admin notification before returning', async () => {
    const db = database();
    bootstrapEmptyInstall({ sqlite: db.sqlite, ownerEmail: 'owner@example.com', workspaceName: 'Summit Operations', now, ids: { workspaceId: 'workspace_summit', roleId: 'role_workspace_admin', reservationId: 'reservation_owner', auditId: 'audit_bootstrap' } });
    addAuthUser(db, 'auth_grace', 'grace@example.com');
    const claims: ExternalIdentityClaims = { provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-subject-grace', email: 'grace@example.com', emailVerified: true, displayName: 'Grace Hopper', observedAt: now };
    const store = createSQLiteProvisioningStore(db.sqlite);
    const plan = planSignIn({ workspaceId: 'workspace_summit', claims, now });
    const result = await store.commitSignInPlan({ authUserId: 'auth_grace', workspaceId: 'workspace_summit', plan, correlationId: 'corr_grace', now });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data.membership.status).toBe('pending_review');
    expect(db.sqlite.query<{ type: string; status: string }, []>('select type, status from outbox_events').get()).toEqual({ type: 'access.requested', status: 'pending' });
  });
});
