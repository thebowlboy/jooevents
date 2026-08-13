import {
  parseAggregateVersion,
  parseEventId,
  parseIanaTimezone,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type AggregateVersion,
  type Brand,
  type EventId,
  type IanaTimezone,
  type Instant,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';

const EVENT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EVENT_NAME_LIMIT = 200;

export type EventDate = Brand<string, 'EventDate'>;

export type EventValidationErrorCode =
  | 'invalid_event_id'
  | 'invalid_workspace_id'
  | 'invalid_event_name'
  | 'invalid_event_timezone'
  | 'invalid_event_date'
  | 'invalid_event_date_range'
  | 'invalid_event_version'
  | 'invalid_event_attribution'
  | 'invalid_event_timestamp'
  | 'invalid_event_set_version'
  | 'invalid_current_event_id';

export class EventValidationError extends TypeError {
  readonly code: EventValidationErrorCode;

  constructor(code: EventValidationErrorCode) {
    super(code);
    this.name = 'EventValidationError';
    this.code = code;
  }
}

export interface Event {
  readonly id: EventId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly timezone: IanaTimezone;
  readonly startDate: EventDate;
  readonly endDate: EventDate;
  readonly version: AggregateVersion;
  readonly createdByUserId: UserId;
  readonly createdAt: Instant;
}

export interface WorkspaceEventSet {
  readonly workspaceId: WorkspaceId;
  readonly version: AggregateVersion;
  readonly currentEventId: EventId | null;
}

export interface EventStateInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly version: number;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface WorkspaceEventSetInput {
  readonly workspaceId: string;
  readonly version: number;
  readonly currentEventId: string | null;
}

function parsed<Value>(read: () => Value, code: EventValidationErrorCode): Value {
  try {
    return read();
  } catch {
    throw new EventValidationError(code);
  }
}

export function normalizeEventName(value: unknown): string {
  if (typeof value !== 'string') throw new EventValidationError('invalid_event_name');
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0 || normalized.length > EVENT_NAME_LIMIT) {
    throw new EventValidationError('invalid_event_name');
  }
  return normalized;
}

export function parseEventDate(value: unknown): EventDate {
  if (typeof value !== 'string') throw new EventValidationError('invalid_event_date');
  const match = EVENT_DATE.exec(value);
  if (!match || match[1] === '0000') throw new EventValidationError('invalid_event_date');
  const parsedDate = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) {
    throw new EventValidationError('invalid_event_date');
  }
  return value as EventDate;
}

export function createEvent(input: EventStateInput): Event {
  const startDate = parseEventDate(input.startDate);
  const endDate = parseEventDate(input.endDate);
  if (endDate < startDate) throw new EventValidationError('invalid_event_date_range');
  return Object.freeze({
    id: parsed(() => parseEventId(input.id), 'invalid_event_id'),
    workspaceId: parsed(() => parseWorkspaceId(input.workspaceId), 'invalid_workspace_id'),
    name: normalizeEventName(input.name),
    timezone: parsed(() => parseIanaTimezone(input.timezone), 'invalid_event_timezone'),
    startDate,
    endDate,
    version: parsed(() => parseAggregateVersion(input.version), 'invalid_event_version'),
    createdByUserId: parsed(() => parseUserId(input.createdByUserId), 'invalid_event_attribution'),
    createdAt: parsed(() => parseInstant(input.createdAt), 'invalid_event_timestamp')
  });
}

/** Rehydrates already-canonical Event state and refuses any byte that needs normalization. */
export function parseEventState(input: EventStateInput): Event {
  const event = createEvent(input);
  if (event.id !== input.id) throw new EventValidationError('invalid_event_id');
  if (event.workspaceId !== input.workspaceId) throw new EventValidationError('invalid_workspace_id');
  if (event.name !== input.name) throw new EventValidationError('invalid_event_name');
  if (event.timezone !== input.timezone) throw new EventValidationError('invalid_event_timezone');
  if (event.startDate !== input.startDate || event.endDate !== input.endDate) {
    throw new EventValidationError('invalid_event_date');
  }
  if (event.version !== input.version) throw new EventValidationError('invalid_event_version');
  if (event.createdByUserId !== input.createdByUserId) {
    throw new EventValidationError('invalid_event_attribution');
  }
  if (event.createdAt !== input.createdAt) throw new EventValidationError('invalid_event_timestamp');
  return event;
}

export function createWorkspaceEventSet(input: WorkspaceEventSetInput): WorkspaceEventSet {
  return Object.freeze({
    workspaceId: parsed(() => parseWorkspaceId(input.workspaceId), 'invalid_workspace_id'),
    version: parsed(() => parseAggregateVersion(input.version), 'invalid_event_set_version'),
    currentEventId: input.currentEventId === null
      ? null
      : parsed(() => parseEventId(input.currentEventId), 'invalid_current_event_id')
  });
}

/** Rehydrates an already-canonical workspace Event set without normalizing stored IDs. */
export function parseWorkspaceEventSetState(input: WorkspaceEventSetInput): WorkspaceEventSet {
  const eventSet = createWorkspaceEventSet(input);
  if (eventSet.workspaceId !== input.workspaceId) {
    throw new EventValidationError('invalid_workspace_id');
  }
  if (eventSet.version !== input.version) {
    throw new EventValidationError('invalid_event_set_version');
  }
  if (eventSet.currentEventId !== input.currentEventId) {
    throw new EventValidationError('invalid_current_event_id');
  }
  return eventSet;
}

export function sameEventScope(
  event: Pick<Event, 'workspaceId'>,
  eventSet: Pick<WorkspaceEventSet, 'workspaceId'>
): boolean {
  return event.workspaceId === eventSet.workspaceId;
}
