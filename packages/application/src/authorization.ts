import {
  evaluateAccess,
  type AccessDecision,
  type AccessScope,
  type AuthorizationRepository,
  type MembershipRepository,
  type PermissionId,
  type UserId
} from '@jooevents/identity-access';

export interface AccessEvaluatorDependencies {
  readonly memberships: MembershipRepository;
  readonly authorization: AuthorizationRepository;
  readonly now: () => string;
}

/** Loads live evidence at the server boundary and preserves the explainable decision. */
export function createAccessEvaluator(dependencies: AccessEvaluatorDependencies) {
  return async (input: {
    readonly userId: UserId;
    readonly permissionId: PermissionId;
    readonly scope: AccessScope;
  }): Promise<AccessDecision> => {
    const [membership, roles, assignments, overrides] = await Promise.all([
      dependencies.memberships.find(input.scope.workspaceId, input.userId),
      dependencies.authorization.listRoles(input.scope.workspaceId),
      dependencies.authorization.listAssignments(input.scope.workspaceId, input.userId),
      dependencies.authorization.listOverrides(input.scope.workspaceId, input.userId)
    ]);
    return evaluateAccess({
      userId: input.userId,
      permissionId: input.permissionId,
      requestedScope: input.scope,
      ...(membership ? { membership } : {}),
      roles,
      assignments,
      overrides,
      now: dependencies.now()
    });
  };
}
