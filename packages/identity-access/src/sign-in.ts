import type {
  ExternalIdentityClaims,
  ExternalIdentityLink,
  ProviderAvatarCandidate,
  User,
  UserEmail,
  WorkspaceId,
  WorkspaceMembership
} from './identity';
import { externalIdentityKey, normalizeEmail } from './identity';
import type { OperationalNotice } from './outcomes';
import type {
  AccessReservation,
  ReservedPermissionOverride,
  ReservedRoleAssignment
} from './permissions';

export type UserReference =
  | { readonly kind: 'existing'; readonly userId: string }
  | { readonly kind: 'new' };

export type SignInMutation =
  | { readonly type: 'create_user'; readonly displayName: string; readonly status: 'active' | 'pending_review' }
  | { readonly type: 'activate_user'; readonly userId: string }
  | { readonly type: 'add_verified_email'; readonly user: UserReference; readonly email: string }
  | { readonly type: 'link_external_identity'; readonly user: UserReference; readonly claims: ExternalIdentityClaims }
  | { readonly type: 'refresh_external_identity_snapshot'; readonly identityLinkId: string; readonly claims: ExternalIdentityClaims }
  | { readonly type: 'create_membership'; readonly user: UserReference; readonly workspaceId: WorkspaceId; readonly status: 'active' | 'pending_review' }
  | { readonly type: 'activate_membership'; readonly membershipId: string; readonly reservationId: string }
  | { readonly type: 'assign_reserved_roles'; readonly user: UserReference; readonly roleAssignments: readonly ReservedRoleAssignment[] }
  | { readonly type: 'apply_reserved_permission_overrides'; readonly user: UserReference; readonly permissionOverrides: readonly ReservedPermissionOverride[] }
  | { readonly type: 'consume_access_reservation'; readonly reservationId: string; readonly user: UserReference }
  | { readonly type: 'request_avatar_import'; readonly user: UserReference; readonly candidate: ProviderAvatarCandidate; readonly policy: 'replace' }
  | { readonly type: 'expose_active_access_context'; readonly user: UserReference; readonly workspaceId: WorkspaceId }
  | { readonly type: 'expose_pending_review_access_context'; readonly user: UserReference; readonly workspaceId: WorkspaceId }
  | { readonly type: 'write_audit_event'; readonly eventType: string; readonly user: UserReference };

export type SignInResult =
  | 'signed_in'
  | 'awaiting_approval'
  | 'confirmation_required'
  | 'rejected';

export interface SignInPlan {
  readonly result: SignInResult;
  readonly code:
    | 'active_member'
    | 'new_preapproved_member'
    | 'existing_preapproved_member'
    | 'new_member_pending_review'
    | 'existing_member_pending_review'
    | 'explicit_link_required'
    | 'email_not_verified'
    | 'user_inactive'
    | 'membership_inactive';
  readonly message: string;
  readonly mutations: readonly SignInMutation[];
  readonly notices: readonly OperationalNotice[];
}

export interface PlanSignInInput {
  readonly workspaceId: WorkspaceId;
  readonly claims: ExternalIdentityClaims;
  readonly identityLink?: ExternalIdentityLink;
  readonly linkedUser?: User;
  readonly linkedMembership?: WorkspaceMembership;
  /** A user found by verified normalized email, but without this exact provider identity. */
  readonly sameEmailUser?: { readonly user: User; readonly email: UserEmail };
  readonly reservation?: AccessReservation;
  readonly now: string;
}

function reservationIsUsable(
  reservation: AccessReservation | undefined,
  normalizedEmail: string,
  workspaceId: WorkspaceId,
  now: string
): reservation is AccessReservation {
  return Boolean(
    reservation &&
      reservation.workspaceId === workspaceId &&
      reservation.normalizedEmail === normalizedEmail &&
      reservation.status === 'open' &&
      (reservation.expiresAt === undefined || Date.parse(reservation.expiresAt) > Date.parse(now))
  );
}

function existingUserRef(user: User): UserReference {
  return { kind: 'existing', userId: user.id };
}

function displayNameFromClaims(claims: ExternalIdentityClaims): string {
  return claims.displayName ?? claims.email?.split('@')[0] ?? 'New user';
}

function avatarMutation(
  claims: ExternalIdentityClaims,
  user: UserReference
): readonly SignInMutation[] {
  return claims.avatar
    ? [{ type: 'request_avatar_import', user, candidate: claims.avatar, policy: 'replace' }]
    : [];
}

function reservedAccessMutations(
  reservation: AccessReservation,
  user: UserReference
): readonly SignInMutation[] {
  return [
    ...(reservation.roleAssignments.length > 0
      ? [{ type: 'assign_reserved_roles', user, roleAssignments: reservation.roleAssignments } as const]
      : []),
    ...(reservation.permissionOverrides.length > 0
      ? [{ type: 'apply_reserved_permission_overrides', user, permissionOverrides: reservation.permissionOverrides } as const]
      : [])
  ];
}

/**
 * Produces mutations for one transaction. It never links accounts merely because
 * their email strings match; that requires a separately authenticated confirmation.
 */
export function planSignIn(input: PlanSignInInput): SignInPlan {
  const { claims } = input;

  if (input.identityLink) {
    const user = input.linkedUser;
    if (!user || input.identityLink.userId !== user.id) {
      return {
        result: 'rejected',
        code: 'user_inactive',
        message: 'The external identity link does not resolve to an available user.',
        mutations: [],
        notices: []
      };
    }

    if (user.status === 'suspended' || user.status === 'deactivated') {
      return {
        result: 'rejected',
        code: 'user_inactive',
        message: `This account is ${user.status}; no session was issued.`,
        mutations: [],
        notices: []
      };
    }

    const membership = input.linkedMembership;
    if (membership?.status === 'active') {
      const userRef = existingUserRef(user);
      return {
        result: 'signed_in',
        code: 'active_member',
        message: 'The verified external identity belongs to an active workspace member.',
        mutations: [
          { type: 'refresh_external_identity_snapshot', identityLinkId: input.identityLink.id, claims },
          ...avatarMutation(claims, userRef),
          { type: 'expose_active_access_context', user: userRef, workspaceId: input.workspaceId },
          { type: 'write_audit_event', eventType: 'auth.sign_in.succeeded', user: userRef }
        ],
        notices: []
      };
    }

    const verifiedEmail = claims.email && claims.emailVerified ? normalizeEmail(claims.email) : undefined;
    const usableReservation = verifiedEmail
      ? reservationIsUsable(input.reservation, verifiedEmail, input.workspaceId, input.now)
        ? input.reservation
        : undefined
      : undefined;

    if (
      usableReservation &&
      (!membership || membership.status === 'invited' || membership.status === 'pending_review')
    ) {
      const userRef = existingUserRef(user);
      return {
        result: 'signed_in',
        code: 'existing_preapproved_member',
        message: 'The verified email matches an open reservation, so the existing user is admitted to this workspace.',
        mutations: [
          { type: 'refresh_external_identity_snapshot', identityLinkId: input.identityLink.id, claims },
          ...(user.status === 'pending_review' ? [{ type: 'activate_user', userId: user.id } as const] : []),
          ...(!membership
            ? [{ type: 'create_membership', user: userRef, workspaceId: input.workspaceId, status: 'active' } as const]
            : [{ type: 'activate_membership', membershipId: membership.id, reservationId: usableReservation.id } as const]),
          ...reservedAccessMutations(usableReservation, userRef),
          { type: 'consume_access_reservation', reservationId: usableReservation.id, user: userRef },
          ...avatarMutation(claims, userRef),
          { type: 'expose_active_access_context', user: userRef, workspaceId: input.workspaceId },
          { type: 'write_audit_event', eventType: 'auth.preapproved_existing_user_joined', user: userRef }
        ],
        notices: []
      };
    }

    if (!membership || membership.status === 'invited' || membership.status === 'pending_review') {
      const userRef = existingUserRef(user);
      return {
        result: 'awaiting_approval',
        code: 'existing_member_pending_review',
        message: 'Identity is verified, but workspace admission still needs administrator approval.',
        mutations: [
          { type: 'refresh_external_identity_snapshot', identityLinkId: input.identityLink.id, claims },
          ...avatarMutation(claims, userRef),
          ...(!membership
            ? [{ type: 'create_membership', user: userRef, workspaceId: input.workspaceId, status: 'pending_review' } as const]
            : []),
          { type: 'expose_pending_review_access_context', user: userRef, workspaceId: input.workspaceId },
          { type: 'write_audit_event', eventType: 'auth.sign_in.awaiting_approval', user: userRef }
        ],
        notices: []
      };
    }

    return {
      result: 'rejected',
      code: 'membership_inactive',
      message: `Workspace membership is ${membership.status}; no session was issued.`,
      mutations: [],
      notices: []
    };
  }

  if (!claims.email || !claims.emailVerified) {
    return {
      result: 'rejected',
      code: 'email_not_verified',
      message: 'A new JooEvents account requires a verified email from the login provider.',
      mutations: [],
      notices: []
    };
  }

  const normalizedEmail = normalizeEmail(claims.email);
  if (input.sameEmailUser) {
    return {
      result: 'confirmation_required',
      code: 'explicit_link_required',
      message: 'This verified email already belongs to a user, but this provider identity is not linked.',
      mutations: [],
      notices: [
        {
          code: 'implicit_email_link_blocked',
          severity: 'warning',
          message: `No account was linked from email alone. Confirm while signed in to the existing account. Identity key: ${externalIdentityKey(claims)}`
        }
      ]
    };
  }

  const userRef: UserReference = { kind: 'new' };
  const reservation = reservationIsUsable(
    input.reservation,
    normalizedEmail,
    input.workspaceId,
    input.now
  )
    ? input.reservation
    : undefined;

  if (reservation) {
    return {
      result: 'signed_in',
      code: 'new_preapproved_member',
      message: 'The verified email matches an open access reservation, so workspace access is active immediately.',
      mutations: [
        { type: 'create_user', displayName: displayNameFromClaims(claims), status: 'active' },
        { type: 'add_verified_email', user: userRef, email: claims.email },
        { type: 'link_external_identity', user: userRef, claims },
        ...avatarMutation(claims, userRef),
        { type: 'create_membership', user: userRef, workspaceId: input.workspaceId, status: 'active' },
        ...reservedAccessMutations(reservation, userRef),
        { type: 'consume_access_reservation', reservationId: reservation.id, user: userRef },
        { type: 'expose_active_access_context', user: userRef, workspaceId: input.workspaceId },
        { type: 'write_audit_event', eventType: 'auth.preapproved_user_joined', user: userRef }
      ],
      notices: []
    };
  }

  return {
    result: 'awaiting_approval',
    code: 'new_member_pending_review',
    message: 'The account was recorded, but it can only see the review screen until an administrator approves it.',
    mutations: [
      { type: 'create_user', displayName: displayNameFromClaims(claims), status: 'pending_review' },
      { type: 'add_verified_email', user: userRef, email: claims.email },
      { type: 'link_external_identity', user: userRef, claims },
      ...avatarMutation(claims, userRef),
      { type: 'create_membership', user: userRef, workspaceId: input.workspaceId, status: 'pending_review' },
      { type: 'expose_pending_review_access_context', user: userRef, workspaceId: input.workspaceId },
      { type: 'write_audit_event', eventType: 'auth.user_requested_access', user: userRef }
    ],
    notices: []
  };
}
