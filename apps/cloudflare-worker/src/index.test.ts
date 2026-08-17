import { describe, expect, test } from 'bun:test';
import { handleQueue, isCloudflareWakeMessage } from './index';

describe('Cloudflare Worker message boundary', () => {
  test('accepts only the versioned maintenance wake envelope', () => {
    expect(isCloudflareWakeMessage({ version: 1, kind: 'maintenance.wake', scheduledAtMs: 1 })).toBe(true);
    expect(isCloudflareWakeMessage({ version: 2, kind: 'maintenance.wake', scheduledAtMs: 1 })).toBe(false);
    expect(isCloudflareWakeMessage({ version: 1, kind: 'other', scheduledAtMs: 1 })).toBe(false);
    expect(isCloudflareWakeMessage({ version: 1, kind: 'maintenance.wake', scheduledAtMs: -1 })).toBe(false);
    expect(isCloudflareWakeMessage(null)).toBe(false);
  });

  test('acknowledges a valid wake without touching adapters while activation is off', async () => {
    let acknowledgements = 0;
    let retries = 0;
    const message = {
      id: 'inactive-wake',
      timestamp: new Date(1),
      attempts: 1,
      body: { version: 1, kind: 'maintenance.wake', scheduledAtMs: 1 },
      ack: () => { acknowledgements += 1; },
      retry: () => { retries += 1; }
    };
    await handleQueue(
      { queue: 'jooevents-jobs', messages: [message] } as unknown as MessageBatch<unknown>,
      { JOOEVENTS_APPLICATION_RUNTIME_ENABLED: 'false' } as never
    );
    expect(acknowledgements).toBe(1);
    expect(retries).toBe(0);
  });
});
