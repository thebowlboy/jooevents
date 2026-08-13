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

  constructor(
    readonly code: SQLiteWorkspaceOverviewErrorCode,
    options?: { readonly cause?: unknown }
  ) {
    super(code, options);
  }
}

const REQUIRED_TABLES = Object.freeze([
  'changeset_heads',
  'changeset_lifecycle_timeline_projection',
  'event_create_draft_timeline',
  'event_creation_changeset_timeline',
  'event_settings_changeset_timeline',
  'event_settings_update_draft_timeline',
  'event_spine_timeline_projection',
  'event_spine_workspace_sets',
  'field_registry_changeset_timeline',
  'field_registry_draft_timeline',
  'foundation_trial_operation_audits',
  'foundation_trial_operation_receipts',
  'intake_form_changeset_timeline',
  'intake_form_draft_timeline',
  'intake_form_heads',
  'intake_submission_heads',
  'program_vocabulary_draft_timeline',
  'program_vocabulary_formats',
  'program_vocabulary_rooms',
  'program_vocabulary_tracks',
  'submission_triage_changeset_timeline',
  'submission_triage_draft_timeline',
  'workspace_team_changeset_timeline',
  'workspace_team_draft_timeline'
]);

const EVENT_REQUIRED_AREAS = new Set([
  'submissions',
  'review',
  'decisions',
  'speakers',
  'reviewers',
  'tasks',
  'schedule',
  'messages',
  'templates',
  'forms',
  'embeds'
]);

const ACTOR_ORDER = Object.freeze([
  'person',
  'agent',
  'participant',
  'system',
  'integration'
] satisfies readonly WorkspaceOverviewHistoryActor[]);

interface ExistingTableRow {
  readonly name: string;
}

interface StatusCountRow {
  readonly total: number;
  readonly draft: number;
  readonly open: number;
  readonly closed: number;
}

interface VocabularyCountRow {
  readonly total: number;
  readonly active: number;
  readonly retired: number;
}

interface ChangesetCountRow {
  readonly total: number;
  readonly draft: number;
  readonly proposed: number;
  readonly committed: number;
  readonly discarded: number;
}

interface TotalCountRow {
  readonly total: number;
}

interface HistoryEvidenceRow {
  readonly timeline_id: string;
  readonly domain: WorkspaceOverviewHistoryDomain;
  readonly receipt_id: string;
  readonly workspace_id: string;
  readonly event_id: string | null;
  readonly changeset_id: string | null;
  readonly occurred_at_ms: number;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: string;
  readonly result_json: string;
  readonly audit_record_json: string | null;
  readonly changeset_status: string | null;
	readonly changeset_event_id: string | null;
}

interface ParsedHistoryEvidence {
  readonly row: HistoryEvidenceRow;
  readonly actor: WorkspaceOverviewHistoryActor;
  readonly surface: OperationSurface;
  readonly result: EffectfulOperationResult;
}

interface MutableHistoryGroup {
  readonly id: string;
  readonly domain: WorkspaceOverviewHistoryDomain;
  readonly changesetId: string | null;
  readonly receiptIds: Set<string>;
  readonly actors: Set<WorkspaceOverviewHistoryActor>;
  readonly surfaces: Set<OperationSurface>;
  readonly changesetStatus: string | null;
  firstOccurredAtMs: number;
  lastOccurredAtMs: number;
  latest: ParsedHistoryEvidence;
  timelineEntries: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as Value;
}

function assertSafeCount(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  }
  return value;
}

function statusCounts(row: StatusCountRow | null): StatusCountRow {
  if (!row) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  const parsed = {
    total: assertSafeCount(row.total),
    draft: assertSafeCount(row.draft),
    open: assertSafeCount(row.open),
    closed: assertSafeCount(row.closed)
  };
  if (parsed.total !== parsed.draft + parsed.open + parsed.closed) {
    throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  }
  return parsed;
}

function vocabularyCounts(row: VocabularyCountRow | null): VocabularyCountRow {
  if (!row) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  const parsed = {
    total: assertSafeCount(row.total),
    active: assertSafeCount(row.active),
    retired: assertSafeCount(row.retired)
  };
  if (parsed.total !== parsed.active + parsed.retired) {
    throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  }
  return parsed;
}

function changesetCounts(row: ChangesetCountRow | null): ChangesetCountRow {
  if (!row) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  const parsed = {
    total: assertSafeCount(row.total),
    draft: assertSafeCount(row.draft),
    proposed: assertSafeCount(row.proposed),
    committed: assertSafeCount(row.committed),
    discarded: assertSafeCount(row.discarded)
  };
  if (
    parsed.total !== parsed.draft + parsed.proposed + parsed.committed + parsed.discarded
  ) {
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

function parseAuditActor(row: HistoryEvidenceRow): WorkspaceOverviewHistoryActor {
  if (row.audit_record_json === null) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.audit_record_json);
  } catch (cause) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
	const authorityEventId = row.changeset_id === null ? row.event_id : row.changeset_event_id;
	if (
    !isRecord(candidate)
    || candidate.disposition !== 'terminal_new'
    || candidate.receiptId !== row.receipt_id
    || candidate.surface !== row.surface
    || !isRecord(candidate.operation)
    || candidate.operation.name !== row.operation_name
    || candidate.operation.version !== row.operation_version
    || !isRecord(candidate.scope)
    || candidate.scope.workspaceId !== row.workspace_id
		|| (authorityEventId === null
      ? candidate.scope.eventId !== undefined
			: candidate.scope.eventId !== undefined && candidate.scope.eventId !== authorityEventId)
    || !isRecord(candidate.actor)
  ) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  }
  return actorCategory(candidate.actor.kind);
}

function parseEvidence(row: HistoryEvidenceRow): ParsedHistoryEvidence {
  if (
    !Number.isSafeInteger(row.occurred_at_ms)
    || row.occurred_at_ms < 0
    || row.workspace_id.length !== 36
    || (row.domain === 'workspace_team'
      ? row.event_id !== null
      : typeof row.event_id !== 'string' || row.event_id.length !== 36)
    || row.receipt_id.length !== 36
		|| (row.changeset_id !== null && row.changeset_status === null)
		|| (row.changeset_event_id !== null && row.changeset_event_id !== row.event_id)
		|| (row.domain === 'workspace_team' && row.changeset_event_id !== null)
  ) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  }
  let result: EffectfulOperationResult;
  try {
    result = effectfulOperationResultSchema.parse(JSON.parse(row.result_json));
  } catch (cause) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
  if (
    !('receipt' in result)
    || result.receipt.id !== row.receipt_id
    || result.receipt.operationName !== row.operation_name
    || result.receipt.operationVersion !== row.operation_version
  ) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
  }
  let surface: OperationSurface;
  try {
    surface = operationSurfaceSchema.parse(row.surface);
  } catch (cause) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
  return Object.freeze({
    row,
    actor: parseAuditActor(row),
    surface,
    result
  });
}

function isLater(left: HistoryEvidenceRow, right: HistoryEvidenceRow): boolean {
  return left.occurred_at_ms > right.occurred_at_ms
    || (
      left.occurred_at_ms === right.occurred_at_ms
      && left.timeline_id > right.timeline_id
    );
}

function isoInstant(milliseconds: number): string {
  try {
    return new Date(milliseconds).toISOString();
  } catch (cause) {
    throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
}

function historyOutcome(result: EffectfulOperationResult) {
  return result.kind === 'success'
    ? Object.freeze({ kind: 'success' as const })
    : Object.freeze({ kind: 'outcome' as const, outcome: result.outcome });
}

function threadFromGroup(group: MutableHistoryGroup): WorkspaceOverviewHistoryThread {
  const latest = group.latest.row;
  const root = group.changesetId === null
    ? { kind: 'operation' as const, receiptId: latest.receipt_id }
    : {
        kind: 'changeset' as const,
        changesetId: group.changesetId,
        status: group.changesetStatus
      };
  return workspaceOverviewHistoryThreadSchema.parse({
    id: group.id,
    domain: group.domain,
    root,
    firstOccurredAt: isoInstant(group.firstOccurredAtMs),
    lastOccurredAt: isoInstant(group.lastOccurredAtMs),
    actors: ACTOR_ORDER.filter((actor) => group.actors.has(actor)),
    surfaces: OPERATION_SURFACES.filter((surface) => group.surfaces.has(surface)),
    latestOperation: {
      name: latest.operation_name,
      version: latest.operation_version
    },
    latestReceipt: {
      id: latest.receipt_id,
      operationName: latest.operation_name,
      operationVersion: latest.operation_version
    },
    latestOutcome: historyOutcome(group.latest.result),
    evidence: {
      timelineEntries: group.timelineEntries,
      receipts: group.receiptIds.size
    }
  });
}

const HISTORY_SQL = `
WITH timeline_evidence AS (
  SELECT timeline_id, 'event' AS domain, receipt_id, workspace_id, event_id,
         NULL AS changeset_id, occurred_at_ms
    FROM event_spine_timeline_projection
  UNION ALL
  SELECT timeline_id, 'event', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM event_create_draft_timeline
  UNION ALL
  SELECT timeline_id, 'event', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM event_creation_changeset_timeline
  UNION ALL
  SELECT timeline_id, 'event', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM event_settings_update_draft_timeline
  UNION ALL
  SELECT timeline_id, 'event', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM event_settings_changeset_timeline
  UNION ALL
  SELECT timeline_id, 'program_vocabulary', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM program_vocabulary_draft_timeline
  UNION ALL
  SELECT timeline_id, 'program_vocabulary', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM changeset_lifecycle_timeline_projection
  UNION ALL
  SELECT timeline_id, 'forms', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM intake_form_draft_timeline
  UNION ALL
  SELECT timeline_id, 'forms', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM intake_form_changeset_timeline
  UNION ALL
  SELECT timeline_id, 'field_registry', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM field_registry_draft_timeline
  UNION ALL
  SELECT timeline_id, 'field_registry', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM field_registry_changeset_timeline
  UNION ALL
  SELECT timeline_id, 'submission_triage', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM submission_triage_draft_timeline
  UNION ALL
  SELECT timeline_id, 'submission_triage', receipt_id, workspace_id, event_id,
         changeset_id, occurred_at_ms
    FROM submission_triage_changeset_timeline
  UNION ALL
  SELECT timeline_id, 'workspace_team', receipt_id, workspace_id, NULL AS event_id,
         changeset_id, occurred_at_ms
    FROM workspace_team_draft_timeline
  UNION ALL
  SELECT timeline_id, 'workspace_team', receipt_id, workspace_id, NULL AS event_id,
         changeset_id, occurred_at_ms
    FROM workspace_team_changeset_timeline
)
SELECT evidence.timeline_id, evidence.domain, evidence.receipt_id,
       evidence.workspace_id, evidence.event_id, evidence.changeset_id,
       evidence.occurred_at_ms, receipt.operation_name, receipt.operation_version,
       receipt.surface, receipt.result_json, audit.record_json AS audit_record_json,
       head.status AS changeset_status, head.event_id AS changeset_event_id
  FROM timeline_evidence AS evidence
  JOIN foundation_trial_operation_receipts AS receipt
    ON receipt.id = evidence.receipt_id
  LEFT JOIN foundation_trial_operation_audits AS audit
    ON audit.receipt_id = evidence.receipt_id AND audit.disposition = 'terminal_new'
  LEFT JOIN changeset_heads AS head
    ON head.changeset_id = evidence.changeset_id
 WHERE evidence.workspace_id = ?
   AND (
     (? IS NULL AND evidence.domain = 'event')
     OR (? IS NOT NULL AND evidence.event_id = ?)
     OR evidence.domain = 'workspace_team'
   )
 ORDER BY evidence.occurred_at_ms ASC, evidence.timeline_id ASC
`;

function groupHistory(
  rows: readonly HistoryEvidenceRow[],
  limit: number
): WorkspaceOverviewProjection['history'] {
  const groups = new Map<string, MutableHistoryGroup>();
  for (const raw of rows) {
    const evidence = parseEvidence(raw);
    const rootId = raw.changeset_id ?? raw.receipt_id;
    const id = raw.changeset_id === null
      ? `operation:${rootId}`
      : `changeset:${rootId}`;
    const existing = groups.get(id);
    if (!existing) {
      if (
        raw.changeset_id !== null
        && !['draft', 'proposed', 'committed', 'discarded'].includes(raw.changeset_status ?? '')
      ) {
        throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
      }
      groups.set(id, {
        id,
        domain: raw.domain,
        changesetId: raw.changeset_id,
        receiptIds: new Set([raw.receipt_id]),
        actors: new Set([evidence.actor]),
        surfaces: new Set([evidence.surface]),
        changesetStatus: raw.changeset_status,
        firstOccurredAtMs: raw.occurred_at_ms,
        lastOccurredAtMs: raw.occurred_at_ms,
        latest: evidence,
        timelineEntries: 1
      });
      continue;
    }
    if (
      existing.domain !== raw.domain
      || existing.changesetId !== raw.changeset_id
      || existing.changesetStatus !== raw.changeset_status
    ) {
      throw new SQLiteWorkspaceOverviewError('history_evidence_corrupt');
    }
    existing.receiptIds.add(raw.receipt_id);
    existing.actors.add(evidence.actor);
    existing.surfaces.add(evidence.surface);
    existing.timelineEntries += 1;
    existing.firstOccurredAtMs = Math.min(existing.firstOccurredAtMs, raw.occurred_at_ms);
    existing.lastOccurredAtMs = Math.max(existing.lastOccurredAtMs, raw.occurred_at_ms);
    if (isLater(raw, existing.latest.row)) existing.latest = evidence;
  }

  const all = [...groups.values()].map(threadFromGroup).sort((left, right) => {
    const byTime = Date.parse(right.lastOccurredAt) - Date.parse(left.lastOccurredAt);
    return byTime === 0 ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : byTime;
  });
  const threads = all.slice(0, limit);
  return {
    total: all.length,
    truncated: all.length > threads.length,
    threads
  };
}

function noEventAreaCatalog(catalog: WorkspaceOverviewAreaCatalog): WorkspaceOverviewAreaCatalog {
  return workspaceOverviewAreaCatalogSchema.parse(catalog.map((entry) => {
    if (
      EVENT_REQUIRED_AREAS.has(entry.area)
      && (entry.status === 'available' || entry.status === 'partial')
    ) {
      return { area: entry.area, status: 'locked', reason: 'event_required' };
    }
    return entry;
  }));
}

function assertRequiredTables(sqlite: Database): void {
  const rows = sqlite.query<ExistingTableRow, []>(`
    SELECT name
      FROM sqlite_schema
     WHERE type = 'table'
     ORDER BY name
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
    try {
      this.#catalog = deepFreeze(workspaceOverviewAreaCatalogSchema.parse(input.areaCatalog));
    } catch (cause) {
      throw new SQLiteWorkspaceOverviewError('invalid_configuration', { cause });
    }
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
    return this.input.sqlite.inTransaction
      ? read()
      : this.input.sqlite.transaction(read).deferred();
  }

  #readSnapshot(workspaceId: WorkspaceId): WorkspaceOverviewProjection {
    const event = new SQLiteEventSpineRepository(this.input.sqlite)
      .readCurrentEventProjection(workspaceId);
    if (!event) throw new SQLiteWorkspaceOverviewError('workspace_event_set_missing');

    const eventId = event.kind === 'current_event' ? event.event.id : null;
    const areas = eventId === null ? noEventAreaCatalog(this.#catalog) : this.#catalog;
    const metrics = eventId === null
      ? {
          forms: { kind: 'unavailable' as const, reason: 'event_required' as const },
          submissions: { kind: 'unavailable' as const, reason: 'event_required' as const },
          programVocabulary: {
            kind: 'unavailable' as const,
            reason: 'event_required' as const
          },
          changesets: { kind: 'unavailable' as const, reason: 'event_required' as const }
        }
      : this.#readMetrics(workspaceId, eventId);
    const rows = this.input.sqlite.query<
      HistoryEvidenceRow,
      [WorkspaceId, string | null, string | null, string | null]
    >(HISTORY_SQL).all(workspaceId, eventId, eventId, eventId);

    try {
      return deepFreeze(workspaceOverviewProjectionSchema.parse({
        schemaVersion: 1,
        event,
        areas,
        metrics,
        history: groupHistory(rows, this.#historyLimit)
      }));
    } catch (cause) {
      if (cause instanceof SQLiteWorkspaceOverviewError) throw cause;
      throw new SQLiteWorkspaceOverviewError('projection_corrupt', { cause });
    }
  }

  #readMetrics(workspaceId: WorkspaceId, eventId: string) {
    const forms = statusCounts(this.input.sqlite.query<StatusCountRow, [WorkspaceId, string]>(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(status = 'draft'), 0) AS draft,
             COALESCE(SUM(status = 'open'), 0) AS open,
             COALESCE(SUM(status = 'closed'), 0) AS closed
        FROM intake_form_heads
       WHERE workspace_id = ? AND event_id = ?
    `).get(workspaceId, eventId) ?? null);
    const submissions = this.input.sqlite.query<TotalCountRow, [WorkspaceId, string]>(`
      SELECT COUNT(*) AS total
        FROM intake_submission_heads
       WHERE workspace_id = ? AND event_id = ?
    `).get(workspaceId, eventId);
    if (!submissions) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    const vocabulary = (table: 'rooms' | 'tracks' | 'formats') => vocabularyCounts(
      this.input.sqlite.query<VocabularyCountRow, [WorkspaceId, string]>(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(status = 'active'), 0) AS active,
               COALESCE(SUM(status = 'retired'), 0) AS retired
          FROM program_vocabulary_${table}
         WHERE workspace_id = ? AND event_id = ?
      `).get(workspaceId, eventId) ?? null
    );
    const changesets = changesetCounts(
      this.input.sqlite.query<ChangesetCountRow, [WorkspaceId, string]>(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(status = 'draft'), 0) AS draft,
               COALESCE(SUM(status = 'proposed'), 0) AS proposed,
               COALESCE(SUM(status = 'committed'), 0) AS committed,
               COALESCE(SUM(status = 'discarded'), 0) AS discarded
          FROM changeset_heads
         WHERE workspace_id = ? AND event_id = ?
      `).get(workspaceId, eventId) ?? null
    );
    return {
      forms: { kind: 'exact' as const, ...forms },
      submissions: { kind: 'exact' as const, total: assertSafeCount(submissions.total) },
      programVocabulary: {
        kind: 'exact' as const,
        rooms: vocabulary('rooms'),
        tracks: vocabulary('tracks'),
        formats: vocabulary('formats')
      },
      changesets: { kind: 'exact' as const, ...changesets }
    };
  }
}

/** Browser-independent constructor shared by server composition and deterministic scenarios. */
export function createSQLiteWorkspaceOverviewProjection(input: {
  readonly sqlite: Database;
  readonly areaCatalog: WorkspaceOverviewAreaCatalog;
  readonly historyLimit?: number;
}): SQLiteWorkspaceOverviewProjection {
  return new SQLiteWorkspaceOverviewProjection(input);
}
