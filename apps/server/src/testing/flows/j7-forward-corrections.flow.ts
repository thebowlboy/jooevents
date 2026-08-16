import { expect } from 'bun:test';
import { runJ2Spine } from './j2-spine.flow';
import type { FlowWorld } from './flow-world';

type DecisionState = {
  readonly rows: readonly {
    readonly submissionId: string;
    readonly head: { readonly state: string; readonly version: number; readonly digestSha256: string } | null;
    readonly origin: { readonly sessionId: string } | null;
  }[];
};

type ScheduleSnapshot = {
  readonly scheduleVersion: number;
  readonly occurrences: readonly {
    readonly id: string;
    readonly version: number;
    readonly sessionId: string;
    readonly roomId: string;
    readonly startAt: string;
    readonly endAt: string;
  }[];
};

type Placement = {
  readonly action: 'place' | 'move' | 'unplace';
  readonly scheduleVersion: number;
  readonly occurrence: ScheduleSnapshot['occurrences'][number] | null;
};

type Roster = {
  readonly rosterVersion: number;
  readonly rosterDigestSha256: string;
  readonly reviewers: readonly {
    readonly reviewerId: string;
    readonly recordVersion: number;
    readonly status: 'active' | 'revoked' | 'invited';
    readonly reviews: readonly { readonly kind: string; readonly id: string }[];
  }[];
};

function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`J7 prerequisite missing: ${label}`);
  return value;
}

function expectNoRemovedCompensation(result: unknown, names: readonly string[]): void {
  for (const name of names) expect(result).not.toHaveProperty(name);
}

const scheduleWindow = {
  startAt: '2027-06-10T00:00:00.000Z',
  endAt: '2027-06-13T00:00:00.000Z',
  limit: 100
} as const;

/** J7 — corrections always author a guarded successor; none restores a cached before-image. */
export async function runJ7ForwardCorrections(world: FlowWorld): Promise<void> {
  const organizer = world.as('organizer');
  const spine = await runJ2Spine(world);

  const redecided = await organizer.do<{ readonly action: 'decide'; readonly rows: readonly unknown[] }>('decision.decide', {
    action: 'decide',
    decisions: [{
      submissionId: spine.submissionId,
      state: 'declined',
      expectedDecisionVersion: spine.decision.version,
      expectedDecisionDigestSha256: spine.decision.digestSha256
    }]
  });
  await organizer.expectLog('Recorded submission decisions');
  expectNoRemovedCompensation(redecided.data, ['undo', 'restore', 'priorVerdict', 'compensation']);
  await organizer.expectRead('decision.state.read', { submissionIds: [spine.submissionId] }, (projection) => {
    const state = projection as DecisionState;
    const row = state.rows.find((candidate) => candidate.submissionId === spine.submissionId);
    return row?.head?.state === 'declined' && row.origin?.sessionId === spine.sessionId;
  });

  let schedule!: ScheduleSnapshot;
  await organizer.expectRead('schedule.placement.snapshot.read', scheduleWindow, (projection) => {
    schedule = projection as ScheduleSnapshot;
    return schedule.occurrences.some((item) => item.id === spine.placement.id);
  });
  const initial = required(schedule.occurrences.find((item) => item.id === spine.placement.id), 'initial occurrence');
  const moved = await organizer.do<Placement>('schedule.placement', {
    action: 'move',
    expectedScheduleVersion: schedule.scheduleVersion,
    occurrenceId: initial.id,
    expectedOccurrenceVersion: initial.version,
    roomId: initial.roomId,
    startAt: '2027-06-10T02:00:00.000Z',
    endAt: '2027-06-10T02:45:00.000Z'
  });
  await organizer.expectLog('Moved a session on the schedule');
  expectNoRemovedCompensation(moved.data, ['undo', 'moveBack', 'compensation']);
  const movedOccurrence = required(moved.data.occurrence, 'moved occurrence');
  const movedBack = await organizer.do<Placement>('schedule.placement', {
    action: 'move',
    expectedScheduleVersion: moved.data.scheduleVersion,
    occurrenceId: movedOccurrence.id,
    expectedOccurrenceVersion: movedOccurrence.version,
    roomId: initial.roomId,
    startAt: initial.startAt,
    endAt: initial.endAt
  });
  await organizer.expectLog('Moved a session on the schedule');
  expectNoRemovedCompensation(movedBack.data, ['undo', 'moveBack', 'compensation']);
  const returnedOccurrence = required(movedBack.data.occurrence, 'returned occurrence');
  const unplaced = await organizer.do<Placement>('schedule.placement', {
    action: 'unplace',
    expectedScheduleVersion: movedBack.data.scheduleVersion,
    occurrenceId: returnedOccurrence.id,
    expectedOccurrenceVersion: returnedOccurrence.version
  });
  await organizer.expectLog('Removed a session from the schedule');
  expect(unplaced.data.occurrence).toBeNull();
  expectNoRemovedCompensation(unplaced.data, ['undo', 'restore', 'compensation']);
  await organizer.expectRead('schedule.placement.snapshot.read', scheduleWindow, (projection) =>
    !(projection as ScheduleSnapshot).occurrences.some((item) => item.id === returnedOccurrence.id)
  );
  const replaced = await organizer.do<Placement>('schedule.placement', {
    action: 'place',
    expectedScheduleVersion: unplaced.data.scheduleVersion,
    roomId: spine.roomId,
    sessionId: spine.sessionId,
    startAt: initial.startAt,
    endAt: initial.endAt
  });
  await organizer.expectLog('Placed a session on the schedule');
  expectNoRemovedCompensation(replaced.data, ['undo', 'restore', 'compensation']);

  let roster!: Roster;
  await organizer.expectRead('reviewer_roster.snapshot.read', (projection) => {
    roster = projection as Roster;
    return roster.reviewers.some((item) => item.reviewerId === spine.reviewerId && item.status === 'active');
  });
  const registered = required(roster.reviewers.find((item) => item.reviewerId === spine.reviewerId), 'reviewer');
  const revoked = await organizer.do<{ readonly action: 'revoke'; readonly rosterVersion: number; readonly rosterDigestSha256: string; readonly reviewer: { readonly version: number } }>('reviewer_roster.change', {
    action: 'revoke', reviewerId: registered.reviewerId,
    expectedReviewerVersion: registered.recordVersion,
    expectedRosterVersion: roster.rosterVersion,
    expectedRosterDigestSha256: roster.rosterDigestSha256
  });
  await organizer.expectLog('Revoked a reviewer');
  expectNoRemovedCompensation(revoked.data, ['undo', 'priorScope', 'compensation']);
  const restored = await organizer.do<{ readonly action: 'restore'; readonly rosterVersion: number; readonly rosterDigestSha256: string; readonly reviewer: { readonly version: number } }>('reviewer_roster.change', {
    action: 'restore', reviewerId: registered.reviewerId,
    expectedReviewerVersion: revoked.data.reviewer.version,
    expectedRosterVersion: revoked.data.rosterVersion,
    expectedRosterDigestSha256: revoked.data.rosterDigestSha256
  });
  await organizer.expectLog('Restored a reviewer');
  await organizer.expectRead('reviewer_roster.snapshot.read', (projection) =>
    (projection as Roster).reviewers.some((item) => item.reviewerId === spine.reviewerId && item.status === 'active')
  );

  const scoped = await organizer.do<{ readonly action: 'set_scope' }>('reviewer_roster.change', {
    action: 'set_scope', reviewerId: registered.reviewerId,
    expectedReviewerVersion: restored.data.reviewer.version,
    expectedRosterVersion: restored.data.rosterVersion,
    expectedRosterDigestSha256: restored.data.rosterDigestSha256,
    reviews: [{ kind: 'format', id: spine.formatId }]
  });
  await organizer.expectLog("Changed a reviewer's scope");
  expectNoRemovedCompensation(scoped.data, ['undo', 'restore', 'priorScope', 'compensation']);
  await organizer.expectRead('reviewer_roster.snapshot.read', (projection) => {
    const current = projection as Roster;
    return current.reviewers.some((item) => item.reviewerId === spine.reviewerId
      && item.reviews.length === 1 && item.reviews[0]?.kind === 'format' && item.reviews[0]?.id === spine.formatId);
  });
}
