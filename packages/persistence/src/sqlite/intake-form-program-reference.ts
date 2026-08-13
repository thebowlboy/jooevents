import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  formDefinitionHeadSchema,
  formVersionSchema,
  programVocabularyScopeSchema,
  submissionSubmitEvidenceSchema,
  type FormDefinitionHeadDto,
  type FormVersionDto,
  type SubmissionSubmitEvidenceDto
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  encodeCanonicalJson,
  parseAggregateVersion,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  ProgramVocabularyPlanningError,
  type ProgramHistoricalPin,
  type ProgramReferenceContributionPlan,
  type ProgramReferenceContributorSnapshot,
  type ProgramReferenceRecord
} from '@jooevents/program';
import {
  fieldRegistryStateDigest,
  parseFieldRegistryState,
  type FieldRegistryState
} from '@jooevents/field-registry';
import type {
  ProgramVocabularyMutationAttribution,
  SQLiteProgramVocabularyContributorAdapter,
  SQLiteProgramVocabularyContributorResolution
} from './program-vocabulary';

export const INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR = Object.freeze({
  key: 'intake.forms',
  version: 1
});

const GUARD_ID = 'program_reference:intake.forms';

interface CatalogRow { readonly catalog_version: number }
interface EventRootRow { readonly event_id: unknown }
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
interface FieldRegistryRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly registry_version: unknown;
  readonly state_json: unknown;
  readonly state_digest_sha256: unknown;
}
interface SubmissionEvidenceRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly submission_id: unknown;
  readonly evidence_id: unknown;
  readonly evidence_json: unknown;
  readonly evidence_digest_sha256: unknown;
}
interface ReferenceSlotRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly form_id: unknown;
  readonly slot_key: unknown;
  readonly slot_kind: unknown;
  readonly field_id: unknown;
  readonly rule_id: unknown;
  readonly origin_item_id: unknown;
  readonly item_kind: unknown;
  readonly item_id: unknown;
  readonly slot_version: unknown;
}

interface ReferenceSlot {
  readonly formId: string;
  readonly slotKey: string;
  readonly slotKind: 'target' | 'option_exposure' | 'rule_condition';
  readonly fieldId: string | null;
  readonly ruleId: string | null;
  readonly originItemId: string;
  readonly itemKind: 'track' | 'format';
  readonly itemId: string;
  readonly slotVersion: number;
}

export class SQLiteIntakeFormProgramReferenceError extends Error {
  constructor(readonly code: 'transaction_required' | 'data_corrupt', cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteIntakeFormProgramReferenceError';
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storedDigest(value: unknown): string {
  return sha256(canonicalJsonText(value));
}

function guardDigest(
  guardVersion: number,
  references: readonly ProgramReferenceRecord[]
): string {
  return sha256(encodeCanonicalJson({
    contributor: INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
    guardVersion,
    references
  }));
}

function currentReferenceKey(formId: string): string {
  return `intake_form:${formId}:target`;
}

function historicalReferenceKey(formVersionId: string): string {
  return `intake_form_version:${formVersionId}:target`;
}

function currentExposureReferenceKey(formId: string, fieldId: string, itemId: string): string {
  return `intake_form:${formId}:field:${fieldId}:exposure:${itemId}`;
}

function currentRuleReferenceKey(formId: string, ruleId: string, itemId: string): string {
  return `intake_form:${formId}:rule:${ruleId}:choice:${itemId}`;
}

function historicalExposureReferenceKey(
  formVersionId: string,
  fieldId: string,
  itemId: string
): string {
  return `intake_form_version:${formVersionId}:field:${fieldId}:exposure:${itemId}`;
}

function historicalRuleReferenceKey(formVersionId: string, ruleId: string, itemId: string): string {
  return `intake_form_version:${formVersionId}:rule:${ruleId}:choice:${itemId}`;
}

function historicalAnswerReferenceKey(
  submissionId: string,
  fieldId: string,
  itemId: string
): string {
  return `intake_submission:${submissionId}:field:${fieldId}:choice:${itemId}`;
}

function slotKey(slot: Pick<ReferenceSlot,
'formId' | 'slotKind' | 'fieldId' | 'ruleId' | 'originItemId'>): string {
  if (slot.slotKind === 'target' && slot.fieldId === null && slot.ruleId === null) {
    return currentReferenceKey(slot.formId);
  }
  if (slot.slotKind === 'option_exposure' && slot.fieldId && slot.ruleId === null) {
    return currentExposureReferenceKey(slot.formId, slot.fieldId, slot.originItemId);
  }
  if (slot.slotKind === 'rule_condition' && slot.fieldId && slot.ruleId) {
    return currentRuleReferenceKey(slot.formId, slot.ruleId, slot.originItemId);
  }
  throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
}

function slotLocation(slot: Pick<ReferenceSlot, 'slotKind' | 'fieldId' | 'ruleId'>): string {
  if (slot.slotKind === 'target' && slot.fieldId === null && slot.ruleId === null) return 'target';
  if (slot.slotKind === 'option_exposure' && slot.fieldId && slot.ruleId === null) {
    return `option_exposure:${slot.fieldId}`;
  }
  if (slot.slotKind === 'rule_condition' && slot.fieldId && slot.ruleId) {
    return `rule_condition:${slot.ruleId}`;
  }
  throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
}

function parseSlot(
  row: ReferenceSlotRow,
  scope: { readonly workspaceId: string; readonly eventId: string }
): ReferenceSlot {
  if (row.workspace_id !== scope.workspaceId || row.event_id !== scope.eventId
      || typeof row.form_id !== 'string' || typeof row.slot_key !== 'string'
      || (row.slot_kind !== 'target'
        && row.slot_kind !== 'option_exposure'
        && row.slot_kind !== 'rule_condition')
      || (row.field_id !== null && typeof row.field_id !== 'string')
      || (row.rule_id !== null && typeof row.rule_id !== 'string')
      || typeof row.origin_item_id !== 'string'
      || (row.item_kind !== 'track' && row.item_kind !== 'format')
      || typeof row.item_id !== 'string'
      || typeof row.slot_version !== 'number'
      || !Number.isSafeInteger(row.slot_version) || row.slot_version <= 0) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  }
  const slot: ReferenceSlot = {
    formId: row.form_id,
    slotKey: row.slot_key,
    slotKind: row.slot_kind,
    fieldId: row.field_id,
    ruleId: row.rule_id,
    originItemId: row.origin_item_id,
    itemKind: row.item_kind,
    itemId: row.item_id,
    slotVersion: row.slot_version
  };
  if (slot.slotKey !== slotKey(slot)) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  }
  return slot;
}

function programKind(source: 'tracks' | 'formats'): 'track' | 'format' {
  return source === 'tracks' ? 'track' : 'format';
}

function parseHead(row: FormHeadRow): FormDefinitionHeadDto {
  try {
    if (typeof row.head_json !== 'string' || typeof row.head_digest_sha256 !== 'string') {
      throw new TypeError('intake_form_head_json_invalid');
    }
    const head = formDefinitionHeadSchema.parse(JSON.parse(row.head_json));
    if (canonicalJsonText(head) !== row.head_json
        || storedDigest(head) !== row.head_digest_sha256
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
      throw new TypeError('intake_form_head_columns_mismatch');
    }
    return head;
  } catch (error) {
    if (error instanceof SQLiteIntakeFormProgramReferenceError) throw error;
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt', error);
  }
}

function parseVersion(row: FormVersionRow): FormVersionDto {
  try {
    if (typeof row.version_json !== 'string' || typeof row.version_digest_sha256 !== 'string') {
      throw new TypeError('intake_form_version_json_invalid');
    }
    const version = formVersionSchema.parse(JSON.parse(row.version_json));
    if (canonicalJsonText(version) !== row.version_json
        || storedDigest(version) !== row.version_digest_sha256
        || row.workspace_id !== version.scope.workspaceId
        || row.event_id !== version.scope.eventId
        || row.form_id !== version.formId
        || row.form_version_id !== version.id
        || row.version_number !== version.number
        || row.source_definition_version !== version.sourceDefinitionVersion
        || row.published_by_user_id !== version.publishedByUserId
        || row.published_at_ms !== Date.parse(version.publishedAt)) {
      throw new TypeError('intake_form_version_columns_mismatch');
    }
    return version;
  } catch (error) {
    if (error instanceof SQLiteIntakeFormProgramReferenceError) throw error;
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt', error);
  }
}

function parseRegistry(row: FieldRegistryRow): FieldRegistryState {
  try {
    if (typeof row.state_json !== 'string' || typeof row.state_digest_sha256 !== 'string') {
      throw new TypeError('field_registry_json_invalid');
    }
    const state = parseFieldRegistryState(JSON.parse(row.state_json));
    if (canonicalJsonText(state) !== row.state_json
        || fieldRegistryStateDigest(state) !== row.state_digest_sha256
        || row.workspace_id !== state.scope.workspaceId
        || row.event_id !== state.scope.eventId
        || row.registry_version !== state.version) {
      throw new TypeError('field_registry_columns_mismatch');
    }
    return state;
  } catch (error) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt', error);
  }
}

function parseSubmissionEvidence(row: SubmissionEvidenceRow): SubmissionSubmitEvidenceDto {
  try {
    if (typeof row.evidence_json !== 'string'
        || typeof row.evidence_digest_sha256 !== 'string') {
      throw new TypeError('submission_evidence_json_invalid');
    }
    const evidence = submissionSubmitEvidenceSchema.parse(JSON.parse(row.evidence_json));
    if (canonicalJsonText(evidence) !== row.evidence_json
        || storedDigest(evidence) !== row.evidence_digest_sha256
        || row.submission_id !== evidence.submissionId
        || row.evidence_id !== evidence.id) {
      throw new TypeError('submission_evidence_columns_mismatch');
    }
    return evidence;
  } catch (error) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt', error);
  }
}

function oneOrNone<Row>(rows: readonly Row[]): Row | undefined {
  if (rows.length > 1) throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  return rows[0];
}

function readSnapshot(
  sqlite: Database,
  scopeInput: { readonly workspaceId: string; readonly eventId: string }
): SQLiteProgramVocabularyContributorResolution {
  const scope = programVocabularyScopeSchema.parse(scopeInput);
  const referenceScope = Object.freeze({
    workspaceId: parseWorkspaceId(scope.workspaceId),
    eventId: parseEventId(scope.eventId)
  });
  const root = oneOrNone(sqlite.query<EventRootRow, [string, string]>(`
    SELECT event_id FROM event_spine_scope_roots
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY workspace_id, event_id LIMIT 2
  `).all(scope.workspaceId, scope.eventId));
  if (!root) return { kind: 'missing' };
  if (root.event_id !== scope.eventId) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  }

  const catalog = oneOrNone(sqlite.query<CatalogRow, [string, string]>(`
    SELECT catalog_version FROM intake_form_catalogs
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY workspace_id, event_id LIMIT 2
  `).all(scope.workspaceId, scope.eventId));
  const guardVersion = catalog?.catalog_version ?? 1;
  if (!Number.isSafeInteger(guardVersion) || (catalog ? guardVersion < 2 : guardVersion !== 1)) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  }

  const registryRow = oneOrNone(sqlite.query<FieldRegistryRow, [string, string]>(`
    SELECT workspace_id, event_id, registry_version, state_json, state_digest_sha256
      FROM field_registry_aggregates
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY workspace_id, event_id LIMIT 2
  `).all(scope.workspaceId, scope.eventId));
  if (!registryRow) throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  const registry = parseRegistry(registryRow);
  const registryFields = new Map([
    ...registry.fields.map((field) => [field.id, field] as const),
    ...registry.removed.map((removed) => [removed.field.id, removed.field] as const)
  ]);

  const headRows = sqlite.query<FormHeadRow, [string, string]>(`
    SELECT workspace_id, event_id, form_id, head_version, status,
           current_published_version_id, head_json, head_digest_sha256,
           created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      FROM intake_form_heads
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY form_id COLLATE BINARY
  `).all(scope.workspaceId, scope.eventId);
  const versionRows = sqlite.query<FormVersionRow, [string, string]>(`
    SELECT workspace_id, event_id, form_id, form_version_id, version_number,
           source_definition_version, version_json, version_digest_sha256,
           published_by_user_id, published_at_ms
      FROM intake_form_versions
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY form_version_id COLLATE BINARY
  `).all(scope.workspaceId, scope.eventId);
  const submissionRows = sqlite.query<SubmissionEvidenceRow, [string, string]>(`
    SELECT workspace_id, event_id, submission_id, evidence_id,
           evidence_json, evidence_digest_sha256
      FROM intake_submission_submit_evidence
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY submission_id COLLATE BINARY, evidence_id COLLATE BINARY
  `).all(scope.workspaceId, scope.eventId);
  const slotRows = sqlite.query<ReferenceSlotRow, [string, string]>(`
    SELECT workspace_id, event_id, form_id, slot_key, slot_kind, field_id, rule_id,
           origin_item_id, item_kind, item_id, slot_version
      FROM intake_form_program_reference_slots
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY slot_key COLLATE BINARY
  `).all(scope.workspaceId, scope.eventId);
  if (!catalog && (headRows.length > 0 || versionRows.length > 0 || slotRows.length > 0)) {
    throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  }

  const references: ProgramReferenceRecord[] = [];
  const slotsByForm = new Map<string, ReferenceSlot[]>();
  for (const row of slotRows) {
    const slot = parseSlot(row, scope);
    const slots = slotsByForm.get(slot.formId) ?? [];
    slots.push(slot);
    slotsByForm.set(slot.formId, slots);
  }
  for (const row of headRows) {
    const head = parseHead(row);
    const expected = new Map<string, { readonly kind: 'track' | 'format'; readonly ids: Set<string> }>();
    if (head.definition.target.kind === 'category') expected.set('target', {
      kind: head.definition.target.category.kind,
      ids: new Set([head.definition.target.category.id])
    });
    for (const [fieldId, itemIds] of Object.entries(head.definition.composition.optionExposure)) {
      const field = registryFields.get(fieldId);
      if (!field || field.options.kind !== 'program_vocabulary') {
        throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
      }
      expected.set(`option_exposure:${fieldId}`, {
        kind: programKind(field.options.source), ids: new Set(itemIds)
      });
    }
    for (const rule of head.definition.rules) {
      if (rule.condition.kind !== 'selected_any') continue;
      const field = registryFields.get(rule.condition.sourceFieldId);
      if (!field || field.options.kind !== 'program_vocabulary') continue;
      expected.set(`rule_condition:${rule.id}`, {
        kind: programKind(field.options.source), ids: new Set(rule.condition.choiceIds)
      });
    }
    const slots = slotsByForm.get(head.id) ?? [];
    slotsByForm.delete(head.id);
    const actual = new Map<string, { readonly kind: 'track' | 'format'; readonly ids: Set<string> }>();
    for (const slot of slots) {
      const location = slotLocation(slot);
      const locationState = actual.get(location);
      if (locationState && locationState.kind !== slot.itemKind) {
        throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
      }
      (locationState?.ids ?? (() => {
        const ids = new Set<string>();
        actual.set(location, { kind: slot.itemKind, ids });
        return ids;
      })()).add(slot.itemId);
      references.push({
        referenceKey: slot.slotKey,
        version: parseAggregateVersion(slot.slotVersion),
        item: { kind: slot.itemKind, id: slot.itemId },
        mode: 'current',
        destination: {
          kind: slot.slotKind === 'target'
            ? 'intake.form'
            : slot.slotKind === 'option_exposure'
              ? 'intake.form.option_exposure'
              : 'intake.form.rule_condition',
          id: head.id
        }
      });
    }
    if (actual.size !== expected.size || [...expected].some(([location, state]) => {
      const found = actual.get(location);
      return !found || found.kind !== state.kind || found.ids.size !== state.ids.size
        || [...state.ids].some((id) => !found.ids.has(id));
    })) throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  }
  if (slotsByForm.size !== 0) throw new SQLiteIntakeFormProgramReferenceError('data_corrupt');
  for (const row of versionRows) {
    const version = parseVersion(row);
    const referenceVersion = parseAggregateVersion(version.number);
    if (version.targetPin?.kind === 'category') references.push({
      referenceKey: historicalReferenceKey(version.id), version: referenceVersion,
      item: { kind: version.targetPin.categoryKind, id: version.targetPin.id },
      mode: 'historical', destination: { kind: 'intake.form_version', id: version.id }
    });
    for (const field of version.definition.fields) {
      if ((field.kind !== 'select' && field.kind !== 'multiselect')
          || field.options.kind !== 'program_vocabulary'
          || field.options.exposure.kind !== 'subset') continue;
      for (const item of field.options.exposure.items) references.push({
        referenceKey: historicalExposureReferenceKey(version.id, field.id, item.id),
        version: referenceVersion,
        item: { kind: programKind(item.source), id: item.id }, mode: 'historical',
        destination: { kind: 'intake.form_version.option_exposure', id: version.id }
      });
    }
    for (const rule of version.definition.rules) {
      if (rule.condition.kind !== 'selected_any') continue;
      for (const pin of rule.condition.programVocabularyPins) references.push({
        referenceKey: historicalRuleReferenceKey(version.id, rule.id, pin.id),
        version: referenceVersion,
        item: { kind: programKind(pin.source), id: pin.id }, mode: 'historical',
        destination: { kind: 'intake.form_version.rule_condition', id: version.id }
      });
    }
  }
  for (const row of submissionRows) {
    const evidence = parseSubmissionEvidence(row);
    for (const pin of evidence.programVocabularyAnswerPins) references.push({
      referenceKey: historicalAnswerReferenceKey(
        evidence.submissionId, pin.fieldId, pin.itemId
      ),
      version: parseAggregateVersion(1),
      item: { kind: programKind(pin.source), id: pin.itemId }, mode: 'historical',
      destination: { kind: 'intake.submission.answer', id: evidence.submissionId }
    });
  }
  references.sort((left, right) => left.referenceKey < right.referenceKey
    ? -1
    : left.referenceKey > right.referenceKey ? 1 : 0);
  const frozenReferences = Object.freeze(references.map((reference) => Object.freeze({
    ...reference,
    item: Object.freeze({ ...reference.item }),
    destination: Object.freeze({ ...reference.destination })
  })));
  const snapshot: ProgramReferenceContributorSnapshot = Object.freeze({
    contributor: INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
    scope: referenceScope,
    guard: Object.freeze({
      id: GUARD_ID,
      version: parseAggregateVersion(guardVersion),
      digest: guardDigest(guardVersion, frozenReferences)
    }),
    references: frozenReferences
  });
  return { kind: 'available', snapshot };
}

function sameHistoricalPin(
  reference: ProgramReferenceRecord | undefined,
  pin: ProgramHistoricalPin
): boolean {
  return reference !== undefined
    && reference.mode === 'historical'
    && reference.version === pin.version
    && reference.item.kind === pin.item.kind
    && reference.item.id === pin.item.id
    && reference.destination.kind === pin.destination.kind
    && reference.destination.id === pin.destination.id;
}

function changedExactlyOnce(result: { readonly changes: number }): void {
  if (result.changes !== 1) {
    const error = new ProgramVocabularyPlanningError('stale_reference');
    Error.captureStackTrace(error, changedExactlyOnce);
    throw error;
  }
}

function applyRepoints(input: {
  readonly sqlite: Database;
  readonly scope: { readonly workspaceId: string; readonly eventId: string };
  readonly contribution: ProgramReferenceContributionPlan;
  readonly attribution: ProgramVocabularyMutationAttribution;
}): void {
  if (!input.sqlite.inTransaction) {
    throw new SQLiteIntakeFormProgramReferenceError('transaction_required');
  }
  const contribution = input.contribution;
  if (contribution.contributor.key !== INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR.key
      || contribution.contributor.version !== INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR.version) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  const resolution = readSnapshot(input.sqlite, input.scope);
  if (resolution.kind !== 'available') throw new ProgramVocabularyPlanningError('stale_reference');
  const snapshot = resolution.snapshot as ProgramReferenceContributorSnapshot;
  if (snapshot.guard.id !== contribution.guard.id
      || snapshot.guard.version !== contribution.guard.version
      || snapshot.guard.digest !== contribution.guard.digest) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  const byKey = new Map(snapshot.references.map((reference) => [reference.referenceKey, reference]));
  if (contribution.historicalPins.some((pin) => !sameHistoricalPin(
    byKey.get(pin.referenceKey), pin
  ))) throw new ProgramVocabularyPlanningError('stale_reference');
  if (contribution.liveRepoints.length === 0) return;

  const actorUserId = parseUserId(input.attribution.actorUserId);
  const occurredAt = parseInstant(input.attribution.occurredAt);
  const occurredAtMs = Date.parse(occurredAt);
  const grouped = new Map<string, {
    readonly entries: {
      readonly reference: ProgramReferenceRecord;
      readonly repoint: ProgramReferenceContributionPlan['liveRepoints'][number];
      readonly slot: ReferenceSlot;
    }[];
  }>();
  const seenReferenceKeys = new Set<string>();
  for (const repoint of contribution.liveRepoints) {
    const reference = byKey.get(repoint.referenceKey);
    if (!reference || seenReferenceKeys.has(repoint.referenceKey)
        || reference.mode !== 'current'
        || reference.version !== repoint.expectedVersion
        || reference.item.kind !== repoint.from.kind
        || reference.item.id !== repoint.from.id
        || repoint.to.kind !== repoint.from.kind
        || repoint.to.id === repoint.from.id
        || (repoint.to.kind !== 'track' && repoint.to.kind !== 'format')
        || repoint.destination.kind !== reference.destination.kind
        || repoint.destination.id !== reference.destination.id
        || !new Set([
          'intake.form',
          'intake.form.option_exposure',
          'intake.form.rule_condition'
        ]).has(reference.destination.kind)) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    const slotRow = oneOrNone(input.sqlite.query<ReferenceSlotRow, [string, string, string]>(`
      SELECT workspace_id, event_id, form_id, slot_key, slot_kind, field_id, rule_id,
             origin_item_id, item_kind, item_id, slot_version
        FROM intake_form_program_reference_slots
       WHERE workspace_id = ? AND event_id = ? AND slot_key = ? LIMIT 2
    `).all(input.scope.workspaceId, input.scope.eventId, repoint.referenceKey));
    if (!slotRow) throw new ProgramVocabularyPlanningError('stale_reference');
    const slot = parseSlot(slotRow, input.scope);
    if (slot.formId !== reference.destination.id
        || slot.itemKind !== repoint.from.kind
        || slot.itemId !== repoint.from.id
        || slot.slotVersion !== repoint.expectedVersion
        || (reference.destination.kind === 'intake.form' && slot.slotKind !== 'target')
        || (reference.destination.kind === 'intake.form.option_exposure'
          && slot.slotKind !== 'option_exposure')
        || (reference.destination.kind === 'intake.form.rule_condition'
          && slot.slotKind !== 'rule_condition')) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    seenReferenceKeys.add(repoint.referenceKey);
    const current = grouped.get(reference.destination.id);
    if (current) current.entries.push({ reference, repoint, slot });
    else grouped.set(reference.destination.id, {
      entries: [{ reference, repoint, slot }]
    });
  }

  const updates: {
    readonly before: FormDefinitionHeadDto;
    readonly after: FormDefinitionHeadDto;
    readonly beforeDigest: string;
  }[] = [];
  for (const [formId, group] of grouped) {
    const row = oneOrNone(input.sqlite.query<FormHeadRow, [string, string, string]>(`
      SELECT workspace_id, event_id, form_id, head_version, status,
             current_published_version_id, head_json, head_digest_sha256,
             created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
        FROM intake_form_heads
       WHERE workspace_id = ? AND event_id = ? AND form_id = ? LIMIT 2
    `).all(input.scope.workspaceId, input.scope.eventId, formId));
    if (!row) throw new ProgramVocabularyPlanningError('stale_reference');
    const before = parseHead(row);
    if (Date.parse(before.updatedAt) > occurredAtMs) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    let target = before.definition.target;
    const optionExposure: Record<string, readonly string[]> = {
      ...before.definition.composition.optionExposure
    };
    let rules = before.definition.rules.map((rule) => ({ ...rule }));
    const formSlots = input.sqlite.query<ReferenceSlotRow, [string, string, string]>(`
      SELECT workspace_id, event_id, form_id, slot_key, slot_kind, field_id, rule_id,
             origin_item_id, item_kind, item_id, slot_version
        FROM intake_form_program_reference_slots
       WHERE workspace_id = ? AND event_id = ? AND form_id = ?
       ORDER BY slot_key COLLATE BINARY
    `).all(input.scope.workspaceId, input.scope.eventId, formId)
      .map((slotRow) => parseSlot(slotRow, input.scope));
    const repointBySlot = new Map(group.entries.map((entry) => [entry.slot.slotKey, entry.repoint]));
    const affectedExposureFields = new Set<string>();
    const affectedRuleIds = new Set<string>();
    for (const { reference, repoint, slot } of group.entries) {
      if (reference.destination.kind === 'intake.form') {
        const categoryKind = repoint.to.kind;
        if (slot.slotKind !== 'target'
            || (categoryKind !== 'track' && categoryKind !== 'format')
            || target.kind !== 'category'
            || target.category.kind !== repoint.from.kind
            || target.category.id !== repoint.from.id) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        target = {
          kind: 'category',
          category: { kind: categoryKind, id: repoint.to.id }
        };
        continue;
      }
      if (reference.destination.kind === 'intake.form.option_exposure') {
        if (slot.slotKind !== 'option_exposure' || !slot.fieldId) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        const itemIds = optionExposure[slot.fieldId];
        if (!itemIds || !itemIds.includes(repoint.from.id)) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        affectedExposureFields.add(slot.fieldId);
        continue;
      }
      const matches = rules.flatMap((rule, index) =>
        rule.condition.kind === 'selected_any'
          && slot.slotKind === 'rule_condition'
          && rule.id === slot.ruleId
          && rule.condition.sourceFieldId === slot.fieldId
          && rule.condition.choiceIds.includes(repoint.from.id)
          ? [{ rule, index }]
          : []
      );
      if (matches.length !== 1) throw new ProgramVocabularyPlanningError('stale_reference');
      const { rule, index } = matches[0]!;
      if (rule.condition.kind !== 'selected_any') {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      affectedRuleIds.add(rule.id);
    }
    for (const fieldId of affectedExposureFields) {
      optionExposure[fieldId] = [...new Set(formSlots
        .filter((slot) => slot.slotKind === 'option_exposure' && slot.fieldId === fieldId)
        .map((slot) => repointBySlot.get(slot.slotKey)?.to.id ?? slot.itemId))]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    }
    rules = rules.map((rule) => {
      if (!affectedRuleIds.has(rule.id) || rule.condition.kind !== 'selected_any') return rule;
      const choiceIds = [...new Set(formSlots
        .filter((slot) => slot.slotKind === 'rule_condition' && slot.ruleId === rule.id)
        .map((slot) => repointBySlot.get(slot.slotKey)?.to.id ?? slot.itemId))]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      return {
        ...rule,
        condition: { ...rule.condition, choiceIds }
      };
    });
    for (const fieldId of affectedExposureFields) {
      if (optionExposure[fieldId]?.length === 0) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
    }
    const after = formDefinitionHeadSchema.parse({
      ...before,
      version: before.version + 1,
      definition: {
        ...before.definition,
        target,
        composition: { ...before.definition.composition, optionExposure },
        rules
      },
      updatedByUserId: actorUserId,
      updatedAt: occurredAt
    });
    updates.push({ before, after, beforeDigest: row.head_digest_sha256 as string });
  }

  for (const update of updates) {
    const afterJson = canonicalJsonText(update.after);
    changedExactlyOnce(input.sqlite.query<never, [
      number, string, string, string, number,
      string, string, string, number, string
    ]>(`
      UPDATE intake_form_heads
         SET head_version = ?, head_json = ?, head_digest_sha256 = ?,
             updated_by_user_id = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND form_id = ?
         AND head_version = ? AND head_digest_sha256 = ?
    `).run(
      update.after.version,
      afterJson,
      storedDigest(update.after),
      update.after.updatedByUserId,
      Date.parse(update.after.updatedAt),
      input.scope.workspaceId,
      input.scope.eventId,
      update.before.id,
      update.before.version,
      update.beforeDigest
    ));
  }
  for (const group of grouped.values()) {
    for (const { slot, repoint } of group.entries) {
      changedExactlyOnce(input.sqlite.query<never, [
        string, number, string, string, string, number, string, string
      ]>(`
        UPDATE intake_form_program_reference_slots
           SET item_id = ?, slot_version = ?
         WHERE workspace_id = ? AND event_id = ? AND slot_key = ?
           AND slot_version = ? AND item_kind = ? AND item_id = ?
      `).run(
        repoint.to.id,
        slot.slotVersion + 1,
        input.scope.workspaceId,
        input.scope.eventId,
        slot.slotKey,
        slot.slotVersion,
        slot.itemKind,
        slot.itemId
      ));
    }
  }
  changedExactlyOnce(input.sqlite.query<never, [number, string, string, number]>(`
    UPDATE intake_form_catalogs
       SET catalog_version = ?
     WHERE workspace_id = ? AND event_id = ? AND catalog_version = ?
  `).run(
    contribution.guard.version + 1,
    input.scope.workspaceId,
    input.scope.eventId,
    contribution.guard.version
  ));
}

/** Connects mutable Form targets and immutable published-version pins to Program Vocabulary. */
export function createSQLiteIntakeFormProgramVocabularyReferenceAdapter():
SQLiteProgramVocabularyContributorAdapter {
  return Object.freeze({
    contributor: INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
    read({ sqlite, scope }: Parameters<SQLiteProgramVocabularyContributorAdapter['read']>[0]) {
      return readSnapshot(sqlite, scope);
    },
    applyRepoints(
      input: Parameters<SQLiteProgramVocabularyContributorAdapter['applyRepoints']>[0]
    ) {
      applyRepoints(input);
    }
  });
}
