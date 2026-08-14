import { afterEach, describe, expect, test } from 'bun:test';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  planWorkspaceTeamInvitation,
  planWorkspaceTeamRemoval,
  planWorkspaceTeamRoleChange,
  type AuthenticatedWorkspaceInvitationMailbox,
  type AuthenticatedWorkspaceInvitationMailboxEvidenceSource
} from '@jooevents/identity-access';
import {
  workspaceTeamSubjectRefSchema,
  type WorkspaceTeamRoleKey
} from '@jooevents/contracts/workspace-team';
import {
  parseInstant,
  parseMembershipId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { openSQLite, type OpenSQLiteResult } from './database';
import {
  SQLiteClassifiedPayloadStore,
  installSQLiteClassifiedPayloadStoreSchema
} from './sqlite-classified-payload-store';
import {
  SQLiteWorkspaceTeamError,
  SQLiteWorkspaceTeamRepository,
  adoptWorkspaceInvitationRecipient,
  createSQLiteAuthenticatedWorkspaceInvitationLookup,
  ensureWorkspaceTeamRoles,
  installWorkspaceTeamSchema
} from './workspace-team';

const ids = {
  workspace: parseWorkspaceId('019c2d70-0000-7000-8000-000000000001'),
  otherWorkspace: parseWorkspaceId('019c2d70-0000-7000-8000-000000000002'),
  owner: parseUserId('019c2d70-0000-7000-8000-000000000003'),
  member: parseUserId('019c2d70-0000-7000-8000-000000000004'),
  ownerMembership: parseMembershipId('019c2d70-0000-7000-8000-000000000005'),
  memberMembership: parseMembershipId('019c2d70-0000-7000-8000-000000000006')
} as const;
const now = parseInstant('2026-08-13T03:00:00.000Z');
const lookupKey = new Uint8Array(32).fill(0x45);
const opened: OpenSQLiteResult[] = [];

interface Fixture {
  readonly sqlite: OpenSQLiteResult['sqlite'];
  readonly store: SQLiteClassifiedPayloadStore;
  readonly repository: SQLiteWorkspaceTeamRepository;
  readonly roleIds: Readonly<Record<WorkspaceTeamRoleKey, string>>;
}

function fixture(): Fixture {
  const database = openSQLite(':memory:');
  opened.push(database);
  installSQLiteClassifiedPayloadStoreSchema(database.sqlite);
  installWorkspaceTeamSchema(database.sqlite);
  const profile = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.workspace-invitation-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x71)
  });
  const store = new SQLiteClassifiedPayloadStore(database.sqlite, {
    encryptionProfile: profile,
    nonceSource: (length) => new Uint8Array(length).fill(0x29)
  });
  const repository = new SQLiteWorkspaceTeamRepository(database.sqlite, store);
  const roleIds = {
    workspace_admin: '019c2d70-0000-7000-8000-000000000101',
    event_manager: '019c2d70-0000-7000-8000-000000000102',
    speaker_manager: '019c2d70-0000-7000-8000-000000000103',
    speaker_reviewer: '019c2d70-0000-7000-8000-000000000104',
    scheduler: '019c2d70-0000-7000-8000-000000000105',
    communications_coordinator: '019c2d70-0000-7000-8000-000000000106',
    viewer: '019c2d70-0000-7000-8000-000000000107'
  } as const;
  const at = Date.parse(now);
  database.sqlite.transaction(() => {
    database.sqlite.query(`INSERT INTO workspaces
      (id, name, state, created_at, updated_at, version)
      VALUES (?, 'Main', 'active', ?, ?, 1), (?, 'Other', 'active', ?, ?, 1)`)
      .run(ids.workspace, at, at, ids.otherWorkspace, at, at);
    database.sqlite.query(`INSERT INTO users
      (id, status, display_name, created_at, updated_at, version)
      VALUES (?, 'active', 'Owner', ?, ?, 1), (?, 'active', 'Member', ?, ?, 1)`)
      .run(ids.owner, at, at, ids.member, at, at);
    database.sqlite.query(`INSERT INTO user_emails
      (id, user_id, normalized_email, display_email, verified, source,
       is_primary, verified_at, created_at)
      VALUES
      ('019c2d70-0000-7000-8000-000000000201', ?, 'owner@example.test',
       'owner@example.test', 1, 'auth_provider', 1, ?, ?),
      ('019c2d70-0000-7000-8000-000000000202', ?, 'member@example.test',
       'member@example.test', 1, 'auth_provider', 1, ?, ?)`)
      .run(ids.owner, at, at, ids.member, at, at);
    database.sqlite.query(`INSERT INTO workspace_memberships
      (id, workspace_id, user_id, status, created_at, updated_at, version)
      VALUES (?, ?, ?, 'active', ?, ?, 1), (?, ?, ?, 'active', ?, ?, 1)`)
      .run(ids.ownerMembership, ids.workspace, ids.owner, at, at,
        ids.memberMembership, ids.workspace, ids.member, at, at);
    ensureWorkspaceTeamRoles({
      sqlite: database.sqlite,
      workspaceId: ids.workspace,
      now,
      newRoleId: (key) => roleIds[key]
    });
    database.sqlite.query(`INSERT INTO role_assignments
      (id, user_id, role_id, workspace_id, scope_kind, event_id,
       assigned_by_user_id, assigned_at, version)
      VALUES
      ('019c2d70-0000-7000-8000-000000000301', ?, ?, ?, 'workspace', NULL, ?, ?, 1),
      ('019c2d70-0000-7000-8000-000000000302', ?, ?, ?, 'workspace', NULL, ?, ?, 1)`)
      .run(ids.owner, roleIds.workspace_admin, ids.workspace, ids.owner, at,
        ids.member, roleIds.viewer, ids.workspace, ids.owner, at);
    repository.initialize(ids.workspace);
  }).immediate();
  return { sqlite: database.sqlite, store, repository, roleIds };
}

afterEach(() => {
  while (opened.length) opened.pop()?.sqlite.close(false);
});

function invitationPlan(input: Fixture, email = 'invitee@example.test') {
  const snapshot = input.repository.readPlanningSnapshot(ids.workspace);
  const reservationId = '019c2d70-0000-7000-8000-000000000401';
  const recipient = adoptWorkspaceInvitationRecipient({
    store: input.store,
    workspaceId: ids.workspace,
    reservationId,
    payloadRefId: parsePayloadRefId('019c2d70-0000-7000-8000-000000000402'),
    normalizedEmail: email,
    lookupKeyBytes: lookupKey,
    createdAt: now
  });
  return planWorkspaceTeamInvitation({
    snapshot,
    expectedTeamVersion: snapshot.version,
    expectedTeamDigestSha256: snapshot.digestSha256,
    roleKey: 'viewer',
    recipient,
    ids: {
      reservationId,
      reservationRoleAssignmentId: '019c2d70-0000-7000-8000-000000000403',
      releaseIntentId: '019c2d70-0000-7000-8000-000000000404',
      historyId: '019c2d70-0000-7000-8000-000000000405'
    },
    actorUserId: ids.owner,
    evaluatedAt: now
  });
}

describe('disposable SQLite workspace team adapter', () => {
  test('a role-less pending_review admission is awaiting approval, not aggregate corruption', () => {
    const input = fixture();
    const before = input.repository.readPlanningSnapshot(ids.workspace);
    const at = Date.parse(now);
    // Open admission (mode 'pending') commits a user and membership with no
    // workspace role assignment inside the guarded provisioning transaction.
    input.sqlite.transaction(() => {
      const guard = input.repository.captureProvisioningGuard(ids.workspace);
      input.sqlite.query(`INSERT INTO users
        (id, status, display_name, created_at, updated_at, version)
        VALUES ('019c2d70-0000-7000-8000-000000000701', 'pending_review', 'Applicant', ?, ?, 1)`)
        .run(at, at);
      input.sqlite.query(`INSERT INTO workspace_memberships
        (id, workspace_id, user_id, status, created_at, updated_at, version)
        VALUES ('019c2d70-0000-7000-8000-000000000702', ?,
          '019c2d70-0000-7000-8000-000000000701', 'pending_review', ?, ?, 1)`)
        .run(ids.workspace, at, at);
      input.repository.synchronizeProvisioningMutation(guard);
    }).immediate();
    const after = input.repository.readPlanningSnapshot(ids.workspace);
    expect(after.version).toBe(before.version);
    expect(after.digestSha256).toBe(before.digestSha256);
    expect(after.members.map((member) => member.userId)).toEqual([ids.owner, ids.member]);
  });

  test('zeroizes the transient mailbox buffer when classified adoption fails', () => {
    let captured: Uint8Array | undefined;
    const failing: SynchronousClassifiedPayloadStore = {
      put(input) {
        captured = input.bytes;
        throw new Error('injected put failure');
      },
      read() { throw new Error('unreachable'); }
    };
    expect(() => adoptWorkspaceInvitationRecipient({
      store: failing,
      workspaceId: ids.workspace,
      reservationId: '019c2d70-0000-7000-8000-000000000901',
      payloadRefId: '019c2d70-0000-7000-8000-000000000902',
      normalizedEmail: 'zeroize@example.test',
      lookupKeyBytes: lookupKey,
      createdAt: now
    })).toThrow('injected put failure');
    expect(captured).toBeDefined();
    expect(captured && [...captured].every((byte) => byte === 0)).toBe(true);
  });

  test('records an invitation without leaking its mailbox into ordinary state or history', () => {
    const input = fixture();
    input.sqlite.transaction(() => {
      input.repository.applyPlan(invitationPlan(input));
    }).immediate();
    const projection = input.repository.readProjection(ids.workspace);
    expect(projection.version).toBe(2);
    expect(projection.members.find((entry) => entry.status === 'invited')).toMatchObject({
      email: 'invitee@example.test',
      delivery: 'awaiting_activation',
      role: { key: 'viewer' }
    });
    expect(input.sqlite.query<{ normalized_email: string }, []>(`
      SELECT normalized_email FROM access_reservations WHERE status = 'open'
    `).get()?.normalized_email).toMatch(/^[a-f0-9]{64}$/);
    const history = input.sqlite.query<{ evidence_json: string }, []>(`
      SELECT evidence_json FROM workspace_team_history WHERE action = 'invite_recorded'
    `).get()?.evidence_json ?? '';
    expect(history).not.toContain('invitee@example.test');
    expect(Buffer.from(input.sqlite.serialize()).includes(Buffer.from('invitee@example.test')))
      .toBe(false);
  });

  test('zeroizes classified recipient bytes after an authorized projection read', () => {
    const input = fixture();
    input.sqlite.transaction(() => {
      input.repository.applyPlan(invitationPlan(input));
    }).immediate();
    let openedBytes: Uint8Array | undefined;
    const observingStore: SynchronousClassifiedPayloadStore = {
      put: input.store.put.bind(input.store),
      read(readInput) {
        openedBytes = input.store.read(readInput);
        return openedBytes;
      }
    };
    const projection = new SQLiteWorkspaceTeamRepository(input.sqlite, observingStore)
      .readProjection(ids.workspace);
    expect(projection.members.some((member) => member.email === 'invitee@example.test')).toBe(true);
    expect(openedBytes).toBeDefined();
    expect(openedBytes && [...openedBytes].every((byte) => byte === 0)).toBe(true);
  });

  test('changes roles with an exact guard and rolls back every partial write on failure', () => {
    const input = fixture();
    const before = input.repository.readPlanningSnapshot(ids.workspace);
    const plan = planWorkspaceTeamRoleChange({
      snapshot: before,
      expectedTeamVersion: before.version,
      expectedTeamDigestSha256: before.digestSha256,
      subject: { kind: 'member', membershipId: ids.memberMembership, version: 1 },
      roleKey: 'scheduler',
      actorUserId: ids.owner,
      evaluatedAt: now,
      historyId: '019c2d70-0000-7000-8000-000000000502'
    });
    expect(() => input.sqlite.transaction(() => {
      input.repository.applyPlan(plan);
      throw new Error('force rollback');
    }).immediate()).toThrow('force rollback');
    expect(input.repository.readPlanningSnapshot(ids.workspace).version).toBe(1);

    input.sqlite.transaction(() => {
      input.repository.applyPlan(plan);
    }).immediate();
    expect(input.repository.readProjection(ids.workspace).members.find(
      (member) => member.id === ids.memberMembership
    )?.role.key).toBe('scheduler');
    expect(() => input.sqlite.transaction(() => {
      input.repository.applyPlan(plan);
    }).immediate()).toThrow(SQLiteWorkspaceTeamError);
  });

  test('deactivates a member and records an awaiting session-revocation seam', () => {
    const input = fixture();
    const snapshot = input.repository.readPlanningSnapshot(ids.workspace);
    const plan = planWorkspaceTeamRemoval({
      snapshot,
      expectedTeamVersion: snapshot.version,
      expectedTeamDigestSha256: snapshot.digestSha256,
      subject: { kind: 'member', membershipId: ids.memberMembership, version: 1 },
      actorUserId: ids.owner,
      evaluatedAt: now,
      historyId: '019c2d70-0000-7000-8000-000000000602',
      sessionRevocationIntentId: '019c2d70-0000-7000-8000-000000000601'
    });
    input.sqlite.transaction(() => {
      input.repository.applyPlan(plan);
    }).immediate();
    expect(input.sqlite.query<{ status: string }, [string]>(`
      SELECT status FROM workspace_memberships WHERE id = ?
    `).get(ids.memberMembership)?.status).toBe('deactivated');
    expect(input.sqlite.query<{ status: string }, [string]>(`
      SELECT status FROM workspace_team_session_revocation_intents WHERE membership_id = ?
    `).get(ids.memberMembership)?.status).toBe('awaiting_activation');
  });

  test('changes and then revokes an invitation while cancelling its release intent', () => {
    const input = fixture();
    input.sqlite.transaction(() => {
      input.repository.applyPlan(invitationPlan(input));
    }).immediate();
    const invited = input.repository.readPlanningSnapshot(ids.workspace);
    const invitation = invited.invitations[0];
    if (!invitation) throw new TypeError('expected invitation');
    const roleChange = planWorkspaceTeamRoleChange({
      snapshot: invited,
      expectedTeamVersion: invited.version,
      expectedTeamDigestSha256: invited.digestSha256,
      subject: workspaceTeamSubjectRefSchema.parse({
        kind: 'invitation',
        reservationId: invitation.reservationId,
        version: invitation.reservationVersion
      }),
      roleKey: 'scheduler',
      actorUserId: ids.owner,
      evaluatedAt: now,
      historyId: '019c2d70-0000-7000-8000-000000000701'
    });
    input.sqlite.transaction(() => input.repository.applyPlan(roleChange)).immediate();
    expect(input.repository.readProjection(ids.workspace).members.find(
      (member) => member.kind === 'invitation'
    )?.role.key).toBe('scheduler');

    const changed = input.repository.readPlanningSnapshot(ids.workspace);
    const changedInvitation = changed.invitations[0];
    if (!changedInvitation) throw new TypeError('expected changed invitation');
    const removal = planWorkspaceTeamRemoval({
      snapshot: changed,
      expectedTeamVersion: changed.version,
      expectedTeamDigestSha256: changed.digestSha256,
      subject: workspaceTeamSubjectRefSchema.parse({
        kind: 'invitation',
        reservationId: changedInvitation.reservationId,
        version: changedInvitation.reservationVersion
      }),
      actorUserId: ids.owner,
      evaluatedAt: now,
      historyId: '019c2d70-0000-7000-8000-000000000702'
    });
    input.sqlite.transaction(() => input.repository.applyPlan(removal)).immediate();
    expect(input.sqlite.query<{ status: string }, []>(`
      SELECT status FROM workspace_team_invitation_release_intents
    `).get()?.status).toBe('cancelled');
    expect(input.sqlite.query<{ status: string }, []>(`
      SELECT status FROM access_reservations
    `).get()?.status).toBe('revoked');
    expect(input.repository.readProjection(ids.workspace).members.some(
      (member) => member.kind === 'invitation'
    )).toBe(false);
  });

  test('requires an auth-ceremony handle; forged structural claims cannot resolve', () => {
    const input = fixture();
    input.sqlite.transaction(() => {
      input.repository.applyPlan(invitationPlan(input));
    }).immediate();
    const genuine = Object.freeze(Object.create(null)) as AuthenticatedWorkspaceInvitationMailbox;
    const issued = new WeakSet<object>([genuine]);
    const mailboxEvidence: AuthenticatedWorkspaceInvitationMailboxEvidenceSource = {
      open(mailbox) {
        return issued.has(mailbox)
          ? {
              provider: 'oidc', issuer: 'https://issuer.example', subject: 'subject-1',
              normalizedEmail: 'invitee@example.test', observedAt: now
            }
          : undefined;
      }
    };
    const lookup = createSQLiteAuthenticatedWorkspaceInvitationLookup({
      sqlite: input.sqlite, lookupKeyBytes: lookupKey, mailboxEvidence
    });
    expect(lookup.findOpen({ workspaceId: ids.workspace, mailbox: genuine })).toMatchObject({
      reservationVersion: 1, roleKey: 'viewer'
    });
    const forged = Object.freeze({
      provider: 'oidc', issuer: 'https://issuer.example', subject: 'subject-1',
      normalizedEmail: 'invitee@example.test', observedAt: now
    }) as unknown as AuthenticatedWorkspaceInvitationMailbox;
    expect(lookup.findOpen({ workspaceId: ids.workspace, mailbox: forged })).toBeUndefined();
    expect(lookup.findOpen({ workspaceId: ids.otherWorkspace, mailbox: genuine })).toBeUndefined();
  });

  test('rolls classified recipient adoption back with the invitation transaction', () => {
    const input = fixture();
    expect(() => input.sqlite.transaction(() => {
      const plan = invitationPlan(input, 'rollback@example.test');
      input.repository.applyPlan(plan);
      throw new Error('force rollback');
    }).immediate()).toThrow('force rollback');
    expect(input.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM classified_payload_records
    `).get()?.count).toBe(0);
    expect(input.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM access_reservations
    `).get()?.count).toBe(0);
    expect(input.repository.readPlanningSnapshot(ids.workspace).version).toBe(1);
  });
});
