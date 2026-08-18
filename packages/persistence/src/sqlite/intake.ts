import type { Database } from 'bun:sqlite';
import { ORGANIZER_PERSON_SUBMISSION_PAGE_SIZE } from '@jooevents/contracts';
import type {
  ApplicationDraftHeadDto,
  ApplicationDraftRevisionDto,
  FieldRegistryOptionSource,
  FieldRegistrySnapshotDto,
  FormAvailability,
  FormDefinitionHeadDto,
  FormVersionDto,
  OrganizerFormDetailDto,
  OrganizerFormCatalogDto,
  OrganizerSubmissionDetailDto,
  OrganizerSubmissionSummaryDto,
  OrganizerPersonSubmissionPageDto,
  OrganizerSubmissionContactDto,
  PublicApplicationDraftResumeDto,
  ServedPublicFormDto,
  SubmissionConsentEvidenceDto,
  SubmissionDirectEntryEvidenceDto,
  SubmissionHeadDto,
  SubmissionParticipantEvidenceDto,
  SubmissionSubmitEvidenceDto,
  FormTarget,
  FormTargetReferencePinDto
} from '@jooevents/contracts';
import {
  applyFormMutationPlan,
  applicationMutationPlanDigest,
  formMutationPlanDigest,
  parseApplicationDraftHead,
  parseApplicationDraftRevision,
  parseApplicationMutationPlan,
  parseFormCatalogState,
  parseFormDefinitionHead,
  parseFormMutationPlan,
  parseApplicationDirectEntryPlan,
  parseFormVersion,
  parseSubmissionConsentEvidence,
  parseSubmissionDirectEntryEvidence,
  parseSubmissionHead,
  parseSubmissionParticipantEvidence,
  parseSubmissionSubmitEvidence,
  projectOrganizerFormDetail,
  projectOrganizerFormCatalog,
  projectOrganizerFormSummary,
  projectServedPublicForm,
  validateApplicationDirectEntryPlanAgainstForm,
  validateApplicationMutationPlanAgainstForm,
  type ApplicationDirectEntryPlan,
  type ApplicationMutationPlan,
  type ApplicationAnswerPayloadReferenceVerifier,
  type ApplicationCollectionSource,
  type ApplicationAnswerLiveOption,
  type AppliedFormMutation,
  type FormCatalogState,
  type FormMutationPlan,
  type FormTargetReferenceResolver
} from '@jooevents/intake';
import { assertAuthenticatedIntakeProjection } from './intake-projection-auth';
import {
  canonicalJsonText,
  parseEventId,
  parseWorkspaceId,
  type EventId,
  type WorkspaceId
} from '@jooevents/kernel';
import { createHash } from 'node:crypto';
import {
  SQLiteFieldRegistryRepository,
  SQLiteFieldRegistrySnapshotSource,
  SQLiteIntakeFieldRegistryFormReferenceResolver,
  SQLiteProgramVocabularyFieldOptionSource
} from './field-registry';
import { SQLiteDeadlineRepository } from './deadline';
import { SQLiteEventSpineRepository } from './event-spine';
import type {
  FormCloseDeadlineAppliedContribution,
  FormCloseDeadlineChangeInput,
  FormCloseDeadlineContribution,
  FormCloseDeadlineValidation
} from '@jooevents/deadline';
import type {
  DeadlineCatalogSnapshotDto,
  DeadlineEventTimeBasisDto,
  DeadlineHeadDto
} from '@jooevents/contracts/deadlines';

export const SQLITE_INTAKE_SQL = `
CREATE TABLE intake_form_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36 AND workspace_id = lower(workspace_id)),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36 AND event_id = lower(event_id)),
  catalog_version INTEGER NOT NULL CHECK(catalog_version >= 2),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL CHECK(length(form_id) = 36 AND form_id = lower(form_id)),
  head_version INTEGER NOT NULL CHECK(head_version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'open', 'closed')),
  current_published_version_id TEXT CHECK(
    current_published_version_id IS NULL
    OR (length(current_published_version_id) = 36 AND current_published_version_id = lower(current_published_version_id))
  ),
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, form_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES intake_form_catalogs(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_versions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL CHECK(length(form_version_id) = 36 AND form_version_id = lower(form_version_id)),
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  source_definition_version INTEGER NOT NULL CHECK(source_definition_version > 0),
  version_json TEXT NOT NULL CHECK(json_valid(version_json) AND json_type(version_json) = 'object'),
  version_digest_sha256 TEXT NOT NULL CHECK(
    length(version_digest_sha256) = 64 AND version_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  published_by_user_id TEXT NOT NULL CHECK(length(published_by_user_id) = 36),
  published_at_ms INTEGER NOT NULL CHECK(published_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, form_version_id),
  UNIQUE (workspace_id, event_id, form_id, version_number),
  UNIQUE (workspace_id, event_id, form_id, form_version_id),
  FOREIGN KEY (workspace_id, event_id, form_id)
    REFERENCES intake_form_heads(workspace_id, event_id, form_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_form_program_reference_slots (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  slot_key TEXT NOT NULL CHECK(length(slot_key) BETWEEN 1 AND 300),
  slot_kind TEXT NOT NULL CHECK(slot_kind IN ('target', 'option_exposure', 'rule_condition')),
  field_id TEXT,
  rule_id TEXT,
  origin_item_id TEXT NOT NULL CHECK(length(origin_item_id) = 36 AND origin_item_id = lower(origin_item_id)),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('track', 'format')),
  item_id TEXT NOT NULL CHECK(length(item_id) = 36 AND item_id = lower(item_id)),
  slot_version INTEGER NOT NULL CHECK(slot_version > 0),
  PRIMARY KEY (workspace_id, event_id, slot_key),
  CHECK(
    (slot_kind = 'target' AND field_id IS NULL AND rule_id IS NULL)
    OR (slot_kind = 'option_exposure' AND field_id IS NOT NULL AND rule_id IS NULL)
    OR (slot_kind = 'rule_condition' AND field_id IS NOT NULL AND rule_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, event_id, form_id)
    REFERENCES intake_form_heads(workspace_id, event_id, form_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX intake_form_program_reference_slots_by_form
  ON intake_form_program_reference_slots(
    workspace_id, event_id, form_id, slot_kind, field_id, rule_id, slot_key
  );

CREATE TABLE intake_application_draft_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL CHECK(length(draft_id) = 36 AND draft_id = lower(draft_id)),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  authority_partition_digest_sha256 TEXT NOT NULL CHECK(
    length(authority_partition_digest_sha256) = 64
    AND authority_partition_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  status TEXT NOT NULL CHECK(status IN ('in_progress', 'submitted')),
  submitted_submission_id TEXT,
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, draft_id),
  UNIQUE (draft_id),
  CHECK((status = 'in_progress' AND submitted_submission_id IS NULL)
     OR (status = 'submitted' AND submitted_submission_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, event_id, form_id, form_version_id)
    REFERENCES intake_form_versions(workspace_id, event_id, form_id, form_version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_application_draft_revisions (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36 AND revision_id = lower(revision_id)),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  request_digest_sha256 TEXT NOT NULL CHECK(
    length(request_digest_sha256) = 64 AND request_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json) AND json_type(revision_json) = 'object'),
  revision_digest_sha256 TEXT NOT NULL CHECK(
    length(revision_digest_sha256) = 64 AND revision_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  saved_at_ms INTEGER NOT NULL CHECK(saved_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, revision_id),
  UNIQUE (workspace_id, event_id, draft_id, revision_number),
  UNIQUE (workspace_id, event_id, draft_id, revision_id),
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES intake_application_draft_heads(workspace_id, event_id, draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_heads (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL CHECK(length(submission_id) = 36 AND submission_id = lower(submission_id)),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  draft_id TEXT UNIQUE,
  submit_evidence_id TEXT NOT NULL UNIQUE,
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  head_json TEXT NOT NULL CHECK(json_valid(head_json) AND json_type(head_json) = 'object'),
  head_digest_sha256 TEXT NOT NULL CHECK(
    length(head_digest_sha256) = 64 AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  submitted_at_ms INTEGER NOT NULL CHECK(submitted_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, submission_id),
  UNIQUE (submission_id),
  CHECK(
    (draft_id IS NOT NULL AND json_extract(head_json, '$.source') = 'public_form')
    OR (draft_id IS NULL AND json_extract(head_json, '$.source') = 'direct_entry')
  ),
  FOREIGN KEY (workspace_id, event_id, form_id, form_version_id)
    REFERENCES intake_form_versions(workspace_id, event_id, form_id, form_version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, draft_id)
    REFERENCES intake_application_draft_heads(workspace_id, event_id, draft_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_submit_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_direct_entry_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) = 36 AND evidence_id = lower(evidence_id)),
  entered_by_user_id TEXT NOT NULL CHECK(length(entered_by_user_id) = 36),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (entered_by_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_participant_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  participant_identity_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE intake_submission_consent_evidence (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  evidence_digest_sha256 TEXT NOT NULL CHECK(
    length(evidence_digest_sha256) = 64 AND evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, event_id, evidence_id),
  UNIQUE (workspace_id, event_id, submission_id, field_id),
  FOREIGN KEY (workspace_id, event_id, submission_id)
    REFERENCES intake_submission_heads(workspace_id, event_id, submission_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX intake_form_heads_list
  ON intake_form_heads(workspace_id, event_id, form_id);
CREATE INDEX intake_submission_heads_list
  ON intake_submission_heads(workspace_id, event_id, submission_id);

CREATE TRIGGER intake_form_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, form_id, created_by_user_id, created_at_ms
ON intake_form_heads BEGIN SELECT RAISE(ABORT, 'intake form identity is immutable'); END;
CREATE TRIGGER intake_form_heads_version_guard
BEFORE UPDATE ON intake_form_heads
WHEN NEW.head_version != OLD.head_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'intake form version is invalid'); END;
CREATE TRIGGER intake_form_versions_no_update BEFORE UPDATE ON intake_form_versions
BEGIN SELECT RAISE(ABORT, 'intake form versions are immutable'); END;
CREATE TRIGGER intake_form_versions_no_delete BEFORE DELETE ON intake_form_versions
BEGIN SELECT RAISE(ABORT, 'intake form versions are immutable'); END;
CREATE TRIGGER intake_application_draft_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, draft_id, form_id, form_version_id,
  authority_partition_digest_sha256, created_at_ms
ON intake_application_draft_heads
BEGIN SELECT RAISE(ABORT, 'intake application identity is immutable'); END;
CREATE TRIGGER intake_application_draft_heads_version_guard
BEFORE UPDATE ON intake_application_draft_heads
WHEN NEW.draft_version != OLD.draft_version + 1 OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT, 'intake application version is invalid'); END;
CREATE TRIGGER intake_application_draft_revisions_no_update BEFORE UPDATE ON intake_application_draft_revisions
BEGIN SELECT RAISE(ABORT, 'intake application revisions are immutable'); END;
CREATE TRIGGER intake_application_draft_revisions_no_delete BEFORE DELETE ON intake_application_draft_revisions
BEGIN SELECT RAISE(ABORT, 'intake application revisions are immutable'); END;
CREATE TRIGGER intake_submission_heads_no_update BEFORE UPDATE ON intake_submission_heads
BEGIN SELECT RAISE(ABORT, 'intake submissions are immutable'); END;
CREATE TRIGGER intake_submission_heads_no_delete BEFORE DELETE ON intake_submission_heads
BEGIN SELECT RAISE(ABORT, 'intake submissions are immutable'); END;
CREATE TRIGGER intake_submission_submit_evidence_no_update BEFORE UPDATE ON intake_submission_submit_evidence
BEGIN SELECT RAISE(ABORT, 'intake submit evidence is immutable'); END;
CREATE TRIGGER intake_submission_submit_evidence_no_delete BEFORE DELETE ON intake_submission_submit_evidence
BEGIN SELECT RAISE(ABORT, 'intake submit evidence is immutable'); END;
CREATE TRIGGER intake_submission_direct_entry_evidence_no_update BEFORE UPDATE ON intake_submission_direct_entry_evidence
BEGIN SELECT RAISE(ABORT, 'intake direct entry evidence is immutable'); END;
CREATE TRIGGER intake_submission_direct_entry_evidence_no_delete BEFORE DELETE ON intake_submission_direct_entry_evidence
BEGIN SELECT RAISE(ABORT, 'intake direct entry evidence is immutable'); END;
CREATE TRIGGER intake_submission_participant_evidence_no_update BEFORE UPDATE ON intake_submission_participant_evidence
BEGIN SELECT RAISE(ABORT, 'intake participant evidence is immutable'); END;
CREATE TRIGGER intake_submission_participant_evidence_no_delete BEFORE DELETE ON intake_submission_participant_evidence
BEGIN SELECT RAISE(ABORT, 'intake participant evidence is immutable'); END;
CREATE TRIGGER intake_submission_consent_evidence_no_update BEFORE UPDATE ON intake_submission_consent_evidence
BEGIN SELECT RAISE(ABORT, 'intake consent evidence is immutable'); END;
CREATE TRIGGER intake_submission_consent_evidence_no_delete BEFORE DELETE ON intake_submission_consent_evidence
BEGIN SELECT RAISE(ABORT, 'intake consent evidence is immutable'); END;
`;

export class SQLiteIntakeError extends Error {
  constructor(readonly code:
    | 'transaction_required'
    | 'scope_missing'
    | 'data_corrupt'
    | 'stale_form'
    | 'stale_draft'
    | 'id_collision'
  ) {
    super(code);
    this.name = 'SQLiteIntakeError';
  }
}

export interface SQLiteIntakeScopeInput {
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface SQLiteIntakeSubmissionProjectionPort {
  projectSummary(input: {
    readonly head: SubmissionHeadDto;
    readonly submitEvidence: SubmissionSubmitEvidenceDto;
    readonly version: FormVersionDto;
    readonly draftHead: ApplicationDraftHeadDto;
    readonly sourceRevision: ApplicationDraftRevisionDto;
  }): OrganizerSubmissionSummaryDto;
  projectDirectEntrySummary(input: {
    readonly head: SubmissionHeadDto;
    readonly entryEvidence: SubmissionDirectEntryEvidenceDto;
    readonly version: FormVersionDto;
  }): OrganizerSubmissionSummaryDto;
  projectDirectEntryDetail(input: {
    readonly head: SubmissionHeadDto;
    readonly entryEvidence: SubmissionDirectEntryEvidenceDto;
    readonly version: FormVersionDto;
    readonly participants: readonly SubmissionParticipantEvidenceDto[];
  }): OrganizerSubmissionDetailDto;
  resolveDirectEntryContact(input: {
    readonly head: SubmissionHeadDto;
    readonly entryEvidence: SubmissionDirectEntryEvidenceDto;
    readonly participant: SubmissionParticipantEvidenceDto;
    readonly version: FormVersionDto;
  }): OrganizerSubmissionContactDto;
  projectDetail(input: {
    readonly head: SubmissionHeadDto;
    readonly submitEvidence: SubmissionSubmitEvidenceDto;
    readonly version: FormVersionDto;
    readonly draftHead: ApplicationDraftHeadDto;
    readonly sourceRevision: ApplicationDraftRevisionDto;
    readonly participants: readonly SubmissionParticipantEvidenceDto[];
    readonly consents: readonly SubmissionConsentEvidenceDto[];
  }): OrganizerSubmissionDetailDto;
  resolveContact(input: {
    readonly head: SubmissionHeadDto;
    readonly submitEvidence: SubmissionSubmitEvidenceDto;
    readonly participant: SubmissionParticipantEvidenceDto;
    readonly version: FormVersionDto;
    readonly draftHead: ApplicationDraftHeadDto;
    readonly sourceRevision: ApplicationDraftRevisionDto;
  }): OrganizerSubmissionContactDto;
  resolveDraftResume(input: {
    readonly head: ApplicationDraftHeadDto;
    readonly revision: ApplicationDraftRevisionDto;
    readonly version: FormVersionDto;
  }): PublicApplicationDraftResumeDto;
}

interface Scope { readonly workspaceId: WorkspaceId; readonly eventId: EventId }
interface JsonRow { readonly value_json: string; readonly value_digest: string }
interface FormHeadRow extends JsonRow {
  readonly workspace_id: string; readonly event_id: string; readonly form_id: string;
  readonly head_version: number; readonly status: string;
  readonly current_published_version_id: string | null;
  readonly created_by_user_id: string; readonly created_at_ms: number;
  readonly updated_by_user_id: string; readonly updated_at_ms: number;
}
interface FormVersionRow extends JsonRow {
  readonly workspace_id: string; readonly event_id: string; readonly form_id: string;
  readonly form_version_id: string; readonly version_number: number;
  readonly source_definition_version: number; readonly published_by_user_id: string;
  readonly published_at_ms: number;
}
interface DraftHeadRow extends JsonRow {
  readonly workspace_id: string; readonly event_id: string; readonly draft_id: string;
  readonly form_id: string; readonly form_version_id: string;
  readonly authority_partition_digest_sha256: string; readonly draft_version: number;
  readonly current_revision_id: string; readonly status: string;
  readonly submitted_submission_id: string | null;
  readonly created_at_ms: number; readonly updated_at_ms: number;
}
interface DraftRevisionRow extends JsonRow {
  readonly workspace_id: string; readonly event_id: string; readonly draft_id: string;
  readonly revision_id: string; readonly revision_number: number;
  readonly request_digest_sha256: string; readonly saved_at_ms: number;
}
interface SubmissionHeadRow extends JsonRow {
  readonly workspace_id: string; readonly event_id: string; readonly submission_id: string;
  readonly form_id: string; readonly form_version_id: string; readonly draft_id: string | null;
  readonly submit_evidence_id: string; readonly person_id: string; readonly submitted_at_ms: number;
}
interface SubmissionEvidenceRow extends JsonRow {
  readonly workspace_id: string; readonly event_id: string; readonly submission_id: string;
  readonly evidence_id: string;
}
interface ParticipantEvidenceRow extends SubmissionEvidenceRow {
  readonly person_id: string; readonly participant_identity_id: string;
}
interface ConsentEvidenceRow extends SubmissionEvidenceRow { readonly field_id: string }
interface FormProgramReferenceSlotRow {
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

type FormProgramReferenceSlot = {
  readonly formId: string;
  readonly slotKey: string;
  readonly slotKind: 'target' | 'option_exposure' | 'rule_condition';
  readonly fieldId: string | null;
  readonly ruleId: string | null;
  readonly originItemId: string;
  readonly itemKind: 'track' | 'format';
  readonly itemId: string;
  readonly slotVersion: number;
};

type DesiredProgramReferenceLocation = {
  readonly locationKey: string;
  readonly slotKind: FormProgramReferenceSlot['slotKind'];
  readonly fieldId: string | null;
  readonly ruleId: string | null;
  readonly itemKind: FormProgramReferenceSlot['itemKind'];
  readonly itemIds: readonly string[];
};

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonText(value)).digest('hex');
}

function scope(value: SQLiteIntakeScopeInput): Scope {
  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspaceId),
    eventId: parseEventId(value.eventId)
  });
}

function changedOnce(result: { readonly changes: number }, code: SQLiteIntakeError['code']): void {
  if (result.changes !== 1) throw new SQLiteIntakeError(code);
}

function programReferenceLocationKey(input: {
  readonly slotKind: FormProgramReferenceSlot['slotKind'];
  readonly fieldId: string | null;
  readonly ruleId: string | null;
}): string {
  if (input.slotKind === 'target') return 'target';
  if (input.slotKind === 'option_exposure' && input.fieldId && input.ruleId === null) {
    return `option_exposure:${input.fieldId}`;
  }
  if (input.slotKind === 'rule_condition' && input.fieldId && input.ruleId) {
    return `rule_condition:${input.ruleId}`;
  }
  throw new SQLiteIntakeError('data_corrupt');
}

function programReferenceSlotKey(input: {
  readonly formId: string;
  readonly slotKind: FormProgramReferenceSlot['slotKind'];
  readonly fieldId: string | null;
  readonly ruleId: string | null;
  readonly originItemId: string;
}): string {
  if (input.slotKind === 'target') return `intake_form:${input.formId}:target`;
  if (input.slotKind === 'option_exposure' && input.fieldId && input.ruleId === null) {
    return `intake_form:${input.formId}:field:${input.fieldId}:exposure:${input.originItemId}`;
  }
  if (input.slotKind === 'rule_condition' && input.ruleId && input.fieldId) {
    return `intake_form:${input.formId}:rule:${input.ruleId}:choice:${input.originItemId}`;
  }
  throw new SQLiteIntakeError('data_corrupt');
}

function readProgramReferenceSlots(
  sqlite: Database,
  currentScope: Scope,
  formId: string
): FormProgramReferenceSlot[] {
  return sqlite.query<FormProgramReferenceSlotRow, [string, string, string]>(`
    SELECT workspace_id, event_id, form_id, slot_key, slot_kind, field_id, rule_id,
           origin_item_id, item_kind, item_id, slot_version
      FROM intake_form_program_reference_slots
     WHERE workspace_id = ? AND event_id = ? AND form_id = ?
     ORDER BY slot_key COLLATE BINARY
  `).all(currentScope.workspaceId, currentScope.eventId, formId).map((row) => {
    if (row.workspace_id !== currentScope.workspaceId
        || row.event_id !== currentScope.eventId
        || row.form_id !== formId
        || typeof row.slot_key !== 'string'
        || (row.slot_kind !== 'target'
          && row.slot_kind !== 'option_exposure'
          && row.slot_kind !== 'rule_condition')
        || (row.field_id !== null && typeof row.field_id !== 'string')
        || (row.rule_id !== null && typeof row.rule_id !== 'string')
        || typeof row.origin_item_id !== 'string'
        || (row.item_kind !== 'track' && row.item_kind !== 'format')
        || typeof row.item_id !== 'string'
        || typeof row.slot_version !== 'number'
        || !Number.isSafeInteger(row.slot_version)
        || row.slot_version <= 0) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    const slot: FormProgramReferenceSlot = {
      formId,
      slotKey: row.slot_key,
      slotKind: row.slot_kind,
      fieldId: row.field_id,
      ruleId: row.rule_id,
      originItemId: row.origin_item_id,
      itemKind: row.item_kind,
      itemId: row.item_id,
      slotVersion: row.slot_version
    };
    if (slot.slotKey !== programReferenceSlotKey(slot)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return slot;
  });
}

function desiredProgramReferenceLocations(
  head: FormDefinitionHeadDto,
  registry: FieldRegistrySnapshotDto
): DesiredProgramReferenceLocation[] {
  const fields = new Map(registry.fields.map((field) => [field.id, field]));
  const locations: DesiredProgramReferenceLocation[] = [];
  if (head.definition.target.kind === 'category') locations.push({
    locationKey: 'target',
    slotKind: 'target',
    fieldId: null,
    ruleId: null,
    itemKind: head.definition.target.category.kind,
    itemIds: [head.definition.target.category.id]
  });
  for (const [fieldId, itemIds] of Object.entries(
    head.definition.composition.optionExposure
  )) {
    const field = fields.get(fieldId);
    if (!field || field.options.kind !== 'program_vocabulary') {
      throw new SQLiteIntakeError('data_corrupt');
    }
    locations.push({
      locationKey: `option_exposure:${fieldId}`,
      slotKind: 'option_exposure',
      fieldId,
      ruleId: null,
      itemKind: field.options.source === 'tracks' ? 'track' : 'format',
      itemIds
    });
  }
  for (const rule of head.definition.rules) {
    if (rule.condition.kind !== 'selected_any') continue;
    const field = fields.get(rule.condition.sourceFieldId);
    if (!field || field.options.kind !== 'program_vocabulary') continue;
    locations.push({
      locationKey: `rule_condition:${rule.id}`,
      slotKind: 'rule_condition',
      fieldId: field.id,
      ruleId: rule.id,
      itemKind: field.options.source === 'tracks' ? 'track' : 'format',
      itemIds: rule.condition.choiceIds
    });
  }
  return locations.sort((left, right) =>
    left.locationKey < right.locationKey ? -1 : left.locationKey > right.locationKey ? 1 : 0
  );
}

function synchronizeProgramReferenceSlots(input: {
  readonly sqlite: Database;
  readonly head: FormDefinitionHeadDto;
  readonly registry: FieldRegistrySnapshotDto;
}): void {
  const currentScope = scope(input.head.scope);
  const existing = readProgramReferenceSlots(input.sqlite, currentScope, input.head.id);
  const byLocation = new Map<string, FormProgramReferenceSlot[]>();
  for (const slot of existing) {
    const locationKey = programReferenceLocationKey(slot);
    const group = byLocation.get(locationKey) ?? [];
    group.push(slot);
    byLocation.set(locationKey, group);
  }
  const retained = new Set<string>();
  for (const location of desiredProgramReferenceLocations(input.head, input.registry)) {
    const candidates = [...(byLocation.get(location.locationKey) ?? [])]
      .sort((left, right) => left.slotKey < right.slotKey ? -1 : 1);
    const used = new Set<string>();
    for (const itemId of [...location.itemIds].sort()) {
      const choose = (predicate: (slot: FormProgramReferenceSlot) => boolean) =>
        candidates.find((slot) => !used.has(slot.slotKey) && predicate(slot));
      const prior = choose((slot) => slot.itemId === itemId && slot.originItemId === itemId)
        ?? choose((slot) => slot.itemId === itemId)
        ?? choose((slot) => slot.originItemId === itemId)
        ?? choose(() => true);
      if (!prior) {
        const slotKey = programReferenceSlotKey({
          formId: input.head.id,
          slotKind: location.slotKind,
          fieldId: location.fieldId,
          ruleId: location.ruleId,
          originItemId: itemId
        });
        changedOnce(input.sqlite.query<never, [
          string, string, string, string, string, string | null, string | null,
          string, string, string
        ]>(`
          INSERT INTO intake_form_program_reference_slots (
            workspace_id, event_id, form_id, slot_key, slot_kind, field_id, rule_id,
            origin_item_id, item_kind, item_id, slot_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          currentScope.workspaceId, currentScope.eventId, input.head.id, slotKey,
          location.slotKind, location.fieldId, location.ruleId, itemId,
          location.itemKind, itemId
        ), 'stale_form');
        retained.add(slotKey);
        continue;
      }
      used.add(prior.slotKey);
      retained.add(prior.slotKey);
      const changed = prior.fieldId !== location.fieldId
        || prior.ruleId !== location.ruleId
        || prior.itemKind !== location.itemKind
        || prior.itemId !== itemId;
      if (!changed) continue;
      changedOnce(input.sqlite.query<never, [
        string | null, string | null, string, string, number,
        string, string, string, number, string, string, string | null, string | null
      ]>(`
        UPDATE intake_form_program_reference_slots
           SET field_id = ?, rule_id = ?, item_kind = ?, item_id = ?, slot_version = ?
         WHERE workspace_id = ? AND event_id = ? AND slot_key = ? AND slot_version = ?
           AND item_kind = ? AND item_id = ? AND field_id IS ? AND rule_id IS ?
      `).run(
        location.fieldId, location.ruleId, location.itemKind, itemId,
        prior.slotVersion + 1,
        currentScope.workspaceId, currentScope.eventId, prior.slotKey, prior.slotVersion,
        prior.itemKind, prior.itemId, prior.fieldId, prior.ruleId
      ), 'stale_form');
    }
  }
  for (const slot of existing) {
    if (retained.has(slot.slotKey)) continue;
    changedOnce(input.sqlite.query<never, [string, string, string, number, string, string]>(`
      DELETE FROM intake_form_program_reference_slots
       WHERE workspace_id = ? AND event_id = ? AND slot_key = ? AND slot_version = ?
         AND item_kind = ? AND item_id = ?
    `).run(
      currentScope.workspaceId, currentScope.eventId, slot.slotKey, slot.slotVersion,
      slot.itemKind, slot.itemId
    ), 'stale_form');
  }
}

function parseStored<T>(row: JsonRow | null, parser: (value: unknown) => T): T | undefined {
  if (!row) return undefined;
  try {
    const parsed = parser(JSON.parse(row.value_json));
    if (canonicalJsonText(parsed) !== row.value_json || digest(parsed) !== row.value_digest) {
      throw new TypeError();
    }
    return parsed;
  } catch {
    throw new SQLiteIntakeError('data_corrupt');
  }
}

function exactInstant(value: string, milliseconds: number): boolean {
  return Date.parse(value) === milliseconds;
}

export function installSQLiteIntakeSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteIntakeError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(SQLITE_INTAKE_SQL)).immediate();
}

interface SQLiteIntakeTargetReferenceSource {
  resolveActiveCategory(
    scope: SQLiteIntakeScopeInput,
    target: Extract<FormTarget, { readonly kind: 'category' }>
  ): Extract<FormTargetReferencePinDto, { readonly kind: 'category' }> | undefined;
  resolveCollectingSession?(
    scope: SQLiteIntakeScopeInput,
    target: Extract<FormTarget, { readonly kind: 'session' }>
  ): Extract<FormTargetReferencePinDto, { readonly kind: 'session' }> | undefined;
}

/** Canonical ephemeral Form/Application state on one caller-owned SQLite handle. */
export class SQLiteIntakeRepository {
  readonly #optionSource: SQLiteProgramVocabularyFieldOptionSource;
  readonly #registrySnapshots: SQLiteFieldRegistrySnapshotSource;
  readonly #deadlines: SQLiteDeadlineRepository;

  constructor(
    private readonly sqlite: Database,
    private readonly targetReferences: SQLiteIntakeTargetReferenceSource,
    private readonly submissionProjection?: SQLiteIntakeSubmissionProjectionPort
  ) {
    if (submissionProjection !== undefined) assertAuthenticatedIntakeProjection(submissionProjection);
    this.#optionSource = new SQLiteProgramVocabularyFieldOptionSource(sqlite);
    this.#registrySnapshots = new SQLiteFieldRegistrySnapshotSource(
      new SQLiteFieldRegistryRepository(
        sqlite,
        new SQLiteIntakeFieldRegistryFormReferenceResolver(sqlite)
      ),
      this.#optionSource
    );
    this.#deadlines = new SQLiteDeadlineRepository(sqlite, new SQLiteEventSpineRepository(sqlite));
  }

  readFormCatalog(scopeInput: SQLiteIntakeScopeInput): FormCatalogState | undefined {
    const currentScope = scope(scopeInput);
    const root = this.sqlite.query<{ readonly event_id: string }, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(currentScope.workspaceId, currentScope.eventId);
    if (root.length > 1) throw new SQLiteIntakeError('data_corrupt');
    if (root.length === 0) return undefined;
    const row = this.sqlite.query<{ readonly catalog_version: number }, [string, string]>(`
      SELECT catalog_version FROM intake_form_catalogs
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(currentScope.workspaceId, currentScope.eventId);
    if (row.length > 1) throw new SQLiteIntakeError('data_corrupt');
    const heads = this.readFormHeads(currentScope);
    if (!row[0] && heads.length > 0) throw new SQLiteIntakeError('data_corrupt');
    return parseFormCatalogState({
      scope: currentScope,
      version: row[0]?.catalog_version ?? 1,
      heads
    });
  }

  readFormHead(scopeInput: SQLiteIntakeScopeInput, formId: string): FormDefinitionHeadDto | undefined {
    const currentScope = scope(scopeInput);
    const row = this.sqlite.query<FormHeadRow, [string, string, string]>(`
      SELECT workspace_id, event_id, form_id, head_version, status,
             current_published_version_id, created_by_user_id, created_at_ms,
             updated_by_user_id, updated_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_form_heads
       WHERE workspace_id = ? AND event_id = ? AND form_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, formId);
    const head = parseStored(row, parseFormDefinitionHead);
    if (head && (!row || row.workspace_id !== currentScope.workspaceId
      || row.event_id !== currentScope.eventId || row.form_id !== formId
      || head.scope.workspaceId !== row.workspace_id || head.scope.eventId !== row.event_id
      || head.id !== row.form_id || head.version !== row.head_version
      || head.status !== row.status
      || head.currentPublishedVersionId !== row.current_published_version_id
      || head.createdByUserId !== row.created_by_user_id
      || !exactInstant(head.createdAt, row.created_at_ms)
      || head.updatedByUserId !== row.updated_by_user_id
      || !exactInstant(head.updatedAt, row.updated_at_ms))) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return head;
  }

  readFormVersions(scopeInput: SQLiteIntakeScopeInput, formId: string): readonly FormVersionDto[] {
    const currentScope = scope(scopeInput);
    return Object.freeze(this.sqlite.query<FormVersionRow, [string, string, string]>(`
      SELECT workspace_id, event_id, form_id, form_version_id, version_number,
             source_definition_version, published_by_user_id, published_at_ms,
             version_json AS value_json, version_digest_sha256 AS value_digest
        FROM intake_form_versions
       WHERE workspace_id = ? AND event_id = ? AND form_id = ?
       ORDER BY version_number, form_version_id COLLATE BINARY
    `).all(currentScope.workspaceId, currentScope.eventId, formId).map((row) => {
      const version = parseStored(row, parseFormVersion);
      if (!version || row.workspace_id !== currentScope.workspaceId
          || row.event_id !== currentScope.eventId || row.form_id !== formId
          || version.scope.workspaceId !== row.workspace_id
          || version.scope.eventId !== row.event_id || version.formId !== row.form_id
          || version.id !== row.form_version_id || version.number !== row.version_number
          || version.sourceDefinitionVersion !== row.source_definition_version
          || version.publishedByUserId !== row.published_by_user_id
          || !exactInstant(version.publishedAt, row.published_at_ms)) {
        throw new SQLiteIntakeError('data_corrupt');
      }
      return version;
    }));
  }

  readFieldRegistrySnapshot(
    scopeInput: SQLiteIntakeScopeInput
  ): FieldRegistrySnapshotDto | undefined {
    return this.#registrySnapshots.readSnapshot(scope(scopeInput));
  }

  readFormVersion(scopeInput: SQLiteIntakeScopeInput, formVersionId: string): FormVersionDto | undefined {
    const currentScope = scope(scopeInput);
    const row = this.sqlite.query<FormVersionRow, [string, string, string]>(`
      SELECT workspace_id, event_id, form_id, form_version_id, version_number,
             source_definition_version, published_by_user_id, published_at_ms,
             version_json AS value_json, version_digest_sha256 AS value_digest
        FROM intake_form_versions
       WHERE workspace_id = ? AND event_id = ? AND form_version_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, formVersionId);
    const version = parseStored(row, parseFormVersion);
    if (version && (!row || row.workspace_id !== currentScope.workspaceId
      || row.event_id !== currentScope.eventId || row.form_version_id !== formVersionId
      || version.scope.workspaceId !== row.workspace_id
      || version.scope.eventId !== row.event_id || version.formId !== row.form_id
      || version.id !== row.form_version_id || version.number !== row.version_number
      || version.sourceDefinitionVersion !== row.source_definition_version
      || version.publishedByUserId !== row.published_by_user_id
      || !exactInstant(version.publishedAt, row.published_at_ms))) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return version;
  }

  applyFormMutation(planInput: FormMutationPlan): AppliedFormMutation {
    if (!this.sqlite.inTransaction) throw new SQLiteIntakeError('transaction_required');
    const plan = parseFormMutationPlan(planInput);
    const currentScope = scope(plan.scope);
    const catalog = this.readFormCatalog(currentScope);
    if (!catalog) throw new SQLiteIntakeError('scope_missing');
    const versions = plan.action === 'publish'
      || (plan.action === 'lifecycle' && plan.publishedVersion !== null)
      ? this.readFormVersions(currentScope, plan.after.id)
      : undefined;
    const registry = this.readFieldRegistrySnapshot(currentScope);
    if (!registry) throw new SQLiteIntakeError('scope_missing');
    let applied;
    try {
      applied = applyFormMutationPlan({
        catalog,
        registry,
        plan,
        references: this,
        ...(versions === undefined ? {} : { existingVersions: versions })
      });
    } catch {
      throw new SQLiteIntakeError('stale_form');
    }
    if (catalog.version === 1) {
      changedOnce(this.sqlite.query<never, [string, string, number, string, string, string, string]>(`
        INSERT INTO intake_form_catalogs (workspace_id, event_id, catalog_version)
        SELECT ?, ?, ? FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM intake_form_catalogs WHERE workspace_id = ? AND event_id = ?
           )
      `).run(
        currentScope.workspaceId, currentScope.eventId, applied.catalog.version,
        currentScope.workspaceId, currentScope.eventId,
        currentScope.workspaceId, currentScope.eventId
      ), 'stale_form');
    } else {
      changedOnce(this.sqlite.query<never, [number, string, string, number]>(`
        UPDATE intake_form_catalogs SET catalog_version = ?
         WHERE workspace_id = ? AND event_id = ? AND catalog_version = ?
      `).run(
        applied.catalog.version, currentScope.workspaceId, currentScope.eventId, catalog.version
      ), 'stale_form');
    }
    if (plan.action === 'create') this.insertFormHead(plan.after);
    else {
      if (plan.action === 'publish') this.insertFormVersion(plan.publishedVersion);
      else if (plan.action === 'lifecycle' && plan.publishedVersion !== null) {
        this.insertFormVersion(plan.publishedVersion);
      }
      this.updateFormHead(plan.before, plan.after);
    }
    if (plan.action === 'create' || plan.action === 'revise') {
      synchronizeProgramReferenceSlots({ sqlite: this.sqlite, head: plan.after, registry });
    }
    const after = this.readFormCatalog(currentScope);
    if (!after || canonicalJsonText(after) !== canonicalJsonText(applied.catalog)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return applied;
  }

  applyFormPlan(plan: FormMutationPlan): AppliedFormMutation {
    return this.applyFormMutation(plan);
  }

  resolveActiveCategory(
    scopeInput: SQLiteIntakeScopeInput,
    target: Extract<FormTarget, { readonly kind: 'category' }>
  ): Extract<FormTargetReferencePinDto, { readonly kind: 'category' }> | undefined {
    const resolved = this.targetReferences.resolveActiveCategory(scope(scopeInput), target);
    return resolved?.kind === 'category' ? resolved : undefined;
  }

  resolveCollectingSession(
    scopeInput: SQLiteIntakeScopeInput,
    target: Extract<FormTarget, { readonly kind: 'session' }>
  ): Extract<FormTargetReferencePinDto, { readonly kind: 'session' }> | undefined {
    const resolved = this.targetReferences.resolveCollectingSession?.(scope(scopeInput), target);
    return resolved?.kind === 'session' && resolved.lifecycle === 'collecting'
      ? resolved : undefined;
  }

  resolveCurrentDeadline(
    scopeInput: SQLiteIntakeScopeInput,
    availability: Extract<FormAvailability, { readonly kind: 'deadline' }>
  ) {
    return this.#deadlines.resolveCurrentDeadline(scope(scopeInput), availability);
  }

  readDeadlineCatalog(scopeInput: SQLiteIntakeScopeInput): DeadlineCatalogSnapshotDto | undefined {
    return this.#deadlines.readDeadlineCatalog(scope(scopeInput));
  }

  readDeadline(
    scopeInput: SQLiteIntakeScopeInput,
    deadlineId: string
  ): DeadlineHeadDto | undefined {
    return this.#deadlines.readDeadline(scope(scopeInput), deadlineId);
  }

  readDeadlineEventTimeBasis(
    scopeInput: SQLiteIntakeScopeInput
  ): DeadlineEventTimeBasisDto | undefined {
    return this.#deadlines.readDeadlineEventTimeBasis(scope(scopeInput));
  }

  readLiveOptions(
    scopeInput: SQLiteIntakeScopeInput,
    source: FieldRegistryOptionSource
  ): readonly ApplicationAnswerLiveOption[] {
    return this.#optionSource.readLiveOptions(scope(scopeInput), source);
  }

  planFormCloseDeadlineChange(
    input: FormCloseDeadlineChangeInput
  ): FormCloseDeadlineContribution {
    return this.#deadlines.planFormCloseDeadlineChange(input);
  }

  validateFormCloseDeadline(
    contribution: FormCloseDeadlineContribution
  ): FormCloseDeadlineValidation {
    return this.#deadlines.validateFormCloseDeadline(contribution);
  }

  applyFormCloseDeadline(
    contribution: FormCloseDeadlineContribution
  ): FormCloseDeadlineAppliedContribution {
    return this.#deadlines.applyFormCloseDeadline(contribution);
  }

  readDraft(scopeInput: SQLiteIntakeScopeInput, draftId: string): {
    readonly head: ApplicationDraftHeadDto;
    readonly revision: ApplicationDraftRevisionDto;
  } | undefined {
    const currentScope = scope(scopeInput);
    const headRow = this.sqlite.query<DraftHeadRow, [string, string, string]>(`
      SELECT workspace_id, event_id, draft_id, form_id, form_version_id,
             authority_partition_digest_sha256, draft_version, current_revision_id,
             status, submitted_submission_id, created_at_ms, updated_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_application_draft_heads
       WHERE workspace_id = ? AND event_id = ? AND draft_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, draftId);
    const head = parseStored(headRow, parseApplicationDraftHead);
    if (!head) return undefined;
    const revisionRow = this.sqlite.query<DraftRevisionRow, [string, string, string, string]>(`
      SELECT workspace_id, event_id, draft_id, revision_id, revision_number,
             request_digest_sha256, saved_at_ms,
             revision_json AS value_json, revision_digest_sha256 AS value_digest
        FROM intake_application_draft_revisions
       WHERE workspace_id = ? AND event_id = ? AND draft_id = ? AND revision_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, draftId, head.currentRevisionId);
    const revision = parseStored(revisionRow, parseApplicationDraftRevision);
    if (!headRow || !revisionRow || !revision || headRow.workspace_id !== currentScope.workspaceId
        || headRow.event_id !== currentScope.eventId || headRow.draft_id !== draftId
        || head.scope.workspaceId !== headRow.workspace_id
        || head.scope.eventId !== headRow.event_id || head.id !== headRow.draft_id
        || head.formId !== headRow.form_id || head.formVersionId !== headRow.form_version_id
        || head.authorityPartitionDigestSha256 !== headRow.authority_partition_digest_sha256
        || head.version !== headRow.draft_version
        || head.currentRevisionId !== headRow.current_revision_id
        || head.status !== headRow.status
        || head.submittedSubmissionId !== headRow.submitted_submission_id
        || !exactInstant(head.createdAt, headRow.created_at_ms)
        || !exactInstant(head.updatedAt, headRow.updated_at_ms)
        || revisionRow.workspace_id !== currentScope.workspaceId
        || revisionRow.event_id !== currentScope.eventId
        || revisionRow.draft_id !== draftId || revisionRow.revision_id !== revision.id
        || revisionRow.revision_number !== revision.version
        || revisionRow.request_digest_sha256 !== revision.requestDigestSha256
        || !exactInstant(revision.savedAt, revisionRow.saved_at_ms)
        || revision.draftId !== draftId || revision.id !== head.currentRevisionId
        || revision.version !== (head.status === 'submitted' ? head.version - 1 : head.version)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return Object.freeze({ head, revision });
  }

  applyApplicationMutation(
    plan: ApplicationMutationPlan | ApplicationDirectEntryPlan,
    payloadReferences: ApplicationAnswerPayloadReferenceVerifier
  ): void {
    if (!this.sqlite.inTransaction) throw new SQLiteIntakeError('transaction_required');
    if ((plan as { readonly action?: unknown }).action === 'direct_entry') {
      this.applyDirectEntryMutation(plan as ApplicationDirectEntryPlan, payloadReferences);
      return;
    }
    plan = parseApplicationMutationPlan(plan);
    const expectedHead = plan.action === 'begin' ? plan.head : plan.beforeHead;
    const formHead = this.readFormHead(expectedHead.scope, expectedHead.formId);
    const formVersion = this.readFormVersion(expectedHead.scope, expectedHead.formVersionId);
    if (!formHead || !formVersion) throw new SQLiteIntakeError('stale_form');
    try {
      plan = validateApplicationMutationPlanAgainstForm({
        plan,
        formHead,
        formVersion,
        collection: this,
        payloadReferences
      });
    } catch {
      throw new SQLiteIntakeError('stale_form');
    }
    if (plan.action === 'begin') {
      this.assertCurrentForm(plan.head.scope, plan.head.formId, plan.head.formVersionId,
        plan.formDefinitionVersion, plan.formVersionDigestSha256);
      this.insertDraftHead(plan.head);
      this.insertDraftRevision(plan.revision);
    } else if (plan.action === 'save') {
      this.assertCurrentForm(plan.beforeHead.scope, plan.beforeHead.formId,
        plan.beforeHead.formVersionId, plan.formDefinitionVersion, plan.formVersionDigestSha256);
      this.assertCurrentDraft(plan.beforeHead, plan.beforeRevision);
      this.insertDraftRevision(plan.afterRevision);
      this.updateDraftHead(plan.beforeHead, plan.afterHead);
    } else {
      this.assertCurrentForm(plan.beforeHead.scope, plan.beforeHead.formId,
        plan.beforeHead.formVersionId, plan.formDefinitionVersion, plan.formVersionDigestSha256);
      this.assertCurrentDraft(plan.beforeHead, plan.sourceRevision);
      this.insertSubmission(plan);
      this.updateDraftHead(plan.beforeHead, plan.afterHead);
    }
    const effective = plan.action === 'begin'
      ? this.readDraft(plan.head.scope, plan.head.id)
      : this.readDraft(plan.afterHead.scope, plan.afterHead.id);
    if (!effective) throw new SQLiteIntakeError('data_corrupt');
  }

  private applyDirectEntryMutation(
    planInput: ApplicationDirectEntryPlan,
    payloadReferences: ApplicationAnswerPayloadReferenceVerifier
  ): void {
    let plan = parseApplicationDirectEntryPlan(planInput);
    const formHead = this.readFormHead(plan.submission.scope, plan.submission.formId);
    const formVersion = this.readFormVersion(plan.submission.scope, plan.submission.formVersionId);
    if (!formHead || !formVersion) throw new SQLiteIntakeError('stale_form');
    try {
      plan = validateApplicationDirectEntryPlanAgainstForm({
        plan,
        formHead,
        formVersion,
        collection: this,
        payloadReferences
      });
    } catch {
      throw new SQLiteIntakeError('stale_form');
    }
    this.assertCurrentForm(plan.submission.scope, plan.submission.formId,
      plan.submission.formVersionId, plan.formDefinitionVersion, plan.formVersionDigestSha256);
    this.insertSubmission(plan);
    const head = this.readSubmissionHead(plan.submission.scope, plan.submission.id);
    const evidence = this.readDirectEntryEvidence(plan.submission.scope, plan.submission.id);
    if (!head || !evidence
        || canonicalJsonText(head) !== canonicalJsonText(plan.submission)
        || canonicalJsonText(evidence) !== canonicalJsonText(plan.entryEvidence)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
  }

  readDirectEntryEvidence(
    scopeInput: SQLiteIntakeScopeInput,
    submissionId: string
  ): SubmissionDirectEntryEvidenceDto | undefined {
    const currentScope = scope(scopeInput);
    const row = this.sqlite.query<SubmissionEvidenceRow & {
      readonly entered_by_user_id: string;
    }, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, evidence_id, entered_by_user_id,
             evidence_json AS value_json, evidence_digest_sha256 AS value_digest
        FROM intake_submission_direct_entry_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const evidence = parseStored(row, parseSubmissionDirectEntryEvidence);
    if (evidence && (!row || row.workspace_id !== currentScope.workspaceId
        || row.event_id !== currentScope.eventId || row.submission_id !== submissionId
        || evidence.id !== row.evidence_id || evidence.submissionId !== row.submission_id
        || evidence.enteredByUserId !== row.entered_by_user_id)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return evidence;
  }

  listForms(scopeInput: SQLiteIntakeScopeInput): OrganizerFormCatalogDto {
    const currentScope = scope(scopeInput);
    const catalog = this.readFormCatalog(currentScope);
    if (!catalog) throw new SQLiteIntakeError('scope_missing');
    const registry = this.readFieldRegistrySnapshot(currentScope);
    if (!registry) throw new SQLiteIntakeError('scope_missing');
    const forms = catalog.heads.map((head) => {
      const row = this.sqlite.query<{ readonly submission_count: number }, [string, string, string]>(`
        SELECT count(*) AS submission_count
          FROM intake_submission_heads
         WHERE workspace_id = ? AND event_id = ? AND form_id = ?
      `).get(currentScope.workspaceId, currentScope.eventId, head.id);
      if (!row || !Number.isSafeInteger(row.submission_count) || row.submission_count < 0) {
        throw new SQLiteIntakeError('data_corrupt');
      }
      return projectOrganizerFormSummary({
        head,
        submissionCount: row.submission_count,
        registry,
        references: this
      });
    });
    return projectOrganizerFormCatalog({ catalogVersion: catalog.version, registry, forms });
  }

  readFormDetail(scopeInput: SQLiteIntakeScopeInput, formId: string): OrganizerFormDetailDto | undefined {
    const head = this.readFormHead(scopeInput, formId);
    if (!head) return undefined;
    const current = head.currentPublishedVersionId === null
      ? null
      : this.readFormVersion(scopeInput, head.currentPublishedVersionId);
    if (current === undefined) throw new SQLiteIntakeError('data_corrupt');
    const registry = this.readFieldRegistrySnapshot(scopeInput);
    if (!registry) throw new SQLiteIntakeError('scope_missing');
    return projectOrganizerFormDetail({
      head,
      registry,
      references: this,
      currentPublishedVersion: current
    });
  }

  readServedForm(scopeInput: SQLiteIntakeScopeInput, formId: string): ServedPublicFormDto | undefined {
    const head = this.readFormHead(scopeInput, formId);
    if (!head || head.status !== 'open' || head.currentPublishedVersionId === null) return undefined;
    const version = this.readFormVersion(scopeInput, head.currentPublishedVersionId);
    if (!version) throw new SQLiteIntakeError('data_corrupt');
    return projectServedPublicForm({ version, optionSource: this, references: this });
  }

  listSubmissions(scopeInput: SQLiteIntakeScopeInput): readonly OrganizerSubmissionSummaryDto[] {
    return this.listSubmissionSummaries(scopeInput, true);
  }

  /**
   * Application-internal source projection. Unlike the organizer list read,
   * this returns the complete retained population for joined operations such
   * as triage and Review; it is never mounted as a browser list endpoint.
   */
  listAllSubmissionSummaries(
    scopeInput: SQLiteIntakeScopeInput
  ): readonly OrganizerSubmissionSummaryDto[] {
    return this.listSubmissionSummaries(scopeInput, false);
  }

  /**
   * Complete canonical-Person proposal coverage in stable pages. This reads the
   * retained person binding on the submission head; it never reconstructs
   * identity from email or a display name and it does not widen the triage
   * projection with participant identifiers.
   */
  listPersonSubmissions(
    scopeInput: SQLiteIntakeScopeInput,
    personId: string,
    afterSubmissionId?: string
  ): OrganizerPersonSubmissionPageDto {
    const currentScope = scope(scopeInput);
    const rows = this.sqlite.query<SubmissionHeadRow, [string, string, string, string, number]>(`
      SELECT workspace_id, event_id, submission_id, form_id, form_version_id,
             draft_id, submit_evidence_id, person_id, submitted_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_submission_heads
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?
         AND submission_id > ?
       ORDER BY submission_id COLLATE BINARY
       LIMIT ?
    `).all(
      currentScope.workspaceId,
      currentScope.eventId,
      personId,
      afterSubmissionId ?? '',
      ORGANIZER_PERSON_SUBMISSION_PAGE_SIZE + 1
    );
    const hasMore = rows.length > ORGANIZER_PERSON_SUBMISSION_PAGE_SIZE;
    const pageRows = rows.slice(0, ORGANIZER_PERSON_SUBMISSION_PAGE_SIZE)
      .map((row) => this.projectSubmissionSummary(currentScope, row));
    return Object.freeze({
      schemaVersion: 1 as const,
      rows: pageRows,
      nextAfterSubmissionId: hasMore ? pageRows.at(-1)!.id : null
    });
  }

  /** Exact application-internal lookup; it does not scan the capped organizer list. */
  readSubmissionSummary(
    scopeInput: SQLiteIntakeScopeInput,
    submissionId: string
  ): OrganizerSubmissionSummaryDto | undefined {
    const currentScope = scope(scopeInput);
    const rows = this.sqlite.query<SubmissionHeadRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, form_id, form_version_id,
             draft_id, submit_evidence_id, person_id, submitted_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_submission_heads
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).all(currentScope.workspaceId, currentScope.eventId, submissionId);
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) throw new SQLiteIntakeError('data_corrupt');
    return this.projectSubmissionSummary(currentScope, rows[0]!);
  }

  private listSubmissionSummaries(
    scopeInput: SQLiteIntakeScopeInput,
    bounded: boolean
  ): readonly OrganizerSubmissionSummaryDto[] {
    const currentScope = scope(scopeInput);
    const select = `
      SELECT workspace_id, event_id, submission_id, form_id, form_version_id,
             draft_id, submit_evidence_id, person_id, submitted_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_submission_heads
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY submission_id COLLATE BINARY${bounded ? ' LIMIT 500' : ''}
    `;
    const rows = this.sqlite.query<SubmissionHeadRow, [string, string]>(select)
      .all(currentScope.workspaceId, currentScope.eventId);
    return Object.freeze(rows.map((row) => this.projectSubmissionSummary(currentScope, row)));
  }

  private projectSubmissionSummary(
    currentScope: Scope,
    row: SubmissionHeadRow
  ): OrganizerSubmissionSummaryDto {
    const head = parseStored(row, parseSubmissionHead);
    if (!head || row.workspace_id !== currentScope.workspaceId
        || row.event_id !== currentScope.eventId || row.submission_id !== head.id
        || head.scope.workspaceId !== currentScope.workspaceId
        || head.scope.eventId !== currentScope.eventId || head.formId !== row.form_id
        || head.formVersionId !== row.form_version_id
        || head.submitEvidenceId !== row.submit_evidence_id
        || head.primaryPersonId !== row.person_id
        || !exactInstant(head.submittedAt, row.submitted_at_ms)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    const version = this.readFormVersion(currentScope, head.formVersionId);
    if (!version || !this.submissionProjection) throw new SQLiteIntakeError('data_corrupt');
    if (head.source === 'direct_entry') {
      const entryEvidence = this.readDirectEntryEvidence(currentScope, head.id);
      if (!entryEvidence || row.draft_id !== null
          || entryEvidence.id !== row.submit_evidence_id
          || entryEvidence.submissionId !== row.submission_id
          || entryEvidence.formVersionId !== row.form_version_id
          || entryEvidence.submittedAt !== head.submittedAt) {
        throw new SQLiteIntakeError('data_corrupt');
      }
      return this.submissionProjection.projectDirectEntrySummary({
        head, entryEvidence, version
      });
    }
    const evidence = this.readSubmitEvidence(currentScope, head.id);
    if (!evidence
        || evidence.id !== row.submit_evidence_id
        || evidence.submissionId !== row.submission_id
        || evidence.draftId !== row.draft_id
        || evidence.formVersionId !== row.form_version_id
        || evidence.submittedAt !== head.submittedAt) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    const draft = this.readDraft(currentScope, evidence.draftId);
    if (!draft || draft.head.status !== 'submitted'
        || draft.head.submittedSubmissionId !== head.id
        || draft.revision.id !== evidence.draftRevisionId) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return this.submissionProjection.projectSummary({
      head,
      submitEvidence: evidence,
      version,
      draftHead: draft.head,
      sourceRevision: draft.revision
    });
  }

  readSubmissionDetail(scopeInput: SQLiteIntakeScopeInput, submissionId: string): OrganizerSubmissionDetailDto | undefined {
    const currentScope = scope(scopeInput);
    const head = this.readSubmissionHead(currentScope, submissionId);
    if (!head) return undefined;
    if (head.source === 'direct_entry') return this.readDirectEntryDetail(currentScope, head);
    const evidence = this.readSubmitEvidence(currentScope, submissionId);
    const bindingRow = this.sqlite.query<{
      readonly draft_id: string; readonly form_id: string; readonly form_version_id: string;
      readonly submit_evidence_id: string; readonly person_id: string; readonly submitted_at_ms: number;
    }, [string, string, string]>(`
      SELECT draft_id, form_id, form_version_id, submit_evidence_id, person_id, submitted_at_ms
        FROM intake_submission_heads
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const participantRow = this.sqlite.query<ParticipantEvidenceRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, evidence_id, person_id,
             participant_identity_id, evidence_json AS value_json,
             evidence_digest_sha256 AS value_digest
        FROM intake_submission_participant_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const participant = parseStored(participantRow, parseSubmissionParticipantEvidence);
    const consents = this.sqlite.query<ConsentEvidenceRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, evidence_id, field_id,
             evidence_json AS value_json, evidence_digest_sha256 AS value_digest
        FROM intake_submission_consent_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
       ORDER BY field_id COLLATE BINARY
    `).all(currentScope.workspaceId, currentScope.eventId, submissionId).map((row) => {
      const consent = parseStored(row, parseSubmissionConsentEvidence);
      if (!consent || row.workspace_id !== currentScope.workspaceId
          || row.event_id !== currentScope.eventId || row.submission_id !== submissionId
          || consent.id !== row.evidence_id || consent.submissionId !== row.submission_id
          || consent.fieldId !== row.field_id) throw new SQLiteIntakeError('data_corrupt');
      return consent;
    });
    if (!bindingRow || !evidence || !participant || evidence.id !== head.submitEvidenceId
        || evidence.submissionId !== head.id || evidence.formVersionId !== head.formVersionId
        || bindingRow.draft_id !== evidence.draftId || bindingRow.form_id !== head.formId
        || bindingRow.form_version_id !== head.formVersionId
        || bindingRow.submit_evidence_id !== evidence.id
        || bindingRow.person_id !== head.primaryPersonId
        || bindingRow.submitted_at_ms !== Date.parse(head.submittedAt)
        || !participantRow || participantRow.workspace_id !== currentScope.workspaceId
        || participantRow.event_id !== currentScope.eventId
        || participant.id !== participantRow.evidence_id
        || participant.submissionId !== participantRow.submission_id
        || participant.personId !== participantRow.person_id
        || participant.participantIdentityId !== participantRow.participant_identity_id
        || participant.submissionId !== head.id || participant.personId !== head.primaryPersonId
        || consents.some((consent) => consent.submissionId !== head.id
          || consent.formVersionId !== head.formVersionId)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    const version = this.readFormVersion(currentScope, head.formVersionId);
    if (!version || !this.submissionProjection) throw new SQLiteIntakeError('data_corrupt');
    const draft = this.readDraft(currentScope, evidence.draftId);
    if (!draft || draft.head.status !== 'submitted'
        || draft.head.submittedSubmissionId !== head.id
        || draft.revision.id !== evidence.draftRevisionId) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return this.submissionProjection.projectDetail({
      head,
      submitEvidence: evidence,
      version,
      draftHead: draft.head,
      sourceRevision: draft.revision,
      participants: [participant],
      consents
    });
  }

  private readDirectEntryDetail(
    currentScope: Scope,
    head: SubmissionHeadDto
  ): OrganizerSubmissionDetailDto {
    const entryEvidence = this.readDirectEntryEvidence(currentScope, head.id);
    const participant = this.readParticipantEvidence(currentScope, head.id);
    const consentCount = this.sqlite.query<{ readonly consent_count: number }, [string, string, string]>(`
      SELECT count(*) AS consent_count FROM intake_submission_consent_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ?
    `).get(currentScope.workspaceId, currentScope.eventId, head.id);
    const version = this.readFormVersion(currentScope, head.formVersionId);
    if (!entryEvidence || !participant || !version || !this.submissionProjection
        || consentCount?.consent_count !== 0
        || entryEvidence.id !== head.submitEvidenceId
        || entryEvidence.submissionId !== head.id
        || entryEvidence.formVersionId !== head.formVersionId
        || entryEvidence.submittedAt !== head.submittedAt
        || participant.submissionId !== head.id
        || participant.personId !== head.primaryPersonId) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return this.submissionProjection.projectDirectEntryDetail({
      head, entryEvidence, version, participants: [participant]
    });
  }

  private readParticipantEvidence(
    currentScope: Scope,
    submissionId: string
  ): SubmissionParticipantEvidenceDto | undefined {
    const row = this.sqlite.query<ParticipantEvidenceRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, evidence_id, person_id,
             participant_identity_id, evidence_json AS value_json,
             evidence_digest_sha256 AS value_digest
        FROM intake_submission_participant_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const participant = parseStored(row, parseSubmissionParticipantEvidence);
    if (participant && (!row || row.workspace_id !== currentScope.workspaceId
        || row.event_id !== currentScope.eventId || row.submission_id !== submissionId
        || participant.id !== row.evidence_id
        || participant.submissionId !== row.submission_id
        || participant.personId !== row.person_id
        || participant.participantIdentityId !== row.participant_identity_id)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return participant;
  }

  readSubmissionContact(
    scopeInput: SQLiteIntakeScopeInput,
    submissionId: string
  ): OrganizerSubmissionContactDto | undefined {
    const currentScope = scope(scopeInput);
    const head = this.readSubmissionHead(currentScope, submissionId);
    if (!head) return undefined;
    if (head.source === 'direct_entry') {
      const entryEvidence = this.readDirectEntryEvidence(currentScope, submissionId);
      const participant = this.readParticipantEvidence(currentScope, submissionId);
      const version = this.readFormVersion(currentScope, head.formVersionId);
      if (!entryEvidence || !participant || !version || !this.submissionProjection
          || entryEvidence.id !== head.submitEvidenceId
          || participant.submissionId !== head.id
          || participant.personId !== head.primaryPersonId) {
        throw new SQLiteIntakeError('data_corrupt');
      }
      return this.submissionProjection.resolveDirectEntryContact({
        head, entryEvidence, participant, version
      });
    }
    const submitEvidence = this.readSubmitEvidence(currentScope, submissionId);
    const participantRow = this.sqlite.query<ParticipantEvidenceRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, evidence_id, person_id,
             participant_identity_id, evidence_json AS value_json,
             evidence_digest_sha256 AS value_digest
        FROM intake_submission_participant_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const participant = parseStored(participantRow, parseSubmissionParticipantEvidence);
    const version = this.readFormVersion(currentScope, head.formVersionId);
    if (!submitEvidence || !participant || !participantRow || !version
        || !this.submissionProjection || participant.id !== participantRow.evidence_id
        || participant.submissionId !== head.id || participant.personId !== head.primaryPersonId
        || participant.personId !== participantRow.person_id
        || participant.participantIdentityId !== participantRow.participant_identity_id) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    const draft = this.readDraft(currentScope, submitEvidence.draftId);
    if (!draft || draft.head.submittedSubmissionId !== head.id
        || draft.revision.id !== submitEvidence.draftRevisionId) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return this.submissionProjection.resolveContact({
      head, submitEvidence, participant, version,
      draftHead: draft.head, sourceRevision: draft.revision
    });
  }

  readPublicDraftResume(
    scopeInput: SQLiteIntakeScopeInput,
    binding: {
      readonly draftId: string;
      readonly formId: string;
      readonly formVersionId: string;
      readonly authorityPartitionDigestSha256: string;
    }
  ): PublicApplicationDraftResumeDto | undefined {
    const currentScope = scope(scopeInput);
    const draft = this.readDraft(currentScope, binding.draftId);
    if (!draft) return undefined;
    if (draft.head.formId !== binding.formId
        || draft.head.formVersionId !== binding.formVersionId
        || draft.head.authorityPartitionDigestSha256
          !== binding.authorityPartitionDigestSha256
        || !this.submissionProjection) throw new SQLiteIntakeError('data_corrupt');
    const version = this.readFormVersion(currentScope, binding.formVersionId);
    if (!version) throw new SQLiteIntakeError('data_corrupt');
    return this.submissionProjection.resolveDraftResume({
      head: draft.head,
      revision: draft.revision,
      version
    });
  }

  private readFormHeads(currentScope: Scope): readonly FormDefinitionHeadDto[] {
    return Object.freeze(this.sqlite.query<FormHeadRow, [string, string]>(`
      SELECT workspace_id, event_id, form_id, head_version, status,
             current_published_version_id, created_by_user_id, created_at_ms,
             updated_by_user_id, updated_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_form_heads
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY form_id COLLATE BINARY LIMIT 500
    `).all(currentScope.workspaceId, currentScope.eventId).map((row) => {
      const head = parseStored(row, parseFormDefinitionHead);
      if (!head || row.workspace_id !== currentScope.workspaceId
          || row.event_id !== currentScope.eventId || row.form_id !== head.id
          || head.scope.workspaceId !== currentScope.workspaceId
          || head.scope.eventId !== currentScope.eventId
          || head.version !== row.head_version || head.status !== row.status
          || head.currentPublishedVersionId !== row.current_published_version_id
          || head.createdByUserId !== row.created_by_user_id
          || !exactInstant(head.createdAt, row.created_at_ms)
          || head.updatedByUserId !== row.updated_by_user_id
          || !exactInstant(head.updatedAt, row.updated_at_ms)) {
        throw new SQLiteIntakeError('data_corrupt');
      }
      return head;
    }));
  }

  private insertFormHead(headInput: FormDefinitionHeadDto): void {
    const head = parseFormDefinitionHead(headInput);
    try {
      changedOnce(this.sqlite.query<never, [string, string, string, number, string, string | null, string, string, string, number, string, number]>(`
        INSERT INTO intake_form_heads (
          workspace_id, event_id, form_id, head_version, status, current_published_version_id,
          head_json, head_digest_sha256, created_by_user_id, created_at_ms,
          updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        head.scope.workspaceId, head.scope.eventId, head.id, head.version, head.status,
        head.currentPublishedVersionId, canonicalJsonText(head), digest(head),
        head.createdByUserId, Date.parse(head.createdAt), head.updatedByUserId, Date.parse(head.updatedAt)
      ), 'id_collision');
    } catch (error) {
      if (error instanceof SQLiteIntakeError) throw error;
      throw new SQLiteIntakeError('id_collision');
    }
  }

  private updateFormHead(beforeInput: FormDefinitionHeadDto, afterInput: FormDefinitionHeadDto): void {
    const before = parseFormDefinitionHead(beforeInput);
    const after = parseFormDefinitionHead(afterInput);
    changedOnce(this.sqlite.query<never, [number, string, string | null, string, string, string, number, string, string, string, number, string]>(`
      UPDATE intake_form_heads
         SET head_version = ?, status = ?, current_published_version_id = ?,
             head_json = ?, head_digest_sha256 = ?, updated_by_user_id = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND form_id = ?
         AND head_version = ? AND head_digest_sha256 = ?
    `).run(
      after.version, after.status, after.currentPublishedVersionId, canonicalJsonText(after), digest(after),
      after.updatedByUserId, Date.parse(after.updatedAt), before.scope.workspaceId, before.scope.eventId,
      before.id, before.version, digest(before)
    ), 'stale_form');
  }

  private insertFormVersion(versionInput: FormVersionDto): void {
    const version = parseFormVersion(versionInput);
    try {
      changedOnce(this.sqlite.query<never, [string, string, string, string, number, number, string, string, string, number]>(`
        INSERT INTO intake_form_versions (
          workspace_id, event_id, form_id, form_version_id, version_number,
          source_definition_version, version_json, version_digest_sha256,
          published_by_user_id, published_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        version.scope.workspaceId, version.scope.eventId, version.formId, version.id,
        version.number, version.sourceDefinitionVersion, canonicalJsonText(version), digest(version),
        version.publishedByUserId, Date.parse(version.publishedAt)
      ), 'id_collision');
    } catch (error) {
      if (error instanceof SQLiteIntakeError) throw error;
      throw new SQLiteIntakeError('id_collision');
    }
  }

  private insertDraftHead(headInput: ApplicationDraftHeadDto): void {
    const head = parseApplicationDraftHead(headInput);
    try {
      changedOnce(this.sqlite.query<never, [string, string, string, string, string, string, number, string, string, string | null, string, string, number, number]>(`
        INSERT INTO intake_application_draft_heads (
          workspace_id, event_id, draft_id, form_id, form_version_id,
          authority_partition_digest_sha256, draft_version, current_revision_id,
          status, submitted_submission_id, head_json, head_digest_sha256,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        head.scope.workspaceId, head.scope.eventId, head.id, head.formId, head.formVersionId,
        head.authorityPartitionDigestSha256, head.version, head.currentRevisionId,
        head.status, head.submittedSubmissionId, canonicalJsonText(head), digest(head),
        Date.parse(head.createdAt), Date.parse(head.updatedAt)
      ), 'id_collision');
    } catch (error) {
      if (error instanceof SQLiteIntakeError) throw error;
      throw new SQLiteIntakeError('id_collision');
    }
  }

  private insertDraftRevision(revisionInput: ApplicationDraftRevisionDto): void {
    const revision = parseApplicationDraftRevision(revisionInput);
    try {
      changedOnce(this.sqlite.query<never, [string, number, string, string, string, number, string]>(`
        INSERT INTO intake_application_draft_revisions (
          workspace_id, event_id, draft_id, revision_id, revision_number,
          request_digest_sha256, revision_json, revision_digest_sha256, saved_at_ms
        ) SELECT workspace_id, event_id, draft_id, ?, ?, ?, ?, ?, ?
            FROM intake_application_draft_heads
           WHERE draft_id = ?
      `).run(
        revision.id, revision.version, revision.requestDigestSha256,
        canonicalJsonText(revision), digest(revision), Date.parse(revision.savedAt), revision.draftId
      ), 'stale_draft');
    } catch (error) {
      if (error instanceof SQLiteIntakeError) throw error;
      throw new SQLiteIntakeError('id_collision');
    }
  }

  private updateDraftHead(beforeInput: ApplicationDraftHeadDto, afterInput: ApplicationDraftHeadDto): void {
    const before = parseApplicationDraftHead(beforeInput);
    const after = parseApplicationDraftHead(afterInput);
    changedOnce(this.sqlite.query<never, [number, string, string, string | null, string, string, number, string, string, string, number, string]>(`
      UPDATE intake_application_draft_heads
         SET draft_version = ?, current_revision_id = ?, status = ?, submitted_submission_id = ?,
             head_json = ?, head_digest_sha256 = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND draft_id = ?
         AND draft_version = ? AND head_digest_sha256 = ?
    `).run(
      after.version, after.currentRevisionId, after.status, after.submittedSubmissionId,
      canonicalJsonText(after), digest(after), Date.parse(after.updatedAt), before.scope.workspaceId,
      before.scope.eventId, before.id, before.version, digest(before)
    ), 'stale_draft');
  }

  private assertCurrentDraft(
    expectedHead: ApplicationDraftHeadDto,
    expectedRevision: ApplicationDraftRevisionDto
  ): void {
    const current = this.readDraft(expectedHead.scope, expectedHead.id);
    if (!current || canonicalJsonText(current.head) !== canonicalJsonText(expectedHead)
        || canonicalJsonText(current.revision) !== canonicalJsonText(expectedRevision)) {
      throw new SQLiteIntakeError('stale_draft');
    }
  }

  private assertCurrentForm(
    scopeInput: SQLiteIntakeScopeInput,
    formId: string,
    versionId: string,
    definitionVersion: number,
    versionDigestSha256: string
  ): void {
    const head = this.readFormHead(scopeInput, formId);
    const version = this.readFormVersion(scopeInput, versionId);
    if (!head || !version || head.version !== definitionVersion
        || digest(version) !== versionDigestSha256) throw new SQLiteIntakeError('stale_form');
  }

  private insertSubmission(
    plan: Extract<ApplicationMutationPlan, { readonly action: 'submit' }> | ApplicationDirectEntryPlan
  ): void {
    const head = parseSubmissionHead(plan.submission);
    const submitEvidence = plan.action === 'submit'
      ? parseSubmissionSubmitEvidence(plan.submitEvidence)
      : undefined;
    const entryEvidence = plan.action === 'direct_entry'
      ? parseSubmissionDirectEntryEvidence(plan.entryEvidence)
      : undefined;
    const evidence = submitEvidence ?? entryEvidence;
    const participant = parseSubmissionParticipantEvidence(plan.participant);
    const consents = plan.action === 'submit'
      ? plan.consents.map(parseSubmissionConsentEvidence)
      : [];
    if (!evidence || head.id !== evidence.submissionId || head.id !== participant.submissionId
        || head.submitEvidenceId !== evidence.id || head.primaryPersonId !== participant.personId
        || (plan.action === 'submit'
          ? head.source !== 'public_form' || submitEvidence?.draftId !== plan.beforeHead.id
          : head.source !== 'direct_entry')) throw new SQLiteIntakeError('data_corrupt');
    try {
      changedOnce(this.sqlite.query<never, [string, string, string, string, string, string | null, string, string, string, string, number]>(`
        INSERT INTO intake_submission_heads (
          workspace_id, event_id, submission_id, form_id, form_version_id, draft_id,
          submit_evidence_id, person_id, head_json, head_digest_sha256, submitted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        head.scope.workspaceId, head.scope.eventId, head.id, head.formId, head.formVersionId,
        plan.action === 'submit' ? plan.beforeHead.id : null,
        head.submitEvidenceId, head.primaryPersonId,
        canonicalJsonText(head), digest(head), Date.parse(head.submittedAt)
      ), 'id_collision');
      if (submitEvidence !== undefined) {
        this.insertSubmissionEvidence(
          'intake_submission_submit_evidence', head, submitEvidence.id, submitEvidence
        );
      }
      if (entryEvidence !== undefined) {
        changedOnce(this.sqlite.query<never, [string, string, string, string, string, string, string]>(`
          INSERT INTO intake_submission_direct_entry_evidence (
            workspace_id, event_id, submission_id, evidence_id, entered_by_user_id,
            evidence_json, evidence_digest_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          head.scope.workspaceId, head.scope.eventId, head.id, entryEvidence.id,
          entryEvidence.enteredByUserId, canonicalJsonText(entryEvidence), digest(entryEvidence)
        ), 'id_collision');
      }
      changedOnce(this.sqlite.query<never, [string, string, string, string, string, string, string, string]>(`
        INSERT INTO intake_submission_participant_evidence (
          workspace_id, event_id, submission_id, evidence_id, person_id,
          participant_identity_id, evidence_json, evidence_digest_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        head.scope.workspaceId, head.scope.eventId, head.id, participant.id,
        participant.personId, participant.participantIdentityId,
        canonicalJsonText(participant), digest(participant)
      ), 'id_collision');
      for (const consent of consents) {
        changedOnce(this.sqlite.query<never, [string, string, string, string, string, string, string]>(`
          INSERT INTO intake_submission_consent_evidence (
            workspace_id, event_id, submission_id, evidence_id, field_id,
            evidence_json, evidence_digest_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          head.scope.workspaceId, head.scope.eventId, head.id, consent.id,
          consent.fieldId, canonicalJsonText(consent), digest(consent)
        ), 'id_collision');
      }
    } catch (error) {
      if (error instanceof SQLiteIntakeError) throw error;
      throw new SQLiteIntakeError('id_collision');
    }
  }

  private insertSubmissionEvidence(
    table: 'intake_submission_submit_evidence',
    head: SubmissionHeadDto,
    evidenceId: string,
    evidence: SubmissionSubmitEvidenceDto
  ): void {
    changedOnce(this.sqlite.query<never, [string, string, string, string, string, string]>(`
      INSERT INTO ${table} (
        workspace_id, event_id, submission_id, evidence_id, evidence_json, evidence_digest_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      head.scope.workspaceId, head.scope.eventId, head.id, evidenceId,
      canonicalJsonText(evidence), digest(evidence)
    ), 'id_collision');
  }

  readSubmissionHead(scopeInput: SQLiteIntakeScopeInput, submissionId: string): SubmissionHeadDto | undefined {
    const currentScope = scope(scopeInput);
    const row = this.sqlite.query<SubmissionHeadRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, form_id, form_version_id,
             draft_id, submit_evidence_id, person_id, submitted_at_ms,
             head_json AS value_json, head_digest_sha256 AS value_digest
        FROM intake_submission_heads
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const head = parseStored(row, parseSubmissionHead);
    if (head && (row?.workspace_id !== currentScope.workspaceId
        || row.event_id !== currentScope.eventId || row.submission_id !== submissionId
        || head.id !== submissionId || head.scope.workspaceId !== currentScope.workspaceId
        || head.scope.eventId !== currentScope.eventId || head.formId !== row.form_id
        || head.formVersionId !== row.form_version_id
        || head.submitEvidenceId !== row.submit_evidence_id
        || head.primaryPersonId !== row.person_id
        || !exactInstant(head.submittedAt, row.submitted_at_ms))) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return head;
  }

  private readSubmitEvidence(
    currentScope: Scope,
    submissionId: string
  ): SubmissionSubmitEvidenceDto | undefined {
    const row = this.sqlite.query<SubmissionEvidenceRow, [string, string, string]>(`
      SELECT workspace_id, event_id, submission_id, evidence_id,
             evidence_json AS value_json, evidence_digest_sha256 AS value_digest
        FROM intake_submission_submit_evidence
       WHERE workspace_id = ? AND event_id = ? AND submission_id = ? LIMIT 2
    `).get(currentScope.workspaceId, currentScope.eventId, submissionId);
    const evidence = parseStored(row, parseSubmissionSubmitEvidence);
    if (evidence && (!row || row.workspace_id !== currentScope.workspaceId
        || row.event_id !== currentScope.eventId || row.submission_id !== submissionId
        || evidence.id !== row.evidence_id || evidence.submissionId !== row.submission_id)) {
      throw new SQLiteIntakeError('data_corrupt');
    }
    return evidence;
  }
}

export function sqliteIntakePlanDigest(plan: FormMutationPlan | ApplicationMutationPlan): string {
  return 'scope' in plan ? formMutationPlanDigest(plan) : applicationMutationPlanDigest(plan);
}
