import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createEmailProviderConfigurationService,
  createEmailProviderReadinessReader
} from '@jooevents/communications';
import { createFoundationEphemeralSQLiteRuntime } from '@jooevents/persistence';
import {
  SQLiteEmailProviderConfigurationRepository
} from '@jooevents/persistence/email-provider-configuration';
import type { CloudflareFetch } from '@jooevents/cloudflare-email';
import { loadCommunicationsProviderConfig } from '../config/communications';
import { createCloudflareTokenVerificationReadinessProbe } from './cloudflare-email-readiness-probe';
import { createCommunicationsProviderActivation } from './communications-provider-activation';
import {
  createCloudflareApiTokenLease,
  createCommunicationsProviderRuntime,
  type OpaqueSecretTextResolver
} from './communications-provider-runtime';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const SECRET_TOKEN = 'unit-test-secret-token';
const TOKEN_VERIFY_URL = 'https://api.cloudflare.com/client/v4/user/tokens/verify';

const runtimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

const resolver: OpaqueSecretTextResolver = {
  async withSecretText(reference, use) {
    expect(reference).toEqual({
      storeKey: 'deployment.secret',
      reference: 'cloudflare-email-token'
    });
    return use(SECRET_TOKEN);
  }
};

function setup(
  fetchStub: CloudflareFetch,
  deliverability?: Parameters<typeof createCommunicationsProviderActivation>[0]['deliverability']
) {
  const database = createFoundationEphemeralSQLiteRuntime();
  runtimes.push(database);
  database.sqlite.query(`INSERT INTO workspaces (
    id, name, state, created_at, updated_at, version
  ) VALUES (?, 'Provider activation test', 'active', 1, 1, 1)`).run(workspaceId);

  const providerRuntime = createCommunicationsProviderRuntime({
    config: loadCommunicationsProviderConfig({
      JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
      JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
      JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
    }),
    secretResolver: resolver,
    fetch: fetchStub,
    readinessProbe: createCloudflareTokenVerificationReadinessProbe({
      tokenLease: createCloudflareApiTokenLease({
        reference: { storeKey: 'deployment.secret', reference: 'cloudflare-email-token' },
        resolver
      }),
      fetch: fetchStub
    })
  });
  const registration = providerRuntime.registration!;
  const repository = new SQLiteEmailProviderConfigurationRepository(database.sqlite);
  const configuration = createEmailProviderConfigurationService({
    registry: providerRuntime.registry,
    store: repository
  });
  const activation = createCommunicationsProviderActivation({
    sqlite: database.sqlite,
    workspaceId,
    configuration,
    repository,
    registration,
    connectionConfig: {
      accountId: 'account_123',
      apiTokenSecret: { storeKey: 'deployment.secret', reference: 'cloudflare-email-token' }
    },
    sender: {
      fromAddress: 'events@mail.example.test',
      fromDisplayName: 'JooEvents'
    },
    clock: { now: () => new Date().toISOString() },
    nowEpochMs: () => Date.now(),
    ids: { newId: () => crypto.randomUUID() },
    ...(deliverability === undefined ? {} : { deliverability })
  });
  const readiness = createEmailProviderReadinessReader({
    configuration,
    registry: providerRuntime.registry,
    store: repository,
    nowEpochMs: () => Date.now()
  });
  return { sqlite: database.sqlite, activation, readiness, repository };
}

function tokenVerifyResponse(status: number, tokenStatus = 'active'): Response {
  return new Response(JSON.stringify({
    success: status === 200,
    result: { status: tokenStatus }
  }), { status });
}

describe('communications provider activation', () => {
  test('stages and activates one deterministic connection row idempotently', async () => {
    const { sqlite, activation, repository } = setup(async () => tokenVerifyResponse(200));
    const first = await activation.ensureActiveOutboundConnection();
    const second = await activation.ensureActiveOutboundConnection();

    expect(second).toEqual(first);
    const connection = repository.requireConnection(first.connectionId);
    expect(connection.lifecycle).toBe('active_outbound');
    expect(connection.currentRevisionId).toBe(first.revisionId);
    expect(connection.candidateRevisions).toHaveLength(1);
    expect(connection.candidateRevisions[0]?.secretRequirements).toEqual([
      { key: 'cloudflare.api_token', configured: true }
    ]);
    // Only the opaque reference is stored; never the token.
    const revisionJson = sqlite.query<{ revision_json: string }, []>(`
      SELECT revision_json FROM email_provider_connection_revisions
    `).get()!;
    expect(revisionJson.revision_json).not.toContain(SECRET_TOKEN);
    expect(sqlite.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM email_provider_connections
    `).get()?.count).toBe(1);
  });

  test('runs a readiness check outside any transaction and the reader projects ready', async () => {
    let sqliteRef: Database | undefined;
    let providerCallsInTransaction = 0;
    const { sqlite, activation, readiness } = setup(async (url) => {
      expect(String(url)).toBe(TOKEN_VERIFY_URL);
      if (sqliteRef?.inTransaction) providerCallsInTransaction += 1;
      return tokenVerifyResponse(200);
    });
    sqliteRef = sqlite;
    await activation.ensureActiveOutboundConnection();

    const check = await activation.runReadinessCheck();
    expect(check.state).toBe('passed');
    expect(check.readiness).toBe('ready');
    expect(check.validUntil).not.toBeNull();
    expect(check.evidence?.registeredCode).toBe('cloudflare.email.readiness.ready');
    expect(providerCallsInTransaction).toBe(0);

    const projection = await readiness.getReadiness({ workspaceId });
    expect(projection.outbound.state).toBe('ready');
    expect(projection.callbacks.state).toBe('not_supported');
    expect(projection.inbound.state).toBe('not_enabled');
  });

  test('records a failed probe as typed blocked evidence, never a crash', async () => {
    const { activation, readiness } = setup(async () => tokenVerifyResponse(401));
    await activation.ensureActiveOutboundConnection();

    const check = await activation.runReadinessCheck();
    expect(check.state).toBe('failed');
    expect(check.readiness).toBe('blocked');
    expect(check.validUntil).toBeNull();
    expect(check.evidence?.registeredCode).toBe('cloudflare.email.readiness.known_failed');

    const projection = await readiness.getReadiness({ workspaceId });
    expect(projection.outbound.state).toBe('action_required');
  });

  test('sends one diagnostic fixture message through the real adapter grammar', async () => {
    const sent: { url: string; body: unknown; authorization: string | null }[] = [];
    const { activation } = setup(async (url, init) => {
      const address = String(url);
      if (address === TOKEN_VERIFY_URL) return tokenVerifyResponse(200);
      sent.push({
        url: address,
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization')
      });
      // Verbatim field-captured accept (2026-08-14, authorized diagnostic
      // send): message_id present, all disposition arrays empty. This is the
      // exact shape that misparsed as acceptance_unknown before the fix.
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          message_id: '<ADjOnhG6hr2MAdzDuHh1Vthg5OxvxAr3G5zc@mail.jooevents.com>',
          delivered: [],
          queued: [],
          permanent_bounces: []
        }
      }), { status: 200 });
    });
    await activation.ensureActiveOutboundConnection();

    const diagnostic = await activation.sendDiagnosticTest({
      recipient: 'owner@example.test'
    });
    expect(diagnostic.state).toBe('accepted');
    expect(diagnostic.providerMessageRecorded).toBe(true);
    expect(diagnostic.cost).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account_123/email/sending/send'
    );
    expect(sent[0]?.authorization).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(JSON.stringify(diagnostic)).not.toContain(SECRET_TOKEN);
  });

  test('checks deliverability against the declared records without persisting anything', async () => {
    const asked: string[] = [];
    const { sqlite, activation } = setup(async () => tokenVerifyResponse(200), {
      resolver: {
        resolveTxt: (name) => {
          asked.push(name);
          return Promise.resolve(name.startsWith('_dmarc.')
            ? { kind: 'no_records' as const }
            : { kind: 'answers' as const, values: ['v=spf1 include:x v=DKIM1'] });
        }
      },
      resolverKey: 'doh.test',
      expectedRecords: (domain) => [
        { key: 'spf', recordName: `cf-bounce.${domain}`, mustContain: ['v=spf1'] },
        { key: 'dmarc', recordName: `_dmarc.${domain}`, mustContain: ['v=DMARC1'] }
      ]
    });
    await activation.ensureActiveOutboundConnection();

    const projection = await activation.checkDeliverability();
    expect(projection.domain).toBe('mail.example.test');
    expect(asked).toEqual(['cf-bounce.mail.example.test', '_dmarc.mail.example.test']);
    expect(projection.records.map((record) => record.state)).toEqual(['found', 'missing']);
    expect(projection.overall).toBe('action_required');
    expect(projection.advisory).toBe(true);
    // A diagnosis, not state: no readiness row is written by a DNS check.
    const checks = sqlite.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM email_provider_readiness_checks'
    ).get();
    expect(checks?.n).toBe(0);
  });

  test('refuses deliverability as a typed error when the diagnostics are not composed', async () => {
    const { activation } = setup(async () => tokenVerifyResponse(200));
    await activation.ensureActiveOutboundConnection();
    await expect(activation.checkDeliverability()).rejects.toThrow('deliverability_not_supported');
  });

  test('derives the setup guide from the adapter manifest, links resolved', () => {
    const { activation } = setup(async () => tokenVerifyResponse(200));
    const guide = activation.getSetupGuide();
    expect(guide.provider.adapterKey).toBe('cloudflare.email.rest');
    expect(guide.fromAddress).toBe('events@mail.example.test');
    expect(guide.senderDomain).toBe('mail.example.test');
    expect(guide.steps.map((step) => step.key)).toEqual([
      'cloudflare.step_01_onboard_domain',
      'cloudflare.step_02_stage_token',
      'cloudflare.step_03_verify_readiness'
    ]);
    expect(guide.steps[0]?.officialLink?.href).toBe(
      'https://developers.cloudflare.com/email-service/configuration/domains/'
    );
    expect(guide.steps[2]?.officialLink).toBeNull();
  });
});
