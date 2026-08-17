import type { JooEventsAuth } from '@jooevents/auth';
import { accessContextSchema, correlationIdSchema, type AccessContext } from '@jooevents/contracts';
import type { AdapterOutcome } from '@jooevents/identity-access';
import { Hono } from 'hono';
import { z } from 'zod';

export interface CloudflareAccessContextService {
  ensureAuthPrincipalProvisioned(input: {
    readonly authUserId: string;
    readonly workspaceId: string;
    readonly correlationId: string;
    readonly now: string;
  }): Promise<AdapterOutcome<AccessContext>>;
}

function safeReturnPath(candidate: string): string {
  if (!candidate || candidate.includes('\\') || candidate.startsWith('//')) return '/app';
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return '/app';
  }
  if (decoded !== candidate && /[\\?#]|\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) return '/app';
  return /^\/app(?:\/[^?#\\]*)?(?:\?[^#\\]*)?(?:#[^\\]*)?$/.test(candidate)
    && !/(?:^|\/)\.\.?(?:\/|$)/.test(candidate)
    ? candidate
    : '/app';
}

function forwardSetCookies(
  append: (value: string) => void,
  response: Response
): void {
  for (const cookie of response.headers.getSetCookie()) append(cookie);
}

/** Worker-native auth and access-entry routes; feature traffic remains separate. */
export function createCloudflareAuthHttpApp(input: {
  readonly auth: JooEventsAuth;
  readonly accessContext: CloudflareAccessContextService;
  readonly workspaceId: string;
  readonly baseUrl: string;
}) {
  const app = new Hono<{ Variables: { correlationId: string } }>();

  app.use('*', async (context, next) => {
    const incoming = correlationIdSchema.safeParse(context.req.header('x-correlation-id'));
    const correlationId = incoming.success ? incoming.data : crypto.randomUUID();
    context.set('correlationId', correlationId);
    context.header('x-correlation-id', correlationId);
    context.header('cache-control', 'no-store, max-age=0');
    context.header('pragma', 'no-cache');
    context.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    context.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    context.header('referrer-policy', 'no-referrer');
    context.header('x-content-type-options', 'nosniff');
    context.header('x-frame-options', 'DENY');
    await next();
  });

  const authRequest = (request: Request, path: string, body: unknown): Request => {
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    return new Request(new URL(path, input.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  };
  const errorBody = (
    context: { get(key: 'correlationId'): string },
    code: string,
    message: string,
    retryable: boolean
  ) => ({ code, message, retryable, correlationId: context.get('correlationId') });

  app.post('/api/entry/google/start', async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      payload = undefined;
    }
    const parsed = z.strictObject({
      provider: z.literal('google'),
      returnTo: z.string().max(2048)
    }).safeParse(payload);
    if (!parsed.success) {
      return context.json(errorBody(
        context,
        'invalid_request',
        'The sign-in request was not valid.',
        false
      ), 400);
    }
    const callbackURL = new URL('/auth/complete', input.baseUrl);
    callbackURL.searchParams.set('returnTo', safeReturnPath(parsed.data.returnTo));
    const errorCallbackURL = new URL('/sign-in', input.baseUrl);
    errorCallbackURL.searchParams.set('notice', 'provider_error');
    const response = await input.auth.handler(authRequest(
      context.req.raw,
      '/api/auth/sign-in/social',
      {
        provider: 'google',
        callbackURL: callbackURL.toString(),
        errorCallbackURL: errorCallbackURL.toString()
      }
    ));
    forwardSetCookies(
      (cookie) => context.header('set-cookie', cookie, { append: true }),
      response
    );
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      result = undefined;
    }
    const redirect = z.object({ url: z.url() }).safeParse(result);
    if (!response.ok || !redirect.success) {
      return context.json(errorBody(
        context,
        'provider_start_failed',
        'Google sign-in could not start.',
        true
      ), response.status >= 500 ? 502 : 400);
    }
    return context.json({ url: redirect.data.url });
  });

  app.post('/api/entry/sign-out', async (context) => {
    const response = await input.auth.handler(authRequest(
      context.req.raw,
      '/api/auth/sign-out',
      {}
    ));
    forwardSetCookies(
      (cookie) => context.header('set-cookie', cookie, { append: true }),
      response
    );
    if (!response.ok) {
      return context.json(errorBody(
        context,
        'sign_out_failed',
        'Sign-out could not finish.',
        true
      ), 502);
    }
    return context.json({ signedOut: true as const });
  });

  app.on(['GET', 'POST'], '/api/auth/*', (context) => input.auth.handler(context.req.raw));

  app.get('/api/me/access-context', async (context) => {
    const session = await input.auth.api.getSession({ headers: context.req.raw.headers });
    if (!session) return context.json(accessContextSchema.parse({ state: 'anonymous' }));
    const correlationId = context.get('correlationId');
    const result = await input.accessContext.ensureAuthPrincipalProvisioned({
      authUserId: session.user.id,
      workspaceId: input.workspaceId,
      correlationId,
      now: new Date().toISOString()
    });
    if (result.kind === 'success') {
      return context.json(accessContextSchema.parse(result.data));
    }
    if (result.kind === 'needs_confirmation') {
      return context.json(accessContextSchema.parse({ state: 'blocked', code: 'not_admitted' }));
    }
    if (result.error.retryable) {
      return context.json(accessContextSchema.parse({
        state: 'provisioning',
        retryAfterSeconds: 2,
        correlationId
      }));
    }
    return context.json(accessContextSchema.parse({ state: 'blocked', code: 'not_admitted' }));
  });

  app.notFound((context) => context.json(errorBody(
    context,
    'route_not_found',
    'The requested application route does not exist.',
    false
  ), 404));

  return app;
}
