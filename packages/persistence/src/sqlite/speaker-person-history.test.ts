import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { EngagementScopeDto } from '@jooevents/contracts';
import { createSQLiteSpeakerPersonHistoryReader } from './speaker-person-history';

const id = (value: number) => `019c5200-0000-7000-8000-${String(value).padStart(12, '0')}`;
const scope: EngagementScopeDto = { workspaceId: id(1), eventId: id(2) };
const personId = id(3);
const otherPersonId = id(4);
const databases: Database[] = [];

function fixture(): Database {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE event_spine_scope_roots (workspace_id TEXT, event_id TEXT);
    CREATE TABLE task_events (
      workspace_id TEXT, event_id TEXT, id TEXT, assignment_id TEXT, kind TEXT,
      event_json TEXT, occurred_at_ms INTEGER
    );
    CREATE TABLE task_assignments (
      workspace_id TEXT, event_id TEXT, id TEXT, person_id TEXT,
      task_definition_revision_id TEXT
    );
    CREATE TABLE task_definition_revisions (
      workspace_id TEXT, event_id TEXT, revision_id TEXT, revision_json TEXT
    );
    CREATE TABLE participant_portal_activity (
      activity_id TEXT, workspace_id TEXT, event_id TEXT, submission_id TEXT,
      occurred_at_ms INTEGER, acting_person_id TEXT,
      summary_for_actor TEXT, summary_for_others TEXT
    );
    CREATE TABLE intake_submission_participant_evidence (
      workspace_id TEXT, event_id TEXT, submission_id TEXT, person_id TEXT
    );
    CREATE TABLE intake_submission_heads (
      workspace_id TEXT, event_id TEXT, submission_id TEXT, person_id TEXT
    );
    CREATE TABLE operation_log (
      id TEXT, workspace_id TEXT, event_id TEXT, operation_name TEXT,
      actor_json TEXT, result_json TEXT, summary TEXT, occurred_at_ms INTEGER
    );
  `);
  sqlite.query(`INSERT INTO event_spine_scope_roots VALUES (?, ?)`).run(
    scope.workspaceId, scope.eventId
  );
  return sqlite;
}

afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

describe('SQLite speaker Person history', () => {
  test('joins only exact retained Person relationships across feature ledgers', () => {
    const sqlite = fixture();
    const assignmentId = id(10);
    const revisionId = id(11);
    const submissionId = id(12);
    sqlite.query(`INSERT INTO task_assignments VALUES (?, ?, ?, ?, ?)`)
      .run(scope.workspaceId, scope.eventId, assignmentId, personId, revisionId);
    sqlite.query(`INSERT INTO task_definition_revisions VALUES (?, ?, ?, ?)`)
      .run(scope.workspaceId, scope.eventId, revisionId, JSON.stringify({ name: 'Travel details' }));
    sqlite.query(`INSERT INTO task_events VALUES (?, ?, ?, ?, 'fulfillment_accepted', '{}', ?)`)
      .run(scope.workspaceId, scope.eventId, id(13), assignmentId, Date.parse('2026-08-18T08:00:00.000Z'));
    sqlite.query(`INSERT INTO intake_submission_participant_evidence VALUES (?, ?, ?, ?)`)
      .run(scope.workspaceId, scope.eventId, submissionId, personId);
    sqlite.query(`INSERT INTO participant_portal_activity VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id(14), scope.workspaceId, scope.eventId, submissionId,
        Date.parse('2026-08-18T09:00:00.000Z'), personId,
        'You confirmed the invitation', 'A speaker confirmed the invitation'
      );
    sqlite.query(`INSERT INTO operation_log VALUES (?, ?, ?, 'engagement.change', ?, ?, ?, ?)`)
      .run(
        id(15), scope.workspaceId, scope.eventId,
        JSON.stringify({ kind: 'workspace_user', userId: id(20) }),
        JSON.stringify({ kind: 'success', data: { engagement: { personId } } }),
        'Recorded a speaker confirmation', Date.parse('2026-08-18T10:00:00.000Z')
      );
    sqlite.query(`INSERT INTO operation_log VALUES (?, ?, ?, 'engagement.change', ?, ?, ?, ?)`)
      .run(
        id(16), scope.workspaceId, scope.eventId,
        JSON.stringify({ kind: 'workspace_user', userId: id(20) }),
        JSON.stringify({ kind: 'success', data: { engagement: { personId: otherPersonId } } }),
        'Unrelated', Date.parse('2026-08-18T11:00:00.000Z')
      );

    const page = createSQLiteSpeakerPersonHistoryReader(sqlite).read(scope, { personId });
    expect(page?.entries.map((entry) => entry.summary)).toEqual([
      'Recorded a speaker confirmation',
      'You confirmed the invitation',
      'Accepted Travel details'
    ]);
    expect(page?.entries.map((entry) => entry.actor)).toEqual([
      'organizer', 'person', 'organizer'
    ]);
    expect(page?.next).toBeNull();
  });

  test('returns undefined for a missing event scope instead of claiming empty history', () => {
    const sqlite = fixture();
    const reader = createSQLiteSpeakerPersonHistoryReader(sqlite);
    expect(reader.read({ ...scope, eventId: id(99) }, { personId })).toBeUndefined();
  });
});
