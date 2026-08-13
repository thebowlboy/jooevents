import { createHash } from 'node:crypto';
import {
  eventCreateInputSchema,
  eventCreateResultSchema,
  eventCreateSafeDiffSchema,
  eventCreationCompensationEligibilitySchema,
  type EventCreateInput,
  type EventCreateResult,
  type EventCreateSafeDiff,
  type EventCreationCompensationEligibility
} from '@jooevents/contracts';
import {
  encodeCanonicalJson,
  parseAggregateVersion,
  type AggregateVersion
} from '@jooevents/kernel';
import {
  captureRegisteredEventDependencies,
  eventDependencyCount,
  type EventDependencyContributorRegistry,
  type EventDependencySnapshotSource
} from './dependencies';
import {
  createEvent,
  createWorkspaceEventSet,
  parseEventState,
  type Event,
  type WorkspaceEventSet
} from './model';
import { projectEvent } from './projection';

export const EVENT_CREATION_CORRECTION_DEFINITION = Object.freeze({
  schemaVersion: 1 as const,
  reversibilityTier: 'mechanical' as const,
  requiredEvidence: Object.freeze([
    'source_create_plan',
    'current_event_head',
    'workspace_event_set_guard',
    'registered_event_dependencies'
  ] as const)
});

export type EventPlanningErrorCode =
  | 'wrong_workspace'
  | 'stale_event_set'
  | 'event_already_selected'
  | 'invalid_plan';

export class EventPlanningError extends Error {
  readonly code: EventPlanningErrorCode;

  constructor(code: EventPlanningErrorCode) {
    super(code);
    this.name = 'EventPlanningError';
    this.code = code;
  }
}

export interface EventCreatePlan {
  readonly action: 'create';
  readonly workspaceId: string;
  readonly expectedEventSetVersion: AggregateVersion;
  readonly eventSetGuardDigest: string;
  readonly resultingEventSetVersion: AggregateVersion;
  readonly resultingEventSetGuardDigest: string;
  readonly after: Event;
}

export interface PlanEventCreationInput {
  readonly eventSet: WorkspaceEventSet;
  readonly authorInput: EventCreateInput;
  readonly server: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly createdByUserId: string;
    readonly createdAt: string;
  };
}

export interface AppliedEventCreation {
  readonly eventSet: WorkspaceEventSet;
  readonly event: Event;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventPlanningError('invalid_plan');
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new EventPlanningError('invalid_plan');
  }
  return record;
}

function exactDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new EventPlanningError('invalid_plan');
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function eventStateDigest(event: Event): string {
  return sha256({
    id: event.id,
    workspaceId: event.workspaceId,
    name: event.name,
    timezone: event.timezone,
    startDate: event.startDate,
    endDate: event.endDate,
    version: event.version,
    createdByUserId: event.createdByUserId,
    createdAt: event.createdAt
  });
}

export function workspaceEventSetGuardId(workspaceId: string): string {
  return `workspace_event_set:${workspaceId}`;
}

export function workspaceEventSetDigest(eventSet: WorkspaceEventSet): string {
  return sha256({
    schemaVersion: 1,
    workspaceId: eventSet.workspaceId,
    version: eventSet.version,
    currentEventId: eventSet.currentEventId
  });
}

export function eventCreatePlanDigest(plan: EventCreatePlan): string {
  return sha256(plan);
}

function resultingEventSet(plan: Pick<
  EventCreatePlan,
  'workspaceId' | 'resultingEventSetVersion' | 'after'
>): WorkspaceEventSet {
  return createWorkspaceEventSet({
    workspaceId: plan.workspaceId,
    version: plan.resultingEventSetVersion,
    currentEventId: plan.after.id
  });
}

export function planEventCreation(input: PlanEventCreationInput): EventCreatePlan {
  const authorInput = eventCreateInputSchema.parse(input.authorInput);
  if (input.server.workspaceId !== input.eventSet.workspaceId) {
    throw new EventPlanningError('wrong_workspace');
  }
  if (authorInput.expectedEventSetVersion !== input.eventSet.version) {
    throw new EventPlanningError('stale_event_set');
  }
  if (input.eventSet.currentEventId !== null) {
    throw new EventPlanningError('event_already_selected');
  }
  const resultingEventSetVersion = parseAggregateVersion(input.eventSet.version + 1);
  const after = createEvent({
    id: input.server.eventId,
    workspaceId: input.server.workspaceId,
    name: authorInput.name,
    timezone: authorInput.timezone,
    startDate: authorInput.startDate,
    endDate: authorInput.endDate,
    version: 1,
    createdByUserId: input.server.createdByUserId,
    createdAt: input.server.createdAt
  });
  const nextSet = createWorkspaceEventSet({
    workspaceId: input.server.workspaceId,
    version: resultingEventSetVersion,
    currentEventId: after.id
  });
  return deepFreeze({
    action: 'create',
    workspaceId: input.server.workspaceId,
    expectedEventSetVersion: input.eventSet.version,
    eventSetGuardDigest: workspaceEventSetDigest(input.eventSet),
    resultingEventSetVersion,
    resultingEventSetGuardDigest: workspaceEventSetDigest(nextSet),
    after
  });
}

/** Parses persisted or transported create-plan evidence and proves its guard coherence. */
export function parseEventCreatePlan(value: unknown): EventCreatePlan {
  try {
    const record = exactRecord(value, [
      'action',
      'workspaceId',
      'expectedEventSetVersion',
      'eventSetGuardDigest',
      'resultingEventSetVersion',
      'resultingEventSetGuardDigest',
      'after'
    ]);
    if (record.action !== 'create' || typeof record.workspaceId !== 'string') {
      throw new EventPlanningError('invalid_plan');
    }
    const afterRecord = exactRecord(record.after, [
      'id',
      'workspaceId',
      'name',
      'timezone',
      'startDate',
      'endDate',
      'version',
      'createdByUserId',
      'createdAt'
    ]);
    const after = parseEventState({
      id: afterRecord.id as string,
      workspaceId: afterRecord.workspaceId as string,
      name: afterRecord.name as string,
      timezone: afterRecord.timezone as string,
      startDate: afterRecord.startDate as string,
      endDate: afterRecord.endDate as string,
      version: afterRecord.version as number,
      createdByUserId: afterRecord.createdByUserId as string,
      createdAt: afterRecord.createdAt as string
    });
    const plan = deepFreeze({
      action: 'create' as const,
      workspaceId: record.workspaceId,
      expectedEventSetVersion: parseAggregateVersion(record.expectedEventSetVersion),
      eventSetGuardDigest: exactDigest(record.eventSetGuardDigest),
      resultingEventSetVersion: parseAggregateVersion(record.resultingEventSetVersion),
      resultingEventSetGuardDigest: exactDigest(record.resultingEventSetGuardDigest),
      after
    });
    const before = createWorkspaceEventSet({
      workspaceId: plan.workspaceId,
      version: plan.expectedEventSetVersion,
      currentEventId: null
    });
    if (validateEventCreatePlan(before, plan) !== null) {
      throw new EventPlanningError('invalid_plan');
    }
    return plan;
  } catch (error) {
    if (error instanceof EventPlanningError && error.code === 'invalid_plan') throw error;
    throw new EventPlanningError('invalid_plan');
  }
}

export function validateEventCreatePlan(
  eventSet: WorkspaceEventSet,
  plan: EventCreatePlan
): EventPlanningErrorCode | null {
  if (eventSet.workspaceId !== plan.workspaceId || plan.after.workspaceId !== plan.workspaceId) {
    return 'wrong_workspace';
  }
  if (eventSet.version !== plan.expectedEventSetVersion
      || workspaceEventSetDigest(eventSet) !== plan.eventSetGuardDigest) {
    return 'stale_event_set';
  }
  if (eventSet.currentEventId !== null) return 'event_already_selected';
  if (plan.action !== 'create'
      || plan.after.version !== 1
      || plan.resultingEventSetVersion !== plan.expectedEventSetVersion + 1) {
    return 'invalid_plan';
  }
  const nextSet = resultingEventSet(plan);
  if (workspaceEventSetDigest(nextSet) !== plan.resultingEventSetGuardDigest) {
    return 'invalid_plan';
  }
  return null;
}

export function applyEventCreatePlan(
  eventSet: WorkspaceEventSet,
  plan: EventCreatePlan
): AppliedEventCreation {
  const issue = validateEventCreatePlan(eventSet, plan);
  if (issue) throw new EventPlanningError(issue);
  return deepFreeze({ eventSet: resultingEventSet(plan), event: plan.after });
}

export function diffEventCreatePlan(plan: EventCreatePlan): EventCreateSafeDiff {
  return eventCreateSafeDiffSchema.parse({
    action: 'create',
    before: null,
    after: projectEvent(plan.after),
    currentSelection: { before: null, after: plan.after.id },
    eventSetVersion: {
      before: plan.expectedEventSetVersion,
      after: plan.resultingEventSetVersion
    }
  });
}

export function eventCreateResult(plan: EventCreatePlan): EventCreateResult {
  return eventCreateResultSchema.parse({
    eventSetVersion: plan.resultingEventSetVersion,
    event: projectEvent(plan.after)
  });
}

export function assessEventCreationCompensation(input: {
  readonly sourcePlan: EventCreatePlan;
  readonly currentEventSet: WorkspaceEventSet;
  readonly currentEvent: Event | undefined;
  readonly dependencyRegistry: EventDependencyContributorRegistry;
  readonly dependencySource: EventDependencySnapshotSource;
}): EventCreationCompensationEligibility {
  const eventId = input.sourcePlan.after.id;
  if (input.currentEventSet.currentEventId !== eventId) {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'event_not_selected'
    });
  }
  if (input.currentEventSet.workspaceId !== input.sourcePlan.workspaceId
      || input.currentEventSet.version !== input.sourcePlan.resultingEventSetVersion
      || workspaceEventSetDigest(input.currentEventSet)
        !== input.sourcePlan.resultingEventSetGuardDigest) {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'event_set_changed'
    });
  }
  if (!input.currentEvent) {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'event_missing'
    });
  }
  if (eventStateDigest(input.currentEvent) !== eventStateDigest(input.sourcePlan.after)) {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'event_changed'
    });
  }
  let dependencies;
  try {
    dependencies = captureRegisteredEventDependencies({
      registry: input.dependencyRegistry,
      scope: {
        workspaceId: input.sourcePlan.after.workspaceId,
        eventId
      },
      source: input.dependencySource
    });
  } catch {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'dependency_evidence_unavailable'
    });
  }
  if (dependencies.contributors.some((contributor) =>
        contributor.scope.workspaceId !== input.sourcePlan.after.workspaceId
        || contributor.scope.eventId !== eventId
      )) {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'dependency_evidence_unavailable'
    });
  }
  const dependencyCount = eventDependencyCount(dependencies);
  if (dependencyCount > 0) {
    return eventCreationCompensationEligibilitySchema.parse({
      kind: 'blocked', eventId, reason: 'dependencies_present', dependencyCount
    });
  }
  return eventCreationCompensationEligibilitySchema.parse({
    kind: 'exact', eventId, dependencyCount: 0
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
