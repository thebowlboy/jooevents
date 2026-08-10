import { describe, expect, test } from 'bun:test';
import type {
  ExternalIdentityClaims,
  ExternalIdentityLink,
  User,
  WorkspaceMembership
} from './identity';
import type { AccessReservation } from './permissions';
import { planSignIn } from './sign-in';

const now = '2026-08-09T08:00:00.000Z';
const claims: ExternalIdentityClaims = {
  provider: 'google',
  issuer: 'https://accounts.google.com',
  subject: 'google-subject-ada',
  email: 'Ada@Example.com',
  emailVerified: true,
  displayName: 'Ada Lovelace',
  avatar: {
    provider: 'google',
    url: 'https://lh3.googleusercontent.com/a/ada',
    observedAt: now
  },
  observedAt: now
};

const reservation: AccessReservation = {
  id: 'reservation_ada',
  workspaceId: 'workspace_summit',
  normalizedEmail: 'ada@example.com',
  roleAssignments: [
    { roleId: 'role_reviewer', scope: { kind: 'event', eventId: 'event_2027' } }
  ],
  permissionOverrides: [
    {
      permissionId: 'audit.read',
      effect: 'grant',
      scope: { kind: 'event', eventId: 'event_2027' },
      reason: 'Reviewers may inspect this event audit trail'
    }
  ],
  status: 'open',
  createdByUserId: 'user_admin',
  createdAt: now
};

const user: User = {
  id: 'user_ada',
  status: 'active',
  displayName: 'Ada Lovelace',
  createdAt: now,
  updatedAt: now
};

const identityLink: ExternalIdentityLink = {
  id: 'identity_ada_google',
  userId: user.id,
  provider: claims.provider,
  issuer: claims.issuer,
  subject: claims.subject,
  emailSnapshot: 'Ada@Example.com',
  emailVerifiedSnapshot: true,
  linkedAt: now,
  lastObservedAt: now
};

const membership: WorkspaceMembership = {
  id: 'membership_ada',
  workspaceId: 'workspace_summit',
  userId: user.id,
  status: 'active',
  createdAt: now,
  updatedAt: now
};

describe('planSignIn', () => {
  test('admits a new user whose verified email has an open reservation', () => {
    const plan = planSignIn({ workspaceId: 'workspace_summit', claims, reservation, now });

    expect(plan.result).toBe('signed_in');
    expect(plan.code).toBe('new_preapproved_member');
    expect(plan.mutations.map((mutation) => mutation.type)).toEqual([
      'create_user',
      'add_verified_email',
      'link_external_identity',
      'request_avatar_import',
      'create_membership',
      'assign_reserved_roles',
      'apply_reserved_permission_overrides',
      'consume_access_reservation',
      'expose_active_access_context',
      'write_audit_event'
    ]);
  });

  test('creates a limited review session when no reservation exists', () => {
    const plan = planSignIn({ workspaceId: 'workspace_summit', claims, now });

    expect(plan.result).toBe('awaiting_approval');
    expect(plan.code).toBe('new_member_pending_review');
    expect(plan.mutations.some((mutation) => mutation.type === 'expose_pending_review_access_context')).toBe(true);
    expect(plan.mutations.some((mutation) => mutation.type === 'expose_active_access_context')).toBe(false);
  });

  test('never links a different provider identity from an email match alone', () => {
    const plan = planSignIn({
      workspaceId: 'workspace_summit',
      claims,
      sameEmailUser: {
        user,
        email: {
          id: 'email_ada',
          userId: user.id,
          normalizedEmail: 'ada@example.com',
          displayEmail: 'ada@example.com',
          verified: true,
          source: 'auth_provider',
          isPrimary: true,
          createdAt: now
        }
      },
      now
    });

    expect(plan.result).toBe('confirmation_required');
    expect(plan.code).toBe('explicit_link_required');
    expect(plan.mutations).toHaveLength(0);
  });

  test('trusts an existing issuer-and-subject link even if the current email claim is absent', () => {
    const { email: _email, ...claimsWithoutEmail } = claims;
    const plan = planSignIn({
      workspaceId: 'workspace_summit',
      claims: { ...claimsWithoutEmail, emailVerified: false },
      identityLink,
      linkedUser: user,
      linkedMembership: membership,
      now
    });

    expect(plan.result).toBe('signed_in');
    expect(plan.code).toBe('active_member');
  });

  test('blocks a suspended workspace membership before issuing a session', () => {
    const plan = planSignIn({
      workspaceId: 'workspace_summit',
      claims,
      identityLink,
      linkedUser: user,
      linkedMembership: { ...membership, status: 'suspended' },
      now
    });

    expect(plan.result).toBe('rejected');
    expect(plan.code).toBe('membership_inactive');
    expect(plan.mutations).toHaveLength(0);
  });

  test('applies a later reservation to an already linked pending user', () => {
    const pendingUser = { ...user, status: 'pending_review' as const };
    const plan = planSignIn({
      workspaceId: 'workspace_summit',
      claims,
      identityLink,
      linkedUser: pendingUser,
      linkedMembership: { ...membership, status: 'pending_review' },
      reservation,
      now
    });

    expect(plan.result).toBe('signed_in');
    expect(plan.code).toBe('existing_preapproved_member');
    expect(plan.mutations.map((mutation) => mutation.type)).toContain('activate_user');
    expect(plan.mutations.map((mutation) => mutation.type)).toContain('activate_membership');
    expect(plan.mutations.map((mutation) => mutation.type)).toContain('apply_reserved_permission_overrides');
  });
});
