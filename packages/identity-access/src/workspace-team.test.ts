import { describe, expect, test } from 'bun:test';
import { parseInstant, parseMembershipId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  WORKSPACE_TEAM_PERMISSIONS,
  WorkspaceTeamPlanningError,
  planWorkspaceTeamRemoval,
  planWorkspaceTeamRoleChange,
  workspaceTeamRequiredPermission,
  type WorkspaceTeamPlanningSnapshot
} from './workspace-team';

const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678901');
const actor = parseUserId('018f7d5a-4b3c-7abc-8def-012345678902');
const other = parseUserId('018f7d5a-4b3c-7abc-8def-012345678903');
const now = parseInstant('2026-08-13T02:00:00.000Z');
const digest = 'a'.repeat(64);

function member(userId: typeof actor, roleKey: 'workspace_admin' | 'viewer', index: number) {
  return {
    kind: 'member' as const,
    membershipId: parseMembershipId(
      `018f7d5a-4b3c-7abc-8def-${(100 + index).toString().padStart(12, '0')}`
    ),
    membershipVersion: 1,
    workspaceId,
    userId,
    status: 'active' as const,
    primaryRole: {
      assignmentId: `018f7d5a-4b3c-7abc-8def-${(200 + index).toString().padStart(12, '0')}`,
      assignmentVersion: 1,
      roleId: `018f7d5a-4b3c-7abc-8def-${(300 + index).toString().padStart(12, '0')}`,
      roleKey
    },
    hasAdditionalAccess: false
  };
}

function snapshot(members = [member(actor, 'workspace_admin', 1), member(other, 'viewer', 2)]): WorkspaceTeamPlanningSnapshot {
  return {
    workspaceId,
    version: 4,
    digestSha256: digest,
    roles: new Map([
      ['workspace_admin', { id: '018f7d5a-4b3c-7abc-8def-000000000401', version: 1 }],
      ['viewer', { id: '018f7d5a-4b3c-7abc-8def-000000000402', version: 1 }]
    ]),
    members,
    invitations: []
  };
}

describe('workspace team policy', () => {
  test('uses the active permission catalog for each operation', () => {
    expect(workspaceTeamRequiredPermission('invite')).toBe(WORKSPACE_TEAM_PERMISSIONS.invite);
    expect(workspaceTeamRequiredPermission('change_role')).toBe('access.roles.manage');
    expect(workspaceTeamRequiredPermission('remove')).toBe('access.users.suspend');
  });

  test('denies current-session self removal and role changes', () => {
    const current = snapshot();
    expect(() => planWorkspaceTeamRemoval({
      snapshot: current,
      expectedTeamVersion: 4,
      expectedTeamDigestSha256: digest,
      subject: { kind: 'member', membershipId: current.members[0]!.membershipId, version: 1 },
      actorUserId: actor,
      evaluatedAt: now,
      historyId: '018f7d5a-4b3c-7abc-8def-000000000599',
      sessionRevocationIntentId: '018f7d5a-4b3c-7abc-8def-000000000500'
    })).toThrow('current_actor_removal');
    expect(() => planWorkspaceTeamRoleChange({
      snapshot: current,
      expectedTeamVersion: 4,
      expectedTeamDigestSha256: digest,
      subject: { kind: 'member', membershipId: current.members[0]!.membershipId, version: 1 },
      roleKey: 'viewer',
      actorUserId: actor,
      evaluatedAt: now,
      historyId: '018f7d5a-4b3c-7abc-8def-000000000598'
    })).toThrow('current_actor_role_change');
  });

  test('protects the last non-expiring active owner and detects stale guards', () => {
    const current = snapshot();
    expect(() => planWorkspaceTeamRoleChange({
      snapshot: current,
      expectedTeamVersion: 4,
      expectedTeamDigestSha256: digest,
      subject: { kind: 'member', membershipId: current.members[0]!.membershipId, version: 1 },
      roleKey: 'viewer',
      actorUserId: other,
      evaluatedAt: now,
      historyId: '018f7d5a-4b3c-7abc-8def-000000000597'
    })).toThrow('last_owner');
    expect(() => planWorkspaceTeamRemoval({
      snapshot: current,
      expectedTeamVersion: 3,
      expectedTeamDigestSha256: 'b'.repeat(64),
      subject: { kind: 'member', membershipId: current.members[1]!.membershipId, version: 1 },
      actorUserId: actor,
      evaluatedAt: now,
      historyId: '018f7d5a-4b3c-7abc-8def-000000000596',
      sessionRevocationIntentId: '018f7d5a-4b3c-7abc-8def-000000000501'
    })).toThrow('stale_team');
  });

  test('rejects a member reference from another workspace snapshot', () => {
    const crossWorkspace = {
      ...member(other, 'viewer', 3),
      workspaceId: parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678999')
    };
    try {
      planWorkspaceTeamRemoval({
        snapshot: snapshot([member(actor, 'workspace_admin', 1), crossWorkspace]),
        expectedTeamVersion: 4,
        expectedTeamDigestSha256: digest,
        subject: { kind: 'member', membershipId: crossWorkspace.membershipId, version: 1 },
        actorUserId: actor,
        evaluatedAt: now,
        historyId: '018f7d5a-4b3c-7abc-8def-000000000595',
        sessionRevocationIntentId: '018f7d5a-4b3c-7abc-8def-000000000502'
      });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceTeamPlanningError);
      expect((error as WorkspaceTeamPlanningError).code).toBe('wrong_scope');
    }
  });
});
