import { describe, expect, test } from 'bun:test';
import type { DirectOperationFeatureContribution } from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import {
  assertSQLiteOperationFeatureContributionAdapterRegistry,
  createSQLiteOperationFeatureContributionAdapterRegistry,
  type SQLiteOperationFeatureContributionAdapterRegistry
} from './operation-feature-contribution-registry';

const alpha = Object.freeze({ key: 'feature.alpha', version: 1 });
const zulu = Object.freeze({ key: 'feature.zulu', version: 1 });

function contribution(contributor: VersionedDefinitionRef = alpha): DirectOperationFeatureContribution {
  return Object.freeze({ contributor, operationLogId: crypto.randomUUID(), value: { stable: true } });
}

describe('SQLite operation feature contribution adapter registry', () => {
  test('sorts process registrations, dispatches exact identities, and orders lifecycle hooks', async () => {
    const calls: string[] = [];
    const registry = createSQLiteOperationFeatureContributionAdapterRegistry([
      {
        contributor: zulu,
        adapter: {
          apply: () => { calls.push('zulu:apply'); },
          afterUnitOfWorkCommitted: () => { calls.push('zulu:commit'); },
          afterUnitOfWorkFinished: ({ committed }) => { calls.push(`zulu:finish:${committed}`); }
        }
      },
      {
        contributor: alpha,
        adapter: {
          apply: () => { calls.push('alpha:apply'); },
          afterUnitOfWorkCommitted: () => { calls.push('alpha:commit'); },
          afterUnitOfWorkFinished: ({ committed }) => { calls.push(`alpha:finish:${committed}`); }
        }
      }
    ]);
    expect(registry.contributors).toEqual([alpha, zulu]);
    registry.apply(contribution(zulu));
    registry.apply(contribution(alpha));
    await registry.afterUnitOfWorkCommitted?.();
    await registry.afterUnitOfWorkFinished?.({ committed: true });
    expect(calls).toEqual([
      'zulu:apply', 'alpha:apply',
      'alpha:commit', 'zulu:commit',
      'alpha:finish:true', 'zulu:finish:true'
    ]);
  });

  test('rejects duplicates, unknown contributors, and an unsealed runtime adapter', () => {
    expect(() => createSQLiteOperationFeatureContributionAdapterRegistry([
      { contributor: alpha, adapter: { apply() {} } },
      { contributor: alpha, adapter: { apply() {} } }
    ])).toThrow('sqlite_operation_feature_contributor_duplicate');
    const registry = createSQLiteOperationFeatureContributionAdapterRegistry([
      { contributor: alpha, adapter: { apply() {} } }
    ]);
    expect(() => registry.apply(contribution(zulu)))
      .toThrow('sqlite_operation_feature_contributor_unregistered');

    const forged = Object.freeze({
      contributors: [alpha],
      apply() {}
    }) as SQLiteOperationFeatureContributionAdapterRegistry;
    expect(() => assertSQLiteOperationFeatureContributionAdapterRegistry(forged))
      .toThrow('sqlite_operation_feature_contribution_registry_unsealed');
  });
});
