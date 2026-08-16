import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export interface TaskDirectPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}
export interface TaskDirectPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): TaskDirectPreparedContribution;
}
interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: TaskDirectPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}
const sealed = new WeakMap<object, SealedPreparation>();
const sameRef = (left: VersionedDefinitionRef, right: VersionedDefinitionRef) =>
  left.key === right.key && left.version === right.version;

export function sealTaskDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: TaskDirectPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('task_direct_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'task_direct_mutation', version: 1 });
  sealed.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createTaskDirectHandler(input: {
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
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const preparation = sealed.get(snapshot);
      if (!preparation || !sameRef(preparation.capability, capability)
          || preparation.context !== context || preparation.phase !== 'ready') {
        throw new TypeError('invalid_task_direct_preparation');
      }
      preparation.phase = 'preparing';
      try {
        const contribution = preparation.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('task_direct_preparation_must_be_synchronous');
        }
        preparation.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          effectContributions: [...contribution.effectContributions]
        };
      } catch (error) {
        preparation.phase = 'spent';
        throw error;
      }
    }
  });
}
