import type { Database } from 'bun:sqlite';
import type {
  DeadlineCatalogSnapshotDto,
  DeadlineEventTimeBasisDto,
  DeadlineHeadDto,
  DeadlineMutationPlanDto,
  DeadlineMutationResult,
  DeadlineReferencePinDto,
  DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import type {
  ReviewAssignmentDto,
  ReviewCandidateDisplayDto,
  ReviewCandidateSnapshotDto,
  ReviewCatalogDto,
  ReviewCriterionDto,
  ReviewDeadlinePinDto,
  ReviewDraftDto,
  ReviewHeadDto,
  ReviewRevisionDto,
  ReviewRoundDto,
  ReviewScopeDto,
  ReviewVacancyResolutionDto
} from '@jooevents/contracts/reviews';
import {
  reviewDeadlinePinFromReference,
  type ReviewDueDeadlineAppliedContribution,
  type ReviewDueDeadlineChangeInput,
  type ReviewDueDeadlineContribution,
  type ReviewDueDeadlinePlanningPort,
  type ReviewDueDeadlineTransactionPort,
  type ReviewDueDeadlineValidation,
  type ReviewDueDeadlineValidationPort
} from '@jooevents/deadline';
import {
  createEmptyReviewCatalog,
  assertReviewCatalogDigest,
  parseReviewAssignment,
  parseReviewCatalog,
  parseReviewDraft,
  parseReviewHead,
  parseReviewRevision,
  parseReviewRound,
  parseReviewScope,
  parseReviewVacancyResolution,
  type ReviewCandidateDisplaySource,
  type ReviewCandidateSet,
  type ReviewPlanningSource,
  type ReviewRosterSet,
  type ReviewTransactionRepository
} from '@jooevents/review';
import {
  createReviewerRosterReviewPlanningSource,
  projectReviewerRosterSnapshot,
  type ReviewerRosterPlanningSource
} from '@jooevents/review/roster';
import type { SubmissionTriageSourcePort } from '@jooevents/submission-triage';
import { SQLiteDeadlineRepository } from './deadline';
import { SQLiteEventSpineRepository } from './event-spine';
import { SQLiteReviewCandidateSourceAdapter } from './review-candidate-source';
import { SQLiteReviewerRosterRepository } from './reviewer-roster';

/**
 * Durable Review schema over an established event scope root. Promoted from the
 * review trial: the `review_one_open_round` partial unique index and every
 * immutability/retention trigger are retained verbatim, and each round pins the
 * canonical `review_due` Deadline created in the same committed unit of work.
 */
export const REVIEW_SQL = `
CREATE TABLE review_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_rounds (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'discarded')),
  version INTEGER NOT NULL CHECK(version > 0),
  deadline_id TEXT NOT NULL CHECK(length(deadline_id) = 36),
  deadline_kind TEXT NOT NULL CHECK(deadline_kind = 'review_due'),
  deadline_version INTEGER NOT NULL CHECK(deadline_version > 0),
  deadline_digest_sha256 TEXT NOT NULL CHECK(length(deadline_digest_sha256) = 64 AND deadline_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  deadline_effective_at_ms INTEGER NOT NULL CHECK(deadline_effective_at_ms BETWEEN 0 AND 8640000000000000),
  participant_identity TEXT NOT NULL CHECK(participant_identity IN ('hidden', 'shown')),
  peer_reviewer_identity TEXT NOT NULL CHECK(peer_reviewer_identity IN ('hidden', 'shown')),
  peer_content_unlock TEXT NOT NULL CHECK(peer_content_unlock IN ('after_own_commit', 'open')),
  opened_by_user_id TEXT NOT NULL CHECK(length(opened_by_user_id) = 36),
  opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms BETWEEN 0 AND 8640000000000000),
  closed_by_user_id TEXT CHECK(closed_by_user_id IS NULL OR length(closed_by_user_id) = 36),
  closed_at_ms INTEGER CHECK(closed_at_ms IS NULL OR closed_at_ms BETWEEN 0 AND 8640000000000000),
  discarded_by_user_id TEXT CHECK(discarded_by_user_id IS NULL OR length(discarded_by_user_id) = 36),
  discarded_at_ms INTEGER CHECK(discarded_at_ms IS NULL OR discarded_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, ordinal),
  UNIQUE (id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES review_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'open' AND closed_by_user_id IS NULL AND closed_at_ms IS NULL AND discarded_by_user_id IS NULL AND discarded_at_ms IS NULL)
    OR (state = 'closed' AND closed_by_user_id IS NOT NULL AND closed_at_ms IS NOT NULL AND discarded_by_user_id IS NULL AND discarded_at_ms IS NULL)
    OR (state = 'discarded' AND discarded_by_user_id IS NOT NULL AND discarded_at_ms IS NOT NULL AND closed_by_user_id IS NULL AND closed_at_ms IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX review_one_open_round
  ON review_rounds(workspace_id, event_id) WHERE state = 'open';

CREATE TABLE review_round_criteria (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 160),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  description TEXT CHECK(description IS NULL OR length(description) BETWEEN 1 AND 500),
  position INTEGER NOT NULL CHECK(position >= 0),
  weight_bps INTEGER NOT NULL CHECK(weight_bps BETWEEN 1 AND 10000),
  scale_min INTEGER NOT NULL CHECK(scale_min = 1),
  scale_max INTEGER NOT NULL CHECK(scale_max = 5),
  PRIMARY KEY (workspace_id, event_id, round_id, id),
  UNIQUE (workspace_id, event_id, round_id, key),
  UNIQUE (workspace_id, event_id, round_id, position),
  FOREIGN KEY (workspace_id, event_id, round_id)
    REFERENCES review_rounds(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_assignments (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  round_id TEXT NOT NULL CHECK(length(round_id) = 36),
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36),
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('assigned', 'stepped_back')),
  assigned_at_ms INTEGER NOT NULL CHECK(assigned_at_ms BETWEEN 0 AND 8640000000000000),
  stepped_back_at_ms INTEGER CHECK(stepped_back_at_ms IS NULL OR stepped_back_at_ms BETWEEN 0 AND 8640000000000000),
  stepped_back_by_user_id TEXT CHECK(stepped_back_by_user_id IS NULL OR length(stepped_back_by_user_id) = 36),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, event_id, round_id, submission_id, reviewer_id),
  FOREIGN KEY (workspace_id, event_id, round_id)
    REFERENCES review_rounds(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'assigned' AND stepped_back_at_ms IS NULL AND stepped_back_by_user_id IS NULL)
    OR (state = 'stepped_back' AND stepped_back_at_ms IS NOT NULL AND stepped_back_by_user_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE review_drafts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  comment TEXT NOT NULL CHECK(length(comment) <= 20000),
  updated_by_reviewer_id TEXT NOT NULL CHECK(length(updated_by_reviewer_id) = 36),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, assignment_id),
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE review_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  weighted_score REAL NOT NULL CHECK(weighted_score BETWEEN 1 AND 5),
  comment TEXT NOT NULL CHECK(length(comment) <= 20000),
  committed_by_reviewer_id TEXT NOT NULL CHECK(length(committed_by_reviewer_id) = 36),
  committed_by_user_id TEXT NOT NULL CHECK(length(committed_by_user_id) = 36),
  committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms BETWEEN 0 AND 8640000000000000),
  post_unlock INTEGER NOT NULL CHECK(post_unlock IN (0, 1)),
  correction_of_revision_id TEXT CHECK(correction_of_revision_id IS NULL OR length(correction_of_revision_id) = 36),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, event_id, assignment_id, revision_number),
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (correction_of_revision_id) REFERENCES review_revisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (revision_number = 1 AND post_unlock = 0 AND correction_of_revision_id IS NULL)
    OR (revision_number > 1 AND post_unlock = 1 AND correction_of_revision_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE review_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  first_committed_at_ms INTEGER NOT NULL CHECK(first_committed_at_ms BETWEEN 0 AND 8640000000000000),
  peer_unlocked_at_ms INTEGER NOT NULL CHECK(peer_unlocked_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, assignment_id),
  FOREIGN KEY (workspace_id, event_id, assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (current_revision_id) REFERENCES review_revisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER review_round_criteria_immutable BEFORE UPDATE ON review_round_criteria
BEGIN SELECT RAISE(ABORT, 'review criteria are immutable'); END;
CREATE TRIGGER review_round_criteria_retained BEFORE DELETE ON review_round_criteria
BEGIN SELECT RAISE(ABORT, 'review criteria are retained'); END;
CREATE TRIGGER review_revisions_immutable BEFORE UPDATE ON review_revisions
BEGIN SELECT RAISE(ABORT, 'review revisions are immutable'); END;
CREATE TRIGGER review_revisions_retained BEFORE DELETE ON review_revisions
BEGIN SELECT RAISE(ABORT, 'review revisions are retained'); END;
CREATE TRIGGER review_rounds_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, ordinal, deadline_id, deadline_kind,
  deadline_version, deadline_digest_sha256, deadline_effective_at_ms, opened_by_user_id,
  opened_at_ms ON review_rounds
BEGIN SELECT RAISE(ABORT, 'review round identity and pins are immutable'); END;
CREATE TRIGGER review_assignments_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, round_id, submission_id, reviewer_id,
  assigned_at_ms ON review_assignments
BEGIN SELECT RAISE(ABORT, 'review assignment identity is immutable'); END;
CREATE TRIGGER review_catalogs_retained BEFORE DELETE ON review_catalogs
BEGIN SELECT RAISE(ABORT, 'review catalogs are retained'); END;
CREATE TRIGGER review_rounds_retained BEFORE DELETE ON review_rounds
BEGIN SELECT RAISE(ABORT, 'review rounds are retained'); END;
CREATE TRIGGER review_assignments_retained BEFORE DELETE ON review_assignments
BEGIN SELECT RAISE(ABORT, 'review assignments are retained'); END;
CREATE TRIGGER review_drafts_retained BEFORE DELETE ON review_drafts
BEGIN SELECT RAISE(ABORT, 'review drafts are retained'); END;
CREATE TRIGGER review_heads_retained BEFORE DELETE ON review_heads
BEGIN SELECT RAISE(ABORT, 'review heads are retained'); END;
`;

/** Sequence-10 additive schema for isolated repository fixtures only. */
export const REVIEW_VACANCY_RESOLUTION_SQL = `
CREATE TABLE review_assignment_vacancy_resolutions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  vacated_assignment_id TEXT NOT NULL CHECK(length(vacated_assignment_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('replacement', 'coverage_accepted')),
  replacement_assignment_id TEXT CHECK(replacement_assignment_id IS NULL OR length(replacement_assignment_id) = 36),
  replacement_reviewer_id TEXT CHECK(replacement_reviewer_id IS NULL OR length(replacement_reviewer_id) = 36),
  resolved_by_user_id TEXT NOT NULL CHECK(length(resolved_by_user_id) = 36),
  resolved_at_ms INTEGER NOT NULL CHECK(resolved_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, vacated_assignment_id),
  UNIQUE (workspace_id, event_id, replacement_assignment_id),
  FOREIGN KEY (workspace_id, event_id, vacated_assignment_id)
    REFERENCES review_assignments(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    workspace_id, event_id, replacement_assignment_id, replacement_reviewer_id
  ) REFERENCES review_assignments(workspace_id, event_id, id, reviewer_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (kind = 'replacement' AND replacement_assignment_id IS NOT NULL AND replacement_reviewer_id IS NOT NULL)
    OR (kind = 'coverage_accepted' AND replacement_assignment_id IS NULL AND replacement_reviewer_id IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX review_assignments_vacancy_resolution_reference
  ON review_assignments(workspace_id, event_id, id, reviewer_id);

CREATE TRIGGER review_assignment_vacancy_resolutions_immutable
BEFORE UPDATE ON review_assignment_vacancy_resolutions
BEGIN SELECT RAISE(ABORT, 'review vacancy resolutions are immutable'); END;

CREATE TRIGGER review_assignment_vacancy_resolutions_retained
BEFORE DELETE ON review_assignment_vacancy_resolutions
BEGIN SELECT RAISE(ABORT, 'review vacancy resolutions are retained'); END;
`;

export type SQLiteReviewErrorCode =
  | 'transaction_required'
  | 'data_corrupt'
  | 'stale_catalog'
  | 'stale_round'
  | 'stale_assignment'
  | 'stale_draft'
  | 'stale_review'
  | 'identity_collision';

export class SQLiteReviewError extends Error {
  constructor(readonly code: SQLiteReviewErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteReviewError';
  }
}

interface CatalogRow { readonly version: number; readonly digest_sha256: string }
interface RoundRow {
  readonly workspace_id: string; readonly event_id: string; readonly id: string;
  readonly ordinal: number; readonly name: string;
  readonly state: 'open' | 'closed' | 'discarded'; readonly version: number;
  readonly deadline_id: string; readonly deadline_kind: 'review_due';
  readonly deadline_version: number; readonly deadline_digest_sha256: string;
  readonly deadline_effective_at_ms: number;
  readonly participant_identity: 'hidden' | 'shown';
  readonly peer_reviewer_identity: 'hidden' | 'shown';
  readonly peer_content_unlock: 'after_own_commit' | 'open';
  readonly opened_by_user_id: string; readonly opened_at_ms: number;
  readonly closed_by_user_id: string | null; readonly closed_at_ms: number | null;
  readonly discarded_by_user_id: string | null; readonly discarded_at_ms: number | null;
}
interface CriterionRow {
  readonly id: string; readonly key: string; readonly label: string;
  readonly description: string | null; readonly position: number;
  readonly weight_bps: number; readonly scale_min: 1; readonly scale_max: 5;
}
interface AssignmentRow {
  readonly workspace_id: string; readonly event_id: string; readonly id: string;
  readonly round_id: string; readonly submission_id: string; readonly reviewer_id: string;
  readonly version: number; readonly state: 'assigned' | 'stepped_back';
  readonly assigned_at_ms: number; readonly stepped_back_at_ms: number | null;
  readonly stepped_back_by_user_id: string | null;
}
interface VacancyResolutionRow {
  readonly workspace_id: string; readonly event_id: string;
  readonly vacated_assignment_id: string;
  readonly kind: 'replacement' | 'coverage_accepted';
  readonly replacement_assignment_id: string | null;
  readonly replacement_reviewer_id: string | null;
  readonly resolved_by_user_id: string; readonly resolved_at_ms: number;
}
interface DraftRow {
  readonly workspace_id: string; readonly event_id: string; readonly assignment_id: string;
  readonly version: number; readonly scores_json: string; readonly comment: string;
  readonly updated_by_reviewer_id: string; readonly updated_by_user_id: string;
  readonly updated_at_ms: number;
}
interface HeadRow {
  readonly workspace_id: string; readonly event_id: string; readonly assignment_id: string;
  readonly version: number; readonly current_revision_id: string;
  readonly first_committed_at_ms: number; readonly peer_unlocked_at_ms: number;
}
interface RevisionRow {
  readonly workspace_id: string; readonly event_id: string; readonly id: string;
  readonly assignment_id: string; readonly revision_number: number;
  readonly scores_json: string; readonly weighted_score: number; readonly comment: string;
  readonly committed_by_reviewer_id: string; readonly committed_by_user_id: string;
  readonly committed_at_ms: number; readonly post_unlock: 0 | 1;
  readonly correction_of_revision_id: string | null;
}

export function installReviewSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteReviewError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(REVIEW_SQL);
  sqlite.exec(REVIEW_VACANCY_RESOLUTION_SQL);
}

/** Imported lower-owner sources the composed Review repository joins over. */
export interface SQLiteReviewRepositorySources {
  /** Least-disclosure submission-triage rows that become Review candidates. */
  readonly triage: SubmissionTriageSourcePort;
  /** Reviewer authority and scope-target facts consumed by the durable roster. */
  readonly roster: ReviewerRosterPlanningSource;
}

/**
 * Durable Review domain repository on one caller-owned SQLite handle. It owns
 * the review tables and composes every imported planning fact behind the frozen
 * `ReviewPlanningSource` port: candidates come from the submission-triage
 * source adapter, the reviewer roster from the durable roster repository joined
 * to lower-owner authority facts, and Deadline pins plus the three `review_due`
 * collaboration ports from the sibling Deadline repository, so one object can
 * serve every read, validation, and transaction port Review operations need.
 */
export class SQLiteReviewRepository implements
  ReviewTransactionRepository,
  ReviewPlanningSource,
  ReviewCandidateDisplaySource,
  ReviewDueDeadlinePlanningPort,
  ReviewDueDeadlineValidationPort,
  ReviewDueDeadlineTransactionPort {
  readonly deadlines: SQLiteDeadlineRepository;
  readonly #candidates: SQLiteReviewCandidateSourceAdapter;
  readonly #rosterRepository: SQLiteReviewerRosterRepository;
  readonly #rosterPlanning: ReturnType<typeof createReviewerRosterReviewPlanningSource>;
  readonly #rosterSources: ReviewerRosterPlanningSource;

  constructor(
    private readonly sqlite: Database,
    sources: SQLiteReviewRepositorySources
  ) {
    this.#candidates = new SQLiteReviewCandidateSourceAdapter(sources.triage);
    this.#rosterSources = sources.roster;
    this.#rosterRepository = new SQLiteReviewerRosterRepository(sqlite, sources.roster);
    this.#rosterPlanning = createReviewerRosterReviewPlanningSource({
      repository: this.#rosterRepository,
      authority: sources.roster
    });
    this.deadlines = new SQLiteDeadlineRepository(sqlite, new SQLiteEventSpineRepository(sqlite));
  }

  // ---- ReviewPlanningSource ------------------------------------------------

  readCandidates(scope: ReviewScopeDto): ReviewCandidateSet | undefined {
    return this.#candidates.readCandidates(scope);
  }

  readCandidate(scope: ReviewScopeDto, submissionId: string): ReviewCandidateSnapshotDto | undefined {
    return this.#candidates.readCandidate(scope, submissionId);
  }

  readReviewerRoster(scope: ReviewScopeDto): ReviewRosterSet | undefined {
    return this.#rosterPlanning.readReviewerRoster(parseReviewScope(scope));
  }

  resolveReviewDeadline(
    scopeInput: ReviewScopeDto,
    deadlineId: string
  ): ReviewDeadlinePinDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const head = this.deadlines.readDeadline(scope, deadlineId);
    if (!head || head.kind !== 'review_due' || head.status !== 'active') return undefined;
    const pin = this.deadlines.resolveCurrentDeadline(scope, { deadlineId });
    return pin ? reviewDeadlinePinFromReference(pin) : undefined;
  }

  // ---- ReviewCandidateDisplaySource ---------------------------------------

  readReviewCandidateDisplay(input: {
    readonly scope: ReviewScopeDto;
    readonly roundId: string;
    readonly submissionId: string;
    readonly reviewerId: string;
    readonly includeSpeakerIdentity: boolean;
  }): ReviewCandidateDisplayDto | undefined {
    return this.#candidates.readReviewCandidateDisplay(input);
  }

  /**
   * Resolves the acting reviewer for a verified workspace-membership principal:
   * the single active roster member whose current authority subject is exactly
   * that membership. Absent or ambiguous bindings resolve to no reviewer, which
   * surfaces upstream as the typed viewer-required refusal.
   */
  resolveActingReviewer(scopeInput: ReviewScopeDto, membershipId: string): string | undefined {
    const scope = parseReviewScope(scopeInput);
    const snapshot = projectReviewerRosterSnapshot({
      repository: this.#rosterRepository,
      authority: this.#rosterSources,
      scope
    });
    if (!snapshot) return undefined;
    const matches = snapshot.reviewers.filter((reviewer) =>
      reviewer.status === 'active'
      && reviewer.authority.state === 'active'
      && reviewer.authority.currentSubject !== undefined
      && reviewer.authority.currentSubject.kind === 'workspace_membership'
      && reviewer.authority.currentSubject.id === membershipId
    );
    return matches.length === 1 ? matches[0]!.reviewerId : undefined;
  }

  // ---- review_due Deadline collaboration ports (delegated) -----------------

  readDeadlineCatalog(scope: DeadlineScopeDto): DeadlineCatalogSnapshotDto | undefined {
    return this.deadlines.readDeadlineCatalog(scope);
  }

  readDeadline(scope: DeadlineScopeDto, deadlineId: string): DeadlineHeadDto | undefined {
    return this.deadlines.readDeadline(scope, deadlineId);
  }

  readDeadlineEventTimeBasis(scope: DeadlineScopeDto): DeadlineEventTimeBasisDto | undefined {
    return this.deadlines.readDeadlineEventTimeBasis(scope);
  }

  resolveCurrentDeadline(
    scope: DeadlineScopeDto,
    reference: { readonly deadlineId: string }
  ): DeadlineReferencePinDto | undefined {
    return this.deadlines.resolveCurrentDeadline(scope, reference);
  }

  planReviewDueDeadlineChange(input: ReviewDueDeadlineChangeInput): ReviewDueDeadlineContribution {
    return this.deadlines.planReviewDueDeadlineChange(input);
  }

  validateReviewDueDeadline(
    contribution: ReviewDueDeadlineContribution
  ): ReviewDueDeadlineValidation {
    return this.deadlines.validateReviewDueDeadline(contribution);
  }

  applyReviewDueDeadline(
    contribution: ReviewDueDeadlineContribution
  ): ReviewDueDeadlineAppliedContribution {
    return this.deadlines.applyReviewDueDeadline(contribution);
  }

  applyDeadlinePlan(plan: DeadlineMutationPlanDto): DeadlineMutationResult {
    return this.deadlines.applyDeadlinePlan(plan);
  }

  // ---- ReviewRepository ----------------------------------------------------

  readCatalog(scopeInput: ReviewScopeDto): ReviewCatalogDto | undefined {
    const scope = parseReviewScope(scopeInput);
    if (!this.scopeExists(scope)) return undefined;
    const rows = this.sqlite.query<CatalogRow, [string, string]>(`
      SELECT version, digest_sha256 FROM review_catalogs
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    const rounds = this.readRoundRows(scope).map((row) => this.roundFromRow(row));
    if (!rows[0]) {
      if (rounds.length > 0) throw new SQLiteReviewError('data_corrupt');
      return createEmptyReviewCatalog(scope);
    }
    return guarded(() => parseReviewCatalog({
      schemaVersion: 1,
      scope,
      version: rows[0]!.version,
      digestSha256: rows[0]!.digest_sha256,
      rounds
    }));
  }

  readRound(scopeInput: ReviewScopeDto, roundId: string): ReviewRoundDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.sqlite.query<RoundRow, [string, string, string]>(`
      SELECT * FROM review_rounds
       WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, roundId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows[0] ? this.roundFromRow(rows[0]) : undefined;
  }

  listAssignments(scopeInput: ReviewScopeDto, roundId: string): readonly ReviewAssignmentDto[] {
    const scope = parseReviewScope(scopeInput);
    return Object.freeze(this.sqlite.query<AssignmentRow, [string, string, string]>(`
      SELECT * FROM review_assignments
       WHERE workspace_id = ? AND event_id = ? AND round_id = ?
       ORDER BY reviewer_id COLLATE BINARY, submission_id COLLATE BINARY, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, roundId).map(assignmentFromRow));
  }

  readAssignment(scopeInput: ReviewScopeDto, assignmentId: string): ReviewAssignmentDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.sqlite.query<AssignmentRow, [string, string, string]>(`
      SELECT * FROM review_assignments
       WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, assignmentId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows[0] ? assignmentFromRow(rows[0]) : undefined;
  }

  readVacancyResolution(
    scopeInput: ReviewScopeDto,
    vacatedAssignmentId: string
  ): ReviewVacancyResolutionDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.sqlite.query<VacancyResolutionRow, [string, string, string]>(`
      SELECT * FROM review_assignment_vacancy_resolutions
       WHERE workspace_id = ? AND event_id = ? AND vacated_assignment_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, vacatedAssignmentId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows[0] ? vacancyResolutionFromRow(rows[0]) : undefined;
  }

  readDraft(scopeInput: ReviewScopeDto, assignmentId: string): ReviewDraftDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.sqlite.query<DraftRow, [string, string, string]>(`
      SELECT * FROM review_drafts
       WHERE workspace_id = ? AND event_id = ? AND assignment_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, assignmentId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows[0] ? draftFromRow(rows[0]) : undefined;
  }

  readReviewHead(scopeInput: ReviewScopeDto, assignmentId: string): ReviewHeadDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT * FROM review_heads
       WHERE workspace_id = ? AND event_id = ? AND assignment_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, assignmentId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows[0] ? headFromRow(rows[0]) : undefined;
  }

  readRevision(scopeInput: ReviewScopeDto, revisionId: string): ReviewRevisionDto | undefined {
    const scope = parseReviewScope(scopeInput);
    const rows = this.sqlite.query<RevisionRow, [string, string, string]>(`
      SELECT * FROM review_revisions
       WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, revisionId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows[0] ? revisionFromRow(rows[0]) : undefined;
  }

  listRevisions(scopeInput: ReviewScopeDto, assignmentId: string): readonly ReviewRevisionDto[] {
    const scope = parseReviewScope(scopeInput);
    return Object.freeze(this.sqlite.query<RevisionRow, [string, string, string]>(`
      SELECT * FROM review_revisions
       WHERE workspace_id = ? AND event_id = ? AND assignment_id = ?
       ORDER BY revision_number, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, assignmentId).map(revisionFromRow));
  }

  // ---- ReviewTransactionRepository ----------------------------------------

  applyCatalog(input: { readonly before: ReviewCatalogDto; readonly after: ReviewCatalogDto }): void {
    this.requireTransaction();
    const before = parseReviewCatalog(input.before);
    const after = parseReviewCatalog(input.after);
    assertReviewCatalogDigest(before);
    assertReviewCatalogDigest(after);
    if (before.scope.workspaceId !== after.scope.workspaceId
        || before.scope.eventId !== after.scope.eventId
        || after.version !== before.version + 1) {
      throw new SQLiteReviewError('stale_catalog');
    }
    if (before.version === 1) {
      try {
        changedExactlyOnce(this.sqlite.query<never, [string, string, number, string]>(`
          INSERT INTO review_catalogs (workspace_id, event_id, version, digest_sha256)
          VALUES (?, ?, ?, ?)
        `).run(
          after.scope.workspaceId, after.scope.eventId,
          after.version, after.digestSha256
        ), 'stale_catalog');
      } catch (error) {
        if (error instanceof SQLiteReviewError) throw error;
        throw new SQLiteReviewError('stale_catalog', error);
      }
      return;
    }
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, string, number, string]>(`
      UPDATE review_catalogs SET version = ?, digest_sha256 = ?
       WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?
    `).run(
      after.version, after.digestSha256,
      before.scope.workspaceId, before.scope.eventId,
      before.version, before.digestSha256
    ), 'stale_catalog');
  }

  insertRound(round: ReviewRoundDto): void {
    this.requireTransaction();
    const parsed = parseReviewRound(round);
    try {
      this.insertRoundRow(parsed);
      for (const criterion of parsed.criteria) {
        this.insertCriterion(parsed.scope, parsed.id, criterion);
      }
    } catch (error) {
      if (error instanceof SQLiteReviewError) throw error;
      throw new SQLiteReviewError('identity_collision', error);
    }
  }

  updateRound(input: { readonly before: ReviewRoundDto; readonly after: ReviewRoundDto }): void {
    this.requireTransaction();
    const before = parseReviewRound(input.before);
    const after = parseReviewRound(input.after);
    if (before.id !== after.id
        || before.scope.workspaceId !== after.scope.workspaceId
        || before.scope.eventId !== after.scope.eventId
        || after.version !== before.version + 1) {
      throw new SQLiteReviewError('stale_round');
    }
    changedExactlyOnce(this.sqlite.query<never, [string, number, string | null, number | null, string | null, number | null, string, string, string, number, string]>(`
      UPDATE review_rounds
         SET state = ?, version = ?, closed_by_user_id = ?, closed_at_ms = ?,
             discarded_by_user_id = ?, discarded_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ? AND state = ?
    `).run(
      after.state, after.version,
      after.state === 'closed' ? after.closedByUserId : null,
      after.state === 'closed' ? Date.parse(after.closedAt) : null,
      after.state === 'discarded' ? after.discardedByUserId : null,
      after.state === 'discarded' ? Date.parse(after.discardedAt) : null,
      before.scope.workspaceId, before.scope.eventId, before.id,
      before.version, before.state
    ), 'stale_round');
  }

  insertAssignments(assignments: readonly ReviewAssignmentDto[]): void {
    this.requireTransaction();
    try {
      const statement = this.sqlite.query<never, [string, string, string, string, string, string, number, string, number, number | null, string | null]>(`
        INSERT INTO review_assignments (
          workspace_id, event_id, id, round_id, submission_id, reviewer_id,
          version, state, assigned_at_ms, stepped_back_at_ms, stepped_back_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const assignmentInput of assignments) {
        const assignment = parseReviewAssignment(assignmentInput);
        changedExactlyOnce(statement.run(
          assignment.scope.workspaceId, assignment.scope.eventId, assignment.id,
          assignment.roundId, assignment.submissionId, assignment.reviewerId,
          assignment.version, assignment.state, Date.parse(assignment.assignedAt),
          assignment.state === 'stepped_back' ? Date.parse(assignment.steppedBackAt) : null,
          assignment.state === 'stepped_back' ? assignment.steppedBackByUserId : null
        ), 'identity_collision');
      }
    } catch (error) {
      if (error instanceof SQLiteReviewError) throw error;
      throw new SQLiteReviewError('identity_collision', error);
    }
  }

  updateAssignment(input: { readonly before: ReviewAssignmentDto; readonly after: ReviewAssignmentDto }): void {
    this.requireTransaction();
    const before = parseReviewAssignment(input.before);
    const after = parseReviewAssignment(input.after);
    if (before.id !== after.id
        || before.scope.workspaceId !== after.scope.workspaceId
        || before.scope.eventId !== after.scope.eventId
        || after.version !== before.version + 1) {
      throw new SQLiteReviewError('stale_assignment');
    }
    changedExactlyOnce(this.sqlite.query<never, [string, number, number | null, string | null, string, string, string, number, string]>(`
      UPDATE review_assignments
         SET state = ?, version = ?, stepped_back_at_ms = ?, stepped_back_by_user_id = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ? AND state = ?
    `).run(
      after.state, after.version,
      after.state === 'stepped_back' ? Date.parse(after.steppedBackAt) : null,
      after.state === 'stepped_back' ? after.steppedBackByUserId : null,
      before.scope.workspaceId, before.scope.eventId, before.id,
      before.version, before.state
    ), 'stale_assignment');
  }

  resolveVacancy(input: {
    readonly resolution: ReviewVacancyResolutionDto;
    readonly replacement?: ReviewAssignmentDto;
  }): void {
    this.requireTransaction();
    const resolution = parseReviewVacancyResolution(input.resolution);
    const replacement = input.replacement === undefined
      ? undefined
      : parseReviewAssignment(input.replacement);
    const coherent = resolution.kind === 'replacement'
      ? replacement !== undefined
        && replacement.id === resolution.replacementAssignmentId
        && replacement.reviewerId === resolution.replacementReviewerId
        && replacement.scope.workspaceId === resolution.scope.workspaceId
        && replacement.scope.eventId === resolution.scope.eventId
      : replacement === undefined;
    if (!coherent) throw new SQLiteReviewError('data_corrupt');
    try {
      if (replacement) this.insertAssignments([replacement]);
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string | null, string | null, string, number]>(`
        INSERT INTO review_assignment_vacancy_resolutions (
          workspace_id, event_id, vacated_assignment_id, kind,
          replacement_assignment_id, replacement_reviewer_id,
          resolved_by_user_id, resolved_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resolution.scope.workspaceId,
        resolution.scope.eventId,
        resolution.vacatedAssignmentId,
        resolution.kind,
        resolution.kind === 'replacement' ? resolution.replacementAssignmentId : null,
        resolution.kind === 'replacement' ? resolution.replacementReviewerId : null,
        resolution.resolvedByUserId,
        Date.parse(resolution.resolvedAt)
      ), 'identity_collision');
    } catch (error) {
      if (error instanceof SQLiteReviewError) throw error;
      throw new SQLiteReviewError('identity_collision', error);
    }
  }

  saveDraft(input: { readonly expectedVersion: number | null; readonly draft: ReviewDraftDto }): void {
    this.requireTransaction();
    const draft = parseReviewDraft(input.draft);
    if (draft.version !== (input.expectedVersion ?? 0) + 1) {
      throw new SQLiteReviewError('stale_draft');
    }
    if (input.expectedVersion === null) {
      try {
        changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string, string, string, string, number]>(`
          INSERT INTO review_drafts (
            workspace_id, event_id, assignment_id, version, scores_json, comment,
            updated_by_reviewer_id, updated_by_user_id, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          draft.scope.workspaceId, draft.scope.eventId, draft.assignmentId, draft.version,
          JSON.stringify(draft.scores), draft.comment, draft.updatedByReviewerId,
          draft.updatedByUserId, Date.parse(draft.updatedAt)
        ), 'stale_draft');
      } catch (error) {
        if (error instanceof SQLiteReviewError) throw error;
        throw new SQLiteReviewError('stale_draft', error);
      }
      return;
    }
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, string, string, number, string, string, string, number]>(`
      UPDATE review_drafts
         SET version = ?, scores_json = ?, comment = ?, updated_by_reviewer_id = ?,
             updated_by_user_id = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND assignment_id = ? AND version = ?
    `).run(
      draft.version, JSON.stringify(draft.scores), draft.comment,
      draft.updatedByReviewerId, draft.updatedByUserId, Date.parse(draft.updatedAt),
      draft.scope.workspaceId, draft.scope.eventId, draft.assignmentId, input.expectedVersion
    ), 'stale_draft');
  }

  insertFirstReview(input: { readonly head: ReviewHeadDto; readonly revision: ReviewRevisionDto }): void {
    this.requireTransaction();
    const head = parseReviewHead(input.head);
    const revision = parseReviewRevision(input.revision);
    if (head.version !== 1
        || revision.revisionNumber !== 1
        || head.currentRevisionId !== revision.id
        || head.assignmentId !== revision.assignmentId
        || head.scope.workspaceId !== revision.scope.workspaceId
        || head.scope.eventId !== revision.scope.eventId) {
      throw new SQLiteReviewError('identity_collision');
    }
    try {
      this.insertRevision(revision);
      this.insertHead(head);
    } catch (error) {
      if (error instanceof SQLiteReviewError) throw error;
      throw new SQLiteReviewError('identity_collision', error);
    }
  }

  appendReviewRevision(input: {
    readonly before: ReviewHeadDto;
    readonly after: ReviewHeadDto;
    readonly revision: ReviewRevisionDto;
  }): void {
    this.requireTransaction();
    const before = parseReviewHead(input.before);
    const after = parseReviewHead(input.after);
    const revision = parseReviewRevision(input.revision);
    if (before.assignmentId !== after.assignmentId
        || before.scope.workspaceId !== after.scope.workspaceId
        || before.scope.eventId !== after.scope.eventId
        || after.version !== before.version + 1
        || after.currentRevisionId !== revision.id
        || revision.assignmentId !== before.assignmentId) {
      throw new SQLiteReviewError('stale_review');
    }
    try {
      this.insertRevision(revision);
      changedExactlyOnce(this.sqlite.query<never, [number, string, string, string, string, number, string]>(`
        UPDATE review_heads SET version = ?, current_revision_id = ?
         WHERE workspace_id = ? AND event_id = ? AND assignment_id = ?
           AND version = ? AND current_revision_id = ?
      `).run(
        after.version, after.currentRevisionId,
        before.scope.workspaceId, before.scope.eventId,
        before.assignmentId, before.version, before.currentRevisionId
      ), 'stale_review');
    } catch (error) {
      if (error instanceof SQLiteReviewError) throw error;
      throw new SQLiteReviewError('stale_review', error);
    }
  }

  // ---- internals -----------------------------------------------------------

  private scopeExists(scope: ReviewScopeDto): boolean {
    const rows = this.sqlite.query<{ readonly event_id: string }, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteReviewError('data_corrupt');
    return rows.length === 1;
  }

  private readRoundRows(scope: ReviewScopeDto): readonly RoundRow[] {
    return this.sqlite.query<RoundRow, [string, string]>(`
      SELECT * FROM review_rounds
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY ordinal, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
  }

  private roundFromRow(row: RoundRow): ReviewRoundDto {
    const criteria = this.sqlite.query<CriterionRow, [string, string, string]>(`
      SELECT id, key, label, description, position, weight_bps, scale_min, scale_max
        FROM review_round_criteria
       WHERE workspace_id = ? AND event_id = ? AND round_id = ?
       ORDER BY position, id COLLATE BINARY
    `).all(row.workspace_id, row.event_id, row.id).map(criterionFromRow);
    const common = {
      schemaVersion: 1 as const,
      scope: { workspaceId: row.workspace_id, eventId: row.event_id },
      id: row.id,
      ordinal: row.ordinal,
      name: row.name,
      version: row.version,
      deadline: {
        deadlineId: row.deadline_id,
        kind: row.deadline_kind,
        version: row.deadline_version,
        digestSha256: row.deadline_digest_sha256,
        effectiveAt: instant(row.deadline_effective_at_ms)
      },
      criteria,
      visibility: {
        participantIdentity: row.participant_identity,
        peerReviewerIdentity: row.peer_reviewer_identity,
        peerContentUnlock: row.peer_content_unlock
      },
      openedByUserId: row.opened_by_user_id,
      openedAt: instant(row.opened_at_ms)
    };
    if (row.state === 'closed') return guarded(() => parseReviewRound({
      ...common, state: row.state,
      closedByUserId: row.closed_by_user_id,
      closedAt: row.closed_at_ms === null ? null : instant(row.closed_at_ms)
    }));
    if (row.state === 'discarded') return guarded(() => parseReviewRound({
      ...common, state: row.state,
      discardedByUserId: row.discarded_by_user_id,
      discardedAt: row.discarded_at_ms === null ? null : instant(row.discarded_at_ms)
    }));
    return guarded(() => parseReviewRound({ ...common, state: row.state }));
  }

  private insertRoundRow(round: ReviewRoundDto): void {
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string, string, number, string, string, number, string, number, string, string, string, string, number, string | null, number | null, string | null, number | null]>(`
      INSERT INTO review_rounds (
        workspace_id, event_id, id, ordinal, name, state, version,
        deadline_id, deadline_kind, deadline_version, deadline_digest_sha256,
        deadline_effective_at_ms, participant_identity, peer_reviewer_identity,
        peer_content_unlock, opened_by_user_id, opened_at_ms,
        closed_by_user_id, closed_at_ms, discarded_by_user_id, discarded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      round.scope.workspaceId, round.scope.eventId, round.id, round.ordinal, round.name,
      round.state, round.version, round.deadline.deadlineId, round.deadline.kind,
      round.deadline.version, round.deadline.digestSha256, Date.parse(round.deadline.effectiveAt),
      round.visibility.participantIdentity, round.visibility.peerReviewerIdentity,
      round.visibility.peerContentUnlock, round.openedByUserId, Date.parse(round.openedAt),
      round.state === 'closed' ? round.closedByUserId : null,
      round.state === 'closed' ? Date.parse(round.closedAt) : null,
      round.state === 'discarded' ? round.discardedByUserId : null,
      round.state === 'discarded' ? Date.parse(round.discardedAt) : null
    ), 'identity_collision');
  }

  private insertCriterion(scope: ReviewScopeDto, roundId: string, criterion: ReviewCriterionDto): void {
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string, string, string | null, number, number, number, number]>(`
      INSERT INTO review_round_criteria (
        workspace_id, event_id, round_id, id, key, label, description,
        position, weight_bps, scale_min, scale_max
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.workspaceId, scope.eventId, roundId, criterion.id, criterion.key,
      criterion.label, criterion.description ?? null, criterion.position,
      criterion.weightBps, criterion.scaleMin, criterion.scaleMax
    ), 'identity_collision');
  }

  private insertRevision(revisionInput: ReviewRevisionDto): void {
    const revision = parseReviewRevision(revisionInput);
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, number, string, number, string, string, string, number, number, string | null]>(`
      INSERT INTO review_revisions (
        workspace_id, event_id, id, assignment_id, revision_number, scores_json,
        weighted_score, comment, committed_by_reviewer_id, committed_by_user_id,
        committed_at_ms, post_unlock, correction_of_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.scope.workspaceId, revision.scope.eventId, revision.id,
      revision.assignmentId, revision.revisionNumber, JSON.stringify(revision.scores),
      revision.weightedScore, revision.comment, revision.committedByReviewerId,
      revision.committedByUserId, Date.parse(revision.committedAt),
      revision.postUnlock ? 1 : 0, revision.correctionOfRevisionId ?? null
    ), 'identity_collision');
  }

  private insertHead(headInput: ReviewHeadDto): void {
    const head = parseReviewHead(headInput);
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string, number, number]>(`
      INSERT INTO review_heads (
        workspace_id, event_id, assignment_id, version, current_revision_id,
        first_committed_at_ms, peer_unlocked_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      head.scope.workspaceId, head.scope.eventId, head.assignmentId, head.version,
      head.currentRevisionId, Date.parse(head.firstCommittedAt), Date.parse(head.peerUnlockedAt)
    ), 'identity_collision');
  }

  private requireTransaction(): void {
    if (!this.sqlite.inTransaction) throw new SQLiteReviewError('transaction_required');
  }
}

function criterionFromRow(row: CriterionRow): ReviewCriterionDto {
  return {
    id: row.id as ReviewCriterionDto['id'], key: row.key, label: row.label,
    ...(row.description === null ? {} : { description: row.description }),
    position: row.position, weightBps: row.weight_bps,
    scaleMin: row.scale_min, scaleMax: row.scale_max
  };
}

function assignmentFromRow(row: AssignmentRow): ReviewAssignmentDto {
  const common = {
    schemaVersion: 1 as const,
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    id: row.id,
    roundId: row.round_id,
    submissionId: row.submission_id,
    reviewerId: row.reviewer_id,
    version: row.version,
    assignedAt: instant(row.assigned_at_ms)
  };
  return guarded(() => row.state === 'assigned'
    ? parseReviewAssignment({ ...common, state: row.state })
    : parseReviewAssignment({
        ...common, state: row.state,
        steppedBackAt: row.stepped_back_at_ms === null ? null : instant(row.stepped_back_at_ms),
        steppedBackByUserId: row.stepped_back_by_user_id
      }));
}

function vacancyResolutionFromRow(row: VacancyResolutionRow): ReviewVacancyResolutionDto {
  const common = {
    schemaVersion: 1 as const,
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    vacatedAssignmentId: row.vacated_assignment_id,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedAt: instant(row.resolved_at_ms)
  };
  return guarded(() => row.kind === 'replacement'
    ? parseReviewVacancyResolution({
        ...common,
        kind: row.kind,
        replacementAssignmentId: row.replacement_assignment_id,
        replacementReviewerId: row.replacement_reviewer_id
      })
    : parseReviewVacancyResolution({ ...common, kind: row.kind }));
}

function draftFromRow(row: DraftRow): ReviewDraftDto {
  return guarded(() => parseReviewDraft({
    schemaVersion: 1,
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    assignmentId: row.assignment_id,
    version: row.version,
    scores: JSON.parse(row.scores_json) as unknown,
    comment: row.comment,
    updatedByReviewerId: row.updated_by_reviewer_id,
    updatedByUserId: row.updated_by_user_id,
    updatedAt: instant(row.updated_at_ms)
  }));
}

function headFromRow(row: HeadRow): ReviewHeadDto {
  return guarded(() => parseReviewHead({
    schemaVersion: 1,
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    assignmentId: row.assignment_id,
    version: row.version,
    currentRevisionId: row.current_revision_id,
    firstCommittedAt: instant(row.first_committed_at_ms),
    peerUnlockedAt: instant(row.peer_unlocked_at_ms)
  }));
}

function revisionFromRow(row: RevisionRow): ReviewRevisionDto {
  return guarded(() => parseReviewRevision({
    schemaVersion: 1,
    scope: { workspaceId: row.workspace_id, eventId: row.event_id },
    id: row.id,
    assignmentId: row.assignment_id,
    revisionNumber: row.revision_number,
    scores: JSON.parse(row.scores_json) as unknown,
    weightedScore: row.weighted_score,
    comment: row.comment,
    committedByReviewerId: row.committed_by_reviewer_id,
    committedByUserId: row.committed_by_user_id,
    committedAt: instant(row.committed_at_ms),
    postUnlock: row.post_unlock === 1,
    ...(row.correction_of_revision_id === null
      ? {}
      : { correctionOfRevisionId: row.correction_of_revision_id })
  }));
}

function instant(milliseconds: number): string {
  const value = new Date(milliseconds).toISOString();
  if (Date.parse(value) !== milliseconds) throw new SQLiteReviewError('data_corrupt');
  return value;
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteReviewErrorCode
): void {
  if (result.changes !== 1) throw new SQLiteReviewError(code);
}

function guarded<Value>(read: () => Value): Value {
  try {
    return read();
  } catch (error) {
    if (error instanceof SQLiteReviewError) throw error;
    throw new SQLiteReviewError('data_corrupt', error);
  }
}
