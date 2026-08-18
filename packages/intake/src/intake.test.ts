import { describe, expect, test } from 'bun:test';
import {
  applyFormMutationPlan,
  FormPlanningError,
  parseFormMutationPlan,
  planFormCreation,
  planFormLifecycleChange,
  planFormRevision,
  validateFormMutationPlan
} from './forms';
import {
  analyzeFormComposition,
  projectOrganizerFormDetail,
  projectServedPublicForm
} from './model';
import {
  answerIndexDigest,
  pinProgramVocabularyAnswers,
  validateGovernedAnswerIndex
} from './answers';
import {
  planApplicationSubmit,
  type ApplicationCollectionSource
} from './submissions';
import {
  PUBLIC_INPUT_POLICY_ACTION,
  evaluatePublicInputPolicy,
  issuePublicInputPolicyEvaluator
} from './input-policy';
import {
  fixtureAt,
  fixtureCatalog,
  fixtureCollection,
  fixtureCreateDraft,
  fixtureDigest,
  fixtureId,
  fixtureIds,
  fixtureRegistry,
  fixtureScope
} from './test-fixtures';
import type {
  ApplicationDraftHeadDto,
  ApplicationDraftRevisionDto,
  FormDeadlineReferencePinDto,
  FormDefinitionHeadDto,
  FormVersionDto
} from '@jooevents/contracts';

const references = fixtureCollection;

function createPlan() {
  return planFormCreation({
    catalog: fixtureCatalog,
    registry: fixtureRegistry,
    authorInput: fixtureCreateDraft(),
    identities: { formId: fixtureIds.form, rules: [] },
    references,
    deadlineContribution: null,
    server: { createdByUserId: fixtureIds.user, createdAt: fixtureAt.create }
  });
}

function firstOpen() {
  const creation = createPlan();
  const catalog = applyFormMutationPlan({
    catalog: fixtureCatalog,
    registry: fixtureRegistry,
    plan: creation,
    references
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
    references,
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
    references,
    existingVersions: []
  });
  if (!applied.publishedVersion) throw new TypeError('expected_published_version');
  return { creation, lifecycle, head: lifecycle.after, version: applied.publishedVersion };
}

describe('canonical Form and Registry model', () => {
  test('head stores composition while publication materializes immutable current Registry truth', () => {
    const flow = firstOpen();
    expect('fields' in flow.head.definition).toBe(false);
    expect(flow.version.registryPin).toEqual({
      version: fixtureRegistry.version,
      digestSha256: fixtureRegistry.registryDigestSha256
    });
    expect(flow.version.definition.fields.map((field) => field.id)).toEqual(
      fixtureRegistry.fields.map((field) => field.id)
    );
    const email = flow.version.definition.fields.find((field) => field.mapsTo === 'person.email');
    expect(email).toMatchObject({ kind: 'email', required: false });
    expect(flow.version.definition.fields.find((field) => field.id === fixtureIds.consent)?.purpose)
      .toEqual({ kind: 'consent', key: 'recording_release' });
    expect(flow.version.definition.fields.find((field) => field.id === fixtureIds.ordinaryCheckbox)?.purpose)
      .toEqual({ kind: 'ordinary' });
    expect(parseFormMutationPlan(structuredClone(flow.lifecycle))).toEqual(flow.lifecycle);
  });

  test('locked email inclusion is structural but requiredness remains organizer-overridable', () => {
    const allowed = analyzeFormComposition({
      formId: fixtureIds.form,
      definition: createPlan().after.definition,
      registry: fixtureRegistry
    });
    expect(allowed.issues).toEqual([]);
    expect(allowed.fields.find((row) => row.field.mapsTo === 'person.email')?.required).toBe(false);

    const excludedEmail = fixtureCreateDraft({
      composition: {
        excludedFieldIds: [fixtureIds.email],
        requiredOverrides: {},
        optionExposure: {}
      }
    });
    expect(() => planFormCreation({
      catalog: fixtureCatalog,
      registry: fixtureRegistry,
      authorInput: excludedEmail,
      identities: { formId: fixtureIds.form, rules: [] },
      references,
      deadlineContribution: null,
      server: { createdByUserId: fixtureIds.user, createdAt: fixtureAt.create }
    })).toThrow('invalid_definition');
  });

  test('organizer projection joins current Registry without rewriting an immutable FormVersion', () => {
    const flow = firstOpen();
    const changedRegistry = {
      ...fixtureRegistry,
      version: fixtureRegistry.version + 1,
      registryDigestSha256: 'b'.repeat(64),
      fields: fixtureRegistry.fields.map((field) => field.id === fixtureIds.title
        ? { ...field, label: 'Current title label', version: field.version + 1 }
        : field)
    };
    const detail = projectOrganizerFormDetail({
      head: flow.head,
      registry: changedRegistry,
      references,
      currentPublishedVersion: flow.version
    });
    expect(detail.fields.find((row) => row.field.id === fixtureIds.title)?.field.label)
      .toBe('Current title label');
    expect(detail.currentPublishedVersion?.definition.fields.find((field) =>
      field.id === fixtureIds.title)?.label).toBe('Title');
  });

  test('revisions require the exact Registry pin and preserve rule identities', () => {
    const creation = createPlan();
    const revision = planFormRevision({
      head: creation.after,
      registry: fixtureRegistry,
      authorInput: {
        formId: fixtureIds.form,
        expectedDefinitionVersion: creation.after.version,
        expectedRegistryVersion: fixtureRegistry.version,
        definition: {
          ...creation.after.definition,
          name: 'Revised CFP',
          rules: []
        }
      },
      identities: { formId: fixtureIds.form, rules: [] },
      references,
      server: { updatedByUserId: fixtureIds.user, updatedAt: fixtureAt.publish }
    });
    expect(revision.after.definition.name).toBe('Revised CFP');
    expect(validateFormMutationPlan({
      catalog: { ...fixtureCatalog, version: 2, heads: [creation.after] },
      registry: fixtureRegistry,
      plan: revision,
      references
    })).toBeUndefined();
    expect(() => planFormRevision({
      head: creation.after,
      registry: fixtureRegistry,
      authorInput: {
        formId: fixtureIds.form,
        expectedDefinitionVersion: creation.after.version,
        expectedRegistryVersion: fixtureRegistry.version + 1,
        definition: creation.after.definition
      },
      identities: { formId: fixtureIds.form, rules: [] },
      references,
      server: { updatedByUserId: fixtureIds.user, updatedAt: fixtureAt.publish }
    })).toThrow('stale_registry');
  });
});

describe('live references and immutable answer evidence', () => {
  test('PV options are live at serve time while subset exposure and selected label evidence stay exact', () => {
    const flow = firstOpen();
    const served = projectServedPublicForm({
      version: flow.version,
      optionSource: fixtureCollection,
      references
    });
    const track = served.fields.find((field) => field.id === fixtureIds.track);
    expect(track).toMatchObject({
      kind: 'select',
      options: [{ id: fixtureIds.trackAi, label: 'Applied AI', position: 0 }]
    });
    const answers = [
      { kind: 'select' as const, fieldId: fixtureIds.track, choiceId: fixtureIds.trackAi },
      { kind: 'checkbox' as const, fieldId: fixtureIds.consent, checked: true }
    ];
    const pins = pinProgramVocabularyAnswers({
      answers,
      formVersion: flow.version,
      optionSource: fixtureCollection
    });
    expect(pins).toEqual([{
      fieldId: fixtureIds.track,
      source: 'tracks',
      itemId: fixtureIds.trackAi,
      itemVersion: 5,
      label: 'Applied AI'
    }]);
    expect(() => validateGovernedAnswerIndex({
      answers: [{ kind: 'select', fieldId: fixtureIds.track, choiceId: fixtureIds.trackWeb }],
      formVersion: flow.version,
      optionSource: fixtureCollection,
      mode: 'draft'
    })).toThrow('unknown_choice');
  });

  test('session target fails closed until an exact collecting-session owner is mounted', () => {
    const draft = fixtureCreateDraft({ target: { kind: 'session', sessionId: fixtureIds.session } });
    expect(() => planFormCreation({
      catalog: fixtureCatalog,
      registry: fixtureRegistry,
      authorInput: draft,
      identities: { formId: fixtureIds.form, rules: [] },
      references,
      deadlineContribution: null,
      server: { createdByUserId: fixtureIds.user, createdAt: fixtureAt.create }
    })).toThrow('session_unavailable');
  });

  test('public serve re-resolves active target and Deadline and preserves historical pins', () => {
    const flow = firstOpen();
    const deadlinePin: FormDeadlineReferencePinDto = {
      id: fixtureIds.deadline,
      version: 3,
      digestSha256: 'd'.repeat(64),
      effectiveAt: '2026-09-01T16:00:00.000Z',
      displayDate: '2026-09-01',
      eventTimezone: 'America/New_York',
      gracePolicy: 'soft'
    };
    const version: FormVersionDto = {
      ...flow.version,
      definition: {
        ...flow.version.definition,
        availability: { kind: 'deadline', deadlineId: fixtureIds.deadline }
      },
      deadlinePin
    };
    expect(() => projectServedPublicForm({
      version,
      optionSource: fixtureCollection,
      references
    })).toThrow('deadline_unavailable');
    const live: ApplicationCollectionSource = {
      ...fixtureCollection,
      resolveCurrentDeadline() { return { ...deadlinePin, version: 4, digestSha256: 'e'.repeat(64) }; }
    };
    expect(projectServedPublicForm({ version, optionSource: live, references: live }).availability)
      .toEqual({
        kind: 'closes', effectiveAt: '2026-09-01T16:00:00.000Z',
        eventTimezone: 'America/New_York', gracePolicy: 'soft'
      });
    expect(version.deadlinePin).toEqual(deadlinePin);

    const retained = {
      ...version,
      deadlinePin: Object.fromEntries(
        Object.entries(deadlinePin).filter(([key]) => key !== 'eventTimezone')
      ) as FormDeadlineReferencePinDto
    };
    const retainedLive: ApplicationCollectionSource = {
      ...fixtureCollection,
      resolveCurrentDeadline() { return retained.deadlinePin!; }
    };
    expect(projectServedPublicForm({
      version: retained, optionSource: retainedLive, references: retainedLive
    }).availability).toEqual({
      kind: 'closes', effectiveAt: '2026-09-01T16:00:00.000Z', gracePolicy: 'soft'
    });
  });
});

describe('submission evidence', () => {
  test('submit pins the exact live PV item and records only explicit consent semantics', () => {
    const flow = firstOpen();
    const answers = [
      { kind: 'select' as const, fieldId: fixtureIds.track, choiceId: fixtureIds.trackAi },
      { kind: 'checkbox' as const, fieldId: fixtureIds.consent, checked: true },
      { kind: 'checkbox' as const, fieldId: fixtureIds.ordinaryCheckbox, checked: true }
    ];
    const authorityPartition = fixtureDigest('partition');
    const requestDigest = fixtureDigest('submit');
    const draft: ApplicationDraftHeadDto = {
      schemaVersion: 1,
      id: fixtureIds.draft,
      scope: fixtureScope,
      formId: fixtureIds.form,
      formVersionId: flow.version.id,
      authorityPartitionDigestSha256: authorityPartition,
      version: 1,
      currentRevisionId: fixtureIds.revision1,
      status: 'in_progress',
      submittedSubmissionId: null,
      createdAt: fixtureAt.save,
      updatedAt: fixtureAt.save
    };
    const revision: ApplicationDraftRevisionDto = {
      schemaVersion: 1,
      id: fixtureIds.revision1,
      draftId: draft.id,
      version: 1,
      sourceExpectedDraftVersion: 0,
      requestDigestSha256: fixtureDigest('save'),
      answersDigestSha256: fixtureDigest(answers),
      answers,
      admissibilityDeadlinePin: null,
      inputPolicy: {
        schemaVersion: 1,
        evaluationId: fixtureIds.policySave,
        policy: { key: 'input.allow', version: 1 },
        disposition: 'allow',
        reasonCode: null,
        remedyCode: null,
        requestDigestSha256: fixtureDigest('save'),
        evaluatedAt: fixtureAt.save,
        evidenceDigestSha256: 'f'.repeat(64)
      },
      savedAt: fixtureAt.save
    };
    // The exact digest is domain-derived; use the parser-produced value from the public helper.
    const currentRevision = { ...revision, answersDigestSha256: answerIndexDigest(answers) };
    const evaluator = issuePublicInputPolicyEvaluator({
      policy: { key: 'input.allow', version: 1 },
      issueEvaluationId: () => fixtureIds.policySubmit,
      decide: () => ({ disposition: 'allow', reasonCode: null, remedyCode: null })
    });
    const inputPolicy = evaluatePublicInputPolicy(evaluator, {
      scope: fixtureScope,
      action: PUBLIC_INPUT_POLICY_ACTION.submit,
      requestDigestSha256: requestDigest,
      evaluatedAt: fixtureAt.submit
    });
    const plan = planApplicationSubmit({
      formHead: flow.head,
      formVersion: flow.version,
      collection: fixtureCollection,
      draftHead: draft,
      currentRevision,
      expectedDraftVersion: 1,
      expectedAuthorityPartitionDigestSha256: authorityPartition,
      requestDigestSha256: requestDigest,
      inputPolicy,
      identities: {
        submissionId: fixtureIds.submission,
        submitEvidenceId: fixtureIds.submitEvidence,
        personId: fixtureIds.person,
        participantIdentityId: fixtureIds.participantIdentity,
        participantEvidenceId: fixtureIds.participantEvidence,
        consentEvidenceIds: [{
          fieldId: fixtureIds.consent,
          evidenceId: fixtureIds.consentEvidence
        }]
      },
      server: { submittedAt: fixtureAt.submit }
    });
    expect(plan.submitEvidence.programVocabularyAnswerPins).toEqual([{
      fieldId: fixtureIds.track,
      source: 'tracks',
      itemId: fixtureIds.trackAi,
      itemVersion: 5,
      label: 'Applied AI'
    }]);
    expect(plan.consents.map((consent) => consent.fieldId)).toEqual([fixtureIds.consent]);
  });
});
