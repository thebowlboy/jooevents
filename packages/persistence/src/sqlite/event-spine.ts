import { Database } from 'bun:sqlite';
import {
  applyEventCreatePlan,
  eventCreatePlanDigest,
  eventCreateResult,
  parseEventCreatePlan,
  parseEventState,
  parseWorkspaceEventSetState,
  projectCurrentEvent,
  validateEventCreatePlan,
  workspaceEventSetDigest,
  eventCreateCompensationResult,
  validateEventCreateCompensationPlan,
  type Event,
  type EventCreateCompensationPlan,
  type EventCreationReadPort,
  type EventCreationChangesetResult,
  type EventDependencyContributorRegistry,
  type EventCreatePlan,
  type WorkspaceEventSet
} from '@jooevents/event';
import {
  parseEventId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  eventCreateOperationResultSchema,
  type CurrentEventProjection
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';

/** Additive schema installed only in an explicitly ephemeral SQLite runtime. */
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

CREATE TABLE event_spine_create_links (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  UNIQUE (receipt_id, workspace_id, event_id),
  FOREIGN KEY (receipt_id)
    REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_heads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_create_plans (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  plan_digest_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(plan_digest_sha256) = 64
    AND plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK(
    json_valid(plan_json)
    AND json_extract(plan_json, '$.action') = 'create'
    AND json_extract(plan_json, '$.workspaceId') = workspace_id
    AND json_extract(plan_json, '$.after.id') = event_id
  ),
  UNIQUE (receipt_id, workspace_id, event_id),
  FOREIGN KEY (receipt_id, workspace_id, event_id)
    REFERENCES event_spine_create_links(receipt_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, plan_digest_sha256)
    REFERENCES event_spine_heads(workspace_id, id, create_plan_digest_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_domain_facts (
  fact_id TEXT PRIMARY KEY CHECK(length(fact_id) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  fact_kind TEXT NOT NULL CHECK(fact_kind = 'event_created'),
  fact_version INTEGER NOT NULL CHECK(fact_version = 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  UNIQUE (fact_id, receipt_id),
  UNIQUE (fact_id, receipt_id, workspace_id, event_id),
  FOREIGN KEY (receipt_id, workspace_id, event_id)
    REFERENCES event_spine_create_links(receipt_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_outbox_pointers (
  pointer_id TEXT PRIMARY KEY CHECK(length(pointer_id) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY (fact_id, receipt_id)
    REFERENCES event_spine_domain_facts(fact_id, receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE event_spine_timeline_projection (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) BETWEEN 1 AND 300),
  receipt_id TEXT NOT NULL UNIQUE,
  fact_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  source_kind TEXT NOT NULL CHECK(source_kind = 'domain_fact'),
  FOREIGN KEY (fact_id, receipt_id, workspace_id, event_id)
    REFERENCES event_spine_domain_facts(fact_id, receipt_id, workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_heads(workspace_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_spine_create_links_no_update
BEFORE UPDATE ON event_spine_create_links
BEGIN
  SELECT RAISE(ABORT, 'event create links are immutable');
END;

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

CREATE TRIGGER event_spine_create_links_no_delete
BEFORE DELETE ON event_spine_create_links
BEGIN
  SELECT RAISE(ABORT, 'event create links are immutable');
END;

CREATE TRIGGER event_spine_create_plans_no_update
BEFORE UPDATE ON event_spine_create_plans
BEGIN
  SELECT RAISE(ABORT, 'event create plans are immutable');
END;

CREATE TRIGGER event_spine_create_plans_no_delete
BEFORE DELETE ON event_spine_create_plans
BEGIN
  SELECT RAISE(ABORT, 'event create plans are immutable');
END;

CREATE TRIGGER event_spine_domain_facts_no_update
BEFORE UPDATE ON event_spine_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'event facts are immutable');
END;

CREATE TRIGGER event_spine_domain_facts_no_delete
BEFORE DELETE ON event_spine_domain_facts
BEGIN
  SELECT RAISE(ABORT, 'event facts are immutable');
END;

CREATE TRIGGER event_spine_outbox_pointers_no_update
BEFORE UPDATE ON event_spine_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'event outbox pointers are immutable');
END;

CREATE TRIGGER event_spine_outbox_pointers_no_delete
BEFORE DELETE ON event_spine_outbox_pointers
BEGIN
  SELECT RAISE(ABORT, 'event outbox pointers are immutable');
END;

CREATE TRIGGER event_spine_timeline_no_update
BEFORE UPDATE ON event_spine_timeline_projection
BEGIN
  SELECT RAISE(ABORT, 'event timeline entries are immutable');
END;

CREATE TRIGGER event_spine_timeline_no_delete
BEFORE DELETE ON event_spine_timeline_projection
BEGIN
  SELECT RAISE(ABORT, 'event timeline entries are immutable');
END;
`;

export type SQLiteEventSpineErrorCode =
  | 'transaction_required'
  | 'workspace_event_set_missing'
  | 'event_set_data_corrupt'
  | 'event_head_data_corrupt'
  | 'current_event_missing'
  | 'source_plan_missing'
  | 'source_plan_corrupt'
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

interface EventCreatePlanRow {
  readonly plan_digest_sha256: string;
  readonly plan_json: string;
}

interface EventCreateReceiptRow {
  readonly operation_name: string;
  readonly operation_version: number;
  readonly result_json: string;
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
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, number]>(`
      UPDATE event_spine_workspace_sets
         SET version = ?, current_event_id = ?
       WHERE workspace_id = ? AND version = ? AND current_event_id IS NULL
    `).run(
      applied.eventSet.version,
      applied.event.id,
      applied.eventSet.workspaceId,
      currentSet.version
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

  applyEventCreateCompensationPlan(input: {
    readonly plan: EventCreateCompensationPlan;
    readonly dependencyRegistry: EventDependencyContributorRegistry;
    readonly readPort: EventCreationReadPort;
  }): EventCreationChangesetResult {
    requireTransaction(this.sqlite);
    const issue = validateEventCreateCompensationPlan(
      input.plan,
      input.readPort,
      input.dependencyRegistry
    );
    if (issue !== null) {
      throw new SQLiteEventSpineError(
        issue === 'stale_event_set' || issue === 'event_missing'
          || issue === 'event_changed' || issue === 'dependencies_changed'
          ? 'stale_event_set'
          : 'event_head_data_corrupt'
      );
    }
    changedExactlyOnce(this.sqlite.query<never, [number, string, number, string]>(`
      UPDATE event_spine_workspace_sets
         SET version = ?, current_event_id = NULL
       WHERE workspace_id = ? AND version = ? AND current_event_id = ?
    `).run(
      input.plan.resultingEventSetVersion,
      input.plan.workspaceId,
      input.plan.expectedEventSetVersion,
      input.plan.before.id
    ));
    return eventCreateCompensationResult(input.plan);
  }

  linkEventCreateReceipt(input: {
    readonly receiptId: string;
    readonly plan: EventCreatePlan;
    readonly operation: { readonly name: string; readonly version: number };
  }): void {
    requireTransaction(this.sqlite);
    const plan = parseEventCreatePlan(input.plan);
    const eventSet = this.requireEventSet(plan.workspaceId);
    const event = this.readEventHead({ workspaceId: plan.workspaceId, eventId: plan.after.id });
    const receipt = oneOrNone(this.sqlite.query<EventCreateReceiptRow, [string]>(`
      SELECT operation_name, operation_version, result_json
        FROM foundation_trial_operation_receipts
       WHERE id = ?
       ORDER BY id
       LIMIT 2
    `).all(input.receiptId), 'source_plan_corrupt');
    let parsedReceipt: ReturnType<typeof eventCreateOperationResultSchema.parse>;
    try {
      parsedReceipt = eventCreateOperationResultSchema.parse(JSON.parse(receipt?.result_json ?? 'null'));
    } catch (error) {
      throw new SQLiteEventSpineError('source_plan_corrupt', error);
    }
    if (!event
        || canonicalJsonText(event) !== canonicalJsonText(plan.after)
        || eventSet.currentEventId !== plan.after.id
        || eventSet.version !== plan.resultingEventSetVersion
        || workspaceEventSetDigest(eventSet) !== plan.resultingEventSetGuardDigest
        || parsedReceipt.kind !== 'success'
        || receipt?.operation_name !== input.operation.name
        || receipt.operation_version !== input.operation.version
        || parsedReceipt.receipt.id !== input.receiptId
        || parsedReceipt.receipt.operationName !== input.operation.name
        || parsedReceipt.receipt.operationVersion !== input.operation.version
        || canonicalJsonText(parsedReceipt.data) !== canonicalJsonText(eventCreateResult(plan))) {
      throw new SQLiteEventSpineError('source_plan_corrupt');
    }
    this.sqlite.query<never, [string, string, string]>(`
      INSERT INTO event_spine_create_links (receipt_id, workspace_id, event_id)
      VALUES (?, ?, ?)
    `).run(input.receiptId, plan.workspaceId, plan.after.id);
    this.sqlite.query<never, [string, string, string, string, string]>(`
      INSERT INTO event_spine_create_plans (
        receipt_id, workspace_id, event_id, plan_digest_sha256, plan_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.receiptId,
      plan.workspaceId,
      plan.after.id,
      eventCreatePlanDigest(plan),
      canonicalJsonText(plan)
    );
  }

  readEventCreatePlan(receiptId: string): EventCreatePlan {
    const row = oneOrNone(this.sqlite.query<EventCreatePlanRow, [string]>(`
      SELECT plan_digest_sha256, plan_json
        FROM event_spine_create_plans
       WHERE receipt_id = ?
       ORDER BY receipt_id
       LIMIT 2
    `).all(receiptId), 'source_plan_corrupt');
    if (!row) throw new SQLiteEventSpineError('source_plan_missing');
    try {
      const plan = parseEventCreatePlan(JSON.parse(row.plan_json));
      if (canonicalJsonText(plan) !== row.plan_json
          || eventCreatePlanDigest(plan) !== row.plan_digest_sha256) {
        throw new SQLiteEventSpineError('source_plan_corrupt');
      }
      return plan;
    } catch (error) {
      if (error instanceof SQLiteEventSpineError) throw error;
      throw new SQLiteEventSpineError('source_plan_corrupt', error);
    }
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
