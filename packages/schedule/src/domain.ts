import { createHash } from 'node:crypto';
import {
  schedulePlacementPlanningInputSchema,
  schedulePlacementPlanSchema,
  schedulePlacementResultSchema,
  type SchedulePlacementPlanningInput,
  type SchedulePlacementConflictDetail,
  type SchedulePlacementPlanDto,
  type SchedulePlacementResult
} from '@jooevents/contracts';
import { encodeCanonicalJson, parseAggregateVersion } from '@jooevents/kernel';
import {
  resolveProgramVocabularyItem,
  type ProgramVocabularyState
} from '@jooevents/program';
import {
  compareScheduleOccurrences,
  parseSchedulePlacementOccurrence,
  parseSchedulePlacementScope,
  parseScheduleOccurrenceId,
  parseScheduleSessionId,
  projectSchedulePlacementOccurrence,
  sameScheduleScope,
  resolvePlaceableSession,
  type PlaceableSessionIdentityPort,
  type SchedulePlacementOccurrence,
  type SchedulePlacementScope,
  type SchedulePlacementState
} from './model';

export type SchedulePlacementPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_schedule'
  | 'occurrence_exists'
  | 'occurrence_missing'
  | 'stale_occurrence'
  | 'session_missing'
  | 'room_missing'
  | 'room_retired'
  | 'room_overlap'
  | 'stale_room_query'
  | 'invalid_plan';

export class SchedulePlacementPlanningError extends Error {
  constructor(
    readonly code: SchedulePlacementPlanningErrorCode,
    readonly conflict?: SchedulePlacementConflictDetail
  ) {
    super(code);
    this.name = 'SchedulePlacementPlanningError';
  }
}

export function schedulePlacementGuardId(eventId: string): string {
  return `event_schedule:${eventId}`;
}

export function schedulePlacementRoomQueryGuardId(eventId: string, roomId: string): string {
  return `schedule_room_query:${eventId}:${roomId}`;
}

export function schedulePlacementStateDigest(state: SchedulePlacementState): string {
  return sha256({
    scope: state.scope,
    scheduleVersion: state.scheduleVersion,
    occurrences: state.occurrences.map(projectSchedulePlacementOccurrence)
  });
}

export function schedulePlacementRoomQueryGuard(
  state: SchedulePlacementState,
  roomId: string,
  excludingOccurrenceId?: string
): SchedulePlacementPlanDto['roomQueryGuard'] {
  const occurrences = state.occurrences
    .filter((occurrence) => occurrence.roomId === roomId && occurrence.id !== excludingOccurrenceId)
    .map(projectSchedulePlacementOccurrence);
  return Object.freeze({
    id: schedulePlacementRoomQueryGuardId(state.scope.eventId, roomId),
    version: state.scheduleVersion,
    digestSha256: sha256(occurrences)
  });
}

export function overlappingRoomOccurrences(input: {
  readonly state: SchedulePlacementState;
  readonly roomId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly excludingOccurrenceId?: string;
}): readonly SchedulePlacementOccurrence[] {
  return Object.freeze(input.state.occurrences
    .filter((occurrence) => occurrence.roomId === input.roomId
      && occurrence.id !== input.excludingOccurrenceId
      && input.startAt < occurrence.endAt
      && occurrence.startAt < input.endAt)
    .sort(compareScheduleOccurrences));
}

export function planSchedulePlacementMutation(input: {
  readonly planningInput: SchedulePlacementPlanningInput;
  readonly state: SchedulePlacementState;
  readonly sessions: PlaceableSessionIdentityPort;
  readonly vocabulary: ProgramVocabularyState;
}): SchedulePlacementPlanDto {
  const planningInput = schedulePlacementPlanningInputSchema.parse(input.planningInput);
  const scope = parseSchedulePlacementScope(planningInput.scope);
  assertScope(input.state.scope, scope);
  assertScope(input.vocabulary.scope, scope);
  if (input.state.scheduleVersion !== planningInput.expectedScheduleVersion) {
    throw new SchedulePlacementPlanningError('stale_schedule');
  }
  const existing = input.state.occurrences.find((occurrence) => occurrence.id === planningInput.occurrenceId);
  if (planningInput.action === 'place' && existing) {
    throw new SchedulePlacementPlanningError('occurrence_exists');
  }
  if (planningInput.action !== 'place') {
    if (!existing) throw new SchedulePlacementPlanningError('occurrence_missing');
    if (existing.version !== planningInput.expectedOccurrenceVersion) {
      throw new SchedulePlacementPlanningError('stale_occurrence');
    }
  }

  if (planningInput.action === 'unplace') {
    const before = projectSchedulePlacementOccurrence(existing!);
    return schedulePlacementPlanSchema.parse({
      input: planningInput,
      before,
      after: null,
      scheduleVersion: { before: input.state.scheduleVersion, after: input.state.scheduleVersion + 1 },
      roomQueryGuard: schedulePlacementRoomQueryGuard(input.state, existing!.roomId, existing!.id)
    });
  }

  const sessionId = planningInput.action === 'place'
    ? parseScheduleSessionId(planningInput.sessionId)
    : existing!.sessionId;
  const session = resolvePlaceableSession(input.sessions, scope, sessionId);
  if (!session || !sameScheduleScope(session.scope, scope) || session.id !== sessionId
      || (session.lifecycle !== 'collecting' && session.lifecycle !== 'programmed')) {
    throw new SchedulePlacementPlanningError('session_missing');
  }
  const room = resolveProgramVocabularyItem(input.vocabulary, 'room', planningInput.roomId);
  if (!room) throw new SchedulePlacementPlanningError('room_missing');
  if (room.status !== 'active') throw new SchedulePlacementPlanningError('room_retired');

  const overlaps = overlappingRoomOccurrences({
    state: input.state,
    roomId: planningInput.roomId,
    startAt: planningInput.startAt,
    endAt: planningInput.endAt,
    ...(existing ? { excludingOccurrenceId: existing.id } : {})
  });
  if (overlaps.length > 0) {
    throw new SchedulePlacementPlanningError('room_overlap', {
      severity: 'block',
      roomId: planningInput.roomId,
      requested: { startAt: planningInput.startAt, endAt: planningInput.endAt },
      conflicts: overlaps.map((occurrence) => ({
        occurrenceId: occurrence.id,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt
      }))
    });
  }
  const after = projectSchedulePlacementOccurrence(parseSchedulePlacementOccurrence({
    id: parseScheduleOccurrenceId(planningInput.occurrenceId),
    sessionId,
    roomId: planningInput.roomId,
    startAt: planningInput.startAt,
    endAt: planningInput.endAt,
    version: existing ? existing.version + 1 : 1
  }));
  return schedulePlacementPlanSchema.parse({
    input: planningInput,
    before: existing ? projectSchedulePlacementOccurrence(existing) : null,
    after,
    scheduleVersion: { before: input.state.scheduleVersion, after: input.state.scheduleVersion + 1 },
    roomQueryGuard: schedulePlacementRoomQueryGuard(input.state, planningInput.roomId, existing?.id)
  });
}

export function validateSchedulePlacementPlan(input: {
  readonly state: SchedulePlacementState;
  readonly sessions: PlaceableSessionIdentityPort;
  readonly vocabulary: ProgramVocabularyState;
  readonly plan: SchedulePlacementPlanDto;
}): SchedulePlacementPlanningErrorCode | undefined {
  let rebuilt: SchedulePlacementPlanDto;
  try {
    rebuilt = planSchedulePlacementMutation({
      planningInput: input.plan.input,
      state: input.state,
      sessions: input.sessions,
      vocabulary: input.vocabulary
    });
  } catch (error) {
    return error instanceof SchedulePlacementPlanningError ? error.code : 'invalid_plan';
  }
  const currentGuard = schedulePlacementRoomQueryGuard(
    input.state,
    roomFor(input.plan),
    input.plan.before?.id
  );
  if (canonical(currentGuard) !== canonical(input.plan.roomQueryGuard)) return 'stale_room_query';
  return canonical(rebuilt) === canonical(input.plan) ? undefined : 'invalid_plan';
}

export function applySchedulePlacementPlan(input: {
  readonly state: SchedulePlacementState;
  readonly sessions: PlaceableSessionIdentityPort;
  readonly vocabulary: ProgramVocabularyState;
  readonly plan: SchedulePlacementPlanDto;
}): { readonly state: SchedulePlacementState; readonly result: SchedulePlacementResult } {
  const refusal = validateSchedulePlacementPlan(input);
  if (refusal) throw new SchedulePlacementPlanningError(refusal);
  const occurrences = input.state.occurrences.filter((occurrence) => occurrence.id !== input.plan.input.occurrenceId);
  if (input.plan.after) occurrences.push(parseSchedulePlacementOccurrence(input.plan.after));
  occurrences.sort(compareScheduleOccurrences);
  const state: SchedulePlacementState = deepFreeze({
    scope: input.state.scope,
    scheduleVersion: parseAggregateVersion(input.plan.scheduleVersion.after),
    occurrences
  });
  return Object.freeze({
    state,
    result: schedulePlacementResultSchema.parse({
      action: input.plan.input.action,
      scheduleVersion: state.scheduleVersion,
      occurrence: input.plan.after
    })
  });
}

function assertScope(
  actual: { readonly workspaceId: string; readonly eventId: string },
  expected: SchedulePlacementScope
): void {
  if (actual.workspaceId !== expected.workspaceId || actual.eventId !== expected.eventId) {
    throw new SchedulePlacementPlanningError('wrong_scope');
  }
}

function roomFor(plan: SchedulePlacementPlanDto): string {
  return plan.after?.roomId ?? plan.before?.roomId ?? '';
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function canonical(value: unknown): string {
  return Buffer.from(encodeCanonicalJson(value)).toString('utf8');
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
