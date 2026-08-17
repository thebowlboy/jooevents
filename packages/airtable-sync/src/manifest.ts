import type {
  AirtableBaseSchema,
  AirtableCellValue,
  AirtableCreateTableInput,
  AirtableFieldId,
  AirtableFieldType,
  AirtableRecordId,
  AirtableTableId,
  AirtableWriteRecord
} from '@jooevents/airtable';
import { canonicalJsonSha256, canonicalJsonValue, type CanonicalJson } from '@jooevents/kernel';

export type ManagedBaseScope = 'all_events' | 'single_event';
export type ManagedFieldAuthority = 'view' | 'editable' | 'request' | 'control';

export interface ManagedManifestField {
  readonly key: string;
  readonly name: string;
  readonly type: AirtableFieldType;
  readonly authority: ManagedFieldAuthority;
  readonly description: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ManagedManifestTable {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly stableIdFieldKey: string;
  readonly fields: readonly ManagedManifestField[];
}

export interface ManagedBaseManifest {
  readonly version: number;
  readonly scope: ManagedBaseScope;
  readonly tables: readonly ManagedManifestTable[];
  readonly digestSha256: string;
}

export interface ManagedFieldBinding {
  readonly key: string;
  readonly fieldId: AirtableFieldId;
  readonly type: AirtableFieldType;
}

export interface ManagedTableBinding {
  readonly key: string;
  readonly tableId: AirtableTableId;
  readonly primaryFieldId: AirtableFieldId;
  readonly defaultViewId: string;
  readonly stableIdFieldId: AirtableFieldId;
  readonly fields: readonly ManagedFieldBinding[];
}

export interface ManagedSchemaBinding {
  readonly manifestVersion: number;
  readonly manifestDigestSha256: string;
  readonly baseId: AirtableBaseSchema['id'];
  readonly tables: readonly ManagedTableBinding[];
}

const stableKey = /^[a-z][a-z0-9_.-]{0,127}$/u;
const VIEW_DESCRIPTION = 'JooEvents keeps this current — edits here are put back.';
const EDITABLE_DESCRIPTION = 'Edits here update JooEvents when this area is set to Work from Airtable.';
const REQUEST_DESCRIPTION = 'Fill this in to propose a change. It takes effect after review in JooEvents.';
const CONTROL_DESCRIPTION = 'Used by JooEvents to keep this base in sync — best left alone.';
const dateTimeOptions = Object.freeze({
  timeZone: 'utc',
  dateFormat: Object.freeze({ name: 'iso', format: 'YYYY-MM-DD' }),
  timeFormat: Object.freeze({ name: '24hour', format: 'HH:mm' })
});

function assertName(value: string, kind: 'table' | 'field'): void {
  if (value.trim() !== value || value.length < 1 || value.length > 255) {
    throw new TypeError(`managed_manifest_${kind}_name_invalid`);
  }
}

function freezeField(field: ManagedManifestField): ManagedManifestField {
  if (!stableKey.test(field.key)) throw new TypeError('managed_manifest_field_key_invalid');
  assertName(field.name, 'field');
  if (!field.description || field.description.length > 20_000) {
    throw new TypeError('managed_manifest_field_description_invalid');
  }
  const options = field.options === undefined
    ? undefined
    : canonicalJsonValue(field.options) as Readonly<Record<string, unknown>>;
  return Object.freeze({ ...field, ...(options === undefined ? {} : { options }) });
}

export function createManagedBaseManifest(input: Readonly<{
  version: number;
  scope: ManagedBaseScope;
  tables: readonly ManagedManifestTable[];
}>): ManagedBaseManifest {
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.tables.length < 1) {
    throw new TypeError('managed_manifest_invalid');
  }
  const tableKeys = new Set<string>();
  const tableNames = new Set<string>();
  const tables = input.tables.map((table) => {
    if (!stableKey.test(table.key) || tableKeys.has(table.key)) {
      throw new TypeError('managed_manifest_table_key_invalid');
    }
    tableKeys.add(table.key);
    assertName(table.name, 'table');
    const foldedName = table.name.toLocaleLowerCase('en-US');
    if (tableNames.has(foldedName)) throw new TypeError('managed_manifest_table_name_duplicate');
    tableNames.add(foldedName);
    if (!table.description || table.description.length > 20_000 || table.fields.length < 1) {
      throw new TypeError('managed_manifest_table_invalid');
    }
    const fieldKeys = new Set<string>();
    const fieldNames = new Set<string>();
    let reachedControls = false;
    const fields = table.fields.map((candidate, index) => {
      const field = freezeField(candidate);
      if (fieldKeys.has(field.key)) throw new TypeError('managed_manifest_field_key_duplicate');
      fieldKeys.add(field.key);
      const folded = field.name.toLocaleLowerCase('en-US');
      if (fieldNames.has(folded)) throw new TypeError('managed_manifest_field_name_duplicate');
      fieldNames.add(folded);
      if (index === 0 && field.type !== 'singleLineText') {
        throw new TypeError('managed_manifest_primary_field_invalid');
      }
      if (field.authority === 'control') reachedControls = true;
      else if (reachedControls) throw new TypeError('managed_manifest_control_fields_not_last');
      return field;
    });
    if (!fieldKeys.has(table.stableIdFieldKey)) throw new TypeError('managed_manifest_stable_id_missing');
    const stableId = fields.find((field) => field.key === table.stableIdFieldKey);
    if (stableId?.authority !== 'control' || stableId.type !== 'singleLineText') {
      throw new TypeError('managed_manifest_stable_id_invalid');
    }
    return Object.freeze({ ...table, fields: Object.freeze(fields) });
  });
  const body = { version: input.version, scope: input.scope, tables };
  return Object.freeze({
    ...body,
    digestSha256: canonicalJsonSha256(body as unknown as CanonicalJson)
  });
}

function field(
  key: string,
  name: string,
  type: AirtableFieldType = 'singleLineText',
  options?: Readonly<Record<string, unknown>>,
  authority: ManagedFieldAuthority = 'view'
): ManagedManifestField {
  return Object.freeze({
    key,
    name,
    type,
    authority,
    description: authority === 'editable'
      ? EDITABLE_DESCRIPTION
      : authority === 'request' ? REQUEST_DESCRIPTION : VIEW_DESCRIPTION,
    ...(options === undefined ? {} : { options })
  });
}

function controls(): readonly ManagedManifestField[] {
  return Object.freeze([
    Object.freeze({ key: 'sync_state', name: 'Sync state', type: 'singleLineText' as const,
      authority: 'control' as const, description: CONTROL_DESCRIPTION }),
    Object.freeze({ key: 'last_synced', name: 'Last synced', type: 'dateTime' as const,
      authority: 'control' as const, description: CONTROL_DESCRIPTION, options: dateTimeOptions }),
    Object.freeze({ key: 'jooevents_id', name: 'JooEvents ID', type: 'singleLineText' as const,
      authority: 'control' as const, description: CONTROL_DESCRIPTION })
  ]);
}

function eventField(scope: ManagedBaseScope): readonly ManagedManifestField[] {
  return scope === 'all_events' ? Object.freeze([field('event', 'Event')]) : Object.freeze([]);
}

export function createDefaultManagedBaseManifest(input: Readonly<{
  scope: ManagedBaseScope;
  includeSpeakerEmail: boolean;
  includeSpeakerPhone: boolean;
  vocabulary?: Readonly<{
    submissions?: string;
    sessions?: string;
    speakers?: string;
  }>;
}>): ManagedBaseManifest {
  const submissions = input.vocabulary?.submissions ?? 'Submissions';
  const sessions = input.vocabulary?.sessions ?? 'Sessions';
  const speakers = input.vocabulary?.speakers ?? 'Speakers';
  const tables: ManagedManifestTable[] = [
    {
      key: 'speakers', name: speakers,
      description: 'People speaking at the selected events, with their program engagement.',
      stableIdFieldKey: 'jooevents_id',
      fields: [
        field('speaker', 'Speaker'),
        ...(input.includeSpeakerEmail ? [field('email', 'Email', 'email')] : []),
        ...(input.includeSpeakerPhone ? [field('phone', 'Phone', 'phoneNumber')] : []),
        field('submission', 'Submission'), field('session', 'Session'),
        field('confirmation', 'Confirmation'),
        field('effective_status', 'Effective status'),
        field('requested_status', 'Requested status', 'singleLineText', undefined, 'request'),
        field('cancellation_note', 'Cancellation note', 'multilineText', undefined, 'request'),
        ...eventField(input.scope), ...controls()
      ]
    },
    {
      key: 'submissions', name: submissions,
      description: 'Submitted program ideas and their current review outcome.',
      stableIdFieldKey: 'jooevents_id',
      fields: [field('submission', 'Submission'), field('speakers', speakers), field('track', 'Track'),
        field('status', 'Status'), ...eventField(input.scope), ...controls()]
    },
    {
      key: 'sessions', name: sessions,
      description: 'Program sessions with their current placement.',
      stableIdFieldKey: 'jooevents_id',
      fields: [field('session', 'Session'), field('speakers', speakers), field('room', 'Room'),
        field('starts', 'Starts', 'dateTime', dateTimeOptions),
        field('ends', 'Ends', 'dateTime', dateTimeOptions), field('status', 'Status'),
        ...eventField(input.scope), ...controls()]
    },
    {
      key: 'tasks', name: 'Tasks',
      description: 'Organizer tasks that support the selected events.',
      stableIdFieldKey: 'jooevents_id',
      fields: [field('task', 'Task'), field('assignee', 'Assignee'),
        field('due', 'Due', 'dateTime', dateTimeOptions),
        field('status', 'Status', 'singleLineText', undefined, 'editable'),
        ...eventField(input.scope), ...controls()]
    }
  ];
  if (input.scope === 'all_events') {
    tables.push({
      key: 'events', name: 'Events', description: 'Events included in this managed base.',
      stableIdFieldKey: 'jooevents_id',
      fields: [field('event', 'Event'), field('starts', 'Starts', 'dateTime', dateTimeOptions),
        field('ends', 'Ends', 'dateTime', dateTimeOptions), field('venue', 'Venue'), ...controls()]
    });
  }
  return createManagedBaseManifest({ version: 2, scope: input.scope, tables });
}

export function toAirtableCreateTables(
  manifest: ManagedBaseManifest
): readonly AirtableCreateTableInput[] {
  return Object.freeze(manifest.tables.map((table) => Object.freeze({
    name: table.name,
    description: table.description,
    fields: Object.freeze(table.fields.map((candidate) => Object.freeze({
      name: candidate.name,
      type: candidate.type,
      description: candidate.description,
      ...(candidate.options === undefined ? {} : { options: candidate.options })
    })))
  })));
}

export type BindManagedSchemaResult =
  | Readonly<{ kind: 'bound'; binding: ManagedSchemaBinding }>
  | Readonly<{ kind: 'drift'; code: string; tableKey?: string; fieldKey?: string }>;

export function bindManagedSchema(
  manifest: ManagedBaseManifest,
  schema: AirtableBaseSchema
): BindManagedSchemaResult {
  const tables: ManagedTableBinding[] = [];
  for (const expectedTable of manifest.tables) {
    const matches = schema.tables.filter((table) => table.name === expectedTable.name);
    if (matches.length !== 1) return { kind: 'drift', code: 'table_name_match', tableKey: expectedTable.key };
    const actualTable = matches[0]!;
    const fields: ManagedFieldBinding[] = [];
    for (const expectedField of expectedTable.fields) {
      const candidates = actualTable.fields.filter((field) => field.name === expectedField.name);
      if (candidates.length !== 1 || candidates[0]!.type !== expectedField.type) {
        return { kind: 'drift', code: 'field_name_type_match', tableKey: expectedTable.key,
          fieldKey: expectedField.key };
      }
      fields.push(Object.freeze({ key: expectedField.key, fieldId: candidates[0]!.id,
        type: expectedField.type }));
    }
    const stable = fields.find((field) => field.key === expectedTable.stableIdFieldKey)!;
    const defaultView = actualTable.views.find((view) => view.type === 'grid');
    if (!defaultView) return { kind: 'drift', code: 'default_grid_missing', tableKey: expectedTable.key };
    tables.push(Object.freeze({
      key: expectedTable.key,
      tableId: actualTable.id,
      primaryFieldId: actualTable.primaryFieldId,
      defaultViewId: defaultView.id,
      stableIdFieldId: stable.fieldId,
      fields: Object.freeze(fields)
    }));
  }
  return Object.freeze({
    kind: 'bound',
    binding: Object.freeze({
      manifestVersion: manifest.version,
      manifestDigestSha256: manifest.digestSha256,
      baseId: schema.id,
      tables: Object.freeze(tables)
    })
  });
}

export interface ManagedProjectedRecord {
  readonly subjectKey: string;
  readonly fields: Readonly<Record<string, AirtableCellValue>>;
}

export function projectSnapshotBatch(input: Readonly<{
  manifest: ManagedBaseManifest;
  binding: ManagedSchemaBinding;
  tableKey: string;
  records: readonly ManagedProjectedRecord[];
  syncedAt: string;
}>): Readonly<{
  tableId: AirtableTableId;
  stableIdFieldId: AirtableFieldId;
  writes: readonly AirtableWriteRecord[];
}> {
  if (input.binding.manifestDigestSha256 !== input.manifest.digestSha256
    || input.records.length < 1 || input.records.length > 10 || !Number.isFinite(Date.parse(input.syncedAt))) {
    throw new TypeError('managed_snapshot_batch_invalid');
  }
  const manifestTable = input.manifest.tables.find((table) => table.key === input.tableKey);
  const bindingTable = input.binding.tables.find((table) => table.key === input.tableKey);
  if (!manifestTable || !bindingTable) throw new TypeError('managed_snapshot_table_missing');
  const fields = new Map(bindingTable.fields.map((field) => [field.key, field.fieldId]));
  const allowed = new Set(manifestTable.fields.map((field) => field.key));
  const writes: AirtableWriteRecord[] = input.records.map((record) => {
    if (!record.subjectKey || record.subjectKey.length > 256) throw new TypeError('managed_snapshot_subject_invalid');
    const cells: Record<AirtableFieldId, AirtableCellValue> = {
      [bindingTable.stableIdFieldId]: record.subjectKey
    };
    for (const [key, value] of Object.entries(record.fields)) {
      if (key === manifestTable.stableIdFieldKey) {
        if (value !== record.subjectKey) throw new TypeError('managed_snapshot_stable_id_mismatch');
        continue;
      }
      if (!allowed.has(key)) {
        throw new TypeError('managed_snapshot_field_invalid');
      }
      const fieldId = fields.get(key);
      if (!fieldId) throw new TypeError('managed_snapshot_field_unbound');
      cells[fieldId] = canonicalJsonValue(value);
    }
    const syncedId = fields.get('last_synced');
    if (syncedId) cells[syncedId] = input.syncedAt;
    return Object.freeze({ fields: Object.freeze(cells) });
  });
  return Object.freeze({
    tableId: bindingTable.tableId,
    stableIdFieldId: bindingTable.stableIdFieldId,
    writes: Object.freeze(writes)
  });
}

export interface SnapshotRecordLink {
  readonly tableKey: string;
  readonly subjectKey: string;
  readonly recordId: AirtableRecordId;
}
