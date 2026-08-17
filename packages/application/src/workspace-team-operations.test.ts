import { describe, expect, test } from 'bun:test';
import {
  WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
  WORKSPACE_TEAM_INVITE_OPERATION,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  createWorkspaceTeamOperationModule,
  sealWorkspaceTeamMutationPreparation,
  workspaceTeamMutationContributionSchema
} from './workspace-team-operations';
import {
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry,
  type EffectInvocationContext
} from './operations';
import {
  workspaceTeamInviteInputSchema,
  type WorkspaceTeamSnapshot
} from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';

const workspaceId = parseWorkspaceId('019c2d90-0000-7000-8000-000000000001');
const now = parseInstant('2026-08-13T05:00:00.000Z');
const profile = { key: 'workspace-team-operation-test', version: parseContractVersion(1) };
const snapshot: WorkspaceTeamSnapshot = {
  schemaVersion: 1,
  version: 1,
  digestSha256: 'a'.repeat(64),
  roles: [
    { key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
    { key: 'event_manager', name: 'Event Manager', version: 1 },
    { key: 'speaker_manager', name: 'Speaker Manager', version: 1 },
    { key: 'speaker_reviewer', name: 'Speaker Reviewer', version: 1 },
    { key: 'scheduler', name: 'Scheduler', version: 1 },
    { key: 'communications_coordinator', name: 'Communications Coordinator', version: 1 },
    { key: 'viewer', name: 'Viewer', version: 1 }
  ],
  members: []
};

function module(wrong = false, mountMutations = true) {
  let id = 1;
  const policies = {
    read: WORKSPACE_TEAM_OPERATION_ACCESS.read.policy,
    invite: WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy,
    changeRole: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy,
    remove: wrong
      ? { key: 'authority.workspace_team.wrong', version: parseContractVersion(1) }
      : WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy
  };
  return createWorkspaceTeamOperationModule({
    workspaceId,
    policies,
    currentAuthority: {
      resolve: () => ({ kind: 'denied' as const, reason: 'not_authorized' as const })
    },
    teamRead: {
      readWorkspaceTeam: () => mountMutations ? snapshot : Promise.resolve(snapshot)
    },
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `019c2d90-0000-7000-8000-${(id++).toString().padStart(12, '0')}`
      )
    },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
      keyBytes: new Uint8Array(32).fill(0x31)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x32)
    }),
    mountMutations
  });
}

describe('workspace team registered operations', () => {
  test('compiles deterministic operator-only member and direct mutation bindings', async () => {
    const first = await createOperationRegistry(module().source);
    const second = await createOperationRegistry(module().source);
    expect(first.manifestDigestSha256).toBe(second.manifestDigestSha256);
    expect(first.safeManifest.operations.map((operation) => operation.name)).toEqual([
      'workspace_team.invite',
      'workspace_team.members.read',
      'workspace_team.remove',
      'workspace_team.role_change'
    ]);
    expect(first.operatorHttpBindings).toEqual([{
      operationName: 'workspace_team.members.read', operationVersion: 1,
      surface: 'operator_http', method: 'GET', path: '/api/workspace/team', input: 'query'
    }]);
    expect(first.operatorHttpEffectBindings.map((binding) => binding.path).sort()).toEqual([
      '/api/workspace/team/invitations',
      '/api/workspace/team/removals',
      '/api/workspace/team/role-changes'
    ]);
    expect(first.appModelEffectBindings).toEqual([]);
  });

  test('binds exact access permissions and rejects policy substitution', () => {
    expect(WORKSPACE_TEAM_OPERATION_ACCESS).toMatchObject({
      read: { permissionId: 'access.users.read' },
      invite: { permissionId: 'access.users.invite' },
      changeRole: { permissionId: 'access.roles.manage' },
      remove: { permissionId: 'access.users.suspend' }
    });
    expect(() => module(true)).toThrow('workspace_team_operation_policy_catalog_mismatch');
  });

  test('can mount the asynchronous Team read without advertising uncomposed mutations', async () => {
    const readOnly = module(false, false);
    const registry = await createOperationRegistry(readOnly.source);
    expect(registry.safeManifest.operations.map((operation) => operation.name)).toEqual([
      'workspace_team.members.read'
    ]);
    expect(registry.operatorHttpEffectBindings).toEqual([]);
    expect(readOnly.source.effectHandlers).toEqual([]);
  });

  test('keeps browser input free of trusted scope, actor, and time', () => {
    const input = {
      email: 'invitee@example.test', roleKey: 'viewer', expectedTeamVersion: 1,
      expectedTeamDigestSha256: 'a'.repeat(64)
    };
    expect(workspaceTeamInviteInputSchema.safeParse(input).success).toBe(true);
    for (const field of ['workspaceId', 'actorUserId', 'evaluatedAt', 'authority']) {
      expect(workspaceTeamInviteInputSchema.safeParse({ ...input, [field]: 'forged' }).success)
        .toBe(false);
    }
  });

  test('uses a capability-bound synchronous one-shot mutation preparation', () => {
    const operationModule = module();
    const handler = operationModule.source.effectHandlers?.[0];
    if (!handler) throw new TypeError('handler missing');
    const context = Object.freeze({
      operation: WORKSPACE_TEAM_INVITE_OPERATION
    }) as EffectInvocationContext;
    const contribution = {
      result: {
        kind: 'success',
        data: {
          schemaVersion: 1, action: 'invite',
          teamVersion: 2,
          safeDiff: {
            action: 'invite', recipientHint: 'recipient-cccccccccccc',
            role: { key: 'viewer', name: 'Viewer', version: 1 },
            invitationStatus: 'recorded', delivery: 'awaiting_activation'
          }
        }
      },
      domain: {
        kind: 'workspace_team_direct_mutation',
        preparationHandle: '019c2d90-0000-7000-8000-000000000103',
        action: 'invite', workspaceId, resultingTeamVersion: 2,
        occurredAt: now
      },
      effectContributions: []
    };
    expect(workspaceTeamMutationContributionSchema.safeParse(contribution).success).toBe(true);
    const sealed = sealWorkspaceTeamMutationPreparation({
      capability: WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
      context,
      preparation: { prepare: () => contribution }
    });
    expect(handler.handle({ businessInput: {}, context, snapshot: sealed })).toEqual(contribution);
    expect(() => handler.handle({ businessInput: {}, context, snapshot: sealed }))
      .toThrow('workspace_team_mutation_preparation_invalid');
    expect(JSON.stringify(contribution)).not.toContain('invitee@example.test');
  });
});
