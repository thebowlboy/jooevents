import { describe, expect, test } from 'bun:test';
import { isCloudflareWakeMessage } from './index';

describe('Cloudflare Worker message boundary', () => {
  test('accepts only the versioned maintenance wake envelope', () => {
    expect(isCloudflareWakeMessage({ version: 1, kind: 'maintenance.wake', scheduledAtMs: 1 })).toBe(true);
    expect(isCloudflareWakeMessage({ version: 2, kind: 'maintenance.wake', scheduledAtMs: 1 })).toBe(false);
    expect(isCloudflareWakeMessage({ version: 1, kind: 'other', scheduledAtMs: 1 })).toBe(false);
    expect(isCloudflareWakeMessage({ version: 1, kind: 'maintenance.wake', scheduledAtMs: -1 })).toBe(false);
    expect(isCloudflareWakeMessage(null)).toBe(false);
  });
});
