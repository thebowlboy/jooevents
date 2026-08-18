import { calendarScopeSchema, type CalendarScope } from '@jooevents/contracts/calendar';

export type CalendarDeliveryMode = 'invite_primary' | 'feed_primary';

export interface CalendarDeliveryPreference {
  readonly scope: CalendarScope;
  readonly personId: string;
  readonly mode: CalendarDeliveryMode;
  readonly deadlineOptIn: boolean;
  readonly version: number;
  readonly attributedByUserId: string;
  readonly attributedAt: string;
}

export const DEFAULT_CALENDAR_DELIVERY_PREFERENCE = Object.freeze({
  mode: 'invite_primary' as const,
  deadlineOptIn: false
});

export function effectiveCalendarDeliveryPreference(
  current: CalendarDeliveryPreference | null | undefined
): Readonly<{ mode: CalendarDeliveryMode; deadlineOptIn: boolean; version: number | null }> {
  return current
    ? Object.freeze({ mode: current.mode, deadlineOptIn: current.deadlineOptIn, version: current.version })
    : Object.freeze({ ...DEFAULT_CALENDAR_DELIVERY_PREFERENCE, version: null });
}

/** Returns null when the requested state is exactly the sparse implicit default. */
export function changeCalendarDeliveryPreference(input: {
  readonly current: CalendarDeliveryPreference | null;
  readonly scope: CalendarScope;
  readonly personId: string;
  readonly mode: CalendarDeliveryMode;
  readonly deadlineOptIn: boolean;
  readonly expectedVersion: number | null;
  readonly attributedByUserId: string;
  readonly attributedAt: string;
}): CalendarDeliveryPreference | null {
  const scope = calendarScopeSchema.parse(input.scope);
  const currentVersion = input.current?.version ?? null;
  if (input.expectedVersion !== currentVersion) {
    throw new TypeError('calendar_delivery_preference_stale');
  }
  if (input.mode === DEFAULT_CALENDAR_DELIVERY_PREFERENCE.mode
      && input.deadlineOptIn === DEFAULT_CALENDAR_DELIVERY_PREFERENCE.deadlineOptIn) {
    return null;
  }
  return Object.freeze({
    scope: Object.freeze({ ...scope }),
    personId: input.personId,
    mode: input.mode,
    deadlineOptIn: input.deadlineOptIn,
    version: (input.current?.version ?? 0) + 1,
    attributedByUserId: input.attributedByUserId,
    attributedAt: input.attributedAt
  });
}

export interface CalendarFeedLookupEvidence {
  readonly profile: Readonly<{ readonly key: string; readonly version: number }>;
  readonly keyedHash: string;
}

export interface CalendarFeedHead {
  readonly id: string;
  readonly scope: CalendarScope;
  readonly personId: string;
  readonly version: number;
  readonly state: 'active' | 'revoked';
  readonly lookup: CalendarFeedLookupEvidence;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
}

export interface CalendarFeedTokenFactory {
  mint(): Readonly<{ readonly token: string; readonly entropyBits: number }>;
}

export interface CalendarFeedTokenSealer {
  seal(token: string): CalendarFeedLookupEvidence;
}

function sealedLookup(input: CalendarFeedLookupEvidence): CalendarFeedLookupEvidence {
  if (!input.profile.key || !Number.isSafeInteger(input.profile.version) || input.profile.version <= 0
      || !/^[a-f0-9]{64}$/.test(input.keyedHash)) {
    throw new TypeError('calendar_feed_lookup_evidence_invalid');
  }
  return Object.freeze({
    profile: Object.freeze({ ...input.profile }),
    keyedHash: input.keyedHash
  });
}

function mintToken(input: {
  readonly tokens: CalendarFeedTokenFactory;
  readonly sealer: CalendarFeedTokenSealer;
}): Readonly<{ token: string; lookup: CalendarFeedLookupEvidence }> {
  const minted = input.tokens.mint();
  if (minted.entropyBits < 128 || minted.token.length < 16) {
    throw new TypeError('calendar_feed_token_entropy_insufficient');
  }
  return Object.freeze({ token: minted.token, lookup: sealedLookup(input.sealer.seal(minted.token)) });
}

/** The raw token exists only in this one ceremony result; it is absent from the head. */
export function issueCalendarFeed(input: {
  readonly id: string;
  readonly scope: CalendarScope;
  readonly personId: string;
  readonly issuedAt: string;
  readonly tokens: CalendarFeedTokenFactory;
  readonly sealer: CalendarFeedTokenSealer;
}): Readonly<{ readonly token: string; readonly head: CalendarFeedHead }> {
  const scope = calendarScopeSchema.parse(input.scope);
  const minted = mintToken(input);
  return Object.freeze({
    token: minted.token,
    head: Object.freeze({
      id: input.id,
      scope: Object.freeze({ ...scope }),
      personId: input.personId,
      version: 1,
      state: 'active',
      lookup: minted.lookup,
      createdAt: input.issuedAt,
      rotatedAt: null,
      revokedAt: null
    })
  });
}

export function rotateCalendarFeed(input: {
  readonly current: CalendarFeedHead;
  readonly expectedVersion: number;
  readonly rotatedAt: string;
  readonly tokens: CalendarFeedTokenFactory;
  readonly sealer: CalendarFeedTokenSealer;
}): Readonly<{ readonly token: string; readonly head: CalendarFeedHead }> {
  if (input.current.version !== input.expectedVersion || input.current.state !== 'active') {
    throw new TypeError('calendar_feed_rotation_stale');
  }
  const minted = mintToken(input);
  return Object.freeze({
    token: minted.token,
    head: Object.freeze({
      ...input.current,
      version: input.current.version + 1,
      lookup: minted.lookup,
      rotatedAt: input.rotatedAt
    })
  });
}

export function revokeCalendarFeed(input: {
  readonly current: CalendarFeedHead;
  readonly expectedVersion: number;
  readonly revokedAt: string;
}): CalendarFeedHead {
  if (input.current.version !== input.expectedVersion || input.current.state !== 'active') {
    throw new TypeError('calendar_feed_revocation_stale');
  }
  return Object.freeze({
    ...input.current,
    version: input.current.version + 1,
    state: 'revoked',
    revokedAt: input.revokedAt
  });
}

export function resolveActiveCalendarFeed(input: {
  readonly heads: readonly CalendarFeedHead[];
  readonly workspaceId: string;
  readonly lookup: CalendarFeedLookupEvidence;
}): CalendarFeedHead | undefined {
  const lookup = sealedLookup(input.lookup);
  return input.heads.find((head) => head.state === 'active'
    && head.scope.workspaceId === input.workspaceId
    && head.lookup.profile.key === lookup.profile.key
    && head.lookup.profile.version === lookup.profile.version
    && head.lookup.keyedHash === lookup.keyedHash);
}
