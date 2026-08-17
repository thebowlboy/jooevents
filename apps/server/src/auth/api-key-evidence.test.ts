import { expect, test } from 'bun:test';
import { mintApiKey, type ApiKeyRecord, type ApiKeyStore } from '@jooevents/identity-access';
import { parseApiKeyId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import { createApiKeyEvidenceVerifier } from './api-key-evidence';

const workspaceId = parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7100');
const minted = mintApiKey({ randomBytes: () => new Uint8Array(32) });
const key: ApiKeyRecord = Object.freeze({
  apiKeyId: parseApiKeyId('018f0f47-7a86-7d36-8a25-9f86589c7400'),
  workspaceId,
  ownerUserId: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7200'),
  displayName: 'Assistant',
  tokenHashSha256: minted.tokenHashSha256,
  tokenHint: minted.tokenHint,
  mayRead: true,
  maySubmitPlans: false,
  permissionIds: ['event.read'] as const,
  eventIds: [],
  createdAt: '2026-08-17T00:00:00.000Z',
  expiresAt: '2026-11-15T00:00:00.000Z',
  lastUsedAt: null,
  standing: 'active',
  revokedAt: null,
  revokedByUserId: null,
  revokeReason: null,
  rotationSuccessorId: null,
  version: 1
});

test('uniformly rejects absent and malformed bearer values and never reads cookies', () => {
  const lookups: string[] = [];
  const store = {
    resolveByTokenHash(input) {
      lookups.push(input.tokenHashSha256);
      return input.tokenHashSha256 === key.tokenHashSha256
        ? { kind: 'current' as const, key }
        : { kind: 'invalid' as const };
    },
    recordUse() {},
    get() { return undefined; }, list() { return []; }, create() { throw new Error(); },
    rotate() { throw new Error(); }, revoke() { throw new Error(); }
  } satisfies ApiKeyStore;
  const verifier = createApiKeyEvidenceVerifier({
    workspaceId,
    apiKeys: store,
    ownerIsCurrent: () => true,
    now: () => '2026-08-17T01:00:00.000Z'
  });
  const absent = verifier.verify(new Request('https://events.test/api/v1/me', {
    headers: { cookie: `api_key=${minted.secret}` }
  }), 'read');
  const malformed = verifier.verify(new Request('https://events.test/api/v1/me', {
    headers: { authorization: 'Bearer jooak1_short' }
  }), 'read');
  expect(absent).toEqual({ kind: 'rejected', reason: 'unauthenticated' });
  expect(malformed).toEqual(absent);
  expect(lookups).toHaveLength(2);
});

test('emits credential-neutral external-agent evidence and keeps capability denial distinct', () => {
  let used = 0;
  const store = {
    resolveByTokenHash: () => ({ kind: 'current' as const, key }),
    recordUse: () => { used += 1; },
    get() { return undefined; }, list() { return []; }, create() { throw new Error(); },
    rotate() { throw new Error(); }, revoke() { throw new Error(); }
  } satisfies ApiKeyStore;
  const verifier = createApiKeyEvidenceVerifier({
    workspaceId,
    apiKeys: store,
    ownerIsCurrent: () => true,
    now: () => '2026-08-17T01:00:00.000Z'
  });
  const request = new Request('https://events.test/api/v1/me', {
    headers: { authorization: `Bearer ${minted.secret}`, cookie: 'session=ambient' }
  });
  const allowed = verifier.verify(request, 'read');
  expect(allowed).toMatchObject({
    kind: 'verified',
    evidence: {
      kind: 'external_mcp',
      client: { key: 'api.v1' },
      credentialHandle: key.apiKeyId,
      clientKey: `api-key:${key.apiKeyId}`
    }
  });
  expect(verifier.verify(request, 'submit_plans')).toEqual({ kind: 'rejected', reason: 'forbidden' });
  expect(used).toBe(1);
});

test('rejects a valid key when its owner no longer has active workspace standing', () => {
  let recorded = false;
  const verifier = createApiKeyEvidenceVerifier({
    workspaceId,
    apiKeys: {
      resolveByTokenHash: () => ({ kind: 'current' as const, key }),
      recordUse: () => { recorded = true; },
      get() { return undefined; }, list() { return []; }, create() { throw new Error(); },
      rotate() { throw new Error(); }, revoke() { throw new Error(); }
    },
    ownerIsCurrent: () => false,
    now: () => '2026-08-17T01:00:00.000Z'
  });
  expect(verifier.verify(new Request('https://events.test/api/v1/me', {
    headers: { authorization: `Bearer ${minted.secret}` }
  }), 'read')).toEqual({ kind: 'rejected', reason: 'unauthenticated' });
  expect(recorded).toBe(false);
});
