import type {
  SecretReference,
  SecretStore,
  SecretStoreAdapterRef
} from '@jooevents/application';
import type {
  AirtableAccessTokenLease,
  AirtableAuthorizationRequest,
  AirtableClientSecretLease,
  AirtableOAuthGrant,
  AirtableOAuthScope
} from '@jooevents/airtable';
import { canonicalJsonSha256 } from '@jooevents/kernel';

const GRANT_PURPOSE = 'airtable.oauth.grant';
const CLIENT_SECRET_PURPOSE = 'airtable.oauth.client_secret';
const ATTEMPT_PURPOSE = 'airtable.oauth.attempt';
const WEBHOOK_MAC_PURPOSE = 'airtable.webhook.mac';
const encoder = new TextEncoder();

interface GrantEnvelope {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string;
}

interface AttemptEnvelope {
  readonly version: 1;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface StoredAirtableOAuthGrant {
  readonly secretReference: SecretReference;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly scopes: readonly AirtableOAuthScope[];
}

export interface StoredAirtableOAuthAttempt {
  readonly secretReference: SecretReference;
  readonly stateDigestSha256: string;
  readonly scopes: readonly AirtableOAuthScope[];
  readonly expiresAt: string;
}

export interface StoredAirtableWebhookMacSecret {
  readonly secretReference: SecretReference;
}

function decodeBase64Secret(value: string): Uint8Array {
  if (value.length < 16 || value.length > 512
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError('airtable_webhook_mac_secret_invalid');
  }
  try {
    const decoded = globalThis.atob(value);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.byteLength < 16 || bytes.byteLength > 128) {
      throw new TypeError('airtable_webhook_mac_secret_invalid');
    }
    return bytes;
  } catch {
    throw new TypeError('airtable_webhook_mac_secret_invalid');
  }
}

export interface StoredAirtableGrantLease extends AirtableAccessTokenLease {
  withRefreshToken<Result>(use: (refreshToken: string) => Promise<Result>): Promise<Result>;
}

function encodeGrant(grant: AirtableOAuthGrant): Uint8Array {
  return encoder.encode(JSON.stringify({
    version: 1,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken
  } satisfies GrantEnvelope));
}

function decodeGrant(secret: Uint8Array): GrantEnvelope {
  if (secret.byteLength < 2 || secret.byteLength > 32_768) {
    throw new TypeError('airtable_oauth_grant_secret_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret));
  } catch {
    throw new TypeError('airtable_oauth_grant_secret_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null
    || !('version' in parsed) || parsed.version !== 1
    || !('accessToken' in parsed) || typeof parsed.accessToken !== 'string'
    || !('refreshToken' in parsed) || typeof parsed.refreshToken !== 'string'
    || parsed.accessToken.length < 1 || parsed.accessToken.length > 16_384
    || parsed.refreshToken.length < 1 || parsed.refreshToken.length > 16_384) {
    throw new TypeError('airtable_oauth_grant_secret_invalid');
  }
  return Object.freeze({
    version: 1,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken
  });
}

function equalSecretText(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function decodeAttempt(secret: Uint8Array): AttemptEnvelope {
  if (secret.byteLength < 2 || secret.byteLength > 4_096) {
    throw new TypeError('airtable_oauth_attempt_secret_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret));
  } catch {
    throw new TypeError('airtable_oauth_attempt_secret_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null
    || !('version' in parsed) || parsed.version !== 1
    || !('state' in parsed) || typeof parsed.state !== 'string'
    || !('codeVerifier' in parsed) || typeof parsed.codeVerifier !== 'string'
    || parsed.state.length < 32 || parsed.state.length > 256
    || parsed.codeVerifier.length < 43 || parsed.codeVerifier.length > 128) {
    throw new TypeError('airtable_oauth_attempt_secret_invalid');
  }
  return Object.freeze({ version: 1, state: parsed.state, codeVerifier: parsed.codeVerifier });
}

export async function storeAirtableOAuthAttempt(input: Readonly<{
  secretStore: SecretStore;
  adapter: SecretStoreAdapterRef;
  connectionId: string;
  request: AirtableAuthorizationRequest;
  nowMs: number;
}>): Promise<StoredAirtableOAuthAttempt> {
  const bytes = encoder.encode(JSON.stringify({
    version: 1,
    state: input.request.state,
    codeVerifier: input.request.codeVerifier
  } satisfies AttemptEnvelope));
  try {
    const secretReference = await input.secretStore.create({
      adapter: input.adapter,
      purpose: ATTEMPT_PURPOSE,
      scopeBinding: input.connectionId,
      secret: bytes
    });
    return Object.freeze({
      secretReference,
      stateDigestSha256: canonicalJsonSha256({ state: input.request.state }),
      scopes: Object.freeze([...input.request.scopes]),
      expiresAt: new Date(input.nowMs + 10 * 60 * 1_000).toISOString()
    });
  } finally {
    bytes.fill(0);
  }
}

export async function withAirtableOAuthAttemptVerifier<Result>(input: Readonly<{
  secretStore: SecretStore;
  stored: StoredAirtableOAuthAttempt;
  connectionId: string;
  returnedState: string;
  nowMs: number;
  use: (codeVerifier: string, scopes: readonly AirtableOAuthScope[]) => Promise<Result>;
}>): Promise<Result> {
  if (input.nowMs > Date.parse(input.stored.expiresAt)) {
    throw new TypeError('airtable_oauth_attempt_expired');
  }
  return input.secretStore.withSecret({
    reference: input.stored.secretReference,
    purpose: ATTEMPT_PURPOSE,
    scopeBinding: input.connectionId,
    consume: async (secret) => {
      const attempt = decodeAttempt(secret);
      if (!equalSecretText(attempt.state, input.returnedState)
        || canonicalJsonSha256({ state: input.returnedState }) !== input.stored.stateDigestSha256) {
        throw new TypeError('airtable_oauth_state_mismatch');
      }
      return input.use(attempt.codeVerifier, input.stored.scopes);
    }
  });
}

export async function storeAirtableOAuthGrant(input: Readonly<{
  secretStore: SecretStore;
  adapter: SecretStoreAdapterRef;
  connectionId: string;
  grant: AirtableOAuthGrant;
}>): Promise<StoredAirtableOAuthGrant> {
  const bytes = encodeGrant(input.grant);
  try {
    const secretReference = await input.secretStore.create({
      adapter: input.adapter,
      purpose: GRANT_PURPOSE,
      scopeBinding: input.connectionId,
      secret: bytes
    });
    return Object.freeze({
      secretReference,
      accessExpiresAt: input.grant.accessExpiresAt,
      refreshExpiresAt: input.grant.refreshExpiresAt,
      scopes: Object.freeze([...input.grant.scopes])
    });
  } finally {
    bytes.fill(0);
  }
}

export async function rotateAirtableOAuthGrant(input: Readonly<{
  secretStore: SecretStore;
  stored: StoredAirtableOAuthGrant;
  grant: AirtableOAuthGrant;
}>): Promise<StoredAirtableOAuthGrant> {
  const bytes = encodeGrant(input.grant);
  try {
    const secretReference = await input.secretStore.rotate({
      reference: input.stored.secretReference,
      expectedVersion: input.stored.secretReference.version,
      secret: bytes
    });
    return Object.freeze({
      secretReference,
      accessExpiresAt: input.grant.accessExpiresAt,
      refreshExpiresAt: input.grant.refreshExpiresAt,
      scopes: Object.freeze([...input.grant.scopes])
    });
  } finally {
    bytes.fill(0);
  }
}

export function createStoredAirtableGrantLease(input: Readonly<{
  secretStore: SecretStore;
  stored: StoredAirtableOAuthGrant;
  connectionId: string;
}>): StoredAirtableGrantLease {
  const consume = async <Result>(
    kind: 'accessToken' | 'refreshToken',
    use: (token: string) => Promise<Result>
  ): Promise<Result> => input.secretStore.withSecret({
    reference: input.stored.secretReference,
    purpose: GRANT_PURPOSE,
    scopeBinding: input.connectionId,
    consume: async (secret) => use(decodeGrant(secret)[kind])
  });
  const lease: StoredAirtableGrantLease = {
    withAccessToken<Result>(use: (accessToken: string) => Promise<Result>): Promise<Result> {
      return consume('accessToken', use);
    },
    withRefreshToken<Result>(use: (refreshToken: string) => Promise<Result>): Promise<Result> {
      return consume('refreshToken', use);
    }
  };
  return Object.freeze(lease);
}

export function createStoredAirtableClientSecretLease(input: Readonly<{
  secretStore: SecretStore;
  reference: SecretReference;
  scopeBinding: string;
}>): AirtableClientSecretLease {
  const lease: AirtableClientSecretLease = {
    withClientSecret<Result>(use: (clientSecret: string) => Promise<Result>): Promise<Result> {
      return input.secretStore.withSecret({
      reference: input.reference,
      purpose: CLIENT_SECRET_PURPOSE,
      scopeBinding: input.scopeBinding,
      consume: async (secret) => {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(secret);
        if (!value || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) {
          throw new TypeError('airtable_oauth_client_secret_invalid');
        }
        return use(value);
      }
      });
    }
  };
  return Object.freeze(lease);
}

export async function storeAirtableWebhookMacSecret(input: Readonly<{
  secretStore: SecretStore;
  adapter: SecretStoreAdapterRef;
  connectionId: string;
  macSecretBase64: string;
}>): Promise<StoredAirtableWebhookMacSecret> {
  const bytes = decodeBase64Secret(input.macSecretBase64);
  try {
    const secretReference = await input.secretStore.create({
      adapter: input.adapter,
      purpose: WEBHOOK_MAC_PURPOSE,
      scopeBinding: input.connectionId,
      secret: bytes
    });
    return Object.freeze({ secretReference });
  } finally {
    bytes.fill(0);
  }
}

export async function withAirtableWebhookMacSecret<Result>(input: Readonly<{
  secretStore: SecretStore;
  stored: StoredAirtableWebhookMacSecret;
  connectionId: string;
  use: (secret: Uint8Array) => Promise<Result>;
}>): Promise<Result> {
  return input.secretStore.withSecret({
    reference: input.stored.secretReference,
    purpose: WEBHOOK_MAC_PURPOSE,
    scopeBinding: input.connectionId,
    consume: async (secret) => {
      if (secret.byteLength < 16 || secret.byteLength > 128) {
        throw new TypeError('airtable_webhook_mac_secret_invalid');
      }
      return input.use(Uint8Array.from(secret));
    }
  });
}

export const AIRTABLE_SECRET_PURPOSES = Object.freeze({
  grant: GRANT_PURPOSE,
  clientSecret: CLIENT_SECRET_PURPOSE,
  attempt: ATTEMPT_PURPOSE,
  webhookMac: WEBHOOK_MAC_PURPOSE
});
