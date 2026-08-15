import {
  schedulePlacementIdSchema,
  schedulePlacementOccurrenceSchema,
  schedulePlacementScopeSchema,
  schedulePlacementSnapshotSchema,
  type SchedulePlacementOccurrenceDto,
  type SchedulePlacementSnapshotDto
} from '@jooevents/contracts';
import {
  parseAggregateVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type AggregateVersion,
  type Brand,
  type EventId,
  type Instant,
  type WorkspaceId
} from '@jooevents/kernel';

export type ScheduleOccurrenceId = Brand<string, 'ScheduleOccurrenceId'>;
export type ScheduleSessionId = Brand<string, 'ScheduleSessionId'>;

export interface SchedulePlacementScope {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

export interface SchedulePlacementOccurrence {
  readonly id: ScheduleOccurrenceId;
  readonly sessionId: ScheduleSessionId;
  readonly roomId: string;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly version: AggregateVersion;
}

export interface SchedulePlacementState {
  readonly scope: SchedulePlacementScope;
  readonly scheduleVersion: AggregateVersion;
  readonly occurrences: readonly SchedulePlacementOccurrence[];
}

export interface PlaceableSessionIdentity {
  readonly scope: SchedulePlacementScope;
  readonly id: ScheduleSessionId;
  readonly lifecycle: 'collecting' | 'programmed';
  /** Null only for legacy data or events whose vocabulary has no active tracks. */
  readonly trackId?: string | null;
}

/** Schedule placement imports session identity; it never creates or owns sessions. */
export interface PlaceableSessionIdentityPort {
  readPlaceableSession?(
    scope: SchedulePlacementScope,
    sessionId: ScheduleSessionId
  ): PlaceableSessionIdentity | undefined;
  /** Compatibility seam for pre-Session composition; new adapters implement readPlaceableSession. */
  readProgrammedSession?(
    scope: SchedulePlacementScope,
    sessionId: ScheduleSessionId
  ): ProgrammedSessionIdentity | undefined;
}

/** @deprecated Use PlaceableSessionIdentity. */
export interface ProgrammedSessionIdentity extends Omit<PlaceableSessionIdentity, 'lifecycle'> {
  readonly lifecycle: 'programmed';
}

/** @deprecated Compatibility seam while existing runtimes compose the canonical Session source. */
export interface ProgrammedSessionIdentityPort extends PlaceableSessionIdentityPort {
  readProgrammedSession(
    scope: SchedulePlacementScope,
    sessionId: ScheduleSessionId
  ): ProgrammedSessionIdentity | undefined;
}

export function resolvePlaceableSession(
  port: PlaceableSessionIdentityPort,
  scope: SchedulePlacementScope,
  sessionId: ScheduleSessionId
): PlaceableSessionIdentity | undefined {
  const resolved = port.readPlaceableSession?.(scope, sessionId)
    ?? port.readProgrammedSession?.(scope, sessionId);
  return resolved?.lifecycle === 'collecting' || resolved?.lifecycle === 'programmed'
    ? resolved
    : undefined;
}

export function parseScheduleOccurrenceId(value: unknown): ScheduleOccurrenceId {
  return schedulePlacementIdSchema.parse(value) as ScheduleOccurrenceId;
}

export function parseScheduleSessionId(value: unknown): ScheduleSessionId {
  return schedulePlacementIdSchema.parse(value) as ScheduleSessionId;
}

export function parseSchedulePlacementScope(value: unknown): SchedulePlacementScope {
  const scope = schedulePlacementScopeSchema.parse(value);
  return Object.freeze({
    workspaceId: parseWorkspaceId(scope.workspaceId),
    eventId: parseEventId(scope.eventId)
  });
}

export function parseSchedulePlacementOccurrence(value: unknown): SchedulePlacementOccurrence {
  const occurrence = schedulePlacementOccurrenceSchema.parse(value);
  return Object.freeze({
    id: parseScheduleOccurrenceId(occurrence.id),
    sessionId: parseScheduleSessionId(occurrence.sessionId),
    roomId: schedulePlacementIdSchema.parse(occurrence.roomId),
    startAt: parseInstant(occurrence.startAt),
    endAt: parseInstant(occurrence.endAt),
    version: parseAggregateVersion(occurrence.version)
  });
}

export function parseSchedulePlacementState(value: unknown): SchedulePlacementState {
  const state = schedulePlacementSnapshotSchema.parse(value);
  return deepFreeze({
    scope: parseSchedulePlacementScope(state.scope),
    scheduleVersion: parseAggregateVersion(state.scheduleVersion),
    occurrences: state.occurrences.map(parseSchedulePlacementOccurrence)
  });
}

export function projectSchedulePlacementState(state: SchedulePlacementState): SchedulePlacementSnapshotDto {
  return schedulePlacementSnapshotSchema.parse({
    schemaVersion: 1,
    scope: state.scope,
    scheduleVersion: state.scheduleVersion,
    occurrences: state.occurrences.map(projectSchedulePlacementOccurrence)
  });
}

export function projectSchedulePlacementOccurrence(
  occurrence: SchedulePlacementOccurrence
): SchedulePlacementOccurrenceDto {
  return schedulePlacementOccurrenceSchema.parse(occurrence);
}

export function sameScheduleScope(
  left: SchedulePlacementScope,
  right: SchedulePlacementScope
): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function compareScheduleOccurrences(
  left: SchedulePlacementOccurrence,
  right: SchedulePlacementOccurrence
): number {
  if (left.startAt !== right.startAt) return left.startAt < right.startAt ? -1 : 1;
  if (left.endAt !== right.endAt) return left.endAt < right.endAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
