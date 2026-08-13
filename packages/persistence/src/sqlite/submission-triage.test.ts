import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  submissionTriageSourceRowSchema,
  type SubmissionTriageAttribution,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import {
  createSubmissionTriageInitialization,
  planSubmissionTriageTransition,
  projectSubmissionTriageList,
  projectSubmissionTriageRead,
  type SubmissionTriageScope,
  type SubmissionTriageSourcePort
} from '@jooevents/submission-triage';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteSubmissionTriageError,
  SQLiteSubmissionTriageRepository
} from './submission-triage';

const id = (suffix: number): string =>
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const otherEventId = id(3);
const formId = id(4);
const formVersionId = id(5);
const fieldId = id(6);
const submittedAt = '2026-08-12T10:00:00.000Z';
const closeAt = '2026-08-12T09:00:00.000Z';
const scope = Object.freeze({ workspaceId, eventId });

function sourceRow(input: {
  readonly submissionId: string;
  readonly currentScope?: SubmissionTriageScope;
  readonly title?: string;
  readonly name?: string;
  readonly abstract?: string;
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
      target: { kind: 'general_pool' },
      title: input.title ?? `Proposal ${input.submissionId.slice(-2)}`,
      primaryParticipantName: input.name ?? 'José Sørensen',
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
        kind: 'text', fieldId, fieldLabel: 'Session title',
        value: input.title ?? 'Durable event systems'
      }],
      affirmedConsentFieldIds: []
    },
    abstract: input.abstract ?? 'Kubernetes without cognitive overload',
    track: null,
    format: null
  });
}

class Source implements SubmissionTriageSourcePort {
  readonly rows = new Map<string, SubmissionTriageSourceRowDto[]>();

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
  return { sqlite, source, repository: new SQLiteSubmissionTriageRepository(sqlite, source) };
}

function initialization(row: SubmissionTriageSourceRowDto, suffix: number) {
  return createSubmissionTriageInitialization({
    scope: row.scope,
    submission: {
      id: row.summary.id,
      formId: row.summary.formId,
      formVersionId: row.summary.formVersionId,
      source: row.source,
      submittedAt: row.summary.submittedAt
    },
    arrivalId: id(suffix),
    recordedAt: submittedAt,
    closeEvidence: {
      closeAt,
      policy: {
        reference: { key: 'submission.accepting-window', version: 1 },
        definitionDigestSha256: 'a'.repeat(64)
      }
    }
  });
}

function initialize(
  sqlite: Database,
  repository: SQLiteSubmissionTriageRepository,
  value: ReturnType<typeof initialization>
) {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = repository.initializeSubmissionTriage(value);
    sqlite.exec('COMMIT');
    return result;
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

describe('SQLite submission triage repository', () => {
  test('initialization is transaction-bound, rollback-safe, exact-replayable, and collision honest', () => {
    const { sqlite, source, repository } = openDatabase();
    const row = sourceRow({ submissionId: id(10) });
    source.rows.set(`${workspaceId}:${eventId}`, [row]);
    const value = initialization(row, 20);
    try {
      expect(() => repository.initializeSubmissionTriage(value))
        .toThrow('transaction_required');

      sqlite.exec('BEGIN IMMEDIATE');
      expect(repository.initializeSubmissionTriage(value).replay).toBe(false);
      expect(repository.readTriageState(scope)?.entries).toHaveLength(1);
      sqlite.exec('ROLLBACK');
      expect(repository.readTriageState(scope)).toBeUndefined();

      const inserted = initialize(sqlite, repository, value);
      expect(inserted.replay).toBe(false);
      const version = inserted.queryGuard.version;

      sqlite.exec('BEGIN IMMEDIATE');
      const replay = repository.initializeSubmissionTriage(value);
      sqlite.exec('COMMIT');
      expect(replay).toMatchObject({ replay: true, submissionId: row.summary.id });
      expect(replay.queryGuard.version).toBe(version);

      sqlite.exec('BEGIN IMMEDIATE');
      expect(() => repository.initializeSubmissionTriage({
        ...value,
        arrival: { ...value.arrival, id: id(21) }
      })).toThrow('id_collision');
      sqlite.exec('ROLLBACK');
      expect(repository.readTriageState(scope)?.queryGuard.version).toBe(version);
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });

  test('refuses a cross-event source row before writing any triage state', () => {
    const { sqlite, source, repository } = openDatabase();
    const leaked = sourceRow({ submissionId: id(11), currentScope: scope });
    const requestedScope = { workspaceId, eventId: otherEventId };
    source.rows.set(`${workspaceId}:${otherEventId}`, [leaked]);
    const value = createSubmissionTriageInitialization({
      scope: requestedScope,
      submission: {
        id: leaked.summary.id,
        formId: leaked.summary.formId,
        formVersionId: leaked.summary.formVersionId,
        source: leaked.source,
        submittedAt: leaked.summary.submittedAt
      },
      arrivalId: id(22),
      recordedAt: submittedAt,
      closeEvidence: null
    });
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      expect(() => repository.initializeSubmissionTriage(value)).toThrow('source_changed');
      sqlite.exec('ROLLBACK');
      expect(repository.readTriageState(requestedScope)).toBeUndefined();
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });

  test('bulk transitions are atomic and stale plans perform zero writes', () => {
    const { sqlite, source, repository } = openDatabase();
    const rows = [10, 11, 12].map((suffix) => sourceRow({ submissionId: id(suffix) }));
    source.rows.set(`${workspaceId}:${eventId}`, rows);
    try {
      rows.forEach((row, index) => initialize(sqlite, repository, initialization(row, 30 + index)));
      const before = repository.readTriageState(scope)!;
      const bulk = planSubmissionTriageTransition({
        state: before,
        action: 'set_aside',
        submissionIds: [id(10), id(11)],
        expectedHeads: [
          { submissionId: id(10), version: 1 },
          { submissionId: id(11), version: 1 }
        ],
        expectedQueryGuard: before.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:01:00.000Z'
      });
      sqlite.exec(`
        CREATE TEMP TRIGGER stop_second_triage_update
        BEFORE UPDATE ON submission_triage_heads
        WHEN OLD.submission_id = '${id(11)}'
        BEGIN SELECT RAISE(ABORT, 'forced second-row failure'); END;
      `);
      sqlite.exec('BEGIN IMMEDIATE');
      expect(() => repository.applyTransitionPlan(bulk)).toThrow('stale_state');
      sqlite.exec('ROLLBACK');
      expect(repository.readTriageState(scope)).toEqual(before);
      sqlite.exec('DROP TRIGGER stop_second_triage_update');

      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(bulk);
      sqlite.exec('COMMIT');
      const afterBulk = repository.readTriageState(scope)!;
      expect(afterBulk.entries.map((entry) => entry.head.state)).toEqual([
        'set_aside', 'set_aside', 'inbox'
      ]);

      const staleBefore = repository.readTriageState(scope)!;
      const stale = planSubmissionTriageTransition({
        state: staleBefore,
        action: 'discard_recoverable',
        submissionIds: [id(12)],
        expectedHeads: [{ submissionId: id(12), version: 1 }],
        expectedQueryGuard: staleBefore.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:02:00.000Z'
      });
      const intervening = planSubmissionTriageTransition({
        state: staleBefore,
        action: 'return_to_inbox',
        submissionIds: [id(10)],
        expectedHeads: [{ submissionId: id(10), version: 2 }],
        expectedQueryGuard: staleBefore.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:02:30.000Z'
      });
      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(intervening);
      sqlite.exec('COMMIT');
      const afterIntervening = repository.readTriageState(scope)!;

      sqlite.exec('BEGIN IMMEDIATE');
      expect(() => repository.applyTransitionPlan(stale)).toThrow('stale_state');
      sqlite.exec('ROLLBACK');
      expect(repository.readTriageState(scope)).toEqual(afterIntervening);
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });

  test('late remains orthogonal across mixed trays and projections disclose no contact', () => {
    const { sqlite, source, repository } = openDatabase();
    const rows = [
      sourceRow({ submissionId: id(10), title: 'Secondary body', name: 'Lina', abstract: 'Kubernetes notes' }),
      sourceRow({ submissionId: id(11), title: 'Kubernetes primary', name: 'José Sørensen' })
    ];
    source.rows.set(`${workspaceId}:${eventId}`, rows);
    try {
      rows.forEach((row, index) => initialize(sqlite, repository, initialization(row, 40 + index)));
      const before = repository.readTriageState(scope)!;
      expect(before.entries.every((entry) => entry.arrival.classification === 'late')).toBe(true);
      const plan = planSubmissionTriageTransition({
        state: before,
        action: 'set_aside',
        submissionIds: [id(10)],
        expectedHeads: [{ submissionId: id(10), version: 1 }],
        expectedQueryGuard: before.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:03:00.000Z'
      });
      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(plan);
      sqlite.exec('COMMIT');
      const state = repository.readTriageState(scope)!;
      const page = projectSubmissionTriageList({ state, sourceRows: rows });
      expect(page.trayTotals).toEqual({ inbox: 0, set_aside: 1, late: 1, discarded: 0 });
      expect(page.rows.map((row) => row.visibleTray)).toEqual(['set_aside', 'late']);
      expect(projectSubmissionTriageList({
        state, sourceRows: [rows[1]!, rows[0]!]
      }).rows.map((row) => row.source.summary.id)).toEqual([id(11), id(10)]);
      const ranked = projectSubmissionTriageList({
        state, sourceRows: rows, query: { search: 'kube' }
      });
      expect(ranked.rows.map((row) => row.source.summary.id)).toEqual([id(11), id(10)]);
      const folded = projectSubmissionTriageList({
        state, sourceRows: rows, query: { search: 'sorensen' }
      });
      expect(folded.rows.map((row) => row.source.summary.id)).toEqual([id(11)]);
      const detail = projectSubmissionTriageRead({
        state, sourceRows: rows, submissionId: id(11)
      });
      expect(JSON.stringify(detail)).not.toContain('@');
      expect(JSON.stringify(detail)).not.toContain('email');

      const discard = planSubmissionTriageTransition({
        state,
        action: 'discard_recoverable',
        submissionIds: [id(11)],
        expectedHeads: [{ submissionId: id(11), version: 1 }],
        expectedQueryGuard: state.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:04:00.000Z'
      });
      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(discard);
      sqlite.exec('COMMIT');
      const discarded = repository.readTriageState(scope)!;
      expect(projectSubmissionTriageRead({
        state: discarded, sourceRows: rows, submissionId: id(11)
      })?.row).toMatchObject({
        visibleTray: 'discarded',
        triage: { state: 'discarded_recoverable' },
        arrival: { classification: 'late' }
      });

      const restore = planSubmissionTriageTransition({
        state: discarded,
        action: 'restore',
        submissionIds: [id(11)],
        expectedHeads: [{ submissionId: id(11), version: 2 }],
        expectedQueryGuard: discarded.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:05:00.000Z'
      });
      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(restore);
      sqlite.exec('COMMIT');
      const restored = repository.readTriageState(scope)!;
      expect(projectSubmissionTriageRead({
        state: restored, sourceRows: rows, submissionId: id(11)
      })?.row).toMatchObject({
        visibleTray: 'late',
        triage: { state: 'inbox' },
        arrival: { classification: 'late' }
      });
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});
