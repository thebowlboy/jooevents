import {
  signalDefinitionSchema,
  signalObservationRetractionSchema,
  signalObservationSchema,
  signalScopeSchema,
  type SignalDefinitionDto,
  type SignalObservationDto,
  type SignalObservationRetractionDto,
  type SignalScopeDto
} from '@jooevents/contracts/signals';

export interface SignalRepository {
  listDefinitions(scope: SignalScopeDto): readonly SignalDefinitionDto[];
  readDefinition(scope: SignalScopeDto, key: string): SignalDefinitionDto | undefined;
  readObservation(scope: SignalScopeDto, observationId: string): SignalObservationDto | undefined;
  readCurrentHumanFlag(input: {
    readonly scope: SignalScopeDto;
    readonly definitionKey: string;
    readonly subjectId: string;
    readonly actorReviewerId: string;
    readonly reviewPlanId: string;
  }): SignalObservationDto | undefined;
  listCurrentHumanFlags(input: {
    readonly scope: SignalScopeDto;
    readonly definitionKey?: string;
    readonly actorReviewerId: string;
    readonly reviewPlanId?: string;
  }): readonly SignalObservationDto[];
}

export interface SignalTransactionRepository extends SignalRepository {
  insertObservation(observation: SignalObservationDto): void;
  insertRetraction(retraction: SignalObservationRetractionDto): void;
}

export function parseSignalScope(value: unknown): SignalScopeDto {
  return Object.freeze(signalScopeSchema.parse(value));
}

export function parseSignalDefinition(value: unknown): SignalDefinitionDto {
  return deepFreeze(signalDefinitionSchema.parse(value));
}

export function parseSignalObservation(value: unknown): SignalObservationDto {
  return deepFreeze(signalObservationSchema.parse(value));
}

export function parseSignalObservationRetraction(value: unknown): SignalObservationRetractionDto {
  return deepFreeze(signalObservationRetractionSchema.parse(value));
}

export function sameSignalScope(
  left: { readonly workspaceId: string; readonly eventId: string },
  right: { readonly workspaceId: string; readonly eventId: string }
): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
