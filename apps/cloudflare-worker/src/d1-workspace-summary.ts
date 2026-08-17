import {
  workspaceShellSummaryProjectionSchema,
  type WorkspaceShellSummaryProjection
} from '@jooevents/contracts/workspace-shell-summary';
import { parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';

interface WorkspaceSummaryRow {
  readonly workspace_id: string;
  readonly workspace_name: string;
  readonly event_id: string | null;
  readonly event_name: string | null;
  readonly event_timezone: string | null;
  readonly event_start_date: string | null;
  readonly event_end_date: string | null;
}

export type D1WorkspaceShellSummaryErrorCode =
  | 'workspace_missing'
  | 'workspace_corrupt'
  | 'projection_corrupt';

export class D1WorkspaceShellSummaryError extends Error {
  readonly name = 'D1WorkspaceShellSummaryError';

  constructor(
    readonly code: D1WorkspaceShellSummaryErrorCode,
    options?: { readonly cause?: unknown }
  ) {
    super(code, options);
  }
}

/** Reads workspace and selected-Event chrome identity in one D1 statement. */
export function createD1WorkspaceShellSummaryReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async readSummary(requestedWorkspaceId: WorkspaceId): Promise<WorkspaceShellSummaryProjection> {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new D1WorkspaceShellSummaryError('workspace_missing');
      }
      const result = await input.database.prepare(`
        SELECT workspace.id AS workspace_id,workspace.name AS workspace_name,
          event.id AS event_id,event.name AS event_name,event.timezone AS event_timezone,
          event.start_date AS event_start_date,event.end_date AS event_end_date
        FROM workspaces AS workspace
        JOIN event_spine_workspace_sets AS selected
          ON selected.workspace_id = workspace.id
        LEFT JOIN event_spine_heads AS event
          ON event.workspace_id = selected.workspace_id
         AND event.id = selected.current_event_id
        WHERE workspace.id = ? AND workspace.state = 'active'
        ORDER BY workspace.id
        LIMIT 2
      `).bind(workspaceId).all<WorkspaceSummaryRow>();
      if (result.results.length === 0) {
        throw new D1WorkspaceShellSummaryError('workspace_missing');
      }
      if (result.results.length !== 1) {
        throw new D1WorkspaceShellSummaryError('workspace_corrupt');
      }
      const row = result.results[0]!;
      try {
        return workspaceShellSummaryProjectionSchema.parse({
          schemaVersion: 1,
          workspace: { id: row.workspace_id, name: row.workspace_name },
          event: row.event_id === null
            ? null
            : {
                id: row.event_id,
                name: row.event_name,
                timezone: row.event_timezone,
                startDate: row.event_start_date,
                endDate: row.event_end_date
              }
        });
      } catch (cause) {
        throw new D1WorkspaceShellSummaryError('projection_corrupt', { cause });
      }
    }
  });
}
