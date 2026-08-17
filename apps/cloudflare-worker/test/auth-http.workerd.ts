import { env } from 'cloudflare:workers';
import { createProvisioningService } from '@jooevents/application';
import { makeSignature } from 'better-auth/crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import { createCloudflareAuthHttpApp } from '../src/auth-http';
import { createD1Auth } from '../src/d1-auth';
import { createD1AuthPrincipalReader } from '../src/d1-principal-reader';
import { createD1ProvisioningStore } from '../src/d1-provisioning-store';
import { handleRequest, type CloudflareApplicationEnvironment } from '../src/index';

const uuid = (suffix: number): string =>
  `019c1df8-c9e8-7abc-8def-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = uuid(601);
const authUserId = uuid(602);
const rawSessionToken = 'd1-http-session-token';
const secret = 'd1-http-auth-secret-value-at-least-thirty-two-characters';
const baseUrl = 'https://auth-http.jooevents.invalid';
const configuration = {
  baseUrl,
  trustedOrigins: [] as string[],
  authSecrets: [{ version: 1, value: secret }],
  googleClientId: 'http-google-client-id',
  googleClientSecret: 'http-google-client-secret',
  admissionMode: 'pending' as const
};

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces (id,name,state,created_at,updated_at,version)
      VALUES (?,'Worker HTTP workspace','active',?,?,1)`).bind(workspaceId, now, now),
    env.DB.prepare(`INSERT INTO auth_users
      (id,name,email,email_verified,image,created_at,updated_at)
      VALUES (?,'HTTP Person','http-person@example.invalid',1,NULL,?,?)`)
      .bind(authUserId, now, now),
    env.DB.prepare(`INSERT INTO auth_accounts
      (id,account_id,provider_id,user_id,created_at,updated_at)
      VALUES (?,'google-http-person','google',?,?,?)`)
      .bind(uuid(603), authUserId, now, now),
    env.DB.prepare(`INSERT INTO auth_sessions
      (id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
      VALUES (?,?,?, ?,NULL,NULL,?,?)`)
      .bind(uuid(604), rawSessionToken, authUserId, now + 86_400_000, now, now)
  ]);
});

function application() {
  const auth = createD1Auth(env.DB, configuration);
  return createCloudflareAuthHttpApp({
    auth,
    workspaceId,
    baseUrl,
    accessContext: createProvisioningService({
      principals: createD1AuthPrincipalReader(env.DB),
      store: createD1ProvisioningStore(env.DB),
      admission: { mode: 'pending' }
    })
  });
}

describe('Worker auth/access HTTP boundary', () => {
  test('serves closed anonymous context with no-store and deny-framing headers', async () => {
    const response = await application().request(`${baseUrl}/api/me/access-context`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'anonymous' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
  });

  test('normalizes return paths and starts Better Auth without exposing provider mechanics', async () => {
    const response = await application().request(`${baseUrl}/api/entry/google/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ provider: 'google', returnTo: 'https://attacker.invalid/' })
    });
    const payload = await response.json<{ readonly url: string }>();
    const authorization = new URL(payload.url);
    const state = authorization.searchParams.get('state');
    expect(response.status).toBe(200);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(state).toBeTruthy();
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    const verification = await env.DB.prepare(`SELECT value FROM auth_verifications
      WHERE identifier = ?`).bind(state).first<{ readonly value: string }>();
    expect(verification).toBeTruthy();
    expect(verification?.value).not.toContain('attacker.invalid');
  });

  test('reconciles a valid Better Auth session to pending access and signs it out', async () => {
    const signature = await makeSignature(rawSessionToken, secret);
    const cookie = `__Secure-better-auth.session_token=${rawSessionToken}.${signature}`;
    const app = application();
    const access = await app.request(`${baseUrl}/api/me/access-context`, {
      headers: { cookie, 'x-correlation-id': uuid(605) }
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      state: 'pending_review',
      user: { displayName: 'HTTP Person', primaryEmail: 'http-person@example.invalid' },
      workspace: { id: workspaceId, name: 'Worker HTTP workspace' }
    });
    expect(access.headers.get('x-correlation-id')).toBe(uuid(605));

    const signOut = await app.request(`${baseUrl}/api/entry/sign-out`, {
      method: 'POST',
      headers: { cookie, origin: baseUrl }
    });
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ signedOut: true });
    expect(signOut.headers.getSetCookie().some((value) =>
      value.startsWith('__Secure-better-auth.session_token=;')
    )).toBe(true);

    const after = await app.request(`${baseUrl}/api/me/access-context`, {
      headers: { cookie }
    });
    expect(await after.json()).toEqual({ state: 'anonymous' });
  });

  test('returns a disclosure-safe JSON 404 for unknown auth namespace routes', async () => {
    const response = await application().request(`${baseUrl}/api/entry/unknown`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      code: 'route_not_found',
      retryable: false
    });
  });

  test('activates the default Worker auth route only behind complete validated bindings', async () => {
    const environment: CloudflareApplicationEnvironment = {
      DB: env.DB,
      FILES: env.FILES,
      EMAIL: env.EMAIL,
      JOBS: env.JOBS,
      ASSETS: env.ASSETS,
      JOOEVENTS_DEPLOYMENT_ENVIRONMENT: env.JOOEVENTS_DEPLOYMENT_ENVIRONMENT,
      JOOEVENTS_D1_RELEASE_FLOOR: env.JOOEVENTS_D1_RELEASE_FLOOR,
      JOOEVENTS_AUTH_RUNTIME_ENABLED: 'true',
      JOOEVENTS_BASE_URL: baseUrl,
      JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
      JOOEVENTS_PERSISTENT_HMAC_KEYS: `1:${Buffer.alloc(32, 7).toString('base64url')}`,
      JOOEVENTS_GOOGLE_CLIENT_ID: 'http-google-client-id',
      JOOEVENTS_GOOGLE_CLIENT_SECRET: 'http-google-client-secret',
      JOOEVENTS_ADMISSION_MODE: 'pending',
      JOOEVENTS_WORKSPACE_ID: workspaceId
    };
    const response = await handleRequest(
      new Request(`${baseUrl}/api/me/access-context`),
      environment
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'anonymous' });

    const invalid = await handleRequest(
      new Request(`${baseUrl}/api/me/access-context`),
      { ...environment, JOOEVENTS_AUTH_SECRETS: 'too-short' }
    );
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({
      code: 'cloudflare_auth_configuration_invalid'
    });
  });
});
