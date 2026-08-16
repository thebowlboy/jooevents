import type { EffectHandlerRegistration, EffectHandlerSnapshot, EffectInvocationContext } from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export type ReviewDirectAction = 'open_round' | 'discard_empty_round' | 'step_back' | 'commit_review' | 'amend_review';

export interface ReviewDirectPreparation {
  prepare(input: { readonly action: ReviewDirectAction; readonly businessInput: unknown; readonly context: EffectInvocationContext }): {
    readonly result: unknown; readonly domain: unknown; readonly effectContributions: readonly [];
  };
}

interface State { readonly capability: VersionedDefinitionRef; readonly context: EffectInvocationContext; readonly prepare: ReviewDirectPreparation['prepare']; phase: 'ready' | 'spent' }
const states = new WeakMap<object, State>();
const same = (a: VersionedDefinitionRef, b: VersionedDefinitionRef) => a.key === b.key && a.version === b.version;

export function sealReviewDirectPreparation(input: { readonly capability: VersionedDefinitionRef; readonly context: EffectInvocationContext; readonly preparation: ReviewDirectPreparation }): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') throw new TypeError('review_direct_preparation_must_be_synchronous');
  const snapshot = Object.freeze({ strategy: 'review_direct', version: 1 });
  states.set(snapshot, { capability: Object.freeze({ ...input.capability }), context: input.context, prepare: input.preparation.prepare.bind(input.preparation), phase: 'ready' });
  return snapshot;
}

export function createReviewDirectHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
  readonly actionForOperation: (name: string, version: number, businessInput: unknown) => ReviewDirectAction | undefined;
}): EffectHandlerRegistration {
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }), effect: 'commit' as const,
    handlerCapability: Object.freeze({ ...input.handlerCapability }),
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const state = states.get(snapshot);
      const action = input.actionForOperation(context.operation.name, context.operation.version, businessInput);
      if (!state || !same(state.capability, input.handlerCapability) || state.context !== context || state.phase !== 'ready' || action === undefined) throw new TypeError('invalid_review_direct_preparation');
      state.phase = 'spent';
      const contribution = state.prepare({ action, businessInput, context });
      if (contribution && typeof (contribution as { then?: unknown }).then === 'function') throw new TypeError('review_direct_preparation_must_be_synchronous');
      return contribution;
    }
  });
}
