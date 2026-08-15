import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  createSQLiteMailSenderPresentationResolver,
  installWorkspaceSenderIdentitySchema,
  SQLiteWorkspaceSenderIdentityStore
} from './workspace-sender-identity';

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '019c1df7-86b5-769b-bba4-5f7097bfa211';
const INSTALLATION = Object.freeze({
  fromAddress: 'no-reply@mail.installation.example',
  fromDisplayName: 'JooEvents'
});

const databases: Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function openDatabase(): Database {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO workspaces VALUES ('${WORKSPACE_ID}', 'Primary', 'active', 1, 1, 1);
    INSERT INTO users VALUES ('${USER_ID}', 'active', 'Owner', 1, 1, 1);
  `);
  installWorkspaceSenderIdentitySchema(sqlite);
  return sqlite;
}

function tx<Value>(sqlite: Database, work: () => Value): Value {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const value = work();
    sqlite.exec('COMMIT;');
    return value;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

describe('workspace sender identity store', () => {
  test('an unedited workspace reads as version 1 with nothing set', () => {
    const store = new SQLiteWorkspaceSenderIdentityStore(openDatabase());
    expect(store.read(WORKSPACE_ID)).toEqual({
      workspaceId: WORKSPACE_ID,
      headVersion: 1,
      displayName: null,
      replyToAddress: null,
      updatedAt: null
    });
  });

  test('the first update materializes version 2 and later updates advance once', () => {
    const sqlite = openDatabase();
    const store = new SQLiteWorkspaceSenderIdentityStore(sqlite);
    const first = tx(sqlite, () => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 1,
      displayName: 'Nordic Product Days',
      replyToAddress: 'hello@nordic.example',
      updatedAt: '2026-08-15T09:00:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    }));
    expect(first).toEqual({
      kind: 'applied',
      head: {
        workspaceId: WORKSPACE_ID,
        headVersion: 2,
        displayName: 'Nordic Product Days',
        replyToAddress: 'hello@nordic.example',
        updatedAt: '2026-08-15T09:00:00.000Z'
      }
    });
    const second = tx(sqlite, () => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 2,
      displayName: null,
      replyToAddress: null,
      updatedAt: '2026-08-15T10:00:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    }));
    expect(second.kind).toBe('applied');
    expect(second.head.headVersion).toBe(3);
    expect(second.head.displayName).toBeNull();
  });

  test('a stale expectation reports the current head instead of overwriting', () => {
    const sqlite = openDatabase();
    const store = new SQLiteWorkspaceSenderIdentityStore(sqlite);
    tx(sqlite, () => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 1,
      displayName: 'Nordic Product Days',
      replyToAddress: null,
      updatedAt: '2026-08-15T09:00:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    }));
    const stale = tx(sqlite, () => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 1,
      displayName: 'Someone Else',
      replyToAddress: null,
      updatedAt: '2026-08-15T09:30:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    }));
    expect(stale).toEqual({
      kind: 'stale',
      head: {
        workspaceId: WORKSPACE_ID,
        headVersion: 2,
        displayName: 'Nordic Product Days',
        replyToAddress: null,
        updatedAt: '2026-08-15T09:00:00.000Z'
      }
    });
  });

  test('writes require the caller transaction', () => {
    const sqlite = openDatabase();
    const store = new SQLiteWorkspaceSenderIdentityStore(sqlite);
    expect(() => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 1,
      displayName: 'Nordic Product Days',
      replyToAddress: null,
      updatedAt: '2026-08-15T09:00:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    })).toThrow('workspace_sender_identity_transaction_required');
  });

  test('the row itself cannot carry a header-injection byte by any path', () => {
    const sqlite = openDatabase();
    for (const injected of ['Nordic\r\nBcc: attacker@example.test', 'Nordic\nDays']) {
      expect(() => sqlite.query(`
        INSERT INTO workspace_mail_sender_identity (
          workspace_id, head_version, display_name, reply_to_address,
          updated_at, updated_by_actor_key, updated_by_user_id
        ) VALUES (?, 2, ?, NULL, '2026-08-15T09:00:00.000Z', ?, ?)
      `).run(WORKSPACE_ID, injected, `workspace_user:${USER_ID}`, USER_ID)).toThrow();
    }
    expect(() => sqlite.query(`
      INSERT INTO workspace_mail_sender_identity (
        workspace_id, head_version, display_name, reply_to_address,
        updated_at, updated_by_actor_key, updated_by_user_id
      ) VALUES (?, 2, NULL, ?, '2026-08-15T09:00:00.000Z', ?, ?)
    `).run(WORKSPACE_ID, 'a@b.test, c@d.test', `workspace_user:${USER_ID}`, USER_ID)).toThrow();
  });
});

describe('per-send sender presentation resolution', () => {
  test('the resolver reflects the CURRENT head on every call, never a boot snapshot', () => {
    const sqlite = openDatabase();
    const store = new SQLiteWorkspaceSenderIdentityStore(sqlite);
    const resolver = createSQLiteMailSenderPresentationResolver({
      sqlite, workspaceId: WORKSPACE_ID, installation: INSTALLATION
    });
    expect(resolver.resolve()).toEqual({
      fromAddress: 'no-reply@mail.installation.example',
      fromDisplayName: 'JooEvents',
      source: 'installation'
    });
    tx(sqlite, () => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 1,
      displayName: 'Nordic Product Days',
      replyToAddress: 'hello@nordic.example',
      updatedAt: '2026-08-15T09:00:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    }));
    // Same resolver instance: no restart, no recomposition.
    expect(resolver.resolve()).toEqual({
      fromAddress: 'no-reply@mail.installation.example',
      fromDisplayName: 'Nordic Product Days',
      replyToAddress: 'hello@nordic.example',
      source: 'workspace'
    });
  });

  test('the from-address is always the installation\'s, whatever the workspace set', () => {
    const sqlite = openDatabase();
    const store = new SQLiteWorkspaceSenderIdentityStore(sqlite);
    tx(sqlite, () => store.apply({
      workspaceId: WORKSPACE_ID,
      expectedHeadVersion: 1,
      displayName: 'Nordic Product Days',
      replyToAddress: 'hello@nordic.example',
      updatedAt: '2026-08-15T09:00:00.000Z',
      updatedByActorKey: `workspace_user:${USER_ID}`,
      updatedByUserId: USER_ID
    }));
    expect(createSQLiteMailSenderPresentationResolver({
      sqlite, workspaceId: WORKSPACE_ID, installation: INSTALLATION
    }).resolve().fromAddress).toBe('no-reply@mail.installation.example');
  });
});
