import {
  PERMISSIONS,
  evaluateAccess,
  parseOperationAccessLane,
  type AuthorizationRepository,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolutionInput,
  type CurrentAuthorityResolver,
  type CurrentResolvedAuthority,
  type MembershipRepository,
  type OperationAccessLane,
  type PermissionId,
  type VersionedAccessPolicyRef
} from '@jooevents/identity-access';
import {
  parseInstant,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Instant,
  type ResolvedScope,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { InvocationEvidence } from './operations/invocation-context';
import {
  getCompiledEffectOperation,
  getCompiledReadOperation
} from './operations/registry';
import type { OperationRegistry } from './operations/types';

export type CurrentOperatorSessionResolution =
  | {
      readonly kind: 'current';
      readonly session: {
        /** Better Auth's non-credential session record identity, never its token. */
        readonly sessionId: string;
        readonly authUserId: string;
        readonly userId: UserId;
        readonly expiresAt: Instant;
        /** Credential-free durable evidence references safe to retain in authority. */
        readonly evidenceIds: readonly string[];
      };
    }
  | { readonly kind: 'denied'; readonly reason: 'missing' | 'revoked' };

/** Resolves only server-verified, opaque Better Auth session record handles. */
export interface CurrentOperatorSessionRepository {
  resolveCurrent(input: {
    readonly sessionHandle: string;
    readonly evaluatedAt: Instant;
  }): CurrentOperatorSessionResolution | Promise<CurrentOperatorSessionResolution>;
}

export type OperatorScopeRelationshipResolution =
  | { readonly kind: 'valid'; readonly evidenceIds: readonly string[] }
  | {
      readonly kind: 'denied';
      readonly reason: Extract<CurrentAuthorityDenialReason, 'missing' | 'revoked' | 'cross_scope'>;
    };

/**
 * Revalidates every server-resolved event and subject relationship. Implementations
 * used inside an effect transaction must be transaction-local readers only.
 */
export interface OperatorScopeRelationshipValidator {
  validate(input: {
    readonly userId: UserId;
    readonly scope: ResolvedScope;
    readonly evaluatedAt: Instant;
  }): OperatorScopeRelationshipResolution | Promise<OperatorScopeRelationshipResolution>;
}

export type OperatorAuthorityPermissionRule =
  | { readonly kind: 'fixed'; readonly permissionId: PermissionId }
  | {
      readonly kind: 'all_of';
      readonly permissionIds: readonly [PermissionId, PermissionId, ...PermissionId[]];
    }
  | {
      readonly kind: 'domain_subject';
      readonly domain: string;
      readonly entity: string;
      readonly mappings: readonly (
        | {
            readonly id: string;
            readonly permissionId: PermissionId;
          }
        | {
            readonly id: string;
            readonly anyOfPermissionIds: readonly [
              PermissionId,
              PermissionId,
              ...PermissionId[]
            ];
          }
      )[];
    };

type OperatorAuthorityDomainSubjectMapping = Extract<
  OperatorAuthorityPermissionRule,
  { readonly kind: 'domain_subject' }
>['mappings'][number];

/**
 * The shorthand remains source-compatible for fixed policies. Subject-derived
 * policies must use the explicit sealed rule so a generic operation family does
 * not acquire one broad permission by convenience.
 */
export type OperatorAuthorityPolicyRegistration =
  | {
      readonly policy: VersionedAccessPolicyRef;
      readonly permissionId: PermissionId;
    }
  | {
      readonly policy: VersionedAccessPolicyRef;
      readonly permission: OperatorAuthorityPermissionRule;
    };

interface CapturedOperatorAuthorityPolicyRegistration {
  readonly policy: VersionedAccessPolicyRef;
  readonly permission: OperatorAuthorityPermissionRule;
}

export interface OperatorAuthorityPolicyCatalog {
  readonly policies: readonly CapturedOperatorAuthorityPolicyRegistration[];
}

const policyCatalogEntries = new WeakMap<
  OperatorAuthorityPolicyCatalog,
  ReadonlyMap<string, CapturedOperatorAuthorityPolicyRegistration>
>();
const permissionIds = new Set<string>(PERMISSIONS.map((permission) => permission.id));
const stableSubjectKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function policyKey(policy: VersionedAccessPolicyRef): string {
  return `${policy.key}\u0000${policy.version}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareCodeUnits));
}

function canonicalGrants(
  values: readonly CurrentResolvedAuthority['grants'][number][]
): CurrentResolvedAuthority['grants'] {
  const byIdentity = new Map<string, CurrentResolvedAuthority['grants'][number]>();
  for (const value of values) byIdentity.set(`${value.kind}\u0000${value.key}`, value);
  return Object.freeze(
    [...byIdentity.values()]
      .sort((left, right) =>
        compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.key, right.key)
      )
      .map((grant) => Object.freeze({ ...grant }))
  );
}

function boundedOpaque(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function evidenceRef(kind: string, id: string): string {
  const bounded = boundedOpaque(id, `${kind} evidence ID`);
  return `${kind}:${bounded.length}:${bounded}`;
}

/** Creates the sole accepted mapping from an exact operator lane policy to permission. */
export function createOperatorAuthorityPolicyCatalog(
  candidates: readonly OperatorAuthorityPolicyRegistration[]
): OperatorAuthorityPolicyCatalog {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('At least one operator authority policy is required.');
  }
  const entries = candidates.map((candidate): CapturedOperatorAuthorityPolicyRegistration => {
    const lane = parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: candidate.policy
    });
    const candidateKeys = Object.keys(candidate).sort();
    const shorthand = 'permissionId' in candidate;
    if (candidateKeys.join('\u0000') !== (shorthand
      ? ['permissionId', 'policy'].join('\u0000')
      : ['permission', 'policy'].join('\u0000'))) {
      throw new TypeError('Operator authority policy has unknown fields.');
    }
    let permission: OperatorAuthorityPermissionRule;
    if (shorthand) {
      if (!permissionIds.has(candidate.permissionId)) {
        throw new TypeError('Operator authority policy names an unknown permission.');
      }
      permission = Object.freeze({ kind: 'fixed', permissionId: candidate.permissionId });
    } else {
      const rule: OperatorAuthorityPermissionRule = candidate.permission;
      if (!rule || typeof rule !== 'object') {
        throw new TypeError('Operator authority permission rule is invalid.');
      }
      if (rule.kind === 'fixed') {
        if (Object.keys(rule).sort().join('\u0000') !== ['kind', 'permissionId'].join('\u0000')
            || !permissionIds.has(rule.permissionId)) {
          throw new TypeError('Operator authority policy names an unknown permission.');
        }
        permission = Object.freeze({ kind: 'fixed', permissionId: rule.permissionId });
      } else if (rule.kind === 'all_of') {
        if (Object.keys(rule).sort().join('\u0000') !== ['kind', 'permissionIds'].join('\u0000')
            || !Array.isArray(rule.permissionIds)
            || rule.permissionIds.length < 2
            || rule.permissionIds.length > 32
            || rule.permissionIds.some((permissionId) => !permissionIds.has(permissionId))) {
          throw new TypeError('Operator authority all-of rule is invalid.');
        }
        const canonical = [...rule.permissionIds].sort(compareCodeUnits);
        if (new Set(canonical).size !== canonical.length) {
          throw new TypeError('Operator authority all-of permissions must be unique.');
        }
        permission = Object.freeze({
          kind: 'all_of',
          permissionIds: Object.freeze(canonical) as readonly [
            PermissionId, PermissionId, ...PermissionId[]
          ]
        });
      } else if (rule.kind === 'domain_subject') {
        if (Object.keys(rule).sort().join('\u0000')
              !== ['domain', 'entity', 'kind', 'mappings'].join('\u0000')
            || !stableSubjectKey.test(rule.domain)
            || !stableSubjectKey.test(rule.entity)
            || !Array.isArray(rule.mappings)
            || rule.mappings.length === 0) {
          throw new TypeError('Operator authority domain-subject rule is invalid.');
        }
        const mappings = rule.mappings.map((mapping: OperatorAuthorityDomainSubjectMapping) => {
          if (!mapping || typeof mapping !== 'object' || !stableSubjectKey.test(mapping.id)) {
            throw new TypeError('Operator authority domain-subject mapping is invalid.');
          }
          if ('permissionId' in mapping) {
            if (Object.keys(mapping).sort().join('\u0000')
                  !== ['id', 'permissionId'].join('\u0000')
                || !permissionIds.has(mapping.permissionId)) {
              throw new TypeError('Operator authority domain-subject mapping is invalid.');
            }
            return Object.freeze({ id: mapping.id, permissionId: mapping.permissionId });
          }
          if (Object.keys(mapping).sort().join('\u0000')
                !== ['anyOfPermissionIds', 'id'].join('\u0000')
              || !Array.isArray(mapping.anyOfPermissionIds)
              || mapping.anyOfPermissionIds.length < 2
              || mapping.anyOfPermissionIds.length > 32
              || mapping.anyOfPermissionIds.some((permissionId) => !permissionIds.has(permissionId))) {
            throw new TypeError('Operator authority domain-subject any-of mapping is invalid.');
          }
          const canonical = [...mapping.anyOfPermissionIds].sort(compareCodeUnits);
          if (new Set(canonical).size !== canonical.length) {
            throw new TypeError('Operator authority domain-subject any-of permissions must be unique.');
          }
          return Object.freeze({
            id: mapping.id,
            anyOfPermissionIds: Object.freeze(canonical) as readonly [
              PermissionId, PermissionId, ...PermissionId[]
            ]
          });
        }).sort((left: OperatorAuthorityDomainSubjectMapping, right: OperatorAuthorityDomainSubjectMapping) =>
          compareCodeUnits(left.id, right.id)
        );
        if (new Set(mappings.map((mapping: OperatorAuthorityDomainSubjectMapping) => mapping.id)).size !== mappings.length) {
          throw new TypeError('Duplicate operator authority domain-subject mapping.');
        }
        permission = Object.freeze({
          kind: 'domain_subject',
          domain: rule.domain,
          entity: rule.entity,
          mappings: Object.freeze(mappings)
        });
      } else {
        throw new TypeError('Operator authority permission rule is invalid.');
      }
    }
    return Object.freeze({
      policy: lane.policy,
      permission
    });
  }).sort((left, right) =>
    compareCodeUnits(left.policy.key, right.policy.key)
    || left.policy.version - right.policy.version
  );
  const byPolicy = new Map<string, CapturedOperatorAuthorityPolicyRegistration>();
  for (const entry of entries) {
    const key = policyKey(entry.policy);
    if (byPolicy.has(key)) throw new TypeError('Duplicate operator authority policy.');
    byPolicy.set(key, entry);
  }
  const catalog = Object.freeze({ policies: Object.freeze(entries) });
  policyCatalogEntries.set(catalog, byPolicy);
  return catalog;
}

/**
 * Fails startup when an enabled operator binding cites a policy that has no exact
 * server-owned permission mapping. The compiled registry remains the activation
 * authority; unused catalog entries do not activate an operation.
 */
export function assertOperatorAuthorityPolicyCatalogCoversOperationRegistry(input: {
  readonly catalog: OperatorAuthorityPolicyCatalog;
  readonly registry: OperationRegistry;
}): void {
  const policies = policyCatalogEntries.get(input.catalog);
  if (!policies) throw new TypeError('Unsealed operator authority policy catalog.');
  const bindings = [
    ...input.registry.operatorHttpBindings.map((binding) => ({ effect: 'read' as const, binding })),
    ...input.registry.operatorHttpEffectBindings.map((binding) => ({ effect: 'effect' as const, binding }))
  ];
  for (const entry of bindings) {
    const compiled = entry.effect === 'read'
      ? getCompiledReadOperation(
          input.registry,
          entry.binding.operationName,
          entry.binding.operationVersion,
          entry.binding.surface
        )
      : getCompiledEffectOperation(
          input.registry,
          entry.binding.operationName,
          entry.binding.operationVersion,
          entry.binding.surface
        );
    if (!compiled) throw new TypeError('Operator binding is absent from the compiled registry.');
    const lanes = compiled.operation.definition.accessLanes.filter((lane) =>
      lane.kind === 'operator' && lane.surface === 'operator_http'
    );
    if (lanes.length !== 1 || !policies.has(policyKey(lanes[0]!.policy))) {
      throw new TypeError(
        `Operator authority policy is not mapped for ${entry.binding.operationName}@${entry.binding.operationVersion}.`
      );
    }
  }
}

/**
 * Safe initial constraint for workspace-root operations. Event and subject-bearing
 * scopes require an injected relationship-aware validator.
 */
export function createEmptyOnlyOperatorScopeRelationshipValidator(): OperatorScopeRelationshipValidator {
  return Object.freeze({
    validate({ scope }: {
      readonly userId: UserId;
      readonly scope: ResolvedScope;
      readonly evaluatedAt: Instant;
    }) {
      return scope.eventId === undefined && scope.subjects.length === 0
        ? Object.freeze({ kind: 'valid' as const, evidenceIds: Object.freeze([]) })
        : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
    }
  });
}

function sameLane(left: OperationAccessLane, right: OperationAccessLane): boolean {
  return left.kind === right.kind
    && left.surface === right.surface
    && left.policy.key === right.policy.key
    && left.policy.version === right.policy.version;
}

function accessDenialReason(input: {
  readonly code: ReturnType<typeof evaluateAccess>['code'];
  readonly membershipPresent: boolean;
}): CurrentAuthorityDenialReason {
  switch (input.code) {
    case 'membership_inactive':
      return input.membershipPresent ? 'revoked' : 'missing';
    case 'scope_not_allowed':
      return 'cross_scope';
    case 'denied_directly':
    case 'permission_missing':
      return 'not_authorized';
    case 'granted_directly':
    case 'granted_by_role':
      throw new TypeError('An allowed access decision cannot become a denial.');
  }
}

interface ResolvedPermissionRequirement {
  readonly kind: 'all_of' | 'any_of';
  readonly permissionIds: readonly PermissionId[];
}

function permissionsForScope(
  registration: CapturedOperatorAuthorityPolicyRegistration,
  scope: ResolvedScope
): ResolvedPermissionRequirement | undefined {
  const rule = registration.permission;
  if (rule.kind === 'fixed') {
    return Object.freeze({ kind: 'all_of', permissionIds: Object.freeze([rule.permissionId]) });
  }
  if (rule.kind === 'all_of') {
    return Object.freeze({ kind: 'all_of', permissionIds: rule.permissionIds });
  }
  const domainSubjects = scope.subjects.filter((subject) => subject.kind === 'domain');
  if (domainSubjects.length !== 1
      || scope.subjects.some((subject) =>
        subject.kind !== 'workspace' && subject.kind !== 'event' && subject.kind !== 'domain'
      )) {
    return undefined;
  }
  const subject = domainSubjects[0]!;
  if (subject.domain !== rule.domain || subject.entity !== rule.entity) return undefined;
  const mapping = rule.mappings.find((candidate) => candidate.id === subject.id);
  if (mapping === undefined) return undefined;
  return 'permissionId' in mapping
    ? Object.freeze({ kind: 'all_of', permissionIds: Object.freeze([mapping.permissionId]) })
    : Object.freeze({ kind: 'any_of', permissionIds: mapping.anyOfPermissionIds });
}

function validateScopeResult(value: OperatorScopeRelationshipResolution): OperatorScopeRelationshipResolution {
  if (value.kind === 'denied') {
    if (!['missing', 'revoked', 'cross_scope'].includes(value.reason)) {
      throw new TypeError('Invalid operator scope denial reason.');
    }
    return Object.freeze({ kind: 'denied', reason: value.reason });
  }
  if (value.kind !== 'valid' || !Array.isArray(value.evidenceIds)) {
    throw new TypeError('Invalid operator scope relationship result.');
  }
  const evidenceIds = value.evidenceIds.map((id) => boundedOpaque(id, 'scope relationship evidence ID'));
  return Object.freeze({ kind: 'valid', evidenceIds: canonicalStrings(evidenceIds) });
}

/**
 * Builds current operator authority from database-backed session, membership, role,
 * override, and relationship evidence. Nothing is cached between calls.
 */
export function createOperatorCurrentAuthorityResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly policies: OperatorAuthorityPolicyCatalog;
  readonly sessions: CurrentOperatorSessionRepository;
  readonly memberships: MembershipRepository;
  readonly authorization: AuthorizationRepository;
  readonly scopeRelationships: OperatorScopeRelationshipValidator;
}): CurrentAuthorityResolver<InvocationEvidence> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const policies = policyCatalogEntries.get(input.policies);
  if (!policies) throw new TypeError('Unsealed operator authority policy catalog.');
  const resolveSession = input.sessions.resolveCurrent.bind(input.sessions);
  const findMembership = input.memberships.find.bind(input.memberships);
  const listRoles = input.authorization.listRoles.bind(input.authorization);
  const listAssignments = input.authorization.listAssignments.bind(input.authorization);
  const listOverrides = input.authorization.listOverrides.bind(input.authorization);
  const validateRelationships = input.scopeRelationships.validate.bind(input.scopeRelationships);

  return Object.freeze({
    async resolve(resolutionInput: CurrentAuthorityResolutionInput<InvocationEvidence>) {
      const lane = parseOperationAccessLane(resolutionInput.lane);
      if (
        lane.kind !== 'operator'
        || lane.surface !== 'operator_http'
        || resolutionInput.evidence.kind !== 'operator'
        || resolutionInput.evidence.surface !== 'operator_http'
      ) {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      if (!sameLane(lane, resolutionInput.lane)) {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const policy = policies.get(policyKey(lane.policy));
      if (!policy) {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      if (resolutionInput.scope.workspaceId !== workspaceId) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const permissionRequirement = permissionsForScope(policy, resolutionInput.scope);
      if (permissionRequirement === undefined) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }

      const evaluatedAt = parseInstant(resolutionInput.evaluatedAt);
      const sessionResolution = await resolveSession({
        sessionHandle: resolutionInput.evidence.sessionHandle,
        evaluatedAt
      });
      if (sessionResolution.kind === 'denied') {
        return Object.freeze({ kind: 'denied' as const, reason: sessionResolution.reason });
      }
      if (sessionResolution.kind !== 'current') {
        throw new TypeError('Invalid current operator session resolution.');
      }
      const session = sessionResolution.session;
      const sessionId = boundedOpaque(session.sessionId, 'operator session record ID');
      if (sessionId !== resolutionInput.evidence.sessionHandle) {
        throw new TypeError('Operator session repository returned another session.');
      }
      boundedOpaque(session.authUserId, 'authentication user ID');
      const userId = parseUserId(session.userId);
      const expiresAt = parseInstant(session.expiresAt);
      if (!Array.isArray(session.evidenceIds)) {
        throw new TypeError('Operator session repository returned invalid evidence.');
      }
      const sessionEvidenceIds = session.evidenceIds.map((id) =>
        boundedOpaque(id, 'operator session evidence ID')
      );
      if (Date.parse(expiresAt) <= Date.parse(evaluatedAt)) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }

      const relationshipResolution = validateScopeResult(await validateRelationships({
        userId,
        scope: resolutionInput.scope,
        evaluatedAt
      }));
      if (relationshipResolution.kind === 'denied') {
        return Object.freeze({ kind: 'denied' as const, reason: relationshipResolution.reason });
      }

      // Keep these reads ordered: transaction-local adapters may share one connection
      // even though their public ports permit asynchronous implementations.
      const membership = await findMembership(workspaceId, userId);
      const roles = await listRoles(workspaceId);
      const assignments = await listAssignments(workspaceId, userId);
      const overrides = await listOverrides(workspaceId, userId);
      const accessScope = resolutionInput.scope.eventId === undefined
        ? { kind: 'workspace' as const, workspaceId }
        : { kind: 'event' as const, workspaceId, eventId: resolutionInput.scope.eventId };
      const decisions: ReturnType<typeof evaluateAccess>[] = [];
      for (const permissionId of permissionRequirement.permissionIds) {
        const decision = evaluateAccess({
          userId,
          permissionId,
          requestedScope: accessScope,
          ...(membership ? { membership } : {}),
          roles,
          assignments,
          overrides,
          now: evaluatedAt
        });
        decisions.push(decision);
      }
      const grantedDecisions = decisions.filter((decision) => decision.allowed);
      const requirementSatisfied = permissionRequirement.kind === 'all_of'
        ? grantedDecisions.length === decisions.length
        : grantedDecisions.length > 0;
      if (!requirementSatisfied) {
        const denial = decisions.find((decision) => !decision.allowed);
        if (!denial) throw new TypeError('Unsatisfied permission requirement has no denial.');
        return Object.freeze({
          kind: 'denied' as const,
          reason: accessDenialReason({
            code: denial.code,
            membershipPresent: membership !== undefined
          })
        });
      }
      if (!membership || membership.version === undefined) {
        throw new TypeError('Current operator membership must carry a positive version.');
      }
      const membershipId = parseMembershipId(membership.id);
      if (!Number.isSafeInteger(membership.version) || membership.version <= 0) {
        throw new TypeError('Current operator membership must carry a positive version.');
      }

      const permissionEvidence = grantedDecisions.flatMap((decision) => decision.evidence)
        .filter((evidence) => evidence.effect === 'grant')
        .map((evidence) => evidenceRef(`access-${evidence.kind}`, evidence.id));
      const evidenceIds = canonicalStrings([
        ...sessionEvidenceIds,
        evidenceRef('membership', `${membershipId}@${membership.version}`),
        ...permissionEvidence,
        ...relationshipResolution.evidenceIds
      ]);
      const grants = canonicalGrants([
        ...permissionRequirement.permissionIds.flatMap((permissionId, index) =>
          decisions[index]?.allowed
            ? [Object.freeze({ kind: 'permission' as const, key: permissionId })]
            : []
        )
      ]);
      const authorityCitationIds = canonicalStrings([]) as CurrentResolvedAuthority['authorityCitationIds'];
      const authority: CurrentResolvedAuthority = Object.freeze({
        actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
        principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
        lane,
        scope: resolutionInput.scope,
        grants,
        evidenceIds,
        authorityCitationIds,
        evaluatedAt
      });
      return Object.freeze({ kind: 'authorized' as const, authority });
    }
  });
}
