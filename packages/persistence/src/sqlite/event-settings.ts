import { Database } from 'bun:sqlite';
import {
  eventSettingsScopeSchema,
  type EventSettingsDto,
  type EventSettingsScope
} from '@jooevents/contracts';
import {
  applyEventSettingsUpdatePlan,
  parseEventSettingsCompanion,
  parseEventSettingsState,
  projectEventSettings,
  validateEventSettingsUpdatePlan,
  type EventSettingsState,
  type EventSettingsTransactionPort,
  type EventSettingsUpdatePlan
} from '@jooevents/event';
import { parseEventId, parseWorkspaceId, type EventId, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteEventSpineRepository } from './event-spine';

/** Additive schema installed only in an explicitly ephemeral SQLite runtime. */
export const EVENT_SETTINGS_SQL = `
CREATE TABLE event_settings_companions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  event_version INTEGER NOT NULL CHECK(event_version > 0),
  location TEXT NOT NULL CHECK(length(location) <= 500),
  venue_note TEXT NOT NULL CHECK(length(venue_note) <= 8000),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, event_id, event_version),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_settings_companions_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON event_settings_companions
BEGIN
  SELECT RAISE(ABORT, 'event settings scope is immutable');
END;

CREATE TRIGGER event_settings_companions_version_advances_once
BEFORE UPDATE OF event_version ON event_settings_companions
WHEN NEW.event_version != OLD.event_version + 1
BEGIN
  SELECT RAISE(ABORT, 'event settings version must advance once');
END;

CREATE TRIGGER event_settings_companions_no_delete
BEFORE DELETE ON event_settings_companions
BEGIN
  SELECT RAISE(ABORT, 'event settings companions are retained with the Event root');
END;
`;

export type SQLiteEventSettingsErrorCode =
  | 'transaction_required'
  | 'current_event_missing'
  | 'selection_changed'
  | 'settings_companion_missing'
  | 'settings_companion_conflict'
  | 'settings_data_corrupt'
  | 'stale_settings';

export class SQLiteEventSettingsError extends TypeError {
  constructor(readonly code: SQLiteEventSettingsErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteEventSettingsError';
  }
}

interface CompanionRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly event_version: number;
  readonly location: string;
  readonly venue_note: string;
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteEventSettingsError('transaction_required');
}

function oneOrNone(rows: readonly CompanionRow[]): CompanionRow | undefined {
  if (rows.length > 1) throw new SQLiteEventSettingsError('settings_data_corrupt');
  return rows[0];
}

function parseCompanion(row: CompanionRow) {
  try {
    return parseEventSettingsCompanion({
      workspaceId: row.workspace_id,
      eventId: row.event_id,
      eventVersion: row.event_version,
      location: row.location,
      venueNote: row.venue_note
    });
  } catch (error) {
    throw new SQLiteEventSettingsError('settings_data_corrupt', error);
  }
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteEventSettingsErrorCode
): void {
  if (result.changes !== 1) throw new SQLiteEventSettingsError(code);
}

export function installEventSettingsSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteEventSettingsError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(EVENT_SETTINGS_SQL);
}

export interface CreatedEventSettingsInitializer {
  initializeCreatedEventSettings(scope: EventSettingsScope): EventSettingsState;
}

export class SQLiteEventSettingsRepository implements EventSettingsTransactionPort {
  readonly #spine: SQLiteEventSpineRepository;

  constructor(private readonly sqlite: Database) {
    this.#spine = new SQLiteEventSpineRepository(sqlite);
  }

  private readCompanion(scopeInput: EventSettingsScope) {
    const scope = eventSettingsScopeSchema.parse(scopeInput);
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const eventId = parseEventId(scope.eventId);
    const row = oneOrNone(this.sqlite.query<CompanionRow, [WorkspaceId, EventId]>(`
      SELECT workspace_id, event_id, event_version, location, venue_note
        FROM event_settings_companions
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id
       LIMIT 2
    `).all(workspaceId, eventId));
    return row ? parseCompanion(row) : undefined;
  }

  readEventSettings(scopeInput: EventSettingsScope): EventSettingsState | undefined {
    const scope = eventSettingsScopeSchema.parse(scopeInput);
    const current = this.#spine.readCurrentEventState(scope.workspaceId);
    if (!current) return undefined;
    if (!current.currentEvent) return undefined;
    if (current.eventSet.currentEventId !== scope.eventId
        || current.currentEvent.id !== scope.eventId) return undefined;
    const companion = this.readCompanion(scope);
    if (!companion) throw new SQLiteEventSettingsError('settings_companion_missing');
    try {
      return parseEventSettingsState({
        eventSet: current.eventSet,
        event: current.currentEvent,
        companion
      });
    } catch (error) {
      throw new SQLiteEventSettingsError('settings_data_corrupt', error);
    }
  }

  requireEventSettings(scope: EventSettingsScope): EventSettingsState {
    const state = this.readEventSettings(scope);
    if (!state) throw new SQLiteEventSettingsError('selection_changed');
    return state;
  }

  readCurrentEventSettings(workspaceIdInput: string): EventSettingsDto | undefined {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    const current = this.#spine.readCurrentEventState(workspaceId);
    if (!current || !current.currentEvent) return undefined;
    return projectEventSettings(this.requireEventSettings({
      workspaceId,
      eventId: current.currentEvent.id
    }));
  }

  initializeCreatedEventSettings(scopeInput: EventSettingsScope): EventSettingsState {
    requireTransaction(this.sqlite);
    const scope = eventSettingsScopeSchema.parse(scopeInput);
    const current = this.#spine.readCurrentEventState(scope.workspaceId);
    if (!current?.currentEvent) throw new SQLiteEventSettingsError('current_event_missing');
    if (current.eventSet.currentEventId !== scope.eventId
        || current.currentEvent.id !== scope.eventId) {
      throw new SQLiteEventSettingsError('selection_changed');
    }
    const existing = this.readCompanion(scope);
    if (existing) {
      if (existing.eventVersion !== current.currentEvent.version
          || existing.location !== ''
          || existing.venueNote !== '') {
        throw new SQLiteEventSettingsError('settings_companion_conflict');
      }
      return this.requireEventSettings(scope);
    }
    try {
      changedExactlyOnce(this.sqlite.query<never, [
        WorkspaceId, EventId, number, WorkspaceId, EventId, number
      ]>(`
        INSERT INTO event_settings_companions (
          workspace_id, event_id, event_version, location, venue_note
        )
        SELECT ?, ?, ?, '', ''
         WHERE EXISTS (
           SELECT 1
             FROM event_spine_workspace_sets s
             JOIN event_spine_heads h
               ON h.workspace_id = s.workspace_id AND h.id = s.current_event_id
            WHERE s.workspace_id = ?
              AND s.current_event_id = ?
              AND h.version = ?
         )
      `).run(
        current.currentEvent.workspaceId,
        current.currentEvent.id,
        current.currentEvent.version,
        current.currentEvent.workspaceId,
        current.currentEvent.id,
        current.currentEvent.version
      ), 'selection_changed');
    } catch (error) {
      if (error instanceof SQLiteEventSettingsError) throw error;
      throw new SQLiteEventSettingsError('settings_companion_conflict', error);
    }
    return this.requireEventSettings(scope);
  }

  applyEventSettingsUpdatePlan(plan: EventSettingsUpdatePlan): EventSettingsDto {
    requireTransaction(this.sqlite);
    const scope = eventSettingsScopeSchema.parse(plan.scope);
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const eventId = parseEventId(scope.eventId);
    const selectedEventId = parseEventId(plan.selection.eventId);
    const current = this.requireEventSettings(plan.scope);
    const issue = validateEventSettingsUpdatePlan(current, plan);
    if (issue) throw new SQLiteEventSettingsError('stale_settings');
    const result = applyEventSettingsUpdatePlan({ state: current, plan });
    this.sqlite.exec('SAVEPOINT event_settings_apply');
    try {
      changedExactlyOnce(this.sqlite.query<never, [
        string, string, string, string, number,
        WorkspaceId, EventId, number, string, string, string, string,
        WorkspaceId, EventId, number
      ]>(`
        UPDATE event_spine_heads
           SET name = ?, timezone = ?, start_date = ?, end_date = ?, version = ?
         WHERE workspace_id = ? AND id = ? AND version = ?
           AND name = ? AND timezone = ? AND start_date = ? AND end_date = ?
           AND EXISTS (
             SELECT 1 FROM event_spine_workspace_sets s
              WHERE s.workspace_id = ?
                AND s.current_event_id = ?
                AND s.version = ?
           )
      `).run(
        plan.after.name,
        plan.after.timezone,
        plan.after.startDate,
        plan.after.endDate,
        plan.resultingEventVersion,
        workspaceId,
        eventId,
        plan.expectedEventVersion,
        plan.before.name,
        plan.before.timezone,
        plan.before.startDate,
        plan.before.endDate,
        workspaceId,
        selectedEventId,
        plan.selection.eventSetVersion
      ), 'stale_settings');
      changedExactlyOnce(this.sqlite.query<never, [
        number, string, string, WorkspaceId, EventId, number, string, string
      ]>(`
        UPDATE event_settings_companions
           SET event_version = ?, location = ?, venue_note = ?
         WHERE workspace_id = ? AND event_id = ? AND event_version = ?
           AND location = ? AND venue_note = ?
      `).run(
        plan.resultingEventVersion,
        plan.after.location,
        plan.after.venueNote,
        workspaceId,
        eventId,
        plan.expectedEventVersion,
        plan.before.location,
        plan.before.venueNote
      ), 'stale_settings');
      this.sqlite.exec('RELEASE SAVEPOINT event_settings_apply');
    } catch (error) {
      this.sqlite.exec('ROLLBACK TO SAVEPOINT event_settings_apply');
      this.sqlite.exec('RELEASE SAVEPOINT event_settings_apply');
      if (error instanceof SQLiteEventSettingsError) throw error;
      throw new SQLiteEventSettingsError('stale_settings', error);
    }
    return result;
  }
}

/** Transaction-required Event-create companion collaborator for the central create UoW. */
export function createSQLiteEventSettingsInitializer(input: {
  readonly sqlite: Database;
}): CreatedEventSettingsInitializer {
  const repository = new SQLiteEventSettingsRepository(input.sqlite);
  return Object.freeze({
    initializeCreatedEventSettings(scope: EventSettingsScope) {
      return repository.initializeCreatedEventSettings(scope);
    }
  });
}

/** Direct form for isolated composition and tests; callers must already hold the create transaction. */
export function initializeCreatedEventSettings(input: {
  readonly sqlite: Database;
  readonly scope: EventSettingsScope;
}): EventSettingsState {
  return new SQLiteEventSettingsRepository(input.sqlite)
    .initializeCreatedEventSettings(input.scope);
}
