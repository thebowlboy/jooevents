import {
  deriveProgramTrackAccent,
  formDefinitionHeadSchema,
  formVersionSchema,
  programVocabularyIdSchema,
  programVocabularySnapshotSchema,
  submissionSubmitEvidenceSchema,
  type FormDefinitionHeadDto,
  type FormVersionDto,
  type ProgramVocabularyItemDto,
  type ProgramVocabularyKind,
  type ProgramVocabularySnapshotDto,
  type SubmissionSubmitEvidenceDto
} from '@jooevents/contracts';
import { parseFieldRegistryState, type FieldRegistryState } from '@jooevents/field-registry';
import { canonicalJsonText, parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { parseProgramVocabularyState } from '@jooevents/program';
import type { ProgramVocabularySnapshotReadSource } from '@jooevents/program-operations';

const MAX_ROWS = 10_000;

interface EventRootRow { readonly event_id: unknown }
interface SetRow { readonly set_version: unknown }
interface CatalogRow { readonly catalog_version: unknown }
interface NamedItemRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly status: unknown;
  readonly version: unknown;
}
interface RoomRow extends NamedItemRow { readonly capacity: unknown }
interface CurrentReferenceRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly form_id: unknown;
  readonly reference_key: unknown;
  readonly slot_kind: unknown;
  readonly field_id: unknown;
  readonly rule_id: unknown;
  readonly origin_item_id: unknown;
  readonly item_kind: unknown;
  readonly item_id: unknown;
  readonly version: unknown;
}
interface ScheduleReferenceRow {
  readonly reference_key: unknown;
  readonly item_kind: unknown;
  readonly item_id: unknown;
  readonly version: unknown;
}
interface FieldRegistryRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly registry_version: unknown;
  readonly state_json: unknown;
  readonly state_digest_sha256: unknown;
}
interface FormHeadRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly form_id: unknown;
  readonly head_version: unknown;
  readonly status: unknown;
  readonly current_published_version_id: unknown;
  readonly head_json: unknown;
  readonly head_digest_sha256: unknown;
  readonly created_by_user_id: unknown;
  readonly created_at_ms: unknown;
  readonly updated_by_user_id: unknown;
  readonly updated_at_ms: unknown;
}
interface FormVersionRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly form_id: unknown;
  readonly form_version_id: unknown;
  readonly version_number: unknown;
  readonly source_definition_version: unknown;
  readonly version_json: unknown;
  readonly version_digest_sha256: unknown;
  readonly published_by_user_id: unknown;
  readonly published_at_ms: unknown;
}
interface SubmissionEvidenceRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly submission_id: unknown;
  readonly evidence_id: unknown;
  readonly evidence_json: unknown;
  readonly evidence_digest_sha256: unknown;
}

interface CurrentFormReference {
  readonly formId: string;
  readonly referenceKey: string;
  readonly slotKind: 'target' | 'option_exposure' | 'rule_condition';
  readonly fieldId: string | null;
  readonly ruleId: string | null;
  readonly originItemId: string;
  readonly itemKind: 'track' | 'format';
  readonly itemId: string;
  readonly version: number;
}

export class D1ProgramVocabularyReadError extends Error {
  readonly name = 'D1ProgramVocabularyReadError';

  constructor(
    readonly code: 'wrong_scope' | 'data_corrupt' | 'row_limit_exceeded',
    options?: { readonly cause?: unknown }
  ) {
    super(code, options);
  }
}

function oneOrNone<Row>(result: D1Result<Row>): Row | undefined {
  if (result.results.length > 1) throw new D1ProgramVocabularyReadError('data_corrupt');
  return result.results[0];
}

function boundedRows<Row>(result: D1Result<Row>): readonly Row[] {
  if (result.results.length > MAX_ROWS) {
    throw new D1ProgramVocabularyReadError('row_limit_exceeded');
  }
  return result.results;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new D1ProgramVocabularyReadError('data_corrupt');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new D1ProgramVocabularyReadError('data_corrupt');
  return value;
}

function nullableCapacity(value: unknown): number | null {
  return value === null ? null : positiveInteger(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function parseFieldRegistry(row: FieldRegistryRow): Promise<FieldRegistryState> {
  try {
    const stored = text(row.state_json);
    const state = parseFieldRegistryState(JSON.parse(stored));
    if (canonicalJsonText(state) !== stored
        || await sha256(stored) !== text(row.state_digest_sha256)
        || row.workspace_id !== state.scope.workspaceId
        || row.event_id !== state.scope.eventId
        || row.registry_version !== state.version) {
      throw new TypeError('field_registry_columns_mismatch');
    }
    return state;
  } catch (cause) {
    if (cause instanceof D1ProgramVocabularyReadError) throw cause;
    throw new D1ProgramVocabularyReadError('data_corrupt', { cause });
  }
}

async function parseFormHead(row: FormHeadRow): Promise<FormDefinitionHeadDto> {
  try {
    const stored = text(row.head_json);
    const head = formDefinitionHeadSchema.parse(JSON.parse(stored));
    if (canonicalJsonText(head) !== stored
        || await sha256(stored) !== text(row.head_digest_sha256)
        || row.workspace_id !== head.scope.workspaceId
        || row.event_id !== head.scope.eventId
        || row.form_id !== head.id
        || row.head_version !== head.version
        || row.status !== head.status
        || row.current_published_version_id !== head.currentPublishedVersionId
        || row.created_by_user_id !== head.createdByUserId
        || row.created_at_ms !== Date.parse(head.createdAt)
        || row.updated_by_user_id !== head.updatedByUserId
        || row.updated_at_ms !== Date.parse(head.updatedAt)) {
      throw new TypeError('form_head_columns_mismatch');
    }
    return head;
  } catch (cause) {
    if (cause instanceof D1ProgramVocabularyReadError) throw cause;
    throw new D1ProgramVocabularyReadError('data_corrupt', { cause });
  }
}

function currentReferenceKey(reference: CurrentFormReference): string {
  if (reference.slotKind === 'target'
      && reference.fieldId === null
      && reference.ruleId === null) {
    return `intake_form:${reference.formId}:target`;
  }
  if (reference.slotKind === 'option_exposure'
      && reference.fieldId !== null
      && reference.ruleId === null) {
    return `intake_form:${reference.formId}:field:${reference.fieldId}:exposure:${reference.originItemId}`;
  }
  if (reference.slotKind === 'rule_condition'
      && reference.fieldId !== null
      && reference.ruleId !== null) {
    return `intake_form:${reference.formId}:rule:${reference.ruleId}:choice:${reference.originItemId}`;
  }
  throw new D1ProgramVocabularyReadError('data_corrupt');
}

function parseCurrentFormReference(
  row: CurrentReferenceRow,
  scope: { readonly workspaceId: string; readonly eventId: string }
): CurrentFormReference {
  if (row.workspace_id !== scope.workspaceId
      || row.event_id !== scope.eventId
      || typeof row.form_id !== 'string'
      || (row.slot_kind !== 'target'
        && row.slot_kind !== 'option_exposure'
        && row.slot_kind !== 'rule_condition')
      || (row.field_id !== null && typeof row.field_id !== 'string')
      || (row.rule_id !== null && typeof row.rule_id !== 'string')
      || typeof row.origin_item_id !== 'string'
      || (row.item_kind !== 'track' && row.item_kind !== 'format')
      || typeof row.item_id !== 'string') {
    throw new D1ProgramVocabularyReadError('data_corrupt');
  }
  const reference: CurrentFormReference = {
    formId: row.form_id,
    referenceKey: text(row.reference_key),
    slotKind: row.slot_kind,
    fieldId: row.field_id,
    ruleId: row.rule_id,
    originItemId: row.origin_item_id,
    itemKind: row.item_kind,
    itemId: programVocabularyIdSchema.parse(row.item_id),
    version: positiveInteger(row.version)
  };
  if (reference.referenceKey !== currentReferenceKey(reference)) {
    throw new D1ProgramVocabularyReadError('data_corrupt');
  }
  return reference;
}

function currentReferenceLocation(reference: CurrentFormReference): string {
  if (reference.slotKind === 'target') return 'target';
  if (reference.slotKind === 'option_exposure' && reference.fieldId !== null) {
    return `option_exposure:${reference.fieldId}`;
  }
  if (reference.slotKind === 'rule_condition' && reference.ruleId !== null) {
    return `rule_condition:${reference.ruleId}`;
  }
  throw new D1ProgramVocabularyReadError('data_corrupt');
}

function validateCurrentFormReferences(input: {
  readonly heads: readonly FormDefinitionHeadDto[];
  readonly registry: FieldRegistryState;
  readonly references: readonly CurrentFormReference[];
}): void {
  const registryFields = new Map([
    ...input.registry.fields.map((field) => [field.id, field] as const),
    ...input.registry.removed.map((removed) => [removed.field.id, removed.field] as const)
  ]);
  const referencesByForm = new Map<string, CurrentFormReference[]>();
  for (const reference of input.references) {
    const group = referencesByForm.get(reference.formId) ?? [];
    group.push(reference);
    referencesByForm.set(reference.formId, group);
  }
  for (const head of input.heads) {
    const expected = new Map<string, {
      readonly kind: 'track' | 'format';
      readonly ids: Set<string>;
    }>();
    if (head.definition.target.kind === 'category') {
      expected.set('target', {
        kind: head.definition.target.category.kind,
        ids: new Set([head.definition.target.category.id])
      });
    }
    for (const [fieldId, itemIds] of Object.entries(
      head.definition.composition.optionExposure
    )) {
      const field = registryFields.get(fieldId);
      if (!field || field.options.kind !== 'program_vocabulary') {
        throw new D1ProgramVocabularyReadError('data_corrupt');
      }
      expected.set(`option_exposure:${fieldId}`, {
        kind: programKind(field.options.source),
        ids: new Set(itemIds)
      });
    }
    for (const rule of head.definition.rules) {
      if (rule.condition.kind !== 'selected_any') continue;
      const field = registryFields.get(rule.condition.sourceFieldId);
      if (!field || field.options.kind !== 'program_vocabulary') continue;
      expected.set(`rule_condition:${rule.id}`, {
        kind: programKind(field.options.source),
        ids: new Set(rule.condition.choiceIds)
      });
    }
    const actual = new Map<string, {
      readonly kind: 'track' | 'format';
      readonly ids: Set<string>;
    }>();
    for (const reference of referencesByForm.get(head.id) ?? []) {
      const location = currentReferenceLocation(reference);
      const existing = actual.get(location);
      if (existing && existing.kind !== reference.itemKind) {
        throw new D1ProgramVocabularyReadError('data_corrupt');
      }
      const ids = existing?.ids ?? new Set<string>();
      ids.add(reference.itemId);
      actual.set(location, { kind: reference.itemKind, ids });
    }
    referencesByForm.delete(head.id);
    if (actual.size !== expected.size || [...expected].some(([location, expectedValue]) => {
      const actualValue = actual.get(location);
      return !actualValue
        || actualValue.kind !== expectedValue.kind
        || actualValue.ids.size !== expectedValue.ids.size
        || [...expectedValue.ids].some((id) => !actualValue.ids.has(id));
    })) {
      throw new D1ProgramVocabularyReadError('data_corrupt');
    }
  }
  if (referencesByForm.size > 0) throw new D1ProgramVocabularyReadError('data_corrupt');
}

async function parseFormVersion(row: FormVersionRow): Promise<FormVersionDto> {
  try {
    const stored = text(row.version_json);
    const version = formVersionSchema.parse(JSON.parse(stored));
    if (canonicalJsonText(version) !== stored
        || await sha256(stored) !== text(row.version_digest_sha256)
        || row.workspace_id !== version.scope.workspaceId
        || row.event_id !== version.scope.eventId
        || row.form_id !== version.formId
        || row.form_version_id !== version.id
        || row.version_number !== version.number
        || row.source_definition_version !== version.sourceDefinitionVersion
        || row.published_by_user_id !== version.publishedByUserId
        || row.published_at_ms !== Date.parse(version.publishedAt)) {
      throw new TypeError('form_version_columns_mismatch');
    }
    return version;
  } catch (cause) {
    if (cause instanceof D1ProgramVocabularyReadError) throw cause;
    throw new D1ProgramVocabularyReadError('data_corrupt', { cause });
  }
}

async function parseSubmissionEvidence(
  row: SubmissionEvidenceRow
): Promise<SubmissionSubmitEvidenceDto> {
  try {
    const stored = text(row.evidence_json);
    const evidence = submissionSubmitEvidenceSchema.parse(JSON.parse(stored));
    if (canonicalJsonText(evidence) !== stored
        || await sha256(stored) !== text(row.evidence_digest_sha256)
        || row.submission_id !== evidence.submissionId
        || row.evidence_id !== evidence.id) {
      throw new TypeError('submission_evidence_columns_mismatch');
    }
    return evidence;
  } catch (cause) {
    if (cause instanceof D1ProgramVocabularyReadError) throw cause;
    throw new D1ProgramVocabularyReadError('data_corrupt', { cause });
  }
}

function programKind(source: 'tracks' | 'formats'): 'track' | 'format' {
  return source === 'tracks' ? 'track' : 'format';
}

interface Usage { current: number; historicalPins: number }

function usageKey(kind: ProgramVocabularyKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function projectItem(
  item: {
    readonly kind: ProgramVocabularyKind;
    readonly id: string;
    readonly name: string;
    readonly status: 'active' | 'retired';
    readonly version: number;
    readonly capacity?: number | null;
  },
  usage: Usage
): ProgramVocabularyItemDto {
  const deleteEligibility = usage.current === 0 && usage.historicalPins === 0
    ? { kind: 'eligible' as const }
    : {
        kind: 'blocked' as const,
        currentReferences: usage.current,
        historicalPins: usage.historicalPins
      };
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    status: item.status,
    version: item.version,
    usage,
    deleteEligibility,
    ...(item.kind === 'room'
      ? { capacity: item.capacity ?? null }
      : item.kind === 'track'
        ? { accent: deriveProgramTrackAccent(item.id) }
        : {})
  } as ProgramVocabularyItemDto;
}

/** Reads one exact current-Event Program Vocabulary projection in one D1 session. */
export function createD1ProgramVocabularySnapshotReadSource(input: {
  readonly database: D1Database;
  readonly workspaceId: string;
}): ProgramVocabularySnapshotReadSource {
  const configuredWorkspaceId = parseWorkspaceId(input.workspaceId);

  return Object.freeze({
    async readSnapshot(scopeInput: {
      readonly workspaceId: string;
      readonly eventId: string;
    }): Promise<ProgramVocabularySnapshotDto | undefined> {
      const workspaceId = parseWorkspaceId(scopeInput.workspaceId);
      const eventId = parseEventId(scopeInput.eventId);
      if (workspaceId !== configuredWorkspaceId) {
        throw new D1ProgramVocabularyReadError('wrong_scope');
      }
      const session = input.database.withSession('first-primary');
      const results = await session.batch([
        session.prepare(`
          SELECT event_id
            FROM event_spine_scope_roots
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY workspace_id, event_id
           LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`
          SELECT set_version
            FROM program_vocabulary_sets
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY workspace_id, event_id
           LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`
          SELECT id, name, capacity, status, version
            FROM program_vocabulary_rooms
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT id, name, status, version
            FROM program_vocabulary_tracks
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT id, name, status, version
            FROM program_vocabulary_formats
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT catalog_version
            FROM intake_form_catalogs
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY workspace_id, event_id
           LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`
          SELECT workspace_id, event_id, registry_version, state_json,
                 state_digest_sha256
            FROM field_registry_aggregates
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY workspace_id, event_id
           LIMIT 2`).bind(workspaceId, eventId),
        session.prepare(`
          SELECT workspace_id, event_id, form_id, head_version, status,
                 current_published_version_id, head_json, head_digest_sha256,
                 created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
            FROM intake_form_heads
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY form_id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT workspace_id, event_id, form_id, slot_key AS reference_key,
                 slot_kind, field_id, rule_id, origin_item_id, item_kind, item_id,
                 slot_version AS version
            FROM intake_form_program_reference_slots
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY slot_key COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT id AS reference_key, 'room' AS item_kind, room_id AS item_id,
                 version
            FROM schedule_occurrences
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT workspace_id, event_id, form_id, form_version_id, version_number,
                 source_definition_version, version_json, version_digest_sha256,
                 published_by_user_id, published_at_ms
            FROM intake_form_versions
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY form_version_id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1),
        session.prepare(`
          SELECT workspace_id, event_id, submission_id, evidence_id,
                 evidence_json, evidence_digest_sha256
            FROM intake_submission_submit_evidence
           WHERE workspace_id = ? AND event_id = ?
           ORDER BY submission_id COLLATE BINARY, evidence_id COLLATE BINARY
           LIMIT ?`).bind(workspaceId, eventId, MAX_ROWS + 1)
      ]);

      const root = oneOrNone(results[0] as D1Result<EventRootRow>);
      if (!root) return undefined;
      if (root.event_id !== eventId) throw new D1ProgramVocabularyReadError('data_corrupt');
      const set = oneOrNone(results[1] as D1Result<SetRow>);
      const rooms = boundedRows(results[2] as D1Result<RoomRow>);
      const tracks = boundedRows(results[3] as D1Result<NamedItemRow>);
      const formats = boundedRows(results[4] as D1Result<NamedItemRow>);
      const catalog = oneOrNone(results[5] as D1Result<CatalogRow>);
      if (catalog && positiveInteger(catalog.catalog_version) < 2) {
        throw new D1ProgramVocabularyReadError('data_corrupt');
      }
      const registryRow = oneOrNone(results[6] as D1Result<FieldRegistryRow>);
      if (!registryRow) throw new D1ProgramVocabularyReadError('data_corrupt');
      const registry = await parseFieldRegistry(registryRow);
      const formHeads = await Promise.all(
        boundedRows(results[7] as D1Result<FormHeadRow>).map(parseFormHead)
      );
      const formReferences = boundedRows(results[8] as D1Result<CurrentReferenceRow>)
        .map((row) => parseCurrentFormReference(row, { workspaceId, eventId }));
      if (!catalog && (formHeads.length > 0 || formReferences.length > 0)) {
        throw new D1ProgramVocabularyReadError('data_corrupt');
      }
      validateCurrentFormReferences({ heads: formHeads, registry, references: formReferences });
      const scheduleReferences = boundedRows(results[9] as D1Result<ScheduleReferenceRow>);
      const formVersions = await Promise.all(
        boundedRows(results[10] as D1Result<FormVersionRow>).map(parseFormVersion)
      );
      const submissionEvidence = await Promise.all(
        boundedRows(results[11] as D1Result<SubmissionEvidenceRow>).map(parseSubmissionEvidence)
      );
      if (!catalog && formVersions.length > 0) {
        throw new D1ProgramVocabularyReadError('data_corrupt');
      }

      let state;
      try {
        state = parseProgramVocabularyState({
          scope: { workspaceId, eventId },
          setVersion: set ? positiveInteger(set.set_version) : 1,
          rooms: rooms.map((row) => ({
            id: text(row.id),
            name: text(row.name),
            capacity: nullableCapacity(row.capacity),
            status: text(row.status),
            version: positiveInteger(row.version)
          })),
          tracks: tracks.map((row) => ({
            id: text(row.id),
            name: text(row.name),
            status: text(row.status),
            version: positiveInteger(row.version)
          })),
          formats: formats.map((row) => ({
            id: text(row.id),
            name: text(row.name),
            status: text(row.status),
            version: positiveInteger(row.version)
          }))
        });
      } catch (cause) {
        if (cause instanceof D1ProgramVocabularyReadError) throw cause;
        throw new D1ProgramVocabularyReadError('data_corrupt', { cause });
      }

      const itemIds = new Set<string>([
        ...state.rooms.map((item) => usageKey('room', item.id)),
        ...state.tracks.map((item) => usageKey('track', item.id)),
        ...state.formats.map((item) => usageKey('format', item.id))
      ]);
      const usage = new Map<string, Usage>();
      const referenceKeys = new Set<string>();
      const addReference = (
        referenceKey: string,
        kind: ProgramVocabularyKind,
        id: string,
        mode: keyof Usage
      ) => {
        if (!itemIds.has(usageKey(kind, id)) || referenceKeys.has(referenceKey)) {
          throw new D1ProgramVocabularyReadError('data_corrupt');
        }
        referenceKeys.add(referenceKey);
        const key = usageKey(kind, id);
        const existing = usage.get(key) ?? { current: 0, historicalPins: 0 };
        usage.set(key, { ...existing, [mode]: existing[mode] + 1 });
      };

      for (const reference of formReferences) {
        addReference(`current:${reference.referenceKey}`, reference.itemKind,
          reference.itemId, 'current');
      }
      for (const row of scheduleReferences) {
        const kind = text(row.item_kind);
        if (kind !== 'room' && kind !== 'track' && kind !== 'format') {
          throw new D1ProgramVocabularyReadError('data_corrupt');
        }
        positiveInteger(row.version);
        addReference(`schedule:${text(row.reference_key)}`, kind,
          programVocabularyIdSchema.parse(row.item_id), 'current');
      }
      for (const version of formVersions) {
        if (version.targetPin?.kind === 'category') {
          addReference(`form-version:${version.id}:target`, version.targetPin.categoryKind,
            version.targetPin.id, 'historicalPins');
        }
        for (const field of version.definition.fields) {
          if ((field.kind !== 'select' && field.kind !== 'multiselect')
              || field.options.kind !== 'program_vocabulary'
              || field.options.exposure.kind !== 'subset') continue;
          for (const item of field.options.exposure.items) {
            addReference(`form-version:${version.id}:field:${field.id}:exposure:${item.id}`,
              programKind(item.source), item.id, 'historicalPins');
          }
        }
        for (const rule of version.definition.rules) {
          if (rule.condition.kind !== 'selected_any') continue;
          for (const pin of rule.condition.programVocabularyPins) {
            addReference(`form-version:${version.id}:rule:${rule.id}:choice:${pin.id}`,
              programKind(pin.source), pin.id, 'historicalPins');
          }
        }
      }
      for (const evidence of submissionEvidence) {
        for (const pin of evidence.programVocabularyAnswerPins) {
          addReference(`submission:${evidence.submissionId}:field:${pin.fieldId}:choice:${pin.itemId}`,
            programKind(pin.source), pin.itemId, 'historicalPins');
        }
      }

      const emptyUsage = Object.freeze({ current: 0, historicalPins: 0 });
      return programVocabularySnapshotSchema.parse({
        schemaVersion: 1,
        scope: state.scope,
        setVersion: state.setVersion,
        rooms: state.rooms.map((item) => projectItem(item,
          usage.get(usageKey('room', item.id)) ?? emptyUsage)),
        tracks: state.tracks.map((item) => projectItem(item,
          usage.get(usageKey('track', item.id)) ?? emptyUsage)),
        formats: state.formats.map((item) => projectItem(item,
          usage.get(usageKey('format', item.id)) ?? emptyUsage))
      });
    }
  });
}
