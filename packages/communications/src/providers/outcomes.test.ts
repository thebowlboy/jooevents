import { describe, expect, test } from 'bun:test';
import {
  createSafeEvidence,
  createSafeEvidenceCatalog,
  validateSafeEvidence
} from './outcomes';

const catalog = createSafeEvidenceCatalog({
  facts: [
    {
      key: 'provider.phase',
      schemaVersion: 1,
      valueKind: 'enum',
      allowedValues: ['accepted', 'before_capture']
    },
    {
      key: 'provider.request_captured',
      schemaVersion: 1,
      valueKind: 'boolean'
    }
  ],
  codes: [
    {
      code: 'provider.accepted',
      allowedFactKeys: ['provider.phase', 'provider.request_captured']
    }
  ]
});

describe('safe evidence catalog', () => {
  test('creates canonical registered evidence without any free-text slot', () => {
    const evidence = createSafeEvidence(catalog, {
      code: 'provider.accepted',
      correlationId: 'corr1_evidencefixture1',
      facts: [
        {
          factKey: 'provider.phase' as never,
          factSchemaVersion: 1,
          valueKind: 'enum',
          enumValue: 'accepted' as never
        },
        {
          factKey: 'provider.request_captured' as never,
          factSchemaVersion: 1,
          valueKind: 'boolean',
          booleanValue: true
        }
      ]
    });
    expect(validateSafeEvidence(evidence, catalog)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain('message');
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  test('rejects unregistered codes, fact keys, versions, and enum values', () => {
    expect(() => createSafeEvidence(catalog, {
      code: 'provider.raw_exception',
      correlationId: 'corr1_evidencefixture2'
    })).toThrow('not registered');
    expect(() => createSafeEvidence(catalog, {
      code: 'provider.accepted',
      correlationId: 'corr1_evidencefixture3',
      facts: [{
        factKey: 'provider.unknown' as never,
        factSchemaVersion: 1,
        valueKind: 'boolean',
        booleanValue: true
      }]
    })).toThrow('does not allow');
    expect(() => createSafeEvidence(catalog, {
      code: 'provider.accepted',
      correlationId: 'corr1_evidencefixture4',
      facts: [{
        factKey: 'provider.phase' as never,
        factSchemaVersion: 2,
        valueKind: 'enum',
        enumValue: 'accepted' as never
      }]
    })).toThrow('schema version');
    expect(() => createSafeEvidence(catalog, {
      code: 'provider.accepted',
      correlationId: 'corr1_evidencefixture5',
      facts: [{
        factKey: 'provider.phase' as never,
        factSchemaVersion: 1,
        valueKind: 'enum',
        enumValue: 'provider_raw_text' as never
      }]
    })).toThrow('not registered');
  });
});
