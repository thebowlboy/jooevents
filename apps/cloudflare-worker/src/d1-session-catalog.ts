import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import {
  createEmptySessionCatalog,
  parseSessionCatalog,
  parseSessionHead,
  type SessionCatalog
} from '@jooevents/session';

const MAX_SESSIONS = 5_000;

interface EventRootRow { readonly event_id: unknown }
interface CatalogRow {
  readonly version: unknown;
  readonly digest_sha256: unknown;
}
interface SessionRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly planned_duration_minutes: unknown;
  readonly lifecycle: unknown;
  readonly format_id: unknown;
  readonly track_id: unknown;
  readonly program_set_version: unknown;
  readonly program_set_digest_sha256: unknown;
  readonly roster_version: unknown;
  readonly roster_digest_sha256: unknown;
  readonly roster_json: unknown;
  readonly head_json: unknown;
  readonly version: unknown;
  readonly digest_sha256: unknown;
  readonly created_by_user_id: unknown;
  readonly created_at_ms: unknown;
  readonly updated_by_user_id: unknown;
  readonly updated_at_ms: unknown;
}

export class D1SessionCatalogReadError extends Error {
  readonly name = 'D1SessionCatalogReadError';

  constructor(readonly code: 'wrong_scope' | 'data_corrupt' | 'row_limit_exceeded') {
    super(code);
  }
}

function oneOrNone<Row>(result: D1Result<Row>): Row | undefined {
  if (result.results.length > 1) throw new D1SessionCatalogReadError('data_corrupt');
  return result.results[0];
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new D1SessionCatalogReadError('data_corrupt');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new D1SessionCatalogReadError('data_corrupt');
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new D1SessionCatalogReadError('data_corrupt');
  }
  return value;
}

function headFromRow(row: SessionRow) {
  const head = parseSessionHead(JSON.parse(text(row.head_json)));
  if (text(row.id) !== head.id
      || text(row.title) !== head.title
      || positiveInteger(row.planned_duration_minutes) !== head.plannedDurationMinutes
      || text(row.lifecycle) !== head.lifecycle
      || text(row.format_id) !== head.programTarget.format.id
      || nullableText(row.track_id) !== (head.programTarget.track?.id ?? null)
      || positiveInteger(row.program_set_version) !== head.programTarget.setVersion
      || text(row.program_set_digest_sha256) !== head.programTarget.setDigestSha256
      || positiveInteger(row.roster_version) !== head.roster.version
      || text(row.roster_digest_sha256) !== head.roster.digestSha256
      || text(row.roster_json) !== canonicalJsonText(head.roster)
      || positiveInteger(row.version) !== head.version
      || text(row.digest_sha256) !== head.digestSha256
      || text(row.created_by_user_id) !== head.createdByUserId
      || nonnegativeInteger(row.created_at_ms) !== Date.parse(head.createdAt)
      || text(row.updated_by_user_id) !== head.updatedByUserId
      || nonnegativeInteger(row.updated_at_ms) !== Date.parse(head.updatedAt)) {
    throw new D1SessionCatalogReadError('data_corrupt');
  }
  return head;
}

/** Reads the canonical current-Event Session catalog through one primary D1 session. */
export function createD1SessionCatalogReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: string;
}): { readSessionCatalog(scope: {
  readonly workspaceId: string;
  readonly eventId: string;
}): Promise<SessionCatalog | undefined> } {
  const configuredWorkspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readSessionCatalog(scopeInput) {
      const workspaceId = parseWorkspaceId(scopeInput.workspaceId);
      const eventId = parseEventId(scopeInput.eventId);
      if (workspaceId !== configuredWorkspaceId) {
        throw new D1SessionCatalogReadError('wrong_scope');
      }
      const session = input.database.withSession('first-primary');
      const [rootResult, catalogResult, sessionResult] = await session.batch([
        session.prepare(`SELECT event_id FROM event_spine_scope_roots
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY workspace_id,event_id LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`SELECT version,digest_sha256 FROM session_catalogs
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY workspace_id,event_id LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`SELECT id,title,planned_duration_minutes,lifecycle,format_id,
          track_id,program_set_version,program_set_digest_sha256,roster_version,
          roster_digest_sha256,roster_json,head_json,version,digest_sha256,
          created_by_user_id,created_at_ms,updated_by_user_id,updated_at_ms FROM sessions
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY id COLLATE BINARY LIMIT ?`).bind(workspaceId, eventId, MAX_SESSIONS + 1)
      ]);
      const root = oneOrNone(rootResult as D1Result<EventRootRow>);
      if (!root) return undefined;
      if (root.event_id !== eventId) throw new D1SessionCatalogReadError('data_corrupt');
      const catalog = oneOrNone(catalogResult as D1Result<CatalogRow>);
      const rows = (sessionResult as D1Result<SessionRow>).results;
      if (rows.length > MAX_SESSIONS) {
        throw new D1SessionCatalogReadError('row_limit_exceeded');
      }
      if (!catalog) {
        if (rows.length > 0) throw new D1SessionCatalogReadError('data_corrupt');
        return createEmptySessionCatalog({ workspaceId, eventId });
      }
      try {
        return parseSessionCatalog({
          schemaVersion: 1,
          scope: { workspaceId, eventId },
          version: positiveInteger(catalog.version),
          digestSha256: text(catalog.digest_sha256),
          sessions: rows.map(headFromRow)
        });
      } catch (cause) {
        if (cause instanceof D1SessionCatalogReadError) throw cause;
        throw new D1SessionCatalogReadError('data_corrupt');
      }
    }
  });
}
