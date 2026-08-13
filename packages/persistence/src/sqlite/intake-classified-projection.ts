import type { ClassifiedPayloadProfiles } from '@jooevents/application';
import type { SynchronousClassifiedPayloadStore } from '@jooevents/application/synchronous-classified-payload-store';
import {
  organizerSubmissionAnswerSchema,
  organizerSubmissionDetailSchema,
  organizerSubmissionSummarySchema,
  publicApplicationDraftResumeSchema,
  transientApplicationAnswerInputSchema,
  type ApplicationAnswerIndexEntryDto,
  type FormFieldDefinitionDto,
  type OrganizerSubmissionAnswerDto,
  type OrganizerSubmissionContactDto,
  type OrganizerSubmissionDetailDto,
  type OrganizerSubmissionSummaryDto,
  type PublicApplicationDraftResumeDto
} from '@jooevents/contracts';
import {
  applicationAnswerPayloadScopeBinding,
  compareCanonicalText,
  IntakeValidationError,
  parseFormVersion,
  parseSubmissionConsentEvidence,
  parseSubmissionHead,
  parseSubmissionParticipantEvidence,
  parseSubmissionSubmitEvidence,
  projectOrganizerSubmissionContact,
  projectPublicApplicationDraftStatus,
  sameIntakeScope,
  type ApplicationAnswerPayloadReferenceVerificationInput,
  type ApplicationAnswerPayloadReferenceVerifier
} from '@jooevents/intake';
import { canonicalJsonText, createPayloadRef, parsePayloadRefId } from '@jooevents/kernel';
import {
  type SQLiteIntakeSubmissionProjectionPort
} from './intake';
import { authenticateIntakeProjection } from './intake-projection-auth';

const decoder = new TextDecoder('utf-8', { fatal: true });

type GovernedAnswer = Extract<ApplicationAnswerIndexEntryDto, { readonly value: unknown }>;
type GovernedAnswerKind = GovernedAnswer['kind'];

function decode(bytes: Uint8Array): string {
  try {
    const value = decoder.decode(bytes);
    if (value.normalize('NFC') !== value || value.includes('\0')) throw new TypeError();
    return value;
  } catch {
    throw new TypeError('intake_classified_projection_corrupt');
  } finally {
    bytes.fill(0);
  }
}

function parseResolvedAnswers(
  answers: readonly OrganizerSubmissionAnswerDto[]
): OrganizerSubmissionAnswerDto[] {
  const parsed = answers.map((answer) => organizerSubmissionAnswerSchema.parse(answer));
  parsed.sort((left, right) => compareCanonicalText(left.fieldId, right.fieldId));
  if (parsed.some((answer, index) => index > 0 && parsed[index - 1]!.fieldId === answer.fieldId)) {
    throw new IntakeValidationError('invalid_submission_evidence');
  }
  return parsed;
}

function answerMatchesVersion(
  answer: OrganizerSubmissionAnswerDto,
  version: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['version']
): boolean {
  const field = version.definition.fields.find((candidate) => candidate.id === answer.fieldId);
  if (!field || field.kind !== answer.kind || field.label !== answer.fieldLabel) return false;
  if (answer.kind === 'select' && field.kind === 'select' && field.options.kind === 'custom') {
    return field.options.choices.find((choice) => choice.id === answer.choice.id)?.label
      === answer.choice.label;
  }
  if (answer.kind === 'multiselect'
      && field.kind === 'multiselect' && field.options.kind === 'custom') {
    const choices = new Map(field.options.choices.map((choice) => [choice.id, choice.label]));
    return answer.choices.every((choice) => choices.get(choice.id) === choice.label);
  }
  return true;
}

function resolvedAnswerMatches(
  durable: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['submitEvidence']['answers'][number] | undefined,
  resolved: OrganizerSubmissionAnswerDto
): boolean {
  if (!durable) return false;
  if ('value' in durable) return durable.kind === resolved.kind && 'value' in resolved;
  if (resolved.kind === 'select') {
    return durable.kind === 'select' && durable.choiceId === resolved.choice.id;
  }
  if (resolved.kind === 'multiselect') {
    return durable.kind === 'multiselect'
      && durable.choiceIds.length === resolved.choices.length
      && durable.choiceIds.every((id, index) => id === resolved.choices[index]?.id);
  }
  return durable.kind === 'checkbox' && resolved.kind === 'checkbox'
    && durable.checked === resolved.checked;
}

function projectVerifiedSummary(input:
  Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0] & {
    readonly resolvedAnswers: readonly OrganizerSubmissionAnswerDto[];
  }): OrganizerSubmissionSummaryDto {
  const head = parseSubmissionHead(input.head);
  const version = parseFormVersion(input.version);
  const evidence = parseSubmissionSubmitEvidence(input.submitEvidence);
  const answers = parseResolvedAnswers(input.resolvedAnswers);
  if (version.id !== head.formVersionId || version.formId !== head.formId
      || !sameIntakeScope(version.scope, head.scope)
      || evidence.id !== head.submitEvidenceId || evidence.submissionId !== head.id
      || evidence.formVersionId !== head.formVersionId || evidence.submittedAt !== head.submittedAt) {
    throw new IntakeValidationError('invalid_form_version');
  }
  const titleField = version.definition.fields.find((field) => field.mapsTo === 'talk.title');
  const nameField = version.definition.fields.find((field) => field.mapsTo === 'person.name');
  if (titleField && titleField.kind !== 'text') throw new IntakeValidationError('invalid_form_version');
  if (nameField && nameField.kind !== 'text') throw new IntakeValidationError('invalid_form_version');
  const permittedIds = new Set([
    ...(titleField ? [titleField.id] : []), ...(nameField ? [nameField.id] : [])
  ]);
  const durableByField = new Map(evidence.answers.map((answer) => [answer.fieldId, answer]));
  const title = titleField ? answers.find((answer) => answer.fieldId === titleField.id) : undefined;
  const name = nameField ? answers.find((answer) => answer.fieldId === nameField.id) : undefined;
  const durableTitle = titleField ? durableByField.get(titleField.id) : undefined;
  const durableName = nameField ? durableByField.get(nameField.id) : undefined;
  if (answers.some((answer) => !permittedIds.has(answer.fieldId) || !answerMatchesVersion(answer, version))
      || ((durableTitle !== undefined) !== (title !== undefined))
      || (title !== undefined && (title.kind !== 'text'
        || !resolvedAnswerMatches(durableTitle, title)))
      || ((durableName !== undefined) !== (name !== undefined))
      || (name !== undefined && (name.kind !== 'text' || !resolvedAnswerMatches(durableName, name)))) {
    throw new IntakeValidationError('invalid_submission_evidence');
  }
  return organizerSubmissionSummarySchema.parse({
    schemaVersion: 1, id: head.id, formId: head.formId, formVersionId: head.formVersionId,
    target: version.definition.target, title: title?.kind === 'text' ? title.value : null,
    primaryParticipantName: name?.kind === 'text' && name.value.length > 0 ? name.value : null,
    submittedAt: head.submittedAt
  });
}

function projectVerifiedDetail(input:
  Parameters<SQLiteIntakeSubmissionProjectionPort['projectDetail']>[0] & {
    readonly resolvedAnswers: readonly OrganizerSubmissionAnswerDto[];
  }): OrganizerSubmissionDetailDto {
  const head = parseSubmissionHead(input.head);
  const version = parseFormVersion(input.version);
  const evidence = parseSubmissionSubmitEvidence(input.submitEvidence);
  const participants = input.participants.map(parseSubmissionParticipantEvidence);
  const consents = input.consents.map(parseSubmissionConsentEvidence);
  const answers = parseResolvedAnswers(input.resolvedAnswers);
  const durable = evidence.answers.filter((answer) => answer.kind !== 'email');
  const durableByField = new Map(durable.map((answer) => [answer.fieldId, answer]));
  const durableIds = durable.map((answer) => answer.fieldId).sort(compareCanonicalText);
  const resolvedIds = answers.map((answer) => answer.fieldId).sort(compareCanonicalText);
  if (head.submitEvidenceId !== evidence.id || head.id !== evidence.submissionId
      || head.formVersionId !== evidence.formVersionId || version.id !== head.formVersionId
      || version.formId !== head.formId || !sameIntakeScope(version.scope, head.scope)
      || participants.length !== 1 || participants[0]!.submissionId !== head.id
      || participants[0]!.personId !== head.primaryPersonId
      || durableIds.length !== resolvedIds.length
      || durableIds.some((id, index) => id !== resolvedIds[index])
      || answers.some((answer) => !answerMatchesVersion(answer, version)
        || !resolvedAnswerMatches(durableByField.get(answer.fieldId), answer))
      || consents.some((consent) => consent.submissionId !== head.id
        || consent.formVersionId !== head.formVersionId)) {
    throw new IntakeValidationError('invalid_submission_evidence');
  }
  return organizerSubmissionDetailSchema.parse({
    schemaVersion: 1, submissionId: head.id, formId: head.formId,
    formVersionId: head.formVersionId, submittedAt: head.submittedAt,
    participantCount: 1, answers,
    affirmedConsentFieldIds: consents.filter((consent) => consent.affirmed)
      .map((consent) => consent.fieldId).sort(compareCanonicalText)
  });
}

export interface SQLiteIntakeClassifiedProjectionOptions {
  readonly store: SynchronousClassifiedPayloadStore;
  readonly profiles: ClassifiedPayloadProfiles;
}

/** Same-store descriptor verifier and least-disclosure Intake projection. */
export class SQLiteIntakeClassifiedProjection
implements SQLiteIntakeSubmissionProjectionPort, ApplicationAnswerPayloadReferenceVerifier {
  readonly #store: SynchronousClassifiedPayloadStore;
  readonly #profiles: ClassifiedPayloadProfiles;

  constructor(options: SQLiteIntakeClassifiedProjectionOptions) {
    if (!options.store || typeof options.store.read !== 'function'
        || typeof options.store.put !== 'function') {
      throw new TypeError('intake_classified_store_invalid');
    }
    this.#store = options.store;
    this.#profiles = Object.freeze({ ...options.profiles });
    authenticateIntakeProjection(this);
  }

  verifyApplicationAnswerPayload(
    expected: ApplicationAnswerPayloadReferenceVerificationInput
  ): boolean {
    try {
      if (expected.field.kind !== expected.answer.kind) return false;
      const value = this.#decodeGoverned(expected.answer, expected.field, this.#read({
        kind: expected.answer.kind,
        fieldId: expected.answer.fieldId,
        payloadRefId: expected.answer.value.payloadRef.id,
        scopeBinding: applicationAnswerPayloadScopeBinding({
          scope: expected.scope,
          formVersionId: expected.formVersionId,
          owner: {
            draftId: expected.draftId,
            revisionId: expected.revisionId,
            authorityPartitionDigestSha256: expected.authorityPartitionDigestSha256
          },
          fieldId: expected.answer.fieldId,
          kind: expected.answer.kind
        })
      }));
      return typeof value === 'number' || value.length > 0;
    } catch {
      return false;
    }
  }

  projectSummary(
    input: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]
  ): OrganizerSubmissionSummaryDto {
    const resolvedAnswers = this.#resolveSafeAnswers({ ...input, mode: 'summary' });
    return projectVerifiedSummary({ ...input, resolvedAnswers });
  }

  projectDetail(
    input: Parameters<SQLiteIntakeSubmissionProjectionPort['projectDetail']>[0]
  ): OrganizerSubmissionDetailDto {
    const resolvedAnswers = this.#resolveSafeAnswers({ ...input, mode: 'detail' });
    return projectVerifiedDetail({ ...input, resolvedAnswers });
  }

  #resolveSafeAnswers(input: {
    readonly head: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['head'];
    readonly submitEvidence: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['submitEvidence'];
    readonly version: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['version'];
    readonly draftHead: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['draftHead'];
    readonly sourceRevision: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['sourceRevision'];
    readonly mode: 'summary' | 'detail';
  }): readonly OrganizerSubmissionAnswerDto[] {
    this.#assertSource(input);
    const summaryFieldIds = input.mode === 'summary'
      ? new Set(input.version.definition.fields.filter((field) =>
          field.mapsTo === 'talk.title' || field.mapsTo === 'person.name'
        ).map((field) => field.id))
      : undefined;
    const answers = Object.freeze(input.submitEvidence.answers.flatMap((answer) => {
      if (answer.kind === 'email'
          || (summaryFieldIds && !summaryFieldIds.has(answer.fieldId))) return [];
      const field = input.version.definition.fields.find((candidate) =>
        candidate.id === answer.fieldId
      );
      if (!field || field.kind !== answer.kind) {
        throw new TypeError('intake_classified_projection_corrupt');
      }
      const identifiedField = { fieldId: field.id, fieldLabel: field.label };
      if ('value' in answer) {
        const value = this.#readGoverned(
          answer, field, input.version, input.draftHead, input.sourceRevision.id
        );
        return [organizerSubmissionAnswerSchema.parse({
          kind: answer.kind,
          ...identifiedField,
          value
        })];
      }
      if (answer.kind === 'select') {
        if (field.kind !== 'select') throw new TypeError('intake_classified_projection_corrupt');
        const choice = this.#resolveChoice(input, field, answer.choiceId);
        return [organizerSubmissionAnswerSchema.parse({
          kind: answer.kind,
          ...identifiedField,
          choice
        })];
      }
      if (answer.kind === 'multiselect') {
        if (field.kind !== 'multiselect') {
          throw new TypeError('intake_classified_projection_corrupt');
        }
        const choices = answer.choiceIds.map((choiceId) =>
          this.#resolveChoice(input, field, choiceId)
        );
        return [organizerSubmissionAnswerSchema.parse({
          kind: answer.kind,
          ...identifiedField,
          choices
        })];
      }
      return [organizerSubmissionAnswerSchema.parse({
        kind: answer.kind,
        ...identifiedField,
        checked: answer.checked
      })];
    }));
    return answers;
  }

  resolveContact(
    input: Parameters<SQLiteIntakeSubmissionProjectionPort['resolveContact']>[0]
  ): OrganizerSubmissionContactDto {
    this.#assertSource(input);
    if (input.participant.submissionId !== input.head.id
        || input.participant.personId !== input.head.primaryPersonId) {
      throw new TypeError('intake_contact_attribution_mismatch');
    }
    const emailFields = input.version.definition.fields.filter((field) =>
      field.kind === 'email' && field.mapsTo === 'person.email'
    );
    if (emailFields.length !== 1) throw new TypeError('intake_contact_field_invalid');
    const field = emailFields[0]!;
    const answer = input.submitEvidence.answers.find((candidate) =>
      candidate.fieldId === field.id
    );
    if (!answer || answer.kind !== 'email') throw new TypeError('intake_contact_missing');
    const email = this.#readGoverned(
      answer, field, input.version, input.draftHead, input.sourceRevision.id
    );
    if (typeof email !== 'string') throw new TypeError('intake_contact_field_invalid');
    return projectOrganizerSubmissionContact({
      submissionId: input.head.id,
      personId: input.participant.personId,
      participantIdentityId: input.participant.participantIdentityId,
      sourceFieldId: field.id,
      email
    });
  }

  resolveDraftResume(
    input: Parameters<SQLiteIntakeSubmissionProjectionPort['resolveDraftResume']>[0]
  ): PublicApplicationDraftResumeDto {
    if (input.head.formVersionId !== input.version.id
        || input.revision.id !== input.head.currentRevisionId
        || input.revision.draftId !== input.head.id) {
      throw new TypeError('intake_resume_binding_mismatch');
    }
    const answers = input.revision.answers.map((answer) => {
      if ('value' in answer) {
        const field = input.version.definition.fields.find((candidate) =>
          candidate.id === answer.fieldId
        );
        if (!field || field.kind !== answer.kind) {
          throw new TypeError('intake_classified_projection_corrupt');
        }
        return transientApplicationAnswerInputSchema.parse({
          kind: answer.kind,
          fieldId: answer.fieldId,
          value: this.#readGoverned(answer, field, input.version, input.head, input.revision.id)
        });
      }
      return transientApplicationAnswerInputSchema.parse(answer);
    });
    return publicApplicationDraftResumeSchema.parse({
      schemaVersion: 1,
      draft: projectPublicApplicationDraftStatus(input.head, input.revision),
      answers
    });
  }

  #assertSource(input: {
    readonly head: { readonly id: string; readonly formId: string; readonly formVersionId: string };
    readonly submitEvidence: { readonly submissionId: string; readonly draftId: string;
      readonly draftRevisionId: string; readonly formVersionId: string;
      readonly answers: readonly ApplicationAnswerIndexEntryDto[] };
    readonly version: { readonly id: string; readonly formId: string };
    readonly draftHead: { readonly id: string; readonly formId: string;
      readonly formVersionId: string; readonly authorityPartitionDigestSha256: string };
    readonly sourceRevision: { readonly id: string; readonly draftId: string;
      readonly answers: readonly ApplicationAnswerIndexEntryDto[] };
  }): void {
    if (input.submitEvidence.submissionId !== input.head.id
        || input.submitEvidence.draftId !== input.draftHead.id
        || input.submitEvidence.draftRevisionId !== input.sourceRevision.id
        || input.submitEvidence.formVersionId !== input.version.id
        || input.head.formId !== input.version.formId
        || input.head.formVersionId !== input.version.id
        || input.draftHead.formId !== input.version.formId
        || input.draftHead.formVersionId !== input.version.id
        || input.sourceRevision.draftId !== input.draftHead.id
        || canonicalJsonText(input.submitEvidence.answers)
          !== canonicalJsonText(input.sourceRevision.answers)) {
      throw new TypeError('intake_projection_source_mismatch');
    }
  }

  #resolveChoice(
    input: {
      readonly submitEvidence: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['submitEvidence'];
    },
    field: Extract<FormFieldDefinitionDto, { readonly kind: 'select' | 'multiselect' }>,
    choiceId: string
  ): { readonly id: string; readonly label: string } {
    if (field.options.kind === 'custom') {
      const choice = field.options.choices.find((candidate) => candidate.id === choiceId);
      if (!choice) throw new TypeError('intake_classified_projection_corrupt');
      return { id: choice.id, label: choice.label };
    }
    const source = field.options.source;
    const pins = input.submitEvidence.programVocabularyAnswerPins.filter((pin) =>
      pin.fieldId === field.id && pin.itemId === choiceId && pin.source === source
    );
    if (pins.length !== 1) throw new TypeError('intake_classified_projection_corrupt');
    return { id: pins[0]!.itemId, label: pins[0]!.label };
  }

  #readGoverned(
    answer: GovernedAnswer,
    field: FormFieldDefinitionDto,
    version: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['version'],
    draft: Parameters<SQLiteIntakeSubmissionProjectionPort['projectSummary']>[0]['draftHead'],
    revisionId: string
  ): string | number {
    if (field.kind !== answer.kind) throw new TypeError('intake_classified_projection_corrupt');
    return this.#decodeGoverned(answer, field, this.#read({
      kind: answer.kind,
      fieldId: answer.fieldId,
      payloadRefId: answer.value.payloadRef.id,
      scopeBinding: applicationAnswerPayloadScopeBinding({
        scope: version.scope,
        formVersionId: version.id,
        owner: {
          draftId: draft.id,
          revisionId,
          authorityPartitionDigestSha256: draft.authorityPartitionDigestSha256
        },
        fieldId: answer.fieldId,
        kind: answer.kind
      })
    }));
  }

  #decodeGoverned(
    answer: GovernedAnswer,
    field: FormFieldDefinitionDto,
    bytes: Uint8Array
  ): string | number {
    const text = decode(bytes);
    const rawValue: unknown = answer.kind === 'number' ? JSON.parse(text) : text;
    const parsed = transientApplicationAnswerInputSchema.parse({
      kind: answer.kind, fieldId: answer.fieldId, value: rawValue
    });
    if (!('value' in parsed) || parsed.kind !== field.kind) {
      throw new TypeError('intake_classified_projection_corrupt');
    }
    if ('maximumLength' in field && typeof parsed.value === 'string'
        && parsed.value.length > field.maximumLength) {
      throw new TypeError('intake_classified_projection_corrupt');
    }
    if (field.kind === 'number') {
      if (typeof parsed.value !== 'number'
          || (field.minimum !== null && parsed.value < field.minimum)
          || (field.maximum !== null && parsed.value > field.maximum)
          || (field.integerOnly && !Number.isInteger(parsed.value))) {
        throw new TypeError('intake_classified_projection_corrupt');
      }
    }
    return parsed.value;
  }

  #read(input: {
    readonly kind: GovernedAnswerKind;
    readonly fieldId: string;
    readonly payloadRefId: string;
    readonly scopeBinding: string;
  }): Uint8Array {
    return this.#store.read({
      payloadRef: createPayloadRef(parsePayloadRefId(input.payloadRefId)),
      expectedBinding: {
      profiles: this.#profiles,
      scopeBinding: input.scopeBinding,
      contentType: input.kind === 'number' ? 'application/json' : 'text/plain'
      },
      purpose: 'intake.application_answer'
    });
  }
}
