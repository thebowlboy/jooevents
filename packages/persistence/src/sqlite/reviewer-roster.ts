import { canonicalJsonSha256 } from '@jooevents/kernel';
import type { Database } from 'bun:sqlite';

import {
  compareScopeRef,
  reviewerRosterMutationResultSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerRosterMutationPlanDto,
  type ReviewerRosterMutationResult,
  type ReviewerRosterRecordDto,
  type ReviewerRosterScopeDto,
  type ReviewerRosterStateDto,
  type ReviewerScopeRefDto,
  type ReviewerScopeTargetSetDto
} from '@jooevents/contracts/reviewer-roster';
import {
  createEmptyReviewerRoster,
  parseReviewerRosterRecord,
  parseReviewerRosterScope,
  parseReviewerRosterState,
  type ReviewerRosterPlanningSource,
  type ReviewerRosterTransactionRepository
} from '@jooevents/review/roster';

/** Durable reviewer-roster schema over an established event scope root. */
export const REVIEWER_ROSTER_SQL = `
CREATE TABLE reviewer_roster_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_records (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('included', 'revoked')),
  access_subject_kind TEXT NOT NULL CHECK(access_subject_kind IN ('access_reservation', 'workspace_membership')),
  access_subject_id TEXT NOT NULL CHECK(length(access_subject_id) = 36),
  access_subject_version INTEGER NOT NULL CHECK(access_subject_version > 0),
  added_by_user_id TEXT NOT NULL CHECK(length(added_by_user_id) = 36),
  added_at_ms INTEGER NOT NULL CHECK(added_at_ms BETWEEN 0 AND 8640000000000000),
  revoked_by_user_id TEXT CHECK(revoked_by_user_id IS NULL OR length(revoked_by_user_id) = 36),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, reviewer_id),
  UNIQUE (workspace_id, event_id, access_subject_kind, access_subject_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES reviewer_roster_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'included' AND revoked_by_user_id IS NULL AND revoked_at_ms IS NULL)
    OR (state = 'revoked' AND revoked_by_user_id IS NOT NULL AND revoked_at_ms IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_scopes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('track', 'format', 'session')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) = 36),
  PRIMARY KEY (workspace_id, event_id, reviewer_id, ref_kind, ref_id),
  FOREIGN KEY (workspace_id, event_id, reviewer_id)
    REFERENCES reviewer_roster_records(workspace_id, event_id, reviewer_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER reviewer_roster_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, reviewer_id, access_subject_kind, access_subject_id
ON reviewer_roster_records
BEGIN SELECT RAISE(ABORT, 'reviewer roster identity is immutable'); END;

CREATE TRIGGER reviewer_roster_records_retained
BEFORE DELETE ON reviewer_roster_records
BEGIN SELECT RAISE(ABORT, 'reviewer roster records are retained'); END;
`;

export type SQLiteReviewerRosterErrorCode =
  | 'transaction_required'
  | 'data_corrupt'
  | 'stale_roster'
  | 'stale_reviewer'
  | 'identity_collision';

export class SQLiteReviewerRosterError extends Error {
  constructor(readonly code: SQLiteReviewerRosterErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteReviewerRosterError';
  }
}

interface SetRow { readonly version: number; readonly digest_sha256: string }
interface RecordRow {
  readonly reviewer_id: string; readonly version: number;
  readonly state: 'included' | 'revoked';
  readonly access_subject_kind: 'access_reservation' | 'workspace_membership';
  readonly access_subject_id: string; readonly access_subject_version: number;
  readonly added_by_user_id: string; readonly added_at_ms: number;
  readonly revoked_by_user_id: string | null; readonly revoked_at_ms: number | null;
}
interface ScopeRow { readonly ref_kind: 'track' | 'format' | 'session'; readonly ref_id: string }

export function installReviewerRosterSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteReviewerRosterError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(REVIEWER_ROSTER_SQL);
}

/**
 * Durable reviewer roster on a caller-owned SQLite handle. The roster tables
 * are the only state this repository owns: reviewer records are retained (never
 * deleted), their identity — including the exact access-subject binding — is
 * immutable, and one access subject registers at most once per event. Authority
 * and scope-target facts are delegated to the injected lower-owner sources.
 */
export class SQLiteReviewerRosterRepository
implements ReviewerRosterTransactionRepository {
  constructor(
    private readonly sqlite: Database,
    private readonly sources: ReviewerRosterPlanningSource
  ) {}

  readReviewerRoster(scopeValue: ReviewerRosterScopeDto): ReviewerRosterStateDto | undefined {
    const scope = parseReviewerRosterScope(scopeValue);
    const sets = this.sqlite.query<SetRow, [string, string]>(`
      SELECT version, digest_sha256 FROM reviewer_roster_sets
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (sets.length > 1) throw new SQLiteReviewerRosterError('data_corrupt');
    const rows = this.sqlite.query<RecordRow, [string, string]>(`
      SELECT reviewer_id, version, state, access_subject_kind, access_subject_id,
             access_subject_version, added_by_user_id, added_at_ms,
             revoked_by_user_id, revoked_at_ms
        FROM reviewer_roster_records
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY reviewer_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    if (!sets[0]) {
      if (rows.length > 0) throw new SQLiteReviewerRosterError('data_corrupt');
      return createEmptyReviewerRoster(scope);
    }
    const reviewers = rows.map((row) => this.recordFromRow(scope, row));
    return guarded(() => parseReviewerRosterState({
      schemaVersion: 1, scope, version: sets[0]!.version,
      digestSha256: sets[0]!.digest_sha256, reviewers
    }));
  }

  readReviewerAuthority(scope: ReviewerRosterScopeDto): ReviewerAuthoritySetDto | undefined {
    return this.sources.readReviewerAuthority(parseReviewerRosterScope(scope));
  }

  readReviewerScopeTargets(scope: ReviewerRosterScopeDto): ReviewerScopeTargetSetDto | undefined {
    return this.sources.readReviewerScopeTargets(parseReviewerRosterScope(scope));
  }

  applyReviewerRosterPlan(plan: ReviewerRosterMutationPlanDto): ReviewerRosterMutationResult {
    requireTransaction(this.sqlite);
    const current = this.readReviewerRoster(plan.input.scope);
    if (!current || current.version !== plan.roster.beforeVersion
        || current.digestSha256 !== plan.roster.beforeDigestSha256) {
      throw new SQLiteReviewerRosterError('stale_roster');
    }
    const currentRecord = current.reviewers.find(
      (reviewer) => reviewer.reviewerId === plan.input.reviewerId
    ) ?? null;
    if (canonicalJsonSha256(currentRecord) !== canonicalJsonSha256(plan.before)) {
      throw new SQLiteReviewerRosterError('stale_reviewer');
    }
    try {
      this.writeSet(plan.input.scope, plan.roster.afterVersion, plan.roster.afterDigestSha256);
      this.writeRecord(plan.after);
      this.replaceScope(plan.after);
    } catch (error) {
      if (error instanceof SQLiteReviewerRosterError) throw error;
      throw new SQLiteReviewerRosterError('identity_collision', error);
    }
    return reviewerRosterMutationResultSchema.parse({
      schemaVersion: 1, action: plan.action,
      rosterVersion: plan.roster.afterVersion,
      rosterDigestSha256: plan.roster.afterDigestSha256,
      reviewer: plan.after
    });
  }

  private recordFromRow(scope: ReviewerRosterScopeDto, row: RecordRow): ReviewerRosterRecordDto {
    const reviews = (this.sqlite.query<ScopeRow, [string, string, string]>(`
      SELECT ref_kind, ref_id FROM reviewer_roster_scopes
       WHERE workspace_id = ? AND event_id = ? AND reviewer_id = ?
       ORDER BY CASE ref_kind WHEN 'track' THEN 0 WHEN 'format' THEN 1 ELSE 2 END,
                ref_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, row.reviewer_id).map((candidate) => ({
      kind: candidate.ref_kind, id: candidate.ref_id
    })) as ReviewerScopeRefDto[]).sort(compareScopeRef);
    return guarded(() => parseReviewerRosterRecord({
      schemaVersion: 1, scope, reviewerId: row.reviewer_id, version: row.version,
      accessSubject: {
        kind: row.access_subject_kind, id: row.access_subject_id,
        version: row.access_subject_version
      },
      reviews, state: row.state,
      addedByUserId: row.added_by_user_id, addedAt: fromMillis(row.added_at_ms),
      ...(row.state === 'revoked' ? {
        revokedByUserId: row.revoked_by_user_id,
        revokedAt: row.revoked_at_ms === null ? null : fromMillis(row.revoked_at_ms)
      } : {})
    }));
  }

  private writeSet(scope: ReviewerRosterScopeDto, version: number, digestSha256: string): void {
    if (version === 2) {
      this.sqlite.query(`
        INSERT INTO reviewer_roster_sets(workspace_id, event_id, version, digest_sha256)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, event_id) DO UPDATE SET
          version = excluded.version, digest_sha256 = excluded.digest_sha256
      `).run(scope.workspaceId, scope.eventId, version, digestSha256);
      return;
    }
    const result = this.sqlite.query(`
      UPDATE reviewer_roster_sets SET version = ?, digest_sha256 = ?
       WHERE workspace_id = ? AND event_id = ? AND version = ?
    `).run(version, digestSha256, scope.workspaceId, scope.eventId, version - 1);
    if (result.changes !== 1) throw new SQLiteReviewerRosterError('stale_roster');
  }

  private writeRecord(record: ReviewerRosterRecordDto): void {
    const values = [
      record.scope.workspaceId, record.scope.eventId, record.reviewerId, record.version,
      record.state, record.accessSubject.kind, record.accessSubject.id,
      record.accessSubject.version, record.addedByUserId, toMillis(record.addedAt),
      record.state === 'revoked' ? record.revokedByUserId : null,
      record.state === 'revoked' ? toMillis(record.revokedAt) : null
    ] as const;
    if (record.version === 1) {
      this.sqlite.query(`
        INSERT INTO reviewer_roster_records(
          workspace_id, event_id, reviewer_id, version, state,
          access_subject_kind, access_subject_id, access_subject_version,
          added_by_user_id, added_at_ms, revoked_by_user_id, revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values);
      return;
    }
    const result = this.sqlite.query(`
      UPDATE reviewer_roster_records SET
        version = ?, state = ?, access_subject_version = ?,
        revoked_by_user_id = ?, revoked_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND reviewer_id = ? AND version = ?
    `).run(
      record.version, record.state, record.accessSubject.version,
      record.state === 'revoked' ? record.revokedByUserId : null,
      record.state === 'revoked' ? toMillis(record.revokedAt) : null,
      record.scope.workspaceId, record.scope.eventId, record.reviewerId, record.version - 1
    );
    if (result.changes !== 1) throw new SQLiteReviewerRosterError('stale_reviewer');
  }

  private replaceScope(record: ReviewerRosterRecordDto): void {
    this.sqlite.query(`
      DELETE FROM reviewer_roster_scopes
       WHERE workspace_id = ? AND event_id = ? AND reviewer_id = ?
    `).run(record.scope.workspaceId, record.scope.eventId, record.reviewerId);
    const insert = this.sqlite.query(`
      INSERT INTO reviewer_roster_scopes(
        workspace_id, event_id, reviewer_id, ref_kind, ref_id
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const ref of record.reviews) {
      insert.run(
        record.scope.workspaceId, record.scope.eventId, record.reviewerId, ref.kind, ref.id
      );
    }
  }
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteReviewerRosterError('transaction_required');
}

function guarded<Value>(operation: () => Value): Value {
  try { return operation(); } catch (error) {
    if (error instanceof SQLiteReviewerRosterError) throw error;
    throw new SQLiteReviewerRosterError('data_corrupt', error);
  }
}

function toMillis(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isSafeInteger(millis)) throw new SQLiteReviewerRosterError('data_corrupt');
  return millis;
}

function fromMillis(value: number): string {
  try { return new Date(value).toISOString(); } catch (error) {
    throw new SQLiteReviewerRosterError('data_corrupt', error);
  }
}
