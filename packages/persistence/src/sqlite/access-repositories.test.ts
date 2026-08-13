import { afterEach, describe, expect, test } from 'bun:test';
import { createAccessEvaluator } from '@jooevents/application';
import type { Database } from 'bun:sqlite';
import {
  createSQLiteAccessRepositories,
  SQLiteAccessEvidenceError
} from './access-repositories';
import { openSQLite, type OpenSQLiteResult } from './database';

const now = '2026-08-12T06:00:00.000Z';
const nowMs = Date.parse(now);
const opened: OpenSQLiteResult[] = [];

function fixture(): OpenSQLiteResult {
  const result = openSQLite(':memory:');
  opened.push(result);
  const sqlite = result.sqlite;
  sqlite.query(`
    insert into workspaces (id, name, state, created_at, updated_at, version)
    values (?, ?, 'active', ?, ?, 1), (?, ?, 'active', ?, ?, 1)
  `).run(
    'workspace_summit',
    'Summit Operations',
    nowMs,
    nowMs,
    'workspace_other',
    'Other Workspace',
    nowMs,
    nowMs
  );
  sqlite.query(`
    insert into events (id, workspace_id, name, created_at, updated_at)
    values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
  `).run(
    'event_summit',
    'workspace_summit',
    'Summit 2026',
    nowMs,
    nowMs,
    'event_other',
    'workspace_other',
    'Other 2026',
    nowMs,
    nowMs
  );
  sqlite.query(`
    insert into users (id, status, display_name, created_at, updated_at, version)
    values (?, 'active', ?, ?, ?, 1), (?, 'active', ?, ?, ?, 1)
  `).run('user_ada', 'Ada Lovelace', nowMs, nowMs, 'user_admin', 'Workspace Admin', nowMs, nowMs);
  sqlite.query(`
    insert into workspace_memberships
      (id, workspace_id, user_id, status, approved_by_user_id, approved_at,
       created_at, updated_at, version)
    values (?, ?, ?, 'active', ?, ?, ?, ?, 7)
  `).run(
    'membership_ada',
    'workspace_summit',
    'user_ada',
    'user_admin',
    nowMs - 2_000,
    nowMs - 10_000,
    nowMs - 1_000
  );
  return result;
}

function insertRole(input: {
  readonly sqlite: Database;
  readonly id: string;
  readonly workspaceId?: string;
  readonly name?: string;
  readonly archivedAt?: number;
}): void {
  input.sqlite.query(`
    insert into roles
      (id, workspace_id, name, description, archived_at, created_at, updated_at, version)
    values (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    input.id,
    input.workspaceId ?? 'workspace_summit',
    input.name ?? input.id,
    `${input.name ?? input.id} description`,
    input.archivedAt ?? null,
    nowMs,
    nowMs
  );
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
});

describe('SQLite identity/access evidence repositories', () => {
  test('loads the exact current membership including lifecycle evidence and revision', async () => {
    const db = fixture();
    const repositories = createSQLiteAccessRepositories(db.sqlite);

    expect(await repositories.memberships.find('workspace_summit', 'user_ada')).toEqual({
      id: 'membership_ada',
      workspaceId: 'workspace_summit',
      userId: 'user_ada',
      status: 'active',
      approvedByUserId: 'user_admin',
      approvedAt: '2026-08-12T05:59:58.000Z',
      createdAt: '2026-08-12T05:59:50.000Z',
      updatedAt: '2026-08-12T05:59:59.000Z',
      version: 7
    });
    expect(await repositories.memberships.find('workspace_other', 'user_ada')).toBeUndefined();
    expect(await repositories.memberships.find('workspace_summit', 'user_admin')).toBeUndefined();

    db.sqlite.query(`
      update workspace_memberships
         set status = 'suspended', updated_at = ?, version = version + 1
       where id = 'membership_ada'
    `).run(nowMs + 1_000);
    expect(await repositories.memberships.find('workspace_summit', 'user_ada')).toMatchObject({
      status: 'suspended',
      updatedAt: '2026-08-12T06:00:01.000Z',
      version: 8
    });
  });

  test('returns complete authorization evidence in canonical order without applying expiry policy', async () => {
    const db = fixture();
    insertRole({ sqlite: db.sqlite, id: 'role_zeta', name: 'Zeta' });
    insertRole({
      sqlite: db.sqlite,
      id: 'role_alpha',
      name: 'Alpha',
      archivedAt: nowMs - 20_000
    });
    db.sqlite.query('insert into role_permissions (role_id, permission_id) values (?, ?), (?, ?)')
      .run('role_zeta', 'schedule.read', 'role_zeta', 'event.read');
    db.sqlite.query(`
      insert into role_assignments
        (id, user_id, role_id, workspace_id, scope_kind, event_id,
         assigned_by_user_id, assigned_at, expires_at, version)
      values (?, ?, ?, ?, 'workspace', null, ?, ?, null, 1),
             (?, ?, ?, ?, 'event', ?, ?, ?, ?, 1)
    `).run(
      'assignment_zeta',
      'user_ada',
      'role_zeta',
      'workspace_summit',
      'user_admin',
      nowMs - 8_000,
      'assignment_alpha',
      'user_ada',
      'role_zeta',
      'workspace_summit',
      'event_summit',
      'user_admin',
      nowMs - 9_000,
      nowMs - 1_000
    );
    db.sqlite.query(`
      insert into permission_overrides
        (id, user_id, permission_id, effect, workspace_id, scope_kind, event_id,
         reason, decided_by_user_id, decided_at, expires_at, version)
      values (?, ?, 'event.read', 'grant', ?, 'workspace', null, ?, ?, ?, null, 1),
             (?, ?, 'event.read', 'deny', ?, 'event', ?, ?, ?, ?, ?, 1)
    `).run(
      'override_zeta',
      'user_ada',
      'workspace_summit',
      'Temporary broad access',
      'user_admin',
      nowMs - 7_000,
      'override_alpha',
      'user_ada',
      'workspace_summit',
      'event_summit',
      'Conflict restriction',
      'user_admin',
      nowMs - 6_000,
      nowMs - 1_000
    );

    const { authorization } = createSQLiteAccessRepositories(db.sqlite);
    const roles = await authorization.listRoles('workspace_summit');
    const assignments = await authorization.listAssignments('workspace_summit', 'user_ada');
    const overrides = await authorization.listOverrides('workspace_summit', 'user_ada');

    expect(roles.map((role) => role.id)).toEqual(['role_alpha', 'role_zeta']);
    expect(roles[0]).toMatchObject({
      id: 'role_alpha',
      permissionIds: [],
      archivedAt: '2026-08-12T05:59:40.000Z'
    });
    expect(roles[1]?.permissionIds).toEqual(['event.read', 'schedule.read']);
    expect(assignments.map((assignment) => assignment.id)).toEqual([
      'assignment_alpha',
      'assignment_zeta'
    ]);
    expect(assignments[0]).toMatchObject({
      scope: { kind: 'event', workspaceId: 'workspace_summit', eventId: 'event_summit' },
      expiresAt: '2026-08-12T05:59:59.000Z'
    });
    expect(overrides.map((override) => override.id)).toEqual(['override_alpha', 'override_zeta']);
    expect(overrides[0]).toMatchObject({
      effect: 'deny',
      scope: { kind: 'event', workspaceId: 'workspace_summit', eventId: 'event_summit' },
      expiresAt: '2026-08-12T05:59:59.000Z'
    });
    expect(Object.isFrozen(roles)).toBe(true);
    expect(Object.isFrozen(roles[1]?.permissionIds)).toBe(true);
    expect(Object.isFrozen(assignments)).toBe(true);
    expect(Object.isFrozen(overrides)).toBe(true);
  });

  test('supports the shared evaluator and re-reads membership revocation instead of caching authority', async () => {
    const db = fixture();
    insertRole({ sqlite: db.sqlite, id: 'role_event_reader', name: 'Event Reader' });
    db.sqlite.query('insert into role_permissions (role_id, permission_id) values (?, ?)')
      .run('role_event_reader', 'event.read');
    db.sqlite.query(`
      insert into role_assignments
        (id, user_id, role_id, workspace_id, scope_kind, event_id,
         assigned_by_user_id, assigned_at, version)
      values (?, ?, ?, ?, 'event', ?, ?, ?, 1)
    `).run(
      'assignment_event_reader',
      'user_ada',
      'role_event_reader',
      'workspace_summit',
      'event_summit',
      'user_admin',
      nowMs
    );
    const repositories = createSQLiteAccessRepositories(db.sqlite);
    const evaluate = createAccessEvaluator({ ...repositories, now: () => now });
    const input = {
      userId: 'user_ada',
      permissionId: 'event.read' as const,
      scope: { kind: 'event' as const, workspaceId: 'workspace_summit', eventId: 'event_summit' }
    };

    expect(await evaluate(input)).toMatchObject({ allowed: true, code: 'granted_by_role' });
    db.sqlite.query(`
      update workspace_memberships
         set status = 'suspended', updated_at = ?, version = version + 1
       where id = 'membership_ada'
    `).run(nowMs + 1_000);
    expect(await evaluate(input)).toMatchObject({ allowed: false, code: 'membership_inactive' });
  });

  test('fails closed when a stored role names a permission outside the deployed catalog', async () => {
    const db = fixture();
    insertRole({ sqlite: db.sqlite, id: 'role_corrupt', name: 'Corrupt' });
    db.sqlite.query('insert into role_permissions (role_id, permission_id) values (?, ?)')
      .run('role_corrupt', 'event.superuser');

    const promise = createSQLiteAccessRepositories(db.sqlite).authorization.listRoles(
      'workspace_summit'
    );
    await expect(promise).rejects.toBeInstanceOf(SQLiteAccessEvidenceError);
    await expect(promise).rejects.toMatchObject({ code: 'malformed_access_evidence' });
  });

  test('fails closed when event- or role-scope evidence crosses workspace ownership', async () => {
    const db = fixture();
    insertRole({ sqlite: db.sqlite, id: 'role_summit', name: 'Summit role' });
    db.sqlite.query(`
      insert into role_assignments
        (id, user_id, role_id, workspace_id, scope_kind, event_id,
         assigned_by_user_id, assigned_at, version)
      values (?, ?, ?, ?, 'event', ?, ?, ?, 1)
    `).run(
      'assignment_crossed_event',
      'user_ada',
      'role_summit',
      'workspace_summit',
      'event_other',
      'user_admin',
      nowMs
    );

    await expect(
      createSQLiteAccessRepositories(db.sqlite).authorization.listAssignments(
        'workspace_summit',
        'user_ada'
      )
    ).rejects.toMatchObject({ code: 'malformed_access_evidence' });
  });

  test('preserves absent epoch-one access attribution without fabricating a user', async () => {
    const db = fixture();
    insertRole({ sqlite: db.sqlite, id: 'role_bootstrap', name: 'Bootstrap role' });
    db.sqlite.query(`
      insert into role_assignments
        (id, user_id, role_id, workspace_id, scope_kind, event_id,
         assigned_by_user_id, assigned_at, version)
      values (?, ?, ?, ?, 'workspace', null, null, ?, 1)
    `).run(
      'assignment_bootstrap',
      'user_ada',
      'role_bootstrap',
      'workspace_summit',
      nowMs
    );
    db.sqlite.query(`
      insert into permission_overrides
        (id, user_id, permission_id, effect, workspace_id, scope_kind, event_id,
         reason, decided_by_user_id, decided_at, version)
      values (?, ?, 'event.read', 'deny', ?, 'workspace', null, ?, null, ?, 1)
    `).run(
      'override_without_actor',
      'user_ada',
      'workspace_summit',
      'Retained restriction without a row-level user actor',
      nowMs
    );

    const authorization = createSQLiteAccessRepositories(db.sqlite).authorization;
    const assignments = await authorization.listAssignments('workspace_summit', 'user_ada');
    const overrides = await authorization.listOverrides('workspace_summit', 'user_ada');
    expect(assignments[0]).not.toHaveProperty('assignedByUserId');
    expect(overrides[0]).not.toHaveProperty('decidedByUserId');
  });
});
