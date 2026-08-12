import { describe, expect, test } from 'bun:test';
import type { EffectInvocationContext } from './types';
import {
  createReviewedChangesetCommitHandler,
  sealReviewedChangesetCommitPreparation
} from './reviewed-changeset';

const refs = {
  handler: { key: 'handler.reviewed_changeset', version: 1 },
  capability: { key: 'capability.reviewed_changeset', version: 1 },
  contribution: { key: 'schema.reviewed_changeset.contribution', version: 1, digestSha256: '1'.repeat(64) },
  canonical: { key: 'schema.reviewed_changeset.canonical', version: 1, digestSha256: '2'.repeat(64) }
} as const;

const context = Object.freeze({}) as EffectInvocationContext;

describe('reviewed changeset commit handler capability', () => {
  test('keeps preparation executable state opaque and consumes it exactly once', async () => {
    let calls = 0;
    const snapshot = sealReviewedChangesetCommitPreparation({
      capability: refs.capability,
      preparation: {
        prepare({ businessInput, context: receivedContext }) {
          calls += 1;
          expect(receivedContext).toBe(context);
          return {
            result: { kind: 'success', data: businessInput },
            domain: { preparationHandle: 'opaque-handle' },
            receiptChildren: [{ kind: 'domain_evidence' }]
          };
        }
      }
    });
    const handler = createReviewedChangesetCommitHandler({
      reference: refs.handler,
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical
    });

    expect(Object.keys(snapshot)).toEqual(['strategy', 'version']);
    expect('prepare' in snapshot).toBe(false);
    expect(handler.handle({ businessInput: { value: 7 }, context, snapshot })).toEqual({
      result: { kind: 'success', data: { value: 7 } },
      domain: { preparationHandle: 'opaque-handle' },
      receiptChildren: [{ kind: 'domain_evidence' }]
    });
    expect(() => handler.handle({ businessInput: { value: 7 }, context, snapshot }))
      .toThrow('invalid_reviewed_changeset_preparation');
    expect(calls).toBe(1);
  });

  test('rejects a counterfeit or capability-substituted snapshot', async () => {
    const handler = createReviewedChangesetCommitHandler({
      reference: refs.handler,
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical
    });
    const wrong = sealReviewedChangesetCommitPreparation({
      capability: { key: 'capability.other', version: 1 },
      preparation: { prepare: () => ({ result: null, domain: null, receiptChildren: [] }) }
    });

    expect(() => handler.handle({ businessInput: {}, context, snapshot: Object.freeze({}) }))
      .toThrow('invalid_reviewed_changeset_preparation');
    expect(() => handler.handle({ businessInput: {}, context, snapshot: wrong }))
      .toThrow('invalid_reviewed_changeset_preparation');
  });

  test('spends a preparation capability after an expected or unexpected throw', async () => {
    const snapshot = sealReviewedChangesetCommitPreparation({
      capability: refs.capability,
      preparation: { prepare: () => { throw new Error('prepare failed'); } }
    });
    const handler = createReviewedChangesetCommitHandler({
      reference: refs.handler,
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical
    });

    expect(() => handler.handle({ businessInput: {}, context, snapshot })).toThrow('prepare failed');
    expect(() => handler.handle({ businessInput: {}, context, snapshot }))
      .toThrow('invalid_reviewed_changeset_preparation');
  });
});
