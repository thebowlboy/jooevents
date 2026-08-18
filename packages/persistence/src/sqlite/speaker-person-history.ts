import type { Database } from 'bun:sqlite';
import {
  SPEAKER_PERSON_HISTORY_PAGE_SIZE,
  speakerPersonHistoryInputSchema,
  speakerPersonHistoryPageSchema,
  type EngagementScopeDto,
  type SpeakerPersonHistoryPageDto
} from '@jooevents/contracts';

interface HistoryRow {
  readonly id: string;
  readonly occurred_at_ms: number;
  readonly actor: 'organizer' | 'person' | 'agent' | 'system';
  readonly summary: string;
}

const HISTORY_QUERY = `
WITH person_history AS (
  SELECT 'task:' || event.id AS id,
         event.occurred_at_ms,
         'organizer' AS actor,
         CASE event.kind
           WHEN 'assigned' THEN 'Assigned ' || json_extract(revision.revision_json, '$.name')
           WHEN 'fulfillment_received' THEN json_extract(revision.revision_json, '$.name') || ' was submitted'
           WHEN 'fulfillment_accepted' THEN 'Accepted ' || json_extract(revision.revision_json, '$.name')
           WHEN 'waived' THEN 'Waived ' || json_extract(revision.revision_json, '$.name')
           WHEN 'restored' THEN 'Restored ' || json_extract(revision.revision_json, '$.name')
           WHEN 'extended' THEN 'Extended ' || json_extract(revision.revision_json, '$.name')
           WHEN 'reminded' THEN 'Sent a reminder for ' || json_extract(revision.revision_json, '$.name')
         END AS summary
    FROM task_events AS event
    JOIN task_assignments AS assignment
      ON assignment.workspace_id = event.workspace_id
     AND assignment.event_id = event.event_id
     AND assignment.id = event.assignment_id
    JOIN task_definition_revisions AS revision
      ON revision.workspace_id = assignment.workspace_id
     AND revision.event_id = assignment.event_id
     AND revision.revision_id = assignment.task_definition_revision_id
   WHERE event.workspace_id = ? AND event.event_id = ? AND assignment.person_id = ?

  UNION ALL

  SELECT 'portal:' || activity.activity_id AS id,
         activity.occurred_at_ms,
         CASE WHEN activity.acting_person_id IS NULL THEN 'organizer' ELSE 'person' END AS actor,
         CASE WHEN activity.acting_person_id = ?
           THEN activity.summary_for_actor ELSE activity.summary_for_others END AS summary
    FROM participant_portal_activity AS activity
   WHERE activity.workspace_id = ? AND activity.event_id = ?
     AND EXISTS (
       SELECT 1 FROM intake_submission_participant_evidence AS participant
        WHERE participant.workspace_id = activity.workspace_id
          AND participant.event_id = activity.event_id
          AND participant.submission_id = activity.submission_id
          AND participant.person_id = ?
     )

  UNION ALL

  SELECT 'operation:' || log.id AS id,
         log.occurred_at_ms,
         CASE json_extract(log.actor_json, '$.kind')
           WHEN 'workspace_user' THEN 'organizer'
           WHEN 'participant' THEN 'person'
           WHEN 'external_mcp_client' THEN 'agent'
           WHEN 'app_model_run' THEN 'agent'
           ELSE 'system'
         END AS actor,
         log.summary
    FROM operation_log AS log
   WHERE log.workspace_id = ? AND log.event_id = ?
     AND json_extract(log.result_json, '$.kind') = 'success'
     AND (
       (log.operation_name = 'engagement.change'
         AND json_extract(log.result_json, '$.data.engagement.personId') = ?)
       OR (log.operation_name = 'speaker-lineup.change'
         AND json_extract(log.result_json, '$.data.entry.personId') = ?)
       OR (log.operation_name = 'decision.decide' AND EXISTS (
         SELECT 1 FROM json_each(log.result_json, '$.data.rows') AS decision_row
          JOIN intake_submission_heads AS submission
            ON submission.workspace_id = log.workspace_id
           AND submission.event_id = log.event_id
           AND submission.submission_id = json_extract(decision_row.value, '$.submissionId')
         WHERE submission.person_id = ?
       ))
     )
)
SELECT id, occurred_at_ms, actor, summary
  FROM person_history
 WHERE (? IS NULL
   OR occurred_at_ms < ?
   OR (occurred_at_ms = ? AND id < ?))
 ORDER BY occurred_at_ms DESC, id DESC
 LIMIT ?
`;

export class SQLiteSpeakerPersonHistoryReader {
  constructor(private readonly sqlite: Database) {}

  read(scope: EngagementScopeDto, businessInput: unknown): SpeakerPersonHistoryPageDto | undefined {
    const input = speakerPersonHistoryInputSchema.parse(businessInput);
    const exists = this.sqlite.query<{ readonly found: number }, [string, string]>(`
      SELECT 1 AS found FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
    `).get(scope.workspaceId, scope.eventId);
    if (!exists) return undefined;

    const beforeMs = input.beforeOccurredAt === undefined
      ? null
      : Date.parse(input.beforeOccurredAt);
    const rows = this.sqlite.query<HistoryRow, Array<string | number | null>>(HISTORY_QUERY).all(
      scope.workspaceId, scope.eventId, input.personId,
      input.personId, scope.workspaceId, scope.eventId, input.personId,
      scope.workspaceId, scope.eventId, input.personId, input.personId, input.personId,
      beforeMs, beforeMs, beforeMs, input.beforeId ?? null,
      SPEAKER_PERSON_HISTORY_PAGE_SIZE + 1
    );
    const visible = rows.slice(0, SPEAKER_PERSON_HISTORY_PAGE_SIZE);
    const entries = visible.map((row) => Object.freeze({
      id: row.id,
      occurredAt: new Date(row.occurred_at_ms).toISOString(),
      actor: row.actor,
      summary: row.summary
    }));
    const last = visible.at(-1);
    return speakerPersonHistoryPageSchema.parse({
      schemaVersion: 1,
      entries,
      next: rows.length > SPEAKER_PERSON_HISTORY_PAGE_SIZE && last
        ? { occurredAt: new Date(last.occurred_at_ms).toISOString(), id: last.id }
        : null
    });
  }
}

export function createSQLiteSpeakerPersonHistoryReader(
  sqlite: Database
): SQLiteSpeakerPersonHistoryReader {
  return new SQLiteSpeakerPersonHistoryReader(sqlite);
}
