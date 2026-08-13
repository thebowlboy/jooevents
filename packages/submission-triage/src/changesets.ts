import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import { CHANGESET_LIFECYCLE_ACCESS_POLICY } from '@jooevents/changeset-operations';
import {
  SUBMISSION_TRIAGE_BULK_MAX,
  submissionArrivalFactSchema,
  submissionTriageActionSchema,
  submissionTriageAttributionSchema,
  submissionTriageExpectedHeadSchema,
  submissionTriageHeadSchema,
  submissionTriageQueryGuardSchema,
  submissionTriageSafeDiffSchema,
  submissionTriageStateSchema,
  type SubmissionTriageAction,
  type SubmissionTriageAttribution
} from '@jooevents/contracts/submission-triage';
import {
  intakeDigestSchema,
  intakeIdInputSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeVersionSchema,
  type IntakeScopeDto
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
import { z } from 'zod';
import {
  SubmissionTriageDomainError,
  parseSubmissionTriageState,
  planSubmissionTriageExactRestore,
  planSubmissionTriageTransition,
  submissionTriageArrivalDigest,
  submissionTriageHeadDigest,
  submissionTriageSafeDiff,
  submissionTriageTransitionResult,
  validateSubmissionTriagePlan,
  type SubmissionTriageDomainErrorCode,
  type SubmissionTriageExactRestoreTarget,
  type SubmissionTriageReadPort,
  type SubmissionTriageStateSnapshot,
  type SubmissionTriageTransactionPort,
  type SubmissionTriageTransitionPlan,
  type SubmissionTriageTransitionResult
} from './model';
import { SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY } from './policy';

export const SUBMISSION_TRIAGE_CHANGESET_KIND = 'submission.triage.transition';
export const SUBMISSION_TRIAGE_CHANGESET_VERSION = 1;

export type SubmissionTriageChangesetAuthorInput =
  | {
      readonly action: SubmissionTriageAction;
      readonly scope: IntakeScopeDto;
      readonly submissionIds: readonly string[];
      readonly expectedHeads: readonly { readonly submissionId: string; readonly version: number }[];
      readonly expectedQueryGuard: { readonly version: number; readonly digestSha256: string };
    }
  | {
      /** Internal-only author input produced by the generic compensation planner. */
      readonly action: 'restore_exact';
      readonly scope: IntakeScopeDto;
      readonly targets: readonly SubmissionTriageExactRestoreTarget[];
    };

/**
 * A transaction composition supplies the authentic invocation and its exact
 * current-authority recheck. Attribution never comes from author input.
 */
export interface SubmissionTriagePlanningAttributionSource {
  readonly context: EffectInvocationContext;
  readonly authorityRecheck: SealedEffectAuthorityRecheckResult;
}

export interface SubmissionTriagePlanningAttributionReadPort {
  readSubmissionTriagePlanningAttribution(
    scope: IntakeScopeDto
  ): SubmissionTriagePlanningAttributionSource | undefined;
}

export const submissionTriageChangesetReadPort =
  defineChangesetReadPort<SubmissionTriageReadPort>('submission_triage.read', 1);
export const submissionTriageChangesetValidationPort =
  defineChangesetValidationPort<SubmissionTriageReadPort>('submission_triage.validation', 1);
export const submissionTriageChangesetTransactionPort =
  defineChangesetTransactionPort<SubmissionTriageTransactionPort>('submission_triage.transaction', 1);
export const submissionTriagePlanningAttributionReadPort =
  defineChangesetReadPort<SubmissionTriagePlanningAttributionReadPort>(
    'submission_triage.planning_attribution', 1
  );

const ordinaryAuthorSchema = z.strictObject({
  action: submissionTriageActionSchema,
  scope: intakeScopeSchema,
  submissionIds: z.array(intakeIdInputSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX),
  expectedHeads: z.array(submissionTriageExpectedHeadSchema)
    .min(1).max(SUBMISSION_TRIAGE_BULK_MAX),
  expectedQueryGuard: z.strictObject({
    version: intakeVersionSchema,
    digestSha256: intakeDigestSchema
  })
}).superRefine((value, context) => {
  canonicalIdIssues(value.submissionIds, context, ['submissionIds']);
  canonicalIdIssues(value.expectedHeads.map((head) => head.submissionId), context, ['expectedHeads']);
  if (value.submissionIds.length !== value.expectedHeads.length
      || value.submissionIds.some((id, index) => id !== value.expectedHeads[index]?.submissionId)) {
    context.addIssue({
      code: 'custom', path: ['expectedHeads'],
      message: 'expected heads must match selected submission ids exactly'
    });
  }
});

const restoreTargetSchema: z.ZodType<SubmissionTriageExactRestoreTarget> = z.strictObject({
  submissionId: intakeIdInputSchema,
  expectedCurrentVersion: intakeVersionSchema,
  state: submissionTriageStateSchema,
  setAsideAttribution: submissionTriageAttributionSchema.nullable()
}).superRefine((value, context) => {
  if ((value.state === 'set_aside') !== (value.setAsideAttribution !== null)) {
    context.addIssue({
      code: 'custom', path: ['setAsideAttribution'],
      message: 'restored set-aside attribution must match restored state'
    });
  }
});

const exactRestoreAuthorSchema = z.strictObject({
  action: z.literal('restore_exact'),
  scope: intakeScopeSchema,
  targets: z.array(restoreTargetSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX)
}).superRefine((value, context) => {
  canonicalIdIssues(value.targets.map((target) => target.submissionId), context, ['targets']);
});

const authorInputValueSchema: z.ZodType<SubmissionTriageChangesetAuthorInput> =
  z.union([ordinaryAuthorSchema, exactRestoreAuthorSchema]);

const plannedTransitionSchema = z.strictObject({
  submissionId: intakeIdSchema,
  arrivalDigestSha256: intakeDigestSchema,
  arrivalClassification: z.enum(['on_time', 'late']),
  beforeVisibleTray: z.enum(['inbox', 'set_aside', 'late', 'discarded']),
  afterVisibleTray: z.enum(['inbox', 'set_aside', 'late', 'discarded']),
  before: submissionTriageHeadSchema,
  after: submissionTriageHeadSchema
});

const transitionPlanValueSchema: z.ZodType<SubmissionTriageTransitionPlan> = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum([
    'set_aside', 'return_to_inbox', 'discard_recoverable', 'restore', 'restore_exact'
  ]),
  scope: intakeScopeSchema,
  attribution: submissionTriageAttributionSchema,
  queryGuard: z.strictObject({
    before: submissionTriageQueryGuardSchema,
    after: submissionTriageQueryGuardSchema
  }),
  transitions: z.array(plannedTransitionSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX)
}).superRefine((plan, context) => {
  try {
    const canonical = parsePlan(plan);
    if (canonical.transitions.some((transition, index) =>
      index > 0 && canonical.transitions[index - 1]!.submissionId >= transition.submissionId
    )) throw new TypeError('non_canonical_transitions');
  } catch {
    context.addIssue({ code: 'custom', message: 'triage transition plan must be exact and coherent' });
  }
});

const resultValueSchema: z.ZodType<SubmissionTriageTransitionResult> = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum([
    'set_aside', 'return_to_inbox', 'discard_recoverable', 'restore', 'restore_exact'
  ]),
  queryGuard: submissionTriageQueryGuardSchema,
  submissionIds: z.array(intakeIdSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX)
}).superRefine((result, context) => {
  canonicalIdIssues(result.submissionIds, context, ['submissionIds']);
});

const authorSchema = defineChangesetSchema({
  key: 'submission.triage.author', version: 1, schema: authorInputValueSchema
});
const planSchema = defineChangesetSchema({
  key: 'submission.triage.plan', version: 1, schema: transitionPlanValueSchema
});
const diffSchema = defineChangesetSchema({
  key: 'submission.triage.safe_diff', version: 1, schema: submissionTriageSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'submission.triage.result', version: 1, schema: resultValueSchema
});

const refusalCodes = [
  'wrong_scope', 'projection_incomplete', 'source_changed', 'submission_missing',
  'stale_query_set', 'stale_submission', 'invalid_transition', 'invalid_plan'
] as const satisfies readonly SubmissionTriageDomainErrorCode[];
const outcomeDetailSchema = defineChangesetSchema({
  key: 'submission.triage.stale_detail', version: 1,
  schema: z.strictObject({
    code: z.enum(refusalCodes),
    action: z.enum([
      'set_aside', 'return_to_inbox', 'discard_recoverable', 'restore', 'restore_exact'
    ]),
    submissionIds: z.array(intakeIdSchema).min(1).max(SUBMISSION_TRIAGE_BULK_MAX)
  })
});

type SubmissionTriageDefinition = ChangesetOperationDefinition<
  SubmissionTriageChangesetAuthorInput,
  SubmissionTriageTransitionPlan,
  z.infer<typeof submissionTriageSafeDiffSchema>,
  SubmissionTriageTransitionPlan,
  SubmissionTriageTransitionResult
>;

export interface SubmissionTriageChangesetBundle {
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

export function createSubmissionTriageChangesetBundle(): SubmissionTriageChangesetBundle {
  const definition: SubmissionTriageDefinition = {
    kind: SUBMISSION_TRIAGE_CHANGESET_KIND,
    version: SUBMISSION_TRIAGE_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [submissionTriageChangesetReadPort, submissionTriagePlanningAttributionReadPort],
    validationPorts: [submissionTriageChangesetValidationPort],
    transactionPorts: [submissionTriageChangesetTransactionPort],
    allowedAggregateKinds: ['submission_triage'],
    allowedGuardKinds: ['submission_arrival', 'submission_triage_query'],
    allowedRisks: ['normal', 'consequential'],
    allowedConsequences: ['submission_triage_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'submission_triage_changed',
      retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'submission_triage_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = parseSubmissionTriageChangesetAuthorInput(authorInput);
      const state = requireState(author.scope, snapshot.getPort(submissionTriageChangesetReadPort));
      const trusted = requirePlanningAttribution(author.scope, snapshot);
      const plan = author.action === 'restore_exact'
        ? planSubmissionTriageExactRestore({
            state,
            targets: author.targets,
            attribution: trusted.attribution,
            changedAt: trusted.occurredAt
          })
        : planSubmissionTriageTransition({
            state,
            action: author.action,
            submissionIds: author.submissionIds,
            expectedHeads: author.expectedHeads,
            expectedQueryGuard: author.expectedQueryGuard,
            attribution: trusted.attribution,
            changedAt: trusted.occurredAt
          });
      return {
        plan,
        aggregateRefs: plan.transitions.map((transition) => ({
          id: submissionTriageAggregateId(transition.submissionId),
          version: transition.before.version
        })),
        guardRefs: [
          {
            id: submissionTriageQueryGuardId(plan.scope.eventId),
            version: plan.queryGuard.before.version,
            digest: plan.queryGuard.before.digestSha256
          },
          ...plan.transitions.map((transition) => ({
            id: submissionArrivalGuardId(transition.submissionId),
            version: 1,
            digest: transition.arrivalDigestSha256
          }))
        ],
        riskTier: plan.action === 'discard_recoverable' ? 'consequential' : 'normal',
        consequences: ['submission_triage_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: submissionTriageSafeDiff(plan),
        representedConsequences: ['submission_triage_changed']
      };
    },
    validateWithin(plan, validation) {
      const state = validation.getPort(submissionTriageChangesetValidationPort)
        .readTriageState(plan.scope);
      if (!state) return { kind: 'outcome', outcome: refusal('wrong_scope', plan) };
      const code = validateSubmissionTriagePlan(plan, state);
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = resultValueSchema.parse(
        transaction.getPort(submissionTriageChangesetTransactionPort).applyTransitionPlan(plan)
      );
      return {
        result,
        facts: [{
          kind: 'submission_triage_changed',
          version: 1,
          payload: {
            schemaVersion: 1,
            action: result.action,
            workspaceId: plan.scope.workspaceId,
            eventId: plan.scope.eventId,
            queryGuard: result.queryGuard,
            transitions: plan.transitions.map((transition) => ({
              submissionId: transition.submissionId,
              arrivalClassification: transition.arrivalClassification,
              before: transition.before,
              after: transition.after
            }))
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      return deriveCompensation(plan, snapshot);
    }
  };
  const bundle = Object.freeze({
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, outcomeDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertSubmissionTriageChangesetBundle(
  candidate: SubmissionTriageChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) throw new TypeError('invalid_submission_triage_changeset_bundle');
}

export function parseSubmissionTriageChangesetAuthorInput(
  candidate: unknown
): SubmissionTriageChangesetAuthorInput {
  return deepFreeze(authorInputValueSchema.parse(candidate));
}

export function parseSubmissionTriageTransitionPlan(
  candidate: unknown
): SubmissionTriageTransitionPlan {
  return deepFreeze(transitionPlanValueSchema.parse(candidate));
}

export function submissionTriageAggregateId(submissionId: string): string {
  return `submission_triage:${intakeIdSchema.parse(submissionId)}`;
}

export function submissionArrivalGuardId(submissionId: string): string {
  return `submission_arrival:${intakeIdSchema.parse(submissionId)}`;
}

export function submissionTriageQueryGuardId(eventId: string): string {
  return `submission_triage_query:${intakeIdSchema.parse(eventId)}`;
}

function requireState(
  scope: IntakeScopeDto,
  port: SubmissionTriageReadPort
): SubmissionTriageStateSnapshot {
  const state = port.readTriageState(scope);
  if (!state) throw new SubmissionTriageDomainError('wrong_scope');
  return parseSubmissionTriageState(state);
}

function parsePlan(candidate: unknown): SubmissionTriageTransitionPlan {
  const plan = candidate as SubmissionTriageTransitionPlan;
  if (plan.queryGuard.after.version !== plan.queryGuard.before.version + 1
      || plan.transitions.length === 0
      || plan.transitions.some((transition) =>
        transition.before.scope.workspaceId !== plan.scope.workspaceId
        || transition.before.scope.eventId !== plan.scope.eventId
        || transition.after.scope.workspaceId !== plan.scope.workspaceId
        || transition.after.scope.eventId !== plan.scope.eventId
        || transition.before.submissionId !== transition.submissionId
        || transition.after.submissionId !== transition.submissionId
        || transition.after.version !== transition.before.version + 1
      )) throw new TypeError('invalid_submission_triage_plan');
  return plan;
}

function refusal(code: SubmissionTriageDomainErrorCode, plan: SubmissionTriageTransitionPlan) {
  return {
    class: 'stale_revision' as const,
    kind: 'submission_triage_changed',
    retryable: false,
    subjects: plan.transitions.map((transition) => ({
      type: 'submission_triage', id: transition.submissionId
    })),
    detail: {
      code,
      action: plan.action,
      submissionIds: plan.transitions.map((transition) => transition.submissionId)
    },
    detailSchemaVersion: 1
  };
}

function deriveCompensation(
  plan: SubmissionTriageTransitionPlan,
  snapshot: ChangesetPlanningSnapshot
): CompensationDerivation<SubmissionTriageChangesetAuthorInput> {
  const state = snapshot.getPort(submissionTriageChangesetReadPort).readTriageState(plan.scope);
  if (!state) return { kind: 'blocked', reasonKey: 'submission_triage.wrong_scope' };
  let parsed: SubmissionTriageStateSnapshot;
  try { parsed = parseSubmissionTriageState(state); } catch {
    return { kind: 'blocked', reasonKey: 'submission_triage.source_changed' };
  }
  const current = new Map(parsed.entries.map((entry) => [entry.head.submissionId, entry]));
  const targets: SubmissionTriageExactRestoreTarget[] = [];
  for (const transition of plan.transitions) {
    const entry = current.get(transition.submissionId);
    if (!entry
        || submissionTriageHeadDigest(entry.head) !== submissionTriageHeadDigest(transition.after)
        || submissionTriageArrivalDigest(entry.arrival) !== transition.arrivalDigestSha256) continue;
    targets.push({
      submissionId: transition.submissionId,
      expectedCurrentVersion: entry.head.version,
      state: transition.before.state,
      setAsideAttribution: transition.before.setAsideAttribution
    });
  }
  if (targets.length === 0) {
    return { kind: 'blocked', reasonKey: 'submission_triage.later_change' };
  }
  const authorInput = deepFreeze({
    action: 'restore_exact' as const,
    scope: plan.scope,
    targets
  });
  return targets.length === plan.transitions.length
    ? { kind: 'exact', authorInput }
    : {
        kind: 'partial', authorInput,
        conflicts: ['submission_triage.later_change']
      };
}

function requirePlanningAttribution(
  scopeInput: IntakeScopeDto,
  snapshot: ChangesetPlanningSnapshot
): { readonly attribution: SubmissionTriageAttribution; readonly occurredAt: string } {
  const scope = intakeScopeSchema.parse(scopeInput);
  const source = snapshot.getPort(submissionTriagePlanningAttributionReadPort)
    .readSubmissionTriagePlanningAttribution(scope);
  if (!source) throw new TypeError('invalid_submission_triage_planning_attribution');
  try {
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(
      source.context, source.authorityRecheck
    );
    const occurredAt = intakeInstantSchema.parse(
      resolveEffectInvocationCurrentAuthorityRecheckTime(source.context, source.authorityRecheck)
    );
    const context = source.context;
    const baseSubjects = context.scope.subjects.filter((subject) =>
      subject.kind === 'workspace' || subject.kind === 'event'
    );
    const ownerSubjects = context.scope.subjects.filter((subject) => subject.kind === 'domain');
    const exactBaseSubjects = baseSubjects.length === 2
      && baseSubjects.some((subject) => subject.kind === 'workspace' && subject.id === scope.workspaceId)
      && baseSubjects.some((subject) => subject.kind === 'event' && subject.id === scope.eventId);
    const ordinaryPlanning = context.scope.subjects.length === 2
      && ownerSubjects.length === 0
      && context.operation.name === 'submission.triage.transition.draft'
      && authority.lane.policy.key === SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY.key
      && authority.lane.policy.version === SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY.version;
    const lifecyclePlanning = context.scope.subjects.length === 3
      && ownerSubjects.length === 1
      && ownerSubjects[0]!.domain === 'changeset'
      && ownerSubjects[0]!.entity === 'owner'
      && ownerSubjects[0]!.id === 'submission_triage'
      && ownerSubjects[0]!.version === undefined
      && new Set(['changeset.rebuild', 'changeset.correction.draft']).has(context.operation.name)
      && authority.lane.policy.key === CHANGESET_LIFECYCLE_ACCESS_POLICY.key
      && authority.lane.policy.version === CHANGESET_LIFECYCLE_ACCESS_POLICY.version;
    if (context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== scope.workspaceId
        || context.scope.eventId !== scope.eventId
        || !exactBaseSubjects
        || (!ordinaryPlanning && !lifecyclePlanning)
        || context.actor.kind !== 'workspace_user'
        || authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || authority.actor.userId !== context.actor.userId
        || authority.scope.workspaceId !== scope.workspaceId
        || authority.scope.eventId !== scope.eventId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) throw new TypeError('invalid_submission_triage_planning_attribution');
    return deepFreeze({
      attribution: submissionTriageAttributionSchema.parse({
        kind: 'manual',
        principalKey: context.authorityPrincipalKey,
        invocationId: context.invocationId,
        surface: 'operator_http'
      }),
      occurredAt
    });
  } catch {
    throw new TypeError('invalid_submission_triage_planning_attribution');
  }
}

function canonicalIdIssues(
  ids: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[]
): void {
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) {
      context.addIssue({
        code: 'custom', path: [...path, index],
        message: 'submission ids must be unique and use canonical code-unit order'
      });
    }
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Reference helper for transaction adapters implementing the declared port. */
export function applySubmissionTriageChangesetPlan(input: {
  readonly port: SubmissionTriageTransactionPort;
  readonly plan: SubmissionTriageTransitionPlan;
}): SubmissionTriageTransitionResult {
  const state = input.port.readTriageState(input.plan.scope);
  if (!state) throw new SubmissionTriageDomainError('wrong_scope');
  const code = validateSubmissionTriagePlan(input.plan, state);
  if (code) throw new SubmissionTriageDomainError(code);
  const result = input.port.applyTransitionPlan(input.plan);
  if (canonicalJsonSha256(result) !== canonicalJsonSha256(submissionTriageTransitionResult(input.plan))) {
    throw new SubmissionTriageDomainError('invalid_plan');
  }
  return result;
}
