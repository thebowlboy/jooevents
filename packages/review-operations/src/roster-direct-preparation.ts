import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export interface ReviewerRosterDirectPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): {
    readonly result: unknown;
    readonly domain: unknown;
    readonly effectContributions: readonly [];
  };
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: ReviewerRosterDirectPreparation['prepare'];
  phase: 'ready' | 'spent';
}

const preparations = new WeakMap<object, SealedPreparation>();

export function sealReviewerRosterDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: ReviewerRosterDirectPreparation;
}): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('reviewer_roster_direct_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'reviewer_roster_direct', version: 1 });
  preparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createReviewerRosterDirectHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability: Object.freeze({ ...input.handlerCapability }),
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = preparations.get(snapshot);
      if (!sealed
          || sealed.capability.key !== input.handlerCapability.key
          || sealed.capability.version !== input.handlerCapability.version
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_reviewer_roster_direct_preparation');
      }
      sealed.phase = 'spent';
      const contribution = sealed.prepare({ businessInput, context });
      if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
        throw new TypeError('reviewer_roster_direct_preparation_must_be_synchronous');
      }
      return contribution;
    }
  });
}
