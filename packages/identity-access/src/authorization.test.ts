import { describe, expect, test } from 'bun:test';
import { evaluateAccess } from './authorization';
import type { WorkspaceMembership } from './identity';
import { createRoleFromPreset } from './permissions';
import type { PermissionOverride, RoleAssignment } from './permissions';

const now = '2026-08-09T08:00:00.000Z';
const workspaceId = 'workspace_summit';
const eventId = 'event_2027';

const membership: WorkspaceMembership = {
  id: 'membership_ada',
  workspaceId,
  userId: 'user_ada',
  status: 'active',
  createdAt: now,
  updatedAt: now
};

const role = createRoleFromPreset('speaker_reviewer', {
  id: 'role_reviewer',
  workspaceId
});

const assignment: RoleAssignment = {
  id: 'assignment_reviewer',
  userId: 'user_ada',
  roleId: role.id,
  scope: { kind: 'event', workspaceId, eventId },
  assignedByUserId: 'user_admin',
  assignedAt: now
};

function decide(
  permissionId: Parameters<typeof evaluateAccess>[0]['permissionId'],
  overrides: readonly PermissionOverride[] = [],
  requestedEventId = eventId,
  membershipOverride: WorkspaceMembership | undefined = membership
) {
  return evaluateAccess({
    userId: 'user_ada',
    permissionId,
    requestedScope: { kind: 'event', workspaceId, eventId: requestedEventId },
    membership: membershipOverride,
    roles: [role],
    assignments: [assignment],
    overrides,
    now
  });
}

describe('evaluateAccess', () => {
  test('grants a permission from an event-scoped role', () => {
    const decision = decide('submission.score');

    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('granted_by_role');
    expect(decision.evidence[0]?.label).toBe('Speaker Reviewer role');
  });

  test('keeps private speaker contact details out of the reviewer preset', () => {
    const decision = decide('speaker.contact.read');

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('permission_missing');
  });

  test('does not carry an event assignment into another event', () => {
    expect(decide('submission.read', [], 'event_other').allowed).toBe(false);
  });

  test('lets an applicable direct deny override a direct grant and a role grant', () => {
    const overrides: PermissionOverride[] = [
      {
        id: 'override_grant',
        userId: 'user_ada',
        permissionId: 'submission.score',
        effect: 'grant',
        scope: { kind: 'event', workspaceId, eventId },
        reason: 'Temporary review duty',
        decidedByUserId: 'user_admin',
        decidedAt: now
      },
      {
        id: 'override_deny',
        userId: 'user_ada',
        permissionId: 'submission.score',
        effect: 'deny',
        scope: { kind: 'workspace', workspaceId },
        reason: 'Conflict of interest',
        decidedByUserId: 'user_admin',
        decidedAt: now
      }
    ];

    const decision = decide('submission.score', overrides);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('denied_directly');
    expect(decision.explanation).toContain('Conflict of interest');
  });

  test('does not invent attribution or change policy when legacy access evidence has no user actor', () => {
    const unattributedAssignment: RoleAssignment = {
      id: 'assignment_legacy',
      userId: 'user_ada',
      roleId: role.id,
      scope: { kind: 'event', workspaceId, eventId },
      assignedAt: now
    };
    const unattributedDeny: PermissionOverride = {
      id: 'override_legacy',
      userId: 'user_ada',
      permissionId: 'submission.score',
      effect: 'deny',
      scope: { kind: 'event', workspaceId, eventId },
      reason: 'Retained conflict restriction',
      decidedAt: now
    };

    const decision = evaluateAccess({
      userId: 'user_ada',
      permissionId: 'submission.score',
      requestedScope: { kind: 'event', workspaceId, eventId },
      membership,
      roles: [role],
      assignments: [unattributedAssignment],
      overrides: [unattributedDeny],
      now
    });

    expect(decision).toMatchObject({ allowed: false, code: 'denied_directly' });
    expect(decision.evidence[0]?.id).toBe('override_legacy');
  });

  test('requires active membership before considering any grant', () => {
    const pending = { ...membership, status: 'pending_review' as const };
    const decision = decide('submission.score', [], eventId, pending);

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('membership_inactive');
  });

  test('rejects a permission at a scope excluded by its catalog definition', () => {
    const decision = evaluateAccess({
      userId: 'user_ada',
      permissionId: 'access.users.read',
      requestedScope: { kind: 'event', workspaceId, eventId },
      membership,
      roles: [createRoleFromPreset('workspace_admin', { id: 'role_admin', workspaceId })],
      assignments: [
        { ...assignment, id: 'assignment_admin', roleId: 'role_admin' }
      ],
      overrides: [],
      now
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('scope_not_allowed');
  });
});
