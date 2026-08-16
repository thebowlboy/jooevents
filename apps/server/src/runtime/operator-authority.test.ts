import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseEventId,
  parseContractVersion,
  parseInstant,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type ResolvedScope
} from '@jooevents/kernel';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  openSQLite,
  SQLiteOperatorAuthorityTransactionError,
  type OpenSQLiteResult
} from '@jooevents/persistence';
import type { InvocationEvidence } from '@jooevents/application';
import { createSQLiteOperatorAuthorityComposition } from './operator-authority';

const now = parseInstant('2026-08-12T06:00:00.000Z');
const nowMs = Date.parse(now);
const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678921');
const userId = parseUserId('018f7d5a-4b3c-7abc-8def-012345678922');
const membershipId = parseMembershipId('018f7d5a-4b3c-7abc-8def-012345678923');
const eventId = parseEventId('018f7d5a-4b3c-7abc-8def-012345678924');
const missingEventId = parseEventId('018f7d5a-4b3c-7abc-8def-012345678925');
const opened: OpenSQLiteResult[] = [];

function fixture(): OpenSQLiteResult {
  const result = openSQLite(':memory:');
  opened.push(result);
  const sqlite = result.sqlite;
  sqlite.query(`
    insert into workspaces (id, name, state, created_at, updated_at, version)
    values (?, 'Authority Workspace', 'active', ?, ?, 1)
  `).run(workspaceId, nowMs, nowMs);
  sqlite.query(`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values ('auth_operator', 'Operator', 'operator@example.test', 1, ?, ?)
  `).run(nowMs, nowMs);
  sqlite.query(`
    insert into users (id, status, display_name, created_at, updated_at, version)
    values (?, 'active', 'Operator', ?, ?, 1)
  `).run(userId, nowMs, nowMs);
  sqlite.query(`
    insert into auth_user_links
      (auth_user_id, user_id, provisioning_state, attempts, created_at, updated_at)
    values ('auth_operator', ?, 'ready', 1, ?, ?)
  `).run(userId, nowMs, nowMs);
  sqlite.query(`
    insert into auth_sessions
      (id, token, user_id, expires_at, created_at, updated_at)
    values ('session_current', 'never-exposed-token', 'auth_operator', ?, ?, ?)
  `).run(nowMs + 60_000, nowMs, nowMs);
  sqlite.query(`
    insert into workspace_memberships
      (id, workspace_id, user_id, status, approved_at, created_at, updated_at, version)
    values (?, ?, ?, 'active', ?, ?, ?, 1)
  `).run(membershipId, workspaceId, userId, nowMs, nowMs, nowMs);
  sqlite.query(`
    insert into roles
      (id, workspace_id, name, description, created_at, updated_at, version)
    values ('role_reader', ?, 'Reader', 'Reads events', ?, ?, 1)
  `).run(workspaceId, nowMs, nowMs);
  sqlite.query(`
    insert into role_permissions (role_id, permission_id)
    values ('role_reader', 'event.read')
  `).run();
  sqlite.query(`
    insert into role_assignments
      (id, user_id, role_id, workspace_id, scope_kind, event_id, assigned_at, version)
    values ('assignment_reader', ?, 'role_reader', ?, 'workspace', null, ?, 1)
  `).run(userId, workspaceId, nowMs);
  return result;
}

function insertEventScopeRoot(sqlite: OpenSQLiteResult['sqlite']): void {
  sqlite.query(`
    insert into event_spine_workspace_sets (workspace_id, version, current_event_id)
    values (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    insert into event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) values (?, ?, 'Authority Event', 'UTC', '2026-10-01', '2026-10-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, nowMs, 'a'.repeat(64));
  sqlite.query(`
    insert into event_spine_scope_roots (workspace_id, event_id) values (?, ?)
  `).run(workspaceId, eventId);
  sqlite.query(`
    update event_spine_workspace_sets
       set version = 2, current_event_id = ?
     where workspace_id = ? and version = 1 and current_event_id is null
  `).run(eventId, workspaceId);
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('SQLite operator authority server composition', () => {
  test('separates ordinary current reads from transaction-required rechecks on one handle', async () => {
    const db = fixture();
    const lane = parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: { key: 'event.read', version: 1 }
    });
    const composition = createSQLiteOperatorAuthorityComposition({
      sqlite: db.sqlite,
      workspaceId,
      policies: Object.freeze([{ policy: lane.policy, permissionId: 'event.read' as const }]),
      clock: Object.freeze({ now: () => now })
    });
    const evidence: Extract<InvocationEvidence, { readonly kind: 'operator' }> = Object.freeze({
      kind: 'operator',
      surface: 'operator_http',
      client: Object.freeze({ key: 'server-authority-test' }),
      sessionHandle: 'session_current'
    });
    const scope: ResolvedScope = Object.freeze({
      workspaceId,
      subjects: Object.freeze([]),
      resolutionEvidenceIds: Object.freeze(['server-workspace-root'])
    });
    const input = Object.freeze({
      operation: Object.freeze({ name: 'event.read', version: 1, effect: 'read' as const }),
      evidence,
      lane,
      scope,
      evaluatedAt: now
    });

    expect((await composition.resolver.resolve(input)).kind).toBe('authorized');
    expect(() => composition.transactionResolver.resolve(input))
      .toThrow(SQLiteOperatorAuthorityTransactionError);
    expect(() => composition.effectRecheckSource.resolveAuthority(input))
      .toThrow(SQLiteOperatorAuthorityTransactionError);

    db.sqlite.exec('BEGIN IMMEDIATE;');
    try {
      db.sqlite.query(`
        update workspace_memberships
           set status = 'suspended', version = version + 1, updated_at = ?
         where id = ?
      `).run(nowMs + 1, membershipId);
      expect(await composition.transactionResolver.resolve(input)).toEqual({
        kind: 'denied',
        reason: 'revoked'
      });
    } finally {
      db.sqlite.exec('ROLLBACK;');
    }

    expect((await composition.resolver.resolve(input)).kind).toBe('authorized');
  });

  test('revalidates a server-owned Event scope through the same outer and transaction handle', async () => {
    const db = fixture();
    db.sqlite.query(`
      insert into permission_overrides (
        id, user_id, permission_id, effect, workspace_id, scope_kind,
        event_id, reason, decided_by_user_id, decided_at, version
      ) values (
        'override_program_vocabulary', ?, 'program.vocabulary.manage', 'grant', ?,
        'workspace', null, 'Explicit Program Vocabulary grant', ?, ?, 1
      )
    `).run(userId, workspaceId, userId, nowMs);

    const policy = Object.freeze({
      key: 'authority.program_vocabulary.manage',
      version: parseContractVersion(1)
    });
    const lane = parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy
    });
    const composition = createSQLiteOperatorAuthorityComposition({
      sqlite: db.sqlite,
      workspaceId,
      policies: Object.freeze([{ policy, permissionId: 'program.vocabulary.manage' as const }]),
      clock: Object.freeze({ now: () => now }),
      eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource()
    });
    const evidence: Extract<InvocationEvidence, { readonly kind: 'operator' }> = Object.freeze({
      kind: 'operator',
      surface: 'operator_http',
      client: Object.freeze({ key: 'server-program-vocabulary-authority-test' }),
      sessionHandle: 'session_current'
    });
    const scope: ResolvedScope = Object.freeze({
      workspaceId,
      eventId,
      subjects: Object.freeze([{ kind: 'event' as const, id: eventId }]),
      resolutionEvidenceIds: Object.freeze([`server-current-event:${eventId}`])
    });
    const input = Object.freeze({
      operation: Object.freeze({
        name: 'program_vocabulary.create.draft',
        version: 1,
        effect: 'draft' as const
      }),
      evidence,
      lane,
      scope,
      evaluatedAt: now
    });

    expect(await composition.resolver.resolve(input)).toEqual({
      kind: 'denied',
      reason: 'missing'
    });

    db.sqlite.exec('BEGIN IMMEDIATE;');
    try {
      insertEventScopeRoot(db.sqlite);
      const inner = await composition.transactionResolver.resolve(input);
      expect(inner).toMatchObject({
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId },
          grants: [{ kind: 'permission', key: 'program.vocabulary.manage' }]
        }
      });
      if (inner.kind === 'authorized') {
        expect(inner.authority.evidenceIds).toContain(`event-spine-root:${eventId}@1`);
        expect(inner.authority.evidenceIds).toContain(`event-subject:${eventId}`);
      }
    } finally {
      db.sqlite.exec('ROLLBACK;');
    }

    expect(await composition.resolver.resolve(input)).toEqual({
      kind: 'denied',
      reason: 'missing'
    });

    db.sqlite.exec('BEGIN IMMEDIATE;');
    insertEventScopeRoot(db.sqlite);
    db.sqlite.exec('COMMIT;');
    expect((await composition.resolver.resolve(input)).kind).toBe('authorized');
    expect(await composition.resolver.resolve(Object.freeze({
      ...input,
      scope: Object.freeze({
        ...scope,
        eventId: missingEventId,
        subjects: Object.freeze([{ kind: 'event' as const, id: missingEventId }])
      })
    }))).toEqual({ kind: 'denied', reason: 'missing' });
  });
});
