import { chmodSync, cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import { openSQLite } from '@jooevents/persistence';
import { loadConfig } from '../config';
import { createConfiguredSQLiteLiveRuntimeForTesting } from '../runtime/configured-sqlite-live-runtime';
import { validateLiveBuildIdentity } from '../runtime/live-build-identity';
import { createProductionRequestHandler } from '../runtime/request-handler';

const hostname = '127.0.0.1';
const rawPort = Bun.env.JOOEVENTS_BROWSER_TEST_PORT ?? '4184';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new TypeError('JOOEVENTS_BROWSER_TEST_PORT must be an unprivileged TCP port.');
}

const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-retained-browser-')));
chmodSync(dataDirectory, 0o700);
const databasePath = join(dataDirectory, 'jooevents.sqlite');
const initialized = openSQLite(databasePath, {
  migrationPolicy: 'apply',
  databaseClass: 'frozen_release'
});
initialized.sqlite.close();

const baseUrl = `http://${hostname}:${port}`;
const secret = 'browser-test-secret-that-is-at-least-thirty-two-bytes';
const ownerEmail = 'owner@example.test';
const rawToken = 'browser-test-owner-session-token';
const durableKey = (seed: number) => Buffer.alloc(32, seed).toString('base64url');
const config = loadConfig({
  JOOEVENTS_BASE_URL: baseUrl,
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
  JOOEVENTS_REQUEST_HASH_KEYS: `1:${durableKey(11)}`,
  JOOEVENTS_IDEMPOTENCY_KEYS: `1:${durableKey(12)}`,
  JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `1:${durableKey(13)}`,
  JOOEVENTS_PERSISTENT_HMAC_KEYS: `1:${durableKey(14)}`,
  JOOEVENTS_GOOGLE_CLIENT_ID: 'browser-test-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'browser-test-client-secret',
  JOOEVENTS_ADMISSION_MODE: 'reservation_only',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: ownerEmail,
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'jooevents.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: dataDirectory
});

// This fixture binds loopback only and uses the test-only configured constructor;
// the production constructor cannot mount issued-link or actor fixture authority.
const runtime = await createConfiguredSQLiteLiveRuntimeForTesting({ config });
const now = Date.now();
const authUserId = crypto.randomUUID();
runtime.database.sqlite.query(`
  INSERT INTO auth_users (
    id, name, email, email_verified, image, created_at, updated_at
  ) VALUES (?, 'Browser Test Owner', ?, 1, NULL, ?, ?)
`).run(authUserId, ownerEmail, now, now);
runtime.database.sqlite.query(`
  INSERT INTO auth_accounts (
    id, account_id, provider_id, user_id, created_at, updated_at
  ) VALUES (?, ?, 'google', ?, ?, ?)
`).run(crypto.randomUUID(), `browser-${crypto.randomUUID()}`, authUserId, now, now);
runtime.database.sqlite.query(`
  INSERT INTO auth_sessions (
    id, token, user_id, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`).run(crypto.randomUUID(), rawToken, authUserId, now + 60 * 60 * 1000, now, now);

const signature = await makeSignature(rawToken, secret);
const cookie = `better-auth.session_token=${rawToken}.${signature}`;
const provisioned = await runtime.app.request('/api/me/access-context', {
  headers: { cookie, 'x-correlation-id': crypto.randomUUID() }
});
if (!provisioned.ok) {
  await runtime.close();
  rmSync(dataDirectory, { recursive: true });
  throw new Error(`Retained browser-test owner provisioning failed (${provisioned.status}).`);
}

const sourceBuildDirectory = resolve(import.meta.dir, '../../../web/build-live');
const sourceBuildIdentity = validateLiveBuildIdentity(sourceBuildDirectory);
const buildDirectory = join(dataDirectory, 'web-build');
cpSync(sourceBuildDirectory, buildDirectory, {
  recursive: true,
  dereference: false,
  errorOnExist: true,
  force: false
});
const buildIdentity = validateLiveBuildIdentity(buildDirectory);
if (buildIdentity.digestSha256 !== sourceBuildIdentity.digestSha256) {
  await runtime.close();
  rmSync(dataDirectory, { recursive: true });
  throw new Error('Retained browser-test live build changed while it was snapshotted.');
}
const fetch = createProductionRequestHandler({
  backend: runtime.app.fetch,
  buildDirectory,
  buildIdentity
});
const server = Bun.serve({ hostname, port, development: false, fetch });

process.stdout.write(`jooevents-retained-browser-test-ready:${baseUrl}\n`);
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.stop();
  await runtime.close();
  if (dataDirectory.startsWith(join(tmpdir(), 'jooevents-retained-browser-'))) {
    rmSync(dataDirectory, { recursive: true });
  }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
