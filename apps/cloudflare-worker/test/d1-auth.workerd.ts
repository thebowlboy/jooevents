import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createD1Auth } from '../src/d1-auth';

interface CountRow { readonly count: number }

describe('Better Auth over D1 in workerd', () => {
  test('starts canonical Google authorization and persists database-backed state', async () => {
    const auth = createD1Auth(env.DB, {
      baseUrl: 'https://auth-test.jooevents.invalid',
      trustedOrigins: [],
      authSecrets: [{ version: 1, value: 'd1-auth-test-secret-value-at-least-thirty-two-characters' }],
      googleClientId: 'workerd-google-client-id',
      googleClientSecret: 'workerd-google-client-secret',
      admissionMode: 'workspace_domain',
      googleHostedDomain: 'example.invalid'
    });
    const response = await auth.handler(new Request(
      'https://auth-test.jooevents.invalid/api/auth/sign-in/social',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: 'https://auth-test.jooevents.invalid'
        },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: 'https://auth-test.jooevents.invalid/auth/complete',
          errorCallbackURL: 'https://auth-test.jooevents.invalid/sign-in?notice=provider_error'
        })
      }
    ));
    const payload = await response.json<{ readonly url: string }>();
    const authorization = new URL(payload.url);
    const stateRows = await env.DB.prepare(
      'SELECT count(*) AS count FROM auth_verifications'
    ).first<CountRow>();

    expect(response.status).toBe(200);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      'https://auth-test.jooevents.invalid/api/auth/callback/google'
    );
    expect(authorization.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile'
    ]);
    expect(authorization.searchParams.get('hd')).toBe('example.invalid');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state')).toBeTruthy();
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    expect(stateRows?.count).toBeGreaterThan(0);
  });
});
