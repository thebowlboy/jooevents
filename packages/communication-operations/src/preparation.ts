import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export interface OutboundEmailDeliveryPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

export interface OutboundEmailDeliveryPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): OutboundEmailDeliveryPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly prepare: OutboundEmailDeliveryPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealOutboundEmailDeliveryPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly preparation: OutboundEmailDeliveryPreparation;
}): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('outbound_email_delivery_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'outbound_email_delivery_registration', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createOutboundEmailDeliveryHandler(input: {
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
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed || !sameRef(sealed.capability, capability) || sealed.phase !== 'ready') {
        throw new TypeError('invalid_outbound_email_delivery_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('outbound_email_delivery_preparation_must_be_synchronous');
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
