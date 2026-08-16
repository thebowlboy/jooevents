import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  planDecisionMutation,
  resolveDecisionMutationPlanningInput,
  type DecisionEnvironmentSource
} from '@jooevents/decision';
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
    CREATE TABLE operation_log (
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

  test('origins require an existing Session and stay immutable; correction is a later decide', () => {
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

      expect(fx.decisions.readDecisionHead(scope, submissionId)).toBeDefined();
      expect(fx.decisions.readSubmissionSessionOrigin(scope, submissionId)).toBeDefined();
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

  test('waitlist and decline seed no engagements; later corrections preserve responses', () => {
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

      expect(fx.decisions.engagements.listSeededEngagements(scope, sessionId, submissionId))
        .toHaveLength(1);
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
