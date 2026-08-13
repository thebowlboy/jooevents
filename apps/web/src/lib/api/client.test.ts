import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { requestJson } from './client';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

function installBrowser(response: Response, inspect?: (request: RequestInfo | URL, init?: RequestInit) => void): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout, clearTimeout }
  });
  globalThis.fetch = Object.assign(async (request: RequestInfo | URL, init?: RequestInit) => {
    inspect?.(request, init);
    return response;
  }, {
    preconnect: (_url: string | URL) => undefined
  });
}

describe('typed API client transport errors', () => {
  test('does not start a request for an already-aborted caller signal', async () => {
    let calls = 0;
    installBrowser(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }),
      () => {
        calls += 1;
      }
    );
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    controller.abort(reason);

    expect(requestJson({
      path: '/api/test/read',
      signal: controller.signal,
      schema: z.object({ accepted: z.literal(true) })
    })).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  test('classifies malformed JSON as an invalid response', async () => {
    const correlationId = crypto.randomUUID();
    installBrowser(new Response('{', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId
      }
    }));

    expect(await requestJson({
      path: '/api/test/read',
      schema: z.object({ accepted: z.literal(true) })
    })).toEqual({
      kind: 'error',
      error: { code: 'invalid_response', retryable: true, correlationId }
    });
  });

  test('preserves a canonical effect failure that must not be retried blindly', async () => {
    const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7001';
    installBrowser(new Response(JSON.stringify({
      kind: 'transport_error', code: 'internal_error', retryable: false, correlationId
    }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId }
    }));
    expect(await requestJson({ path: '/api/test/effect', method: 'POST', body: {}, schema: z.never() }))
      .toEqual({ kind: 'error', error: { code: 'internal_error', retryable: false, correlationId } });
  });

  test('puts a validated idempotency credential only in the effect header', async () => {
    const key = 'browser-effect_01';
    let observedHeaders = new Headers();
    let observedBody = '';
    installBrowser(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }),
      (_request, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
      }
    );

    expect(await requestJson({
      path: '/api/test/effect',
      method: 'POST',
      body: { value: 'alpha' },
      idempotencyKey: key,
      schema: z.object({ accepted: z.literal(true) })
    })).toEqual({ kind: 'success', data: { accepted: true } });
    expect(observedHeaders.get('idempotency-key')).toBe(key);
    expect(observedBody).toBe('{"value":"alpha"}');
    expect(observedBody).not.toContain(key);
  });

  test('refuses an invalid idempotency credential before fetch without echoing it', async () => {
    let calls = 0;
    installBrowser(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }),
      () => {
        calls += 1;
      }
    );

    expect(await requestJson({
      path: '/api/test/effect',
      method: 'POST',
      body: { value: 'alpha' },
      idempotencyKey: 'not a valid key',
      schema: z.object({ accepted: z.literal(true) })
    })).toEqual({
      kind: 'error',
      error: { code: 'invalid_request', retryable: false }
    });
    expect(calls).toBe(0);
  });

  test('preserves canonical authentication and authorization refusals', async () => {
    for (const [status, code] of [[401, 'unauthenticated'], [403, 'forbidden']] as const) {
      const correlationId = crypto.randomUUID();
      installBrowser(new Response(JSON.stringify({
        kind: 'transport_error', code, retryable: false, correlationId
      }), { status, headers: { 'content-type': 'application/json' } }));
      expect(await requestJson({ path: '/api/test/read', schema: z.never() }))
        .toEqual({ kind: 'error', error: { code, retryable: false, correlationId } });
    }
  });
});
