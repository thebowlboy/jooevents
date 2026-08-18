import { describe, expect, test } from 'bun:test';
import type { SpeakerProfileViewDto } from '@jooevents/contracts';
import {
  SpeakerProfilePlanningError,
  planSpeakerProfileApproval,
  planSpeakerProfileReviewPolicyUpdate,
  planSpeakerProfileUpdate,
  type SpeakerProfilePlanningRepository
} from './profile';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const workspaceId = id('1');
const eventId = id('2');
const personId = id('3');
const actorUserId = id('4');
const occurredAt = '2026-08-18T00:00:00.000Z';
const autoApprovalIds: [string, string, string, string] = [
  id('100'), id('101'), id('102'), id('103')
];

function repository(
  view?: SpeakerProfileViewDto,
  related = true,
  candidates: ReturnType<SpeakerProfilePlanningRepository['readPolicyApprovalCandidates']> = []
): SpeakerProfilePlanningRepository {
  const resolved = view ?? {
    schemaVersion: 1 as const, workspaceId, eventId, personId,
    reviewPolicy: {
      schemaVersion: 1 as const, workspaceId, eventId, eventVersion: 1, reviewRequired: true
    },
    profile: null, approvals: []
  };
  return {
    hasEventPersonRelationship: () => related,
    readSpeakerProfileView: () => resolved,
    readReviewPolicy: () => resolved.reviewPolicy,
    readPolicyApprovalCandidates: () => candidates
  };
}

describe('speaker profile planning', () => {
  test('creates a reusable profile without fabricating unprovided fields', () => {
    const plan = planSpeakerProfileUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt, autoApprovalIds,
        authorInput: { personId, expectedProfileVersion: null, patch: { headline: 'Engineer' } }
      },
      profiles: repository()
    });
    expect(plan.after.profile).toMatchObject({
      version: 1,
      headline: { revision: 1, value: 'Engineer' },
      biography: { revision: 1, value: '' },
      location: { revision: 1, value: '' },
      links: { revision: 1, value: [] }
    });
    expect(plan.changedFields).toEqual(['headline']);
  });

  test('invalidates only the approval whose exact field revision changed', () => {
    const created = planSpeakerProfileUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt, autoApprovalIds,
        authorInput: {
          personId, expectedProfileVersion: null,
          patch: { headline: 'Engineer', location: 'Singapore' }
        }
      }, profiles: repository()
    }).after;
    const approved = planSpeakerProfileApproval({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId,
        occurredAt: '2026-08-18T00:01:00.000Z',
        approvalIds: [id('5'), id('6')],
        authorInput: { personId, expectedProfileVersion: 1, fields: ['headline', 'location'] }
      }, profiles: repository(created)
    }).after;
    const edited = planSpeakerProfileUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, autoApprovalIds,
        occurredAt: '2026-08-18T00:02:00.000Z',
        authorInput: { personId, expectedProfileVersion: 1, patch: { headline: 'Principal engineer' } }
      }, profiles: repository(approved)
    }).after;
    expect(edited.profile?.headline.revision).toBe(2);
    expect(edited.approvals.map((approval) => approval.field)).toEqual(['location']);
  });

  test('refuses inferred identity, stale writes, empty approval, and repeat approval', () => {
    const planningInput = {
      scope: { workspaceId, eventId }, actorUserId, occurredAt, autoApprovalIds,
      authorInput: { personId, expectedProfileVersion: null, patch: { headline: 'Engineer' } }
    } as const;
    expect(() => planSpeakerProfileUpdate({ planningInput, profiles: repository(undefined, false) }))
      .toThrow(new SpeakerProfilePlanningError('person_out_of_scope'));

    const created = planSpeakerProfileUpdate({ planningInput, profiles: repository() }).after;
    expect(() => planSpeakerProfileApproval({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
        approvalIds: [id('5')],
        authorInput: { personId, expectedProfileVersion: 1, fields: ['biography'] }
      }, profiles: repository(created)
    })).toThrow(new SpeakerProfilePlanningError('profile_field_empty', 'biography'));

    const approved = planSpeakerProfileApproval({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
        approvalIds: [id('5')],
        authorInput: { personId, expectedProfileVersion: 1, fields: ['headline'] }
      }, profiles: repository(created)
    }).after;
    expect(() => planSpeakerProfileApproval({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
        approvalIds: [id('6')],
        authorInput: { personId, expectedProfileVersion: 1, fields: ['headline'] }
      }, profiles: repository(approved)
    })).toThrow(new SpeakerProfilePlanningError('profile_field_already_approved', 'headline'));
  });

  test('auto mode mints exact policy evidence and makes manual approval unavailable', () => {
    const automatic = repository({
      schemaVersion: 1, workspaceId, eventId, personId,
      reviewPolicy: {
        schemaVersion: 1, workspaceId, eventId, eventVersion: 7, reviewRequired: false
      },
      profile: null,
      approvals: []
    });
    const plan = planSpeakerProfileUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt, autoApprovalIds,
        authorInput: {
          personId, expectedProfileVersion: null,
          patch: { headline: 'Engineer', biography: 'Builds reliable systems.' }
        }
      },
      profiles: automatic
    });
    expect(plan.insertedApprovals.map((approval) => ({
      field: approval.field,
      actor: approval.actor
    }))).toEqual([
      {
        field: 'headline',
        actor: {
          kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
          initiatedByUserId: actorUserId
        }
      },
      {
        field: 'biography',
        actor: {
          kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
          initiatedByUserId: actorUserId
        }
      }
    ]);
    expect(() => planSpeakerProfileApproval({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
        approvalIds: [id('5')],
        authorInput: { personId, expectedProfileVersion: 1, fields: ['headline'] }
      },
      profiles: repository(plan.after)
    })).toThrow(new SpeakerProfilePlanningError('profile_review_not_required'));
  });

  test('switches review mode under the exact event version and policy-mints current evidence', () => {
    const created = planSpeakerProfileUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt, autoApprovalIds,
        authorInput: { personId, expectedProfileVersion: null, patch: { headline: 'Engineer' } }
      },
      profiles: repository()
    }).after;
    const headline = created.profile!.headline;
    const automatic = planSpeakerProfileReviewPolicyUpdate({
      planningInput: {
        scope: { workspaceId, eventId },
        actorUserId,
        occurredAt: '2026-08-18T00:03:00.000Z',
        approvalIds: [id('200')],
        authorInput: { expectedEventVersion: 1, reviewRequired: false }
      },
      profiles: repository(created, true, [{
        personId, field: 'headline', fieldRevision: headline.revision,
        fieldDigestSha256: headline.digestSha256
      }])
    });
    expect(automatic.after).toMatchObject({ eventVersion: 2, reviewRequired: false });
    expect(automatic.insertedApprovals).toEqual([expect.objectContaining({
      personId,
      field: 'headline',
      actor: {
        kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
        initiatedByUserId: actorUserId
      }
    })]);

    expect(() => planSpeakerProfileReviewPolicyUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
        approvalIds: [],
        authorInput: { expectedEventVersion: 99, reviewRequired: false }
      },
      profiles: repository(created)
    })).toThrow(new SpeakerProfilePlanningError('stale_profile'));
  });
});
