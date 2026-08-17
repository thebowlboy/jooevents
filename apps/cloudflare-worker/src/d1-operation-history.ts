import {
  operationHistoryListInputSchema,
  operationHistoryPageSchema,
  operationSurfaceSchema,
  type OperationHistoryPage
} from '@jooevents/contracts';
import {
  parseEventId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';

interface OperationHistoryRow {
  readonly id: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly workspace_id: string;
  readonly effective_event_id: string | null;
  readonly surface: string;
  readonly actor_json: string;
  readonly subjects_json: string;
  readonly summary: string;
  readonly occurred_at_ms: number;
  readonly correlation_id: string;
  readonly result_kind: string;
}

export type D1OperationHistoryErrorCode =
  | 'invalid_scope'
  | 'history_evidence_corrupt';

export class D1OperationHistoryError extends Error {
  readonly name = 'D1OperationHistoryError';

  constructor(
    readonly code: D1OperationHistoryErrorCode,
    options?: { readonly cause?: unknown }
  ) {
    super(code, options);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new D1OperationHistoryError('history_evidence_corrupt', { cause });
  }
}

/** Primary-consistent, safe operation-history projection over the retained D1 log. */
export function createD1OperationHistoryReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return Object.freeze({
    async list(
      scopeInput: { readonly workspaceId: WorkspaceId; readonly eventId?: EventId },
      businessInput: unknown
    ): Promise<OperationHistoryPage> {
      if (parseWorkspaceId(scopeInput.workspaceId) !== workspaceId) {
        throw new D1OperationHistoryError('invalid_scope');
      }
      const request = operationHistoryListInputSchema.parse(businessInput);
      const eventId = scopeInput.eventId === undefined
        ? undefined
        : parseEventId(scopeInput.eventId);
      if ((request.view === 'event') !== (eventId !== undefined)) {
        throw new D1OperationHistoryError('invalid_scope');
      }
      const beforeMs = request.beforeOccurredAt === undefined
        ? undefined
        : Date.parse(request.beforeOccurredAt);
      const eventClause = eventId === undefined
        ? ''
        : ` AND (
            log.event_id = ?
            OR (log.operation_name = 'event.create'
              AND json_extract(log.result_json, '$.data.event.id') = ?)
          )`;
      const cursorClause = beforeMs === undefined
        ? ''
        : ` AND (log.occurred_at_ms < ?
            OR (log.occurred_at_ms = ? AND log.id < ?))`;
      const statement = input.database.prepare(`
        SELECT log.id,log.operation_name,log.operation_version,log.workspace_id,
          CASE WHEN log.operation_name = 'event.create'
            THEN json_extract(log.result_json, '$.data.event.id') ELSE log.event_id END
            AS effective_event_id,
          log.surface,log.actor_json,log.subjects_json,log.summary,
          log.occurred_at_ms,log.correlation_id,
          json_extract(log.result_json, '$.kind') AS result_kind
        FROM operation_log AS log
        WHERE log.workspace_id = ?${eventClause}${cursorClause}
        ORDER BY log.occurred_at_ms DESC,log.id DESC
        LIMIT ?
      `);
      const parameters: Array<string | number> = [workspaceId];
      if (eventId !== undefined) parameters.push(eventId, eventId);
      if (beforeMs !== undefined && request.beforeId !== undefined) {
        parameters.push(beforeMs, beforeMs, request.beforeId);
      }
      parameters.push(request.limit + 1);
      const result = await statement.bind(...parameters).all<OperationHistoryRow>();
      const visible = result.results.slice(0, request.limit);
      try {
        const entries = visible.map((row) => ({
          id: row.id,
          operation: { name: row.operation_name, version: row.operation_version },
          scope: {
            workspaceId: row.workspace_id,
            ...(row.effective_event_id === null ? {} : { eventId: row.effective_event_id })
          },
          surface: operationSurfaceSchema.parse(row.surface),
          actor: parseJson(row.actor_json),
          subjects: parseJson(row.subjects_json),
          summary: row.summary,
          occurredAt: new Date(row.occurred_at_ms).toISOString(),
          correlationId: row.correlation_id,
          resultKind: row.result_kind
        }));
        const last = visible.at(-1);
        return operationHistoryPageSchema.parse({
          schemaVersion: 1,
          scope: request.view,
          entries,
          ...(result.results.length > request.limit && last !== undefined
            ? {
                next: {
                  occurredAt: new Date(last.occurred_at_ms).toISOString(),
                  id: last.id
                }
              }
            : {})
        });
      } catch (cause) {
        if (cause instanceof D1OperationHistoryError) throw cause;
        throw new D1OperationHistoryError('history_evidence_corrupt', { cause });
      }
    }
  });
}
