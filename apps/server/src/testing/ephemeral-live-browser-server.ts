import { resolve } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime } from '../runtime/ephemeral-live';
import { validateLiveBuildIdentity } from '../runtime/live-build-identity';
import { createProductionRequestHandler } from '../runtime/request-handler';

const hostname = '127.0.0.1';
const rawPort = Bun.env.JOOEVENTS_BROWSER_TEST_PORT ?? '4184';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new TypeError('JOOEVENTS_BROWSER_TEST_PORT must be an unprivileged TCP port.');
}

const baseUrl = `http://${hostname}:${port}`;
const secret = 'browser-test-secret-that-is-at-least-thirty-two-bytes';
const ownerEmail = 'owner@example.test';
const rawToken = 'browser-test-owner-session-token';
const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: baseUrl,
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: `1:${secret}`,
  JOOEVENTS_GOOGLE_CLIENT_ID: 'browser-test-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'browser-test-client-secret',
  JOOEVENTS_ADMISSION_MODE: 'reservation_only',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: ownerEmail,
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem'
});

const runtime = await createEphemeralLiveRuntime({ config });
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
  runtime.close();
  throw new Error(`Browser test owner provisioning failed (${provisioned.status}).`);
}

const buildDirectory = resolve(import.meta.dir, '../../../web/build-live');
const buildIdentity = validateLiveBuildIdentity(buildDirectory);
const fetch = createProductionRequestHandler({
  backend: runtime.app.fetch,
  buildDirectory,
  buildIdentity
});
const server = Bun.serve({ hostname, port, development: false, fetch });

process.stdout.write(`jooevents-browser-test-ready:${baseUrl}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.stop();
  runtime.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
