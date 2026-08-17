import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQLiteAirtableManagedSnapshotSource } from './airtable-managed-snapshot';

const workspaceId = '019c30db-4e00-7000-8000-000000000001';
const connectionId = '019c30db-4e00-7000-8000-000000000002';
const databases: Database[] = [];

function database(): Database {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe('SQLite managed Airtable snapshot source', () => {
  test('pages by stable identity and projects readable event values', async () => {
    const sqlite = database();
    sqlite.exec(`
      CREATE TABLE event_spine_heads (
        workspace_id TEXT, id TEXT, name TEXT, start_date TEXT, end_date TEXT, version INTEGER
      );
      CREATE TABLE event_settings_companions (
        workspace_id TEXT, event_id TEXT, location TEXT
      );
    `);
    const insert = sqlite.query(`INSERT INTO event_spine_heads VALUES (?,?,?,?,?,1)`);
    for (let ordinal = 1; ordinal <= 11; ordinal += 1) {
      insert.run(
        workspaceId,
        `019c30db-4e00-7000-8000-${String(ordinal).padStart(12, '0')}`,
        `JooConf day ${ordinal}`,
        '2027-02-20',
        '2027-02-21'
      );
    }
    sqlite.query(`INSERT INTO event_settings_companions VALUES (?,?,?)`).run(
      workspaceId,
      '019c30db-4e00-7000-8000-000000000001',
      'Harbour Hall'
    );
    const source = new SQLiteAirtableManagedSnapshotSource(sqlite, workspaceId);
    const first = await source.listPage({ connectionId, tableKey: 'events', limit: 10 });
    expect(first.records).toHaveLength(10);
    expect(first.nextCursor).toBe('019c30db-4e00-7000-8000-000000000010');
    expect(first.records[0]).toEqual({
      subjectKey: '019c30db-4e00-7000-8000-000000000001',
      fields: {
        event: 'JooConf day 1',
        starts: '2027-02-20T00:00:00.000Z',
        ends: '2027-02-21T00:00:00.000Z',
        venue: 'Harbour Hall',
        jooevents_id: '019c30db-4e00-7000-8000-000000000001'
      }
    });
    if (!first.nextCursor) throw new Error('expected pagination cursor');
    const second = await source.listPage({
      connectionId,
      tableKey: 'events',
      cursor: first.nextCursor,
      limit: 10
    });
    expect(second.records.map((record) => record.subjectKey)).toEqual([
      '019c30db-4e00-7000-8000-000000000011'
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  test('projects task status without contact or review fields', async () => {
    const sqlite = database();
    sqlite.exec(`
      CREATE TABLE task_assignments (
        workspace_id TEXT, event_id TEXT, id TEXT, task_definition_revision_id TEXT,
        person_id TEXT, state TEXT, assignment_json TEXT, version INTEGER
      );
      CREATE TABLE task_definition_revisions (
        workspace_id TEXT, event_id TEXT, revision_id TEXT, deadline_id TEXT, revision_json TEXT
      );
      CREATE TABLE deadlines (
        workspace_id TEXT, event_id TEXT, id TEXT, effective_at_ms INTEGER
      );
      CREATE TABLE event_spine_heads (workspace_id TEXT, id TEXT, name TEXT);
      CREATE TABLE participant_identity_family (
        person_id TEXT, display_name TEXT, display_email TEXT
      );
    `);
    const eventId = '019c30db-4e00-7000-8000-000000000003';
    const assignmentId = '019c30db-4e00-7000-8000-000000000004';
    const revisionId = '019c30db-4e00-7000-8000-000000000005';
    const deadlineId = '019c30db-4e00-7000-8000-000000000006';
    const personId = '019c30db-4e00-7000-8000-000000000007';
    sqlite.query(`INSERT INTO event_spine_heads VALUES (?,?,?)`).run(workspaceId, eventId, 'JooConf');
    sqlite.query(`INSERT INTO deadlines VALUES (?,?,?,?)`).run(
      workspaceId, eventId, deadlineId, Date.parse('2027-02-20T16:00:00.000Z')
    );
    sqlite.query(`INSERT INTO task_definition_revisions VALUES (?,?,?,?,?)`).run(
      workspaceId, eventId, revisionId, deadlineId, JSON.stringify({ name: 'Confirm slides' })
    );
    sqlite.query(`INSERT INTO participant_identity_family VALUES (?,?,?)`).run(
      personId, 'Ada Lovelace', 'private@example.test'
    );
    sqlite.query(`INSERT INTO task_assignments VALUES (?,?,?,?,?,?,?,?)`).run(
      workspaceId, eventId, assignmentId, revisionId, personId, 'complete', '{}', 4
    );
    const source = new SQLiteAirtableManagedSnapshotSource(sqlite, workspaceId);
    const page = await source.listPage({ connectionId, tableKey: 'tasks', limit: 10 });
    expect(page.records).toEqual([{
      subjectKey: assignmentId,
      fields: {
        task: 'Confirm slides',
        assignee: 'Ada Lovelace',
        due: '2027-02-20T16:00:00.000Z',
        status: 'Complete',
        event: 'JooConf',
        jooevents_id: assignmentId
      }
    }]);
    expect(JSON.stringify(page)).not.toContain('private@example.test');
  });
});
