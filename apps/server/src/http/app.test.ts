import { afterEach, describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWorkPort,
  type OperationRegistrySource
} from '@jooevents/application';
import { correlationIdSchema, safeOperationManifestSchema } from '@jooevents/contracts';
import { parseInstant, parseInvocationId } from '@jooevents/kernel';
import { openSQLite } from '@jooevents/persistence';
import { createAuth } from '../auth/better-auth';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import { loadConfig } from '../config';
import { createHttpApp } from './app';

const databases: ReturnType<typeof openSQLite>[] = [];
const config = loadConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_REQUEST_HASH_KEYS: `1:${Buffer.alloc(32, 1).toString('base64url')}`,
  JOOEVENTS_IDEMPOTENCY_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
  JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `1:${Buffer.alloc(32, 3).toString('base64url')}`,
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/jooevents-server-test'
});

afterEach(() => {
  while (databases.length) databases.pop()?.sqlite.close();
});

describe('HTTP/auth composition', () => {
  test('mounts an injected operator registry manifest under one UUID correlation boundary', async () => {
    const opened = openSQLite(':memory:');
    databases.push(opened);
    const auth = createAuth(config, opened.db);
    const emptySource: OperationRegistrySource = {
      autonomyPolicies: [], schemas: [], contextBuilders: [], readCapabilities: [],
      handlers: [], projections: [], operations: []
    };
    const unopened: EffectUnitOfWorkPort = {
      findTerminalReceipt() { throw new Error('unexpected receipt lookup'); },
      recordShortOperationAudit() { throw new Error('unexpected audit append'); },
      runInUnitOfWork() { throw new Error('unexpected transaction'); }
    };
    const operations = await createApplicationOperationRuntime({
      source: emptySource,
      read: {
        operationalTrace: { emit() {} }, immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-12T00:00:00.000Z') },
        newInvocationId: () => parseInvocationId('018f0f47-7a86-7d36-8a25-9f86589c7001')
      },
      unitOfWork: unopened
    });
    const app = createHttpApp({
      auth,
      baseUrl: config.baseUrl,
      workspaceId: 'workspace_summit',
      accessContext: { ensureAuthPrincipalProvisioned: async () => { throw new Error('must not provision manifest requests'); } },
      operatorOperations: {
        operations,
        evidence: { verify: () => ({ kind: 'rejected', reason: 'unauthenticated' }) }
      }
    });

    const response = await app.request('/api/operations/manifest', {
      headers: { 'x-correlation-id': 'formerly-accepted-but-not-a-uuid' }
    });
    expect(response.status).toBe(200);
    expect(correlationIdSchema.safeParse(response.headers.get('x-correlation-id')).success).toBe(true);
    expect(safeOperationManifestSchema.parse(await response.json())).toEqual(operations.registry.safeManifest);
  });

  test('returns the closed anonymous context and a correlation ID without a session', async () => {
    const opened = openSQLite(':memory:');
    databases.push(opened);
    const auth = createAuth(config, opened.db);
    const app = createHttpApp({
      auth,
      baseUrl: config.baseUrl,
      workspaceId: 'workspace_summit',
      accessContext: { ensureAuthPrincipalProvisioned: async () => { throw new Error('must not provision anonymous requests'); } }
    });
    const response = await app.request('/api/me/access-context');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'anonymous' });
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  test('starts Google authorization with the canonical Better Auth callback', async () => {
    const opened = openSQLite(':memory:');
    databases.push(opened);
    const auth = createAuth(config, opened.db);
    const app = createHttpApp({
      auth,
      baseUrl: config.baseUrl,
      workspaceId: 'workspace_summit',
      accessContext: { ensureAuthPrincipalProvisioned: async () => { throw new Error('must not provision before callback'); } }
    });
    const response = await app.request('/api/entry/google/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.baseUrl },
      body: JSON.stringify({ provider: 'google', returnTo: '/app' })
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { url: string };
    const authorization = new URL(payload.url);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost:5176/api/auth/callback/google');
    expect(authorization.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'openid', 'profile']);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
  });

  test('maps only Better Auth verified Google account records to domain claims', async () => {
    const opened = openSQLite(':memory:');
    databases.push(opened);
    const timestamp = Date.parse('2026-08-09T08:00:00.000Z');
    opened.sqlite.query(`insert into auth_users (id, name, email, email_verified, image, created_at, updated_at) values (?, ?, ?, 1, ?, ?, ?)`)
      .run('auth_ada', 'Ada Lovelace', 'ada@example.com', 'https://lh3.googleusercontent.com/a/ada', timestamp, timestamp);
    opened.sqlite.query(`insert into auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values (?, ?, 'google', ?, ?, ?)`)
      .run('account_ada', 'google-subject-ada', 'auth_ada', timestamp, timestamp);
    const result = await createSQLiteAuthPrincipalReader(opened.sqlite).getVerifiedClaims('auth_ada');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.data).toMatchObject({ provider: 'google', issuer: 'https://accounts.google.com', subject: 'google-subject-ada', emailVerified: true });
    }
  });

  test('returns a disclosure-safe structured 404 instead of HTML for unknown backend paths', async () => {
    const opened = openSQLite(':memory:');
    databases.push(opened);
    const auth = createAuth(config, opened.db);
    const app = createHttpApp({
      auth,
      baseUrl: config.baseUrl,
      workspaceId: 'workspace_summit',
      accessContext: { ensureAuthPrincipalProvisioned: async () => { throw new Error('must not provision unknown routes'); } }
    });

    for (const path of ['/api/unknown', '/api/auth/unknown', '/mcp/unknown', '/.well-known/unknown', '/webhooks/unknown', '/health/unknown']) {
      const response = await app.request(path, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('x-correlation-id')).toBeTruthy();
      expect(await response.json()).toMatchObject({ code: 'route_not_found', retryable: false });
    }
  });
});
