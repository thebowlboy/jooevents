import { describe, expect, test } from 'bun:test';
import { createAirtableWebhookIngress } from './webhook-ingress';

describe('Airtable webhook verified-inbox handoff', () => {
  test('acknowledges only durable inbox intake and passes MAC evidence with exact bytes', async () => {
    const rawBody = new TextEncoder().encode('{ "exact": true }');
    const ingress = createAirtableWebhookIngress({
      intakes: {
        async resolve(callbackRef) {
          expect(callbackRef).toBe('opaque-ref');
          return {
            async intake(input) {
              expect(input.rawEnvelope).toBe(rawBody);
              expect(input.protocolEvidence).toEqual({ contentMac: 'hmac-sha256=abc' });
              return { kind: 'intake' };
            }
          };
        }
      }
    });
    expect(await ingress.intake({
      callbackRef: 'opaque-ref', rawBody, contentMac: 'hmac-sha256=abc'
    })).toEqual({ kind: 'accepted' });
  });

  test('does not enumerate missing callbacks and retries non-durable inbox outcomes', async () => {
    const bytes = new Uint8Array();
    const missing = createAirtableWebhookIngress({
      intakes: { async resolve() { return undefined; } }
    });
    expect(await missing.intake({ callbackRef: 'missing', rawBody: bytes, contentMac: 'mac' }))
      .toEqual({ kind: 'rejected' });
    for (const kind of ['deferred', 'requires_attention'] as const) {
      const ingress = createAirtableWebhookIngress({
        retryAfterSeconds: 11,
        intakes: {
          async resolve() { return { async intake() { return { kind }; } }; }
        }
      });
      expect(await ingress.intake({ callbackRef: 'opaque', rawBody: bytes, contentMac: 'mac' }))
        .toEqual({ kind: 'deferred', retryAfterSeconds: 11 });
    }
  });
});
