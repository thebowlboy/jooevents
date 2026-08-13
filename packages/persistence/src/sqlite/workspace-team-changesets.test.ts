import { describe, expect, test } from 'bun:test';
import {
  planChangesetOperation,
  type ChangesetPlanningSnapshot,
  type ChangesetReadPortKey,
  type ChangesetTransactionPortKey,
  type ChangesetValidationPortKey
} from '@jooevents/changesets';
import type { WorkspaceTeamPlanningSnapshot } from '@jooevents/identity-access';
import { parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  WORKSPACE_TEAM_CHANGESET_KIND,
  WORKSPACE_TEAM_CHANGESET_VERSION,
  createWorkspaceTeamChangesetBundle,
  createWorkspaceTeamChangesetPolicy,
  workspaceTeamChangesetAuthorInputSchema,
  workspaceTeamReadPort,
  workspaceTeamTransactionPort,
  workspaceTeamValidationPort,
  type WorkspaceTeamReadPort,
  type WorkspaceTeamTransactionPort
} from './workspace-team-changesets';

const workspaceId = parseWorkspaceId('019c2d80-0000-7000-8000-000000000001');
const actor = parseUserId('019c2d80-0000-7000-8000-000000000002');
const now = parseInstant('2026-08-13T04:00:00.000Z');
const digest = 'a'.repeat(64);

function state(version = 3, stateDigest = digest): WorkspaceTeamPlanningSnapshot {
  return {
    workspaceId,
    version,
    digestSha256: stateDigest,
    roles: new Map([
      ['workspace_admin', { id: '019c2d80-0000-7000-8000-000000000101', version: 1 }],
      ['event_manager', { id: '019c2d80-0000-7000-8000-000000000102', version: 1 }],
      ['speaker_manager', { id: '019c2d80-0000-7000-8000-000000000103', version: 1 }],
      ['speaker_reviewer', { id: '019c2d80-0000-7000-8000-000000000104', version: 1 }],
      ['scheduler', { id: '019c2d80-0000-7000-8000-000000000105', version: 1 }],
      ['communications_coordinator', { id: '019c2d80-0000-7000-8000-000000000106', version: 1 }],
      ['viewer', { id: '019c2d80-0000-7000-8000-000000000107', version: 1 }]
    ]),
    members: [],
    invitations: []
  };
}

const author = {
  action: 'invite' as const,
  workspaceId,
  expectedTeamVersion: 3,
  expectedTeamDigestSha256: digest,
  roleKey: 'viewer' as const,
  recipient: {
    payloadRefId: '019c2d80-0000-7000-8000-000000000201',
    lookupBinding: 'b'.repeat(64),
    hint: 'recipient-bbbbbbbbbbbb'
  },
  ids: {
    reservationId: '019c2d80-0000-7000-8000-000000000202',
    reservationRoleAssignmentId: '019c2d80-0000-7000-8000-000000000203',
    releaseIntentId: '019c2d80-0000-7000-8000-000000000204',
    historyId: '019c2d80-0000-7000-8000-000000000205'
  },
  actorUserId: actor,
  evaluatedAt: now
};

function bundle() {
  return createWorkspaceTeamChangesetBundle({
    policy: createWorkspaceTeamChangesetPolicy({
      key: 'workspace_team.trial', version: 1, approval: 'distinct_current_human'
    })
  });
}

function planningSnapshot(current: WorkspaceTeamPlanningSnapshot): ChangesetPlanningSnapshot {
  const port: WorkspaceTeamReadPort = { readWorkspaceTeam: () => current };
  return {
    getPort<Port>(key: ChangesetReadPortKey<Port>): Port {
      if ((key as unknown) !== workspaceTeamReadPort) throw new TypeError('unexpected port');
      return port as unknown as Port;
    }
  };
}

describe('workspace team changeset definition', () => {
  test('plans a consequential typed diff without recipient content', async () => {
    const packet = bundle();
    const operation = await planChangesetOperation({
      registry: packet.registry,
      kind: WORKSPACE_TEAM_CHANGESET_KIND,
      version: WORKSPACE_TEAM_CHANGESET_VERSION,
      authorInput: author,
      dependencyGroup: 'workspace_team',
      snapshot: planningSnapshot(state())
    });
    expect(operation).toMatchObject({
      riskTier: 'normal',
      aggregateRefs: [{ id: `workspace_team:${workspaceId}`, version: 3 }],
      guardRefs: [{ id: `workspace_team_guard:${workspaceId}`, version: 3, digest }],
      safeDiff: {
        action: 'invite', recipientHint: 'recipient-bbbbbbbbbbbb',
        invitationStatus: 'recorded', delivery: 'awaiting_activation'
      }
    });
    expect(JSON.stringify(operation)).not.toContain('invitee@example.test');
    expect(workspaceTeamChangesetAuthorInputSchema.safeParse({
      ...author, recipient: { ...author.recipient, email: 'invitee@example.test' }
    }).success).toBe(false);
    expect(workspaceTeamChangesetAuthorInputSchema.safeParse({
      action: 'remove',
      workspaceId,
      expectedTeamVersion: 3,
      expectedTeamDigestSha256: digest,
      subject: {
        kind: 'member',
        membershipId: '019c2d80-0000-7000-8000-000000000301',
        version: 1
      },
      actorUserId: actor,
      evaluatedAt: now,
      historyId: '019c2d80-0000-7000-8000-000000000302'
    }).success).toBe(false);
  });

  test('rejects a second mutation against the stale team guard', async () => {
    const packet = bundle();
    const operation = await planChangesetOperation({
      registry: packet.registry,
      kind: WORKSPACE_TEAM_CHANGESET_KIND,
      version: 1,
      authorInput: author,
      dependencyGroup: 'workspace_team',
      snapshot: planningSnapshot(state())
    });
    const definition = packet.registry.get(WORKSPACE_TEAM_CHANGESET_KIND, 1);
    if (!definition) throw new TypeError('definition missing');
    const stalePort: WorkspaceTeamReadPort = {
      readWorkspaceTeam: () => state(4, 'c'.repeat(64))
    };
    const result = await definition.validateWithin(operation.plan, {
      getPort<Port>(key: ChangesetValidationPortKey<Port>): Port {
        if ((key as unknown) !== workspaceTeamValidationPort) throw new TypeError('unexpected port');
        return stalePort as unknown as Port;
      }
    });
    expect(result).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision',
        kind: 'workspace_team.change_refused',
        detail: { code: 'stale_team', action: 'invite' }
      }
    });
  });

  test('applies only through its declared transaction port and exposes honest compensation', async () => {
    const packet = bundle();
    const operation = await planChangesetOperation({
      registry: packet.registry,
      kind: WORKSPACE_TEAM_CHANGESET_KIND,
      version: 1,
      authorInput: author,
      dependencyGroup: 'workspace_team',
      snapshot: planningSnapshot(state())
    });
    const definition = packet.registry.get(WORKSPACE_TEAM_CHANGESET_KIND, 1);
    if (!definition) throw new TypeError('definition missing');
    let applied = false;
    const port: WorkspaceTeamTransactionPort = {
      readWorkspaceTeam: () => state(),
      applyWorkspaceTeamPlan() { applied = true; }
    };
    const contribution = await definition.applyWithin(operation.plan, {
      getPort<Port>(key: ChangesetTransactionPortKey<Port>): Port {
        if ((key as unknown) !== workspaceTeamTransactionPort) throw new TypeError('unexpected port');
        return port as unknown as Port;
      }
    });
    expect(applied).toBe(true);
    expect(contribution).toMatchObject({
      result: { action: 'invite', teamVersion: 4 },
      facts: [{ kind: 'workspace_team_changed', version: 1 }],
      effects: []
    });
    expect(await definition.deriveCompensation(operation.plan, planningSnapshot(state(4))))
      .toEqual({ kind: 'blocked', reasonKey: 'workspace_team.fresh_authority_required' });
  });
});
