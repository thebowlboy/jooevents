import {
  sessionMutationPlanSchema,
  sessionMutationResultSchema,
  sessionPlanningInputSchema,
  sessionRestorePlanSchema,
  sessionSafeDiffSchema,
  sessionIdSchema,
  type SessionMutationPlanDto,
  type SessionMutationResult,
  type SessionPlanningInput,
  type SessionRestorePlanDto,
  type SessionSafeDiffDto
} from '@jooevents/contracts';
import {
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition
} from '@jooevents/changesets';
import {
  programVocabularyAggregateId,
  programVocabularySetDigest,
  programVocabularySetGuardId,
  type ProgramVocabularyState
} from '@jooevents/program';
import { z } from 'zod';
import {
  applySessionRestorePlan,
  planSessionCompensation,
  planSessionMutation,
  sessionAggregateId,
  sessionCatalogGuardId,
  validateSessionMutationPlan,
  type SessionPlanningErrorCode
} from './domain';
import { parseSessionScope, type SessionCatalog, type SessionReadPort } from './model';

export const SESSION_CHANGESET_KIND = 'session.mutate';
export const SESSION_CHANGESET_VERSION = 1;

type SessionChangesetAuthorInput = SessionPlanningInput | SessionRestorePlanDto;
type SessionChangesetPlan = SessionMutationPlanDto | SessionRestorePlanDto;

export interface SessionChangesetReadPort extends SessionReadPort {
  readSessionVocabulary(scope: ReturnType<typeof parseSessionScope>): ProgramVocabularyState | undefined;
}

export interface SessionChangesetTransactionPort extends SessionChangesetReadPort {
  applySessionPlan(plan: SessionChangesetPlan): SessionMutationResult;
}

export const sessionReadPort = defineChangesetReadPort<SessionChangesetReadPort>('session.read', 1);
export const sessionValidationPort = defineChangesetValidationPort<SessionChangesetReadPort>('session.validation', 1);
export const sessionTransactionPort = defineChangesetTransactionPort<SessionChangesetTransactionPort>('session.transaction', 1);

const combinedPlanSchema = z.union([sessionMutationPlanSchema, sessionRestorePlanSchema]);
const authorInputSchema = defineChangesetSchema({
  key: 'session.planning_input', version: 1,
  schema: z.union([sessionPlanningInputSchema, sessionRestorePlanSchema])
});
const planSchema = defineChangesetSchema({ key: 'session.plan', version: 1, schema: combinedPlanSchema });
const diffSchema = defineChangesetSchema({ key: 'session.safe_diff', version: 1, schema: sessionSafeDiffSchema });
const resultSchema = defineChangesetSchema({ key: 'session.result', version: 1, schema: sessionMutationResultSchema });
const staleDetailSchema = defineChangesetSchema({
  key: 'session.stale_detail', version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_scope', 'stale_catalog', 'session_exists', 'session_missing', 'stale_session',
      'format_missing', 'format_retired', 'track_missing', 'track_retired',
      'invalid_transition', 'invalid_plan'
    ]),
    action: z.enum(['create', 'transition', 'restore']),
    sessionId: sessionIdSchema
  })
});

type SessionDefinition = ChangesetOperationDefinition<
  SessionChangesetAuthorInput,
  SessionChangesetPlan,
  SessionSafeDiffDto,
  SessionChangesetPlan,
  SessionMutationResult
>;

export interface SessionChangesetBundle {
  readonly definition: SessionDefinition;
  readonly registry: ChangesetDefinitionRegistry;
}

export function createSessionChangesetBundle(): SessionChangesetBundle {
  const definition: SessionDefinition = {
    kind: SESSION_CHANGESET_KIND,
    version: SESSION_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [sessionReadPort],
    validationPorts: [sessionValidationPort],
    transactionPorts: [sessionTransactionPort],
    allowedAggregateKinds: ['session', 'program_format', 'program_track'],
    allowedGuardKinds: ['session_catalog', 'program_vocabulary_set'],
    allowedRisks: ['normal'],
    allowedConsequences: ['session_changed'],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'session.changed', retryable: false,
      detailSchema: staleDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'session_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const port = snapshot.getPort(sessionReadPort);
      if (isRestorePlan(authorInput)) {
        const catalog = port.readSessionCatalog(parseSessionScope(authorInput.scope));
        if (!catalog) throw new TypeError('session_scope_missing');
        applySessionRestorePlan({ plan: authorInput, catalog });
        return {
          plan: authorInput,
          aggregateRefs: [{ id: sessionAggregateId(authorInput.expectedCurrent.id), version: authorInput.expectedCurrent.version }],
          guardRefs: [{
            id: sessionCatalogGuardId(authorInput.scope.eventId),
            version: catalog.version,
            digest: catalog.digestSha256
          }],
          riskTier: 'normal', consequences: ['session_changed']
        };
      }
      const { catalog, vocabulary } = environment(authorInput.scope, port);
      const plan = planSessionMutation({ planningInput: authorInput, catalog, vocabulary });
      const targetItems = [plan.after.programTarget.format, plan.after.programTarget.track]
        .filter((item): item is NonNullable<typeof item> => item !== null);
      return {
        plan,
        aggregateRefs: [
          ...(plan.before ? [{ id: sessionAggregateId(plan.before.id), version: plan.before.version }] : []),
          ...targetItems.map((item) => ({ id: programVocabularyAggregateId(item), version: item.version }))
        ],
        guardRefs: [
          { id: sessionCatalogGuardId(plan.input.scope.eventId), version: catalog.version, digest: catalog.digestSha256 },
          {
            id: programVocabularySetGuardId(plan.input.scope.eventId),
            version: vocabulary.setVersion,
            digest: programVocabularySetDigest(vocabulary)
          }
        ],
        riskTier: 'normal', consequences: ['session_changed']
      };
    },
    projectDiff(plan) {
      if (isRestorePlan(plan)) {
        return {
          diff: { action: 'restore', before: plan.expectedCurrent, after: plan.restore },
          representedConsequences: ['session_changed']
        };
      }
      return {
        diff: { action: plan.input.action, before: plan.before, after: plan.after },
        representedConsequences: ['session_changed']
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(sessionValidationPort);
      if (isRestorePlan(plan)) {
        const catalog = port.readSessionCatalog(parseSessionScope(plan.scope));
        if (!catalog) return { kind: 'outcome', outcome: refusalOutcome('wrong_scope', plan) };
        try {
          applySessionRestorePlan({ plan, catalog });
          return { kind: 'ready', validated: plan };
        } catch {
          return { kind: 'outcome', outcome: refusalOutcome('stale_session', plan) };
        }
      }
      let catalog: SessionCatalog;
      let vocabulary: ProgramVocabularyState;
      try {
        ({ catalog, vocabulary } = environment(plan.input.scope, port));
      } catch {
        return { kind: 'outcome', outcome: refusalOutcome('wrong_scope', plan) };
      }
      const refusal = validateSessionMutationPlan({ plan, catalog, vocabulary });
      return refusal
        ? { kind: 'outcome', outcome: refusalOutcome(refusal, plan) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(sessionTransactionPort).applySessionPlan(plan);
      return {
        result,
        facts: [{ kind: 'session_changed', version: 1, payload: result }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      if (isRestorePlan(plan)) return { kind: 'blocked', reasonKey: 'session.compensation_of_compensation' };
      const port = snapshot.getPort(sessionReadPort);
      const catalog = port.readSessionCatalog(parseSessionScope(plan.input.scope));
      if (!catalog) return { kind: 'blocked', reasonKey: 'session.scope_missing' };
      try {
        return {
          kind: 'exact',
          authorInput: planSessionCompensation({
            original: plan,
            catalog,
            actorUserId: plan.input.actorUserId,
            occurredAt: plan.input.occurredAt
          })
        };
      } catch {
        return { kind: 'blocked', reasonKey: 'session.changed' };
      }
    }
  };
  return Object.freeze({
    definition,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorInputSchema, planSchema, diffSchema, resultSchema, staleDetailSchema],
      definitions: [definition]
    })
  });
}

function environment(
  scopeInput: SessionPlanningInput['scope'],
  port: SessionChangesetReadPort
): { readonly catalog: SessionCatalog; readonly vocabulary: ProgramVocabularyState } {
  const scope = parseSessionScope(scopeInput);
  const catalog = port.readSessionCatalog(scope);
  const vocabulary = port.readSessionVocabulary(scope);
  if (!catalog || !vocabulary) throw new TypeError('session_scope_missing');
  return { catalog, vocabulary };
}

function refusalOutcome(code: SessionPlanningErrorCode, plan: SessionChangesetPlan) {
  const action = isRestorePlan(plan) ? 'restore' as const : plan.input.action;
  const sessionId = isRestorePlan(plan) ? plan.expectedCurrent.id : plan.after.id;
  return Object.freeze({
    class: 'stale_revision' as const,
    kind: 'session.changed',
    retryable: false,
    subjects: [{ type: 'session', id: sessionId }],
    detail: Object.freeze({ code, action, sessionId }),
    detailSchemaVersion: 1
  });
}

function isRestorePlan(value: SessionChangesetAuthorInput | SessionChangesetPlan): value is SessionRestorePlanDto {
  return 'action' in value && value.action === 'restore';
}
