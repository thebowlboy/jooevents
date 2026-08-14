import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import { eventCreateDraftOperationResultSchema } from '@jooevents/contracts';
import { changesetLifecycleOperationResultSchema } from '@jooevents/changeset-operations';
import {
  workspaceSignInLinkAddressFingerprint,
  WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID
} from '@jooevents/persistence/workspace-sign-in-link';
import { loadEphemeralLiveConfig } from '../config';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig
} from '../config/communications';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';

/**
 * The workspace magic-link acceptance loop (owner revision, 2026-08-14:
 * registered or reserved). One joined test proves the user-visible loop end
 * to end: a reservation-named address requests a link on the anonymous entry
 * surface, completes it, and lands ADMITTED — first sign-in included — while
 * unknown addresses get byte-identical acknowledgements and no durable work.
 */

const runtimes: EphemeralLiveRuntime[] = [];
const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-by-workspace-magic-link-test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-by-workspace-magic-link-test'
});

const INVITEE_EMAIL = 'invitee@example.test';

interface BrowserSession {
  readonly authUserId: string;
  readonly cookie: string;
}

function cleanupRetainedTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || !basename(path).startsWith('jooevents-ephemeral-runtime-')) {
    throw new Error(`unsafe_workspace_magic_link_cleanup:${path}`);
  }
  if (dirname(path) !== realpathSync(dirname(path))) {
    throw new Error(`unsafe_workspace_magic_link_parent:${path}`);
  }
  rmSync(path, { recursive: true });
}

afterEach(() => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (!runtime) continue;
    runtime.close();
    cleanupRetainedTree(runtime.database.directoryPath);
  }
});

async function createOwnerSession(runtime: EphemeralLiveRuntime): Promise<BrowserSession> {
  const now = Date.now();
  const authUserId = crypto.randomUUID();
  const rawToken = crypto.randomUUID();
  runtime.database.sqlite.query(`
    INSERT INTO auth_users (
      id, name, email, email_verified, image, created_at, updated_at
    ) VALUES (?, 'Magic link owner', ?, 1, NULL, ?, ?)
  `).run(authUserId, config.bootstrapOwnerEmail, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_accounts (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, 'google', ?, ?, ?)
  `).run(crypto.randomUUID(), `google-${crypto.randomUUID()}`, authUserId, now, now);
  runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), rawToken, authUserId, now + 3_600_000, now, now);
  const secret = config.authSecrets[0]?.value;
  if (!secret) throw new Error('workspace_magic_link_auth_secret_missing');
  const signature = await makeSignature(rawToken, secret);
  return Object.freeze({
    authUserId,
    cookie: `better-auth.session_token=${rawToken}.${signature}`
  });
}

function operatorHeaders(input: {
  readonly session: BrowserSession;
  readonly key?: string;
}): Headers {
  const headers = new Headers({
    cookie: input.session.cookie,
    origin: config.baseUrl,
    'content-type': 'application/json',
    'x-correlation-id': crypto.randomUUID()
  });
  if (input.key) headers.set('idempotency-key', input.key);
  return headers;
}

async function effect(input: {
  readonly runtime: EphemeralLiveRuntime;
  readonly session: BrowserSession;
  readonly path: string;
  readonly key: string;
  readonly body: unknown;
}): Promise<unknown> {
  const response = await input.runtime.app.request(input.path, {
    method: 'POST',
    headers: operatorHeaders({ session: input.session, key: input.key }),
    body: JSON.stringify(input.body)
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function createEvent(
  runtime: EphemeralLiveRuntime,
  session: BrowserSession
): Promise<void> {
  const draft = eventCreateDraftOperationResultSchema.parse(await effect({
    runtime,
    session,
    path: '/api/events/drafts/create',
    key: 'magic-link-event-draft',
    body: {
      name: 'Magic Link Event',
      timezone: 'Asia/Singapore',
      startDate: '2027-06-10',
      endDate: '2027-06-12'
    }
  }));
  if (draft.kind !== 'success') throw new Error('workspace_magic_link_event_draft_failed');
  const selector = Object.freeze({
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  });
  const proposed = changesetLifecycleOperationResultSchema.parse(await effect({
    runtime, session,
    path: '/api/changesets/proposals',
    key: 'magic-link-event-propose',
    body: { ...selector, expectedHeadVersion: 1 }
  }));
  expect(proposed).toMatchObject({ kind: 'success', data: { action: 'propose' } });
  const committed = changesetLifecycleOperationResultSchema.parse(await effect({
    runtime, session,
    path: '/api/changesets/commits',
    key: 'magic-link-event-commit',
    body: { ...selector, expectedHeadVersion: 2 }
  }));
  expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
}

function insertOpenReservation(runtime: EphemeralLiveRuntime, email: string): void {
  const now = Date.now();
  const role = runtime.database.sqlite.query<{ readonly id: string }, [string, string]>(`
    SELECT id FROM roles
     WHERE workspace_id = ? AND source_preset_key = ? AND archived_at IS NULL
  `).get(runtime.workspaceId, 'viewer');
  if (!role) throw new Error('workspace_magic_link_role_missing');
  const reservationId = crypto.randomUUID();
  runtime.database.sqlite.query(`
    INSERT INTO access_reservations (
      id, workspace_id, normalized_email, status, created_at, version
    ) VALUES (?, ?, ?, 'open', ?, 1)
  `).run(reservationId, runtime.workspaceId, email.toLowerCase(), now);
  runtime.database.sqlite.query(`
    INSERT INTO reservation_role_assignments (
      id, reservation_id, role_id, scope_kind, event_id
    ) VALUES (?, ?, ?, 'workspace', NULL)
  `).run(crypto.randomUUID(), reservationId, role.id);
}

async function requestLink(
  runtime: EphemeralLiveRuntime,
  email: string
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await runtime.app.request('/api/entry/sign-in-link', {
    method: 'POST',
    headers: {
      origin: config.baseUrl,
      'content-type': 'application/json',
      'x-correlation-id': crypto.randomUUID()
    },
    body: JSON.stringify({ email })
  });
  return { status: response.status, body: await response.text() };
}

async function issuedLink(
  runtime: EphemeralLiveRuntime,
  email: string
): Promise<{ readonly kind: 'none' } | { readonly kind: 'issued'; readonly url: string }> {
  const response = await runtime.app.request('/api/entry/dev/issued-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<
    { readonly kind: 'none' } | { readonly kind: 'issued'; readonly url: string }
  >;
}

function sessionCookieFrom(response: Response): string {
  const cookie = response.headers.getSetCookie()
    .map((entry) => entry.split(';', 1)[0]!)
    .find((entry) => entry.startsWith('better-auth.session_token='));
  if (!cookie || cookie.endsWith('=')) {
    throw new Error('workspace_magic_link_session_cookie_missing');
  }
  return cookie;
}

/** The pinned `/a/:token` expansion target: relative callbacks, verify arbitrates. */
function verifyLocation(token: string): string {
  return `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`
    + `&callbackURL=${encodeURIComponent('/auth/complete?returnTo=/app')}`
    + `&errorCallbackURL=${encodeURIComponent('/sign-in?notice=link_invalid')}`;
}

/** Follows the short link's fixed 302 into the verify endpoint and returns its response. */
async function completeShortLink(
  runtime: EphemeralLiveRuntime,
  shortUrl: string
): Promise<Response> {
  const expand = await runtime.app.request(shortUrl);
  expect(expand.status).toBe(302);
  expect(expand.headers.getSetCookie()).toEqual([]);
  const location = expand.headers.get('location') ?? '';
  expect(location).toBe(verifyLocation(shortUrl.slice(shortUrl.lastIndexOf('/') + 1)));
  return runtime.app.request(location);
}

describe('workspace magic-link sign-in', () => {
  test('a reserved address completes a FIRST sign-in and lands admitted; the link works once', async () => {
    const runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(runtime);
    const owner = await createOwnerSession(runtime);
    const provisioned = await runtime.app.request('/api/me/access-context', {
      headers: { cookie: owner.cookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(await provisioned.json()).toMatchObject({ state: 'active' });

    // Before any event exists, security mail has no delivery scope: the
    // acknowledgement is identical, and nothing is issued.
    insertOpenReservation(runtime, INVITEE_EMAIL);
    const preEvent = await requestLink(runtime, INVITEE_EMAIL);
    expect(preEvent.status).toBe(200);
    expect(await issuedLink(runtime, INVITEE_EMAIL)).toEqual({ kind: 'none' });

    await createEvent(runtime, owner);

    const requested = await requestLink(runtime, INVITEE_EMAIL);
    expect(requested.status).toBe(200);
    expect(JSON.parse(requested.body)).toEqual({ outcome: 'link_requested' });

    const issued = await issuedLink(runtime, INVITEE_EMAIL);
    if (issued.kind !== 'issued') throw new Error('workspace_magic_link_not_issued');

    // The emailed naked link is the short form: origin, `/a/`, and a 22-char
    // base64url token (16 random bytes).
    expect(issued.url).toMatch(/^https?:\/\/[^/]+\/a\/[A-Za-z0-9_-]{22}$/);

    // Garbage tokens produce the byte-identical redirect shape — same status,
    // identical headers, same Location construction — so the short route
    // discloses nothing; the verify endpoint is the single arbiter. Overlong
    // path tokens are capped without changing the shape.
    const wellFormed = await runtime.app.request(issued.url);
    expect(wellFormed.status).toBe(302);
    const garbage = await runtime.app.request(`${config.baseUrl}/a/definitely-not-a-token`);
    expect(garbage.status).toBe(302);
    expect(garbage.headers.get('location')).toBe(verifyLocation('definitely-not-a-token'));
    expect(garbage.headers.getSetCookie()).toEqual([]);
    expect([...garbage.headers.entries()].map(([name]) => name).sort())
      .toEqual([...wellFormed.headers.entries()].map(([name]) => name).sort());
    expect(garbage.headers.get('cache-control')).toBe(wellFormed.headers.get('cache-control'));
    const oversized = await runtime.app.request(`${config.baseUrl}/a/${'x'.repeat(600)}`);
    expect(oversized.status).toBe(302);
    expect(oversized.headers.get('location')).toBe(verifyLocation('x'.repeat(512)));

    // The completed link mints the session AND performs first admission: the
    // open reservation is consumed exactly as a provider sign-in would.
    const verify = await completeShortLink(runtime, issued.url);
    expect([302, 307]).toContain(verify.status);
    const location = verify.headers.get('location') ?? '';
    expect(location).toContain('/auth/complete');
    const cookie = sessionCookieFrom(verify);

    const context = await runtime.app.request('/api/me/access-context', {
      headers: { cookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(await context.json()).toMatchObject({
      state: 'active',
      workspace: { id: runtime.workspaceId }
    });
    const reservation = runtime.database.sqlite.query<{ readonly status: string }, [string, string]>(`
      SELECT status FROM access_reservations WHERE workspace_id = ? AND normalized_email = ?
    `).get(runtime.workspaceId, INVITEE_EMAIL);
    expect(reservation?.status).toBe('consumed');
    // The signup display name is the address's local part, never empty.
    const user = runtime.database.sqlite.query<{ readonly name: string }, [string]>(`
      SELECT name FROM auth_users WHERE email = ?
    `).get(INVITEE_EMAIL);
    expect(user?.name).toBe('invitee');

    // Single use: replaying the same short link redirects to the closed notice
    // and mints nothing.
    const replay = await completeShortLink(runtime, issued.url);
    expect([302, 307]).toContain(replay.status);
    expect(replay.headers.get('location') ?? '').toContain('notice=link_invalid');
    expect(replay.headers.getSetCookie().some(
      (entry) => entry.startsWith('better-auth.session_token=') && !entry.startsWith('better-auth.session_token=;')
    )).toBe(false);

    // Now REGISTERED: a second request serves the returning-user branch of the
    // same lane, and its fresh link signs the same User in again.
    const again = await requestLink(runtime, INVITEE_EMAIL);
    expect(again.status).toBe(200);
    const reissued = await issuedLink(runtime, INVITEE_EMAIL);
    if (reissued.kind !== 'issued') throw new Error('workspace_magic_link_not_reissued');
    expect(reissued.url).not.toBe(issued.url);
    const secondVerify = await completeShortLink(runtime, reissued.url);
    const secondCookie = sessionCookieFrom(secondVerify);
    const secondContext = await runtime.app.request('/api/me/access-context', {
      headers: { cookie: secondCookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(await secondContext.json()).toMatchObject({ state: 'active' });
    const users = runtime.database.sqlite.query<{ readonly count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM auth_users WHERE email = ?
    `).all(INVITEE_EMAIL);
    expect(users[0]?.count).toBe(1);
  });

  test('unknown addresses are acknowledged byte-identically and produce no durable work', async () => {
    const runtime = await createEphemeralLiveRuntime({ config, devFixtures: true });
    runtimes.push(runtime);
    const owner = await createOwnerSession(runtime);
    await runtime.app.request('/api/me/access-context', {
      headers: { cookie: owner.cookie, 'x-correlation-id': crypto.randomUUID() }
    });
    await createEvent(runtime, owner);
    insertOpenReservation(runtime, INVITEE_EMAIL);

    const eligible = await requestLink(runtime, INVITEE_EMAIL);
    const unknown = await requestLink(runtime, 'nobody@example.test');
    expect(unknown.status).toBe(eligible.status);
    expect(unknown.body).toBe(eligible.body);
    expect(await issuedLink(runtime, 'nobody@example.test')).toEqual({ kind: 'none' });
    const heads = runtime.database.sqlite.query<{ readonly count: number }, []>(`
      SELECT COUNT(*) AS count FROM communication_outbound_delivery_heads
       WHERE template_revision_ref_id = 'template.workspace-sign-in-link.v1'
    `).all();
    expect(heads[0]?.count).toBe(1);

    // Malformed addresses are refused before any durable work.
    const malformed = await requestLink(runtime, 'not-an-address');
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toMatchObject({ code: 'invalid_request' });
  });

  test('a composed provider dispatches the link right after commit, ahead of the sweep', async () => {
    const sends: string[] = [];
    const runtime = await createEphemeralLiveRuntime({
      config,
      devFixtures: true,
      communications: {
        provider: loadCommunicationsProviderConfig({
          JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
          JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
          JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
          JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
        }),
        mailSender: loadMailSenderConfig({
          JOOEVENTS_MAIL_FROM_ADDRESS: 'events@mail.example.test',
          JOOEVENTS_MAIL_FROM_NAME: 'JooEvents'
        }),
        secretResolver: { withSecretText: async (_reference, use) => use('stub-secret-token') },
        fetch: async (url) => {
          if (String(url).includes('/email/sending/send')) {
            sends.push(String(url));
            return new Response(JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: {
                message_id: '<instant-dispatch@example.test>',
                delivered: [INVITEE_EMAIL],
                queued: [],
                permanent_bounces: []
              }
            }), { status: 200 });
          }
          return new Response(
            JSON.stringify({ success: true, result: { status: 'active' } }),
            { status: 200 }
          );
        }
      }
    });
    runtimes.push(runtime);
    const owner = await createOwnerSession(runtime);
    await runtime.app.request('/api/me/access-context', {
      headers: { cookie: owner.cookie, 'x-correlation-id': crypto.randomUUID() }
    });
    await createEvent(runtime, owner);
    insertOpenReservation(runtime, INVITEE_EMAIL);

    const requested = await requestLink(runtime, INVITEE_EMAIL);
    expect(requested.status).toBe(200);

    // The after-commit kick moves the delivery head out of `pending` within
    // this poll window, which stays strictly shorter than the 2s sweep
    // period — the mail leaves without waiting for any pump pass.
    const readHeadState = () => runtime.database.sqlite.query<{
      readonly state: string;
    }, [string, string]>(`
      SELECT state FROM communication_outbound_delivery_heads
       WHERE template_revision_ref_id = ? AND address_lookup_fingerprint_sha256 = ?
       ORDER BY rowid DESC LIMIT 1
    `).get(
      WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID,
      workspaceSignInLinkAddressFingerprint(INVITEE_EMAIL)
    )?.state;
    const deadline = Date.now() + 1_000;
    let state = readHeadState();
    while ((state === undefined || state === 'pending' || state === 'request_started')
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = readHeadState();
    }
    expect(state).toBe('accepted');
    expect(sends).toHaveLength(1);
  });

  test('the workspace link oracle is structurally absent unless devFixtures is set', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);
    const response = await runtime.app.request('/api/entry/dev/issued-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: INVITEE_EMAIL })
    });
    expect(response.status).toBe(404);
  });
});
