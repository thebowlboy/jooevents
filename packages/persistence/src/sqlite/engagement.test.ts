import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  applyEngagementSeedFrom,
  applyEngagementSeedReversalFrom,
  deterministicEngagementId,
  planEngagementMutation,
  planEngagementSeedFrom,
  planEngagementSeedReversalFrom,
  validateEngagementSeedReversalFrom,
  EngagementSeedError
} from '@jooevents/engagement';
import { parseEventId, parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation
} from '@jooevents/program';
import { planSessionMutation } from '@jooevents/session';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import {
  createSQLiteEngagementSubmissionReferenceSource,
  installEngagementSchema,
  SQLiteEngagementRepository
} from './engagement';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfb201');
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfb301';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfb401';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfb501';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfb502';
const submissionA = '019c1df7-86b5-769b-bba4-5f7097bfb601';
const submissionB = '019c1df7-86b5-769b-bba4-5f7097bfb602';
const now = parseInstant('2026-08-14T08:00:00.000Z');
const later = parseInstant('2026-08-14T09:00:00.000Z');
const scope = { workspaceId, eventId };
const seededBy = Object.freeze({ version: 1, digestSha256: 'e'.repeat(64) });
const otherSeededBy = Object.freeze({ version: 1, digestSha256: 'f'.repeat(64) });

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
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installEngagementSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1)
  `).run(userId);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);

  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [], contributors: []
  });
  const adapterRegistry = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite, expected: [], adapters: []
  });
  const program = new SQLiteProgramVocabularyRepository(
    sqlite, referenceRegistry, adapterRegistry,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  const state = program.readVocabulary(scope)!;
  const vocabularyPlan = planProgramVocabularyMutation({
    state,
    referenceRegistry,
    referenceSource: program,
    authorInput: {
      action: 'create', scope, expectedSetVersion: state.setVersion,
      item: { kind: 'format', id: formatId, name: 'Talk' }
    }
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  program.applyVocabularyPlan(vocabularyPlan);
  sqlite.exec('COMMIT;');
  const sessions = new SQLiteSessionRepository(sqlite, program);
  const catalog = sessions.readSessionCatalog(scope)!;
  const sessionPlan = planSessionMutation({
    catalog,
    vocabulary: sessions.readSessionVocabulary(scope)!,
    planningInput: {
      action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Seeded Panel', plannedDurationMinutes: 60,
      lifecycle: 'collecting', formatId, trackId: null
    }
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  sessions.applySessionPlan(sessionPlan);
  sqlite.exec('COMMIT;');

  const engagements = new SQLiteEngagementRepository(sqlite);
  return { sqlite, engagements };
}

function seedInput(overrides: Record<string, unknown> = {}) {
  return {
    scope,
    sessionId,
    submissionId: submissionA,
    seededByDecision: seededBy,
    source: { kind: 'submission', id: submissionA, version: 7 },
    personIds: [personA, personB],
    invitedAt: now,
    respondBy: null,
    ...overrides
  } as Parameters<typeof planEngagementSeedFrom>[1];
}

function applySeed(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const contribution = planEngagementSeedFrom(fx.engagements, seedInput(overrides));
  fx.sqlite.exec('BEGIN IMMEDIATE;');
  const result = applyEngagementSeedFrom(fx.engagements, contribution);
  fx.sqlite.exec('COMMIT;');
  return result;
}

describe('disposable SQLite engagement repository', () => {
  test('seeds invited rows transactionally with guarded inserts and typed replay refusals', () => {
    const fx = fixture();
    try {
      const contribution = planEngagementSeedFrom(fx.engagements, seedInput());
      expect(() => applyEngagementSeedFrom(fx.engagements, contribution))
        .toThrow('transaction_required');
      const result = applySeed(fx);
      expect(result.seeded.map((head) => head.personId)).toEqual([personA, personB]);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      expect(head).toMatchObject({
        id: deterministicEngagementId(scope, sessionId, personA),
        state: 'invited', version: 1, submissionId: submissionA
      });
      expect(fx.engagements.readEngagementHead(scope, head.id)).toEqual(head);
      // Replaying the exact seeded contribution refuses: the physical pair and
      // the guarded insert both fence it.
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => applyEngagementSeedFrom(fx.engagements, contribution))
        .toThrow('seed_conflict');
      fx.sqlite.exec('ROLLBACK;');
      // A replanned seed over current state skips both pairs and applies cleanly.
      const replay = planEngagementSeedFrom(fx.engagements, seedInput());
      expect(replay.rows).toHaveLength(0);
      expect(replay.skippedPersonIds).toEqual([personA, personB]);
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      applyEngagementSeedFrom(fx.engagements, replay);
      fx.sqlite.exec('COMMIT;');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 2 });
      expect(fx.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fx.sqlite.close();
    }
  });

  test('responses use exact-image guarded updates and identity stays immutable', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      const plan = planEngagementMutation({
        planningInput: {
          action: 'record_confirmation',
          scope, actorUserId: userId, occurredAt: later,
          engagementId: head.id,
          expectedEngagementVersion: 1,
          attribution: 'organizer_recorded'
        },
        environment: { engagements: fx.engagements }
      });
      expect(() => fx.engagements.applyEngagementPlan(plan)).toThrow('transaction_required');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(fx.engagements.applyEngagementPlan(plan)).toMatchObject({
        action: 'record_confirmation',
        engagement: { state: 'confirmed', version: 2 }
      });
      fx.sqlite.exec('COMMIT;');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.engagements.applyEngagementPlan(plan)).toThrow('stale_engagement');
      fx.sqlite.exec('ROLLBACK;');
      expect(() => fx.sqlite.query(`
        UPDATE engagement_heads SET person_id = ?
      `).run(personB)).toThrow('immutable');
      // The seed provenance pin inside the head image is physically immutable
      // too: no response or raw write may re-home a row to another acceptance.
      expect(() => fx.sqlite.query(`
        UPDATE engagement_heads
           SET head_json = json_set(head_json, '$.seededByDecision.digestSha256', ?)
      `).run('9'.repeat(64))).toThrow('seed provenance is immutable');
      expect(fx.engagements.readEngagementHead(scope, head.id)).toMatchObject({
        state: 'confirmed',
        seededByDecision: seededBy,
        confirmation: { attribution: 'organizer_recorded', recordedByUserId: userId }
      });
    } finally {
      fx.sqlite.close();
    }
  });

  test('reversal removes exactly one submission\'s seeded rows and refuses advanced rows', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      applySeed(fx, {
        submissionId: submissionB,
        seededByDecision: otherSeededBy,
        source: { kind: 'submission', id: submissionB, version: 3 },
        personIds: [personA, '019c1df7-86b5-769b-bba4-5f7097bfb503']
      });
      expect(fx.engagements.listSeededEngagements(scope, sessionId, submissionB))
        .toHaveLength(1);
      const reversal = planEngagementSeedReversalFrom(fx.engagements, {
        scope, sessionId, submissionId: submissionA, seededByDecision: seededBy
      });
      expect(validateEngagementSeedReversalFrom(fx.engagements, reversal))
        .toEqual({ kind: 'ready' });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      const removed = applyEngagementSeedReversalFrom(fx.engagements, reversal);
      fx.sqlite.exec('COMMIT;');
      expect(removed.removedPersonIds).toEqual([personA, personB]);
      expect(fx.engagements.listSeededEngagements(scope, sessionId, submissionA)).toEqual([]);
      expect(fx.engagements.listSeededEngagements(scope, sessionId, submissionB))
        .toHaveLength(1);

      // Advance the remaining row; its submission's reversal now refuses.
      const standing = fx.engagements.listSeededEngagements(scope, sessionId, submissionB)[0]!;
      const decline = planEngagementMutation({
        planningInput: {
          action: 'decline',
          scope, actorUserId: userId, occurredAt: later,
          engagementId: standing.id,
          expectedEngagementVersion: 1
        },
        environment: { engagements: fx.engagements }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.engagements.applyEngagementPlan(decline);
      fx.sqlite.exec('COMMIT;');
      expect(() => planEngagementSeedReversalFrom(fx.engagements, {
        scope, sessionId, submissionId: submissionB, seededByDecision: otherSeededBy
      })).toThrow(EngagementSeedError);
    } finally {
      fx.sqlite.close();
    }
  });

  test('snapshot orders canonically and the census counts durable submission references', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const snapshot = fx.engagements.readEngagementSnapshot(scope)!;
      expect(snapshot.engagements.map((head) => head.personId)).toEqual([personA, personB]);
      const census = createSQLiteEngagementSubmissionReferenceSource(fx.sqlite);
      expect(census.countSubmissionReferences(scope, submissionA)).toBe(2);
      expect(census.countSubmissionReferences(scope, submissionB)).toBe(0);
    } finally {
      fx.sqlite.close();
    }
  });

  test('the pair is physically unique and the Session foreign key holds deletion order', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.sqlite.query(`
        INSERT INTO engagement_heads (
          workspace_id, event_id, id, session_id, person_id, submission_id,
          state, version, head_json, invited_at_ms, cancelled_at_ms
        ) VALUES (?, ?, ?, ?, ?, NULL, 'invited', 1, ?, ?, NULL)
      `).run(
        workspaceId, eventId, '019c1df7-86b5-769b-bba4-5f7097bfbff0',
        sessionId, personA,
        JSON.stringify({
          ...head, id: '019c1df7-86b5-769b-bba4-5f7097bfbff0', submissionId: null
        }),
        Date.parse(now)
      )).toThrow();
      fx.sqlite.exec('ROLLBACK;');
      // A Session with engagement rows cannot be deleted from under them.
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.sqlite.query('DELETE FROM sessions').run()).toThrow();
      fx.sqlite.exec('ROLLBACK;');
    } finally {
      fx.sqlite.close();
    }
  });
});
