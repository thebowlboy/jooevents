import { describe, expect, test } from 'bun:test';
import { compareSyncField, compareSyncRecord } from './comparison';

describe('three-way Airtable comparison', () => {
  test.each([
    ['unchanged', 'Old', 'Old', 'Old', 'view_in_airtable'],
    ['outbound', 'Old', 'Local', 'Old', 'view_in_airtable'],
    ['restore', 'Old', 'Old', 'Remote', 'view_in_airtable'],
    ['apply_inbound', 'Old', 'Old', 'Remote', 'editable_in_airtable'],
    ['create_request', 'Old', 'Old', 'Remote', 'request_from_airtable'],
    ['forbidden', 'Old', 'Old', 'Remote', 'not_shared'],
    ['converged', 'Old', 'Same', 'Same', 'editable_in_airtable'],
    ['conflict', 'Old', 'Local', 'Remote', 'editable_in_airtable']
  ] as const)('%s disposition follows base/local/remote and field authority', (
    expected,
    base,
    local,
    remote,
    mode
  ) => {
    expect(compareSyncField({
      fieldKey: 'session.title',
      mode,
      base,
      local,
      remote
    }).disposition).toBe(expected);
  });

  test('recognizes an outbound echo without relying on provider source', () => {
    expect(compareSyncField({
      fieldKey: 'session.title',
      mode: 'editable_in_airtable',
      base: 'Old',
      local: 'New',
      remote: 'New',
      lastOutbound: 'New'
    }).disposition).toBe('echo');
  });

  test('record summary is deterministic and never merges a same-field conflict', () => {
    const result = compareSyncRecord([
      {
        fieldKey: 'task.status',
        mode: 'editable_in_airtable',
        base: 'Open',
        local: 'Open',
        remote: 'Done'
      },
      {
        fieldKey: 'session.title',
        mode: 'view_in_airtable',
        base: 'Old',
        local: 'Local',
        remote: 'Remote'
      },
      {
        fieldKey: 'schedule.status',
        mode: 'request_from_airtable',
        base: 'Published',
        local: 'Published',
        remote: 'Cancelled'
      }
    ]);
    expect(result.fields.map((field) => field.fieldKey)).toEqual([
      'schedule.status',
      'session.title',
      'task.status'
    ]);
    expect(result).toMatchObject({
      hasConflict: true,
      needsInbound: true,
      needsReview: true
    });
  });
});
