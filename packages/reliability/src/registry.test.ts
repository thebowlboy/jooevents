import { describe, expect, test } from 'bun:test';
import { definitionRef, parseDefinitionKey } from './definitions';
import {
  ReliabilityRegistryError,
  buildReliabilityRegistry,
  resolveReliabilityDefinition,
  sealReliabilityDefinition
} from './registry';
import {
  completeCatalog,
  effectDefinition,
  factDefinition,
  jobDefinition
} from './test-fixtures';
import { parseContractVersion } from '@jooevents/kernel';

describe('reliability registry', () => {
  test('seals definitions and produces a registration-order-independent catalog digest', async () => {
    const definitions = await completeCatalog();
    const forward = await buildReliabilityRegistry(definitions);
    const reverse = await buildReliabilityRegistry([...definitions].reverse());

    expect(forward.catalogDigestSha256).toBe(reverse.catalogDigestSha256);
    expect(forward.catalogDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(forward.definitions.map(({ kind, key }) => `${kind}:${key}`)).toEqual([
      'activity_projection:event.activity',
      'consumer:submission.activity',
      'domain_fact:submission.created',
      'effect:message.requested',
      'job:message.dispatch'
    ]);
    expect(
      resolveReliabilityDefinition(forward, definitionRef('job', 'message.dispatch', 1))?.kind
    ).toBe('job');
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.definitions)).toBe(true);
  });

  test('rejects mutation after sealing and duplicate exact definitions', async () => {
    const job = await jobDefinition();
    const mutated = {
      ...job,
      targetOperation: definitionRef('operation', 'message.dispatch.different', 1)
    };
    await expect(buildReliabilityRegistry([mutated])).rejects.toMatchObject({
      code: 'digest_mismatch'
    });
    await expect(buildReliabilityRegistry([job, job])).rejects.toMatchObject({
      code: 'duplicate_definition'
    });
  });

  test('requires retained prior versions and exact internal references', async () => {
    const versionTwoOnly = await jobDefinition('message.dispatch', 2);
    await expect(buildReliabilityRegistry([versionTwoOnly])).rejects.toMatchObject({
      code: 'missing_prior_version'
    });

    const fact = await factDefinition();
    const job = await jobDefinition();
    const effect = await effectDefinition(definitionRef('job', 'unknown.job', 1));
    await expect(buildReliabilityRegistry([fact, job, effect])).rejects.toMatchObject({
      code: 'unknown_reference'
    });
  });

  test('refuses unversioned or invalid producer citations before they can be sealed', async () => {
    const valid = await factDefinition();
    const { canonicalDigestSha256: _digest, ...draft } = valid;
    const invalid = {
      ...draft,
      key: parseDefinitionKey('submission.invalid'),
      version: parseContractVersion(1),
      producers: [
        {
          kind: 'operation' as const,
          operation: {
            kind: 'operation' as const,
            key: parseDefinitionKey('submission.commit'),
            version: 0 as never
          }
        }
      ]
    };
    await expect(sealReliabilityDefinition(invalid)).rejects.toBeInstanceOf(
      ReliabilityRegistryError
    );
  });
});
