import { describe, expect, test } from 'bun:test';
import { createCloudflareEmailDeliveryLookup } from './analytics';

function response(events: unknown[], status = 200): Response {
  return new Response(JSON.stringify({
    data: { viewer: { zones: [{ emailSendingAdaptive: events }] } }
  }), { status, headers: { 'content-type': 'application/json' } });
}

describe('Cloudflare Email GraphQL delivery lookup', () => {
  test('normalizes a matching delivered event without retaining recipient payload fields', async () => {
    let request: Request | undefined;
    const lookup = createCloudflareEmailDeliveryLookup({
      zoneId: 'zone_123',
      tokenLease: { withApiToken: (use) => use('secret-token') },
      fetch: async (url, init) => {
        request = new Request(url, init);
        return response([
          { datetime: '2026-08-18T10:00:00Z', messageId: 'other', status: 'delivered' },
          {
            datetime: '2026-08-18T09:59:00Z', messageId: 'message-1', status: 'delivered',
            to: 'classified@example.com', subject: 'Classified subject', isLastEvent: 1
          }
        ]);
      }
    });
    const result = await lookup.lookup({
      providerMessageId: 'message-1',
      start: '2026-08-18T09:00:00Z',
      end: '2026-08-18T11:00:00Z'
    });
    expect(result).toMatchObject({
      kind: 'found', disposition: 'delivered', providerMessageId: 'message-1',
      providerObservedAt: '2026-08-18T09:59:00.000Z'
    });
    expect(result.kind === 'found' ? JSON.stringify(result) : '').not.toContain('classified@example.com');
    expect(result.kind === 'found' ? result.safeEvidence.registeredFacts : []).toContainEqual(
      expect.objectContaining({ factKey: 'cloudflare.observation', enumValue: 'delivery_confirmed' })
    );
    expect(request?.headers.get('authorization')).toBe('Bearer secret-token');
    expect(await request?.json()).toMatchObject({ variables: { zoneTag: 'zone_123' } });
  });

  test('normalizes deliveryFailed and keeps absence distinct from provider failure', async () => {
    const rows = [{
      datetime: '2026-08-18T10:00:00Z', messageId: 'message-1',
      status: 'deliveryFailed', errorCause: 'hard bounce'
    }];
    const failed = createCloudflareEmailDeliveryLookup({
      zoneId: 'zone_123', tokenLease: { withApiToken: (use) => use('token') },
      fetch: async () => response(rows)
    });
    expect(await failed.lookup({
      providerMessageId: 'message-1', start: '2026-08-18T09:00:00Z', end: '2026-08-18T11:00:00Z'
    })).toMatchObject({ kind: 'found', disposition: 'delivery_failed' });

    const absent = createCloudflareEmailDeliveryLookup({
      zoneId: 'zone_123', tokenLease: { withApiToken: (use) => use('token') },
      fetch: async () => response([])
    });
    expect(await absent.lookup({
      providerMessageId: 'message-1', start: '2026-08-18T09:00:00Z', end: '2026-08-18T11:00:00Z'
    })).toEqual({ kind: 'not_found' });
  });

  test('fails closed on GraphQL errors and malformed zone cardinality', async () => {
    const graphqlError = createCloudflareEmailDeliveryLookup({
      zoneId: 'zone_123', tokenLease: { withApiToken: (use) => use('token') },
      fetch: async () => new Response(JSON.stringify({ errors: [{ message: 'denied' }] }))
    });
    expect(await graphqlError.lookup({
      providerMessageId: 'message-1', start: '2026-08-18T09:00:00Z', end: '2026-08-18T11:00:00Z'
    })).toEqual({ kind: 'unavailable', reason: 'invalid_response' });
  });
});
