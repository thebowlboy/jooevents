import { describe, expect, test } from 'bun:test';
import { loadCommunicationsProviderConfig } from '../config/communications';
import {
  createCloudflareApiTokenLease,
  createCommunicationsProviderRuntime,
  type OpaqueSecretTextResolver
} from './communications-provider-runtime';

describe('communications provider runtime', () => {
  test('keeps the disabled runtime empty and inert', () => {
    const runtime = createCommunicationsProviderRuntime({
      config: loadCommunicationsProviderConfig({})
    });

    expect(runtime.registry.listManifests()).toEqual([]);
    expect(runtime.selected).toBeNull();
    expect(runtime.activation).toEqual({
      providerCalls: 'not_mounted', readinessChecks: 'unmounted',
      diagnosticTests: 'not_enabled', callbacks: 'not_supported', inbound: 'not_enabled'
    });
  });

  test('registers a Workers provider without invoking binding or probe', () => {
    let bindingCalls = 0;
    let probeCalls = 0;
    const runtime = createCommunicationsProviderRuntime({
      config: loadCommunicationsProviderConfig({
        JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_workers',
        JOOEVENTS_CLOUDFLARE_EMAIL_BINDING_NAME: 'EMAIL_SENDING'
      }),
      workersBindings: {
        EMAIL_SENDING: { async send() { bindingCalls += 1; throw new Error('not expected'); } }
      },
      readinessProbe: {
        async check() { probeCalls += 1; throw new Error('not expected'); }
      }
    });

    expect(runtime.registry.listManifests()).toHaveLength(1);
    expect(runtime.selected?.adapterKey).toBe('cloudflare.email.workers');
    expect(bindingCalls).toBe(0);
    expect(probeCalls).toBe(0);
  });

  test('registers REST using lazy secret and fetch seams', () => {
    let secretCalls = 0;
    let fetchCalls = 0;
    const runtime = createCommunicationsProviderRuntime({
      config: loadCommunicationsProviderConfig({
        JOOEVENTS_EMAIL_PROVIDER_MODE: 'cloudflare_rest',
        JOOEVENTS_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account_123',
        JOOEVENTS_CLOUDFLARE_EMAIL_ZONE_ID: 'zone_123',
        JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE: 'deployment.secret',
        JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE: 'cloudflare-email-token'
      }),
      secretResolver: {
        async withSecretText(_reference, use) {
          secretCalls += 1;
          return use('leased-token');
        }
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('not expected');
      }
    });

    expect(runtime.selected?.adapterKey).toBe('cloudflare.email.rest');
    expect(secretCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('token leases invoke the opaque resolver and consumer exactly once', async () => {
    let uses = 0;
    const resolver: OpaqueSecretTextResolver = {
      async withSecretText(reference, use) {
        expect(reference).toEqual({
          storeKey: 'deployment.secret', reference: 'cloudflare-email-token'
        });
        return use('leased-token');
      }
    };
    const lease = createCloudflareApiTokenLease({
      reference: { storeKey: 'deployment.secret', reference: 'cloudflare-email-token' },
      resolver
    });

    expect(await lease.withApiToken(async (token) => {
      uses += 1;
      return token.length;
    })).toBe(12);
    expect(uses).toBe(1);
    expect(Object.keys(lease)).toEqual(['withApiToken']);
  });
});
