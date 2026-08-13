import { describe, expect, test } from 'bun:test';
import type {
  RegisteredOperatorHttpEffectBinding,
  RegisteredOperatorHttpReadBinding
} from '@jooevents/application';
import { createBetterAuthOperatorEvidenceVerifier } from './operator-evidence';

const readBinding = {
  method: 'GET',
  surface: 'operator_http'
} as RegisteredOperatorHttpReadBinding;
const effectBinding = {
  method: 'POST',
  surface: 'operator_http'
} as RegisteredOperatorHttpEffectBinding;

function session() {
  return {
    session: { id: 'session-server-owned', userId: 'auth-user-current' },
    user: { id: 'auth-user-current' }
  };
}

describe('Better Auth operator evidence verifier', () => {
  test('emits only an opaque current session handle for a verified read', async () => {
    const seen: Headers[] = [];
    const verifier = createBetterAuthOperatorEvidenceVerifier({
      sessions: {
        getSession(headers) {
          seen.push(headers);
          return session();
        }
      },
      allowedOrigins: ['https://events.example']
    });
    const result = await verifier.verify({
      request: new Request('https://events.example/api/events/current', {
        headers: { cookie: 'opaque=session' }
      }),
      correlationId: crypto.randomUUID(),
      binding: readBinding
    });
    expect(result).toEqual({
      kind: 'verified',
      evidence: {
        kind: 'operator',
        surface: 'operator_http',
        client: { key: 'web.operator' },
        sessionHandle: 'session-server-owned'
      }
    });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('auth-user-current');
    expect(JSON.stringify(result)).not.toContain('opaque=session');
  });

  test('requires an exact trusted Origin before resolving a cookie-authenticated mutation', async () => {
    let sessionLookups = 0;
    const verifier = createBetterAuthOperatorEvidenceVerifier({
      sessions: { getSession: () => { sessionLookups += 1; return session(); } },
      allowedOrigins: ['https://events.example', 'https://preview.example']
    });
    for (const origin of [undefined, 'https://attacker.example', 'https://events.example.evil']) {
      const headers = new Headers({ cookie: 'opaque=session' });
      if (origin) headers.set('origin', origin);
      expect(await verifier.verify({
        request: new Request('https://events.example/api/events', {
          method: 'POST', headers, body: '{}'
        }),
        correlationId: crypto.randomUUID(),
        binding: effectBinding
      })).toEqual({ kind: 'rejected', reason: 'forbidden' });
    }
    expect(sessionLookups).toBe(0);

    expect((await verifier.verify({
      request: new Request('https://events.example/api/events', {
        method: 'POST',
        headers: { cookie: 'opaque=session', origin: 'https://events.example' },
        body: '{}'
      }),
      correlationId: crypto.randomUUID(),
      binding: effectBinding
    })).kind).toBe('verified');
    expect(sessionLookups).toBe(1);
  });

  test('keeps missing sessions distinct and fails closed on malformed or substituted sessions', async () => {
    const request = new Request('https://events.example/api/events/current');
    const binding = readBinding;
    const missing = createBetterAuthOperatorEvidenceVerifier({
      sessions: { getSession: () => null },
      allowedOrigins: ['https://events.example']
    });
    expect(await missing.verify({ request, binding, correlationId: crypto.randomUUID() }))
      .toEqual({ kind: 'rejected', reason: 'unauthenticated' });

    for (const candidate of [
      {},
      { session: { id: '', userId: 'user-a' }, user: { id: 'user-a' } },
      { session: { id: 'session-a', userId: 'user-a' }, user: { id: 'user-b' } }
    ]) {
      const malformed = createBetterAuthOperatorEvidenceVerifier({
        sessions: { getSession: () => candidate },
        allowedOrigins: ['https://events.example']
      });
      await expect(malformed.verify({ request, binding, correlationId: crypto.randomUUID() }))
        .rejects.toThrow('Invalid Better Auth session result');
    }
  });

  test('rejects noncanonical origin configuration at startup', () => {
    expect(() => createBetterAuthOperatorEvidenceVerifier({
      sessions: { getSession: () => null },
      allowedOrigins: ['https://events.example/path']
    })).toThrow('canonical origin');
  });
});
