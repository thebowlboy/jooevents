import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type ResolvedScope
} from '@jooevents/kernel';
import {
  createSQLiteCurrentOperatorSessionRepository,
  createSQLiteOperatorScopeRelationshipValidator,
  createSQLiteTransactionBoundOperatorAuthorityPersistence,
  SQLiteOperatorAuthorityTransactionError,
  type SQLiteOperatorEventRelationshipSource
} from './operator-authority-repositories';
import { openSQLite, type OpenSQLiteResult } from './database';

const now = parseInstant('2026-08-12T06:00:00.000Z');
const nowMs = Date.parse(now);
const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678911');
const otherWorkspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678912');
const userId = parseUserId('018f7d5a-4b3c-7abc-8def-012345678913');
const otherUserId = parseUserId('018f7d5a-4b3c-7abc-8def-012345678914');
const eventId = parseEventId('018f7d5a-4b3c-7abc-8def-012345678915');
const opened: OpenSQLiteResult[] = [];

function fixture(): OpenSQLiteResult {
  const result = openSQLite(':memory:');
  opened.push(result);
  const sqlite = result.sqlite;
  sqlite.query(`
    insert into workspaces (id, name, state, created_at, updated_at, version)
    values (?, 'Authority Workspace', 'active', ?, ?, 1),
           (?, 'Other Workspace', 'active', ?, ?, 1)
  `).run(workspaceId, nowMs, nowMs, otherWorkspaceId, nowMs, nowMs);
  sqlite.query(`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values ('auth_operator', 'Operator', 'operator@example.test', 1, ?, ?)
  `).run(nowMs, nowMs);
  sqlite.query(`
    insert into users (id, status, display_name, created_at, updated_at, version)
    values (?, 'active', 'Operator', ?, ?, 1),
           (?, 'active', 'Other User', ?, ?, 1)
  `).run(userId, nowMs, nowMs, otherUserId, nowMs, nowMs);
  sqlite.query(`
    insert into auth_user_links
      (auth_user_id, user_id, provisioning_state, attempts, created_at, updated_at)
    values ('auth_operator', ?, 'ready', 1, ?, ?)
  `).run(userId, nowMs, nowMs);
  sqlite.query(`
    insert into auth_sessions
      (id, token, user_id, expires_at, created_at, updated_at)
    values ('session_current', 'credential-secret-never-returned', 'auth_operator', ?, ?, ?),
           ('session_expired', 'expired-credential-secret', 'auth_operator', ?, ?, ?)
  `).run(nowMs + 60_000, nowMs, nowMs, nowMs, nowMs - 60_000, nowMs - 60_000);
  sqlite.query(`
    insert into workspace_memberships
      (id, workspace_id, user_id, status, approved_at, created_at, updated_at, version)
    values (?, ?, ?, 'active', ?, ?, ?, 3),
           (?, ?, ?, 'active', ?, ?, ?, 1)
  `).run(
    '018f7d5a-4b3c-7abc-8def-012345678916',
    workspaceId,
    userId,
    nowMs,
    nowMs,
    nowMs,
    '018f7d5a-4b3c-7abc-8def-012345678917',
    workspaceId,
    otherUserId,
    nowMs,
    nowMs,
    nowMs
  );
  return result;
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('SQLite operator authority evidence', () => {
  test('resolves only an unexpired session with its exact ready application-user link', async () => {
    const db = fixture();
    const sessions = createSQLiteCurrentOperatorSessionRepository(db.sqlite);
    const current = await sessions.resolveCurrent({
      sessionHandle: 'session_current',
      evaluatedAt: now
    });

    expect(current).toMatchObject({
      kind: 'current',
      session: {
        sessionId: 'session_current',
        authUserId: 'auth_operator',
        userId,
        expiresAt: parseInstant('2026-08-12T06:01:00.000Z')
      }
    });
    if (current.kind !== 'current') return;
    expect(current.session.evidenceIds).toHaveLength(2);
    expect(current.session.evidenceIds[0]).toMatch(/^auth-session:sha256:[a-f0-9]{64}@/);
    expect(current.session.evidenceIds[1]).toMatch(/^auth-user-link:sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(current)).not.toContain('credential-secret');
    expect(await sessions.resolveCurrent({ sessionHandle: 'session_expired', evaluatedAt: now }))
      .toEqual({ kind: 'denied', reason: 'revoked' });
    expect(await sessions.resolveCurrent({ sessionHandle: 'session_missing', evaluatedAt: now }))
      .toEqual({ kind: 'denied', reason: 'missing' });

    db.sqlite.query(`
      update auth_user_links set provisioning_state = 'pending', updated_at = ?
       where auth_user_id = 'auth_operator'
    `).run(nowMs + 1);
    expect(await sessions.resolveCurrent({ sessionHandle: 'session_current', evaluatedAt: now }))
      .toEqual({ kind: 'denied', reason: 'missing' });

    db.sqlite.query(`
      update auth_user_links set provisioning_state = 'ready', updated_at = ?
       where auth_user_id = 'auth_operator'
    `).run(nowMs + 2);
    db.sqlite.query('update users set status = \'suspended\' where id = ?').run(userId);
    expect(await sessions.resolveCurrent({ sessionHandle: 'session_current', evaluatedAt: now }))
      .toEqual({ kind: 'denied', reason: 'revoked' });
  });

  test('uses an injected event relationship proof and fails closed for unsupported subjects', async () => {
    const db = fixture();
    let receivedSameHandle = false;
    const validator = createSQLiteOperatorScopeRelationshipValidator({
      sqlite: db.sqlite,
      workspaceId,
      eventRelationships: Object.freeze({
        validateEvent(
          input: Parameters<SQLiteOperatorEventRelationshipSource['validateEvent']>[0]
        ) {
          receivedSameHandle = input.sqlite === db.sqlite;
          return input.workspaceId === workspaceId && input.eventId === eventId
            ? Object.freeze({
                kind: 'valid' as const,
                evidenceIds: Object.freeze(['ephemeral-event-head:7'])
              })
            : Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
        }
      })
    });
    const eventScope: ResolvedScope = Object.freeze({
      workspaceId,
      eventId,
      subjects: Object.freeze([{ kind: 'event' as const, id: eventId }]),
      resolutionEvidenceIds: Object.freeze(['event-resolver'])
    });

    expect(await validator.validate({ userId, scope: eventScope, evaluatedAt: now })).toEqual({
      kind: 'valid',
      evidenceIds: [
        `workspace-root:${workspaceId}`,
        'ephemeral-event-head:7',
        `event-root:${eventId}`,
        `event-subject:${eventId}`
      ]
    });
    expect(receivedSameHandle).toBe(true);
    expect(db.sqlite.query('select count(*) as count from events').get()).toEqual({ count: 0 });

    expect(await validator.validate({
      userId,
      scope: Object.freeze({
        ...eventScope,
        subjects: Object.freeze([{
          kind: 'domain' as const,
          domain: 'program',
          entity: 'room',
          id: 'room_1'
        }])
      }),
      evaluatedAt: now
    })).toEqual({ kind: 'denied', reason: 'cross_scope' });

    expect(await validator.validate({
      userId,
      scope: Object.freeze({ ...eventScope, workspaceId: otherWorkspaceId }),
      evaluatedAt: now
    })).toEqual({ kind: 'denied', reason: 'cross_scope' });
  });

  test('transaction-bound readers reject calls outside an active SQLite transaction', async () => {
    const db = fixture();
    const persistence = createSQLiteTransactionBoundOperatorAuthorityPersistence({
      sqlite: db.sqlite,
      workspaceId
    });
    expect(() => persistence.assertInTransaction()).toThrow(SQLiteOperatorAuthorityTransactionError);
    expect(() => persistence.sessions.resolveCurrent({
      sessionHandle: 'session_current',
      evaluatedAt: now
    })).toThrow(SQLiteOperatorAuthorityTransactionError);
    expect(() => persistence.memberships.find(workspaceId, userId))
      .toThrow(SQLiteOperatorAuthorityTransactionError);

    db.sqlite.exec('BEGIN IMMEDIATE;');
    try {
      expect(await persistence.memberships.find(workspaceId, userId)).toMatchObject({
        status: 'active',
        version: 3
      });
    } finally {
      db.sqlite.exec('ROLLBACK;');
    }
  });
});
