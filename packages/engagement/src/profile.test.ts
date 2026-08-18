import { describe, expect, test } from 'bun:test';
import type { SpeakerProfileViewDto } from '@jooevents/contracts';
import {
  SpeakerProfilePlanningError,
  planSpeakerProfileApproval,
  planSpeakerProfileUpdate,
  type SpeakerProfilePlanningRepository
} from './profile';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const workspaceId = id('1');
const eventId = id('2');
const personId = id('3');
const actorUserId = id('4');
const occurredAt = '2026-08-18T00:00:00.000Z';

function repository(view?: SpeakerProfileViewDto, related = true): SpeakerProfilePlanningRepository {
  return {
    hasEventPersonRelationship: () => related,
    readSpeakerProfileView: () => view ?? {
      schemaVersion: 1, workspaceId, eventId, personId, profile: null, approvals: []
    }
  };
}

describe('speaker profile planning', () => {
  test('creates a reusable profile without fabricating unprovided fields', () => {
    const plan = planSpeakerProfileUpdate({
      planningInput: {
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
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
        scope: { workspaceId, eventId }, actorUserId, occurredAt,
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
        scope: { workspaceId, eventId }, actorUserId,
        occurredAt: '2026-08-18T00:02:00.000Z',
        authorInput: { personId, expectedProfileVersion: 1, patch: { headline: 'Principal engineer' } }
      }, profiles: repository(approved)
    }).after;
    expect(edited.profile?.headline.revision).toBe(2);
    expect(edited.approvals.map((approval) => approval.field)).toEqual(['location']);
  });

  test('refuses inferred identity, stale writes, empty approval, and repeat approval', () => {
    const planningInput = {
      scope: { workspaceId, eventId }, actorUserId, occurredAt,
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
});
