import { describe, expect, test } from 'bun:test';
import type { AirtableIntegrationView } from '@jooevents/contracts';
import {
  createAirtableIntegrationHttpAdapter,
  type AirtableIntegrationHttpRuntime
} from './airtable-integration';

const disconnected: AirtableIntegrationView = Object.freeze({
  state: 'not_connected', areas: [], attention: [], history: []
});

function runtime(overrides: Partial<AirtableIntegrationHttpRuntime> = {}): AirtableIntegrationHttpRuntime {
  return {
    async authorize() { return 'authorized'; },
    async read() { return disconnected; },
    async startOAuth() { return { authorizationUrl: 'https://airtable.com/oauth2/v1/authorize?state=test' }; },
    async completeOAuth() { return { redirectTo: '/app/integrations/airtable?connected=1' }; },
    async listBases() { return [{ id: 'appBase123', name: 'Event operations', permissionLevel: 'edit' }]; },
    async activate() { return { ...disconnected, state: 'provisioning', baseName: 'Event operations' }; },
    async setSharing() { return disconnected; },
    async syncNow() { return disconnected; },
    async setPaused() { return disconnected; },
    async revertHistory() { return disconnected; },
    async disconnect() { return disconnected; },
    ...overrides
  };
}

describe('Airtable integration HTTP adapter', () => {
  test('distinguishes authentication and permission refusal', async () => {
    const unauthenticated = createAirtableIntegrationHttpAdapter(runtime({
      async authorize() { return 'unauthenticated'; }
    }));
    expect((await unauthenticated.request('/api/integrations/airtable')).status).toBe(401);
    const forbidden = createAirtableIntegrationHttpAdapter(runtime({
      async authorize() { return 'forbidden'; }
    }));
    expect((await forbidden.request('/api/integrations/airtable')).status).toBe(403);
  });

  test('starts OAuth and validates callback state shape and local redirect', async () => {
    const app = createAirtableIntegrationHttpAdapter(runtime());
    const start = await app.request('/api/integrations/airtable/oauth/start', { method: 'POST' });
    expect(start.status).toBe(200);
    expect((await start.json()).authorizationUrl).toStartWith('https://airtable.com/');
    expect((await app.request('/api/integrations/airtable/oauth/callback?code=x&state=short')).status).toBe(400);
    const callback = await app.request(
      `/api/integrations/airtable/oauth/callback?code=code&state=${'s'.repeat(43)}`
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/app/integrations/airtable?connected=1');
  });

  test('lists scoped bases and accepts one finite direction choice per area', async () => {
    let activation: unknown;
    const app = createAirtableIntegrationHttpAdapter(runtime({
      async activate(input) { activation = input; return { ...disconnected, state: 'provisioning' }; }
    }));
    const bases = await app.request('/api/integrations/airtable/bases');
    expect(bases.status).toBe(200);
    expect((await bases.json()).bases).toHaveLength(1);
    const activated = await app.request('/api/integrations/airtable/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseId: 'appBase123',
        directions: [
          { areaKey: 'tasks', direction: 'work_from_airtable' },
          { areaKey: 'schedule', direction: 'keep_airtable_updated' }
        ]
      })
    });
    expect(activated.status).toBe(200);
    expect(activation).toEqual({
      baseId: 'appBase123',
      directions: [
        { areaKey: 'tasks', direction: 'work_from_airtable' },
        { areaKey: 'schedule', direction: 'keep_airtable_updated' }
      ]
    });
    const duplicate = await app.request('/api/integrations/airtable/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseId: 'appBase123', directions: [
        { areaKey: 'tasks', direction: 'work_from_airtable' },
        { areaKey: 'tasks', direction: 'keep_airtable_updated' }
      ] })
    });
    expect(duplicate.status).toBe(400);
  });

  test('validates controls before invoking the runtime', async () => {
    let pauses = 0;
    const app = createAirtableIntegrationHttpAdapter(runtime({
      async setPaused() { pauses += 1; return disconnected; }
    }));
    const invalid = await app.request('/api/integrations/airtable/pause', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    expect(invalid.status).toBe(400);
    expect(pauses).toBe(0);
    const valid = await app.request('/api/integrations/airtable/pause', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"paused":true}'
    });
    expect(valid.status).toBe(200);
    expect(pauses).toBe(1);
  });
});
