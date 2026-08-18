import { describe, expect, test } from 'bun:test';
import {
  changeCalendarDeliveryPreference,
  effectiveCalendarDeliveryPreference,
  issueCalendarFeed,
  resolveActiveCalendarFeed,
  revokeCalendarFeed,
  rotateCalendarFeed
} from './preferences-and-feeds';

const scope = {
  workspaceId: '60000000-0000-4000-8000-000000000001',
  eventId: '60000000-0000-4000-8000-000000000002'
};
const personId = '60000000-0000-4000-8000-000000000003';
const userId = '60000000-0000-4000-8000-000000000004';
const rawTokens = ['first-private-feed-token-value', 'rotated-private-feed-token'] as const;
let tokenIndex = 0;
const tokens = {
  mint: () => ({ token: rawTokens[tokenIndex++]!, entropyBits: 192 })
};
const sealer = {
  seal: (token: string) => ({
    profile: { key: 'calendar-feed.lookup', version: 1 },
    keyedHash: (token === rawTokens[0] ? 'a' : 'b').repeat(64)
  })
};

describe('calendar delivery preferences and feed credentials', () => {
  test('uses a sparse default and fences changed preference versions', () => {
    expect(effectiveCalendarDeliveryPreference(null)).toEqual({
      mode: 'invite_primary', deadlineOptIn: false, version: null
    });
    const changed = changeCalendarDeliveryPreference({
      current: null, scope, personId, mode: 'feed_primary', deadlineOptIn: true,
      expectedVersion: null, attributedByUserId: userId,
      attributedAt: '2026-08-18T01:00:00.000Z'
    });
    expect(changed).toMatchObject({ mode: 'feed_primary', deadlineOptIn: true, version: 1 });
    expect(() => changeCalendarDeliveryPreference({
      current: changed, scope, personId, mode: 'invite_primary', deadlineOptIn: false,
      expectedVersion: null, attributedByUserId: userId,
      attributedAt: '2026-08-18T01:01:00.000Z'
    })).toThrow('calendar_delivery_preference_stale');
    expect(changeCalendarDeliveryPreference({
      current: changed, scope, personId, mode: 'invite_primary', deadlineOptIn: false,
      expectedVersion: 1, attributedByUserId: userId,
      attributedAt: '2026-08-18T01:01:00.000Z'
    })).toBeNull();
  });

  test('shows tokens once, persists only keyed lookup evidence, and fences rotation', () => {
    tokenIndex = 0;
    const issued = issueCalendarFeed({
      id: '60000000-0000-4000-8000-000000000005', scope, personId,
      issuedAt: '2026-08-18T01:00:00.000Z', tokens, sealer
    });
    expect(issued.token).toBe(rawTokens[0]);
    expect(JSON.stringify(issued.head)).not.toContain(rawTokens[0]!);
    expect(resolveActiveCalendarFeed({
      heads: [issued.head], workspaceId: scope.workspaceId, lookup: issued.head.lookup
    })?.id).toBe(issued.head.id);
    expect(resolveActiveCalendarFeed({
      heads: [issued.head],
      workspaceId: '60000000-0000-4000-8000-000000000099',
      lookup: issued.head.lookup
    })).toBeUndefined();

    const rotated = rotateCalendarFeed({
      current: issued.head, expectedVersion: 1,
      rotatedAt: '2026-08-18T01:01:00.000Z', tokens, sealer
    });
    expect(rotated.token).toBe(rawTokens[1]);
    expect(JSON.stringify(rotated.head)).not.toContain(rawTokens[1]!);
    expect(rotated.head).toMatchObject({ version: 2, state: 'active' });
    expect(() => rotateCalendarFeed({
      current: rotated.head, expectedVersion: 1,
      rotatedAt: '2026-08-18T01:02:00.000Z', tokens, sealer
    })).toThrow('calendar_feed_rotation_stale');
  });

  test('revocation makes current lookup fail closed', () => {
    tokenIndex = 0;
    const issued = issueCalendarFeed({
      id: '60000000-0000-4000-8000-000000000005', scope, personId,
      issuedAt: '2026-08-18T01:00:00.000Z', tokens, sealer
    });
    const revoked = revokeCalendarFeed({
      current: issued.head, expectedVersion: 1, revokedAt: '2026-08-18T01:03:00.000Z'
    });
    expect(revoked).toMatchObject({ state: 'revoked', version: 2 });
    expect(resolveActiveCalendarFeed({
      heads: [revoked], workspaceId: scope.workspaceId, lookup: revoked.lookup
    })).toBeUndefined();
  });
});
