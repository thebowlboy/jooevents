import type { Database } from 'bun:sqlite';
import {
  compareScopeRef,
  reviewerAuthoritySetSchema,
  reviewerRosterMutationResultSchema,
  reviewerScopeTargetSetSchema,
  type ReviewerAuthoritySetDto,
  type ReviewerEligibilityFactDto,
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
  reviewerRosterDigest,
  type ReviewerRosterAttribution,
  type ReviewerRosterChangesetReadPort,
  type ReviewerRosterChangesetTransactionPort
} from '@jooevents/review/roster';

/** Disposable evaluation schema. This is deliberately not a retained migration. */
export const REVIEWER_ROSTER_TRIAL_SQL = `
CREATE TABLE reviewer_roster_trial_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_trial_records (
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
    REFERENCES reviewer_roster_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (state = 'included' AND revoked_by_user_id IS NULL AND revoked_at_ms IS NULL)
    OR (state = 'revoked' AND revoked_by_user_id IS NOT NULL AND revoked_at_ms IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_roster_trial_scopes (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('track', 'format', 'session')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) = 36),
  PRIMARY KEY (workspace_id, event_id, reviewer_id, ref_kind, ref_id),
  FOREIGN KEY (workspace_id, event_id, reviewer_id)
    REFERENCES reviewer_roster_trial_records(workspace_id, event_id, reviewer_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_authority_trial_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_authority_trial_facts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  roster_subject_kind TEXT NOT NULL CHECK(roster_subject_kind IN ('access_reservation', 'workspace_membership')),
  roster_subject_id TEXT NOT NULL CHECK(length(roster_subject_id) = 36),
  roster_subject_version INTEGER NOT NULL CHECK(roster_subject_version > 0),
  current_subject_kind TEXT CHECK(current_subject_kind IS NULL OR current_subject_kind IN ('access_reservation', 'workspace_membership')),
  current_subject_id TEXT CHECK(current_subject_id IS NULL OR length(current_subject_id) = 36),
  current_subject_version INTEGER CHECK(current_subject_version IS NULL OR current_subject_version > 0),
  state TEXT NOT NULL CHECK(state IN ('reserved', 'active', 'unavailable')),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  capability_ids_json TEXT NOT NULL CHECK(json_valid(capability_ids_json)),
  evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  display_name TEXT CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 160),
  PRIMARY KEY (workspace_id, event_id, roster_subject_kind, roster_subject_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES reviewer_authority_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(
    (current_subject_kind IS NULL AND current_subject_id IS NULL AND current_subject_version IS NULL)
    OR (current_subject_kind IS NOT NULL AND current_subject_id IS NOT NULL AND current_subject_version IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_scope_target_trial_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewer_scope_target_trial_facts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('track', 'format', 'session')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  assignability TEXT NOT NULL CHECK(assignability IN ('assignable', 'retained_only')),
  PRIMARY KEY (workspace_id, event_id, ref_kind, ref_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES reviewer_scope_target_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER reviewer_roster_trial_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, reviewer_id, access_subject_kind, access_subject_id
ON reviewer_roster_trial_records
BEGIN SELECT RAISE(ABORT, 'reviewer roster identity is immutable'); END;

CREATE TRIGGER reviewer_roster_trial_records_retained
BEFORE DELETE ON reviewer_roster_trial_records
BEGIN SELECT RAISE(ABORT, 'reviewer roster records are retained'); END;
`;

export type SQLiteReviewerRosterTrialErrorCode =
  | 'transaction_required'
  | 'data_corrupt'
  | 'stale_roster'
  | 'stale_reviewer'
  | 'identity_collision';

export class SQLiteReviewerRosterTrialError extends Error {
  constructor(readonly code: SQLiteReviewerRosterTrialErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteReviewerRosterTrialError';
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
interface AuthorityRow {
  readonly roster_subject_kind: 'access_reservation' | 'workspace_membership';
  readonly roster_subject_id: string; readonly roster_subject_version: number;
  readonly current_subject_kind: 'access_reservation' | 'workspace_membership' | null;
  readonly current_subject_id: string | null; readonly current_subject_version: number | null;
  readonly state: 'reserved' | 'active' | 'unavailable'; readonly version: number;
  readonly digest_sha256: string; readonly capability_ids_json: string;
  readonly evidence_ids_json: string; readonly display_name: string | null;
}
interface TargetRow {
  readonly ref_kind: 'track' | 'format' | 'session'; readonly ref_id: string;
  readonly version: number; readonly digest_sha256: string;
  readonly assignability: 'assignable' | 'retained_only';
}

export function installReviewerRosterTrialSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteReviewerRosterTrialError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(REVIEWER_ROSTER_TRIAL_SQL);
}

export class SQLiteReviewerRosterTrialRepository
implements ReviewerRosterChangesetReadPort, ReviewerRosterChangesetTransactionPort {
  constructor(
    private readonly sqlite: Database,
    private readonly compensationAttribution?: (
      scope: ReviewerRosterScopeDto
    ) => ReviewerRosterAttribution | undefined
  ) {}

  readReviewerRoster(scopeValue: ReviewerRosterScopeDto): ReviewerRosterStateDto | undefined {
    const scope = parseReviewerRosterScope(scopeValue);
    const sets = this.sqlite.query<SetRow, [string, string]>(`
      SELECT version, digest_sha256 FROM reviewer_roster_trial_sets
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (sets.length > 1) throw new SQLiteReviewerRosterTrialError('data_corrupt');
    const rows = this.sqlite.query<RecordRow, [string, string]>(`
      SELECT reviewer_id, version, state, access_subject_kind, access_subject_id,
             access_subject_version, added_by_user_id, added_at_ms,
             revoked_by_user_id, revoked_at_ms
        FROM reviewer_roster_trial_records
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY reviewer_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    if (!sets[0]) {
      if (rows.length > 0) throw new SQLiteReviewerRosterTrialError('data_corrupt');
      return createEmptyReviewerRoster(scope);
    }
    const reviewers = rows.map((row) => this.recordFromRow(scope, row));
    return guarded(() => parseReviewerRosterState({
      schemaVersion: 1, scope, version: sets[0]!.version,
      digestSha256: sets[0]!.digest_sha256, reviewers
    }));
  }

  readReviewerAuthority(scopeValue: ReviewerRosterScopeDto): ReviewerAuthoritySetDto | undefined {
    const scope = parseReviewerRosterScope(scopeValue);
    const sets = this.sqlite.query<SetRow, [string, string]>(`
      SELECT version, digest_sha256 FROM reviewer_authority_trial_sets
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (!sets[0]) return undefined;
    const facts = this.sqlite.query<AuthorityRow, [string, string]>(`
      SELECT roster_subject_kind, roster_subject_id, roster_subject_version,
             current_subject_kind, current_subject_id, current_subject_version,
             state, version, digest_sha256, capability_ids_json, evidence_ids_json, display_name
        FROM reviewer_authority_trial_facts
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY roster_subject_kind COLLATE BINARY, roster_subject_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId).map((row) => authorityFactFromRow(scope, row));
    return guarded(() => reviewerAuthoritySetSchema.parse({
      schemaVersion: 1, scope, version: sets[0]!.version,
      digestSha256: sets[0]!.digest_sha256, facts
    }));
  }

  readReviewerScopeTargets(scopeValue: ReviewerRosterScopeDto): ReviewerScopeTargetSetDto | undefined {
    const scope = parseReviewerRosterScope(scopeValue);
    const sets = this.sqlite.query<SetRow, [string, string]>(`
      SELECT version, digest_sha256 FROM reviewer_scope_target_trial_sets
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (!sets[0]) return undefined;
    const targets = this.sqlite.query<TargetRow, [string, string]>(`
      SELECT ref_kind, ref_id, version, digest_sha256, assignability
        FROM reviewer_scope_target_trial_facts
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY CASE ref_kind WHEN 'track' THEN 0 WHEN 'format' THEN 1 ELSE 2 END,
                ref_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId).map((row) => ({
      schemaVersion: 1 as const, scope,
      ref: { kind: row.ref_kind, id: row.ref_id },
      version: row.version, digestSha256: row.digest_sha256,
      assignability: row.assignability
    }));
    return guarded(() => reviewerScopeTargetSetSchema.parse({
      schemaVersion: 1, scope, version: sets[0]!.version,
      digestSha256: sets[0]!.digest_sha256, targets
    }));
  }

  readReviewerRosterCompensationAttribution(scope: ReviewerRosterScopeDto) {
    return this.compensationAttribution?.(parseReviewerRosterScope(scope));
  }

  applyReviewerRosterPlan(plan: ReviewerRosterMutationPlanDto): ReviewerRosterMutationResult {
    requireTransaction(this.sqlite);
    const current = this.readReviewerRoster(plan.input.scope);
    if (!current || current.version !== plan.roster.beforeVersion
        || current.digestSha256 !== plan.roster.beforeDigestSha256) {
      throw new SQLiteReviewerRosterTrialError('stale_roster');
    }
    const currentRecord = current.reviewers.find(
      (reviewer) => reviewer.reviewerId === plan.input.reviewerId
    ) ?? null;
    if (JSON.stringify(currentRecord) !== JSON.stringify(plan.before)) {
      throw new SQLiteReviewerRosterTrialError('stale_reviewer');
    }
    try {
      this.writeSet(plan.input.scope, plan.roster.afterVersion, plan.roster.afterDigestSha256);
      this.writeRecord(plan.after);
      this.replaceScope(plan.after);
    } catch (error) {
      if (error instanceof SQLiteReviewerRosterTrialError) throw error;
      throw new SQLiteReviewerRosterTrialError('identity_collision', error);
    }
    return reviewerRosterMutationResultSchema.parse({
      schemaVersion: 1, action: plan.action,
      rosterVersion: plan.roster.afterVersion,
      rosterDigestSha256: plan.roster.afterDigestSha256,
      reviewer: plan.after
    });
  }

  replaceReviewerAuthoritySet(setValue: ReviewerAuthoritySetDto): void {
    requireTransaction(this.sqlite);
    const set = reviewerAuthoritySetSchema.parse(setValue);
    this.sqlite.query(`
      INSERT INTO reviewer_authority_trial_sets(workspace_id, event_id, version, digest_sha256)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, event_id) DO UPDATE SET
        version = excluded.version, digest_sha256 = excluded.digest_sha256
    `).run(set.scope.workspaceId, set.scope.eventId, set.version, set.digestSha256);
    this.sqlite.query(`
      DELETE FROM reviewer_authority_trial_facts WHERE workspace_id = ? AND event_id = ?
    `).run(set.scope.workspaceId, set.scope.eventId);
    const insert = this.sqlite.query(`
      INSERT INTO reviewer_authority_trial_facts(
        workspace_id, event_id, roster_subject_kind, roster_subject_id,
        roster_subject_version, current_subject_kind, current_subject_id,
        current_subject_version, state, version, digest_sha256,
        capability_ids_json, evidence_ids_json, display_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fact of set.facts) {
      insert.run(
        set.scope.workspaceId, set.scope.eventId,
        fact.rosterSubject.kind, fact.rosterSubject.id, fact.rosterSubject.version,
        fact.currentSubject?.kind ?? null, fact.currentSubject?.id ?? null,
        fact.currentSubject?.version ?? null, fact.state, fact.version,
        fact.digestSha256, JSON.stringify(fact.capabilityIds),
        JSON.stringify(fact.evidenceIds), fact.displayName ?? null
      );
    }
  }

  replaceReviewerScopeTargetSet(setValue: ReviewerScopeTargetSetDto): void {
    requireTransaction(this.sqlite);
    const set = reviewerScopeTargetSetSchema.parse(setValue);
    this.sqlite.query(`
      INSERT INTO reviewer_scope_target_trial_sets(workspace_id, event_id, version, digest_sha256)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, event_id) DO UPDATE SET
        version = excluded.version, digest_sha256 = excluded.digest_sha256
    `).run(set.scope.workspaceId, set.scope.eventId, set.version, set.digestSha256);
    this.sqlite.query(`
      DELETE FROM reviewer_scope_target_trial_facts WHERE workspace_id = ? AND event_id = ?
    `).run(set.scope.workspaceId, set.scope.eventId);
    const insert = this.sqlite.query(`
      INSERT INTO reviewer_scope_target_trial_facts(
        workspace_id, event_id, ref_kind, ref_id, version, digest_sha256, assignability
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const target of set.targets) {
      insert.run(
        set.scope.workspaceId, set.scope.eventId, target.ref.kind, target.ref.id,
        target.version, target.digestSha256, target.assignability
      );
    }
  }

  private recordFromRow(scope: ReviewerRosterScopeDto, row: RecordRow): ReviewerRosterRecordDto {
    const reviews = (this.sqlite.query<ScopeRow, [string, string, string]>(`
      SELECT ref_kind, ref_id FROM reviewer_roster_trial_scopes
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
        INSERT INTO reviewer_roster_trial_sets(workspace_id, event_id, version, digest_sha256)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, event_id) DO UPDATE SET
          version = excluded.version, digest_sha256 = excluded.digest_sha256
      `).run(scope.workspaceId, scope.eventId, version, digestSha256);
      return;
    }
    const result = this.sqlite.query(`
      UPDATE reviewer_roster_trial_sets SET version = ?, digest_sha256 = ?
       WHERE workspace_id = ? AND event_id = ? AND version = ?
    `).run(version, digestSha256, scope.workspaceId, scope.eventId, version - 1);
    if (result.changes !== 1) throw new SQLiteReviewerRosterTrialError('stale_roster');
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
        INSERT INTO reviewer_roster_trial_records(
          workspace_id, event_id, reviewer_id, version, state,
          access_subject_kind, access_subject_id, access_subject_version,
          added_by_user_id, added_at_ms, revoked_by_user_id, revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values);
      return;
    }
    const result = this.sqlite.query(`
      UPDATE reviewer_roster_trial_records SET
        version = ?, state = ?, access_subject_version = ?,
        revoked_by_user_id = ?, revoked_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND reviewer_id = ? AND version = ?
    `).run(
      record.version, record.state, record.accessSubject.version,
      record.state === 'revoked' ? record.revokedByUserId : null,
      record.state === 'revoked' ? toMillis(record.revokedAt) : null,
      record.scope.workspaceId, record.scope.eventId, record.reviewerId, record.version - 1
    );
    if (result.changes !== 1) throw new SQLiteReviewerRosterTrialError('stale_reviewer');
  }

  private replaceScope(record: ReviewerRosterRecordDto): void {
    this.sqlite.query(`
      DELETE FROM reviewer_roster_trial_scopes
       WHERE workspace_id = ? AND event_id = ? AND reviewer_id = ?
    `).run(record.scope.workspaceId, record.scope.eventId, record.reviewerId);
    const insert = this.sqlite.query(`
      INSERT INTO reviewer_roster_trial_scopes(
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

function authorityFactFromRow(
  scope: ReviewerRosterScopeDto,
  row: AuthorityRow
): ReviewerEligibilityFactDto {
  return guarded(() => ({
    schemaVersion: 1, scope,
    rosterSubject: {
      kind: row.roster_subject_kind, id: row.roster_subject_id,
      version: row.roster_subject_version
    },
    ...(row.current_subject_kind === null ? {} : {
      currentSubject: {
        kind: row.current_subject_kind,
        id: row.current_subject_id,
        version: row.current_subject_version
      }
    }),
    state: row.state, version: row.version, digestSha256: row.digest_sha256,
    capabilityIds: JSON.parse(row.capability_ids_json),
    evidenceIds: JSON.parse(row.evidence_ids_json),
    ...(row.display_name === null ? {} : { displayName: row.display_name })
  } as ReviewerEligibilityFactDto));
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteReviewerRosterTrialError('transaction_required');
}

function guarded<Value>(operation: () => Value): Value {
  try { return operation(); } catch (error) {
    if (error instanceof SQLiteReviewerRosterTrialError) throw error;
    throw new SQLiteReviewerRosterTrialError('data_corrupt', error);
  }
}

function toMillis(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isSafeInteger(millis)) throw new SQLiteReviewerRosterTrialError('data_corrupt');
  return millis;
}

function fromMillis(value: number): string {
  try { return new Date(value).toISOString(); } catch (error) {
    throw new SQLiteReviewerRosterTrialError('data_corrupt', error);
  }
}
