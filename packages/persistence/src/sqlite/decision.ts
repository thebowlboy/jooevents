import { canonicalJsonSha256 } from '@jooevents/kernel';
import type { Database } from 'bun:sqlite';

import {
  decisionMutationPlanSchema,
  type DecisionHeadDto,
  type DecisionMutationPlanDto,
  type DecisionMutationResult,
  type DecisionReviewPinDto,
  type DecisionScopeDto,
  type SubmissionSessionOriginDto
} from '@jooevents/contracts';
import {
  decisionMutationResultFromPlan,
  parseDecisionHead,
  parseSubmissionSessionOrigin,
  type DecisionCandidateDto,
  type DecisionTransactionPort,
  type DecisionEnvironmentSource
} from '@jooevents/decision';
import { submissionTriageSourceRowSchema } from '@jooevents/contracts/submission-triage';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  parseReviewScope,
  projectReviewStandings,
  type ReviewProjectionEnvironment
} from '@jooevents/review';
import {
  applyEngagementSeedFrom,
  planEngagementSeedFrom
} from '@jooevents/engagement';
import {
  applySessionGraduationFrom,
  applySessionGraduationReversalFrom,
  planSessionGraduationFrom,
  planSessionGraduationReversalFrom,
  validateSessionGraduationFrom,
  validateSessionGraduationReversalFrom,
  type SessionGraduationAppliedContribution,
  type SessionGraduationChangeInput,
  type SessionGraduationContribution,
  type SessionGraduationPlanningPort,
  type SessionGraduationReversalInput,
  type SessionGraduationTransactionPort,
  type SessionGraduationValidation,
  type SessionGraduationValidationPort
} from '@jooevents/session';
import type { DecisionRowPlanDto, SessionRosterParticipantInput } from '@jooevents/contracts';
import { SQLiteEngagementRepository } from './engagement';
import type {
  SessionMutationPlanDto,
  SessionMutationResult,
  SessionRestorePlanDto
} from '@jooevents/contracts/sessions';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import type { SQLiteSessionRepository } from './session';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const DECISION_SQL = `
CREATE TABLE decision_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('accepted', 'waitlisted', 'declined', 'withdrawn')),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  decided_by_user_id TEXT NOT NULL CHECK(length(decided_by_user_id) = 36),
  decided_at_ms INTEGER NOT NULL CHECK(decided_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  CHECK(json_extract(head_json, '$.submissionId') = submission_id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(json_extract(head_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (decided_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX decision_heads_state
  ON decision_heads(workspace_id, event_id, state, submission_id);

CREATE TABLE submission_session_origins (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('spawned', 'attached')),
  linked_by_user_id TEXT NOT NULL CHECK(length(linked_by_user_id) = 36),
  linked_at_ms INTEGER NOT NULL CHECK(linked_at_ms BETWEEN 0 AND 8640000000000000),
  origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  CHECK(json_extract(origin_json, '$.submissionId') = submission_id),
  CHECK(json_extract(origin_json, '$.sessionId') = session_id),
  CHECK(json_extract(origin_json, '$.kind') = kind),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES decision_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (linked_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX submission_session_origins_session
  ON submission_session_origins(workspace_id, event_id, session_id, submission_id);

CREATE TRIGGER decision_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, submission_id ON decision_heads
BEGIN
  SELECT RAISE(ABORT, 'decision head identity is immutable');
END;

CREATE TRIGGER submission_session_origins_immutable
BEFORE UPDATE ON submission_session_origins
BEGIN
  SELECT RAISE(ABORT, 'submission session origins are immutable; compensation unlinks by delete');
END;
`;

export type SQLiteDecisionErrorCode =
  | 'transaction_required'
  | 'scope_corrupt'
  | 'data_corrupt'
  | 'stale_decision'
  | 'stale_origin';

export class SQLiteDecisionError extends Error {
  constructor(readonly code: SQLiteDecisionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteDecisionError';
  }
}

export function installDecisionSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteDecisionError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(DECISION_SQL);
}

interface HeadRow { readonly head_json: string }
interface OriginRow { readonly origin_json: string }
interface ScopeRow { readonly event_id: string }
interface CountRow { readonly count: number }

/**
 * Canonical Decision persistence plus the Session graduation collaboration
 * ports served from the one composed Session repository, so the direct
 * operation commits Decision heads, origin links, and Session graduations in
 * a single unit of work on the caller-owned handle. Every write is guarded by
 * the exact expected row image and refuses on any drift.
 *
 * Acceptance-seed join (recorded Wave-3 widening of the decide unit of work):
 * every accepted row's committed roster write additionally seeds one
 * `invited` engagement per candidate participant through the engagement seed
 * collaboration, skip-existing on the `(sessionId, personId)` pair, inside
 * this same transaction, each row stamped with the acceptance's own written
 * decision head.
 */
export class SQLiteDecisionRepository implements DecisionTransactionPort,
  SessionGraduationPlanningPort,
  SessionGraduationValidationPort,
  SessionGraduationTransactionPort {
  readonly engagements: SQLiteEngagementRepository;

  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly sessions: SQLiteSessionRepository;
    readonly environment: DecisionEnvironmentSource;
  }) {
    this.engagements = new SQLiteEngagementRepository(input.sqlite);
  }

  readDecisionHead(scope: DecisionScopeDto, submissionId: string): DecisionHeadDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.input.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM decision_heads
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
    `).get(scope.workspaceId, scope.eventId, submissionId);
    if (!row) return undefined;
    try {
      return parseDecisionHead(JSON.parse(row.head_json));
    } catch (error) {
      throw new SQLiteDecisionError('data_corrupt', error);
    }
  }

  readSubmissionSessionOrigin(
    scope: DecisionScopeDto,
    submissionId: string
  ): SubmissionSessionOriginDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.input.sqlite.query<OriginRow, [string, string, string]>(`
      SELECT origin_json FROM submission_session_origins
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
    `).get(scope.workspaceId, scope.eventId, submissionId);
    if (!row) return undefined;
    try {
      return parseSubmissionSessionOrigin(JSON.parse(row.origin_json));
    } catch (error) {
      throw new SQLiteDecisionError('data_corrupt', error);
    }
  }

  listSessionOrigins(
    scope: DecisionScopeDto,
    sessionId: string
  ): readonly SubmissionSessionOriginDto[] {
    if (!this.scopeExists(scope)) return Object.freeze([]);
    const rows = this.input.sqlite.query<OriginRow, [string, string, string]>(`
      SELECT origin_json FROM submission_session_origins
       WHERE workspace_id = ? AND event_id = ? AND session_id = ?
       ORDER BY submission_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, sessionId);
    try {
      return Object.freeze(rows.map((row) => parseSubmissionSessionOrigin(JSON.parse(row.origin_json))));
    } catch (error) {
      throw new SQLiteDecisionError('data_corrupt', error);
    }
  }

  countSessionSchedulePlacements(scope: DecisionScopeDto, sessionId: string): number {
    const row = this.input.sqlite.query<CountRow, [string, string, string]>(`
      SELECT count(*) AS count FROM schedule_occurrences
       WHERE workspace_id = ? AND event_id = ? AND session_id = ?
    `).get(scope.workspaceId, scope.eventId, sessionId);
    return row?.count ?? 0;
  }

  readDecisionCandidate(
    scope: DecisionScopeDto,
    submissionId: string
  ): DecisionCandidateDto | undefined {
    return this.input.environment.readDecisionCandidate(scope, submissionId);
  }

  readDecisionReviewBasis(
    scope: DecisionScopeDto,
    submissionId: string
  ): DecisionReviewPinDto | undefined {
    return this.input.environment.readDecisionReviewBasis(scope, submissionId);
  }

  readSessionCatalog(scope: Parameters<SQLiteSessionRepository['readSessionCatalog']>[0]) {
    return this.input.sessions.readSessionCatalog(scope);
  }

  readSessionVocabulary(scope: Parameters<SQLiteSessionRepository['readSessionVocabulary']>[0]) {
    return this.input.sessions.readSessionVocabulary(scope);
  }

  planSessionGraduation(input: SessionGraduationChangeInput): SessionGraduationContribution {
    return planSessionGraduationFrom(this.input.sessions, input);
  }

  planSessionGraduationReversal(input: SessionGraduationReversalInput): SessionRestorePlanDto {
    return planSessionGraduationReversalFrom(this.input.sessions, input);
  }

  validateSessionGraduation(
    contribution: SessionGraduationContribution
  ): SessionGraduationValidation {
    return validateSessionGraduationFrom(this.input.sessions, contribution);
  }

  validateSessionGraduationReversal(plan: SessionRestorePlanDto): SessionGraduationValidation {
    return validateSessionGraduationReversalFrom(this.input.sessions, plan);
  }

  applySessionPlan(plan: SessionMutationPlanDto | SessionRestorePlanDto): SessionMutationResult {
    return this.input.sessions.applySessionPlan(plan);
  }

  applySessionGraduation(
    contribution: SessionGraduationContribution
  ): SessionGraduationAppliedContribution {
    return applySessionGraduationFrom(this.input.sessions, contribution);
  }

  applySessionGraduationReversal(plan: SessionRestorePlanDto): SessionMutationResult {
    return applySessionGraduationReversalFrom(this.input.sessions, plan);
  }

  applyDecisionPlan(plan: DecisionMutationPlanDto): DecisionMutationResult {
    if (!this.input.sqlite.inTransaction) throw new SQLiteDecisionError('transaction_required');
    const parsed = decisionMutationPlanSchema.parse(plan);
    const scope = parsed.input.scope;
    for (const row of parsed.rows) {
      if (row.before === null) this.insertHead(scope, row.after);
      else this.updateHead(scope, row.before, row.after);
      if (row.origin !== null) this.insertOrigin(scope, row.origin);
      this.seedEngagements(scope, row, parsed.input.occurredAt);
    }
    return decisionMutationResultFromPlan(parsed);
  }

  /**
   * Seeds `invited` engagements for one accepted row inside the hosting
   * transaction. The person set is the graduation's candidate participants;
   * existing `(sessionId, personId)` pairs are skipped untouched, so replays
   * and attaches onto peopled Sessions are idempotent. Every seeded row is
   * stamped with this acceptance's own written decision head
   * (`row.after.version` + digest). Waitlisted and declined rows carry no
   * graduation and seed nothing.
   */
  private seedEngagements(scope: DecisionScopeDto, row: DecisionRowPlanDto, occurredAt: string): void {
    if (row.graduation === null || row.origin === null) return;
    const participants = graduationParticipants(row.graduation);
    if (participants.length === 0) return;
    const source = participants[0]!.source;
    applyEngagementSeedFrom(this.engagements, planEngagementSeedFrom(this.engagements, {
      scope,
      sessionId: row.graduation.after.id,
      submissionId: row.submissionId,
      seededByDecision: {
        version: row.after.version,
        digestSha256: row.after.digestSha256
      },
      source,
      personIds: participants.map((participant) => participant.personId),
      invitedAt: occurredAt,
      respondBy: null
    }));
  }

  private scopeExists(scope: DecisionScopeDto): boolean {
    const rows = this.input.sqlite.query<ScopeRow, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteDecisionError('scope_corrupt');
    return rows.length === 1;
  }

  private insertHead(scope: DecisionScopeDto, head: DecisionHeadDto): void {
    changedExactlyOnce(this.input.sqlite.query<never, [
      string, string, string, string, number, string, string, string, number,
      string, string, string, string, string
    ]>(`
      INSERT INTO decision_heads (
        workspace_id, event_id, submission_id, state, version, digest_sha256,
        head_json, decided_by_user_id, decided_at_ms
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM decision_heads
            WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
         )
    `).run(
      scope.workspaceId, scope.eventId, head.submissionId, head.state, head.version,
      head.digestSha256, canonicalJsonText(head), head.decidedByUserId,
      Date.parse(head.decidedAt),
      scope.workspaceId, scope.eventId,
      scope.workspaceId, scope.eventId, head.submissionId
    ), 'stale_decision');
  }

  private updateHead(
    scope: DecisionScopeDto,
    expected: DecisionHeadDto,
    next: DecisionHeadDto
  ): void {
    changedExactlyOnce(this.input.sqlite.query<never, [
      string, number, string, string, string, number,
      string, string, string, number, string
    ]>(`
      UPDATE decision_heads
         SET state = ?, version = ?, digest_sha256 = ?, head_json = ?,
             decided_by_user_id = ?, decided_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
         AND version = ? AND digest_sha256 = ?
    `).run(
      next.state, next.version, next.digestSha256, canonicalJsonText(next),
      next.decidedByUserId, Date.parse(next.decidedAt),
      scope.workspaceId, scope.eventId, expected.submissionId,
      expected.version, expected.digestSha256
    ), 'stale_decision');
  }

  private deleteHead(scope: DecisionScopeDto, expected: DecisionHeadDto): void {
    changedExactlyOnce(this.input.sqlite.query<never, [string, string, string, number, string]>(`
      DELETE FROM decision_heads
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
         AND version = ? AND digest_sha256 = ?
    `).run(
      scope.workspaceId, scope.eventId, expected.submissionId,
      expected.version, expected.digestSha256
    ), 'stale_decision');
  }

  private insertOrigin(scope: DecisionScopeDto, origin: SubmissionSessionOriginDto): void {
    changedExactlyOnce(this.input.sqlite.query<never, [
      string, string, string, string, string, string, number, string
    ]>(`
      INSERT INTO submission_session_origins (
        workspace_id, event_id, submission_id, session_id, kind,
        linked_by_user_id, linked_at_ms, origin_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.workspaceId, scope.eventId, origin.submissionId, origin.sessionId,
      origin.kind, origin.linkedByUserId, Date.parse(origin.linkedAt),
      canonicalJsonText(origin)
    ), 'stale_origin');
  }

  private deleteOrigin(scope: DecisionScopeDto, origin: SubmissionSessionOriginDto): void {
    changedExactlyOnce(this.input.sqlite.query<never, [
      string, string, string, string, string, string, number
    ]>(`
      DELETE FROM submission_session_origins
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
         AND session_id = ? AND kind = ? AND linked_by_user_id = ? AND linked_at_ms = ?
    `).run(
      scope.workspaceId, scope.eventId, origin.submissionId, origin.sessionId,
      origin.kind, origin.linkedByUserId, Date.parse(origin.linkedAt)
    ), 'stale_origin');
  }
}

export interface DecisionParticipantPersonSource {
  listParticipantPersonIds(scope: DecisionScopeDto, submissionId: string): readonly string[];
}

/** Ascending unique participant person ids from the immutable Intake evidence. */
export function createSQLiteIntakeParticipantPersonSource(
  sqlite: Database
): DecisionParticipantPersonSource {
  return Object.freeze({
    listParticipantPersonIds(scope: DecisionScopeDto, submissionId: string): readonly string[] {
      const rows = sqlite.query<{ readonly person_id: string }, [string, string, string]>(`
        SELECT person_id FROM intake_submission_participant_evidence
         WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
         ORDER BY person_id COLLATE BINARY
      `).all(scope.workspaceId, scope.eventId, submissionId);
      return Object.freeze([...new Set(rows.map((row) => row.person_id))]);
    }
  });
}

/**
 * Decision candidate facts joined from the least-disclosure submission-triage
 * source row and the submission-minted participant person ids. The candidate
 * `version` reduces the immutable submission facts
 * `{ submissionId, formVersionId, submittedAt }` with the same derivation the
 * Review candidate source uses, so a Decision submission pin and a Review
 * candidate guard always agree about one submission's version.
 */
export class SQLiteDecisionCandidateSourceAdapter {
  constructor(
    private readonly source: SubmissionTriageSourcePort,
    private readonly participants: DecisionParticipantPersonSource
  ) {}

  readDecisionCandidate(
    scope: DecisionScopeDto,
    submissionId: string
  ): DecisionCandidateDto | undefined {
    const value = this.source.readSourceRow(scope, submissionId);
    if (value === undefined) return undefined;
    let row;
    try {
      row = submissionTriageSourceRowSchema.parse(value);
    } catch (error) {
      throw new SQLiteDecisionError('data_corrupt', error);
    }
    if (row.scope.workspaceId !== scope.workspaceId
        || row.scope.eventId !== scope.eventId
        || row.summary.id !== submissionId) {
      throw new SQLiteDecisionError('data_corrupt');
    }
    const target = row.summary.target;
    return Object.freeze({
      submissionId,
      formVersionId: row.summary.formVersionId,
      candidateVersion: deterministicVersion({
        submissionId,
        formVersionId: row.summary.formVersionId,
        submittedAt: row.summary.submittedAt
      }),
      title: row.summary.title,
      formatId: row.format?.id ?? null,
      trackId: row.track?.id ?? null,
      targetSessionId: target.kind === 'session' ? target.sessionId : null,
      participantPersonIds: this.participants.listParticipantPersonIds(scope, submissionId)
    });
  }
}

/** Reduces canonical facts to a positive safe integer (48 digest bits, plus one). */
function deterministicVersion(facts: unknown): number {
  return Number.parseInt(canonicalJsonSha256(facts).slice(0, 12), 16) + 1;
}

/** The graduation's roster write participants; only create and append carry them. */
function graduationParticipants(
  graduation: SessionMutationPlanDto
): readonly SessionRosterParticipantInput[] {
  const input = graduation.input;
  if (input.action === 'create') return input.participants ?? [];
  if (input.action === 'roster_append') return input.participants;
  return [];
}

/**
 * Aggregate review basis for a decide: the current non-discarded round's
 * identity and the organizer-visible whole-population standing reduced to
 * `{ value, n, band }`. Nothing here exposes reviewer identities,
 * per-reviewer scores, or comments; `undefined` means no round basis exists.
 */
export class SQLiteDecisionReviewBasisSourceAdapter {
  constructor(private readonly environment: ReviewProjectionEnvironment) {}

  readDecisionReviewBasis(
    scope: DecisionScopeDto,
    submissionId: string
  ): DecisionReviewPinDto | undefined {
    const reviewScope = parseReviewScope(scope);
    const catalog = this.environment.repository.readCatalog(reviewScope);
    if (!catalog) return undefined;
    const round = [...catalog.rounds].reverse().find(
      (candidate) => candidate.state !== 'discarded'
    );
    if (!round) return undefined;
    const standing = projectReviewStandings({
      scope: reviewScope,
      viewer: { kind: 'organizer' },
      submissionIds: [submissionId],
      slice: 'all',
      environment: this.environment
    })[submissionId];
    return Object.freeze({
      roundId: round.id,
      roundVersion: round.version,
      standing: standing === undefined
        ? null
        : Object.freeze({ value: standing.value, n: standing.n, band: standing.band })
    });
  }
}

export function createSQLiteDecisionEnvironmentSource(input: {
  readonly candidates: Pick<SQLiteDecisionCandidateSourceAdapter, 'readDecisionCandidate'>;
  readonly reviewBasis: Pick<SQLiteDecisionReviewBasisSourceAdapter, 'readDecisionReviewBasis'>;
}): DecisionEnvironmentSource {
  return Object.freeze({
    readDecisionCandidate: (scope: DecisionScopeDto, submissionId: string) =>
      input.candidates.readDecisionCandidate(scope, submissionId),
    readDecisionReviewBasis: (scope: DecisionScopeDto, submissionId: string) =>
      input.reviewBasis.readDecisionReviewBasis(scope, submissionId)
  });
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteDecisionErrorCode
): void {
  if (result.changes !== 1) throw new SQLiteDecisionError(code);
}
