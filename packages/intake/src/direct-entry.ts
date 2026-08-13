import { createHash } from 'node:crypto';
import {
  intakeDigestSchema,
  intakeIdSchema,
  intakeInstantSchema,
  submissionDirectEntryEvidenceSchema,
  submissionHeadSchema,
  submissionParticipantEvidenceSchema,
  type ApplicationAnswerIndexDto,
  type FormDefinitionHeadDto,
  type FormDeadlineReferencePinDto,
  type FormTarget,
  type FormTargetReferencePinDto,
  type FormVersionDto,
  type SubmissionDirectEntryEvidenceDto,
  type SubmissionHeadDto,
  type SubmissionParticipantEvidenceDto
} from '@jooevents/contracts';
import {
  submissionArrivalCloseEvidenceSchema
} from '@jooevents/contracts/submission-triage';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';
import {
  ApplicationAnswerError,
  answerIndexDigest,
  pinProgramVocabularyAnswers,
  validateGovernedAnswerIndex,
  type ApplicationAnswerOwner
} from './answers';
import {
  compareCanonicalText,
  deepFreeze,
  parseFormDefinitionHead,
  parseFormVersion,
  parseSubmissionHead,
  sameIntakeScope
} from './model';
import {
  ApplicationPlanningError,
  type ApplicationAnswerPayloadReferenceVerifier,
  type ApplicationCollectionSource,
  type ApplicationSubmitIdentityAssignment
} from './submissions';

export type SubmissionArrivalCloseEvidence =
  z.infer<typeof submissionArrivalCloseEvidenceSchema>;

/** Versioned identity of the accepting-close policy a direct entry records. */
export const DIRECT_ENTRY_CLOSE_POLICY = Object.freeze({
  key: 'intake.form.availability_deadline',
  version: 1
});

/**
 * A direct entry has no public draft chain. The submission head and the entry
 * evidence identities bind its governed answer payloads, and the partition
 * digest binds them to the operator who keyed the record in.
 */
export function submissionDirectEntryAnswerOwner(input: {
  readonly scope: FormVersionDto['scope'];
  readonly submissionId: string;
  readonly entryEvidenceId: string;
  readonly enteredByUserId: string;
}): ApplicationAnswerOwner {
  const submissionId = intakeIdSchema.parse(input.submissionId);
  return deepFreeze({
    draftId: submissionId,
    revisionId: intakeIdSchema.parse(input.entryEvidenceId),
    authorityPartitionDigestSha256: sha256({
      schemaVersion: 1,
      kind: 'intake.direct_entry',
      scope: input.scope,
      enteredByUserId: intakeIdSchema.parse(input.enteredByUserId),
      submissionId
    })
  });
}

export interface ApplicationDirectEntryPlan {
  readonly action: 'direct_entry';
  readonly formDefinitionVersion: number;
  readonly formVersionDigestSha256: string;
  readonly submission: SubmissionHeadDto;
  readonly entryEvidence: SubmissionDirectEntryEvidenceDto;
  readonly participant: SubmissionParticipantEvidenceDto;
  readonly closeEvidence: SubmissionArrivalCloseEvidence | null;
}

export function applicationDirectEntryPlanDigest(plan: ApplicationDirectEntryPlan): string {
  return sha256(plan);
}

export function planApplicationDirectEntry(input: {
  readonly formHead: FormDefinitionHeadDto;
  readonly formVersion: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly answers: ApplicationAnswerIndexDto;
  readonly identities: ApplicationSubmitIdentityAssignment;
  readonly enteredByUserId: string;
  readonly requestDigestSha256: string;
  readonly server: { readonly submittedAt: string };
}): ApplicationDirectEntryPlan {
  const head = parseFormDefinitionHead(input.formHead);
  const version = parseFormVersion(input.formVersion);
  assertFormMayAcceptDirectEntry(head, version);
  assertDirectEntryAnswers(input.answers, version, input.collection);
  assertRequiredIdentityAnswers(input.answers, version);
  const identities = parseDirectEntryIdentities(input.identities);
  const enteredByUserId = intakeIdSchema.parse(input.enteredByUserId);
  const submittedAt = intakeInstantSchema.parse(input.server.submittedAt);
  const requestDigestSha256 = intakeDigestSchema.parse(input.requestDigestSha256);
  const { deadlinePin } = resolveDirectEntryReferences(version, input.collection);
  const owner = submissionDirectEntryAnswerOwner({
    scope: version.scope,
    submissionId: identities.submissionId,
    entryEvidenceId: identities.submitEvidenceId,
    enteredByUserId
  });
  const programVocabularyAnswerPins = pinProgramVocabularyAnswers({
    answers: input.answers,
    formVersion: version,
    optionSource: input.collection,
    mode: 'direct_entry'
  });
  const entryEvidence = submissionDirectEntryEvidenceSchema.parse({
    schemaVersion: 1,
    id: identities.submitEvidenceId,
    submissionId: identities.submissionId,
    formVersionId: version.id,
    enteredByUserId,
    authorityPartitionDigestSha256: owner.authorityPartitionDigestSha256,
    requestDigestSha256,
    answerIndexDigestSha256: answerIndexDigest(input.answers),
    answers: input.answers,
    programVocabularyAnswerPins,
    submittedAt
  });
  const submission = submissionHeadSchema.parse({
    schemaVersion: 1,
    id: identities.submissionId,
    scope: version.scope,
    formId: version.formId,
    formVersionId: version.id,
    source: 'direct_entry',
    status: 'submitted',
    version: 1,
    submitEvidenceId: entryEvidence.id,
    primaryPersonId: identities.personId,
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
  return deepFreeze({
    action: 'direct_entry',
    formDefinitionVersion: head.version,
    formVersionDigestSha256: formVersionDigest(version),
    submission,
    entryEvidence,
    participant,
    closeEvidence: directEntryCloseEvidence(deadlinePin)
  });
}

/** Rehydrates persisted exact-plan evidence without normalization or unknown keys. */
export function parseApplicationDirectEntryPlan(value: unknown): ApplicationDirectEntryPlan {
  try {
    const root = exactRecord(value);
    assertExactKeys(root, [
      'action', 'formDefinitionVersion', 'formVersionDigestSha256',
      'submission', 'entryEvidence', 'participant', 'closeEvidence'
    ]);
    if (root.action !== 'direct_entry') throw new TypeError();
    const plan: ApplicationDirectEntryPlan = {
      action: 'direct_entry',
      formDefinitionVersion: positiveVersion(root.formDefinitionVersion),
      formVersionDigestSha256: intakeDigestSchema.parse(root.formVersionDigestSha256),
      submission: parseSubmissionHead(root.submission),
      entryEvidence: submissionDirectEntryEvidenceSchema.parse(root.entryEvidence),
      participant: submissionParticipantEvidenceSchema.parse(root.participant),
      closeEvidence: root.closeEvidence === null
        ? null
        : submissionArrivalCloseEvidenceSchema.parse(root.closeEvidence)
    };
    assertDirectEntryPlanShape(plan);
    return deepFreeze(plan);
  } catch {
    throw new ApplicationPlanningError('invalid_plan');
  }
}

/** Revalidates exact plan evidence immediately before the transaction writes. */
export function validateApplicationDirectEntryPlanAgainstForm(input: {
  readonly plan: unknown;
  readonly formHead: FormDefinitionHeadDto;
  readonly formVersion: FormVersionDto;
  readonly collection: ApplicationCollectionSource;
  readonly payloadReferences: ApplicationAnswerPayloadReferenceVerifier;
}): ApplicationDirectEntryPlan {
  const plan = parseApplicationDirectEntryPlan(input.plan);
  const head = parseFormDefinitionHead(input.formHead);
  const version = parseFormVersion(input.formVersion);
  assertFormMayAcceptDirectEntry(head, version);
  if (plan.formDefinitionVersion !== head.version
      || plan.formVersionDigestSha256 !== formVersionDigest(version)
      || plan.submission.formId !== head.id
      || plan.submission.formVersionId !== version.id
      || !sameIntakeScope(plan.submission.scope, head.scope)) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
  assertDirectEntryAnswers(plan.entryEvidence.answers, version, input.collection);
  assertRequiredIdentityAnswers(plan.entryEvidence.answers, version);
  verifyDirectEntryPayloadReferences({ plan, version, verifier: input.payloadReferences });
  const pins = pinProgramVocabularyAnswers({
    answers: plan.entryEvidence.answers,
    formVersion: version,
    optionSource: input.collection,
    mode: 'direct_entry'
  });
  if (sha256(pins) !== sha256(plan.entryEvidence.programVocabularyAnswerPins)) {
    throw new ApplicationPlanningError('invalid_answers');
  }
  const { deadlinePin } = resolveDirectEntryReferences(version, input.collection);
  if (sha256(directEntryCloseEvidence(deadlinePin)) !== sha256(plan.closeEvidence)) {
    throw new ApplicationPlanningError('deadline_changed');
  }
  return plan;
}

function assertFormMayAcceptDirectEntry(
  head: FormDefinitionHeadDto,
  version: FormVersionDto
): void {
  if (!sameIntakeScope(head.scope, version.scope) || head.id !== version.formId) {
    throw new ApplicationPlanningError('wrong_scope');
  }
  if (head.status !== 'open') throw new ApplicationPlanningError('form_not_open');
  if (head.currentPublishedVersionId !== version.id) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
}

function assertDirectEntryAnswers(
  answers: ApplicationAnswerIndexDto,
  version: FormVersionDto,
  collection: ApplicationCollectionSource
): void {
  try {
    validateGovernedAnswerIndex({
      answers, formVersion: version, optionSource: collection, mode: 'direct_entry'
    });
  } catch (error) {
    if (error instanceof ApplicationAnswerError) {
      throw new ApplicationPlanningError('invalid_answers', error);
    }
    throw error;
  }
}

/**
 * Title is the row's identity everywhere and a titleless submission is never a
 * review candidate; people are keyed by email. Both are guaranteed at entry.
 */
function assertRequiredIdentityAnswers(
  answers: ApplicationAnswerIndexDto,
  version: FormVersionDto
): void {
  const titleField = version.definition.fields.find((field) =>
    field.mapsTo === 'talk.title' && field.kind === 'text'
  );
  if (!titleField || !answers.some((answer) =>
    answer.fieldId === titleField.id && answer.kind === 'text'
  )) {
    throw new ApplicationPlanningError('direct_entry_title_required');
  }
  const emailField = version.definition.fields.find((field) =>
    field.mapsTo === 'person.email' && field.kind === 'email'
  );
  if (!emailField || !answers.some((answer) =>
    answer.fieldId === emailField.id && answer.kind === 'email'
  )) {
    throw new ApplicationPlanningError('direct_entry_email_required');
  }
}

function resolveDirectEntryReferences(
  version: FormVersionDto,
  collection: ApplicationCollectionSource
): {
  readonly targetPin: FormTargetReferencePinDto | null;
  readonly deadlinePin: FormDeadlineReferencePinDto | null;
} {
  const target: FormTarget = version.definition.target;
  let targetPin: FormTargetReferencePinDto | null = null;
  if (target.kind === 'category') {
    const pin = collection.resolveActiveCategory(version.scope, target);
    if (!pin || pin.kind !== 'category' || pin.id !== target.category.id
        || pin.categoryKind !== target.category.kind) {
      throw new ApplicationPlanningError('target_unavailable');
    }
    targetPin = pin;
  } else if (target.kind === 'session') {
    const pin = collection.resolveCollectingSession(version.scope, target);
    if (!pin || pin.kind !== 'session' || pin.id !== target.sessionId
        || pin.lifecycle !== 'collecting') {
      throw new ApplicationPlanningError('target_unavailable');
    }
    targetPin = pin;
  }
  if (version.definition.availability.kind === 'evergreen') {
    return deepFreeze({ targetPin, deadlinePin: null });
  }
  const pin = collection.resolveCurrentDeadline(
    version.scope, version.definition.availability
  );
  if (!pin || pin.id !== version.definition.availability.deadlineId) {
    throw new ApplicationPlanningError('deadline_unavailable');
  }
  return deepFreeze({ targetPin, deadlinePin: pin });
}

function directEntryCloseEvidence(
  deadlinePin: FormDeadlineReferencePinDto | null
): SubmissionArrivalCloseEvidence | null {
  if (deadlinePin === null) return null;
  return deepFreeze(submissionArrivalCloseEvidenceSchema.parse({
    closeAt: deadlinePin.effectiveAt,
    policy: {
      reference: { key: DIRECT_ENTRY_CLOSE_POLICY.key, version: DIRECT_ENTRY_CLOSE_POLICY.version },
      definitionDigestSha256: sha256(deadlinePin)
    }
  }));
}

function parseDirectEntryIdentities(
  input: ApplicationSubmitIdentityAssignment
): ApplicationSubmitIdentityAssignment {
  try {
    const parsed = {
      submissionId: intakeIdSchema.parse(input.submissionId),
      submitEvidenceId: intakeIdSchema.parse(input.submitEvidenceId),
      personId: intakeIdSchema.parse(input.personId),
      participantIdentityId: intakeIdSchema.parse(input.participantIdentityId),
      participantEvidenceId: intakeIdSchema.parse(input.participantEvidenceId),
      consentEvidenceIds: [] as const
    };
    // A direct entry never records consent on the speaker's behalf.
    if (input.consentEvidenceIds.length !== 0) throw new TypeError();
    const allIds = [
      parsed.submissionId, parsed.submitEvidenceId, parsed.personId,
      parsed.participantIdentityId, parsed.participantEvidenceId
    ];
    if (new Set(allIds).size !== allIds.length) throw new TypeError();
    return deepFreeze(parsed);
  } catch {
    throw new ApplicationPlanningError('invalid_submission_identity');
  }
}

function verifyDirectEntryPayloadReferences(input: {
  readonly plan: ApplicationDirectEntryPlan;
  readonly version: FormVersionDto;
  readonly verifier: ApplicationAnswerPayloadReferenceVerifier;
}): void {
  if (!input.verifier || typeof input.verifier.verifyApplicationAnswerPayload !== 'function') {
    throw new ApplicationPlanningError('invalid_answers');
  }
  const payloadRefIds = new Set<string>();
  for (const answer of input.plan.entryEvidence.answers) {
    if (!('value' in answer)) continue;
    if (payloadRefIds.has(answer.value.payloadRef.id)) {
      throw new ApplicationPlanningError('invalid_answers');
    }
    payloadRefIds.add(answer.value.payloadRef.id);
    const field = input.version.definition.fields.find(
      (candidate) => candidate.id === answer.fieldId
    );
    if (!field || field.kind !== answer.kind) throw new ApplicationPlanningError('invalid_answers');
    let verified = false;
    try {
      verified = input.verifier.verifyApplicationAnswerPayload({
        scope: input.plan.submission.scope,
        formVersionId: input.version.id,
        draftId: input.plan.submission.id,
        revisionId: input.plan.entryEvidence.id,
        authorityPartitionDigestSha256: input.plan.entryEvidence.authorityPartitionDigestSha256,
        field,
        answer
      });
    } catch {
      verified = false;
    }
    if (!verified) throw new ApplicationPlanningError('invalid_answers');
  }
}

function assertDirectEntryPlanShape(plan: ApplicationDirectEntryPlan): void {
  const { submission, entryEvidence: evidence, participant } = plan;
  const derivedOwner = submissionDirectEntryAnswerOwner({
    scope: submission.scope,
    submissionId: submission.id,
    entryEvidenceId: evidence.id,
    enteredByUserId: evidence.enteredByUserId
  });
  if (submission.source !== 'direct_entry'
      || submission.status !== 'submitted'
      || submission.version !== 1
      || submission.submitEvidenceId !== evidence.id
      || evidence.submissionId !== submission.id
      || evidence.formVersionId !== submission.formVersionId
      || evidence.submittedAt !== submission.submittedAt
      || evidence.answerIndexDigestSha256 !== answerIndexDigest(evidence.answers)
      || evidence.authorityPartitionDigestSha256 !== derivedOwner.authorityPartitionDigestSha256
      || participant.submissionId !== submission.id
      || participant.personId !== submission.primaryPersonId
      || participant.recordedAt !== submission.submittedAt) throw new TypeError();
  const evidenceIds = [
    submission.id, evidence.id, participant.id,
    participant.personId, participant.participantIdentityId
  ];
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new TypeError();
}

function formVersionDigest(version: FormVersionDto): string {
  return sha256(parseFormVersion(version));
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
