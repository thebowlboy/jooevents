import { createHash } from 'node:crypto';
import {
  applicationAnswerIndexSchema,
  applicationDraftHeadSchema,
  applicationDraftRevisionSchema,
  formVersionSchema,
  intakeDigestSchema,
  intakeIdSchema,
  intakeInstantSchema,
  publicApplicationDraftStatusSchema,
  publicApplicationSubmitResultSchema,
  submissionConsentEvidenceSchema,
  submissionHeadSchema,
  submissionParticipantEvidenceSchema,
  submissionSubmitEvidenceSchema,
  type ApplicationAnswerIndexDto,
  type ApplicationAnswerIndexEntryDto,
  type ApplicationDraftHeadDto,
  type ApplicationDraftRevisionDto,
  type FormDeadlineReferencePinDto,
  type FormDefinitionHeadDto,
  type FormFieldDefinitionDto,
  type FormTarget,
  type FormTargetReferencePinDto,
  type FormVersionDto,
  type PublicApplicationDraftStatusDto,
  type PublicApplicationSubmitResultDto,
  type SubmissionConsentEvidenceDto,
  type SubmissionHeadDto,
  type SubmissionParticipantEvidenceDto,
  type SubmissionSubmitEvidenceDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import {
  answerIndexDigest,
  pinProgramVocabularyAnswers,
  validateGovernedAnswerIndex,
  ApplicationAnswerError,
  type ApplicationAnswerOptionSource
} from './answers';
import {
  compareCanonicalText,
  deepFreeze,
  parseApplicationDraftHead,
  parseApplicationDraftRevision,
  parseFormDefinitionHead,
  parseFormVersion,
  parseSubmissionHead,
  parseSubmissionSubmitEvidence,
  sameIntakeScope,
  type IntakeFormReferenceSource
} from './model';
import {
  PUBLIC_INPUT_POLICY_ACTION,
  PublicInputPolicyError,
  openPublicInputPolicyDecision,
  parsePersistedPublicInputPolicyEvidence,
  type PublicInputPolicyEvaluationContext,
  type SealedPublicInputPolicyDecision
} from './input-policy';

export type ApplicationPlanningErrorCode =
  | 'wrong_scope'
  | 'form_not_open'
  | 'form_version_mismatch'
  | 'target_unavailable'
  | 'deadline_unavailable'
  | 'deadline_changed'
  | 'deadline_edit_locked'
  | 'wrong_authority_partition'
  | 'stale_draft'
  | 'draft_submitted'
  | 'draft_revision_mismatch'
  | 'input_policy_refused'
  | 'input_policy_mismatch'
  | 'invalid_input_policy_evidence'
  | 'invalid_answers'
  | 'invalid_submission_identity'
  | 'direct_entry_title_required'
  | 'direct_entry_email_required'
  | 'invalid_plan';

export class ApplicationPlanningError extends Error {
  constructor(
    readonly code: ApplicationPlanningErrorCode,
    readonly answerError?: ApplicationAnswerError
  ) {
    super(code);
    this.name = 'ApplicationPlanningError';
  }
}

export interface ApplicationCollectionSource
extends IntakeFormReferenceSource, ApplicationAnswerOptionSource {}

export interface ApplicationDraftBeginPlan {
  readonly action: 'begin';
  readonly formDefinitionVersion: number;
  readonly formVersionDigestSha256: string;
  readonly head: ApplicationDraftHeadDto;
  readonly revision: ApplicationDraftRevisionDto;
}

export interface ApplicationDraftSavePlan {
  readonly action: 'save';
  readonly formDefinitionVersion: number;
  readonly formVersionDigestSha256: string;
  readonly beforeHead: ApplicationDraftHeadDto;
  readonly beforeRevision: ApplicationDraftRevisionDto;
  readonly afterHead: ApplicationDraftHeadDto;
  readonly afterRevision: ApplicationDraftRevisionDto;
}

export interface ApplicationSubmitIdentityAssignment {
  readonly submissionId: string;
  readonly submitEvidenceId: string;
  readonly personId: string;
  readonly participantIdentityId: string;
  readonly participantEvidenceId: string;
  readonly consentEvidenceIds: readonly {
    readonly fieldId: string;
    readonly evidenceId: string;
  }[];
}

export interface ApplicationSubmitPlan {
  readonly action: 'submit';
  readonly formDefinitionVersion: number;
  readonly formVersionDigestSha256: string;
  readonly beforeHead: ApplicationDraftHeadDto;
  readonly sourceRevision: ApplicationDraftRevisionDto;
  readonly afterHead: ApplicationDraftHeadDto;
  readonly submission: SubmissionHeadDto;
  readonly submitEvidence: SubmissionSubmitEvidenceDto;
  readonly participant: SubmissionParticipantEvidenceDto;
  readonly consents: readonly SubmissionConsentEvidenceDto[];
  readonly result: PublicApplicationSubmitResultDto;
}

export type ApplicationMutationPlan =
  | ApplicationDraftBeginPlan
  | ApplicationDraftSavePlan
  | ApplicationSubmitPlan;

export function applicationMutationPlanDigest(plan: ApplicationMutationPlan): string {
  return sha256(plan);
}

type GovernedAnswer = Extract<ApplicationAnswerIndexEntryDto, { readonly value: unknown }>;

export interface ApplicationAnswerPayloadReferenceVerificationInput {
  readonly scope: FormVersionDto['scope'];
  readonly formVersionId: string;
  readonly draftId: string;
  readonly revisionId: string;
  readonly authorityPartitionDigestSha256: string;
  readonly field: FormFieldDefinitionDto;
  readonly answer: GovernedAnswer;
}

export interface ApplicationAnswerPayloadReferenceVerifier {
  verifyApplicationAnswerPayload(
    input: ApplicationAnswerPayloadReferenceVerificationInput
  ): boolean;
}

/** Revalidates exact plan evidence immediately before the transaction writes. */
export function validateApplicationMutationPlanAgainstForm(input: {
  readonly plan: unknown;
  readonly formHead: FormDefinitionHeadDto;
  readonly formVersion: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly payloadReferences: ApplicationAnswerPayloadReferenceVerifier;
}): ApplicationMutationPlan {
  const plan = parseApplicationMutationPlan(input.plan);
  const head = parseFormDefinitionHead(input.formHead);
  const version = parseFormVersion(input.formVersion);
  if (head.id !== version.formId
      || !sameIntakeScope(head.scope, version.scope)
      || head.status !== 'open'
      || plan.formDefinitionVersion !== head.version
      || plan.formVersionDigestSha256 !== formVersionDigest(version)) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
  const draftHead = plan.action === 'begin' ? plan.head : plan.beforeHead;
  if (draftHead.formId !== head.id
      || draftHead.formVersionId !== version.id
      || !sameIntakeScope(draftHead.scope, head.scope)) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
  const at = plan.action === 'begin'
    ? plan.revision.savedAt
    : plan.action === 'save'
      ? plan.afterRevision.savedAt
      : plan.submission.submittedAt;
  const deadlinePin = resolveCollectionAdmissibility({
    head,
    version,
    collection: input.collection,
    at,
    action: plan.action,
    ...(plan.action === 'begin' ? {} : { draftHead: plan.beforeHead })
  });
  const recordedPin = plan.action === 'begin'
    ? plan.revision.admissibilityDeadlinePin
    : plan.action === 'save'
      ? plan.afterRevision.admissibilityDeadlinePin
      : plan.submitEvidence.admissibilityDeadlinePin;
  if (sha256(deadlinePin) !== sha256(recordedPin)) {
    throw new ApplicationPlanningError('deadline_changed');
  }

  if (plan.action === 'begin') {
    if (head.currentPublishedVersionId !== version.id) {
      throw new ApplicationPlanningError('form_version_mismatch');
    }
    verifyRevisionPayloadReferences({
      head: plan.head, revision: plan.revision, version, mode: 'draft',
      collection: input.collection, verifier: input.payloadReferences
    });
    return plan;
  }
  if (plan.action === 'save') {
    verifyRevisionPayloadReferences({
      head: plan.beforeHead, revision: plan.beforeRevision, version, mode: 'draft',
      collection: input.collection, verifier: input.payloadReferences
    });
    verifyRevisionPayloadReferences({
      head: plan.afterHead, revision: plan.afterRevision, version, mode: 'draft',
      collection: input.collection, verifier: input.payloadReferences
    });
    return plan;
  }
  verifyRevisionPayloadReferences({
    head: plan.beforeHead, revision: plan.sourceRevision, version, mode: 'submit',
    collection: input.collection, verifier: input.payloadReferences
  });
  const pins = pinProgramVocabularyAnswers({
    answers: plan.sourceRevision.answers,
    formVersion: version,
    optionSource: input.collection
  });
  if (sha256(pins) !== sha256(plan.submitEvidence.programVocabularyAnswerPins)) {
    throw new ApplicationPlanningError('invalid_answers');
  }
  validateSubmitConsentSet(plan, version);
  return plan;
}

/** Rehydrates persisted exact-plan evidence without normalization or unknown keys. */
export function parseApplicationMutationPlan(value: unknown): ApplicationMutationPlan {
  try {
    const root = exactRecord(value);
    const common = {
      formDefinitionVersion: positiveVersion(root.formDefinitionVersion),
      formVersionDigestSha256: intakeDigestSchema.parse(root.formVersionDigestSha256)
    };
    let plan: ApplicationMutationPlan;
    if (root.action === 'begin') {
      assertExactKeys(root, [
        'action', 'formDefinitionVersion', 'formVersionDigestSha256', 'head', 'revision'
      ]);
      plan = {
        action: 'begin', ...common,
        head: parseApplicationDraftHead(root.head),
        revision: parseApplicationDraftRevision(root.revision)
      };
    } else if (root.action === 'save') {
      assertExactKeys(root, [
        'action', 'formDefinitionVersion', 'formVersionDigestSha256',
        'beforeHead', 'beforeRevision', 'afterHead', 'afterRevision'
      ]);
      plan = {
        action: 'save', ...common,
        beforeHead: parseApplicationDraftHead(root.beforeHead),
        beforeRevision: parseApplicationDraftRevision(root.beforeRevision),
        afterHead: parseApplicationDraftHead(root.afterHead),
        afterRevision: parseApplicationDraftRevision(root.afterRevision)
      };
    } else if (root.action === 'submit') {
      assertExactKeys(root, [
        'action', 'formDefinitionVersion', 'formVersionDigestSha256',
        'beforeHead', 'sourceRevision', 'afterHead', 'submission', 'submitEvidence',
        'participant', 'consents', 'result'
      ]);
      if (!Array.isArray(root.consents)) throw new TypeError();
      plan = {
        action: 'submit', ...common,
        beforeHead: parseApplicationDraftHead(root.beforeHead),
        sourceRevision: parseApplicationDraftRevision(root.sourceRevision),
        afterHead: parseApplicationDraftHead(root.afterHead),
        submission: parseSubmissionHead(root.submission),
        submitEvidence: parseSubmissionSubmitEvidence(root.submitEvidence),
        participant: submissionParticipantEvidenceSchema.parse(root.participant),
        consents: root.consents.map((consent) => submissionConsentEvidenceSchema.parse(consent)),
        result: publicApplicationSubmitResultSchema.parse(root.result)
      };
    } else throw new TypeError();
    assertApplicationMutationPlanShape(plan);
    return deepFreeze(plan);
  } catch {
    throw new ApplicationPlanningError('invalid_plan');
  }
}

export function planApplicationDraftBegin(input: {
  readonly formHead: FormDefinitionHeadDto;
  readonly formVersion: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly inputPolicy: SealedPublicInputPolicyDecision;
  readonly requestDigestSha256: string;
  readonly server: {
    readonly draftId: string;
    readonly revisionId: string;
    readonly authorityPartitionDigestSha256: string;
    readonly createdAt: string;
  };
}): ApplicationDraftBeginPlan {
  const head = parseFormDefinitionHead(input.formHead);
  const version = parseFormVersion(input.formVersion);
  assertFormMayBegin(head, version);
  const at = intakeInstantSchema.parse(input.server.createdAt);
  const deadlinePin = resolveCollectionAdmissibility({
    head, version, collection: input.collection, at, action: 'begin'
  });
  const inputPolicy = openAllowPolicy(input.inputPolicy, {
    scope: version.scope,
    action: PUBLIC_INPUT_POLICY_ACTION.draftBegin,
    requestDigestSha256: input.requestDigestSha256,
    evaluatedAt: at
  });
  const draftId = intakeIdSchema.parse(input.server.draftId);
  const revisionId = intakeIdSchema.parse(input.server.revisionId);
  const authorityPartitionDigestSha256 = intakeDigestSchema.parse(
    input.server.authorityPartitionDigestSha256
  );
  const answers: ApplicationAnswerIndexDto = [];
  const revision = applicationDraftRevisionSchema.parse({
    schemaVersion: 1,
    id: revisionId,
    draftId,
    version: 1,
    sourceExpectedDraftVersion: 0,
    requestDigestSha256: input.requestDigestSha256,
    answersDigestSha256: answerIndexDigest(answers),
    answers,
    admissibilityDeadlinePin: deadlinePin,
    inputPolicy,
    savedAt: at
  });
  const draftHead = applicationDraftHeadSchema.parse({
    schemaVersion: 1,
    id: draftId,
    scope: version.scope,
    formId: version.formId,
    formVersionId: version.id,
    authorityPartitionDigestSha256,
    version: 1,
    currentRevisionId: revision.id,
    status: 'in_progress',
    submittedSubmissionId: null,
    createdAt: at,
    updatedAt: at
  });
  return deepFreeze({
    action: 'begin',
    formDefinitionVersion: head.version,
    formVersionDigestSha256: formVersionDigest(version),
    head: draftHead,
    revision
  });
}

export function planApplicationDraftSave(input: {
  readonly formHead: FormDefinitionHeadDto;
  readonly formVersion: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly draftHead: ApplicationDraftHeadDto;
  readonly currentRevision: ApplicationDraftRevisionDto;
  readonly expectedDraftVersion: number;
  readonly expectedAuthorityPartitionDigestSha256: string;
  readonly requestDigestSha256: string;
  readonly inputPolicy: SealedPublicInputPolicyDecision;
  readonly answers: ApplicationAnswerIndexDto;
  readonly server: { readonly revisionId: string; readonly savedAt: string };
}): ApplicationDraftSavePlan {
  const formHead = parseFormDefinitionHead(input.formHead);
  const formVersion = parseFormVersion(input.formVersion);
  const beforeHead = parseApplicationDraftHead(input.draftHead);
  const beforeRevision = parseApplicationDraftRevision(input.currentRevision);
  assertFormMayCollect(formHead, formVersion);
  assertDraftContext({
    draftHead: beforeHead,
    currentRevision: beforeRevision,
    formVersion,
    expectedDraftVersion: input.expectedDraftVersion,
    expectedAuthorityPartitionDigestSha256: input.expectedAuthorityPartitionDigestSha256
  });
  assertAnswers(input.answers, formVersion, input.collection, 'draft');
  const savedAt = intakeInstantSchema.parse(input.server.savedAt);
  const deadlinePin = resolveCollectionAdmissibility({
    head: formHead, version: formVersion, collection: input.collection,
    at: savedAt, action: 'save', draftHead: beforeHead
  });
  const inputPolicy = openAllowPolicy(input.inputPolicy, {
    scope: formVersion.scope,
    action: PUBLIC_INPUT_POLICY_ACTION.draftSave,
    requestDigestSha256: input.requestDigestSha256,
    evaluatedAt: savedAt
  });
  const afterRevision = applicationDraftRevisionSchema.parse({
    schemaVersion: 1,
    id: intakeIdSchema.parse(input.server.revisionId),
    draftId: beforeHead.id,
    version: beforeHead.version + 1,
    sourceExpectedDraftVersion: input.expectedDraftVersion,
    requestDigestSha256: input.requestDigestSha256,
    answersDigestSha256: answerIndexDigest(input.answers),
    answers: input.answers,
    admissibilityDeadlinePin: deadlinePin,
    inputPolicy,
    savedAt
  });
  const afterHead = applicationDraftHeadSchema.parse({
    ...beforeHead,
    version: beforeHead.version + 1,
    currentRevisionId: afterRevision.id,
    updatedAt: savedAt
  });
  return deepFreeze({
    action: 'save',
    formDefinitionVersion: formHead.version,
    formVersionDigestSha256: formVersionDigest(formVersion),
    beforeHead, beforeRevision, afterHead, afterRevision
  });
}

export function planApplicationSubmit(input: {
  readonly formHead: FormDefinitionHeadDto;
  readonly formVersion: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly draftHead: ApplicationDraftHeadDto;
  readonly currentRevision: ApplicationDraftRevisionDto;
  readonly expectedDraftVersion: number;
  readonly expectedAuthorityPartitionDigestSha256: string;
  readonly requestDigestSha256: string;
  readonly inputPolicy: SealedPublicInputPolicyDecision;
  readonly identities: ApplicationSubmitIdentityAssignment;
  readonly server: { readonly submittedAt: string };
}): ApplicationSubmitPlan {
  const formHead = parseFormDefinitionHead(input.formHead);
  const formVersion = parseFormVersion(input.formVersion);
  const beforeHead = parseApplicationDraftHead(input.draftHead);
  const sourceRevision = parseApplicationDraftRevision(input.currentRevision);
  assertFormMayCollect(formHead, formVersion);
  assertDraftContext({
    draftHead: beforeHead,
    currentRevision: sourceRevision,
    formVersion,
    expectedDraftVersion: input.expectedDraftVersion,
    expectedAuthorityPartitionDigestSha256: input.expectedAuthorityPartitionDigestSha256
  });
  assertAnswers(sourceRevision.answers, formVersion, input.collection, 'submit');
  const identities = parseSubmitIdentities(input.identities, formVersion, sourceRevision.answers);
  const submittedAt = intakeInstantSchema.parse(input.server.submittedAt);
  const deadlinePin = resolveCollectionAdmissibility({
    head: formHead, version: formVersion, collection: input.collection,
    at: submittedAt, action: 'submit', draftHead: beforeHead
  });
  const inputPolicy = openAllowPolicy(input.inputPolicy, {
    scope: formVersion.scope,
    action: PUBLIC_INPUT_POLICY_ACTION.submit,
    requestDigestSha256: input.requestDigestSha256,
    evaluatedAt: submittedAt
  });
  const submission = submissionHeadSchema.parse({
    schemaVersion: 1,
    id: identities.submissionId,
    scope: beforeHead.scope,
    formId: beforeHead.formId,
    formVersionId: beforeHead.formVersionId,
    source: 'public_form',
    status: 'submitted',
    version: 1,
    submitEvidenceId: identities.submitEvidenceId,
    primaryPersonId: identities.personId,
    submittedAt
  });
  const programVocabularyAnswerPins = pinProgramVocabularyAnswers({
    answers: sourceRevision.answers,
    formVersion,
    optionSource: input.collection
  });
  const submitEvidence = submissionSubmitEvidenceSchema.parse({
    schemaVersion: 1,
    id: identities.submitEvidenceId,
    submissionId: submission.id,
    draftId: beforeHead.id,
    draftRevisionId: sourceRevision.id,
    formVersionId: formVersion.id,
    requestDigestSha256: input.requestDigestSha256,
    answerIndexDigestSha256: answerIndexDigest(sourceRevision.answers),
    answers: sourceRevision.answers,
    programVocabularyAnswerPins,
    admissibilityDeadlinePin: deadlinePin,
    inputPolicy,
    submittedAt
  });
  const participant = submissionParticipantEvidenceSchema.parse({
    schemaVersion: 1,
    id: identities.participantEvidenceId,
    submissionId: submission.id,
    personId: identities.personId,
    participantIdentityId: identities.participantIdentityId,
    role: 'primary',
    position: 0,
    recordedAt: submittedAt
  });
  const explicitConsents = formVersion.definition.fields
    .filter((field) => field.purpose.kind === 'consent')
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const consentIds = new Map(
    identities.consentEvidenceIds.map((entry) => [entry.fieldId, entry.evidenceId])
  );
  const answerByField = new Map(sourceRevision.answers.map((answer) => [answer.fieldId, answer]));
  const consents = explicitConsents.flatMap((field): SubmissionConsentEvidenceDto[] => {
    const answer = answerByField.get(field.id);
    if (!answer || answer.kind !== 'checkbox' || !answer.checked) return [];
    return [submissionConsentEvidenceSchema.parse({
      schemaVersion: 1,
      id: consentIds.get(field.id),
      submissionId: submission.id,
      formVersionId: formVersion.id,
      fieldId: field.id,
      wordingDigestSha256: consentWordingDigest(field),
      affirmed: true,
      recordedAt: submittedAt
    })];
  });
  const afterHead = applicationDraftHeadSchema.parse({
    ...beforeHead,
    version: beforeHead.version + 1,
    status: 'submitted',
    submittedSubmissionId: submission.id,
    updatedAt: submittedAt
  });
  const result = publicApplicationSubmitResultSchema.parse({
    schemaVersion: 1,
    submissionId: submission.id,
    formId: submission.formId,
    formVersionId: submission.formVersionId,
    submittedAt
  });
  return deepFreeze({
    action: 'submit',
    formDefinitionVersion: formHead.version,
    formVersionDigestSha256: formVersionDigest(formVersion),
    beforeHead, sourceRevision, afterHead, submission, submitEvidence,
    participant, consents, result
  });
}

export function validateApplicationSubmitReplay(input: {
  readonly draftHead: ApplicationDraftHeadDto;
  readonly sourceRevision: ApplicationDraftRevisionDto;
  readonly submission: SubmissionHeadDto;
  readonly submitEvidence: SubmissionSubmitEvidenceDto;
}): PublicApplicationSubmitResultDto {
  const draft = parseApplicationDraftHead(input.draftHead);
  const revision = parseApplicationDraftRevision(input.sourceRevision);
  const submission = parseSubmissionHead(input.submission);
  const evidence = parseSubmissionSubmitEvidence(input.submitEvidence);
  if (draft.status !== 'submitted'
      || draft.submittedSubmissionId !== submission.id
      || draft.currentRevisionId !== revision.id
      || revision.draftId !== draft.id
      || revision.version !== draft.version - 1
      || submission.submitEvidenceId !== evidence.id
      || evidence.submissionId !== submission.id
      || evidence.draftId !== draft.id
      || evidence.draftRevisionId !== revision.id
      || evidence.formVersionId !== draft.formVersionId
      || evidence.formVersionId !== submission.formVersionId
      || evidence.answerIndexDigestSha256 !== revision.answersDigestSha256
      || evidence.answerIndexDigestSha256 !== answerIndexDigest(revision.answers)
      || sha256(evidence.answers) !== sha256(revision.answers)
      || evidence.submittedAt !== submission.submittedAt
      || evidence.submittedAt !== draft.updatedAt
      || submission.formId !== draft.formId
      || submission.formVersionId !== draft.formVersionId
      || !sameIntakeScope(submission.scope, draft.scope)) {
    throw new ApplicationPlanningError('invalid_plan');
  }
  return publicApplicationSubmitResultSchema.parse({
    schemaVersion: 1,
    submissionId: submission.id,
    formId: submission.formId,
    formVersionId: submission.formVersionId,
    submittedAt: submission.submittedAt
  });
}

export function projectPublicApplicationDraftStatus(
  head: ApplicationDraftHeadDto,
  revision: ApplicationDraftRevisionDto
): PublicApplicationDraftStatusDto {
  const draft = parseApplicationDraftHead(head);
  const current = parseApplicationDraftRevision(revision);
  if (draft.currentRevisionId !== current.id || draft.id !== current.draftId) {
    throw new ApplicationPlanningError('draft_revision_mismatch');
  }
  return publicApplicationDraftStatusSchema.parse({
    schemaVersion: 1,
    formId: draft.formId,
    formVersionId: draft.formVersionId,
    draftVersion: draft.version,
    status: draft.status,
    answeredFieldIds: current.answers.map((answer) => answer.fieldId).sort(compareCanonicalText),
    submittedSubmissionId: draft.submittedSubmissionId,
    updatedAt: draft.updatedAt
  });
}

export type ApplicationCorrectionDerivation =
  | { readonly kind: 'exact'; readonly restoredHead: null }
  | { readonly kind: 'semantic'; readonly restoredHead: ApplicationDraftHeadDto; readonly retainedRevisionId: string }
  | { readonly kind: 'blocked'; readonly reason: 'later_draft_change' | 'submission_immutable' };

export function deriveApplicationCorrection(input: {
  readonly sourcePlan: ApplicationMutationPlan;
  readonly currentHead: ApplicationDraftHeadDto | undefined;
  readonly correctedAt: string;
}): ApplicationCorrectionDerivation {
  const plan = input.sourcePlan;
  if (plan.action === 'submit') return deepFreeze({ kind: 'blocked', reason: 'submission_immutable' });
  const after = plan.action === 'begin' ? plan.head : plan.afterHead;
  if (!input.currentHead || sha256(input.currentHead) !== sha256(after)) {
    return deepFreeze({ kind: 'blocked', reason: 'later_draft_change' });
  }
  if (plan.action === 'begin') return deepFreeze({ kind: 'exact', restoredHead: null });
  return deepFreeze({
    kind: 'semantic',
    restoredHead: applicationDraftHeadSchema.parse({
      ...plan.beforeHead,
      version: plan.afterHead.version + 1,
      updatedAt: intakeInstantSchema.parse(input.correctedAt)
    }),
    retainedRevisionId: plan.afterRevision.id
  });
}

function resolveCollectionAdmissibility(input: {
  readonly head: FormDefinitionHeadDto;
  readonly version: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly at: string;
  readonly action: ApplicationMutationPlan['action'];
  readonly draftHead?: ApplicationDraftHeadDto;
}): FormDeadlineReferencePinDto | null {
  assertFormMayCollect(input.head, input.version);
  resolveCurrentTarget(input.version, input.collection);
  if (input.version.definition.availability.kind === 'evergreen') return null;
  const pin = input.collection.resolveCurrentDeadline(
    input.version.scope, input.version.definition.availability
  );
  if (!pin || pin.id !== input.version.definition.availability.deadlineId) {
    throw new ApplicationPlanningError('deadline_unavailable');
  }
  const at = intakeInstantSchema.parse(input.at);
  if (input.action !== 'begin' && input.draftHead
      && at >= pin.effectiveAt && input.draftHead.createdAt < pin.effectiveAt) {
    throw new ApplicationPlanningError('deadline_edit_locked');
  }
  return deepFreeze(pin);
}

function resolveCurrentTarget(
  version: FormVersionDto,
  collection: ApplicationCollectionSource
): FormTargetReferencePinDto | null {
  const target: FormTarget = version.definition.target;
  if (target.kind === 'general_pool') return null;
  if (target.kind === 'category') {
    const pin = collection.resolveActiveCategory(version.scope, target);
    if (!pin || pin.kind !== 'category' || pin.id !== target.category.id
        || pin.categoryKind !== target.category.kind) {
      throw new ApplicationPlanningError('target_unavailable');
    }
    return pin;
  }
  const pin = collection.resolveCollectingSession(version.scope, target);
  if (!pin || pin.kind !== 'session' || pin.id !== target.sessionId
      || pin.lifecycle !== 'collecting') {
    throw new ApplicationPlanningError('target_unavailable');
  }
  return pin;
}

function assertFormMayCollect(head: FormDefinitionHeadDto, version: FormVersionDto): void {
  if (!sameIntakeScope(head.scope, version.scope) || head.id !== version.formId) {
    throw new ApplicationPlanningError('wrong_scope');
  }
  if (head.status !== 'open') throw new ApplicationPlanningError('form_not_open');
  if (head.currentPublishedVersionId === null) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
}

function assertFormMayBegin(head: FormDefinitionHeadDto, version: FormVersionDto): void {
  assertFormMayCollect(head, version);
  if (head.currentPublishedVersionId !== version.id) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
}

function assertDraftContext(input: {
  readonly draftHead: ApplicationDraftHeadDto;
  readonly currentRevision: ApplicationDraftRevisionDto;
  readonly formVersion: FormVersionDto;
  readonly expectedDraftVersion: number;
  readonly expectedAuthorityPartitionDigestSha256: string;
}): void {
  if (input.draftHead.status === 'submitted') throw new ApplicationPlanningError('draft_submitted');
  if (input.draftHead.version !== input.expectedDraftVersion) {
    throw new ApplicationPlanningError('stale_draft');
  }
  if (input.draftHead.authorityPartitionDigestSha256
      !== intakeDigestSchema.parse(input.expectedAuthorityPartitionDigestSha256)) {
    throw new ApplicationPlanningError('wrong_authority_partition');
  }
  if (!sameIntakeScope(input.draftHead.scope, input.formVersion.scope)
      || input.draftHead.formId !== input.formVersion.formId
      || input.draftHead.formVersionId !== input.formVersion.id) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
  if (input.draftHead.currentRevisionId !== input.currentRevision.id
      || input.currentRevision.draftId !== input.draftHead.id
      || input.currentRevision.version !== input.draftHead.version) {
    throw new ApplicationPlanningError('draft_revision_mismatch');
  }
}

function openAllowPolicy(
  value: SealedPublicInputPolicyDecision,
  expectedContext: PublicInputPolicyEvaluationContext
) {
  let policy;
  try {
    policy = openPublicInputPolicyDecision(value, expectedContext);
  } catch (error) {
    if (error instanceof PublicInputPolicyError
        && error.code === 'input_policy_context_mismatch') {
      throw new ApplicationPlanningError('input_policy_mismatch');
    }
    if (error instanceof PublicInputPolicyError) {
      throw new ApplicationPlanningError('invalid_input_policy_evidence');
    }
    throw error;
  }
  if (policy.disposition !== 'allow') throw new ApplicationPlanningError('input_policy_refused');
  return policy;
}

function assertAnswers(
  answers: ApplicationAnswerIndexDto,
  formVersion: FormVersionDto,
  collection: ApplicationCollectionSource,
  mode: 'draft' | 'submit'
): void {
  try {
    validateGovernedAnswerIndex({ answers, formVersion, optionSource: collection, mode });
  } catch (error) {
    if (error instanceof ApplicationAnswerError) {
      throw new ApplicationPlanningError('invalid_answers', error);
    }
    throw error;
  }
}

function verifyRevisionPayloadReferences(input: {
  readonly head: ApplicationDraftHeadDto;
  readonly revision: ApplicationDraftRevisionDto;
  readonly version: FormVersionDto;
  readonly mode: 'draft' | 'submit';
  readonly collection: ApplicationCollectionSource;
  readonly verifier: ApplicationAnswerPayloadReferenceVerifier;
}): void {
  assertAnswers(input.revision.answers, input.version, input.collection, input.mode);
  if (!input.verifier || typeof input.verifier.verifyApplicationAnswerPayload !== 'function') {
    throw new ApplicationPlanningError('invalid_answers');
  }
  const payloadRefIds = new Set<string>();
  for (const answer of input.revision.answers) {
    if (!('value' in answer)) continue;
    if (payloadRefIds.has(answer.value.payloadRef.id)) {
      throw new ApplicationPlanningError('invalid_answers');
    }
    payloadRefIds.add(answer.value.payloadRef.id);
    const field = input.version.definition.fields.find((candidate) => candidate.id === answer.fieldId);
    if (!field || field.kind !== answer.kind) throw new ApplicationPlanningError('invalid_answers');
    let verified = false;
    try {
      verified = input.verifier.verifyApplicationAnswerPayload({
        scope: input.head.scope,
        formVersionId: input.version.id,
        draftId: input.head.id,
        revisionId: input.revision.id,
        authorityPartitionDigestSha256: input.head.authorityPartitionDigestSha256,
        field,
        answer
      });
    } catch {
      verified = false;
    }
    if (!verified) throw new ApplicationPlanningError('invalid_answers');
  }
}

function validateSubmitConsentSet(plan: ApplicationSubmitPlan, version: FormVersionDto): void {
  const fieldById = new Map(version.definition.fields.map((field) => [field.id, field]));
  const expected = plan.sourceRevision.answers
    .filter((answer) => {
      const field = fieldById.get(answer.fieldId);
      return answer.kind === 'checkbox' && answer.checked && field?.purpose.kind === 'consent';
    })
    .map((answer) => answer.fieldId)
    .sort(compareCanonicalText);
  const actual = plan.consents.map((consent) => consent.fieldId);
  if (expected.length !== actual.length
      || expected.some((fieldId, index) => fieldId !== actual[index])) {
    throw new ApplicationPlanningError('invalid_plan');
  }
  for (const consent of plan.consents) {
    const field = fieldById.get(consent.fieldId);
    if (!field || field.purpose.kind !== 'consent'
        || consent.wordingDigestSha256 !== consentWordingDigest(field)
        || consent.submissionId !== plan.submission.id
        || consent.formVersionId !== version.id
        || consent.recordedAt !== plan.submission.submittedAt
        || !consent.affirmed) {
      throw new ApplicationPlanningError('invalid_plan');
    }
  }
}

function consentWordingDigest(field: FormFieldDefinitionDto): string {
  if (field.purpose.kind !== 'consent') throw new ApplicationPlanningError('invalid_plan');
  return sha256({ purposeKey: field.purpose.key, label: field.label, help: field.help });
}

function assertApplicationMutationPlanShape(plan: ApplicationMutationPlan): void {
  if (plan.action === 'begin') {
    const { head, revision } = plan;
    if (head.version !== 1 || head.status !== 'in_progress'
        || head.submittedSubmissionId !== null || head.currentRevisionId !== revision.id
        || head.id !== revision.draftId || revision.version !== 1
        || revision.sourceExpectedDraftVersion !== 0 || revision.answers.length !== 0
        || revision.answersDigestSha256 !== answerIndexDigest(revision.answers)
        || head.createdAt !== revision.savedAt || head.updatedAt !== revision.savedAt) throw new TypeError();
    assertPersistedAllowPolicy(
      revision.inputPolicy, head.scope, PUBLIC_INPUT_POLICY_ACTION.draftBegin,
      revision.requestDigestSha256, revision.savedAt
    );
    return;
  }
  const beforeRevision = plan.action === 'save' ? plan.beforeRevision : plan.sourceRevision;
  assertCurrentRevision(plan.beforeHead, beforeRevision);
  if (plan.beforeHead.status !== 'in_progress'
      || plan.afterHead.id !== plan.beforeHead.id
      || !sameIntakeScope(plan.afterHead.scope, plan.beforeHead.scope)
      || plan.afterHead.formId !== plan.beforeHead.formId
      || plan.afterHead.formVersionId !== plan.beforeHead.formVersionId
      || plan.afterHead.authorityPartitionDigestSha256
        !== plan.beforeHead.authorityPartitionDigestSha256
      || plan.afterHead.createdAt !== plan.beforeHead.createdAt
      || plan.afterHead.version !== plan.beforeHead.version + 1
      || plan.afterHead.updatedAt < plan.beforeHead.updatedAt) throw new TypeError();
  if (plan.action === 'save') {
    const revision = plan.afterRevision;
    if (plan.afterHead.status !== 'in_progress'
        || plan.afterHead.submittedSubmissionId !== null
        || plan.afterHead.currentRevisionId !== revision.id
        || revision.draftId !== plan.beforeHead.id
        || revision.version !== plan.afterHead.version
        || revision.sourceExpectedDraftVersion !== plan.beforeHead.version
        || revision.savedAt !== plan.afterHead.updatedAt
        || revision.answersDigestSha256 !== answerIndexDigest(revision.answers)) throw new TypeError();
    assertPersistedAllowPolicy(
      revision.inputPolicy, plan.afterHead.scope, PUBLIC_INPUT_POLICY_ACTION.draftSave,
      revision.requestDigestSha256, revision.savedAt
    );
    return;
  }
  const { submission, submitEvidence: evidence, participant, result } = plan;
  if (plan.afterHead.status !== 'submitted'
      || plan.afterHead.submittedSubmissionId !== submission.id
      || plan.afterHead.currentRevisionId !== plan.beforeHead.currentRevisionId
      || plan.afterHead.updatedAt !== submission.submittedAt
      || !sameIntakeScope(submission.scope, plan.beforeHead.scope)
      || submission.formId !== plan.beforeHead.formId
      || submission.formVersionId !== plan.beforeHead.formVersionId
      || submission.version !== 1
      || submission.submitEvidenceId !== evidence.id
      || evidence.submissionId !== submission.id
      || evidence.draftId !== plan.beforeHead.id
      || evidence.draftRevisionId !== plan.sourceRevision.id
      || evidence.formVersionId !== submission.formVersionId
      || evidence.requestDigestSha256 !== evidence.inputPolicy.requestDigestSha256
      || evidence.answerIndexDigestSha256 !== answerIndexDigest(plan.sourceRevision.answers)
      || sha256(evidence.answers) !== sha256(plan.sourceRevision.answers)
      || evidence.submittedAt !== submission.submittedAt
      || participant.submissionId !== submission.id
      || participant.personId !== submission.primaryPersonId
      || participant.recordedAt !== submission.submittedAt
      || result.submissionId !== submission.id || result.formId !== submission.formId
      || result.formVersionId !== submission.formVersionId
      || result.submittedAt !== submission.submittedAt) throw new TypeError();
  const consentFieldIds = plan.consents.map((consent) => consent.fieldId);
  const evidenceIds = [
    submission.id, evidence.id, participant.id, participant.personId,
    participant.participantIdentityId, ...plan.consents.map((consent) => consent.id)
  ];
  if (new Set(evidenceIds).size !== evidenceIds.length
      || consentFieldIds.some((id, index) => index > 0
        && compareCanonicalText(consentFieldIds[index - 1]!, id) >= 0)
      || plan.consents.some((consent) => consent.submissionId !== submission.id
        || consent.formVersionId !== submission.formVersionId
        || !consent.affirmed || consent.recordedAt !== submission.submittedAt)) throw new TypeError();
  assertPersistedAllowPolicy(
    evidence.inputPolicy, submission.scope, PUBLIC_INPUT_POLICY_ACTION.submit,
    evidence.requestDigestSha256, evidence.submittedAt
  );
}

function assertCurrentRevision(
  head: ApplicationDraftHeadDto,
  revision: ApplicationDraftRevisionDto
): void {
  if (head.currentRevisionId !== revision.id || head.id !== revision.draftId
      || head.version !== revision.version || head.updatedAt !== revision.savedAt
      || revision.answersDigestSha256 !== answerIndexDigest(revision.answers)) throw new TypeError();
  const action = revision.sourceExpectedDraftVersion === 0
    ? PUBLIC_INPUT_POLICY_ACTION.draftBegin
    : PUBLIC_INPUT_POLICY_ACTION.draftSave;
  assertPersistedAllowPolicy(
    revision.inputPolicy, head.scope, action, revision.requestDigestSha256, revision.savedAt
  );
}

function assertPersistedAllowPolicy(
  evidence: ApplicationDraftRevisionDto['inputPolicy'],
  scope: ApplicationDraftHeadDto['scope'],
  action: PublicInputPolicyEvaluationContext['action'],
  requestDigestSha256: string,
  evaluatedAt: string
): void {
  const parsed = parsePersistedPublicInputPolicyEvidence({
    evidence, context: { scope, action, requestDigestSha256, evaluatedAt }
  });
  if (parsed.disposition !== 'allow') throw new TypeError();
}

function parseSubmitIdentities(
  input: ApplicationSubmitIdentityAssignment,
  formVersion: FormVersionDto,
  answers: ApplicationAnswerIndexDto
): ApplicationSubmitIdentityAssignment {
  try {
    const parsed = {
      submissionId: intakeIdSchema.parse(input.submissionId),
      submitEvidenceId: intakeIdSchema.parse(input.submitEvidenceId),
      personId: intakeIdSchema.parse(input.personId),
      participantIdentityId: intakeIdSchema.parse(input.participantIdentityId),
      participantEvidenceId: intakeIdSchema.parse(input.participantEvidenceId),
      consentEvidenceIds: input.consentEvidenceIds.map((entry) => ({
        fieldId: intakeIdSchema.parse(entry.fieldId),
        evidenceId: intakeIdSchema.parse(entry.evidenceId)
      })).sort((left, right) => compareCanonicalText(left.fieldId, right.fieldId))
    };
    const allIds = [
      parsed.submissionId, parsed.submitEvidenceId, parsed.personId,
      parsed.participantIdentityId, parsed.participantEvidenceId,
      ...parsed.consentEvidenceIds.map((entry) => entry.evidenceId)
    ];
    if (new Set(allIds).size !== allIds.length) throw new TypeError();
    const fieldById = new Map(formVersion.definition.fields.map((field) => [field.id, field]));
    const consentFieldIds = answers.filter((answer) => {
      const field = fieldById.get(answer.fieldId);
      return answer.kind === 'checkbox' && answer.checked && field?.purpose.kind === 'consent';
    }).map((answer) => answer.fieldId).sort(compareCanonicalText);
    const assignedFieldIds = parsed.consentEvidenceIds.map((entry) => entry.fieldId);
    if (consentFieldIds.length !== assignedFieldIds.length
        || consentFieldIds.some((id, index) => id !== assignedFieldIds[index])) throw new TypeError();
    return deepFreeze(parsed);
  } catch {
    throw new ApplicationPlanningError('invalid_submission_identity');
  }
}

function formVersionDigest(version: FormVersionDto): string {
  return sha256(formVersionSchema.parse(version));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) throw new TypeError();
}

function positiveVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError();
  return value;
}
