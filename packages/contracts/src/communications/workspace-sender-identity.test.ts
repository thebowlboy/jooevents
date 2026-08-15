import { describe, expect, test } from 'bun:test';
import {
  workspaceSenderIdentityRefusalDetailSchema,
  workspaceSenderIdentitySchema,
  workspaceSenderIdentityUpdateInputSchema
} from '../index';

const base = {
  schemaVersion: 1,
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  headVersion: 1,
  displayName: null,
  replyToAddress: null,
  effective: {
    fromAddress: 'no-reply@mail.example.test',
    fromDisplayName: 'JooEvents',
    replyToAddress: null,
    source: 'installation'
  },
  updatedAt: null
} as const;

describe('workspace sender identity projection', () => {
  test('an unedited workspace projects the installation presentation', () => {
    expect(workspaceSenderIdentitySchema.parse(base).effective.source).toBe('installation');
  });

  test('a set workspace value must be the effective value and name its source', () => {
    expect(workspaceSenderIdentitySchema.safeParse({
      ...base,
      headVersion: 2,
      displayName: 'Nordic Product Days',
      updatedAt: '2026-08-15T09:00:00.000Z',
      effective: { ...base.effective, fromDisplayName: 'JooEvents', source: 'workspace' }
    }).success).toBe(false);
    expect(workspaceSenderIdentitySchema.safeParse({
      ...base,
      headVersion: 2,
      displayName: 'Nordic Product Days',
      updatedAt: '2026-08-15T09:00:00.000Z',
      effective: {
        ...base.effective, fromDisplayName: 'Nordic Product Days', source: 'installation'
      }
    }).success).toBe(false);
    expect(workspaceSenderIdentitySchema.safeParse({
      ...base,
      headVersion: 2,
      displayName: 'Nordic Product Days',
      updatedAt: '2026-08-15T09:00:00.000Z',
      effective: {
        ...base.effective, fromDisplayName: 'Nordic Product Days', source: 'workspace'
      }
    }).success).toBe(true);
  });

  test('an unedited head carries no update instant', () => {
    expect(workspaceSenderIdentitySchema.safeParse({
      ...base, updatedAt: '2026-08-15T09:00:00.000Z'
    }).success).toBe(false);
  });
});

describe('workspace sender identity update input', () => {
  test('carries the expected head version and nullable proposals', () => {
    expect(workspaceSenderIdentityUpdateInputSchema.parse({
      expectedHeadVersion: 1, displayName: 'Nordic Product Days', replyToAddress: null
    })).toEqual({
      expectedHeadVersion: 1, displayName: 'Nordic Product Days', replyToAddress: null
    });
  });

  test('a header-injection attempt still parses — acceptance is the operation refusal, not a 400', () => {
    expect(workspaceSenderIdentityUpdateInputSchema.safeParse({
      expectedHeadVersion: 1,
      displayName: 'Nordic\r\nBcc: attacker@example.test',
      replyToAddress: null
    }).success).toBe(true);
  });

  test('unbounded text is still refused at the wire', () => {
    expect(workspaceSenderIdentityUpdateInputSchema.safeParse({
      expectedHeadVersion: 1, displayName: 'n'.repeat(1_025), replyToAddress: null
    }).success).toBe(false);
  });
});

describe('workspace sender identity refusal detail', () => {
  test('the code must name the field it refused', () => {
    expect(workspaceSenderIdentityRefusalDetailSchema.safeParse({
      field: 'display_name', code: 'display_name_control_character'
    }).success).toBe(true);
    expect(workspaceSenderIdentityRefusalDetailSchema.safeParse({
      field: 'display_name', code: 'reply_to_multiple_addresses'
    }).success).toBe(false);
    expect(workspaceSenderIdentityRefusalDetailSchema.safeParse({
      field: 'reply_to_address', code: 'reply_to_multiple_addresses'
    }).success).toBe(true);
  });
});
