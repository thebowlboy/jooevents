import type { Database } from 'bun:sqlite';
import {
  workspaceShellSummaryProjectionSchema,
  type WorkspaceShellSummaryProjection
} from '@jooevents/contracts/workspace-shell-summary';
import { parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteEventSpineRepository } from './event-spine';

export type SQLiteWorkspaceShellSummaryErrorCode =
  | 'workspace_missing'
  | 'workspace_corrupt'
  | 'workspace_event_set_missing'
  | 'projection_corrupt';

export class SQLiteWorkspaceShellSummaryError extends Error {
  readonly name = 'SQLiteWorkspaceShellSummaryError';
  constructor(
    readonly code: SQLiteWorkspaceShellSummaryErrorCode,
    options?: { readonly cause?: unknown }
  ) {
    super(code, options);
  }
}

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
}

export class SQLiteWorkspaceShellSummaryProjection {
  constructor(private readonly sqlite: Database) {}

  readSummary(workspaceIdInput: WorkspaceId): WorkspaceShellSummaryProjection {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    const read = () => {
      const rows = this.sqlite.query<WorkspaceRow, [WorkspaceId]>(`
        SELECT id, name
          FROM workspaces
         WHERE id = ? AND state = 'active'
         ORDER BY id
         LIMIT 2
      `).all(workspaceId);
      if (rows.length === 0) throw new SQLiteWorkspaceShellSummaryError('workspace_missing');
      if (rows.length !== 1) throw new SQLiteWorkspaceShellSummaryError('workspace_corrupt');
      const current = new SQLiteEventSpineRepository(this.sqlite)
        .readCurrentEventState(workspaceId);
      if (!current) {
        throw new SQLiteWorkspaceShellSummaryError('workspace_event_set_missing');
      }
      try {
        return workspaceShellSummaryProjectionSchema.parse({
          schemaVersion: 1,
          workspace: rows[0],
          event: current.currentEvent === undefined
            ? null
            : {
                id: current.currentEvent.id,
                name: current.currentEvent.name,
                timezone: current.currentEvent.timezone,
                startDate: current.currentEvent.startDate,
                endDate: current.currentEvent.endDate
              }
        });
      } catch (cause) {
        throw new SQLiteWorkspaceShellSummaryError('projection_corrupt', { cause });
      }
    };
    return this.sqlite.inTransaction ? read() : this.sqlite.transaction(read).deferred();
  }
}

export function createSQLiteWorkspaceShellSummaryProjection(
  sqlite: Database
): SQLiteWorkspaceShellSummaryProjection {
  return new SQLiteWorkspaceShellSummaryProjection(sqlite);
}
