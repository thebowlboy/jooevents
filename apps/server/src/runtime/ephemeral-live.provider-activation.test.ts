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
        JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
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
    const guide = await runtime.app.request('/api/communications/email-setup-guide', {
      headers: { origin: 'http://localhost:5176' }
    });
    expect(guide.status).toBe(404);
    const deliverability = await runtime.app.request(
      '/api/communications/email-deliverability/check',
      { method: 'POST', headers: { origin: 'http://localhost:5176' } }
    );
    expect(deliverability.status).toBe(404);
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
    const guide = await runtime.app.request('/api/communications/email-setup-guide', {
      headers: { origin: 'http://localhost:5176' }
    });
    expect(guide.status).toBe(401);
    const deliverability = await runtime.app.request(
      '/api/communications/email-deliverability/check',
      { method: 'POST', headers: { origin: 'http://localhost:5176' } }
    );
    expect(deliverability.status).toBe(401);

    // The composed executor itself runs against the injected seams.
    const check = await runtime.providerActivation!.runReadinessCheck();
    expect(check.state).toBe('passed');
    expect(check.readiness).toBe('ready');
  });

  test('the deliverability executor and setup guide run against the injected seams', async () => {
    const runtime = await activatedRuntime((url) => {
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        const name = new URL(url).searchParams.get('name') ?? '';
        return new Response(JSON.stringify({
          Status: 0,
          Answer: name.startsWith('_dmarc.')
            ? [{ type: 16, data: '"v=DMARC1; p=none;"' }]
            : name.startsWith('cf-bounce._domainkey.')
              ? [{ type: 16, data: '"v=DKIM1; p=abc"' }]
              : [{ type: 16, data: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' }]
        }), { status: 200, headers: { 'content-type': 'application/dns-json' } });
      }
      return new Response(JSON.stringify({
        success: true,
        result: { status: 'active' }
      }), { status: 200 });
    });

    const projection = await runtime.providerActivation!.checkDeliverability();
    expect(projection.domain).toBe('mail.example.test');
    expect(projection.overall).toBe('pass');
    expect(projection.advisory).toBe(true);

    const guide = runtime.providerActivation!.getSetupGuide();
    expect(guide.provider.adapterKey).toBe('cloudflare.email.rest');
    expect(guide.senderDomain).toBe('mail.example.test');
    expect(guide.steps.map((step) => step.key)).toContain('cloudflare.step_01_onboard_domain');
  });

  test('an admitted owner exercises the guide and deliverability routes end to end', async () => {
    const runtime = await createEphemeralLiveRuntime({
      config,
      devFixtures: true,
      communications: {
        provider: loadCommunicationsProviderConfig({
          JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
          JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
          JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
          JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
          JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
        }),
        mailSender: loadMailSenderConfig({
          JOOEVENTS_MAIL_FROM_ADDRESS: 'events@mail.example.test',
          JOOEVENTS_MAIL_FROM_NAME: 'JooEvents'
        }),
        secretResolver: stubResolver,
        fetch: async (url) => {
          const address = String(url);
          if (address.startsWith('https://cloudflare-dns.com/dns-query')) {
            const name = new URL(address).searchParams.get('name') ?? '';
            return new Response(JSON.stringify({
              Status: 0,
              Answer: name.startsWith('_dmarc.')
                ? [{ type: 16, data: '"v=DMARC1; p=none;"' }]
                : name.startsWith('cf-bounce._domainkey.')
                  ? [{ type: 16, data: '"v=DKIM1; p=abc"' }]
                  : [{ type: 16, data: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' }]
            }), { status: 200, headers: { 'content-type': 'application/dns-json' } });
          }
          return new Response(JSON.stringify({
            success: true,
            result: { status: 'active' }
          }), { status: 200 });
        }
      }
    });
    runtimes.push(runtime);
    const support = runtime.testSupport;
    if (!support) throw new Error('ephemeral test support missing');
    const { organizer } = await support.bootstrapActors();

    const guide = await runtime.app.request('/api/communications/email-setup-guide', {
      headers: { origin: 'http://localhost:5176', cookie: organizer.cookie }
    });
    expect(guide.status).toBe(200);
    const guideBody = await guide.json() as {
      kind: string;
      guide: { senderDomain: string; steps: readonly { key: string }[] };
    };
    expect(guideBody.kind).toBe('completed');
    expect(guideBody.guide.senderDomain).toBe('mail.example.test');
    expect(guideBody.guide.steps.length).toBeGreaterThan(0);

    const deliverability = await runtime.app.request(
      '/api/communications/email-deliverability/check',
      { method: 'POST', headers: { origin: 'http://localhost:5176', cookie: organizer.cookie } }
    );
    expect(deliverability.status).toBe(200);
    const deliverabilityBody = await deliverability.json() as {
      kind: string;
      deliverability: { overall: string; advisory: boolean; domain: string };
    };
    expect(deliverabilityBody.kind).toBe('completed');
    expect(deliverabilityBody.deliverability.domain).toBe('mail.example.test');
    expect(deliverabilityBody.deliverability.overall).toBe('pass');
    expect(deliverabilityBody.deliverability.advisory).toBe(true);
  });

  test('refuses activation without a configured sender identity', async () => {
    expect(createEphemeralLiveRuntime({
      config,
      communications: {
        provider: loadCommunicationsProviderConfig({
          JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
          JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
          JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
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
