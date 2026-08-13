import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  submissionTriageSourceRowSchema,
  type SubmissionTriageAttribution,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import type { ReviewScopeDto } from '@jooevents/contracts/reviews';
import { parseApplicationId } from '@jooevents/kernel';
import {
  createSubmissionTriageInitialization,
  planSubmissionTriageTransition,
  type SubmissionTriageScope,
  type SubmissionTriageSourcePort
} from '@jooevents/submission-triage';
import {
  SQLiteReviewCandidateSourceAdapter,
  SQLiteReviewCandidateSourceError
} from './review-candidate-source';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteSubmissionTriageRepository
} from './submission-triage';

const id = (suffix: number) => parseApplicationId(
  'user',
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`
);
const workspaceId = id(1);
const eventId = id(2);
const otherEventId = id(3);
const formId = id(4);
const formVersionId = id(5);
const abstractFieldId = id(6);
const trackId = id(7);
const formatId = id(8);
const sessionId = id(9);
const roundId = id(80);
const reviewerId = id(81);
const submittedAt = '2026-08-12T10:00:00.000Z';
const scope: ReviewScopeDto = Object.freeze({ workspaceId, eventId });

function sourceRow(input: {
  readonly submissionId: string;
  readonly currentScope?: SubmissionTriageScope;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly abstract?: string | null;
  readonly target?: SubmissionTriageSourceRowDto['summary']['target'];
  readonly track?: SubmissionTriageSourceRowDto['track'];
  readonly format?: SubmissionTriageSourceRowDto['format'];
}): SubmissionTriageSourceRowDto {
  const currentScope = input.currentScope ?? scope;
  return submissionTriageSourceRowSchema.parse({
    schemaVersion: 1,
    scope: currentScope,
    source: 'public_form',
    summary: {
      schemaVersion: 1,
      id: input.submissionId,
      formId,
      formVersionId,
      target: input.target ?? { kind: 'general_pool' },
      title: input.title === undefined ? `Proposal ${input.submissionId.slice(-2)}` : input.title,
      primaryParticipantName: input.name === undefined ? 'José Sørensen' : input.name,
      submittedAt
    },
    detail: {
      schemaVersion: 1,
      submissionId: input.submissionId,
      formId,
      formVersionId,
      submittedAt,
      participantCount: 1,
      answers: [{
        kind: 'textarea', fieldId: abstractFieldId, fieldLabel: 'Abstract',
        value: input.abstract ?? 'Durable event systems'
      }],
      affirmedConsentFieldIds: []
    },
    abstract: input.abstract === undefined ? 'Durable event systems' : input.abstract,
    track: input.track ?? null,
    format: input.format ?? null
  });
}

class Source implements SubmissionTriageSourcePort {
  readonly rows = new Map<string, SubmissionTriageSourceRowDto[]>();

  set(currentScope: SubmissionTriageScope, rows: readonly SubmissionTriageSourceRowDto[]): void {
    this.rows.set(`${currentScope.workspaceId}:${currentScope.eventId}`, [...rows]);
  }

  listSourceRows(currentScope: SubmissionTriageScope): readonly SubmissionTriageSourceRowDto[] {
    return this.rows.get(`${currentScope.workspaceId}:${currentScope.eventId}`) ?? [];
  }

  readSourceRow(currentScope: SubmissionTriageScope, submissionId: string) {
    return this.listSourceRows(currentScope).find((row) => row.summary.id === submissionId);
  }
}

function openDatabase() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE event_spine_scope_roots (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES
      ('${workspaceId}', '${eventId}'),
      ('${workspaceId}', '${otherEventId}');
  `);
  installSQLiteSubmissionTriageSchema(sqlite);
  const source = new Source();
  const repository = new SQLiteSubmissionTriageRepository(sqlite, source);
  return {
    sqlite,
    source,
    repository,
    adapter: new SQLiteReviewCandidateSourceAdapter(repository)
  };
}

function initialize(
  sqlite: Database,
  repository: SQLiteSubmissionTriageRepository,
  row: SubmissionTriageSourceRowDto,
  arrivalSuffix: number
): void {
  const value = createSubmissionTriageInitialization({
    scope: row.scope,
    submission: {
      id: row.summary.id,
      formId: row.summary.formId,
      formVersionId: row.summary.formVersionId,
      source: row.source,
      submittedAt: row.summary.submittedAt
    },
    arrivalId: id(arrivalSuffix),
    recordedAt: submittedAt,
    closeEvidence: null
  });
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    repository.initializeSubmissionTriage(value);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

const attribution: SubmissionTriageAttribution = Object.freeze({
  kind: 'manual',
  principalKey: 'workspace-user:test',
  invocationId: id(90),
  surface: 'operator_http'
});

function transition(
  sqlite: Database,
  repository: SQLiteSubmissionTriageRepository,
  action: 'set_aside' | 'return_to_inbox',
  submissionId: string,
  expectedVersion: number,
  changedAt: string
): void {
  const state = repository.readTriageState(scope)!;
  const plan = planSubmissionTriageTransition({
    state,
    action,
    submissionIds: [submissionId],
    expectedHeads: [{ submissionId, version: expectedVersion }],
    expectedQueryGuard: state.queryGuard,
    attribution,
    changedAt
  });
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    repository.applyTransitionPlan(plan);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

describe('SQLite review candidate source adapter', () => {
  test('both faces derive from one row and agree on version, track, format, and session target', () => {
    const { sqlite, source, adapter } = openDatabase();
    try {
      source.set(scope, [
        sourceRow({
          submissionId: id(10),
          track: { id: trackId, label: 'Data & AI' },
          format: { id: formatId, label: 'Talk' }
        }),
        sourceRow({
          submissionId: id(11),
          target: { kind: 'session', sessionId }
        })
      ]);
      const set = adapter.readCandidates(scope)!;
      expect(set.candidates.map((candidate) => candidate.submissionId)).toEqual([id(10), id(11)]);
      expect(set.candidates[0]).toMatchObject({ trackId, formatId });
      expect(set.candidates[0]?.targetSessionId).toBeUndefined();
      expect(set.candidates[1]).toMatchObject({ targetSessionId: sessionId });
      for (const candidate of set.candidates) {
        expect(adapter.readCandidate(scope, candidate.submissionId)).toEqual(candidate);
        const display = adapter.readReviewCandidateDisplay({
          scope, roundId, submissionId: candidate.submissionId,
          reviewerId, includeSpeakerIdentity: false
        })!;
        expect(display.submissionId).toBe(candidate.submissionId);
        expect(display.version).toBe(candidate.version);
        expect(display.trackId).toBe(candidate.trackId);
        expect(display.formatId).toBe(candidate.formatId);
        expect(display.targetSessionId).toBe(candidate.targetSessionId);
        expect(display.abstract).toBe('Durable event systems');
        expect(display.resources).toEqual([]);
      }
      expect(adapter.readCandidate(scope, id(99))).toBeUndefined();
      expect(adapter.readReviewCandidateDisplay({
        scope, roundId, submissionId: id(99), reviewerId, includeSpeakerIdentity: false
      })).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test('withholds the speakers key entirely unless identity is released, and never a contact', () => {
    const { sqlite, source, adapter } = openDatabase();
    try {
      source.set(scope, [sourceRow({ submissionId: id(10) })]);
      const blind = adapter.readReviewCandidateDisplay({
        scope, roundId, submissionId: id(10), reviewerId, includeSpeakerIdentity: false
      })!;
      expect('speakers' in blind).toBe(false);
      const released = adapter.readReviewCandidateDisplay({
        scope, roundId, submissionId: id(10), reviewerId, includeSpeakerIdentity: true
      })!;
      expect(released.speakers).toHaveLength(1);
      expect(released.speakers?.[0]?.displayName).toBe('José Sørensen');
      const speakerId = released.speakers?.[0]?.speakerId;
      expect(speakerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(speakerId).not.toBe(id(10));
      expect(adapter.readReviewCandidateDisplay({
        scope, roundId, submissionId: id(10), reviewerId, includeSpeakerIdentity: true
      })?.speakers?.[0]?.speakerId).toBe(speakerId);

      const serialized = JSON.stringify([
        adapter.readCandidates(scope), blind, released
      ]);
      expect(serialized).not.toContain('@');
      expect(serialized.toLowerCase()).not.toContain('email');
    } finally {
      sqlite.close();
    }
  });

  test('refuses rows that smuggle contact material or cross the requested scope', () => {
    const { sqlite, source, adapter } = openDatabase();
    try {
      const genuine = sourceRow({ submissionId: id(10) });
      const withContact = { ...genuine, contact: { email: 'private@example.test' } };
      source.set(scope, [withContact]);
      expect(() => adapter.readCandidates(scope))
        .toThrow(SQLiteReviewCandidateSourceError);
      expect(() => adapter.readReviewCandidateDisplay({
        scope, roundId, submissionId: id(10), reviewerId, includeSpeakerIdentity: true
      })).toThrow('source_row_invalid');

      const withSummaryEmail = {
        ...genuine,
        summary: { ...genuine.summary, email: 'private@example.test' }
      };
      source.set(scope, [withSummaryEmail]);
      expect(() => adapter.readCandidates(scope)).toThrow('source_row_invalid');

      const leaked = sourceRow({ submissionId: id(11) });
      source.set({ workspaceId, eventId: otherEventId }, [leaked]);
      expect(() => adapter.readCandidates({ workspaceId, eventId: otherEventId }))
        .toThrow('source_row_out_of_scope');
    } finally {
      sqlite.close();
    }
  });

  test('untitled submissions are excluded from both faces consistently', () => {
    const { sqlite, source, adapter } = openDatabase();
    try {
      source.set(scope, [
        sourceRow({ submissionId: id(10) }),
        sourceRow({ submissionId: id(11), title: null })
      ]);
      const set = adapter.readCandidates(scope)!;
      expect(set.candidates.map((candidate) => candidate.submissionId)).toEqual([id(10)]);
      expect(adapter.readCandidate(scope, id(11))).toBeUndefined();
      expect(adapter.readReviewCandidateDisplay({
        scope, roundId, submissionId: id(11), reviewerId, includeSpeakerIdentity: true
      })).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test('triage set_aside and return_to_inbox never change the candidate set version', () => {
    const { sqlite, source, repository, adapter } = openDatabase();
    try {
      const rows = [sourceRow({ submissionId: id(10) }), sourceRow({ submissionId: id(11) })];
      source.set(scope, rows);
      rows.forEach((row, index) => initialize(sqlite, repository, row, 20 + index));
      const before = adapter.readCandidates(scope)!;
      expect(before.candidates).toHaveLength(2);

      transition(sqlite, repository, 'set_aside', id(10), 1, '2026-08-12T10:01:00.000Z');
      const afterSetAside = adapter.readCandidates(scope)!;
      expect(afterSetAside.version).toBe(before.version);
      expect(afterSetAside.candidates).toEqual(before.candidates);

      transition(sqlite, repository, 'return_to_inbox', id(10), 2, '2026-08-12T10:02:00.000Z');
      const afterReturn = adapter.readCandidates(scope)!;
      expect(afterReturn.version).toBe(before.version);
      expect(afterReturn.candidates).toEqual(before.candidates);

      // A genuinely new arrival is candidate drift and must move the set version.
      const arrival = sourceRow({ submissionId: id(12) });
      source.set(scope, [...rows, arrival]);
      initialize(sqlite, repository, arrival, 22);
      const afterArrival = adapter.readCandidates(scope)!;
      expect(afterArrival.version).not.toBe(before.version);
      expect(afterArrival.candidates.map((candidate) => candidate.version).slice(0, 2))
        .toEqual(before.candidates.map((candidate) => candidate.version));
    } finally {
      sqlite.close();
    }
  });
});
