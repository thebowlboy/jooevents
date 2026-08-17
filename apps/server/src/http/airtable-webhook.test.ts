import { describe, expect, test } from 'bun:test';
import {
  createAirtableWebhookHttpAdapter,
  type AirtableWebhookIngressRuntime
} from './airtable-webhook';

const callbackRef = 'opaque_airtable_callback_ref_000001';
const contentMac = `hmac-sha256=${'a'.repeat(64)}`;

function runtime(
  intake: AirtableWebhookIngressRuntime['intake']
): AirtableWebhookIngressRuntime {
  return { maximumRawBodyBytes: 512, intake };
}

describe('Airtable webhook HTTP adapter', () => {
  test('passes exact body bytes and returns empty success only after durable acceptance', async () => {
    const seen: Uint8Array[] = [];
    const app = createAirtableWebhookHttpAdapter(runtime(async (input) => {
      seen.push(input.rawBody);
      expect(input.callbackRef).toBe(callbackRef);
      expect(input.contentMac).toBe(contentMac);
      return { kind: 'accepted' };
    }));
    const body = '{ "webhook": {"id":"ach1"}, "spacing": true }';
    const response = await app.request(`/webhooks/airtable/${callbackRef}`, {
      method: 'POST',
      headers: { 'x-airtable-content-mac': contentMac },
      body
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(new TextDecoder().decode(seen[0])).toBe(body);
  });

  test('fails closed for malformed evidence, oversized bodies, and deferred durability', async () => {
    let calls = 0;
    const app = createAirtableWebhookHttpAdapter(runtime(async () => {
      calls += 1;
      return { kind: 'deferred', retryAfterSeconds: 9 };
    }));
    expect((await app.request(`/webhooks/airtable/${callbackRef}`, {
      method: 'POST', body: '{}'
    })).status).toBe(401);
    expect((await app.request(`/webhooks/airtable/${callbackRef}`, {
      method: 'POST',
      headers: { 'x-airtable-content-mac': contentMac },
      body: 'x'.repeat(513)
    })).status).toBe(413);
    const deferred = await app.request(`/webhooks/airtable/${callbackRef}`, {
      method: 'POST',
      headers: { 'x-airtable-content-mac': contentMac },
      body: '{}'
    });
    expect(deferred.status).toBe(503);
    expect(deferred.headers.get('retry-after')).toBe('9');
    expect(calls).toBe(1);
  });
});
