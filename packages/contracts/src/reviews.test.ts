import { describe, expect, test } from 'bun:test';
import {
  reviewCriteriaSchema,
  reviewChangeDraftInputSchema,
  reviewPlanProjectionSchema,
  reviewRevisionSchema,
  reviewSnapshotSchema
} from './reviews';

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
const scope = { workspaceId: id(1), eventId: id(2) };

describe('review contracts', () => {
  test('requires canonical ordered criteria whose weights total 10000', () => {
    expect(reviewCriteriaSchema.safeParse([
      { id: id(3), key: 'quality', label: 'Quality', position: 0, weightBps: 6_000, scaleMin: 1, scaleMax: 5 },
      { id: id(4), key: 'fit', label: 'Fit', position: 1, weightBps: 4_000, scaleMin: 1, scaleMax: 5 }
    ]).success).toBe(true);
    expect(reviewCriteriaSchema.safeParse([
      { id: id(3), key: 'quality', label: 'Quality', position: 0, weightBps: 5_999, scaleMin: 1, scaleMax: 5 },
      { id: id(4), key: 'fit', label: 'Fit', position: 1, weightBps: 4_000, scaleMin: 1, scaleMax: 5 }
    ]).success).toBe(false);
  });

  test('makes amendments explicit forward corrections', () => {
    const common = {
      schemaVersion: 1 as const,
      scope,
      id: id(9),
      assignmentId: id(8),
      scores: [{ criterionId: id(3), score: 4 }],
      weightedScore: 4,
      comment: '',
      committedByReviewerId: id(6),
      committedByUserId: id(7),
      committedAt: '2026-08-13T00:00:00.000Z'
    };
    expect(reviewRevisionSchema.safeParse({
      ...common, revisionNumber: 1, postUnlock: false
    }).success).toBe(true);
    expect(reviewRevisionSchema.safeParse({
      ...common, revisionNumber: 2, postUnlock: false
    }).success).toBe(false);
    expect(reviewRevisionSchema.safeParse({
      ...common, revisionNumber: 2, postUnlock: true, correctionOfRevisionId: id(10)
    }).success).toBe(true);
  });

  test('permits honest absence of reviewer-only and derived projections', () => {
    expect(reviewSnapshotSchema.parse({
      schemaVersion: 1,
      viewer: { kind: 'organizer' },
      plans: [],
      standings: {}
    })).toEqual({
      schemaVersion: 1,
      viewer: { kind: 'organizer' },
      plans: [],
      standings: {}
    });
  });

  test('serves round version and canonical criterion identities on every plan', () => {
    const plan = {
      id: id(20),
      ordinal: 1,
      name: 'Round 1',
      state: 'open',
      version: 3,
      scaleMax: 5,
      criteria: [{
        id: id(21), key: 'overall', label: 'Overall', position: 0,
        weightBps: 10_000, scaleMin: 1, scaleMax: 5
      }],
      deadlineEffectiveAt: '2026-08-31T00:00:00.000Z',
      anonymized: true,
      antiAnchoring: true,
      done: 0,
      total: 1,
      reviewers: []
    };
    expect(reviewPlanProjectionSchema.safeParse(plan).success).toBe(true);
    const { criteria: _criteria, ...withoutCriteria } = plan;
    expect(reviewPlanProjectionSchema.safeParse(withoutCriteria).success).toBe(false);
    const { version: _version, ...withoutVersion } = plan;
    expect(reviewPlanProjectionSchema.safeParse(withoutVersion).success).toBe(false);
  });

  test('accepts open-round date intent and never trusts the browser with a Deadline id', () => {
    expect(reviewChangeDraftInputSchema.parse({
      action: 'open_round', deadlineDate: '2026-08-30', anonymized: true
    })).toEqual({ action: 'open_round', deadlineDate: '2026-08-30', anonymized: true });
    expect(reviewChangeDraftInputSchema.safeParse({
      action: 'open_round', deadlineId: id(40), anonymized: true
    }).success).toBe(false);
  });
});
