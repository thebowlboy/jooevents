import { env } from 'cloudflare:workers';
import {
  createProvisioningService,
  deriveDurableCryptoProfileKey
} from '@jooevents/application';
import { planSignIn, type ExternalIdentityClaims } from '@jooevents/identity-access';
import { canonicalJsonText } from '@jooevents/kernel';
import { createHmac } from 'node:crypto';
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

  test('admits a classified invitation without indexing the recipient mailbox as plaintext', async () => {
    const classifiedAuthUserId = uuid(518);
    const classifiedReservationId = uuid(519);
    const payloadRefId = uuid(520);
    const normalizedEmail = 'classified-owner@example.invalid';
    const rootKeyBytes = new Uint8Array(32).fill(0x37);
    const lookupKeyBytes = deriveDurableCryptoProfileKey({
      rootKeyBytes,
      coordinate: {
        family: 'persistent_hmac',
        purpose: 'persistent-domain-hmac',
        key: 'security.workspace-invitation-lookup',
        version: 1
      }
    });
    rootKeyBytes.fill(0);
    const lookupBinding = createHmac('sha256', lookupKeyBytes)
      .update(canonicalJsonText({ workspaceId, normalizedEmail }))
      .digest('hex');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO classified_payload_records (
        payload_ref_id,record_schema_version,
        encryption_profile_key,encryption_profile_version,
        classification_profile_key,classification_profile_version,
        schema_profile_key,schema_profile_version,
        content_profile_key,content_profile_version,
        integrity_profile_key,integrity_profile_version,
        descriptor_auth_profile_key,descriptor_auth_profile_version,
        scope_binding,purpose,content_type,byte_size,
        integrity_digest_sha256,authenticated_data_digest_sha256,
        nonce,ciphertext,authentication_tag,created_at_ms
      ) VALUES (?,1,'encryption.workspace-invitation',1,
        'classification.workspace_invitation_recipient',1,
        'schema.workspace_invitation_recipient',1,
        'content.workspace_invitation_recipient',1,
        'integrity.sha256',1,'descriptor_auth.workspace_invitation_recipient',1,
        ?,'workspace_invitation.recipient',
        'application/vnd.jooevents.workspace-invitation-recipient+json',0,
        ?,?,?,?, ?,?)`).bind(
        payloadRefId,
        `workspace:${workspaceId}/reservation:${classifiedReservationId}`,
        '0'.repeat(64),
        '0'.repeat(64),
        new ArrayBuffer(12),
        new ArrayBuffer(0),
        new ArrayBuffer(16),
        nowMs
      ),
      env.DB.prepare(`INSERT INTO access_reservations
        (id,workspace_id,normalized_email,status,created_at,version)
        VALUES (?,?,?,'open',?,1)`).bind(
        classifiedReservationId,
        workspaceId,
        lookupBinding,
        nowMs
      ),
      env.DB.prepare(`INSERT INTO reservation_role_assignments
        (reservation_id,role_id,scope_kind,event_id)
        VALUES (?,?,'workspace',NULL)`).bind(classifiedReservationId, roleId),
      env.DB.prepare(`INSERT INTO workspace_team_invitation_recipients
        (reservation_id,workspace_id,payload_ref_id,lookup_binding,recipient_hint,created_at_ms)
        VALUES (?,?,?,?,?,?)`).bind(
        classifiedReservationId,
        workspaceId,
        payloadRefId,
        lookupBinding,
        `recipient-${lookupBinding.slice(0, 12)}`,
        nowMs
      ),
      env.DB.prepare(`INSERT INTO auth_users
        (id,name,email,email_verified,image,created_at,updated_at)
        VALUES (?,'Classified Owner',?,1,NULL,?,?)`).bind(
        classifiedAuthUserId,
        normalizedEmail,
        nowMs,
        nowMs
      ),
      env.DB.prepare(`INSERT INTO auth_accounts
        (id,account_id,provider_id,user_id,created_at,updated_at)
        VALUES (?,'google-classified-owner','google',?,?,?)`).bind(
        uuid(521),
        classifiedAuthUserId,
        nowMs,
        nowMs
      )
    ]);
    const store = createD1ProvisioningStore(env.DB, {
      workspaceInvitationLookupKeyBytes: [lookupKeyBytes]
    });
    lookupKeyBytes.fill(0);
    const result = await createProvisioningService({
      principals: createD1AuthPrincipalReader(env.DB, {
        issuerOrigin: 'https://auth-test.jooevents.invalid'
      }),
      store,
      admission: { mode: 'reservation_only' }
    }).ensureAuthPrincipalProvisioned({
      authUserId: classifiedAuthUserId,
      workspaceId,
      correlationId: uuid(522),
      now
    });
    expect(result).toMatchObject({
      kind: 'success',
      data: {
        state: 'active',
        user: { displayName: 'Classified Owner', primaryEmail: normalizedEmail }
      }
    });
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM access_reservations
      WHERE workspace_id = ? AND normalized_email = ?`).bind(
        workspaceId,
        normalizedEmail
      ).first<CountRow>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT status FROM access_reservations
      WHERE id = ?`).bind(classifiedReservationId).first<ReservationRow>())?.status).toBe('consumed');
  });
});
