import type { Database } from 'bun:sqlite';
import {
  submissionArrivalFactSchema,
  submissionTriageHeadSchema,
  submissionTriageSourceRowSchema,
  type SubmissionArrivalFactDto,
  type SubmissionTriageHeadDto,
  type SubmissionTriageSourceRowDto
} from '@jooevents/contracts/submission-triage';
import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import {
  createSubmissionTriageState,
  parseSubmissionTriageState,
  submissionTriageArrivalDigest,
  submissionTriageHeadDigest,
  submissionTriageTransitionResult,
  validateSubmissionTriagePlan,
  type SubmissionTriageInitialization,
  type SubmissionTriageInitializationStore,
  type SubmissionTriageInitializationResult,
  type SubmissionTriageReadPort,
  type SubmissionTriageScope,
  type SubmissionTriageSourcePort,
  type SubmissionTriageStateSnapshot,
  type SubmissionTriageTransactionPort,
  type SubmissionTriageTransitionPlan,
  type SubmissionTriageTransitionResult
} from '@jooevents/submission-triage';
import { SQLiteIntakeRepository } from './intake';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const SQLITE_SUBMISSION_TRIAGE_SQL = `
CREATE TABLE submission_triage_event_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36 AND workspace_id = lower(workspace_id)),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36 AND event_id = lower(event_id)),
  query_version INTEGER NOT NULL CHECK(query_version > 0),
  query_digest_sha256 TEXT NOT NULL CHECK(
    length(query_digest_sha256) = 64 AND query_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE submission_arrival_facts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36 AND submission_id = lower(submission_id)),
  arrival_id TEXT NOT NULL CHECK(length(arrival_id) = 36 AND arrival_id = lower(arrival_id)),
  form_id TEXT NOT NULL CHECK(length(form_id) = 36 AND form_id = lower(form_id)),
  form_version_id TEXT NOT NULL CHECK(length(form_version_id) = 36 AND form_version_id = lower(form_version_id)),
  source TEXT NOT NULL CHECK(source IN ('public_form', 'direct_entry', 'import', 'email')),
  classification TEXT NOT NULL CHECK(classification IN ('on_time', 'late')),
  submitted_at_ms INTEGER NOT NULL CHECK(submitted_at_ms BETWEEN 0 AND 8640000000000000),
  recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms BETWEEN 0 AND 8640000000000000),
  fact_json TEXT NOT NULL CHECK(
    json_valid(fact_json) AND json_type(fact_json) = 'object'
    AND json_extract(fact_json, '$.submissionId') = submission_id
    AND json_extract(fact_json, '$.id') = arrival_id
    AND json_extract(fact_json, '$.classification') = classification
  ),
  fact_digest_sha256 TEXT NOT NULL CHECK(
    length(fact_digest_sha256) = 64 AND fact_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  UNIQUE (arrival_id),
  UNIQUE (workspace_id, event_id, submission_id, fact_digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES submission_triage_event_heads(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE submission_triage_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  state TEXT NOT NULL CHECK(state IN ('inbox', 'set_aside', 'spam')),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  head_json TEXT NOT NULL CHECK(
    json_valid(head_json) AND json_type(head_json) = 'object'
    AND json_extract(head_json, '$.submissionId') = submission_id
    AND json_extract(head_json, '$.version') = head_version
    AND json_extract(head_json, '$.state') = state
  ),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  UNIQUE (workspace_id, event_id, submission_id, head_version, head_digest_sha256),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES submission_arrival_facts(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX submission_triage_heads_by_state
  ON submission_triage_heads(workspace_id, event_id, state, submission_id);

CREATE TRIGGER submission_arrival_facts_no_update BEFORE UPDATE ON submission_arrival_facts
BEGIN SELECT RAISE(ABORT, 'submission arrival facts are immutable'); END;
CREATE TRIGGER submission_arrival_facts_no_delete BEFORE DELETE ON submission_arrival_facts
BEGIN SELECT RAISE(ABORT, 'submission arrival facts are immutable'); END;
CREATE TRIGGER submission_triage_event_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id ON submission_triage_event_heads
BEGIN SELECT RAISE(ABORT, 'submission triage event identity is immutable'); END;
CREATE TRIGGER submission_triage_event_heads_version_guard
BEFORE UPDATE ON submission_triage_event_heads
WHEN NEW.query_version != OLD.query_version + 1
BEGIN SELECT RAISE(ABORT, 'submission triage query version is invalid'); END;
CREATE TRIGGER submission_triage_event_heads_no_delete BEFORE DELETE ON submission_triage_event_heads
BEGIN SELECT RAISE(ABORT, 'submission triage event heads cannot be deleted'); END;
CREATE TRIGGER submission_triage_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, submission_id ON submission_triage_heads
BEGIN SELECT RAISE(ABORT, 'submission triage identity is immutable'); END;
CREATE TRIGGER submission_triage_heads_version_guard
BEFORE UPDATE ON submission_triage_heads
WHEN NEW.head_version != OLD.head_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'submission triage head version is invalid'); END;
CREATE TRIGGER submission_triage_heads_no_delete BEFORE DELETE ON submission_triage_heads
BEGIN SELECT RAISE(ABORT, 'submission triage heads cannot be deleted'); END;
`;

/** Immutable epoch-2 baseline bytes; current runtimes advance through e2_0002. */
export const SQLITE_SUBMISSION_TRIAGE_E2_0001_SQL = SQLITE_SUBMISSION_TRIAGE_SQL.replace(
  "state IN ('inbox', 'set_aside', 'spam')",
  "state IN ('inbox', 'set_aside', 'discarded_recoverable')"
);

export type SQLiteSubmissionTriageErrorCode =
  | 'transaction_required'
  | 'scope_missing'
  | 'id_collision'
  | 'stale_state'
  | 'source_changed'
  | 'data_corrupt';

export class SQLiteSubmissionTriageError extends Error {
  constructor(readonly code: SQLiteSubmissionTriageErrorCode) {
    super(code);
    this.name = 'SQLiteSubmissionTriageError';
  }
}

interface EventHeadRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly query_version: number;
  readonly query_digest_sha256: string;
}

interface JoinedRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly submission_id: string;
  readonly arrival_id: string;
  readonly form_id: string;
  readonly form_version_id: string;
  readonly source: string;
  readonly classification: string;
  readonly submitted_at_ms: number;
  readonly recorded_at_ms: number;
  readonly fact_json: string;
  readonly fact_digest_sha256: string;
  readonly head_version: number;
  readonly state: string;
  readonly updated_at_ms: number;
  readonly head_json: string;
  readonly head_digest_sha256: string;
}

function scope(input: SubmissionTriageScope): SubmissionTriageScope {
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    eventId: parseEventId(input.eventId)
  });
}

function parseArrival(row: JoinedRow): SubmissionArrivalFactDto {
  try {
    const fact = submissionArrivalFactSchema.parse(JSON.parse(row.fact_json));
    if (canonicalJsonText(fact) !== row.fact_json
        || submissionTriageArrivalDigest(fact) !== row.fact_digest_sha256
        || fact.scope.workspaceId !== row.workspace_id
        || fact.scope.eventId !== row.event_id
        || fact.submissionId !== row.submission_id
        || fact.id !== row.arrival_id
        || fact.formId !== row.form_id
        || fact.formVersionId !== row.form_version_id
        || fact.source !== row.source
        || fact.classification !== row.classification
        || Date.parse(fact.submittedAt) !== row.submitted_at_ms
        || Date.parse(fact.recordedAt) !== row.recorded_at_ms) throw new TypeError();
    return fact;
  } catch {
    throw new SQLiteSubmissionTriageError('data_corrupt');
  }
}

function parseHead(row: JoinedRow): SubmissionTriageHeadDto {
  try {
    const head = submissionTriageHeadSchema.parse(JSON.parse(row.head_json));
    if (canonicalJsonText(head) !== row.head_json
        || submissionTriageHeadDigest(head) !== row.head_digest_sha256
        || head.scope.workspaceId !== row.workspace_id
        || head.scope.eventId !== row.event_id
        || head.submissionId !== row.submission_id
        || head.version !== row.head_version
        || head.state !== row.state
        || Date.parse(head.updatedAt) !== row.updated_at_ms) throw new TypeError();
    return head;
  } catch {
    throw new SQLiteSubmissionTriageError('data_corrupt');
  }
}

function changedOnce(result: { readonly changes: number }, code: SQLiteSubmissionTriageErrorCode) {
  if (result.changes !== 1) throw new SQLiteSubmissionTriageError(code);
}

export function installSQLiteSubmissionTriageSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteSubmissionTriageError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_SUBMISSION_TRIAGE_SQL)).immediate();
}

/**
 * Durable triage state on a caller-owned SQLite handle. Source projections are
 * delegated so this state remains independent of public forms/import/email.
 */
export class SQLiteSubmissionTriageRepository
implements SubmissionTriageReadPort, SubmissionTriageTransactionPort,
  SubmissionTriageInitializationStore {
  constructor(
    private readonly sqlite: Database,
    private readonly source: SubmissionTriageSourcePort
  ) {}

  listSourceRows(currentScope: SubmissionTriageScope): readonly SubmissionTriageSourceRowDto[] {
    return this.source.listSourceRows(scope(currentScope));
  }

  readSourceRow(
    currentScope: SubmissionTriageScope,
    submissionId: string
  ): SubmissionTriageSourceRowDto | undefined {
    return this.source.readSourceRow(scope(currentScope), submissionId);
  }

  readTriageState(scopeInput: SubmissionTriageScope): SubmissionTriageStateSnapshot | undefined {
    const currentScope = scope(scopeInput);
    const roots = this.sqlite.query<EventHeadRow, [string, string]>(`
      SELECT workspace_id, event_id, query_version, query_digest_sha256
        FROM submission_triage_event_heads
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(currentScope.workspaceId, currentScope.eventId);
    if (roots.length > 1) throw new SQLiteSubmissionTriageError('data_corrupt');
    const root = roots[0];
    if (!root) return undefined;
    const rows = this.sqlite.query<JoinedRow, [string, string]>(`
      SELECT arrival.workspace_id, arrival.event_id, arrival.submission_id,
             arrival.arrival_id, arrival.form_id, arrival.form_version_id,
             arrival.source, arrival.classification, arrival.submitted_at_ms,
             arrival.recorded_at_ms, arrival.fact_json, arrival.fact_digest_sha256,
             head.head_version, head.state, head.updated_at_ms,
             head.head_json, head.head_digest_sha256
        FROM submission_arrival_facts AS arrival
        JOIN submission_triage_heads AS head
          ON head.workspace_id = arrival.workspace_id
         AND head.event_id = arrival.event_id
         AND head.submission_id = arrival.submission_id
       WHERE arrival.workspace_id = ? AND arrival.event_id = ?
       ORDER BY arrival.submission_id COLLATE BINARY
    `).all(currentScope.workspaceId, currentScope.eventId);
    const counts = this.sqlite.query<{
      readonly arrival_count: number; readonly head_count: number;
    }, [string, string, string, string]>(`
      SELECT
        (SELECT count(*) FROM submission_arrival_facts
          WHERE workspace_id = ? AND event_id = ?) AS arrival_count,
        (SELECT count(*) FROM submission_triage_heads
          WHERE workspace_id = ? AND event_id = ?) AS head_count
    `).get(
      currentScope.workspaceId, currentScope.eventId,
      currentScope.workspaceId, currentScope.eventId
    );
    if (!counts || counts.arrival_count !== rows.length || counts.head_count !== rows.length
        || root.workspace_id !== currentScope.workspaceId
        || root.event_id !== currentScope.eventId) {
      throw new SQLiteSubmissionTriageError('data_corrupt');
    }
    const state = createSubmissionTriageState({
      scope: currentScope,
      version: root.query_version,
      entries: rows.map((row) => ({ arrival: parseArrival(row), head: parseHead(row) }))
    });
    if (state.queryGuard.digestSha256 !== root.query_digest_sha256) {
      throw new SQLiteSubmissionTriageError('data_corrupt');
    }
    return state;
  }

  initializeSubmissionTriage(
    initializationInput: SubmissionTriageInitialization
  ): SubmissionTriageInitializationResult {
    this.requireTransaction();
    const initialization = Object.freeze({
      arrival: submissionArrivalFactSchema.parse(initializationInput.arrival),
      head: submissionTriageHeadSchema.parse(initializationInput.head)
    });
    const currentScope = scope(initialization.arrival.scope);
    if (initialization.head.scope.workspaceId !== currentScope.workspaceId
        || initialization.head.scope.eventId !== currentScope.eventId
        || initialization.head.submissionId !== initialization.arrival.submissionId
        || initialization.head.version !== 1
        || initialization.head.state !== 'inbox'
        || initialization.head.setAsideAttribution !== null) {
      throw new SQLiteSubmissionTriageError('source_changed');
    }
    const source = this.source.readSourceRow(currentScope, initialization.head.submissionId);
    if (!source
        || source.scope.workspaceId !== currentScope.workspaceId
        || source.scope.eventId !== currentScope.eventId
        || source.summary.id !== initialization.arrival.submissionId
        || source.summary.formId !== initialization.arrival.formId
        || source.summary.formVersionId !== initialization.arrival.formVersionId
        || source.summary.submittedAt !== initialization.arrival.submittedAt
        || source.source !== initialization.arrival.source) {
      throw new SQLiteSubmissionTriageError('source_changed');
    }
    const before = this.readTriageState(currentScope);
    const existing = before?.entries.find((entry) =>
      entry.head.submissionId === initialization.head.submissionId
    );
    if (existing) {
      if (canonicalJsonText(existing.arrival) === canonicalJsonText(initialization.arrival)
          && canonicalJsonText(existing.head) === canonicalJsonText(initialization.head)) {
        return Object.freeze({
          schemaVersion: 1,
          submissionId: existing.head.submissionId,
          queryGuard: before!.queryGuard,
          replay: true
        });
      }
      throw new SQLiteSubmissionTriageError('id_collision');
    }
    this.sqlite.exec('SAVEPOINT submission_triage_initialize');
    try {
      let effectiveBefore = before;
      if (!effectiveBefore) {
        const eventRoot = this.sqlite.query<{ readonly event_id: string }, [string, string]>(`
          SELECT event_id FROM event_spine_scope_roots
           WHERE workspace_id = ? AND event_id = ? LIMIT 2
        `).all(currentScope.workspaceId, currentScope.eventId);
        if (eventRoot.length !== 1) throw new SQLiteSubmissionTriageError('scope_missing');
        const empty = createSubmissionTriageState({ scope: currentScope, version: 1, entries: [] });
        changedOnce(this.sqlite.query<never, [string, string, number, string]>(`
          INSERT INTO submission_triage_event_heads (
            workspace_id, event_id, query_version, query_digest_sha256
          ) VALUES (?, ?, ?, ?)
        `).run(
          currentScope.workspaceId, currentScope.eventId,
          empty.queryGuard.version, empty.queryGuard.digestSha256
        ), 'id_collision');
        effectiveBefore = empty;
      }
      this.insertInitialization(initialization);
      const after = createSubmissionTriageState({
        scope: currentScope,
        version: effectiveBefore.queryGuard.version + 1,
        entries: [...effectiveBefore.entries, initialization]
      });
      changedOnce(this.sqlite.query<never, [number, string, string, string, number, string]>(`
        UPDATE submission_triage_event_heads
           SET query_version = ?, query_digest_sha256 = ?
         WHERE workspace_id = ? AND event_id = ?
           AND query_version = ? AND query_digest_sha256 = ?
      `).run(
        after.queryGuard.version, after.queryGuard.digestSha256,
        currentScope.workspaceId, currentScope.eventId,
        effectiveBefore.queryGuard.version, effectiveBefore.queryGuard.digestSha256
      ), 'stale_state');
      const reread = this.readTriageState(currentScope);
      if (!reread || canonicalJsonText(reread) !== canonicalJsonText(after)) {
        throw new SQLiteSubmissionTriageError('data_corrupt');
      }
      this.sqlite.exec('RELEASE SAVEPOINT submission_triage_initialize');
      return Object.freeze({
        schemaVersion: 1,
        submissionId: initialization.head.submissionId,
        queryGuard: after.queryGuard,
        replay: false
      });
    } catch (error) {
      this.sqlite.exec('ROLLBACK TO SAVEPOINT submission_triage_initialize');
      this.sqlite.exec('RELEASE SAVEPOINT submission_triage_initialize');
      if (error instanceof SQLiteSubmissionTriageError) throw error;
      throw new SQLiteSubmissionTriageError('id_collision');
    }
  }

  applyTransitionPlan(
    plan: SubmissionTriageTransitionPlan
  ): SubmissionTriageTransitionResult {
    this.requireTransaction();
    const before = this.readTriageState(plan.scope);
    if (!before) throw new SQLiteSubmissionTriageError('scope_missing');
    if (validateSubmissionTriagePlan(plan, before)) {
      throw new SQLiteSubmissionTriageError('stale_state');
    }
    this.sqlite.exec('SAVEPOINT submission_triage_apply');
    try {
      for (const transition of plan.transitions) {
        changedOnce(this.sqlite.query<never, [
          number, string, number, string, string, string, string, string, number, string, string
        ]>(`
          UPDATE submission_triage_heads
             SET head_version = ?, state = ?, updated_at_ms = ?,
                 head_json = ?, head_digest_sha256 = ?
           WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
             AND head_version = ? AND head_digest_sha256 = ?
             AND EXISTS (
               SELECT 1 FROM submission_arrival_facts AS arrival
                WHERE arrival.workspace_id = submission_triage_heads.workspace_id
                  AND arrival.event_id = submission_triage_heads.event_id
                  AND arrival.submission_id = submission_triage_heads.submission_id
                  AND arrival.fact_digest_sha256 = ?
             )
        `).run(
          transition.after.version, transition.after.state,
          Date.parse(transition.after.updatedAt), canonicalJsonText(transition.after),
          submissionTriageHeadDigest(transition.after), plan.scope.workspaceId,
          plan.scope.eventId, transition.submissionId, transition.before.version,
          submissionTriageHeadDigest(transition.before), transition.arrivalDigestSha256
        ), 'stale_state');
      }
      changedOnce(this.sqlite.query<never, [number, string, string, string, number, string]>(`
        UPDATE submission_triage_event_heads
           SET query_version = ?, query_digest_sha256 = ?
         WHERE workspace_id = ? AND event_id = ?
           AND query_version = ? AND query_digest_sha256 = ?
      `).run(
        plan.queryGuard.after.version, plan.queryGuard.after.digestSha256,
        plan.scope.workspaceId, plan.scope.eventId,
        plan.queryGuard.before.version, plan.queryGuard.before.digestSha256
      ), 'stale_state');
      const after = this.readTriageState(plan.scope);
      const expectedHeads = new Map(
        plan.transitions.map((transition) => [transition.submissionId, transition.after])
      );
      if (!after
          || canonicalJsonText(after.queryGuard) !== canonicalJsonText(plan.queryGuard.after)
          || after.entries.some((entry) => expectedHeads.has(entry.head.submissionId)
            && submissionTriageHeadDigest(entry.head)
              !== submissionTriageHeadDigest(expectedHeads.get(entry.head.submissionId)!))) {
        throw new SQLiteSubmissionTriageError('data_corrupt');
      }
      this.sqlite.exec('RELEASE SAVEPOINT submission_triage_apply');
      return submissionTriageTransitionResult(plan);
    } catch (error) {
      this.sqlite.exec('ROLLBACK TO SAVEPOINT submission_triage_apply');
      this.sqlite.exec('RELEASE SAVEPOINT submission_triage_apply');
      if (error instanceof SQLiteSubmissionTriageError) throw error;
      throw new SQLiteSubmissionTriageError('stale_state');
    }
  }

  private insertInitialization(initialization: SubmissionTriageInitialization): void {
    const { arrival, head } = initialization;
    try {
      changedOnce(this.sqlite.query<never, [
        string, string, string, string, string, string, string, string,
        number, number, string, string
      ]>(`
        INSERT INTO submission_arrival_facts (
          workspace_id, event_id, submission_id, arrival_id, form_id, form_version_id,
          source, classification, submitted_at_ms, recorded_at_ms, fact_json,
          fact_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        arrival.scope.workspaceId, arrival.scope.eventId, arrival.submissionId, arrival.id,
        arrival.formId, arrival.formVersionId, arrival.source, arrival.classification,
        Date.parse(arrival.submittedAt), Date.parse(arrival.recordedAt),
        canonicalJsonText(arrival), submissionTriageArrivalDigest(arrival)
      ), 'id_collision');
      changedOnce(this.sqlite.query<never, [
        string, string, string, number, string, number, string, string
      ]>(`
        INSERT INTO submission_triage_heads (
          workspace_id, event_id, submission_id, head_version, state,
          updated_at_ms, head_json, head_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        head.scope.workspaceId, head.scope.eventId, head.submissionId, head.version,
        head.state, Date.parse(head.updatedAt), canonicalJsonText(head),
        submissionTriageHeadDigest(head)
      ), 'id_collision');
    } catch (error) {
      if (error instanceof SQLiteSubmissionTriageError) throw error;
      throw new SQLiteSubmissionTriageError('id_collision');
    }
  }

  private requireTransaction(): void {
    if (!this.sqlite.inTransaction) {
      throw new SQLiteSubmissionTriageError('transaction_required');
    }
  }
}

/**
 * Authenticated Intake-backed source projection for public-form submissions.
 * The Intake repository revalidates canonical Submission, SubmitEvidence,
 * participant/consent evidence, and the immutable FormVersion before returning
 * either safe projection. Contact projection is never invoked here.
 */
export class SQLiteIntakeSubmissionTriageSourceAdapter
implements SubmissionTriageSourcePort {
  constructor(private readonly intake: SQLiteIntakeRepository) {
    if (!(intake instanceof SQLiteIntakeRepository)) {
      throw new TypeError('submission_triage_intake_source_invalid');
    }
  }

  listSourceRows(scopeInput: SubmissionTriageScope): readonly SubmissionTriageSourceRowDto[] {
    const currentScope = scope(scopeInput);
    return Object.freeze(this.intake.listSubmissions(currentScope)
      .map((summary) => this.project(currentScope, summary)));
  }

  readSourceRow(
    scopeInput: SubmissionTriageScope,
    submissionId: string
  ): SubmissionTriageSourceRowDto | undefined {
    const currentScope = scope(scopeInput);
    const summary = this.intake.listSubmissions(currentScope)
      .find((candidate) => candidate.id === submissionId);
    return summary ? this.project(currentScope, summary) : undefined;
  }

  private project(
    currentScope: SubmissionTriageScope,
    summary: ReturnType<SQLiteIntakeRepository['listSubmissions']>[number]
  ): SubmissionTriageSourceRowDto {
    const head = this.intake.readSubmissionHead(currentScope, summary.id);
    const detail = this.intake.readSubmissionDetail(currentScope, summary.id);
    if (!head || !detail
        || head.id !== summary.id
        || head.formId !== summary.formId
        || head.formVersionId !== summary.formVersionId
        || head.submittedAt !== summary.submittedAt
        || summary.id !== detail.submissionId
        || summary.formId !== detail.formId
        || summary.formVersionId !== detail.formVersionId
        || summary.submittedAt !== detail.submittedAt) {
      throw new SQLiteSubmissionTriageError('source_changed');
    }
    const version = this.intake.readFormVersion(currentScope, summary.formVersionId);
    if (!version
        || version.scope.workspaceId !== currentScope.workspaceId
        || version.scope.eventId !== currentScope.eventId
        || version.formId !== summary.formId
        || version.id !== summary.formVersionId
        || canonicalJsonText(version.definition.target) !== canonicalJsonText(summary.target)) {
      throw new SQLiteSubmissionTriageError('source_changed');
    }
    const abstractField = version.definition.fields.find((field) => field.mapsTo === 'talk.abstract');
    const abstractAnswer = abstractField
      ? detail.answers.find((answer) => answer.fieldId === abstractField.id)
      : undefined;
    if (abstractAnswer !== undefined && abstractAnswer.kind !== 'textarea') {
      throw new SQLiteSubmissionTriageError('data_corrupt');
    }
    const pinned = version.targetPin;
    const track = pinned?.kind === 'category' && pinned.categoryKind === 'track'
      ? { id: pinned.id, label: pinned.name } : null;
    const format = pinned?.kind === 'category' && pinned.categoryKind === 'format'
      ? { id: pinned.id, label: pinned.name } : null;
    return submissionTriageSourceRowSchema.parse({
      schemaVersion: 1,
      scope: currentScope,
      source: head.source,
      summary,
      detail,
      abstract: abstractAnswer?.value ?? null,
      track,
      format
    });
  }
}
