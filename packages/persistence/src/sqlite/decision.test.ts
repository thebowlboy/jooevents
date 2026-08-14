import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  planDecisionMutation,
  planDecisionCompensation,
  resolveDecisionMutationPlanningInput,
  type DecisionEnvironmentSource
} from '@jooevents/decision';
import { planEngagementMutation } from '@jooevents/engagement';
import { applySessionMutationPlan, planSessionMutation } from '@jooevents/session';
import { parseEventId, parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation
} from '@jooevents/program';
import type { SubmissionTriageSourceRowDto } from '@jooevents/contracts/submission-triage';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import { installSchedulePlacementSchema } from './schedule-placement';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import { SQLiteReviewCandidateSourceAdapter } from './review-candidate-source';
import {
  installDecisionSchema,
  SQLiteDecisionCandidateSourceAdapter,
  SQLiteDecisionRepository
} from './decision';
import { installEngagementSchema } from './engagement';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa401';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa402';
const submissionId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfa502';
const formVersionId = '019c1df7-86b5-769b-bba4-5f7097bfa503';
const personId = '019c1df7-86b5-769b-bba4-5f7097bfa601';
const now = parseInstant('2026-08-13T08:00:00.000Z');
const later = parseInstant('2026-08-13T08:05:00.000Z');
const scope = { workspaceId, eventId };

function fixture(environment?: DecisionEnvironmentSource) {
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
    CREATE TABLE foundation_trial_operation_receipts (
      id TEXT PRIMARY KEY, operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL, result_json TEXT NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installSchedulePlacementSchema(sqlite);
  installDecisionSchema(sqlite);
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
  sqlite.query(`UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?`)
    .run(eventId, workspaceId);

  const referenceRegistry = createProgramReferenceContributorRegistry({ expected: [], contributors: [] });
  const adapterRegistry = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite, expected: [], adapters: []
  });
  const program = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    adapterRegistry,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  for (const item of [
    { kind: 'format' as const, id: formatId, name: 'Talk' },
    { kind: 'track' as const, id: trackId, name: 'Platform' }
  ]) {
    const state = program.readVocabulary(scope)!;
    const authorInput = item.kind === 'format'
      ? {
          action: 'create' as const,
          scope,
          expectedSetVersion: state.setVersion,
          item: { kind: 'format' as const, id: item.id, name: item.name }
        }
      : {
          action: 'create' as const,
          scope,
          expectedSetVersion: state.setVersion,
          item: { kind: 'track' as const, id: item.id, name: item.name }
        };
    const plan = planProgramVocabularyMutation({
      state,
      referenceRegistry,
      referenceSource: program,
      authorInput
    });
    sqlite.exec('BEGIN IMMEDIATE;');
    program.applyVocabularyPlan(plan);
    sqlite.exec('COMMIT;');
  }
  const sessions = new SQLiteSessionRepository(sqlite, program);
  const candidates = new Map<string, ReturnType<typeof candidate>>();
  const decisions = new SQLiteDecisionRepository({
    sqlite,
    sessions,
    environment: environment ?? {
      readDecisionCandidate: (_scope, id) => candidates.get(id),
      readDecisionReviewBasis: () => undefined
    }
  });
  return { sqlite, sessions, decisions, candidates };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    submissionId,
    formVersionId,
    candidateVersion: 7,
    title: 'Persistent Talk',
    formatId,
    trackId,
    targetSessionId: null,
    participantPersonIds: Object.freeze([personId]),
    ...overrides
  }) as never;
}

function seedCollectingSession(fx: ReturnType<typeof fixture>): void {
  const catalog = fx.sessions.readSessionCatalog(scope)!;
  const plan = planSessionMutation({
    catalog,
    vocabulary: fx.sessions.readSessionVocabulary(scope)!,
    planningInput: {
      action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Collecting Panel', plannedDurationMinutes: 60,
      lifecycle: 'collecting', formatId, trackId
    }
  });
  fx.sqlite.exec('BEGIN IMMEDIATE;');
  fx.sessions.applySessionPlan(plan);
  fx.sqlite.exec('COMMIT;');
}

function acceptPlan(fx: ReturnType<typeof fixture>, graduation: Record<string, unknown>) {
  return planDecisionMutation({
    planningInput: {
      action: 'decide',
      scope,
      actorUserId: userId,
      occurredAt: now,
      decisions: [{
        submissionId,
        state: 'accepted',
        expectedDecisionVersion: null,
        expectedDecisionDigestSha256: null,
        graduation
      }]
    } as never,
    environment: { decisions: fx.decisions, sessions: fx.decisions }
  });
}

describe('disposable SQLite Decision repository', () => {
  test('commits head, origin, and graduation together with guarded writes and typed replay refusals', () => {
    const fx = fixture();
    try {
      seedCollectingSession(fx);
      fx.candidates.set(submissionId, candidate({ targetSessionId: sessionId }));
      const plan = acceptPlan(fx, { kind: 'attach', sessionId });
      expect(() => fx.decisions.applyDecisionPlan(plan)).toThrow('transaction_required');

      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applySessionGraduation(plan.rows[0]!.graduation!);
      const result = fx.decisions.applyDecisionPlan(plan);
      fx.sqlite.exec('COMMIT;');
      expect(result.rows[0]).toMatchObject({
        submissionId,
        head: { state: 'accepted', version: 1 },
        origin: { kind: 'attached', sessionId }
      });
      expect(fx.decisions.readDecisionHead(scope, submissionId)?.state).toBe('accepted');
      expect(fx.decisions.readSubmissionSessionOrigin(scope, submissionId)?.sessionId)
        .toBe(sessionId);
      expect(fx.decisions.listSessionOrigins(scope, sessionId)).toHaveLength(1);
      // The acceptance-shaped roster write seeded one invited engagement per
      // candidate participant inside the same transaction.
      expect(fx.decisions.engagements.listSeededEngagements(scope, sessionId, submissionId))
        .toEqual([expect.objectContaining({
          personId, state: 'invited', version: 1, submissionId,
          source: { kind: 'submission', id: submissionId, version: 7 }
        })]);

      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.decisions.applyDecisionPlan(plan)).toThrow('stale_decision');
      fx.sqlite.exec('ROLLBACK;');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM decision_heads').get())
        .toEqual({ count: 1 });
      expect(fx.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fx.sqlite.close();
    }
  });

  test('origins require an existing Session, stay immutable, and unlink only on the exact image', () => {
    const fx = fixture();
    try {
      fx.candidates.set(submissionId, candidate());
      let minted = false;
      const resolved = resolveDecisionMutationPlanningInput({
        authorInput: {
          action: 'decide',
          decisions: [{
            submissionId, state: 'accepted',
            expectedDecisionVersion: null, expectedDecisionDigestSha256: null
          }]
        } as never,
        scope,
        actorUserId: userId,
        occurredAt: now,
        environment: { decisions: fx.decisions, sessions: fx.decisions },
        newSessionId: () => {
          minted = true;
          return sessionId;
        }
      });
      expect(minted).toBe(true);
      const plan = planDecisionMutation({
        planningInput: resolved,
        environment: { decisions: fx.decisions, sessions: fx.decisions }
      });

      // Writing the origin before its spawned Session exists breaks the FK.
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.decisions.applyDecisionPlan(plan)).toThrow();
      fx.sqlite.exec('ROLLBACK;');

      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applySessionGraduation(plan.rows[0]!.graduation!);
      fx.decisions.applyDecisionPlan(plan);
      fx.sqlite.exec('COMMIT;');
      expect(() => fx.sqlite.query(`
        UPDATE submission_session_origins SET kind = 'attached'
      `).run()).toThrow('immutable');

      const compensation = planDecisionCompensation({
        original: plan,
        environment: { decisions: fx.decisions, sessions: fx.decisions },
        actorUserId: userId,
        occurredAt: later
      });
      expect(compensation.kind).toBe('exact');
      if (compensation.kind === 'blocked') throw new TypeError('unexpected_blocked');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 1 });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applyDecisionPlan(compensation.plan);
      for (const row of compensation.plan.rows) {
        if (row.sessionRestore) fx.decisions.applySessionGraduationReversal(row.sessionRestore);
      }
      fx.sqlite.exec('COMMIT;');
      expect(fx.decisions.readDecisionHead(scope, submissionId)).toBeUndefined();
      expect(fx.decisions.readSubmissionSessionOrigin(scope, submissionId)).toBeUndefined();
      expect(fx.sessions.readSessionCatalog(scope)?.sessions).toEqual([]);
      expect(fx.sqlite.query('SELECT count(*) AS count FROM submission_session_origins').get())
        .toEqual({ count: 0 });
      // Compensation removed exactly the seeded engagement rows before the
      // spawned Session row left, so the foreign key held throughout.
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 0 });
    } finally {
      fx.sqlite.close();
    }
  });

  test('counts schedule placements as the graduation-reversal reference gate', () => {
    const fx = fixture();
    try {
      seedCollectingSession(fx);
      expect(fx.decisions.countSessionSchedulePlacements(scope, sessionId)).toBe(0);
      const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa701';
      const occurrenceId = '019c1df7-86b5-769b-bba4-5f7097bfa702';
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.sqlite.query(`
        INSERT INTO program_vocabulary_rooms (
          workspace_id, event_id, id, name, status, capacity, version,
          created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, 'Main Hall', 'active', NULL, 1, ?, ?, ?, ?)
      `).run(workspaceId, eventId, roomId, userId, Date.parse(now), userId, Date.parse(now));
      fx.sqlite.query(`
        INSERT INTO schedule_placement_sets (
          workspace_id, event_id, schedule_version, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, 2, ?, ?)
      `).run(workspaceId, eventId, userId, Date.parse(now));
      fx.sqlite.query(`
        INSERT INTO schedule_occurrences (
          workspace_id, event_id, id, session_id, room_id, start_at_ms, end_at_ms,
          version, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        workspaceId, eventId, occurrenceId, sessionId, roomId,
        Date.parse(now), Date.parse(later), userId, Date.parse(now)
      );
      fx.sqlite.exec('COMMIT;');
      expect(fx.decisions.countSessionSchedulePlacements(scope, sessionId)).toBe(1);
    } finally {
      fx.sqlite.close();
    }
  });

  test('waitlist and decline seed no engagements, and an advanced engagement blocks the compensating removal', () => {
    const fx = fixture();
    try {
      seedCollectingSession(fx);
      fx.candidates.set(submissionId, candidate({ targetSessionId: sessionId }));
      const waitlist = planDecisionMutation({
        planningInput: {
          action: 'decide', scope, actorUserId: userId, occurredAt: now,
          decisions: [{
            submissionId, state: 'waitlisted',
            expectedDecisionVersion: null, expectedDecisionDigestSha256: null,
            graduation: null
          }]
        },
        environment: { decisions: fx.decisions, sessions: fx.decisions }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applyDecisionPlan(waitlist);
      fx.sqlite.exec('COMMIT;');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 0 });

      const head = fx.decisions.readDecisionHead(scope, submissionId)!;
      const accept = planDecisionMutation({
        planningInput: {
          action: 'decide', scope, actorUserId: userId, occurredAt: now,
          decisions: [{
            submissionId, state: 'accepted',
            expectedDecisionVersion: head.version,
            expectedDecisionDigestSha256: head.digestSha256,
            graduation: { kind: 'attach', sessionId }
          }]
        },
        environment: { decisions: fx.decisions, sessions: fx.decisions }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applySessionGraduation(accept.rows[0]!.graduation!);
      fx.decisions.applyDecisionPlan(accept);
      fx.sqlite.exec('COMMIT;');
      const seeded = fx.decisions.engagements.listSeededEngagements(scope, sessionId, submissionId);
      expect(seeded).toHaveLength(1);

      // A recorded confirmation moves the seeded row past invited; the
      // compensating removal now aborts instead of destroying the response.
      const confirm = planEngagementMutation({
        planningInput: {
          action: 'record_confirmation',
          scope, actorUserId: userId, occurredAt: later,
          engagementId: seeded[0]!.id,
          expectedEngagementVersion: 1,
          attribution: 'organizer_recorded'
        },
        environment: { engagements: fx.decisions.engagements }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.engagements.applyEngagementPlan(confirm);
      fx.sqlite.exec('COMMIT;');
      const compensation = planDecisionCompensation({
        original: accept,
        environment: { decisions: fx.decisions, sessions: fx.decisions },
        actorUserId: userId,
        occurredAt: later
      });
      if (compensation.kind === 'blocked') throw new TypeError('unexpected_blocked');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.decisions.applyDecisionPlan(compensation.plan))
        .toThrow('engagement_advanced');
      fx.sqlite.exec('ROLLBACK;');
      expect(fx.decisions.readDecisionHead(scope, submissionId)?.state).toBe('accepted');
      expect(fx.decisions.engagements.readSessionPersonEngagement(scope, sessionId, personId))
        .toMatchObject({ state: 'confirmed', version: 2 });
    } finally {
      fx.sqlite.close();
    }
  });

  test('compensating a re-acceptance leaves rows an earlier acceptance seeded standing', () => {
    // Adversarial sequence: accept #1 seeds (S, P); a stays-standing semantic
    // compensation deliberately preserves that row; a re-acceptance of the
    // same submission then seeds nothing (the pair exists). Compensating the
    // re-acceptance must remove exactly what IT seeded — nothing — because
    // the survivor carries accept #1's decision pin, not accept #2's.
    const evenLater = parseInstant('2026-08-13T08:10:00.000Z');
    const personQ = '019c1df7-86b5-769b-bba4-5f7097bfa602';
    const fx = fixture();
    try {
      seedCollectingSession(fx);
      fx.candidates.set(submissionId, candidate({ targetSessionId: sessionId }));

      // Accept #1 (attach): seeds the invited row pinned to its own head.
      const accept1 = acceptPlan(fx, { kind: 'attach', sessionId });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applySessionGraduation(accept1.rows[0]!.graduation!);
      fx.decisions.applyDecisionPlan(accept1);
      fx.sqlite.exec('COMMIT;');
      const seededByAccept1 = Object.freeze({
        version: accept1.rows[0]!.after.version,
        digestSha256: accept1.rows[0]!.after.digestSha256
      });
      expect(fx.decisions.engagements.listSeededEngagements(scope, sessionId, submissionId))
        .toEqual([expect.objectContaining({ seededByDecision: seededByAccept1 })]);

      // An unrelated ordinary roster append moves the Session digest, so the
      // first compensation derives SEMANTIC stays-standing.
      const catalog = fx.sessions.readSessionCatalog(scope)!;
      const current = catalog.sessions.find((session) => session.id === sessionId)!;
      const append = planSessionMutation({
        catalog,
        vocabulary: fx.sessions.readSessionVocabulary(scope)!,
        planningInput: {
          action: 'roster_append', scope, sessionId, actorUserId: userId, occurredAt: later,
          expectedCatalogVersion: catalog.version,
          expectedCatalogDigestSha256: catalog.digestSha256,
          expectedSessionVersion: current.version,
          expectedSessionDigestSha256: current.digestSha256,
          participants: [{
            personId: personQ, role: 'speaker', publiclyVisible: true,
            source: { kind: 'manual', id: userId, version: 1 }
          }]
        }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.sessions.applySessionPlan(append);
      fx.sqlite.exec('COMMIT;');
      const compensation1 = planDecisionCompensation({
        original: accept1,
        environment: { decisions: fx.decisions, sessions: fx.decisions },
        actorUserId: userId,
        occurredAt: later
      });
      expect(compensation1.kind).toBe('semantic');
      if (compensation1.kind === 'blocked') throw new TypeError('unexpected_blocked');
      expect(compensation1.plan.rows[0]!.sessionRestore).toBeNull();
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applyDecisionPlan(compensation1.plan);
      fx.sqlite.exec('COMMIT;');
      // The recorded stays-standing semantics: the engagement survives.
      expect(fx.decisions.readDecisionHead(scope, submissionId)).toBeUndefined();
      expect(fx.decisions.engagements.listSeededEngagements(scope, sessionId, submissionId))
        .toHaveLength(1);

      // Re-accept (attach): the pair exists, so this acceptance seeds nothing.
      const accept2 = planDecisionMutation({
        planningInput: {
          action: 'decide', scope, actorUserId: userId, occurredAt: evenLater,
          decisions: [{
            submissionId, state: 'accepted',
            expectedDecisionVersion: null, expectedDecisionDigestSha256: null,
            graduation: { kind: 'attach', sessionId }
          }]
        },
        environment: { decisions: fx.decisions, sessions: fx.decisions }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applySessionGraduation(accept2.rows[0]!.graduation!);
      fx.decisions.applyDecisionPlan(accept2);
      fx.sqlite.exec('COMMIT;');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 1 });

      // Compensating the re-acceptance derives EXACT (untouched since) and
      // must not delete the survivor accept #2 never seeded.
      const compensation2 = planDecisionCompensation({
        original: accept2,
        environment: { decisions: fx.decisions, sessions: fx.decisions },
        actorUserId: userId,
        occurredAt: evenLater
      });
      if (compensation2.kind === 'blocked') throw new TypeError('unexpected_blocked');
      expect(compensation2.plan.rows[0]!.sessionRestore).not.toBeNull();
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.decisions.applyDecisionPlan(compensation2.plan);
      for (const row of compensation2.plan.rows) {
        if (row.sessionRestore) fx.decisions.applySessionGraduationReversal(row.sessionRestore);
      }
      fx.sqlite.exec('COMMIT;');

      // P stays rostered AND keeps engagement tracking with accept #1's pin:
      // no rostered person falls through the cracks.
      const roster = fx.sessions.readSessionCatalog(scope)!
        .sessions.find((session) => session.id === sessionId)!
        .roster.participants.map((participant) => participant.personId);
      expect(roster).toContain(personId);
      expect(fx.decisions.engagements.listSeededEngagements(scope, sessionId, submissionId))
        .toEqual([expect.objectContaining({
          personId, state: 'invited', version: 1, seededByDecision: seededByAccept1
        })]);
      expect(fx.decisions.readDecisionHead(scope, submissionId)).toBeUndefined();
      expect(fx.decisions.readSubmissionSessionOrigin(scope, submissionId)).toBeUndefined();
    } finally {
      fx.sqlite.close();
    }
  });

  test('candidate source derives the same version as the Review candidate source over one row', () => {
    const row: SubmissionTriageSourceRowDto = {
      schemaVersion: 1,
      scope,
      source: 'public_form',
      summary: {
        schemaVersion: 1,
        id: submissionId,
        formId,
        formVersionId,
        target: { kind: 'session', sessionId },
        title: 'Persistent Talk',
        primaryParticipantName: 'Ada Lovelace',
        submittedAt: now
      },
      detail: {
        schemaVersion: 1,
        submissionId,
        formId,
        formVersionId,
        submittedAt: now,
        participantCount: 1,
        answers: [],
        affirmedConsentFieldIds: []
      },
      abstract: null,
      track: { id: trackId, label: 'Platform' },
      format: { id: formatId, label: 'Talk' }
    };
    const source = {
      listSourceRows: () => [row],
      readSourceRow: (_scope: unknown, id: string) => id === submissionId ? row : undefined
    };
    const adapter = new SQLiteDecisionCandidateSourceAdapter(source, {
      listParticipantPersonIds: () => [personId]
    });
    const decisionCandidate = adapter.readDecisionCandidate(scope, submissionId)!;
    expect(decisionCandidate).toMatchObject({
      submissionId,
      formVersionId,
      title: 'Persistent Talk',
      formatId,
      trackId,
      targetSessionId: sessionId,
      participantPersonIds: [personId]
    });
    const reviewCandidate = new SQLiteReviewCandidateSourceAdapter(source)
      .readCandidate(scope, submissionId)!;
    expect(decisionCandidate.candidateVersion).toBe(reviewCandidate.version);
    expect(adapter.readDecisionCandidate(scope, '019c1df7-86b5-769b-bba4-5f7097bfaff0'))
      .toBeUndefined();
  });
});
