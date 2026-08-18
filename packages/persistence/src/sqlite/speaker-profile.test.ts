import { afterEach, describe, expect, test } from 'bun:test';
import {
  planSpeakerProfileApproval,
  planSpeakerProfileReviewPolicyUpdate,
  planSpeakerProfileUpdate
} from '@jooevents/engagement';
import { openSQLite, type OpenSQLiteResult } from './database';
import {
  SQLiteSpeakerProfileError,
  SQLiteSpeakerProfileRepository
} from './speaker-profile';

const id = (value: number) => `019c5300-0000-7000-8000-${String(value).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const userId = id(3);
const personId = id(4);
const scope = { workspaceId, eventId };
const opened: OpenSQLiteResult[] = [];

function fixture(reviewRequired = true) {
  const database = openSQLite(':memory:');
  opened.push(database);
  const sqlite = database.sqlite;
  const nowMs = Date.parse('2026-08-18T06:00:00.000Z');
  sqlite.query(`
    INSERT INTO workspaces(id,name,state,created_at,updated_at,version)
    VALUES (?,'Workspace','active',?,?,1)
  `).run(workspaceId, nowMs, nowMs);
  sqlite.query(`
    INSERT INTO users(id,status,display_name,created_at,updated_at,version)
    VALUES (?,'active','Organizer',?,?,1)
  `).run(userId, nowMs, nowMs);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets(workspace_id,version,current_event_id)
    VALUES (?,1,NULL)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads(
      workspace_id,id,name,timezone,start_date,end_date,version,created_by_user_id,
      created_at_ms,create_plan_digest_sha256
    ) VALUES (?,?,'Event','UTC','2026-11-01','2026-11-02',1,?,?,?)
  `).run(workspaceId, eventId, userId, nowMs, 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots(workspace_id,event_id) VALUES (?,?)`)
    .run(workspaceId, eventId);
  sqlite.query(`UPDATE event_spine_workspace_sets SET current_event_id = ? WHERE workspace_id = ?`)
    .run(eventId, workspaceId);
  sqlite.query(`
    INSERT INTO event_settings_companions(
      workspace_id,event_id,event_version,location,venue_note,
      day_start,day_end,slot_minutes,profile_content_review
    ) VALUES (?,?,1,'','',NULL,NULL,NULL,?)
  `).run(workspaceId, eventId, reviewRequired ? 1 : 0);
  sqlite.query(`
    INSERT INTO speaker_lineup_entries(
      workspace_id,event_id,person_id,position,category_id,publicly_visible,version
    ) VALUES (?,?,?,0,NULL,1,1)
  `).run(workspaceId, eventId, personId);
  return { sqlite, profiles: new SQLiteSpeakerProfileRepository(sqlite) };
}

function update(
  fx: ReturnType<typeof fixture>,
  input: { readonly expectedProfileVersion: number | null; readonly patch: Record<string, unknown> },
  occurredAt: string
) {
  const plan = planSpeakerProfileUpdate({
    planningInput: {
      scope, actorUserId: userId, occurredAt,
      autoApprovalIds: [id(100), id(101), id(102), id(103)],
      authorInput: { personId, ...input }
    },
    profiles: fx.profiles
  });
  fx.sqlite.exec('BEGIN IMMEDIATE');
  const saved = fx.profiles.applySpeakerProfileUpdatePlan(plan);
  fx.sqlite.exec('COMMIT');
  return { plan, saved };
}

afterEach(() => { while (opened.length > 0) opened.pop()?.sqlite.close(); });

describe('SQLite speaker profile repository', () => {
  test('retains field revisions and exposes only approvals for exact current values', () => {
    const fx = fixture();
    const created = update(fx, {
      expectedProfileVersion: null,
      patch: { headline: 'Engineer', location: 'Singapore' }
    }, '2026-08-18T07:00:00.000Z').saved;
    expect(created.profile).toMatchObject({
      version: 1,
      headline: { revision: 1, value: 'Engineer' },
      location: { revision: 1, value: 'Singapore' }
    });

    const approval = planSpeakerProfileApproval({
      planningInput: {
        scope, actorUserId: userId, occurredAt: '2026-08-18T07:05:00.000Z',
        approvalIds: [id(10), id(11)],
        authorInput: {
          personId, expectedProfileVersion: 1, fields: ['headline', 'location']
        }
      }, profiles: fx.profiles
    });
    fx.sqlite.exec('BEGIN IMMEDIATE');
    fx.profiles.applySpeakerProfileApprovePlan(approval);
    fx.sqlite.exec('COMMIT');

    const edited = update(fx, {
      expectedProfileVersion: 1,
      patch: { headline: 'Principal engineer' }
    }, '2026-08-18T07:10:00.000Z').saved;
    expect(edited.profile?.headline).toMatchObject({ revision: 2, value: 'Principal engineer' });
    expect(edited.approvals.map((entry) => entry.field)).toEqual(['location']);
    expect(fx.sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM content_approvals'
    ).get()?.count).toBe(2);
    expect(fx.sqlite.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM speaker_profile_field_revisions'
    ).get()?.count).toBe(5);
    expect(fx.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('requires a caller transaction and rejects replayed plans', () => {
    const fx = fixture();
    const plan = planSpeakerProfileUpdate({
      planningInput: {
        scope, actorUserId: userId, occurredAt: '2026-08-18T07:00:00.000Z',
        autoApprovalIds: [id(100), id(101), id(102), id(103)],
        authorInput: {
          personId, expectedProfileVersion: null, patch: { biography: 'Biography' }
        }
      }, profiles: fx.profiles
    });
    expect(() => fx.profiles.applySpeakerProfileUpdatePlan(plan))
      .toThrow(new SQLiteSpeakerProfileError('transaction_required'));
    fx.sqlite.exec('BEGIN IMMEDIATE');
    fx.profiles.applySpeakerProfileUpdatePlan(plan);
    fx.sqlite.exec('COMMIT');
    fx.sqlite.exec('BEGIN IMMEDIATE');
    expect(() => fx.profiles.applySpeakerProfileUpdatePlan(plan))
      .toThrow(new SQLiteSpeakerProfileError('stale_profile'));
    fx.sqlite.exec('ROLLBACK');
  });

  test('does not infer an event relationship from a workspace profile', () => {
    const fx = fixture();
    update(fx, {
      expectedProfileVersion: null, patch: { headline: 'Engineer' }
    }, '2026-08-18T07:00:00.000Z');
    expect(fx.profiles.hasEventPersonRelationship({
      workspaceId, eventId: id(99), personId
    })).toBe(false);
  });

  test('reads every event profile as one directory projection', () => {
    const fx = fixture(false);
    update(fx, {
      expectedProfileVersion: null,
      patch: { headline: 'Engineer', location: 'Singapore' }
    }, '2026-08-18T07:00:00.000Z');
    const directory = fx.profiles.readSpeakerProfileDirectory(scope);
    expect(directory).toMatchObject({
      workspaceId, eventId,
      profiles: [{
        personId,
        profile: {
          headline: { value: 'Engineer' },
          location: { value: 'Singapore' }
        }
      }]
    });
    expect(directory.profiles[0]?.approvals).toHaveLength(2);
  });

  test('mints honest policy evidence with an automatic profile edit', () => {
    const fx = fixture(false);
    const saved = update(fx, {
      expectedProfileVersion: null,
      patch: { headline: 'Engineer', location: 'Singapore' }
    }, '2026-08-18T07:00:00.000Z').saved;
    expect(saved.reviewPolicy.reviewRequired).toBe(false);
    expect(saved.approvals.map((entry) => [entry.field, entry.actor])).toEqual([
      ['headline', {
        kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
        initiatedByUserId: userId
      }],
      ['location', {
        kind: 'policy', policyKey: 'profile_content_review', policyVersion: 1,
        initiatedByUserId: userId
      }]
    ]);
  });

  test('switches review policy atomically, backfills exact policy evidence, and exposes all manual-mode profiles', () => {
    const fx = fixture(true);
    update(fx, {
      expectedProfileVersion: null,
      patch: { headline: 'Engineer', location: 'Singapore' }
    }, '2026-08-18T07:00:00.000Z');
    expect(fx.profiles.readReviewQueue(scope).profiles).toHaveLength(1);

    const candidates = fx.profiles.readPolicyApprovalCandidates(scope);
    const automatic = planSpeakerProfileReviewPolicyUpdate({
      planningInput: {
        scope,
        actorUserId: userId,
        occurredAt: '2026-08-18T07:05:00.000Z',
        approvalIds: candidates.map((_, index) => id(200 + index)),
        authorInput: { expectedEventVersion: 1, reviewRequired: false }
      },
      profiles: fx.profiles
    });
    fx.sqlite.exec('BEGIN IMMEDIATE');
    fx.profiles.applyReviewPolicyUpdatePlan(automatic);
    fx.sqlite.exec('COMMIT');

    expect(fx.profiles.readReviewQueue(scope)).toMatchObject({
      policy: { eventVersion: 2, reviewRequired: false },
      profiles: []
    });
    expect(fx.profiles.readSpeakerProfileView({ ...scope, personId }).approvals).toHaveLength(4);
    expect(fx.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM content_approvals
       WHERE actor_kind = 'policy' AND approved_by_user_id IS NULL
    `).get()?.count).toBe(4);

    const manual = planSpeakerProfileReviewPolicyUpdate({
      planningInput: {
        scope,
        actorUserId: userId,
        occurredAt: '2026-08-18T07:10:00.000Z',
        approvalIds: [],
        authorInput: { expectedEventVersion: 2, reviewRequired: true }
      },
      profiles: fx.profiles
    });
    fx.sqlite.exec('BEGIN IMMEDIATE');
    fx.profiles.applyReviewPolicyUpdatePlan(manual);
    fx.sqlite.exec('COMMIT');
    const queue = fx.profiles.readReviewQueue(scope);
    expect(queue.policy).toMatchObject({ eventVersion: 3, reviewRequired: true });
    expect(queue.profiles).toHaveLength(1);
    expect(queue.profiles[0]).toMatchObject({
      personId, profileVersion: 1,
      presentFields: ['headline', 'location'], approvedFields: []
    });
    expect(fx.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
