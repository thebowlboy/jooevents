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
import {
  applyDeadlinePlanToCatalog,
  applyFormCloseDeadlineFrom,
  applyReviewDueDeadlineFrom,
  applyTaskDueDeadlineFrom,
  createEmptyDeadlineCatalog,
  parseDeadlineCatalog,
  parseDeadlineHead,
  planFormCloseDeadlineChangeFrom,
  planReviewDueDeadlineChangeFrom,
  planTaskDueDeadlineCreateFrom,
  resolveCurrentDeadlineFrom,
  validateFormCloseDeadlineFrom,
  validateReviewDueDeadlineFrom,
  validateTaskDueDeadlineFrom,
  type DeadlineChangesetTransactionPort,
  type DeadlineReferenceResolver,
  type FormCloseDeadlineAppliedContribution,
  type FormCloseDeadlineChangeInput,
  type FormCloseDeadlineContribution,
  type FormCloseDeadlinePlanningPort,
  type FormCloseDeadlineTransactionPort,
  type FormCloseDeadlineValidation,
  type FormCloseDeadlineValidationPort,
  type ReviewDueDeadlineAppliedContribution,
  type ReviewDueDeadlineChangeInput,
  type ReviewDueDeadlineContribution,
  type ReviewDueDeadlinePlanningPort,
  type ReviewDueDeadlineTransactionPort,
  type ReviewDueDeadlineValidation,
  type ReviewDueDeadlineValidationPort,
  type TaskDueDeadlineAppliedContribution,
  type TaskDueDeadlineContribution,
  type TaskDueDeadlineCreateInput,
  type TaskDueDeadlinePlanningPort,
  type TaskDueDeadlineTransactionPort,
  type TaskDueDeadlineValidation,
  type TaskDueDeadlineValidationPort
} from '@jooevents/deadline';
import { canonicalJsonText } from '@jooevents/kernel';
import type { SQLiteEventSpineRepository } from './event-spine';

/** Additive schema installed only in an explicitly ephemeral SQLite runtime. */
export const DEADLINE_SQL = `
CREATE TABLE deadline_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE deadlines (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('cfp_close', 'review_due', 'task_due')),
  status TEXT NOT NULL CHECK(status IN ('active', 'cleared')),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  grace_policy TEXT NOT NULL CHECK(grace_policy = 'soft'),
  display_date TEXT CHECK(
    display_date IS NULL OR (
      length(display_date) = 10
      AND display_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(display_date, '+0 days') = display_date
    )
  ),
  effective_at_ms INTEGER CHECK(
    effective_at_ms IS NULL OR effective_at_ms BETWEEN 0 AND 8640000000000000
  ),
  boundary_profile_key TEXT,
  boundary_profile_version INTEGER,
  boundary_profile_digest_sha256 TEXT,
  event_timezone TEXT,
  event_version INTEGER,
  local_boundary_date TEXT CHECK(
    local_boundary_date IS NULL OR (
      length(local_boundary_date) = 10
      AND local_boundary_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(local_boundary_date, '+0 days') = local_boundary_date
    )
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  CHECK(
    (status = 'active'
      AND display_date IS NOT NULL AND effective_at_ms IS NOT NULL
      AND boundary_profile_key = 'deadline.calendar-date.event-local-end-exclusive'
      AND boundary_profile_version = 1
      AND length(boundary_profile_digest_sha256) = 64
      AND boundary_profile_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND event_timezone IS NOT NULL AND length(event_timezone) BETWEEN 1 AND 255
      AND event_version > 0 AND local_boundary_date IS NOT NULL)
    OR
    (status = 'cleared'
      AND display_date IS NULL AND effective_at_ms IS NULL
      AND boundary_profile_key IS NULL AND boundary_profile_version IS NULL
      AND boundary_profile_digest_sha256 IS NULL AND event_timezone IS NULL
      AND event_version IS NULL AND local_boundary_date IS NULL)
  ),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES deadline_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX deadlines_status_order
  ON deadlines(workspace_id, event_id, status, id);

CREATE TRIGGER deadlines_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, kind, created_by_user_id, created_at_ms ON deadlines
BEGIN
  SELECT RAISE(ABORT, 'deadline identity is immutable');
END;

CREATE TRIGGER deadlines_no_delete
BEFORE DELETE ON deadlines
BEGIN
  SELECT RAISE(ABORT, 'deadline identity is retained');
END;
`;

export type SQLiteDeadlineErrorCode =
  | 'transaction_required'
  | 'scope_corrupt'
  | 'data_corrupt'
  | 'stale_catalog'
  | 'stale_deadline';

export class SQLiteDeadlineError extends Error {
  constructor(readonly code: SQLiteDeadlineErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteDeadlineError';
  }
}

interface CatalogRow {
  readonly version: number;
  readonly digest_sha256: string;
}

interface DeadlineRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly id: string;
  readonly kind: 'cfp_close' | 'review_due' | 'task_due';
  readonly status: 'active' | 'cleared';
  readonly version: number;
  readonly digest_sha256: string;
  readonly grace_policy: 'soft';
  readonly display_date: string | null;
  readonly effective_at_ms: number | null;
  readonly boundary_profile_key: string | null;
  readonly boundary_profile_version: number | null;
  readonly boundary_profile_digest_sha256: string | null;
  readonly event_timezone: string | null;
  readonly event_version: number | null;
  readonly local_boundary_date: string | null;
  readonly created_by_user_id: string;
  readonly created_at_ms: number;
  readonly updated_by_user_id: string;
  readonly updated_at_ms: number;
}

interface ScopeRow { readonly event_id: string }

export function installDeadlineSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteDeadlineError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(DEADLINE_SQL);
}

export class SQLiteDeadlineRepository implements
  DeadlineChangesetTransactionPort,
  DeadlineReferenceResolver,
  FormCloseDeadlinePlanningPort,
  FormCloseDeadlineValidationPort,
  FormCloseDeadlineTransactionPort,
  ReviewDueDeadlinePlanningPort,
  ReviewDueDeadlineValidationPort,
  ReviewDueDeadlineTransactionPort,
  TaskDueDeadlinePlanningPort,
  TaskDueDeadlineValidationPort,
  TaskDueDeadlineTransactionPort {
  constructor(
    private readonly sqlite: Database,
    private readonly events: Pick<SQLiteEventSpineRepository, 'readEventHead'>
  ) {}

  planTaskDueDeadlineCreate(input: TaskDueDeadlineCreateInput): TaskDueDeadlineContribution {
    return planTaskDueDeadlineCreateFrom(this, input);
  }

  validateTaskDueDeadline(
    contribution: TaskDueDeadlineContribution
  ): TaskDueDeadlineValidation {
    return validateTaskDueDeadlineFrom(this, contribution);
  }

  applyTaskDueDeadline(
    contribution: TaskDueDeadlineContribution
  ): TaskDueDeadlineAppliedContribution {
    return applyTaskDueDeadlineFrom(this, contribution);
  }

  readDeadlineCatalog(scope: DeadlineScopeDto): DeadlineCatalogSnapshotDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const rows = this.sqlite.query<CatalogRow, [string, string]>(`
      SELECT version, digest_sha256 FROM deadline_catalogs
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteDeadlineError('data_corrupt');
    const deadlines = this.readDeadlineRows(scope).map(deadlineFromRow);
    if (!rows[0]) {
      if (deadlines.length > 0) throw new SQLiteDeadlineError('data_corrupt');
      return createEmptyDeadlineCatalog(scope);
    }
    try {
      return parseDeadlineCatalog({
        schemaVersion: 1,
        scope,
        version: rows[0].version,
        digestSha256: rows[0].digest_sha256,
        deadlines
      });
    } catch (error) {
      throw new SQLiteDeadlineError('data_corrupt', error);
    }
  }

  readDeadline(scope: DeadlineScopeDto, deadlineId: string): DeadlineHeadDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const rows = this.sqlite.query<DeadlineRow, [string, string, string]>(`
      SELECT workspace_id, event_id, id, kind, status, version, digest_sha256,
             grace_policy, display_date, effective_at_ms, boundary_profile_key,
             boundary_profile_version, boundary_profile_digest_sha256, event_timezone,
             event_version, local_boundary_date, created_by_user_id, created_at_ms,
             updated_by_user_id, updated_at_ms
        FROM deadlines
       WHERE workspace_id = ? AND event_id = ? AND id = ?
       ORDER BY workspace_id, event_id, id LIMIT 2
    `).all(scope.workspaceId, scope.eventId, deadlineId);
    if (rows.length > 1) throw new SQLiteDeadlineError('data_corrupt');
    return rows[0] ? deadlineFromRow(rows[0]) : undefined;
  }

  readDeadlineEventTimeBasis(scope: DeadlineScopeDto): DeadlineEventTimeBasisDto | undefined {
    const event = this.events.readEventHead({
      workspaceId: scope.workspaceId,
      eventId: scope.eventId
    });
    return event ? Object.freeze({ timezone: event.timezone, eventVersion: event.version }) : undefined;
  }

  resolveCurrentDeadline(
    scope: DeadlineScopeDto,
    reference: { readonly deadlineId: string }
  ): DeadlineReferencePinDto | undefined {
    return resolveCurrentDeadlineFrom(this, scope, reference);
  }

  planFormCloseDeadlineChange(input: FormCloseDeadlineChangeInput): FormCloseDeadlineContribution {
    return planFormCloseDeadlineChangeFrom(this, input);
  }

  validateFormCloseDeadline(
    contribution: FormCloseDeadlineContribution
  ): FormCloseDeadlineValidation {
    return validateFormCloseDeadlineFrom(this, contribution);
  }

  applyFormCloseDeadline(
    contribution: FormCloseDeadlineContribution
  ): FormCloseDeadlineAppliedContribution {
    return applyFormCloseDeadlineFrom(this, contribution);
  }

  planReviewDueDeadlineChange(
    input: ReviewDueDeadlineChangeInput
  ): ReviewDueDeadlineContribution {
    return planReviewDueDeadlineChangeFrom(this, input);
  }

  validateReviewDueDeadline(
    contribution: ReviewDueDeadlineContribution
  ): ReviewDueDeadlineValidation {
    return validateReviewDueDeadlineFrom(this, contribution);
  }

  applyReviewDueDeadline(
    contribution: ReviewDueDeadlineContribution
  ): ReviewDueDeadlineAppliedContribution {
    return applyReviewDueDeadlineFrom(this, contribution);
  }

  applyDeadlinePlan(plan: DeadlineMutationPlanDto): DeadlineMutationResult {
    if (!this.sqlite.inTransaction) throw new SQLiteDeadlineError('transaction_required');
    const catalog = this.readDeadlineCatalog(plan.input.scope);
    if (!catalog) throw new SQLiteDeadlineError('scope_corrupt');
    const eventTimeBasis = plan.eventTimeBasis === null
      ? undefined
      : this.readDeadlineEventTimeBasis(plan.input.scope);
    const applied = applyDeadlinePlanToCatalog({
      plan,
      catalog,
      ...(eventTimeBasis ? { eventTimeBasis } : {})
    });

    if (plan.catalog.beforeVersion === 1) {
      changedExactlyOnce(this.sqlite.query<never, [string, string, number, string, string, string, string, string]>(`
        INSERT INTO deadline_catalogs (workspace_id, event_id, version, digest_sha256)
        SELECT ?, ?, ?, ? FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deadline_catalogs WHERE workspace_id = ? AND event_id = ?
           )
      `).run(
        plan.input.scope.workspaceId, plan.input.scope.eventId,
        plan.catalog.afterVersion, plan.catalog.afterDigestSha256,
        plan.input.scope.workspaceId, plan.input.scope.eventId,
        plan.input.scope.workspaceId, plan.input.scope.eventId
      ), 'stale_catalog');
    }

    if (plan.input.action === 'create') this.insertHead(plan.after);
    else this.updateHead(plan.before!, plan.after);

    if (plan.catalog.beforeVersion !== 1) {
      changedExactlyOnce(this.sqlite.query<never, [number, string, string, string, number, string]>(`
        UPDATE deadline_catalogs SET version = ?, digest_sha256 = ?
         WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?
      `).run(
        plan.catalog.afterVersion, plan.catalog.afterDigestSha256,
        plan.input.scope.workspaceId, plan.input.scope.eventId,
        plan.catalog.beforeVersion, plan.catalog.beforeDigestSha256
      ), 'stale_catalog');
    }
    const reread = this.readDeadlineCatalog(plan.input.scope);
    if (!reread || canonicalJsonText(reread) !== canonicalJsonText(applied.catalog)) {
      throw new SQLiteDeadlineError('data_corrupt');
    }
    return applied.result;
  }

  private scopeExists(scope: DeadlineScopeDto): boolean {
    const rows = this.sqlite.query<ScopeRow, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteDeadlineError('scope_corrupt');
    return rows.length === 1;
  }

  private readDeadlineRows(scope: DeadlineScopeDto): readonly DeadlineRow[] {
    return this.sqlite.query<DeadlineRow, [string, string]>(`
      SELECT workspace_id, event_id, id, kind, status, version, digest_sha256,
             grace_policy, display_date, effective_at_ms, boundary_profile_key,
             boundary_profile_version, boundary_profile_digest_sha256, event_timezone,
             event_version, local_boundary_date, created_by_user_id, created_at_ms,
             updated_by_user_id, updated_at_ms
        FROM deadlines
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
  }

  private insertHead(head: DeadlineHeadDto): void {
    const values = persistedHead(head);
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, string, string, number, string, string,
      string | null, number | null, string | null, number | null, string | null,
      string | null, number | null, string | null, string, number, string, number
    ]>(`
      INSERT INTO deadlines (
        workspace_id, event_id, id, kind, status, version, digest_sha256, grace_policy,
        display_date, effective_at_ms, boundary_profile_key, boundary_profile_version,
        boundary_profile_digest_sha256, event_timezone, event_version, local_boundary_date,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values), 'stale_deadline');
  }

  private updateHead(before: DeadlineHeadDto, after: DeadlineHeadDto): void {
    const values = persistedHead(after);
    changedExactlyOnce(this.sqlite.query<never, [
      string, number, string, string, string | null, number | null, string | null,
      number | null, string | null, string | null, number | null, string | null,
      string, number, string, string, string, number, string
    ]>(`
      UPDATE deadlines
         SET status = ?, version = ?, digest_sha256 = ?, grace_policy = ?,
             display_date = ?, effective_at_ms = ?, boundary_profile_key = ?,
             boundary_profile_version = ?, boundary_profile_digest_sha256 = ?,
             event_timezone = ?, event_version = ?, local_boundary_date = ?,
             updated_by_user_id = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ?
         AND version = ? AND digest_sha256 = ?
    `).run(
      values[4], values[5], values[6], values[7], values[8], values[9], values[10],
      values[11], values[12], values[13], values[14], values[15], values[18], values[19],
      before.scope.workspaceId, before.scope.eventId, before.id,
      before.version, before.digestSha256
    ), 'stale_deadline');
  }
}

function deadlineFromRow(row: DeadlineRow): DeadlineHeadDto {
  try {
    const common = {
      schemaVersion: 1 as const,
      id: row.id,
      scope: { workspaceId: row.workspace_id, eventId: row.event_id },
      kind: row.kind,
      status: row.status,
      version: row.version,
      digestSha256: row.digest_sha256,
      gracePolicy: row.grace_policy,
      createdByUserId: row.created_by_user_id,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedByUserId: row.updated_by_user_id,
      updatedAt: new Date(row.updated_at_ms).toISOString()
    };
    return row.status === 'active'
      ? parseDeadlineHead({
          ...common,
          status: 'active',
          displayDate: row.display_date,
          effectiveAt: new Date(row.effective_at_ms!).toISOString(),
          boundary: {
            profile: {
              key: row.boundary_profile_key,
              version: row.boundary_profile_version,
              digestSha256: row.boundary_profile_digest_sha256
            },
            eventTimezone: row.event_timezone,
            eventVersion: row.event_version,
            localBoundaryDate: row.local_boundary_date
          }
        })
      : parseDeadlineHead({
          ...common,
          status: 'cleared', displayDate: null, effectiveAt: null, boundary: null
        });
  } catch (error) {
    throw new SQLiteDeadlineError('data_corrupt', error);
  }
}

function persistedHead(head: DeadlineHeadDto): readonly [
  string, string, string, string, string, number, string, string,
  string | null, number | null, string | null, number | null, string | null,
  string | null, number | null, string | null, string, number, string, number
] {
  return [
    head.scope.workspaceId, head.scope.eventId, head.id, head.kind, head.status,
    head.version, head.digestSha256, head.gracePolicy, head.displayDate,
    head.effectiveAt === null ? null : Date.parse(head.effectiveAt),
    head.boundary?.profile.key ?? null,
    head.boundary?.profile.version ?? null,
    head.boundary?.profile.digestSha256 ?? null,
    head.boundary?.eventTimezone ?? null,
    head.boundary?.eventVersion ?? null,
    head.boundary?.localBoundaryDate ?? null,
    head.createdByUserId, Date.parse(head.createdAt),
    head.updatedByUserId, Date.parse(head.updatedAt)
  ];
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteDeadlineErrorCode
): void {
  if (result.changes !== 1) throw new SQLiteDeadlineError(code);
}
