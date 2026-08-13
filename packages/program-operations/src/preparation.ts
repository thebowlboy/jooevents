import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';

export type ProgramVocabularyDraftAction =
  | 'create'
  | 'edit'
  | 'retire'
  | 'restore'
  | 'delete'
  | 'merge';

export interface ProgramVocabularyDraftPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

/**
 * Implemented by the transaction-owned lifecycle adapter. It receives parsed wire
 * input, but owns trusted scope, generated identities, actor attribution, and time.
 */
export interface ProgramVocabularyDraftPreparation {
  prepare(input: {
    readonly action: ProgramVocabularyDraftAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): ProgramVocabularyDraftPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: ProgramVocabularyDraftPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

/** Seals a one-shot lifecycle preparation without exposing its store or definition registry. */
export function sealProgramVocabularyDraftPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: ProgramVocabularyDraftPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('program_vocabulary_draft_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('program_vocabulary_draft_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'program_vocabulary_changeset_draft', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function createProgramVocabularyDraftHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
  readonly actionForOperation: (operationName: string, operationVersion: number) =>
    ProgramVocabularyDraftAction | undefined;
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'draft' as const,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      const action = input.actionForOperation(context.operation.name, context.operation.version);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready'
          || action === undefined) {
        throw new TypeError('invalid_program_vocabulary_draft_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ action, businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('program_vocabulary_draft_preparation_must_be_synchronous');
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
