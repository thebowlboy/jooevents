import { describe, expect, test } from 'bun:test';
import {
  fieldRegistryAddDraftRequestSchema,
  fieldRegistryDraftDataSchema,
  fieldRegistryFieldDefinitionSchema,
  fieldRegistrySnapshotSchema
} from '.';

const workspaceId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789a2';
const fieldId = '018f7d5a-4b3c-7abc-8def-0123456789a3';
const formId = '018f7d5a-4b3c-7abc-8def-0123456789a4';

const contexts = {
  apply: { visible: true, required: false },
  onboard: { visible: false, required: false },
  profile: { visible: false, required: false }
};

function field(overrides: Record<string, unknown> = {}) {
  return {
    id: fieldId,
    key: 'custom.company',
    version: 1,
    kind: 'text',
    label: 'Company',
    help: null,
    answerOwner: 'person',
    mapsTo: null,
    purpose: { kind: 'ordinary' },
    scope: { kind: 'shared' },
    group: 'identity',
    position: 0,
    contexts,
    options: { kind: 'none' },
    constraints: { removal: 'allowed', applyVisibility: 'editable' },
    fileUpload: 'not_applicable',
    ...overrides
  };
}

describe('Field Registry transport contracts', () => {
  test('keeps operator mutation requests source-neutral and scope-free', () => {
    const request = fieldRegistryAddDraftRequestSchema.parse({
      expectedRegistryVersion: 1,
      field: {
        kind: 'text',
        label: '  Company   name ',
        answerOwner: 'person',
        scope: { kind: 'shared' },
        contexts,
        options: { kind: 'none' }
      }
    });
    expect(request.field.label).toBe('Company name');
    expect(fieldRegistryAddDraftRequestSchema.safeParse({
      ...request,
      eventId,
      uiGroupLabel: 'Speaker details'
    }).success).toBe(false);
  });

  test('enforces collection-context, form-scope, option, and file activation invariants', () => {
    expect(fieldRegistryFieldDefinitionSchema.safeParse(field({
      contexts: {
        ...contexts,
        apply: { visible: false, required: true }
      }
    })).success).toBe(false);
    expect(fieldRegistryFieldDefinitionSchema.safeParse(field({
      scope: { kind: 'form', formId },
      contexts: {
        ...contexts,
        onboard: { visible: true, required: false }
      }
    })).success).toBe(false);
    expect(fieldRegistryFieldDefinitionSchema.safeParse(field({
      kind: 'select',
      options: { kind: 'none' }
    })).success).toBe(false);
    expect(fieldRegistryFieldDefinitionSchema.safeParse(field({
      kind: 'file',
      fileUpload: 'enabled'
    })).success).toBe(false);
    expect(fieldRegistryFieldDefinitionSchema.safeParse(field({
      kind: 'file',
      fileUpload: 'disabled'
    })).success).toBe(true);
  });

  test('requires exact contiguous snapshot order and source-specific live resolution', () => {
    const sourced = field({
      kind: 'select',
      options: { kind: 'program_vocabulary', source: 'tracks' },
      resolvedOptions: [{ id: formId, label: 'Platform', version: 2 }]
    });
    expect(fieldRegistrySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      version: 1,
      registryDigestSha256: 'a'.repeat(64),
      fields: [sourced]
    }).success).toBe(true);
    expect(fieldRegistrySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      version: 1,
      registryDigestSha256: 'a'.repeat(64),
      fields: [{ ...sourced, position: 3 }]
    }).success).toBe(false);
    expect(fieldRegistrySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      version: 1,
      registryDigestSha256: 'a'.repeat(64),
      fields: [{ ...field(), resolvedOptions: [] }]
    }).success).toBe(false);
    expect(fieldRegistrySnapshotSchema.safeParse({
      schemaVersion: 1,
      scope: { workspaceId, eventId },
      version: 1,
      registryDigestSha256: 'a'.repeat(64),
      fields: [{
        ...field(),
        kind: 'select',
        options: {
          kind: 'custom',
          choices: [{ id: fieldId, key: 'custom.one', label: 'One', position: 0 }]
        },
        resolvedOptions: null
      }]
    }).success).toBe(false);
  });

  test('draft projection contains compact deterministic evidence, not private planning bytes', () => {
    const data = {
      schemaVersion: 1 as const,
      action: 'add' as const,
      changesetId: fieldId,
      headVersion: 1,
      status: 'draft' as const,
      revision: { id: formId, number: 1, digestSha256: 'a'.repeat(64) },
      riskTier: 'low' as const,
      approvalPolicy: {
        reference: { key: 'field_registry.default', version: 1 },
        definitionDigestSha256: 'b'.repeat(64),
        requirement: 'none' as const
      },
      safeDiff: {
        action: 'add' as const,
        registryVersionBefore: 1,
        registryVersionAfter: 2,
        before: null,
        after: field(),
        placement: { index: 0, group: 'identity' as const,
          reasonKey: 'field_registry.placement.group_end' }
      }
    };
    expect(fieldRegistryDraftDataSchema.parse(data)).toMatchObject({
      action: 'add',
      safeDiff: { action: 'add', registryVersionBefore: 1, registryVersionAfter: 2 }
    });
    expect(fieldRegistryDraftDataSchema.safeParse({
      ...data,
      removedByUserId: workspaceId,
      rawRegistryState: []
    }).success).toBe(false);
  });
});
