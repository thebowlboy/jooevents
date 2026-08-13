import {
  schedulePlacementConflictDetailSchema,
  schedulePlacementIdSchema,
  schedulePlacementPlanSchema,
  schedulePlacementPlanningInputSchema,
  schedulePlacementResultSchema,
  type SchedulePlacementPlanDto,
  type SchedulePlacementPlanningInput,
  type SchedulePlacementResult
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot,
  type CompensationDerivation
} from '@jooevents/changesets';
import {
  plannedProgramVocabularyItem,
  programVocabularyAggregateId,
  programVocabularySetDigest,
  programVocabularySetGuardId,
  resolveProgramVocabularyItem,
  type ProgramVocabularyState
} from '@jooevents/program';
import { z } from 'zod';
import {
  planSchedulePlacementMutation,
  overlappingRoomOccurrences,
  schedulePlacementGuardId,
  schedulePlacementStateDigest,
  validateSchedulePlacementPlan,
  type SchedulePlacementPlanningErrorCode
} from './domain';
import {
  projectSchedulePlacementOccurrence,
  parseSchedulePlacementScope,
  type PlaceableSessionIdentityPort,
  type SchedulePlacementScope,
  type SchedulePlacementState
} from './model';

export const SCHEDULE_PLACEMENT_CHANGESET_KIND = 'schedule.placement.mutate';
export const SCHEDULE_PLACEMENT_CHANGESET_VERSION = 1;

export interface SchedulePlacementReadPort extends PlaceableSessionIdentityPort {
  readSchedule(scope: SchedulePlacementScope): SchedulePlacementState | undefined;
  readVocabulary(scope: SchedulePlacementScope): ProgramVocabularyState | undefined;
}

export interface SchedulePlacementTransactionPort extends SchedulePlacementReadPort {
  applyPlacementPlan(plan: SchedulePlacementPlanDto): SchedulePlacementResult;
}

export const schedulePlacementReadPort = defineChangesetReadPort<SchedulePlacementReadPort>(
  'schedule_placement.read',
  1
);
export const schedulePlacementValidationPort = defineChangesetValidationPort<SchedulePlacementReadPort>(
  'schedule_placement.validation',
  1
);
export const schedulePlacementTransactionPort = defineChangesetTransactionPort<SchedulePlacementTransactionPort>(
  'schedule_placement.transaction',
  1
);

const authorInputSchema = defineChangesetSchema({
  key: 'schedule.placement.planning_input',
  version: 1,
  schema: schedulePlacementPlanningInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'schedule.placement.plan',
  version: 1,
  schema: schedulePlacementPlanSchema
});
const diffSchema = defineChangesetSchema({
  key: 'schedule.placement.safe_diff',
  version: 1,
  schema: schedulePlacementPlanSchema
});
const resultSchema = defineChangesetSchema({
  key: 'schedule.placement.result',
  version: 1,
  schema: schedulePlacementResultSchema
});
const staleDetailSchema = defineChangesetSchema({
  key: 'schedule.placement.stale_detail',
  version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope',
      'stale_schedule',
      'occurrence_exists',
      'occurrence_missing',
      'stale_occurrence',
      'session_missing',
      'room_missing',
      'room_retired',
      'stale_room_query',
      'invalid_plan'
    ]),
    action: z.enum(['place', 'move', 'unplace']),
    occurrenceId: schedulePlacementIdSchema
  })
});
const conflictDetailSchema = defineChangesetSchema({
  key: 'schedule.placement.room_overlap_detail',
  version: 1,
  schema: schedulePlacementConflictDetailSchema
});

type SchedulePlacementDefinition = ChangesetOperationDefinition<
  SchedulePlacementPlanningInput,
  SchedulePlacementPlanDto,
  SchedulePlacementPlanDto,
  SchedulePlacementPlanDto,
  SchedulePlacementResult
>;

export interface SchedulePlacementChangesetBundle {
  readonly definition: SchedulePlacementDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

export function createSchedulePlacementChangesetBundle(): SchedulePlacementChangesetBundle {
  const definition: SchedulePlacementDefinition = {
    kind: SCHEDULE_PLACEMENT_CHANGESET_KIND,
    version: SCHEDULE_PLACEMENT_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [schedulePlacementReadPort],
    validationPorts: [schedulePlacementValidationPort],
    transactionPorts: [schedulePlacementTransactionPort],
    allowedAggregateKinds: ['schedule_occurrence', 'program_room'],
    allowedGuardKinds: ['event_schedule', 'schedule_room_query', 'program_vocabulary_set'],
    allowedRisks: ['normal'],
    allowedConsequences: ['schedule_occurrence_changed'],
    allowedOutcomes: [
      {
        class: 'conflict',
        kind: 'schedule_room_overlap',
        retryable: false,
        detailSchema: conflictDetailSchema.reference
      },
      {
        class: 'stale_revision',
        kind: 'schedule_placement_changed',
        retryable: false,
        detailSchema: staleDetailSchema.reference
      }
    ],
    allowedFacts: [{ kind: 'schedule_occurrence_changed', version: 1 }],
    allowedEffects: [],
    plan(planningInput, snapshot) {
      const port = snapshot.getPort(schedulePlacementReadPort);
      const scope = parseSchedulePlacementScope(planningInput.scope);
      const { state, vocabulary } = currentState(scope, port);
      const plan = planSchedulePlacementMutation({ planningInput, state, sessions: port, vocabulary });
      const roomId = plan.after?.roomId ?? plan.before?.roomId;
      const room = roomId === undefined
        ? undefined
        : resolveProgramVocabularyItem(vocabulary, 'room', roomId);
      if (!room) throw new TypeError('schedule_placement_room_reference_missing');
      const plannedRoom = plannedProgramVocabularyItem(room);
      return {
        plan,
        aggregateRefs: [
          ...(plan.before
            ? [{ id: `schedule_occurrence:${plan.before.id}`, version: plan.before.version }]
            : []),
          { id: programVocabularyAggregateId(plannedRoom), version: plannedRoom.version }
        ],
        guardRefs: [
          {
            id: schedulePlacementGuardId(plan.input.scope.eventId),
            version: plan.scheduleVersion.before,
            digest: schedulePlacementStateDigest(state)
          },
          {
            id: plan.roomQueryGuard.id,
            version: plan.roomQueryGuard.version,
            digest: plan.roomQueryGuard.digestSha256
          },
          {
            id: programVocabularySetGuardId(plan.input.scope.eventId),
            version: vocabulary.setVersion,
            digest: programVocabularySetDigest(vocabulary)
          }
        ],
        riskTier: 'normal',
        consequences: ['schedule_occurrence_changed']
      };
    },
    projectDiff(plan) {
      return { diff: plan, representedConsequences: ['schedule_occurrence_changed'] };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(schedulePlacementValidationPort);
      let state: SchedulePlacementState;
      let vocabulary: ProgramVocabularyState;
      try {
        ({ state, vocabulary } = currentState(parseSchedulePlacementScope(plan.input.scope), port));
      } catch {
        return { kind: 'outcome', outcome: refusalOutcome('wrong_scope', plan) };
      }
      const refusal = validateSchedulePlacementPlan({ state, sessions: port, vocabulary, plan });
      return refusal
        ? { kind: 'outcome', outcome: refusalOutcome(refusal, plan, state) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(schedulePlacementTransactionPort).applyPlacementPlan(plan);
      return {
        result,
        facts: [{
          kind: 'schedule_occurrence_changed',
          version: 1,
          payload: {
            action: result.action,
            scheduleVersion: result.scheduleVersion,
            occurrence: result.occurrence
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      return derivePlacementCompensation(plan, snapshot);
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorInputSchema, planSchema, diffSchema, resultSchema, staleDetailSchema, conflictDetailSchema],
      definitions: [definition]
    })
  });
}

function currentState(
  scope: SchedulePlacementScope,
  port: SchedulePlacementReadPort
): { readonly state: SchedulePlacementState; readonly vocabulary: ProgramVocabularyState } {
  const state = port.readSchedule(scope);
  const vocabulary = port.readVocabulary(scope);
  if (!state || !vocabulary) throw new TypeError('schedule_scope_missing');
  return { state, vocabulary };
}

function refusalOutcome(
  code: SchedulePlacementPlanningErrorCode,
  plan: SchedulePlacementPlanDto,
  state?: SchedulePlacementState
) {
  if (code === 'room_overlap') {
    const requested = plan.after ?? plan.before;
    if (!requested || !state) throw new TypeError('invalid_schedule_overlap_plan');
    const conflicts = overlappingRoomOccurrences({
      state,
      roomId: requested.roomId,
      startAt: requested.startAt,
      endAt: requested.endAt,
      excludingOccurrenceId: plan.input.occurrenceId
    });
    if (conflicts.length === 0) throw new TypeError('invalid_schedule_overlap_plan');
    return {
      class: 'conflict' as const,
      kind: 'schedule_room_overlap',
      retryable: false,
      subjects: [{ type: 'schedule_occurrence', id: plan.input.occurrenceId }],
      detail: {
        severity: 'block',
        roomId: requested.roomId,
        requested: { startAt: requested.startAt, endAt: requested.endAt },
        conflicts: conflicts.map((occurrence) => ({
          occurrenceId: occurrence.id,
          startAt: occurrence.startAt,
          endAt: occurrence.endAt
        }))
      },
      detailSchemaVersion: 1
    };
  }
  return {
    class: 'stale_revision' as const,
    kind: 'schedule_placement_changed',
    retryable: false,
    subjects: [{ type: 'schedule_occurrence', id: plan.input.occurrenceId }],
    detail: { code, action: plan.input.action, occurrenceId: plan.input.occurrenceId },
    detailSchemaVersion: 1
  };
}

function derivePlacementCompensation(
  plan: SchedulePlacementPlanDto,
  snapshot: ChangesetPlanningSnapshot
): CompensationDerivation<SchedulePlacementPlanningInput> {
  const port = snapshot.getPort(schedulePlacementReadPort);
  let current: SchedulePlacementState;
  try {
    current = currentState(parseSchedulePlacementScope(plan.input.scope), port).state;
  } catch {
    return { kind: 'blocked', reasonKey: 'schedule.scope_missing' };
  }
  const occurrence = current.occurrences.find((candidate) => candidate.id === plan.input.occurrenceId);
  if (plan.input.action === 'place') {
    if (!occurrence || !plan.after || !sameOccurrence(occurrence, plan.after)) {
      return { kind: 'blocked', reasonKey: 'schedule.placement_changed' };
    }
    return {
      kind: 'exact',
      authorInput: {
        action: 'unplace',
        scope: plan.input.scope,
        expectedScheduleVersion: current.scheduleVersion,
        occurrenceId: occurrence.id,
        expectedOccurrenceVersion: occurrence.version
      }
    };
  }
  if (plan.input.action === 'move') {
    if (!occurrence || !plan.before || !plan.after || !sameOccurrence(occurrence, plan.after)) {
      return { kind: 'blocked', reasonKey: 'schedule.placement_changed' };
    }
    return {
      kind: 'exact',
      authorInput: {
        action: 'move',
        scope: plan.input.scope,
        expectedScheduleVersion: current.scheduleVersion,
        occurrenceId: occurrence.id,
        expectedOccurrenceVersion: occurrence.version,
        roomId: plan.before.roomId,
        startAt: plan.before.startAt,
        endAt: plan.before.endAt
      }
    };
  }
  if (occurrence || !plan.before) {
    return { kind: 'blocked', reasonKey: 'schedule.occurrence_identity_reused' };
  }
  return {
    kind: 'exact',
    authorInput: {
      action: 'place',
      scope: plan.input.scope,
      expectedScheduleVersion: current.scheduleVersion,
      occurrenceId: plan.before.id,
      sessionId: plan.before.sessionId,
      roomId: plan.before.roomId,
      startAt: plan.before.startAt,
      endAt: plan.before.endAt
    }
  };
}

function sameOccurrence(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}
