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
import { SQLiteCommunicationDeliveryObservationRepository }
  from './communications/delivery-observations';

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
  'submission_arrival_facts',
  'submission_triage_heads',
  'program_vocabulary_formats',
  'program_vocabulary_rooms',
  'program_vocabulary_tracks',
  'review_rounds',
  'review_assignments',
  'review_heads',
  'review_assignment_vacancy_resolutions',
  'decision_heads',
  'engagement_heads',
  'task_assignments',
  'sessions',
  'schedule_occurrences',
  'communication_message_releases',
  'communication_outbound_delivery_heads',
  'communication_outbound_delivery_attempts',
  'communication_delivery_observations'
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
interface TriageCountRow { readonly arrived: number; readonly sorted: number; }
interface ReviewCountRow {
  readonly rounds: number;
  readonly assignments: number;
  readonly committed: number;
}
interface DecisionCountRow { readonly decided: number; readonly submissions: number; }
interface EngagementCountRow { readonly total: number; readonly confirmed: number; }
interface SessionCountRow { readonly total: number; readonly placed: number; }
interface CommunicationCountRow { readonly recipients: number; readonly sent: number; }
interface AttentionCountRow {
  readonly results_not_sent: number;
  readonly overdue_speaker_tasks: number;
  readonly uncovered_reviews: number;
  readonly sessions_awaiting_placement: number;
  readonly sessions_missing_speakers: number;
}
interface DeliveryIdRow { readonly delivery_id: string; readonly state: string; }
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
function subsetCounts<TotalKey extends string, SubsetKey extends string>(
  row: Record<TotalKey | SubsetKey, unknown> | null,
  totalKey: TotalKey,
  subsetKey: SubsetKey
): Record<TotalKey | SubsetKey, number> {
  if (!row) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
  const total = safeCount(row[totalKey]);
  const subset = safeCount(row[subsetKey]);
  if (subset > total) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
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
    readonly now?: () => string;
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
      operations: { kind: 'unavailable' as const, reason: 'event_required' as const },
      triage: { kind: 'unavailable' as const, reason: 'event_required' as const },
      reviews: { kind: 'unavailable' as const, reason: 'event_required' as const },
      reviewers: { kind: 'unavailable' as const, reason: 'event_required' as const },
      decisions: { kind: 'unavailable' as const, reason: 'event_required' as const },
      engagements: { kind: 'unavailable' as const, reason: 'event_required' as const },
      sessions: { kind: 'unavailable' as const, reason: 'event_required' as const },
      communications: { kind: 'unavailable' as const, reason: 'event_required' as const },
      templates: { kind: 'unavailable' as const, reason: 'event_required' as const }
    } : this.#readMetrics(workspaceId, eventId, this.input.now?.() ?? new Date().toISOString());
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

  #readMetrics(workspaceId: WorkspaceId, eventId: string, now: string) {
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
    const triage = subsetCounts(
      this.input.sqlite.query<TriageCountRow,
        [WorkspaceId, string, WorkspaceId, string]>(`
        SELECT
          (SELECT COUNT(*) FROM submission_arrival_facts
            WHERE workspace_id = ? AND event_id = ?) AS arrived,
          (SELECT COUNT(*) FROM submission_triage_heads
            WHERE workspace_id = ? AND event_id = ? AND state <> 'inbox') AS sorted
      `).get(workspaceId, eventId, workspaceId, eventId) ?? null,
      'arrived',
      'sorted'
    );
    const reviews = this.input.sqlite.query<ReviewCountRow, [WorkspaceId, string,
      WorkspaceId, string, WorkspaceId, string]>(`
      SELECT
        (SELECT COUNT(*) FROM review_rounds
          WHERE workspace_id = ? AND event_id = ? AND state <> 'discarded') AS rounds,
        (SELECT COUNT(*) FROM review_assignments AS assignment
          JOIN review_rounds AS round
            ON round.workspace_id = assignment.workspace_id
           AND round.event_id = assignment.event_id
           AND round.id = assignment.round_id
         WHERE assignment.workspace_id = ? AND assignment.event_id = ?
           AND assignment.state = 'assigned' AND round.state <> 'discarded') AS assignments,
        (SELECT COUNT(*) FROM review_heads AS head
          JOIN review_assignments AS assignment
            ON assignment.workspace_id = head.workspace_id
           AND assignment.event_id = head.event_id
           AND assignment.id = head.assignment_id
          JOIN review_rounds AS round
            ON round.workspace_id = assignment.workspace_id
           AND round.event_id = assignment.event_id
           AND round.id = assignment.round_id
         WHERE head.workspace_id = ? AND head.event_id = ?
           AND assignment.state = 'assigned' AND round.state <> 'discarded') AS committed
    `).get(workspaceId, eventId, workspaceId, eventId, workspaceId, eventId);
    if (!reviews) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    const reviewCounts = {
      rounds: safeCount(reviews.rounds),
      ...subsetCounts(reviews, 'assignments', 'committed')
    };
    const reviewers = this.input.sqlite.query<TotalCountRow, [WorkspaceId, string]>(`
      SELECT COUNT(*) AS total FROM reviewer_roster_records
       WHERE workspace_id = ? AND event_id = ? AND state = 'included'
    `).get(workspaceId, eventId);
    if (!reviewers) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    const decisions = this.input.sqlite.query<DecisionCountRow,
      [WorkspaceId, string, WorkspaceId, string]>(`
      SELECT
        (SELECT COUNT(*) FROM decision_heads
          WHERE workspace_id = ? AND event_id = ?) AS decided,
        (SELECT COUNT(*) FROM intake_submission_heads
          WHERE workspace_id = ? AND event_id = ?) AS submissions
    `).get(workspaceId, eventId, workspaceId, eventId);
    if (!decisions) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    const decided = safeCount(decisions.decided);
    const decisionPopulation = safeCount(decisions.submissions);
    if (decided > decisionPopulation) {
      throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    }
    const engagements = subsetCounts(
      this.input.sqlite.query<EngagementCountRow, [WorkspaceId, string]>(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(state = 'confirmed'), 0) AS confirmed
          FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ?
           AND state IN ('invited', 'confirmed')
      `).get(workspaceId, eventId) ?? null,
      'total',
      'confirmed'
    );
    const sessions = subsetCounts(
      this.input.sqlite.query<SessionCountRow, [WorkspaceId, string, WorkspaceId, string]>(`
        SELECT
          (SELECT COUNT(*) FROM sessions
            WHERE workspace_id = ? AND event_id = ?) AS total,
          (SELECT COUNT(DISTINCT session_id) FROM schedule_occurrences
            WHERE workspace_id = ? AND event_id = ?) AS placed
      `).get(workspaceId, eventId, workspaceId, eventId) ?? null,
      'total',
      'placed'
    );
    const communications = subsetCounts(
      this.input.sqlite.query<CommunicationCountRow,
        [WorkspaceId, string, WorkspaceId, string]>(`
        SELECT
          (SELECT COUNT(*) FROM communication_message_releases
            WHERE workspace_id = ? AND event_id = ?) AS recipients,
          (SELECT COUNT(DISTINCT delivery.release_id)
             FROM communication_outbound_delivery_heads AS delivery
             JOIN communication_message_releases AS release
               ON release.release_id = delivery.release_id
            WHERE delivery.workspace_id = ? AND delivery.event_id = ?
              AND delivery.state = 'accepted') AS sent
      `).get(workspaceId, eventId, workspaceId, eventId) ?? null,
      'recipients',
      'sent'
    );
    const attention = this.input.sqlite.query<AttentionCountRow,
      [WorkspaceId, string, WorkspaceId, string, string, WorkspaceId, string,
       WorkspaceId, string, WorkspaceId, string, WorkspaceId, string]>(`
      SELECT
        (SELECT COUNT(*)
           FROM decision_heads AS decision
          WHERE decision.workspace_id = ? AND decision.event_id = ?
            AND decision.state IN ('accepted', 'declined')
            AND NOT EXISTS (
              SELECT 1
                FROM communication_message_releases AS release
                JOIN communication_outbound_delivery_heads AS delivery
                  ON delivery.workspace_id = release.workspace_id
                 AND delivery.event_id = release.event_id
                 AND delivery.release_id = release.release_id
               WHERE release.workspace_id = decision.workspace_id
                 AND release.event_id = decision.event_id
                 AND release.recipient_ref_id = decision.submission_id
                 AND release.purpose_key = 'decision_notification'
                 AND delivery.state = 'accepted'
                 AND release.created_at >= strftime(
                   '%Y-%m-%dT%H:%M:%fZ', decision.decided_at_ms / 1000.0, 'unixepoch'
                 )
                 AND delivery.updated_at_ms >= decision.decided_at_ms
            )) AS results_not_sent,
        (SELECT COUNT(*)
           FROM task_assignments AS assignment
          WHERE assignment.workspace_id = ? AND assignment.event_id = ?
            AND assignment.state IN ('pending', 'received_pending_check')
            AND COALESCE(
              json_extract(assignment.assignment_json, '$.deadlineOverride.reference.effectiveAt'),
              json_extract(assignment.assignment_json, '$.deadline.reference.effectiveAt')
            ) < ?) AS overdue_speaker_tasks,
        (SELECT COUNT(*)
           FROM review_assignments AS assignment
           JOIN review_rounds AS round
             ON round.workspace_id = assignment.workspace_id
            AND round.event_id = assignment.event_id
            AND round.id = assignment.round_id
          WHERE assignment.workspace_id = ? AND assignment.event_id = ?
            AND assignment.state = 'stepped_back'
            AND round.state <> 'discarded'
            AND NOT EXISTS (
              SELECT 1 FROM review_assignment_vacancy_resolutions AS resolution
               WHERE resolution.workspace_id = assignment.workspace_id
                 AND resolution.event_id = assignment.event_id
                 AND resolution.vacated_assignment_id = assignment.id
            )) AS uncovered_reviews,
        ((SELECT COUNT(*) FROM sessions
           WHERE workspace_id = ? AND event_id = ?)
          - (SELECT COUNT(DISTINCT session_id) FROM schedule_occurrences
              WHERE workspace_id = ? AND event_id = ?)) AS sessions_awaiting_placement,
        (SELECT COUNT(*) FROM sessions
          WHERE workspace_id = ? AND event_id = ?
            AND json_array_length(roster_json, '$.participants') = 0) AS sessions_missing_speakers
    `).get(
      workspaceId, eventId,
      workspaceId, eventId, now,
      workspaceId, eventId,
      workspaceId, eventId, workspaceId, eventId,
      workspaceId, eventId
    );
    if (!attention) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    const possibleFailures = this.input.sqlite.query<DeliveryIdRow, [WorkspaceId, string]>(`
      SELECT delivery_id, state
        FROM communication_outbound_delivery_heads
       WHERE workspace_id = ? AND event_id = ?
         AND (
           state IN ('known_rejected_terminal', 'known_rejected_safe_retryable')
           OR EXISTS (
             SELECT 1 FROM communication_delivery_observations AS observation
              WHERE observation.delivery_id = communication_outbound_delivery_heads.delivery_id
                AND observation.observation_kind IN ('permanent_bounce', 'delivery_failed')
           )
           OR EXISTS (
             SELECT 1
               FROM communication_outbound_delivery_attempts AS attempt,
                    json_each(attempt.safe_evidence_json, '$.registeredFacts') AS fact
              WHERE attempt.delivery_id = communication_outbound_delivery_heads.delivery_id
                AND json_extract(fact.value, '$.factKey') = 'cloudflare.observation'
                AND json_extract(fact.value, '$.valueKind') = 'enum'
                AND json_extract(fact.value, '$.enumValue') IN (
                  'accepted_permanent_bounce', 'delivery_failed'
                )
           )
         )
    `).all(workspaceId, eventId);
    const observations = new SQLiteCommunicationDeliveryObservationRepository(this.input.sqlite);
    const failedDeliveries = possibleFailures.filter((delivery) => {
      const disposition = observations.currentDisposition(delivery.delivery_id)?.kind;
      return delivery.state === 'known_rejected_terminal'
        || delivery.state === 'known_rejected_safe_retryable'
        || disposition === 'permanent_bounce'
        || disposition === 'delivery_failed';
    }).length;
    const templates = this.input.sqlite.query<TotalCountRow, [WorkspaceId, string]>(`
      SELECT COUNT(*) AS total FROM template_artifact_heads
       WHERE workspace_id = ? AND event_id = ?
    `).get(workspaceId, eventId);
    if (!templates) throw new SQLiteWorkspaceOverviewError('count_evidence_corrupt');
    return {
      forms: { kind: 'exact' as const, ...forms },
      submissions: { kind: 'exact' as const, total: safeCount(submissions.total) },
      programVocabulary: { kind: 'exact' as const, rooms: vocabulary('rooms'),
        tracks: vocabulary('tracks'), formats: vocabulary('formats') },
      operations: { kind: 'exact' as const, total: safeCount(operations.total) },
      triage: { kind: 'exact' as const, ...triage },
      reviews: { kind: 'exact' as const, ...reviewCounts },
      reviewers: { kind: 'exact' as const, total: safeCount(reviewers.total) },
      decisions: {
        kind: 'exact' as const,
        decided,
        undecided: decisionPopulation - decided
      },
      engagements: { kind: 'exact' as const, ...engagements },
      sessions: { kind: 'exact' as const, ...sessions },
      communications: { kind: 'exact' as const, ...communications },
      attention: {
        kind: 'exact' as const,
        resultsNotSent: safeCount(attention.results_not_sent),
        overdueSpeakerTasks: safeCount(attention.overdue_speaker_tasks),
        uncoveredReviews: safeCount(attention.uncovered_reviews),
        sessionsAwaitingPlacement: safeCount(attention.sessions_awaiting_placement),
        sessionsMissingSpeakers: safeCount(attention.sessions_missing_speakers),
        failedDeliveries: safeCount(failedDeliveries)
      },
      templates: { kind: 'exact' as const, total: safeCount(templates.total) }
    };
  }
}

export function createSQLiteWorkspaceOverviewProjection(input: {
  readonly sqlite: Database;
  readonly areaCatalog: WorkspaceOverviewAreaCatalog;
  readonly historyLimit?: number;
  readonly now?: () => string;
}): SQLiteWorkspaceOverviewProjection {
  return new SQLiteWorkspaceOverviewProjection(input);
}
