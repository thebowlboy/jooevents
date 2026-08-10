import {
  failure,
  normalizeEmail,
  success,
  type AccessDecision,
  type AdapterOutcome,
  type PermissionId,
  type ReservedPermissionOverride,
  type ReservedRoleAssignment
} from '@jooevents/identity-access';

export interface ReservationCommand {
  readonly workspaceId: string;
  readonly email: string;
  readonly expiresAt?: string;
  readonly roleAssignments: readonly ReservedRoleAssignment[];
  readonly permissionOverrides: readonly ReservedPermissionOverride[];
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly now: string;
}

export interface ReservationResult {
  readonly id: string;
  readonly workspaceId: string;
  readonly normalizedEmail: string;
  readonly status: 'open';
  readonly version: number;
}

export type MembershipAction = 'approve' | 'reject' | 'suspend' | 'restore';

export interface MembershipCommand {
  readonly action: MembershipAction;
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly expectedVersion: number;
  readonly reason?: string;
  readonly roleAssignments?: readonly ReservedRoleAssignment[];
  readonly permissionOverrides?: readonly ReservedPermissionOverride[];
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly now: string;
}

export interface MembershipResult {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly status: 'active' | 'suspended' | 'deactivated';
  readonly version: number;
}

export interface AccessAdministrationStore {
  createReservation(command: ReservationCommand & { readonly normalizedEmail: string }): Promise<AdapterOutcome<ReservationResult>>;
  decideMembership(command: MembershipCommand): Promise<AdapterOutcome<MembershipResult>>;
}

export interface SessionRevoker {
  revokeUserSessions(userId: string): Promise<AdapterOutcome<{ readonly revoked: number }>>;
}

export type AccessAdminAuthorizer = (input: {
  readonly userId: string;
  readonly workspaceId: string;
  readonly permissionId: PermissionId;
}) => Promise<AccessDecision>;

function denied(decision: AccessDecision): AdapterOutcome<never> {
  return failure({
    code: decision.code,
    message: 'The current user is not permitted to perform this access-management operation.',
    retryable: false,
    details: { evidenceIds: decision.evidence.map((item) => item.id) }
  });
}

export function createAccessAdministrationService(input: {
  readonly authorize: AccessAdminAuthorizer;
  readonly store: AccessAdministrationStore;
  readonly sessions: SessionRevoker;
}) {
  async function requirePermission(userId: string, workspaceId: string, permissionId: PermissionId) {
    return input.authorize({ userId, workspaceId, permissionId });
  }

  return {
    async createReservation(command: ReservationCommand): Promise<AdapterOutcome<ReservationResult>> {
      const decision = await requirePermission(command.actorUserId, command.workspaceId, 'access.users.invite');
      if (!decision.allowed) return denied(decision);
      return input.store.createReservation({ ...command, normalizedEmail: normalizeEmail(command.email) });
    },

    async decideMembership(command: MembershipCommand): Promise<AdapterOutcome<MembershipResult>> {
      const permissionId = command.action === 'approve' || command.action === 'reject'
        ? 'access.users.approve'
        : 'access.users.suspend';
      const decision = await requirePermission(command.actorUserId, command.workspaceId, permissionId);
      if (!decision.allowed) return denied(decision);
      const result = await input.store.decideMembership(command);
      if (result.kind === 'success' && command.action === 'suspend') {
        const revocation = await input.sessions.revokeUserSessions(result.data.userId);
        if (revocation.kind === 'error') {
          return success(result.data, [...result.notices, {
            code: 'session_revocation_delayed',
            severity: 'warning',
            message: 'Membership is suspended; authentication-session revocation will be retried.'
          }]);
        }
      }
      return result;
    }
  };
}
