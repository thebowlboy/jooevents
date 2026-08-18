import { describe, expect, test } from 'bun:test';
import {
  applyCalendarNoticeChange,
  createCalendarNoticeGenerationProjection,
  manuallySealCalendarNoticeGeneration,
  recordCalendarNoticeGenerationRelease,
  sealDueCalendarNoticeGenerations,
  setCalendarNoticeGenerationHold,
  type CalendarNoticeChange
} from './notice-generations';

const scope = {
  workspaceId: '50000000-0000-4000-8000-000000000001',
  eventId: '50000000-0000-4000-8000-000000000002'
};
const personId = '50000000-0000-4000-8000-000000000003';
const commitmentA = '50000000-0000-4000-8000-000000000004';
const commitmentB = '50000000-0000-4000-8000-000000000005';
const identities = {
  mintGeneration: ({ generationNumber }: { generationNumber: number }) => `generation-${generationNumber}`
};

function change(overrides: Partial<CalendarNoticeChange> = {}): CalendarNoticeChange {
  return {
    personId,
    commitmentId: commitmentA,
    method: 'request',
    sequence: 0,
    intakePosition: 1,
    occurredAt: '2026-08-18T01:00:00.000Z',
    priorStartAt: null,
    newStartAt: '2026-09-01T01:00:00.000Z',
    ...overrides
  };
}

describe('calendar notice generation projector', () => {
  test('keeps one open generation and a non-sliding boundary while netting items', () => {
    let projection = createCalendarNoticeGenerationProjection(scope);
    projection = applyCalendarNoticeChange({
      projection, change: change(), windowMilliseconds: 3_600_000,
      nearEventMilliseconds: 172_800_000, identities
    });
    projection = applyCalendarNoticeChange({
      projection,
      change: change({
        commitmentId: commitmentB,
        intakePosition: 2,
        occurredAt: '2026-08-18T01:30:00.000Z'
      }),
      windowMilliseconds: 3_600_000,
      nearEventMilliseconds: 172_800_000,
      identities
    });
    expect(projection.generations).toHaveLength(1);
    expect(projection.generations[0]).toMatchObject({
      state: 'open', generationNumber: 1,
      openedAt: '2026-08-18T01:00:00.000Z', sealAt: '2026-08-18T02:00:00.000Z'
    });
    expect(projection.generations[0]?.items.map((item) => item.commitmentId))
      .toEqual([commitmentA, commitmentB]);
  });

  test('seals urgently when the prior slot is near even if the new slot moves later', () => {
    const projection = applyCalendarNoticeChange({
      projection: createCalendarNoticeGenerationProjection(scope),
      change: change({
        sequence: 2,
        priorStartAt: '2026-08-19T01:00:00.000Z',
        newStartAt: '2026-09-20T01:00:00.000Z'
      }),
      windowMilliseconds: 3_600_000,
      nearEventMilliseconds: 172_800_000,
      identities
    });
    expect(projection.generations[0]).toMatchObject({
      state: 'sealed', sealReason: 'near_event_bypass', sealedIntakePosition: 1
    });
  });

  test('a hold blocks time sealing, manual release seals, and a later fact opens generation two', () => {
    let projection = applyCalendarNoticeChange({
      projection: createCalendarNoticeGenerationProjection(scope),
      change: change(), windowMilliseconds: 60_000,
      nearEventMilliseconds: 1_000, identities
    });
    projection = setCalendarNoticeGenerationHold({
      projection, generationId: 'generation-1', held: true
    });
    projection = sealDueCalendarNoticeGenerations({
      projection, evaluatedAt: '2026-08-18T02:00:00.000Z'
    });
    expect(projection.generations[0]).toMatchObject({ state: 'open', held: true });
    projection = manuallySealCalendarNoticeGeneration({
      projection, generationId: 'generation-1', sealedAt: '2026-08-18T02:01:00.000Z'
    });
    projection = applyCalendarNoticeChange({
      projection,
      change: change({ intakePosition: 2, occurredAt: '2026-08-18T02:02:00.000Z' }),
      windowMilliseconds: 60_000,
      nearEventMilliseconds: 1_000,
      identities
    });
    expect(projection.generations.map((generation) => [
      generation.generationNumber, generation.state, generation.sealReason
    ])).toEqual([
      [1, 'sealed', 'manual_release'],
      [2, 'open', null]
    ]);
  });

  test('release recording is idempotent and rejects a changed release identity', () => {
    let projection = applyCalendarNoticeChange({
      projection: createCalendarNoticeGenerationProjection(scope),
      change: change(), windowMilliseconds: 0,
      nearEventMilliseconds: 0, identities
    });
    projection = sealDueCalendarNoticeGenerations({
      projection, evaluatedAt: '2026-08-18T01:00:00.000Z'
    });
    projection = recordCalendarNoticeGenerationRelease({
      projection, generationId: 'generation-1', releaseId: 'release-1'
    });
    expect(recordCalendarNoticeGenerationRelease({
      projection, generationId: 'generation-1', releaseId: 'release-1'
    })).toEqual(projection);
    expect(() => recordCalendarNoticeGenerationRelease({
      projection, generationId: 'generation-1', releaseId: 'release-2'
    })).toThrow('calendar_notice_release_identity_conflict');
  });
});
