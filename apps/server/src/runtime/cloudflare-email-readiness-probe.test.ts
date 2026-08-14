import { describe, expect, test } from 'bun:test';
import type { CloudflareApiTokenLease, CloudflareFetch } from '@jooevents/cloudflare-email';
import { createCloudflareTokenVerificationReadinessProbe } from './cloudflare-email-readiness-probe';

const SECRET_TOKEN = 'secret-token-abc123';

function lease(value: string | Error = SECRET_TOKEN): CloudflareApiTokenLease {
  return {
    async withApiToken(use) {
      if (value instanceof Error) throw value;
      return use(value);
    }
  };
}

function checkInput(requestedValidUntil = 1_755_100_000_000) {
  return Object.freeze({
    contractVersion: 1 as const,
    transport: 'bun_rest' as const,
    request: { requestedValidUntil } as Parameters<
      ReturnType<typeof createCloudflareTokenVerificationReadinessProbe>['check']
    >[0]['request']
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('cloudflare token-verification readiness probe', () => {
  test('passes ready with the requested validity for an active token', async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchStub: CloudflareFetch = async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization')
      });
      return jsonResponse(200, { success: true, result: { status: 'active' } });
    };
    const probe = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(),
      fetch: fetchStub
    });

    const observation = await probe.check(checkInput(1_755_100_300_000));
    expect(observation).toEqual({
      kind: 'passed',
      readiness: 'ready',
      validUntil: 1_755_100_300_000
    });
    expect(requests).toEqual([{
      url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
      authorization: `Bearer ${SECRET_TOKEN}`
    }]);
  });

  test('maps authentication and authorization failures typed', async () => {
    for (const [status, reason] of [
      [401, 'authentication_failed'],
      [403, 'authorization_failed'],
      [404, 'transport_unavailable']
    ] as const) {
      const probe = createCloudflareTokenVerificationReadinessProbe({
        tokenLease: lease(),
        fetch: async () => jsonResponse(status, { success: false })
      });
      expect(await probe.check(checkInput())).toEqual({ kind: 'known_failed', reason });
    }
  });

  test('treats an inactive token as an authentication failure', async () => {
    const probe = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(),
      fetch: async () => jsonResponse(200, { success: true, result: { status: 'expired' } })
    });
    expect(await probe.check(checkInput())).toEqual({
      kind: 'known_failed',
      reason: 'authentication_failed'
    });
  });

  test('reports acceptance_unknown for 5xx, timeouts, and malformed bodies', async () => {
    const fiveHundred = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(),
      fetch: async () => jsonResponse(500, {})
    });
    expect(await fiveHundred.check(checkInput())).toEqual({
      kind: 'acceptance_unknown',
      reason: 'connection_lost'
    });

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const timedOut = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(),
      fetch: async () => { throw abort; }
    });
    expect(await timedOut.check(checkInput())).toEqual({
      kind: 'acceptance_unknown',
      reason: 'timeout'
    });

    const malformed = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(),
      fetch: async () => new Response('not json', { status: 200 })
    });
    expect(await malformed.check(checkInput())).toEqual({
      kind: 'acceptance_unknown',
      reason: 'malformed_response'
    });
  });

  test('surfaces a secret-resolver failure as a typed known failure, never a throw', async () => {
    let fetchCalls = 0;
    const probe = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(new Error('secret store unavailable')),
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse(200, { success: true, result: { status: 'active' } });
      }
    });
    const observation = await probe.check(checkInput());
    expect(observation).toEqual({ kind: 'known_failed', reason: 'transport_unavailable' });
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(observation)).not.toContain(SECRET_TOKEN);
  });

  test('refuses the workers transport it cannot verify', async () => {
    const probe = createCloudflareTokenVerificationReadinessProbe({
      tokenLease: lease(),
      fetch: async () => jsonResponse(200, { success: true, result: { status: 'active' } })
    });
    expect(await probe.check({
      ...checkInput(),
      transport: 'workers_binding'
    })).toEqual({ kind: 'known_failed', reason: 'transport_unavailable' });
  });
});
