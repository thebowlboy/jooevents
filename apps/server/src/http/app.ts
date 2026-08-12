import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { AccessContext } from '@jooevents/contracts';
import { accessContextSchema } from '@jooevents/contracts';
import { classifyRoutePath } from '@jooevents/contracts/route-namespaces';
import { z } from 'zod';
import type { ReturnTypeOrPromise } from './types';
import type { JooEventsAuth } from '../auth/better-auth';
import { backendRouteNotFoundResponse, protectBackendNotFoundResponse } from './backend-not-found';

export interface AccessContextService {
  ensureAuthPrincipalProvisioned(input: {
    readonly authUserId: string;
    readonly workspaceId: string;
    readonly correlationId: string;
    readonly now: string;
  }): ReturnTypeOrPromise<import('@jooevents/identity-access').AdapterOutcome<AccessContext>>;
}

export function createHttpApp(input: {
  readonly auth: JooEventsAuth;
  readonly accessContext: AccessContextService;
  readonly workspaceId: string;
  readonly baseUrl: string;
}) {
  const app = new OpenAPIHono();

  app.use('*', async (context, next) => {
    const incoming = context.req.header('x-correlation-id');
    const correlationId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
    context.header('x-correlation-id', correlationId);
    context.set('correlationId' as never, correlationId as never);
    await next();
  });

  app.use('*', async (context, next) => {
    await next();
    if (classifyRoutePath(context.req.path).kind === 'backend') {
      context.res = protectBackendNotFoundResponse(
        context.res,
        context.get('correlationId' as never) as string | undefined
      );
    }
  });

  app.use('/api/*', async (context, next) => {
    context.header('cache-control', 'no-store, max-age=0');
    context.header('pragma', 'no-cache');
    await next();
  });

  const startSchema = z.object({ provider: z.literal('google'), returnTo: z.string().max(2048) });
  const safeReturnPath = (candidate: string) => {
    if (!candidate || candidate.includes('\\') || candidate.startsWith('//')) return '/app';
    let decoded: string;
    try { decoded = decodeURIComponent(candidate); } catch { return '/app'; }
    if (decoded !== candidate && /[\\?#]|\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) return '/app';
    return /^\/app(?:\/[^?#\\]*)?(?:\?[^#\\]*)?(?:#[^\\]*)?$/.test(candidate) && !/(?:^|\/)\.\.?(?:\/|$)/.test(candidate) ? candidate : '/app';
  };
  const correlation = (context: { res: Response }) => context.res.headers.get('x-correlation-id') ?? undefined;
  const forwardAuthCookies = (context: { header(name: string, value: string, options?: { append?: boolean }): void }, response: Response) => {
    for (const cookie of response.headers.getSetCookie()) context.header('set-cookie', cookie, { append: true });
  };
  const authRequest = (context: { req: { raw: Request } }, path: string, body: unknown) => {
    const headers = new Headers(context.req.raw.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    return new Request(new URL(path, input.baseUrl), { method: 'POST', headers, body: JSON.stringify(body) });
  };

  app.post('/api/entry/google/start', async (context) => {
    let payload: unknown;
    try { payload = await context.req.json(); } catch { payload = undefined; }
    const parsed = startSchema.safeParse(payload);
    if (!parsed.success) return context.json({ code: 'invalid_request', message: 'The sign-in request was not valid.', retryable: false, correlationId: correlation(context) }, 400);
    const returnTo = safeReturnPath(parsed.data.returnTo);
    const callbackURL = new URL('/auth/complete', input.baseUrl);
    callbackURL.searchParams.set('returnTo', returnTo);
    const errorCallbackURL = new URL('/sign-in', input.baseUrl);
    errorCallbackURL.searchParams.set('notice', 'provider_error');
    const response = await input.auth.handler(authRequest(context, '/api/auth/sign-in/social', {
      provider: 'google',
      callbackURL: callbackURL.toString(),
      errorCallbackURL: errorCallbackURL.toString()
    }));
    forwardAuthCookies(context, response);
    let result: unknown;
    try { result = await response.json(); } catch { result = undefined; }
    const redirect = z.object({ url: z.url() }).safeParse(result);
    if (!response.ok || !redirect.success) {
      return context.json({ code: 'provider_start_failed', message: 'Google sign-in could not start.', retryable: true, correlationId: correlation(context) }, response.status >= 500 ? 502 : 400);
    }
    return context.json({ url: redirect.data.url });
  });

  app.post('/api/entry/sign-out', async (context) => {
    const response = await input.auth.handler(authRequest(context, '/api/auth/sign-out', {}));
    forwardAuthCookies(context, response);
    if (!response.ok) return context.json({ code: 'sign_out_failed', message: 'Sign-out could not finish.', retryable: true, correlationId: correlation(context) }, 502);
    return context.json({ signedOut: true as const });
  });

  app.on(['GET', 'POST'], '/api/auth/*', (context) => input.auth.handler(context.req.raw));

  const accessContextRoute = createRoute({
    method: 'get',
    path: '/api/me/access-context',
    tags: ['Identity and access'],
    summary: 'Resolve the current application access context',
    responses: {
      200: {
        description: 'A closed anonymous, provisioning, review, active, or blocked context.',
        content: { 'application/json': { schema: accessContextSchema } }
      }
    }
  });

  app.openapi(accessContextRoute, async (context) => {
    const session = await input.auth.api.getSession({ headers: context.req.raw.headers });
    if (!session) return context.json(accessContextSchema.parse({ state: 'anonymous' }));

    const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
    const result = await input.accessContext.ensureAuthPrincipalProvisioned({
      authUserId: session.user.id,
      workspaceId: input.workspaceId,
      correlationId,
      now: new Date().toISOString()
    });
    if (result.kind === 'success') return context.json(accessContextSchema.parse(result.data));
    if (result.kind === 'needs_confirmation') {
      return context.json(accessContextSchema.parse({ state: 'blocked', code: 'not_admitted' }));
    }
    if (result.error.retryable) {
      return context.json(accessContextSchema.parse({ state: 'provisioning', retryAfterSeconds: 2, correlationId }));
    }
    return context.json(accessContextSchema.parse({ state: 'blocked', code: 'not_admitted' }));
  });

  app.get('/health', (context) => context.json({ ok: true }));
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'JooEvents API', version: '0.1.0' }
  });
  app.notFound((context) => backendRouteNotFoundResponse(correlation(context)));
  return app;
}
