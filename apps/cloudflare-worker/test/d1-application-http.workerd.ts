import { env } from 'cloudflare:workers';
import { makeSignature } from 'better-auth/crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import { handleRequest, type CloudflareApplicationEnvironment } from '../src/index';

const uuid = (suffix: number): string =>
  `019c1df8-d4f0-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = uuid(701);
const userId = uuid(702);
const membershipId = uuid(703);
const authUserId = uuid(704);
const sessionId = uuid(705);
const rawSessionToken = 'd1-application-http-session-token';
const roleId = uuid(706);
const secret = 'd1-application-http-auth-secret-at-least-thirty-two-characters';
const baseUrl = 'https://application-http.jooevents.invalid';

const ring = (byte: number): string =>
  `1:${Buffer.alloc(32, byte).toString('base64url')}`;

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'D1 application workspace','active',?,?,1)`).bind(workspaceId, now, now),
    env.DB.prepare(`INSERT INTO users (id,status,display_name,created_at,updated_at,version)
      VALUES (?,'active','D1 application owner',?,?,1)`).bind(userId, now, now),
    env.DB.prepare(`INSERT INTO event_spine_workspace_sets (workspace_id,version,current_event_id)
      VALUES (?,1,NULL)`).bind(workspaceId),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'D1 application owner','application-owner@example.invalid',1,NULL,?,?)`)
      .bind(authUserId, now, now),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,?,?, ?,NULL,NULL,?,?)`)
      .bind(sessionId, rawSessionToken, authUserId, now + 86_400_000, now, now),
    env.DB.prepare(`INSERT INTO auth_user_links
      (auth_user_id,user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
      VALUES (?,?,'ready',NULL,0,?,?)`).bind(authUserId, userId, now, now),
    env.DB.prepare(`INSERT INTO workspace_memberships
      (id,workspace_id,user_id,status,approved_by_user_id,approved_at,decision_reason,
       created_at,updated_at,version)
      VALUES (?,?,?,'active',?,?,NULL,?,?,1)`)
      .bind(membershipId, workspaceId, userId, userId, now, now, now),
    env.DB.prepare(`INSERT INTO roles
      (id,workspace_id,name,description,source_preset_key,source_preset_version,
       archived_at,created_at,updated_at,version)
      VALUES (?,?,'D1 Event manager','D1 Event HTTP role',NULL,NULL,NULL,?,?,1)`)
      .bind(roleId, workspaceId, now, now),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'event.read'),
    env.DB.prepare('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)')
      .bind(roleId, 'event.manage'),
    env.DB.prepare(`INSERT INTO role_assignments
      (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_by_user_id,
       assigned_at,expires_at,version)
      VALUES (?,?,?,?,'workspace',NULL,?,?,NULL,1)`)
      .bind(uuid(707), userId, roleId, workspaceId, userId, now)
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
    JOOEVENTS_REQUEST_HASH_KEYS: ring(0x31),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(0x32),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(0x33),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(0x34),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'application-http-google-client-id',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'application-http-google-client-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_WORKSPACE_ID: workspaceId
  };
}

async function cookie(): Promise<string> {
  const signature = await makeSignature(rawSessionToken, secret);
  return `__Secure-better-auth.session_token=${rawSessionToken}.${signature}`;
}

describe('configured D1 application HTTP slice', () => {
  test('serves the exact partial manifest and runs Event create/read/replay over authenticated HTTP', async () => {
    const headers = { cookie: await cookie() };
    const manifest = await handleRequest(
      new Request(`${baseUrl}/api/operations/manifest`, { headers }),
      environment()
    );
    expect(manifest.status).toBe(200);
    const manifestBody = await manifest.json<{
      readonly operations: readonly { readonly name: string }[];
    }>();
    expect(manifestBody.operations.map((operation) => operation.name).sort()).toEqual([
      'event.create', 'event.current.read', 'event.list.read', 'event.select'
    ]);

    const initial = await handleRequest(
      new Request(`${baseUrl}/api/events/current`, { headers }),
      environment()
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      kind: 'success', data: { kind: 'no_event', eventSetVersion: 1 }
    });

    const request = () => new Request(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        cookie: headers.cookie,
        origin: baseUrl,
        'content-type': 'application/json',
        'idempotency-key': 'd1-application-create-event'
      },
      body: JSON.stringify({
        expectedEventSetVersion: 1,
        name: 'D1 Application Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-03-10',
        endDate: '2027-03-12'
      })
    });
    const first = await handleRequest(request(), environment());
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json<{
      readonly kind: string;
      readonly data: { readonly event: { readonly id: string } };
      readonly receipt: { readonly id: string };
    }>();
    expect(firstBody).toMatchObject({
      kind: 'success', data: { event: { name: 'D1 Application Summit' } }
    });
    const replay = await handleRequest(request(), environment());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const list = await handleRequest(
      new Request(`${baseUrl}/api/events`, { headers }),
      environment()
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      kind: 'success',
      data: {
        eventSetVersion: 2,
        currentEventId: firstBody.data.event.id,
        events: [{ id: firstBody.data.event.id, name: 'D1 Application Summit' }]
      }
    });
    const logs = await env.DB.prepare('SELECT count(*) AS count FROM operation_log WHERE id = ?')
      .bind(firstBody.receipt.id).first<{ readonly count: number }>();
    expect(logs?.count).toBe(1);
  });

  test('keeps the application slice closed when activation or a durable key duty is incomplete', async () => {
    const headers = { cookie: await cookie() };
    const disabled = await handleRequest(
      new Request(`${baseUrl}/api/events/current`, { headers }),
      { ...environment(), JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'false' }
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ code: 'cloudflare_application_runtime_not_ready' });

    const invalid = await handleRequest(
      new Request(`${baseUrl}/api/events/current`, { headers }),
      { ...environment(), JOOEVENTS_REQUEST_HASH_KEYS: 'invalid' }
    );
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({
      code: 'cloudflare_application_configuration_invalid'
    });
  });
});
