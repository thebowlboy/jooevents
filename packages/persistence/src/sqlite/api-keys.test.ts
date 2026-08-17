import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  hashApiKey,
  mintApiKey,
  type NewApiKeyRecord
} from '@jooevents/identity-access';
import {
  parseApiKeyId,
  parseEventId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { installSQLiteApiKeySchema, SQLiteApiKeyStore } from './api-keys';

const ids = {
  workspace: parseWorkspaceId('018f0f47-7a86-7d36-8a25-9f86589c7100'),
  owner: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7200'),
  admin: parseUserId('018f0f47-7a86-7d36-8a25-9f86589c7201'),
  event: parseEventId('018f0f47-7a86-7d36-8a25-9f86589c7300'),
  first: parseApiKeyId('018f0f47-7a86-7d36-8a25-9f86589c7400'),
  second: parseApiKeyId('018f0f47-7a86-7d36-8a25-9f86589c7401')
};

describe('SQLite API key store', () => {
  let sqlite: Database;
  let store: SQLiteApiKeyStore;

  beforeEach(() => {
    sqlite = new Database(':memory:', { create: true, strict: true });
    sqlite.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE workspaces(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE users(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id)) STRICT;
      INSERT INTO workspaces VALUES ('${ids.workspace}');
      INSERT INTO users VALUES ('${ids.owner}'), ('${ids.admin}');
      INSERT INTO events VALUES ('${ids.event}', '${ids.workspace}');`);
    installSQLiteApiKeySchema(sqlite);
    store = new SQLiteApiKeyStore(sqlite);
  });

  afterEach(() => sqlite.close());

  function candidate(apiKeyId = ids.first, seed = 0): NewApiKeyRecord {
    const minted = mintApiKey({
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256)
    });
    return {
      apiKeyId,
      workspaceId: ids.workspace,
      ownerUserId: ids.owner,
      displayName: 'Planning assistant',
      tokenHashSha256: minted.tokenHashSha256,
      tokenHint: minted.tokenHint,
      mayRead: true,
      maySubmitPlans: true,
      permissionIds: ['event.read', 'submission.read'],
      eventIds: [ids.event],
      createdAt: '2026-08-17T00:00:00.000Z',
      expiresAt: '2026-11-15T00:00:00.000Z'
    };
  }

  test('stores hash-only immutable scopes and uniformly rejects expired credentials', () => {
    const secret = mintApiKey({ randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index) });
    const key = store.create(candidate());
    expect(key.permissionIds).toEqual(['event.read', 'submission.read']);
    expect(key.eventIds).toEqual([ids.event]);
    expect(JSON.stringify(sqlite.query('SELECT * FROM api_keys').all())).not.toContain(secret.secret);

    expect(store.resolveByTokenHash({
      tokenHashSha256: hashApiKey(secret.secret),
      workspaceId: ids.workspace,
      evaluatedAt: '2026-08-18T00:00:00.000Z'
    }).kind).toBe('current');
    expect(store.resolveByTokenHash({
      tokenHashSha256: hashApiKey(secret.secret),
      workspaceId: ids.workspace,
      evaluatedAt: '2026-11-15T00:00:00.000Z'
    })).toEqual({ kind: 'invalid' });
  });

  test('coalesces last-use writes, rotates atomically, and makes revocation terminal', () => {
    const first = store.create(candidate());
    store.recordUse({ apiKeyId: first.apiKeyId, usedAt: '2026-08-17T00:00:10.000Z', coalesceWithinMs: 60_000 });
    const observed = store.get(first.apiKeyId)!;
    expect(observed.version).toBe(2);
    store.recordUse({ apiKeyId: first.apiKeyId, usedAt: '2026-08-17T00:00:20.000Z', coalesceWithinMs: 60_000 });
    expect(store.get(first.apiKeyId)?.version).toBe(2);

    const rotated = store.rotate({
      predecessorId: first.apiKeyId,
      expectedVersion: observed.version,
      successor: { ...candidate(ids.second, 1), createdAt: '2026-08-17T00:01:00.000Z' },
      predecessorExpiresAt: '2026-08-24T00:01:00.000Z'
    });
    expect(rotated.predecessor.rotationSuccessorId).toBe(ids.second);
    expect(rotated.predecessor.expiresAt).toBe('2026-08-24T00:01:00.000Z');
    expect(rotated.successor.permissionIds).toEqual(rotated.predecessor.permissionIds);

    const revoked = store.revoke({
      apiKeyId: rotated.successor.apiKeyId,
      expectedVersion: rotated.successor.version,
      revokedAt: '2026-08-17T00:02:00.000Z',
      revokedByUserId: ids.admin,
      reason: 'security'
    });
    expect(revoked.standing).toBe('revoked');
    expect(() => store.revoke({
      apiKeyId: revoked.apiKeyId,
      expectedVersion: revoked.version,
      revokedAt: '2026-08-17T00:03:00.000Z',
      revokedByUserId: ids.admin,
      reason: 'security'
    })).toThrow('api_key_revocation_stale');
    expect(() => sqlite.query('DELETE FROM api_keys WHERE api_key_id = ?').run(revoked.apiKeyId))
      .toThrow('api keys are retained');
  });

  test('keeps a never-expiring key current and gives its rotated predecessor a finite grace period', () => {
    const first = store.create({ ...candidate(), expiresAt: null });
    expect(store.resolveByTokenHash({
      tokenHashSha256: first.tokenHashSha256,
      workspaceId: ids.workspace,
      evaluatedAt: '2099-01-01T00:00:00.000Z'
    })).toEqual(expect.objectContaining({ kind: 'current' }));

    const rotated = store.rotate({
      predecessorId: first.apiKeyId,
      expectedVersion: first.version,
      successor: {
        ...candidate(ids.second, 1),
        createdAt: '2026-08-17T00:01:00.000Z',
        expiresAt: null
      },
      predecessorExpiresAt: '2026-08-24T00:01:00.000Z'
    });
    expect(rotated.predecessor.expiresAt).toBe('2026-08-24T00:01:00.000Z');
    expect(rotated.successor.expiresAt).toBeNull();
  });
});
