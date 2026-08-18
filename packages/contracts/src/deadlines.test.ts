import { describe, expect, test } from 'bun:test';
import {
  deadlineHeadSchema,
  deadlineMutationPlanSchema,
  deadlineReferencePinSchema
} from './deadlines';

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const digest = 'a'.repeat(64);
const active = {
  schemaVersion: 1 as const,
  id: id('1'), scope: { workspaceId: id('2'), eventId: id('3') }, kind: 'cfp_close' as const,
  status: 'active' as const, version: 1, digestSha256: digest, gracePolicy: 'soft' as const,
  displayDate: '2026-11-01', effectiveAt: '2026-11-02T05:00:00.000Z',
  boundary: {
    profile: {
      key: 'deadline.calendar-date.event-local-end-exclusive' as const,
      version: 1 as const, digestSha256: digest
    },
    eventTimezone: 'America/New_York', eventVersion: 4, localBoundaryDate: '2026-11-02'
  },
  createdByUserId: id('4'), createdAt: '2026-08-13T01:00:00.000Z',
  updatedByUserId: id('4'), updatedAt: '2026-08-13T01:00:00.000Z'
};

describe('Deadline contracts', () => {
  test('accept exact active state and reject a host-style instant', () => {
    expect(deadlineHeadSchema.safeParse(active).success).toBe(true);
    expect(deadlineHeadSchema.safeParse({ ...active, effectiveAt: '2026-11-02T00:00:00-05:00' }).success)
      .toBe(false);
  });

  test('requires coherent create plan images and one catalog advance', () => {
    const candidate = {
      input: {
        action: 'create' as const, scope: active.scope, deadlineId: active.id,
        displayDate: active.displayDate, attributedByUserId: id('4'),
        attributedAt: '2026-08-13T01:00:00.000Z'
      },
      before: null,
      after: active,
      eventTimeBasis: { timezone: 'America/New_York', eventVersion: 4 },
      catalog: {
        beforeVersion: 1, beforeDigestSha256: digest,
        afterVersion: 2, afterDigestSha256: digest
      }
    };
    expect(deadlineMutationPlanSchema.safeParse(candidate).success).toBe(true);
    expect(deadlineMutationPlanSchema.safeParse({
      ...candidate, catalog: { ...candidate.catalog, afterVersion: 3 }
    }).success).toBe(false);
  });

  test('retains old reference pins while accepting the pinned event timezone', () => {
    const legacy = {
      id: active.id, version: 1, digestSha256: digest,
      effectiveAt: active.effectiveAt, displayDate: active.displayDate, gracePolicy: 'soft' as const
    };
    expect(deadlineReferencePinSchema.parse(legacy)).toEqual(legacy);
    expect(deadlineReferencePinSchema.parse({
      ...legacy, eventTimezone: 'America/New_York'
    }).eventTimezone).toBe('America/New_York');
  });
});
