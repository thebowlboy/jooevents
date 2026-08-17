import { describe, expect, test } from 'bun:test';
import {
  compileMapping,
  fieldPolicySchema,
  resolveEffectiveFieldMode,
  type FieldPolicy
} from './mapping';

const policies: readonly FieldPolicy[] = [
  fieldPolicySchema.parse({
    fieldKey: 'task.status',
    areaKey: 'tasks',
    allowedModes: ['not_shared', 'view_in_airtable', 'editable_in_airtable'],
    recommendedMode: 'editable_in_airtable',
    transformKey: 'enumerated_choice',
    dataClassification: 'ordinary',
    inboundOperationKey: 'task.set_status@1'
  }),
  fieldPolicySchema.parse({
    fieldKey: 'schedule.status',
    areaKey: 'schedule',
    allowedModes: ['not_shared', 'view_in_airtable', 'request_from_airtable'],
    recommendedMode: 'request_from_airtable',
    transformKey: 'enumerated_choice',
    dataClassification: 'ordinary',
    requestContractKey: 'schedule.change_request@1'
  })
];

describe('field authority mapping', () => {
  test('workspace selection can narrow but cannot exceed policy or direction', () => {
    expect(resolveEffectiveFieldMode({
      policy: policies[0],
      direction: 'work_from_airtable',
      requestedMode: 'editable_in_airtable',
      canReadRecords: true,
      canWriteRecords: true
    })).toEqual({ kind: 'enabled', mode: 'editable_in_airtable' });

    expect(resolveEffectiveFieldMode({
      policy: policies[0],
      direction: 'keep_airtable_updated',
      requestedMode: 'editable_in_airtable',
      canReadRecords: true,
      canWriteRecords: true
    })).toEqual({ kind: 'refused', code: 'direction_excludes_field' });

    expect(resolveEffectiveFieldMode({
      policy: policies[1],
      direction: 'work_from_airtable',
      requestedMode: 'editable_in_airtable',
      canReadRecords: true,
      canWriteRecords: true
    })).toEqual({ kind: 'refused', code: 'mode_exceeds_policy' });
  });

  test('compiled mapping is deterministic and refuses duplicate fields', () => {
    const draft = {
      manifestVersion: 1,
      revision: 2,
      areas: [
        {
          areaKey: 'tasks',
          direction: 'work_from_airtable',
          fields: [{ fieldKey: 'task.status', userMode: 'editable_in_airtable' }]
        },
        {
          areaKey: 'schedule',
          direction: 'work_from_airtable',
          fields: [{ fieldKey: 'schedule.status', userMode: 'request_from_airtable' }]
        }
      ]
    };
    const first = compileMapping({
      draft,
      policies,
      canReadRecords: true,
      canWriteRecords: true
    });
    const second = compileMapping({
      draft: {
        ...draft,
        areas: [...draft.areas].reverse()
      },
      policies: [...policies].reverse(),
      canReadRecords: true,
      canWriteRecords: true
    });
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    if (first.kind === 'ready' && second.kind === 'ready') {
      expect(first.mapping.digestSha256).toBe(second.mapping.digestSha256);
      expect(first.mapping.fields.map((field) => field.fieldKey)).toEqual([
        'schedule.status',
        'task.status'
      ]);
      expect(first.mapping.areas).toEqual([
        { areaKey: 'schedule', direction: 'work_from_airtable' },
        { areaKey: 'tasks', direction: 'work_from_airtable' }
      ]);
    }

    const duplicate = compileMapping({
      draft: {
        manifestVersion: 1,
        revision: 3,
        areas: [{
          areaKey: 'tasks',
          direction: 'work_from_airtable',
          fields: [
            { fieldKey: 'task.status', userMode: 'view_in_airtable' },
            { fieldKey: 'task.status', userMode: 'editable_in_airtable' }
          ]
        }]
      },
      policies,
      canReadRecords: true,
      canWriteRecords: true
    });
    expect(duplicate).toEqual({
      kind: 'refused',
      issues: [{
        areaKey: 'tasks',
        fieldKey: 'task.status',
        code: 'mapping_field_duplicate'
      }]
    });
  });

  test('editable and request policies require explicit application contracts', () => {
    expect(() => fieldPolicySchema.parse({
      fieldKey: 'task.status',
      areaKey: 'tasks',
      allowedModes: ['editable_in_airtable'],
      recommendedMode: 'editable_in_airtable',
      transformKey: 'enumerated_choice',
      dataClassification: 'ordinary'
    })).toThrow();
    expect(() => fieldPolicySchema.parse({
      fieldKey: 'schedule.status',
      areaKey: 'schedule',
      allowedModes: ['request_from_airtable'],
      recommendedMode: 'request_from_airtable',
      transformKey: 'enumerated_choice',
      dataClassification: 'ordinary'
    })).toThrow();
  });
});
