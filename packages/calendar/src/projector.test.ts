import { describe, expect, test } from 'bun:test';
import { calendarCommitmentFactSchema, type CalendarCommitmentFact } from '@jooevents/contracts/calendar';
import type { EngagementHeadDto, SessionHeadDto } from '@jooevents/contracts';
import type { SchedulePlacementOccurrenceDto } from '@jooevents/contracts/schedule-placement';
import {
  createCalendarProjectorState,
  projectCalendarCommitmentFacts,
  type CalendarProjectorIdentityFactory,
  type CalendarProjectorState
} from './projector';

const W = '10000000-0000-4000-8000-000000000001';
const E = '10000000-0000-4000-8000-000000000002';
const S = '10000000-0000-4000-8000-000000000003';
const P = '10000000-0000-4000-8000-000000000004';
const G = '10000000-0000-4000-8000-000000000005';
const O1 = '10000000-0000-4000-8000-000000000006';
const O2 = '10000000-0000-4000-8000-000000000007';
const R = '10000000-0000-4000-8000-000000000008';
const F = '10000000-0000-4000-8000-000000000009';
const U = '10000000-0000-4000-8000-000000000010';
const O3 = '10000000-0000-4000-8000-000000000011';
const O4 = '10000000-0000-4000-8000-000000000012';
const D = 'a'.repeat(64);

function session(version = 1, title = 'Practical systems'): SessionHeadDto {
  return {
    schemaVersion: 1, scope: { workspaceId: W, eventId: E }, id: S, title,
    plannedDurationMinutes: 45, lifecycle: 'programmed',
    programTarget: {
      setVersion: 1, setDigestSha256: D,
      format: { kind: 'format', id: F, name: 'Talk', status: 'active', version: 1 },
      track: null
    },
    roster: {
      version, digestSha256: D,
      participants: [{
        personId: P, role: 'speaker', position: 0, publiclyVisible: true,
        source: { kind: 'submission', id: 'submission-1', version: 1 }
      }]
    },
    version, digestSha256: D, createdByUserId: U,
    createdAt: '2026-08-18T01:00:00.000Z', updatedByUserId: U,
    updatedAt: `2026-08-18T01:0${version}:00.000Z`
  };
}

function engagement(state: EngagementHeadDto['state'] = 'confirmed', version = 2): EngagementHeadDto {
  return {
    schemaVersion: 1, id: G, scope: { workspaceId: W, eventId: E }, sessionId: S,
    personId: P, submissionId: null, seededByDecision: null, state,
    invitedAt: '2026-08-18T01:00:00.000Z', respondBy: null,
    confirmation: state === 'confirmed' ? {
      attribution: 'self', personId: P, recordedByUserId: null,
      confirmedAt: '2026-08-18T01:01:00.000Z'
    } : null,
    cancellationRequest: null,
    cancelledAt: state === 'cancelled' ? '2026-08-18T01:09:00.000Z' : null,
    source: { kind: 'session', id: S, version: 1 }, version
  };
}

function occurrence(id = O1, version = 1, startAt = '2026-09-01T02:00:00.000Z'): SchedulePlacementOccurrenceDto {
  const endAt = new Date(new Date(startAt).getTime() + 45 * 60_000).toISOString();
  return { id, sessionId: S, roomId: R, startAt, endAt, version };
}

let sourceNumber = 20;
function fact(payload: CalendarCommitmentFact['fact'], occurredAt = '2026-08-18T01:02:00.000Z'): CalendarCommitmentFact {
  sourceNumber += 1;
  return calendarCommitmentFactSchema.parse({
    schemaVersion: 1,
    source: { operationLogId: `20000000-0000-4000-8000-${String(sourceNumber).padStart(12, '0')}`, ordinal: 0 },
    scope: { workspaceId: W, eventId: E }, occurredAt, fact: payload
  });
}

function sessionFact(value: SessionHeadDto | null, occurredAt?: string): CalendarCommitmentFact {
  return fact({ kind: 'session_changed', version: 1, data: { sessionId: S, session: value } }, occurredAt);
}
function engagementFact(value: EngagementHeadDto, occurredAt?: string): CalendarCommitmentFact {
  return fact({ kind: 'engagement_changed', version: 1, data: { engagement: value } }, occurredAt);
}
function placeFact(value: SchedulePlacementOccurrenceDto, occurredAt?: string): CalendarCommitmentFact {
  return fact({ kind: 'occurrence_changed', version: 1, data: {
    action: 'place', occurrenceId: value.id, occurrence: value
  } }, occurredAt);
}
function unplaceFact(id: string, occurredAt?: string): CalendarCommitmentFact {
  return fact({ kind: 'occurrence_changed', version: 1, data: {
    action: 'unplace', occurrenceId: id, occurrence: null
  } }, occurredAt);
}
function roomFact(name: string, version: number, occurredAt?: string): CalendarCommitmentFact {
  return fact({ kind: 'room_changed', version: 1, data: {
    action: version === 1 ? 'create' : 'edit', roomId: R, name, version
  } }, occurredAt);
}

function identities() {
  let commitments = 0;
  let generations = 0;
  const factory: CalendarProjectorIdentityFactory = {
    mintCommitment: () => {
      commitments += 1;
      return { id: `commitment-${commitments}`, uid: `commitment-${commitments}@calendar.jooevents` };
    },
    mintNoticeGeneration: () => `generation-${++generations}`
  };
  return { factory, commitmentCount: () => commitments, generationCount: () => generations };
}

function project(state: CalendarProjectorState, facts: readonly CalendarCommitmentFact[], ids: CalendarProjectorIdentityFactory) {
  return projectCalendarCommitmentFacts({ state, facts, identities: ids });
}

describe('calendar commitment projector', () => {
  test('confirmation and placement converge independent of their order', () => {
    const a = identities();
    const first = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), roomFact('Room A', 1), placeFact(occurrence()), engagementFact(engagement())
    ], a.factory);
    const b = identities();
    const second = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), engagementFact(engagement()), roomFact('Room A', 1), placeFact(occurrence())
    ], b.factory);
    expect(first.commitments).toEqual(second.commitments);
    expect(first.commitments[0]).toMatchObject({
      uid: 'commitment-1@calendar.jooevents', sequence: 0, lifecycle: 'deliverable', roomName: 'Room A'
    });
  });

  test('significant changes preserve UID and monotonically advance sequence', () => {
    const ids = identities();
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), roomFact('Room A', 1), placeFact(occurrence()), engagementFact(engagement())
    ], ids.factory);
    state = project(state, [fact({ kind: 'occurrence_changed', version: 1, data: {
      action: 'move', occurrenceId: O1,
      occurrence: occurrence(O1, 2, '2026-09-01T03:00:00.000Z')
    } }, '2026-08-18T01:03:00.000Z')], ids.factory);
    state = project(state, [engagementFact(engagement('declined', 3), '2026-08-18T01:04:00.000Z')], ids.factory);
    expect(state.commitments[0]).toMatchObject({
      uid: 'commitment-1@calendar.jooevents', sequence: 2,
      lifecycle: 'cancelled', lastDtstamp: '2026-08-18T01:04:00.000Z'
    });
    expect(ids.commitmentCount()).toBe(1);
  });

  test('exact fact replay is inert and source identity conflict fails closed', () => {
    const ids = identities();
    const original = sessionFact(session());
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [original], ids.factory);
    state = project(state, [original], ids.factory);
    expect(state.processedSources).toHaveLength(1);
    const conflict = calendarCommitmentFactSchema.parse({
      ...original, occurredAt: '2026-08-18T01:05:00.000Z'
    });
    expect(() => project(state, [conflict], ids.factory)).toThrow('calendar_fact_identity_conflict');
  });

  test('adjacent unplace and re-place reincarnates the commitment within one open generation', () => {
    const ids = identities();
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), placeFact(occurrence()), engagementFact(engagement())
    ], ids.factory);
    state = project(state, [
      unplaceFact(O1, '2026-08-18T01:05:00.000Z'),
      placeFact(occurrence(O2, 1, '2026-09-01T04:00:00.000Z'), '2026-08-18T01:06:00.000Z')
    ], ids.factory);
    expect(state.commitments).toHaveLength(1);
    expect(state.commitments[0]).toMatchObject({
      occurrenceId: O2, uid: 'commitment-1@calendar.jooevents', sequence: 2, lifecycle: 'deliverable'
    });
    expect(ids.commitmentCount()).toBe(1);
  });

  test('pairs several interleaved occurrence reincarnations by deterministic unplace FIFO', () => {
    const ids = identities();
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()),
      placeFact(occurrence(O1, 1, '2026-09-01T02:00:00.000Z')),
      placeFact(occurrence(O2, 1, '2026-09-01T03:00:00.000Z')),
      engagementFact(engagement())
    ], ids.factory);
    expect(state.commitments.map((item) => [item.occurrenceId, item.uid])).toEqual([
      [O1, 'commitment-1@calendar.jooevents'],
      [O2, 'commitment-2@calendar.jooevents']
    ]);

    // Each fact crosses a projector/cursor boundary. O2 is unplaced first, so
    // the first later placement inherits O2's identity; O1 pairs with the next.
    state = project(state, [unplaceFact(O2, '2026-08-18T01:05:00.000Z')], ids.factory);
    state = project(state, [unplaceFact(O1, '2026-08-18T01:06:00.000Z')], ids.factory);
    state = project(state, [
      placeFact(occurrence(O3, 1, '2026-09-01T04:00:00.000Z'), '2026-08-18T01:07:00.000Z')
    ], ids.factory);
    state = project(state, [
      placeFact(occurrence(O4, 1, '2026-09-01T05:00:00.000Z'), '2026-08-18T01:08:00.000Z')
    ], ids.factory);

    expect(state.commitments.map((item) => [item.occurrenceId, item.uid, item.sequence])).toEqual([
      [O3, 'commitment-2@calendar.jooevents', 2],
      [O4, 'commitment-1@calendar.jooevents', 2]
    ]);
    expect(state.pendingReincarnations).toEqual([]);
    expect(ids.commitmentCount()).toBe(2);
    expect(ids.generationCount()).toBe(1);
  });

  test('an intervening fact ends reincarnation and a replacement gets a new UID', () => {
    const ids = identities();
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), roomFact('Room A', 1), placeFact(occurrence()), engagementFact(engagement())
    ], ids.factory);
    state = project(state, [
      unplaceFact(O1, '2026-08-18T01:05:00.000Z'),
      roomFact('Room B', 2, '2026-08-18T01:06:00.000Z'),
      placeFact(occurrence(O2, 1, '2026-09-01T04:00:00.000Z'), '2026-08-18T01:07:00.000Z')
    ], ids.factory);
    expect(state.commitments.map((item) => [item.uid, item.lifecycle])).toEqual([
      ['commitment-1@calendar.jooevents', 'cancelled'],
      ['commitment-2@calendar.jooevents', 'deliverable']
    ]);
  });

  test('session title and room rename are significant artifact changes', () => {
    const ids = identities();
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), roomFact('Room A', 1), placeFact(occurrence()), engagementFact(engagement())
    ], ids.factory);
    state = project(state, [
      sessionFact(session(2, 'Practical systems, revised'), '2026-08-18T01:08:00.000Z'),
      roomFact('Main Hall', 2, '2026-08-18T01:09:00.000Z')
    ], ids.factory);
    expect(state.commitments[0]).toMatchObject({
      sequence: 2, sessionTitle: 'Practical systems, revised', roomName: 'Main Hall'
    });
  });

  test('source-version churn that leaves the rendered artifact unchanged does not bump sequence', () => {
    const ids = identities();
    let state = project(createCalendarProjectorState({ workspaceId: W, eventId: E }), [
      sessionFact(session()), placeFact(occurrence()), engagementFact(engagement())
    ], ids.factory);
    state = project(state, [
      sessionFact(session(2), '2026-08-18T01:10:00.000Z'),
      engagementFact(engagement('confirmed', 3), '2026-08-18T01:11:00.000Z')
    ], ids.factory);
    expect(state.commitments[0]).toMatchObject({
      sequence: 0, sessionVersion: 2, engagementVersion: 3
    });
  });
});
