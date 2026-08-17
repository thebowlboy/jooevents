import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUBMISSION_TRIAGE_LIST_MAX,
  submissionTriageSourceRowSchema,
  type SubmissionTriageAttribution,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  createSubmissionTriageInitialization,
  createSubmissionTriageState,
  createSubmissionTriageSubmitInitializer,
  planSubmissionTriageTransition,
  projectSubmissionTriageList,
  projectSubmissionTriageRead,
  submissionTriageArrivalDigest,
  submissionTriageHeadDigest,
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
  readonly source?: SubmissionTriageSourceRowDto['source'];
}): SubmissionTriageSourceRowDto {
  const currentScope = input.currentScope ?? scope;
  return submissionTriageSourceRowSchema.parse({
    schemaVersion: 1,
    scope: currentScope,
    source: input.source ?? 'public_form',
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
        action: 'mark_spam',
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
      expect(page.trayTotals).toEqual({ inbox: 0, set_aside: 1, late: 1, spam: 0 });
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

      const markSpam = planSubmissionTriageTransition({
        state,
        action: 'mark_spam',
        submissionIds: [id(11)],
        expectedHeads: [{ submissionId: id(11), version: 1 }],
        expectedQueryGuard: state.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:04:00.000Z'
      });
      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(markSpam);
      sqlite.exec('COMMIT');
      const spam = repository.readTriageState(scope)!;
      expect(projectSubmissionTriageRead({
        state: spam, sourceRows: rows, submissionId: id(11)
      })?.row).toMatchObject({
        visibleTray: 'spam',
        triage: { state: 'spam' },
        arrival: { classification: 'late' }
      });

      const notSpam = planSubmissionTriageTransition({
        state: spam,
        action: 'not_spam',
        submissionIds: [id(11)],
        expectedHeads: [{ submissionId: id(11), version: 2 }],
        expectedQueryGuard: spam.queryGuard,
        attribution,
        changedAt: '2026-08-12T10:05:00.000Z'
      });
      sqlite.exec('BEGIN IMMEDIATE');
      repository.applyTransitionPlan(notSpam);
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

  test('initializes a direct-entry arrival with real close evidence and never classifies it late', () => {
    const { sqlite, source, repository } = openDatabase();
    const direct = sourceRow({ submissionId: id(30), source: 'direct_entry' });
    const publicRow = sourceRow({ submissionId: id(31) });
    source.rows.set(`${workspaceId}:${eventId}`, [direct, publicRow]);

    // Same instants: submittedAt is one hour past closeAt for both arrivals.
    const directValue = initialization(direct, 40);
    const publicValue = initialization(publicRow, 41);
    expect(Date.parse(directValue.arrival.submittedAt))
      .toBeGreaterThan(Date.parse(directValue.arrival.closeEvidence!.closeAt));
    expect(directValue.arrival.source).toBe('direct_entry');
    expect(directValue.arrival.classification).toBe('on_time');
    expect(directValue.arrival.closeEvidence).not.toBeNull();
    expect(publicValue.arrival.classification).toBe('late');

    try {
      const inserted = initialize(sqlite, repository, directValue);
      expect(inserted.replay).toBe(false);
      initialize(sqlite, repository, publicValue);

      const state = repository.readTriageState(scope)!;
      const rows = [direct, publicRow];
      expect(projectSubmissionTriageRead({
        state, sourceRows: rows, submissionId: id(30)
      })?.row).toMatchObject({
        visibleTray: 'inbox',
        arrival: { source: 'direct_entry', classification: 'on_time' }
      });
      expect(projectSubmissionTriageRead({
        state, sourceRows: rows, submissionId: id(31)
      })?.row).toMatchObject({
        visibleTray: 'late',
        arrival: { source: 'public_form', classification: 'late' }
      });

      // A lagging source projection that still claims public_form is refused at commit.
      const mismatched = sourceRow({ submissionId: id(32), source: 'public_form' });
      source.rows.set(`${workspaceId}:${eventId}`, [direct, publicRow, mismatched]);
      const mismatchedValue = createSubmissionTriageInitialization({
        scope,
        submission: {
          id: mismatched.summary.id,
          formId: mismatched.summary.formId,
          formVersionId: mismatched.summary.formVersionId,
          source: 'direct_entry',
          submittedAt: mismatched.summary.submittedAt
        },
        arrivalId: id(42),
        recordedAt: submittedAt,
        closeEvidence: null
      });
      sqlite.exec('BEGIN IMMEDIATE');
      expect(() => repository.initializeSubmissionTriage(mismatchedValue))
        .toThrow('source_changed');
      sqlite.exec('ROLLBACK');
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});

/**
 * Server-projection guarantee: `trayTotals` count every triaged submission in
 * the event, never the returned window. The list contract alone can only
 * enforce that the totals are no smaller than the served rows, so this suite
 * is the invariant's executable proof over a population larger than the
 * window.
 */
describe('conformance: submission triage tray totals state the whole population', () => {
  test('totals count every submission while rows stop at the served window', () => {
    const { sqlite, source, repository } = openDatabase();
    const total = SUBMISSION_TRIAGE_LIST_MAX + 20;
    const lateCount = 15;
    const onTimeCount = total - lateCount;
    try {
      const rows: SubmissionTriageSourceRowDto[] = [];
      const entries: ReturnType<typeof createSubmissionTriageInitialization>[] = [];
      for (let index = 0; index < total; index += 1) {
        const row = sourceRow({ submissionId: id(0x1000 + index) });
        rows.push(row);
        entries.push(createSubmissionTriageInitialization({
          scope,
          submission: {
            id: row.summary.id,
            formId: row.summary.formId,
            formVersionId: row.summary.formVersionId,
            source: row.source,
            submittedAt: row.summary.submittedAt
          },
          arrivalId: id(0x2000 + index),
          recordedAt: submittedAt,
          // The population tail is late, so the served window never reaches it.
          closeEvidence: index < onTimeCount ? null : {
            closeAt,
            policy: {
              reference: { key: 'submission.accepting-window', version: 1 },
              definitionDigestSha256: 'a'.repeat(64)
            }
          }
        }));
      }
      source.rows.set(`${workspaceId}:${eventId}`, rows);
      const assembled = createSubmissionTriageState({ scope, version: 1, entries });
      sqlite.exec('BEGIN IMMEDIATE');
      sqlite.query(`
        INSERT INTO submission_triage_event_heads (
          workspace_id, event_id, query_version, query_digest_sha256
        ) VALUES (?, ?, ?, ?)
      `).run(
        workspaceId, eventId,
        assembled.queryGuard.version, assembled.queryGuard.digestSha256
      );
      const insertArrival = sqlite.query(`
        INSERT INTO submission_arrival_facts (
          workspace_id, event_id, submission_id, arrival_id, form_id, form_version_id,
          source, classification, submitted_at_ms, recorded_at_ms, fact_json,
          fact_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertHead = sqlite.query(`
        INSERT INTO submission_triage_heads (
          workspace_id, event_id, submission_id, head_version, state,
          updated_at_ms, head_json, head_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insertArrival.run(
          entry.arrival.scope.workspaceId, entry.arrival.scope.eventId,
          entry.arrival.submissionId, entry.arrival.id, entry.arrival.formId,
          entry.arrival.formVersionId, entry.arrival.source, entry.arrival.classification,
          Date.parse(entry.arrival.submittedAt), Date.parse(entry.arrival.recordedAt),
          canonicalJsonText(entry.arrival), submissionTriageArrivalDigest(entry.arrival)
        );
        insertHead.run(
          entry.head.scope.workspaceId, entry.head.scope.eventId, entry.head.submissionId,
          entry.head.version, entry.head.state, Date.parse(entry.head.updatedAt),
          canonicalJsonText(entry.head), submissionTriageHeadDigest(entry.head)
        );
      }
      sqlite.exec('COMMIT');

      // The durable read revalidates every row it serves the projection.
      const durable = repository.readTriageState(scope)!;
      expect(durable.entries).toHaveLength(total);

      const page = projectSubmissionTriageList({ state: durable, sourceRows: rows });
      expect(page.rows).toHaveLength(SUBMISSION_TRIAGE_LIST_MAX);
      // Every returned row is inbox, yet the totals still state the 15 late
      // arrivals that sit entirely outside the served window.
      expect(page.rows.every((row) => row.visibleTray === 'inbox')).toBe(true);
      expect(page.trayTotals).toEqual({
        inbox: onTimeCount, set_aside: 0, late: lateCount, spam: 0
      });

      // A tray-filtered window keeps whole-population totals as well.
      const lateTray = projectSubmissionTriageList({
        state: durable, sourceRows: rows, query: { tray: 'late' }
      });
      expect(lateTray.rows).toHaveLength(lateCount);
      expect(lateTray.trayTotals).toEqual({
        inbox: onTimeCount, set_aside: 0, late: lateCount, spam: 0
      });
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});

/**
 * Seam guarantee: a submission acceptance and its triage initialization share
 * one transaction, for every submission-creating effect domain. A new
 * accepting write path fails this suite until it composes the same
 * initializer seam inside its own unit of work.
 */
describe('conformance: triage initialization binds to submission acceptance', () => {
  const sqliteDirectory = dirname(fileURLToPath(import.meta.url));

  test('every submission-persisting effect domain composes same-transaction triage initialization', () => {
    const bindings = readdirSync(sqliteDirectory)
      .filter((name) => name.endsWith('-effect-domain.ts'))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(sqliteDirectory, name), 'utf8') }))
      .filter((file) => /\binsertSubmission\(|\bapplyApplicationMutation\(/.test(file.text))
      .map((file) => ({
        domain: file.name,
        initializesTriageInTransaction: /\binitializeWithinTransaction\(/.test(file.text)
      }));
    // The accepting path stays enumerated: a new submission-creating effect
    // domain joins this list automatically and fails until it binds the
    // same-transaction triage initializer.
    expect(bindings.map((binding) => binding.domain))
      .toContain('intake-public-mutation-effect-domain.ts');
    expect(bindings).toEqual(bindings.map((binding) => ({
      domain: binding.domain,
      initializesTriageInTransaction: true
    })));
  });

  test('submission head persistence keeps exactly one insert site', () => {
    const inserters = readdirSync(sqliteDirectory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) =>
        readFileSync(join(sqliteDirectory, name), 'utf8').includes('INSERT INTO intake_submission_heads')
      )
      .sort();
    expect(inserters).toEqual(['intake.ts']);
  });

  test('the submit-initializer seam shares the accepting transaction fate', () => {
    const { sqlite, source, repository } = openDatabase();
    const row = sourceRow({ submissionId: id(0x60) });
    source.rows.set(`${workspaceId}:${eventId}`, [row]);
    const initializer = createSubmissionTriageSubmitInitializer({
      store: repository,
      ids: { newArrivalId: () => id(0x61) }
    });
    const candidate = {
      scope,
      submission: {
        id: row.summary.id,
        formId: row.summary.formId,
        formVersionId: row.summary.formVersionId,
        source: row.source,
        submittedAt: row.summary.submittedAt
      },
      recordedAt: submittedAt,
      closeEvidence: null
    };
    try {
      // Initialization cannot detach from the accepting transaction.
      expect(() => initializer.initializeWithinTransaction(candidate))
        .toThrow('transaction_required');

      // Rolling the accepting transaction back leaves no triage state behind:
      // the acceptance and its triage spine share one fate, so an absent
      // event head stays honest "not initialized", never a false empty tray.
      sqlite.exec('BEGIN IMMEDIATE');
      expect(initializer.initializeWithinTransaction(candidate).replay).toBe(false);
      sqlite.exec('ROLLBACK');
      expect(repository.readTriageState(scope)).toBeUndefined();

      // The committed acceptance serves the row as proven inbox state.
      sqlite.exec('BEGIN IMMEDIATE');
      const initialized = initializer.initializeWithinTransaction(candidate);
      sqlite.exec('COMMIT');
      expect(initialized.replay).toBe(false);
      const state = repository.readTriageState(scope)!;
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]).toMatchObject({
        arrival: { source: 'public_form', classification: 'on_time' },
        head: { state: 'inbox', version: 1 }
      });
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});
