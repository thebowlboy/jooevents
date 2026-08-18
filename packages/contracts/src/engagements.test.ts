import { describe, expect, test } from 'bun:test';
import {
  engagementAuthorInputSchema,
  engagementHeadSchema,
  engagementSeedInputSchema,
  engagementSeedPlanSchema,
  engagementSeedReversalPlanSchema,
  engagementSnapshotSchema,
  engagementStateSchema,
  speakerPersonHistoryInputSchema,
  speakerPersonHistoryPageSchema
} from './engagements';

const scope = Object.freeze({
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
});
const engagementId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const personId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const otherPersonId = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa601';
const now = '2026-08-14T08:00:00.000Z';
const later = '2026-08-14T09:00:00.000Z';
const seededBy = Object.freeze({ version: 1, digestSha256: 'b'.repeat(64) });
const otherSeededBy = Object.freeze({ version: 1, digestSha256: 'c'.repeat(64) });

function invitedHead(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: engagementId,
    scope,
    sessionId,
    personId,
    submissionId,
    seededByDecision: seededBy,
    state: 'invited',
    invitedAt: now,
    respondBy: null,
    confirmation: null,
    cancellationRequest: null,
    cancelledAt: null,
    source: { kind: 'submission', id: submissionId, version: 7 },
    version: 1,
    ...overrides
  };
}

describe('engagement contracts', () => {
  test('the four canonical states and the strict head shape hold', () => {
    expect(engagementStateSchema.options).toEqual([
      'invited', 'confirmed', 'declined', 'cancelled'
    ]);
    expect(engagementHeadSchema.parse(invitedHead())).toMatchObject({ state: 'invited' });
    // personId keys the head; an email attribute has no home anywhere in it.
    expect(engagementHeadSchema.safeParse(
      invitedHead({ email: 'speaker@example.org' })
    ).success).toBe(false);
  });

  test('state invariants: cancellation instant, confirmation presence, declined purity', () => {
    expect(engagementHeadSchema.safeParse(invitedHead({ cancelledAt: now })).success).toBe(false);
    expect(engagementHeadSchema.safeParse(
      invitedHead({ state: 'cancelled', cancelledAt: null })
    ).success).toBe(false);
    expect(engagementHeadSchema.safeParse(
      invitedHead({ state: 'confirmed', version: 2 })
    ).success).toBe(false);
    const confirmation = {
      attribution: 'organizer_recorded', personId, recordedByUserId: userId, confirmedAt: later
    };
    expect(engagementHeadSchema.parse(
      invitedHead({ state: 'confirmed', confirmation, version: 2 })
    ).state).toBe('confirmed');
    expect(engagementHeadSchema.safeParse(
      invitedHead({ state: 'declined', confirmation, version: 2 })
    ).success).toBe(false);
    expect(engagementHeadSchema.safeParse(invitedHead({
      state: 'declined',
      cancellationRequest: { requestedBy: 'speaker', requestedAt: later, note: null },
      version: 2
    })).success).toBe(false);
    // Cancelled retains confirmation and request as history.
    expect(engagementHeadSchema.parse(invitedHead({
      state: 'cancelled',
      confirmation,
      cancellationRequest: { requestedBy: 'speaker', requestedAt: later, note: null },
      cancelledAt: later,
      version: 4
    })).state).toBe('cancelled');
  });

  test('confirmation attribution binds its person and recording user coherently', () => {
    expect(engagementHeadSchema.safeParse(invitedHead({
      state: 'confirmed',
      confirmation: { attribution: 'self', personId: otherPersonId, recordedByUserId: null, confirmedAt: later },
      version: 2
    })).success).toBe(false);
    expect(engagementHeadSchema.safeParse(invitedHead({
      state: 'confirmed',
      confirmation: { attribution: 'co_speaker', personId, recordedByUserId: null, confirmedAt: later },
      version: 2
    })).success).toBe(false);
    expect(engagementHeadSchema.safeParse(invitedHead({
      state: 'confirmed',
      confirmation: { attribution: 'self', personId, recordedByUserId: userId, confirmedAt: later },
      version: 2
    })).success).toBe(false);
    expect(engagementHeadSchema.parse(invitedHead({
      state: 'confirmed',
      confirmation: {
        attribution: 'co_speaker', personId: otherPersonId, recordedByUserId: null, confirmedAt: later
      },
      version: 2
    })).confirmation?.attribution).toBe('co_speaker');
  });

  test('submission linkage is exact in both directions', () => {
    expect(engagementHeadSchema.safeParse(invitedHead({ submissionId: null })).success).toBe(false);
    expect(engagementHeadSchema.safeParse(invitedHead({
      source: { kind: 'organizer', id: userId, version: 1 }
    })).success).toBe(false);
    expect(engagementHeadSchema.parse(invitedHead({
      submissionId: null,
      seededByDecision: null,
      source: { kind: 'organizer', id: userId, version: 1 }
    })).submissionId).toBeNull();
  });

  test('seed provenance is pinned exactly for acceptance-seeded rows', () => {
    // A submission-seeded row without its seeding decision pin refuses...
    expect(engagementHeadSchema.safeParse(
      invitedHead({ seededByDecision: null })
    ).success).toBe(false);
    // ...and a pin without a submission linkage refuses symmetrically.
    expect(engagementHeadSchema.safeParse(invitedHead({
      submissionId: null,
      source: { kind: 'organizer', id: userId, version: 1 }
    })).success).toBe(false);
    expect(engagementHeadSchema.parse(invitedHead()).seededByDecision).toEqual(seededBy);
  });

  test('author input arms fence versions and lowercase the wire id', () => {
    const upper = engagementId.toUpperCase();
    expect(engagementAuthorInputSchema.parse({
      action: 'record_confirmation',
      engagementId: upper,
      expectedEngagementVersion: 1,
      attribution: 'organizer_recorded'
    }).engagementId).toBe(engagementId);
    expect(engagementAuthorInputSchema.parse({
      action: 'accept_cancellation',
      engagementId,
      expectedEngagementVersion: 3
    }).action).toBe('accept_cancellation');
  });

  test('the operator wire admits only organizer-recorded confirmations', () => {
    // `self` and `co_speaker` record a participant's personal act; the
    // operator surface cannot assert them, so the head can never carry a
    // fabricated participant confirmation whose recorder is erased.
    for (const attribution of ['self', 'co_speaker'] as const) {
      expect(engagementAuthorInputSchema.safeParse({
        action: 'record_confirmation',
        engagementId,
        expectedEngagementVersion: 1,
        attribution
      }).success).toBe(false);
    }
    // The co-speaker person parameter has no operator-wire home either.
    expect(engagementAuthorInputSchema.safeParse({
      action: 'record_confirmation',
      engagementId,
      expectedEngagementVersion: 1,
      attribution: 'organizer_recorded',
      confirmingPersonId: otherPersonId
    }).success).toBe(false);
    expect(engagementAuthorInputSchema.parse({
      action: 'record_confirmation',
      engagementId,
      expectedEngagementVersion: 1,
      attribution: 'organizer_recorded'
    })).toMatchObject({ action: 'record_confirmation', attribution: 'organizer_recorded' });
  });

  test('seed plans partition input persons into seeded rows and skipped pairs', () => {
    const input = {
      scope,
      sessionId,
      submissionId,
      seededByDecision: seededBy,
      source: { kind: 'submission', id: submissionId, version: 7 },
      personIds: [personId, otherPersonId],
      invitedAt: now,
      respondBy: null
    };
    expect(engagementSeedInputSchema.safeParse({
      ...input, personIds: [otherPersonId, personId]
    }).success).toBe(false);
    expect(engagementSeedPlanSchema.parse({
      input,
      rows: [{ personId, head: invitedHead() }],
      skippedPersonIds: [otherPersonId]
    }).rows).toHaveLength(1);
    expect(engagementSeedPlanSchema.safeParse({
      input,
      rows: [{ personId, head: invitedHead() }],
      skippedPersonIds: []
    }).success).toBe(false);
    expect(engagementSeedPlanSchema.safeParse({
      input,
      rows: [{ personId, head: invitedHead({ state: 'confirmed' }) }],
      skippedPersonIds: [otherPersonId]
    }).success).toBe(false);
    // A seeded head must carry the seed input's own decision pin exactly.
    expect(engagementSeedPlanSchema.safeParse({
      input,
      rows: [{ personId, head: invitedHead({ seededByDecision: otherSeededBy }) }],
      skippedPersonIds: [otherPersonId]
    }).success).toBe(false);
  });

  test('seed reversals pin exactly seeded invited version-one rows of one acceptance', () => {
    const plan = {
      action: 'seed_reversal',
      scope,
      sessionId,
      submissionId,
      seededByDecision: seededBy,
      rows: [{ personId, expectedCurrent: invitedHead() }]
    };
    expect(engagementSeedReversalPlanSchema.parse(plan).rows).toHaveLength(1);
    expect(engagementSeedReversalPlanSchema.safeParse({
      ...plan,
      rows: [{
        personId,
        expectedCurrent: invitedHead({
          state: 'confirmed',
          confirmation: {
            attribution: 'organizer_recorded', personId, recordedByUserId: userId, confirmedAt: later
          },
          version: 2
        })
      }]
    }).success).toBe(false);
    // A row another acceptance seeded can never ride this reversal.
    expect(engagementSeedReversalPlanSchema.safeParse({
      ...plan,
      rows: [{ personId, expectedCurrent: invitedHead({ seededByDecision: otherSeededBy }) }]
    }).success).toBe(false);
  });

  test('snapshots order engagements canonically by session and person', () => {
    const second = invitedHead({
      id: '019c1df7-86b5-769b-bba4-5f7097bfa202',
      personId: otherPersonId,
      submissionId: null,
      seededByDecision: null,
      source: { kind: 'organizer', id: userId, version: 1 }
    });
    expect(engagementSnapshotSchema.parse({
      schemaVersion: 1, scope, engagements: [invitedHead(), second]
    }).engagements).toHaveLength(2);
    expect(engagementSnapshotSchema.safeParse({
      schemaVersion: 1, scope, engagements: [second, invitedHead()]
    }).success).toBe(false);
    expect(engagementSnapshotSchema.safeParse({
      schemaVersion: 1, scope, engagements: [invitedHead(), invitedHead()]
    }).success).toBe(false);
  });

  test('person history pages bind a truthful reverse-chronological cursor', () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      id: `task:019c1df7-86b5-7${String(index).padStart(3, '0')}-8ba4-5f7097bfa401`,
      occurredAt: new Date(Date.parse(later) - index * 1_000).toISOString(),
      actor: 'organizer' as const,
      summary: 'Changed a speaker task'
    }));
    const last = entries.at(-1)!;
    expect(speakerPersonHistoryPageSchema.parse({
      schemaVersion: 1, entries, next: { occurredAt: last.occurredAt, id: last.id }
    }).entries).toHaveLength(100);
    expect(speakerPersonHistoryPageSchema.safeParse({
      schemaVersion: 1, entries: entries.slice(0, 2),
      next: { occurredAt: entries[1]!.occurredAt, id: entries[1]!.id }
    }).success).toBe(false);
    expect(speakerPersonHistoryPageSchema.safeParse({
      schemaVersion: 1, entries: [entries[1], entries[0]], next: null
    }).success).toBe(false);
    expect(speakerPersonHistoryInputSchema.safeParse({
      personId, beforeOccurredAt: last.occurredAt
    }).success).toBe(false);
  });
});
