import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import { EventPlanningError } from '@jooevents/event';

export interface EventCreatePreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

export interface EventCreatePreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): EventCreatePreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly prepare: EventCreatePreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function planningRefusal(error: EventPlanningError): EventCreatePreparedContribution | undefined {
  const refusal = error.code === 'stale_event_set'
    ? { class: 'stale_revision' as const, kind: 'event.event_set_changed' }
    : error.code === 'event_already_selected'
      ? { class: 'conflict' as const, kind: 'event.already_selected' }
      : undefined;
  return refusal && Object.freeze({
    result: Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        ...refusal,
        retryable: false,
        subjects: Object.freeze([]),
        detail: null,
        detailSchemaVersion: 1
      })
    }),
    domain: null,
    effectContributions: Object.freeze([])
  });
}

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

/** Holds a synchronous, transaction-owned Event-create preparation behind an inert snapshot. */
export function sealEventCreatePreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly preparation: EventCreatePreparation;
}): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('event_create_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'event_create', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createEventCreateHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed || !sameReference(sealed.capability, handlerCapability) || sealed.phase !== 'ready') {
        throw new TypeError('invalid_event_create_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('event_create_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          effectContributions: [...contribution.effectContributions]
        };
      } catch (error) {
        sealed.phase = 'spent';
        if (error instanceof EventPlanningError) {
          const refusal = planningRefusal(error);
          if (refusal) return refusal;
        }
        throw error;
      }
    }
  });
}
