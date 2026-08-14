import {
  participantContextSchema,
  signInLinkCallbackResultSchema,
  signInLinkRequestResultSchema,
  type PortalEventDto
} from '@jooevents/contracts';
import {
  completeParticipantSignInLink,
  requestParticipantSignInLink,
  resolveParticipantContext,
  signOutParticipant,
  toSignInLinkCallbackOutcome,
  type IntakeAttributedParticipantSource,
  type ParticipantAccessPolicy,
  type ParticipantChallengeDelivery,
  type ParticipantChallengeStore,
  type ParticipantIdentityDirectory,
  type ParticipantLane,
  type ParticipantSessionStore
} from '@jooevents/identity-access';
import type {
  ParticipantIdentityId,
  ParticipantSessionId,
  PersonId
} from '@jooevents/kernel';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

/**
 * Server-owned participant entry ceremony routes. This lane never consults
 * Better Auth: mailbox proof and the lane-separate participant session are
 * the whole story. POST ceremonies are origin-checked exactly like operator
 * effects; the sign-in acknowledgement is non-enumerating by construction.
 */

export const PORTAL_SESSION_COOKIE = '__Host-je_portal_session';

export const PARTICIPANT_ENTRY_PATHS = Object.freeze({
  link: '/api/portal/entry/link',
  complete: '/api/portal/entry/complete',
  signOut: '/api/portal/entry/sign-out',
  context: '/api/me/participant-context'
});

export interface ParticipantEntryStores extends
  ParticipantChallengeStore, ParticipantIdentityDirectory, ParticipantSessionStore {}

export interface ParticipantEntryRuntime {
  /** The single-event launch lane; `undefined` while no current event exists. */
  resolveLane(): ParticipantLane | undefined;
  /** Runs ceremony work inside one BEGIN IMMEDIATE request transaction. */
  transaction<Value>(work: () => Value): Value;
  readonly store: ParticipantEntryStores;
  readonly delivery: ParticipantChallengeDelivery;
  readonly intakeAttribution: IntakeAttributedParticipantSource;
  readonly policy: ParticipantAccessPolicy;
  readonly ids: {
    newChallengeId(): string;
    newReceiptId(): string;
    newPersonId(): PersonId;
    newParticipantIdentityId(): ParticipantIdentityId;
    newSessionId(): ParticipantSessionId;
  };
  readPortalEvent(lane: ParticipantLane): PortalEventDto | undefined;
  now(): string;
  readonly allowedOrigins: readonly string[];
}

/** Extracts the lane-separate portal bearer from the Cookie header, if any. */
export function readPortalSessionToken(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== PORTAL_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${PORTAL_SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearedSessionCookie(): string {
  return `${PORTAL_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

const linkRequestBodySchema = z.strictObject({ email: z.string().min(3).max(320) });
const completeBodySchema = z.strictObject({ token: z.string().min(1).max(512) });

function canonicalOrigins(values: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const parsed = new URL(value);
    if (parsed.origin !== value) throw new TypeError('Participant origin must be a canonical origin.');
    origins.add(value);
  }
  if (origins.size === 0) throw new TypeError('At least one participant origin is required.');
  return origins;
}

export function createParticipantEntryRoutes(runtime: ParticipantEntryRuntime) {
  const allowedOrigins = canonicalOrigins(runtime.allowedOrigins);
  const app = new Hono();

  const correlation = (context: { res: Response }) =>
    context.res.headers.get('x-correlation-id') ?? undefined;
  const invalidRequest = (context: Context) =>
    context.json({
      code: 'invalid_request',
      message: 'The request was not valid.',
      retryable: false,
      correlationId: correlation(context)
    }, 400);
  const forbiddenOrigin = (context: Context) =>
    context.json({
      code: 'forbidden',
      message: 'The request origin is not allowed.',
      retryable: false,
      correlationId: correlation(context)
    }, 403);
  const originAllowed = (request: Request) => {
    const origin = request.headers.get('origin');
    return origin !== null && allowedOrigins.has(origin);
  };

  app.post(PARTICIPANT_ENTRY_PATHS.link, async (context) => {
    if (!originAllowed(context.req.raw)) return forbiddenOrigin(context);
    let payload: unknown;
    try { payload = await context.req.json(); } catch { payload = undefined; }
    const parsed = linkRequestBodySchema.safeParse(payload);
    if (!parsed.success) return invalidRequest(context);
    const lane = runtime.resolveLane();
    if (lane === undefined) {
      // No current event: every address receives the identical frozen
      // acknowledgement and identical (zero) durable work — non-enumeration
      // holds trivially because no participant world exists to enumerate.
      return context.json(signInLinkRequestResultSchema.parse({ outcome: 'link_requested' }));
    }
    try {
      const result = runtime.transaction(() => requestParticipantSignInLink({
        challenges: runtime.store,
        delivery: runtime.delivery,
        ids: {
          newChallengeId: runtime.ids.newChallengeId,
          newReceiptId: runtime.ids.newReceiptId
        },
        policy: runtime.policy,
        lane,
        email: parsed.data.email,
        now: runtime.now()
      }));
      return context.json(signInLinkRequestResultSchema.parse(result.result));
    } catch (error) {
      // Address validation, not enumeration: a malformed address is refused
      // before any durable work regardless of whether it exists.
      if (error instanceof TypeError && error.message.startsWith('participant_email')) {
        return invalidRequest(context);
      }
      throw error;
    }
  });

  app.post(PARTICIPANT_ENTRY_PATHS.complete, async (context) => {
    if (!originAllowed(context.req.raw)) return forbiddenOrigin(context);
    let payload: unknown;
    try { payload = await context.req.json(); } catch { payload = undefined; }
    const parsed = completeBodySchema.safeParse(payload);
    if (!parsed.success) return invalidRequest(context);
    const lane = runtime.resolveLane();
    if (lane === undefined) {
      return context.json(signInLinkCallbackResultSchema.parse({ outcome: 'link_invalid' }));
    }
    const completion = runtime.transaction(() => completeParticipantSignInLink({
      challenges: runtime.store,
      identities: runtime.store,
      intakeAttribution: runtime.intakeAttribution,
      sessions: runtime.store,
      ids: {
        newPersonId: runtime.ids.newPersonId,
        newParticipantIdentityId: runtime.ids.newParticipantIdentityId,
        newSessionId: runtime.ids.newSessionId
      },
      policy: runtime.policy,
      lane,
      token: parsed.data.token,
      now: runtime.now()
    }));
    if (completion.kind === 'signed_in') {
      context.header(
        'set-cookie',
        sessionCookie(
          completion.session.sessionToken,
          Math.floor(runtime.policy.sessionAbsoluteCapMs / 1000)
        ),
        { append: true }
      );
    }
    return context.json(signInLinkCallbackResultSchema.parse({
      outcome: toSignInLinkCallbackOutcome(completion)
    }));
  });

  app.get(PARTICIPANT_ENTRY_PATHS.context, (context) => {
    const lane = runtime.resolveLane();
    if (lane === undefined) {
      return context.json(participantContextSchema.parse({ state: 'anonymous' }));
    }
    const resolution = resolveParticipantContext({
      sessions: runtime.store,
      identities: runtime.store,
      lane,
      sessionToken: readPortalSessionToken(context.req.raw),
      now: runtime.now()
    });
    if (resolution.kind === 'anonymous') {
      return context.json(participantContextSchema.parse({ state: 'anonymous' }));
    }
    if (resolution.kind === 'expired') {
      return context.json(participantContextSchema.parse({ state: 'expired' }));
    }
    const event = runtime.readPortalEvent(lane);
    if (event === undefined) {
      // A live session whose event world cannot be assembled is a
      // composition fault surfaced loudly, never a fabricated context.
      throw new TypeError('participant_context_event_missing');
    }
    return context.json(participantContextSchema.parse({
      state: 'active',
      participant: {
        id: resolution.identity.participantIdentityId,
        displayName: resolution.identity.displayName,
        email: resolution.identity.displayEmail
      },
      event
    }));
  });

  app.post(PARTICIPANT_ENTRY_PATHS.signOut, (context) => {
    if (!originAllowed(context.req.raw)) return forbiddenOrigin(context);
    const lane = runtime.resolveLane();
    if (lane !== undefined) {
      signOutParticipant({
        sessions: runtime.store,
        lane,
        sessionToken: readPortalSessionToken(context.req.raw),
        now: runtime.now()
      });
    }
    context.header('set-cookie', clearedSessionCookie(), { append: true });
    return context.json({ signedOut: true as const });
  });

  return app;
}
