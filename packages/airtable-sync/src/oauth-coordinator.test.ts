import { describe, expect, test } from 'bun:test';
import {
  createSecretReference,
  createSecretStoreAdapterRef,
  type SecretReference,
  type SecretStore,
  type SecretStoreAdapterRef
} from '@jooevents/application';
import {
  parseAirtableUserId,
  type AirtableOAuthGrant,
  type AirtableOAuthPort
} from '@jooevents/airtable';
import type { AggregateVersion } from '@jooevents/kernel';
import {
  AirtableOAuthCompletionError,
  createAirtableOAuthCoordinator,
  type AirtableOAuthAttemptClaim,
  type AirtableOAuthCoordinatorRepository
} from './oauth-coordinator';
import type { StoredAirtableOAuthAttempt, StoredAirtableOAuthGrant } from './grant-secrets';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, {
    bytes: Uint8Array;
    adapter: SecretStoreAdapterRef;
    purpose: string;
    scopeBinding: string;
    revoked: boolean;
  }>();
  async create(input: Parameters<SecretStore['create']>[0]): Promise<SecretReference> {
    const id = `secret.airtable.oauth.${this.values.size + 1}`;
    this.values.set(id, { ...input, bytes: input.secret.slice(), revoked: false });
    return createSecretReference({ id, version: 1, adapter: input.adapter,
      purpose: input.purpose, scopeBinding: input.scopeBinding });
  }
  async rotate(): Promise<SecretReference> { throw new Error('not used'); }
  async revoke(input: { reference: SecretReference; expectedVersion: AggregateVersion }): Promise<void> {
    const value = this.values.get(input.reference.id);
    if (!value || input.expectedVersion !== 1) throw new Error('missing');
    value.revoked = true;
  }
  async withSecret<Value>(input: Parameters<SecretStore['withSecret']>[0]): Promise<Value> {
    const value = this.values.get(input.reference.id);
    if (!value || value.revoked || value.purpose !== input.purpose
      || value.scopeBinding !== input.scopeBinding) throw new Error('secret unavailable');
    return input.consume(value.bytes.slice()) as Promise<Value>;
  }
}

class MemoryRepository implements AirtableOAuthCoordinatorRepository {
  claim?: AirtableOAuthAttemptClaim;
  completed?: StoredAirtableOAuthGrant;
  failed = 0;
  async createOAuthConnectionAttempt(input: {
    connectionId: string; workspaceId: string; publicCallbackRef: string; attemptId: string;
    stored: StoredAirtableOAuthAttempt; redirectUri: string; nowMs: number;
  }): Promise<void> {
    this.claim = Object.freeze({
      id: input.attemptId,
      connectionId: input.connectionId,
      stored: input.stored,
      redirectUri: input.redirectUri,
      workerId: 'oauth-worker',
      leaseVersion: 1
    });
  }
  async claimOAuthAttempt(input: { stateDigestSha256: string }): Promise<AirtableOAuthAttemptClaim | undefined> {
    if (this.claim?.stored.stateDigestSha256 !== input.stateDigestSha256) return undefined;
    return this.claim;
  }
  async completeOAuthConnection(input: { stored: StoredAirtableOAuthGrant }): Promise<boolean> {
    this.completed = input.stored;
    return true;
  }
  async finishOAuthAttempt(): Promise<boolean> { this.failed += 1; return true; }
}

const grant: AirtableOAuthGrant = Object.freeze({
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  accessExpiresAt: '2026-08-17T02:00:00.000Z',
  refreshExpiresAt: '2026-10-17T02:00:00.000Z',
  scopes: Object.freeze(['data.records:read', 'schema.bases:read'] as const)
});

function oauth(returned: AirtableOAuthGrant = grant): AirtableOAuthPort {
  return Object.freeze({
    async exchangeAuthorizationCode() { return { kind: 'success' as const, value: returned }; },
    async refreshGrant() { return { kind: 'success' as const, value: returned }; }
  });
}

describe('Airtable OAuth coordinator', () => {
  test('stores a fenced attempt, exchanges it once, and persists only a grant reference', async () => {
    const secrets = new MemorySecrets();
    const repository = new MemoryRepository();
    const coordinator = createAirtableOAuthCoordinator({
      clientId: 'client_jooevents', oauth: oauth(), repository, secretStore: secrets,
      secretAdapter: createSecretStoreAdapterRef('secret.memory', 1),
      workerId: 'oauth-worker', now: () => 1_000,
      async inspectGrant(received) {
        expect(received.accessToken).toBe('access-token-secret');
        return { kind: 'success', value: Object.freeze({
          userId: parseAirtableUserId('usrAirtable1'),
          email: 'owner@example.test',
          scopes: received.scopes
        }) };
      }
    });
    const started = await coordinator.start({
      connectionId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      publicCallbackRef: 'callback-reference-with-enough-entropy-1234567890',
      attemptId: '33333333-3333-4333-8333-333333333333',
      redirectUri: 'https://events.example.test/api/integrations/airtable/oauth/callback',
      scopes: ['data.records:read', 'schema.bases:read']
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    const completed = await coordinator.complete({ code: 'authorization-code', state: state! });
    expect(completed.identity.email).toBe('owner@example.test');
    expect(repository.completed).toBeDefined();
    expect(JSON.stringify(repository.completed)).not.toContain('access-token-secret');
    expect(JSON.stringify(repository.completed)).not.toContain('refresh-token-secret');
  });

  test('rejects unknown state before provider exchange', async () => {
    let exchanges = 0;
    const baseOauth = oauth();
    const repository = new MemoryRepository();
    const coordinator = createAirtableOAuthCoordinator({
      clientId: 'client_jooevents',
      oauth: { ...baseOauth, async exchangeAuthorizationCode(value) {
        exchanges += 1; return baseOauth.exchangeAuthorizationCode(value);
      } },
      repository, secretStore: new MemorySecrets(),
      secretAdapter: createSecretStoreAdapterRef('secret.memory', 1),
      workerId: 'oauth-worker', now: () => 1_000,
      async inspectGrant() { throw new Error('not reached'); }
    });
    await expect(coordinator.complete({ code: 'code', state: 'x'.repeat(43) }))
      .rejects.toEqual(new AirtableOAuthCompletionError('attempt_unavailable', 'restart'));
    expect(exchanges).toBe(0);
  });

  test('revokes the exchanged grant when the atomic database completion loses its fence', async () => {
    const secrets = new MemorySecrets();
    const repository = new MemoryRepository();
    repository.completeOAuthConnection = async (input) => {
      repository.completed = input.stored;
      return false;
    };
    const coordinator = createAirtableOAuthCoordinator({
      clientId: 'client_jooevents', oauth: oauth(), repository, secretStore: secrets,
      secretAdapter: createSecretStoreAdapterRef('secret.memory', 1),
      workerId: 'oauth-worker', now: () => 1_000,
      async inspectGrant(received) { return { kind: 'success', value: Object.freeze({
        userId: parseAirtableUserId('usrAirtable1'), scopes: received.scopes
      }) }; }
    });
    const started = await coordinator.start({
      connectionId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      publicCallbackRef: 'callback-reference-with-enough-entropy-1234567890',
      attemptId: '33333333-3333-4333-8333-333333333333',
      redirectUri: 'https://events.example.test/api/integrations/airtable/oauth/callback',
      scopes: ['data.records:read', 'schema.bases:read']
    });
    await expect(coordinator.complete({
      code: 'authorization-code',
      state: new URL(started.authorizationUrl).searchParams.get('state')!
    })).rejects.toThrow('completion_raced');
    expect(secrets.values.get(repository.completed!.secretReference.id)?.revoked).toBe(true);
    expect(repository.failed).toBe(1);
  });
});
