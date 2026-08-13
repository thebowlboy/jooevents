import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
  WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE,
  WORKSPACE_TEAM_INVITE_DRAFT_OPERATION,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  WORKSPACE_TEAM_REMOVAL_DRAFT_OPERATION,
  WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  createWorkspaceTeamOperationModule,
  type InvocationEvidence,
  type OperationExecutionError
} from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  workspaceTeamDraftOperationResultSchema
} from '@jooevents/contracts/workspace-team';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  COMMIT_CHANGESET_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  changesetDiffOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import { openSQLite } from './database';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import {
  SQLiteClassifiedPayloadStore,
  installSQLiteClassifiedPayloadStoreSchema
} from './sqlite-classified-payload-store';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import {
  SQLiteWorkspaceTeamRepository,
  ensureWorkspaceTeamRoles,
  installWorkspaceTeamSchema
} from './workspace-team';
import {
  SQLiteWorkspaceTeamChangesetEffectDomainAdapter,
  installWorkspaceTeamChangesetEffectSchema,
  type SQLiteWorkspaceTeamChangesetEffectIds
} from './workspace-team-changeset-effect-domain';
import { createWorkspaceTeamChangesetPolicy } from './workspace-team-changesets';
import {
  SQLiteWorkspaceTeamDraftEffectDomainAdapter,
  installWorkspaceTeamDraftEffectSchema,
  type SQLiteWorkspaceTeamDraftEffectIds
} from './workspace-team-draft-effect-domain';

const workspaceId = parseWorkspaceId('019c2da1-0000-7000-8000-000000000001');
const ownerUserId = parseUserId('019c2da1-0000-7000-8000-000000000002');
const ownerMembershipId = parseMembershipId('019c2da1-0000-7000-8000-000000000003');
const memberUserId = parseUserId('019c2da1-0000-7000-8000-000000000004');
const memberMembershipId = parseMembershipId('019c2da1-0000-7000-8000-000000000005');
const now = parseInstant('2026-08-13T07:00:00.000Z');
const profile = { key: 'workspace-team-joined-test', version: parseContractVersion(1) };
const evidence: InvocationEvidence = {
  kind: 'operator', surface: 'operator_http',
  client: { key: 'web.operator' }, sessionHandle: 'verified-session'
};

function uuid(suffix: number): string {
  return `019c2da1-0000-7000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function mismatchLifecycleChild(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (!base.afterReceiptParentInserted || !base.afterReceiptChildInserted
      || !base.afterExecutionClaimReleased || !base.afterUnitOfWorkFinished) {
    throw new TypeError('workspace_team_lifecycle_test_hooks_missing');
  }
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base),
    afterReceiptChildInserted(receiptId, contribution) {
      if ((contribution as { readonly kind?: unknown }).kind !== 'domain_fact') {
        base.afterReceiptChildInserted!(receiptId, contribution);
        return;
      }
      const replaced = structuredClone(contribution) as Record<string, unknown>;
      replaced.workspaceId = uuid(0xff01);
      base.afterReceiptChildInserted!(receiptId, replaced);
    },
    afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base),
    afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base)
  };
}

function openFixture(options: {
  readonly mismatchLifecycle?: boolean;
  readonly grants?: readonly string[];
} = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installWorkspaceTeamSchema(sqlite);
  installWorkspaceTeamDraftEffectSchema(sqlite);
  installWorkspaceTeamChangesetEffectSchema(sqlite);
  let nonce = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: { key: 'encryption.workspace-team-joined-test', version: 1 },
      keyBytes: new Uint8Array(32).fill(0x55)
    }),
    nonceSource: (length) => {
      const value = new Uint8Array(length).fill(nonce);
      nonce += 1;
      return value;
    }
  });
  const repository = new SQLiteWorkspaceTeamRepository(sqlite, classifiedStore);
  const at = Date.parse(now);
  sqlite.transaction(() => {
    sqlite.query(`INSERT INTO workspaces
      (id, name, state, created_at, updated_at, version)
      VALUES (?, 'Main', 'active', ?, ?, 1)`).run(workspaceId, at, at);
    for (const [userId, name, email, membershipId] of [
      [ownerUserId, 'Owner', 'owner@example.test', ownerMembershipId],
      [memberUserId, 'Member', 'member@example.test', memberMembershipId]
    ] as const) {
      sqlite.query(`INSERT INTO users
        (id, status, display_name, created_at, updated_at, version)
        VALUES (?, 'active', ?, ?, ?, 1)`).run(userId, name, at, at);
      sqlite.query(`INSERT INTO user_emails
        (id, user_id, normalized_email, display_email, verified, source,
         is_primary, verified_at, created_at)
        VALUES (?, ?, ?, ?, 1, 'auth_provider', 1, ?, ?)`)
        .run(uuid(userId === ownerUserId ? 0x10 : 0x11), userId, email, email, at, at);
      sqlite.query(`INSERT INTO workspace_memberships
        (id, workspace_id, user_id, status, created_at, updated_at, version)
        VALUES (?, ?, ?, 'active', ?, ?, 1)`)
        .run(membershipId, workspaceId, userId, at, at);
    }
    ensureWorkspaceTeamRoles({
      sqlite, workspaceId, now,
      newRoleId: (key) => ({
        workspace_admin: uuid(0x21), event_manager: uuid(0x22),
        speaker_manager: uuid(0x23), speaker_reviewer: uuid(0x24),
        scheduler: uuid(0x25), communications_coordinator: uuid(0x26),
        viewer: uuid(0x27)
      })[key]
    });
    for (const [assignmentId, userId, roleKey] of [
      [uuid(0x30), ownerUserId, 'workspace_admin'],
      [uuid(0x31), memberUserId, 'viewer']
    ] as const) {
      sqlite.query(`INSERT INTO role_assignments
        (id, user_id, role_id, workspace_id, scope_kind, event_id,
         assigned_by_user_id, assigned_at, version)
        SELECT ?, ?, id, ?, 'workspace', NULL, ?, ?, 1 FROM roles
         WHERE workspace_id = ? AND source_preset_key = ?`)
        .run(assignmentId, userId, workspaceId, ownerUserId, at, workspaceId, roleKey);
    }
    repository.initialize(workspaceId);
  }).immediate();

  const policy = createWorkspaceTeamChangesetPolicy({
    key: 'workspace_team.joined_test', version: 1, approval: 'none'
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteWorkspaceTeamDraftEffectIds = {
    newChangesetId: next, newRevisionId: next, newPreparationHandle: next,
    newTimelineId: next, newReservationId: next,
    newReservationRoleAssignmentId: next, newReleaseIntentId: next,
    newHistoryId: next, newPayloadRefId: next, newSessionRevocationIntentId: next
  };
  const lifecycleIds: SQLiteWorkspaceTeamChangesetEffectIds = {
    newChangesetId: next, newRevisionId: next, newApprovalId: next,
    newCorrectionAttemptId: next, newPreparationHandle: next,
    newTimelineId: next, newFactId: next, newPointerId: next
  };
  const draftAdapter = new SQLiteWorkspaceTeamDraftEffectDomainAdapter({
    sqlite, workspaceId, policy, classifiedStore,
    invitationLookupKeyBytes: new Uint8Array(32).fill(0x68), ids: draftIds
  });
  const lifecycleAdapter = new SQLiteWorkspaceTeamChangesetEffectDomainAdapter({
    sqlite, workspaceId, policy, classifiedStore, ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([{
    capability: WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
    adapter: draftAdapter
  }, {
    capability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    adapter: options.mismatchLifecycle
      ? mismatchLifecycleChild(lifecycleAdapter)
      : lifecycleAdapter
  }]);
  let currentGrants = [...(options.grants ?? [
    'access.users.invite', 'access.roles.manage', 'access.users.suspend'
  ])];
  let currentTime: Instant = now;
  const authority: Parameters<typeof createChangesetOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId: ownerUserId },
          principal: {
            kind: 'workspace_user', userId: ownerUserId,
            membershipId: ownerMembershipId
          },
          lane: input.lane, scope: input.scope,
          grants: currentGrants.map((key) => ({ kind: 'permission' as const, key })),
          evidenceIds: ['membership.current'], authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const common = {
    workspaceId,
    currentAuthority: authority,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw: string) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`workspace-team:${raw}`).digest('hex')
        };
      }
    }
  };
  const draftModule = createWorkspaceTeamOperationModule({
    ...common,
    policies: {
      read: WORKSPACE_TEAM_OPERATION_ACCESS.read.policy,
      invite: WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy,
      changeRole: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy,
      remove: WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy
    },
    teamRead: { readWorkspaceTeam: () => repository.readProjection(workspaceId) },
    requestHashSealer: createHmacRequestHashSealer({
      profile: WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x42)
    })
  });
  const lifecycleModule = createChangesetOperationModule({
    ...common,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    lifecycleStore: lifecycleAdapter.lifecycleStore,
    ownerResolution: lifecycleAdapter,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x43)
    })
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve, now: () => currentTime
  });
  let receipt = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([draftModule, lifecycleModule]),
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => currentTime }, newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receipt++)
  });
  let correlation = 0x900;
  return {
    sqlite, repository, lifecycle: lifecycleAdapter.lifecycleStore,
    close: () => sqlite.close(false),
    setGrants(grants: readonly string[]) { currentGrants = [...grants]; },
    advance(milliseconds: number) {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + milliseconds).toISOString());
    },
    async effect(
      operation: { readonly name: string; readonly version: number },
      businessInput: unknown,
      key: string
    ) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: operation.name, operationVersion: operation.version,
        surface: 'operator_http', correlationId: uuid(correlation++),
        businessInput, verifiedEvidence: evidence, rawIdempotencyKey: key
      });
      return composed.effectExecutor.execute(invocation);
    },
    async read(
      operation: { readonly name: string; readonly version: number },
      businessInput: unknown
    ) {
      const composed = await runtime;
      return composed.readExecutor.execute({
        operationName: operation.name,
        operationVersion: operation.version,
        surface: 'operator_http',
        correlationId: uuid(correlation++),
        businessInput,
        verifiedEvidence: evidence
      });
    }
  };
}

async function draftAndPropose(
  fixture: ReturnType<typeof openFixture>,
  operation: { readonly name: string; readonly version: number },
  businessInput: unknown,
  key: string
) {
  const draft = workspaceTeamDraftOperationResultSchema.parse(
    await fixture.effect(operation, businessInput, `${key}-draft`)
  );
  if (draft.kind !== 'success') throw new TypeError('workspace_team_test_draft_failed');
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(
    await fixture.effect(
      PROPOSE_CHANGESET_OPERATION,
      { ...selector, expectedHeadVersion: 1 },
      `${key}-propose`
    )
  );
  if (proposed.kind !== 'success' || proposed.data.action !== 'propose') {
    throw new TypeError('workspace_team_test_propose_failed');
  }
  return { draft, selector, proposed };
}

describe('joined SQLite workspace team changeset lifecycle', () => {
  test('records, proposes, commits, and exactly replays an opaque invitation', async () => {
    const fixture = openFixture();
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      const prepared = await draftAndPropose(
        fixture,
        WORKSPACE_TEAM_INVITE_DRAFT_OPERATION,
        {
          email: 'invitee@example.test', roleKey: 'viewer',
          expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'invite'
      );
      const commitInput = { ...prepared.selector, expectedHeadVersion: 2 };
      const committed = changesetLifecycleOperationResultSchema.parse(
        await fixture.effect(COMMIT_CHANGESET_OPERATION, commitInput, 'invite-commit')
      );
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', expectedHeadVersion: 2, committedHeadVersion: 3 }
      });
      if (committed.kind !== 'success') throw new TypeError('workspace_team_test_commit_failed');
      const receiptCount = count(fixture.sqlite, 'foundation_trial_operation_receipts');
      expect(await fixture.effect(COMMIT_CHANGESET_OPERATION, commitInput, 'invite-commit'))
        .toMatchObject({ kind: 'success', receipt: { id: committed.receipt.id } });
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(receiptCount);
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...commitInput, expectedHeadVersion: 3 },
        'invite-commit'
      )).toMatchObject({
        kind: 'outcome', outcome: {
          class: 'idempotency_conflict', kind: 'operation.request_changed'
        }
      });
      expect(fixture.lifecycle.read(prepared.selector.changesetId)).toMatchObject({
        head: { workspaceId, status: 'committed', version: 3 }
      });
      const projection = fixture.repository.readProjection(workspaceId);
      expect(projection.version).toBe(2);
      expect(projection.members.find((member) => member.kind === 'invitation'))
        .toMatchObject({
          kind: 'invitation', email: 'invitee@example.test', status: 'invited',
          delivery: 'awaiting_activation'
        });
      expect(count(fixture.sqlite, 'workspace_team_changeset_domain_facts')).toBe(1);
      expect(count(fixture.sqlite, 'workspace_team_changeset_outbox_pointers')).toBe(1);
      expect(count(fixture.sqlite, 'workspace_team_changeset_timeline')).toBe(2);
      expect(Buffer.from(fixture.sqlite.serialize()).includes(Buffer.from('invitee@example.test')))
        .toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('commits one role change and refuses a parallel stale removal', async () => {
    const fixture = openFixture();
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      const role = await draftAndPropose(
        fixture,
        WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          roleKey: 'speaker_manager', expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'role'
      );
      const removal = await draftAndPropose(
        fixture,
        WORKSPACE_TEAM_REMOVAL_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'remove'
      );
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...role.selector, expectedHeadVersion: 2 },
        'role-commit'
      )).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      const before = count(fixture.sqlite, 'foundation_trial_operation_receipts');
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...removal.selector, expectedHeadVersion: 2 },
        'remove-commit'
      )).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: { class: 'stale_revision', detail: { code: 'base_version_changed' } }
      });
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(before);
      const projection = fixture.repository.readProjection(workspaceId);
      expect(projection.version).toBe(2);
      expect(projection.members.find((member) => member.id === memberMembershipId))
        .toMatchObject({
          id: memberMembershipId, status: 'active', role: { key: 'speaker_manager' }
        });
      expect(count(fixture.sqlite, 'workspace_team_session_revocation_intents')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('commits member removal and records the inactive session-revocation seam', async () => {
    const fixture = openFixture();
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      const removal = await draftAndPropose(
        fixture,
        WORKSPACE_TEAM_REMOVAL_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'successful-remove'
      );
      expect(await fixture.effect(
        COMMIT_CHANGESET_OPERATION,
        { ...removal.selector, expectedHeadVersion: 2 },
        'successful-remove-commit'
      )).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      expect(fixture.repository.readProjection(workspaceId).members.some(
        (member) => member.id === memberMembershipId
      )).toBe(false);
      expect(fixture.sqlite.query<{ status: string }, [string]>(`
        SELECT status FROM workspace_memberships WHERE id = ?
      `).get(memberMembershipId)?.status).toBe('deactivated');
      expect(fixture.sqlite.query<{ status: string }, [string]>(`
        SELECT status FROM workspace_team_session_revocation_intents WHERE membership_id = ?
      `).get(memberMembershipId)?.status).toBe('awaiting_activation');
      expect(count(fixture.sqlite, 'workspace_team_history')).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('rolls back effective access and all commit evidence on a late child mismatch', async () => {
    const fixture = openFixture({ mismatchLifecycle: true });
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      const prepared = await draftAndPropose(
        fixture,
        WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          roleKey: 'speaker_manager', expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'rollback-role'
      );
      try {
        await fixture.effect(
          COMMIT_CHANGESET_OPERATION,
          { ...prepared.selector, expectedHeadVersion: 2 },
          'rollback-role-commit'
        );
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toMatchObject({
          name: 'OperationExecutionError', phase: 'receipt_children'
        } satisfies Partial<OperationExecutionError>);
      }
      const projection = fixture.repository.readProjection(workspaceId);
      expect(projection.version).toBe(1);
      expect(projection.members.find((member) => member.id === memberMembershipId))
        .toMatchObject({ id: memberMembershipId, role: { key: 'viewer' } });
      expect(fixture.lifecycle.read(prepared.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
      expect(count(fixture.sqlite, 'workspace_team_history')).toBe(0);
      expect(count(fixture.sqlite, 'workspace_team_changeset_domain_facts')).toBe(0);
      expect(count(fixture.sqlite, 'workspace_team_changeset_outbox_pointers')).toBe(0);
      expect(count(fixture.sqlite, 'workspace_team_changeset_effect_receipt_links')).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('rejects lifecycle use when current authority loses the exact mutation permission', async () => {
    const fixture = openFixture();
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      const draft = workspaceTeamDraftOperationResultSchema.parse(await fixture.effect(
        WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          roleKey: 'speaker_manager', expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'permission-role-draft'
      ));
      if (draft.kind !== 'success') throw new TypeError('workspace_team_test_draft_failed');
      fixture.setGrants(['access.users.invite']);
      await expect(fixture.effect(
        PROPOSE_CHANGESET_OPERATION,
        {
          changesetId: draft.data.changesetId,
          revisionId: draft.data.revision.id,
          revisionDigest: draft.data.revision.digestSha256,
          expectedHeadVersion: 1
        },
        'permission-role-propose'
      )).rejects.toMatchObject({ name: 'OperationExecutionError' });
      expect(fixture.lifecycle.read(draft.data.changesetId)).toMatchObject({
        head: { status: 'draft', version: 1 }
      });
      expect(count(fixture.sqlite, 'workspace_team_changeset_effect_receipt_links')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('rejects a direct draft when current authority lacks its mutation permission', async () => {
    const fixture = openFixture({ grants: ['access.users.invite'] });
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      await expect(fixture.effect(
        WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          roleKey: 'speaker_manager', expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'denied-role-draft'
      )).rejects.toMatchObject({ name: 'OperationExecutionError' });
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('requires the exact frozen team-plan permission before projecting a generic diff', async () => {
    const fixture = openFixture();
    try {
      const head = fixture.repository.readPlanningSnapshot(workspaceId);
      const draft = workspaceTeamDraftOperationResultSchema.parse(await fixture.effect(
        WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
        {
          subject: { kind: 'member', membershipId: memberMembershipId, version: 1 },
          roleKey: 'speaker_manager', expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        },
        'read-authority-role-draft'
      ));
      if (draft.kind !== 'success') throw new TypeError('workspace_team_test_draft_failed');
      const input = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };

      fixture.setGrants(['access.users.invite']);
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        { name: 'changeset.diff.read', version: 1 }, input
      ))).toMatchObject({
        kind: 'outcome', outcome: {
          class: 'conflict', kind: 'changeset.lifecycle_refused', detail: { code: 'scope_changed' }
        }
      });

      fixture.setGrants(['access.roles.manage']);
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        { name: 'changeset.diff.read', version: 1 }, input
      ))).toMatchObject({
        kind: 'success', data: {
          changesetId: draft.data.changesetId,
          operations: [{ safeDiff: { action: 'change_role' } }]
        }
      });
    } finally {
      fixture.close();
    }
  });
});
