import { describe, expect, test } from 'bun:test';
import {
  workspaceTeamInviteDraftInputSchema,
  workspaceTeamMemberViewSchema,
  workspaceTeamRemovalDraftInputSchema,
  workspaceTeamRoleChangeDraftInputSchema,
  workspaceTeamSafeDiffSchema,
  workspaceTeamSnapshotSchema
} from './workspace-team';

const digest = 'a'.repeat(64);
const membershipId = '018f7d5a-4b3c-7abc-8def-012345678901';

describe('workspace team browser contracts', () => {
  test('keeps trusted scope, actor, time, and authority out of effect inputs', () => {
    const invite = {
      email: 'owner@example.test', roleKey: 'workspace_admin',
      expectedTeamVersion: 4, expectedTeamDigestSha256: digest
    };
    expect(workspaceTeamInviteDraftInputSchema.parse(invite).email).toBe('owner@example.test');
    for (const field of ['workspaceId', 'actorUserId', 'evaluatedAt', 'authority', 'receiptId']) {
      expect(workspaceTeamInviteDraftInputSchema.safeParse({ ...invite, [field]: 'forged' }).success)
        .toBe(false);
    }

    const subject = { kind: 'member' as const, membershipId, version: 2 };
    expect(workspaceTeamRoleChangeDraftInputSchema.safeParse({
      subject, roleKey: 'viewer', expectedTeamVersion: 4, expectedTeamDigestSha256: digest
    }).success).toBe(true);
    expect(workspaceTeamRemovalDraftInputSchema.safeParse({
      subject, expectedTeamVersion: 4, expectedTeamDigestSha256: digest
    }).success).toBe(true);
  });

  test('does not permit a raw invitation address in the safe diff', () => {
    const safe = {
      action: 'invite',
      recipientHint: 'recipient-a1b2c3d4e5f6',
      role: { key: 'viewer', name: 'Viewer', version: 1 },
      invitationStatus: 'recorded',
      delivery: 'awaiting_activation'
    } as const;
    expect(workspaceTeamSafeDiffSchema.safeParse(safe).success).toBe(true);
    expect(workspaceTeamSafeDiffSchema.safeParse({ ...safe, email: 'owner@example.test' }).success)
      .toBe(false);
    expect(JSON.stringify(workspaceTeamSafeDiffSchema.parse(safe)))
      .not.toContain('owner@example.test');
    expect(safe.recipientHint).not.toContain('@');
  });

  test('distinguishes active members from recorded invitations', () => {
    expect(workspaceTeamMemberViewSchema.parse({
      id: membershipId,
      kind: 'member',
      userId: '018f7d5a-4b3c-7abc-8def-012345678902',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      role: { key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
      status: 'active',
      version: 1,
      hasAdditionalAccess: false
    }).status).toBe('active');
    const invitation = workspaceTeamMemberViewSchema.parse({
      id: '018f7d5a-4b3c-7abc-8def-012345678903',
      kind: 'invitation',
      name: 'Pending invitation',
      email: 'invitee@example.test',
      role: { key: 'viewer', name: 'Viewer', version: 1 },
      status: 'invited',
      delivery: 'awaiting_activation',
      version: 1,
      hasAdditionalAccess: false
    });
    expect(invitation.status).toBe('invited');
    if (invitation.status !== 'invited') throw new TypeError('expected invitation');
    expect(invitation.delivery).toBe('awaiting_activation');
  });

  test('rejects hostile or noncanonical list projections', () => {
    const roles = [
      { key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
      { key: 'event_manager', name: 'Event Manager', version: 1 },
      { key: 'speaker_manager', name: 'Speaker Manager', version: 1 },
      { key: 'speaker_reviewer', name: 'Speaker Reviewer', version: 1 },
      { key: 'scheduler', name: 'Scheduler', version: 1 },
      { key: 'communications_coordinator', name: 'Communications Coordinator', version: 1 },
      { key: 'viewer', name: 'Viewer', version: 1 }
    ];
    const member = {
      id: membershipId,
      kind: 'member',
      userId: '018f7d5a-4b3c-7abc-8def-012345678902',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      role: roles[0],
      status: 'active',
      version: 1,
      hasAdditionalAccess: false
    };
    const base = { schemaVersion: 1, version: 1, digestSha256: digest, roles, members: [member] };
    expect(workspaceTeamSnapshotSchema.safeParse(base).success).toBe(true);
    expect(workspaceTeamSnapshotSchema.safeParse({ ...base, roles: roles.map(() => roles[0]) }).success)
      .toBe(false);
    expect(workspaceTeamSnapshotSchema.safeParse({ ...base, members: [member, member] }).success)
      .toBe(false);
    expect(workspaceTeamSnapshotSchema.safeParse({
      ...base,
      members: [member, {
        id: member.id,
        kind: 'invitation',
        name: 'Pending invitation',
        email: 'invitee@example.test',
        role: roles[6],
        status: 'invited',
        delivery: 'awaiting_activation',
        version: 1,
        hasAdditionalAccess: false
      }]
    }).success).toBe(false);
    expect(workspaceTeamSnapshotSchema.safeParse({
      ...base, members: [{ ...member, email: 'ada@example.test\nBcc:x@example.test' }]
    }).success).toBe(false);
  });
});
