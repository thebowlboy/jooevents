import { describe, expect, test } from 'bun:test';
import {
  createSecretReference,
  createSecretStoreAdapterRef,
  type SecretReference,
  type SecretStore,
  type SecretStoreAdapterRef
} from '@jooevents/application';
import { parseAggregateVersion, type AggregateVersion } from '@jooevents/kernel';
import {
  createAirtableAuthorizationRequest,
} from '@jooevents/airtable';
import {
  createStoredAirtableGrantLease,
  rotateAirtableOAuthGrant,
  storeAirtableOAuthAttempt,
  storeAirtableOAuthGrant,
  storeAirtableWebhookMacSecret,
  withAirtableOAuthAttemptVerifier,
  withAirtableWebhookMacSecret
} from './grant-secrets';

class MemorySecretStore implements SecretStore {
  readonly records = new Map<string, {
    bytes: Uint8Array;
    version: number;
    adapter: SecretStoreAdapterRef;
    purpose: string;
    scopeBinding: string;
    revoked: boolean;
  }>();

  async create(input: {
    adapter: SecretStoreAdapterRef;
    purpose: string;
    scopeBinding: string;
    secret: Uint8Array;
  }): Promise<SecretReference> {
    const id = `secret.airtable.${this.records.size + 1}`;
    this.records.set(id, { ...input, bytes: input.secret.slice(), version: 1, revoked: false });
    return createSecretReference({ id, version: 1, adapter: input.adapter,
      purpose: input.purpose, scopeBinding: input.scopeBinding });
  }

  async rotate(input: {
    reference: SecretReference;
    expectedVersion: AggregateVersion;
    secret: Uint8Array;
  }): Promise<SecretReference> {
    const record = this.records.get(input.reference.id);
    if (!record || record.revoked || record.version !== input.expectedVersion) throw new Error('stale');
    record.version += 1;
    record.bytes = input.secret.slice();
    return createSecretReference({ id: input.reference.id, version: record.version,
      adapter: record.adapter, purpose: record.purpose, scopeBinding: record.scopeBinding });
  }

  async revoke(input: {
    reference: SecretReference;
    expectedVersion: AggregateVersion;
  }): Promise<void> {
    const record = this.records.get(input.reference.id);
    if (!record || record.version !== input.expectedVersion) throw new Error('stale');
    record.revoked = true;
  }

  async withSecret<Value>(input: {
    reference: SecretReference;
    purpose: string;
    scopeBinding: string;
    consume: (secret: Uint8Array) => Value | Promise<Value>;
  }): Promise<Value> {
    const record = this.records.get(input.reference.id);
    if (!record || record.revoked || record.version !== input.reference.version
      || record.purpose !== input.purpose || record.scopeBinding !== input.scopeBinding) {
      throw new Error('secret unavailable');
    }
    return input.consume(record.bytes.slice());
  }
}

const firstGrant = {
  accessToken: 'access-secret-one',
  refreshToken: 'refresh-secret-one',
  accessExpiresAt: '2026-08-17T01:00:00.000Z',
  refreshExpiresAt: '2026-10-16T00:00:00.000Z',
  scopes: ['data.records:read', 'data.records:write'] as const
};

describe('Airtable OAuth grant secret boundary', () => {
  test('stores OAuth state and PKCE verifier only behind a ten-minute attempt reference', async () => {
    const secretStore = new MemorySecretStore();
    const request = await createAirtableAuthorizationRequest({
      clientId: 'client_123',
      redirectUri: 'https://events.example.test/api/integrations/airtable/callback',
      scopes: ['schema.bases:write']
    });
    const stored = await storeAirtableOAuthAttempt({
      secretStore,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      connectionId: 'connection-1',
      request,
      nowMs: 1_000
    });
    expect(JSON.stringify(stored)).not.toContain(request.state);
    expect(JSON.stringify(stored)).not.toContain(request.codeVerifier);
    expect(await withAirtableOAuthAttemptVerifier({
      secretStore,
      stored,
      connectionId: 'connection-1',
      returnedState: request.state,
      nowMs: 2_000,
      use: async (verifier) => verifier
    })).toBe(request.codeVerifier);
    await expect(withAirtableOAuthAttemptVerifier({
      secretStore,
      stored,
      connectionId: 'connection-1',
      returnedState: `${request.state}x`,
      nowMs: 2_000,
      use: async (verifier) => verifier
    })).rejects.toThrow('state_mismatch');
    await expect(withAirtableOAuthAttemptVerifier({
      secretStore,
      stored,
      connectionId: 'connection-1',
      returnedState: request.state,
      nowMs: 601_001,
      use: async (verifier) => verifier
    })).rejects.toThrow('expired');
  });

  test('stores one rotating envelope and leases only the requested token', async () => {
    const secretStore = new MemorySecretStore();
    const stored = await storeAirtableOAuthGrant({
      secretStore,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      connectionId: 'connection-1',
      grant: firstGrant
    });
    expect(JSON.stringify(stored)).not.toContain('access-secret-one');
    expect(JSON.stringify(stored)).not.toContain('refresh-secret-one');
    const lease = createStoredAirtableGrantLease({
      secretStore, stored, connectionId: 'connection-1'
    });
    expect(await lease.withAccessToken(async (token) => token)).toBe('access-secret-one');
    expect(await lease.withRefreshToken(async (token) => token)).toBe('refresh-secret-one');

    const rotated = await rotateAirtableOAuthGrant({
      secretStore,
      stored,
      grant: {
        ...firstGrant,
        accessToken: 'access-secret-two',
        refreshToken: 'refresh-secret-two'
      }
    });
    expect(rotated.secretReference.version).toBe(parseAggregateVersion(2));
    const newLease = createStoredAirtableGrantLease({
      secretStore, stored: rotated, connectionId: 'connection-1'
    });
    expect(await newLease.withAccessToken(async (token) => token)).toBe('access-secret-two');
    await expect(lease.withAccessToken(async (token) => token)).rejects.toThrow('unavailable');
  });

  test('decodes and stores the webhook MAC key only behind its connection-bound purpose', async () => {
    const secretStore = new MemorySecretStore();
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const macSecretBase64 = Buffer.from(bytes).toString('base64');
    const stored = await storeAirtableWebhookMacSecret({
      secretStore,
      adapter: createSecretStoreAdapterRef('secret.memory', 1),
      connectionId: 'connection-1',
      macSecretBase64
    });
    expect(JSON.stringify(stored)).not.toContain(macSecretBase64);
    expect(await withAirtableWebhookMacSecret({
      secretStore,
      stored,
      connectionId: 'connection-1',
      use: async (secret) => [...secret]
    })).toEqual([...bytes]);
    await expect(withAirtableWebhookMacSecret({
      secretStore,
      stored,
      connectionId: 'connection-2',
      use: async () => undefined
    })).rejects.toThrow('secret unavailable');
  });
});
