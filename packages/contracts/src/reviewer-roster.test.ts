import { describe, expect, test } from 'bun:test';
import {
  REVIEWER_CAPABILITY_IDS,
  reviewerEligibilityFactSchema,
  reviewerRosterMutationInputSchema,
  reviewerScopeRefsSchema
} from './reviewer-roster';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const eventId = '00000000-0000-4000-8000-000000000002';
const reservationId = '00000000-0000-4000-8000-000000000003';
const membershipId = '00000000-0000-4000-8000-000000000004';
const reviewerId = '00000000-0000-4000-8000-000000000005';

describe('reviewer roster contracts', () => {
  test('requires exact, role-name-free reviewer capability evidence', () => {
    const parsed = reviewerEligibilityFactSchema.parse({
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      rosterSubject: { kind: 'access_reservation', id: reservationId, version: 2 },
      currentSubject: { kind: 'workspace_membership', id: membershipId, version: 7 },
      state: 'active',
      version: 9,
      digestSha256: 'a'.repeat(64),
      capabilityIds: REVIEWER_CAPABILITY_IDS,
      evidenceIds: ['access.assignment:reviewer', 'access.membership:current']
    });

    expect(parsed.state).toBe('active');
    expect('email' in parsed).toBe(false);
    expect('roleName' in parsed).toBe(false);

    expect(() => reviewerEligibilityFactSchema.parse({
      ...parsed,
      capabilityIds: ['event.read', 'submission.read']
    })).toThrow();
  });

  test('keeps reviewer scope a canonical union and uses empty scope for generalists', () => {
    expect(reviewerScopeRefsSchema.parse([])).toEqual([]);
    expect(reviewerScopeRefsSchema.parse([
      { kind: 'track', id: reservationId },
      { kind: 'format', id: membershipId },
      { kind: 'session', id: reviewerId }
    ])).toHaveLength(3);
    expect(() => reviewerScopeRefsSchema.parse([
      { kind: 'session', id: reviewerId },
      { kind: 'track', id: reservationId }
    ])).toThrow();
  });

  test('does not accept an email or invitation payload as a roster identity', () => {
    expect(() => reviewerRosterMutationInputSchema.parse({
      action: 'register',
      scope: { workspaceId, eventId },
      reviewerId,
      accessSubject: { kind: 'access_reservation', id: reservationId, version: 2 },
      reviews: [],
      expectedRosterVersion: 1,
      expectedRosterDigestSha256: 'b'.repeat(64),
      email: 'reviewer@example.test'
    })).toThrow();
  });
});
