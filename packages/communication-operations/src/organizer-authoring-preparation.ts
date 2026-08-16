import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export type OrganizerCommunicationMutationOperationName =
  | 'store_communication_authoring_payload'
  | 'create_message_draft'
  | 'revise_message_batch'
  | 'discard_message_draft';

export interface OrganizerCommunicationPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

export interface OrganizerCommunicationMutationPreparation {
  prepare(input: {
    readonly operationName: OrganizerCommunicationMutationOperationName;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): OrganizerCommunicationPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly operationName: OrganizerCommunicationMutationOperationName;
  readonly prepare: OrganizerCommunicationMutationPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

/** Seals one transaction-local, synchronous organizer authoring mutation. */
export function sealOrganizerCommunicationMutationPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly operationName: OrganizerCommunicationMutationOperationName;
  readonly preparation: OrganizerCommunicationMutationPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('organizer_communication_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'organizer_communication_authoring', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    operationName: input.operationName,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createOrganizerCommunicationMutationHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operationName: OrganizerCommunicationMutationOperationName;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'draft' as const,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, capability)
          || sealed.context !== context
          || sealed.operationName !== input.operationName
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_organizer_communication_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({
          operationName: input.operationName,
          businessInput,
          context
        });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('organizer_communication_preparation_must_be_synchronous');
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
