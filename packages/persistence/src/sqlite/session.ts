import type { Database } from 'bun:sqlite';
import type { SessionHeadDto, SessionMutationPlanDto, SessionMutationResult, SessionRestorePlanDto } from '@jooevents/contracts/sessions';
import { canonicalJsonText } from '@jooevents/kernel';
import type { SQLiteProgramVocabularyRepository } from './program-vocabulary';
import {
  applySessionMutationPlan,
  applySessionRestorePlan,
  createEmptySessionCatalog,
  parseSessionCatalog,
  parseSessionHead,
  parseSessionScope,
  type SessionCatalog,
  type SessionChangesetTransactionPort,
  type SessionScope
} from '@jooevents/session';

/** Additive schema installed only in an explicitly disposable SQLite runtime. */
export const SESSION_SQL = `
CREATE TABLE session_catalogs (
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

CREATE TABLE sessions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300 AND title = trim(title)),
  planned_duration_minutes INTEGER NOT NULL CHECK(
    planned_duration_minutes BETWEEN 5 AND 1440 AND planned_duration_minutes % 5 = 0
  ),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'collecting', 'programmed')),
  format_id TEXT NOT NULL CHECK(length(format_id) = 36),
  track_id TEXT CHECK(track_id IS NULL OR length(track_id) = 36),
  program_set_version INTEGER NOT NULL CHECK(program_set_version > 0),
  program_set_digest_sha256 TEXT NOT NULL CHECK(
    length(program_set_digest_sha256) = 64 AND program_set_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  roster_version INTEGER NOT NULL CHECK(roster_version > 0),
  roster_digest_sha256 TEXT NOT NULL CHECK(
    length(roster_digest_sha256) = 64 AND roster_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  roster_json TEXT NOT NULL CHECK(json_valid(roster_json)),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  version INTEGER NOT NULL CHECK(version > 0),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (id),
  CHECK(json_extract(head_json, '$.id') = id),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(json_extract(head_json, '$.digestSha256') = digest_sha256),
  CHECK(json_extract(head_json, '$.lifecycle') = lifecycle),
  CHECK(json_extract(head_json, '$.programTarget.format.id') = format_id),
  CHECK(json_extract(head_json, '$.programTarget.track.id') IS track_id),
  CHECK(json_extract(head_json, '$.roster.version') = roster_version),
  CHECK(json_extract(head_json, '$.roster.digestSha256') = roster_digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES session_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, format_id)
    REFERENCES program_vocabulary_formats(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, track_id)
    REFERENCES program_vocabulary_tracks(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX sessions_lifecycle_title
  ON sessions(workspace_id, event_id, lifecycle, title, id);
CREATE INDEX sessions_format
  ON sessions(workspace_id, event_id, format_id, id);
CREATE INDEX sessions_track
  ON sessions(workspace_id, event_id, track_id, id);

CREATE TRIGGER sessions_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, created_by_user_id, created_at_ms ON sessions
BEGIN
  SELECT RAISE(ABORT, 'session identity is immutable');
END;
`;

export type SQLiteSessionErrorCode =
  | 'transaction_required'
  | 'scope_corrupt'
  | 'data_corrupt'
  | 'stale_catalog'
  | 'stale_session';

export class SQLiteSessionError extends Error {
  constructor(readonly code: SQLiteSessionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteSessionError';
  }
}

interface CatalogRow { readonly version: number; readonly digest_sha256: string }
interface HeadRow { readonly head_json: string }
interface ScopeRow { readonly event_id: string }

export function installSessionSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteSessionError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SESSION_SQL);
}

export class SQLiteSessionRepository implements SessionChangesetTransactionPort {
  constructor(
    private readonly sqlite: Database,
    private readonly vocabulary: Pick<SQLiteProgramVocabularyRepository, 'readVocabulary'>
  ) {}

  readSessionCatalog(scopeInput: SessionScope): SessionCatalog | undefined {
    const scope = parseSessionScope(scopeInput);
    if (!this.scopeExists(scope)) return undefined;
    const rows = this.sqlite.query<CatalogRow, [string, string]>(`
      SELECT version, digest_sha256 FROM session_catalogs
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteSessionError('data_corrupt');
    const sessions = this.readHeads(scope);
    if (!rows[0]) {
      if (sessions.length > 0) throw new SQLiteSessionError('data_corrupt');
      return createEmptySessionCatalog(scope);
    }
    try {
      return parseSessionCatalog({
        schemaVersion: 1,
        scope,
        version: rows[0].version,
        digestSha256: rows[0].digest_sha256,
        sessions
      });
    } catch (error) {
      throw new SQLiteSessionError('data_corrupt', error);
    }
  }

  readSessionVocabulary(scope: SessionScope) {
    return this.vocabulary.readVocabulary(parseSessionScope(scope));
  }

  applySessionPlan(plan: SessionMutationPlanDto | SessionRestorePlanDto): SessionMutationResult {
    if (!this.sqlite.inTransaction) throw new SQLiteSessionError('transaction_required');
    const restore = isRestorePlan(plan);
    const scope = parseSessionScope(restore ? plan.scope : plan.input.scope);
    const catalog = this.readSessionCatalog(scope);
    if (!catalog) throw new SQLiteSessionError('scope_corrupt');
    const applied = restore
      ? applySessionRestorePlan({ plan, catalog })
      : (() => {
          const vocabulary = this.readSessionVocabulary(scope);
          if (!vocabulary) throw new SQLiteSessionError('scope_corrupt');
          return applySessionMutationPlan({ plan, catalog, vocabulary });
        })();

    if (catalog.version === 1) {
      changedExactlyOnce(this.sqlite.query<never, [string, string, number, string, string, string, string, string]>(`
        INSERT INTO session_catalogs (workspace_id, event_id, version, digest_sha256)
        SELECT ?, ?, ?, ? FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM session_catalogs WHERE workspace_id = ? AND event_id = ?
           )
      `).run(
        scope.workspaceId, scope.eventId, applied.catalog.version, applied.catalog.digestSha256,
        scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId
      ), 'stale_catalog');
    }

    const before = restore ? plan.expectedCurrent : plan.before;
    const after = restore ? plan.restore : plan.after;
    if (before === null && after) this.insertHead(after);
    else if (before && after) this.updateHead(before, after);
    else if (before && after === null) this.deleteHead(before);
    else throw new SQLiteSessionError('data_corrupt');

    if (catalog.version !== 1) {
      changedExactlyOnce(this.sqlite.query<never, [number, string, string, string, number, string]>(`
        UPDATE session_catalogs SET version = ?, digest_sha256 = ?
         WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?
      `).run(
        applied.catalog.version, applied.catalog.digestSha256,
        scope.workspaceId, scope.eventId, catalog.version, catalog.digestSha256
      ), 'stale_catalog');
    }
    const reread = this.readSessionCatalog(scope);
    if (!reread || canonicalJsonText(reread) !== canonicalJsonText(applied.catalog)) {
      throw new SQLiteSessionError('data_corrupt');
    }
    return applied.result;
  }

  private scopeExists(scope: SessionScope): boolean {
    const rows = this.sqlite.query<ScopeRow, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteSessionError('scope_corrupt');
    return rows.length === 1;
  }

  private readHeads(scope: SessionScope): readonly SessionHeadDto[] {
    const rows = this.sqlite.query<HeadRow, [string, string]>(`
      SELECT head_json FROM sessions
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
    try {
      return rows.map((row) => parseSessionHead(JSON.parse(row.head_json)));
    } catch (error) {
      throw new SQLiteSessionError('data_corrupt', error);
    }
  }

  private insertHead(head: SessionHeadDto): void {
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, string, number, string, string, string | null, number, string,
      number, string, string, string, number, string, string, number, string, number
    ]>(`
      INSERT INTO sessions (
        workspace_id, event_id, id, title, planned_duration_minutes, lifecycle,
        format_id, track_id, program_set_version, program_set_digest_sha256,
        roster_version, roster_digest_sha256, roster_json, head_json, version,
        digest_sha256, created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...persistedHead(head)), 'stale_session');
  }

  private updateHead(before: SessionHeadDto, after: SessionHeadDto): void {
    const values = persistedHead(after);
    changedExactlyOnce(this.sqlite.query<never, [
      string, number, string, string, string | null, number, string, number, string, string,
      string, number, string, string, number, string, string, string, number, string
    ]>(`
      UPDATE sessions
         SET title = ?, planned_duration_minutes = ?, lifecycle = ?, format_id = ?, track_id = ?,
             program_set_version = ?, program_set_digest_sha256 = ?, roster_version = ?,
             roster_digest_sha256 = ?, roster_json = ?, head_json = ?, version = ?,
             digest_sha256 = ?, updated_by_user_id = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ?
         AND version = ? AND digest_sha256 = ?
    `).run(
      values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10],
      values[11], values[12], values[13], values[14], values[15], values[18], values[19],
      before.scope.workspaceId, before.scope.eventId, before.id, before.version, before.digestSha256
    ), 'stale_session');
  }

  private deleteHead(before: SessionHeadDto): void {
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string]>(`
      DELETE FROM sessions
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ? AND digest_sha256 = ?
    `).run(
      before.scope.workspaceId, before.scope.eventId, before.id, before.version, before.digestSha256
    ), 'stale_session');
  }
}

function persistedHead(head: SessionHeadDto): readonly [
  string, string, string, string, number, string, string, string | null, number, string,
  number, string, string, string, number, string, string, number, string, number
] {
  return [
    head.scope.workspaceId, head.scope.eventId, head.id, head.title,
    head.plannedDurationMinutes, head.lifecycle, head.programTarget.format.id,
    head.programTarget.track?.id ?? null, head.programTarget.setVersion,
    head.programTarget.setDigestSha256, head.roster.version, head.roster.digestSha256,
    canonicalJsonText(head.roster), canonicalJsonText(head), head.version, head.digestSha256,
    head.createdByUserId, Date.parse(head.createdAt), head.updatedByUserId, Date.parse(head.updatedAt)
  ];
}

function changedExactlyOnce(result: { readonly changes: number }, code: SQLiteSessionErrorCode): void {
  if (result.changes !== 1) throw new SQLiteSessionError(code);
}

function isRestorePlan(
  plan: SessionMutationPlanDto | SessionRestorePlanDto
): plan is SessionRestorePlanDto {
  return 'action' in plan && plan.action === 'restore';
}
