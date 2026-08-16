import type { EffectHandlerRegistration, EffectHandlerSnapshot, EffectInvocationContext } from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

interface State {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: (input: { readonly businessInput: unknown; readonly context: EffectInvocationContext }) => {
    readonly result: unknown; readonly domain: unknown; readonly effectContributions: readonly [];
  };
  phase: 'ready' | 'spent';
}
const states = new WeakMap<object, State>();

export function sealReleaseNativePreparation(input: Omit<State, 'phase'>): EffectHandlerSnapshot {
  if (input.prepare.constructor.name === 'AsyncFunction') throw new TypeError('release_native_preparation_must_be_synchronous');
  const snapshot = Object.freeze({ strategy: 'release_native', version: 1 });
  states.set(snapshot, { ...input, phase: 'ready' });
  return snapshot;
}

export function createReleaseNativeHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly effect: 'draft' | 'commit';
  readonly capability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  return Object.freeze({
    reference: input.reference, effect: input.effect, handlerCapability: input.capability,
    contributionSchema: input.contributionSchema, canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const state = states.get(snapshot);
      if (!state || state.capability.key !== input.capability.key
          || state.capability.version !== input.capability.version
          || state.context !== context || state.phase !== 'ready') {
        throw new TypeError('invalid_release_native_preparation');
      }
      state.phase = 'spent';
      return state.prepare({ businessInput, context });
    }
  });
}
