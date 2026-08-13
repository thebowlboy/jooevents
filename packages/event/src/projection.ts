import {
  currentEventProjectionSchema,
  eventSchema,
  type CurrentEventProjection,
  type EventDto
} from '@jooevents/contracts';
import type { Event, WorkspaceEventSet } from './model';

export type EventProjectionErrorCode =
  | 'unexpected_event'
  | 'current_event_missing'
  | 'current_event_mismatch'
  | 'wrong_workspace';

export class EventProjectionError extends TypeError {
  readonly code: EventProjectionErrorCode;

  constructor(code: EventProjectionErrorCode) {
    super(code);
    this.name = 'EventProjectionError';
    this.code = code;
  }
}

export function projectEvent(event: Event): EventDto {
  return eventSchema.parse({
    id: event.id,
    name: event.name,
    timezone: event.timezone,
    startDate: event.startDate,
    endDate: event.endDate,
    version: event.version
  });
}

export function projectCurrentEvent(
  eventSet: WorkspaceEventSet,
  currentEvent: Event | undefined
): CurrentEventProjection {
  if (eventSet.currentEventId === null) {
    if (currentEvent !== undefined) throw new EventProjectionError('unexpected_event');
    return currentEventProjectionSchema.parse({
      schemaVersion: 1,
      kind: 'no_event',
      eventSetVersion: eventSet.version
    });
  }
  if (!currentEvent) throw new EventProjectionError('current_event_missing');
  if (currentEvent.id !== eventSet.currentEventId) {
    throw new EventProjectionError('current_event_mismatch');
  }
  if (currentEvent.workspaceId !== eventSet.workspaceId) {
    throw new EventProjectionError('wrong_workspace');
  }
  return currentEventProjectionSchema.parse({
    schemaVersion: 1,
    kind: 'current_event',
    eventSetVersion: eventSet.version,
    event: projectEvent(currentEvent)
  });
}
