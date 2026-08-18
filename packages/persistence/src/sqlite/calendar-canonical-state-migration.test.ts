import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJsonText } from '@jooevents/kernel';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import { loadSQLiteFoundationArtifacts, migrateOrValidateSQLite } from './migration-runner';

const W = '30000000-0000-4000-8000-000000000001';
const E = '30000000-0000-4000-8000-000000000002';
const U = '30000000-0000-4000-8000-000000000003';
const S = '30000000-0000-4000-8000-000000000004';
const P1 = '30000000-0000-4000-8000-000000000005';
const P2 = '30000000-0000-4000-8000-000000000006';
const G1 = '30000000-0000-4000-8000-000000000007';
const G2 = '30000000-0000-4000-8000-000000000008';
const O1 = '30000000-0000-4000-8000-000000000009';
const O2 = '30000000-0000-4000-8000-000000000010';
const R = '30000000-0000-4000-8000-000000000011';
const F = '30000000-0000-4000-8000-000000000012';
const D = 'a'.repeat(64);
const directories: string[] = [];
const opened: OpenSQLiteResult[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function pathFor(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-calendar-migration-'));
  directories.push(directory);
  return join(directory, 'database.sqlite');
}

function expectFoundationError(work: () => unknown): void {
  try { work(); } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    return;
  }
  throw new Error('Expected SQLiteFoundationError');
}

function predecessorPath(): string {
  const path = pathFor();
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys=ON;');
  let passes = 0;
  expectFoundationError(() => migrateOrValidateSQLite({
    database: sqlite,
    artifacts: loadSQLiteFoundationArtifacts(),
    policy: 'apply',
    databaseClass: 'retained_development',
    isMemory: false,
    fault(point) {
      if (point === 'after_schema_before_receipt' && (passes += 1) === 15) {
        throw new Error('hold_before_calendar_receipt');
      }
    }
  }));
  expect(sqlite.query<{ count: number }, []>(`
    SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='calendar_commitments'
  `).get()).toEqual({ count: 0 });
  expect(sqlite.query<{ sequence: number }, []>(`
    SELECT max(sequence) AS sequence FROM schema_migrations WHERE schema_epoch=2
  `).get()).toEqual({ sequence: 14 });
  sqlite.close();
  return path;
}

function seedDeliverable(path: string, options: { duplicateRoster?: boolean; wrongHeadScope?: boolean } = {}): void {
  const sqlite = new Database(path, { create: false, strict: true });
  sqlite.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  sqlite.query(`INSERT INTO workspaces(id,name,state,created_at,updated_at,version)
    VALUES (?,'Retained calendar workspace','active',0,0,1)`).run(W);
  sqlite.query(`INSERT INTO users(id,status,display_name,created_at,updated_at,version)
    VALUES (?,'active','Calendar owner',0,0,1)`).run(U);
  sqlite.query(`INSERT INTO event_spine_workspace_sets(workspace_id,version,current_event_id)
    VALUES (?,1,NULL)`).run(W);
  sqlite.query(`INSERT INTO event_spine_heads(
    workspace_id,id,name,timezone,start_date,end_date,version,created_by_user_id,created_at_ms,create_plan_digest_sha256
  ) VALUES (?,?,'Calendar event','UTC','2026-09-01','2026-09-02',1,?,0,?)`).run(W, E, U, D);
  sqlite.query('INSERT INTO event_spine_scope_roots(workspace_id,event_id) VALUES (?,?)').run(W, E);
  sqlite.query(`INSERT INTO program_vocabulary_sets(
    workspace_id,event_id,set_version,created_by_user_id,created_at_ms,updated_by_user_id,updated_at_ms
  ) VALUES (?,?,2,?,0,?,0)`).run(W, E, U, U);
  sqlite.query(`INSERT INTO program_vocabulary_rooms(
    workspace_id,event_id,id,name,capacity,status,version,created_by_user_id,created_at_ms,updated_by_user_id,updated_at_ms
  ) VALUES (?,?,?,'Room A',100,'active',1,?,0,?,0)`).run(W, E, R, U, U);
  sqlite.query(`INSERT INTO program_vocabulary_formats(
    workspace_id,event_id,id,name,status,version,created_by_user_id,created_at_ms,updated_by_user_id,updated_at_ms
  ) VALUES (?,?,?,'Talk','active',1,?,0,?,0)`).run(W, E, F, U, U);
  sqlite.query(`INSERT INTO session_catalogs(workspace_id,event_id,version,digest_sha256)
    VALUES (?,?,2,?)`).run(W, E, D);
  const participants = [
    { personId: P1, role: 'speaker', position: 0, publiclyVisible: true, source: { kind: 'organizer', id: U, version: 1 } },
    { personId: P2, role: 'speaker', position: 1, publiclyVisible: true, source: { kind: 'organizer', id: U, version: 1 } },
    ...(options.duplicateRoster
      ? [{ personId: P1, role: 'panelist', position: 2, publiclyVisible: true, source: { kind: 'organizer', id: U, version: 1 } }]
      : [])
  ];
  const roster = { version: 1, digestSha256: D, participants };
  const scope = options.wrongHeadScope ? { workspaceId: W, eventId: O1 } : { workspaceId: W, eventId: E };
  const head = {
    schemaVersion: 1, scope, id: S, title: 'Retained Session', plannedDurationMinutes: 45,
    lifecycle: 'programmed',
    programTarget: { setVersion: 2, setDigestSha256: D, format: { id: F }, track: null },
    roster, version: 1, digestSha256: D
  };
  sqlite.query(`INSERT INTO sessions(
    workspace_id,event_id,id,title,planned_duration_minutes,lifecycle,format_id,track_id,
    program_set_version,program_set_digest_sha256,roster_version,roster_digest_sha256,
    roster_json,head_json,version,digest_sha256,created_by_user_id,created_at_ms,updated_by_user_id,updated_at_ms
  ) VALUES (?,?,?,'Retained Session',45,'programmed',?,NULL,2,?,1,?,?,?,1,?, ?,0,?,0)`)
    .run(W, E, S, F, D, D, canonicalJsonText(roster), canonicalJsonText(head), D, U, U);
  sqlite.query(`INSERT INTO schedule_placement_sets(
    workspace_id,event_id,schedule_version,updated_by_user_id,updated_at_ms
  ) VALUES (?,?,2,?,0)`).run(W, E, U);
  for (const [id, start, end] of [[O1, 1_788_228_800_000, 1_788_231_500_000], [O2, 1_788_232_400_000, 1_788_235_100_000]] as const) {
    sqlite.query(`INSERT INTO schedule_occurrences(
      workspace_id,event_id,id,session_id,room_id,start_at_ms,end_at_ms,version,updated_by_user_id,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,1,?,0)`).run(W, E, id, S, R, start, end, U);
  }
  for (const [id, person, state] of [[G1, P1, 'confirmed'], [G2, P2, 'invited']] as const) {
    sqlite.query(`INSERT INTO engagement_heads(
      workspace_id,event_id,id,session_id,person_id,submission_id,state,version,head_json,invited_at_ms,cancelled_at_ms
    ) VALUES (?,?,?,?,?,NULL,?,1,?,0,NULL)`).run(W, E, id, S, person, state, canonicalJsonText({
      schemaVersion: 1, id, scope: { workspaceId: W, eventId: E }, sessionId: S, personId: person,
      submissionId: null, seededByDecision: null, state, version: 1
    }));
  }
  sqlite.exec('COMMIT;');
  sqlite.close();
}

describe('calendar canonical-state migration', () => {
  test('anchors every current source and deterministically backfills only confirmed roster joins', () => {
    const paths = [predecessorPath(), predecessorPath()];
    const uids: string[] = [];
    for (const path of paths) {
      seedDeliverable(path);
      const before = new Database(path, { create: false, strict: true });
      expect(before.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM sessions s
        JOIN engagement_heads e ON e.workspace_id=s.workspace_id AND e.event_id=s.event_id
          AND e.session_id=s.id AND e.state='confirmed'
        JOIN json_each(s.roster_json,'$.participants') participant
          ON json_extract(participant.value,'$.personId')=e.person_id
        JOIN schedule_occurrences o ON o.workspace_id=s.workspace_id AND o.event_id=s.event_id
          AND o.session_id=s.id
      `).get()).toEqual({ count: 2 });
      before.close();
      const migrated = openSQLite(path, { migrationPolicy: 'apply' });
      opened.push(migrated);
      expect(migrated.migration).toMatchObject({
        migrationId: 'e2_0017_speaker_profile_review_policy', coordinate: { schemaEpoch: 2, sequence: 17 }
      });
      expect(migrated.sqlite.query<{ source_kind: string; count: number }, []>(`
        SELECT source_kind,count(*) AS count FROM calendar_commitment_source_heads
         GROUP BY source_kind ORDER BY source_kind
      `).all()).toEqual([
        { source_kind: 'engagement', count: 2 }, { source_kind: 'occurrence', count: 2 },
        { source_kind: 'room', count: 1 }, { source_kind: 'session', count: 1 }
      ]);
      expect(migrated.sqlite.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM sessions s
        JOIN engagement_heads e ON e.workspace_id=s.workspace_id AND e.event_id=s.event_id
          AND e.session_id=s.id AND e.state='confirmed'
        JOIN json_each(s.roster_json,'$.participants') participant
          ON json_extract(participant.value,'$.personId')=e.person_id
        JOIN schedule_occurrences o ON o.workspace_id=s.workspace_id AND o.event_id=s.event_id
          AND o.session_id=s.id
        JOIN program_vocabulary_rooms r ON r.workspace_id=o.workspace_id AND r.event_id=o.event_id AND r.id=o.room_id
      `).get()).toEqual({ count: 2 });
      const candidateIds = migrated.sqlite.query<{ id: string }, []>(`
        SELECT lower(
          substr(replace(e.person_id,'-',''),1,8) || '-' || substr(replace(s.id,'-',''),-4) ||
          '-5' || substr(replace(o.id,'-',''),-3) || '-a' || substr(replace(e.person_id,'-',''),-3) ||
          '-' || substr(replace(s.id,'-',''),-6) || substr(replace(o.id,'-',''),-6)
        ) AS id
        FROM sessions s JOIN engagement_heads e
          ON e.workspace_id=s.workspace_id AND e.event_id=s.event_id AND e.session_id=s.id AND e.state='confirmed'
        JOIN json_each(s.roster_json,'$.participants') participant
          ON json_extract(participant.value,'$.personId')=e.person_id
        JOIN schedule_occurrences o ON o.workspace_id=s.workspace_id AND o.event_id=s.event_id AND o.session_id=s.id
        JOIN program_vocabulary_rooms r ON r.workspace_id=o.workspace_id AND r.event_id=o.event_id AND r.id=o.room_id
      `).all();
      expect(candidateIds).toHaveLength(2);
      expect(new Set(candidateIds.map((row) => row.id)).size).toBe(2);
      const commitments = migrated.sqlite.query<{
        uid: string; sequence: number; person_id: string; occurrence_id: string; provenance_profile: string;
      }, []>(`
        SELECT uid,sequence,person_id,occurrence_id,provenance_profile FROM calendar_commitments
         ORDER BY occurrence_id
      `).all();
      expect(commitments).toHaveLength(2);
      expect(commitments.every((row) => row.person_id === P1 && row.sequence === 0
        && row.provenance_profile === 'calendar.backfill-identity')).toBe(true);
      uids.push(...commitments.map((row) => `${row.occurrence_id}:${row.uid}`));
      for (const table of [
        'calendar_commitment_facts','calendar_notice_generations','calendar_notice_generation_items',
        'calendar_delivery_preferences','calendar_feeds'
      ]) expect(migrated.sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get())
        .toEqual({ count: 0 });
      expect(migrated.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }
    expect(uids.slice(0, 2)).toEqual(uids.slice(2));
  });

  test('refuses ambiguous duplicate roster authority and cross-scope source images atomically', () => {
    for (const [label, options] of [
      ['duplicate', { duplicateRoster: true }],
      ['cross-scope', { wrongHeadScope: true }]
    ] as const) {
      const path = predecessorPath();
      seedDeliverable(path, options);
      if (label === 'duplicate') {
        const probe = new Database(path, { create: false, strict: true });
        expect(probe.query<{ count: number }, []>(`
          SELECT count(*) AS count FROM sessions s
          JOIN engagement_heads e ON e.workspace_id=s.workspace_id AND e.event_id=s.event_id
            AND e.session_id=s.id AND e.state='confirmed'
          JOIN json_each(s.roster_json,'$.participants') participant
            ON json_extract(participant.value,'$.personId')=e.person_id
          JOIN schedule_occurrences o ON o.workspace_id=s.workspace_id AND o.event_id=s.event_id AND o.session_id=s.id
        `).get()).toEqual({ count: 4 });
        probe.close();
      }
      let refused = false;
      try {
        const unexpected = openSQLite(path, { migrationPolicy: 'apply' });
        unexpected.sqlite.close();
      } catch (error) {
        expect(error).toBeInstanceOf(SQLiteFoundationError);
        refused = true;
      }
      expect({ label, refused }).toEqual({ label, refused: true });
      const held = new Database(path, { create: false, strict: true });
      expect(held.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='calendar_commitments'
      `).get()).toEqual({ count: 0 });
      expect(held.query<{ sequence: number }, []>(`
        SELECT max(sequence) AS sequence FROM schema_migrations WHERE schema_epoch=2
      `).get()).toEqual({ sequence: 14 });
      held.close();
    }
  });
});
