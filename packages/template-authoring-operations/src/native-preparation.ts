import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

interface SealedNativePreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: (input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }) => { readonly result: unknown; readonly domain: unknown; readonly effectContributions: readonly unknown[] };
  phase: 'ready' | 'preparing' | 'spent';
}

const sealed = new WeakMap<object, SealedNativePreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealTemplateArtifactNativePreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: SealedNativePreparation['prepare'];
}): EffectHandlerSnapshot {
  if (typeof input.prepare !== 'function' || input.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('template_artifact_native_preparation_invalid');
  }
  const snapshot = Object.freeze({ strategy: 'template_artifact_native_review', version: 1 });
  sealed.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.prepare,
    phase: 'ready'
  });
  return snapshot;
}

export function createTemplateArtifactNativeHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly effect: 'draft' | 'commit';
  readonly capability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.capability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: input.effect,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const state = sealed.get(snapshot);
      if (!state || !sameReference(state.capability, capability)
          || state.context !== context || state.phase !== 'ready') {
        throw new TypeError('invalid_template_artifact_native_preparation');
      }
      state.phase = 'preparing';
      try {
        const contribution = state.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('template_artifact_native_preparation_must_be_synchronous');
        }
        state.phase = 'spent';
        return { result: contribution.result, domain: contribution.domain, effectContributions: [...contribution.effectContributions] };
      } catch (error) {
        state.phase = 'spent';
        throw error;
      }
    }
  });
}
