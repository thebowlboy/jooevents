import type { AirtableOAuthGrant, AirtableOAuthPort } from './port';
import {
  AIRTABLE_OAUTH_SCOPES,
  type AirtableOAuthScope,
  type AirtableProviderResult
} from './types';
import {
  failure,
  failureForStatus,
  isObject,
  readBoundedJson,
  success,
  timeoutLike,
  validSecretText,
  type AirtableClientSecretLease,
  type AirtableFetch
} from './http-common';

const AUTHORIZE_ENDPOINT = 'https://airtable.com/oauth2/v1/authorize';
const TOKEN_ENDPOINT = 'https://airtable.com/oauth2/v1/token';
const TOKEN_REQUEST_BUDGET_MS = 15_000;
const scopeSet = new Set<string>(AIRTABLE_OAUTH_SCOPES);

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function validateRedirectUri(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new TypeError('AirtableOAuthRedirect_invalid');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('AirtableOAuthRedirect_invalid');
  }
}

function normalizedScopes(scopes: readonly AirtableOAuthScope[]): readonly AirtableOAuthScope[] {
  if (scopes.length < 1 || new Set(scopes).size !== scopes.length) {
    throw new TypeError('AirtableOAuthScopes_invalid');
  }
  if (scopes.some((scope) => !scopeSet.has(scope))) throw new TypeError('AirtableOAuthScopes_invalid');
  return Object.freeze([...scopes].sort());
}

export interface AirtableAuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly scopes: readonly AirtableOAuthScope[];
}

export async function createAirtableAuthorizationRequest(input: Readonly<{
  clientId: string;
  redirectUri: string;
  scopes: readonly AirtableOAuthScope[];
}>): Promise<AirtableAuthorizationRequest> {
  if (!/^[A-Za-z0-9._-]{3,256}$/u.test(input.clientId)) throw new TypeError('AirtableOAuthClient_invalid');
  validateRedirectUri(input.redirectUri);
  const scopes = normalizedScopes(input.scopes);
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(64));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64Url(new Uint8Array(digest));
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const request: AirtableAuthorizationRequest = {
    authorizationUrl: url.toString(),
    state,
    codeVerifier,
    codeChallenge,
    scopes
  };
  return Object.freeze(request);
}

function parseGrant(
  value: unknown,
  nowMs: number,
  expectedScopes?: readonly AirtableOAuthScope[]
): AirtableProviderResult<AirtableOAuthGrant> {
  if (!isObject(value)
    || !validSecretText(value.access_token)
    || !validSecretText(value.refresh_token)
    || !Number.isSafeInteger(value.expires_in)
    || !Number.isSafeInteger(value.refresh_expires_in)
    || typeof value.scope !== 'string') {
    return failure('response_invalid', 'never', 'Airtable returned an invalid connection response.');
  }
  const scopes = value.scope.split(' ').filter(Boolean);
  if (scopes.length < 1
    || new Set(scopes).size !== scopes.length
    || scopes.some((scope) => !scopeSet.has(scope))) {
    return failure('response_invalid', 'never', 'Airtable returned an invalid connection response.');
  }
  if (expectedScopes?.some((scope) => !scopes.includes(scope))) {
    return failure('resource_forbidden', 'reconnect', 'The Airtable connection did not grant all required access.');
  }
  const accessSeconds = value.expires_in as number;
  const refreshSeconds = value.refresh_expires_in as number;
  if (accessSeconds < 1 || accessSeconds > 7 * 24 * 60 * 60
    || refreshSeconds < 1 || refreshSeconds > 366 * 24 * 60 * 60) {
    return failure('response_invalid', 'never', 'Airtable returned an invalid connection lifetime.');
  }
  return success(Object.freeze({
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    accessExpiresAt: new Date(nowMs + accessSeconds * 1_000).toISOString(),
    refreshExpiresAt: new Date(nowMs + refreshSeconds * 1_000).toISOString(),
    scopes: Object.freeze(scopes.sort() as AirtableOAuthScope[])
  }));
}

export function createAirtableOAuthClient(input: Readonly<{
  clientId: string;
  clientSecretLease?: AirtableClientSecretLease;
  fetch: AirtableFetch;
  now?: () => number;
}>): AirtableOAuthPort {
  if (!/^[A-Za-z0-9._-]{3,256}$/u.test(input.clientId)) throw new TypeError('AirtableOAuthClient_invalid');
  const request = async (
    body: URLSearchParams,
    expectedScopes?: readonly AirtableOAuthScope[]
  ): Promise<AirtableProviderResult<AirtableOAuthGrant>> => {
    let dispatched = false;
    try {
      const run = async (secret?: string): Promise<Response> => {
        const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (secret === undefined) body.set('client_id', input.clientId);
        else {
          if (!validSecretText(secret)) throw new TypeError('AirtableOAuthSecret_unavailable');
          headers.Authorization = `Basic ${btoa(`${input.clientId}:${secret}`)}`;
        }
        dispatched = true;
        return input.fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          headers,
          body,
          signal: AbortSignal.timeout(TOKEN_REQUEST_BUDGET_MS)
        });
      };
      const response = input.clientSecretLease === undefined
        ? await run()
        : await input.clientSecretLease.withClientSecret(run);
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return failureForStatus(response, 'oauth');
      }
      const read = await readBoundedJson(response);
      if (read.kind !== 'value') {
        return failure('response_invalid', 'never', 'Airtable returned an invalid connection response.');
      }
      return parseGrant(read.value, (input.now ?? Date.now)(), expectedScopes);
    } catch (error) {
      if (!dispatched) return failure('temporary_unavailable', 'after_delay', 'The Airtable connection secret is unavailable.');
      return failure(
        'temporary_unavailable',
        'after_delay',
        timeoutLike(error) ? 'The Airtable connection timed out.' : 'Airtable is temporarily unavailable.'
      );
    }
  };
  const port: AirtableOAuthPort = {
    async exchangeAuthorizationCode(value) {
      validateRedirectUri(value.redirectUri);
      if (!value.code || value.code.length > 8_192 || value.codeVerifier.length < 43 || value.codeVerifier.length > 128) {
        return failure('validation_failed', 'never', 'The Airtable authorization response is invalid.');
      }
      const body = new URLSearchParams({
        code: value.code,
        redirect_uri: value.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: value.codeVerifier
      });
      return request(body, normalizedScopes(value.expectedScopes));
    },
    async refreshGrant(value) {
      if (!validSecretText(value.refreshToken)) {
        return failure('grant_revoked', 'reconnect', 'The Airtable connection must be authorized again.');
      }
      return request(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: value.refreshToken
      }));
    }
  };
  return Object.freeze(port);
}
