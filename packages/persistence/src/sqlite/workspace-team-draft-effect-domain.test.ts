import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE,
  WORKSPACE_TEAM_INVITE_DRAFT_OPERATION,
  WORKSPACE_TEAM_OPERATION_ACCESS,
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
} from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { openSQLite } from './database';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  installSQLiteChangesetLifecycleSchema
} from './changeset-lifecycle';
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
  createWorkspaceTeamChangesetPolicy
} from './workspace-team-changesets';
import {
  SQLiteWorkspaceTeamDraftEffectDomainAdapter,
  installWorkspaceTeamDraftEffectSchema,
  type SQLiteWorkspaceTeamDraftEffectIds
} from './workspace-team-draft-effect-domain';

const workspaceId = parseWorkspaceId('019c2da0-0000-7000-8000-000000000001');
const userId = parseUserId('019c2da0-0000-7000-8000-000000000002');
const membershipId = parseMembershipId('019c2da0-0000-7000-8000-000000000003');
const now = parseInstant('2026-08-13T06:00:00.000Z');
const profile = { key: 'workspace-team-draft-test', version: parseContractVersion(1) };
const evidence: InvocationEvidence = {
  kind: 'operator', surface: 'operator_http',
  client: { key: 'web.operator' }, sessionHandle: 'verified-session'
};

function uuid(suffix: number): string {
  return `019c2da0-0000-7000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function mismatchChildAdapter(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (!base.afterReceiptParentInserted || !base.afterReceiptChildInserted
      || !base.afterExecutionClaimReleased || !base.afterUnitOfWorkFinished) {
    throw new TypeError('workspace_team_test_hooks_missing');
  }
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base),
    afterReceiptChildInserted(receiptId, contribution) {
      const replaced = structuredClone(contribution) as Record<string, unknown>;
      replaced.timelineId = uuid(0xff01);
      base.afterReceiptChildInserted!(receiptId, replaced);
    },
    afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base),
    afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base)
  };
}

function fixture(options: { denied?: boolean; mismatchChild?: boolean } = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installWorkspaceTeamSchema(sqlite);
  installWorkspaceTeamDraftEffectSchema(sqlite);
  let nonce = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: { key: 'encryption.workspace-team-draft-test', version: 1 },
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
    sqlite.query(`INSERT INTO users
      (id, status, display_name, created_at, updated_at, version)
      VALUES (?, 'active', 'Owner', ?, ?, 1)`).run(userId, at, at);
    sqlite.query(`INSERT INTO user_emails
      (id, user_id, normalized_email, display_email, verified, source,
       is_primary, verified_at, created_at)
      VALUES (?, ?, 'owner@example.test', 'owner@example.test', 1,
       'auth_provider', 1, ?, ?)`).run(uuid(0x10), userId, at, at);
    sqlite.query(`INSERT INTO workspace_memberships
      (id, workspace_id, user_id, status, created_at, updated_at, version)
      VALUES (?, ?, ?, 'active', ?, ?, 1)`)
      .run(membershipId, workspaceId, userId, at, at);
    ensureWorkspaceTeamRoles({
      sqlite, workspaceId, now,
      newRoleId: (key) => ({
        workspace_admin: uuid(0x21), event_manager: uuid(0x22),
        speaker_manager: uuid(0x23), speaker_reviewer: uuid(0x24),
        scheduler: uuid(0x25), communications_coordinator: uuid(0x26),
        viewer: uuid(0x27)
      })[key]
    });
    sqlite.query(`INSERT INTO role_assignments
      (id, user_id, role_id, workspace_id, scope_kind, event_id,
       assigned_by_user_id, assigned_at, version)
      SELECT ?, ?, id, ?, 'workspace', NULL, ?, ?, 1 FROM roles
       WHERE workspace_id = ? AND source_preset_key = 'workspace_admin'`)
      .run(uuid(0x30), userId, workspaceId, userId, at, workspaceId);
    repository.initialize(workspaceId);
  }).immediate();
  const policy = createWorkspaceTeamChangesetPolicy({
    key: 'workspace_team.trial', version: 1, approval: 'distinct_current_human'
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const ids: SQLiteWorkspaceTeamDraftEffectIds = {
    newChangesetId: next, newRevisionId: next, newPreparationHandle: next,
    newTimelineId: next, newReservationId: next,
    newReservationRoleAssignmentId: next, newReleaseIntentId: next,
    newHistoryId: next, newPayloadRefId: next, newSessionRevocationIntentId: next
  };
  const adapter = new SQLiteWorkspaceTeamDraftEffectDomainAdapter({
    sqlite, workspaceId, policy, classifiedStore,
    invitationLookupKeyBytes: new Uint8Array(32).fill(0x68), ids
  });
  const registry = createSQLiteEffectDomainAdapterRegistry([{
    capability: { key: 'capability.workspace_team.changeset_draft', version: 1 },
    adapter: options.mismatchChild ? mismatchChildAdapter(adapter) : adapter
  }]);
  const authority: Parameters<typeof createWorkspaceTeamOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (options.denied) return { kind: 'denied', reason: 'not_authorized' };
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane, scope: input.scope,
          grants: [{ kind: 'permission', key: 'access.users.invite' }],
          evidenceIds: ['membership.current'], authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const module = createWorkspaceTeamOperationModule({
    workspaceId,
    policies: {
      read: WORKSPACE_TEAM_OPERATION_ACCESS.read.policy,
      invite: WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy,
      changeRole: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy,
      remove: WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy
    },
    currentAuthority: authority,
    teamRead: { readWorkspaceTeam: () => repository.readProjection(workspaceId) },
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x42)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`workspace-team:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, registry, {
    resolveAuthority: authority.resolve,
    now: () => now
  });
  let receipt = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: module.source,
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => now }, newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receipt++)
  });
  let request = 0;
  return {
    sqlite, repository,
    lifecycle: createSQLiteDraftOnlyChangesetLifecycleStore(sqlite),
    close: () => sqlite.close(false),
    async execute(input: {
      email: string; roleKey: 'viewer'; expectedTeamVersion: number;
      expectedTeamDigestSha256: string;
    }, idempotencyKey = `workspace-team-${request++}`) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: WORKSPACE_TEAM_INVITE_DRAFT_OPERATION.name,
        operationVersion: 1, surface: 'operator_http',
        correlationId: uuid(0x900 + request), businessInput: input,
        verifiedEvidence: evidence, rawIdempotencyKey: idempotencyKey
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

describe('SQLite workspace team draft effect domain', () => {
  test('atomically persists an inert classified invite changeset and exact evidence', async () => {
    const input = fixture();
    try {
      const head = input.repository.readPlanningSnapshot(workspaceId);
      const result = workspaceTeamDraftOperationResultSchema.parse(await input.execute({
        email: 'invitee@example.test', roleKey: 'viewer',
        expectedTeamVersion: head.version,
        expectedTeamDigestSha256: head.digestSha256
      }));
      expect(result).toMatchObject({
        kind: 'success',
        data: {
          action: 'invite', status: 'draft',
          safeDiff: { invitationStatus: 'recorded', delivery: 'awaiting_activation' }
        }
      });
      if (result.kind !== 'success') throw new TypeError('expected success');
      const stored = input.lifecycle.read(result.data.changesetId);
      expect(stored).toMatchObject({
        head: { workspaceId, status: 'draft', version: 1 }
      });
      expect(stored && 'eventId' in stored.head).toBe(false);
      expect(count(input.sqlite, 'access_reservations')).toBe(0);
      expect(count(input.sqlite, 'classified_payload_records')).toBe(1);
      expect(count(input.sqlite, 'workspace_team_draft_receipt_links')).toBe(1);
      expect(count(input.sqlite, 'workspace_team_draft_timeline')).toBe(1);
      expect(Buffer.from(input.sqlite.serialize()).includes(Buffer.from('invitee@example.test')))
        .toBe(false);
    } finally {
      input.close();
    }
  });

  test('replays the exact request and conflicts when one idempotency key changes', async () => {
    const input = fixture();
    try {
      const head = input.repository.readPlanningSnapshot(workspaceId);
      const request = {
        email: 'invitee@example.test', roleKey: 'viewer' as const,
        expectedTeamVersion: head.version, expectedTeamDigestSha256: head.digestSha256
      };
      const first = await input.execute(request, 'same-key');
      const replay = await input.execute(request, 'same-key');
      expect(replay).toEqual(first);
      expect(await input.execute({ ...request, email: 'changed@example.test' }, 'same-key'))
        .toMatchObject({
          kind: 'outcome', terminal: false,
          outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
        });
      expect(count(input.sqlite, 'changeset_heads')).toBe(1);
      expect(count(input.sqlite, 'classified_payload_records')).toBe(1);
    } finally {
      input.close();
    }
  });

  test('returns stale and authority refusals without payload, draft, or receipt writes', async () => {
    for (const [input, denial] of [[fixture(), 'stale'], [fixture({ denied: true }), 'authority']] as const) {
      try {
        const head = input.repository.readPlanningSnapshot(workspaceId);
        const result = await input.execute({
          email: 'blocked@example.test', roleKey: 'viewer',
          expectedTeamVersion: denial === 'stale' ? head.version + 1 : head.version,
          expectedTeamDigestSha256: head.digestSha256
        });
        expect(result).toMatchObject(denial === 'stale'
          ? { kind: 'outcome', outcome: { class: 'stale_revision' } }
          : { kind: 'outcome', outcome: { class: 'access_denied' } });
        expect(count(input.sqlite, 'changeset_heads')).toBe(0);
        expect(count(input.sqlite, 'classified_payload_records')).toBe(0);
        expect(count(input.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
      } finally {
        input.close();
      }
    }
  });

  test('rolls back classified payload, draft, receipt, and timeline on evidence mismatch', async () => {
    const input = fixture({ mismatchChild: true });
    try {
      const head = input.repository.readPlanningSnapshot(workspaceId);
      try {
        await input.execute({
          email: 'rollback@example.test', roleKey: 'viewer',
          expectedTeamVersion: head.version,
          expectedTeamDigestSha256: head.digestSha256
        });
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toMatchObject({
          name: 'OperationExecutionError', phase: 'receipt_children'
        } satisfies Partial<OperationExecutionError>);
      }
      for (const table of [
        'classified_payload_records', 'changeset_heads',
        'workspace_team_draft_receipt_links', 'workspace_team_draft_timeline',
        'foundation_trial_operation_receipts'
      ]) expect(count(input.sqlite, table), table).toBe(0);
    } finally {
      input.close();
    }
  });
});
