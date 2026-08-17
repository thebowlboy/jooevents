import type { Database } from 'bun:sqlite';
import {
  parseAirtableBaseId,
  parseAirtableFieldId,
  parseAirtableRecordId,
  parseAirtableTableId
} from '@jooevents/airtable';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  type CanonicalJson
} from '@jooevents/kernel';
import type {
  AirtableOutboundProjectionSource,
  AirtableProjectionTarget,
  CompiledMapping,
  CurrentProjection,
  ManagedProvisioningState,
  ProjectionWorkClaim
} from '@jooevents/airtable-sync';
import { SQLiteAirtableManagedSnapshotSource } from './airtable-managed-snapshot';

interface AirtableShadowContextSourceInput {
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly recordLinkId: string;
  readonly areaKey: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly mapping: CanonicalJson;
}

interface AirtableShadowContextSource {
  resolve(input: AirtableShadowContextSourceInput): Promise<Readonly<{
    mappings: readonly Readonly<{
      fieldKey: string;
      fieldId: ReturnType<typeof parseAirtableFieldId>;
      mode: CompiledMapping['fields'][number]['mode'];
      dataClassification: CompiledMapping['fields'][number]['dataClassification'];
    }>[];
    local: Readonly<Record<string, CanonicalJson>>;
    subjectVersion?: number;
    lastOutbound?: Readonly<Record<string, CanonicalJson>>;
  }> | undefined>;
}

function taskStatus(value: string): string {
  if (value === 'complete' || value === 'late_complete') return 'Complete';
  if (value === 'waived') return 'Waived';
  return 'Open';
}

function parsedState(value: string): ManagedProvisioningState {
  return JSON.parse(value) as ManagedProvisioningState;
}

function liveFieldKey(tableKey: string, fieldKey: string): string {
  if (tableKey === 'tasks' && fieldKey === 'status') return 'task.status';
  if (tableKey === 'speakers' && fieldKey === 'requested_status') {
    return 'speaker.requested_status';
  }
  if (tableKey === 'speakers' && fieldKey === 'cancellation_note') {
    return 'speaker.cancellation_note';
  }
  return `managed.${fieldKey}`;
}

interface LinkRow {
  readonly provider_record_id: string;
  readonly canonical_version: number;
  readonly baseline_digest: string;
  readonly provider_fingerprint: string | null;
}

/** Canonical task projection and stable managed-schema target resolution. */
export class SQLiteAirtableLiveProjectionSource implements AirtableOutboundProjectionSource {
  constructor(
    private readonly sqlite: Database,
    private readonly managedSnapshot?: SQLiteAirtableManagedSnapshotSource
  ) {}

  async readCurrent(claim: ProjectionWorkClaim): Promise<CurrentProjection> {
    if (claim.areaKey !== 'tasks' || claim.subjectKind !== 'task_assignment') {
      const tableKey = claim.areaKey === 'people' ? 'speakers'
        : claim.areaKey === 'schedule' ? 'sessions' : claim.areaKey;
      const record = this.managedSnapshot?.readSubject(tableKey, claim.subjectId);
      if (!record) throw new TypeError('airtable_projection_subject_missing');
      const fields = Object.freeze(Object.fromEntries(
        Object.entries(record.fields)
          .filter(([key]) => key !== 'jooevents_id')
          .map(([key, value]) => [liveFieldKey(tableKey, key), value])
      ));
      return Object.freeze({
        projectionVersion: record.projectionVersion ?? claim.requestedProjectionVersion,
        fingerprint: canonicalJsonSha256(fields),
        fields
      });
    }
    const row = this.sqlite.query<{
      readonly state: string;
      readonly version: number;
    }, [string]>(`
      SELECT state,version FROM task_assignments WHERE id=? LIMIT 2
    `).get(claim.subjectId);
    if (!row) throw new TypeError('airtable_projection_subject_missing');
    const snapshot = this.managedSnapshot?.readSubject('tasks', claim.subjectId);
    const fields = Object.freeze({
      ...Object.fromEntries(Object.entries(snapshot?.fields ?? {})
        .filter(([key]) => key !== 'status' && key !== 'jooevents_id')
        .map(([key, value]) => [`managed.${key}`, value])),
      'task.status': taskStatus(row.state)
    });
    return Object.freeze({
      projectionVersion: row.version,
      fingerprint: canonicalJsonSha256(fields),
      fields
    });
  }

  async resolveTarget(claim: ProjectionWorkClaim): Promise<AirtableProjectionTarget | undefined> {
    const row = this.sqlite.query<{
      readonly state_json: string;
      readonly revision: number;
      readonly provider_record_id: string | null;
      readonly canonical_version: number | null;
      readonly baseline_digest: string | null;
      readonly provider_fingerprint: string | null;
    }, [string, string, string, string, number]>(`
      SELECT p.state_json,m.revision,l.provider_record_id,l.canonical_version,
             l.baseline_digest,l.provider_fingerprint
        FROM airtable_sync_connections c
        JOIN airtable_sync_provisioning_runs p ON p.connection_id=c.id
        JOIN airtable_sync_mapping_revisions m
          ON m.connection_id=c.id AND m.status='active'
        LEFT JOIN airtable_sync_record_links l
          ON l.connection_id=c.id AND l.mapping_revision=m.revision
         AND l.area_key=? AND l.subject_kind=? AND l.subject_id=?
       WHERE c.id=? AND c.state='active' AND m.revision=?
    `).get(claim.areaKey, claim.subjectKind, claim.subjectId, claim.connectionId, claim.mappingRevision);
    if (!row) return undefined;
    const state = parsedState(row.state_json);
    const tableKey = claim.areaKey === 'people' ? 'speakers'
      : claim.areaKey === 'schedule' ? 'sessions' : claim.areaKey;
    const table = state.binding?.tables.find((candidate) => candidate.key === tableKey);
    if (!state.binding || !table) return undefined;
    const fieldIds: Record<string, ReturnType<typeof parseAirtableFieldId>> = {};
    for (const field of table.fields) {
      if (field.key === 'jooevents_id' || field.key === 'last_synced' || field.key === 'sync_state') continue;
      const logicalKey = liveFieldKey(tableKey, field.key);
      fieldIds[logicalKey] = parseAirtableFieldId(field.fieldId);
    }
    return Object.freeze({
      mappingRevision: row.revision,
      baseId: parseAirtableBaseId(state.binding.baseId),
      tableId: parseAirtableTableId(table.tableId),
      stableIdFieldId: parseAirtableFieldId(table.stableIdFieldId),
      fieldIds: Object.freeze(fieldIds),
      ...(row.provider_record_id ? { providerRecordId: parseAirtableRecordId(row.provider_record_id) } : {}),
      ...(row.canonical_version && row.baseline_digest && row.provider_fingerprint ? {
        lastCommon: Object.freeze({
          canonicalVersion: row.canonical_version,
          baselineDigestSha256: row.baseline_digest,
          providerFingerprintSha256: row.provider_fingerprint
        })
      } : {})
    });
  }

  /** Promotes verified initial-backfill identities into the live comparison baseline. */
  promoteInitialLinks(input: Readonly<{
    connectionId: string;
    mappingRevision: number;
    nowMs: number;
    newId?: () => string;
  }>): number {
    const newId = input.newId ?? (() => crypto.randomUUID());
    const taskRows = this.sqlite.query<{
      readonly subject_key: string;
      readonly provider_table_id: string;
      readonly provider_record_id: string;
      readonly state: string;
      readonly version: number;
    }, [string]>(`
      SELECT s.subject_key,s.provider_table_id,s.provider_record_id,a.state,a.version
        FROM airtable_sync_snapshot_links s
        JOIN task_assignments a ON a.id=s.subject_key
       WHERE s.connection_id=? AND s.table_key='tasks'
       ORDER BY s.subject_key
    `).all(input.connectionId);
    const speakerRows = this.sqlite.query<{
      readonly subject_key: string;
      readonly provider_table_id: string;
      readonly provider_record_id: string;
      readonly head_json: string;
      readonly version: number;
    }, [string]>(`
      SELECT s.subject_key,s.provider_table_id,s.provider_record_id,g.head_json,g.version
        FROM airtable_sync_snapshot_links s
        JOIN engagement_heads g ON g.id=s.subject_key
       WHERE s.connection_id=? AND s.table_key='speakers'
       ORDER BY s.subject_key
    `).all(input.connectionId);
    const sessionRows = this.sqlite.query<{
      readonly subject_key: string;
      readonly provider_table_id: string;
      readonly provider_record_id: string;
      readonly version: number;
    }, [string]>(`
      SELECT snapshot.subject_key,snapshot.provider_table_id,snapshot.provider_record_id,session.version
        FROM airtable_sync_snapshot_links snapshot
        JOIN sessions session ON session.id=snapshot.subject_key
       WHERE snapshot.connection_id=? AND snapshot.table_key='sessions'
       ORDER BY snapshot.subject_key
    `).all(input.connectionId);
    const submissionRows = this.sqlite.query<{
      readonly subject_key: string;
      readonly provider_table_id: string;
      readonly provider_record_id: string;
    }, [string]>(`
      SELECT subject_key,provider_table_id,provider_record_id
        FROM airtable_sync_snapshot_links
       WHERE connection_id=? AND table_key='submissions'
       ORDER BY subject_key
    `).all(input.connectionId);
    const eventRows = this.sqlite.query<{
      readonly subject_key: string;
      readonly provider_table_id: string;
      readonly provider_record_id: string;
      readonly version: number;
    }, [string]>(`
      SELECT snapshot.subject_key,snapshot.provider_table_id,snapshot.provider_record_id,event.version
        FROM airtable_sync_snapshot_links snapshot
        JOIN event_spine_heads event ON event.id=snapshot.subject_key
       WHERE snapshot.connection_id=? AND snapshot.table_key='events'
       ORDER BY snapshot.subject_key
    `).all(input.connectionId);
    let inserted = 0;
    const save = this.sqlite.query(`
      INSERT OR IGNORE INTO airtable_sync_record_links(
        id,connection_id,mapping_revision,area_key,subject_kind,subject_id,
        provider_table_id,provider_record_id,canonical_version,baseline_json,
        baseline_digest,provider_fingerprint,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)
    `);
    this.sqlite.transaction(() => {
      for (const row of taskRows) {
        const baseline = { 'task.status': taskStatus(row.state) };
        inserted += save.run(
          newId(), input.connectionId, input.mappingRevision, 'tasks', 'task_assignment',
          row.subject_key, row.provider_table_id, row.provider_record_id, row.version,
          canonicalJsonText(baseline), canonicalJsonSha256(baseline), input.nowMs
        ).changes;
      }
      for (const row of speakerRows) {
        const head = JSON.parse(row.head_json) as {
          readonly cancellationRequest?: { readonly note?: string | null } | null;
        };
        const baseline = {
          'speaker.requested_status': head.cancellationRequest ? 'Cancelled' : null,
          'speaker.cancellation_note': head.cancellationRequest?.note ?? null
        };
        inserted += save.run(
          newId(), input.connectionId, input.mappingRevision, 'people', 'engagement',
          row.subject_key, row.provider_table_id, row.provider_record_id, row.version,
          canonicalJsonText(baseline), canonicalJsonSha256(baseline), input.nowMs
        ).changes;
      }
      for (const row of sessionRows) {
        const baseline = {};
        inserted += save.run(
          newId(), input.connectionId, input.mappingRevision, 'sessions', 'session',
          row.subject_key, row.provider_table_id, row.provider_record_id, row.version,
          canonicalJsonText(baseline), canonicalJsonSha256(baseline), input.nowMs
        ).changes;
      }
      for (const row of submissionRows) {
        const baseline = {};
        inserted += save.run(
          newId(), input.connectionId, input.mappingRevision, 'submissions', 'submission',
          row.subject_key, row.provider_table_id, row.provider_record_id, 1,
          canonicalJsonText(baseline), canonicalJsonSha256(baseline), input.nowMs
        ).changes;
      }
      for (const row of eventRows) {
        const baseline = {};
        inserted += save.run(
          newId(), input.connectionId, input.mappingRevision, 'events', 'event',
          row.subject_key, row.provider_table_id, row.provider_record_id, row.version,
          canonicalJsonText(baseline), canonicalJsonSha256(baseline), input.nowMs
        ).changes;
      }
    })();
    return inserted;
  }
}

/** Resolves the live side of the three-way comparison from canonical SQL. */
export class SQLiteAirtableShadowContextSource implements AirtableShadowContextSource {
  constructor(
    private readonly sqlite: Database,
    private readonly managedSnapshot?: SQLiteAirtableManagedSnapshotSource
  ) {}

  async resolve(input: AirtableShadowContextSourceInput) {
    const stateRow = this.sqlite.query<{ readonly state_json: string }, [string]>(`
      SELECT state_json FROM airtable_sync_provisioning_runs WHERE connection_id=?
    `).get(input.connectionId);
    if (!stateRow) return undefined;
    const state = parsedState(stateRow.state_json);
    const mapping = input.mapping as unknown as CompiledMapping;
    const tableKey = input.areaKey === 'people' ? 'speakers' : input.areaKey;
    const table = state.binding?.tables.find((candidate) => candidate.key === tableKey);
    if (!table) return undefined;
    const configuredMappings = mapping.fields.filter((field) => field.areaKey === input.areaKey)
      .flatMap((field) => {
        const key = field.fieldKey.slice(field.fieldKey.lastIndexOf('.') + 1);
        const binding = table.fields.find((candidate) => candidate.key === key);
        return binding ? [Object.freeze({
          fieldKey: field.fieldKey,
          fieldId: parseAirtableFieldId(binding.fieldId),
          mode: field.mode,
          dataClassification: field.dataClassification
        })] : [];
      });
    const configuredByKey = new Map(configuredMappings.map((field) => [field.fieldKey, field]));
    const mappings = table.fields.flatMap((binding) => {
      if (binding.key === 'jooevents_id' || binding.key === 'last_synced'
          || binding.key === 'sync_state') return [];
      const fieldKey = liveFieldKey(tableKey, binding.key);
      const configured = configuredByKey.get(fieldKey);
      return [configured ?? Object.freeze({
        fieldKey,
        fieldId: parseAirtableFieldId(binding.fieldId),
        mode: 'view_in_airtable' as const,
        dataClassification: input.areaKey === 'people' ? 'personal' as const : 'ordinary' as const
      })];
    });
    const snapshot = this.managedSnapshot?.readSubject(tableKey, input.subjectId);
    const projectedLocal = Object.fromEntries(Object.entries(snapshot?.fields ?? {})
      .filter(([key]) => key !== 'jooevents_id')
      .map(([key, value]) => [liveFieldKey(tableKey, key), value]));
    if (input.subjectKind === 'task_assignment') {
      const row = this.sqlite.query<{ readonly state: string; readonly version: number }, [string]>(`
        SELECT state,version FROM task_assignments WHERE id=? LIMIT 2
      `).get(input.subjectId);
      return row ? Object.freeze({
        mappings: Object.freeze(mappings),
        local: Object.freeze({ ...projectedLocal, 'task.status': taskStatus(row.state) }),
        subjectVersion: row.version
      }) : undefined;
    }
    if (input.subjectKind === 'engagement') {
      const row = this.sqlite.query<{ readonly head_json: string; readonly version: number }, [string]>(`
        SELECT head_json,version FROM engagement_heads WHERE id=? LIMIT 2
      `).get(input.subjectId);
      if (!row) return undefined;
      const head = JSON.parse(row.head_json) as {
        readonly cancellationRequest?: { readonly note?: string | null } | null;
      };
      return Object.freeze({
        mappings: Object.freeze(mappings),
        local: Object.freeze({
          ...projectedLocal,
          'speaker.requested_status': head.cancellationRequest ? 'Cancelled' : null,
          'speaker.cancellation_note': head.cancellationRequest?.note ?? null
        }),
        subjectVersion: row.version
      });
    }
    return snapshot ? Object.freeze({
      mappings: Object.freeze(mappings),
      local: Object.freeze(projectedLocal)
    }) : undefined;
  }
}
