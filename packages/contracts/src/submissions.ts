import { encodeCanonicalJson, parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema
} from './operations';
import {
  FORM_EMAIL_MAX_LENGTH,
  FORM_FIELDS_MAX,
  FORM_LONG_TEXT_MAX_LENGTH,
  FORM_MULTISELECT_MAX_SELECTIONS,
  FORM_PHONE_MAX_LENGTH,
  FORM_TEXT_MAX_LENGTH,
  FORM_URL_MAX_LENGTH,
  INTAKE_REQUEST_MAX_CANONICAL_BYTES,
  formDeadlineReferencePinSchema,
  formTargetSchema,
  intakeDigestSchema,
  formFieldLabelSchema,
  intakeIdInputSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeStableKeySchema,
  intakeVersionSchema
} from './forms';
import { fieldRegistryOptionSourceSchema } from './field-registry';

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeAnswer(value: string, multiline: boolean): string {
  const normalized = value.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
  return multiline ? normalized : normalized.replace(/\n/gu, '');
}

function acceptedAnswer(value: string, maximum: number, multiline: boolean): boolean {
  if (!hasOnlyUnicodeScalars(value)) return false;
  const normalized = value.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
  const forbidden = multiline
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  return !forbidden.test(normalized) && normalized.length <= maximum;
}

function answerInput(maximum: number, multiline: boolean) {
  return z.string()
    .refine((value) => acceptedAnswer(value, maximum, multiline))
    .overwrite((value) => normalizeAnswer(value, multiline));
}

function acceptedEmail(value: string): boolean {
  const normalized = normalizeAnswer(value, false);
  if (!acceptedAnswer(value, FORM_EMAIL_MAX_LENGTH, false) || normalized.length === 0) return false;
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return local.length <= 64
    && domain.length <= 255
    && !/\s/u.test(normalized)
    && !local.startsWith('.')
    && !local.endsWith('.')
    && !local.includes('..')
    && domain.includes('.')
    && domain.split('.').every((label) =>
      label.length > 0
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
    );
}

export const applicationEmailInputSchema = z.string()
  .refine(acceptedEmail)
  .overwrite((value) => normalizeAnswer(value, false));
export const applicationEmailSchema = z.string()
  .refine((value) => acceptedEmail(value) && normalizeAnswer(value, false) === value);

function acceptedUrl(value: string): boolean {
  const normalized = normalizeAnswer(value, false);
  if (!acceptedAnswer(value, FORM_URL_MAX_LENGTH, false) || normalized.length === 0) return false;
  try {
    const parsed = new URL(normalized);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

export const applicationUrlInputSchema = z.string().refine(acceptedUrl)
  .overwrite((value) => normalizeAnswer(value, false));
export const applicationUrlSchema = z.string()
  .refine((value) => acceptedUrl(value) && normalizeAnswer(value, false) === value);

export const applicationPhoneInputSchema = answerInput(FORM_PHONE_MAX_LENGTH, false)
  .refine((value) => value.length > 0);
export const applicationPhoneSchema = z.string().refine((value) =>
  acceptedAnswer(value, FORM_PHONE_MAX_LENGTH, false)
  && normalizeAnswer(value, false) === value
  && value.length > 0
);

export const applicationNumberSchema = z.number().finite()
  .refine((value) => !Object.is(value, -0));

function acceptedDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day;
}

export const applicationDateSchema = z.string().refine(acceptedDate);
export const applicationDatetimeInputSchema = z.iso.datetime({ offset: true })
  .overwrite((value) => new Date(value).toISOString());
export const applicationDatetimeSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
});

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addUniqueIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) context.addIssue({ code: 'custom', path: [...path, index], message });
    seen.add(value);
  }
}

function addCanonicalOrderIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCanonicalText(values[index - 1]!, values[index]!) >= 0) {
      context.addIssue({ code: 'custom', path: [...path, index], message });
    }
  }
}

export const transientApplicationAnswerInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    fieldId: intakeIdInputSchema,
    value: answerInput(FORM_TEXT_MAX_LENGTH, false)
  }),
  z.strictObject({
    kind: z.literal('textarea'),
    fieldId: intakeIdInputSchema,
    value: answerInput(FORM_LONG_TEXT_MAX_LENGTH, true)
  }),
  z.strictObject({
    kind: z.literal('email'),
    fieldId: intakeIdInputSchema,
    value: applicationEmailInputSchema
  }),
  z.strictObject({ kind: z.literal('url'), fieldId: intakeIdInputSchema, value: applicationUrlInputSchema }),
  z.strictObject({ kind: z.literal('phone'), fieldId: intakeIdInputSchema, value: applicationPhoneInputSchema }),
  z.strictObject({ kind: z.literal('number'), fieldId: intakeIdInputSchema, value: applicationNumberSchema }),
  z.strictObject({ kind: z.literal('date'), fieldId: intakeIdInputSchema, value: applicationDateSchema }),
  z.strictObject({ kind: z.literal('datetime'), fieldId: intakeIdInputSchema, value: applicationDatetimeInputSchema }),
  z.strictObject({
    kind: z.literal('select'),
    fieldId: intakeIdInputSchema,
    choiceId: intakeIdInputSchema
  }),
  z.strictObject({
    kind: z.literal('multiselect'),
    fieldId: intakeIdInputSchema,
    choiceIds: z.array(intakeIdInputSchema).max(FORM_MULTISELECT_MAX_SELECTIONS)
  }),
  z.strictObject({
    kind: z.literal('checkbox'),
    fieldId: intakeIdInputSchema,
    checked: z.boolean()
  })
]);

export const transientApplicationAnswersInputSchema = z.array(transientApplicationAnswerInputSchema)
  .max(FORM_FIELDS_MAX)
  .superRefine((answers, context) => {
    addUniqueIssues(
      answers.map((answer) => answer.fieldId),
      context,
      [],
      'answer field ids must be unique'
    );
    for (const [answerIndex, answer] of answers.entries()) {
      if (answer.kind === 'multiselect') {
        addUniqueIssues(
          answer.choiceIds,
          context,
          [answerIndex, 'choiceIds'],
          'selected choice ids must be unique'
        );
      }
    }
    try {
      if (encodeCanonicalJson(answers).byteLength > INTAKE_REQUEST_MAX_CANONICAL_BYTES) {
        context.addIssue({ code: 'custom', path: [], message: 'application answers exceed the request byte limit' });
      }
    } catch {
      context.addIssue({ code: 'custom', path: [], message: 'application answers are not canonicalizable' });
    }
  });

/** The form identity is an untrusted public selection; current availability is resolved server-side. */
export const publicApplicationDraftBeginInputSchema = z.strictObject({
  formId: intakeIdInputSchema
});

/** Continuation evidence resolves the draft; no draft/participant/scope identity is accepted here. */
export const publicApplicationDraftReadInputSchema = z.strictObject({});

/** Continuation evidence resolves the draft; only optimistic version and transient answers are business input. */
export const publicApplicationDraftSaveInputSchema = z.strictObject({
  expectedDraftVersion: intakeVersionSchema,
  answers: transientApplicationAnswersInputSchema
}).superRefine((input, context) => {
  try {
    if (encodeCanonicalJson(input).byteLength > INTAKE_REQUEST_MAX_CANONICAL_BYTES) {
      context.addIssue({ code: 'custom', path: [], message: 'application save exceeds the request byte limit' });
    }
  } catch {
    context.addIssue({ code: 'custom', path: [], message: 'application save is not canonicalizable' });
  }
});

/** Protocol idempotency and continuation evidence remain outside this explicit submit body. */
export const publicApplicationSubmitInputSchema = z.strictObject({
  expectedDraftVersion: intakeVersionSchema
});

export const publicInputPolicyDispositionSchema = z.enum([
  'allow',
  'throttle',
  'challenge_required',
  'reject'
]);

export const publicInputPolicyDecisionEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evaluationId: intakeIdSchema,
  policy: z.strictObject({ key: intakeStableKeySchema, version: intakeVersionSchema }),
  disposition: publicInputPolicyDispositionSchema,
  reasonCode: intakeStableKeySchema.nullable(),
  remedyCode: intakeStableKeySchema.nullable(),
  requestDigestSha256: intakeDigestSchema,
  evaluatedAt: intakeInstantSchema,
  evidenceDigestSha256: intakeDigestSchema
}).superRefine((decision, context) => {
  if (decision.disposition === 'allow'
      && (decision.reasonCode !== null || decision.remedyCode !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['reasonCode'],
      message: 'an allow decision cannot carry refusal instructions'
    });
  }
  if (decision.disposition !== 'allow' && decision.reasonCode === null) {
    context.addIssue({
      code: 'custom',
      path: ['reasonCode'],
      message: 'a non-allow decision must carry a stable reason code'
    });
  }
});

export const governedAnswerPayloadSchema = z.strictObject({
  payloadRef: z.strictObject({ id: intakeIdSchema })
});

export const applicationAnswerIndexEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('textarea'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('email'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('url'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('phone'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('number'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('date'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('datetime'), fieldId: intakeIdSchema, value: governedAnswerPayloadSchema }),
  z.strictObject({ kind: z.literal('select'), fieldId: intakeIdSchema, choiceId: intakeIdSchema }),
  z.strictObject({
    kind: z.literal('multiselect'),
    fieldId: intakeIdSchema,
    choiceIds: z.array(intakeIdSchema).max(FORM_MULTISELECT_MAX_SELECTIONS)
  }),
  z.strictObject({ kind: z.literal('checkbox'), fieldId: intakeIdSchema, checked: z.boolean() })
]);

export const applicationAnswerIndexSchema = z.array(applicationAnswerIndexEntrySchema)
  .max(FORM_FIELDS_MAX)
  .superRefine((answers, context) => {
    const fieldIds = answers.map((answer) => answer.fieldId);
    addCanonicalOrderIssues(
      fieldIds,
      context,
      [],
      'answer entries must be unique and ordered by canonical field id'
    );
    for (const [answerIndex, answer] of answers.entries()) {
      if (answer.kind === 'multiselect') {
        addCanonicalOrderIssues(
          answer.choiceIds,
          context,
          [answerIndex, 'choiceIds'],
          'selected choices must be unique and use canonical code-unit order'
        );
      }
    }
  });

export const applicationDraftStatusSchema = z.enum(['in_progress', 'submitted']);

export const applicationDraftHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  scope: intakeScopeSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  authorityPartitionDigestSha256: intakeDigestSchema,
  version: intakeVersionSchema,
  currentRevisionId: intakeIdSchema,
  status: applicationDraftStatusSchema,
  submittedSubmissionId: intakeIdSchema.nullable(),
  createdAt: intakeInstantSchema,
  updatedAt: intakeInstantSchema
}).superRefine((draft, context) => {
  const coherent = draft.status === 'submitted'
    ? draft.submittedSubmissionId !== null
    : draft.submittedSubmissionId === null;
  if (!coherent) {
    context.addIssue({
      code: 'custom',
      path: ['submittedSubmissionId'],
      message: 'submitted linkage must match draft status'
    });
  }
});

export const applicationDraftRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  draftId: intakeIdSchema,
  version: intakeVersionSchema,
  sourceExpectedDraftVersion: z.number().int().nonnegative().safe(),
  requestDigestSha256: intakeDigestSchema,
  answersDigestSha256: intakeDigestSchema,
  answers: applicationAnswerIndexSchema,
  admissibilityDeadlinePin: formDeadlineReferencePinSchema.nullable(),
  inputPolicy: publicInputPolicyDecisionEvidenceSchema,
  savedAt: intakeInstantSchema
});

export const publicApplicationDraftStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  draftVersion: intakeVersionSchema,
  status: applicationDraftStatusSchema,
  answeredFieldIds: z.array(intakeIdSchema).max(FORM_FIELDS_MAX),
  submittedSubmissionId: intakeIdSchema.nullable(),
  updatedAt: intakeInstantSchema
}).superRefine((draft, context) => {
  addCanonicalOrderIssues(
    draft.answeredFieldIds,
    context,
    ['answeredFieldIds'],
    'answered field ids must be unique and canonically ordered'
  );
  const coherent = draft.status === 'submitted'
    ? draft.submittedSubmissionId !== null
    : draft.submittedSubmissionId === null;
  if (!coherent) context.addIssue({
    code: 'custom',
    path: ['submittedSubmissionId'],
    message: 'submitted linkage must match draft status'
  });
});

/**
 * Authorized continuation-only projection. Raw values are resolved from governed
 * payloads for this response and are not a durable draft/submission DTO.
 */
export const publicApplicationDraftResumeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  draft: publicApplicationDraftStatusSchema,
  answers: transientApplicationAnswersInputSchema
});

export const submissionStatusSchema = z.literal('submitted');

export const submissionSourceSchema = z.enum([
  'public_form',
  'direct_entry',
  'import',
  'email'
]);

export const submissionHeadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  scope: intakeScopeSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  source: submissionSourceSchema,
  status: submissionStatusSchema,
  version: intakeVersionSchema,
  submitEvidenceId: intakeIdSchema,
  primaryPersonId: intakeIdSchema,
  submittedAt: intakeInstantSchema
});

export const submissionProgramVocabularyAnswerPinSchema = z.strictObject({
  fieldId: intakeIdSchema,
  source: fieldRegistryOptionSourceSchema,
  itemId: intakeIdSchema,
  itemVersion: intakeVersionSchema,
  label: formFieldLabelSchema
});

export const submissionSubmitEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  submissionId: intakeIdSchema,
  draftId: intakeIdSchema,
  draftRevisionId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  requestDigestSha256: intakeDigestSchema,
  answerIndexDigestSha256: intakeDigestSchema,
  answers: applicationAnswerIndexSchema,
  programVocabularyAnswerPins: z.array(submissionProgramVocabularyAnswerPinSchema)
    .max(FORM_FIELDS_MAX * FORM_MULTISELECT_MAX_SELECTIONS),
  admissibilityDeadlinePin: formDeadlineReferencePinSchema.nullable(),
  inputPolicy: publicInputPolicyDecisionEvidenceSchema,
  submittedAt: intakeInstantSchema
}).superRefine((evidence, context) => {
  const identities = evidence.programVocabularyAnswerPins
    .map((pin) => `${pin.fieldId}:${pin.itemId}`);
  addCanonicalOrderIssues(
    identities, context, ['programVocabularyAnswerPins'],
    'vocabulary answer pins must be unique and ordered by field and item id'
  );
});

/**
 * Immutable evidence for an organizer-entered submission. It is a distinct
 * record beside the public submit evidence: there is no public input-policy
 * decision and no draft ceremony behind a direct entry, and the operator who
 * keyed the record in is carried as attribution, never as authorship.
 */
export const submissionDirectEntryEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  submissionId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  enteredByUserId: intakeIdSchema,
  authorityPartitionDigestSha256: intakeDigestSchema,
  requestDigestSha256: intakeDigestSchema,
  answerIndexDigestSha256: intakeDigestSchema,
  answers: applicationAnswerIndexSchema,
  programVocabularyAnswerPins: z.array(submissionProgramVocabularyAnswerPinSchema)
    .max(FORM_FIELDS_MAX * FORM_MULTISELECT_MAX_SELECTIONS),
  submittedAt: intakeInstantSchema
}).superRefine((evidence, context) => {
  const identities = evidence.programVocabularyAnswerPins
    .map((pin) => `${pin.fieldId}:${pin.itemId}`);
  addCanonicalOrderIssues(
    identities, context, ['programVocabularyAnswerPins'],
    'vocabulary answer pins must be unique and ordered by field and item id'
  );
});

export const submissionParticipantEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  submissionId: intakeIdSchema,
  personId: intakeIdSchema,
  participantIdentityId: intakeIdSchema,
  role: z.literal('primary'),
  position: z.literal(0),
  recordedAt: intakeInstantSchema
});

export const submissionConsentEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  submissionId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  fieldId: intakeIdSchema,
  wordingDigestSha256: intakeDigestSchema,
  affirmed: z.literal(true),
  recordedAt: intakeInstantSchema
});

export const publicApplicationSubmitResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  submissionId: intakeIdSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  submittedAt: intakeInstantSchema
});

export const organizerSubmissionSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: intakeIdSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  target: formTargetSchema,
  title: z.string().refine((value) =>
    acceptedAnswer(value, FORM_TEXT_MAX_LENGTH, false)
    && normalizeAnswer(value, false) === value
    && value.length > 0
  ).nullable(),
  primaryParticipantName: z.string().refine((value) =>
    acceptedAnswer(value, FORM_TEXT_MAX_LENGTH, false)
    && normalizeAnswer(value, false) === value
    && value.length > 0
  ).nullable(),
  submittedAt: intakeInstantSchema
});

const organizerTextAnswerValueSchema = z.string().refine((value) =>
  acceptedAnswer(value, FORM_TEXT_MAX_LENGTH, false)
  && normalizeAnswer(value, false) === value
);
const organizerLongTextAnswerValueSchema = z.string().refine((value) =>
  acceptedAnswer(value, FORM_LONG_TEXT_MAX_LENGTH, true)
  && normalizeAnswer(value, true) === value
);

const organizerAnswerField = {
  fieldId: intakeIdSchema,
  fieldLabel: formFieldLabelSchema
} as const;

export const organizerSubmissionChoiceSchema = z.strictObject({
  id: intakeIdSchema,
  label: formFieldLabelSchema
});

/**
 * Privacy-safe answer projection bound to the immutable FormVersion the
 * submission answered. Labels are carried here so consumers never need to
 * reinterpret historical answer IDs against the Form's current version.
 */
export const organizerSubmissionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    ...organizerAnswerField,
    value: organizerTextAnswerValueSchema
  }),
  z.strictObject({
    kind: z.literal('textarea'),
    ...organizerAnswerField,
    value: organizerLongTextAnswerValueSchema
  }),
  z.strictObject({ kind: z.literal('url'), ...organizerAnswerField, value: applicationUrlSchema }),
  z.strictObject({ kind: z.literal('phone'), ...organizerAnswerField, value: applicationPhoneSchema }),
  z.strictObject({ kind: z.literal('number'), ...organizerAnswerField, value: applicationNumberSchema }),
  z.strictObject({ kind: z.literal('date'), ...organizerAnswerField, value: applicationDateSchema }),
  z.strictObject({ kind: z.literal('datetime'), ...organizerAnswerField, value: applicationDatetimeSchema }),
  z.strictObject({
    kind: z.literal('select'),
    ...organizerAnswerField,
    choice: organizerSubmissionChoiceSchema
  }),
  z.strictObject({
    kind: z.literal('multiselect'),
    ...organizerAnswerField,
    choices: z.array(organizerSubmissionChoiceSchema).max(FORM_MULTISELECT_MAX_SELECTIONS)
  }),
  z.strictObject({
    kind: z.literal('checkbox'),
    ...organizerAnswerField,
    checked: z.boolean()
  })
]);

export const organizerSubmissionDetailSchema = z.strictObject({
  schemaVersion: z.literal(1),
  submissionId: intakeIdSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  submittedAt: intakeInstantSchema,
  participantCount: z.literal(1),
  answers: z.array(organizerSubmissionAnswerSchema).max(FORM_FIELDS_MAX),
  affirmedConsentFieldIds: z.array(intakeIdSchema).max(FORM_FIELDS_MAX)
}).superRefine((detail, context) => {
  addCanonicalOrderIssues(
    detail.answers.map((answer) => answer.fieldId),
    context,
    ['answers'],
    'answered field ids must be unique and canonically ordered'
  );
  for (const [index, answer] of detail.answers.entries()) {
    if (answer.kind === 'multiselect') addCanonicalOrderIssues(
      answer.choices.map((choice) => choice.id),
      context,
      ['answers', index, 'choices'],
      'selected choice ids must be unique and canonically ordered'
    );
  }
  addCanonicalOrderIssues(
    detail.affirmedConsentFieldIds,
    context,
    ['affirmedConsentFieldIds'],
    'consent field ids must be unique and canonically ordered'
  );
});

/** Permission-gated contact projection; it is never nested into the safe detail by default. */
export const organizerSubmissionContactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  submissionId: intakeIdSchema,
  personId: intakeIdSchema,
  participantIdentityId: intakeIdSchema,
  sourceFieldId: intakeIdSchema,
  email: applicationEmailSchema
});

/**
 * Operator wire input for the organizer direct-entry draft. The record's
 * identities, source, and `submittedAt` are server-assigned inside the sealed
 * invocation — the input cannot name or backdate them.
 */
export const submissionDirectEntryDraftInputSchema = z.strictObject({
  formId: intakeIdInputSchema,
  expectedFormDefinitionVersion: intakeVersionSchema,
  answers: transientApplicationAnswersInputSchema
});

/**
 * Non-classified diff surface for a planned direct entry. Answer values stay in
 * governed payloads; only field identities and vocabulary pins appear here.
 */
export const submissionDirectEntrySafeDiffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('create'),
  submission: z.strictObject({
    id: intakeIdSchema,
    formId: intakeIdSchema,
    formVersionId: intakeIdSchema,
    source: z.literal('direct_entry'),
    submittedAt: intakeInstantSchema,
    answeredFieldIds: z.array(intakeIdSchema).min(1).max(FORM_FIELDS_MAX),
    programVocabularyAnswerPins: z.array(submissionProgramVocabularyAnswerPinSchema)
      .max(FORM_FIELDS_MAX * FORM_MULTISELECT_MAX_SELECTIONS)
  })
}).superRefine((diff, context) => {
  addCanonicalOrderIssues(
    diff.submission.answeredFieldIds,
    context,
    ['submission', 'answeredFieldIds'],
    'answered field ids must be unique and canonically ordered'
  );
  addCanonicalOrderIssues(
    diff.submission.programVocabularyAnswerPins.map((pin) => `${pin.fieldId}:${pin.itemId}`),
    context,
    ['submission', 'programVocabularyAnswerPins'],
    'vocabulary answer pins must be unique and ordered by field and item id'
  );
});

const canonicalDirectEntryApplicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  'application ids use canonical lowercase form'
);

export const submissionDirectEntryDraftDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.literal('create'),
  changesetId: canonicalDirectEntryApplicationIdSchema,
  headVersion: intakeVersionSchema,
  status: z.literal('draft'),
  revision: z.strictObject({
    id: canonicalDirectEntryApplicationIdSchema,
    number: intakeVersionSchema,
    digestSha256: intakeDigestSchema
  }),
  riskTier: z.literal('low'),
  approvalPolicy: z.strictObject({
    reference: versionedDefinitionRefSchema,
    definitionDigestSha256: intakeDigestSchema,
    requirement: z.enum(['none', 'distinct_current_human'])
  }),
  safeDiff: submissionDirectEntrySafeDiffSchema
});

/**
 * Committed direct-entry receipt. `triage.queryGuard` proves the tray spine
 * initialized in the same transaction, and `undo` names the recoverable
 * compensating route — the arrival record itself is immutable evidence.
 */
export const submissionDirectEntryResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  submissionId: intakeIdSchema,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  source: z.literal('direct_entry'),
  submittedAt: intakeInstantSchema,
  triage: z.strictObject({
    queryGuard: z.strictObject({
      version: intakeVersionSchema,
      digestSha256: intakeDigestSchema
    }),
    replay: z.boolean()
  }),
  undo: z.strictObject({
    kind: z.literal('submission_triage_discard_recoverable'),
    submissionId: intakeIdSchema
  })
});

export const submissionDirectEntryDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: submissionDirectEntryDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const submissionDirectEntryDraftOperationResultSchema =
  createEffectfulOperationResultSchema(submissionDirectEntryDraftDataSchema);

export const SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS = Object.freeze({
  draft: createOperationSchemaManifestRefs({
    inputKey: 'schema.submission.direct-entry-create-draft.input',
    inputSchema: submissionDirectEntryDraftInputSchema,
    resultKey: 'schema.submission.direct-entry-create-draft.operator-result',
    resultSchema: submissionDirectEntryDraftOperationResultSchema
  })
});

export type TransientApplicationAnswerInput = z.infer<typeof transientApplicationAnswerInputSchema>;
export type TransientApplicationAnswersInput = z.infer<typeof transientApplicationAnswersInputSchema>;
export type PublicApplicationDraftBeginInput = z.infer<typeof publicApplicationDraftBeginInputSchema>;
export type PublicApplicationDraftReadInput = z.infer<typeof publicApplicationDraftReadInputSchema>;
export type PublicApplicationDraftSaveInput = z.infer<typeof publicApplicationDraftSaveInputSchema>;
export type PublicApplicationSubmitInput = z.infer<typeof publicApplicationSubmitInputSchema>;
export type PublicInputPolicyDisposition = z.infer<typeof publicInputPolicyDispositionSchema>;
export type PublicInputPolicyDecisionEvidence = z.infer<typeof publicInputPolicyDecisionEvidenceSchema>;
export type GovernedAnswerPayloadDto = z.infer<typeof governedAnswerPayloadSchema>;
export type ApplicationAnswerIndexEntryDto = z.infer<typeof applicationAnswerIndexEntrySchema>;
export type ApplicationAnswerIndexDto = z.infer<typeof applicationAnswerIndexSchema>;
export type ApplicationDraftStatus = z.infer<typeof applicationDraftStatusSchema>;
export type ApplicationDraftHeadDto = z.infer<typeof applicationDraftHeadSchema>;
export type ApplicationDraftRevisionDto = z.infer<typeof applicationDraftRevisionSchema>;
export type PublicApplicationDraftStatusDto = z.infer<typeof publicApplicationDraftStatusSchema>;
export type PublicApplicationDraftResumeDto = z.infer<typeof publicApplicationDraftResumeSchema>;
export type SubmissionSource = z.infer<typeof submissionSourceSchema>;
export type SubmissionHeadDto = z.infer<typeof submissionHeadSchema>;
export type SubmissionSubmitEvidenceDto = z.infer<typeof submissionSubmitEvidenceSchema>;
export type SubmissionProgramVocabularyAnswerPinDto =
  z.infer<typeof submissionProgramVocabularyAnswerPinSchema>;
export type SubmissionDirectEntryEvidenceDto = z.infer<typeof submissionDirectEntryEvidenceSchema>;
export type SubmissionParticipantEvidenceDto = z.infer<typeof submissionParticipantEvidenceSchema>;
export type SubmissionConsentEvidenceDto = z.infer<typeof submissionConsentEvidenceSchema>;
export type PublicApplicationSubmitResultDto = z.infer<typeof publicApplicationSubmitResultSchema>;
export type OrganizerSubmissionSummaryDto = z.infer<typeof organizerSubmissionSummarySchema>;
export type OrganizerSubmissionChoiceDto = z.infer<typeof organizerSubmissionChoiceSchema>;
export type OrganizerSubmissionAnswerDto = z.infer<typeof organizerSubmissionAnswerSchema>;
export type OrganizerSubmissionDetailDto = z.infer<typeof organizerSubmissionDetailSchema>;
export type OrganizerSubmissionContactDto = z.infer<typeof organizerSubmissionContactSchema>;
export type SubmissionDirectEntryDraftInput = z.infer<typeof submissionDirectEntryDraftInputSchema>;
export type SubmissionDirectEntrySafeDiff = z.infer<typeof submissionDirectEntrySafeDiffSchema>;
export type SubmissionDirectEntryDraftData = z.infer<typeof submissionDirectEntryDraftDataSchema>;
export type SubmissionDirectEntryResultDto = z.infer<typeof submissionDirectEntryResultSchema>;
