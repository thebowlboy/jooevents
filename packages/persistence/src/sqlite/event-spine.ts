import { Database } from 'bun:sqlite';
import {
  applyEventCreatePlan,
  applyEventSelectPlan,
  eventCreatePlanDigest,
  eventCreateResult,
  eventSelectResult,
  parseEventCreatePlan,
  parseEventSelectPlan,
  parseEventState,
  parseWorkspaceEventSetState,
  projectCurrentEvent,
  projectEventList,
  validateEventCreatePlan,
  validateEventSelectPlan,
  type Event,
  type EventCreatePlan,
  type EventSelectPlan,
  type WorkspaceEventSet
} from '@jooevents/event';
import {
  parseEventId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { CurrentEventProjection, EventListProjection } from '@jooevents/contracts';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const EVENT_SPINE_SQL = `
CREATE TABLE event_spine_workspace_sets (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  current_event_id TEXT CHECK(current_event_id IS NULL OR length(current_event_id) = 36),
  UNIQUE (workspace_id, current_event_id),
  FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, current_event_id)
    REFERENCES event_spine_heads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 255 AND timezone = trim(timezone)),
  start_date TEXT NOT NULL CHECK(
    length(start_date) = 10
    AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(start_date, '+0 days') = start_date
  ),
  end_date TEXT NOT NULL CHECK(
    length(end_date) = 10
    AND end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(end_date, '+0 days') = end_date
    AND end_date >= start_date
  ),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  create_plan_digest_sha256 TEXT NOT NULL CHECK(
    length(create_plan_digest_sha256) = 64
    AND create_plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, id, create_plan_digest_sha256),
  FOREIGN KEY (workspace_id)
    REFERENCES event_spine_workspace_sets(workspace_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_scope_roots (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_heads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_spine_scope_roots_no_update
BEFORE UPDATE ON event_spine_scope_roots
BEGIN
  SELECT RAISE(ABORT, 'event scope root links are immutable');
END;

CREATE TRIGGER event_spine_scope_roots_no_delete
BEFORE DELETE ON event_spine_scope_roots
BEGIN
  SELECT RAISE(ABORT, 'event scope root links are immutable');
END;

`;

export type SQLiteEventSpineErrorCode =
  | 'transaction_required'
  | 'workspace_event_set_missing'
  | 'event_set_data_corrupt'
  | 'event_head_data_corrupt'
  | 'current_event_missing'
  | 'stale_event_set';

export class SQLiteEventSpineError extends TypeError {
  readonly code: SQLiteEventSpineErrorCode;

  constructor(code: SQLiteEventSpineErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteEventSpineError';
    this.code = code;
  }
}

interface EventSetRow {
  readonly workspace_id: string;
  readonly version: number;
  readonly current_event_id: string | null;
}

interface EventHeadRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly version: number;
  readonly created_by_user_id: string;
  readonly created_at_ms: number;
  readonly create_plan_digest_sha256: string;
}

export interface CurrentEventState {
  readonly eventSet: WorkspaceEventSet;
  readonly currentEvent: Event | undefined;
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteEventSpineError('transaction_required');
}

function oneOrNone<Row>(rows: readonly Row[], corruptCode: SQLiteEventSpineErrorCode): Row | undefined {
  if (rows.length > 1) throw new SQLiteEventSpineError(corruptCode);
  return rows[0];
}

function eventSetFromRow(row: EventSetRow): WorkspaceEventSet {
  try {
    return parseWorkspaceEventSetState({
      workspaceId: row.workspace_id,
      version: row.version,
      currentEventId: row.current_event_id
    });
  } catch (error) {
    throw new SQLiteEventSpineError('event_set_data_corrupt', error);
  }
}

function eventFromRow(row: EventHeadRow): Event {
  try {
    const createdAt = new Date(row.created_at_ms).toISOString();
    return parseEventState({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      timezone: row.timezone,
      startDate: row.start_date,
      endDate: row.end_date,
      version: row.version,
      createdByUserId: row.created_by_user_id,
      createdAt
    });
  } catch (error) {
    throw new SQLiteEventSpineError('event_head_data_corrupt', error);
  }
}

function changedExactlyOnce(result: { readonly changes: number }): void {
  if (result.changes !== 1) throw new SQLiteEventSpineError('stale_event_set');
}

export function installEventSpineSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteEventSpineError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(EVENT_SPINE_SQL);
}

export class SQLiteEventSpineRepository {
  constructor(private readonly sqlite: Database) {}

  readEventSet(workspaceIdInput: string): WorkspaceEventSet | undefined {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    const row = oneOrNone(this.sqlite.query<EventSetRow, [WorkspaceId]>(`
      SELECT workspace_id, version, current_event_id
        FROM event_spine_workspace_sets
       WHERE workspace_id = ?
       ORDER BY workspace_id
       LIMIT 2
    `).all(workspaceId), 'event_set_data_corrupt');
    return row ? eventSetFromRow(row) : undefined;
  }

  requireEventSet(workspaceId: string): WorkspaceEventSet {
    const eventSet = this.readEventSet(workspaceId);
    if (!eventSet) throw new SQLiteEventSpineError('workspace_event_set_missing');
    return eventSet;
  }

  readEventHead(input: { readonly workspaceId: string; readonly eventId: string }): Event | undefined {
    const workspaceId = parseWorkspaceId(input.workspaceId);
    const eventId = parseEventId(input.eventId);
    const row = oneOrNone(this.sqlite.query<EventHeadRow, [WorkspaceId, EventId]>(`
      SELECT h.workspace_id, h.id, h.name, h.timezone, h.start_date, h.end_date,
             h.version, h.created_by_user_id, h.created_at_ms,
             h.create_plan_digest_sha256
        FROM event_spine_heads h
        JOIN event_spine_scope_roots o
          ON o.workspace_id = h.workspace_id AND o.event_id = h.id
       WHERE h.workspace_id = ? AND h.id = ?
       ORDER BY h.workspace_id, h.id
       LIMIT 2
    `).all(workspaceId, eventId), 'event_head_data_corrupt');
    return row ? eventFromRow(row) : undefined;
  }

  readEvent(workspaceId: string, eventId: string): Event | undefined {
    return this.readEventHead({ workspaceId, eventId });
  }

  readEventHeads(workspaceIdInput: string): readonly Event[] {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    return Object.freeze(this.sqlite.query<EventHeadRow, [WorkspaceId]>(`
      SELECT h.workspace_id, h.id, h.name, h.timezone, h.start_date, h.end_date,
             h.version, h.created_by_user_id, h.created_at_ms,
             h.create_plan_digest_sha256
        FROM event_spine_heads h
       WHERE h.workspace_id = ?
       ORDER BY h.start_date DESC, h.name, h.id
    `).all(workspaceId).map(eventFromRow));
  }

  readCurrentEventState(workspaceIdInput: string): CurrentEventState | undefined {
    const eventSet = this.readEventSet(workspaceIdInput);
    if (!eventSet) return undefined;
    if (eventSet.currentEventId === null) {
      return Object.freeze({ eventSet, currentEvent: undefined });
    }
    const currentEvent = this.readEventHead({
      workspaceId: eventSet.workspaceId,
      eventId: eventSet.currentEventId
    });
    if (!currentEvent) throw new SQLiteEventSpineError('current_event_missing');
    return Object.freeze({ eventSet, currentEvent });
  }

  readCurrentEventProjection(workspaceId: string): CurrentEventProjection | undefined {
    const current = this.readCurrentEventState(workspaceId);
    return current ? projectCurrentEvent(current.eventSet, current.currentEvent) : undefined;
  }

  readEventListProjection(workspaceId: string): EventListProjection | undefined {
    const eventSet = this.readEventSet(workspaceId);
    return eventSet
      ? projectEventList(eventSet, this.readEventHeads(eventSet.workspaceId))
      : undefined;
  }

  bootstrapWorkspaceEventSet(workspaceIdInput: string): WorkspaceEventSet {
    requireTransaction(this.sqlite);
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    this.sqlite.query<never, [WorkspaceId]>(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
      ON CONFLICT(workspace_id) DO NOTHING
    `).run(workspaceId);
    return this.requireEventSet(workspaceId);
  }

  commitEventCreatePlan(plan: EventCreatePlan): CurrentEventState {
    requireTransaction(this.sqlite);
    let canonicalPlan: EventCreatePlan;
    try {
      canonicalPlan = parseEventCreatePlan(plan);
    } catch (error) {
      throw new SQLiteEventSpineError('event_head_data_corrupt', error);
    }
    const currentSet = this.requireEventSet(canonicalPlan.workspaceId);
    const issue = validateEventCreatePlan(currentSet, canonicalPlan);
    if (issue) throw new SQLiteEventSpineError(
      issue === 'stale_event_set' || issue === 'event_already_selected'
        ? 'stale_event_set'
        : 'event_head_data_corrupt'
    );
    const applied = applyEventCreatePlan(currentSet, canonicalPlan);
    const createdAtMs = Date.parse(applied.event.createdAt);
    this.sqlite.query<never, [string, string, string, string, string, string, number, string, number, string]>(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date,
        version, created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      applied.event.workspaceId,
      applied.event.id,
      applied.event.name,
      applied.event.timezone,
      applied.event.startDate,
      applied.event.endDate,
      applied.event.version,
      applied.event.createdByUserId,
      createdAtMs,
      eventCreatePlanDigest(canonicalPlan)
    );
    this.sqlite.query<never, [string, string]>(`
      INSERT INTO event_spine_scope_roots (
        workspace_id, event_id
      ) VALUES (?, ?)
    `).run(
      applied.event.workspaceId,
      applied.event.id
    );
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, number, string | null]>(`
      UPDATE event_spine_workspace_sets
         SET version = ?, current_event_id = ?
       WHERE workspace_id = ? AND version = ? AND current_event_id IS ?
    `).run(
      applied.eventSet.version,
      applied.event.id,
      applied.eventSet.workspaceId,
      currentSet.version,
      currentSet.currentEventId
    ));
    return Object.freeze({
      eventSet: applied.eventSet,
      currentEvent: applied.event
    });
  }

  applyEventCreatePlan(plan: EventCreatePlan) {
    const committed = this.commitEventCreatePlan(plan);
    return eventCreateResult(plan);
  }

  commitEventSelectPlan(plan: EventSelectPlan): CurrentEventState {
    requireTransaction(this.sqlite);
    let canonicalPlan: EventSelectPlan;
    try {
      canonicalPlan = parseEventSelectPlan(plan);
    } catch (error) {
      throw new SQLiteEventSpineError('event_head_data_corrupt', error);
    }
    const currentSet = this.requireEventSet(canonicalPlan.workspaceId);
    const targetEvent = this.readEventHead({
      workspaceId: canonicalPlan.workspaceId,
      eventId: canonicalPlan.selected.id
    });
    const issue = validateEventSelectPlan(currentSet, targetEvent, canonicalPlan);
    if (issue) throw new SQLiteEventSpineError(
      issue === 'stale_event_set' || issue === 'event_already_selected'
        ? 'stale_event_set'
        : issue === 'event_missing'
          ? 'current_event_missing'
          : 'event_head_data_corrupt'
    );
    const eventSet = applyEventSelectPlan(currentSet, targetEvent, canonicalPlan);
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, number, string | null]>(`
      UPDATE event_spine_workspace_sets
         SET version = ?, current_event_id = ?
       WHERE workspace_id = ? AND version = ? AND current_event_id IS ?
    `).run(
      eventSet.version,
      canonicalPlan.selected.id,
      eventSet.workspaceId,
      currentSet.version,
      currentSet.currentEventId
    ));
    return Object.freeze({ eventSet, currentEvent: canonicalPlan.selected });
  }

  applyEventSelectPlan(plan: EventSelectPlan) {
    this.commitEventSelectPlan(plan);
    return eventSelectResult(plan);
  }

}

/** Revalidates a spine-owned Event root using the authority transaction's own handle. */
export function createSQLiteEventSpineOperatorEventRelationshipSource(): SQLiteOperatorEventRelationshipSource {
  return Object.freeze({
    validateEvent(input: Parameters<SQLiteOperatorEventRelationshipSource['validateEvent']>[0]) {
      const repository = new SQLiteEventSpineRepository(input.sqlite);
      const event = repository.readEventHead({
        workspaceId: input.workspaceId,
        eventId: input.eventId
      });
      if (!event) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      return Object.freeze({
        kind: 'valid' as const,
        evidenceIds: Object.freeze([
          `event-spine-root:${event.id}@${event.version}`,
          `event-spine-set:${event.workspaceId}`
        ])
      });
    }
  });
}
