import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSignature } from 'better-auth/crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalSQLiteTarget,
  listSQLiteOwners,
  openSQLite
} from '@jooevents/persistence';
import { safeOperationManifestSchema } from '@jooevents/contracts';
import { newFileStorageKey } from '@jooevents/files';
import { loadConfig, type ConfiguredServerConfig } from '../config';
import {
  createConfiguredSQLiteLiveRuntime,
  type ConfiguredSQLiteLiveRuntime
} from './configured-sqlite-live-runtime';

const directories: string[] = [];
const runtimes: ConfiguredSQLiteLiveRuntime[] = [];
const durableKey = (seed: number) => Buffer.alloc(32, seed).toString('base64url');

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory?.startsWith(join(tmpdir(), 'jooevents-configured-live-'))) {
      rmSync(directory, { recursive: true });
    }
  }
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'jooevents-configured-live-'));
  directories.push(value);
  return value;
}

function configFor(
  dataDirectory: string,
  rotated: boolean | 'newest_only' = false,
  seedOffset = 0
): ConfiguredServerConfig {
  const ring = (activeSeed: number, retainedSeed: number) =>
    rotated === 'newest_only'
      ? `2:${durableKey(activeSeed + seedOffset)}`
      : rotated
        ? `2:${durableKey(activeSeed + seedOffset)},1:${durableKey(retainedSeed + seedOffset)}`
        : `1:${durableKey(retainedSeed + seedOffset)}`;
  return loadConfig({
    JOOEVENTS_BASE_URL: 'http://localhost:5176',
    JOOEVENTS_TRUSTED_ORIGINS: '',
    JOOEVENTS_AUTH_SECRETS: `1:${'a'.repeat(32)}`,
    JOOEVENTS_REQUEST_HASH_KEYS: ring(11, 1),
    JOOEVENTS_IDEMPOTENCY_KEYS: ring(12, 2),
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: ring(13, 3),
    JOOEVENTS_PERSISTENT_HMAC_KEYS: ring(14, 4),
    JOOEVENTS_GOOGLE_CLIENT_ID: 'google-client',
    JOOEVENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
    JOOEVENTS_ADMISSION_MODE: 'pending',
    JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
    JOOEVENTS_DATABASE_DRIVER: 'sqlite',
    JOOEVENTS_DATABASE_PATH: 'jooevents.sqlite',
    JOOEVENTS_BLOB_DRIVER: 'filesystem',
    JOOEVENTS_DATA_DIRECTORY: dataDirectory
  });
}

function initializeDatabase(path: string): void {
  const database = openSQLite(path, {
    migrationPolicy: 'apply',
    databaseClass: 'retained_development'
  });
  database.sqlite.close();
}

async function createBrowserSession(input: {
  readonly runtime: ConfiguredSQLiteLiveRuntime;
  readonly config: ConfiguredServerConfig;
  readonly email: string;
}): Promise<{ readonly authUserId: string; readonly cookie: string }> {
  const now = Date.now();
  const authUserId = crypto.randomUUID();
  const rawToken = crypto.randomUUID();
  input.runtime.database.sqlite.query(`
    INSERT INTO auth_users (
      id, name, email, email_verified, image, created_at, updated_at
    ) VALUES (?, 'Retained runtime user', ?, 1, NULL, ?, ?)
  `).run(authUserId, input.email, now, now);
  input.runtime.database.sqlite.query(`
    INSERT INTO auth_accounts (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, 'google', ?, ?, ?)
  `).run(crypto.randomUUID(), `google-${crypto.randomUUID()}`, authUserId, now, now);
  input.runtime.database.sqlite.query(`
    INSERT INTO auth_sessions (
      id, token, user_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), rawToken, authUserId, now + 60 * 60 * 1000, now, now);
  const secret = input.config.authSecrets[0]?.value;
  if (!secret) throw new Error('configured_live_test_auth_secret_missing');
  const signature = await makeSignature(rawToken, secret);
  return Object.freeze({
    authUserId,
    cookie: `better-auth.session_token=${rawToken}.${signature}`
  });
}

async function provision(
  runtime: ConfiguredSQLiteLiveRuntime,
  session: { readonly cookie: string }
): Promise<unknown> {
  const response = await runtime.app.request('/api/me/access-context', {
    headers: { cookie: session.cookie, 'x-correlation-id': crypto.randomUUID() }
  });
  expect(response.status).toBe(200);
  return response.json();
}

function jsonHeaders(input: {
  readonly config: ConfiguredServerConfig;
  readonly cookie: string;
  readonly idempotencyKey?: string;
}): Headers {
  const headers = new Headers({
    cookie: input.cookie,
    origin: input.config.baseUrl,
    'content-type': 'application/json',
    'x-correlation-id': crypto.randomUUID()
  });
  if (input.idempotencyKey) headers.set('idempotency-key', input.idempotencyKey);
  return headers;
}

async function drain(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of bytes) {
    const copy = Uint8Array.from(chunk);
    chunks.push(copy);
    size += copy.byteLength;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

describe('configured SQLite live runtime', () => {
  test('mounts the complete joined application and preserves retained roots across restart', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'jooevents.sqlite');
    initializeDatabase(databasePath);
    const config = configFor(dataDirectory);

    const first = await createConfiguredSQLiteLiveRuntime({ config });
    runtimes.push(first);
    const manifestResponse = await first.app.request('/api/operations/manifest');
    expect(manifestResponse.status).toBe(200);
    const manifest = safeOperationManifestSchema.parse(await manifestResponse.json());
    expect(manifest.operations.some((operation) => operation.name === 'event.create')).toBe(true);
    expect(manifest.operations.some((operation) => operation.name === 'send_messages'))
      .toBe(true);
    expect(first.blobRootDirectory).toBe(join(dataDirectory, 'blobs'));
    expect(existsSync(first.blobRootDirectory)).toBe(true);
    expect(first.database.sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count FROM reservation_permission_overrides
       WHERE reservation_id = (SELECT owner_reservation_id FROM bootstrap_state
         WHERE key = 'initial_workspace')
    `).get()?.count).toBe(4);

    const beforeStart = await first.app.request('/health');
    expect(await beforeStart.json()).toMatchObject({
      ok: true,
      background: { state: 'not_started' }
    });
    await first.startBackgroundWork();
    const afterStart = await first.app.request('/health');
    expect(await afterStart.json()).toMatchObject({
      ok: true,
      background: {
        state: 'running',
        jobs: [
          { name: 'calendar_notice_dispatch', state: 'succeeded' },
          { name: 'approved_agent_actions', state: 'succeeded' },
          { name: 'expired_file_intents', state: 'succeeded' },
          { name: 'orphan_file_blobs', state: 'succeeded' }
        ]
      }
    });

    const retainedMarker = join(first.blobRootDirectory, 'restart-marker');
    writeFileSync(retainedMarker, 'retained');
    const blobKey = newFileStorageKey({
      workspaceId: first.workspaceId,
      eventId: '22222222-0000-4000-8000-000000000001'
    }, '22222222-0000-4000-8000-000000000002');
    const blobBytes = new TextEncoder().encode('retained file bytes');
    expect(await first.files.blobs.writeStream({
      key: blobKey,
      bytes: (async function* () { yield blobBytes; })(),
      maximumByteSize: 1024
    })).toMatchObject({ kind: 'stored', byteSize: blobBytes.byteLength });
    const workspaceId = first.workspaceId;
    await first.close();
    runtimes.pop();
    expect(existsSync(retainedMarker)).toBe(true);

    const reopened = await createConfiguredSQLiteLiveRuntime({ config });
    runtimes.push(reopened);
    expect(reopened.workspaceId).toBe(workspaceId);
    expect(existsSync(retainedMarker)).toBe(true);
    const retainedBlob = await reopened.files.blobs.openReadStream(blobKey);
    if (retainedBlob.kind !== 'found') throw new Error('retained_blob_missing_after_restart');
    expect(await drain(retainedBlob.bytes)).toEqual(blobBytes);
    expect(reopened.database.sqlite.query<{ readonly count: number }, []>(`
      SELECT count(*) AS count FROM reservation_permission_overrides
       WHERE reservation_id = (SELECT owner_reservation_id FROM bootstrap_state
         WHERE key = 'initial_workspace')
    `).get()?.count).toBe(4);
  });

  test('restarts with durable operation replay, classified invitations, and lookup keys intact', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'jooevents.sqlite');
    initializeDatabase(databasePath);
    const config = configFor(dataDirectory);
    const first = await createConfiguredSQLiteLiveRuntime({ config });
    runtimes.push(first);
    const owner = await createBrowserSession({
      runtime: first,
      config,
      email: config.bootstrapOwnerEmail
    });
    expect(await provision(first, owner)).toMatchObject({ state: 'active' });

    const eventBody = Object.freeze({
      expectedEventSetVersion: 1,
      name: 'Restart-safe Summit',
      timezone: 'Asia/Singapore',
      startDate: '2027-06-10',
      endDate: '2027-06-12'
    });
    const createResponse = await first.app.request('/api/events', {
      method: 'POST',
      headers: jsonHeaders({
        config,
        cookie: owner.cookie,
        idempotencyKey: 'retained-event'
      }),
      body: JSON.stringify(eventBody)
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created).toMatchObject({
      kind: 'success',
      data: { event: { name: 'Restart-safe Summit' } },
      receipt: { operationName: 'event.create', operationVersion: 1 }
    });

    const teamResponse = await first.app.request('/api/workspace/team', {
      headers: jsonHeaders({ config, cookie: owner.cookie })
    });
    const team = await teamResponse.json() as {
      readonly kind: string;
      readonly data: { readonly version: number; readonly digestSha256: string };
    };
    expect(team.kind).toBe('success');
    const inviteResponse = await first.app.request('/api/workspace/team/invitations', {
      method: 'POST',
      headers: jsonHeaders({ config, cookie: owner.cookie, idempotencyKey: 'retained-invite' }),
      body: JSON.stringify({
        email: 'restart-invitee@example.test',
        roleKey: 'viewer',
        expectedTeamVersion: team.data.version,
        expectedTeamDigestSha256: team.data.digestSha256
      })
    });
    expect(inviteResponse.status).toBe(200);
    expect(await inviteResponse.json()).toMatchObject({ kind: 'success' });

    await first.close();
    runtimes.pop();
    const rotatedConfig = configFor(dataDirectory, true);
    const reopened = await createConfiguredSQLiteLiveRuntime({ config: rotatedConfig });
    runtimes.push(reopened);
    const replayResponse = await reopened.app.request('/api/events', {
      method: 'POST',
      headers: jsonHeaders({
        config: rotatedConfig,
        cookie: owner.cookie,
        idempotencyKey: 'retained-event'
      }),
      body: JSON.stringify(eventBody)
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(created);
    expect(await (await reopened.app.request('/api/events/current', {
      headers: jsonHeaders({ config: rotatedConfig, cookie: owner.cookie })
    })).json()).toMatchObject({
      kind: 'success',
      data: { kind: 'current_event', event: { name: 'Restart-safe Summit' } }
    });
    const reopenedTeam = await (await reopened.app.request('/api/workspace/team', {
      headers: jsonHeaders({ config: rotatedConfig, cookie: owner.cookie })
    })).json() as {
      readonly kind: string;
      readonly data: {
        readonly version: number;
        readonly digestSha256: string;
        readonly members: unknown[];
      };
    };
    expect(reopenedTeam.kind).toBe('success');
    expect(reopenedTeam.data.members).toContainEqual(expect.objectContaining({
      kind: 'invitation',
      email: 'restart-invitee@example.test'
    }));

    const secondInviteResponse = await reopened.app.request('/api/workspace/team/invitations', {
      method: 'POST',
      headers: jsonHeaders({
        config: rotatedConfig,
        cookie: owner.cookie,
        idempotencyKey: 'rotated-invite'
      }),
      body: JSON.stringify({
        email: 'new-key-invitee@example.test',
        roleKey: 'viewer',
        expectedTeamVersion: reopenedTeam.data.version,
        expectedTeamDigestSha256: reopenedTeam.data.digestSha256
      })
    });
    expect(secondInviteResponse.status).toBe(200);
    expect(await secondInviteResponse.json()).toMatchObject({ kind: 'success' });
    expect(reopened.database.sqlite.query<{ readonly version: number }, []>(`
      SELECT encryption_profile_version AS version
        FROM classified_payload_records
       WHERE payload_ref_id IN (
         SELECT payload_ref_id FROM workspace_team_invitation_recipients
       )
       ORDER BY encryption_profile_version
    `).all().map((row) => row.version)).toEqual([1, 2]);

    const invitee = await createBrowserSession({
      runtime: reopened,
      config: rotatedConfig,
      email: 'restart-invitee@example.test'
    });
    expect(await provision(reopened, invitee)).toMatchObject({
      state: 'active',
      workspace: { id: reopened.workspaceId }
    });

    await reopened.close();
    runtimes.pop();
    await expect(createConfiguredSQLiteLiveRuntime({
      config: configFor(dataDirectory, 'newest_only')
    })).rejects.toThrow('retained_crypto_profile_version_unavailable');
    expect(listSQLiteOwners(canonicalSQLiteTarget(databasePath))).toEqual([]);
  });

  test('fails before opening storage for unsupported adapters or escaping paths', async () => {
    const dataDirectory = directory();
    const config = configFor(dataDirectory);
    await expect(createConfiguredSQLiteLiveRuntime({
      config: { ...config, databasePath: '../outside.sqlite' }
    })).rejects.toThrow('must stay below JOOEVENTS_DATA_DIRECTORY');
    await expect(createConfiguredSQLiteLiveRuntime({
      config: { ...config, blobDriver: 'r2' }
    })).rejects.toThrow('requires SQLite and filesystem deployment adapters');

    initializeDatabase(join(dataDirectory, 'jooevents.sqlite'));
    const outside = directory();
    symlinkSync(outside, join(dataDirectory, 'blobs'));
    await expect(createConfiguredSQLiteLiveRuntime({ config }))
      .rejects.toThrow('blob root must be a real directory below the data directory');
  });

  test('refuses missing or drifted retained databases without leaking ownership', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'jooevents.sqlite');
    const config = configFor(dataDirectory);
    await expect(createConfiguredSQLiteLiveRuntime({ config }))
      .rejects.toThrow('SQLite validation cannot create a missing database');
    expect(existsSync(databasePath)).toBe(false);
    expect(listSQLiteOwners(canonicalSQLiteTarget(databasePath))).toEqual([]);

    initializeDatabase(databasePath);
    const drifted = new Database(databasePath, { create: false, strict: true });
    drifted.exec('CREATE TABLE unexpected_runtime_table (id TEXT PRIMARY KEY);');
    drifted.close();
    await expect(createConfiguredSQLiteLiveRuntime({ config })).rejects.toThrow();
    expect(listSQLiteOwners(canonicalSQLiteTarget(databasePath))).toEqual([]);
  });

  test('releases the retained database when joined composition fails after open', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'jooevents.sqlite');
    initializeDatabase(databasePath);
    const invalidAfterOpen = { ...configFor(dataDirectory), baseUrl: 'not-a-url' };

    await expect(createConfiguredSQLiteLiveRuntime({ config: invalidAfterOpen }))
      .rejects.toThrow();
    expect(listSQLiteOwners(canonicalSQLiteTarget(databasePath))).toEqual([]);
  });

  test('refuses the same profile versions backed by different key material', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'jooevents.sqlite');
    initializeDatabase(databasePath);
    const first = await createConfiguredSQLiteLiveRuntime({
      config: configFor(dataDirectory)
    });
    await first.close();

    await expect(createConfiguredSQLiteLiveRuntime({
      config: configFor(dataDirectory, false, 20)
    })).rejects.toThrow('installation_crypto_check_failed');
    expect(listSQLiteOwners(canonicalSQLiteTarget(databasePath))).toEqual([]);
  });
});
