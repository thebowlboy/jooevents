import type { ISODateTime, UserId, WorkspaceMembership } from './identity';
import type {
  AccessScope,
  AccessScopeKind,
  PermissionId,
  PermissionOverride,
  Role,
  RoleAssignment
} from './permissions';
import { PERMISSIONS } from './permissions';

export type AccessDecisionCode =
  | 'granted_directly'
  | 'granted_by_role'
  | 'denied_directly'
  | 'membership_inactive'
  | 'scope_not_allowed'
  | 'permission_missing';

export interface AccessEvidence {
  readonly kind: 'membership' | 'role' | 'override' | 'default';
  readonly id: string;
  readonly label: string;
  readonly effect: 'grant' | 'deny' | 'inactive' | 'none';
  readonly scope?: AccessScope;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly code: AccessDecisionCode;
  readonly permissionId: PermissionId;
  readonly requestedScope: AccessScope;
  readonly explanation: string;
  readonly evidence: readonly AccessEvidence[];
}

export interface EvaluateAccessInput {
  readonly userId: UserId;
  readonly permissionId: PermissionId;
  readonly requestedScope: AccessScope;
  readonly membership?: WorkspaceMembership;
  readonly roles: readonly Role[];
  readonly assignments: readonly RoleAssignment[];
  readonly overrides: readonly PermissionOverride[];
  readonly now: ISODateTime;
}

function isExpired(expiresAt: ISODateTime | undefined, now: ISODateTime): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now);
}

function scopeApplies(grantScope: AccessScope, requestedScope: AccessScope): boolean {
  if (grantScope.workspaceId !== requestedScope.workspaceId) return false;
  if (grantScope.kind === 'workspace') return true;
  return requestedScope.kind === 'event' && grantScope.eventId === requestedScope.eventId;
}

/**
 * The sole access algorithm for HTTP handlers, jobs, and MCP tools.
 * Applicable direct deny wins, then direct grant, then role grant, then default deny.
 */
export function evaluateAccess(input: EvaluateAccessInput): AccessDecision {
  const definition = PERMISSIONS.find((permission) => permission.id === input.permissionId);
  const allowedScopeKinds: readonly AccessScopeKind[] = definition?.allowedScopes ?? [];
  if (!allowedScopeKinds.includes(input.requestedScope.kind)) {
    return {
      allowed: false,
      code: 'scope_not_allowed',
      permissionId: input.permissionId,
      requestedScope: input.requestedScope,
      explanation: `The ${input.permissionId} permission cannot be evaluated at ${input.requestedScope.kind} scope.`,
      evidence: [
        { kind: 'default', id: 'scope-policy', label: 'Permission scope policy', effect: 'none' }
      ]
    };
  }

  const membership = input.membership;
  if (
    !membership ||
    membership.userId !== input.userId ||
    membership.workspaceId !== input.requestedScope.workspaceId ||
    membership.status !== 'active'
  ) {
    return {
      allowed: false,
      code: 'membership_inactive',
      permissionId: input.permissionId,
      requestedScope: input.requestedScope,
      explanation: 'The user does not have an active membership in this workspace.',
      evidence: [
        {
          kind: 'membership',
          id: membership?.id ?? 'missing',
          label: membership ? `Membership is ${membership.status}` : 'No membership record',
          effect: 'inactive'
        }
      ]
    };
  }

  const applicableOverrides = input.overrides.filter(
    (override) =>
      override.userId === input.userId &&
      override.permissionId === input.permissionId &&
      !isExpired(override.expiresAt, input.now) &&
      scopeApplies(override.scope, input.requestedScope)
  );

  const deny = applicableOverrides.find((override) => override.effect === 'deny');
  if (deny) {
    return {
      allowed: false,
      code: 'denied_directly',
      permissionId: input.permissionId,
      requestedScope: input.requestedScope,
      explanation: `A direct deny applies: ${deny.reason}`,
      evidence: [
        { kind: 'override', id: deny.id, label: deny.reason, effect: 'deny', scope: deny.scope }
      ]
    };
  }

  const grant = applicableOverrides.find((override) => override.effect === 'grant');
  if (grant) {
    return {
      allowed: true,
      code: 'granted_directly',
      permissionId: input.permissionId,
      requestedScope: input.requestedScope,
      explanation: `A direct grant applies: ${grant.reason}`,
      evidence: [
        { kind: 'override', id: grant.id, label: grant.reason, effect: 'grant', scope: grant.scope }
      ]
    };
  }

  const roleById = new Map(input.roles.map((role) => [role.id, role]));
  const grantingRoleEvidence: AccessEvidence[] = [];

  for (const assignment of input.assignments) {
    if (
      assignment.userId !== input.userId ||
      isExpired(assignment.expiresAt, input.now) ||
      !scopeApplies(assignment.scope, input.requestedScope)
    ) {
      continue;
    }

    const role = roleById.get(assignment.roleId);
    if (
      !role ||
      role.workspaceId !== input.requestedScope.workspaceId ||
      role.archivedAt !== undefined ||
      !role.permissionIds.includes(input.permissionId)
    ) {
      continue;
    }

    grantingRoleEvidence.push({
      kind: 'role',
      id: assignment.id,
      label: `${role.name} role`,
      effect: 'grant',
      scope: assignment.scope
    });
  }

  if (grantingRoleEvidence.length > 0) {
    return {
      allowed: true,
      code: 'granted_by_role',
      permissionId: input.permissionId,
      requestedScope: input.requestedScope,
      explanation: `${grantingRoleEvidence[0]?.label ?? 'An assigned role'} grants this permission.`,
      evidence: grantingRoleEvidence
    };
  }

  return {
    allowed: false,
    code: 'permission_missing',
    permissionId: input.permissionId,
    requestedScope: input.requestedScope,
    explanation: 'No applicable role or direct grant provides this permission.',
    evidence: [
      { kind: 'default', id: 'default-deny', label: 'Default deny', effect: 'none' }
    ]
  };
}
