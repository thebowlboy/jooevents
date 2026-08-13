import {
  eventCreateDraftInputSchema,
  eventCreateResultSchema,
  eventCreateSafeDiffSchema,
  eventSchema,
  type EventCreateDraftInput,
  type EventCreateResult,
  type EventCreateSafeDiff
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
  type ChangesetTransaction,
  type CompensationDerivation
} from '@jooevents/changesets';
import { parseAggregateVersion, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  assertEventDependencyContributorRegistry,
  captureRegisteredEventDependencies,
  type EventDependencyContributorRef,
  type EventDependencyContributorRegistry,
  type EventDependencySnapshotSource
} from './dependencies';
import {
  assessEventCreationCompensation,
  diffEventCreatePlan,
  eventCreateResult,
  planEventCreation,
  validateEventCreatePlan,
  workspaceEventSetDigest,
  workspaceEventSetGuardId,
  type EventCreatePlan,
  type EventPlanningErrorCode
} from './domain';
import {
  createWorkspaceEventSet,
  parseEventState,
  type Event,
  type WorkspaceEventSet
} from './model';
import {
  assertEventOrdinaryPolicy,
  eventOrdinaryPolicySchema,
  type EventOrdinaryPolicy
} from './policy';
import { projectEvent } from './projection';

export const EVENT_CREATION_CHANGESET_KIND = 'event.creation';
export const EVENT_CREATION_CHANGESET_VERSION = 1;

export interface EventCreateChangesetAuthorInput {
  readonly action: 'create';
  readonly workspaceId: string;
  readonly eventId: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly input: EventCreateDraftInput;
}

export interface EventCreateCompensationAuthorInput {
  readonly action: 'compensate_create';
  readonly sourcePlan: EventCreatePlan;
}

export type EventCreationChangesetAuthorInput =
  | EventCreateChangesetAuthorInput
  | EventCreateCompensationAuthorInput;

export interface EventDependencyEvidence {
  readonly registryDigestSha256: string;
  readonly contributors: readonly {
    readonly contributor: EventDependencyContributorRef;
    readonly scope: { readonly workspaceId: string; readonly eventId: string };
    readonly guard: { readonly id: string; readonly version: number; readonly digest: string };
    readonly dependencies: readonly {
      readonly referenceKey: string;
      readonly version: number;
      readonly destination: { readonly kind: string; readonly id: string };
    }[];
  }[];
}

export interface EventCreateCompensationPlan {
  readonly action: 'compensate_create';
  readonly sourcePlan: EventCreatePlan;
  readonly workspaceId: string;
  readonly expectedEventSetVersion: number;
  readonly eventSetGuardDigest: string;
  readonly resultingEventSetVersion: number;
  readonly resultingEventSetGuardDigest: string;
  readonly before: Event;
  readonly dependencies: EventDependencyEvidence;
}

export type EventCreationMutationPlan = EventCreatePlan | EventCreateCompensationPlan;

export interface EventCreationChangesetPlan {
  readonly policy: EventOrdinaryPolicy;
  readonly mutation: EventCreationMutationPlan;
}

export interface EventCreateCompensationSafeDiff {
  readonly action: 'compensate_create';
  readonly before: EventCreateSafeDiff['after'];
  readonly after: null;
  readonly currentSelection: { readonly before: string; readonly after: null };
  readonly eventSetVersion: { readonly before: number; readonly after: number };
}

export type EventCreationSafeDiff = EventCreateSafeDiff | EventCreateCompensationSafeDiff;

export type EventCreationChangesetResult =
  | ({ readonly action: 'create' } & EventCreateResult)
  | {
      readonly action: 'compensate_create';
      readonly eventId: string;
      readonly eventSetVersion: number;
      readonly currentEventId: null;
    };

export interface EventCreationReadPort extends EventDependencySnapshotSource {
  readEventSet(workspaceId: string): WorkspaceEventSet | undefined;
  readEvent(workspaceId: string, eventId: string): Event | undefined;
}

export interface EventCreationTransactionPort extends EventCreationReadPort {
  applyEventCreatePlan(plan: EventCreatePlan): EventCreateResult;
  applyEventCreateCompensationPlan(
    plan: EventCreateCompensationPlan
  ): EventCreationChangesetResult;
}

export function createEventCreationValidationView(
  port: EventCreationReadPort
): EventCreationReadPort {
  return Object.freeze({
    readEventSet(workspaceId: string) {
      return port.readEventSet(workspaceId);
    },
    readEvent(workspaceId: string, eventId: string) {
      return port.readEvent(workspaceId, eventId);
    },
    readContributor(contributor: EventDependencyContributorRef, scope: {
      readonly workspaceId: ReturnType<typeof parseWorkspaceId>;
      readonly eventId: ReturnType<typeof parseEventId>;
    }) {
      return port.readContributor(contributor, scope);
    }
  });
}

export const eventCreationReadPort = defineChangesetReadPort<EventCreationReadPort>(
  'event_creation.read',
  1
);
export const eventCreationValidationPort =
  defineChangesetValidationPort<EventCreationReadPort>('event_creation.validation', 1);
export const eventCreationTransactionPort =
  defineChangesetTransactionPort<EventCreationTransactionPort>('event_creation.transaction', 1);

const canonicalUuidSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: 'Application IDs must use canonical lowercase bytes.' }
);
const instantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: 'Instant must use canonical UTC bytes.' }
);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveVersionSchema = z.number().int().positive();

const eventStateSchema = z.strictObject({
  id: canonicalUuidSchema,
  workspaceId: canonicalUuidSchema,
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).max(255),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  version: positiveVersionSchema,
  createdByUserId: canonicalUuidSchema,
  createdAt: instantSchema
}).superRefine((value, context) => {
  try {
    parseEventState(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Event state must be canonical.' });
  }
});

const eventCreatePlanSchema = z.strictObject({
  action: z.literal('create'),
  workspaceId: canonicalUuidSchema,
  expectedEventSetVersion: positiveVersionSchema,
  eventSetGuardDigest: digestSchema,
  resultingEventSetVersion: positiveVersionSchema,
  resultingEventSetGuardDigest: digestSchema,
  after: eventStateSchema
});

const dependencyEvidenceSchema = z.strictObject({
  registryDigestSha256: digestSchema,
  contributors: z.array(z.strictObject({
    contributor: z.strictObject({
      key: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
      version: positiveVersionSchema
    }),
    scope: z.strictObject({
      workspaceId: canonicalUuidSchema,
      eventId: canonicalUuidSchema
    }),
    guard: z.strictObject({
      id: z.string().regex(/^event_dependency:[A-Za-z0-9._~:-]+$/),
      version: positiveVersionSchema,
      digest: digestSchema
    }),
    dependencies: z.array(z.strictObject({
      referenceKey: z.string().trim().min(1).max(300),
      version: positiveVersionSchema,
      destination: z.strictObject({
        kind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
        id: z.string().trim().min(1).max(300)
      })
    }))
  }))
});

const compensationPlanSchema = z.strictObject({
  action: z.literal('compensate_create'),
  sourcePlan: eventCreatePlanSchema,
  workspaceId: canonicalUuidSchema,
  expectedEventSetVersion: positiveVersionSchema,
  eventSetGuardDigest: digestSchema,
  resultingEventSetVersion: positiveVersionSchema,
  resultingEventSetGuardDigest: digestSchema,
  before: eventStateSchema,
  dependencies: dependencyEvidenceSchema
});

const authorInputSchema = defineChangesetSchema({
  key: 'event.creation.author',
  version: 1,
  schema: z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('create'),
      workspaceId: canonicalUuidSchema,
      eventId: canonicalUuidSchema,
      createdByUserId: canonicalUuidSchema,
      createdAt: instantSchema,
      input: eventCreateDraftInputSchema
    }),
    z.strictObject({
      action: z.literal('compensate_create'),
      sourcePlan: eventCreatePlanSchema
    })
  ])
});

const planSchema = defineChangesetSchema({
  key: 'event.creation.plan',
  version: 1,
  schema: z.strictObject({
    policy: eventOrdinaryPolicySchema,
    mutation: z.discriminatedUnion('action', [eventCreatePlanSchema, compensationPlanSchema])
  })
});

const compensationDiffSchema = z.strictObject({
  action: z.literal('compensate_create'),
  before: eventSchema,
  after: z.null(),
  currentSelection: z.strictObject({ before: canonicalUuidSchema, after: z.null() }),
  eventSetVersion: z.strictObject({ before: positiveVersionSchema, after: positiveVersionSchema })
});
const safeDiffSchema = defineChangesetSchema({
  key: 'event.creation.safe_diff',
  version: 1,
  schema: z.discriminatedUnion('action', [eventCreateSafeDiffSchema, compensationDiffSchema])
});
const resultSchema = defineChangesetSchema({
  key: 'event.creation.result',
  version: 1,
  schema: z.discriminatedUnion('action', [
    eventCreateResultSchema.extend({ action: z.literal('create') }),
    z.strictObject({
      action: z.literal('compensate_create'),
      eventId: canonicalUuidSchema,
      eventSetVersion: positiveVersionSchema,
      currentEventId: z.null()
    })
  ])
});
const outcomeDetailSchema = defineChangesetSchema({
  key: 'event.creation.stale_detail',
  version: 1,
  schema: z.strictObject({
    code: z.enum([
      'wrong_workspace',
      'stale_event_set',
      'event_already_selected',
      'invalid_plan',
      'event_missing',
      'event_changed',
      'dependencies_changed',
      'policy_changed'
    ]),
    action: z.enum(['create', 'compensate_create']),
    eventId: canonicalUuidSchema
  })
});

function visibleDependencyEvidence(
  value: ReturnType<typeof captureRegisteredEventDependencies>
): EventDependencyEvidence {
  return Object.freeze({
    registryDigestSha256: value.registryDigestSha256,
    contributors: Object.freeze(value.contributors.map((contributor) => Object.freeze({
      contributor: Object.freeze({ ...contributor.contributor }),
      scope: Object.freeze({ ...contributor.scope }),
      guard: Object.freeze({ ...contributor.guard }),
      dependencies: Object.freeze(contributor.dependencies.map((dependency) => Object.freeze({
        referenceKey: dependency.referenceKey,
        version: dependency.version,
        destination: Object.freeze({ ...dependency.destination })
      })))
    })))
  });
}

function compensationPlan(input: {
  readonly sourcePlan: EventCreatePlan;
  readonly eventSet: WorkspaceEventSet;
  readonly event: Event;
  readonly dependencies: EventDependencyEvidence;
}): EventCreateCompensationPlan {
  const nextSet = createWorkspaceEventSet({
    workspaceId: input.eventSet.workspaceId,
    version: parseAggregateVersion(input.eventSet.version + 1),
    currentEventId: null
  });
  return Object.freeze({
    action: 'compensate_create',
    sourcePlan: input.sourcePlan,
    workspaceId: input.eventSet.workspaceId,
    expectedEventSetVersion: input.eventSet.version,
    eventSetGuardDigest: workspaceEventSetDigest(input.eventSet),
    resultingEventSetVersion: nextSet.version,
    resultingEventSetGuardDigest: workspaceEventSetDigest(nextSet),
    before: input.event,
    dependencies: input.dependencies
  });
}

export function validateEventCreateCompensationPlan(
  plan: EventCreateCompensationPlan,
  port: EventCreationReadPort,
  registry: EventDependencyContributorRegistry
): string | null {
  const eventSet = port.readEventSet(plan.workspaceId);
  if (!eventSet) return 'wrong_workspace';
  if (eventSet.currentEventId !== plan.before.id
      || eventSet.version !== plan.expectedEventSetVersion
      || workspaceEventSetDigest(eventSet) !== plan.eventSetGuardDigest) {
    return 'stale_event_set';
  }
  const event = port.readEvent(plan.workspaceId, plan.before.id);
  if (!event) return 'event_missing';
  if (canonicalJsonSha256(event) !== canonicalJsonSha256(plan.before)) return 'event_changed';
  const eligibility = assessEventCreationCompensation({
    sourcePlan: plan.sourcePlan,
    currentEventSet: eventSet,
    currentEvent: event,
    dependencyRegistry: registry,
    dependencySource: port
  });
  if (eligibility.kind !== 'exact') return 'dependencies_changed';
  const currentDependencies = visibleDependencyEvidence(captureRegisteredEventDependencies({
    registry,
    scope: {
      workspaceId: parseWorkspaceId(plan.workspaceId),
      eventId: parseEventId(plan.before.id)
    },
    source: port
  }));
  if (canonicalJsonSha256(currentDependencies) !== canonicalJsonSha256(plan.dependencies)) {
    return 'dependencies_changed';
  }
  const nextSet = createWorkspaceEventSet({
    workspaceId: plan.workspaceId,
    version: plan.resultingEventSetVersion,
    currentEventId: null
  });
  return plan.resultingEventSetVersion !== plan.expectedEventSetVersion + 1
      || workspaceEventSetDigest(nextSet) !== plan.resultingEventSetGuardDigest
    ? 'invalid_plan'
    : null;
}

export function eventCreateCompensationResult(
  plan: EventCreateCompensationPlan
): EventCreationChangesetResult {
  return Object.freeze({
    action: 'compensate_create',
    eventId: plan.before.id,
    eventSetVersion: plan.resultingEventSetVersion,
    currentEventId: null
  });
}

function planEventChangeset(
  authorInput: EventCreationChangesetAuthorInput,
  snapshot: ChangesetPlanningSnapshot,
  registry: EventDependencyContributorRegistry,
  policy: EventOrdinaryPolicy
) {
  const port = snapshot.getPort(eventCreationReadPort);
  if (authorInput.action === 'create') {
    const eventSet = port.readEventSet(authorInput.workspaceId);
    if (!eventSet) throw new TypeError('event_creation_workspace_missing');
    const mutation = planEventCreation({
      eventSet,
      authorInput: { ...authorInput.input, expectedEventSetVersion: eventSet.version },
      server: {
        workspaceId: authorInput.workspaceId,
        eventId: authorInput.eventId,
        createdByUserId: authorInput.createdByUserId,
        createdAt: authorInput.createdAt
      }
    });
    return { policy, mutation } as EventCreationChangesetPlan;
  }
  const sourcePlan = authorInput.sourcePlan;
  const eventSet = port.readEventSet(sourcePlan.workspaceId);
  const event = port.readEvent(sourcePlan.workspaceId, sourcePlan.after.id);
  if (!eventSet || !event) throw new TypeError('event_creation_correction_missing');
  const eligibility = assessEventCreationCompensation({
    sourcePlan,
    currentEventSet: eventSet,
    currentEvent: event,
    dependencyRegistry: registry,
    dependencySource: port
  });
  if (eligibility.kind !== 'exact') throw new TypeError(`event_creation_correction_${eligibility.reason}`);
  const dependencies = visibleDependencyEvidence(captureRegisteredEventDependencies({
    registry,
    scope: {
      workspaceId: parseWorkspaceId(sourcePlan.workspaceId),
      eventId: parseEventId(sourcePlan.after.id)
    },
    source: port
  }));
  return {
    policy,
    mutation: compensationPlan({ sourcePlan, eventSet, event, dependencies })
  } as EventCreationChangesetPlan;
}

function aggregateRefs(plan: EventCreationMutationPlan) {
  return plan.action === 'create'
    ? []
    : [{ id: eventAggregateId(plan.before.id), version: plan.before.version }];
}

function guardRefs(plan: EventCreationMutationPlan) {
  const refs = [{
    id: workspaceEventSetGuardId(plan.workspaceId),
    version: plan.expectedEventSetVersion,
    digest: plan.eventSetGuardDigest
  }];
  if (plan.action === 'compensate_create') {
    refs.push(...plan.dependencies.contributors.map((entry) => ({ ...entry.guard })));
  }
  return refs;
}

function diff(plan: EventCreationMutationPlan): EventCreationSafeDiff {
  if (plan.action === 'create') return diffEventCreatePlan(plan);
  return {
    action: 'compensate_create',
    before: projectEvent(plan.before),
    after: null,
    currentSelection: { before: plan.before.id, after: null },
    eventSetVersion: {
      before: plan.expectedEventSetVersion,
      after: plan.resultingEventSetVersion
    }
  };
}

function outcome(
  code: EventPlanningErrorCode | 'event_missing' | 'event_changed'
    | 'dependencies_changed' | 'policy_changed',
  plan: EventCreationMutationPlan
) {
  const eventId = plan.action === 'create' ? plan.after.id : plan.before.id;
  return {
    class: 'stale_revision' as const,
    kind: 'event.creation_changed',
    retryable: false,
    subjects: [{ type: 'event', id: eventId }],
    detail: { code, action: plan.action, eventId },
    detailSchemaVersion: 1
  };
}

type EventCreationDefinition = ChangesetOperationDefinition<
  EventCreationChangesetAuthorInput,
  EventCreationChangesetPlan,
  EventCreationSafeDiff,
  EventCreationChangesetPlan,
  EventCreationChangesetResult
>;

export interface EventCreationOrdinaryChangesetBundle {
  readonly policy: EventOrdinaryPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

export function createEventCreationOrdinaryChangesetBundle(input: {
  readonly dependencyRegistry: EventDependencyContributorRegistry;
  readonly policy: EventOrdinaryPolicy;
}): EventCreationOrdinaryChangesetBundle {
  assertEventDependencyContributorRegistry(input.dependencyRegistry);
  assertEventOrdinaryPolicy(input.policy);
  const policy = input.policy;
  const definition: EventCreationDefinition = {
    kind: EVENT_CREATION_CHANGESET_KIND,
    version: EVENT_CREATION_CHANGESET_VERSION,
    schemas: {
      authorInput: authorInputSchema.reference,
      plan: planSchema.reference,
      diff: safeDiffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [eventCreationReadPort],
    validationPorts: [eventCreationValidationPort],
    transactionPorts: [eventCreationTransactionPort],
    allowedAggregateKinds: ['event'],
    allowedGuardKinds: ['workspace_event_set', 'event_dependency'],
    allowedRisks: ['low', 'normal'],
    allowedConsequences: ['event_selection_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'event.creation_changed',
      retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [
      { kind: 'event_created', version: 1 },
      { kind: 'event_creation_compensated', version: 1 }
    ],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const wrapped = planEventChangeset(
        authorInput,
        snapshot,
        input.dependencyRegistry,
        policy
      );
      return {
        plan: wrapped,
        aggregateRefs: aggregateRefs(wrapped.mutation),
        guardRefs: guardRefs(wrapped.mutation),
        riskTier: policy.risk,
        consequences: ['event_selection_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: safeDiffSchema.schema.parse(diff(plan.mutation)) as EventCreationSafeDiff,
        representedConsequences: ['event_selection_changed']
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(eventCreationValidationPort);
      const mutation = plan.mutation;
      if (canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(policy)) {
        return { kind: 'outcome', outcome: outcome('policy_changed', mutation) };
      }
      if (mutation.action === 'create') {
        const eventSet = port.readEventSet(mutation.workspaceId);
        const refusal = eventSet
          ? validateEventCreatePlan(eventSet, mutation)
          : 'wrong_workspace';
        return refusal
          ? { kind: 'outcome', outcome: outcome(refusal, mutation) }
          : { kind: 'ready', validated: plan };
      }
      const refusal = validateEventCreateCompensationPlan(
        mutation,
        port,
        input.dependencyRegistry
      );
      return refusal
        ? { kind: 'outcome', outcome: outcome(refusal as 'event_missing', mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const port = transaction.getPort(eventCreationTransactionPort);
      const mutation = plan.mutation;
      const result = mutation.action === 'create'
        ? ({ action: 'create', ...port.applyEventCreatePlan(mutation) } as const)
        : port.applyEventCreateCompensationPlan(mutation);
      return {
        result,
        facts: [{
          kind: mutation.action === 'create'
            ? 'event_created'
            : 'event_creation_compensated',
          version: 1,
          payload: mutation.action === 'create'
            ? {
                action: 'create',
                eventId: mutation.after.id,
                eventSetVersion: mutation.resultingEventSetVersion
              }
            : {
                action: 'compensate_create',
                eventId: mutation.before.id,
                eventSetVersion: mutation.resultingEventSetVersion
              }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot): CompensationDerivation<EventCreationChangesetAuthorInput> {
      if (plan.mutation.action !== 'create') {
        return { kind: 'blocked', reasonKey: 'event.nested_creation_compensation' };
      }
      const port = snapshot.getPort(eventCreationReadPort);
      const eventSet = port.readEventSet(plan.mutation.workspaceId);
      const event = port.readEvent(plan.mutation.workspaceId, plan.mutation.after.id);
      if (!eventSet) return { kind: 'blocked', reasonKey: 'event.event_set_missing' };
      const eligibility = assessEventCreationCompensation({
        sourcePlan: plan.mutation,
        currentEventSet: eventSet,
        currentEvent: event,
        dependencyRegistry: input.dependencyRegistry,
        dependencySource: port
      });
      return eligibility.kind === 'exact'
        ? {
            kind: 'exact',
            authorInput: { action: 'compensate_create', sourcePlan: plan.mutation }
          }
        : { kind: 'blocked', reasonKey: `event.creation.${eligibility.reason}` };
    }
  };
  const registry = createChangesetDefinitionRegistry({
    schemas: [authorInputSchema, planSchema, safeDiffSchema, resultSchema, outcomeDetailSchema],
    definitions: [definition]
  });
  const bundle: EventCreationOrdinaryChangesetBundle = Object.freeze({ policy, registry });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertEventCreationOrdinaryChangesetBundle(
  candidate: EventCreationOrdinaryChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) {
    throw new TypeError('invalid_event_creation_ordinary_changeset_bundle');
  }
  assertEventOrdinaryPolicy(candidate.policy);
}

export function eventAggregateId(eventId: string): string {
  return `event:${eventId}`;
}
