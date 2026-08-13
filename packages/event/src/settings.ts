import {
  eventSettingsGeometrySchema,
  eventSettingsLocationSchema,
  eventSettingsSchema,
  eventSettingsScopeSchema,
  eventSettingsUpdateAuthorInputSchema,
  eventSettingsVenueNoteSchema,
  type EventSettingsDto,
  type EventSettingsScope,
  type EventSettingsSlotMinutes,
  type EventSettingsUpdateAuthorInput
} from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/changesets';
import {
  parseAggregateVersion,
  parseEventId,
  parseWorkspaceId,
  type AggregateVersion,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import { workspaceEventSetDigest } from './domain';
import {
  createEvent,
  parseEventState,
  parseWorkspaceEventSetState,
  type Event,
  type WorkspaceEventSet
} from './model';

export type EventSettingsPlanningErrorCode =
  | 'wrong_scope'
  | 'current_event_missing'
  | 'selection_changed'
  | 'stale_event_set'
  | 'stale_event'
  | 'settings_changed'
  | 'no_changes'
  | 'invalid_plan';

export class EventSettingsPlanningError extends Error {
  constructor(readonly code: EventSettingsPlanningErrorCode) {
    super(code);
    this.name = 'EventSettingsPlanningError';
  }
}

export interface EventSettingsCompanion {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
  readonly eventVersion: AggregateVersion;
  readonly location: string;
  readonly venueNote: string;
  readonly dayStart: string | null;
  readonly dayEnd: string | null;
  readonly slotMinutes: EventSettingsSlotMinutes | null;
}

export interface EventSettingsCompanionInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly location: string;
  readonly venueNote: string;
  readonly dayStart: string | null;
  readonly dayEnd: string | null;
  readonly slotMinutes: number | null;
}

export interface EventSettingsState {
  readonly eventSet: WorkspaceEventSet;
  readonly event: Event;
  readonly companion: EventSettingsCompanion;
}

export interface EventSettingsUpdatePlan {
  readonly action: 'update';
  readonly scope: EventSettingsScope;
  readonly selection: {
    readonly eventId: string;
    readonly eventSetVersion: number;
    readonly eventSetGuardDigestSha256: string;
  };
  readonly expectedEventVersion: number;
  readonly resultingEventVersion: number;
  readonly before: EventSettingsDto;
  readonly after: EventSettingsDto;
}

function freezeState(state: EventSettingsState): EventSettingsState {
  return Object.freeze({
    eventSet: state.eventSet,
    event: state.event,
    companion: state.companion
  });
}

export function parseEventSettingsCompanion(
  input: EventSettingsCompanionInput
): EventSettingsCompanion {
  try {
    const location = eventSettingsLocationSchema.parse(input.location);
    const venueNote = eventSettingsVenueNoteSchema.parse(input.venueNote);
    const geometry = eventSettingsGeometrySchema.parse({
      dayStart: input.dayStart,
      dayEnd: input.dayEnd,
      slotMinutes: input.slotMinutes
    });
    const companion = Object.freeze({
      workspaceId: parseWorkspaceId(input.workspaceId),
      eventId: parseEventId(input.eventId),
      eventVersion: parseAggregateVersion(input.eventVersion),
      location,
      venueNote,
      dayStart: geometry.dayStart,
      dayEnd: geometry.dayEnd,
      slotMinutes: geometry.slotMinutes
    });
    if (companion.workspaceId !== input.workspaceId
        || companion.eventId !== input.eventId
        || companion.eventVersion !== input.eventVersion
        || companion.location !== input.location
        || companion.venueNote !== input.venueNote
        || companion.dayStart !== input.dayStart
        || companion.dayEnd !== input.dayEnd
        || companion.slotMinutes !== input.slotMinutes) {
      throw new TypeError('event_settings_companion_not_canonical');
    }
    return companion;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'event_settings_companion_not_canonical') {
      throw error;
    }
    throw new TypeError('invalid_event_settings_companion');
  }
}

export function parseEventSettingsState(input: EventSettingsState): EventSettingsState {
  try {
    const eventSet = parseWorkspaceEventSetState(input.eventSet);
    const event = parseEventState(input.event);
    const companion = parseEventSettingsCompanion(input.companion);
    if (eventSet.currentEventId === null) {
      throw new EventSettingsPlanningError('current_event_missing');
    }
    if (eventSet.workspaceId !== event.workspaceId
        || eventSet.workspaceId !== companion.workspaceId) {
      throw new EventSettingsPlanningError('wrong_scope');
    }
    if (eventSet.currentEventId !== event.id || event.id !== companion.eventId) {
      throw new EventSettingsPlanningError('selection_changed');
    }
    if (event.version !== companion.eventVersion) {
      throw new EventSettingsPlanningError('settings_changed');
    }
    return freezeState({ eventSet, event, companion });
  } catch (error) {
    if (error instanceof EventSettingsPlanningError) throw error;
    throw new EventSettingsPlanningError('invalid_plan');
  }
}

export function projectEventSettings(state: EventSettingsState): EventSettingsDto {
  const current = parseEventSettingsState(state);
  return eventSettingsSchema.parse({
    schemaVersion: 1,
    eventId: current.event.id,
    eventSetVersion: current.eventSet.version,
    eventVersion: current.event.version,
    name: current.event.name,
    timezone: current.event.timezone,
    startDate: current.event.startDate,
    endDate: current.event.endDate,
    location: current.companion.location,
    venueNote: current.companion.venueNote,
    dayStart: current.companion.dayStart,
    dayEnd: current.companion.dayEnd,
    slotMinutes: current.companion.slotMinutes
  });
}

export function eventSettingsStateDigest(state: EventSettingsState): string {
  return canonicalJsonSha256(projectEventSettings(state));
}

function sameScope(left: EventSettingsScope, right: EventSettingsScope): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function updatedEvent(state: EventSettingsState, after: {
  readonly name: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
}): Event {
  return createEvent({
    id: state.event.id,
    workspaceId: state.event.workspaceId,
    name: after.name,
    timezone: after.timezone,
    startDate: after.startDate,
    endDate: after.endDate,
    version: state.event.version + 1,
    createdByUserId: state.event.createdByUserId,
    createdAt: state.event.createdAt
  });
}

function projectedAfter(
  state: EventSettingsState,
  author: EventSettingsUpdateAuthorInput
): EventSettingsDto {
  const event = updatedEvent(state, author.request);
  return eventSettingsSchema.parse({
    schemaVersion: 1,
    eventId: event.id,
    eventSetVersion: state.eventSet.version,
    eventVersion: event.version,
    name: event.name,
    timezone: event.timezone,
    startDate: event.startDate,
    endDate: event.endDate,
    location: author.request.location,
    venueNote: author.request.venueNote,
    dayStart: author.request.dayStart,
    dayEnd: author.request.dayEnd,
    slotMinutes: author.request.slotMinutes
  });
}

export function planEventSettingsUpdate(input: {
  readonly state: EventSettingsState;
  readonly authorInput: EventSettingsUpdateAuthorInput;
}): EventSettingsUpdatePlan {
  const state = parseEventSettingsState(input.state);
  const author = eventSettingsUpdateAuthorInputSchema.parse(input.authorInput);
  const scope = eventSettingsScopeSchema.parse(author.scope);
  if (!sameScope(scope, {
    workspaceId: state.eventSet.workspaceId,
    eventId: state.event.id
  })) throw new EventSettingsPlanningError('wrong_scope');
  if (author.request.expectedEventId !== state.eventSet.currentEventId) {
    throw new EventSettingsPlanningError('selection_changed');
  }
  if (author.request.expectedEventSetVersion !== state.eventSet.version) {
    throw new EventSettingsPlanningError('stale_event_set');
  }
  if (author.request.expectedEventVersion !== state.event.version) {
    throw new EventSettingsPlanningError('stale_event');
  }
  const before = projectEventSettings(state);
  const after = projectedAfter(state, author);
  const comparableBefore = { ...before, eventVersion: after.eventVersion };
  if (canonicalJsonSha256(comparableBefore) === canonicalJsonSha256(after)) {
    throw new EventSettingsPlanningError('no_changes');
  }
  return Object.freeze({
    action: 'update' as const,
    scope,
    selection: Object.freeze({
      eventId: state.event.id,
      eventSetVersion: state.eventSet.version,
      eventSetGuardDigestSha256: workspaceEventSetDigest(state.eventSet)
    }),
    expectedEventVersion: state.event.version,
    resultingEventVersion: after.eventVersion,
    before,
    after
  });
}

export function validateEventSettingsUpdatePlan(
  stateInput: EventSettingsState,
  plan: EventSettingsUpdatePlan
): EventSettingsPlanningErrorCode | null {
  let state: EventSettingsState;
  try {
    state = parseEventSettingsState(stateInput);
  } catch (error) {
    return error instanceof EventSettingsPlanningError ? error.code : 'invalid_plan';
  }
  if (plan.action !== 'update') return 'invalid_plan';
  if (!sameScope(plan.scope, {
    workspaceId: state.eventSet.workspaceId,
    eventId: state.event.id
  })) return 'wrong_scope';
  if (plan.selection.eventId !== state.eventSet.currentEventId
      || plan.selection.eventId !== plan.scope.eventId) return 'selection_changed';
  if (plan.selection.eventSetVersion !== state.eventSet.version
      || plan.before.eventSetVersion !== state.eventSet.version
      || plan.after.eventSetVersion !== state.eventSet.version
      || plan.selection.eventSetGuardDigestSha256 !== workspaceEventSetDigest(state.eventSet)) {
    return 'stale_event_set';
  }
  if (plan.expectedEventVersion !== state.event.version
      || plan.before.eventVersion !== state.event.version) return 'stale_event';
  if (canonicalJsonSha256(plan.before) !== canonicalJsonSha256(projectEventSettings(state))) {
    return 'settings_changed';
  }
  if (plan.resultingEventVersion !== plan.expectedEventVersion + 1
      || plan.after.eventVersion !== plan.resultingEventVersion
      || plan.after.eventId !== plan.scope.eventId) return 'invalid_plan';
  let expected: EventSettingsDto;
  try {
    expected = projectedAfter(state, {
      scope: plan.scope,
      request: {
        expectedEventId: plan.selection.eventId,
        expectedEventSetVersion: plan.selection.eventSetVersion,
        expectedEventVersion: plan.expectedEventVersion,
        name: plan.after.name,
        timezone: plan.after.timezone,
        startDate: plan.after.startDate,
        endDate: plan.after.endDate,
        location: plan.after.location,
        venueNote: plan.after.venueNote,
        dayStart: plan.after.dayStart,
        dayEnd: plan.after.dayEnd,
        slotMinutes: plan.after.slotMinutes
      }
    });
  } catch {
    return 'invalid_plan';
  }
  if (canonicalJsonSha256(expected) !== canonicalJsonSha256(plan.after)) return 'invalid_plan';
  const comparableBefore = { ...plan.before, eventVersion: plan.after.eventVersion };
  if (canonicalJsonSha256(comparableBefore) === canonicalJsonSha256(plan.after)) {
    return 'no_changes';
  }
  return null;
}

export function applyEventSettingsUpdatePlan(input: {
  readonly state: EventSettingsState;
  readonly plan: EventSettingsUpdatePlan;
}): EventSettingsDto {
  const issue = validateEventSettingsUpdatePlan(input.state, input.plan);
  if (issue) throw new EventSettingsPlanningError(issue);
  return eventSettingsSchema.parse(input.plan.after);
}

export function deriveEventSettingsUpdateCompensation(input: {
  readonly state: EventSettingsState;
  readonly sourcePlan: EventSettingsUpdatePlan;
}): { readonly kind: 'exact'; readonly authorInput: EventSettingsUpdateAuthorInput }
  | { readonly kind: 'blocked'; readonly reasonKey: string } {
  let current: EventSettingsDto;
  try {
    current = projectEventSettings(input.state);
  } catch {
    return { kind: 'blocked', reasonKey: 'event_settings.current_state_unavailable' };
  }
  if (current.eventId !== input.sourcePlan.after.eventId
      || current.eventSetVersion !== input.sourcePlan.after.eventSetVersion) {
    return { kind: 'blocked', reasonKey: 'event_settings.selection_changed' };
  }
  if (canonicalJsonSha256(current) !== canonicalJsonSha256(input.sourcePlan.after)) {
    return { kind: 'blocked', reasonKey: 'event_settings.later_change' };
  }
  return {
    kind: 'exact',
    authorInput: {
      scope: input.sourcePlan.scope,
      request: {
        expectedEventId: current.eventId,
        expectedEventSetVersion: current.eventSetVersion,
        expectedEventVersion: current.eventVersion,
        name: input.sourcePlan.before.name,
        timezone: input.sourcePlan.before.timezone,
        startDate: input.sourcePlan.before.startDate,
        endDate: input.sourcePlan.before.endDate,
        location: input.sourcePlan.before.location,
        venueNote: input.sourcePlan.before.venueNote,
        dayStart: input.sourcePlan.before.dayStart,
        dayEnd: input.sourcePlan.before.dayEnd,
        slotMinutes: input.sourcePlan.before.slotMinutes
      }
    }
  };
}
