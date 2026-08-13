import { createHash } from 'node:crypto';
import type { ClassifiedPayloadProfiles } from '@jooevents/application';
import {
  openSynchronousClassifiedPayloadAdoptionReceipt,
  type SynchronousClassifiedPayloadAdoptionReceipt,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  applicationAnswerIndexSchema,
  intakeDigestSchema,
  intakeIdSchema,
  intakeScopeSchema,
  transientApplicationAnswersInputSchema,
  type ApplicationAnswerIndexDto,
  type ApplicationAnswerIndexEntryDto,
  type FieldRegistryOptionSource,
  type FormFieldDefinitionDto,
  type FormVersionDto,
  type GovernedAnswerPayloadDto,
  type SubmissionProgramVocabularyAnswerPinDto,
  type TransientApplicationAnswerInput,
  type TransientApplicationAnswersInput
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { compareCanonicalText, deepFreeze, parseFormVersion } from './model';

export type ApplicationAnswerValidationMode = 'draft' | 'submit' | 'direct_entry';

export interface ApplicationAnswerOwner {
  readonly draftId: string;
  readonly revisionId: string;
  readonly authorityPartitionDigestSha256: string;
}

export interface ApplicationAnswerLiveOption {
  readonly id: string;
  readonly label: string;
  readonly version: number;
  readonly status: 'active' | 'retired';
}

export interface ApplicationAnswerOptionSource {
  readLiveOptions(
    scope: FormVersionDto['scope'],
    source: FieldRegistryOptionSource
  ): readonly ApplicationAnswerLiveOption[];
}

type GovernedAnswerKind = Extract<
  ApplicationAnswerIndexEntryDto['kind'],
  'text' | 'textarea' | 'email' | 'url' | 'phone' | 'number' | 'date' | 'datetime'
>;

export interface PreparedApplicationAnswerPayload {
  readonly fieldId: string;
  readonly kind: GovernedAnswerKind;
  readonly bytes: Uint8Array;
  readonly binding: {
    readonly profileKey: 'intake.application_answer';
    readonly scopeBinding: string;
    readonly contentType: 'text/plain' | 'application/json';
  };
}

export interface PreparedApplicationAnswers {
  readonly owner: ApplicationAnswerOwner;
  readonly formVersionId: string;
  readonly mode: ApplicationAnswerValidationMode;
  readonly requestDigestSha256: string;
  readonly payloads: readonly PreparedApplicationAnswerPayload[];
  readonly structuralEntries: readonly Extract<
    ApplicationAnswerIndexEntryDto,
    { readonly kind: 'select' | 'multiselect' | 'checkbox' }
  >[];
  readonly answeredFieldIds: readonly string[];
}

interface PreparedAnswersRecord {
  readonly ownerDigestSha256: string;
}

const issuedPreparedAnswers = new WeakMap<object, PreparedAnswersRecord>();

export type ApplicationAnswerErrorCode =
  | 'unknown_field'
  | 'answer_type_mismatch'
  | 'answer_too_long'
  | 'number_out_of_range'
  | 'integer_required'
  | 'unknown_choice'
  | 'too_many_choices'
  | 'hidden_field_answered'
  | 'required_answer_missing'
  | 'required_consent_not_affirmed'
  | 'consent_not_enterable'
  | 'invalid_payload_adoption'
  | 'invalid_answer_index';

export class ApplicationAnswerError extends Error {
  constructor(readonly code: ApplicationAnswerErrorCode, readonly fieldId?: string) {
    super(code);
    this.name = 'ApplicationAnswerError';
  }
}

export function prepareApplicationAnswers(input: {
  readonly answers: TransientApplicationAnswersInput;
  readonly formVersion: FormVersionDto;
  readonly optionSource: ApplicationAnswerOptionSource;
  readonly mode: ApplicationAnswerValidationMode;
  readonly owner: ApplicationAnswerOwner;
}): PreparedApplicationAnswers {
  const version = parseFormVersion(input.formVersion);
  const owner = deepFreeze({
    draftId: intakeIdSchema.parse(input.owner.draftId),
    revisionId: intakeIdSchema.parse(input.owner.revisionId),
    authorityPartitionDigestSha256: intakeDigestSchema.parse(
      input.owner.authorityPartitionDigestSha256
    )
  });
  const ownerDigestSha256 = sha256({
    schemaVersion: 1,
    scope: version.scope,
    formVersionId: version.id,
    owner
  });
  const answers = transientApplicationAnswersInputSchema.parse(input.answers).filter(hasValue);
  const answerByField = new Map(answers.map((answer) => [answer.fieldId, answer]));
  const fieldById = new Map(version.definition.fields.map((field) => [field.id, field]));
  for (const answer of answers) {
    const field = fieldById.get(answer.fieldId);
    if (!field) throw new ApplicationAnswerError('unknown_field', answer.fieldId);
    validateAnswerShape(version, field, answer, input.optionSource);
  }
  validateEffectiveState(version, answerByField, answers, input.mode);

  const encoder = new TextEncoder();
  const payloads: PreparedApplicationAnswerPayload[] = [];
  const structuralEntries: PreparedApplicationAnswers['structuralEntries'][number][] = [];
  for (const answer of answers) {
    if (isGovernedTransientAnswer(answer)) {
      const contentType = answer.kind === 'number' ? 'application/json' as const : 'text/plain' as const;
      const encoded = answer.kind === 'number' ? encodeCanonicalJson(answer.value) : encoder.encode(answer.value);
      payloads.push(deepFreeze({
        fieldId: answer.fieldId,
        kind: answer.kind,
        bytes: Uint8Array.from(encoded),
        binding: {
          profileKey: 'intake.application_answer',
          scopeBinding: applicationAnswerPayloadScopeBinding({
            scope: version.scope,
            formVersionId: version.id,
            owner,
            fieldId: answer.fieldId,
            kind: answer.kind
          }),
          contentType
        }
      }));
    } else if (answer.kind === 'select') {
      structuralEntries.push(deepFreeze({
        kind: 'select', fieldId: answer.fieldId, choiceId: answer.choiceId
      }));
    } else if (answer.kind === 'multiselect') {
      structuralEntries.push(deepFreeze({
        kind: 'multiselect', fieldId: answer.fieldId,
        choiceIds: [...answer.choiceIds].sort(compareCanonicalText)
      }));
    } else {
      structuralEntries.push(deepFreeze({
        kind: 'checkbox', fieldId: answer.fieldId, checked: answer.checked
      }));
    }
  }
  payloads.sort((left, right) => compareCanonicalText(left.fieldId, right.fieldId));
  structuralEntries.sort((left, right) => compareCanonicalText(left.fieldId, right.fieldId));
  const prepared = deepFreeze({
    owner,
    formVersionId: version.id,
    mode: input.mode,
    requestDigestSha256: sha256(answers),
    payloads,
    structuralEntries,
    answeredFieldIds: answers.map((answer) => answer.fieldId).sort(compareCanonicalText)
  });
  issuedPreparedAnswers.set(prepared, { ownerDigestSha256 });
  return prepared;
}

export function finalizeGovernedAnswerIndex(input: {
  readonly prepared: PreparedApplicationAnswers;
  readonly adoptions: readonly SynchronousClassifiedPayloadAdoptionReceipt[];
  readonly expectedStore: SynchronousClassifiedPayloadStore;
  readonly expectedProfiles: ClassifiedPayloadProfiles;
}): ApplicationAnswerIndexDto {
  if (!issuedPreparedAnswers.has(input.prepared)
      || input.adoptions.length !== input.prepared.payloads.length) {
    throw new ApplicationAnswerError('invalid_payload_adoption');
  }
  const adoptionByField = new Map<string, string>();
  for (const [index, receipt] of input.adoptions.entries()) {
    const payload = input.prepared.payloads[index];
    if (!payload) throw new ApplicationAnswerError('invalid_payload_adoption');
    let opened;
    try {
      opened = openSynchronousClassifiedPayloadAdoptionReceipt({
        receipt,
        expectedStore: input.expectedStore,
        expected: {
          binding: {
            profiles: input.expectedProfiles,
            scopeBinding: payload.binding.scopeBinding,
            contentType: payload.binding.contentType
          },
          purpose: payload.binding.profileKey,
          bytes: payload.bytes
        }
      });
    } catch {
      throw new ApplicationAnswerError('invalid_payload_adoption');
    }
    if (adoptionByField.has(payload.fieldId)) {
      throw new ApplicationAnswerError('invalid_payload_adoption', payload.fieldId);
    }
    adoptionByField.set(payload.fieldId, opened.payloadRef.id);
  }
  if (adoptionByField.size !== input.prepared.payloads.length) {
    throw new ApplicationAnswerError('invalid_payload_adoption');
  }
  const entries: ApplicationAnswerIndexEntryDto[] = [...input.prepared.structuralEntries];
  for (const payload of input.prepared.payloads) {
    const adoption = adoptionByField.get(payload.fieldId);
    if (!adoption) throw new ApplicationAnswerError('invalid_payload_adoption', payload.fieldId);
    const value: GovernedAnswerPayloadDto = { payloadRef: { id: intakeIdSchema.parse(adoption) } };
    entries.push({ kind: payload.kind, fieldId: payload.fieldId, value });
  }
  entries.sort((left, right) => compareCanonicalText(left.fieldId, right.fieldId));
  const parsed = applicationAnswerIndexSchema.safeParse(entries);
  if (!parsed.success) throw new ApplicationAnswerError('invalid_answer_index');
  return deepFreeze(parsed.data);
}

export function validateGovernedAnswerIndex(input: {
  readonly answers: ApplicationAnswerIndexDto;
  readonly formVersion: FormVersionDto;
  readonly optionSource: ApplicationAnswerOptionSource;
  readonly mode: ApplicationAnswerValidationMode;
}): void {
  const version = parseFormVersion(input.formVersion);
  const parsed = applicationAnswerIndexSchema.safeParse(input.answers);
  if (!parsed.success) throw new ApplicationAnswerError('invalid_answer_index');
  const fieldById = new Map(version.definition.fields.map((field) => [field.id, field]));
  for (const answer of parsed.data) {
    const field = fieldById.get(answer.fieldId);
    if (!field) throw new ApplicationAnswerError('unknown_field', answer.fieldId);
    validateGovernedAnswerShape(version, field, answer, input.optionSource);
  }
  const structural = new Map<string, TransientApplicationAnswerInput>();
  for (const answer of parsed.data) {
    if (answer.kind === 'select' || answer.kind === 'multiselect' || answer.kind === 'checkbox') {
      structural.set(answer.fieldId, answer);
    }
  }
  validateEffectiveState(version, structural, parsed.data, input.mode);
}

/** Resolves exact active item evidence at submit time, after current validation succeeds. */
export function pinProgramVocabularyAnswers(input: {
  readonly answers: ApplicationAnswerIndexDto;
  readonly formVersion: FormVersionDto;
  readonly optionSource: ApplicationAnswerOptionSource;
  readonly mode?: Extract<ApplicationAnswerValidationMode, 'submit' | 'direct_entry'>;
}): readonly SubmissionProgramVocabularyAnswerPinDto[] {
  const version = parseFormVersion(input.formVersion);
  validateGovernedAnswerIndex({
    answers: input.answers,
    formVersion: input.formVersion,
    optionSource: input.optionSource,
    mode: input.mode ?? 'submit'
  });
  const fields = new Map(version.definition.fields.map((field) => [field.id, field]));
  const pins: SubmissionProgramVocabularyAnswerPinDto[] = [];
  for (const answer of input.answers) {
    if (answer.kind !== 'select' && answer.kind !== 'multiselect') continue;
    const field = fields.get(answer.fieldId);
    if (!field || (field.kind !== 'select' && field.kind !== 'multiselect')
        || field.options.kind !== 'program_vocabulary') continue;
    const current = new Map(allowedVocabularyOptions(version, field, input.optionSource)
      .map((option) => [option.id, option]));
    const choiceIds = answer.kind === 'select' ? [answer.choiceId] : answer.choiceIds;
    for (const itemId of choiceIds) {
      const item = current.get(itemId);
      if (!item) throw new ApplicationAnswerError('unknown_choice', field.id);
      pins.push({
        fieldId: field.id,
        source: field.options.source,
        itemId: item.id,
        itemVersion: item.version,
        label: item.label
      });
    }
  }
  pins.sort((left, right) => compareCanonicalText(
    `${left.fieldId}:${left.itemId}`, `${right.fieldId}:${right.itemId}`
  ));
  return deepFreeze(pins);
}

export function answerIndexDigest(answers: ApplicationAnswerIndexDto): string {
  return sha256(applicationAnswerIndexSchema.parse(answers));
}

export function applicationAnswerPayloadScopeBinding(input: {
  readonly scope: FormVersionDto['scope'];
  readonly formVersionId: string;
  readonly owner: ApplicationAnswerOwner;
  readonly fieldId: string;
  readonly kind: GovernedAnswerKind;
}): string {
  const scope = intakeScopeSchema.parse(input.scope);
  const formVersionId = intakeIdSchema.parse(input.formVersionId);
  const fieldId = intakeIdSchema.parse(input.fieldId);
  const kind = input.kind;
  const owner = {
    draftId: intakeIdSchema.parse(input.owner.draftId),
    revisionId: intakeIdSchema.parse(input.owner.revisionId),
    authorityPartitionDigestSha256: intakeDigestSchema.parse(
      input.owner.authorityPartitionDigestSha256
    )
  };
  const ownerDigestSha256 = sha256({ schemaVersion: 1, scope, formVersionId, owner });
  return `intake.application_answer:${sha256({ ownerDigestSha256, fieldId, kind })}`;
}

function validateEffectiveState(
  version: FormVersionDto,
  answerByField: ReadonlyMap<string, TransientApplicationAnswerInput>,
  answers: readonly { readonly fieldId: string; readonly kind: string; readonly checked?: boolean }[],
  mode: ApplicationAnswerValidationMode
): void {
  const effective = evaluateEffectiveFormState(version, answerByField);
  for (const answer of answers) {
    if (!effective.visible.has(answer.fieldId)) {
      throw new ApplicationAnswerError('hidden_field_answered', answer.fieldId);
    }
  }
  if (mode === 'direct_entry') {
    // An organizer transcribes on behalf of the speaker: form requiredness is
    // not enforced, and a consent affirmation can never be entered for them.
    const fields = new Map(version.definition.fields.map((field) => [field.id, field]));
    for (const answer of answers) {
      if (fields.get(answer.fieldId)?.purpose.kind === 'consent') {
        throw new ApplicationAnswerError('consent_not_enterable', answer.fieldId);
      }
    }
    return;
  }
  if (mode !== 'submit') return;
  const byField = new Map(answers.map((answer) => [answer.fieldId, answer]));
  const fields = new Map(version.definition.fields.map((field) => [field.id, field]));
  for (const fieldId of effective.required) {
    const answer = byField.get(fieldId);
    if (!answer) throw new ApplicationAnswerError('required_answer_missing', fieldId);
    const field = fields.get(fieldId);
    if (field?.purpose.kind === 'consent'
        && (answer.kind !== 'checkbox' || answer.checked !== true)) {
      throw new ApplicationAnswerError('required_consent_not_affirmed', fieldId);
    }
  }
}

function evaluateEffectiveFormState(
  version: FormVersionDto,
  answers: ReadonlyMap<string, TransientApplicationAnswerInput>
): { readonly visible: ReadonlySet<string>; readonly required: ReadonlySet<string> } {
  const visible = new Set(version.definition.fields
    .filter((field) => field.initiallyVisible)
    .map((field) => field.id));
  const required = new Set(version.definition.fields
    .filter((field) => field.initiallyVisible && field.required)
    .map((field) => field.id));
  for (const rule of version.definition.rules) {
    const condition = rule.condition;
    const source = answers.get(condition.sourceFieldId);
    const matches = condition.kind === 'selected_any'
      ? !!source && (
          (source.kind === 'select' && condition.choiceIds.includes(source.choiceId))
          || (source.kind === 'multiselect'
            && source.choiceIds.some((choiceId) => condition.choiceIds.includes(choiceId)))
        )
      : !!source && source.kind === 'checkbox' && source.checked === condition.value;
    if (!matches) continue;
    for (const targetId of rule.effect.targetFieldIds) {
      if (rule.effect.kind === 'show') visible.add(targetId);
      if (rule.effect.kind === 'hide') {
        visible.delete(targetId);
        required.delete(targetId);
      }
      if (rule.effect.kind === 'require') {
        visible.add(targetId);
        required.add(targetId);
      }
    }
  }
  return deepFreeze({ visible, required });
}

function validateAnswerShape(
  version: FormVersionDto,
  field: FormFieldDefinitionDto,
  answer: TransientApplicationAnswerInput,
  optionSource: ApplicationAnswerOptionSource
): void {
  if (field.kind !== answer.kind) throw new ApplicationAnswerError('answer_type_mismatch', field.id);
  if (answer.kind === 'text' || answer.kind === 'textarea' || answer.kind === 'email'
      || answer.kind === 'url' || answer.kind === 'phone') {
    if (field.kind !== answer.kind) throw new ApplicationAnswerError('answer_type_mismatch', field.id);
    if (answer.value.length > field.maximumLength) {
      throw new ApplicationAnswerError('answer_too_long', field.id);
    }
    return;
  }
  if (answer.kind === 'number') {
    if (field.kind !== 'number') throw new ApplicationAnswerError('answer_type_mismatch', field.id);
    if ((field.minimum !== null && answer.value < field.minimum)
        || (field.maximum !== null && answer.value > field.maximum)) {
      throw new ApplicationAnswerError('number_out_of_range', field.id);
    }
    if (field.integerOnly && !Number.isInteger(answer.value)) {
      throw new ApplicationAnswerError('integer_required', field.id);
    }
    return;
  }
  if (answer.kind === 'select') {
    if (field.kind !== 'select') throw new ApplicationAnswerError('answer_type_mismatch', field.id);
    if (!allowedChoiceIds(version, field, optionSource).has(answer.choiceId)) {
      throw new ApplicationAnswerError('unknown_choice', field.id);
    }
    return;
  }
  if (answer.kind === 'multiselect') {
    if (field.kind !== 'multiselect') throw new ApplicationAnswerError('answer_type_mismatch', field.id);
    if (answer.choiceIds.length > field.maximumSelections) {
      throw new ApplicationAnswerError('too_many_choices', field.id);
    }
    const allowed = allowedChoiceIds(version, field, optionSource);
    if (answer.choiceIds.some((choiceId) => !allowed.has(choiceId))) {
      throw new ApplicationAnswerError('unknown_choice', field.id);
    }
  }
}

function validateGovernedAnswerShape(
  version: FormVersionDto,
  field: FormFieldDefinitionDto,
  answer: ApplicationAnswerIndexEntryDto,
  optionSource: ApplicationAnswerOptionSource
): void {
  if (field.kind !== answer.kind) throw new ApplicationAnswerError('answer_type_mismatch', field.id);
  if (answer.kind === 'select') {
    if (field.kind !== 'select' || !allowedChoiceIds(version, field, optionSource).has(answer.choiceId)) {
      throw new ApplicationAnswerError(
        field.kind !== 'select' ? 'answer_type_mismatch' : 'unknown_choice', field.id
      );
    }
  } else if (answer.kind === 'multiselect') {
    if (field.kind !== 'multiselect') throw new ApplicationAnswerError('answer_type_mismatch', field.id);
    if (answer.choiceIds.length > field.maximumSelections) {
      throw new ApplicationAnswerError('too_many_choices', field.id);
    }
    const allowed = allowedChoiceIds(version, field, optionSource);
    if (answer.choiceIds.some((choiceId) => !allowed.has(choiceId))) {
      throw new ApplicationAnswerError('unknown_choice', field.id);
    }
  }
}

function allowedChoiceIds(
  version: FormVersionDto,
  field: Extract<FormFieldDefinitionDto, { readonly kind: 'select' | 'multiselect' }>,
  optionSource: ApplicationAnswerOptionSource
): ReadonlySet<string> {
  return field.options.kind === 'custom'
    ? new Set(field.options.choices.map((choice) => choice.id))
    : new Set(allowedVocabularyOptions(version, field, optionSource).map((option) => option.id));
}

function allowedVocabularyOptions(
  version: FormVersionDto,
  field: Extract<FormFieldDefinitionDto, { readonly kind: 'select' | 'multiselect' }>,
  optionSource: ApplicationAnswerOptionSource
): readonly ApplicationAnswerLiveOption[] {
  if (field.options.kind !== 'program_vocabulary') return [];
  const exposure = field.options.exposure;
  return optionSource.readLiveOptions(version.scope, field.options.source)
    .filter((option) => option.status === 'active'
      && (exposure.kind === 'all_active'
        || exposure.items.some((item) => item.id === option.id)))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
}

function isGovernedTransientAnswer(answer: TransientApplicationAnswerInput): answer is Extract<
  TransientApplicationAnswerInput,
  { readonly kind: GovernedAnswerKind }
> {
  return answer.kind !== 'select' && answer.kind !== 'multiselect' && answer.kind !== 'checkbox';
}

function hasValue(answer: TransientApplicationAnswerInput): boolean {
  if (answer.kind === 'text' || answer.kind === 'textarea') return answer.value.length > 0;
  if (answer.kind === 'multiselect') return answer.choiceIds.length > 0;
  return true;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}
