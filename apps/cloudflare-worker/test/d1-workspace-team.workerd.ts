import { env } from 'cloudflare:workers';
import { makeSignature } from 'better-auth/crypto';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
  WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE,
  WORKSPACE_INVITATION_RECIPIENT_PURPOSE
} from '@jooevents/application';
import { createDurableCryptoProfileComposition } from '@jooevents/application/durable-crypto-profiles';
import { ImmutableClassifiedPayloadRecordCodec } from '@jooevents/application/immutable-classified-payload-record';
import { WORKSPACE_TEAM_ROLES } from '@jooevents/identity-access';
import { canonicalJsonText, parseInstant, parsePayloadRefId } from '@jooevents/kernel';
import { handleRequest, type CloudflareApplicationEnvironment } from '../src/index';

const uuid = (suffix: number): string =>
  `019c2ef9-2250-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = uuid(801);
const userId = uuid(802);
const membershipId = uuid(803);
const emailId = uuid(804);
const authUserId = uuid(805);
const sessionId = uuid(806);
const assignmentId = uuid(807);
const reservationId = uuid(808);
const reservationAssignmentId = uuid(809);
const payloadRefId = uuid(810);
const releaseIntentId = uuid(811);
const secondUserId = uuid(812);
const secondMembershipId = uuid(813);
const secondEmailId = uuid(814);
const secondAssignmentId = uuid(815);
const roleIds = new Map(
  WORKSPACE_TEAM_ROLES.map((role, index) => [role.key, uuid(820 + index)])
);
const rawSessionToken = 'd1-workspace-team-session-token';
const secret = 'd1-workspace-team-auth-secret-at-least-thirty-two-characters';
const baseUrl = 'https://workspace-team.jooevents.invalid';
const email = 'workspace-owner@example.invalid';
const invitationEmail = 'future-teammate@example.invalid';
const secondEmail = 'second-teammate@example.invalid';
const newInvitationEmail = 'new-teammate@example.invalid';
const lookupBinding = 'a'.repeat(64);
const recipientHint = 'recipient-aaaaaaaaaaaa';

const ring = (byte: number): string =>
  `1:${Buffer.alloc(32, byte).toString('base64url')}`;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value)).digest('hex');
}

beforeAll(async () => {
  const now = Date.now();
  const adminRoleId = roleIds.get('workspace_admin')!;
  const viewerRoleId = roleIds.get('viewer')!;
  const cryptoProfiles = createDurableCryptoProfileComposition({
    requestHashKeys: ring(0x41),
    idempotencyKeys: ring(0x42),
    classifiedPayloadKeys: ring(0x43),
    persistentHmacKeys: ring(0x44)
  });
  const selected = cryptoProfiles.classifiedPayloadEncryptionProfiles(
    cryptoProfiles.profileSelection(
      'classified_payload',
      'encryption.workspace-invitation'
    )
  );
  const recipientBytes = new TextEncoder().encode(canonicalJsonText({ email: invitationEmail }));
  const classifiedRecord = new ImmutableClassifiedPayloadRecordCodec({
    encryptionProfile: selected.encryptionProfile,
    retainedEncryptionProfiles: selected.retainedEncryptionProfiles
  }).create({
    payloadRefId: parsePayloadRefId(payloadRefId),
    binding: {
      profiles: WORKSPACE_INVITATION_CLASSIFIED_PROFILES,
      scopeBinding: `workspace:${workspaceId}/reservation:${reservationId}`,
      contentType: WORKSPACE_INVITATION_RECIPIENT_CONTENT_TYPE
    },
    purpose: WORKSPACE_INVITATION_RECIPIENT_PURPOSE,
    bytes: recipientBytes,
    createdAt: parseInstant(new Date(now).toISOString())
  });
  recipientBytes.fill(0);
  const teamDigest = digest({
    schemaVersion: 1,
    roles: WORKSPACE_TEAM_ROLES.map((role) => ({ ...role, id: roleIds.get(role.key) })),
    members: [{
      membershipId,
      version: 1,
      status: 'active',
      userId,
      role: {
        assignmentId,
        assignmentVersion: 1,
        roleId: adminRoleId,
        roleKey: 'workspace_admin'
      },
      hasAdditionalAccess: false
    }, {
      membershipId: secondMembershipId,
      version: 1,
      status: 'active',
      userId: secondUserId,
      role: {
        assignmentId: secondAssignmentId,
        assignmentVersion: 1,
        roleId: viewerRoleId,
        roleKey: 'viewer'
      },
      hasAdditionalAccess: false
    }],
    invitations: [{
      reservationId,
      version: 1,
      lookupBinding,
      payloadRefId,
      roleId: viewerRoleId,
      roleKey: 'viewer'
    }]
  });
  const statements = [
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 Team workspace','active',?,?,1)`).bind(workspaceId, now, now),
    env.DB.prepare(`INSERT INTO users
      (id,status,display_name,primary_email_id,avatar_asset_id,created_at,updated_at,version)
      VALUES (?,'active','D1 Workspace Owner',?,NULL,?,?,1)`)
      .bind(userId, emailId, now, now),
    env.DB.prepare(`INSERT INTO user_emails
      (id,user_id,normalized_email,display_email,verified,source,is_primary,
       verified_at,revoked_at,created_at)
      VALUES (?,?,?, ?,1,'auth_provider',1,?,NULL,?)`)
      .bind(emailId, userId, email, email, now, now),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,?,NULL,?,?,1)`)
      .bind(membershipId, workspaceId, userId, userId, now, now, now),
    env.DB.prepare(`INSERT INTO users
      (id,status,display_name,primary_email_id,avatar_asset_id,created_at,updated_at,version)
      VALUES (?,'active','D1 Second Teammate',?,NULL,?,?,1)`)
      .bind(secondUserId, secondEmailId, now, now),
    env.DB.prepare(`INSERT INTO user_emails
      (id,user_id,normalized_email,display_email,verified,source,is_primary,
       verified_at,revoked_at,created_at)
      VALUES (?,?,?, ?,1,'auth_provider',1,?,NULL,?)`)
      .bind(secondEmailId, secondUserId, secondEmail, secondEmail, now, now),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,?,NULL,?,?,1)`)
      .bind(secondMembershipId, workspaceId, secondUserId, userId, now, now, now),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 Workspace Owner',?,1,NULL,?,?)`)
      .bind(authUserId, email, now, now),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,?,?, ?,NULL,NULL,?,?)`)
      .bind(sessionId, rawSessionToken, authUserId, now + 86_400_000, now, now),
    env.DB.prepare(`INSERT INTO auth_user_links
      (auth_user_id,user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
      VALUES (?,?,'ready',NULL,0,?,?)`).bind(authUserId, userId, now, now),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets
      (workspace_id,version,current_event_id) VALUES (?,1,NULL)`).bind(workspaceId),
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
    ) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      classifiedRecord.payloadRefId,
      classifiedRecord.encryptionProfile.key,
      classifiedRecord.encryptionProfile.version,
      classifiedRecord.descriptor.profiles.classification.key,
      classifiedRecord.descriptor.profiles.classification.version,
      classifiedRecord.descriptor.profiles.schema.key,
      classifiedRecord.descriptor.profiles.schema.version,
      classifiedRecord.descriptor.profiles.content.key,
      classifiedRecord.descriptor.profiles.content.version,
      classifiedRecord.descriptor.profiles.integrity.key,
      classifiedRecord.descriptor.profiles.integrity.version,
      classifiedRecord.descriptor.profiles.descriptorAuth.key,
      classifiedRecord.descriptor.profiles.descriptorAuth.version,
      classifiedRecord.descriptor.scopeBinding,
      classifiedRecord.purpose,
      classifiedRecord.descriptor.contentType,
      classifiedRecord.descriptor.byteSize,
      classifiedRecord.descriptor.integrityDigest,
      classifiedRecord.authenticatedDataDigest,
      classifiedRecord.nonce,
      classifiedRecord.ciphertext,
      classifiedRecord.authenticationTag,
      now
    ),
    ...WORKSPACE_TEAM_ROLES.map((role) => env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,?,?,?,1,NULL,?,?,1)`).bind(
        roleIds.get(role.key),
        workspaceId,
        role.name,
        `${role.name} fixture`,
        role.key,
        now,
        now
      )),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(adminRoleId, 'access.users.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(adminRoleId, 'event.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(adminRoleId, 'access.users.invite'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(adminRoleId, 'access.roles.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(adminRoleId, 'access.users.suspend'),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(assignmentId, userId, adminRoleId, workspaceId, userId, now),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(secondAssignmentId, secondUserId, viewerRoleId, workspaceId, userId, now),
    env.DB.prepare(`INSERT INTO access_reservations
      (id,workspace_id,normalized_email,status,expires_at,created_by_user_id,
       consumed_by_user_id,consumed_at,created_at,version)
      VALUES (?,?,?,'open',NULL,?,NULL,NULL,?,1)`)
      .bind(reservationId, workspaceId, lookupBinding, userId, now),
    env.DB.prepare(`INSERT INTO reservation_role_assignments
      (id,reservation_id,role_id,scope_kind,event_id)
      VALUES (?,?,?,'workspace',NULL)`)
      .bind(reservationAssignmentId, reservationId, viewerRoleId),
    env.DB.prepare(`INSERT INTO workspace_team_invitation_recipients
      (reservation_id,workspace_id,payload_ref_id,lookup_binding,recipient_hint,created_at_ms)
      VALUES (?,?,?,?,?,?)`)
      .bind(reservationId, workspaceId, payloadRefId, lookupBinding, recipientHint, now),
    env.DB.prepare(`INSERT INTO workspace_team_invitation_release_intents
      (id,reservation_id,workspace_id,status,created_at_ms,cancelled_at_ms)
      VALUES (?,?,?,'awaiting_activation',?,NULL)`)
      .bind(releaseIntentId, reservationId, workspaceId, now),
    env.DB.prepare(`INSERT INTO workspace_team_heads
      (workspace_id,team_version,team_digest_sha256) VALUES (?,1,?)`)
      .bind(workspaceId, teamDigest)
  ];
  await env.DB.batch(statements);
});

function environment(): CloudflareApplicationEnvironment {
  return {
    DB: env.DB,
    FILES: env.FILES,
    EMAIL: env.EMAIL,
    JOBS: env.JOBS,
    ASSETS: env.ASSETS,
    JOOEVENTS_DEPLOYMENT_ENVIRONMENT: env.JOOEVENTS_DEPLOYMENT_ENVIRONMENT,
    JOOEVENTS_D1_RELEASE_FLOOR: env.JOOEVENTS_D1_RELEASE_FLOOR,
    JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true',
    JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'true',
    JOOEVENTS_MAIL_FROM_ADDRESS: 'events@mail.jooevents.com',
    JOOEVENTS_MAIL_FROM_NAME: 'JooEvents',
    JOOEVENTS_BASE_URL: baseUrl,
    JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
    JOOEVENTS_REQUEST_HASH_KEYS: ring(0x41),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(0x42),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(0x43),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(0x44),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'workspace-team-google-client-id',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'workspace-team-google-client-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_WORKSPACE_ID: workspaceId
  };
}

async function cookie(): Promise<string> {
  const signature = await makeSignature(rawSessionToken, secret);
  return `__Secure-better-auth.session_token=${rawSessionToken}.${signature}`;
}

interface TeamBody {
  readonly kind: 'success';
  readonly data: {
    readonly schemaVersion: 1;
    readonly version: number;
    readonly digestSha256: string;
    readonly roles: readonly unknown[];
    readonly members: readonly {
      readonly id: string;
      readonly kind: 'member' | 'invitation';
      readonly userId?: string;
      readonly name: string;
      readonly email: string;
      readonly role: { readonly key: string };
      readonly status: string;
      readonly version: number;
      readonly hasAdditionalAccess: boolean;
      readonly delivery?: string;
    }[];
  };
}

describe('D1 workspace Team operations', () => {
  test('reads classified recipients and runs guarded mutations with deferred activators', async () => {
    const cookieHeader = await cookie();
    const headers = { cookie: cookieHeader };
    const readTeam = async (): Promise<TeamBody> => {
      const response = await handleRequest(
        new Request(`${baseUrl}/api/workspace/team`, { headers }),
        environment()
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json<TeamBody>();
    };
    const mutate = async (
      path: string,
      idempotencyKey: string,
      body: unknown
    ): Promise<Readonly<Record<string, unknown>>> => {
      const response = await handleRequest(new Request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          origin: baseUrl,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey
        },
        body: JSON.stringify(body)
      }), environment());
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json<Readonly<Record<string, unknown>>>();
    };

    let teamBody = await readTeam();
    expect(teamBody).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, version: 1, roles: WORKSPACE_TEAM_ROLES }
    });
    expect(teamBody.data.members).toEqual(expect.arrayContaining([expect.objectContaining({
      id: membershipId,
      kind: 'member',
      userId,
      name: 'D1 Workspace Owner',
      email,
      role: expect.objectContaining({ key: 'workspace_admin' }),
      status: 'active',
      version: 1,
      hasAdditionalAccess: false
    }), expect.objectContaining({
      id: secondMembershipId,
      kind: 'member',
      userId: secondUserId,
      role: expect.objectContaining({ key: 'viewer' })
    }), expect.objectContaining({
      id: reservationId,
      kind: 'invitation',
      email: invitationEmail,
      role: expect.objectContaining({ key: 'viewer' }),
      delivery: 'awaiting_activation',
      version: 1
    })]));

    const roleChangeInput = {
      subject: { kind: 'invitation', reservationId, version: 1 },
      roleKey: 'speaker_reviewer',
      expectedTeamVersion: teamBody.data.version,
      expectedTeamDigestSha256: teamBody.data.digestSha256
    };
    const roleChanged = await mutate(
      '/api/workspace/team/role-changes',
      'd1-team-role-change',
      roleChangeInput
    );
    expect(roleChanged).toMatchObject({
      kind: 'success',
      data: {
        action: 'change_role',
        teamVersion: 2,
        safeDiff: {
          action: 'change_role',
          before: { key: 'viewer' },
          after: { key: 'speaker_reviewer' }
        }
      }
    });
    expect(await mutate(
      '/api/workspace/team/role-changes',
      'd1-team-role-change',
      roleChangeInput
    )).toEqual(roleChanged);
    expect(await mutate(
      '/api/workspace/team/role-changes',
      'd1-team-role-change-stale',
      { ...roleChangeInput, roleKey: 'scheduler' }
    )).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'workspace_team.change_refused',
        detail: { code: 'stale_team', action: 'change_role' }
      }
    });

    teamBody = await readTeam();
    const changedInvitation = teamBody.data.members.find((member) => member.id === reservationId);
    expect(changedInvitation).toMatchObject({
      kind: 'invitation', version: 2, role: { key: 'speaker_reviewer' }
    });
    const invited = await mutate(
      '/api/workspace/team/invitations',
      'd1-team-invite',
      {
        email: newInvitationEmail,
        roleKey: 'viewer',
        expectedTeamVersion: teamBody.data.version,
        expectedTeamDigestSha256: teamBody.data.digestSha256
      }
    );
    expect(invited).toMatchObject({
      kind: 'success',
      data: {
        action: 'invite',
        teamVersion: 3,
        safeDiff: {
          action: 'invite',
          invitationStatus: 'recorded',
          delivery: 'awaiting_activation'
        }
      }
    });
    expect(JSON.stringify(invited)).not.toContain(newInvitationEmail);

    teamBody = await readTeam();
    const newInvitation = teamBody.data.members.find(
      (member) => member.kind === 'invitation' && member.email === newInvitationEmail
    );
    if (!newInvitation) throw new TypeError('new D1 invitation missing');
    const removedInvitation = await mutate(
      '/api/workspace/team/removals',
      'd1-team-remove-invitation',
      {
        subject: { kind: 'invitation', reservationId, version: 2 },
        expectedTeamVersion: teamBody.data.version,
        expectedTeamDigestSha256: teamBody.data.digestSha256
      }
    );
    expect(removedInvitation).toMatchObject({
      kind: 'success',
      data: {
        action: 'remove',
        teamVersion: 4,
        safeDiff: { action: 'remove', sessionRevocation: 'not_applicable' }
      }
    });

    teamBody = await readTeam();
    const removedMember = await mutate(
      '/api/workspace/team/removals',
      'd1-team-remove-member',
      {
        subject: { kind: 'member', membershipId: secondMembershipId, version: 1 },
        expectedTeamVersion: teamBody.data.version,
        expectedTeamDigestSha256: teamBody.data.digestSha256
      }
    );
    expect(removedMember).toMatchObject({
      kind: 'success',
      data: {
        action: 'remove',
        teamVersion: 5,
        safeDiff: { action: 'remove', sessionRevocation: 'awaiting_activation' }
      }
    });

    teamBody = await readTeam();
    expect(teamBody.data.version).toBe(5);
    expect(teamBody.data.members.some((member) => member.id === reservationId)).toBe(false);
    expect(teamBody.data.members.some((member) => member.id === secondMembershipId)).toBe(false);
    expect(teamBody.data.members).toEqual(expect.arrayContaining([expect.objectContaining({
      id: newInvitation.id,
      kind: 'invitation',
      email: newInvitationEmail,
      delivery: 'awaiting_activation'
    })]));

    const [oldRelease, newRelease, revocation, logs, history] = await env.DB.batch([
      env.DB.prepare(`SELECT status FROM workspace_team_invitation_release_intents
        WHERE reservation_id = ?`).bind(reservationId),
      env.DB.prepare(`SELECT status FROM workspace_team_invitation_release_intents
        WHERE reservation_id = ?`).bind(newInvitation.id),
      env.DB.prepare(`SELECT status FROM workspace_team_session_revocation_intents
        WHERE membership_id = ?`).bind(secondMembershipId),
      env.DB.prepare(`SELECT count(*) AS count FROM operation_log
        WHERE workspace_id = ? AND operation_name LIKE 'workspace_team.%'`).bind(workspaceId),
      env.DB.prepare(`SELECT count(*) AS count FROM workspace_team_history
        WHERE workspace_id = ?`).bind(workspaceId)
    ]);
    expect((oldRelease as D1Result<{ status: string }>).results[0]?.status).toBe('cancelled');
    expect((newRelease as D1Result<{ status: string }>).results[0]?.status)
      .toBe('awaiting_activation');
    expect((revocation as D1Result<{ status: string }>).results[0]?.status)
      .toBe('awaiting_activation');
    expect((logs as D1Result<{ count: number }>).results[0]?.count).toBe(4);
    expect((history as D1Result<{ count: number }>).results[0]?.count).toBe(4);

    const manifest = await handleRequest(
      new Request(`${baseUrl}/api/operations/manifest`, { headers }),
      environment()
    );
    const names = (await manifest.json<{
      readonly operations: readonly { readonly name: string }[];
    }>()).operations.map((operation) => operation.name);
    expect(names).toEqual(expect.arrayContaining([
      'workspace_team.members.read',
      'workspace_team.invite',
      'workspace_team.role_change',
      'workspace_team.remove'
    ]));

    const overview = await handleRequest(
      new Request(`${baseUrl}/api/workspace/overview`, { headers }),
      environment()
    );
    const body = await overview.json<{
      readonly data: {
        readonly areas: readonly {
          readonly area: string;
          readonly availableCapabilities?: readonly string[];
          readonly unavailableCapabilities?: readonly string[];
        }[];
      };
    }>();
    const settings = body.data.areas.find((area) => area.area === 'settings');
    expect(settings?.availableCapabilities).toEqual(expect.arrayContaining([
      'workspace_team.members.read',
      'workspace_team.invite',
      'workspace_team.role_change',
      'workspace_team.remove'
    ]));
    expect(settings?.unavailableCapabilities).toEqual(expect.arrayContaining([
      'workspace_team.delivery.activate',
      'workspace_team.session_revocation.activate'
    ]));
  });
});
