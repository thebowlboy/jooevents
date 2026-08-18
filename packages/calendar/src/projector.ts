import {
  calendarCommitmentFactSchema,
  calendarScopeSchema,
  type CalendarCommitmentFact,
  type CalendarScope
} from '@jooevents/contracts/calendar';
import type { EngagementHeadDto } from '@jooevents/contracts';
import type { DeadlineChangedFactPayload } from '@jooevents/contracts/deadlines';
import type { SchedulePlacementOccurrenceDto } from '@jooevents/contracts/schedule-placement';
import type { SessionHeadDto } from '@jooevents/contracts/sessions';
import { canonicalJsonText } from '@jooevents/kernel';

export type CalendarCommitmentLifecycle = 'deliverable' | 'embargoed' | 'cancelled';

export interface CalendarCommitmentProjection {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly sessionId: string;
  readonly occurrenceId: string;
  readonly uid: string;
  readonly sequence: number;
  readonly lastDtstamp: string;
  readonly lifecycle: CalendarCommitmentLifecycle;
  readonly sessionTitle: string;
  readonly sessionVersion: number;
  readonly engagementVersion: number;
  readonly occurrenceVersion: number;
  readonly startAt: string;
  readonly endAt: string;
  readonly roomId: string;
  readonly roomName: string | null;
  readonly embargoed: boolean;
}

export interface CalendarProjectorState {
  readonly schemaVersion: 1;
  readonly scope: CalendarScope;
  readonly sessions: readonly SessionHeadDto[];
  readonly occurrences: readonly SchedulePlacementOccurrenceDto[];
  readonly engagements: readonly EngagementHeadDto[];
  readonly rooms: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly status: 'active' | 'retired' | 'deleted';
    readonly version: number;
  }[];
  readonly deadlines: readonly DeadlineChangedFactPayload[];
  readonly commitments: readonly CalendarCommitmentProjection[];
  readonly processedSources: readonly { readonly key: string; readonly canonicalFact: string }[];
  readonly openNoticeGenerationId: string | null;
  readonly pendingReincarnations: readonly {
    readonly personId: string;
    readonly sessionId: string;
    readonly occurrenceId: string;
    readonly generationId: string;
    /** Cursor intake order, used as the deterministic FIFO pairing rule. */
    readonly intakeOrder: number;
  }[];
}

export interface CalendarProjectorIdentityFactory {
  mintCommitment(input: {
    readonly scope: CalendarScope;
    readonly personId: string;
    readonly sessionId: string;
    readonly occurrenceId: string;
  }): Readonly<{ id: string; uid: string }>;
  mintNoticeGeneration(scope: CalendarScope): string;
}

type MutableState = {
  scope: CalendarScope;
  sessions: Map<string, SessionHeadDto>;
  occurrences: Map<string, SchedulePlacementOccurrenceDto>;
  engagements: Map<string, EngagementHeadDto>;
  rooms: Map<string, { id: string; name: string | null; status: 'active' | 'retired' | 'deleted'; version: number }>;
  deadlines: Map<string, DeadlineChangedFactPayload>;
  commitments: Map<string, CalendarCommitmentProjection>;
  processedSources: Map<string, string>;
  openNoticeGenerationId: string | null;
  pendingReincarnations: Map<string, {
    personId: string;
    sessionId: string;
    occurrenceId: string;
    generationId: string;
    intakeOrder: number;
  }>;
};

function commitmentKey(personId: string, sessionId: string, occurrenceId: string): string {
  return `${personId}\u0000${sessionId}\u0000${occurrenceId}`;
}

function sourceKey(fact: CalendarCommitmentFact): string {
  return `${fact.source.operationLogId}:${fact.source.ordinal}`;
}

function mutable(state: CalendarProjectorState): MutableState {
  return {
    scope: calendarScopeSchema.parse(state.scope),
    sessions: new Map(state.sessions.map((item) => [item.id, structuredClone(item)])),
    occurrences: new Map(state.occurrences.map((item) => [item.id, structuredClone(item)])),
    engagements: new Map(state.engagements.map((item) => [item.id, structuredClone(item)])),
    rooms: new Map(state.rooms.map((item) => [item.id, { ...item }])),
    deadlines: new Map(state.deadlines.map((item) => [item.deadlineId, { ...item }])),
    commitments: new Map(state.commitments.map((item) => [
      commitmentKey(item.personId, item.sessionId, item.occurrenceId),
      { ...item }
    ])),
    processedSources: new Map(state.processedSources.map((item) => [item.key, item.canonicalFact])),
    openNoticeGenerationId: state.openNoticeGenerationId,
    pendingReincarnations: new Map(state.pendingReincarnations.map((item) => [
      commitmentKey(item.personId, item.sessionId, item.occurrenceId), { ...item }
    ]))
  };
}

function ordered<Value>(values: Iterable<Value>, key: (value: Value) => string): readonly Value[] {
  return Object.freeze([...values].sort((left, right) => key(left).localeCompare(key(right))));
}

function freezeState(state: MutableState): CalendarProjectorState {
  return Object.freeze({
    schemaVersion: 1 as const,
    scope: Object.freeze({ ...state.scope }),
    sessions: ordered(state.sessions.values(), (item) => item.id).map((item) => Object.freeze(item)),
    occurrences: ordered(state.occurrences.values(), (item) => item.id).map((item) => Object.freeze(item)),
    engagements: ordered(state.engagements.values(), (item) => item.id).map((item) => Object.freeze(item)),
    rooms: ordered(state.rooms.values(), (item) => item.id).map((item) => Object.freeze(item)),
    deadlines: ordered(state.deadlines.values(), (item) => item.deadlineId)
      .map((item) => Object.freeze(item)),
    commitments: ordered(
      state.commitments.values(),
      (item) => commitmentKey(item.personId, item.sessionId, item.occurrenceId)
    ).map((item) => Object.freeze(item)),
    processedSources: Object.freeze([...state.processedSources.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, canonicalFact]) => Object.freeze({ key, canonicalFact }))),
    openNoticeGenerationId: state.openNoticeGenerationId,
    pendingReincarnations: ordered(
      state.pendingReincarnations.values(),
      (item) => commitmentKey(item.personId, item.sessionId, item.occurrenceId)
    ).map((item) => Object.freeze(item))
  });
}

export function createCalendarProjectorState(scope: CalendarScope): CalendarProjectorState {
  return freezeState({
    scope: calendarScopeSchema.parse(scope),
    sessions: new Map(),
    occurrences: new Map(),
    engagements: new Map(),
    rooms: new Map(),
    deadlines: new Map(),
    commitments: new Map(),
    processedSources: new Map(),
    openNoticeGenerationId: null,
    pendingReincarnations: new Map()
  });
}

function noticeGeneration(state: MutableState, identities: CalendarProjectorIdentityFactory): string {
  if (state.openNoticeGenerationId === null) {
    state.openNoticeGenerationId = identities.mintNoticeGeneration(state.scope);
  }
  return state.openNoticeGenerationId;
}

function rosterPersonIds(session: SessionHeadDto): Set<string> {
  return new Set(session.roster.participants.map((participant) => participant.personId));
}

function confirmedPeople(state: MutableState, session: SessionHeadDto): Map<string, EngagementHeadDto> {
  const roster = rosterPersonIds(session);
  return new Map([...state.engagements.values()]
    .filter((engagement) => engagement.sessionId === session.id
      && engagement.state === 'confirmed'
      && roster.has(engagement.personId))
    .map((engagement) => [engagement.personId, engagement]));
}

function cancelCommitment(input: {
  state: MutableState;
  commitment: CalendarCommitmentProjection;
  occurredAt: string;
  identities: CalendarProjectorIdentityFactory;
  reincarnatable: boolean;
}): void {
  if (input.commitment.lifecycle === 'cancelled') return;
  const generationId = noticeGeneration(input.state, input.identities);
  const cancelled = Object.freeze({
    ...input.commitment,
    lifecycle: 'cancelled' as const,
    sequence: input.commitment.sequence + 1,
    lastDtstamp: input.occurredAt
  });
  input.state.commitments.set(
    commitmentKey(cancelled.personId, cancelled.sessionId, cancelled.occurrenceId),
    cancelled
  );
  if (input.reincarnatable) {
    input.state.pendingReincarnations.set(
      commitmentKey(cancelled.personId, cancelled.sessionId, cancelled.occurrenceId),
      {
        personId: cancelled.personId,
        sessionId: cancelled.sessionId,
        occurrenceId: cancelled.occurrenceId,
        generationId,
        intakeOrder: input.state.processedSources.size
      }
    );
  }
}

function takeReincarnation(
  state: MutableState,
  personId: string,
  sessionId: string
): CalendarCommitmentProjection | undefined {
  const candidates = [...state.pendingReincarnations.values()]
    .filter((pending) => pending.personId === personId
      && pending.sessionId === sessionId
      && pending.generationId === state.openNoticeGenerationId)
    .sort((left, right) => left.intakeOrder - right.intakeOrder
      || left.occurrenceId.localeCompare(right.occurrenceId));
  for (const pending of candidates) {
    const key = commitmentKey(pending.personId, pending.sessionId, pending.occurrenceId);
    const commitment = state.commitments.get(key);
    state.pendingReincarnations.delete(key);
    if (commitment) state.commitments.delete(key);
    return commitment;
  }
  return undefined;
}

function desiredProjection(input: {
  state: MutableState;
  session: SessionHeadDto;
  engagement: EngagementHeadDto;
  occurrence: SchedulePlacementOccurrenceDto;
}): Pick<CalendarCommitmentProjection,
  'sessionTitle' | 'sessionVersion' | 'engagementVersion' | 'occurrenceVersion'
  | 'startAt' | 'endAt' | 'roomId' | 'roomName'> {
  return {
    sessionTitle: input.session.title,
    sessionVersion: input.session.version,
    engagementVersion: input.engagement.version,
    occurrenceVersion: input.occurrence.version,
    startAt: input.occurrence.startAt,
    endAt: input.occurrence.endAt,
    roomId: input.occurrence.roomId,
    roomName: input.state.rooms.get(input.occurrence.roomId)?.name ?? null
  };
}

function ensureCommitment(input: {
  state: MutableState;
  session: SessionHeadDto;
  engagement: EngagementHeadDto;
  occurrence: SchedulePlacementOccurrenceDto;
  occurredAt: string;
  identities: CalendarProjectorIdentityFactory;
  mayReincarnate: boolean;
}): void {
  const key = commitmentKey(input.engagement.personId, input.session.id, input.occurrence.id);
  const desired = desiredProjection(input);
  let current = input.state.commitments.get(key);
  if (!current && input.mayReincarnate) {
    current = takeReincarnation(input.state, input.engagement.personId, input.session.id);
  }
  if (!current) {
    const identity = input.identities.mintCommitment({
      scope: input.state.scope,
      personId: input.engagement.personId,
      sessionId: input.session.id,
      occurrenceId: input.occurrence.id
    });
    noticeGeneration(input.state, input.identities);
    input.state.commitments.set(key, Object.freeze({
      ...identity,
      workspaceId: input.state.scope.workspaceId,
      eventId: input.state.scope.eventId,
      personId: input.engagement.personId,
      sessionId: input.session.id,
      occurrenceId: input.occurrence.id,
      uid: identity.uid,
      sequence: 0,
      lastDtstamp: input.occurredAt,
      lifecycle: 'deliverable',
      ...desired,
      embargoed: false
    }));
    return;
  }
  const changed = current.lifecycle !== 'deliverable'
    || current.occurrenceId !== input.occurrence.id
    || current.sessionTitle !== desired.sessionTitle
    || current.startAt !== desired.startAt
    || current.endAt !== desired.endAt
    || current.roomId !== desired.roomId
    || current.roomName !== desired.roomName;
  const next = Object.freeze({
    ...current,
    personId: input.engagement.personId,
    sessionId: input.session.id,
    occurrenceId: input.occurrence.id,
    lifecycle: 'deliverable' as const,
    ...desired,
    ...(changed ? { sequence: current.sequence + 1, lastDtstamp: input.occurredAt } : {})
  });
  input.state.commitments.set(key, next);
}

function reconcileSession(input: {
  state: MutableState;
  sessionId: string;
  occurredAt: string;
  identities: CalendarProjectorIdentityFactory;
  unplacedOccurrenceId?: string;
  mayReincarnate?: boolean;
}): void {
  const session = input.state.sessions.get(input.sessionId);
  const occurrences = [...input.state.occurrences.values()]
    .filter((occurrence) => occurrence.sessionId === input.sessionId);
  const people = session ? confirmedPeople(input.state, session) : new Map<string, EngagementHeadDto>();
  const desired = new Set<string>();
  if (session) {
    for (const occurrence of occurrences) {
      for (const engagement of people.values()) {
        const key = commitmentKey(engagement.personId, session.id, occurrence.id);
        desired.add(key);
        ensureCommitment({
          state: input.state,
          session,
          engagement,
          occurrence,
          occurredAt: input.occurredAt,
          identities: input.identities,
          mayReincarnate: input.mayReincarnate === true
        });
      }
    }
  }
  for (const [key, commitment] of [...input.state.commitments.entries()]) {
    if (commitment.sessionId !== input.sessionId || desired.has(key)) continue;
    cancelCommitment({
      state: input.state,
      commitment,
      occurredAt: input.occurredAt,
      identities: input.identities,
      reincarnatable: commitment.occurrenceId === input.unplacedOccurrenceId
    });
  }
}

function pendingReincarnationContinuation(
  state: MutableState,
  fact: CalendarCommitmentFact
): Readonly<{ retain: boolean; mayReincarnate: boolean }> {
  if (state.pendingReincarnations.size === 0
      || fact.fact.kind !== 'occurrence_changed') {
    return { retain: false, mayReincarnate: false };
  }
  const { action, occurrenceId, occurrence } = fact.fact.data;
  const sessionId = occurrence?.sessionId ?? state.occurrences.get(occurrenceId)?.sessionId;
  const sameSession = sessionId !== undefined && [...state.pendingReincarnations.values()]
    .some((pending) => pending.sessionId === sessionId);
  if (!sameSession) return { retain: false, mayReincarnate: false };
  return {
    retain: action === 'unplace' || (action === 'place' && occurrence !== null),
    mayReincarnate: action === 'place' && occurrence !== null
  };
}

function applyOne(
  state: MutableState,
  candidate: CalendarCommitmentFact,
  identities: CalendarProjectorIdentityFactory
): void {
  const fact = calendarCommitmentFactSchema.parse(candidate);
  if (fact.scope.workspaceId !== state.scope.workspaceId || fact.scope.eventId !== state.scope.eventId) {
    throw new TypeError('calendar_fact_wrong_scope');
  }
  const key = sourceKey(fact);
  const canonical = canonicalJsonText(fact);
  const existing = state.processedSources.get(key);
  if (existing !== undefined) {
    if (existing !== canonical) throw new TypeError('calendar_fact_identity_conflict');
    return;
  }
  const continuation = pendingReincarnationContinuation(state, fact);
  if (!continuation.retain) state.pendingReincarnations.clear();

  if (fact.fact.kind === 'session_changed') {
    const { sessionId, session } = fact.fact.data;
    if (session === null) state.sessions.delete(sessionId);
    else state.sessions.set(sessionId, session);
    reconcileSession({ state, sessionId, occurredAt: fact.occurredAt, identities });
  } else if (fact.fact.kind === 'engagement_changed') {
    const { engagement } = fact.fact.data;
    state.engagements.set(engagement.id, engagement);
    reconcileSession({ state, sessionId: engagement.sessionId, occurredAt: fact.occurredAt, identities });
  } else if (fact.fact.kind === 'occurrence_changed') {
    const { action, occurrenceId, occurrence } = fact.fact.data;
    const before = state.occurrences.get(occurrenceId);
    if (action === 'unplace') state.occurrences.delete(occurrenceId);
    else if (occurrence) state.occurrences.set(occurrenceId, occurrence);
    const sessionId = occurrence?.sessionId ?? before?.sessionId;
    if (!sessionId) throw new TypeError('calendar_occurrence_source_missing');
    reconcileSession({
      state,
      sessionId,
      occurredAt: fact.occurredAt,
      identities,
      ...(action === 'unplace' ? { unplacedOccurrenceId: occurrenceId } : {}),
      ...(continuation.mayReincarnate ? { mayReincarnate: true } : {})
    });
  } else if (fact.fact.kind === 'room_changed') {
    const room = fact.fact.data;
    if (room.action === 'create' || room.action === 'edit') {
      state.rooms.set(room.roomId, {
        id: room.roomId, name: room.name, status: 'active', version: room.version
      });
    } else if (room.action === 'retire' || room.action === 'restore') {
      const current = state.rooms.get(room.roomId);
      state.rooms.set(room.roomId, {
        id: room.roomId,
        name: current?.name ?? null,
        status: room.status,
        version: room.version
      });
    } else if (room.action === 'delete') {
      state.rooms.set(room.roomId, { id: room.roomId, name: null, status: 'deleted', version: 1 });
    } else if (room.action === 'merge') {
      for (const [occurrenceId, occurrence] of state.occurrences) {
        if (occurrence.roomId !== room.sourceRoomId) continue;
        state.occurrences.set(occurrenceId, Object.freeze({
          ...occurrence,
          roomId: room.targetRoomId,
          version: occurrence.version + 1
        }));
      }
    }
    const affectedRoomId = room.action === 'merge' ? room.targetRoomId : room.roomId;
    const affectedSessions = new Set([...state.occurrences.values()]
      .filter((occurrence) => occurrence.roomId === affectedRoomId)
      .map((occurrence) => occurrence.sessionId));
    for (const sessionId of affectedSessions) {
      reconcileSession({ state, sessionId, occurredAt: fact.occurredAt, identities });
    }
  } else {
    state.deadlines.set(fact.fact.data.deadlineId, fact.fact.data);
  }
  state.processedSources.set(key, canonical);
}

export function projectCalendarCommitmentFacts(input: {
  readonly state: CalendarProjectorState;
  readonly facts: readonly CalendarCommitmentFact[];
  readonly identities: CalendarProjectorIdentityFactory;
}): CalendarProjectorState {
  const state = mutable(input.state);
  for (const fact of input.facts) applyOne(state, fact, input.identities);
  return freezeState(state);
}
