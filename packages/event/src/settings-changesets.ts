import {
  eventSettingsSafeDiffSchema,
  eventSettingsSchema,
  eventSettingsScopeSchema,
  eventSettingsUpdateAuthorInputSchema,
  type EventSettingsDto,
  type EventSettingsSafeDiff,
  type EventSettingsScope,
  type EventSettingsUpdateAuthorInput
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition
} from '@jooevents/changesets';
import { z } from 'zod';
import { eventAggregateId } from './changesets';
import { workspaceEventSetDigest, workspaceEventSetGuardId } from './domain';
import {
  assertEventOrdinaryPolicy,
  captureEventOrdinaryApprovalPolicy,
  eventOrdinaryPolicySchema,
  type EventOrdinaryPolicy
} from './policy';
import {
  EventSettingsPlanningError,
  applyEventSettingsUpdatePlan,
  deriveEventSettingsUpdateCompensation,
  parseEventSettingsState,
  planEventSettingsUpdate,
  validateEventSettingsUpdatePlan,
  type EventSettingsPlanningErrorCode,
  type EventSettingsState,
  type EventSettingsUpdatePlan
} from './settings';

export const EVENT_SETTINGS_CHANGESET_KIND = 'event.settings.update';
export const EVENT_SETTINGS_CHANGESET_VERSION = 1;

export interface EventSettingsReadPort {
  readEventSettings(scope: EventSettingsScope): EventSettingsState | undefined;
}

export interface EventSettingsTransactionPort extends EventSettingsReadPort {
  applyEventSettingsUpdatePlan(plan: EventSettingsUpdatePlan): EventSettingsDto;
}

export const eventSettingsReadPort = defineChangesetReadPort<EventSettingsReadPort>(
  'event_settings.read', 1
);
export const eventSettingsValidationPort =
  defineChangesetValidationPort<EventSettingsReadPort>('event_settings.validation', 1);
export const eventSettingsTransactionPort =
  defineChangesetTransactionPort<EventSettingsTransactionPort>('event_settings.transaction', 1);

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const versionSchema = z.number().int().positive().safe();
const planMutationSchema: z.ZodType<EventSettingsUpdatePlan> = z.strictObject({
  action: z.literal('update'),
  scope: eventSettingsScopeSchema,
  selection: z.strictObject({
    eventId: eventSettingsScopeSchema.shape.eventId,
    eventSetVersion: versionSchema,
    eventSetGuardDigestSha256: digestSchema
  }),
  expectedEventVersion: versionSchema,
  resultingEventVersion: versionSchema,
  before: eventSettingsSchema,
  after: eventSettingsSchema
});

export interface EventSettingsChangesetPlan {
  readonly policy: EventOrdinaryPolicy;
  readonly mutation: EventSettingsUpdatePlan;
}

const authorSchema = defineChangesetSchema({
  key: 'event_settings.author', version: 1, schema: eventSettingsUpdateAuthorInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'event_settings.plan', version: 1,
  schema: z.strictObject({ policy: eventOrdinaryPolicySchema, mutation: planMutationSchema })
});
const diffSchema = defineChangesetSchema({
  key: 'event_settings.safe_diff', version: 1, schema: eventSettingsSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'event_settings.result', version: 1, schema: eventSettingsSchema
});
const refusalCodes = [
  'wrong_scope',
  'current_event_missing',
  'selection_changed',
  'stale_event_set',
  'stale_event',
  'settings_changed',
  'no_changes',
  'invalid_plan',
  'policy_changed'
] as const;
const outcomeDetailSchema = defineChangesetSchema({
  key: 'event_settings.stale_detail', version: 1,
  schema: z.strictObject({
    code: z.enum(refusalCodes),
    action: z.literal('update'),
    eventId: eventSettingsScopeSchema.shape.eventId
  })
});

type Definition = ChangesetOperationDefinition<
  EventSettingsUpdateAuthorInput,
  EventSettingsChangesetPlan,
  EventSettingsSafeDiff,
  EventSettingsChangesetPlan,
  EventSettingsDto
>;

export interface EventSettingsOrdinaryChangesetBundle {
  readonly policy: EventOrdinaryPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

function requireState(
  scope: EventSettingsScope,
  port: EventSettingsReadPort
): EventSettingsState {
  const state = port.readEventSettings(scope);
  if (!state) throw new EventSettingsPlanningError('wrong_scope');
  return parseEventSettingsState(state);
}

function safeDiff(plan: EventSettingsUpdatePlan): EventSettingsSafeDiff {
  return eventSettingsSafeDiffSchema.parse({
    action: 'update',
    before: plan.before,
    after: plan.after,
    selection: {
      eventId: plan.selection.eventId,
      eventSetVersion: plan.selection.eventSetVersion
    }
  });
}

function refusal(
  code: EventSettingsPlanningErrorCode | 'policy_changed',
  plan: EventSettingsUpdatePlan
) {
  return {
    class: 'stale_revision' as const,
    kind: 'event.settings_changed',
    retryable: false,
    subjects: [{ type: 'event', id: plan.scope.eventId }],
    detail: { code, action: 'update' as const, eventId: plan.scope.eventId },
    detailSchemaVersion: 1
  };
}

export function createEventSettingsOrdinaryChangesetBundle(input: {
  readonly policy: EventOrdinaryPolicy;
}): EventSettingsOrdinaryChangesetBundle {
  assertEventOrdinaryPolicy(input.policy);
  const policy = input.policy;
  const definition: Definition = {
    kind: EVENT_SETTINGS_CHANGESET_KIND,
    version: EVENT_SETTINGS_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [eventSettingsReadPort],
    validationPorts: [eventSettingsValidationPort],
    transactionPorts: [eventSettingsTransactionPort],
    allowedAggregateKinds: ['event'],
    allowedGuardKinds: ['workspace_event_set'],
    allowedRisks: ['low', 'normal'],
    allowedConsequences: ['event_settings_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'event.settings_changed',
      retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'event_settings_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = eventSettingsUpdateAuthorInputSchema.parse(authorInput);
      const mutation = planEventSettingsUpdate({
        state: requireState(author.scope, snapshot.getPort(eventSettingsReadPort)),
        authorInput: author
      });
      return {
        plan: { policy, mutation },
        aggregateRefs: [{
          id: eventAggregateId(mutation.scope.eventId),
          version: mutation.expectedEventVersion
        }],
        guardRefs: [{
          id: workspaceEventSetGuardId(mutation.scope.workspaceId),
          version: mutation.selection.eventSetVersion,
          digest: mutation.selection.eventSetGuardDigestSha256
        }],
        riskTier: policy.risk,
        consequences: ['event_settings_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: safeDiff(plan.mutation),
        representedConsequences: ['event_settings_changed']
      };
    },
    validateWithin(plan, validation) {
      const mutation = plan.mutation;
      if (canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(policy)) {
        return { kind: 'outcome', outcome: refusal('policy_changed', mutation) };
      }
      const state = validation.getPort(eventSettingsValidationPort)
        .readEventSettings(mutation.scope);
      if (!state) return { kind: 'outcome', outcome: refusal('wrong_scope', mutation) };
      const issue = validateEventSettingsUpdatePlan(state, mutation);
      return issue
        ? { kind: 'outcome', outcome: refusal(issue, mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(eventSettingsTransactionPort)
        .applyEventSettingsUpdatePlan(plan.mutation);
      return {
        result,
        facts: [{
          kind: 'event_settings_changed',
          version: 1,
          payload: {
            action: 'update',
            eventId: result.eventId,
            eventSetVersion: result.eventSetVersion,
            eventVersion: result.eventVersion
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      const state = snapshot.getPort(eventSettingsReadPort)
        .readEventSettings(plan.mutation.scope);
      if (!state) return { kind: 'blocked', reasonKey: 'event_settings.scope_missing' };
      return deriveEventSettingsUpdateCompensation({ state, sourcePlan: plan.mutation });
    }
  };
  const bundle = Object.freeze({
    policy,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, outcomeDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertEventSettingsOrdinaryChangesetBundle(
  candidate: EventSettingsOrdinaryChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) {
    throw new TypeError('invalid_event_settings_ordinary_changeset_bundle');
  }
  assertEventOrdinaryPolicy(candidate.policy);
}

export function captureEventSettingsChangesetApprovalPolicy(input: {
  readonly bundle: EventSettingsOrdinaryChangesetBundle;
}) {
  assertEventSettingsOrdinaryChangesetBundle(input.bundle);
  return captureEventOrdinaryApprovalPolicy({ policy: input.bundle.policy });
}

export function applyEventSettingsChangesetPlan(input: {
  readonly port: EventSettingsReadPort;
  readonly plan: EventSettingsUpdatePlan;
}): EventSettingsDto {
  return applyEventSettingsUpdatePlan({
    state: requireState(input.plan.scope, input.port),
    plan: input.plan
  });
}

export function currentEventSettingsGuard(input: {
  readonly port: EventSettingsReadPort;
  readonly scope: EventSettingsScope;
}) {
  const state = requireState(input.scope, input.port);
  return Object.freeze({
    aggregate: {
      id: eventAggregateId(state.event.id),
      version: state.event.version
    },
    guard: {
      id: workspaceEventSetGuardId(state.eventSet.workspaceId),
      version: state.eventSet.version,
      digest: workspaceEventSetDigest(state.eventSet)
    }
  });
}
