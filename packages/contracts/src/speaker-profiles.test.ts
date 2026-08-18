import { describe, expect, test } from 'bun:test';
import {
  speakerProfileApproveInputSchema,
  speakerProfileApprovalSchema,
  speakerProfileLinkSchema,
  speakerProfileReviewPolicyUpdateInputSchema,
  speakerProfileUpdateInputSchema,
  speakerProfileViewSchema
} from './speaker-profiles';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const digest = 'a'.repeat(64);

describe('speaker profile contracts', () => {
  test('normalizes bounded profile text and HTTPS links', () => {
    expect(speakerProfileUpdateInputSchema.parse({
      personId: id('1').toUpperCase(),
      expectedProfileVersion: null,
      patch: {
        headline: '  Principal   engineer  ',
        biography: 'Line one\r\nLine two',
        links: [{ kind: 'website', label: '  Work  ', href: 'https://example.com/profile' }]
      }
    })).toEqual({
      personId: id('1'),
      expectedProfileVersion: null,
      patch: {
        headline: 'Principal engineer',
        biography: 'Line one\nLine two',
        links: [{ kind: 'website', label: 'Work', href: 'https://example.com/profile' }]
      }
    });
    expect(speakerProfileLinkSchema.safeParse({
      kind: 'website', label: 'Work', href: 'http://example.com'
    }).success).toBe(false);
  });

  test('requires a real patch and unique approval fields', () => {
    expect(speakerProfileUpdateInputSchema.safeParse({
      personId: id('1'), expectedProfileVersion: null, patch: {}
    }).success).toBe(false);
    expect(speakerProfileApproveInputSchema.safeParse({
      personId: id('1'), expectedProfileVersion: 1, fields: ['headline', 'headline']
    }).success).toBe(false);
  });

  test('refuses duplicate or cross-scope current approvals', () => {
    const workspaceId = id('1');
    const eventId = id('2');
    const personId = id('3');
    const profile = {
      schemaVersion: 1 as const,
      workspaceId,
      personId,
      version: 1,
      headline: { revision: 1, digestSha256: digest, value: 'Engineer' },
      biography: { revision: 1, digestSha256: digest, value: '' },
      location: { revision: 1, digestSha256: digest, value: '' },
      links: { revision: 1, digestSha256: digest, value: [] },
      updatedAt: '2026-08-18T00:00:00.000Z'
    };
    const approval = {
      id: id('4'), workspaceId, eventId, personId, field: 'headline' as const,
      fieldRevision: 1, fieldDigestSha256: digest,
      actor: { kind: 'user' as const, userId: id('5') },
      approvedAt: '2026-08-18T00:01:00.000Z'
    };
    expect(speakerProfileViewSchema.safeParse({
      schemaVersion: 1, workspaceId, eventId, personId,
      reviewPolicy: { schemaVersion: 1, workspaceId, eventId, eventVersion: 1, reviewRequired: true },
      profile,
      approvals: [approval, { ...approval, id: id('6') }]
    }).success).toBe(false);
  });

  test('distinguishes a human approval from policy-minted evidence', () => {
    const common = {
      id: id('4'), workspaceId: id('1'), eventId: id('2'), personId: id('3'),
      field: 'headline' as const, fieldRevision: 1, fieldDigestSha256: digest,
      approvedAt: '2026-08-18T00:01:00.000Z'
    };
    expect(speakerProfileApprovalSchema.parse({
      ...common, actor: { kind: 'user', userId: id('5') }
    }).actor).toEqual({ kind: 'user', userId: id('5') });
    expect(speakerProfileApprovalSchema.parse({
      ...common,
      actor: {
        kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
        initiatedByUserId: null
      }
    }).actor).toEqual({
      kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
      initiatedByUserId: null
    });
  });

  test('review policy updates carry an exact event-version guard', () => {
    expect(speakerProfileReviewPolicyUpdateInputSchema.parse({
      expectedEventVersion: 3, reviewRequired: true
    })).toEqual({ expectedEventVersion: 3, reviewRequired: true });
    expect(speakerProfileReviewPolicyUpdateInputSchema.safeParse({
      expectedEventVersion: 0, reviewRequired: true
    }).success).toBe(false);
  });
});
