import type { Database } from 'bun:sqlite';
import type { SessionHeadDto, SessionMutationPlanDto, SessionMutationResult, SessionRemoveNewPlanDto, SessionRestorePlanDto } from '@jooevents/contracts/sessions';
import { canonicalJsonSha256, canonicalJsonText, parseAggregateVersion, parseInstant, parseUserId } from '@jooevents/kernel';
import {
  ProgramVocabularyPlanningError,
  programVocabularySetDigest,
  resolveProgramVocabularyItem,
  type ProgramReferenceContributionPlan,
  type ProgramReferenceContributorSnapshot,
  type ProgramVocabularyState
} from '@jooevents/program';
import type {
  ProgramVocabularyMutationAttribution,
  SQLiteProgramVocabularyContributorAdapter,
  SQLiteProgramVocabularyContributorResolution,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import {
  applySessionMutationPlan,
  applyNewSessionRemovalPlan,
  applySessionRestorePlan,
  createEmptySessionCatalog,
  parseSessionCatalog,
  parseSessionHead,
  parseSessionScope,
  sessionCatalogDigest,
  sessionHeadDigest,
  type SessionCatalog,
  type SessionGraduationReadPort,
  type SessionTransactionPort,
  type SessionScope
} from '@jooevents/session';

export const SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR = Object.freeze({
  key: 'sessions.program-targets',
  version: 1
});

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
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

/** Additive sequence-8 Session reference lineage, also installed by isolated fixtures. */
export const SESSION_PROGRAM_REFERENCE_SQL = `CREATE TABLE session_program_reference_slots (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  slot_kind TEXT NOT NULL CHECK(slot_kind IN ('format', 'track')),
  item_id TEXT NOT NULL CHECK(length(item_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, session_id, slot_kind),
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX session_program_reference_slots_item
  ON session_program_reference_slots(workspace_id, event_id, slot_kind, item_id, session_id);

INSERT INTO session_program_reference_slots
  (workspace_id, event_id, session_id, slot_kind, item_id, version)
SELECT workspace_id, event_id, id, 'format', format_id, 1
  FROM sessions
 ORDER BY workspace_id, event_id, id;

INSERT INTO session_program_reference_slots
  (workspace_id, event_id, session_id, slot_kind, item_id, version)
SELECT workspace_id, event_id, id, 'track', track_id, 1
  FROM sessions
 WHERE track_id IS NOT NULL
 ORDER BY workspace_id, event_id, id;

CREATE TRIGGER session_program_reference_slots_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, session_id, slot_kind
  ON session_program_reference_slots
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot identity is immutable');
END;

CREATE TRIGGER session_program_reference_slots_version_monotonic
BEFORE UPDATE ON session_program_reference_slots
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot versions advance by one');
END;

CREATE TRIGGER session_program_reference_slots_insert_matches_head
BEFORE INSERT ON session_program_reference_slots
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.workspace_id = NEW.workspace_id AND s.event_id = NEW.event_id
     AND s.id = NEW.session_id
     AND ((NEW.slot_kind = 'format' AND s.format_id = NEW.item_id)
       OR (NEW.slot_kind = 'track' AND s.track_id = NEW.item_id))
)
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot must match its head');
END;

CREATE TRIGGER session_program_reference_slots_update_matches_head
BEFORE UPDATE OF item_id ON session_program_reference_slots
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.workspace_id = NEW.workspace_id AND s.event_id = NEW.event_id
     AND s.id = NEW.session_id
     AND ((NEW.slot_kind = 'format' AND s.format_id = NEW.item_id)
       OR (NEW.slot_kind = 'track' AND s.track_id = NEW.item_id))
)
BEGIN
  SELECT RAISE(ABORT, 'session program reference slot must match its head');
END;

CREATE TRIGGER session_program_reference_slots_delete_follows_head
BEFORE DELETE ON session_program_reference_slots
WHEN EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.workspace_id = OLD.workspace_id AND s.event_id = OLD.event_id
     AND s.id = OLD.session_id
     AND ((OLD.slot_kind = 'format' AND s.format_id = OLD.item_id)
       OR (OLD.slot_kind = 'track' AND s.track_id = OLD.item_id))
)
BEGIN
  SELECT RAISE(ABORT, 'current session program reference slot cannot be deleted');
END;

CREATE TRIGGER sessions_program_reference_slots_after_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_program_reference_slots
    (workspace_id, event_id, session_id, slot_kind, item_id, version)
  VALUES (NEW.workspace_id, NEW.event_id, NEW.id, 'format', NEW.format_id, 1);
  INSERT INTO session_program_reference_slots
    (workspace_id, event_id, session_id, slot_kind, item_id, version)
  SELECT NEW.workspace_id, NEW.event_id, NEW.id, 'track', NEW.track_id, 1
   WHERE NEW.track_id IS NOT NULL;
END;

CREATE TRIGGER sessions_program_reference_format_after_update
AFTER UPDATE OF format_id ON sessions
WHEN NEW.format_id <> OLD.format_id
BEGIN
  UPDATE session_program_reference_slots
     SET item_id = NEW.format_id, version = version + 1
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND session_id = NEW.id AND slot_kind = 'format' AND item_id = OLD.format_id;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'session format reference slot is corrupt') END;
END;

CREATE TRIGGER sessions_program_reference_track_after_update
AFTER UPDATE OF track_id ON sessions
WHEN NEW.track_id IS NOT OLD.track_id
BEGIN
  DELETE FROM session_program_reference_slots
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND session_id = NEW.id AND slot_kind = 'track' AND NEW.track_id IS NULL;
  SELECT CASE WHEN NEW.track_id IS NULL AND changes() <> 1
    THEN RAISE(ABORT, 'session track reference slot is corrupt') END;
  UPDATE session_program_reference_slots
     SET item_id = NEW.track_id, version = version + 1
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id
     AND session_id = NEW.id AND slot_kind = 'track'
     AND OLD.track_id IS NOT NULL AND NEW.track_id IS NOT NULL;
  SELECT CASE WHEN OLD.track_id IS NOT NULL AND NEW.track_id IS NOT NULL AND changes() <> 1
    THEN RAISE(ABORT, 'session track reference slot is corrupt') END;
  INSERT INTO session_program_reference_slots
    (workspace_id, event_id, session_id, slot_kind, item_id, version)
  SELECT NEW.workspace_id, NEW.event_id, NEW.id, 'track', NEW.track_id, 1
   WHERE OLD.track_id IS NULL AND NEW.track_id IS NOT NULL;
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
interface CountRow { readonly count: number }
interface HeadRow { readonly head_json: string }
interface ScopeRow { readonly event_id: string }

export function installSessionSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteSessionError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SESSION_SQL);
  sqlite.exec(SESSION_PROGRAM_REFERENCE_SQL);
}

export class SQLiteSessionRepository implements SessionTransactionPort, SessionGraduationReadPort {
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

  countSessionSchedulePlacements(scopeInput: SessionScope, sessionId: string): number {
    const scope = parseSessionScope(scopeInput);
    const row = this.sqlite.query<CountRow, [string, string, string]>(`
      SELECT count(*) AS count FROM schedule_occurrences
       WHERE workspace_id = ? AND event_id = ? AND session_id = ?
    `).get(scope.workspaceId, scope.eventId, sessionId);
    return row?.count ?? 0;
  }

  countSessionCanonicalReferences(scopeInput: SessionScope, sessionId: string): number {
    const scope = parseSessionScope(scopeInput);
    return ['submission_session_origins', 'engagement_heads'].reduce((total, table) => {
      const installed = this.sqlite.query<CountRow, [string]>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table)?.count ?? 0;
      if (installed === 0) return total;
      const row = this.sqlite.query<CountRow, [string, string, string]>(
        `SELECT count(*) AS count FROM ${table} WHERE workspace_id = ? AND event_id = ? AND session_id = ?`
      ).get(scope.workspaceId, scope.eventId, sessionId);
      return total + (row?.count ?? 0);
    }, 0);
  }

  applySessionPlan(plan: SessionMutationPlanDto | SessionRestorePlanDto | SessionRemoveNewPlanDto): SessionMutationResult {
    if (!this.sqlite.inTransaction) throw new SQLiteSessionError('transaction_required');
    const directRemoval = isRemoveNewPlan(plan);
    const restore = isRestorePlan(plan);
    const scope = parseSessionScope((restore || directRemoval) ? plan.scope : plan.input.scope);
    const catalog = this.readSessionCatalog(scope);
    if (!catalog) throw new SQLiteSessionError('scope_corrupt');
    const applied = directRemoval
      ? applyNewSessionRemovalPlan({ plan, catalog })
      : restore
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

    const before = (restore || directRemoval) ? plan.expectedCurrent : plan.before;
    const after = directRemoval ? null : restore ? plan.restore : plan.after;
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

interface ProgramReferenceSlotRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly session_id: string;
  readonly slot_kind: 'format' | 'track';
  readonly item_id: string;
  readonly version: number;
}

/** Adapts current Session format/track slots into the complete Program Vocabulary registry. */
export function createSQLiteSessionProgramReferenceAdapter(input: {
  readonly sqlite: Database;
}): SQLiteProgramVocabularyContributorAdapter {
  return Object.freeze({
    contributor: SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR,
    read(readInput: Parameters<SQLiteProgramVocabularyContributorAdapter['read']>[0]):
    SQLiteProgramVocabularyContributorResolution {
      const { sqlite, scope } = readInput;
      if (sqlite !== input.sqlite) throw new SQLiteSessionError('data_corrupt');
      return readSessionProgramReferenceSnapshot(sqlite, scope);
    },
    applyRepoints(applyInput: Parameters<SQLiteProgramVocabularyContributorAdapter['applyRepoints']>[0]): void {
      const { sqlite, scope, contribution, attribution, beforeVocabulary, afterVocabulary } = applyInput;
      if (sqlite !== input.sqlite || !sqlite.inTransaction) {
        throw new SQLiteSessionError(sqlite.inTransaction ? 'data_corrupt' : 'transaction_required');
      }
      const sessionScope = parseSessionScope(scope);
      if (beforeVocabulary.scope.workspaceId !== sessionScope.workspaceId
          || beforeVocabulary.scope.eventId !== sessionScope.eventId
          || afterVocabulary.scope.workspaceId !== sessionScope.workspaceId
          || afterVocabulary.scope.eventId !== sessionScope.eventId
          || afterVocabulary.setVersion !== beforeVocabulary.setVersion + 1
          || contribution.contributor.key !== SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR.key
          || contribution.contributor.version !== SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR.version
          || contribution.historicalPins.length !== 0) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      const current = readSessionProgramReferenceSnapshot(sqlite, beforeVocabulary.scope);
      if (current.kind !== 'available') throw new ProgramVocabularyPlanningError('stale_reference');
      const snapshot = current.snapshot as ProgramReferenceContributorSnapshot;
      if (snapshot.guard.id !== contribution.guard.id
          || snapshot.guard.version !== contribution.guard.version
          || snapshot.guard.digest !== contribution.guard.digest) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      if (contribution.liveRepoints.length === 0) return;

      const catalog = readValidatedSessionCatalog(sqlite, sessionScope);
      if (!catalog || catalog.version !== contribution.guard.version) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      const references = new Map(snapshot.references.map((reference) => [reference.referenceKey, reference]));
      const repointsBySession = new Map<string, ProgramReferenceContributionPlan['liveRepoints'][number]>();
      for (const repoint of contribution.liveRepoints) {
        const currentReference = references.get(repoint.referenceKey);
        const [sessionId, slotKind] = parseSessionReferenceDestination(repoint.destination.id);
        if (!currentReference || currentReference.mode !== 'current'
            || currentReference.version !== repoint.expectedVersion
            || currentReference.item.kind !== repoint.from.kind
            || currentReference.item.id !== repoint.from.id
            || repoint.to.kind !== repoint.from.kind
            || (repoint.to.kind !== 'format' && repoint.to.kind !== 'track')
            || currentReference.destination.kind !== 'session.head'
            || currentReference.destination.id !== repoint.destination.id
            || slotKind !== repoint.from.kind
            || repointsBySession.has(sessionId)) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        repointsBySession.set(sessionId, repoint);
      }

      const actorUserId = parseUserId(attribution.actorUserId);
      const occurredAt = parseInstant(attribution.occurredAt);
      const occurredAtMs = Date.parse(occurredAt);
      const nextHeads = catalog.sessions.map((head) => {
        const repoint = repointsBySession.get(head.id);
        if (!repoint) return head;
        repointsBySession.delete(head.id);
        const currentId = repoint.from.kind === 'format'
          ? head.programTarget.format.id
          : head.programTarget.track?.id;
        if (currentId !== repoint.from.id) throw new ProgramVocabularyPlanningError('stale_reference');
        const target = resolveSessionProgramTarget(
          afterVocabulary,
          repoint.from.kind === 'format' ? repoint.to.id : head.programTarget.format.id,
          repoint.from.kind === 'track' ? repoint.to.id : head.programTarget.track?.id ?? null
        );
        const { digestSha256: _digest, ...unsignedBefore } = head;
        const unsigned = {
          ...unsignedBefore,
          programTarget: target,
          version: head.version + 1,
          updatedByUserId: actorUserId,
          updatedAt: occurredAt
        };
        const after = parseSessionHead({ ...unsigned, digestSha256: sessionHeadDigest(unsigned) });
        updateRepointedSessionHead(sqlite, head, after);
        return after;
      });
      if (repointsBySession.size !== 0) throw new ProgramVocabularyPlanningError('stale_reference');
      const unsignedCatalog = {
        schemaVersion: 1 as const,
        scope: catalog.scope,
        version: catalog.version + 1,
        sessions: nextHeads
      };
      const nextCatalog = parseSessionCatalog({
        ...unsignedCatalog,
        digestSha256: sessionCatalogDigest(unsignedCatalog)
      });
      changedExactlyOnce(sqlite.query<never, [number, string, string, string, number, string]>(`
        UPDATE session_catalogs SET version = ?, digest_sha256 = ?
         WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?
      `).run(
        nextCatalog.version,
        nextCatalog.digestSha256,
        sessionScope.workspaceId,
        sessionScope.eventId,
        catalog.version,
        catalog.digestSha256
      ), 'stale_catalog');
    }
  });
}

function readSessionProgramReferenceSnapshot(
  sqlite: Database,
  scopeInput: ProgramVocabularyState['scope']
): SQLiteProgramVocabularyContributorResolution {
  const scope = parseSessionScope(scopeInput);
  const rootCount = sqlite.query<CountRow, [string, string]>(`
    SELECT count(*) AS count FROM event_spine_scope_roots
     WHERE workspace_id = ? AND event_id = ?
  `).get(scope.workspaceId, scope.eventId)?.count ?? 0;
  if (rootCount === 0) return { kind: 'missing' };
  if (rootCount !== 1) throw new SQLiteSessionError('scope_corrupt');
  const catalog = readValidatedSessionCatalog(sqlite, scope);
  if (!catalog) throw new SQLiteSessionError('data_corrupt');
  const slots = sqlite.query<ProgramReferenceSlotRow, [string, string]>(`
    SELECT workspace_id,event_id,session_id,slot_kind,item_id,version
      FROM session_program_reference_slots
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY session_id COLLATE BINARY,slot_kind COLLATE BINARY
  `).all(scope.workspaceId, scope.eventId);
  const expected = new Map<string, { readonly itemId: string; readonly kind: 'format' | 'track' }>();
  for (const head of catalog.sessions) {
    expected.set(sessionReferenceKey(head.id, 'format'), {
      itemId: head.programTarget.format.id,
      kind: 'format'
    });
    if (head.programTarget.track) {
      expected.set(sessionReferenceKey(head.id, 'track'), {
        itemId: head.programTarget.track.id,
        kind: 'track'
      });
    }
  }
  const references = slots.map((slot) => {
    const key = sessionReferenceKey(slot.session_id, slot.slot_kind);
    const expectedSlot = expected.get(key);
    if (!expectedSlot || expectedSlot.kind !== slot.slot_kind || expectedSlot.itemId !== slot.item_id
        || slot.workspace_id !== scope.workspaceId || slot.event_id !== scope.eventId) {
      throw new SQLiteSessionError('data_corrupt');
    }
    expected.delete(key);
    return {
      referenceKey: key,
      version: parseAggregateVersion(slot.version),
      item: { kind: slot.slot_kind, id: slot.item_id },
      mode: 'current' as const,
      destination: { kind: 'session.head', id: sessionReferenceDestination(slot.session_id, slot.slot_kind) }
    };
  });
  if (expected.size !== 0) throw new SQLiteSessionError('data_corrupt');
  const guardVersion = parseAggregateVersion(catalog.version);
  const contributor = SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR;
  return {
    kind: 'available',
    snapshot: {
      contributor,
      scope: scopeInput,
      guard: {
        id: 'program_reference:sessions.program-targets',
        version: guardVersion,
        digest: canonicalJsonSha256({ contributor, guardVersion, references })
      },
      references
    } satisfies ProgramReferenceContributorSnapshot
  };
}

function readValidatedSessionCatalog(sqlite: Database, scope: SessionScope): SessionCatalog | undefined {
  const catalogRows = sqlite.query<CatalogRow, [string, string]>(`
    SELECT version,digest_sha256 FROM session_catalogs
     WHERE workspace_id = ? AND event_id = ? LIMIT 2
  `).all(scope.workspaceId, scope.eventId);
  if (catalogRows.length > 1) throw new SQLiteSessionError('data_corrupt');
  const headRows = sqlite.query<HeadRow, [string, string]>(`
    SELECT head_json FROM sessions
     WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY
  `).all(scope.workspaceId, scope.eventId);
  const heads = headRows.map((row) => parseSessionHead(JSON.parse(row.head_json)));
  if (!catalogRows[0]) {
    if (heads.length > 0) throw new SQLiteSessionError('data_corrupt');
    return createEmptySessionCatalog(scope);
  }
  return parseSessionCatalog({
    schemaVersion: 1,
    scope,
    version: catalogRows[0].version,
    digestSha256: catalogRows[0].digest_sha256,
    sessions: heads
  });
}

function resolveSessionProgramTarget(
  vocabulary: ProgramVocabularyState,
  formatId: string,
  trackId: string | null
) {
  const format = resolveProgramVocabularyItem(vocabulary, 'format', formatId);
  const track = trackId === null ? null : resolveProgramVocabularyItem(vocabulary, 'track', trackId);
  if (!format || format.status !== 'active' || (trackId !== null && (!track || track.status !== 'active'))) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  return {
    setVersion: vocabulary.setVersion,
    setDigestSha256: programVocabularySetDigest(vocabulary),
    format: {
      kind: 'format' as const,
      id: format.id,
      name: format.name,
      status: 'active' as const,
      version: format.version
    },
    track: track ? {
      kind: 'track' as const,
      id: track.id,
      name: track.name,
      accent: track.accent,
      status: 'active' as const,
      version: track.version
    } : null
  };
}

function updateRepointedSessionHead(
  sqlite: Database,
  before: SessionHeadDto,
  after: SessionHeadDto
): void {
  changedExactlyOnce(sqlite.query<never, [
    string, string | null, number, string, string, number, string, string, number,
    string, string, string, number, string
  ]>(`
    UPDATE sessions
       SET format_id = ?,track_id = ?,program_set_version = ?,program_set_digest_sha256 = ?,
           head_json = ?,version = ?,digest_sha256 = ?,updated_by_user_id = ?,updated_at_ms = ?
     WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ? AND digest_sha256 = ?
  `).run(
    after.programTarget.format.id,
    after.programTarget.track?.id ?? null,
    after.programTarget.setVersion,
    after.programTarget.setDigestSha256,
    canonicalJsonText(after),
    after.version,
    after.digestSha256,
    after.updatedByUserId,
    Date.parse(after.updatedAt),
    before.scope.workspaceId,
    before.scope.eventId,
    before.id,
    before.version,
    before.digestSha256
  ), 'stale_session');
}

function sessionReferenceKey(sessionId: string, kind: 'format' | 'track'): string {
  return `session:${sessionId}:${kind}`;
}

function sessionReferenceDestination(sessionId: string, kind: 'format' | 'track'): string {
  return `${sessionId}:${kind}`;
}

function parseSessionReferenceDestination(value: string): readonly [string, 'format' | 'track'] {
  const match = /^([0-9a-f-]{36}):(format|track)$/.exec(value);
  if (!match) throw new ProgramVocabularyPlanningError('stale_reference');
  return [match[1]!, match[2] as 'format' | 'track'];
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
  // Bun reports rows changed by owned maintenance triggers in this total. Every
  // caller's predicate is unique, so a positive result still proves the one parent
  // row matched while zero remains the stale guard.
  if (result.changes < 1) throw new SQLiteSessionError(code);
}

function isRestorePlan(
  plan: SessionMutationPlanDto | SessionRestorePlanDto | SessionRemoveNewPlanDto
): plan is SessionRestorePlanDto {
  return 'action' in plan && plan.action === 'restore';
}

function isRemoveNewPlan(
  plan: SessionMutationPlanDto | SessionRestorePlanDto | SessionRemoveNewPlanDto
): plan is SessionRemoveNewPlanDto {
  return 'action' in plan && plan.action === 'remove_new_session';
}
