import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  planSpeakerLineupMutation,
  resolveSpeakerLineupPlanningInput,
  SpeakerLineupPlanningError
} from '@jooevents/engagement';
import { installEventSpineSchema } from './event-spine';
import {
  installSpeakerLineupSchema,
  SQLiteSpeakerLineupError,
  SQLiteSpeakerLineupRepository
} from './speaker-lineup';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfd101';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfd201';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfd301';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfd302';
const categoryId = '019c1df7-86b5-769b-bba4-5f7097bfd401';
const scope = { workspaceId, eventId };
const occurredAt = '2026-08-18T08:00:00.000Z';

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
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
  `);
  installEventSpineSchema(sqlite);
  installSpeakerLineupSchema(sqlite);
  sqlite.query(`INSERT INTO workspaces(id,name,state,created_at,updated_at,version)
    VALUES (?,'Workspace','active',1,1,1)`).run(workspaceId);
  sqlite.query(`INSERT INTO users(id,status,display_name,created_at,updated_at,version)
    VALUES (?,'active','Organizer',1,1,1)`).run(userId);
  sqlite.query(`INSERT INTO event_spine_workspace_sets(workspace_id,version,current_event_id)
    VALUES (?,1,NULL)`).run(workspaceId);
  sqlite.query(`INSERT INTO event_spine_heads(
    workspace_id,id,name,timezone,start_date,end_date,version,created_by_user_id,
    created_at_ms,create_plan_digest_sha256
  ) VALUES (?,?,'Event','UTC','2026-11-01','2026-11-02',1,?,1,?)`)
    .run(workspaceId, eventId, userId, 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots(workspace_id,event_id) VALUES (?,?)`)
    .run(workspaceId, eventId);
  return { sqlite, repository: new SQLiteSpeakerLineupRepository(sqlite) };
}

function commit(
  fx: ReturnType<typeof fixture>,
  authorInput: unknown,
  newCategoryId?: string
) {
  const plan = planSpeakerLineupMutation({
    planningInput: resolveSpeakerLineupPlanningInput({
      authorInput,
      scope,
      actorUserId: userId,
      occurredAt,
      ...(newCategoryId === undefined ? {} : { categoryId: newCategoryId })
    }),
    lineups: fx.repository
  });
  fx.sqlite.exec('BEGIN IMMEDIATE');
  const saved = fx.repository.applySpeakerLineupPlan(plan);
  fx.sqlite.exec('COMMIT');
  return { plan, saved };
}

describe('SQLite speaker lineup repository', () => {
  test('keeps one person-level entry and applies category, visibility, and global order atomically', () => {
    const fx = fixture();
    try {
      expect(fx.repository.readSpeakerLineupSnapshot(scope)).toMatchObject({
        version: 1,
        categories: [],
        entries: []
      });
      fx.sqlite.exec('BEGIN IMMEDIATE');
      fx.repository.ensureEntries(scope, [personA, personB, personA]);
      fx.sqlite.exec('COMMIT');
      expect(fx.repository.readSpeakerLineupSnapshot(scope)?.entries.map((entry) => entry.personId))
        .toEqual([personA, personB]);

      commit(fx, { action: 'add_category', expectedLineupVersion: 2, name: 'Keynotes' }, categoryId);
      commit(fx, {
        action: 'set_category', expectedLineupVersion: 3,
        personId: personA, categoryId
      });
      commit(fx, {
        action: 'set_visibility', expectedLineupVersion: 4,
        personId: personB, publiclyVisible: false
      });
      const { plan, saved } = commit(fx, {
        action: 'reorder', expectedLineupVersion: 5, personIds: [personB, personA]
      });

      expect(saved).toMatchObject({
        version: 6,
        categories: [{ id: categoryId, name: 'Keynotes', position: 0 }],
        entries: [
          { personId: personB, position: 0, publiclyVisible: false, categoryId: null },
          { personId: personA, position: 1, publiclyVisible: true, categoryId }
        ]
      });
      expect(fx.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);

      fx.sqlite.exec('BEGIN IMMEDIATE');
      expect(() => fx.repository.applySpeakerLineupPlan(plan))
        .toThrow(new SQLiteSpeakerLineupError('stale_lineup'));
      fx.sqlite.exec('ROLLBACK');
      expect(fx.repository.readSpeakerLineupSnapshot(scope)).toEqual(saved);
    } finally {
      fx.sqlite.close();
    }
  });

  test('refuses incomplete order and duplicate category names before writing', () => {
    const fx = fixture();
    try {
      fx.sqlite.exec('BEGIN IMMEDIATE');
      fx.repository.ensureEntries(scope, [personA, personB]);
      fx.sqlite.exec('COMMIT');
      expect(() => planSpeakerLineupMutation({
        planningInput: resolveSpeakerLineupPlanningInput({
          authorInput: { action: 'reorder', expectedLineupVersion: 2, personIds: [personA] },
          scope, actorUserId: userId, occurredAt
        }),
        lineups: fx.repository
      })).toThrow(new SpeakerLineupPlanningError('invalid_order'));
      commit(fx, { action: 'add_category', expectedLineupVersion: 2, name: 'Keynotes' }, categoryId);
      expect(() => planSpeakerLineupMutation({
        planningInput: resolveSpeakerLineupPlanningInput({
          authorInput: { action: 'add_category', expectedLineupVersion: 3, name: 'keynotes' },
          scope, actorUserId: userId, occurredAt,
          categoryId: '019c1df7-86b5-769b-bba4-5f7097bfd402'
        }),
        lineups: fx.repository
      })).toThrow(new SpeakerLineupPlanningError('category_name_exists'));
    } finally {
      fx.sqlite.close();
    }
  });
});
