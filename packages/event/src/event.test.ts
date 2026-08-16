import { describe, expect, test } from 'bun:test';
import type { EventCreateInput, EventSelectInput } from '@jooevents/contracts';
import {
  EVENT_CREATION_CORRECTION_DEFINITION,
  EventDependencyRegistryValidationError,
  EventDependencySnapshotError,
  EventPlanningError,
  EventProjectionError,
  EventValidationError,
  applyEventCreatePlan,
  applyEventSelectPlan,
  assessEventCreationCompensation,
  createEvent,
  createEventDependencyContributorRegistry,
  createWorkspaceEventSet,
  diffEventCreatePlan,
  eventCreatePlanDigest,
  eventCreateResult,
  eventSelectResult,
  parseEventCreatePlan,
  parseEventSelectPlan,
  parseEventState,
  parseWorkspaceEventSetState,
  planEventCreation,
  planEventSelection,
  projectCurrentEvent,
  validateEventCreatePlan,
  validateEventSelectPlan,
  workspaceEventSetDigest,
  workspaceEventSetGuardId,
  type Event,
  type EventCreatePlan,
  type EventSelectPlan,
  type EventDependencyContributorRef,
  type EventDependencyScope,
  type EventDependencySnapshotSource,
  type WorkspaceEventSet
} from '.';

const workspaceId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
const otherWorkspaceId = '018f7d5a-4b3c-7abc-8def-0123456789a9';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const otherEventId = '018f7d5a-4b3c-7abc-8def-0123456789a3';
const userId = '018f7d5a-4b3c-7abc-8def-0123456789a4';
const createdAt = '2026-08-12T04:00:00.000Z';

function emptyEventSet(input?: { workspaceId?: string; version?: number }): WorkspaceEventSet {
  return createWorkspaceEventSet({
    workspaceId: input?.workspaceId ?? workspaceId,
    version: input?.version ?? 1,
    currentEventId: null
  });
}

function authorInput(input?: Partial<EventCreateInput>): EventCreateInput {
  return {
    expectedEventSetVersion: 1,
    name: 'JooConf 2027',
    timezone: 'Asia/Singapore',
    startDate: '2027-04-16',
    endDate: '2027-04-18',
    ...input
  };
}

function plan(input?: {
  eventSet?: WorkspaceEventSet;
  authorInput?: EventCreateInput;
  serverWorkspaceId?: string;
}): EventCreatePlan {
  return planEventCreation({
    eventSet: input?.eventSet ?? emptyEventSet(),
    authorInput: input?.authorInput ?? authorInput(),
    server: {
      workspaceId: input?.serverWorkspaceId ?? workspaceId,
      eventId,
      createdByUserId: userId,
      createdAt
    }
  });
}

function initialEvent(input?: Partial<{
  id: string;
  workspaceId: string;
  name: string;
  timezone: string;
  startDate: string;
  endDate: string;
  version: number;
  createdByUserId: string;
  createdAt: string;
}>): Event {
  return createEvent({
    id: eventId,
    workspaceId,
    name: 'JooConf 2027',
    timezone: 'Asia/Singapore',
    startDate: '2027-04-16',
    endDate: '2027-04-18',
    version: 1,
    createdByUserId: userId,
    createdAt,
    ...input
  });
}

function emptyDependencyEvidence() {
  const dependencyRegistry = createEventDependencyContributorRegistry({ expected: [], contributors: [] });
  return {
    dependencyRegistry,
    dependencySource: { readContributor: () => undefined }
  };
}

function unavailableDependencyEvidence() {
  const contributor = { key: 'schedule.event_dependencies', version: 1 } as const;
  const dependencyRegistry = createEventDependencyContributorRegistry({
    expected: [contributor], contributors: [contributor]
  });
  return {
    dependencyRegistry,
    dependencySource: { readContributor: () => undefined }
  };
}

describe('minimal Event state', () => {
  test('normalizes the name and validates timezone while preserving canonical dates', () => {
    const event = initialEvent({ name: '  Joo   Conf 2027  ', timezone: 'US/Eastern' });
    expect(event.name).toBe('Joo Conf 2027');
    expect(String(event.timezone)).toBe('US/Eastern');
    expect(String(event.startDate)).toBe('2027-04-16');
    expect(Object.isFrozen(event)).toBe(true);
  });

  test('rejects invalid values with domain-owned error codes', () => {
    for (const [changes, code] of [
      [{ name: '   ' }, 'invalid_event_name'],
      [{ timezone: 'Mars/Olympus' }, 'invalid_event_timezone'],
      [{ startDate: '2027-02-29' }, 'invalid_event_date'],
      [{ startDate: '2027-04-19' }, 'invalid_event_date_range'],
      [{ version: 0 }, 'invalid_event_version']
    ] as const) {
      try {
        initialEvent(changes);
        throw new Error('expected Event validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(EventValidationError);
        expect((error as EventValidationError).code).toBe(code);
      }
    }
  });

  test('strictly rehydrates canonical state without normalizing stored bytes', () => {
    const canonical = initialEvent();
    expect(parseEventState(canonical)).toEqual(canonical);
    expect(() => parseEventState({ ...canonical, name: 'JooConf  2027' }))
      .toThrow('invalid_event_name');
    expect(() => parseEventState({ ...canonical, createdAt: '2026-08-12T04:00:00Z' }))
      .toThrow('invalid_event_timestamp');
  });

  test('keeps current selection on the workspace set rather than the Event', () => {
    const event = initialEvent();
    const set = createWorkspaceEventSet({ workspaceId, version: 2, currentEventId: event.id });
    expect(set.currentEventId).toBe(event.id);
    expect('current' in event).toBe(false);
    expect('status' in event).toBe(false);
  });

  test('strictly rehydrates Event-set IDs without normalizing stored bytes', () => {
    const canonical = createWorkspaceEventSet({ workspaceId, version: 2, currentEventId: eventId });
    expect(parseWorkspaceEventSetState(canonical)).toEqual(canonical);
    expect(() => parseWorkspaceEventSetState({
      ...canonical,
      workspaceId: workspaceId.toUpperCase()
    })).toThrow('invalid_workspace_id');
    expect(() => parseWorkspaceEventSetState({
      ...canonical,
      currentEventId: eventId.toUpperCase()
    })).toThrow('invalid_current_event_id');
  });
});

describe('current Event projection', () => {
  test('projects no_event as successful live data', () => {
    expect(projectCurrentEvent(emptyEventSet(), undefined)).toEqual({
      schemaVersion: 1,
      kind: 'no_event',
      eventSetVersion: 1
    });
  });

  test('projects only the safe current Event fields', () => {
    const event = initialEvent();
    const projection = projectCurrentEvent(
      createWorkspaceEventSet({ workspaceId, version: 2, currentEventId: event.id }),
      event
    );
    expect(projection).toEqual({
      schemaVersion: 1,
      kind: 'current_event',
      eventSetVersion: 2,
      event: {
        id: eventId,
        name: 'JooConf 2027',
        timezone: 'Asia/Singapore',
        startDate: '2027-04-16',
        endDate: '2027-04-18',
        version: 1
      }
    });
    expect(JSON.stringify(projection)).not.toContain(userId);
    expect(JSON.stringify(projection)).not.toContain(workspaceId);
  });

  test('fails closed on missing, mismatched, or cross-workspace heads', () => {
    const set = createWorkspaceEventSet({ workspaceId, version: 2, currentEventId: eventId });
    const cases = [
      [undefined, 'current_event_missing'],
      [initialEvent({ id: otherEventId }), 'current_event_mismatch'],
      [initialEvent({ workspaceId: otherWorkspaceId }), 'wrong_workspace']
    ] as const;
    for (const [event, code] of cases) {
      try {
        projectCurrentEvent(set, event);
        throw new Error('expected projection to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(EventProjectionError);
        expect((error as EventProjectionError).code).toBe(code);
      }
    }
  });
});

describe('Event creation planning', () => {
  test('freezes a deterministic guarded create plan and diff', () => {
    const first = plan({ authorInput: authorInput({ name: '  Joo   Conf 2027  ' }) });
    const second = plan({ authorInput: authorInput({ name: '  Joo   Conf 2027  ' }) });
    expect(first).toEqual(second);
    expect(first.after.name).toBe('Joo Conf 2027');
    expect(first.eventSetGuardDigest).toBe(workspaceEventSetDigest(emptyEventSet()));
    expect(workspaceEventSetGuardId(workspaceId)).toBe(`workspace_event_set:${workspaceId}`);
    expect(Object.isFrozen(first)).toBe(true);
    expect(diffEventCreatePlan(first)).toEqual({
      action: 'create',
      before: null,
      after: {
        id: eventId,
        name: 'Joo Conf 2027',
        timezone: 'Asia/Singapore',
        startDate: '2027-04-16',
        endDate: '2027-04-18',
        version: 1
      },
      currentSelection: { before: null, after: eventId },
      eventSetVersion: { before: 1, after: 2 }
    });
  });

  test('applies once and returns a safe canonical result', () => {
    const source = emptyEventSet();
    const createPlan = plan({ eventSet: source });
    const applied = applyEventCreatePlan(source, createPlan);
    expect(JSON.parse(JSON.stringify(applied.eventSet))).toEqual({
      workspaceId, version: 2, currentEventId: eventId
    });
    expect(applied.event).toBe(createPlan.after);
    expect(eventCreateResult(createPlan)).toEqual({
      eventSetVersion: 2,
      event: {
        id: eventId,
        name: 'JooConf 2027',
        timezone: 'Asia/Singapore',
        startDate: '2027-04-16',
        endDate: '2027-04-18',
        version: 1
      }
    });
    expect(validateEventCreatePlan(applied.eventSet, createPlan)).toBe('stale_event_set');
  });

  test('rejects wrong workspace and stale set while allowing another Event', () => {
    const cases: readonly [() => unknown, EventPlanningError['code']][] = [
      [() => plan({ serverWorkspaceId: otherWorkspaceId }), 'wrong_workspace'],
      [() => plan({ authorInput: authorInput({ expectedEventSetVersion: 2 }) }), 'stale_event_set']
    ];
    for (const [run, code] of cases) {
      try {
        run();
        throw new Error('expected Event planning to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(EventPlanningError);
        expect((error as EventPlanningError).code).toBe(code);
      }
    }
    const selected = createWorkspaceEventSet({
      workspaceId, version: 2, currentEventId: otherEventId
    });
    const next = plan({
      eventSet: selected,
      authorInput: authorInput({ expectedEventSetVersion: 2 })
    });
    expect(String(next.previousEventId)).toBe(otherEventId);
    expect(diffEventCreatePlan(next).currentSelection).toEqual({
      before: otherEventId, after: eventId
    });
  });

  test('detects a changed guard even when the set version is reused', () => {
    const createPlan = plan();
    const changed = createWorkspaceEventSet({ workspaceId, version: 1, currentEventId: otherEventId });
    expect(validateEventCreatePlan(changed, createPlan)).toBe('stale_event_set');
    expect(() => applyEventCreatePlan(changed, createPlan)).toThrow(EventPlanningError);
  });
});

describe('Event selection planning', () => {
  function selectPlan(input?: {
    readonly eventSet?: WorkspaceEventSet;
    readonly targetEvent?: Event;
    readonly authorInput?: EventSelectInput;
  }): EventSelectPlan {
    return planEventSelection({
      eventSet: input?.eventSet ?? createWorkspaceEventSet({
        workspaceId, version: 3, currentEventId: otherEventId
      }),
      targetEvent: input?.targetEvent ?? initialEvent(),
      authorInput: input?.authorInput ?? { eventId, expectedEventSetVersion: 3 }
    });
  }

  test('round-trips and applies an exact workspace-current selection', () => {
    const before = createWorkspaceEventSet({
      workspaceId, version: 3, currentEventId: otherEventId
    });
    const planned = selectPlan({ eventSet: before });
    expect(parseEventSelectPlan(JSON.parse(JSON.stringify(planned)))).toEqual(planned);
    expect(validateEventSelectPlan(before, initialEvent(), planned)).toBeNull();
    expect(applyEventSelectPlan(before, initialEvent(), planned)).toEqual(
      createWorkspaceEventSet({ workspaceId, version: 4, currentEventId: eventId })
    );
    expect(eventSelectResult(planned)).toEqual({
      eventSetVersion: 4,
      event: {
        id: eventId,
        name: 'JooConf 2027',
        timezone: 'Asia/Singapore',
        startDate: '2027-04-16',
        endDate: '2027-04-18',
        version: 1
      }
    });
  });

  test('refuses stale, missing, already-current, and cross-workspace targets', () => {
    const cases: readonly [() => unknown, EventPlanningError['code']][] = [
      [() => selectPlan({ authorInput: { eventId, expectedEventSetVersion: 2 } }), 'stale_event_set'],
      [() => planEventSelection({
        eventSet: createWorkspaceEventSet({ workspaceId, version: 3, currentEventId: otherEventId }),
        targetEvent: undefined,
        authorInput: { eventId, expectedEventSetVersion: 3 }
      }), 'event_missing'],
      [() => selectPlan({
        eventSet: createWorkspaceEventSet({ workspaceId, version: 3, currentEventId: eventId })
      }), 'event_already_selected'],
      [() => selectPlan({ targetEvent: initialEvent({ workspaceId: otherWorkspaceId }) }), 'wrong_workspace']
    ];
    for (const [run, code] of cases) {
      try {
        run();
        throw new Error('expected Event selection to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(EventPlanningError);
        expect((error as EventPlanningError).code).toBe(code);
      }
    }
  });
});

describe('Event dependency evidence and creation correction', () => {
  test('captures every registered dependency contributor and fails closed when one is absent', () => {
    const contributor = { key: 'schedule.event_dependencies', version: 1 } as const;
    expect(() => createEventDependencyContributorRegistry({
      expected: [contributor],
      contributors: []
    })).toThrow(EventDependencyRegistryValidationError);

    const registry = createEventDependencyContributorRegistry({
      expected: [contributor],
      contributors: [contributor]
    });
    const source: EventDependencySnapshotSource = { readContributor: () => undefined };
    expect(() => registry.capture(
      { workspaceId: workspaceId as EventDependencyScope['workspaceId'], eventId: eventId as EventDependencyScope['eventId'] },
      source
    )).toThrow(EventDependencySnapshotError);
  });

  test('allows exact correction only for the unchanged selected empty Event', () => {
    const sourcePlan = plan();
    const applied = applyEventCreatePlan(emptyEventSet(), sourcePlan);
    expect(EVENT_CREATION_CORRECTION_DEFINITION).toEqual({
      schemaVersion: 1,
      reversibilityTier: 'mechanical',
      requiredEvidence: [
        'source_create_plan',
        'current_event_head',
        'workspace_event_set_guard',
        'registered_event_dependencies'
      ]
    });
    expect(assessEventCreationCompensation({
      sourcePlan,
      currentEventSet: applied.eventSet,
      currentEvent: applied.event,
      ...emptyDependencyEvidence()
    })).toEqual({ kind: 'exact', eventId, dependencyCount: 0 });
  });

  test('round-trips only a complete coherent persisted create plan', () => {
    const sourcePlan = plan();
    const persisted = JSON.parse(JSON.stringify(sourcePlan));
    const parsed = parseEventCreatePlan(persisted);
    expect(parsed).toEqual(sourcePlan);
    expect(eventCreatePlanDigest(parsed)).toBe(eventCreatePlanDigest(sourcePlan));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.after)).toBe(true);

    const corruptions = [
      { ...persisted, extra: true },
      { ...persisted, action: 'update' },
      { ...persisted, expectedEventSetVersion: 2 },
      { ...persisted, eventSetGuardDigest: 'f'.repeat(64) },
      { ...persisted, resultingEventSetVersion: 3 },
      { ...persisted, resultingEventSetGuardDigest: 'e'.repeat(64) },
      { ...persisted, after: { ...persisted.after, workspaceId: otherWorkspaceId } },
      { ...persisted, after: { ...persisted.after, version: 2 } },
      { ...persisted, after: { ...persisted.after, extra: true } }
    ];
    for (const corruption of corruptions) {
      expect(() => parseEventCreatePlan(corruption)).toThrow('invalid_plan');
    }
  });

  test('blocks correction after selection, set, head, or evidence changes', () => {
    const sourcePlan = plan();
    const applied = applyEventCreatePlan(emptyEventSet(), sourcePlan);
    const cases = [
      {
        set: createWorkspaceEventSet({ workspaceId, version: 3, currentEventId: otherEventId }),
        event: applied.event,
        ...emptyDependencyEvidence(),
        reason: 'event_not_selected'
      },
      {
        set: createWorkspaceEventSet({ workspaceId, version: 3, currentEventId: eventId }),
        event: applied.event,
        ...emptyDependencyEvidence(),
        reason: 'event_set_changed'
      },
      { set: applied.eventSet, event: undefined, ...emptyDependencyEvidence(), reason: 'event_missing' },
      {
        set: applied.eventSet,
        event: initialEvent({ name: 'Changed later', version: 2 }),
        ...emptyDependencyEvidence(),
        reason: 'event_changed'
      },
      {
        set: applied.eventSet,
        event: applied.event,
        ...unavailableDependencyEvidence(),
        reason: 'dependency_evidence_unavailable'
      }
    ] as const;
    for (const item of cases) {
      expect(assessEventCreationCompensation({
        sourcePlan,
        currentEventSet: item.set,
        currentEvent: item.event,
        dependencyRegistry: item.dependencyRegistry,
        dependencySource: item.dependencySource
      })).toMatchObject({ kind: 'blocked', eventId, reason: item.reason });
    }
  });

  test('blocks exact correction when any registered domain depends on the Event', () => {
    const sourcePlan = plan();
    const applied = applyEventCreatePlan(emptyEventSet(), sourcePlan);
    const contributor: EventDependencyContributorRef = {
      key: 'program.event_dependencies', version: 1
    };
    const registry = createEventDependencyContributorRegistry({
      expected: [contributor], contributors: [contributor]
    });
    const dependencies = registry.capture(
      { workspaceId: applied.event.workspaceId, eventId: applied.event.id },
      {
        readContributor: () => ({
          contributor,
          scope: { workspaceId, eventId },
          guard: { id: 'event_dependency:program', version: 1, digest: 'a'.repeat(64) },
          dependencies: [{
            referenceKey: 'program-vocabulary',
            version: 1,
            destination: { kind: 'program_vocabulary_set', id: eventId }
          }]
        })
      }
    );
    expect(assessEventCreationCompensation({
      sourcePlan,
      currentEventSet: applied.eventSet,
      currentEvent: applied.event,
      dependencyRegistry: registry,
      dependencySource: {
        readContributor: () => dependencies.contributors[0]
      }
    })).toEqual({
      kind: 'blocked',
      eventId,
      reason: 'dependencies_present',
      dependencyCount: 1
    });
  });

  test('captures dependencies at assessment time and fails closed on unavailable evidence', () => {
    const sourcePlan = plan();
    const applied = applyEventCreatePlan(emptyEventSet(), sourcePlan);
    const contributor = { key: 'schedule.event_dependencies', version: 1 } as const;
    const dependencyRegistry = createEventDependencyContributorRegistry({
      expected: [contributor],
      contributors: [contributor]
    });
    let dependencyCount = 0;
    const dependencySource: EventDependencySnapshotSource = {
      readContributor: () => ({
        contributor,
        scope: { workspaceId, eventId },
        guard: {
          id: 'event_dependency:schedule',
          version: 1,
          digest: 'a'.repeat(64)
        },
        dependencies: dependencyCount === 0 ? [] : [{
          referenceKey: 'schedule-current',
          version: 1,
          destination: { kind: 'schedule', id: eventId }
        }]
      })
    };
    expect(assessEventCreationCompensation({
      sourcePlan,
      currentEventSet: applied.eventSet,
      currentEvent: applied.event,
      dependencyRegistry,
      dependencySource
    })).toEqual({ kind: 'exact', eventId, dependencyCount: 0 });
    dependencyCount = 1;
    expect(assessEventCreationCompensation({
      sourcePlan,
      currentEventSet: applied.eventSet,
      currentEvent: applied.event,
      dependencyRegistry,
      dependencySource
    })).toEqual({
      kind: 'blocked',
      eventId,
      reason: 'dependencies_present',
      dependencyCount: 1
    });
    const unavailableSources: readonly EventDependencySnapshotSource[] = [
      { readContributor: () => Promise.resolve(undefined) },
      { readContributor: () => { throw new Error('source unavailable'); } },
      { readContributor: () => undefined },
      {
        readContributor: () => ({
          contributor: { key: 'other.event_dependencies', version: 1 },
          scope: { workspaceId, eventId },
          guard: { id: 'event_dependency:schedule', version: 1, digest: 'a'.repeat(64) },
          dependencies: []
        })
      }
    ];
    for (const unavailableSource of unavailableSources) {
      expect(assessEventCreationCompensation({
        sourcePlan,
        currentEventSet: applied.eventSet,
        currentEvent: applied.event,
        dependencyRegistry,
        dependencySource: unavailableSource
      })).toEqual({
        kind: 'blocked', eventId, reason: 'dependency_evidence_unavailable'
      });
    }
    const forgedRegistry = {
      ...dependencyRegistry,
      capture: dependencyRegistry.capture.bind(dependencyRegistry)
    };
    expect(assessEventCreationCompensation({
      sourcePlan,
      currentEventSet: applied.eventSet,
      currentEvent: applied.event,
      dependencyRegistry: forgedRegistry,
      dependencySource
    })).toEqual({
      kind: 'blocked', eventId, reason: 'dependency_evidence_unavailable'
    });
  });
});
