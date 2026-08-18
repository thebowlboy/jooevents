import {
  signalHumanFlagPlanSchema,
  signalHumanFlagPlanningInputSchema,
  type SignalHumanFlagPlanDto,
  type SignalHumanFlagPlanningInput
} from '@jooevents/contracts/signals';
import {
  parseSignalDefinition,
  parseSignalObservation,
  parseSignalObservationRetraction,
  parseSignalScope,
  type SignalRepository,
  type SignalTransactionRepository
} from './model';

export type SignalHumanFlagPlanningErrorCode =
  | 'definition_missing'
  | 'definition_retired'
  | 'stale_definition'
  | 'not_human_flag_definition'
  | 'flag_already_recorded'
  | 'write_cap_exceeded'
  | 'observation_missing'
  | 'stale_observation';

export class SignalHumanFlagPlanningError extends Error {
  constructor(
    readonly code: SignalHumanFlagPlanningErrorCode,
    readonly detail: { readonly holderSubjectIds?: readonly string[] } = {}
  ) {
    super(code);
    this.name = 'SignalHumanFlagPlanningError';
  }
}

/**
 * Plans one human flag observation against definition data. Review proves the
 * assignment/commit relationship before calling this generic Signal rule.
 */
export function planSignalHumanFlagChange(input: {
  readonly repository: SignalRepository;
  readonly planningInput: SignalHumanFlagPlanningInput;
}): SignalHumanFlagPlanDto {
  const request = signalHumanFlagPlanningInputSchema.parse(input.planningInput);
  const scope = parseSignalScope(request.scope);
  const definition = input.repository.readDefinition(scope, request.definitionKey);
  if (!definition) throw new SignalHumanFlagPlanningError('definition_missing');
  const parsedDefinition = parseSignalDefinition(definition);
  if (parsedDefinition.status !== 'active') {
    throw new SignalHumanFlagPlanningError('definition_retired');
  }
  if (parsedDefinition.version !== request.expectedDefinitionVersion) {
    throw new SignalHumanFlagPlanningError('stale_definition');
  }
  if (!parsedDefinition.key.startsWith('accolade.')
      || parsedDefinition.family !== 'quality'
      || parsedDefinition.valueKind !== 'flag'
      || parsedDefinition.direction !== 'neutral'
      || parsedDefinition.visibility !== 'reviewer'
      || !parsedDefinition.subjects.includes('submission')
      || !parsedDefinition.allowedProvenance.includes('human')) {
    throw new SignalHumanFlagPlanningError('not_human_flag_definition');
  }
  const current = input.repository.readCurrentHumanFlag({
    scope,
    definitionKey: parsedDefinition.key,
    subjectId: request.subjectId,
    actorReviewerId: request.actorReviewerId,
    reviewPlanId: request.reviewPlanId
  });
  if (request.action === 'record_human_flag') {
    if (current) throw new SignalHumanFlagPlanningError('flag_already_recorded');
    const holders = input.repository.listCurrentHumanFlags({
      scope,
      definitionKey: parsedDefinition.key,
      actorReviewerId: request.actorReviewerId,
      reviewPlanId: request.reviewPlanId
    });
    const cap = parsedDefinition.writeCaps?.perActorPerPlan;
    if (cap !== undefined && holders.length >= cap) {
      throw new SignalHumanFlagPlanningError('write_cap_exceeded', {
        holderSubjectIds: Object.freeze(holders.map((entry) => entry.subject.id).sort())
      });
    }
    const observation = parseSignalObservation({
      schemaVersion: 1,
      id: request.observationId,
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      subject: { kind: 'submission', id: request.subjectId },
      definitionKey: parsedDefinition.key,
      definitionVersion: parsedDefinition.version,
      value: true,
      provenance: {
        kind: 'human',
        actorReviewerId: request.actorReviewerId,
        actorUserId: request.actorUserId,
        reviewPlanId: request.reviewPlanId
      },
      computedAt: request.attributedAt,
      inputVersions: { definition: parsedDefinition.version }
    });
    return signalHumanFlagPlanSchema.parse({
      action: request.action,
      input: request,
      definition: parsedDefinition,
      observation
    });
  }
  if (!current) throw new SignalHumanFlagPlanningError('observation_missing');
  if (current.id !== request.expectedObservationId) {
    throw new SignalHumanFlagPlanningError('stale_observation');
  }
  const observation = parseSignalObservation(current);
  const retraction = parseSignalObservationRetraction({
    schemaVersion: 1,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    observationId: observation.id,
    reason: request.reason,
    retractedByUserId: request.actorUserId,
    retractedAt: request.attributedAt
  });
  return signalHumanFlagPlanSchema.parse({
    action: request.action,
    input: request,
    definition: parsedDefinition,
    observation,
    retraction
  });
}

export function applySignalHumanFlagPlan(
  repository: SignalTransactionRepository,
  planInput: SignalHumanFlagPlanDto
): void {
  const plan = signalHumanFlagPlanSchema.parse(planInput);
  if (plan.action === 'record_human_flag') repository.insertObservation(plan.observation);
  else repository.insertRetraction(plan.retraction);
}
