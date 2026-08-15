import { describe, expect, test } from 'bun:test';
import {
  OrganizerMergeRegistryError,
  createOrganizerMergeRegistryRelease,
  organizerMergeValueText,
  resolveOrganizerMergeFields
} from './merge-registry';

/** Reads an expectation with ordinary spaces against the real non-breaking bytes. */
const span = (text: string): string => text.replaceAll(' ', '\u00a0');

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

describe('organizer merge value text', () => {
  test('spells a stored date and instant in the shared date vocabulary', () => {
    expect(organizerMergeValueText({ valueType: 'date', value: '2027-03-18' }))
      .toBe(span('18 Mar 2027'));
    expect(organizerMergeValueText(
      { valueType: 'instant', value: '2027-03-18T23:59:00.000Z' },
      { timezone: 'America/New_York' }
    )).toBe(span('18 Mar 2027 · 19:59 EDT'));
  });

  test('never emits the machine string a recipient must not be shown', () => {
    for (const value of [
      { valueType: 'date' as const, value: '2027-03-18' },
      { valueType: 'instant' as const, value: '2027-03-18T23:59:00.000Z' }
    ]) {
      const text = organizerMergeValueText(value, { timezone: 'Europe/Helsinki' });
      expect(text).not.toContain(value.value);
      expect(text).not.toContain('T23:59');
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toContain('Invalid Date');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test('labels the zone it actually used, including the UTC it falls back to', () => {
    // No zone at the seam is not a licence to print a bare clock: the reader is
    // told which wall clock this is, and can convert it.
    expect(organizerMergeValueText({ valueType: 'instant', value: '2027-03-18T23:59:00.000Z' }))
      .toBe(span('18 Mar 2027 · 23:59 UTC'));
    // The zone moves the calendar day, which is the whole reason it is here.
    expect(organizerMergeValueText(
      { valueType: 'instant', value: '2027-03-18T23:59:00.000Z' },
      { timezone: 'Pacific/Auckland' }
    )).toBe(span('19 Mar 2027 · 12:59 GMT+13'));
  });

  test('passes text, url, and integer through unchanged', () => {
    expect(organizerMergeValueText({ valueType: 'text', value: 'Maya' })).toBe('Maya');
    expect(organizerMergeValueText({ valueType: 'url', value: 'https://a.test/x' }))
      .toBe('https://a.test/x');
    expect(organizerMergeValueText({ valueType: 'integer', value: 12 })).toBe('12');
  });
});
