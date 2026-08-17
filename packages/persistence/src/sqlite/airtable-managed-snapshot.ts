import type { Database } from 'bun:sqlite';
import type { CanonicalJson } from '@jooevents/kernel';
import type {
  ManagedProjectedRecord,
  ManagedSnapshotSource
} from '@jooevents/airtable-sync';

interface SnapshotRow {
  readonly subject_key: string;
  readonly event_name?: string | null;
  readonly primary_label: string;
  readonly secondary_label?: string | null;
  readonly tertiary_label?: string | null;
  readonly status?: string | null;
  readonly starts_at?: string | number | null;
  readonly ends_at?: string | number | null;
  readonly due_at?: number | null;
  readonly venue?: string | null;
  readonly requested_status?: string | null;
  readonly cancellation_note?: string | null;
  readonly version: number;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURSOR = /^[\p{L}\p{N}._:-]{1,256}$/u;

function text(value: string | null | undefined): string | undefined {
  const normalized = value?.normalize('NFC').trim();
  return normalized ? normalized : undefined;
}

function instant(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return new Date(value).toISOString();
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? `${value}T00:00:00.000Z`
    : new Date(value).toISOString();
}

function compact(fields: Readonly<Record<string, CanonicalJson | undefined>>): Readonly<Record<string, CanonicalJson>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, CanonicalJson] => entry[1] !== undefined)
  ));
}

function taskStatus(value: string | null | undefined): string | undefined {
  if (value === 'complete' || value === 'late_complete') return 'Complete';
  if (value === 'pending' || value === 'received_pending_check') return 'Open';
  if (value === 'waived') return 'Waived';
  return undefined;
}

/**
 * Read-only, bounded projection of canonical workspace state for the managed
 * Airtable snapshot. It deliberately excludes contact and review payloads.
 */
export class SQLiteAirtableManagedSnapshotSource implements ManagedSnapshotSource {
  constructor(
    private readonly sqlite: Database,
    private readonly workspaceId: string
  ) {
    if (!WORKSPACE_ID.test(workspaceId)) throw new TypeError('airtable_snapshot_workspace_invalid');
  }

  async listPage(input: Readonly<{
    connectionId: string;
    tableKey: string;
    cursor?: string;
    limit: 10;
  }>): Promise<Readonly<{ records: readonly ManagedProjectedRecord[]; nextCursor?: string }>> {
    if (!input.connectionId || input.connectionId.length > 256 || input.limit !== 10
      || (input.cursor !== undefined && !CURSOR.test(input.cursor))) {
      throw new TypeError('airtable_snapshot_page_invalid');
    }
    if (!this.tableIsConnected(input.connectionId, input.tableKey)) {
      return Object.freeze({ records: Object.freeze([]) });
    }
    const queried = this.query(input.tableKey, input.cursor).all(
      this.workspaceId,
      input.cursor ?? '',
      input.limit + (input.cursor ? 2 : 1)
    );
    const rows = input.cursor && queried[0]?.subject_key === input.cursor
      ? queried.slice(1) : queried;
    const page = rows.slice(0, input.limit);
    const records = Object.freeze(page.map((row) => this.project(input.tableKey, row)));
    return Object.freeze({
      records,
      ...(rows.length > input.limit ? { nextCursor: page.at(-1)!.subject_key } : {})
    });
  }

  readSubject(tableKey: string, subjectKey: string): (ManagedProjectedRecord & {
    readonly projectionVersion: number;
  }) | undefined {
    if (!CURSOR.test(subjectKey)) throw new TypeError('airtable_snapshot_subject_invalid');
    const row = this.query(tableKey).get(this.workspaceId, subjectKey, 1);
    return row?.subject_key === subjectKey
      ? Object.freeze({ ...this.project(tableKey, row), projectionVersion: row.version })
      : undefined;
  }

  private tableIsConnected(connectionId: string, tableKey: string): boolean {
    const mappingTable = this.sqlite.query<{ readonly present: number }, []>(`
      SELECT 1 AS present FROM sqlite_master
       WHERE type='table' AND name='airtable_sync_mapping_revisions'
    `).get();
    if (!mappingTable) return true;
    const row = this.sqlite.query<{ readonly mapping_json: string }, [string]>(`
      SELECT mapping_json FROM airtable_sync_mapping_revisions
       WHERE connection_id=? AND status IN ('draft','active')
       ORDER BY revision DESC LIMIT 1
    `).get(connectionId);
    if (!row) return true;
    const mapping = JSON.parse(row.mapping_json) as {
      readonly areas?: readonly { readonly areaKey?: string; readonly direction?: string }[];
    };
    const connected = new Set((mapping.areas ?? [])
      .filter((area) => area.direction !== 'not_connected')
      .map((area) => area.areaKey));
    if (tableKey === 'events') return connected.size > 0;
    if (tableKey === 'speakers') return connected.has('people');
    if (tableKey === 'sessions') return connected.has('sessions') || connected.has('schedule');
    return connected.has(tableKey);
  }

  private query(tableKey: string, cursor?: string) {
    void cursor;
    if (tableKey === 'events') return this.sqlite.query<SnapshotRow, [string, string, number]>(`
      SELECT e.id AS subject_key, e.name AS primary_label, e.start_date AS starts_at,
             e.end_date AS ends_at, s.location AS venue, e.version
        FROM event_spine_heads e
        LEFT JOIN event_settings_companions s
          ON s.workspace_id=e.workspace_id AND s.event_id=e.id
       WHERE e.workspace_id=? AND e.id>=?
       ORDER BY e.id COLLATE BINARY LIMIT ?
    `);
    if (tableKey === 'sessions') return this.sqlite.query<SnapshotRow, [string, string, number]>(`
      SELECT s.id AS subject_key, e.name AS event_name, s.title AS primary_label,
             r.name AS secondary_label,
             (SELECT group_concat(p.display_name, ', ')
                FROM engagement_heads g
                JOIN participant_identity_family p ON p.person_id=g.person_id
               WHERE g.workspace_id=s.workspace_id AND g.event_id=s.event_id
                 AND g.session_id=s.id AND g.state<>'cancelled'
               ORDER BY p.display_name COLLATE NOCASE) AS tertiary_label,
             s.lifecycle AS status, o.start_at_ms AS starts_at, o.end_at_ms AS ends_at,
             s.version * 1000000 + coalesce(o.version,0) AS version
        FROM sessions s
        JOIN event_spine_heads e ON e.workspace_id=s.workspace_id AND e.id=s.event_id
        LEFT JOIN schedule_occurrences o
          ON o.workspace_id=s.workspace_id AND o.event_id=s.event_id AND o.session_id=s.id
         AND o.id=(SELECT first.id FROM schedule_occurrences first
                    WHERE first.workspace_id=s.workspace_id AND first.event_id=s.event_id
                      AND first.session_id=s.id ORDER BY first.start_at_ms,first.id LIMIT 1)
        LEFT JOIN program_vocabulary_rooms r
          ON r.workspace_id=o.workspace_id AND r.event_id=o.event_id AND r.id=o.room_id
       WHERE s.workspace_id=? AND s.id>=?
       ORDER BY s.id COLLATE BINARY LIMIT ?
    `);
    if (tableKey === 'tasks') return this.sqlite.query<SnapshotRow, [string, string, number]>(`
      SELECT a.id AS subject_key, e.name AS event_name,
             json_extract(d.revision_json, '$.name') AS primary_label,
             p.display_name AS secondary_label, a.state AS status,
             COALESCE(
               json_extract(a.assignment_json, '$.deadlineOverride.reference.effectiveAtMs'),
               json_extract(a.assignment_json, '$.deadline.reference.effectiveAtMs'),
               dl.effective_at_ms
             ) AS due_at,
             a.version
        FROM task_assignments a
        JOIN task_definition_revisions d
          ON d.workspace_id=a.workspace_id AND d.event_id=a.event_id
         AND d.revision_id=a.task_definition_revision_id
        JOIN deadlines dl
          ON dl.workspace_id=d.workspace_id AND dl.event_id=d.event_id AND dl.id=d.deadline_id
        JOIN event_spine_heads e ON e.workspace_id=a.workspace_id AND e.id=a.event_id
        LEFT JOIN participant_identity_family p ON p.person_id=a.person_id
       WHERE a.workspace_id=? AND a.id>=?
       ORDER BY a.id COLLATE BINARY LIMIT ?
    `);
    if (tableKey === 'submissions') return this.sqlite.query<SnapshotRow, [string, string, number]>(`
      WITH evidence AS (
        SELECT workspace_id,event_id,submission_id,evidence_json
          FROM intake_submission_submit_evidence
        UNION ALL
        SELECT workspace_id,event_id,submission_id,evidence_json
          FROM intake_submission_direct_entry_evidence
      )
      SELECT h.submission_id AS subject_key, ev.name AS event_name,
             COALESCE((
               SELECT json_extract(answer.value, '$.value')
                 FROM json_each(x.evidence_json, '$.answers') answer
                 JOIN json_each(v.version_json, '$.definition.fields') field
                   ON json_extract(field.value, '$.id')=json_extract(answer.value, '$.fieldId')
                WHERE json_extract(field.value, '$.mapsTo')='talk.title'
                LIMIT 1
             ), 'Untitled submission') AS primary_label,
             p.display_name AS secondary_label,
             COALESCE((
               SELECT json_extract(pin.value, '$.label')
                 FROM json_each(x.evidence_json, '$.programVocabularyAnswerPins') pin
                 JOIN json_each(v.version_json, '$.definition.fields') field
                   ON json_extract(field.value, '$.id')=json_extract(pin.value, '$.fieldId')
                WHERE json_extract(field.value, '$.mapsTo')='talk.track'
                LIMIT 1
             ), '') AS tertiary_label,
             COALESCE(d.state, 'submitted') AS status,
             1 + COALESCE(d.version,0) AS version
        FROM intake_submission_heads h
        JOIN intake_form_versions v
          ON v.workspace_id=h.workspace_id AND v.event_id=h.event_id
         AND v.form_version_id=h.form_version_id
        JOIN evidence x
          ON x.workspace_id=h.workspace_id AND x.event_id=h.event_id
         AND x.submission_id=h.submission_id
        JOIN event_spine_heads ev ON ev.workspace_id=h.workspace_id AND ev.id=h.event_id
        LEFT JOIN participant_identity_family p ON p.person_id=h.person_id
        LEFT JOIN decision_heads d
          ON d.workspace_id=h.workspace_id AND d.event_id=h.event_id
         AND d.submission_id=h.submission_id
       WHERE h.workspace_id=? AND h.submission_id>=?
       ORDER BY h.submission_id COLLATE BINARY LIMIT ?
    `);
    if (tableKey === 'speakers') return this.sqlite.query<SnapshotRow, [string, string, number]>(`
      SELECT g.id AS subject_key, ev.name AS event_name, p.display_name AS primary_label,
             COALESCE((
               SELECT json_extract(answer.value, '$.value')
                 FROM intake_submission_heads h
                 JOIN intake_form_versions v
                   ON v.workspace_id=h.workspace_id AND v.event_id=h.event_id
                  AND v.form_version_id=h.form_version_id
                 LEFT JOIN intake_submission_submit_evidence se
                   ON se.workspace_id=h.workspace_id AND se.event_id=h.event_id
                  AND se.submission_id=h.submission_id
                 LEFT JOIN intake_submission_direct_entry_evidence de
                   ON de.workspace_id=h.workspace_id AND de.event_id=h.event_id
                  AND de.submission_id=h.submission_id
                 JOIN json_each(COALESCE(se.evidence_json,de.evidence_json), '$.answers') answer
                 JOIN json_each(v.version_json, '$.definition.fields') field
                   ON json_extract(field.value, '$.id')=json_extract(answer.value, '$.fieldId')
                WHERE h.submission_id=g.submission_id
                  AND json_extract(field.value, '$.mapsTo')='talk.title'
                LIMIT 1
             ), '') AS secondary_label,
             s.title AS tertiary_label, g.state AS status,
             CASE WHEN json_type(g.head_json,'$.cancellationRequest')='object'
               THEN 'Cancelled' ELSE NULL END AS requested_status,
             json_extract(g.head_json,'$.cancellationRequest.note') AS cancellation_note,
             g.version
        FROM engagement_heads g
        JOIN sessions s
          ON s.workspace_id=g.workspace_id AND s.event_id=g.event_id AND s.id=g.session_id
        JOIN event_spine_heads ev ON ev.workspace_id=g.workspace_id AND ev.id=g.event_id
        JOIN participant_identity_family p ON p.person_id=g.person_id
       WHERE g.workspace_id=? AND g.id>=?
       ORDER BY g.id COLLATE BINARY LIMIT ?
    `);
    throw new TypeError('airtable_snapshot_table_unknown');
  }

  private project(tableKey: string, row: SnapshotRow): ManagedProjectedRecord {
    const common = { event: text(row.event_name), jooevents_id: row.subject_key } as const;
    let fields: Readonly<Record<string, CanonicalJson | undefined>>;
    if (tableKey === 'events') fields = {
      event: row.primary_label, starts: instant(row.starts_at), ends: instant(row.ends_at),
      venue: text(row.venue), jooevents_id: row.subject_key
    };
    else if (tableKey === 'sessions') fields = {
      session: row.primary_label, room: text(row.secondary_label), speakers: text(row.tertiary_label),
      starts: instant(row.starts_at), ends: instant(row.ends_at), status: text(row.status), ...common
    };
    else if (tableKey === 'tasks') fields = {
      task: row.primary_label, assignee: text(row.secondary_label), due: instant(row.due_at),
      status: taskStatus(row.status), ...common
    };
    else if (tableKey === 'submissions') fields = {
      submission: row.primary_label, speakers: text(row.secondary_label), track: text(row.tertiary_label),
      status: text(row.status), ...common
    };
    else fields = {
      speaker: row.primary_label, submission: text(row.secondary_label), session: text(row.tertiary_label),
      confirmation: text(row.status), effective_status: text(row.status),
      requested_status: text(row.requested_status), cancellation_note: text(row.cancellation_note),
      ...common
    };
    return Object.freeze({ subjectKey: row.subject_key, fields: compact(fields) });
  }
}
