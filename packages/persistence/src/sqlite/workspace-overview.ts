import type { Database } from 'bun:sqlite';
import {
  effectfulOperationResultSchema,
  operationSurfaceSchema,
  type EffectfulOperationResult,
  type OperationSurface
} from '@jooevents/contracts';
import {
  workspaceOverviewAreaCatalogSchema,
  workspaceOverviewHistoryThreadSchema,
  workspaceOverviewProjectionSchema,
  type WorkspaceOverviewAreaCatalog,
  type WorkspaceOverviewHistoryActor,
  type WorkspaceOverviewHistoryDomain,
  type WorkspaceOverviewHistoryThread,
  type WorkspaceOverviewProjection
} from '@jooevents/contracts/workspace-overview';
import { OPERATION_SURFACES, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { SQLiteEventSpineRepository } from './event-spine';

export type SQLiteWorkspaceOverviewErrorCode =
  | 'invalid_configuration'
  | 'required_schema_missing'
  | 'workspace_event_set_missing'
  | 'count_evidence_corrupt'
  | 'history_evidence_corrupt'
  | 'projection_corrupt';

export class SQLiteWorkspaceOverviewError extends Error {
  readonly name = 'SQLiteWorkspaceOverviewError';
  constructor(readonly code: SQLiteWorkspaceOverviewErrorCode, options?: { readonly cause?: unknown }) {
    super(code, options);
  }
}

const REQUIRED_TABLES = Object.freeze([
  'operation_log',
  'event_spine_workspace_sets',
  'intake_form_heads',
  'intake_submission_heads',
  'program_vocabulary_formats',
  'program_vocabulary_rooms',
  'program_vocabulary_tracks',
]);
const EVENT_REQUIRED_AREAS = new Set([
  'submissions', 'review', 'decisions', 'speakers', 'reviewers', 'tasks', 'schedule',
  'messages', 'templates', 'forms', 'embeds'
]);
const ACTOR_ORDER = Object.freeze([
  'person', 'agent', 'participant', 'system', 'integration'
] satisfies readonly WorkspaceOverviewHistoryActor[]);

interface ExistingTableRow { readonly name: string; }
interface StatusCountRow { readonly total: number; readonly draft: number; readonly open: number; readonly closed: number; }
interface VocabularyCountRow { readonly total: number; readonly active: number; readonly retired: number; }
interface TotalCountRow { readonly total: number; }
interface HistoryRow {
  readonly id: string;
  readonly domain: WorkspaceOverviewHistoryDomain;
  readonly workspace_id: string;
  readonly event_id: string | null;
  readonly occurred_at_ms: number;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: string;
  readonly result_json: string;
  readonly actor_json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as Value;
}
function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  }
  return value;
}
function statusCounts(row: StatusCountRow | null): StatusCountRow {
  if (!row) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  const parsed = { total: safeCount(row.total), draft: safeCount(row.draft),
    open: safeCount(row.open), closed: safeCount(row.closed) };
  if (parsed.total !== parsed.draft + parsed.open + parsed.closed) {
    throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  }
  return parsed;
}
function vocabularyCounts(row: VocabularyCountRow | null): VocabularyCountRow {
  if (!row) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  const parsed = { total: safeCount(row.total), active: safeCount(row.active), retired: safeCount(row.retired) };
  if (parsed.total !== parsed.active + parsed.retired) {
    throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  }
  return parsed;
}
function actorCategory(value: unknown): WorkspaceOverviewHistoryActor {
  switch (value) {
    case 'workspace_user': return 'person';
    case 'external_mcp_client':
    case 'app_model_run': return 'agent';
    case 'participant':
    case 'public_request': return 'participant';
    case 'system_job':
    case 'system_consumer_delivery':
    case 'system_scheduler': return 'system';
    case 'service':
    case 'verified_ingress_intake':
    case 'verified_inbox_processing': return 'integration';
    default: throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  }
}
function parseActor(row: HistoryRow): WorkspaceOverviewHistoryActor {
  let candidate: unknown;
  try { candidate = JSON.parse(row.actor_json); }
  catch (cause) { throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause }); }
  if (!isRecord(candidate)) throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  return actorCategory(candidate.kind);
}
function parseResult(row: HistoryRow): EffectfulOperationResult {
  try {
    const result = effectfulOperationResultSchema.parse(JSON.parse(row.result_json));
    if (!('receipt' in result)
        || result.receipt.id !== row.id
        || result.receipt.operationName !== row.operation_name
        || result.receipt.operationVersion !== row.operation_version) {
      throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
    }
    return result;
  } catch (cause) {
    if (cause instanceof SQLiteWorkspaceOverviewError) throw cause;
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
}
function historyOutcome(result: EffectfulOperationResult) {
  return result.kind === 'success'
    ? Object.freeze({ kind: 'success' as const })
    : Object.freeze({ kind: 'outcome' as const, outcome: result.outcome });
}
function thread(row: HistoryRow): WorkspaceOverviewHistoryThread {
  if (!Number.isSafeInteger(row.occurred_at_ms) || row.occurred_at_ms < 0
      || row.workspace_id.length !== 36 || row.id.length !== 36) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  }
  let surface: OperationSurface;
  try { surface = operationSurfaceSchema.parse(row.surface); }
  catch (cause) { throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause }); }
  const result = parseResult(row);
  const actor = parseActor(row);
  return workspaceOverviewHistoryThreadSchema.parse({
    id: `operation:${row.id}`,
    domain: row.domain,
    root: { kind: 'operation', receiptId: row.id },
    firstOccurredAt: new Date(row.occurred_at_ms).toISOString(),
    lastOccurredAt: new Date(row.occurred_at_ms).toISOString(),
    actors: ACTOR_ORDER.filter((value) => value === actor),
    surfaces: OPERATION_SURFACES.filter((value) => value === surface),
    latestOperation: { name: row.operation_name, version: row.operation_version },
    latestReceipt: { id: row.id, operationName: row.operation_name,
      operationVersion: row.operation_version },
    latestOutcome: historyOutcome(result),
    evidence: { timelineEntries: 1, receipts: 1 }
  });
}

const HISTORY_SQL = `
SELECT log.id,
       CASE
         WHEN log.operation_name LIKE 'field_registry.%' THEN 'field_registry'
         WHEN log.operation_name LIKE 'form.%' THEN 'forms'
         WHEN log.operation_name LIKE 'program_vocabulary.%' THEN 'program_vocabulary'
         WHEN log.operation_name LIKE 'submission.triage.%' THEN 'submission_triage'
         WHEN log.operation_name LIKE 'workspace_team.%' THEN 'workspace_team'
         ELSE 'event'
       END AS domain,
       log.workspace_id,
       CASE WHEN log.operation_name = 'event.create'
         THEN json_extract(log.result_json, '$.data.event.id') ELSE log.event_id END AS event_id,
       log.occurred_at_ms, log.operation_name, log.operation_version,
       log.surface, log.result_json, log.actor_json
  FROM operation_log AS log
 WHERE log.workspace_id = ?
   AND (
     log.operation_name LIKE 'workspace_team.%'
     OR (? IS NULL AND log.operation_name = 'event.create')
     OR (? IS NOT NULL AND (
       log.event_id = ?
       OR (log.operation_name = 'event.create'
         AND json_extract(log.result_json, '$.data.event.id') = ?)
     ))
   )
 ORDER BY log.occurred_at_ms DESC, log.id ASC
`;

function history(rows: readonly HistoryRow[], limit: number): WorkspaceOverviewProjection['history'] {
  const all = rows.map(thread);
  const threads = all.slice(0, limit);
  return { total: all.length, truncated: all.length > threads.length, threads };
}
function noEventAreaCatalog(catalog: WorkspaceOverviewAreaCatalog): WorkspaceOverviewAreaCatalog {
  return workspaceOverviewAreaCatalogSchema.parse(catalog.map((entry) => {
    if (EVENT_REQUIRED_AREAS.has(entry.area)
        && (entry.status === 'available' || entry.status === 'partial')) {
      return { area: entry.area, status: 'locked', reason: 'event_required' };
    }
    return entry;
  }));
}
function assertRequiredTables(sqlite: Database): void {
  const rows = sqlite.query<ExistingTableRow, []>(`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `).all();
  const existing = new Set(rows.map((row) => row.name));
  if (REQUIRED_TABLES.some((name) => !existing.has(name))) {
    throw new SQLiteWorkspaceOverviewError('required_schema_missing');
  }
}

export class SQLiteWorkspaceOverviewProjection {
  readonly #catalog: WorkspaceOverviewAreaCatalog;
  readonly #historyLimit: number;
  constructor(private readonly input: {
    readonly sqlite: Database;
    readonly areaCatalog: WorkspaceOverviewAreaCatalog;
    readonly historyLimit?: number;
  }) {
    try { this.#catalog = deepFreeze(workspaceOverviewAreaCatalogSchema.parse(input.areaCatalog)); }
    catch (cause) { throw new SQLiteWorkspaceOverviewError('invalid_configuration', { cause }); }
    const historyLimit = input.historyLimit ?? 20;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 50) {
      throw new SQLiteWorkspaceOverviewError('invalid_configuration');
    }
    this.#historyLimit = historyLimit;
    assertRequiredTables(input.sqlite);
  }

  readOverview(workspaceIdInput: WorkspaceId): WorkspaceOverviewProjection {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    const read = () => this.#readSnapshot(workspaceId);
    return this.input.sqlite.inTransaction ? read() : this.input.sqlite.transaction(read).deferred();
  }

  #readSnapshot(workspaceId: WorkspaceId): WorkspaceOverviewProjection {
    const event = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventProjection(workspaceId);
    if (!event) throw new SQLiteWorkspaceOverviewError('workspace_event_set_missing');
    const eventId = event.kind === 'current_event' ? event.event.id : null;
    const areas = eventId === null ? noEventAreaCatalog(this.#catalog) : this.#catalog;
    const metrics = eventId === null ? {
      forms: { kind: 'unavailable' as const, reason: 'event_required' as const },
      submissions: { kind: 'unavailable' as const, reason: 'event_required' as const },
      programVocabulary: { kind: 'unavailable' as const, reason: 'event_required' as const },
      operations: { kind: 'unavailable' as const, reason: 'event_required' as const }
    } : this.#readMetrics(workspaceId, eventId);
    const rows = this.input.sqlite.query<HistoryRow,
      [WorkspaceId, string | null, string | null, string | null, string | null]>(HISTORY_SQL)
      .all(workspaceId, eventId, eventId, eventId, eventId);
    try {
      return deepFreeze(workspaceOverviewProjectionSchema.parse({
        schemaVersion: 1, event, areas, metrics, history: history(rows, this.#historyLimit)
      }));
    } catch (cause) {
      if (cause instanceof SQLiteWorkspaceOverviewError) throw cause;
      throw new SQLiteWorkspaceOverviewError('projection_corrupt', { cause });
    }
  }

  #readMetrics(workspaceId: WorkspaceId, eventId: string) {
    const forms = statusCounts(this.input.sqlite.query<StatusCountRow, [WorkspaceId, string]>(`
      SELECT COUNT(*) AS total, COALESCE(SUM(status = 'draft'), 0) AS draft,
             COALESCE(SUM(status = 'open'), 0) AS open,
             COALESCE(SUM(status = 'closed'), 0) AS closed
        FROM intake_form_heads WHERE workspace_id = ? AND event_id = ?
    `).get(workspaceId, eventId) ?? null);
    const submissions = this.input.sqlite.query<TotalCountRow, [WorkspaceId, string]>(`
      SELECT COUNT(*) AS total FROM intake_submission_heads WHERE workspace_id = ? AND event_id = ?
    `).get(workspaceId, eventId);
    if (!submissions) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    const vocabulary = (table: 'rooms' | 'tracks' | 'formats') => vocabularyCounts(
      this.input.sqlite.query<VocabularyCountRow, [WorkspaceId, string]>(`
        SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active,
               COALESCE(SUM(status = 'retired'), 0) AS retired
          FROM program_vocabulary_${table} WHERE workspace_id = ? AND event_id = ?
      `).get(workspaceId, eventId) ?? null
    );
    const operations = this.input.sqlite.query<TotalCountRow, [WorkspaceId, string, string]>(`
      SELECT COUNT(*) AS total FROM operation_log
       WHERE workspace_id = ? AND (
         event_id = ? OR (operation_name = 'event.create'
           AND json_extract(result_json, '$.data.event.id') = ?)
       )
    `).get(workspaceId, eventId, eventId);
    if (!operations) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    return {
      forms: { kind: 'exact' as const, ...forms },
      submissions: { kind: 'exact' as const, total: safeCount(submissions.total) },
      programVocabulary: { kind: 'exact' as const, rooms: vocabulary('rooms'),
        tracks: vocabulary('tracks'), formats: vocabulary('formats') },
      operations: { kind: 'exact' as const, total: safeCount(operations.total) }
    };
  }
}

export function createSQLiteWorkspaceOverviewProjection(input: {
  readonly sqlite: Database;
  readonly areaCatalog: WorkspaceOverviewAreaCatalog;
  readonly historyLimit?: number;
}): SQLiteWorkspaceOverviewProjection {
  return new SQLiteWorkspaceOverviewProjection(input);
}
