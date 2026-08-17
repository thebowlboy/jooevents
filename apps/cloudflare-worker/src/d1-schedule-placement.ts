import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { parseSchedulePlacementState, type SchedulePlacementState } from '@jooevents/schedule';

const MAX_OCCURRENCES = 2_000;

interface EventRootRow { readonly event_id: unknown }
interface ScheduleSetRow { readonly schedule_version: unknown }
interface OccurrenceRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly room_id: unknown;
  readonly start_at_ms: unknown;
  readonly end_at_ms: unknown;
  readonly version: unknown;
}

export class D1SchedulePlacementReadError extends Error {
  readonly name = 'D1SchedulePlacementReadError';

  constructor(readonly code: 'wrong_scope' | 'data_corrupt' | 'row_limit_exceeded') {
    super(code);
  }
}

function oneOrNone<Row>(result: D1Result<Row>): Row | undefined {
  if (result.results.length > 1) throw new D1SchedulePlacementReadError('data_corrupt');
  return result.results[0];
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new D1SchedulePlacementReadError('data_corrupt');
  }
  return value;
}

function instantFromMs(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < 0 || value > 8_640_000_000_000_000) {
    throw new D1SchedulePlacementReadError('data_corrupt');
  }
  try {
    return new Date(value).toISOString();
  } catch {
    throw new D1SchedulePlacementReadError('data_corrupt');
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new D1SchedulePlacementReadError('data_corrupt');
  return value;
}

/** Reads the canonical current-Event schedule state through one primary D1 session. */
export function createD1SchedulePlacementReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: string;
}): { readSchedule(scope: {
  readonly workspaceId: string;
  readonly eventId: string;
}): Promise<SchedulePlacementState | undefined> } {
  const configuredWorkspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readSchedule(scopeInput) {
      const workspaceId = parseWorkspaceId(scopeInput.workspaceId);
      const eventId = parseEventId(scopeInput.eventId);
      if (workspaceId !== configuredWorkspaceId) {
        throw new D1SchedulePlacementReadError('wrong_scope');
      }
      const session = input.database.withSession('first-primary');
      const [rootResult, setResult, occurrenceResult] = await session.batch([
        session.prepare(`SELECT event_id FROM event_spine_scope_roots
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY workspace_id,event_id LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`SELECT schedule_version FROM schedule_placement_sets
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY workspace_id,event_id LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`SELECT id,session_id,room_id,start_at_ms,end_at_ms,version
          FROM schedule_occurrences
          WHERE workspace_id = ? AND event_id = ?
          ORDER BY start_at_ms,end_at_ms,id COLLATE BINARY
          LIMIT ?`).bind(workspaceId, eventId, MAX_OCCURRENCES + 1)
      ]);
      const root = oneOrNone(rootResult as D1Result<EventRootRow>);
      if (!root) return undefined;
      if (root.event_id !== eventId) throw new D1SchedulePlacementReadError('data_corrupt');
      const set = oneOrNone(setResult as D1Result<ScheduleSetRow>);
      const rows = (occurrenceResult as D1Result<OccurrenceRow>).results;
      if (rows.length > MAX_OCCURRENCES) {
        throw new D1SchedulePlacementReadError('row_limit_exceeded');
      }
      if (!set && rows.length > 0) throw new D1SchedulePlacementReadError('data_corrupt');
      try {
        return parseSchedulePlacementState({
          schemaVersion: 1,
          scope: { workspaceId, eventId },
          scheduleVersion: set ? positiveInteger(set.schedule_version) : 1,
          occurrences: rows.map((row) => ({
            id: text(row.id),
            sessionId: text(row.session_id),
            roomId: text(row.room_id),
            startAt: instantFromMs(row.start_at_ms),
            endAt: instantFromMs(row.end_at_ms),
            version: positiveInteger(row.version)
          }))
        });
      } catch (cause) {
        if (cause instanceof D1SchedulePlacementReadError) throw cause;
        throw new D1SchedulePlacementReadError('data_corrupt');
      }
    }
  });
}
