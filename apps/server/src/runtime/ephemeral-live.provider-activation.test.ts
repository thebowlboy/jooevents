import { afterEach, describe, expect, test } from 'bun:test';
import { loadEphemeralLiveConfig } from '../config';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig
} from '../config/communications';
import { createEphemeralLiveRuntime, type EphemeralLiveRuntime } from './ephemeral-live';
import type { OpaqueSecretTextResolver } from './communications-provider-runtime';

/**
 * Activated-composition coverage for the reviewed Cloudflare change: the
 * runtime composes the provider registry, lifecycle row, delivery routes, and
 * owner-gated executor mounts from the entry-passed communications config —
 * with injected secret and fetch seams, so no test byte can reach a real
 * provider — and stays byte-identically inert when the config is omitted.
 */

const config = loadEphemeralLiveConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'ignored-by-explicit-ephemeral-entry.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/ignored-by-explicit-ephemeral-entry'
});

const runtimes: EphemeralLiveRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

const stubResolver: OpaqueSecretTextResolver = {
  async withSecretText(_reference, use) {
    return use('stub-secret-token');
  }
};

async function activatedRuntime(fetchStub: (url: string) => Response | Promise<Response>) {
  const runtime = await createEphemeralLiveRuntime({
    config,
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
      secretResolver: stubResolver,
      fetch: async (url) => fetchStub(String(url))
    }
  });
  runtimes.push(runtime);
  return runtime;
}

describe('ephemeral live provider activation composition', () => {
  test('stays structurally inert without the entry-passed communications config', async () => {
    const runtime = await createEphemeralLiveRuntime({ config });
    runtimes.push(runtime);

    expect(runtime.providerActivation).toBeUndefined();
    expect(runtime.database.sqlite.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM email_provider_connections
    `).get()?.count).toBe(0);
    const denied = await runtime.app.request('/api/communications/email-readiness/check', {
      method: 'POST',
      headers: { origin: 'http://localhost:5176' }
    });
    // The executor routes are not mounted at all: reserved-namespace 404,
    // not an authentication refusal.
    expect(denied.status).toBe(404);
  });

  test('activates the lifecycle row and mounts the owner-gated executors', async () => {
    const runtime = await activatedRuntime(() => new Response(JSON.stringify({
      success: true,
      result: { status: 'active' }
    }), { status: 200 }));

    expect(runtime.providerActivation).toBeDefined();
    const row = runtime.database.sqlite.query<{
      readonly lifecycle: string;
      readonly current_revision_id: string | null;
      readonly adapter_key: string;
    }, []>(`
      SELECT lifecycle, current_revision_id, adapter_key FROM email_provider_connections
    `).get();
    expect(row).toEqual({
      lifecycle: 'active_outbound',
      current_revision_id: expect.any(String),
      adapter_key: 'cloudflare.email.rest'
    });

    // Owner-lane gate: an unauthenticated caller is refused typed before any
    // provider I/O; the executors stay reachable only with operator authority.
    const readiness = await runtime.app.request('/api/communications/email-readiness/check', {
      method: 'POST',
      headers: { origin: 'http://localhost:5176' }
    });
    expect(readiness.status).toBe(401);
    const diagnostic = await runtime.app.request('/api/communications/email-diagnostic/send-test', {
      method: 'POST',
      headers: { origin: 'http://localhost:5176', 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: 'owner@example.test' })
    });
    expect(diagnostic.status).toBe(401);

    // The composed executor itself runs against the injected seams.
    const check = await runtime.providerActivation!.runReadinessCheck();
    expect(check.state).toBe('passed');
    expect(check.readiness).toBe('ready');
  });

  test('refuses activation without a configured sender identity', async () => {
    expect(createEphemeralLiveRuntime({
      config,
      communications: {
        provider: loadCommunicationsProviderConfig({
          JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
          JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
          JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
          JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
        }),
        mailSender: loadMailSenderConfig({}),
        secretResolver: stubResolver,
        fetch: async () => new Response('{}', { status: 500 })
      }
    })).rejects.toThrow('JOOEVENTS_MAIL_FROM_ADDRESS is required');
  });
});
