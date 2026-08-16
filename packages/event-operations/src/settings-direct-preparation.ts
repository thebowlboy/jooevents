import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import {
  eventSettingsEventRequiredOutcomeSchema,
  eventSettingsSchema,
  eventSettingsScopeSchema,
  eventSettingsUpdateCanonicalResultSchema,
  eventSettingsUpdateDataSchema,
  eventSettingsUpdateInputSchema,
  structuredOutcomeSchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  EventSettingsPlanningError,
  planEventSettingsUpdate,
  type EventSettingsState,
  type EventSettingsUpdatePlan
} from '@jooevents/event';
import { z } from 'zod';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const eventSettingsDirectUpdatePlanSchema = z.strictObject({
  action: z.literal('update'),
  scope: eventSettingsScopeSchema,
  selection: z.strictObject({
    eventId: z.uuid(),
    eventSetVersion: z.number().int().positive(),
    eventSetGuardDigestSha256: digestSchema
  }),
  expectedEventVersion: z.number().int().positive(),
  resultingEventVersion: z.number().int().positive(),
  before: eventSettingsSchema,
  after: eventSettingsSchema
});

const successContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: eventSettingsUpdateDataSchema }),
  domain: z.strictObject({
    kind: z.literal('event_settings_direct_update'),
    plan: eventSettingsDirectUpdatePlanSchema
  }),
  effectContributions: z.tuple([])
});

const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
});

export const eventSettingsDirectUpdateContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);

interface SealedSnapshot {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly state: EventSettingsState | undefined;
  phase: 'ready' | 'spent';
}

const sealedSnapshots = new WeakMap<object, SealedSnapshot>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealEventSettingsDirectUpdateSnapshot(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly state: EventSettingsState | undefined;
}): EffectHandlerSnapshot {
  const snapshot = Object.freeze({ strategy: 'event_settings_direct_update', version: 1 });
  sealedSnapshots.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    state: input.state,
    phase: 'ready'
  });
  return snapshot;
}

function changedOutcome(error: EventSettingsPlanningError, eventId: string) {
  return {
    kind: 'outcome' as const,
    outcome: {
      class: 'stale_revision' as const,
      kind: 'event.settings_changed',
      retryable: false,
      subjects: [],
      detail: { code: error.code, action: 'update' as const, eventId },
      detailSchemaVersion: 1
    }
  };
}

export function createEventSettingsDirectUpdateHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: {
      readonly businessInput: unknown;
      readonly context: EffectInvocationContext;
      readonly snapshot: EffectHandlerSnapshot;
    }) {
      const sealed = sealedSnapshots.get(snapshot);
      if (!sealed || sealed.phase !== 'ready' || sealed.context !== context
          || !sameReference(sealed.capability, capability)) {
        throw new TypeError('invalid_event_settings_direct_snapshot');
      }
      sealed.phase = 'spent';
      const request = eventSettingsUpdateInputSchema.parse(businessInput);
      if (!sealed.state) {
        return eventSettingsDirectUpdateContributionSchema.parse({
          result: {
            kind: 'outcome',
            outcome: eventSettingsEventRequiredOutcomeSchema.parse({
              class: 'conflict',
              kind: 'event.settings.event_required',
              retryable: false,
              subjects: [],
              detail: null,
              detailSchemaVersion: 1
            })
          },
          domain: null,
          effectContributions: []
        });
      }
      let plan: EventSettingsUpdatePlan;
      try {
        plan = planEventSettingsUpdate({
          state: sealed.state,
          authorInput: {
            scope: {
              workspaceId: context.scope.workspaceId,
              eventId: request.expectedEventId
            },
            request
          }
        });
      } catch (error) {
        if (!(error instanceof EventSettingsPlanningError)) throw error;
        return eventSettingsDirectUpdateContributionSchema.parse({
          result: changedOutcome(error, request.expectedEventId),
          domain: null,
          effectContributions: []
        });
      }
      const result = eventSettingsUpdateCanonicalResultSchema.parse({
        kind: 'success',
        data: {
          schemaVersion: 1,
          action: 'update',
          eventId: plan.after.eventId,
          eventSetVersion: plan.after.eventSetVersion,
          eventVersion: plan.after.eventVersion
        }
      });
      return eventSettingsDirectUpdateContributionSchema.parse({
        result,
        domain: { kind: 'event_settings_direct_update', plan },
        effectContributions: []
      });
    }
  });
}
