import { expect, test } from 'bun:test';
import {
  createExternalAgentAuthorityResolver,
  createOperatorAuthorityPolicyCatalog
} from './index';
import type {
  ApiKeyRecord,
  ApiKeyStore,
  AuthorizationRepository,
  MembershipRepository,
  Role,
  WorkspaceMembership
} from '@jooevents/identity-access';
import {
  parseApiKeyId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';

const ids = {
  workspace: parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7100'),
  owner: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7200'),
  membership: parseMembershipId('018f0f47-7a86-7d36-8a25-9f86589c7210'),
  event: parseEventId('018f0f47-7a86-7d36-8a25-9f86589c7300'),
  otherEvent: parseEventId('018f0f47-7a86-7d36-8a25-9f86589c7301'),
  key: parseApiKeyId('018f0f47-7a86-7d36-8a25-9f86589c7400')
};
const now = parseInstant('2026-08-17T01:00:00.000Z');
const lane = Object.freeze({
  kind: 'external_mcp' as const,
  surface: 'external_mcp' as const,
  policy: Object.freeze({ key: 'event.read', version: parseContractVersion(1) })
});
const evidence = Object.freeze({
  kind: 'external_mcp' as const,
  surface: 'external_mcp' as const,
  client: Object.freeze({ key: 'api.v1' }),
  credentialHandle: ids.key,
  clientKey: `api-key:${ids.key}`
});

function fixture(input: {
  readonly permissionIds?: ApiKeyRecord['permissionIds'];
  readonly eventIds?: ApiKeyRecord['eventIds'];
  readonly membershipStatus?: WorkspaceMembership['status'];
  readonly rolePermissionIds?: Role['permissionIds'];
} = {}) {
  const key: ApiKeyRecord = Object.freeze({
    apiKeyId: ids.key,
    workspaceId: ids.workspace,
    ownerUserId: ids.owner,
    displayName: 'Assistant',
    tokenHashSha256: 'a'.repeat(64),
    tokenHint: 'jooak1_AAAA',
    mayRead: true,
    maySubmitPlans: true,
    permissionIds: input.permissionIds ?? (['event.read'] as const),
    eventIds: input.eventIds ?? [ids.event],
    createdAt: '2026-08-17T00:00:00.000Z',
    expiresAt: '2026-11-15T00:00:00.000Z',
    lastUsedAt: null,
    standing: 'active',
    revokedAt: null,
    revokedByUserId: null,
    revokeReason: null,
    rotationSuccessorId: null,
    version: 1
  });
  const membership: WorkspaceMembership = Object.freeze({
    id: ids.membership,
    workspaceId: ids.workspace,
    userId: ids.owner,
    status: input.membershipStatus ?? 'active',
    createdAt: now,
    updatedAt: now,
    version: 1
  });
  const role: Role = Object.freeze({
    id: 'role-event-reader',
    workspaceId: ids.workspace,
    name: 'Reader',
    description: 'Reads event data.',
    permissionIds: input.rolePermissionIds ?? (['event.read'] as const)
  });
  const keys = {
    get: () => key,
    resolveByTokenHash: () => ({ kind: 'current' as const, key }),
    recordUse() {}, list: () => [key], create() { throw new Error(); },
    rotate() { throw new Error(); }, revoke() { throw new Error(); }
  } satisfies ApiKeyStore;
  const memberships = { find: async () => membership } satisfies MembershipRepository;
  const authorization = {
    listRoles: async () => [role],
    listAssignments: async () => [Object.freeze({
      id: 'assignment-reader',
      userId: ids.owner,
      roleId: role.id,
      scope: Object.freeze({ kind: 'workspace' as const, workspaceId: ids.workspace }),
      assignedAt: now
    })],
    listOverrides: async () => []
  } satisfies AuthorizationRepository;
  return createExternalAgentAuthorityResolver({
    workspaceId: ids.workspace,
    policies: createOperatorAuthorityPolicyCatalog([{ policy: lane.policy, permissionId: 'event.read' }]),
    apiKeys: keys,
    memberships,
    authorization,
    scopeRelationships: Object.freeze({
      validate: () => Object.freeze({ kind: 'valid' as const, evidenceIds: Object.freeze(['event:current']) })
    })
  });
}

function resolution(eventId = ids.event) {
  return {
    operation: { name: 'event.read', version: 1, effect: 'read' as const },
    evidence,
    lane,
    scope: Object.freeze({
      workspaceId: ids.workspace,
      eventId,
      subjects: Object.freeze([{ kind: 'event' as const, id: eventId }]),
      resolutionEvidenceIds: Object.freeze([])
    }),
    evaluatedAt: now
  };
}

test('emits token-scope authority only when both the key and current owner grant allow', async () => {
  const allowed = await fixture().resolve(resolution());
  expect(allowed).toMatchObject({
    kind: 'authorized',
    authority: {
      actor: { kind: 'external_mcp_client', clientKey: `api-key:${ids.key}` },
      principal: { kind: 'workspace_user', userId: ids.owner },
      grants: [{ kind: 'token_scope', key: 'event.read' }]
    }
  });
  expect(await fixture({ permissionIds: ['submission.read'] }).resolve(resolution()))
    .toEqual({ kind: 'denied', reason: 'not_authorized' });
  expect(await fixture({ rolePermissionIds: ['submission.read'] }).resolve(resolution()))
    .toEqual({ kind: 'denied', reason: 'not_authorized' });
});

test('owner suspension and event narrowing take effect on the next invocation', async () => {
  expect(await fixture({ membershipStatus: 'suspended' }).resolve(resolution()))
    .toEqual({ kind: 'denied', reason: 'revoked' });
  expect(await fixture().resolve(resolution(ids.otherEvent)))
    .toEqual({ kind: 'denied', reason: 'cross_scope' });
});
