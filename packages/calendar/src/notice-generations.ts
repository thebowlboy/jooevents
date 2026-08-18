import { calendarScopeSchema, type CalendarScope } from '@jooevents/contracts/calendar';

export type CalendarNoticeMethod = 'request' | 'cancel';
export type CalendarNoticeGenerationStateName = 'open' | 'sealed' | 'released';
export type CalendarNoticeSealReason =
  | 'window_expired'
  | 'near_event_bypass'
  | 'manual_release';

export interface CalendarNoticeGenerationItem {
  readonly commitmentId: string;
  readonly method: CalendarNoticeMethod;
  readonly sequence: number;
  readonly lastIntakePosition: number;
}

export interface CalendarNoticeGeneration {
  readonly id: string;
  readonly scope: CalendarScope;
  readonly personId: string;
  readonly generationNumber: number;
  readonly state: CalendarNoticeGenerationStateName;
  readonly openedAt: string;
  readonly openedIntakePosition: number;
  readonly sealAt: string;
  readonly held: boolean;
  readonly sealReason: CalendarNoticeSealReason | null;
  readonly sealedAt: string | null;
  readonly sealedIntakePosition: number | null;
  readonly releaseId: string | null;
  readonly items: readonly CalendarNoticeGenerationItem[];
}

export interface CalendarNoticeGenerationProjection {
  readonly schemaVersion: 1;
  readonly scope: CalendarScope;
  readonly generations: readonly CalendarNoticeGeneration[];
}

export interface CalendarNoticeGenerationIdentityFactory {
  mintGeneration(input: {
    readonly scope: CalendarScope;
    readonly personId: string;
    readonly generationNumber: number;
  }): string;
}

export interface CalendarNoticeChange {
  readonly personId: string;
  readonly commitmentId: string;
  readonly method: CalendarNoticeMethod;
  readonly sequence: number;
  readonly intakePosition: number;
  readonly occurredAt: string;
  readonly priorStartAt: string | null;
  readonly newStartAt: string | null;
}

function instantMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`calendar_notice_${label}_invalid`);
  return parsed;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`calendar_notice_${label}_invalid`);
  }
}

function generationKey(generation: CalendarNoticeGeneration): string {
  return `${generation.personId}\u0000${String(generation.generationNumber).padStart(12, '0')}`;
}

function freezeGeneration(generation: CalendarNoticeGeneration): CalendarNoticeGeneration {
  return Object.freeze({
    ...generation,
    scope: Object.freeze({ ...generation.scope }),
    items: Object.freeze([...generation.items]
      .sort((left, right) => left.commitmentId.localeCompare(right.commitmentId))
      .map((item) => Object.freeze({ ...item })))
  });
}

function freezeProjection(input: {
  readonly scope: CalendarScope;
  readonly generations: readonly CalendarNoticeGeneration[];
}): CalendarNoticeGenerationProjection {
  return Object.freeze({
    schemaVersion: 1,
    scope: Object.freeze({ ...input.scope }),
    generations: Object.freeze([...input.generations]
      .sort((left, right) => generationKey(left).localeCompare(generationKey(right)))
      .map(freezeGeneration))
  });
}

export function createCalendarNoticeGenerationProjection(
  scope: CalendarScope
): CalendarNoticeGenerationProjection {
  return freezeProjection({ scope: calendarScopeSchema.parse(scope), generations: [] });
}

function isNearEvent(input: {
  readonly occurredAtMs: number;
  readonly thresholdMs: number;
  readonly startAt: string | null;
}): boolean {
  if (input.startAt === null) return false;
  const startAtMs = instantMs(input.startAt, 'start_at');
  return startAtMs >= input.occurredAtMs
    && startAtMs - input.occurredAtMs <= input.thresholdMs;
}

/** Applies one ordered net artifact change. It performs no release or external I/O. */
export function applyCalendarNoticeChange(input: {
  readonly projection: CalendarNoticeGenerationProjection;
  readonly change: CalendarNoticeChange;
  readonly windowMilliseconds: number;
  readonly nearEventMilliseconds: number;
  readonly identities: CalendarNoticeGenerationIdentityFactory;
}): CalendarNoticeGenerationProjection {
  const scope = calendarScopeSchema.parse(input.projection.scope);
  assertPositiveInteger(input.change.intakePosition, 'intake_position');
  if (!Number.isSafeInteger(input.change.sequence) || input.change.sequence < 0) {
    throw new TypeError('calendar_notice_sequence_invalid');
  }
  if (!Number.isSafeInteger(input.windowMilliseconds) || input.windowMilliseconds < 0
      || !Number.isSafeInteger(input.nearEventMilliseconds) || input.nearEventMilliseconds < 0) {
    throw new TypeError('calendar_notice_policy_invalid');
  }
  const occurredAtMs = instantMs(input.change.occurredAt, 'occurred_at');
  const generations = input.projection.generations.map((generation) => freezeGeneration(generation));
  const open = generations.filter((generation) =>
    generation.personId === input.change.personId && generation.state === 'open');
  if (open.length > 1) throw new TypeError('calendar_notice_open_generation_conflict');
  let generation = open[0];
  if (!generation) {
    const priorNumbers = generations
      .filter((candidate) => candidate.personId === input.change.personId)
      .map((candidate) => candidate.generationNumber);
    const generationNumber = (priorNumbers.length === 0 ? 0 : Math.max(...priorNumbers)) + 1;
    generation = freezeGeneration({
      id: input.identities.mintGeneration({
        scope, personId: input.change.personId, generationNumber
      }),
      scope,
      personId: input.change.personId,
      generationNumber,
      state: 'open',
      openedAt: input.change.occurredAt,
      openedIntakePosition: input.change.intakePosition,
      sealAt: new Date(occurredAtMs + input.windowMilliseconds).toISOString(),
      held: false,
      sealReason: null,
      sealedAt: null,
      sealedIntakePosition: null,
      releaseId: null,
      items: []
    });
    generations.push(generation);
  }
  const prior = generation.items.find((item) => item.commitmentId === input.change.commitmentId);
  if (prior && input.change.intakePosition <= prior.lastIntakePosition) {
    throw new TypeError('calendar_notice_item_intake_regression');
  }
  const items = generation.items.filter((item) => item.commitmentId !== input.change.commitmentId);
  items.push({
    commitmentId: input.change.commitmentId,
    method: input.change.method,
    sequence: input.change.sequence,
    lastIntakePosition: input.change.intakePosition
  });
  const urgent = isNearEvent({
    occurredAtMs,
    thresholdMs: input.nearEventMilliseconds,
    startAt: input.change.priorStartAt
  }) || isNearEvent({
    occurredAtMs,
    thresholdMs: input.nearEventMilliseconds,
    startAt: input.change.newStartAt
  });
  const updated = freezeGeneration({
    ...generation,
    items,
    ...(urgent
      ? {
          state: 'sealed' as const,
          sealReason: 'near_event_bypass' as const,
          sealedAt: input.change.occurredAt,
          sealedIntakePosition: input.change.intakePosition
        }
      : {})
  });
  return freezeProjection({
    scope,
    generations: generations.map((candidate) => candidate.id === updated.id ? updated : candidate)
  });
}

export function setCalendarNoticeGenerationHold(input: {
  readonly projection: CalendarNoticeGenerationProjection;
  readonly generationId: string;
  readonly held: boolean;
}): CalendarNoticeGenerationProjection {
  let found = false;
  const generations = input.projection.generations.map((generation) => {
    if (generation.id !== input.generationId) return generation;
    found = true;
    if (generation.state !== 'open') throw new TypeError('calendar_notice_hold_requires_open');
    return freezeGeneration({ ...generation, held: input.held });
  });
  if (!found) throw new TypeError('calendar_notice_generation_missing');
  return freezeProjection({ scope: input.projection.scope, generations });
}

export function sealDueCalendarNoticeGenerations(input: {
  readonly projection: CalendarNoticeGenerationProjection;
  readonly evaluatedAt: string;
}): CalendarNoticeGenerationProjection {
  const evaluatedAtMs = instantMs(input.evaluatedAt, 'evaluated_at');
  return freezeProjection({
    scope: input.projection.scope,
    generations: input.projection.generations.map((generation) =>
      generation.state === 'open' && !generation.held
        && instantMs(generation.sealAt, 'seal_at') <= evaluatedAtMs
        ? freezeGeneration({
            ...generation,
            state: 'sealed',
            sealReason: 'window_expired',
            sealedAt: input.evaluatedAt,
            sealedIntakePosition: Math.max(...generation.items.map((item) => item.lastIntakePosition))
          })
        : generation)
  });
}

export function manuallySealCalendarNoticeGeneration(input: {
  readonly projection: CalendarNoticeGenerationProjection;
  readonly generationId: string;
  readonly sealedAt: string;
}): CalendarNoticeGenerationProjection {
  instantMs(input.sealedAt, 'sealed_at');
  let found = false;
  const generations = input.projection.generations.map((generation) => {
    if (generation.id !== input.generationId) return generation;
    found = true;
    if (generation.state !== 'open') throw new TypeError('calendar_notice_manual_release_requires_open');
    return freezeGeneration({
      ...generation,
      state: 'sealed',
      held: false,
      sealReason: 'manual_release',
      sealedAt: input.sealedAt,
      sealedIntakePosition: Math.max(...generation.items.map((item) => item.lastIntakePosition))
    });
  });
  if (!found) throw new TypeError('calendar_notice_generation_missing');
  return freezeProjection({ scope: input.projection.scope, generations });
}

export function recordCalendarNoticeGenerationRelease(input: {
  readonly projection: CalendarNoticeGenerationProjection;
  readonly generationId: string;
  readonly releaseId: string;
}): CalendarNoticeGenerationProjection {
  let found = false;
  const generations = input.projection.generations.map((generation) => {
    if (generation.id !== input.generationId) return generation;
    found = true;
    if (generation.state === 'released') {
      if (generation.releaseId !== input.releaseId) {
        throw new TypeError('calendar_notice_release_identity_conflict');
      }
      return generation;
    }
    if (generation.state !== 'sealed') throw new TypeError('calendar_notice_release_requires_sealed');
    return freezeGeneration({ ...generation, state: 'released', releaseId: input.releaseId });
  });
  if (!found) throw new TypeError('calendar_notice_generation_missing');
  return freezeProjection({ scope: input.projection.scope, generations });
}
