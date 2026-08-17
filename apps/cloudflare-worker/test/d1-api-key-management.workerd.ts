import { env } from 'cloudflare:workers';
import { makeSignature } from 'better-auth/crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import { handleRequest, type CloudflareApplicationEnvironment } from '../src/index';

const uuid = (suffix: number): string =>
  `019c2f31-2250-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = uuid(901);
const ownerUserId = uuid(902);
const ownerEmailId = uuid(903);
const ownerMembershipId = uuid(904);
const ownerRoleId = uuid(905);
const ownerAssignmentId = uuid(906);
const ownerAuthUserId = uuid(907);
const ownerSessionId = uuid(908);
const secondUserId = uuid(909);
const secondEmailId = uuid(910);
const secondMembershipId = uuid(911);
const secondRoleId = uuid(912);
const secondAssignmentId = uuid(913);
const secondAuthUserId = uuid(914);
const secondSessionId = uuid(915);
const ownerKeyId = uuid(916);
const secondKeyId = uuid(917);
const ownerEventReadDenyId = uuid(918);
const ownerEmail = 'api-owner@example.invalid';
const secondEmail = 'api-collaborator@example.invalid';
const ownerSessionToken = 'd1-api-key-owner-session-token';
const secondSessionToken = 'd1-api-key-second-session-token';
const secret = 'd1-api-key-auth-secret-at-least-thirty-two-characters';
const baseUrl = 'https://api-key-management.jooevents.invalid';
const ring = (byte: number): string =>
  `1:${Buffer.alloc(32, byte).toString('base64url')}`;

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 API key workspace','active',?,?,1)`).bind(workspaceId, now, now),
    env.DB.prepare(`INSERT INTO users
      (id,status,display_name,primary_email_id,avatar_asset_id,created_at,updated_at,version)
      VALUES (?,'active','D1 API Owner',?,NULL,?,?,1)`)
      .bind(ownerUserId, ownerEmailId, now, now),
    env.DB.prepare(`INSERT INTO user_emails
      (id,user_id,normalized_email,display_email,verified,source,is_primary,
       verified_at,revoked_at,created_at)
      VALUES (?,?,?,?,1,'auth_provider',1,?,NULL,?)`)
      .bind(ownerEmailId, ownerUserId, ownerEmail, ownerEmail, now, now),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,?,NULL,?,?,1)`)
      .bind(ownerMembershipId, workspaceId, ownerUserId, ownerUserId, now, now, now),
    env.DB.prepare(`INSERT INTO users
      (id,status,display_name,primary_email_id,avatar_asset_id,created_at,updated_at,version)
      VALUES (?,'active','D1 API Collaborator',?,NULL,?,?,1)`)
      .bind(secondUserId, secondEmailId, now, now),
    env.DB.prepare(`INSERT INTO user_emails
      (id,user_id,normalized_email,display_email,verified,source,is_primary,
       verified_at,revoked_at,created_at)
      VALUES (?,?,?,?,1,'auth_provider',1,?,NULL,?)`)
      .bind(secondEmailId, secondUserId, secondEmail, secondEmail, now, now),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,?,NULL,?,?,1)`)
      .bind(secondMembershipId, workspaceId, secondUserId, ownerUserId, now, now, now),
    env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,'API owner','Fixture role',NULL,NULL,NULL,?,?,1)`)
      .bind(ownerRoleId, workspaceId, now, now),
    env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,'API collaborator','Fixture role',NULL,NULL,NULL,?,?,1)`)
      .bind(secondRoleId, workspaceId, now, now),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(ownerRoleId, 'integration.api.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(ownerRoleId, 'access.roles.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(ownerRoleId, 'event.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(secondRoleId, 'integration.api.manage'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(secondRoleId, 'event.read'),
    env.DB.prepare(`INSERT INTO permission_overrides
      (id,user_id,permission_id,effect,workspace_id,scope_kind,event_id,reason,
       decided_by_user_id,decided_at,expires_at,version)
      VALUES (?,?,'event.read','deny',?,'workspace',NULL,'Fixture direct deny',?,?,NULL,1)`)
      .bind(ownerEventReadDenyId, ownerUserId, workspaceId, ownerUserId, now),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(ownerAssignmentId, ownerUserId, ownerRoleId, workspaceId, ownerUserId, now),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(secondAssignmentId, secondUserId, secondRoleId, workspaceId, ownerUserId, now),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 API Owner',?,1,NULL,?,?)`)
      .bind(ownerAuthUserId, ownerEmail, now, now),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 API Collaborator',?,1,NULL,?,?)`)
      .bind(secondAuthUserId, secondEmail, now, now),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,?,?, ?,NULL,NULL,?,?)`)
      .bind(ownerSessionId, ownerSessionToken, ownerAuthUserId, now + 86_400_000, now, now),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,?,?, ?,NULL,NULL,?,?)`)
      .bind(secondSessionId, secondSessionToken, secondAuthUserId, now + 86_400_000, now, now),
    env.DB.prepare(`INSERT INTO auth_user_links
      (auth_user_id,user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
      VALUES (?,?,'ready',NULL,0,?,?)`).bind(ownerAuthUserId, ownerUserId, now, now),
    env.DB.prepare(`INSERT INTO auth_user_links
      (auth_user_id,user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
      VALUES (?,?,'ready',NULL,0,?,?)`).bind(secondAuthUserId, secondUserId, now, now),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets
      (workspace_id,version,current_event_id) VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO api_keys (
      api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
      may_read,may_submit_plans,created_at_ms,expires_at_ms,last_used_at_ms,standing,
      revoked_at_ms,revoked_by_user_id,revoke_reason,rotation_successor_id,version
    ) VALUES (?,?,?,'Owner assistant',?,'jooak1_abcd',1,1,?,NULL,?,'active',NULL,NULL,NULL,NULL,1)`)
      .bind(ownerKeyId, workspaceId, ownerUserId, 'a'.repeat(64), now - 20_000, now - 1_000),
    env.DB.prepare(`INSERT INTO api_keys (
      api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
      may_read,may_submit_plans,created_at_ms,expires_at_ms,last_used_at_ms,standing,
      revoked_at_ms,revoked_by_user_id,revoke_reason,rotation_successor_id,version
    ) VALUES (?,?,?,'Retired dashboard',?,'jooak1_efgh',1,0,?,?,NULL,'revoked',?,?,'owner_request',NULL,2)`)
      .bind(
        secondKeyId, workspaceId, secondUserId, 'b'.repeat(64),
        now - 30_000, now + 86_400_000, now - 2_000, secondUserId
      ),
    env.DB.prepare('INSERT INTO api_key_permission_scopes(api_key_id,permission_id) VALUES (?,?)')
      .bind(ownerKeyId, 'event.read'),
    env.DB.prepare('INSERT INTO api_key_permission_scopes(api_key_id,permission_id) VALUES (?,?)')
      .bind(ownerKeyId, 'schedule.read'),
    env.DB.prepare('INSERT INTO api_key_permission_scopes(api_key_id,permission_id) VALUES (?,?)')
      .bind(secondKeyId, 'event.read')
  ]);
});

function environment(): CloudflareApplicationEnvironment {
  return {
    DB: env.DB,
    FILES: env.FILES,
    JOBS: env.JOBS,
    ASSETS: env.ASSETS,
    JOOEVENTS_DEPLOYMENT_ENVIRONMENT: env.JOOEVENTS_DEPLOYMENT_ENVIRONMENT,
    JOOEVENTS_D1_RELEASE_FLOOR: env.JOOEVENTS_D1_RELEASE_FLOOR,
    JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true',
    JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'true',
    JOOEVENTS_BASE_URL: baseUrl,
    JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
    JOOEVENTS_REQUEST_HASH_KEYS: ring(0x61),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(0x62),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(0x63),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(0x64),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'api-key-google-client-id',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'api-key-google-client-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_WORKSPACE_ID: workspaceId
  };
}

async function cookie(token: string): Promise<string> {
  return `__Secure-better-auth.session_token=${token}.${await makeSignature(token, secret)}`;
}

describe('D1 API key management read', () => {
  test('keeps the D1 hint constraint equivalent without the unsupported complex GLOB', async () => {
    const invalidId = uuid(919);
    await expect(env.DB.prepare(`INSERT INTO api_keys (
      api_key_id,workspace_id,owner_user_id,display_name,token_hash_sha256,token_hint,
      may_read,may_submit_plans,created_at_ms,expires_at_ms,last_used_at_ms,standing,
      revoked_at_ms,revoked_by_user_id,revoke_reason,rotation_successor_id,version
    ) VALUES (?,?,?,'Invalid hint fixture',?,'jooak1_ab$d',1,0,?,NULL,NULL,
      'active',NULL,NULL,NULL,NULL,1)`)
      .bind(invalidId, workspaceId, ownerUserId, 'c'.repeat(64), Date.now()).run())
      .rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS count FROM api_keys WHERE api_key_id = ?')
      .bind(invalidId).first<{ readonly count: number }>())?.count).toBe(0);
  });

  test('projects all metadata for an administrator and only owned keys otherwise', async () => {
    const ownerResponse = await handleRequest(
      new Request(`${baseUrl}/api/workspace/api-keys`, {
        headers: { cookie: await cookie(ownerSessionToken) }
      }),
      environment()
    );
    expect(ownerResponse.status, await ownerResponse.clone().text()).toBe(200);
    const ownerBody = await ownerResponse.json<{
      readonly kind: 'success';
      readonly data: {
        readonly timezone: string;
        readonly keys: readonly {
          readonly id: string;
          readonly ownerUserId: string;
          readonly expiresAt: string | null;
          readonly standing: string;
          readonly permissionIds: readonly string[];
        }[];
        readonly permissions: readonly { readonly id: string; readonly held: boolean }[];
        readonly profiles: readonly unknown[];
        readonly expiry: { readonly defaultDays: number; readonly maxDays: number };
      };
    }>();
    expect(ownerBody.kind).toBe('success');
    expect(ownerBody.data).toMatchObject({
      timezone: 'UTC',
      profiles: expect.arrayContaining([expect.objectContaining({ key: 'assistant' })]),
      expiry: { defaultDays: 90, maxDays: 365 }
    });
    expect(ownerBody.data.keys).toEqual([
      expect.objectContaining({
        id: ownerKeyId,
        ownerUserId,
        expiresAt: null,
        standing: 'active',
        permissionIds: ['event.read', 'schedule.read']
      }),
      expect.objectContaining({
        id: secondKeyId,
        ownerUserId: secondUserId,
        standing: 'revoked',
        permissionIds: ['event.read']
      })
    ]);
    expect(ownerBody.data.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'access.roles.manage', held: true }),
      expect.objectContaining({ id: 'event.read', held: false }),
      expect.objectContaining({ id: 'schedule.read', held: false })
    ]));

    const secondResponse = await handleRequest(
      new Request(`${baseUrl}/api/workspace/api-keys`, {
        headers: { cookie: await cookie(secondSessionToken) }
      }),
      environment()
    );
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
    const secondBody = await secondResponse.json<typeof ownerBody>();
    expect(secondBody.data.keys.map((key) => key.id)).toEqual([secondKeyId]);
    expect(secondBody.data.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'access.roles.manage', held: false })
    ]));

    const manifest = await handleRequest(
      new Request(`${baseUrl}/api/operations/manifest`, {
        headers: { cookie: await cookie(ownerSessionToken) }
      }),
      environment()
    );
    const operationNames = (await manifest.json<{
      readonly operations: readonly { readonly name: string }[];
    }>()).operations.map((operation) => operation.name);
    expect(operationNames).toContain('workspace.api_key.list');
    expect(operationNames).not.toContain('workspace.api_key.create');
    expect(operationNames).not.toContain('workspace.api_key.rotate');
    expect(operationNames).not.toContain('workspace.api_key.revoke');

    const overview = await handleRequest(
      new Request(`${baseUrl}/api/workspace/overview`, {
        headers: { cookie: await cookie(secondSessionToken) }
      }),
      environment()
    );
    const overviewBody = await overview.json<{
      readonly data: {
        readonly areas: readonly {
          readonly area: string;
          readonly availableCapabilities?: readonly string[];
          readonly unavailableCapabilities?: readonly string[];
        }[];
      };
    }>();
    const settings = overviewBody.data.areas.find((area) => area.area === 'settings');
    expect(settings?.availableCapabilities).toContain('workspace.api_key.list');
    expect(settings?.unavailableCapabilities).toEqual(expect.arrayContaining([
      'workspace.api_key.create',
      'workspace.api_key.rotate',
      'workspace.api_key.revoke'
    ]));
  });
});
