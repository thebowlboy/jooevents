import { expect, test } from 'bun:test';
import { parseApiKeyId, parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  apiKeyHashEquals,
  hashApiKey,
  isWellFormedApiKey,
  mintApiKey,
  parseApiKeyPolicy,
  parseNewApiKeyRecord
} from './api-keys';

const id = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';

test('mints a shape-distinct 256-bit API key while retaining only hash and hint material', () => {
  const minted = mintApiKey({ randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index) });
  expect(minted.secret).toBe('jooak1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  expect(isWellFormedApiKey(minted.secret)).toBe(true);
  expect(minted.tokenHashSha256).toBe(hashApiKey(minted.secret));
  expect(minted.tokenHint).toBe('jooak1_AAEC');
  expect(JSON.stringify({ tokenHashSha256: minted.tokenHashSha256, tokenHint: minted.tokenHint }))
    .not.toContain(minted.secret);
  expect(apiKeyHashEquals(minted.tokenHashSha256, hashApiKey(minted.secret))).toBe(true);
  expect(apiKeyHashEquals(minted.tokenHashSha256, '0'.repeat(64))).toBe(false);
});

test('rejects malformed token material, invalid policy, and non-canonical grants', () => {
  expect(isWellFormedApiKey('jooak1_short')).toBe(false);
  expect(isWellFormedApiKey(`joak1_${'A'.repeat(43)}`)).toBe(false);
  expect(() => parseApiKeyPolicy({ defaultTtlDays: 90, maximumTtlDays: 30, rotationGraceHours: 1 }))
    .toThrow('api_key_policy_invalid');
  expect(() => parseNewApiKeyRecord({
    apiKeyId: parseApiKeyId(id),
    workspaceId: parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7a4e'),
    ownerUserId: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7a4f'),
    displayName: 'Agent',
    tokenHashSha256: 'a'.repeat(64),
    tokenHint: 'jooak1_AAEC',
    mayRead: true,
    maySubmitPlans: false,
    permissionIds: ['event.read', 'event.read'],
    eventIds: [parseEventId('018f0f47-7a86-7d36-8a25-9f86589c7500')],
    createdAt: '2026-08-17T00:00:00.000Z',
    expiresAt: '2026-11-15T00:00:00.000Z'
  })).toThrow('api_key_permissions_invalid');
});

test('accepts an explicit never-expire record without treating it as a sentinel date', () => {
  const record = parseNewApiKeyRecord({
    apiKeyId: parseApiKeyId(id),
    workspaceId: parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7a4e'),
    ownerUserId: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7a4f'),
    displayName: 'Persistent dashboard',
    tokenHashSha256: 'a'.repeat(64),
    tokenHint: 'jooak1_AAEC',
    mayRead: true,
    maySubmitPlans: false,
    permissionIds: ['event.read'],
    eventIds: [parseEventId('018f0f47-7a86-7d36-8a25-9f86589c7500')],
    createdAt: '2026-08-17T00:00:00.000Z',
    expiresAt: null
  });
  expect(record.expiresAt).toBeNull();
});
