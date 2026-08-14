import type { Database } from 'bun:sqlite';
import {
  engagementMutationPlanSchema,
  engagementRestorePlanSchema,
  engagementSeedPlanSchema,
  engagementSeedReversalPlanSchema,
  type EngagementHeadDto,
  type EngagementMutationPlanDto,
  type EngagementMutationResult,
  type EngagementRestorePlanDto,
  type EngagementScopeDto,
  type EngagementSeedPlanDto,
  type EngagementSeedResultDto,
  type EngagementSeedReversalPlanDto,
  type EngagementSnapshotDto
} from '@jooevents/contracts';
import {
  engagementMutationResultFromPlan,
  engagementMutationResultFromRestore,
  engagementSeedResultFromPlan,
  engagementSeedResultFromReversal,
  isEngagementRestorePlan,
  parseEngagementHead,
  parseEngagementSnapshot,
  type EngagementChangesetTransactionPort,
  type EngagementSeedTransactionPort
} from '@jooevents/engagement';
import { canonicalJsonText } from '@jooevents/kernel';

/** Additive schema installed only in an explicitly disposable SQLite runtime. */
export const SQLITE_ENGAGEMENT_SQL = `
CREATE TABLE engagement_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  submission_id TEXT CHECK(submission_id IS NULL OR length(submission_id) = 36),
  state TEXT NOT NULL CHECK(state IN ('invited', 'confirmed', 'declined', 'cancelled')),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  invited_at_ms INTEGER NOT NULL CHECK(invited_at_ms BETWEEN 0 AND 8640000000000000),
  cancelled_at_ms INTEGER CHECK(
    cancelled_at_ms IS NULL OR cancelled_at_ms BETWEEN 0 AND 8640000000000000
  ),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, session_id, person_id),
  CHECK((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.sessionId') = session_id),
  CHECK(json_extract(head_json, '$.personId') = person_id),
  CHECK(json_extract(head_json, '$.state') = state),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(
    (submission_id IS NULL AND json_extract(head_json, '$.submissionId') IS NULL)
    OR json_extract(head_json, '$.submissionId') = submission_id
  ),
  CHECK((submission_id IS NULL) = (json_extract(head_json, '$.seededByDecision') IS NULL)),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX engagement_heads_person
  ON engagement_heads(workspace_id, event_id, person_id, session_id);

CREATE INDEX engagement_heads_submission
  ON engagement_heads(workspace_id, event_id, submission_id, session_id, person_id)
  WHERE submission_id IS NOT NULL;

CREATE TRIGGER engagement_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, session_id, person_id, submission_id
ON engagement_heads
BEGIN
  SELECT RAISE(ABORT, 'engagement identity is immutable');
END;

CREATE TRIGGER engagement_heads_seed_provenance_immutable
BEFORE UPDATE OF head_json ON engagement_heads
WHEN json_extract(OLD.head_json, '$.seededByDecision')
  IS NOT json_extract(NEW.head_json, '$.seededByDecision')
BEGIN
  SELECT RAISE(ABORT, 'engagement seed provenance is immutable');
END;
`;

export type SQLiteEngagementErrorCode =
  | 'transaction_required'
  | 'scope_corrupt'
  | 'data_corrupt'
  | 'stale_engagement'
  | 'seed_conflict';

export class SQLiteEngagementError extends Error {
  constructor(readonly code: SQLiteEngagementErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteEngagementError';
  }
}

export function installEngagementSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteEngagementError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_ENGAGEMENT_SQL);
}

interface HeadRow { readonly head_json: string }
interface ScopeRow { readonly event_id: string }
interface CountRow { readonly count: number }

/**
 * Canonical engagement persistence: the response changeset ports and the seed
 * collaboration ports on one caller-owned handle. Every write is guarded by
 * the exact expected row image and refuses on any drift; seeding inserts are
 * additionally fenced by the physical `(sessionId, personId)` uniqueness, so a
 * racing duplicate seed is a conflict, never a second row.
 */
export class SQLiteEngagementRepository
implements EngagementChangesetTransactionPort, EngagementSeedTransactionPort {
  constructor(private readonly sqlite: Database) {}

  readEngagementHead(scope: EngagementScopeDto, engagementId: string): EngagementHeadDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT head_json FROM engagement_heads
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, engagementId);
    return row === null ? undefined : this.parseRow(row);
  }

  readSessionPersonEngagement(
    scope: EngagementScopeDto,
    sessionId: string,
    personId: string
  ): EngagementHeadDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<HeadRow, [string, string, string, string]>(`
      SELECT head_json FROM engagement_heads
       WHERE workspace_id = ? AND event_id = ? AND session_id = ? AND person_id = ?
    `).get(scope.workspaceId, scope.eventId, sessionId, personId);
    return row === null ? undefined : this.parseRow(row);
  }

  listSeededEngagements(
    scope: EngagementScopeDto,
    sessionId: string,
    submissionId: string
  ): readonly EngagementHeadDto[] {
    if (!this.scopeExists(scope)) return Object.freeze([]);
    const rows = this.sqlite.query<HeadRow, [string, string, string, string]>(`
      SELECT head_json FROM engagement_heads
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? AND session_id = ?
       ORDER BY person_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, submissionId, sessionId);
    return Object.freeze(rows.map((row) => this.parseRow(row)));
  }

  readEngagementSnapshot(scope: EngagementScopeDto): EngagementSnapshotDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const rows = this.sqlite.query<HeadRow, [string, string]>(`
      SELECT head_json FROM engagement_heads
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY session_id COLLATE BINARY, person_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    try {
      return parseEngagementSnapshot({
        schemaVersion: 1,
        scope,
        engagements: rows.map((row) => JSON.parse(row.head_json))
      });
    } catch (error) {
      throw new SQLiteEngagementError('data_corrupt', error);
    }
  }

  applyEngagementPlan(
    plan: EngagementMutationPlanDto | EngagementRestorePlanDto
  ): EngagementMutationResult {
    if (!this.sqlite.inTransaction) throw new SQLiteEngagementError('transaction_required');
    if (isEngagementRestorePlan(plan)) {
      const parsed = engagementRestorePlanSchema.parse(plan);
      this.updateHead(parsed.scope, parsed.expectedCurrent, parsed.restore);
      return engagementMutationResultFromRestore(parsed);
    }
    const parsed = engagementMutationPlanSchema.parse(plan);
    this.updateHead(parsed.input.scope, parsed.before, parsed.after);
    return engagementMutationResultFromPlan(parsed);
  }

  applyEngagementSeed(contribution: EngagementSeedPlanDto): EngagementSeedResultDto {
    if (!this.sqlite.inTransaction) throw new SQLiteEngagementError('transaction_required');
    const parsed = engagementSeedPlanSchema.parse(contribution);
    for (const row of parsed.rows) this.insertHead(parsed.input.scope, row.head);
    return engagementSeedResultFromPlan(parsed);
  }

  applyEngagementSeedReversal(plan: EngagementSeedReversalPlanDto): EngagementSeedResultDto {
    if (!this.sqlite.inTransaction) throw new SQLiteEngagementError('transaction_required');
    const parsed = engagementSeedReversalPlanSchema.parse(plan);
    for (const row of parsed.rows) this.deleteSeededHead(parsed.scope, row.expectedCurrent);
    return engagementSeedResultFromReversal(parsed);
  }

  private parseRow(row: HeadRow): EngagementHeadDto {
    try {
      return parseEngagementHead(JSON.parse(row.head_json));
    } catch (error) {
      throw new SQLiteEngagementError('data_corrupt', error);
    }
  }

  private scopeExists(scope: EngagementScopeDto): boolean {
    const rows = this.sqlite.query<ScopeRow, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteEngagementError('scope_corrupt');
    return rows.length === 1;
  }

  private insertHead(scope: EngagementScopeDto, head: EngagementHeadDto): void {
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, string, string, string | null, string, number, string, number,
      string, string,
      string, string, string, string
    ]>(`
      INSERT INTO engagement_heads (
        workspace_id, event_id, id, session_id, person_id, submission_id,
        state, version, head_json, invited_at_ms, cancelled_at_ms
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
        FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM engagement_heads
            WHERE workspace_id = ? AND event_id = ? AND session_id = ? AND person_id = ?
         )
    `).run(
      scope.workspaceId, scope.eventId, head.id, head.sessionId, head.personId,
      head.submissionId, head.state, head.version, canonicalJsonText(head),
      Date.parse(head.invitedAt),
      scope.workspaceId, scope.eventId,
      scope.workspaceId, scope.eventId, head.sessionId, head.personId
    ), 'seed_conflict');
  }

  private updateHead(
    scope: EngagementScopeDto,
    expected: EngagementHeadDto,
    next: EngagementHeadDto
  ): void {
    changedExactlyOnce(this.sqlite.query<never, [
      string, number, string, number | null,
      string, string, string, number, string
    ]>(`
      UPDATE engagement_heads
         SET state = ?, version = ?, head_json = ?, cancelled_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ?
         AND version = ? AND head_json = ?
    `).run(
      next.state, next.version, canonicalJsonText(next),
      next.cancelledAt === null ? null : Date.parse(next.cancelledAt),
      scope.workspaceId, scope.eventId, expected.id,
      expected.version, canonicalJsonText(expected)
    ), 'stale_engagement');
  }

  private deleteSeededHead(scope: EngagementScopeDto, expected: EngagementHeadDto): void {
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, string]>(`
      DELETE FROM engagement_heads
       WHERE workspace_id = ? AND event_id = ? AND id = ?
         AND version = 1 AND state = 'invited' AND head_json = ?
    `).run(
      scope.workspaceId, scope.eventId, expected.id, canonicalJsonText(expected)
    ), 'stale_engagement');
  }
}

/**
 * Compensation-census contributor: engagement heads hold durable
 * `submissionId` references, so a submission with seeded engagements refuses
 * direct-entry compensation until the acceptance itself is compensated first.
 */
export interface SQLiteEngagementSubmissionReferenceSource {
  countSubmissionReferences(
    scope: { readonly workspaceId: string; readonly eventId: string },
    submissionId: string
  ): number;
}

export function createSQLiteEngagementSubmissionReferenceSource(
  sqlite: Database
): SQLiteEngagementSubmissionReferenceSource {
  return Object.freeze({
    countSubmissionReferences(
      scope: { readonly workspaceId: string; readonly eventId: string },
      submissionId: string
    ): number {
      const row = sqlite.query<CountRow, [string, string, string]>(`
        SELECT count(*) AS count FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
      `).get(scope.workspaceId, scope.eventId, submissionId);
      return row?.count ?? 0;
    }
  });
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteEngagementErrorCode
): void {
  if (result.changes !== 1) throw new SQLiteEngagementError(code);
}
