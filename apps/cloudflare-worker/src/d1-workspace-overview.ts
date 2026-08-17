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
import {
  parseEventState,
  parseWorkspaceEventSetState,
  projectCurrentEvent
} from '@jooevents/event';
import { OPERATION_SURFACES, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';

export const D1_WORKSPACE_OVERVIEW_AREA_CATALOG: WorkspaceOverviewAreaCatalog =
  workspaceOverviewAreaCatalogSchema.parse([
    {
      area: 'overview',
      status: 'available',
      capabilities: [
        'operation.history.list',
        'workspace.overview.read',
        'workspace.shell.summary.read'
      ]
    },
    { area: 'submissions', status: 'unavailable', reason: 'not_composed' },
    { area: 'review', status: 'unavailable', reason: 'not_composed' },
    { area: 'decisions', status: 'unavailable', reason: 'not_composed' },
    { area: 'speakers', status: 'unavailable', reason: 'not_composed' },
    { area: 'reviewers', status: 'unavailable', reason: 'not_composed' },
    {
      area: 'tasks',
      status: 'partial',
      availableCapabilities: ['task.board.read', 'task.mutation'],
      unavailableCapabilities: ['task.reminder.send']
    },
    {
      area: 'schedule',
      status: 'partial',
      availableCapabilities: ['schedule.placement.snapshot.read'],
      unavailableCapabilities: ['schedule.placement']
    },
    { area: 'messages', status: 'unavailable', reason: 'not_composed' },
    {
      area: 'templates',
      status: 'partial',
      availableCapabilities: [
        'template.artifact.change',
        'template.artifact.change.draft',
        'template.artifact.get',
        'template.artifact.list'
      ],
      unavailableCapabilities: [
        'template.edit.classify',
        'template.edit.model_choices.list',
        'template.edit.revise'
      ]
    },
    { area: 'forms', status: 'unavailable', reason: 'not_composed' },
    { area: 'embeds', status: 'unavailable', reason: 'not_composed' },
    {
      area: 'settings',
      status: 'partial',
      availableCapabilities: [
        'event.current.read',
        'event.settings.current.read',
        'event.settings.update',
        'field_registry.add',
        'field_registry.edit',
        'field_registry.move',
        'field_registry.remove',
        'field_registry.restore',
        'field_registry.snapshot.read',
        'program_vocabulary.snapshot.read',
        'workspace.api_key.create',
        'workspace.api_key.list',
        'workspace.api_key.revoke',
        'workspace.api_key.rotate',
        'workspace_team.invite',
        'workspace_team.members.read',
        'workspace_team.remove',
        'workspace_team.role_change'
      ],
      unavailableCapabilities: [
        'workspace_team.delivery.activate',
        'workspace_team.session_revocation.activate'
      ]
    }
  ]);

const EVENT_REQUIRED_AREAS = new Set([
  'submissions', 'review', 'decisions', 'speakers', 'reviewers', 'tasks', 'schedule',
  'messages', 'templates', 'forms', 'embeds'
]);
const ACTOR_ORDER = Object.freeze([
  'person', 'agent', 'participant', 'system', 'integration'
] satisfies readonly WorkspaceOverviewHistoryActor[]);

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
interface TotalCountRow { readonly total: number }
interface TriageCountRow { readonly arrived: number; readonly sorted: number }
interface ReviewCountRow {
  readonly rounds: number;
  readonly assignments: number;
  readonly committed: number;
}
interface DecisionCountRow { readonly decided: number; readonly submissions: number }
interface EngagementCountRow { readonly total: number; readonly confirmed: number }
interface SessionCountRow { readonly total: number; readonly placed: number }
interface CommunicationCountRow { readonly recipients: number; readonly sent: number }
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

export type D1WorkspaceOverviewErrorCode =
  | 'invalid_configuration'
  | 'workspace_event_set_missing'
  | 'count_evidence_corrupt'
  | 'history_evidence_corrupt'
  | 'projection_corrupt';

export class D1WorkspaceOverviewError extends Error {
  readonly name = 'D1WorkspaceOverviewError';

  constructor(
    readonly code: D1WorkspaceOverviewErrorCode,
    options?: { readonly cause?: unknown }
  ) {
    super(code, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as Value;
}

function one<Row>(result: D1Result<Row>, code: D1WorkspaceOverviewErrorCode): Row {
  const row = result.results[0];
  if (result.results.length !== 1 || row === undefined) {
    throw new D1WorkspaceOverviewError(code);
  }
  return row;
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new D1WorkspaceOverviewError('count_evidence_corrupt');
  }
  return value;
}

function statusCounts(row: StatusCountRow) {
  const parsed = {
    total: safeCount(row.total),
    draft: safeCount(row.draft),
    open: safeCount(row.open),
    closed: safeCount(row.closed)
  };
  if (parsed.total !== parsed.draft + parsed.open + parsed.closed) {
    throw new D1WorkspaceOverviewError('count_evidence_corrupt');
  }
  return parsed;
}

function vocabularyCounts(row: VocabularyCountRow) {
  const parsed = {
    total: safeCount(row.total),
    active: safeCount(row.active),
    retired: safeCount(row.retired)
  };
  if (parsed.total !== parsed.active + parsed.retired) {
    throw new D1WorkspaceOverviewError('count_evidence_corrupt');
  }
  return parsed;
}

function subsetCounts<TotalKey extends string, SubsetKey extends string>(
  row: Record<TotalKey | SubsetKey, unknown>,
  totalKey: TotalKey,
  subsetKey: SubsetKey
): Record<TotalKey | SubsetKey, number> {
  const total = safeCount(row[totalKey]);
  const subset = safeCount(row[subsetKey]);
  if (subset > total) throw new D1WorkspaceOverviewError('count_evidence_corrupt');
  return { [totalKey]: total, [subsetKey]: subset } as Record<TotalKey | SubsetKey, number>;
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
    default: throw new D1WorkspaceOverviewError('history_evidence_corrupt');
  }
}

function parseActor(row: HistoryRow): WorkspaceOverviewHistoryActor {
  try {
    const candidate = JSON.parse(row.actor_json) as unknown;
    if (!isRecord(candidate)) throw new D1WorkspaceOverviewError('history_evidence_corrupt');
    return actorCategory(candidate.kind);
  } catch (cause) {
    if (cause instanceof D1WorkspaceOverviewError) throw cause;
    throw new D1WorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
}

function parseResult(row: HistoryRow): EffectfulOperationResult {
  try {
    const result = effectfulOperationResultSchema.parse(JSON.parse(row.result_json));
    if (!('receipt' in result)
        || result.receipt.id !== row.id
        || result.receipt.operationName !== row.operation_name
        || result.receipt.operationVersion !== row.operation_version) {
      throw new D1WorkspaceOverviewError('history_evidence_corrupt');
    }
    return result;
  } catch (cause) {
    if (cause instanceof D1WorkspaceOverviewError) throw cause;
    throw new D1WorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
}

function historyOutcome(result: EffectfulOperationResult) {
  return result.kind === 'success'
    ? Object.freeze({ kind: 'success' as const })
    : Object.freeze({ kind: 'outcome' as const, outcome: result.outcome });
}

function historyThread(row: HistoryRow): WorkspaceOverviewHistoryThread {
  if (!Number.isSafeInteger(row.occurred_at_ms) || row.occurred_at_ms < 0
      || row.workspace_id.length !== 36 || row.id.length !== 36) {
    throw new D1WorkspaceOverviewError('history_evidence_corrupt');
  }
  let surface: OperationSurface;
  try {
    surface = operationSurfaceSchema.parse(row.surface);
  } catch (cause) {
    throw new D1WorkspaceOverviewError('history_evidence_corrupt', { cause });
  }
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
    latestReceipt: {
      id: row.id,
      operationName: row.operation_name,
      operationVersion: row.operation_version
    },
    latestOutcome: historyOutcome(result),
    evidence: { timelineEntries: 1, receipts: 1 }
  });
}

function history(rows: readonly HistoryRow[], limit: number): WorkspaceOverviewProjection['history'] {
  const all = rows.map(historyThread);
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

function eventProjection(
  setResult: D1Result<EventSetRow>,
  headResult: D1Result<EventHeadRow>
) {
  const setRow = one(setResult, 'workspace_event_set_missing');
  const set = parseWorkspaceEventSetState({
    workspaceId: setRow.workspace_id,
    version: setRow.version,
    currentEventId: setRow.current_event_id
  });
  if (set.currentEventId === null) {
    if (headResult.results.length !== 0) {
      throw new D1WorkspaceOverviewError('projection_corrupt');
    }
    return projectCurrentEvent(set, undefined);
  }
  const row = one(headResult, 'projection_corrupt');
  const event = parseEventState({
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
  if (event.id !== set.currentEventId) {
    throw new D1WorkspaceOverviewError('projection_corrupt');
  }
  return projectCurrentEvent(set, event);
}

function selected(table: string): string {
  return `FROM ${table}
    WHERE workspace_id = ? AND event_id = (
      SELECT current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?
    )`;
}

/** One transactional D1 snapshot for the registered workspace overview projection. */
export function createD1WorkspaceOverviewReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly areaCatalog?: WorkspaceOverviewAreaCatalog;
  readonly historyLimit?: number;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  let areaCatalog: WorkspaceOverviewAreaCatalog;
  try {
    areaCatalog = deepFreeze(workspaceOverviewAreaCatalogSchema.parse(
      input.areaCatalog ?? D1_WORKSPACE_OVERVIEW_AREA_CATALOG
    ));
  } catch (cause) {
    throw new D1WorkspaceOverviewError('invalid_configuration', { cause });
  }
  const historyLimit = input.historyLimit ?? 20;
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 50) {
    throw new D1WorkspaceOverviewError('invalid_configuration');
  }

  return Object.freeze({
    async readOverview(requestedWorkspaceId: WorkspaceId): Promise<WorkspaceOverviewProjection> {
      if (parseWorkspaceId(requestedWorkspaceId) !== workspaceId) {
        throw new D1WorkspaceOverviewError('workspace_event_set_missing');
      }
      const statements = [
        input.database.prepare(`SELECT workspace_id,version,current_event_id
          FROM event_spine_workspace_sets WHERE workspace_id = ?`).bind(workspaceId),
        input.database.prepare(`SELECT head.workspace_id,head.id,head.name,head.timezone,
          head.start_date,head.end_date,head.version,head.created_by_user_id,head.created_at_ms
          FROM event_spine_heads AS head
          JOIN event_spine_workspace_sets AS selected
            ON selected.workspace_id = head.workspace_id
           AND selected.current_event_id = head.id
          WHERE head.workspace_id = ?`).bind(workspaceId),
        input.database.prepare(`SELECT COUNT(*) AS total,
          COALESCE(SUM(status = 'draft'),0) AS draft,
          COALESCE(SUM(status = 'open'),0) AS open,
          COALESCE(SUM(status = 'closed'),0) AS closed
          ${selected('intake_form_heads')}`).bind(workspaceId, workspaceId),
        input.database.prepare(`SELECT COUNT(*) AS total
          ${selected('intake_submission_heads')}`).bind(workspaceId, workspaceId),
        ...(['rooms', 'tracks', 'formats'] as const).map((kind) => input.database.prepare(`
          SELECT COUNT(*) AS total,COALESCE(SUM(status = 'active'),0) AS active,
            COALESCE(SUM(status = 'retired'),0) AS retired
          ${selected(`program_vocabulary_${kind}`)}`).bind(workspaceId, workspaceId)),
        input.database.prepare(`SELECT COUNT(*) AS total FROM operation_log AS log
          WHERE log.workspace_id = ? AND (
            log.event_id = (SELECT current_event_id FROM event_spine_workspace_sets
              WHERE workspace_id = ?)
            OR (log.operation_name = 'event.create' AND json_extract(
              log.result_json,'$.data.event.id') = (SELECT current_event_id
              FROM event_spine_workspace_sets WHERE workspace_id = ?))
          )`).bind(workspaceId, workspaceId, workspaceId),
        input.database.prepare(`SELECT
          (SELECT COUNT(*) ${selected('submission_arrival_facts')}) AS arrived,
          (SELECT COUNT(*) ${selected('submission_triage_heads')}
            AND state <> 'inbox') AS sorted`).bind(
              workspaceId, workspaceId, workspaceId, workspaceId
            ),
        input.database.prepare(`SELECT
          (SELECT COUNT(*) FROM review_rounds
            WHERE workspace_id = ? AND event_id = (SELECT current_event_id
              FROM event_spine_workspace_sets WHERE workspace_id = ?)
              AND state <> 'discarded') AS rounds,
          (SELECT COUNT(*) FROM review_assignments AS assignment
            JOIN review_rounds AS round ON round.workspace_id = assignment.workspace_id
             AND round.event_id = assignment.event_id AND round.id = assignment.round_id
            WHERE assignment.workspace_id = ? AND assignment.event_id = (SELECT current_event_id
              FROM event_spine_workspace_sets WHERE workspace_id = ?)
              AND assignment.state = 'assigned' AND round.state <> 'discarded') AS assignments,
          (SELECT COUNT(*) FROM review_heads AS head
            JOIN review_assignments AS assignment ON assignment.workspace_id = head.workspace_id
             AND assignment.event_id = head.event_id AND assignment.id = head.assignment_id
            JOIN review_rounds AS round ON round.workspace_id = assignment.workspace_id
             AND round.event_id = assignment.event_id AND round.id = assignment.round_id
            WHERE head.workspace_id = ? AND head.event_id = (SELECT current_event_id
              FROM event_spine_workspace_sets WHERE workspace_id = ?)
              AND assignment.state = 'assigned' AND round.state <> 'discarded') AS committed`)
          .bind(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId),
        input.database.prepare(`SELECT
          (SELECT COUNT(*) ${selected('decision_heads')}) AS decided,
          (SELECT COUNT(*) ${selected('intake_submission_heads')}) AS submissions`)
          .bind(workspaceId, workspaceId, workspaceId, workspaceId),
        input.database.prepare(`SELECT COUNT(*) AS total,
          COALESCE(SUM(state = 'confirmed'),0) AS confirmed
          ${selected('engagement_heads')} AND state IN ('invited','confirmed')`)
          .bind(workspaceId, workspaceId),
        input.database.prepare(`SELECT
          (SELECT COUNT(*) ${selected('sessions')}) AS total,
          (SELECT COUNT(DISTINCT session_id) ${selected('schedule_occurrences')}) AS placed`)
          .bind(workspaceId, workspaceId, workspaceId, workspaceId),
        input.database.prepare(`SELECT
          (SELECT COUNT(*) ${selected('communication_message_releases')}) AS recipients,
          (SELECT COUNT(DISTINCT delivery.release_id)
            FROM communication_outbound_delivery_heads AS delivery
            JOIN communication_message_releases AS release
              ON release.release_id = delivery.release_id
            WHERE delivery.workspace_id = ? AND delivery.event_id = (SELECT current_event_id
              FROM event_spine_workspace_sets WHERE workspace_id = ?)
              AND delivery.state = 'accepted') AS sent`)
          .bind(workspaceId, workspaceId, workspaceId, workspaceId),
        input.database.prepare(`WITH selected AS (
          SELECT current_event_id AS event_id FROM event_spine_workspace_sets
            WHERE workspace_id = ?
        )
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
            THEN json_extract(log.result_json,'$.data.event.id') ELSE log.event_id END AS event_id,
          log.occurred_at_ms,log.operation_name,log.operation_version,
          log.surface,log.result_json,log.actor_json
        FROM operation_log AS log CROSS JOIN selected
        WHERE log.workspace_id = ? AND (
          log.operation_name LIKE 'workspace_team.%'
          OR (selected.event_id IS NULL AND log.operation_name = 'event.create')
          OR (selected.event_id IS NOT NULL AND (
            log.event_id = selected.event_id
            OR (log.operation_name = 'event.create' AND json_extract(
              log.result_json,'$.data.event.id') = selected.event_id)
          ))
        )
        ORDER BY log.occurred_at_ms DESC,log.id ASC`)
          .bind(workspaceId, workspaceId)
      ];
      const results = await input.database.batch(statements);
      const event = eventProjection(
        results[0] as D1Result<EventSetRow>,
        results[1] as D1Result<EventHeadRow>
      );
      const eventId = event.kind === 'current_event' ? event.event.id : null;
      const unavailable = { kind: 'unavailable' as const, reason: 'event_required' as const };
      let metrics: WorkspaceOverviewProjection['metrics'];
      if (eventId === null) {
        metrics = {
          forms: unavailable,
          submissions: unavailable,
          programVocabulary: unavailable,
          operations: unavailable,
          triage: unavailable,
          reviews: unavailable,
          decisions: unavailable,
          engagements: unavailable,
          sessions: unavailable,
          communications: unavailable
        };
      } else {
        const forms = statusCounts(one(
          results[2] as D1Result<StatusCountRow>, 'count_evidence_corrupt'
        ));
        const submissions = one(
          results[3] as D1Result<TotalCountRow>, 'count_evidence_corrupt'
        );
        const rooms = vocabularyCounts(one(
          results[4] as D1Result<VocabularyCountRow>, 'count_evidence_corrupt'
        ));
        const tracks = vocabularyCounts(one(
          results[5] as D1Result<VocabularyCountRow>, 'count_evidence_corrupt'
        ));
        const formats = vocabularyCounts(one(
          results[6] as D1Result<VocabularyCountRow>, 'count_evidence_corrupt'
        ));
        const operations = one(
          results[7] as D1Result<TotalCountRow>, 'count_evidence_corrupt'
        );
        const triage = subsetCounts(one(
          results[8] as D1Result<TriageCountRow>, 'count_evidence_corrupt'
        ), 'arrived', 'sorted');
        const reviews = one(
          results[9] as D1Result<ReviewCountRow>, 'count_evidence_corrupt'
        );
        const reviewCounts = {
          rounds: safeCount(reviews.rounds),
          ...subsetCounts(reviews, 'assignments', 'committed')
        };
        const decisions = one(
          results[10] as D1Result<DecisionCountRow>, 'count_evidence_corrupt'
        );
        const decided = safeCount(decisions.decided);
        const decisionPopulation = safeCount(decisions.submissions);
        if (decided > decisionPopulation) {
          throw new D1WorkspaceOverviewError('count_evidence_corrupt');
        }
        const engagements = subsetCounts(one(
          results[11] as D1Result<EngagementCountRow>, 'count_evidence_corrupt'
        ), 'total', 'confirmed');
        const sessions = subsetCounts(one(
          results[12] as D1Result<SessionCountRow>, 'count_evidence_corrupt'
        ), 'total', 'placed');
        const communications = subsetCounts(one(
          results[13] as D1Result<CommunicationCountRow>, 'count_evidence_corrupt'
        ), 'recipients', 'sent');
        metrics = {
          forms: { kind: 'exact', ...forms },
          submissions: { kind: 'exact', total: safeCount(submissions.total) },
          programVocabulary: { kind: 'exact', rooms, tracks, formats },
          operations: { kind: 'exact', total: safeCount(operations.total) },
          triage: { kind: 'exact', ...triage },
          reviews: { kind: 'exact', ...reviewCounts },
          decisions: {
            kind: 'exact',
            decided,
            undecided: decisionPopulation - decided
          },
          engagements: { kind: 'exact', ...engagements },
          sessions: { kind: 'exact', ...sessions },
          communications: { kind: 'exact', ...communications }
        };
      }
      try {
        return deepFreeze(workspaceOverviewProjectionSchema.parse({
          schemaVersion: 1,
          event,
          areas: eventId === null ? noEventAreaCatalog(areaCatalog) : areaCatalog,
          metrics,
          history: history(
            (results[14] as D1Result<HistoryRow>).results,
            historyLimit
          )
        }));
      } catch (cause) {
        if (cause instanceof D1WorkspaceOverviewError) throw cause;
        throw new D1WorkspaceOverviewError('projection_corrupt', { cause });
      }
    }
  });
}
