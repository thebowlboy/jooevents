import type { Database } from 'bun:sqlite';
import {
  sessionParticipantSupportChangePlanSchema,
  sessionParticipantSupportSchema,
  type SessionParticipantSupportChangePlanDto,
  type SessionParticipantSupportDto,
  type SessionRosterSourceRefDto
} from '@jooevents/contracts';
import type {
  SessionParticipantSupportReadPort,
  SessionParticipantSupportTransactionPort
} from '@jooevents/session';
import { canonicalJsonText } from '@jooevents/kernel';

/** Isolated-fixture schema; the retained chain installs the same owned relation. */
export const SESSION_PARTICIPANT_SUPPORT_SQL = `
CREATE TABLE session_participant_supports (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  support_kind TEXT NOT NULL CHECK(support_kind IN ('submission', 'editorial')),
  support_key TEXT NOT NULL CHECK(length(support_key) BETWEEN 1 AND 700),
  support_json TEXT NOT NULL CHECK(json_valid(support_json) AND json_type(support_json) = 'object'),
  PRIMARY KEY (workspace_id, event_id, session_id, person_id, support_kind, support_key),
  CHECK(json_extract(support_json, '$.schemaVersion') = 1),
  CHECK(json_extract(support_json, '$.scope.workspaceId') = workspace_id),
  CHECK(json_extract(support_json, '$.scope.eventId') = event_id),
  CHECK(json_extract(support_json, '$.sessionId') = session_id),
  CHECK(json_extract(support_json, '$.personId') = person_id),
  CHECK(json_extract(support_json, '$.kind') = support_kind),
  CHECK(
    (support_kind = 'submission'
      AND json_type(support_json, '$.submissionId') = 'text'
      AND json_extract(support_json, '$.submissionId') = support_key
      AND length(json_extract(support_json, '$.submissionId')) = 36
      AND json_type(support_json, '$.source') IS NULL)
    OR
    (support_kind = 'editorial'
      AND json_type(support_json, '$.submissionId') IS NULL
      AND json_type(support_json, '$.source') = 'object'
      AND json_type(support_json, '$.source.kind') = 'text'
      AND json_extract(support_json, '$.source.kind') <> 'submission'
      AND json_type(support_json, '$.source.id') = 'text'
      AND json_type(support_json, '$.source.version') = 'integer'
      AND json_extract(support_json, '$.source.version') > 0
      AND support_key = json(json_extract(support_json, '$.source')))
  ),
  FOREIGN KEY (workspace_id, event_id, session_id)
    REFERENCES sessions(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX session_participant_supports_source
  ON session_participant_supports(workspace_id, event_id, support_kind, support_key, session_id, person_id);

CREATE TRIGGER session_participant_supports_no_update
BEFORE UPDATE ON session_participant_supports
BEGIN
  SELECT RAISE(ABORT, 'session participant support is immutable');
END;
`;

interface SupportRow { readonly support_json: string }

function supportKey(
  support: { readonly kind: 'submission'; readonly submissionId: string }
    | { readonly kind: 'editorial'; readonly source: SessionRosterSourceRefDto }
): string {
  return support.kind === 'submission'
    ? support.submissionId
    : canonicalJsonText(support.source);
}

function changedExactlyOnce(result: { readonly changes: number }): void {
  if (result.changes !== 1) throw new TypeError('session_participant_support_changed');
}

/** Refuses a retained database whose old roster provenance cannot be backfilled exactly. */
export function assertSessionParticipantSupportBackfillSafe(sqlite: Database): void {
  const originWithoutParticipants = sqlite.query<{ readonly count: number }, []>(`
    SELECT count(*) AS count
      FROM submission_session_origins origin
     WHERE NOT EXISTS (
       SELECT 1
         FROM intake_submission_participant_evidence evidence
        WHERE evidence.workspace_id = origin.workspace_id
          AND evidence.event_id = origin.event_id
          AND evidence.submission_id = origin.submission_id
     )
  `).get()?.count ?? 0;
  const unsupportedDisplayedSources = sqlite.query<{ readonly count: number }, []>(`
    SELECT count(*) AS count
      FROM sessions session, json_each(session.roster_json, '$.participants') participant
     WHERE json_extract(participant.value, '$.source.kind') = 'submission'
       AND NOT EXISTS (
         SELECT 1
           FROM submission_session_origins origin
           JOIN intake_submission_participant_evidence evidence
             ON evidence.workspace_id = origin.workspace_id
            AND evidence.event_id = origin.event_id
            AND evidence.submission_id = origin.submission_id
            AND evidence.person_id = json_extract(participant.value, '$.personId')
          WHERE origin.workspace_id = session.workspace_id
            AND origin.event_id = session.event_id
            AND origin.session_id = session.id
            AND origin.submission_id = json_extract(participant.value, '$.source.id')
       )
  `).get()?.count ?? 0;
  if (originWithoutParticipants !== 0 || unsupportedDisplayedSources !== 0) {
    throw new TypeError(
      `session_participant_support_backfill_ambiguous:${originWithoutParticipants}:${unsupportedDisplayedSources}`
    );
  }
}

export class SQLiteSessionParticipantSupportRepository
implements SessionParticipantSupportReadPort, SessionParticipantSupportTransactionPort {
  constructor(private readonly sqlite: Database) {}

  readParticipantSupport(
    scope: { readonly workspaceId: string; readonly eventId: string },
    sessionId: string,
    personId: string,
    support: { readonly kind: 'submission'; readonly submissionId: string }
      | { readonly kind: 'editorial'; readonly source: SessionRosterSourceRefDto }
  ): SessionParticipantSupportDto | undefined {
    const row = this.sqlite.query<SupportRow, [string, string, string, string, string, string]>(`
      SELECT support_json FROM session_participant_supports
       WHERE workspace_id = ? AND event_id = ? AND session_id = ? AND person_id = ?
         AND support_kind = ? AND support_key = ?
    `).get(
      scope.workspaceId, scope.eventId, sessionId, personId, support.kind, supportKey(support)
    );
    return row ? sessionParticipantSupportSchema.parse(JSON.parse(row.support_json)) : undefined;
  }

  listParticipantSupports(
    scope: { readonly workspaceId: string; readonly eventId: string },
    sessionId: string,
    personId: string
  ): readonly SessionParticipantSupportDto[] {
    const rows = this.sqlite.query<SupportRow, [string, string, string, string]>(`
      SELECT support_json FROM session_participant_supports
       WHERE workspace_id = ? AND event_id = ? AND session_id = ? AND person_id = ?
       ORDER BY support_kind COLLATE BINARY, support_key COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId, sessionId, personId);
    return Object.freeze(rows.map((row) =>
      sessionParticipantSupportSchema.parse(JSON.parse(row.support_json))));
  }

  applyParticipantSupportChanges(planInput: SessionParticipantSupportChangePlanDto): void {
    if (!this.sqlite.inTransaction) throw new TypeError('session_participant_support_transaction_required');
    const plan = sessionParticipantSupportChangePlanSchema.parse(planInput);
    for (const support of plan.remove) this.deleteExact(support);
    for (const support of plan.insert) this.insertExact(support);
  }

  private insertExact(support: SessionParticipantSupportDto): void {
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string, string, string]>(`
      INSERT INTO session_participant_supports (
        workspace_id, event_id, session_id, person_id, support_kind, support_key, support_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      support.scope.workspaceId, support.scope.eventId, support.sessionId, support.personId,
      support.kind, supportKey(support), canonicalJsonText(support)
    ));
  }

  private deleteExact(support: SessionParticipantSupportDto): void {
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string, string, string]>(`
      DELETE FROM session_participant_supports
       WHERE workspace_id = ? AND event_id = ? AND session_id = ? AND person_id = ?
         AND support_kind = ? AND support_key = ? AND support_json = ?
    `).run(
      support.scope.workspaceId, support.scope.eventId, support.sessionId, support.personId,
      support.kind, supportKey(support), canonicalJsonText(support)
    ));
  }
}
