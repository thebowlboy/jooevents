import { describe, expect, test } from 'bun:test';
import {
  schedulePlacementConflictDetailSchema,
  schedulePlacementPlanSchema,
  type SchedulePlacementPlanDto,
  type SchedulePlacementPlanningInput
} from '@jooevents/contracts';
import {
  planChangesetOperationSynchronous,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import { createProgramVocabularyState } from '@jooevents/program';
import {
  applySchedulePlacementPlan,
  createSchedulePlacementChangesetBundle,
  parseSchedulePlacementScope,
  parseSchedulePlacementState,
  parseScheduleSessionId,
  schedulePlacementReadPort,
  schedulePlacementTransactionPort,
  schedulePlacementValidationPort,
  type ProgrammedSessionIdentityPort,
  type SchedulePlacementScope,
  type SchedulePlacementState,
  type ScheduleSessionId
} from '.';

const ids = {
  workspace: '01890f47-9abc-7def-8123-456789abcdef',
  event: '01890f47-9abc-7def-8123-456789abcdea',
  room: '01890f47-9abc-7def-8123-456789abcdeb',
  session: '01890f47-9abc-7def-8123-456789abcdec',
  otherSession: '01890f47-9abc-7def-8123-456789abcded',
  occurrence: '01890f47-9abc-7def-8123-456789abcdee',
  otherOccurrence: '01890f47-9abc-7def-8123-456789abcdf0'
} as const;

const scope = parseSchedulePlacementScope({ workspaceId: ids.workspace, eventId: ids.event });
const vocabulary = createProgramVocabularyState({
  scope,
  setVersion: 2,
  rooms: [{ id: ids.room, name: 'Main Hall', capacity: null, status: 'active', version: 1 }]
});

class Store implements ProgrammedSessionIdentityPort {
  state: SchedulePlacementState = parseSchedulePlacementState({
    schemaVersion: 1,
    scope,
    scheduleVersion: 1,
    occurrences: []
  });

  readSchedule(requestScope: SchedulePlacementScope): SchedulePlacementState | undefined {
    return requestScope.workspaceId === scope.workspaceId && requestScope.eventId === scope.eventId
      ? this.state
      : undefined;
  }

  readVocabulary(requestScope: SchedulePlacementScope) {
    return requestScope.workspaceId === scope.workspaceId && requestScope.eventId === scope.eventId
      ? vocabulary
      : undefined;
  }

  readProgrammedSession(requestScope: SchedulePlacementScope, sessionId: ScheduleSessionId) {
    if (requestScope.workspaceId !== scope.workspaceId || requestScope.eventId !== scope.eventId) return undefined;
    if (sessionId !== ids.session && sessionId !== ids.otherSession) return undefined;
    return { scope, id: parseScheduleSessionId(sessionId), lifecycle: 'programmed' as const };
  }

  applyPlacementPlan(plan: SchedulePlacementPlanDto) {
    const applied = applySchedulePlacementPlan({ state: this.state, sessions: this, vocabulary, plan });
    this.state = applied.state;
    return applied.result;
  }
}

function planningInput(): SchedulePlacementPlanningInput {
  return {
    action: 'place',
    scope,
    expectedScheduleVersion: 1,
    occurrenceId: ids.occurrence,
    sessionId: ids.session,
    roomId: ids.room,
    startAt: '2026-09-01T09:00:00.000Z',
    endAt: '2026-09-01T10:00:00.000Z'
  };
}

function snapshot(store: Store): ChangesetPlanningSnapshot {
  return Object.freeze({ getPort: <Port>() => store as unknown as Port });
}

describe('Schedule placement changeset registration', () => {
  test('registers and applies through only declared generic ports, then derives exact correction', async () => {
    const bundle = createSchedulePlacementChangesetBundle();
    const store = new Store();
    const frozen = planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: 'schedule.placement.mutate',
      version: 1,
      authorInput: planningInput(),
      dependencyGroup: 'schedule_placement',
      snapshot: snapshot(store)
    });
    expect(frozen.riskTier).toBe('normal');
    expect(frozen.aggregateRefs).toEqual([{
      id: `program_room:${ids.room}`,
      version: 1
    }]);
    expect(frozen.guardRefs.map((guard) => guard.id)).toEqual([
      `event_schedule:${ids.event}`,
      `schedule_room_query:${ids.event}:${ids.room}`,
      `program_vocabulary_set:${ids.event}`
    ]);
    expect(bundle.registry.get('schedule.placement.mutate', 1)).toBe(bundle.definition);

    const plan = schedulePlacementPlanSchema.parse(frozen.plan);
    const validated = await bundle.definition.validateWithin(plan, {
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        expect(key).toBe(schedulePlacementValidationPort);
        return store as unknown as Port;
      }
    });
    expect(validated.kind).toBe('ready');
    if (validated.kind !== 'ready') throw new TypeError('expected_ready_schedule_plan');
    const contribution = await bundle.definition.applyWithin(validated.validated, {
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        expect(key).toBe(schedulePlacementTransactionPort);
        return store as unknown as Port;
      }
    });
    expect(contribution.facts).toMatchObject([{ kind: 'schedule_occurrence_changed', version: 1 }]);
    expect(contribution.effects).toEqual([]);

    const compensation = await bundle.definition.deriveCompensation(plan, snapshot(store));
    expect(compensation).toMatchObject({
      kind: 'exact',
      authorInput: {
        action: 'unplace',
        occurrenceId: ids.occurrence,
        expectedScheduleVersion: 2,
        expectedOccurrenceVersion: 1
      }
    });
  });

  test('returns actual schema-valid overlap rows when the query set differs', async () => {
    const bundle = createSchedulePlacementChangesetBundle();
    const store = new Store();
    const frozen = planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: 'schedule.placement.mutate',
      version: 1,
      authorInput: planningInput(),
      dependencyGroup: 'schedule_placement',
      snapshot: snapshot(store)
    });
    const plan = schedulePlacementPlanSchema.parse(frozen.plan);
    store.state = parseSchedulePlacementState({
      schemaVersion: 1,
      scope,
      scheduleVersion: 1,
      occurrences: [{
        id: ids.otherOccurrence,
        sessionId: ids.otherSession,
        roomId: ids.room,
        startAt: '2026-09-01T09:30:00.000Z',
        endAt: '2026-09-01T10:30:00.000Z',
        version: 1
      }]
    });
    const validated = await bundle.definition.validateWithin(plan, {
      getPort: <Port>() => store as unknown as Port
    });
    expect(validated).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'schedule_room_overlap',
        detail: { conflicts: [{ occurrenceId: ids.otherOccurrence }] }
      }
    });
    if (validated.kind !== 'outcome') throw new TypeError('expected_schedule_overlap');
    expect(schedulePlacementConflictDetailSchema.safeParse(validated.outcome.detail).success).toBe(true);
  });

  test('the registry exposes only its declared read port', () => {
    const bundle = createSchedulePlacementChangesetBundle();
    const store = new Store();
    expect(bundle.definition.readPorts).toEqual([schedulePlacementReadPort]);
    expect(() => planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: 'schedule.placement.mutate',
      version: 1,
      authorInput: planningInput(),
      dependencyGroup: 'schedule_placement',
      snapshot: {
        getPort() {
          throw new TypeError('generic snapshot reached only through the declared port');
        }
      }
    })).toThrow('generic snapshot reached only through the declared port');
    expect(store.state.occurrences).toHaveLength(0);
  });
});
