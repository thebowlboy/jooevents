import {
  evaluateAccess,
  parseOperationAccessLane,
  type ApiKeyStore,
  type AuthorizationRepository,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolutionInput,
  type CurrentAuthorityResolver,
  type CurrentResolvedAuthority,
  type MembershipRepository,
  type PermissionId
} from '@jooevents/identity-access';
import {
  parseApiKeyId,
  parseInstant,
  parseMembershipId,
  parseWorkspaceId,
  type ResolvedScope,
  type WorkspaceId
} from '@jooevents/kernel';
import type { InvocationEvidence } from './operations/invocation-context';
import { getCompiledReadOperation } from './operations/registry';
import type { OperationRegistry } from './operations/types';
import {
  resolveOperatorAuthorityPermissionRequirement,
  type OperatorAuthorityPolicyCatalog,
  type OperatorScopeRelationshipValidator
} from './operator-authority';

function evidenceRef(kind: string, id: string): string {
  if (id.length === 0 || id.length > 160) throw new TypeError('external_agent_evidence_id_invalid');
  return `${kind}:${id.length}:${id}`;
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function denialReason(input: {
  readonly code: ReturnType<typeof evaluateAccess>['code'];
  readonly membershipPresent: boolean;
}): CurrentAuthorityDenialReason {
  switch (input.code) {
    case 'membership_inactive': return input.membershipPresent ? 'revoked' : 'missing';
    case 'scope_not_allowed': return 'cross_scope';
    case 'denied_directly':
    case 'permission_missing': return 'not_authorized';
    case 'granted_directly':
    case 'granted_by_role': throw new TypeError('allowed_access_became_denial');
  }
}

/** Fails startup if an exposed external read lacks the exact shared permission policy. */
export function assertExternalAgentAuthorityPolicyCatalogCoversOperationRegistry(input: {
  readonly catalog: OperatorAuthorityPolicyCatalog;
  readonly registry: OperationRegistry;
}): void {
  for (const operation of input.registry.safeManifest.operations) {
    const binding = operation.enabledBindings.find((candidate) => candidate.surface === 'external_mcp');
    if (!binding) continue;
    if (operation.effect !== 'read') {
      throw new TypeError(`External agent effect binding is forbidden for ${operation.name}@${operation.version}.`);
    }
    const compiled = getCompiledReadOperation(
      input.registry,
      operation.name,
      operation.version,
      'external_mcp'
    );
    const lanes = compiled?.operation.definition.accessLanes.filter((lane) =>
      lane.kind === 'external_mcp' && lane.surface === 'external_mcp'
    ) ?? [];
    if (lanes.length !== 1 || !resolveOperatorAuthorityPermissionRequirement({
      catalog: input.catalog,
      policy: lanes[0]!.policy,
      scope: Object.freeze({
        workspaceId: parseWorkspaceId('00000000-0000-4000-8000-000000000000'),
        subjects: Object.freeze([]),
        resolutionEvidenceIds: Object.freeze([])
      })
    })) {
      // A domain-subject mapping may need a concrete scope. Catalog membership,
      // rather than a guessed subject, is checked again at invocation time.
      const policyPresent = input.catalog.policies.some((entry) =>
        entry.policy.key === lanes[0]?.policy.key && entry.policy.version === lanes[0]?.policy.version
      );
      if (lanes.length !== 1 || !policyPresent) {
        throw new TypeError(
          `External agent authority policy is not mapped for ${operation.name}@${operation.version}.`
        );
      }
    }
  }
}

/**
 * Intersects one API key's immutable scope with its owning User's current
 * membership, role, override, and event relationships on every invocation.
 */
export function createExternalAgentAuthorityResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly policies: OperatorAuthorityPolicyCatalog;
  readonly apiKeys: ApiKeyStore;
  readonly memberships: MembershipRepository;
  readonly authorization: AuthorizationRepository;
  readonly scopeRelationships: OperatorScopeRelationshipValidator;
}): CurrentAuthorityResolver<InvocationEvidence> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const getKey = input.apiKeys.get.bind(input.apiKeys);
  const findMembership = input.memberships.find.bind(input.memberships);
  const listRoles = input.authorization.listRoles.bind(input.authorization);
  const listAssignments = input.authorization.listAssignments.bind(input.authorization);
  const listOverrides = input.authorization.listOverrides.bind(input.authorization);
  const validateRelationships = input.scopeRelationships.validate.bind(input.scopeRelationships);

  return Object.freeze({
    async resolve(resolutionInput: CurrentAuthorityResolutionInput<InvocationEvidence>) {
      const lane = parseOperationAccessLane(resolutionInput.lane);
      const evidence = resolutionInput.evidence;
      if (lane.kind !== 'external_mcp' || lane.surface !== 'external_mcp'
          || evidence.kind !== 'external_mcp' || evidence.surface !== 'external_mcp') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      if (resolutionInput.scope.workspaceId !== workspaceId) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const requirement = resolveOperatorAuthorityPermissionRequirement({
        catalog: input.policies,
        policy: lane.policy,
        scope: resolutionInput.scope
      });
      if (!requirement) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const evaluatedAt = parseInstant(resolutionInput.evaluatedAt);
      let apiKeyId;
      try { apiKeyId = parseApiKeyId(evidence.credentialHandle); }
      catch { return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const }); }
      const key = getKey(apiKeyId);
      if (!key || key.workspaceId !== workspaceId || key.standing !== 'active'
          || (key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.parse(evaluatedAt))
          || evidence.clientKey !== `api-key:${key.apiKeyId}`) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
      if (!key.mayRead || resolutionInput.operation.effect !== 'read') {
        return Object.freeze({ kind: 'denied' as const, reason: 'not_authorized' as const });
      }
      if (key.eventIds.length > 0
          && (resolutionInput.scope.eventId === undefined
            || !key.eventIds.includes(resolutionInput.scope.eventId))) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }

      const relationship = await validateRelationships({
        userId: key.ownerUserId,
        scope: resolutionInput.scope,
        evaluatedAt
      });
      if (relationship.kind === 'denied') {
        return Object.freeze({ kind: 'denied' as const, reason: relationship.reason });
      }
      const membership = await findMembership(workspaceId, key.ownerUserId);
      const roles = await listRoles(workspaceId);
      const assignments = await listAssignments(workspaceId, key.ownerUserId);
      const overrides = await listOverrides(workspaceId, key.ownerUserId);
      const accessScope = resolutionInput.scope.eventId === undefined
        ? { kind: 'workspace' as const, workspaceId }
        : { kind: 'event' as const, workspaceId, eventId: resolutionInput.scope.eventId };
      const decisions = requirement.permissionIds.map((permissionId) => ({
        permissionId,
        keyAllows: key.permissionIds.includes(permissionId),
        access: evaluateAccess({
          userId: key.ownerUserId,
          permissionId,
          requestedScope: accessScope,
          ...(membership ? { membership } : {}),
          roles,
          assignments,
          overrides,
          now: evaluatedAt
        })
      }));
      const granted = decisions.filter((decision) => decision.keyAllows && decision.access.allowed);
      const satisfied = requirement.kind === 'all_of'
        ? granted.length === decisions.length
        : granted.length > 0;
      if (!satisfied) {
        const ownerDenial = decisions.find((decision) => !decision.access.allowed);
        return Object.freeze({
          kind: 'denied' as const,
          reason: ownerDenial
            ? denialReason({ code: ownerDenial.access.code, membershipPresent: membership !== undefined })
            : 'not_authorized'
        });
      }
      if (!membership || !Number.isSafeInteger(membership.version) || (membership.version ?? 0) <= 0) {
        return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      }
      const membershipId = parseMembershipId(membership.id);
      const permissionEvidence = granted.flatMap((decision) => decision.access.evidence)
        .filter((entry) => entry.effect === 'grant')
        .map((entry) => evidenceRef(`access-${entry.kind}`, entry.id));
      const authority: CurrentResolvedAuthority = Object.freeze({
        actor: Object.freeze({
          kind: 'external_mcp_client' as const,
          clientKey: evidence.clientKey,
          authorityPrincipalId: key.ownerUserId
        }),
        principal: Object.freeze({
          kind: 'workspace_user' as const,
          userId: key.ownerUserId,
          membershipId
        }),
        lane,
        scope: resolutionInput.scope,
        grants: Object.freeze(granted.map((decision) => Object.freeze({
          kind: 'token_scope' as const,
          key: decision.permissionId as PermissionId
        }))),
        evidenceIds: canonicalStrings([
          evidenceRef('api-key', `${key.apiKeyId}@${key.version}`),
          evidenceRef('membership', `${membershipId}@${membership.version}`),
          ...permissionEvidence,
          ...relationship.evidenceIds
        ]),
        authorityCitationIds: Object.freeze([]),
        evaluatedAt
      });
      return Object.freeze({ kind: 'authorized' as const, authority });
    }
  });
}
