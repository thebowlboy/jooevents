import { describe, expect, test } from 'bun:test';
import {
  parseEventId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parseWorkspaceId
} from '@jooevents/kernel';
import type {
  IntakeAttributedParticipant,
  IntakeAttributedParticipantSource,
  ParticipantChallengeClaim,
  ParticipantChallengeDelivery,
  ParticipantChallengeStore,
  ParticipantIdentityDirectory,
  ParticipantIdentityRecord,
  ParticipantLane,
  ParticipantRelationship,
  ParticipantRelationshipSource,
  ParticipantSessionRecord,
  ParticipantSessionResolution,
  ParticipantSessionStore,
  ParticipantSignInChallenge,
  ParticipantSignInLinkDeliveryEffect,
  ParticipantTokenSource
} from './participant-access';
import {
  NO_INTAKE_ATTRIBUTION,
  PARTICIPANT_ACCESS_LAUNCH_POLICY,
  PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS,
  PARTICIPANT_SESSION_LAUNCH_ABSOLUTE_CAP_MS,
  PARTICIPANT_SESSION_LAUNCH_SLIDING_WINDOW_MS,
  adoptIntakeAttributedParticipant,
  completeParticipantSignInLink,
  hashParticipantToken,
  initialParticipantSessionWindow,
  isWellFormedParticipantLinkToken,
  isWellFormedParticipantSessionToken,
  mintParticipantLinkToken,
  mintParticipantSessionToken,
  parseParticipantAccessPolicy,
  parseParticipantEmail,
  participantSubjectAccess,
  requestParticipantSignInLink,
  resolveParticipantAuthority,
  resolveParticipantContext,
  signOutParticipant,
  slideParticipantSessionWindow,
  toSignInLinkCallbackOutcome,
  SIGN_IN_LINK_REQUESTED
} from './participant-access';

const laneA: ParticipantLane = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb101')
});
const laneB: ParticipantLane = Object.freeze({
  workspaceId: laneA.workspaceId,
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb102')
});

const T0 = '2026-08-14T10:00:00.000Z';

function at(offsetMs: number, from: string = T0): string {
  return new Date(Date.parse(from) + offsetMs).toISOString();
}

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function deterministicTokens(seed: number): ParticipantTokenSource {
  let counter = seed;
  return {
    randomBytes(size: number): Uint8Array {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 7 + index * 13) % 256);
    }
  };
}

class FakeChallengeStore implements ParticipantChallengeStore {
  readonly rows = new Map<string, {
    challenge: ParticipantSignInChallenge;
    state: 'issued' | 'used' | 'superseded' | 'expired';
    receiptId: string;
  }>();
  readonly issueCalls: unknown[] = [];

  issue(input: Parameters<ParticipantChallengeStore['issue']>[0]): void {
    this.issueCalls.push(Object.freeze({ ...input }));
    for (const row of this.rows.values()) {
      if (
        row.state === 'issued'
        && row.challenge.lane.workspaceId === input.lane.workspaceId
        && row.challenge.lane.eventId === input.lane.eventId
        && row.challenge.normalizedEmail === input.normalizedEmail
      ) {
        row.state = 'superseded';
      }
    }
    this.rows.set(input.tokenHashSha256, {
      challenge: Object.freeze({
        challengeId: input.challengeId,
        lane: input.lane,
        method: input.method,
        normalizedEmail: input.normalizedEmail,
        displayEmail: input.displayEmail,
        tokenHashSha256: input.tokenHashSha256,
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt,
        state: 'issued'
      }),
      state: 'issued',
      receiptId: input.receiptId
    });
  }

  claim(input: Parameters<ParticipantChallengeStore['claim']>[0]): ParticipantChallengeClaim {
    const row = this.rows.get(input.tokenHashSha256);
    if (
      !row
      || row.challenge.lane.workspaceId !== input.lane.workspaceId
      || row.challenge.lane.eventId !== input.lane.eventId
    ) {
      return { kind: 'unknown' };
    }
    if (row.state === 'used') return { kind: 'used' };
    if (row.state === 'superseded') return { kind: 'superseded' };
    if (row.state === 'expired' || Date.parse(row.challenge.expiresAt) <= Date.parse(input.now)) {
      row.state = 'expired';
      return { kind: 'expired' };
    }
    row.state = 'used';
    return { kind: 'claimed', challenge: row.challenge };
  }
}

class FakeDelivery implements ParticipantChallengeDelivery {
  readonly effects: ParticipantSignInLinkDeliveryEffect[] = [];
  enqueueSignInLink(effect: ParticipantSignInLinkDeliveryEffect): void {
    this.effects.push(effect);
  }
}

class FakeDirectory implements ParticipantIdentityDirectory {
  readonly rows: ParticipantIdentityRecord[] = [];

  resolveByEmail(input: {
    readonly lane: ParticipantLane;
    readonly normalizedEmail: string;
  }): ParticipantIdentityRecord | undefined {
    return this.rows.find((row) =>
      row.lane.workspaceId === input.lane.workspaceId
      && row.lane.eventId === input.lane.eventId
      && row.normalizedEmail === input.normalizedEmail);
  }

  get(input: {
    readonly lane: ParticipantLane;
    readonly participantIdentityId: ParticipantIdentityRecord['participantIdentityId'];
  }): ParticipantIdentityRecord | undefined {
    return this.rows.find((row) =>
      row.lane.workspaceId === input.lane.workspaceId
      && row.lane.eventId === input.lane.eventId
      && row.participantIdentityId === input.participantIdentityId);
  }

  mint(input: Parameters<ParticipantIdentityDirectory['mint']>[0]): ParticipantIdentityRecord {
    for (const row of this.rows) {
      if (
        row.participantIdentityId === input.participantIdentityId
        || row.personId === input.personId
        || (row.personId as string) === (input.participantIdentityId as string)
        || (row.participantIdentityId as string) === (input.personId as string)
        || (row.lane.workspaceId === input.lane.workspaceId
          && row.lane.eventId === input.lane.eventId
          && row.normalizedEmail === input.normalizedEmail)
      ) {
        throw new TypeError('participant_identity_collision');
      }
    }
    if ((input.personId as string) === (input.participantIdentityId as string)) {
      throw new TypeError('participant_identity_collision');
    }
    const record: ParticipantIdentityRecord = Object.freeze({
      participantIdentityId: input.participantIdentityId,
      personId: input.personId,
      lane: input.lane,
      normalizedEmail: input.normalizedEmail,
      displayEmail: input.displayEmail,
      displayName: input.displayName,
      standing: 'active',
      origin: input.origin,
      mintedAt: input.mintedAt
    });
    this.rows.push(record);
    return record;
  }

  revoke(participantIdentityId: ParticipantIdentityRecord['participantIdentityId']): void {
    const index = this.rows.findIndex((row) => row.participantIdentityId === participantIdentityId);
    if (index < 0) throw new TypeError('missing');
    this.rows[index] = Object.freeze({ ...this.rows[index]!, standing: 'revoked' });
  }
}

class FakeSessionStore implements ParticipantSessionStore {
  readonly rows = new Map<string, {
    session: ParticipantSessionRecord;
    revokedAt: string | undefined;
  }>();

  create(input: Parameters<ParticipantSessionStore['create']>[0]): void {
    if (this.rows.has(input.tokenHashSha256)) throw new TypeError('session_token_collision');
    this.rows.set(input.tokenHashSha256, {
      session: Object.freeze({
        sessionId: input.sessionId,
        lane: input.lane,
        participantIdentityId: input.participantIdentityId,
        personId: input.personId,
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        slidingExpiresAt: input.window.slidingExpiresAt,
        absoluteExpiresAt: input.window.absoluteExpiresAt
      }),
      revokedAt: undefined
    });
  }

  resolve(input: Parameters<ParticipantSessionStore['resolve']>[0]): ParticipantSessionResolution {
    const row = this.rows.get(input.tokenHashSha256);
    if (
      !row
      || row.session.lane.workspaceId !== input.lane.workspaceId
      || row.session.lane.eventId !== input.lane.eventId
    ) {
      return { kind: 'unknown' };
    }
    if (row.revokedAt !== undefined) return { kind: 'expired', reason: 'signed_out' };
    const now = Date.parse(input.now);
    if (now >= Date.parse(row.session.absoluteExpiresAt)) {
      return { kind: 'expired', reason: 'absolute_cap_reached' };
    }
    if (now >= Date.parse(row.session.slidingExpiresAt)) {
      return { kind: 'expired', reason: 'sliding_window_elapsed' };
    }
    row.session = Object.freeze({
      ...row.session,
      lastSeenAt: input.now,
      slidingExpiresAt: slideParticipantSessionWindow(
        { sessionSlidingWindowMs: PARTICIPANT_SESSION_LAUNCH_SLIDING_WINDOW_MS },
        row.session,
        input.now
      )
    });
    return { kind: 'active', session: row.session };
  }

  revokeByTokenHash(input: Parameters<ParticipantSessionStore['revokeByTokenHash']>[0]): void {
    const row = this.rows.get(input.tokenHashSha256);
    if (
      row
      && row.session.lane.workspaceId === input.lane.workspaceId
      && row.session.lane.eventId === input.lane.eventId
      && row.revokedAt === undefined
    ) {
      row.revokedAt = input.now;
    }
  }
}

class FakeRelationships implements ParticipantRelationshipSource {
  current: ParticipantRelationship = { kind: 'none' };
  evaluate(): ParticipantRelationship {
    return this.current;
  }
}

class FakeIntakeAttribution implements IntakeAttributedParticipantSource {
  readonly rows = new Map<string, IntakeAttributedParticipant>();
  readonly lookups: { lane: ParticipantLane; normalizedEmail: string }[] = [];

  attribute(lane: ParticipantLane, normalizedEmail: string, pair: IntakeAttributedParticipant): void {
    this.rows.set(`${lane.workspaceId}${lane.eventId}${normalizedEmail}`, pair);
  }

  resolveByEmail(input: {
    readonly lane: ParticipantLane;
    readonly normalizedEmail: string;
  }): IntakeAttributedParticipant | undefined {
    this.lookups.push({ lane: input.lane, normalizedEmail: input.normalizedEmail });
    return this.rows.get(`${input.lane.workspaceId}${input.lane.eventId}${input.normalizedEmail}`);
  }
}

function harness() {
  const challenges = new FakeChallengeStore();
  const delivery = new FakeDelivery();
  const identities = new FakeDirectory();
  const sessions = new FakeSessionStore();
  const relationships = new FakeRelationships();
  const intakeAttribution = new FakeIntakeAttribution();
  let challengeSeq = 0x100;
  let receiptSeq = 0x200;
  let personSeq = 0x300;
  let identitySeq = 0x400;
  let sessionSeq = 0x500;
  const ids = {
    newChallengeId: () => uuid((challengeSeq += 1)),
    newReceiptId: () => uuid((receiptSeq += 1)),
    newPersonId: () => parsePersonId(uuid((personSeq += 1))),
    newParticipantIdentityId: () => parseParticipantIdentityId(uuid((identitySeq += 1))),
    newSessionId: () => parseParticipantSessionId(uuid((sessionSeq += 1)))
  };
  return { challenges, delivery, identities, sessions, relationships, intakeAttribution, ids };
}

function requestLink(h: ReturnType<typeof harness>, email: string, options?: {
  readonly now?: string;
  readonly lane?: ParticipantLane;
  readonly tokens?: ParticipantTokenSource;
}) {
  return requestParticipantSignInLink({
    challenges: h.challenges,
    delivery: h.delivery,
    ids: h.ids,
    policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
    lane: options?.lane ?? laneA,
    email,
    now: options?.now ?? T0,
    ...(options?.tokens ? { tokens: options.tokens } : {})
  });
}

function completeLink(h: ReturnType<typeof harness>, token: string, options?: {
  readonly now?: string;
  readonly lane?: ParticipantLane;
}) {
  return completeParticipantSignInLink({
    challenges: h.challenges,
    identities: h.identities,
    intakeAttribution: h.intakeAttribution,
    sessions: h.sessions,
    ids: h.ids,
    policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
    lane: options?.lane ?? laneA,
    token,
    now: options?.now ?? at(60_000)
  });
}

describe('participant access policy', () => {
  test('launch values are the decided reversible numbers', () => {
    expect(PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS).toBe(15 * 60_000);
    expect(PARTICIPANT_SESSION_LAUNCH_SLIDING_WINDOW_MS).toBe(30 * 24 * 60 * 60_000);
    expect(PARTICIPANT_SESSION_LAUNCH_ABSOLUTE_CAP_MS).toBe(90 * 24 * 60 * 60_000);
    expect(parseParticipantAccessPolicy(PARTICIPANT_ACCESS_LAUNCH_POLICY))
      .toEqual(PARTICIPANT_ACCESS_LAUNCH_POLICY);
  });

  test('a sliding window wider than the cap is refused', () => {
    expect(() => parseParticipantAccessPolicy({
      linkTtlMs: 1000,
      sessionSlidingWindowMs: 10,
      sessionAbsoluteCapMs: 5
    })).toThrow('participant_access_policy_invalid');
  });
});

describe('participant email parsing', () => {
  test('normalizes case and keeps the display form', () => {
    const email = parseParticipantEmail(' Ada.Lovelace@Example.ORG ');
    expect(email.normalizedEmail).toBe('ada.lovelace@example.org');
    expect(email.displayEmail).toBe('Ada.Lovelace@Example.ORG');
  });

  test('rejects malformed and header-injecting addresses', () => {
    for (const bad of ['', 'nope', '@x.y', 'a@', 'a@nodot', 'a b@example.org',
      'a@example.org\nBcc: x@y.z', 'a,b@example.org', 'a@exa mple.org']) {
      expect(() => parseParticipantEmail(bad)).toThrow('participant_email_invalid');
    }
  });
});

describe('participant tokens', () => {
  test('link and session tokens are distinct families and hash to hex digests', () => {
    const link = mintParticipantLinkToken(deterministicTokens(1));
    const session = mintParticipantSessionToken(deterministicTokens(2));
    expect(isWellFormedParticipantLinkToken(link)).toBe(true);
    expect(isWellFormedParticipantSessionToken(session)).toBe(true);
    expect(isWellFormedParticipantLinkToken(session)).toBe(false);
    expect(isWellFormedParticipantSessionToken(link)).toBe(false);
    expect(hashParticipantToken(link)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashParticipantToken(link)).not.toBe(hashParticipantToken(session));
  });
});

describe('magic-link request ceremony', () => {
  test('issues a hash-only challenge and an outbox security_challenge effect', () => {
    const h = harness();
    const { result, challengeId } = requestLink(h, 'speaker@example.org');
    expect(result).toEqual(SIGN_IN_LINK_REQUESTED);

    expect(h.challenges.issueCalls).toHaveLength(1);
    const issued = h.challenges.issueCalls[0] as Record<string, unknown>;
    expect(issued.tokenHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(issued)).not.toContain('plt1_');

    expect(h.delivery.effects).toHaveLength(1);
    const effect = h.delivery.effects[0]!;
    expect(effect.purpose).toBe('security_challenge');
    expect(effect.challengeId).toBe(challengeId);
    expect(isWellFormedParticipantLinkToken(effect.linkToken)).toBe(true);
    expect(hashParticipantToken(effect.linkToken)).toBe(issued.tokenHashSha256 as string);
    expect(Date.parse(effect.expiresAt) - Date.parse(effect.requestedAt))
      .toBe(PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS);
  });

  test('non-enumeration: known and unknown addresses produce identical work and result', () => {
    const h = harness();
    // Make one address "known" by pre-minting its identity.
    h.identities.mint({
      participantIdentityId: h.ids.newParticipantIdentityId(),
      personId: h.ids.newPersonId(),
      lane: laneA,
      normalizedEmail: 'known@example.org',
      displayEmail: 'known@example.org',
      displayName: 'known',
      origin: 'portal_ceremony',
      mintedAt: T0
    });
    const known = requestLink(h, 'known@example.org');
    const unknown = requestLink(h, 'unknown@example.org');
    expect(known.result).toEqual(unknown.result);
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
    expect(h.challenges.issueCalls).toHaveLength(2);
    expect(h.delivery.effects).toHaveLength(2);
    const shapes = h.challenges.issueCalls.map((call) => Object.keys(call as object).sort());
    expect(shapes[0]).toEqual(shapes[1]!);
  });

  test('newest-wins: a new request supersedes the prior unused link for address+lane', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org', { tokens: deterministicTokens(10) });
    const first = h.delivery.effects[0]!.linkToken;
    requestLink(h, 'Speaker@Example.org', { now: at(30_000), tokens: deterministicTokens(20) });
    const second = h.delivery.effects[1]!.linkToken;

    const staleOutcome = completeLink(h, first);
    expect(staleOutcome).toEqual({ kind: 'link_invalid', reason: 'superseded' });
    expect(toSignInLinkCallbackOutcome(staleOutcome)).toBe('link_invalid');

    const fresh = completeLink(h, second);
    expect(fresh.kind).toBe('signed_in');
  });

  test('a different address does not revoke an unrelated live link', () => {
    const h = harness();
    requestLink(h, 'one@example.org', { tokens: deterministicTokens(30) });
    requestLink(h, 'two@example.org', { tokens: deterministicTokens(40) });
    expect(completeLink(h, h.delivery.effects[0]!.linkToken).kind).toBe('signed_in');
    expect(completeLink(h, h.delivery.effects[1]!.linkToken).kind).toBe('signed_in');
  });

  test('the OTP seam refuses methods that are not built', () => {
    const h = harness();
    expect(() => requestParticipantSignInLink({
      challenges: h.challenges,
      delivery: h.delivery,
      ids: h.ids,
      policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
      lane: laneA,
      email: 'speaker@example.org',
      now: T0,
      method: 'otp' as never
    })).toThrow('participant_verification_method_unsupported');
  });
});

describe('magic-link callback', () => {
  test('single use: a replayed token reports link_used', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org');
    const token = h.delivery.effects[0]!.linkToken;
    expect(completeLink(h, token).kind).toBe('signed_in');
    expect(completeLink(h, token)).toEqual({ kind: 'link_used' });
    expect(completeLink(h, token)).toEqual({ kind: 'link_used' });
  });

  test('expiry is typed and stays link_expired on later attempts', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org');
    const token = h.delivery.effects[0]!.linkToken;
    const afterTtl = at(PARTICIPANT_MAGIC_LINK_LAUNCH_TTL_MS + 1);
    expect(completeLink(h, token, { now: afterTtl })).toEqual({ kind: 'link_expired' });
    expect(completeLink(h, token, { now: at(3_600_000) })).toEqual({ kind: 'link_expired' });
  });

  test('unknown and malformed tokens are link_invalid', () => {
    const h = harness();
    expect(completeLink(h, 'plt1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))
      .toEqual({ kind: 'link_invalid', reason: 'unknown_token' });
    expect(completeLink(h, 'not-a-token'))
      .toEqual({ kind: 'link_invalid', reason: 'malformed_token' });
  });

  test('a token issued in one lane never completes in another lane', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org', { lane: laneA });
    const token = h.delivery.effects[0]!.linkToken;
    expect(completeLink(h, token, { lane: laneB }))
      .toEqual({ kind: 'link_invalid', reason: 'unknown_token' });
  });

  test('first completion mints the person + participant-identity pair; later ones resume it', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org', { tokens: deterministicTokens(50) });
    const first = completeLink(h, h.delivery.effects[0]!.linkToken);
    if (first.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(first.resumed).toBe(false);
    expect(first.identity.origin).toBe('portal_ceremony');
    expect(first.identity.personId).not.toBe(first.identity.participantIdentityId as unknown);
    // The fresh mint happened only after intake attribution answered empty.
    expect(h.intakeAttribution.lookups).toEqual([
      { lane: laneA, normalizedEmail: 'speaker@example.org' }
    ]);

    requestLink(h, 'SPEAKER@example.org', { now: at(120_000), tokens: deterministicTokens(60) });
    const second = completeLink(h, h.delivery.effects[1]!.linkToken, { now: at(180_000) });
    if (second.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(second.resumed).toBe(true);
    expect(second.identity.personId).toBe(first.identity.personId);
    expect(second.identity.participantIdentityId).toBe(first.identity.participantIdentityId);
    expect(h.identities.rows).toHaveLength(1);
  });

  test('equal email in a different lane mints a separate family member, never a merge', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org', { lane: laneA, tokens: deterministicTokens(70) });
    requestLink(h, 'speaker@example.org', { lane: laneB, tokens: deterministicTokens(80) });
    const inA = completeLink(h, h.delivery.effects[0]!.linkToken, { lane: laneA });
    const inB = completeLink(h, h.delivery.effects[1]!.linkToken, { lane: laneB });
    if (inA.kind !== 'signed_in' || inB.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(inA.identity.personId).not.toBe(inB.identity.personId);
    expect(inA.identity.participantIdentityId).not.toBe(inB.identity.participantIdentityId);
  });

  test('an intake-attributed pair is adopted, not shadowed by a parallel mint', () => {
    const h = harness();
    const attribution = {
      personId: parsePersonId(uuid(0x900)),
      participantIdentityId: parseParticipantIdentityId(uuid(0x901))
    };
    adoptIntakeAttributedParticipant({
      identities: h.identities,
      lane: laneA,
      attribution,
      email: parseParticipantEmail('speaker@example.org'),
      displayName: 'Speaker',
      now: T0
    });
    requestLink(h, 'speaker@example.org');
    const outcome = completeLink(h, h.delivery.effects[0]!.linkToken);
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(outcome.resumed).toBe(true);
    expect(outcome.identity.personId).toBe(attribution.personId);
    expect(outcome.identity.participantIdentityId).toBe(attribution.participantIdentityId);
    expect(outcome.identity.origin).toBe('adopted_attribution');
    expect(h.identities.rows).toHaveLength(1);
  });

  test('the ceremony itself joins the intake family: a directory miss consults attribution before minting', () => {
    const h = harness();
    const attributed = {
      personId: parsePersonId(uuid(0x910)),
      participantIdentityId: parseParticipantIdentityId(uuid(0x911)),
      displayName: 'Ada Lovelace'
    };
    h.intakeAttribution.attribute(laneA, 'speaker@example.org', attributed);

    requestLink(h, 'Speaker@Example.org', { tokens: deterministicTokens(55) });
    const outcome = completeLink(h, h.delivery.effects[0]!.linkToken);
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    // First portal sign-in of an intake-attributed speaker: the exact intake
    // pair, never a parallel portal_ceremony mint for the same address.
    expect(outcome.resumed).toBe(false);
    expect(outcome.identity.personId).toBe(attributed.personId);
    expect(outcome.identity.participantIdentityId).toBe(attributed.participantIdentityId);
    expect(outcome.identity.origin).toBe('adopted_attribution');
    expect(outcome.identity.displayName).toBe('Ada Lovelace');
    expect(h.identities.rows).toHaveLength(1);
    expect(h.intakeAttribution.lookups).toEqual([
      { lane: laneA, normalizedEmail: 'speaker@example.org' }
    ]);

    // The adopted member is now the directory's; later ceremonies resume it
    // without consulting intake again.
    requestLink(h, 'speaker@example.org', { now: at(120_000), tokens: deterministicTokens(56) });
    const again = completeLink(h, h.delivery.effects[1]!.linkToken, { now: at(180_000) });
    if (again.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(again.resumed).toBe(true);
    expect(again.identity.personId).toBe(attributed.personId);
    expect(h.intakeAttribution.lookups).toHaveLength(1);
  });

  test('attribution is lane-scoped: another lane still mints its own member', () => {
    const h = harness();
    h.intakeAttribution.attribute(laneA, 'speaker@example.org', {
      personId: parsePersonId(uuid(0x920)),
      participantIdentityId: parseParticipantIdentityId(uuid(0x921))
    });
    requestLink(h, 'speaker@example.org', { lane: laneB, tokens: deterministicTokens(57) });
    const outcome = completeLink(h, h.delivery.effects[0]!.linkToken, { lane: laneB });
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    expect(outcome.identity.origin).toBe('portal_ceremony');
    expect(outcome.identity.personId).not.toBe(parsePersonId(uuid(0x920)));
  });

  test('NO_INTAKE_ATTRIBUTION resolves nothing for any address', () => {
    expect(NO_INTAKE_ATTRIBUTION.resolveByEmail({
      lane: laneA,
      normalizedEmail: 'speaker@example.org'
    })).toBeUndefined();
  });

  test('a revoked identity completes the mailbox proof but receives no session', () => {
    const h = harness();
    requestLink(h, 'speaker@example.org', { tokens: deterministicTokens(90) });
    const first = completeLink(h, h.delivery.effects[0]!.linkToken);
    if (first.kind !== 'signed_in') throw new Error('expected signed_in');
    h.identities.revoke(first.identity.participantIdentityId);

    requestLink(h, 'speaker@example.org', { now: at(60_000), tokens: deterministicTokens(91) });
    const second = completeLink(h, h.delivery.effects[1]!.linkToken, { now: at(90_000) });
    expect(second).toEqual({ kind: 'link_invalid', reason: 'identity_revoked' });
    expect(h.sessions.rows.size).toBe(1);
  });
});

describe('participant session', () => {
  const day = 24 * 60 * 60_000;

  function signIn(h: ReturnType<typeof harness>) {
    requestLink(h, 'speaker@example.org');
    const outcome = completeLink(h, h.delivery.effects.at(-1)!.linkToken);
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    return outcome;
  }

  test('window helpers: sliding never passes the absolute cap', () => {
    const window = initialParticipantSessionWindow(PARTICIPANT_ACCESS_LAUNCH_POLICY, T0);
    expect(Date.parse(window.slidingExpiresAt) - Date.parse(T0))
      .toBe(PARTICIPANT_SESSION_LAUNCH_SLIDING_WINDOW_MS);
    expect(Date.parse(window.absoluteExpiresAt) - Date.parse(T0))
      .toBe(PARTICIPANT_SESSION_LAUNCH_ABSOLUTE_CAP_MS);
    const nearCap = at(PARTICIPANT_SESSION_LAUNCH_ABSOLUTE_CAP_MS - day);
    expect(slideParticipantSessionWindow(PARTICIPANT_ACCESS_LAUNCH_POLICY, window, nearCap))
      .toBe(window.absoluteExpiresAt);
  });

  test('activity slides the session; inactivity past the window expires it', () => {
    const h = harness();
    const { session } = signIn(h);
    const active = resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(29 * day)
    });
    expect(active.kind).toBe('active');
    // The visit at day 29 slid the window; day 58 is still inside it.
    const stillActive = resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(58 * day)
    });
    expect(stillActive.kind).toBe('active');
    // 31 idle days after the day-58 visit is past the sliding window.
    const expired = resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(89.5 * day)
    });
    expect(expired).toEqual({ kind: 'expired', reason: 'sliding_window_elapsed' });
  });

  test('the 90-day absolute cap ends the session despite constant activity', () => {
    const h = harness();
    const { session } = signIn(h);
    for (let dayIndex = 1; dayIndex <= 89; dayIndex += 1) {
      const resolution = resolveParticipantContext({
        sessions: h.sessions,
        identities: h.identities,
        lane: laneA,
        sessionToken: session.sessionToken,
        now: at(dayIndex * day)
      });
      expect(resolution.kind).toBe('active');
    }
    const capped = resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(90 * day + 60_000)
    });
    expect(capped).toEqual({ kind: 'expired', reason: 'absolute_cap_reached' });
  });

  test('explicit sign-out revokes; an unknown cookie stays anonymous either way', () => {
    const h = harness();
    const { session } = signIn(h);
    expect(signOutParticipant({
      sessions: h.sessions,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(60_000)
    })).toEqual({ signedOut: true });
    expect(resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(120_000)
    })).toEqual({ kind: 'expired', reason: 'signed_out' });
    // Idempotent, and a never-issued token gets the same acknowledgement.
    expect(signOutParticipant({
      sessions: h.sessions,
      lane: laneA,
      sessionToken: mintParticipantSessionToken(deterministicTokens(99)),
      now: at(120_000)
    })).toEqual({ signedOut: true });
    expect(resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneA,
      sessionToken: undefined,
      now: at(120_000)
    })).toEqual({ kind: 'anonymous' });
  });

  test('a session is lane-separate: it never resolves in another lane', () => {
    const h = harness();
    const { session } = signIn(h);
    expect(resolveParticipantContext({
      sessions: h.sessions,
      identities: h.identities,
      lane: laneB,
      sessionToken: session.sessionToken,
      now: at(60_000)
    })).toEqual({ kind: 'anonymous' });
  });
});

describe('per-request authority re-evaluation', () => {
  function signedIn(h: ReturnType<typeof harness>) {
    requestLink(h, 'speaker@example.org');
    const outcome = completeLink(h, h.delivery.effects.at(-1)!.linkToken);
    if (outcome.kind !== 'signed_in') throw new Error('expected signed_in');
    return outcome;
  }

  test('authority carries the participant actor and a freshly evaluated relationship', () => {
    const h = harness();
    const { session, identity } = signedIn(h);
    h.relationships.current = {
      kind: 'related',
      submissionIds: ['sub-1'],
      engagementIds: ['eng-1']
    };
    const authority = resolveParticipantAuthority({
      sessions: h.sessions,
      identities: h.identities,
      relationships: h.relationships,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(60_000)
    });
    if (authority.kind !== 'authorized') throw new Error('expected authorized');
    expect(authority.actor).toEqual({
      kind: 'participant',
      participantIdentityId: identity.participantIdentityId,
      personId: identity.personId
    });
    expect(participantSubjectAccess(authority.relationship, { kind: 'submission', id: 'sub-1' }))
      .toEqual({ allowed: true });
    expect(participantSubjectAccess(authority.relationship, { kind: 'submission', id: 'sub-2' }))
      .toEqual({ allowed: false, reason: 'no_current_relationship' });
  });

  test('removal bites the next request despite a live session', () => {
    const h = harness();
    const { session } = signedIn(h);
    h.relationships.current = {
      kind: 'related',
      submissionIds: ['sub-1'],
      engagementIds: []
    };
    const before = resolveParticipantAuthority({
      sessions: h.sessions,
      identities: h.identities,
      relationships: h.relationships,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(60_000)
    });
    if (before.kind !== 'authorized') throw new Error('expected authorized');
    expect(participantSubjectAccess(before.relationship, { kind: 'submission', id: 'sub-1' }))
      .toEqual({ allowed: true });

    // The organizer removes the speaker; the session is untouched and unexpired.
    h.relationships.current = { kind: 'none' };
    const after = resolveParticipantAuthority({
      sessions: h.sessions,
      identities: h.identities,
      relationships: h.relationships,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(120_000)
    });
    if (after.kind !== 'authorized') throw new Error('expected authorized');
    expect(participantSubjectAccess(after.relationship, { kind: 'submission', id: 'sub-1' }))
      .toEqual({ allowed: false, reason: 'no_current_relationship' });
  });

  test('a revoked identity is refused on the next request despite a live session', () => {
    const h = harness();
    const { session, identity } = signedIn(h);
    h.identities.revoke(identity.participantIdentityId);
    const refused = resolveParticipantAuthority({
      sessions: h.sessions,
      identities: h.identities,
      relationships: h.relationships,
      lane: laneA,
      sessionToken: session.sessionToken,
      now: at(60_000)
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'identity_revoked' });
  });

  test('no cookie refuses as no_session', () => {
    const h = harness();
    expect(resolveParticipantAuthority({
      sessions: h.sessions,
      identities: h.identities,
      relationships: h.relationships,
      lane: laneA,
      sessionToken: undefined,
      now: T0
    })).toEqual({ kind: 'refused', reason: 'no_session' });
  });
});
