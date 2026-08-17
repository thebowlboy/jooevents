import { env } from 'cloudflare:workers';
import { createProvisioningService } from '@jooevents/application';
import { planSignIn, type ExternalIdentityClaims } from '@jooevents/identity-access';
import { beforeAll, describe, expect, test } from 'vitest';
import { createD1AuthPrincipalReader } from '../src/d1-principal-reader';
import { createD1ProvisioningStore } from '../src/d1-provisioning-store';

const uuid = (suffix: number): string =>
  `019c1df8-b8d7-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const now = '2026-08-17T13:00:00.000Z';
const nowMs = Date.parse(now);
const workspaceId = uuid(501);
const roleId = uuid(502);
const reservationId = uuid(503);
const authUserId = uuid(504);

interface CountRow { readonly count: number }
interface LinkRow { readonly provisioning_state: string; readonly user_id: string }
interface ReservationRow { readonly status: string; readonly consumed_by_user_id: string | null }
interface MembershipRow { readonly id: string; readonly status: string }

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 admission workspace','active',?,?,1)`).bind(workspaceId, nowMs, nowMs),
    env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,'D1 owner','Admission test role',NULL,NULL,NULL,?,?,1)`)
      .bind(roleId, workspaceId, nowMs, nowMs),
    env.DB.prepare(`INSERT INTO role_permissions (role_id,permission_id)
      VALUES (?,'event.manage')`).bind(roleId),
    env.DB.prepare(`INSERT INTO access_reservations
      (id,workspace_id,normalized_email,status,created_at,version)
      VALUES (?,?,'owner-d1@example.invalid','open',?,1)`)
      .bind(reservationId, workspaceId, nowMs),
    env.DB.prepare(`INSERT INTO reservation_role_assignments
      (reservation_id,role_id,scope_kind,event_id)
      VALUES (?,?,'workspace',NULL)`).bind(reservationId, roleId),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 Owner','owner-d1@example.invalid',1,
              'https://lh3.googleusercontent.com/a/d1-owner',?,?)`)
      .bind(authUserId, nowMs, nowMs),
    env.DB.prepare(`INSERT INTO auth_accounts
      (id,account_id,provider_id,user_id,created_at,updated_at)
      VALUES (?,'google-d1-owner','google',?,?,?)`)
      .bind(uuid(505), authUserId, nowMs, nowMs)
  ]);
});

describe('D1 application admission', () => {
  test('atomically consumes a reservation, creates authority, and returns current access', async () => {
    const store = createD1ProvisioningStore(env.DB);
    const service = createProvisioningService({
      principals: createD1AuthPrincipalReader(env.DB, {
        issuerOrigin: 'https://auth-test.jooevents.invalid'
      }),
      store,
      admission: { mode: 'reservation_only' }
    });
    const first = await service.ensureAuthPrincipalProvisioned({
      authUserId,
      workspaceId,
      correlationId: uuid(506),
      now
    });
    expect(first).toMatchObject({
      kind: 'success',
      data: {
        state: 'active',
        user: { displayName: 'D1 Owner', primaryEmail: 'owner-d1@example.invalid' },
        workspace: { id: workspaceId, name: 'D1 admission workspace' }
      }
    });
    const link = await env.DB.prepare(`SELECT provisioning_state,user_id
      FROM auth_user_links WHERE auth_user_id = ?`).bind(authUserId).first<LinkRow>();
    const reservation = await env.DB.prepare(`SELECT status,consumed_by_user_id
      FROM access_reservations WHERE id = ?`).bind(reservationId).first<ReservationRow>();
    const membership = await env.DB.prepare(`SELECT id,status FROM workspace_memberships
      WHERE workspace_id = ? AND user_id = ?`).bind(
      workspaceId,
      link?.user_id
    ).first<MembershipRow>();
    const assignments = await env.DB.prepare(`SELECT count(*) AS count FROM role_assignments
      WHERE workspace_id = ? AND user_id = ?`).bind(
      workspaceId,
      link?.user_id
    ).first<CountRow>();
    const identities = await env.DB.prepare(`SELECT count(*) AS count FROM external_identities
      WHERE provider = 'google' AND issuer = 'https://accounts.google.com'
        AND subject = 'google-d1-owner'`).first<CountRow>();

    expect(link?.provisioning_state).toBe('ready');
    expect(reservation).toEqual({ status: 'consumed', consumed_by_user_id: link?.user_id });
    expect(membership?.status).toBe('active');
    expect(assignments?.count).toBe(1);
    expect(identities?.count).toBe(1);
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM avatar_import_jobs
      WHERE user_id = ?`).bind(link?.user_id).first<CountRow>())?.count).toBe(1);

    const replay = await service.ensureAuthPrincipalProvisioned({
      authUserId,
      workspaceId,
      correlationId: uuid(507),
      now
    });
    expect(replay).toEqual(first);
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM users
      WHERE display_name = 'D1 Owner'`).first<CountRow>())?.count).toBe(1);

    await env.DB.prepare(`UPDATE workspace_memberships
      SET status = 'suspended',updated_at = ?,version = version + 1 WHERE id = ?`)
      .bind(nowMs + 1, membership?.id).run();
    const blocked = await service.ensureAuthPrincipalProvisioned({
      authUserId,
      workspaceId,
      correlationId: uuid(508),
      now
    });
    expect(blocked).toMatchObject({
      kind: 'success',
      data: { state: 'blocked', code: 'suspended' }
    });
  });

  test('rolls back the entire D1 admission batch when reserved authority is invalid', async () => {
    const secondAuthUserId = uuid(509);
    await env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'Invalid Role','invalid-role@example.invalid',1,NULL,?,?)`)
      .bind(secondAuthUserId, nowMs, nowMs).run();
    const claims: ExternalIdentityClaims = {
      provider: 'email',
      issuer: 'https://auth-test.jooevents.invalid',
      subject: secondAuthUserId,
      email: 'invalid-role@example.invalid',
      emailVerified: true,
      displayName: 'Invalid Role',
      observedAt: now
    };
    const forgedReservationId = uuid(510);
    await env.DB.prepare(`INSERT INTO access_reservations
      (id,workspace_id,normalized_email,status,created_at,version)
      VALUES (?,?,'invalid-role@example.invalid','open',?,1)`)
      .bind(forgedReservationId, workspaceId, nowMs).run();
    const plan = planSignIn({
      workspaceId,
      claims,
      reservation: {
        id: forgedReservationId,
        workspaceId,
        normalizedEmail: 'invalid-role@example.invalid',
        roleAssignments: [{ roleId: uuid(999), scope: { kind: 'workspace' } }],
        permissionOverrides: [],
        status: 'open',
        createdByUserId: 'system_bootstrap',
        createdAt: now
      },
      now
    });
    const result = await createD1ProvisioningStore(env.DB).commitSignInPlan({
      authUserId: secondAuthUserId,
      workspaceId,
      plan,
      correlationId: uuid(511),
      now
    });
    expect(result.kind).toBe('error');
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM users
      WHERE display_name = 'Invalid Role'`).first<CountRow>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM external_identities
      WHERE subject = ?`).bind(secondAuthUserId).first<CountRow>())?.count).toBe(0);
  });

  test('keeps open admission pending and does not duplicate its durable notification', async () => {
    const pendingAuthUserId = uuid(512);
    await env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'Pending Person','pending-d1@example.invalid',1,NULL,?,?)`)
      .bind(pendingAuthUserId, nowMs, nowMs).run();
    const service = createProvisioningService({
      principals: createD1AuthPrincipalReader(env.DB, {
        issuerOrigin: 'https://auth-test.jooevents.invalid'
      }),
      store: createD1ProvisioningStore(env.DB),
      admission: { mode: 'pending' }
    });
    const first = await service.ensureAuthPrincipalProvisioned({
      authUserId: pendingAuthUserId,
      workspaceId,
      correlationId: uuid(513),
      now
    });
    const replay = await service.ensureAuthPrincipalProvisioned({
      authUserId: pendingAuthUserId,
      workspaceId,
      correlationId: uuid(514),
      now
    });
    const link = await env.DB.prepare(`SELECT provisioning_state,user_id
      FROM auth_user_links WHERE auth_user_id = ?`)
      .bind(pendingAuthUserId).first<LinkRow>();
    const notifications = await env.DB.prepare(`SELECT count(*) AS count FROM outbox_events
      WHERE idempotency_key = ?`).bind(
      `access.requested:${workspaceId}:${link?.user_id}`
    ).first<CountRow>();
    expect(first).toMatchObject({
      kind: 'success',
      data: { state: 'pending_review', user: { displayName: 'Pending Person' } }
    });
    expect(replay).toEqual(first);
    expect(link?.provisioning_state).toBe('ready');
    expect(notifications?.count).toBe(1);
  });

  test('never links a second provider principal from equal verified email alone', async () => {
    const conflictingAuthUserId = uuid(515);
    const result = await createProvisioningService({
      principals: {
        async getVerifiedClaims() {
          return {
            kind: 'success' as const,
            data: {
              provider: 'google',
              issuer: 'https://accounts.google.com',
              subject: 'different-google-subject',
              email: 'owner-d1@example.invalid',
              emailVerified: true,
              displayName: 'Conflicting Principal',
              observedAt: now
            },
            notices: []
          };
        }
      },
      store: createD1ProvisioningStore(env.DB),
      admission: { mode: 'pending' }
    }).ensureAuthPrincipalProvisioned({
      authUserId: conflictingAuthUserId,
      workspaceId,
      correlationId: uuid(517),
      now
    });
    expect(result).toMatchObject({
      kind: 'success',
      data: { state: 'blocked', code: 'not_admitted' }
    });
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM auth_user_links
      WHERE auth_user_id = ?`).bind(conflictingAuthUserId).first<CountRow>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM external_identities
      WHERE subject = 'different-google-subject'`).first<CountRow>())?.count).toBe(0);
  });
});
