import { describe, expect, test } from 'bun:test';
import {
  OrganizerMergeRegistryError,
  createOrganizerMergeRegistryRelease,
  resolveOrganizerMergeFields
} from './merge-registry';

const registry = createOrganizerMergeRegistryRelease({
  reference: { key: 'merge.registry', version: 1 },
  fields: [
    { fieldKey: 'event.name', valueType: 'text' },
    {
      fieldKey: 'event.url',
      valueType: 'url',
      allowedHttpsOrigins: ['https://events.example.test']
    },
    { fieldKey: 'person.first_name', valueType: 'text' }
  ]
});

describe('organizer merge registry', () => {
  test('pins the definition digest and canonical field order', () => {
    expect(registry.identity.definitionDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createOrganizerMergeRegistryRelease({
      reference: { key: 'merge.registry', version: 1 },
      fields: [...registry.fields].reverse()
    })).toThrow(new OrganizerMergeRegistryError('invalid_registry'));
    expect(() => createOrganizerMergeRegistryRelease({
      reference: { key: 'merge.registry', version: 1 },
      fields: [{ fieldKey: 'event.url', valueType: 'url' }]
    })).toThrow(new OrganizerMergeRegistryError('invalid_registry'));
  });

  test('resolves exact values, exact fallback refs, and honest optional absence', () => {
    const resolved = resolveOrganizerMergeFields({
      registry,
      requestedFieldKeys: ['person.first_name', 'event.url', 'event.name'],
      bindings: [
        { fieldKey: 'event.name', requirement: 'required', fallback: { kind: 'none' } },
        { fieldKey: 'event.url', requirement: 'optional', fallback: { kind: 'none' } },
        { fieldKey: 'person.first_name', requirement: 'required',
          fallback: { kind: 'payload_ref', payloadRefId: 'fallback-1', payloadRefVersion: 1 } }
      ],
      resolvedValues: [{ fieldKey: 'event.name', value: { valueType: 'text', value: 'JooConf' } }],
      fallbackValues: [{
        payloadRefId: 'fallback-1', payloadRefVersion: 1, fieldKey: 'person.first_name',
        value: { valueType: 'text', value: 'there' }
      }]
    });
    expect(resolved.canonicalValues).toEqual([
      { fieldKey: 'event.name', value: { valueType: 'text', value: 'JooConf' }, source: 'resolved' },
      { fieldKey: 'event.url', value: null, source: 'absent_optional' },
      { fieldKey: 'person.first_name', value: { valueType: 'text', value: 'there' }, source: 'fallback' }
    ]);
    expect(resolved.warningCodes).toEqual(['merge.optional_absent']);
  });

  test('fails closed on unknown, missing required, type, and fallback mismatches', () => {
    const base = {
      registry,
      bindings: [{ fieldKey: 'event.name', requirement: 'required' as const, fallback: { kind: 'none' as const } }],
      requestedFieldKeys: ['event.name'],
      resolvedValues: []
    };
    expect(() => resolveOrganizerMergeFields(base))
      .toThrow(new OrganizerMergeRegistryError('required_merge_field_missing'));
    expect(() => resolveOrganizerMergeFields({ ...base, requestedFieldKeys: ['unknown.field'] }))
      .toThrow(new OrganizerMergeRegistryError('unknown_merge_field'));
    expect(() => resolveOrganizerMergeFields({
      ...base,
      resolvedValues: [{ fieldKey: 'event.name', value: { valueType: 'integer', value: 1 } }]
    })).toThrow(new OrganizerMergeRegistryError('merge_value_type_mismatch'));
  });
});
