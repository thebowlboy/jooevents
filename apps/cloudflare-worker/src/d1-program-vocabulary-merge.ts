import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  formDefinitionHeadSchema,
  formVersionSchema,
  programVocabularyMergeDraftRequestSchema,
  programVocabularyMergePublishInputSchema,
  programVocabularySafeDiffSchema,
  submissionSubmitEvidenceSchema,
  type FormDefinitionHeadDto,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyKind
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  canonicalJsonText,
  parseAggregateVersion,
  parseEventId,
  parseUserId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  applyProgramVocabularyPlan,
  createProgramReferenceContributorRegistry,
  mergeReferenceCounts,
  parseProgramVocabularyMutationPlan,
  planProgramVocabularyMutation,
  ProgramVocabularyPlanningError,
  programVocabularySetDigest,
  projectProgramVocabularySafeDiff,
  resolveProgramVocabularyItem,
  validateProgramVocabularyPlan,
  type ProgramMergePlan,
  type ProgramReferenceContributionPlan,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorSnapshot,
  type ProgramReferenceRecord,
  type ProgramReferenceSnapshotSource,
  type ProgramVocabularyState
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID,
  PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY,
  PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_MERGE_OPERATION,
  PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY,
  programVocabularyMergeDraftContributionSchema,
  programVocabularyMergePublishContributionSchema,
  sealProgramVocabularyMergePreparation,
  type ProgramVocabularyMergeDraftContribution,
  type ProgramVocabularyMergePublishContribution
} from '@jooevents/program-operations';
import {
  parseSessionCatalog,
  parseSessionHead,
  sessionCatalogDigest,
  sessionHeadDigest,
  type SessionCatalog,
  type SessionHead
} from '@jooevents/session';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';
import type {
  D1EffectDomainAdapter,
  D1EffectDomainAdapterRegistration
} from './d1-effect-unit-of-work';
import {
  createD1ProgramVocabularySnapshotReadSource,
  programVocabularyStateFromSnapshot
} from './d1-program-vocabulary';
import { createD1SessionCatalogReadSource } from './d1-session-catalog';

const MAX_ROWS = 10_000;
const MAX_D1_BOUND_TEXT_BYTES = 1_900_000;
const INTAKE_FORM_CONTRIBUTOR = Object.freeze({ key: 'intake.forms', version: 1 });
const SCHEDULE_OCCURRENCE_CONTRIBUTOR = Object.freeze({
  key: 'schedule.occurrences', version: 1
});
const SESSION_CONTRIBUTOR = Object.freeze({ key: 'sessions.program-targets', version: 1 });
const CONTRIBUTORS = Object.freeze([
  INTAKE_FORM_CONTRIBUTOR,
  SCHEDULE_OCCURRENCE_CONTRIBUTOR,
  SESSION_CONTRIBUTOR
]);
const referenceRegistry = createProgramReferenceContributorRegistry({
  expected: CONTRIBUTORS,
  contributors: CONTRIBUTORS
});

interface EventSetRow { readonly version: number; readonly current_event_id: string | null }
interface CatalogRow { readonly catalog_version: unknown }
interface ScheduleSetRow { readonly schedule_version: unknown }
interface FormHeadRow {
  readonly form_id: unknown;
  readonly head_version: unknown;
  readonly head_json: unknown;
  readonly head_digest_sha256: unknown;
  readonly updated_at_ms: unknown;
}
interface FormSlotRow {
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
interface VersionRow {
  readonly form_version_id: unknown;
  readonly version_number: unknown;
  readonly version_json: unknown;
  readonly version_digest_sha256: unknown;
}
interface EvidenceRow {
  readonly submission_id: unknown;
  readonly evidence_id: unknown;
  readonly evidence_json: unknown;
  readonly evidence_digest_sha256: unknown;
}
interface OccurrenceRow {
  readonly id: unknown;
  readonly room_id: unknown;
  readonly version: unknown;
}
interface SessionSlotRow {
  readonly session_id: unknown;
  readonly slot_kind: unknown;
  readonly item_id: unknown;
  readonly version: unknown;
}
interface RevisionRow {
  readonly draft_id: unknown;
  readonly revision_id: unknown;
  readonly revision_digest_sha256: unknown;
  readonly status: unknown;
  readonly plan_json: unknown;
}

interface FormSlot {
  readonly formId: string;
  readonly key: string;
  readonly kind: 'target' | 'option_exposure' | 'rule_condition';
  readonly fieldId: string | null;
  readonly ruleId: string | null;
  readonly originItemId: string;
  readonly itemKind: 'track' | 'format';
  readonly itemId: string;
  readonly version: number;
}

interface ExactSnapshot {
  readonly state: ProgramVocabularyState;
  readonly source: ProgramReferenceSnapshotSource;
  readonly contributors: ReadonlyMap<string, ProgramReferenceContributorSnapshot>;
  readonly intake: {
    readonly catalogVersion: number;
    readonly catalogExists: boolean;
    readonly heads: ReadonlyMap<string, { readonly head: FormDefinitionHeadDto; readonly digest: string }>;
    readonly slots: ReadonlyMap<string, FormSlot>;
    readonly versionRows: readonly VersionRow[];
    readonly evidenceRows: readonly EvidenceRow[];
  };
  readonly schedule: {
    readonly setVersion: number;
    readonly setExists: boolean;
    readonly occurrences: readonly { readonly id: string; readonly roomId: string; readonly version: number }[];
  };
  readonly sessions: {
    readonly catalog: SessionCatalog;
    readonly slots: readonly { readonly sessionId: string; readonly kind: 'format' | 'track'; readonly itemId: string; readonly version: number }[];
  };
}

type DraftDomain = NonNullable<Extract<ProgramVocabularyMergeDraftContribution,
{ readonly result: { readonly kind: 'success' } }>['domain']>;
type PublishDomain = NonNullable<Extract<ProgramVocabularyMergePublishContribution,
{ readonly result: { readonly kind: 'success' } }>['domain']>;
type Prepared = {
  readonly kind: 'draft'; readonly domain: DraftDomain; readonly actorUserId: string;
  readonly occurredAt: string; readonly snapshot: ExactSnapshot;
} | {
  readonly kind: 'publish'; readonly domain: PublishDomain; readonly actorUserId: string;
  readonly occurredAt: string; readonly snapshot: ExactSnapshot;
};

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function exactSubjects(context: EffectInvocationContext): boolean {
  const eventId = context.scope.eventId;
  return context.scope.subjects.length === (eventId === undefined ? 1 : 2)
    && context.scope.subjects.some((subject) =>
      subject.kind === 'workspace' && subject.id === context.scope.workspaceId)
    && (eventId === undefined || context.scope.subjects.some((subject) =>
      subject.kind === 'event' && subject.id === eventId));
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`d1_program_vocabulary_merge_${label}_invalid`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`d1_program_vocabulary_merge_${label}_invalid`);
  return value;
}

function bounded<Row>(rows: readonly Row[], label: string): readonly Row[] {
  if (rows.length > MAX_ROWS) throw new TypeError(`d1_program_vocabulary_merge_${label}_limit`);
  return rows;
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`d1_program_vocabulary_merge_${label}_invalid`);
  }
  return value.toLowerCase();
}

function programKind(source: 'tracks' | 'formats'): 'track' | 'format' {
  return source === 'tracks' ? 'track' : 'format';
}

function referenceDigest(
  contributor: ProgramReferenceContributorRef,
  guardVersion: number,
  references: readonly ProgramReferenceRecord[]
): string {
  return canonicalJsonSha256({ contributor, guardVersion, references });
}

function currentFormKey(slot: FormSlot): string {
  if (slot.kind === 'target' && slot.fieldId === null && slot.ruleId === null) {
    return `intake_form:${slot.formId}:target`;
  }
  if (slot.kind === 'option_exposure' && slot.fieldId !== null && slot.ruleId === null) {
    return `intake_form:${slot.formId}:field:${slot.fieldId}:exposure:${slot.originItemId}`;
  }
  if (slot.kind === 'rule_condition' && slot.fieldId !== null && slot.ruleId !== null) {
    return `intake_form:${slot.formId}:rule:${slot.ruleId}:choice:${slot.originItemId}`;
  }
  throw new TypeError('d1_program_vocabulary_merge_form_slot_invalid');
}

function parseFormSlot(row: FormSlotRow): FormSlot {
  if ((row.slot_kind !== 'target' && row.slot_kind !== 'option_exposure'
      && row.slot_kind !== 'rule_condition')
      || (row.item_kind !== 'track' && row.item_kind !== 'format')
      || (row.field_id !== null && typeof row.field_id !== 'string')
      || (row.rule_id !== null && typeof row.rule_id !== 'string')) {
    throw new TypeError('d1_program_vocabulary_merge_form_slot_invalid');
  }
  const slot: FormSlot = Object.freeze({
    formId: text(row.form_id, 'form_id'),
    key: text(row.slot_key, 'slot_key'),
    kind: row.slot_kind,
    fieldId: row.field_id,
    ruleId: row.rule_id,
    originItemId: text(row.origin_item_id, 'origin_item_id'),
    itemKind: row.item_kind,
    itemId: text(row.item_id, 'item_id'),
    version: positiveInteger(row.slot_version, 'slot_version')
  });
  if (currentFormKey(slot) !== slot.key) {
    throw new TypeError('d1_program_vocabulary_merge_form_slot_key_invalid');
  }
  return slot;
}

function mergeResult(plan: ProgramMergePlan): ProgramVocabularyChangeResult {
  return {
    action: 'merge',
    kind: plan.sourceBefore.kind,
    affectedIds: [plan.sourceBefore.id, plan.target.id],
    setVersion: plan.expectedSetVersion + 1,
    liveRepoints: mergeReferenceCounts(plan).liveRepoints
  };
}

function outcome(kind: 'program_vocabulary.event_required' | 'program_vocabulary.merge_draft_changed') {
  return {
    result: { kind: 'outcome' as const, outcome: {
      class: 'conflict' as const, kind, retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: [] as const
  };
}

function refusal(input: {
  readonly error: ProgramVocabularyPlanningError;
  readonly kind: ProgramVocabularyKind;
  readonly ids: readonly string[];
}) {
  const stale = ['wrong_scope', 'stale_set', 'stale_item', 'stale_reference']
    .includes(input.error.code);
  return {
    result: { kind: 'outcome' as const, outcome: {
      class: stale ? 'stale_revision' as const : 'policy_violation' as const,
      kind: stale ? 'program_vocabulary.changed' : 'program_vocabulary.change_refused',
      retryable: false,
      subjects: input.ids.map((id) => ({ type: 'program_vocabulary' as const, id })),
      detail: { code: input.error.code, action: 'merge' as const,
        kind: input.kind, ids: input.ids },
      detailSchemaVersion: 1
    } },
    domain: null,
    effectContributions: [] as const
  };
}

async function readExactSnapshot(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly workspaceId: string;
  readonly eventId: string;
}): Promise<ExactSnapshot> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const eventId = parseEventId(input.eventId);
  const sessionDatabase = {
    withSession: () => input.unitOfWork.readSession
  } as unknown as D1Database;
  const projected = await createD1ProgramVocabularySnapshotReadSource({
    database: sessionDatabase,
    workspaceId
  }).readSnapshot({ workspaceId, eventId });
  if (!projected) throw new ProgramVocabularyPlanningError('wrong_scope');
  const state = programVocabularyStateFromSnapshot(projected);
  const sessionCatalog = await createD1SessionCatalogReadSource({
    database: sessionDatabase,
    workspaceId
  }).readSessionCatalog({ workspaceId, eventId });
  if (!sessionCatalog) throw new ProgramVocabularyPlanningError('wrong_scope');

  const session = input.unitOfWork.readSession;
  const results = await session.batch([
    session.prepare(`SELECT catalog_version FROM intake_form_catalogs
      WHERE workspace_id = ? AND event_id = ? LIMIT 2`)
      .bind(input.workspaceId, input.eventId),
    session.prepare(`SELECT form_id,head_version,head_json,head_digest_sha256,updated_at_ms
      FROM intake_form_heads WHERE workspace_id = ? AND event_id = ?
      ORDER BY form_id COLLATE BINARY LIMIT ?`)
      .bind(input.workspaceId, input.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT form_id,slot_key,slot_kind,field_id,rule_id,origin_item_id,
      item_kind,item_id,slot_version FROM intake_form_program_reference_slots
      WHERE workspace_id = ? AND event_id = ? ORDER BY slot_key COLLATE BINARY LIMIT ?`)
      .bind(input.workspaceId, input.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT form_version_id,version_number,version_json,version_digest_sha256
      FROM intake_form_versions WHERE workspace_id = ? AND event_id = ?
      ORDER BY form_version_id COLLATE BINARY LIMIT ?`)
      .bind(input.workspaceId, input.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT submission_id,evidence_id,evidence_json,evidence_digest_sha256
      FROM intake_submission_submit_evidence WHERE workspace_id = ? AND event_id = ?
      ORDER BY submission_id COLLATE BINARY,evidence_id COLLATE BINARY LIMIT ?`)
      .bind(input.workspaceId, input.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT schedule_version FROM schedule_placement_sets
      WHERE workspace_id = ? AND event_id = ? LIMIT 2`)
      .bind(input.workspaceId, input.eventId),
    session.prepare(`SELECT id,room_id,version FROM schedule_occurrences
      WHERE workspace_id = ? AND event_id = ? ORDER BY id COLLATE BINARY LIMIT ?`)
      .bind(input.workspaceId, input.eventId, MAX_ROWS + 1),
    session.prepare(`SELECT session_id,slot_kind,item_id,version
      FROM session_program_reference_slots WHERE workspace_id = ? AND event_id = ?
      ORDER BY session_id COLLATE BINARY,slot_kind COLLATE BINARY LIMIT ?`)
      .bind(input.workspaceId, input.eventId, MAX_ROWS + 1)
  ]);

  const catalogRows = (results[0] as D1Result<CatalogRow>).results;
  if (catalogRows.length > 1) throw new TypeError('d1_program_vocabulary_merge_intake_catalog_corrupt');
  const intakeCatalogVersion = catalogRows[0]
    ? positiveInteger(catalogRows[0].catalog_version, 'intake_catalog_version') : 1;
  const headRows = bounded((results[1] as D1Result<FormHeadRow>).results, 'form_heads');
  const slotRows = bounded((results[2] as D1Result<FormSlotRow>).results, 'form_slots');
  const versionRows = bounded((results[3] as D1Result<VersionRow>).results, 'form_versions');
  const evidenceRows = bounded((results[4] as D1Result<EvidenceRow>).results, 'evidence');
  if (!catalogRows[0] && (headRows.length > 0 || slotRows.length > 0 || versionRows.length > 0)) {
    throw new TypeError('d1_program_vocabulary_merge_intake_catalog_missing');
  }

  const heads = new Map<string, { readonly head: FormDefinitionHeadDto; readonly digest: string }>();
  for (const row of headRows) {
    const json = text(row.head_json, 'form_head_json');
    const digest = text(row.head_digest_sha256, 'form_head_digest');
    const head = formDefinitionHeadSchema.parse(JSON.parse(json));
    if (canonicalJsonText(head) !== json || canonicalJsonSha256(head) !== digest
        || row.form_id !== head.id || row.head_version !== head.version
        || row.updated_at_ms !== Date.parse(head.updatedAt) || heads.has(head.id)) {
      throw new TypeError('d1_program_vocabulary_merge_form_head_corrupt');
    }
    heads.set(head.id, Object.freeze({ head, digest }));
  }
  const slots = new Map<string, FormSlot>();
  for (const row of slotRows) {
    const slot = parseFormSlot(row);
    if (!heads.has(slot.formId) || slots.has(slot.key)) {
      throw new TypeError('d1_program_vocabulary_merge_form_slot_corrupt');
    }
    slots.set(slot.key, slot);
  }

  const intakeReferences: ProgramReferenceRecord[] = [...slots.values()].map((slot) => ({
    referenceKey: slot.key,
    version: parseAggregateVersion(slot.version),
    item: { kind: slot.itemKind, id: slot.itemId },
    mode: 'current' as const,
    destination: {
      kind: slot.kind === 'target' ? 'intake.form'
        : slot.kind === 'option_exposure' ? 'intake.form.option_exposure'
          : 'intake.form.rule_condition',
      id: slot.formId
    }
  }));
  for (const row of versionRows) {
    const json = text(row.version_json, 'form_version_json');
    const digest = text(row.version_digest_sha256, 'form_version_digest');
    const version = formVersionSchema.parse(JSON.parse(json));
    if (canonicalJsonText(version) !== json || canonicalJsonSha256(version) !== digest
        || row.form_version_id !== version.id || row.version_number !== version.number) {
      throw new TypeError('d1_program_vocabulary_merge_form_version_corrupt');
    }
    const referenceVersion = parseAggregateVersion(version.number);
    if (version.targetPin?.kind === 'category') intakeReferences.push({
      referenceKey: `intake_form_version:${version.id}:target`,
      version: referenceVersion,
      item: { kind: version.targetPin.categoryKind, id: version.targetPin.id },
      mode: 'historical',
      destination: { kind: 'intake.form_version', id: version.id }
    });
    for (const field of version.definition.fields) {
      if ((field.kind !== 'select' && field.kind !== 'multiselect')
          || field.options.kind !== 'program_vocabulary'
          || field.options.exposure.kind !== 'subset') continue;
      for (const item of field.options.exposure.items) intakeReferences.push({
        referenceKey: `intake_form_version:${version.id}:field:${field.id}:exposure:${item.id}`,
        version: referenceVersion,
        item: { kind: programKind(item.source), id: item.id },
        mode: 'historical',
        destination: { kind: 'intake.form_version.option_exposure', id: version.id }
      });
    }
    for (const rule of version.definition.rules) {
      if (rule.condition.kind !== 'selected_any') continue;
      for (const pin of rule.condition.programVocabularyPins) intakeReferences.push({
        referenceKey: `intake_form_version:${version.id}:rule:${rule.id}:choice:${pin.id}`,
        version: referenceVersion,
        item: { kind: programKind(pin.source), id: pin.id },
        mode: 'historical',
        destination: { kind: 'intake.form_version.rule_condition', id: version.id }
      });
    }
  }
  for (const row of evidenceRows) {
    const json = text(row.evidence_json, 'evidence_json');
    const digest = text(row.evidence_digest_sha256, 'evidence_digest');
    const evidence = submissionSubmitEvidenceSchema.parse(JSON.parse(json));
    if (canonicalJsonText(evidence) !== json || canonicalJsonSha256(evidence) !== digest
        || row.submission_id !== evidence.submissionId || row.evidence_id !== evidence.id) {
      throw new TypeError('d1_program_vocabulary_merge_evidence_corrupt');
    }
    for (const pin of evidence.programVocabularyAnswerPins) intakeReferences.push({
      referenceKey: `intake_submission:${evidence.submissionId}:field:${pin.fieldId}:choice:${pin.itemId}`,
      version: parseAggregateVersion(1),
      item: { kind: programKind(pin.source), id: pin.itemId },
      mode: 'historical',
      destination: { kind: 'intake.submission.answer', id: evidence.submissionId }
    });
  }
  intakeReferences.sort((left, right) => left.referenceKey.localeCompare(right.referenceKey));

  const scheduleSetRows = (results[5] as D1Result<ScheduleSetRow>).results;
  if (scheduleSetRows.length > 1) throw new TypeError('d1_program_vocabulary_merge_schedule_set_corrupt');
  const scheduleSetVersion = scheduleSetRows[0]
    ? positiveInteger(scheduleSetRows[0].schedule_version, 'schedule_version') : 1;
  const occurrences = bounded((results[6] as D1Result<OccurrenceRow>).results, 'occurrences')
    .map((row) => Object.freeze({
      id: text(row.id, 'occurrence_id'),
      roomId: text(row.room_id, 'occurrence_room'),
      version: positiveInteger(row.version, 'occurrence_version')
    }));
  if (!scheduleSetRows[0] && occurrences.length > 0) {
    throw new TypeError('d1_program_vocabulary_merge_schedule_set_missing');
  }
  const scheduleReferences: ProgramReferenceRecord[] = occurrences.map((row) => ({
    referenceKey: `schedule_occurrence:${row.id}:room`,
    version: parseAggregateVersion(row.version),
    item: { kind: 'room', id: row.roomId },
    mode: 'current',
    destination: { kind: 'schedule.occurrence', id: row.id }
  }));

  const sessionSlots = bounded((results[7] as D1Result<SessionSlotRow>).results, 'session_slots')
    .map((row) => {
      if (row.slot_kind !== 'format' && row.slot_kind !== 'track') {
        throw new TypeError('d1_program_vocabulary_merge_session_slot_corrupt');
      }
      return Object.freeze({
        sessionId: text(row.session_id, 'session_id'),
        kind: row.slot_kind,
        itemId: text(row.item_id, 'session_item_id'),
        version: positiveInteger(row.version, 'session_slot_version')
      });
    });
  const expectedSessionSlots = new Map<string, string>();
  for (const head of sessionCatalog.sessions) {
    expectedSessionSlots.set(`${head.id}\0format`, head.programTarget.format.id);
    if (head.programTarget.track) expectedSessionSlots.set(`${head.id}\0track`, head.programTarget.track.id);
  }
  const sessionReferences: ProgramReferenceRecord[] = sessionSlots.map((slot) => {
    const key = `${slot.sessionId}\0${slot.kind}`;
    if (expectedSessionSlots.get(key) !== slot.itemId) {
      throw new TypeError('d1_program_vocabulary_merge_session_slot_corrupt');
    }
    expectedSessionSlots.delete(key);
    return {
      referenceKey: `session:${slot.sessionId}:${slot.kind}`,
      version: parseAggregateVersion(slot.version),
      item: { kind: slot.kind, id: slot.itemId },
      mode: 'current',
      destination: { kind: 'session.head', id: `${slot.sessionId}:${slot.kind}` }
    };
  });
  if (expectedSessionSlots.size !== 0) {
    throw new TypeError('d1_program_vocabulary_merge_session_slot_missing');
  }

  const contributorSnapshots = [
    Object.freeze({
      contributor: INTAKE_FORM_CONTRIBUTOR,
      scope: state.scope,
      guard: Object.freeze({
        id: 'program_reference:intake.forms',
        version: parseAggregateVersion(intakeCatalogVersion),
        digest: referenceDigest(INTAKE_FORM_CONTRIBUTOR, intakeCatalogVersion, intakeReferences)
      }),
      references: Object.freeze(intakeReferences)
    }),
    Object.freeze({
      contributor: SCHEDULE_OCCURRENCE_CONTRIBUTOR,
      scope: state.scope,
      guard: Object.freeze({
        id: 'program_reference:schedule.occurrences',
        version: parseAggregateVersion(scheduleSetVersion),
        digest: referenceDigest(SCHEDULE_OCCURRENCE_CONTRIBUTOR, scheduleSetVersion,
          scheduleReferences)
      }),
      references: Object.freeze(scheduleReferences)
    }),
    Object.freeze({
      contributor: SESSION_CONTRIBUTOR,
      scope: state.scope,
      guard: Object.freeze({
        id: 'program_reference:sessions.program-targets',
        version: parseAggregateVersion(sessionCatalog.version),
        digest: referenceDigest(SESSION_CONTRIBUTOR, sessionCatalog.version, sessionReferences)
      }),
      references: Object.freeze(sessionReferences)
    })
  ] satisfies readonly ProgramReferenceContributorSnapshot[];
  const contributors = new Map<string, ProgramReferenceContributorSnapshot>(
    contributorSnapshots.map((snapshot) => [
    snapshot.contributor.key, snapshot
    ] as const)
  );
  const source: ProgramReferenceSnapshotSource = Object.freeze({
    readContributor(contributor: ProgramReferenceContributorRef) {
      const resolved = contributors.get(contributor.key);
      return resolved?.contributor.version === contributor.version ? resolved : undefined;
    }
  });
  return Object.freeze({
    state,
    source,
    contributors,
    intake: Object.freeze({
      catalogVersion: intakeCatalogVersion,
      catalogExists: catalogRows[0] !== undefined,
      heads,
      slots,
      versionRows,
      evidenceRows
    }),
    schedule: Object.freeze({
      setVersion: scheduleSetVersion,
      setExists: scheduleSetRows[0] !== undefined,
      occurrences
    }),
    sessions: Object.freeze({ catalog: sessionCatalog, slots: sessionSlots })
  });
}

function assertJsonRows(
  unitOfWork: D1BufferedUnitOfWork,
  table: string,
  alias: string,
  matchSql: string,
  workspaceId: string,
  eventId: string,
  rows: readonly unknown[]
): void {
  const json = canonicalJsonText(rows);
  if (new TextEncoder().encode(json).byteLength > MAX_D1_BOUND_TEXT_BYTES) {
    throw new TypeError(`d1_program_vocabulary_merge_${table}_guard_limit`);
  }
  unitOfWork.assertCurrent(`
    (SELECT count(*) FROM ${table} WHERE workspace_id = ? AND event_id = ?) = ?
    AND NOT EXISTS (
      SELECT 1 FROM ${table} ${alias}
       WHERE ${alias}.workspace_id = ? AND ${alias}.event_id = ?
         AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE ${matchSql})
    )`, [workspaceId, eventId, rows.length, workspaceId, eventId, json]);
}

function bufferSnapshotGuards(
  unitOfWork: D1BufferedUnitOfWork,
  snapshot: ExactSnapshot,
  workspaceId: string,
  eventId: string
): void {
  if (snapshot.state.setVersion === 1) {
    unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM program_vocabulary_sets
      WHERE workspace_id = ? AND event_id = ?)`, [workspaceId, eventId]);
  } else {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM program_vocabulary_sets
      WHERE workspace_id = ? AND event_id = ? AND set_version = ?)`, [
      workspaceId, eventId, snapshot.state.setVersion
    ]);
  }

  if (snapshot.intake.catalogExists) {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM intake_form_catalogs
      WHERE workspace_id = ? AND event_id = ? AND catalog_version = ?)`, [
      workspaceId, eventId, snapshot.intake.catalogVersion
    ]);
  } else {
    unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM intake_form_catalogs
      WHERE workspace_id = ? AND event_id = ?)`, [workspaceId, eventId]);
  }
  assertJsonRows(unitOfWork, 'intake_form_heads', 'h', `
    h.form_id = json_extract(expected.value,'$.id')
    AND h.head_version = json_extract(expected.value,'$.version')
    AND h.head_digest_sha256 = json_extract(expected.value,'$.digest')`, workspaceId, eventId,
  [...snapshot.intake.heads].map(([id, entry]) => ({
    id, version: entry.head.version, digest: entry.digest
  })));
  assertJsonRows(unitOfWork, 'intake_form_program_reference_slots', 's', `
    s.slot_key = json_extract(expected.value,'$.key')
    AND s.form_id = json_extract(expected.value,'$.formId')
    AND s.slot_kind = json_extract(expected.value,'$.kind')
    AND s.field_id IS json_extract(expected.value,'$.fieldId')
    AND s.rule_id IS json_extract(expected.value,'$.ruleId')
    AND s.origin_item_id = json_extract(expected.value,'$.originItemId')
    AND s.item_kind = json_extract(expected.value,'$.itemKind')
    AND s.item_id = json_extract(expected.value,'$.itemId')
    AND s.slot_version = json_extract(expected.value,'$.version')`, workspaceId, eventId,
  [...snapshot.intake.slots.values()]);
  assertJsonRows(unitOfWork, 'intake_form_versions', 'v', `
    v.form_version_id = json_extract(expected.value,'$.id')
    AND v.version_number = json_extract(expected.value,'$.number')
    AND v.version_digest_sha256 = json_extract(expected.value,'$.digest')`, workspaceId, eventId,
  snapshot.intake.versionRows.map((row) => ({
    id: row.form_version_id, number: row.version_number,
    digest: row.version_digest_sha256
  })));
  assertJsonRows(unitOfWork, 'intake_submission_submit_evidence', 'e', `
    e.submission_id = json_extract(expected.value,'$.submissionId')
    AND e.evidence_id = json_extract(expected.value,'$.evidenceId')
    AND e.evidence_digest_sha256 = json_extract(expected.value,'$.digest')`, workspaceId, eventId,
  snapshot.intake.evidenceRows.map((row) => ({
    submissionId: row.submission_id, evidenceId: row.evidence_id,
    digest: row.evidence_digest_sha256
  })));

  if (snapshot.schedule.setExists) {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM schedule_placement_sets
      WHERE workspace_id = ? AND event_id = ? AND schedule_version = ?)`, [
      workspaceId, eventId, snapshot.schedule.setVersion
    ]);
  } else {
    unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM schedule_placement_sets
      WHERE workspace_id = ? AND event_id = ?)`, [workspaceId, eventId]);
  }
  assertJsonRows(unitOfWork, 'schedule_occurrences', 'o', `
    o.id = json_extract(expected.value,'$.id')
    AND o.room_id = json_extract(expected.value,'$.roomId')
    AND o.version = json_extract(expected.value,'$.version')`, workspaceId, eventId,
  snapshot.schedule.occurrences);

  const catalog = snapshot.sessions.catalog;
  if (catalog.version === 1 && catalog.sessions.length === 0) {
    unitOfWork.assertCurrent(`NOT EXISTS (SELECT 1 FROM session_catalogs
      WHERE workspace_id = ? AND event_id = ?)`, [workspaceId, eventId]);
  } else {
    unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM session_catalogs
      WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?)`, [
      workspaceId, eventId, catalog.version, catalog.digestSha256
    ]);
  }
  assertJsonRows(unitOfWork, 'sessions', 's', `
    s.id = json_extract(expected.value,'$.id')
    AND s.version = json_extract(expected.value,'$.version')
    AND s.digest_sha256 = json_extract(expected.value,'$.digest')`, workspaceId, eventId,
  catalog.sessions.map((head) => ({
    id: head.id, version: head.version, digest: head.digestSha256
  })));
  assertJsonRows(unitOfWork, 'session_program_reference_slots', 'r', `
    r.session_id = json_extract(expected.value,'$.sessionId')
    AND r.slot_kind = json_extract(expected.value,'$.kind')
    AND r.item_id = json_extract(expected.value,'$.itemId')
    AND r.version = json_extract(expected.value,'$.version')`, workspaceId, eventId,
  snapshot.sessions.slots);
}

function contributionFor(plan: ProgramMergePlan, key: string): ProgramReferenceContributionPlan {
  const contribution = plan.references.find((candidate) => candidate.contributor.key === key);
  if (!contribution) throw new TypeError('d1_program_vocabulary_merge_contributor_missing');
  return contribution;
}

function sameHistoricalPins(
  snapshot: ProgramReferenceContributorSnapshot,
  contribution: ProgramReferenceContributionPlan
): boolean {
  const byKey = new Map(snapshot.references.map((reference) => [reference.referenceKey, reference]));
  return contribution.historicalPins.every((pin) => {
    const reference = byKey.get(pin.referenceKey);
    return reference?.mode === 'historical'
      && reference.version === pin.version
      && reference.item.kind === pin.item.kind
      && reference.item.id === pin.item.id
      && reference.destination.kind === pin.destination.kind
      && reference.destination.id === pin.destination.id;
  });
}

function tableFor(kind: ProgramVocabularyKind): string {
  return kind === 'room' ? 'program_vocabulary_rooms'
    : kind === 'track' ? 'program_vocabulary_tracks' : 'program_vocabulary_formats';
}

function bufferVocabularyMerge(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly plan: ProgramMergePlan;
  readonly beforeState: ProgramVocabularyState;
  readonly actorUserId: string;
  readonly occurredAtMs: number;
}): ProgramVocabularyState {
  const { plan } = input;
  const source = plan.sourceBefore;
  const table = tableFor(source.kind);
  input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM ${table}
    WHERE workspace_id = ? AND event_id = ? AND id = ? AND name = ? AND status = ?
      AND version = ?${source.kind === 'room' ? ' AND capacity IS ?' : ''})`, [
    plan.scope.workspaceId, plan.scope.eventId, source.id, source.name, source.status,
    source.version, ...(source.kind === 'room' ? [source.capacity] : [])
  ]);
  input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM ${table}
    WHERE workspace_id = ? AND event_id = ? AND id = ? AND name = ? AND status = ?
      AND version = ?${source.kind === 'room' ? ' AND capacity IS ?' : ''})`, [
    plan.scope.workspaceId, plan.scope.eventId, plan.target.id, plan.target.name,
    plan.target.status, plan.target.version,
    ...(plan.target.kind === 'room' ? [plan.target.capacity] : [])
  ]);
  input.unitOfWork.write(`UPDATE ${table} SET name = ?,
    ${source.kind === 'room' ? 'capacity = ?,' : ''}
    status = ?,version = ?,updated_by_user_id = ?,updated_at_ms = ?
    WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?`, [
    plan.sourceAfter.name,
    ...(plan.sourceAfter.kind === 'room' ? [plan.sourceAfter.capacity] : []),
    plan.sourceAfter.status, plan.sourceAfter.version,
    input.actorUserId, input.occurredAtMs,
    plan.scope.workspaceId, plan.scope.eventId, source.id, source.version
  ]);
  input.unitOfWork.write(`UPDATE program_vocabulary_sets
    SET set_version = ?,updated_by_user_id = ?,updated_at_ms = ?
    WHERE workspace_id = ? AND event_id = ? AND set_version = ?`, [
    plan.expectedSetVersion + 1, input.actorUserId, input.occurredAtMs,
    plan.scope.workspaceId, plan.scope.eventId, plan.expectedSetVersion
  ]);
  return applyProgramVocabularyPlan(input.beforeState, plan);
}

function assertContributionCurrent(
  snapshot: ProgramReferenceContributorSnapshot | undefined,
  contribution: ProgramReferenceContributionPlan
): ProgramReferenceContributorSnapshot {
  if (!snapshot || snapshot.contributor.key !== contribution.contributor.key
      || snapshot.contributor.version !== contribution.contributor.version
      || snapshot.guard.id !== contribution.guard.id
      || snapshot.guard.version !== contribution.guard.version
      || snapshot.guard.digest !== contribution.guard.digest
      || !sameHistoricalPins(snapshot, contribution)) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  return snapshot;
}

function bufferIntakeRepoints(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly snapshot: ExactSnapshot;
  readonly contribution: ProgramReferenceContributionPlan;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): void {
  const current = assertContributionCurrent(
    input.snapshot.contributors.get(INTAKE_FORM_CONTRIBUTOR.key), input.contribution
  );
  if (input.contribution.liveRepoints.length === 0) return;
  if (!input.snapshot.intake.catalogExists) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  const references = new Map(current.references.map((reference) => [reference.referenceKey, reference]));
  const grouped = new Map<string, {
    readonly slot: FormSlot;
    readonly repoint: ProgramReferenceContributionPlan['liveRepoints'][number];
    readonly reference: ProgramReferenceRecord;
  }[]>();
  for (const repoint of input.contribution.liveRepoints) {
    const reference = references.get(repoint.referenceKey);
    const slot = input.snapshot.intake.slots.get(repoint.referenceKey);
    if (!reference || !slot || reference.mode !== 'current'
        || reference.version !== repoint.expectedVersion
        || reference.item.kind !== repoint.from.kind || reference.item.id !== repoint.from.id
        || repoint.to.kind !== repoint.from.kind || repoint.to.id === repoint.from.id
        || reference.destination.kind !== repoint.destination.kind
        || reference.destination.id !== repoint.destination.id
        || slot.formId !== reference.destination.id
        || slot.itemKind !== repoint.from.kind || slot.itemId !== repoint.from.id
        || slot.version !== repoint.expectedVersion) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    const entries = grouped.get(slot.formId) ?? [];
    entries.push({ slot, repoint, reference });
    grouped.set(slot.formId, entries);
  }

  for (const [formId, entries] of grouped) {
    const stored = input.snapshot.intake.heads.get(formId);
    if (!stored || Date.parse(stored.head.updatedAt) > Date.parse(input.occurredAt)) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    const before = stored.head;
    let target = before.definition.target;
    const optionExposure: Record<string, readonly string[]> = {
      ...before.definition.composition.optionExposure
    };
    let rules = before.definition.rules.map((rule) => ({ ...rule }));
    const formSlots = [...input.snapshot.intake.slots.values()]
      .filter((slot) => slot.formId === formId);
    const repointBySlot = new Map(entries.map((entry) => [entry.slot.key, entry.repoint]));
    const affectedExposureFields = new Set<string>();
    const affectedRuleIds = new Set<string>();
    for (const { slot, repoint, reference } of entries) {
      if (reference.destination.kind === 'intake.form') {
        if (slot.kind !== 'target' || target.kind !== 'category'
            || target.category.kind !== repoint.from.kind
            || target.category.id !== repoint.from.id
            || (repoint.to.kind !== 'track' && repoint.to.kind !== 'format')) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        target = { kind: 'category', category: { kind: repoint.to.kind, id: repoint.to.id } };
      } else if (reference.destination.kind === 'intake.form.option_exposure') {
        if (slot.kind !== 'option_exposure' || !slot.fieldId
            || !optionExposure[slot.fieldId]?.includes(repoint.from.id)) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        affectedExposureFields.add(slot.fieldId);
      } else if (reference.destination.kind === 'intake.form.rule_condition') {
        if (slot.kind !== 'rule_condition' || !slot.ruleId
            || !rules.some((rule) => rule.id === slot.ruleId
              && rule.condition.kind === 'selected_any'
              && rule.condition.sourceFieldId === slot.fieldId
              && rule.condition.choiceIds.includes(repoint.from.id))) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        affectedRuleIds.add(slot.ruleId);
      } else {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
    }
    for (const fieldId of affectedExposureFields) {
      optionExposure[fieldId] = [...new Set(formSlots
        .filter((slot) => slot.kind === 'option_exposure' && slot.fieldId === fieldId)
        .map((slot) => repointBySlot.get(slot.key)?.to.id ?? slot.itemId))]
        .sort((left, right) => left.localeCompare(right));
      if (optionExposure[fieldId]!.length === 0) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
    }
    rules = rules.map((rule) => {
      if (!affectedRuleIds.has(rule.id) || rule.condition.kind !== 'selected_any') return rule;
      return {
        ...rule,
        condition: {
          ...rule.condition,
          choiceIds: [...new Set(formSlots
            .filter((slot) => slot.kind === 'rule_condition' && slot.ruleId === rule.id)
            .map((slot) => repointBySlot.get(slot.key)?.to.id ?? slot.itemId))]
            .sort((left, right) => left.localeCompare(right))
        }
      };
    });
    const after = formDefinitionHeadSchema.parse({
      ...before,
      version: before.version + 1,
      definition: {
        ...before.definition,
        target,
        composition: { ...before.definition.composition, optionExposure },
        rules
      },
      updatedByUserId: input.actorUserId,
      updatedAt: input.occurredAt
    });
    const afterJson = canonicalJsonText(after);
    input.unitOfWork.write(`UPDATE intake_form_heads SET head_version = ?,head_json = ?,
      head_digest_sha256 = ?,updated_by_user_id = ?,updated_at_ms = ?
      WHERE workspace_id = ? AND event_id = ? AND form_id = ?
        AND head_version = ? AND head_digest_sha256 = ?`, [
      after.version, afterJson, canonicalJsonSha256(after), after.updatedByUserId,
      Date.parse(after.updatedAt), before.scope.workspaceId, before.scope.eventId, before.id,
      before.version, stored.digest
    ]);
  }
  for (const entries of grouped.values()) {
    for (const { slot, repoint } of entries) {
      input.unitOfWork.write(`UPDATE intake_form_program_reference_slots
        SET item_id = ?,slot_version = ?
        WHERE workspace_id = ? AND event_id = ? AND slot_key = ?
          AND item_kind = ? AND item_id = ? AND slot_version = ?`, [
        repoint.to.id, slot.version + 1,
        input.snapshot.state.scope.workspaceId, input.snapshot.state.scope.eventId,
        slot.key, slot.itemKind, slot.itemId, slot.version
      ]);
    }
  }
  input.unitOfWork.write(`UPDATE intake_form_catalogs SET catalog_version = ?
    WHERE workspace_id = ? AND event_id = ? AND catalog_version = ?`, [
    input.contribution.guard.version + 1,
    input.snapshot.state.scope.workspaceId, input.snapshot.state.scope.eventId,
    input.contribution.guard.version
  ]);
}

function bufferScheduleRepoints(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly snapshot: ExactSnapshot;
  readonly contribution: ProgramReferenceContributionPlan;
  readonly actorUserId: string;
  readonly occurredAtMs: number;
}): void {
  const current = assertContributionCurrent(
    input.snapshot.contributors.get(SCHEDULE_OCCURRENCE_CONTRIBUTOR.key), input.contribution
  );
  if (input.contribution.liveRepoints.length === 0) return;
  if (!input.snapshot.schedule.setExists) throw new ProgramVocabularyPlanningError('stale_reference');
  const references = new Map(current.references.map((reference) => [reference.referenceKey, reference]));
  const occurrences = new Map(input.snapshot.schedule.occurrences.map((row) => [row.id, row]));
  for (const repoint of input.contribution.liveRepoints) {
    const reference = references.get(repoint.referenceKey);
    const occurrence = occurrences.get(repoint.destination.id);
    if (!reference || !occurrence || reference.mode !== 'current'
        || reference.version !== repoint.expectedVersion
        || reference.item.kind !== 'room' || reference.item.id !== repoint.from.id
        || repoint.from.kind !== 'room' || repoint.to.kind !== 'room'
        || reference.destination.kind !== 'schedule.occurrence'
        || reference.destination.id !== repoint.destination.id
        || occurrence.roomId !== repoint.from.id || occurrence.version !== repoint.expectedVersion) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    input.unitOfWork.write(`UPDATE schedule_occurrences
      SET room_id = ?,version = ?,updated_by_user_id = ?,updated_at_ms = ?
      WHERE workspace_id = ? AND event_id = ? AND id = ? AND room_id = ? AND version = ?`, [
      repoint.to.id, repoint.expectedVersion + 1, input.actorUserId, input.occurredAtMs,
      input.snapshot.state.scope.workspaceId, input.snapshot.state.scope.eventId,
      occurrence.id, occurrence.roomId, occurrence.version
    ]);
  }
  input.unitOfWork.write(`UPDATE schedule_placement_sets
    SET schedule_version = ?,updated_by_user_id = ?,updated_at_ms = ?
    WHERE workspace_id = ? AND event_id = ? AND schedule_version = ?`, [
    input.contribution.guard.version + 1, input.actorUserId, input.occurredAtMs,
    input.snapshot.state.scope.workspaceId, input.snapshot.state.scope.eventId,
    input.contribution.guard.version
  ]);
}

function persistedSessionUpdate(head: SessionHead): readonly unknown[] {
  return [
    head.title, head.plannedDurationMinutes, head.lifecycle,
    head.programTarget.format.id, head.programTarget.track?.id ?? null,
    head.programTarget.setVersion, head.programTarget.setDigestSha256,
    head.roster.version, head.roster.digestSha256, canonicalJsonText(head.roster),
    canonicalJsonText(head), head.version, head.digestSha256,
    head.updatedByUserId, Date.parse(head.updatedAt)
  ];
}

function resolveSessionTarget(
  vocabulary: ProgramVocabularyState,
  formatId: string,
  trackId: string | null
) {
  const format = resolveProgramVocabularyItem(vocabulary, 'format', formatId);
  const track = trackId === null ? null : resolveProgramVocabularyItem(vocabulary, 'track', trackId);
  if (!format || format.status !== 'active' || (trackId !== null && (!track || track.status !== 'active'))) {
    throw new ProgramVocabularyPlanningError('stale_reference');
  }
  return {
    setVersion: vocabulary.setVersion,
    setDigestSha256: programVocabularySetDigest(vocabulary),
    format: { kind: 'format' as const, id: format.id, name: format.name,
      status: 'active' as const, version: format.version },
    track: track ? { kind: 'track' as const, id: track.id, name: track.name,
      accent: track.accent, status: 'active' as const, version: track.version } : null
  };
}

function bufferSessionRepoints(input: {
  readonly unitOfWork: D1BufferedUnitOfWork;
  readonly snapshot: ExactSnapshot;
  readonly afterVocabulary: ProgramVocabularyState;
  readonly contribution: ProgramReferenceContributionPlan;
  readonly actorUserId: string;
  readonly occurredAt: string;
}): void {
  const current = assertContributionCurrent(
    input.snapshot.contributors.get(SESSION_CONTRIBUTOR.key), input.contribution
  );
  if (input.contribution.liveRepoints.length === 0) return;
  const references = new Map(current.references.map((reference) => [reference.referenceKey, reference]));
  const repoints = new Map<string, ProgramReferenceContributionPlan['liveRepoints'][number]>();
  for (const repoint of input.contribution.liveRepoints) {
    const reference = references.get(repoint.referenceKey);
    const match = /^(.+):(format|track)$/.exec(repoint.destination.id);
    if (!reference || !match || reference.mode !== 'current'
        || reference.version !== repoint.expectedVersion
        || reference.item.kind !== repoint.from.kind || reference.item.id !== repoint.from.id
        || repoint.to.kind !== repoint.from.kind
        || (repoint.to.kind !== 'format' && repoint.to.kind !== 'track')
        || reference.destination.kind !== 'session.head'
        || reference.destination.id !== repoint.destination.id
        || match[2] !== repoint.from.kind || repoints.has(match[1]!)) {
      throw new ProgramVocabularyPlanningError('stale_reference');
    }
    repoints.set(match[1]!, repoint);
  }
  const nextHeads = input.snapshot.sessions.catalog.sessions.map((head) => {
    const repoint = repoints.get(head.id);
    if (!repoint) return head;
    repoints.delete(head.id);
    const currentId = repoint.from.kind === 'format'
      ? head.programTarget.format.id : head.programTarget.track?.id;
    if (currentId !== repoint.from.id) throw new ProgramVocabularyPlanningError('stale_reference');
    const target = resolveSessionTarget(
      input.afterVocabulary,
      repoint.from.kind === 'format' ? repoint.to.id : head.programTarget.format.id,
      repoint.from.kind === 'track' ? repoint.to.id : head.programTarget.track?.id ?? null
    );
    const { digestSha256: _digest, ...unsignedBefore } = head;
    const unsigned = {
      ...unsignedBefore,
      programTarget: target,
      version: head.version + 1,
      updatedByUserId: input.actorUserId,
      updatedAt: input.occurredAt
    };
    const after = parseSessionHead({ ...unsigned, digestSha256: sessionHeadDigest(unsigned) });
    input.unitOfWork.write(`UPDATE sessions SET title = ?,planned_duration_minutes = ?,
      lifecycle = ?,format_id = ?,track_id = ?,program_set_version = ?,
      program_set_digest_sha256 = ?,roster_version = ?,roster_digest_sha256 = ?,
      roster_json = ?,head_json = ?,version = ?,digest_sha256 = ?,
      updated_by_user_id = ?,updated_at_ms = ?
      WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ? AND digest_sha256 = ?`, [
      ...persistedSessionUpdate(after),
      head.scope.workspaceId, head.scope.eventId, head.id, head.version, head.digestSha256
    ]);
    return after;
  });
  if (repoints.size !== 0) throw new ProgramVocabularyPlanningError('stale_reference');
  const beforeCatalog = input.snapshot.sessions.catalog;
  const unsignedCatalog = {
    schemaVersion: 1 as const,
    scope: beforeCatalog.scope,
    version: beforeCatalog.version + 1,
    sessions: nextHeads
  };
  const afterCatalog = parseSessionCatalog({
    ...unsignedCatalog,
    digestSha256: sessionCatalogDigest(unsignedCatalog)
  });
  input.unitOfWork.write(`UPDATE session_catalogs SET version = ?,digest_sha256 = ?
    WHERE workspace_id = ? AND event_id = ? AND version = ? AND digest_sha256 = ?`, [
    afterCatalog.version, afterCatalog.digestSha256,
    beforeCatalog.scope.workspaceId, beforeCatalog.scope.eventId,
    beforeCatalog.version, beforeCatalog.digestSha256
  ]);
}

export class D1ProgramVocabularyMergeEffectDomainAdapter implements D1EffectDomainAdapter {
  readonly #workspaceId: WorkspaceId;
  readonly #issuedIds = new Set<string>();
  #prepared: Prepared | undefined;

  constructor(private readonly input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly workspaceId: WorkspaceId;
    readonly ids: { readonly newDraftId: () => string; readonly newRevisionId: () => string };
  }) {
    this.#workspaceId = parseWorkspaceId(input.workspaceId);
  }

  async openHandlerSnapshot(
    capability: { readonly key: string; readonly version: number },
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): Promise<EffectHandlerSnapshot> {
    const draft = sameRef(capability, PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY)
      && context.operation.name === PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION.name
      && context.operation.version === PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION.version
      && context.operation.effect === 'draft';
    const publish = sameRef(capability, PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY)
      && context.operation.name === PROGRAM_VOCABULARY_MERGE_OPERATION.name
      && context.operation.version === PROGRAM_VOCABULARY_MERGE_OPERATION.version
      && context.operation.effect === 'commit';
    if ((!draft && !publish) || context.surface !== 'operator_http'
        || context.scope.workspaceId !== this.#workspaceId || !exactSubjects(context)) {
      throw new TypeError('d1_program_vocabulary_merge_scope_mismatch');
    }
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(context, authorityRecheck);
    const evaluatedAt = resolveEffectInvocationCurrentAuthorityRecheckTime(context, authorityRecheck);
    if (authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || context.actor.kind !== 'workspace_user'
        || context.actor.userId !== authority.actor.userId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !sameRef(authority.lane.policy, PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY)
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID)) {
      throw new TypeError('d1_program_vocabulary_merge_authority_mismatch');
    }
    const actorUserId = parseUserId(authority.actor.userId);
    const eventId = context.scope.eventId;
    this.#prepared = undefined;
    if (eventId === undefined) {
      return sealProgramVocabularyMergePreparation({
        capability,
        context,
        prepare: ({ businessInput, context: received }) => {
          if (received !== context) {
            throw new TypeError('d1_program_vocabulary_merge_context_substitution');
          }
          if (draft) programVocabularyMergeDraftRequestSchema.parse(businessInput);
          else programVocabularyMergePublishInputSchema.parse(businessInput);
          return outcome('program_vocabulary.event_required');
        }
      });
    }

    const parsedEventId = parseEventId(eventId);
    const eventSet = await this.input.unitOfWork.readSession.prepare(
      'SELECT version,current_event_id FROM event_spine_workspace_sets WHERE workspace_id = ?'
    ).bind(this.#workspaceId).first<EventSetRow>();
    if (!eventSet || eventSet.current_event_id !== parsedEventId) {
      throw new TypeError('d1_program_vocabulary_merge_current_event_mismatch');
    }
    this.input.unitOfWork.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_workspace_sets
      WHERE workspace_id = ? AND version = ? AND current_event_id = ?)`, [
      this.#workspaceId, eventSet.version, parsedEventId
    ]);
    const snapshot = await readExactSnapshot({
      unitOfWork: this.input.unitOfWork,
      workspaceId: this.#workspaceId,
      eventId: parsedEventId
    });
    bufferSnapshotGuards(this.input.unitOfWork, snapshot, this.#workspaceId, parsedEventId);
    const revisions = publish
      ? bounded((await this.input.unitOfWork.readSession.prepare(`
          SELECT d.id AS draft_id,r.id AS revision_id,r.digest_sha256 AS revision_digest_sha256,
                 d.status,r.plan_json
            FROM program_vocabulary_merge_drafts d
            JOIN program_vocabulary_merge_revisions r
              ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id
             AND r.draft_id = d.id AND r.id = d.head_revision_id
             AND r.digest_sha256 = d.head_revision_digest_sha256
           WHERE d.workspace_id = ? AND d.event_id = ?
           ORDER BY d.id COLLATE BINARY LIMIT ?`)
        .bind(this.#workspaceId, parsedEventId, MAX_ROWS + 1)
        .all<RevisionRow>()).results, 'merge_revisions')
      : [];

    return sealProgramVocabularyMergePreparation({
      capability,
      context,
      prepare: ({ businessInput, context: received }) => {
        if (received !== context) {
          throw new TypeError('d1_program_vocabulary_merge_context_substitution');
        }
        return draft
          ? this.prepareDraft({ businessInput, actorUserId, evaluatedAt, snapshot })
          : this.preparePublish({ businessInput, actorUserId, evaluatedAt, snapshot, revisions });
      }
    });
  }

  private prepareDraft(input: {
    readonly businessInput: unknown;
    readonly actorUserId: string;
    readonly evaluatedAt: string;
    readonly snapshot: ExactSnapshot;
  }) {
    const wire = programVocabularyMergeDraftRequestSchema.parse(input.businessInput);
    let plan: ProgramMergePlan;
    try {
      const candidate = planProgramVocabularyMutation({
        authorInput: { action: 'merge', scope: input.snapshot.state.scope, ...wire },
        state: input.snapshot.state,
        referenceRegistry,
        referenceSource: input.snapshot.source
      });
      if (candidate.action !== 'merge') throw new TypeError('d1_program_vocabulary_merge_plan_invalid');
      plan = candidate;
    } catch (error) {
      if (error instanceof ProgramVocabularyPlanningError) {
        return programVocabularyMergeDraftContributionSchema.parse(refusal({
          error, kind: wire.kind, ids: [wire.sourceId, wire.targetId]
        }));
      }
      throw error;
    }
    const draftId = this.nextId('newDraftId');
    const revisionId = this.nextId('newRevisionId');
    const safeDiff = programVocabularySafeDiffSchema.parse(projectProgramVocabularySafeDiff(plan));
    const revisionDigestSha256 = canonicalJsonSha256({ schemaVersion: 1, plan, safeDiff });
    const contribution = programVocabularyMergeDraftContributionSchema.parse({
      result: { kind: 'success', data: {
        schemaVersion: 1, action: 'merge', draftId, status: 'draft',
        revision: { id: revisionId, number: 1, digestSha256: revisionDigestSha256 },
        safeDiff
      } },
      domain: { kind: 'program_vocabulary_merge_review_draft', draftId, revisionId,
        revisionDigestSha256, plan, safeDiff },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('d1_program_vocabulary_merge_draft_contribution_invalid');
    }
    this.#prepared = { kind: 'draft', domain: contribution.domain,
      actorUserId: input.actorUserId, occurredAt: input.evaluatedAt, snapshot: input.snapshot };
    return contribution;
  }

  private preparePublish(input: {
    readonly businessInput: unknown;
    readonly actorUserId: string;
    readonly evaluatedAt: string;
    readonly snapshot: ExactSnapshot;
    readonly revisions: readonly RevisionRow[];
  }) {
    const wire = programVocabularyMergePublishInputSchema.parse(input.businessInput);
    const row = input.revisions.find((candidate) =>
      candidate.draft_id === wire.draftId
      && candidate.revision_id === wire.revisionId
      && candidate.revision_digest_sha256 === wire.revisionDigestSha256);
    if (!row || row.status !== 'draft') {
      return programVocabularyMergePublishContributionSchema.parse(
        outcome('program_vocabulary.merge_draft_changed')
      );
    }
    const plan = parseProgramVocabularyMutationPlan(JSON.parse(text(row.plan_json, 'plan_json')));
    if (plan.action !== 'merge') throw new TypeError('d1_program_vocabulary_merge_revision_invalid');
    const code = validateProgramVocabularyPlan(
      input.snapshot.state, plan, referenceRegistry, input.snapshot.source
    );
    if (code) {
      return programVocabularyMergePublishContributionSchema.parse(refusal({
        error: new ProgramVocabularyPlanningError(code),
        kind: plan.sourceBefore.kind,
        ids: [plan.sourceBefore.id, plan.target.id]
      }));
    }
    const contribution = programVocabularyMergePublishContributionSchema.parse({
      result: { kind: 'success', data: mergeResult(plan) },
      domain: { kind: 'program_vocabulary_merge_publish', draftId: wire.draftId,
        revisionId: wire.revisionId, revisionDigestSha256: wire.revisionDigestSha256, plan },
      effectContributions: []
    });
    if (contribution.result.kind !== 'success' || contribution.domain === null) {
      throw new TypeError('d1_program_vocabulary_merge_publish_contribution_invalid');
    }
    this.#prepared = { kind: 'publish', domain: contribution.domain,
      actorUserId: input.actorUserId, occurredAt: input.evaluatedAt, snapshot: input.snapshot };
    return contribution;
  }

  applyDomainContribution(contribution: unknown): void {
    const prepared = this.#prepared;
    if (!prepared || canonicalJsonText(prepared.domain) !== canonicalJsonText(contribution)) {
      throw new TypeError('d1_program_vocabulary_merge_preparation_invalid');
    }
    const occurredAtMs = Date.parse(prepared.occurredAt);
    if (prepared.kind === 'draft') {
      const plan = prepared.domain.plan;
      this.input.unitOfWork.assertCurrent(`NOT EXISTS (
        SELECT 1 FROM program_vocabulary_merge_drafts
         WHERE workspace_id = ? AND event_id = ? AND id = ?)`, [
        plan.scope.workspaceId, plan.scope.eventId, prepared.domain.draftId
      ]);
      this.input.unitOfWork.write(`INSERT INTO program_vocabulary_merge_drafts (
        workspace_id,event_id,id,status,head_revision_id,head_revision_digest_sha256,
        authored_by_user_id,authored_at_ms,published_by_user_id,published_at_ms
      ) VALUES (?,?,?,'draft',?,?,?,?,NULL,NULL)`, [
        plan.scope.workspaceId, plan.scope.eventId, prepared.domain.draftId,
        prepared.domain.revisionId, prepared.domain.revisionDigestSha256,
        prepared.actorUserId, occurredAtMs
      ]);
      this.input.unitOfWork.write(`INSERT INTO program_vocabulary_merge_revisions (
        workspace_id,event_id,draft_id,id,number,digest_sha256,plan_json,safe_diff_json,
        authored_by_user_id,authored_at_ms
      ) VALUES (?,?,?,?,1,?,?,?,?,?)`, [
        plan.scope.workspaceId, plan.scope.eventId, prepared.domain.draftId,
        prepared.domain.revisionId, prepared.domain.revisionDigestSha256,
        canonicalJsonText(plan), canonicalJsonText(prepared.domain.safeDiff),
        prepared.actorUserId, occurredAtMs
      ]);
    } else {
      const plan = parseProgramVocabularyMutationPlan(prepared.domain.plan);
      if (plan.action !== 'merge') {
        throw new TypeError('d1_program_vocabulary_merge_publish_plan_invalid');
      }
      this.input.unitOfWork.assertCurrent(`EXISTS (
        SELECT 1 FROM program_vocabulary_merge_drafts d
        JOIN program_vocabulary_merge_revisions r
          ON r.workspace_id = d.workspace_id AND r.event_id = d.event_id
         AND r.draft_id = d.id AND r.id = d.head_revision_id
         AND r.digest_sha256 = d.head_revision_digest_sha256
        WHERE d.workspace_id = ? AND d.event_id = ? AND d.id = ? AND d.status = 'draft'
          AND r.id = ? AND r.digest_sha256 = ? AND r.plan_json = ?)`, [
        plan.scope.workspaceId, plan.scope.eventId, prepared.domain.draftId,
        prepared.domain.revisionId, prepared.domain.revisionDigestSha256,
        canonicalJsonText(plan)
      ]);
      const afterVocabulary = bufferVocabularyMerge({
        unitOfWork: this.input.unitOfWork,
        plan,
        beforeState: prepared.snapshot.state,
        actorUserId: prepared.actorUserId,
        occurredAtMs
      });
      bufferIntakeRepoints({
        unitOfWork: this.input.unitOfWork, snapshot: prepared.snapshot,
        contribution: contributionFor(plan, INTAKE_FORM_CONTRIBUTOR.key),
        actorUserId: prepared.actorUserId, occurredAt: prepared.occurredAt
      });
      bufferScheduleRepoints({
        unitOfWork: this.input.unitOfWork, snapshot: prepared.snapshot,
        contribution: contributionFor(plan, SCHEDULE_OCCURRENCE_CONTRIBUTOR.key),
        actorUserId: prepared.actorUserId, occurredAtMs
      });
      bufferSessionRepoints({
        unitOfWork: this.input.unitOfWork, snapshot: prepared.snapshot, afterVocabulary,
        contribution: contributionFor(plan, SESSION_CONTRIBUTOR.key),
        actorUserId: prepared.actorUserId, occurredAt: prepared.occurredAt
      });
      this.input.unitOfWork.write(`UPDATE program_vocabulary_merge_drafts
        SET status = 'published',published_by_user_id = ?,published_at_ms = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ? AND status = 'draft'
          AND head_revision_id = ? AND head_revision_digest_sha256 = ?`, [
        prepared.actorUserId, occurredAtMs, plan.scope.workspaceId, plan.scope.eventId,
        prepared.domain.draftId, prepared.domain.revisionId,
        prepared.domain.revisionDigestSha256
      ]);
    }
    this.#prepared = undefined;
  }

  afterUnitOfWorkFinished(): void { this.#prepared = undefined; }

  private nextId(method: 'newDraftId' | 'newRevisionId'): string {
    const value = validUuid(this.input.ids[method](), method);
    if (this.#issuedIds.has(value)) throw new TypeError('d1_program_vocabulary_merge_ids_not_unique');
    this.#issuedIds.add(value);
    return value;
  }
}

export function createD1ProgramVocabularyMergeEffectDomainRegistrations(input: {
  readonly workspaceId: WorkspaceId;
  readonly ids: { readonly newDraftId: () => string; readonly newRevisionId: () => string };
}): readonly [D1EffectDomainAdapterRegistration, D1EffectDomainAdapterRegistration] {
  const registration = (capability: { readonly key: string; readonly version: number }) =>
    Object.freeze({
      capability,
      create: (unitOfWork: D1BufferedUnitOfWork) =>
        new D1ProgramVocabularyMergeEffectDomainAdapter({ ...input, unitOfWork })
    });
  return Object.freeze([
    registration(PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY),
    registration(PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY)
  ]);
}
