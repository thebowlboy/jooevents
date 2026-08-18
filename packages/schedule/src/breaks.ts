import {
  scheduleBreakHeadSchema,
  scheduleBreakPlanSchema,
  scheduleBreakPlanningInputSchema,
  scheduleBreakResultSchema,
  type ScheduleBreakHeadDto,
  type ScheduleBreakPlanDto,
  type ScheduleBreakPlanningInput,
  type ScheduleBreakResult
} from '@jooevents/contracts';
import { encodeCanonicalJson, parseAggregateVersion } from '@jooevents/kernel';
import { resolveProgramVocabularyItem, type ProgramVocabularyState } from '@jooevents/program';
import { parseSchedulePlacementScope, sameScheduleScope, type SchedulePlacementScope } from './model';

export interface ScheduleBreakEventGuard {
  readonly version: number;
  readonly startDate: string;
  readonly endDate: string;
}

export interface ScheduleBreakState {
  readonly scope: SchedulePlacementScope;
  readonly scheduleVersion: number;
  /** Active and removed heads; current projections filter to active. */
  readonly breaks: readonly ScheduleBreakHeadDto[];
  readonly event: ScheduleBreakEventGuard;
}

export type ScheduleBreakPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_schedule'
  | 'stale_vocabulary'
  | 'stale_event'
  | 'break_exists'
  | 'break_missing'
  | 'stale_break'
  | 'break_not_active'
  | 'break_not_removed'
  | 'room_missing'
  | 'room_retired'
  | 'day_outside_event'
  | 'invalid_plan';

export class ScheduleBreakPlanningError extends Error {
  constructor(readonly code: ScheduleBreakPlanningErrorCode) {
    super(code);
    this.name = 'ScheduleBreakPlanningError';
  }
}

export interface ScheduleBreakTransactionRepository {
  readBreakState(scope: SchedulePlacementScope): ScheduleBreakState | undefined;
  readVocabulary(scope: SchedulePlacementScope): ProgramVocabularyState | undefined;
  applyBreakPlan(plan: ScheduleBreakPlanDto): ScheduleBreakResult;
}

export function planScheduleBreakMutation(input: {
  readonly planningInput: ScheduleBreakPlanningInput;
  readonly state: ScheduleBreakState;
  readonly vocabulary: ProgramVocabularyState;
}): ScheduleBreakPlanDto {
  const planningInput = scheduleBreakPlanningInputSchema.parse(input.planningInput);
  const scope = parseSchedulePlacementScope(planningInput.scope);
  if (!sameScheduleScope(input.state.scope, scope)
      || !sameScheduleScope(input.vocabulary.scope, scope)) {
    throw new ScheduleBreakPlanningError('wrong_scope');
  }
  if (input.state.scheduleVersion !== planningInput.expectedScheduleVersion) {
    throw new ScheduleBreakPlanningError('stale_schedule');
  }
  const byId = new Map(input.state.breaks.map((head) => [head.id, head]));
  let before: ScheduleBreakHeadDto[] = [];
  let after: ScheduleBreakHeadDto[] = [];

  if (planningInput.action === 'break_add') {
    if (planningInput.dayKey < input.state.event.startDate
        || planningInput.dayKey > input.state.event.endDate) {
      throw new ScheduleBreakPlanningError('day_outside_event');
    }
    for (const item of planningInput.breaks) {
      if (byId.has(item.id)) throw new ScheduleBreakPlanningError('break_exists');
      const room = resolveProgramVocabularyItem(input.vocabulary, 'room', item.roomId);
      if (!room) throw new ScheduleBreakPlanningError('room_missing');
      if (room.status !== 'active') throw new ScheduleBreakPlanningError('room_retired');
      after.push(scheduleBreakHeadSchema.parse({
        id: item.id,
        label: planningInput.label,
        dayKey: planningInput.dayKey,
        roomId: item.roomId,
        startMin: planningInput.startMin,
        endMin: planningInput.endMin,
        status: 'active',
        version: 1
      }));
    }
  } else {
    for (const expected of planningInput.breaks) {
      const head = byId.get(expected.id);
      if (!head) throw new ScheduleBreakPlanningError('break_missing');
      if (head.version !== expected.expectedVersion) {
        throw new ScheduleBreakPlanningError('stale_break');
      }
      if (planningInput.action === 'break_remove' && head.status !== 'active') {
        throw new ScheduleBreakPlanningError('break_not_active');
      }
      if (planningInput.action === 'break_restore' && head.status !== 'removed') {
        throw new ScheduleBreakPlanningError('break_not_removed');
      }
      const room = resolveProgramVocabularyItem(input.vocabulary, 'room', head.roomId);
      if (!room) throw new ScheduleBreakPlanningError('room_missing');
      if (planningInput.action === 'break_restore' && room.status !== 'active') {
        throw new ScheduleBreakPlanningError('room_retired');
      }
      if (planningInput.action === 'break_restore'
          && (head.dayKey < input.state.event.startDate || head.dayKey > input.state.event.endDate)) {
        throw new ScheduleBreakPlanningError('day_outside_event');
      }
      before.push(head);
      after.push(scheduleBreakHeadSchema.parse({
        ...head,
        status: planningInput.action === 'break_remove' ? 'removed' : 'active',
        version: head.version + 1
      }));
    }
  }

  before = before.sort(compareBreakHeads);
  after = after.sort(compareBreakHeads);
  return scheduleBreakPlanSchema.parse({
    input: planningInput,
    before,
    after,
    scheduleVersion: {
      before: input.state.scheduleVersion,
      after: input.state.scheduleVersion + 1
    },
    vocabularySetVersion: input.vocabulary.setVersion,
    eventGuard: input.state.event
  });
}

export function validateScheduleBreakPlan(input: {
  readonly state: ScheduleBreakState;
  readonly vocabulary: ProgramVocabularyState;
  readonly plan: ScheduleBreakPlanDto;
}): ScheduleBreakPlanningErrorCode | undefined {
  if (input.vocabulary.setVersion !== input.plan.vocabularySetVersion) return 'stale_vocabulary';
  if (canonical(input.state.event) !== canonical(input.plan.eventGuard)) return 'stale_event';
  try {
    const rebuilt = planScheduleBreakMutation({
      planningInput: input.plan.input,
      state: input.state,
      vocabulary: input.vocabulary
    });
    return canonical(rebuilt) === canonical(input.plan) ? undefined : 'invalid_plan';
  } catch (error) {
    return error instanceof ScheduleBreakPlanningError ? error.code : 'invalid_plan';
  }
}

export function applyScheduleBreakPlan(input: {
  readonly state: ScheduleBreakState;
  readonly vocabulary: ProgramVocabularyState;
  readonly plan: ScheduleBreakPlanDto;
}): { readonly state: ScheduleBreakState; readonly result: ScheduleBreakResult } {
  const refusal = validateScheduleBreakPlan(input);
  if (refusal) throw new ScheduleBreakPlanningError(refusal);
  const changed = new Set(input.plan.after.map((head) => head.id));
  const breaks = input.state.breaks.filter((head) => !changed.has(head.id));
  breaks.push(...input.plan.after);
  breaks.sort(compareBreakHeads);
  const state = deepFreeze({
    scope: input.state.scope,
    scheduleVersion: parseAggregateVersion(input.plan.scheduleVersion.after),
    breaks,
    event: input.state.event
  });
  return Object.freeze({
    state,
    result: scheduleBreakResultSchema.parse({
      action: input.plan.input.action,
      scheduleVersion: state.scheduleVersion,
      breaks: input.plan.after
    })
  });
}

export function compareBreakHeads(left: ScheduleBreakHeadDto, right: ScheduleBreakHeadDto): number {
  if (left.dayKey !== right.dayKey) return left.dayKey < right.dayKey ? -1 : 1;
  if (left.startMin !== right.startMin) return left.startMin - right.startMin;
  if (left.roomId !== right.roomId) return left.roomId < right.roomId ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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
