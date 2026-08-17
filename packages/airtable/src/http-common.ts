import type {
  AirtableFailureCode,
  AirtableProviderFailure,
  AirtableProviderResult
} from './types';

const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;

export type AirtableFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AirtableAccessTokenLease {
  withAccessToken<Result>(use: (accessToken: string) => Promise<Result>): Promise<Result>;
}

export interface AirtableClientSecretLease {
  withClientSecret<Result>(use: (clientSecret: string) => Promise<Result>): Promise<Result>;
}

export type BoundedJsonRead =
  | Readonly<{ kind: 'value'; value: unknown }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'connection_lost' }>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function timeoutLike(error: unknown): boolean {
  try {
    return typeof error === 'object'
      && error !== null
      && 'name' in error
      && (error.name === 'AbortError' || error.name === 'TimeoutError');
  } catch {
    return false;
  }
}

export function validSecretText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 16_384
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export async function readBoundedJson(response: Response): Promise<BoundedJsonRead> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAXIMUM_RESPONSE_BYTES) {
      try { await response.body?.cancel(); } catch { /* already rejected */ }
      return Object.freeze({ kind: 'invalid' });
    }
  }
  if (response.body === null) return Object.freeze({ kind: 'invalid' });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* already rejected */ }
        return Object.freeze({ kind: 'invalid' });
      }
      chunks.push(item.value);
    }
  } catch {
    return Object.freeze({ kind: 'connection_lost' });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return Object.freeze({
      kind: 'value',
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

export function providerRequestId(response: Response): string | undefined {
  const value = response.headers.get('x-airtable-request-id')
    ?? response.headers.get('x-request-id');
  return value && /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 86_400_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), 86_400_000));
}

export function failure(
  code: AirtableFailureCode,
  retry: AirtableProviderFailure['retry'],
  safeMessage: string,
  options: Readonly<{
    retryAfterMs?: number;
    providerRequestId?: string;
  }> = {}
): AirtableProviderResult<never> {
  return Object.freeze({
    kind: 'failure',
    failure: Object.freeze({
      code,
      retry,
      safeMessage,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      ...(options.providerRequestId === undefined ? {} : {
        providerRequestId: options.providerRequestId
      })
    })
  });
}

export function failureForStatus(
  response: Response,
  requestKind: 'read' | 'write' | 'oauth'
): AirtableProviderResult<never> {
  const requestId = providerRequestId(response);
  const options = requestId === undefined ? {} : { providerRequestId: requestId };
  if (response.status === 429) {
    return failure('rate_limited', 'after_delay', 'Airtable is temporarily limiting this connection.', {
      ...options,
      retryAfterMs: retryAfterMs(response) ?? 30_000
    });
  }
  if (response.status === 401) {
    return failure('grant_revoked', 'reconnect', 'The Airtable connection must be authorized again.', options);
  }
  if (response.status === 403) {
    return failure('resource_forbidden', 'reconnect', 'The Airtable connection no longer has the required access.', options);
  }
  if (response.status === 404) {
    return failure('not_found', 'never', 'The requested Airtable resource was not found.', options);
  }
  if (response.status === 409) {
    return failure('temporary_unavailable', 'after_delay', 'Airtable is still finishing a recent connection update.', {
      ...options,
      retryAfterMs: retryAfterMs(response) ?? 1_000
    });
  }
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return failure('validation_failed', 'never', 'Airtable could not accept the requested change.', options);
  }
  if (response.status >= 500 && requestKind === 'write') {
    return failure('acceptance_unknown', 'reconcile_first', 'Airtable may have accepted the change.', options);
  }
  if (response.status >= 500 || response.status === 408 || response.status === 425) {
    return failure('temporary_unavailable', 'after_delay', 'Airtable is temporarily unavailable.', options);
  }
  return failure('response_invalid', 'never', 'Airtable returned an unsupported response.', options);
}

export function success<Value>(value: Value): AirtableProviderResult<Value> {
  return Object.freeze({ kind: 'success', value });
}
