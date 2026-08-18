import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { AccessContext } from '@jooevents/contracts';
import { accessContextSchema } from '@jooevents/contracts';
import { correlationIdSchema } from '@jooevents/contracts';
import { classifyRoutePath } from '@jooevents/contracts/route-namespaces';
import { z } from 'zod';
import type { ReturnTypeOrPromise } from './types';
import type { JooEventsAuth } from '../auth/better-auth';
import { backendRouteNotFoundResponse, protectBackendNotFoundResponse } from './backend-not-found';
import { createOperatorOperationsHttpAdapter, type OperatorOperationsHttpRuntime } from './operator-operations';
import {
  createParticipantEntryRoutes,
  type ParticipantEntryRuntime
} from './participant-entry';
import {
  createParticipantOperationsHttpAdapter,
  type ParticipantOperationsHttpRuntime
} from './participant-operations';
import {
  RequestSerializationAbortedError,
  RequestSerializationUnavailableError,
  type HttpRequestSerializationBoundary
} from './request-serialization';
import {
  createAirtableWebhookHttpAdapter,
  type AirtableWebhookIngressRuntime
} from './airtable-webhook';
import {
  createAirtableIntegrationHttpAdapter,
  type AirtableIntegrationHttpRuntime
} from './airtable-integration';
import {
  createAcceleventsExportDownloadHttpAdapter,
  type AcceleventsExportDownloadRuntime
} from './accelevents-export';

export interface AccessContextService {
  ensureAuthPrincipalProvisioned(input: {
    readonly authUserId: string;
    readonly workspaceId: string;
    readonly correlationId: string;
    readonly now: string;
  }): ReturnTypeOrPromise<import('@jooevents/identity-access').AdapterOutcome<AccessContext>>;
}

export interface RuntimeHealthSource {
  read(): Readonly<Record<string, unknown>> & { readonly ok: boolean };
}

export function createHttpApp(input: {
  readonly auth: JooEventsAuth;
  readonly accessContext: AccessContextService;
  readonly workspaceId: string;
  readonly baseUrl: string;
  readonly operatorSignInMethods?: readonly ('magic_link' | 'google')[];
  readonly reviewOrganizerEntry?: {
    readonly email: string;
    readonly resolveIssuedUrl: () => string | undefined;
  };
  readonly operatorOperations?: OperatorOperationsHttpRuntime;
  readonly participantEntry?: ParticipantEntryRuntime;
  readonly participantOperations?: ParticipantOperationsHttpRuntime;
  readonly airtableWebhookIngress?: AirtableWebhookIngressRuntime;
  readonly airtableIntegration?: AirtableIntegrationHttpRuntime;
  readonly acceleventsExportDownload?: AcceleventsExportDownloadRuntime;
  readonly requestSerialization?: HttpRequestSerializationBoundary;
  readonly health?: RuntimeHealthSource;
}) {
  const app = new OpenAPIHono();
  const operatorSignInMethods = input.operatorSignInMethods ?? ['magic_link', 'google'];
  const googleSignInEnabled = operatorSignInMethods.includes('google');

  app.use('*', async (context, next) => {
    const incoming = correlationIdSchema.safeParse(context.req.header('x-correlation-id'));
    const correlationId = incoming.success ? incoming.data : crypto.randomUUID();
    context.header('x-correlation-id', correlationId);
    context.set('correlationId' as never, correlationId as never);
    await next();
  });

  const requestSerialization = input.requestSerialization;
  if (requestSerialization) {
    app.use('*', async (context, next) => {
      try {
        await requestSerialization.run(next, context.req.raw.signal);
      } catch (error) {
        if (error instanceof RequestSerializationUnavailableError) {
          context.res = Response.json(
            {
              code: 'service_busy',
              message: 'JooEvents is busy. Try again shortly.',
              retryable: true,
              correlationId: context.get('correlationId' as never) as string
            },
            {
              status: 503,
              headers: {
                'cache-control': 'no-store, max-age=0',
                'retry-after': '1',
                'x-correlation-id': context.get('correlationId' as never) as string
              }
            }
          );
          return;
        }
        if (!(error instanceof RequestSerializationAbortedError)) throw error;
        context.res = new Response(null, {
          status: 499,
          headers: {
            'cache-control': 'no-store, max-age=0',
            'x-correlation-id': context.get('correlationId' as never) as string
          }
        });
      }
    });
  }

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
    if (!googleSignInEnabled) {
      return context.json({
        code: 'provider_unavailable',
        message: 'Google sign-in is not available for this installation.',
        retryable: false,
        correlationId: correlation(context)
      }, 404);
    }
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

  const signInLinkSchema = z.strictObject({ email: z.string().min(3).max(320) });
  const SIGN_IN_LINK_CALLBACK_PATH = '/auth/complete?returnTo=/app';
  const SIGN_IN_LINK_ERROR_CALLBACK_PATH = '/sign-in?notice=link_invalid';
  const SHORT_LINK_TOKEN_MAX_LENGTH = 512;
  app.post('/api/entry/sign-in-link', async (context) => {
    let payload: unknown;
    try { payload = await context.req.json(); } catch { payload = undefined; }
    const parsed = signInLinkSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.email.includes('@')) {
      // Shape validation, not enumeration: a malformed address is refused
      // before any durable work regardless of whether it exists.
      return context.json({ code: 'invalid_request', message: 'The sign-in request was not valid.', retryable: false, correlationId: correlation(context) }, 400);
    }
    const email = parsed.data.email.trim();
    // Whether a link is actually issued is decided server-privately behind the
    // delivery seam; this surface acknowledges every well-formed address with
    // the same body. The initial display name for a reservation-completed
    // first sign-in is the address's local part — a person can rename it, and
    // an empty name must never reach workspace authority reads. Callbacks stay
    // relative: the emailed link is the short `/a/<token>` route below, which
    // rebuilds the same relative pair.
    const response = await input.auth.handler(authRequest(context, '/api/auth/sign-in/magic-link', {
      email,
      name: email.slice(0, email.indexOf('@')) || email,
      callbackURL: SIGN_IN_LINK_CALLBACK_PATH,
      errorCallbackURL: SIGN_IN_LINK_ERROR_CALLBACK_PATH
    }));
    if (response.status === 429) {
      return context.json({ code: 'rate_limited', message: 'Too many sign-in link requests. Try again shortly.', retryable: true, correlationId: correlation(context) }, 429);
    }
    if (!response.ok) {
      return context.json({ code: 'link_request_failed', message: 'The sign-in link request could not be handled.', retryable: true, correlationId: correlation(context) }, response.status >= 500 ? 502 : 400);
    }
    return context.json({ outcome: 'link_requested' as const });
  });

  if (input.reviewOrganizerEntry) {
    app.post('/api/entry/review-organizer', async (context) => {
      try {
        // This route exists only in explicit organizer review mode. Invoke the
        // same Better Auth endpoint internally so repeated evaluator entry does
        // not consume the public magic-link request bucket. The ordinary
        // `/api/entry/sign-in-link` path still crosses Better Auth's HTTP rate
        // limiter unchanged, while this call retains the endpoint's origin/CSRF
        // middleware and issues the same one-use, hashed-at-rest credential.
        await input.auth.api.signInMagicLink({
          headers: context.req.raw.headers,
          body: {
            email: input.reviewOrganizerEntry!.email,
            name: 'Evaluation organizer',
            callbackURL: SIGN_IN_LINK_CALLBACK_PATH,
            errorCallbackURL: SIGN_IN_LINK_ERROR_CALLBACK_PATH
          }
        });
      } catch {
        return context.json({
          code: 'review_entry_failed',
          message: 'Organizer review entry could not start.',
          retryable: true,
          correlationId: correlation(context)
        }, 502);
      }
      const url = input.reviewOrganizerEntry!.resolveIssuedUrl();
      if (!url) {
        return context.json({
          code: 'review_entry_failed',
          message: 'Organizer review entry could not start.',
          retryable: true,
          correlationId: correlation(context)
        }, 502);
      }
      let token: string | null = null;
      try {
        const issued = new URL(url);
        if (issued.origin === new URL(input.baseUrl).origin
            && issued.pathname === '/api/auth/magic-link/verify') {
          token = issued.searchParams.get('token');
        }
      } catch {
        token = null;
      }
      if (!token) {
        return context.json({
          code: 'review_entry_failed',
          message: 'Organizer review entry could not start.',
          retryable: true,
          correlationId: correlation(context)
        }, 502);
      }
      try {
        // Consume the exact one-use, hash-at-rest credential through Better
        // Auth as part of this evaluation-only endpoint. Calling its internal
        // verifier preserves credential consumption, principal/session
        // creation, and secure cookie policy without crossing the ordinary
        // public verify endpoint's anti-abuse bucket.
        const verified = await input.auth.api.magicLinkVerify({
          headers: context.req.raw.headers,
          query: { token },
          asResponse: true
        });
        if (!verified.ok) throw new TypeError('review_entry_verify_failed');
        forwardAuthCookies(context, verified);
      } catch {
        return context.json({
          code: 'review_entry_failed',
          message: 'Organizer review entry could not start.',
          retryable: true,
          correlationId: correlation(context)
        }, 502);
      }
      return context.json({ url: SIGN_IN_LINK_CALLBACK_PATH });
    });
  }

  app.post('/api/entry/sign-out', async (context) => {
    const response = await input.auth.handler(authRequest(context, '/api/auth/sign-out', {}));
    forwardAuthCookies(context, response);
    if (!response.ok) return context.json({ code: 'sign_out_failed', message: 'Sign-out could not finish.', retryable: true, correlationId: correlation(context) }, 502);
    return context.json({ signedOut: true as const });
  });

  // Short sign-in link expansion. Emailed links are `${origin}/a/<token>`
  // (workspace) and `${origin}/p/<token>` (participant portal); each route
  // only re-shapes the path into the verifying surface's URL. The verifier is
  // the single arbiter of token validity, so the redirect is byte-uniform for
  // well-formed and garbage tokens alike: same status, same headers, same
  // Location construction. Tokens are 22 characters; the cap only bounds
  // hostile paths without changing the response shape.
  app.get('/a/:token', (context) => {
    const token = context.req.param('token').slice(0, SHORT_LINK_TOKEN_MAX_LENGTH);
    context.header('cache-control', 'no-store, max-age=0');
    return context.redirect(
      `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`
        + `&callbackURL=${encodeURIComponent(SIGN_IN_LINK_CALLBACK_PATH)}`
        + `&errorCallbackURL=${encodeURIComponent(SIGN_IN_LINK_ERROR_CALLBACK_PATH)}`,
      302
    );
  });
  app.get('/p/:token', (context) => {
    const token = context.req.param('token').slice(0, SHORT_LINK_TOKEN_MAX_LENGTH);
    context.header('cache-control', 'no-store, max-age=0');
    return context.redirect(`/portal/auth/complete?token=${encodeURIComponent(token)}`, 302);
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
    if (!session) return context.json(accessContextSchema.parse({
      state: 'anonymous',
      ...(input.operatorSignInMethods ? { signInMethods: operatorSignInMethods } : {}),
      ...(input.reviewOrganizerEntry ? { reviewOrganizerEntry: true } : {})
    }));

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

  if (input.operatorOperations) {
    app.route('/', createOperatorOperationsHttpAdapter(input.operatorOperations));
  }
  if (input.acceleventsExportDownload) {
    app.route('/', createAcceleventsExportDownloadHttpAdapter(input.acceleventsExportDownload));
  }

  // The participant lane: server-owned entry ceremony routes first, then the
  // registered participant_http operation bindings. Both stay disjoint from
  // operator routes and never consult Better Auth.
  if (input.participantEntry) {
    app.route('/', createParticipantEntryRoutes(input.participantEntry));
  }
  if (input.participantOperations) {
    app.route('/', createParticipantOperationsHttpAdapter(input.participantOperations));
  }
  if (input.airtableWebhookIngress) {
    app.route('/', createAirtableWebhookHttpAdapter(input.airtableWebhookIngress));
  }
  if (input.airtableIntegration) {
    app.route('/', createAirtableIntegrationHttpAdapter(input.airtableIntegration));
  }

  app.get('/health', (context) => context.json(input.health?.read() ?? { ok: true }));
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'JooEvents API', version: '0.1.0' }
  });
  app.notFound((context) => backendRouteNotFoundResponse(correlation(context)));
  return app;
}
