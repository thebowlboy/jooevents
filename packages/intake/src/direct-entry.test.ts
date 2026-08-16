import { describe, expect, test } from 'bun:test';
import {
  applyFormMutationPlan,
  planFormCreation,
  planFormLifecycleChange
} from './forms';
import {
  DIRECT_ENTRY_CLOSE_POLICY,
  parseApplicationDirectEntryPlan,
  planApplicationDirectEntry,
  submissionDirectEntryAnswerOwner,
  validateApplicationDirectEntryPlanAgainstForm,
  type ApplicationDirectEntryPlan
} from './direct-entry';
import type { ApplicationAnswerPayloadReferenceVerifier } from './submissions';
import {
  fixtureAt,
  fixtureCatalog,
  fixtureCollection,
  fixtureCreateDraft,
  fixtureDigest,
  fixtureId,
  fixtureIds,
  fixtureRegistry
} from './test-fixtures';
import type { ApplicationAnswerIndexDto } from '@jooevents/contracts';

const identities = Object.freeze({
  submissionId: fixtureIds.submission,
  submitEvidenceId: fixtureIds.submitEvidence,
  personId: fixtureIds.person,
  participantIdentityId: fixtureIds.participantIdentity,
  participantEvidenceId: fixtureIds.participantEvidence,
  consentEvidenceIds: [] as const
});

const enteredByUserId = fixtureIds.user;
const submittedAt = fixtureAt.submit;
const requestDigestSha256 = fixtureDigest('direct-entry-request');

const acceptAllPayloads: ApplicationAnswerPayloadReferenceVerifier = Object.freeze({
  verifyApplicationAnswerPayload: () => true
});

function firstOpen() {
  const creation = planFormCreation({
    catalog: fixtureCatalog,
    registry: fixtureRegistry,
    authorInput: fixtureCreateDraft(),
    identities: { formId: fixtureIds.form, rules: [] },
    references: fixtureCollection,
    deadlineContribution: null,
    server: { createdByUserId: fixtureIds.user, createdAt: fixtureAt.create }
  });
  const catalog = applyFormMutationPlan({
    catalog: fixtureCatalog,
    registry: fixtureRegistry,
    plan: creation,
    references: fixtureCollection
  }).catalog;
  const lifecycle = planFormLifecycleChange({
    head: creation.after,
    registry: fixtureRegistry,
    existingVersions: [],
    authorInput: {
      transition: 'publish_and_open',
      formId: fixtureIds.form,
      expectedDefinitionVersion: creation.after.version,
      expectedRegistryVersion: fixtureRegistry.version
    },
    references: fixtureCollection,
    server: {
      formVersionId: fixtureIds.version,
      updatedByUserId: fixtureIds.user,
      updatedAt: fixtureAt.publish
    }
  });
  const applied = applyFormMutationPlan({
    catalog,
    registry: fixtureRegistry,
    plan: lifecycle,
    references: fixtureCollection,
    existingVersions: []
  });
  if (!applied.publishedVersion) throw new TypeError('expected_published_version');
  return { head: lifecycle.after, version: applied.publishedVersion };
}

function governedAnswers(overrides: {
  readonly dropTitle?: boolean;
  readonly dropEmail?: boolean;
  readonly withConsent?: boolean;
} = {}): ApplicationAnswerIndexDto {
  const entries = [
    ...(overrides.dropTitle ? [] : [{
      kind: 'text' as const,
      fieldId: fixtureIds.title,
      value: { payloadRef: { id: fixtureId(0x900) } }
    }]),
    ...(overrides.dropEmail ? [] : [{
      kind: 'email' as const,
      fieldId: fixtureIds.email,
      value: { payloadRef: { id: fixtureId(0x901) } }
    }]),
    { kind: 'select' as const, fieldId: fixtureIds.track, choiceId: fixtureIds.trackAi },
    ...(overrides.withConsent
      ? [{ kind: 'checkbox' as const, fieldId: fixtureIds.consent, checked: true }]
      : [])
  ];
  return entries.sort((left, right) =>
    left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0
  ) as ApplicationAnswerIndexDto;
}

function planEntry(
  flow = firstOpen(),
  answers = governedAnswers()
): ApplicationDirectEntryPlan {
  return planApplicationDirectEntry({
    formHead: flow.head,
    formVersion: flow.version,
    collection: fixtureCollection,
    answers,
    identities,
    enteredByUserId,
    requestDigestSha256,
    server: { submittedAt }
  });
}

describe('direct entry planner', () => {
  test('plans an immutable evidence pair bound to the server clock and operator attribution', () => {
    const flow = firstOpen();
    const plan = planEntry(flow);
    expect(plan.submission).toMatchObject({
      source: 'direct_entry',
      status: 'submitted',
      version: 1,
      id: fixtureIds.submission,
      submitEvidenceId: fixtureIds.submitEvidence,
      primaryPersonId: fixtureIds.person,
      submittedAt
    });
    expect(plan.entryEvidence).toMatchObject({
      enteredByUserId,
      submissionId: plan.submission.id,
      formVersionId: flow.version.id,
      submittedAt
    });
    expect(plan.participant.recordedAt).toBe(submittedAt);
    expect(plan.entryEvidence.authorityPartitionDigestSha256).toBe(
      submissionDirectEntryAnswerOwner({
        scope: flow.version.scope,
        submissionId: plan.submission.id,
        entryEvidenceId: plan.entryEvidence.id,
        enteredByUserId
      }).authorityPartitionDigestSha256
    );
    expect(plan.entryEvidence.programVocabularyAnswerPins).toEqual([{
      fieldId: fixtureIds.track,
      source: 'tracks',
      itemId: fixtureIds.trackAi,
      itemVersion: 5,
      label: 'Applied AI'
    }]);
    expect(plan.closeEvidence).toBeNull();
    expect(parseApplicationDirectEntryPlan(structuredClone(plan))).toEqual(plan);
    expect(validateApplicationDirectEntryPlanAgainstForm({
      plan: structuredClone(plan),
      formHead: flow.head,
      formVersion: flow.version,
      collection: fixtureCollection,
      payloadReferences: acceptAllPayloads
    })).toEqual(plan);
  });

  test('guarantees title and email and refuses consent transcription', () => {
    const flow = firstOpen();
    expect(() => planEntry(flow, governedAnswers({ dropTitle: true })))
      .toThrow('direct_entry_title_required');
    expect(() => planEntry(flow, governedAnswers({ dropEmail: true })))
      .toThrow('direct_entry_email_required');
    expect(() => planEntry(flow, governedAnswers({ withConsent: true })))
      .toThrow('invalid_answers');
  });

  test('refuses a closed or superseded form at planning and at revalidation', () => {
    const flow = firstOpen();
    const closedHead = { ...flow.head, status: 'closed' as const };
    expect(() => planApplicationDirectEntry({
      formHead: closedHead,
      formVersion: flow.version,
      collection: fixtureCollection,
      answers: governedAnswers(),
      identities,
      enteredByUserId,
      requestDigestSha256,
      server: { submittedAt }
    })).toThrow('form_not_open');
    const plan = planEntry(flow);
    expect(() => validateApplicationDirectEntryPlanAgainstForm({
      plan: structuredClone(plan),
      formHead: closedHead,
      formVersion: flow.version,
      collection: fixtureCollection,
      payloadReferences: acceptAllPayloads
    })).toThrow('form_not_open');
    expect(() => validateApplicationDirectEntryPlanAgainstForm({
      plan: structuredClone(plan),
      formHead: { ...flow.head, version: flow.head.version + 1 },
      formVersion: flow.version,
      collection: fixtureCollection,
      payloadReferences: acceptAllPayloads
    })).toThrow('form_version_mismatch');
    expect(() => validateApplicationDirectEntryPlanAgainstForm({
      plan: structuredClone(plan),
      formHead: flow.head,
      formVersion: flow.version,
      collection: fixtureCollection,
      payloadReferences: { verifyApplicationAnswerPayload: () => false }
    })).toThrow('invalid_answers');
  });

  test('a backdated or internally shifted submittedAt cannot rehydrate', () => {
    const plan = planEntry();
    const shiftedEvidence = structuredClone(plan) as {
      entryEvidence: { submittedAt: string };
    };
    shiftedEvidence.entryEvidence.submittedAt = '2020-01-01T00:00:00.000Z';
    expect(() => parseApplicationDirectEntryPlan(shiftedEvidence)).toThrow('invalid_plan');
    const shiftedHead = structuredClone(plan) as {
      submission: { submittedAt: string };
      entryEvidence: { submittedAt: string };
    };
    shiftedHead.submission.submittedAt = '2020-01-01T00:00:00.000Z';
    shiftedHead.entryEvidence.submittedAt = '2020-01-01T00:00:00.000Z';
    // participant.recordedAt still binds the original instant, so the pair refuses.
    expect(() => parseApplicationDirectEntryPlan(shiftedHead)).toThrow('invalid_plan');
    const reSourced = structuredClone(plan) as { submission: { source: string } };
    reSourced.submission.source = 'public_form';
    expect(() => parseApplicationDirectEntryPlan(reSourced)).toThrow('invalid_plan');
  });

  test('close policy identity is versioned and stable', () => {
    expect(DIRECT_ENTRY_CLOSE_POLICY).toEqual({
      key: 'intake.form.availability_deadline',
      version: 1
    });
  });
});
