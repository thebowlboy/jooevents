import { describe, expect, test } from 'bun:test';
import { materializeCalendarCommitmentFacts } from '@jooevents/calendar';
import type { EngagementHeadDto, SessionHeadDto } from '@jooevents/contracts';
import { DECISION_DECIDE_OPERATION } from '@jooevents/decision-operations';
import { DEADLINE_CHANGE_OPERATION } from '@jooevents/deadline-operations';
import {
  ENGAGEMENT_CHANGE_OPERATION,
  PORTAL_ENGAGEMENT_RESPOND_OPERATION
} from '@jooevents/engagement-operations';
import {
  PROGRAM_VOCABULARY_CREATE_OPERATION,
  PROGRAM_VOCABULARY_EDIT_OPERATION,
  PROGRAM_VOCABULARY_MERGE_OPERATION
} from '@jooevents/program-operations';
import { SCHEDULE_PLACEMENT_OPERATION } from '@jooevents/schedule-operations';
import { SESSION_CHANGE_OPERATION } from '@jooevents/session-operations';
import { createCalendarCommitmentFactContributor } from './fact-contributor';

const W = '30000000-0000-4000-8000-000000000001';
const E = '30000000-0000-4000-8000-000000000002';
const S = '30000000-0000-4000-8000-000000000003';
const P1 = '30000000-0000-4000-8000-000000000004';
const P2 = '30000000-0000-4000-8000-000000000005';
const G1 = '30000000-0000-4000-8000-000000000006';
const G2 = '30000000-0000-4000-8000-000000000007';
const O = '30000000-0000-4000-8000-000000000008';
const R1 = '30000000-0000-4000-8000-000000000009';
const R2 = '30000000-0000-4000-8000-000000000010';
const F = '30000000-0000-4000-8000-000000000011';
const U = '30000000-0000-4000-8000-000000000012';
const D = 'b'.repeat(64);
const AT = '2026-08-18T03:00:00.000Z';

function head(personId = P1, id = G1): EngagementHeadDto {
  return {
    schemaVersion: 1, id, scope: { workspaceId: W, eventId: E }, sessionId: S, personId,
    submissionId: null, seededByDecision: null, state: 'confirmed',
    invitedAt: AT, respondBy: null,
    confirmation: { attribution: 'self', personId, recordedByUserId: null, confirmedAt: AT },
    cancellationRequest: null, cancelledAt: null,
    source: { kind: 'session', id: S, version: 1 }, version: 2
  };
}

function session(): SessionHeadDto {
  return {
    schemaVersion: 1, scope: { workspaceId: W, eventId: E }, id: S,
    title: 'Calendar facts', plannedDurationMinutes: 45, lifecycle: 'programmed',
    programTarget: {
      setVersion: 1, setDigestSha256: D,
      format: { kind: 'format', id: F, name: 'Talk', status: 'active', version: 1 }, track: null
    },
    roster: { version: 1, digestSha256: D, participants: [] },
    version: 1, digestSha256: D, createdByUserId: U, createdAt: AT,
    updatedByUserId: U, updatedAt: AT
  };
}

function contribute(operation: { name: string; version: number }, businessInput: unknown, canonicalResult: unknown) {
  return createCalendarCommitmentFactContributor().contribute({
    operation, businessInput, canonicalResult,
    scope: { workspaceId: W, eventId: E, subjects: [], resolutionEvidenceIds: [] },
    occurredAt: AT
  } as never);
}

describe('calendar operation fact contributor', () => {
  test('maps place, move, and unplace to their exact current occurrence images', () => {
    const placed = {
      id: O, sessionId: S, roomId: R1, startAt: '2026-09-01T10:00:00.000Z',
      endAt: '2026-09-01T10:45:00.000Z', version: 1
    };
    const batch = contribute(SCHEDULE_PLACEMENT_OPERATION, {
      action: 'place', expectedScheduleVersion: 1, sessionId: S, roomId: R1,
      startAt: '2026-09-01T10:00:00.000Z', endAt: '2026-09-01T10:45:00.000Z'
    }, { kind: 'success', data: {
      action: 'place', scheduleVersion: 2, occurrence: placed
    } });
    expect(batch).toMatchObject({ facts: [{
      kind: 'occurrence_changed', data: { action: 'place', occurrenceId: O }
    }] });
    expect(contribute(SCHEDULE_PLACEMENT_OPERATION, {
      action: 'move', expectedScheduleVersion: 2, occurrenceId: O,
      expectedOccurrenceVersion: 1, roomId: R2,
      startAt: '2026-09-01T11:00:00.000Z', endAt: '2026-09-01T11:45:00.000Z'
    }, { kind: 'success', data: {
      action: 'move', scheduleVersion: 3,
      occurrence: { ...placed, roomId: R2, startAt: '2026-09-01T11:00:00.000Z',
        endAt: '2026-09-01T11:45:00.000Z', version: 2 }
    } })).toMatchObject({ facts: [{
      kind: 'occurrence_changed', data: { action: 'move', occurrenceId: O,
        occurrence: { roomId: R2, version: 2 } }
    }] });
    expect(contribute(SCHEDULE_PLACEMENT_OPERATION, {
      action: 'unplace', expectedScheduleVersion: 3, occurrenceId: O,
      expectedOccurrenceVersion: 2
    }, { kind: 'success', data: {
      action: 'unplace', scheduleVersion: 4, occurrence: null
    } })).toMatchObject({ facts: [{
      kind: 'occurrence_changed', data: { action: 'unplace', occurrenceId: O, occurrence: null }
    }] });
  });

  test('emits organizer and grouped participant engagement heads', () => {
    const organizer = contribute(ENGAGEMENT_CHANGE_OPERATION, {}, {
      kind: 'success', data: { action: 'record_confirmation', engagement: head() }
    });
    expect(organizer).toMatchObject({ facts: [{ data: { engagement: { id: G1 } } }] });

    const participant = contribute(PORTAL_ENGAGEMENT_RESPOND_OPERATION, {}, {
      kind: 'success', data: {
        engagement: {
          id: G1, sessionId: S, sessionTitle: 'Calendar facts', submissionId: null,
          status: 'confirmed', invitedAt: AT, respondBy: null,
          confirmation: { by: 'you', at: AT },
          speakers: [{ participantId: P1, displayName: 'Maya' }]
        },
        changedEngagements: [head(), head(P2, G2)]
      }
    });
    expect(participant).toMatchObject({ facts: [
      { data: { engagement: { id: G1, personId: P1 } } },
      { data: { engagement: { id: G2, personId: P2 } } }
    ] });
    const materialized = materializeCalendarCommitmentFacts({
      operationLogId: '30000000-0000-4000-8000-000000000099',
      batch: participant as never
    });
    expect(materialized.map((fact) => fact.source.ordinal)).toEqual([0, 1]);
  });

  test('maps session and room mutations without reading persistence', () => {
    expect(contribute(SESSION_CHANGE_OPERATION, {}, {
      kind: 'success', data: { action: 'create', catalogVersion: 1, session: session() }
    })).toMatchObject({ facts: [{ kind: 'session_changed', data: { sessionId: S } }] });

    expect(contribute(DECISION_DECIDE_OPERATION, {}, {
      kind: 'success', data: {
        action: 'decide', rows: [{ submissionId: P1, head: null, origin: null }],
        sessions: [{ action: 'create', catalogVersion: 1, session: session() }]
      }
    })).toMatchObject({ facts: [{ kind: 'session_changed', data: { sessionId: S } }] });

    expect(contribute(PROGRAM_VOCABULARY_CREATE_OPERATION, {
      kind: 'room', expectedSetVersion: 1, name: 'Hall A', capacity: 100
    }, { kind: 'success', data: {
      action: 'create', kind: 'room', affectedIds: [R1], setVersion: 2, liveRepoints: 0
    } })).toMatchObject({ facts: [{
      kind: 'room_changed', data: { action: 'create', roomId: R1, name: 'Hall A', version: 1 }
    }] });

    expect(contribute(PROGRAM_VOCABULARY_EDIT_OPERATION, {
      kind: 'room', id: R1, expectedSetVersion: 2, expectedItemVersion: 1,
      changes: { name: 'Hall Alpha', capacity: 100 }
    }, { kind: 'success', data: {
      action: 'edit', kind: 'room', affectedIds: [R1], setVersion: 3, liveRepoints: 0
    } })).toMatchObject({ facts: [{
      kind: 'room_changed', data: { action: 'edit', roomId: R1, name: 'Hall Alpha', version: 2 }
    }] });

    expect(contribute(PROGRAM_VOCABULARY_MERGE_OPERATION, {}, {
      kind: 'success', data: {
        action: 'merge', kind: 'room', affectedIds: [R1, R2], setVersion: 3, liveRepoints: 4
      }
    })).toMatchObject({ facts: [{
      kind: 'room_changed', data: { action: 'merge', sourceRoomId: R1, targetRoomId: R2 }
    }] });
  });

  test('intakes the existing versioned deadline consequence without persistence reads', () => {
    expect(contribute(DEADLINE_CHANGE_OPERATION, {
      action: 'create', displayDate: '2026-09-03'
    }, {
      kind: 'success', data: {
        schemaVersion: 1,
        action: 'create',
        catalogVersion: 2,
        deadline: {
          schemaVersion: 1,
          id: '30000000-0000-4000-8000-000000000013',
          scope: { workspaceId: W, eventId: E },
          kind: 'task_due',
          version: 1,
          digestSha256: D,
          gracePolicy: 'soft',
          createdByUserId: U,
          createdAt: AT,
          updatedByUserId: U,
          updatedAt: AT,
          status: 'active',
          displayDate: '2026-09-03',
          effectiveAt: '2026-09-03T15:59:59.999Z',
          boundary: {
            profile: {
              key: 'deadline.calendar-date.event-local-end-exclusive',
              version: 1,
              digestSha256: D
            },
            eventTimezone: 'Asia/Singapore',
            eventVersion: 1,
            localBoundaryDate: '2026-09-04'
          }
        },
        pin: {
          id: '30000000-0000-4000-8000-000000000013', version: 1,
          digestSha256: D, effectiveAt: '2026-09-03T15:59:59.999Z',
          displayDate: '2026-09-03', gracePolicy: 'soft'
        }
      }
    })).toMatchObject({ facts: [{
      kind: 'deadline_changed',
      data: {
        action: 'create', deadlineId: '30000000-0000-4000-8000-000000000013',
        status: 'active', displayDate: '2026-09-03'
      }
    }] });
  });

  test('unrelated and refused operations emit nothing', () => {
    expect(contribute({ name: 'event.settings.update', version: 1 }, {}, {})).toBeUndefined();
    expect(contribute(ENGAGEMENT_CHANGE_OPERATION, {}, {
      kind: 'outcome', outcome: {
        class: 'conflict', kind: 'engagement.stale', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    })).toBeUndefined();
  });

  test('a complete source image from another event fails the fact scope contract', () => {
    const wrong = structuredClone(head());
    wrong.scope.eventId = '30000000-0000-4000-8000-000000000099';
    expect(() => contribute(ENGAGEMENT_CHANGE_OPERATION, {}, {
      kind: 'success', data: { action: 'record_confirmation', engagement: wrong }
    })).toThrow('complete source image must match the calendar fact batch scope');
  });
});
