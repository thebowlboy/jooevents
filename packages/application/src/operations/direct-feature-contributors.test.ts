import { describe, expect, test } from 'bun:test';
import { parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import type { DirectOperationFeatureContributor } from './types';
import {
  assertDirectOperationFeatureContributorRegistry,
  createDirectOperationFeatureContributorRegistry,
  resolveDirectOperationFeatureContributorRegistry
} from './direct-feature-contributors';

const workspaceId = parseWorkspaceId('40000000-0000-4000-8000-000000000001');
const input = Object.freeze({
  operation: Object.freeze({ name: 'session.change', version: 1 }),
  businessInput: Object.freeze({ action: 'transition' }),
  canonicalResult: Object.freeze({ kind: 'success', data: Object.freeze({ action: 'transition' }) }),
  scope: Object.freeze({ workspaceId, subjects: Object.freeze([]), resolutionEvidenceIds: Object.freeze([]) }),
  occurredAt: parseInstant('2026-08-18T04:00:00.000Z')
});

function contributor(key: string, calls: string[]): DirectOperationFeatureContributor {
  return Object.freeze({
    reference: Object.freeze({ key, version: 1 }),
    contribute() {
      calls.push(key);
      return { key };
    }
  });
}

describe('direct operation feature contributor registry', () => {
  test('freezes one deterministic reference order independent of candidate order', () => {
    const calls: string[] = [];
    const registry = createDirectOperationFeatureContributorRegistry([
      contributor('feature.zulu', calls),
      contributor('feature.alpha', calls),
      contributor('feature.middle', calls)
    ]);
    expect(registry.references.map((reference) => reference.key)).toEqual([
      'feature.alpha', 'feature.middle', 'feature.zulu'
    ]);
    const resolved = resolveDirectOperationFeatureContributorRegistry(registry, input);
    expect(calls).toEqual(['feature.alpha', 'feature.middle', 'feature.zulu']);
    expect(resolved.map((item) => item.value)).toEqual([
      { key: 'feature.alpha' }, { key: 'feature.middle' }, { key: 'feature.zulu' }
    ]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.references)).toBe(true);
  });

  test('rejects duplicate identities, async contributors, and forged dynamic registries', () => {
    expect(() => createDirectOperationFeatureContributorRegistry([
      contributor('feature.same', []), contributor('feature.same', [])
    ])).toThrow('direct_operation_feature_contributor_duplicate');
    const asyncRegistry = createDirectOperationFeatureContributorRegistry([Object.freeze({
      reference: Object.freeze({ key: 'feature.async', version: 1 }),
      async contribute() { return { unsafe: true }; }
    })]);
    expect(() => resolveDirectOperationFeatureContributorRegistry(asyncRegistry, input))
      .toThrow('returned a promise');
    expect(() => assertDirectOperationFeatureContributorRegistry({
      references: [{ key: 'feature.model_supplied', version: 1 }]
    })).toThrow('registry_untrusted');
  });

  test('bounds the complete process registration', () => {
    const candidates = Array.from({ length: 33 }, (_, index) =>
      contributor(`feature.bound-${String(index).padStart(2, '0')}`, []));
    expect(() => createDirectOperationFeatureContributorRegistry(candidates))
      .toThrow('bound_exceeded');
  });
});
