import { afterEach, describe, expect, test } from 'bun:test';
import { makeSignature } from 'better-auth/crypto';
import { createProvisioningService } from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import { bootstrapEmptyInstall, createSQLiteProvisioningStore, openSQLite } from '@jooevents/persistence';
import {
  SQLiteClassifiedPayloadStore,
  installSQLiteClassifiedPayloadStoreSchema
} from '@jooevents/persistence/sqlite-classified-payload-store';
import {
  SQLiteWorkspaceTeamRepository,
  createWorkspaceTeamProvisioningSynchronizationPort,
  ensureWorkspaceTeamRoles,
  installWorkspaceTeamSchema
} from '@jooevents/persistence/sqlite/workspace-team';
import { parseInstant, parseWorkspaceId } from '@jooevents/kernel';
import { createAuth } from '../auth/better-auth';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import { loadConfig } from '../config';
import { createHttpApp } from './app';

const databases: ReturnType<typeof openSQLite>[] = [];
const config = loadConfig({
  JOOEVENTS_BASE_URL: 'http://localhost:5176',
  JOOEVENTS_TRUSTED_ORIGINS: '',
  JOOEVENTS_AUTH_SECRETS: '1:Q7m!2vK9#pL4@xR8%tN5&cW3*zF6$hJ1',
  JOOEVENTS_REQUEST_HASH_KEYS: `1:${Buffer.alloc(32, 1).toString('base64url')}`,
  JOOEVENTS_IDEMPOTENCY_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
  JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `1:${Buffer.alloc(32, 3).toString('base64url')}`,
  JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
  JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
  JOOEVENTS_ADMISSION_MODE: 'pending',
  JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
  JOOEVENTS_DATABASE_DRIVER: 'sqlite',
  JOOEVENTS_DATABASE_PATH: 'test.sqlite',
  JOOEVENTS_BLOB_DRIVER: 'filesystem',
  JOOEVENTS_DATA_DIRECTORY: '/tmp/jooevents-open-admission-test'
});

afterEach(() => {
  while (databases.length) databases.pop()?.sqlite.close();
});

/**
 * The exact joined-runtime admission wiring: the provisioning store carries the
 * workspace-team synchronization port, so the sign-in commit and the Team
 * aggregate guard run in one transaction — the composition the refresh-loop
 * regression lived in.
 */
function joinedAdmissionFixture() {
  const opened = openSQLite(':memory:');
  databases.push(opened);
  installSQLiteClassifiedPayloadStoreSchema(opened.sqlite);
  installWorkspaceTeamSchema(opened.sqlite);
  const bootstrap = bootstrapEmptyInstall({
    sqlite: opened.sqlite,
    ownerEmail: config.bootstrapOwnerEmail,
    workspaceName: 'JooEvents',
    now: new Date('2026-08-14T08:00:00.000Z').toISOString()
  });
  const classifiedStore = new SQLiteClassifiedPayloadStore(opened.sqlite, {
    encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
      reference: Object.freeze({ key: 'encryption.workspace-invitation', version: 1 }),
      keyBytes: Buffer.alloc(32, 7)
    })
  });
  const teamRepository = new SQLiteWorkspaceTeamRepository(opened.sqlite, classifiedStore);
  const workspaceId = parseWorkspaceId(bootstrap.workspaceId);
  opened.sqlite.transaction(() => {
    ensureWorkspaceTeamRoles({
      sqlite: opened.sqlite,
      workspaceId,
      now: parseInstant('2026-08-14T08:00:00.000Z'),
      newRoleId: () => crypto.randomUUID()
    });
    teamRepository.initialize(workspaceId);
  }).immediate();
  const auth = createAuth(config, opened.db);
  const app = createHttpApp({
    auth,
    baseUrl: config.baseUrl,
    workspaceId: bootstrap.workspaceId,
    accessContext: createProvisioningService({
      principals: createSQLiteAuthPrincipalReader(opened.sqlite),
      store: createSQLiteProvisioningStore(opened.sqlite, {
        workspaceTeam: createWorkspaceTeamProvisioningSynchronizationPort(teamRepository)
      }),
      admission: { mode: config.admissionMode }
    })
  });
  return { opened, app, teamRepository, workspaceId };
}

async function sessionCookie(opened: ReturnType<typeof openSQLite>, input: {
  readonly authUserId: string;
  readonly email: string;
  readonly displayName: string;
}) {
  const now = Date.now();
  const rawToken = `session-${input.authUserId}`;
  opened.sqlite.query(`insert into auth_users (id, name, email, email_verified, image, created_at, updated_at)
    values (?, ?, ?, 1, null, ?, ?)`).run(input.authUserId, input.displayName, input.email, now, now);
  opened.sqlite.query(`insert into auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at)
    values (?, ?, 'google', ?, ?, ?)`).run(crypto.randomUUID(), `google-subject-${input.authUserId}`, input.authUserId, now, now);
  opened.sqlite.query(`insert into auth_sessions (id, token, user_id, expires_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), rawToken, input.authUserId, now + 24 * 60 * 60 * 1000, now, now);
  const secret = config.authSecrets[0]?.value;
  if (!secret) throw new Error('auth secret missing');
  return `better-auth.session_token=${rawToken}.${await makeSignature(rawToken, secret)}`;
}

describe('open-admission access context', () => {
  test('a linked principal with no reservation and no membership is served pending_review, never a provisioning loop', async () => {
    const { opened, app, teamRepository, workspaceId } = joinedAdmissionFixture();
    const cookie = await sessionCookie(opened, {
      authUserId: 'auth_new_person',
      email: 'new-person@gmail.example',
      displayName: 'New Person'
    });

    const first = await app.request('/api/me/access-context', {
      headers: { cookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(first.status).toBe(200);
    const served = await first.json() as { state: string; workspace?: { id: string; name: string } };
    expect(served.state).toBe('pending_review');
    expect(served.workspace).toMatchObject({ id: workspaceId, name: 'JooEvents' });

    // The admission committed: the principal link is terminal, a pending_review
    // membership exists, and the served state stays put on the next poll.
    const link = opened.sqlite.query<{ provisioning_state: string; user_id: string | null }, [string]>(
      'select provisioning_state, user_id from auth_user_links where auth_user_id = ?'
    ).get('auth_new_person');
    expect(link?.provisioning_state).toBe('ready');
    const membership = opened.sqlite.query<{ status: string }, [string, string]>(
      'select status from workspace_memberships where workspace_id = ? and user_id = ?'
    ).get(workspaceId, link?.user_id ?? '');
    expect(membership?.status).toBe('pending_review');

    const second = await app.request('/api/me/access-context', {
      headers: { cookie, 'x-correlation-id': crypto.randomUUID() }
    });
    expect(((await second.json()) as { state: string }).state).toBe('pending_review');

    // The Team aggregate still reads cleanly after the role-less pending
    // admission: it is awaiting approval, not corruption.
    const snapshot = teamRepository.readPlanningSnapshot(workspaceId);
    expect(snapshot.members).toHaveLength(0);
  });
});
