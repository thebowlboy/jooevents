import { z } from 'zod';
import {
  operationHttpIdempotencyKeySchema,
  operationTransportErrorSchema
} from '@jooevents/contracts';

/* Deliberately message-free: server, provider, and transport text is diagnostic
   evidence, never interface copy. Features map `code` through their reviewed copy
   vocabularies; the raw detail goes to the console with the correlation ID. */
export interface SafeApiError {
  readonly code: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
}

export type ApiResult<T> =
  | { readonly kind: 'success'; readonly data: T; readonly correlationId?: string }
  | { readonly kind: 'error'; readonly error: SafeApiError };

const safeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  correlationId: z.string().min(1).optional()
});

function logDiagnostic(path: string, code: string, detail?: string, correlationId?: string): void {
  console.debug(`[api] ${path} → ${code}${correlationId ? ` (${correlationId})` : ''}${detail ? `: ${detail}` : ''}`);
}

function echoedCorrelation(response: Response): string | undefined {
  const value = response.headers.get('x-correlation-id') ?? undefined;
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function requestCorrelationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function requestJson<T>(input: {
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Required by every registered effect binding; never placed in a request body. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ApiResult<T>> {
  input.signal?.throwIfAborted();

  const parsedIdempotencyKey = input.idempotencyKey === undefined
    ? undefined
    : operationHttpIdempotencyKeySchema.safeParse(input.idempotencyKey);
  if (parsedIdempotencyKey && !parsedIdempotencyKey.success) {
    logDiagnostic(input.path, 'invalid_request');
    return { kind: 'error', error: { code: 'invalid_request', retryable: false } };
  }

  const correlationId = requestCorrelationId();
  const timeout = new AbortController();
  const relayAbort = () => timeout.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = window.setTimeout(() => timeout.abort('timeout'), input.timeoutMs ?? 10_000);

  try {
    const response = await fetch(input.path, {
      method: input.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-correlation-id': correlationId,
        ...(parsedIdempotencyKey?.success
          ? { 'idempotency-key': parsedIdempotencyKey.data }
          : {}),
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: timeout.signal,
      cache: 'no-store'
    });
    const serverCorrelationId = echoedCorrelation(response);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      logDiagnostic(input.path, 'invalid_response', `unexpected content-type ${contentType}`, serverCorrelationId);
      return { kind: 'error', error: { code: 'invalid_response', retryable: true, ...(serverCorrelationId ? { correlationId: serverCorrelationId } : {}) } };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (input.signal?.aborted) throw error;
      logDiagnostic(
        input.path,
        'invalid_response',
        error instanceof Error ? error.message : undefined,
        serverCorrelationId
      );
      return {
        kind: 'error',
        error: {
          code: 'invalid_response',
          retryable: true,
          ...(serverCorrelationId ? { correlationId: serverCorrelationId } : {})
        }
      };
    }
    if (!response.ok) {
      const operationError = operationTransportErrorSchema.safeParse(payload);
      if (operationError.success) {
        const errorCorrelationId = serverCorrelationId ?? operationError.data.correlationId;
        logDiagnostic(input.path, operationError.data.code, undefined, errorCorrelationId);
        return {
          kind: 'error',
          error: {
            code: operationError.data.code,
            retryable: operationError.data.retryable,
            ...(errorCorrelationId ? { correlationId: errorCorrelationId } : {})
          }
        };
      }
      const parsedError = safeErrorSchema.safeParse(payload);
      if (parsedError.success) {
        logDiagnostic(input.path, parsedError.data.code, parsedError.data.message, serverCorrelationId ?? parsedError.data.correlationId);
        return {
          kind: 'error',
          error: {
            code: parsedError.data.code,
            retryable: parsedError.data.retryable,
            ...(serverCorrelationId ?? parsedError.data.correlationId
              ? { correlationId: serverCorrelationId ?? parsedError.data.correlationId }
              : {})
          }
        };
      }
      logDiagnostic(input.path, `http_${response.status}`, undefined, serverCorrelationId);
      return {
        kind: 'error',
        error: { code: `http_${response.status}`, retryable: response.status >= 500, ...(serverCorrelationId ? { correlationId: serverCorrelationId } : {}) }
      };
    }
    const parsed = input.schema.safeParse(payload);
    if (!parsed.success) {
      logDiagnostic(input.path, 'invalid_contract', parsed.error.issues[0]?.message, serverCorrelationId);
      return { kind: 'error', error: { code: 'invalid_contract', retryable: true, ...(serverCorrelationId ? { correlationId: serverCorrelationId } : {}) } };
    }
    return { kind: 'success', data: parsed.data, ...(serverCorrelationId ? { correlationId: serverCorrelationId } : {}) };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const code = timeout.signal.reason === 'timeout' ? 'request_timeout' : 'network_unavailable';
    logDiagnostic(input.path, code, error instanceof Error ? error.message : undefined);
    return { kind: 'error', error: { code, retryable: true } };
  } finally {
    window.clearTimeout(timer);
    input.signal?.removeEventListener('abort', relayAbort);
  }
}
