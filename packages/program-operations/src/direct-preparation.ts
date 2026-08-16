import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export type ProgramVocabularyDirectAction =
  | 'create'
  | 'edit'
  | 'retire'
  | 'restore'
  | 'delete';

export interface ProgramVocabularyDirectPreparation {
  prepare(input: {
    readonly action: ProgramVocabularyDirectAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): { readonly result: unknown; readonly domain: unknown; readonly effectContributions: readonly [] };
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: ProgramVocabularyDirectPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealed = new WeakMap<object, SealedPreparation>();

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealProgramVocabularyDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: ProgramVocabularyDirectPreparation;
}): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('program_vocabulary_direct_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'program_vocabulary_direct', version: 1 });
  sealed.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createProgramVocabularyDirectHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
  readonly actionForOperation: (
    operationName: string,
    operationVersion: number
  ) => ProgramVocabularyDirectAction | undefined;
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const state = sealed.get(snapshot);
      const action = input.actionForOperation(context.operation.name, context.operation.version);
      if (!state || !sameRef(state.capability, capability) || state.context !== context
          || state.phase !== 'ready' || action === undefined) {
        throw new TypeError('invalid_program_vocabulary_direct_preparation');
      }
      state.phase = 'preparing';
      try {
        const contribution = state.prepare({ action, businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('program_vocabulary_direct_preparation_must_be_synchronous');
        }
        state.phase = 'spent';
        return contribution;
      } catch (error) {
        state.phase = 'spent';
        throw error;
      }
    }
  });
}
