import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  SESSION_PARTICIPANT_SUPPORT_SQL,
  SQLiteSessionParticipantSupportRepository,
  assertSessionParticipantSupportBackfillSafe
} from './session-participant-support';

const scope = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  eventId: '019c1df7-86b5-769b-bba4-5f7097bfa101'
};
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa201';
const personId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const secondPersonId = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfa501';

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE sessions (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id, id)
    ) STRICT, WITHOUT ROWID;
    ${SESSION_PARTICIPANT_SUPPORT_SQL}
  `);
  sqlite.query('INSERT INTO sessions VALUES (?, ?, ?)').run(
    scope.workspaceId, scope.eventId, sessionId
  );
  return { sqlite, repository: new SQLiteSessionParticipantSupportRepository(sqlite) };
}

describe('SQLite Session participant support repository', () => {
  test('writes exact immutable support changes only inside the caller transaction', () => {
    const fx = fixture();
    const submission = {
      schemaVersion: 1 as const, scope, sessionId, personId,
      kind: 'submission' as const, submissionId
    };
    const editorial = {
      schemaVersion: 1 as const, scope, sessionId, personId,
      kind: 'editorial' as const,
      source: { kind: 'organizer', id: userId, version: 1 }
    };
    try {
      expect(() => fx.repository.applyParticipantSupportChanges({
        remove: [], insert: [submission]
      })).toThrow('transaction_required');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.repository.applyParticipantSupportChanges({
        remove: [], insert: [submission, editorial]
      });
      fx.sqlite.exec('COMMIT;');
      expect(fx.repository.listParticipantSupports(scope, sessionId, personId))
        .toEqual([editorial, submission]);
      expect(fx.repository.readParticipantSupport(
        scope, sessionId, personId, { kind: 'submission', submissionId }
      )).toEqual(submission);

      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.repository.applyParticipantSupportChanges({ remove: [submission], insert: [] });
      fx.sqlite.exec('COMMIT;');
      expect(fx.repository.listParticipantSupports(scope, sessionId, personId))
        .toEqual([editorial]);
    } finally {
      fx.sqlite.close();
    }
  });

  test('retained migration backfills exact submission and editorial support', async () => {
    const sqlite = new Database(':memory:', { strict: true });
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec(`
      CREATE TABLE sessions (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        id TEXT NOT NULL,
        roster_json TEXT NOT NULL CHECK(json_valid(roster_json)),
        PRIMARY KEY (workspace_id, event_id, id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE submission_session_origins (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        session_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE intake_submission_participant_evidence (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        person_id TEXT NOT NULL
      ) STRICT;
    `);
    const submissionSource = { kind: 'submission', id: submissionId, version: 7 };
    const editorialSource = { kind: 'organizer', id: userId, version: 1 };
    sqlite.query('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(
      scope.workspaceId, scope.eventId, sessionId, canonicalJsonText({
        participants: [
          { personId, role: 'speaker', position: 0, publiclyVisible: true, source: submissionSource },
          { personId: secondPersonId, role: 'host', position: 1, publiclyVisible: true, source: editorialSource }
        ]
      })
    );
    sqlite.query('INSERT INTO submission_session_origins VALUES (?, ?, ?, ?)').run(
      scope.workspaceId, scope.eventId, submissionId, sessionId
    );
    sqlite.query('INSERT INTO intake_submission_participant_evidence VALUES (?, ?, ?, ?)').run(
      scope.workspaceId, scope.eventId, submissionId, personId
    );
    try {
      expect(sqlite.query<{ count: number }, []>(`
        SELECT count(*) AS count
          FROM sessions session, json_each(session.roster_json, '$.participants') participant
         WHERE json_extract(participant.value, '$.source.kind') = 'submission'
      `).get()?.count).toBe(1);
      const migration = await Bun.file(new URL(
        '../../migrations/sqlite/e2_0014_session_participant_support.sql', import.meta.url
      )).text();
      expect(() => assertSessionParticipantSupportBackfillSafe(sqlite)).not.toThrow();
      sqlite.exec(migration);
      const repository = new SQLiteSessionParticipantSupportRepository(sqlite);
      expect(repository.listParticipantSupports(scope, sessionId, personId)).toEqual([{
        schemaVersion: 1, scope, sessionId, personId, kind: 'submission', submissionId
      }]);
      expect(repository.listParticipantSupports(scope, sessionId, secondPersonId)).toEqual([{
        schemaVersion: 1, scope, sessionId, personId: secondPersonId,
        kind: 'editorial', source: editorialSource
      }]);
      expect(sqlite.query<{ support_json: string }, []>(`
        SELECT support_json FROM session_participant_supports ORDER BY support_kind LIMIT 1
      `).get()?.support_json).toBe(canonicalJsonText({
        schemaVersion: 1, scope, sessionId, personId: secondPersonId,
        kind: 'editorial', source: editorialSource
      }));
    } finally {
      sqlite.close();
    }
  });

  test('retained migration refuses a roster Submission source without matching origin evidence', async () => {
    const sqlite = new Database(':memory:', { strict: true });
    sqlite.exec(`
      CREATE TABLE sessions (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        id TEXT NOT NULL,
        roster_json TEXT NOT NULL CHECK(json_valid(roster_json)),
        PRIMARY KEY (workspace_id, event_id, id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE submission_session_origins (
        workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
        submission_id TEXT NOT NULL, session_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE intake_submission_participant_evidence (
        workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
        submission_id TEXT NOT NULL, person_id TEXT NOT NULL
      ) STRICT;
    `);
    sqlite.query('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(
      scope.workspaceId, scope.eventId, sessionId, canonicalJsonText({
        participants: [{
          personId, role: 'speaker', position: 0, publiclyVisible: true,
          source: { kind: 'submission', id: submissionId, version: 7 }
        }]
      })
    );
    try {
      expect(sqlite.query<{ count: number }, []>(`
        SELECT count(*) AS count
          FROM sessions session, json_each(session.roster_json, '$.participants') participant
         WHERE json_extract(participant.value, '$.source.kind') = 'submission'
      `).get()?.count).toBe(1);
      expect(() => assertSessionParticipantSupportBackfillSafe(sqlite))
        .toThrow('session_participant_support_backfill_ambiguous:0:1');
    } finally {
      sqlite.close();
    }
  });
});
