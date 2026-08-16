import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { FieldRegistryDraftAction, VersionedDefinitionRef } from '@jooevents/contracts';

export interface FieldRegistryDirectPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

/** Transaction-owned preparation; trusted scope, identities, actor, and time stay server-side. */
export interface FieldRegistryDirectPreparation {
  prepare(input: {
    readonly action: FieldRegistryDraftAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): FieldRegistryDirectPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: FieldRegistryDirectPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealFieldRegistryDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: FieldRegistryDirectPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('field_registry_direct_preparation_invalid');
  }
  const snapshot = Object.freeze({ strategy: 'field_registry_direct', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createFieldRegistryDirectHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
  readonly actionForOperation: (
    operationName: string,
    operationVersion: number
  ) => FieldRegistryDraftAction | undefined;
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      const action = input.actionForOperation(context.operation.name, context.operation.version);
      if (!sealed
          || !sameReference(sealed.capability, capability)
          || sealed.context !== context
          || sealed.phase !== 'ready'
          || action === undefined) {
        throw new TypeError('invalid_field_registry_direct_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ action, businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('field_registry_direct_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          effectContributions: [...contribution.effectContributions]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}
