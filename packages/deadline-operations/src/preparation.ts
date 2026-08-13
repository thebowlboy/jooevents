import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export interface DeadlineDraftPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

/** Transaction-owned preparation for one inert canonical Deadline changeset draft. */
export interface DeadlineDraftPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): DeadlineDraftPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: DeadlineDraftPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealDeadlineDraftPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: DeadlineDraftPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('deadline_draft_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('deadline_draft_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'deadline_changeset_draft', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createDeadlineDraftHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'draft' as const,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_deadline_draft_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('deadline_draft_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          receiptChildren: [...contribution.receiptChildren]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}
