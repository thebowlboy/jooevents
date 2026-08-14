import { createHash, randomBytes } from 'node:crypto';
import type {
  EventId,
  ParticipantIdentityId,
  ParticipantSessionId,
  PersonId,
  WorkspaceId
} from '@jooevents/kernel';
import type { ActorRef } from '@jooevents/kernel';
import type { ISODateTime } from './identity';
import { normalizeEmail } from './identity';

/**
 * Participant email-proof access: the magic-link request ceremony, the link
 * callback, the participant identity mint, and the participant session.
 *
 * The lane is the participant domain (`participant_http`) scoped to one
 * workspace/event; nothing here reads or writes workspace Users, and an equal
 * email never merges records across lanes or into the operator domain. The
 * verification vocabulary is email-proof with pluggable methods: magic link is
 * the launch method; OTP stays a planned method behind
 * `ParticipantVerificationMethod` and is deliberately not implemented.
 *
 * One identity family: the portal is not a parallel registry. Completion
 * resumes the directory's member for the proven address, adopts the
 * intake-attributed pair on a directory miss
 * ({@link IntakeAttributedParticipantSource}), and mints fresh only when the
 * lane's intake state has never attributed the address.
 *
 * Delivery discipline: issuing a link is an outbox-delivered
 * `security_challenge` effect recorded inside the request transaction through
 * the synchronous {@link ParticipantChallengeDelivery} port. The raw token
 * exists only inside that effect (whose envelope is a classified payload
 * downstream); every store sees one-way hashes only.
 */

/** One workspace/event participant lane; every key below carries it. */
export interface ParticipantLane {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

export function participantLaneKey(lane: ParticipantLane): string {
  return `${lane.workspaceId}${lane.eventId}`;
}

/**
 * Email-proof verification methods. `magic_link` is the launch method; `otp`
 * joins this union when the reserved code-entry slot ships. Nothing may bind
 * portal behavior to link-shaped verification beyond this seam.
 */
export type ParticipantVerificationMethod = 'magic_link';

export const PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE = 'security_challenge' as const;

/**
 * Reversible launch values (owner decisions D1/D2, 2026-08-14). They are
 * deployment configuration, not closed product contract: compositions pass
 * them through {@link parseParticipantAccessPolicy} and may change them
 * without a schema or ceremony change.
 */
export const PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS = 15 * 60_000;
export const PARTICIPANT_SESSION_LAUNCH_SLIDING_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const PARTICIPANT_SESSION_LAUNCH_ABSOLUTE_CAP_MS = 90 * 24 * 60 * 60_000;

export interface ParticipantAccessPolicy {
  /** Magic-link validity from issue; single-use and newest-wins regardless. */
  readonly linkTtlMs: number;
  /** Inactivity window; each authenticated request slides it forward. */
  readonly sessionSlidingWindowMs: number;
  /** Hard ceiling from session mint; activity never extends past it. */
  readonly sessionAbsoluteCapMs: number;
}

export const PARTICIPANT_ACCESS_LAUNCH_POLICY: ParticipantAccessPolicy = Object.freeze({
  linkTtlMs: PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS,
  sessionSlidingWindowMs: PARTICIPANT_SESSION_LAUNCH_SLIDING_WINDOW_MS,
  sessionAbsoluteCapMs: PARTICIPANT_SESSION_LAUNCH_ABSOLUTE_CAP_MS
});

export function parseParticipantAccessPolicy(candidate: ParticipantAccessPolicy): ParticipantAccessPolicy {
  if (
    !Number.isInteger(candidate.linkTtlMs) || candidate.linkTtlMs <= 0
    || !Number.isInteger(candidate.sessionSlidingWindowMs) || candidate.sessionSlidingWindowMs <= 0
    || !Number.isInteger(candidate.sessionAbsoluteCapMs) || candidate.sessionAbsoluteCapMs <= 0
    || candidate.sessionSlidingWindowMs > candidate.sessionAbsoluteCapMs
  ) {
    throw new TypeError('participant_access_policy_invalid');
  }
  return Object.freeze({ ...candidate });
}

/** Bounded participant address; refusal here is input validation, never enumeration. */
export interface ParticipantEmail {
  readonly normalizedEmail: string;
  readonly displayEmail: string;
}

export function parseParticipantEmail(candidate: string): ParticipantEmail {
  const trimmed = candidate.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length < 3 || trimmed.length > 320 || /[\s,;<>"\\\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new TypeError('participant_email_invalid');
  }
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1 || !trimmed.slice(at + 1).includes('.')) {
    throw new TypeError('participant_email_invalid');
  }
  return Object.freeze({ normalizedEmail: normalizeEmail(trimmed), displayEmail: trimmed });
}

const LINK_TOKEN_PREFIX = 'plt1_';
const SESSION_TOKEN_PREFIX = 'pst1_';
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

export interface ParticipantTokenSource {
  /** 256-bit random material; injected so tests stay deterministic. */
  randomBytes(size: number): Uint8Array;
}

const defaultTokenSource: ParticipantTokenSource = Object.freeze({
  randomBytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
  }
});

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function mintParticipantLinkToken(source: ParticipantTokenSource = defaultTokenSource): string {
  return `${LINK_TOKEN_PREFIX}${base64Url(source.randomBytes(32))}`;
}

export function mintParticipantSessionToken(source: ParticipantTokenSource = defaultTokenSource): string {
  return `${SESSION_TOKEN_PREFIX}${base64Url(source.randomBytes(32))}`;
}

export function isWellFormedParticipantLinkToken(candidate: string): boolean {
  return candidate.startsWith(LINK_TOKEN_PREFIX) && TOKEN_BODY.test(candidate.slice(LINK_TOKEN_PREFIX.length));
}

export function isWellFormedParticipantSessionToken(candidate: string): boolean {
  return candidate.startsWith(SESSION_TOKEN_PREFIX)
    && TOKEN_BODY.test(candidate.slice(SESSION_TOKEN_PREFIX.length));
}

/** The only representation any store may hold: a one-way hex digest. */
export function hashParticipantToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Challenge (magic link) records and ports
// ---------------------------------------------------------------------------

export type ParticipantChallengeState = 'issued' | 'used' | 'superseded' | 'expired';

export interface ParticipantSignInChallenge {
  readonly challengeId: string;
  readonly lane: ParticipantLane;
  readonly method: ParticipantVerificationMethod;
  readonly normalizedEmail: string;
  readonly displayEmail: string;
  readonly tokenHashSha256: string;
  readonly requestedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly state: ParticipantChallengeState;
}

export type ParticipantChallengeClaim =
  | { readonly kind: 'claimed'; readonly challenge: ParticipantSignInChallenge }
  | { readonly kind: 'expired' }
  | { readonly kind: 'used' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'unknown' };

export interface ParticipantChallengeStore {
  /**
   * Records a hash-only challenge and applies newest-wins: every prior
   * still-issued challenge for the same lane + normalized address becomes
   * `superseded` in the same write. Runs inside the request transaction.
   */
  issue(input: {
    readonly challengeId: string;
    readonly lane: ParticipantLane;
    readonly method: ParticipantVerificationMethod;
    readonly normalizedEmail: string;
    readonly displayEmail: string;
    readonly tokenHashSha256: string;
    readonly requestedAt: ISODateTime;
    readonly expiresAt: ISODateTime;
    readonly receiptId: string;
  }): void;
  /**
   * Atomic single-use consumption by token hash. Exactly one caller can ever
   * observe `claimed` for a token; racing or replayed claims observe the
   * typed terminal state instead.
   */
  claim(input: {
    readonly lane: ParticipantLane;
    readonly tokenHashSha256: string;
    readonly now: ISODateTime;
  }): ParticipantChallengeClaim;
}

/**
 * The outbox-delivered `security_challenge` effect. `linkToken` is the only
 * raw-token field in the whole ceremony; the adapter must place it inside the
 * classified delivery envelope and nowhere else. The synchronous signature is
 * load-bearing: an implementation can only record durable outbox work in the
 * caller's transaction — it cannot await a provider inline.
 */
export interface ParticipantSignInLinkDeliveryEffect {
  readonly kind: 'participant_sign_in_link';
  readonly purpose: typeof PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE;
  readonly lane: ParticipantLane;
  readonly challengeId: string;
  readonly receiptId: string;
  readonly recipientEmail: string;
  readonly linkToken: string;
  readonly requestedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}

export interface ParticipantChallengeDelivery {
  enqueueSignInLink(effect: ParticipantSignInLinkDeliveryEffect): void;
}

// ---------------------------------------------------------------------------
// Identity family
// ---------------------------------------------------------------------------

export type ParticipantIdentityStanding = 'active' | 'revoked';
export type ParticipantIdentityOrigin = 'portal_ceremony' | 'adopted_attribution';

/**
 * One member of the person + participant-identity family — the same family the
 * public-intake attribution ceremony resolves. A pair is immutable once
 * minted; a person carries at most one participant identity; the two roles
 * never collide. Equal email in another lane is a different record, and no
 * path here consults or creates workspace Users.
 */
export interface ParticipantIdentityRecord {
  readonly participantIdentityId: ParticipantIdentityId;
  readonly personId: PersonId;
  readonly lane: ParticipantLane;
  readonly normalizedEmail: string;
  readonly displayEmail: string;
  readonly displayName: string;
  readonly standing: ParticipantIdentityStanding;
  readonly origin: ParticipantIdentityOrigin;
  readonly mintedAt: ISODateTime;
}

export interface ParticipantIdentityDirectory {
  resolveByEmail(input: {
    readonly lane: ParticipantLane;
    readonly normalizedEmail: string;
  }): ParticipantIdentityRecord | undefined;
  get(input: {
    readonly lane: ParticipantLane;
    readonly participantIdentityId: ParticipantIdentityId;
  }): ParticipantIdentityRecord | undefined;
  /** Insert-only; refuses on any collision with an existing family member. */
  mint(input: {
    readonly participantIdentityId: ParticipantIdentityId;
    readonly personId: PersonId;
    readonly lane: ParticipantLane;
    readonly normalizedEmail: string;
    readonly displayEmail: string;
    readonly displayName: string;
    readonly origin: ParticipantIdentityOrigin;
    readonly mintedAt: ISODateTime;
  }): ParticipantIdentityRecord;
}

/**
 * Read-only resolution of the pair the intake ceremony attributed to a proven
 * mailbox address within one lane. The completion ceremony consults this
 * source on every portal-directory miss BEFORE minting anything, so a speaker
 * who applied through intake signs in as the same family member their
 * submission evidence is keyed by — never as a parallel one. Implementations
 * read canonical intake state (participant evidence joined with the classified
 * contact projection — the same association the decision-notification send
 * lane emails); when one address maps to several attributed pairs, they must
 * return one deterministic, time-independent choice.
 */
export interface IntakeAttributedParticipant {
  readonly personId: PersonId;
  readonly participantIdentityId: ParticipantIdentityId;
  readonly displayName?: string;
}

export interface IntakeAttributedParticipantSource {
  resolveByEmail(input: {
    readonly lane: ParticipantLane;
    readonly normalizedEmail: string;
  }): IntakeAttributedParticipant | undefined;
}

/** A source for lanes with no intake surface; every address is unattributed. */
export const NO_INTAKE_ATTRIBUTION: IntakeAttributedParticipantSource = Object.freeze({
  resolveByEmail(): undefined {
    return undefined;
  }
});

/**
 * Joins an intake-attributed person + participant-identity pair into the
 * portal directory so the ceremony resumes that exact pair instead of minting
 * a parallel one. {@link completeParticipantSignInLink} calls this on every
 * directory miss whose address the {@link IntakeAttributedParticipantSource}
 * resolves; it is also callable directly when intake-side work adopts a pair
 * ahead of the first sign-in. The caller supplies the pair exactly as the
 * intake attribution resolved it.
 */
export function adoptIntakeAttributedParticipant(input: {
  readonly identities: ParticipantIdentityDirectory;
  readonly lane: ParticipantLane;
  readonly attribution: {
    readonly personId: PersonId;
    readonly participantIdentityId: ParticipantIdentityId;
  };
  readonly email: ParticipantEmail;
  readonly displayName: string;
  readonly now: ISODateTime;
}): ParticipantIdentityRecord {
  return input.identities.mint({
    participantIdentityId: input.attribution.participantIdentityId,
    personId: input.attribution.personId,
    lane: input.lane,
    normalizedEmail: input.email.normalizedEmail,
    displayEmail: input.email.displayEmail,
    displayName: input.displayName,
    origin: 'adopted_attribution',
    mintedAt: input.now
  });
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export interface ParticipantSessionWindow {
  readonly slidingExpiresAt: ISODateTime;
  readonly absoluteExpiresAt: ISODateTime;
}

function instantMs(value: ISODateTime): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError('participant_instant_invalid');
  return parsed;
}

function toInstant(ms: number): ISODateTime {
  return new Date(ms).toISOString();
}

export function initialParticipantSessionWindow(
  policy: Pick<ParticipantAccessPolicy, 'sessionSlidingWindowMs' | 'sessionAbsoluteCapMs'>,
  createdAt: ISODateTime
): ParticipantSessionWindow {
  const created = instantMs(createdAt);
  const absolute = created + policy.sessionAbsoluteCapMs;
  return Object.freeze({
    slidingExpiresAt: toInstant(Math.min(created + policy.sessionSlidingWindowMs, absolute)),
    absoluteExpiresAt: toInstant(absolute)
  });
}

/** Activity slides the window forward but never past the absolute cap. */
export function slideParticipantSessionWindow(
  policy: Pick<ParticipantAccessPolicy, 'sessionSlidingWindowMs'>,
  session: Pick<ParticipantSessionWindow, 'absoluteExpiresAt'>,
  now: ISODateTime
): ISODateTime {
  return toInstant(Math.min(
    instantMs(now) + policy.sessionSlidingWindowMs,
    instantMs(session.absoluteExpiresAt)
  ));
}

export interface ParticipantSessionRecord {
  readonly sessionId: ParticipantSessionId;
  readonly lane: ParticipantLane;
  readonly participantIdentityId: ParticipantIdentityId;
  readonly personId: PersonId;
  readonly createdAt: ISODateTime;
  readonly lastSeenAt: ISODateTime;
  readonly slidingExpiresAt: ISODateTime;
  readonly absoluteExpiresAt: ISODateTime;
}

export type ParticipantSessionResolution =
  | { readonly kind: 'active'; readonly session: ParticipantSessionRecord }
  | {
      readonly kind: 'expired';
      readonly reason: 'sliding_window_elapsed' | 'absolute_cap_reached' | 'signed_out';
    }
  | { readonly kind: 'unknown' };

export interface ParticipantSessionStore {
  create(input: {
    readonly sessionId: ParticipantSessionId;
    readonly lane: ParticipantLane;
    readonly participantIdentityId: ParticipantIdentityId;
    readonly personId: PersonId;
    readonly tokenHashSha256: string;
    readonly createdAt: ISODateTime;
    readonly window: ParticipantSessionWindow;
  }): void;
  /**
   * Resolves by token hash within the lane and, when active, applies the
   * sliding refresh ({@link slideParticipantSessionWindow}) as part of the
   * same resolution. The session only ever proves identity; it carries no
   * authority of its own.
   */
  resolve(input: {
    readonly lane: ParticipantLane;
    readonly tokenHashSha256: string;
    readonly now: ISODateTime;
  }): ParticipantSessionResolution;
  /** Explicit sign-out; idempotent, and unknown tokens are not distinguishable. */
  revokeByTokenHash(input: {
    readonly lane: ParticipantLane;
    readonly tokenHashSha256: string;
    readonly now: ISODateTime;
  }): void;
}

// ---------------------------------------------------------------------------
// Relationship re-evaluation (the authority design)
// ---------------------------------------------------------------------------

/**
 * The participant's current standing in the domain, computed fresh from
 * canonical state on every authorized request. Removal from a submission or
 * engagement therefore bites on the next request regardless of any live
 * session.
 */
export type ParticipantRelationship =
  | {
      readonly kind: 'related';
      readonly submissionIds: readonly string[];
      readonly engagementIds: readonly string[];
    }
  | { readonly kind: 'none' };

export interface ParticipantRelationshipSource {
  evaluate(input: {
    readonly lane: ParticipantLane;
    readonly personId: PersonId;
  }): ParticipantRelationship;
}

export type ParticipantSubjectRef =
  | { readonly kind: 'submission'; readonly id: string }
  | { readonly kind: 'engagement'; readonly id: string };

export type ParticipantSubjectAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'no_current_relationship' };

/**
 * `any_participant_acts` scoping primitive: a participant may act on exactly
 * the submissions/engagements the current relationship lists them on. This is
 * evaluated against a freshly computed relationship, never a session snapshot.
 */
export function participantSubjectAccess(
  relationship: ParticipantRelationship,
  subject: ParticipantSubjectRef
): ParticipantSubjectAccess {
  if (relationship.kind === 'related') {
    const ids = subject.kind === 'submission' ? relationship.submissionIds : relationship.engagementIds;
    if (ids.includes(subject.id)) return Object.freeze({ allowed: true });
  }
  return Object.freeze({ allowed: false, reason: 'no_current_relationship' });
}

// ---------------------------------------------------------------------------
// Ceremonies
// ---------------------------------------------------------------------------

/**
 * The single non-enumerating acknowledgement (frozen contract shape). The
 * ceremony performs identical durable work for every well-formed address —
 * known, unknown, or revoked — so neither the result nor the work pattern
 * reveals whether an address exists.
 */
export const SIGN_IN_LINK_REQUESTED = Object.freeze({ outcome: 'link_requested' as const });

export interface RequestParticipantSignInLinkResult {
  readonly result: typeof SIGN_IN_LINK_REQUESTED;
  /** Server-side audit handle; never part of the transport result. */
  readonly challengeId: string;
}

export function requestParticipantSignInLink(input: {
  readonly challenges: ParticipantChallengeStore;
  readonly delivery: ParticipantChallengeDelivery;
  readonly ids: { newChallengeId(): string; newReceiptId(): string };
  readonly policy: Pick<ParticipantAccessPolicy, 'linkTtlMs'>;
  readonly lane: ParticipantLane;
  readonly email: string;
  readonly now: ISODateTime;
  readonly method?: ParticipantVerificationMethod;
  readonly tokens?: ParticipantTokenSource;
}): RequestParticipantSignInLinkResult {
  const method: ParticipantVerificationMethod = input.method ?? 'magic_link';
  if (method !== 'magic_link') throw new TypeError('participant_verification_method_unsupported');
  const policy = { linkTtlMs: input.policy.linkTtlMs };
  if (!Number.isInteger(policy.linkTtlMs) || policy.linkTtlMs <= 0) {
    throw new TypeError('participant_access_policy_invalid');
  }
  const email = parseParticipantEmail(input.email);
  const challengeId = input.ids.newChallengeId();
  const receiptId = input.ids.newReceiptId();
  const linkToken = mintParticipantLinkToken(input.tokens ?? defaultTokenSource);
  const requestedAt = toInstant(instantMs(input.now));
  const expiresAt = toInstant(instantMs(input.now) + policy.linkTtlMs);

  input.challenges.issue({
    challengeId,
    lane: input.lane,
    method,
    normalizedEmail: email.normalizedEmail,
    displayEmail: email.displayEmail,
    tokenHashSha256: hashParticipantToken(linkToken),
    requestedAt,
    expiresAt,
    receiptId
  });
  input.delivery.enqueueSignInLink(Object.freeze({
    kind: 'participant_sign_in_link',
    purpose: PARTICIPANT_SIGN_IN_CHALLENGE_PURPOSE,
    lane: input.lane,
    challengeId,
    receiptId,
    recipientEmail: email.displayEmail,
    linkToken,
    requestedAt,
    expiresAt
  }));
  return Object.freeze({ result: SIGN_IN_LINK_REQUESTED, challengeId });
}

export interface IssuedParticipantSession {
  readonly sessionId: ParticipantSessionId;
  /** The cookie bearer value; never persisted, never re-derivable. */
  readonly sessionToken: string;
  readonly window: ParticipantSessionWindow;
}

export type ParticipantLinkCompletion =
  | {
      readonly kind: 'signed_in';
      readonly identity: ParticipantIdentityRecord;
      readonly session: IssuedParticipantSession;
      readonly resumed: boolean;
    }
  | { readonly kind: 'link_expired' }
  | { readonly kind: 'link_used' }
  | {
      readonly kind: 'link_invalid';
      readonly reason: 'malformed_token' | 'unknown_token' | 'superseded' | 'identity_revoked';
    };

/** Projection onto the frozen `signInLinkCallbackResultSchema` vocabulary. */
export function toSignInLinkCallbackOutcome(
  completion: ParticipantLinkCompletion
): 'signed_in' | 'link_expired' | 'link_used' | 'link_invalid' {
  return completion.kind;
}

function displayNameFromEmail(email: ParticipantEmail): string {
  const local = email.displayEmail.slice(0, email.displayEmail.lastIndexOf('@'));
  return local.length > 0 ? local : email.displayEmail;
}

/**
 * Completes a claimed magic link: resolves the family member for the proven
 * address and issues the session. The identity resolution order is binding —
 * (1) resume the portal directory's member, (2) adopt the intake-attributed
 * pair when the directory misses but intake already attributed the address,
 * (3) only then mint a fresh `portal_ceremony` pair. Step 2 is what keeps the
 * portal in the same identity family as the intake ceremony: a directory row
 * is permanent (unique per address, never deleted, pair-immutable), so a
 * fresh mint for an intake-attributed address would shadow the true pair
 * forever.
 */
export function completeParticipantSignInLink(input: {
  readonly challenges: ParticipantChallengeStore;
  readonly identities: ParticipantIdentityDirectory;
  readonly intakeAttribution: IntakeAttributedParticipantSource;
  readonly sessions: ParticipantSessionStore;
  readonly ids: {
    newPersonId(): PersonId;
    newParticipantIdentityId(): ParticipantIdentityId;
    newSessionId(): ParticipantSessionId;
  };
  readonly policy: Pick<ParticipantAccessPolicy, 'sessionSlidingWindowMs' | 'sessionAbsoluteCapMs'>;
  readonly lane: ParticipantLane;
  readonly token: string;
  readonly now: ISODateTime;
  readonly tokens?: ParticipantTokenSource;
}): ParticipantLinkCompletion {
  if (!isWellFormedParticipantLinkToken(input.token)) {
    return Object.freeze({ kind: 'link_invalid', reason: 'malformed_token' });
  }
  const claim = input.challenges.claim({
    lane: input.lane,
    tokenHashSha256: hashParticipantToken(input.token),
    now: input.now
  });
  if (claim.kind === 'expired') return Object.freeze({ kind: 'link_expired' });
  if (claim.kind === 'used') return Object.freeze({ kind: 'link_used' });
  if (claim.kind === 'superseded') return Object.freeze({ kind: 'link_invalid', reason: 'superseded' });
  if (claim.kind === 'unknown') return Object.freeze({ kind: 'link_invalid', reason: 'unknown_token' });

  const email: ParticipantEmail = Object.freeze({
    normalizedEmail: claim.challenge.normalizedEmail,
    displayEmail: claim.challenge.displayEmail
  });
  const existing = input.identities.resolveByEmail({
    lane: input.lane,
    normalizedEmail: email.normalizedEmail
  });
  if (existing !== undefined && existing.standing !== 'active') {
    // The mailbox proof succeeded, but the identity's current standing is
    // re-evaluated at the door: a revoked participant does not get a session.
    return Object.freeze({ kind: 'link_invalid', reason: 'identity_revoked' });
  }
  let identity = existing;
  if (identity === undefined) {
    const attributed = input.intakeAttribution.resolveByEmail({
      lane: input.lane,
      normalizedEmail: email.normalizedEmail
    });
    identity = attributed !== undefined
      ? adoptIntakeAttributedParticipant({
          identities: input.identities,
          lane: input.lane,
          attribution: {
            personId: attributed.personId,
            participantIdentityId: attributed.participantIdentityId
          },
          email,
          displayName: attributed.displayName ?? displayNameFromEmail(email),
          now: input.now
        })
      : input.identities.mint({
          participantIdentityId: input.ids.newParticipantIdentityId(),
          personId: input.ids.newPersonId(),
          lane: input.lane,
          normalizedEmail: email.normalizedEmail,
          displayEmail: email.displayEmail,
          displayName: displayNameFromEmail(email),
          origin: 'portal_ceremony',
          mintedAt: input.now
        });
  }

  const sessionId = input.ids.newSessionId();
  const sessionToken = mintParticipantSessionToken(input.tokens ?? defaultTokenSource);
  const window = initialParticipantSessionWindow(input.policy, input.now);
  input.sessions.create({
    sessionId,
    lane: input.lane,
    participantIdentityId: identity.participantIdentityId,
    personId: identity.personId,
    tokenHashSha256: hashParticipantToken(sessionToken),
    createdAt: input.now,
    window
  });
  return Object.freeze({
    kind: 'signed_in',
    identity,
    session: Object.freeze({ sessionId, sessionToken, window }),
    resumed: existing !== undefined
  });
}

// ---------------------------------------------------------------------------
// Per-request resolution
// ---------------------------------------------------------------------------

export type ParticipantContextResolution =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'expired';
      readonly reason:
        | 'sliding_window_elapsed'
        | 'absolute_cap_reached'
        | 'signed_out'
        | 'identity_revoked'
        | 'identity_missing';
    }
  | {
      readonly kind: 'active';
      readonly identity: ParticipantIdentityRecord;
      readonly session: ParticipantSessionRecord;
    };

/**
 * Resolves the participant context for one request. The session proves
 * identity only: the identity's current record is re-read here, and an absent
 * or revoked identity fails closed as `expired` even under a live session.
 */
export function resolveParticipantContext(input: {
  readonly sessions: ParticipantSessionStore;
  readonly identities: ParticipantIdentityDirectory;
  readonly lane: ParticipantLane;
  readonly sessionToken: string | undefined;
  readonly now: ISODateTime;
}): ParticipantContextResolution {
  if (input.sessionToken === undefined || !isWellFormedParticipantSessionToken(input.sessionToken)) {
    return Object.freeze({ kind: 'anonymous' });
  }
  const resolution = input.sessions.resolve({
    lane: input.lane,
    tokenHashSha256: hashParticipantToken(input.sessionToken),
    now: input.now
  });
  if (resolution.kind === 'unknown') return Object.freeze({ kind: 'anonymous' });
  if (resolution.kind === 'expired') {
    return Object.freeze({ kind: 'expired', reason: resolution.reason });
  }
  const identity = input.identities.get({
    lane: input.lane,
    participantIdentityId: resolution.session.participantIdentityId
  });
  if (identity === undefined) return Object.freeze({ kind: 'expired', reason: 'identity_missing' });
  if (identity.standing !== 'active') {
    return Object.freeze({ kind: 'expired', reason: 'identity_revoked' });
  }
  return Object.freeze({ kind: 'active', identity, session: resolution.session });
}

export type ParticipantAuthorityResolution =
  | {
      readonly kind: 'authorized';
      readonly actor: Extract<ActorRef, { kind: 'participant' }>;
      readonly lane: ParticipantLane;
      readonly identity: ParticipantIdentityRecord;
      readonly relationship: ParticipantRelationship;
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'no_session'
        | 'sliding_window_elapsed'
        | 'absolute_cap_reached'
        | 'signed_out'
        | 'identity_revoked'
        | 'identity_missing';
    };

/**
 * The per-request authority evaluation for `participant_http` operations:
 * session proof, current identity standing, and the freshly computed
 * Person→submission/engagement relationship. Nothing is cached between
 * requests, so removal bites on the very next call.
 */
export function resolveParticipantAuthority(input: {
  readonly sessions: ParticipantSessionStore;
  readonly identities: ParticipantIdentityDirectory;
  readonly relationships: ParticipantRelationshipSource;
  readonly lane: ParticipantLane;
  readonly sessionToken: string | undefined;
  readonly now: ISODateTime;
}): ParticipantAuthorityResolution {
  const context = resolveParticipantContext(input);
  if (context.kind === 'anonymous') return Object.freeze({ kind: 'refused', reason: 'no_session' });
  if (context.kind === 'expired') return Object.freeze({ kind: 'refused', reason: context.reason });
  return Object.freeze({
    kind: 'authorized',
    actor: Object.freeze({
      kind: 'participant' as const,
      participantIdentityId: context.identity.participantIdentityId,
      personId: context.identity.personId
    }),
    lane: input.lane,
    identity: context.identity,
    relationship: input.relationships.evaluate({
      lane: input.lane,
      personId: context.identity.personId
    })
  });
}

export function signOutParticipant(input: {
  readonly sessions: ParticipantSessionStore;
  readonly lane: ParticipantLane;
  readonly sessionToken: string | undefined;
  readonly now: ISODateTime;
}): { readonly signedOut: true } {
  if (input.sessionToken !== undefined && isWellFormedParticipantSessionToken(input.sessionToken)) {
    input.sessions.revokeByTokenHash({
      lane: input.lane,
      tokenHashSha256: hashParticipantToken(input.sessionToken),
      now: input.now
    });
  }
  return Object.freeze({ signedOut: true });
}
