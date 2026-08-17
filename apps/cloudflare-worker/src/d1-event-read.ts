import {
  parseEventState,
  parseWorkspaceEventSetState,
  projectCurrentEvent,
  projectEventList,
  type Event,
  type WorkspaceEventSet
} from '@jooevents/event';
import { parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';

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
}

function eventFromRow(row: EventHeadRow): Event {
  return parseEventState({
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at_ms).toISOString()
  });
}

function eventSetFromResult(result: D1Result<EventSetRow>): WorkspaceEventSet {
  if (result.results.length !== 1) throw new TypeError('d1_workspace_event_set_missing');
  const row = result.results[0];
  if (!row) throw new TypeError('d1_workspace_event_set_missing');
  return parseWorkspaceEventSetState({
    workspaceId: row.workspace_id,
    version: row.version,
    currentEventId: row.current_event_id
  });
}

function eventHeadsFromResult(result: D1Result<EventHeadRow>): readonly Event[] {
  return Object.freeze(result.results.map(eventFromRow));
}

async function readSnapshot(database: D1Database, workspaceId: WorkspaceId) {
  const [setResult, headsResult] = await database.batch([
    database.prepare(`SELECT workspace_id,version,current_event_id
      FROM event_spine_workspace_sets WHERE workspace_id = ?`).bind(workspaceId),
    database.prepare(`SELECT h.workspace_id,h.id,h.name,h.timezone,
    h.start_date,h.end_date,h.version,h.created_by_user_id,h.created_at_ms
    FROM event_spine_heads h
    JOIN event_spine_scope_roots root
      ON root.workspace_id = h.workspace_id AND root.event_id = h.id
    WHERE h.workspace_id = ?
    ORDER BY h.start_date DESC,h.name COLLATE BINARY,h.id COLLATE BINARY`)
      .bind(workspaceId)
  ]);
  return Object.freeze({
    eventSet: eventSetFromResult(setResult as D1Result<EventSetRow>),
    events: eventHeadsFromResult(headsResult as D1Result<EventHeadRow>)
  });
}

/** Primary-consistent Event projections for the registered read operations. */
export function createD1EventReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readCurrent(requestedWorkspaceId: WorkspaceId) {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new TypeError('d1_event_read_workspace_mismatch');
      }
      const { eventSet, events } = await readSnapshot(input.database, workspaceId);
      if (eventSet.currentEventId === null) return projectCurrentEvent(eventSet, undefined);
      const current = events.find((event) => event.id === eventSet.currentEventId);
      if (!current) throw new TypeError('d1_current_event_missing');
      return projectCurrentEvent(eventSet, current);
    },
    async readList(requestedWorkspaceId: WorkspaceId) {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new TypeError('d1_event_list_workspace_mismatch');
      }
      const { eventSet, events } = await readSnapshot(input.database, workspaceId);
      return projectEventList(eventSet, events);
    }
  });
}
