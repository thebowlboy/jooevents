import type { VersionedDefinitionRef } from '@jooevents/contracts';
import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext
} from './types';

export interface ReviewedChangesetCommitContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

export interface ReviewedChangesetCommitPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): ReviewedChangesetCommitContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly prepare: ReviewedChangesetCommitPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

/**
 * Seals a preparation-only capability into an otherwise inert handler snapshot.
 * The executable function is held only in application memory and is never exposed
 * as an enumerable snapshot field or serializable contribution.
 */
export function sealReviewedChangesetCommitPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly preparation: ReviewedChangesetCommitPreparation;
}): EffectHandlerSnapshot {
  const snapshot = Object.freeze({
    strategy: 'canonical_changeset_commit',
    version: 1
  });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

/**
 * Creates the trusted handler phase for a canonical reviewed changeset commit.
 * Preparation may validate and mint an opaque apply handle, but effective writes
 * remain the UnitOfWork adapter's responsibility after the contribution validates.
 */
export function createReviewedChangesetCommitHandler(input: {
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
        throw new TypeError('invalid_reviewed_changeset_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
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
