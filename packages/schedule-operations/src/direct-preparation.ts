import type { EffectHandlerRegistration, EffectHandlerSnapshot, EffectInvocationContext } from '@jooevents/application';
import {
  schedulePlacementPlanSchema,
  schedulePlacementResultSchema,
  structuredOutcomeSchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { z } from 'zod';

export const schedulePlacementDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: schedulePlacementResultSchema }),
    domain: z.strictObject({
      kind: z.literal('schedule_placement_direct'),
      plan: schedulePlacementPlanSchema,
      actorUserId: z.uuid(),
      occurredAt: z.iso.datetime({ offset: true })
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(), effectContributions: z.tuple([])
  })
]);

interface Sealed {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: (input: { readonly businessInput: unknown; readonly context: EffectInvocationContext }) => unknown;
  spent: boolean;
}
const sealed = new WeakMap<object, Sealed>();
const same = (a: VersionedDefinitionRef, b: VersionedDefinitionRef) => a.key === b.key && a.version === b.version;

export function sealSchedulePlacementDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: Sealed['prepare'];
}): EffectHandlerSnapshot {
  if (input.prepare.constructor.name === 'AsyncFunction') throw new TypeError('schedule_direct_must_be_synchronous');
  const snapshot = Object.freeze({ strategy: 'schedule_placement_direct', version: 1 });
  sealed.set(snapshot, { capability: input.capability, context: input.context, prepare: input.prepare, spent: false });
  return snapshot;
}

export function createSchedulePlacementDirectHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  return Object.freeze({
    reference: input.reference, effect: 'commit' as const, handlerCapability: input.handlerCapability,
    contributionSchema: input.contributionSchema, canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const state = sealed.get(snapshot);
      if (!state || state.spent || state.context !== context || !same(state.capability, input.handlerCapability)) {
        throw new TypeError('invalid_schedule_direct_snapshot');
      }
      state.spent = true;
      return schedulePlacementDirectContributionSchema.parse(state.prepare({ businessInput, context }));
    }
  });
}
