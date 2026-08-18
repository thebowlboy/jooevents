import { describe, expect, test } from 'bun:test';
import {
  FORM_LONG_TEXT_MAX_LENGTH,
  FORM_NAME_MAX_LENGTH,
  formDefinitionCreateDraftInputSchema,
  formDefinitionAuthorInputSchema,
  formDefinitionContentSchema,
  formLifecycleChangeDraftInputSchema,
  formVersionSchema,
  organizerFormCatalogSchema,
  organizerSubmissionAnswerSchema,
  organizerSubmissionContactSchema,
  organizerSubmissionDetailSchema,
  organizerPersonSubmissionPageSchema,
  organizerSubmissionSummarySchema,
  publicApplicationDraftBeginInputSchema,
  publicApplicationDraftSaveInputSchema,
  publicApplicationDraftStatusSchema,
  publicApplicationSubmitInputSchema,
  servedPublicFormSchema,
  submissionSubmitEvidenceSchema,
  transientApplicationAnswersInputSchema
} from './index';

const id = (suffix: number): string =>
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`;
const digest = (character = 'a'): string => character.repeat(64);
const registryPin = { version: 3, digestSha256: digest() };

function authorDefinition() {
  return {
    kind: 'cfp' as const,
    name: '  Main\tCFP  ',
    target: { kind: 'general_pool' as const },
    availability: { kind: 'evergreen' as const },
    confirmation: '  Thank you\r\nWe will reply.  ',
    composition: {
      excludedFieldIds: [],
      requiredOverrides: { [id(2)]: false },
      optionExposure: { [id(3)]: [id(30)] }
    },
    rules: []
  };
}

function versionField(overrides: Record<string, unknown> = {}) {
  return {
    id: id(2),
    sourceFieldVersion: 2,
    key: 'person.email',
    mapsTo: 'person.email' as const,
    purpose: { kind: 'ordinary' as const },
    answerOwner: 'person' as const,
    group: 'contact' as const,
    constraints: { removal: 'forbidden' as const, applyVisibility: 'required_visible' as const },
    kind: 'email' as const,
    label: 'Email',
    help: null,
    required: false,
    initiallyVisible: true,
    position: 0,
    maximumLength: 320 as const,
    options: { kind: 'none' as const },
    ...overrides
  };
}

function version() {
  const definition = {
    kind: 'cfp' as const,
    name: 'Main CFP',
    target: { kind: 'general_pool' as const },
    availability: { kind: 'evergreen' as const },
    confirmation: 'Thanks',
    fields: [versionField()],
    rules: []
  };
  return {
    schemaVersion: 1 as const,
    id: id(10),
    formId: id(1),
    scope: { workspaceId: id(50), eventId: id(51) },
    number: 1,
    sourceDefinitionVersion: 2,
    sourceDefinitionDigestSha256: digest('b'),
    registryPin,
    definitionDigestSha256: digest('c'),
    definition,
    targetPin: null,
    deadlinePin: null,
    publishedByUserId: id(52),
    publishedAt: '2026-08-12T12:00:00.000Z'
  };
}

describe('Forms contract boundary', () => {
  test('stores composition in the head and authenticates organizer joins to one Registry snapshot', () => {
    const summary = (suffix: number) => ({
      schemaVersion: 1 as const,
      id: id(suffix),
      name: `CFP ${suffix}`,
      target: { kind: 'general_pool' as const },
      availability: { kind: 'evergreen' as const },
      status: 'draft' as const,
      version: 1,
      currentPublishedVersionId: null,
      composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
      registryPin,
      closesAt: null,
      fieldCount: 2,
      configurationIssues: [],
      submissionCount: 0,
      updatedAt: '2026-08-12T12:00:00.000Z'
    });
    expect(organizerFormCatalogSchema.parse({
      schemaVersion: 1, catalogVersion: 3, registryPin,
      forms: [summary(1), summary(2)]
    })).toMatchObject({ registryPin, forms: [{ id: id(1) }, { id: id(2) }] });
    expect(organizerFormCatalogSchema.safeParse({
      schemaVersion: 1, catalogVersion: 3, registryPin,
      forms: [summary(2), summary(1)]
    }).success).toBe(false);
  });

  test('normalizes head prose but never accepts a copied field catalog', () => {
    const parsed = formDefinitionAuthorInputSchema.parse(authorDefinition());
    expect(parsed.name).toBe('Main CFP');
    expect(parsed.confirmation).toBe('Thank you\nWe will reply.');
    expect(formDefinitionContentSchema.safeParse(parsed).success).toBe(true);
    expect(formDefinitionContentSchema.safeParse({ ...parsed, fields: [] }).success).toBe(false);
    expect(formDefinitionAuthorInputSchema.safeParse({
      ...authorDefinition(), name: 'x'.repeat(FORM_NAME_MAX_LENGTH + 1)
    }).success).toBe(false);
  });

  test('accepts a close-date intent on create without trusting the browser with a Deadline id', () => {
    const draft = {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: 3,
      definition: {
        ...authorDefinition(),
        availability: { kind: 'fixed_close_date' as const, displayDate: '2027-01-15' }
      }
    };
    expect(formDefinitionCreateDraftInputSchema.parse(draft).definition.availability)
      .toEqual({ kind: 'fixed_close_date', displayDate: '2027-01-15' });
    expect(formDefinitionCreateDraftInputSchema.safeParse({
      ...draft,
      definition: {
        ...draft.definition,
        availability: { kind: 'deadline', deadlineId: id(99) }
      }
    }).success).toBe(false);
  });

  test('makes first-open Registry evidence explicit while ordinary lifecycle changes use null', () => {
    expect(formLifecycleChangeDraftInputSchema.parse({
      formId: id(1), expectedDefinitionVersion: 2,
      transition: 'publish_and_open', expectedRegistryVersion: 3
    })).toMatchObject({ transition: 'publish_and_open', expectedRegistryVersion: 3 });
    expect(formLifecycleChangeDraftInputSchema.parse({
      formId: id(1), expectedDefinitionVersion: 3,
      transition: 'close'
    })).toMatchObject({ transition: 'close' });
    expect(formLifecycleChangeDraftInputSchema.safeParse({
      formId: id(1), expectedDefinitionVersion: 3,
      transition: 'close', expectedRegistryVersion: 3
    }).success).toBe(false);
  });

  test('requires structurally locked mapped email in a published snapshot but permits optional email', () => {
    expect(formVersionSchema.safeParse(version()).success).toBe(true);
    expect(formVersionSchema.safeParse({
      ...version(),
      definition: { ...version().definition, fields: [versionField({ mapsTo: null })] }
    }).success).toBe(false);
    expect(formVersionSchema.safeParse({
      ...version(),
      definition: {
        ...version().definition,
        fields: [versionField({ constraints: { removal: 'allowed', applyVisibility: 'editable' } })]
      }
    }).success).toBe(false);
  });

  test('keeps Registry semantics and version pins private on the served projection', () => {
    const served = {
      schemaVersion: 1 as const,
      formId: id(1), formVersionId: id(10), formVersionNumber: 1,
      name: 'Main CFP', confirmation: 'Thanks',
      target: { kind: 'general_pool' as const },
      availability: { kind: 'evergreen' as const },
      fields: [{
        kind: 'email' as const, id: id(2), label: 'Email', help: null,
        required: false, initiallyVisible: true, position: 0, maximumLength: 320 as const
      }],
      rules: []
    };
    expect(servedPublicFormSchema.safeParse(served).success).toBe(true);
    const retainedClose = {
      ...served,
      availability: {
        kind: 'closes' as const,
        effectiveAt: '2026-11-02T05:00:00.000Z',
        gracePolicy: 'soft' as const
      }
    };
    expect(servedPublicFormSchema.safeParse(retainedClose).success).toBe(true);
    expect(servedPublicFormSchema.parse({
      ...retainedClose,
      availability: { ...retainedClose.availability, eventTimezone: 'America/New_York' }
    }).availability).toMatchObject({ eventTimezone: 'America/New_York' });
    expect(servedPublicFormSchema.safeParse({
      ...served,
      fields: [{ ...served.fields[0], mapsTo: 'person.email', sourceFieldVersion: 2 }]
    }).success).toBe(false);
  });
});

describe('Submission transport contracts', () => {
  test('accept only untrusted selections and business values, never scope or participant ids', () => {
    expect(publicApplicationDraftBeginInputSchema.parse({ formId: id(1).toUpperCase() }))
      .toEqual({ formId: id(1) });
    expect(publicApplicationDraftSaveInputSchema.safeParse({
      expectedDraftVersion: 1, continuation: 'secret', answers: []
    }).success).toBe(false);
    expect(publicApplicationSubmitInputSchema.safeParse({
      expectedDraftVersion: 1, personId: id(3)
    }).success).toBe(false);
  });

  test('aligns answer kinds with Registry and keeps all scalar values governed durably', () => {
    const answers = transientApplicationAnswersInputSchema.parse([
      { kind: 'text', fieldId: id(1), value: '  My session  ' },
      { kind: 'textarea', fieldId: id(2), value: 'First\r\nSecond' },
      { kind: 'email', fieldId: id(3), value: '  me@example.com  ' },
      { kind: 'url', fieldId: id(4), value: ' https://example.com/talk ' },
      { kind: 'phone', fieldId: id(5), value: ' +65 6123 4567 ' },
      { kind: 'number', fieldId: id(6), value: 42 },
      { kind: 'date', fieldId: id(7), value: '2026-08-12' },
      { kind: 'datetime', fieldId: id(8), value: '2026-08-12T12:00:00+00:00' }
    ]);
    expect(answers.map((answer) => 'value' in answer ? answer.value : null)).toEqual([
      'My session', 'First\nSecond', 'me@example.com', 'https://example.com/talk',
      '+65 6123 4567', 42, '2026-08-12', '2026-08-12T12:00:00.000Z'
    ]);
    expect(transientApplicationAnswersInputSchema.safeParse([
      { kind: 'text', fieldId: id(1), value: 'one' },
      { kind: 'text', fieldId: id(1), value: 'two' }
    ]).success).toBe(false);
    expect(transientApplicationAnswersInputSchema.safeParse([
      { kind: 'textarea', fieldId: id(2), value: 'x'.repeat(FORM_LONG_TEXT_MAX_LENGTH + 1) }
    ]).success).toBe(false);
  });

  test('pins selected live vocabulary labels and versions in immutable submit evidence', () => {
    const evidence = {
      schemaVersion: 1 as const,
      id: id(60), submissionId: id(61), draftId: id(62), draftRevisionId: id(63),
      formVersionId: id(10), requestDigestSha256: digest('d'),
      answerIndexDigestSha256: digest('e'),
      answers: [{ kind: 'select' as const, fieldId: id(20), choiceId: id(30) }],
      programVocabularyAnswerPins: [{
        fieldId: id(20), source: 'tracks' as const, itemId: id(30),
        itemVersion: 7, label: 'AI & Agents'
      }],
      admissibilityDeadlinePin: null,
      inputPolicy: {
        schemaVersion: 1 as const, evaluationId: id(70),
        policy: { key: 'public.input', version: 1 }, disposition: 'allow' as const,
        reasonCode: null, remedyCode: null, requestDigestSha256: digest('f'),
        evaluatedAt: '2026-08-12T12:00:00.000Z', evidenceDigestSha256: digest('1')
      },
      submittedAt: '2026-08-12T12:00:00.000Z'
    };
    expect(submissionSubmitEvidenceSchema.parse(evidence).programVocabularyAnswerPins[0])
      .toMatchObject({ itemVersion: 7, label: 'AI & Agents' });
  });

  test('keeps contact disclosure separate and supports nullable proposal title', () => {
    expect(Object.hasOwn(organizerSubmissionDetailSchema.shape, 'email')).toBe(false);
    expect(organizerSubmissionContactSchema.safeParse({
      schemaVersion: 1, submissionId: id(1), personId: id(2),
      participantIdentityId: id(3), sourceFieldId: id(4), email: 'person@example.com'
    }).success).toBe(true);

    const detail = organizerSubmissionDetailSchema.parse({
      schemaVersion: 1, submissionId: id(10), formId: id(11), formVersionId: id(12),
      submittedAt: '2026-08-12T10:00:00.000Z', participantCount: 1,
      answers: [
        { kind: 'text', fieldId: id(20), fieldLabel: 'Session title', value: 'A title' },
        { kind: 'textarea', fieldId: id(21), fieldLabel: 'Abstract', value: 'An abstract.' },
        { kind: 'select', fieldId: id(22), fieldLabel: 'Format', choice: { id: id(30), label: 'Talk' } },
        { kind: 'multiselect', fieldId: id(23), fieldLabel: 'Topics', choices: [{ id: id(31), label: 'AI' }, { id: id(32), label: 'Web' }] }
      ],
      affirmedConsentFieldIds: []
    });
    expect(detail.answers[2]).toMatchObject({ choice: { label: 'Talk' } });
    expect(organizerSubmissionAnswerSchema.safeParse({
      kind: 'email', fieldId: id(24), fieldLabel: 'Email', value: 'person@example.com'
    }).success).toBe(false);
    expect(organizerSubmissionSummarySchema.parse({
      schemaVersion: 1, id: id(10), formId: id(11), formVersionId: id(12),
      target: { kind: 'general_pool' }, title: null, primaryParticipantName: null,
      submittedAt: '2026-08-12T10:00:00.000Z'
    }).title).toBeNull();
  });

  test('person-scoped proposal pages require a truthful canonical continuation', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      schemaVersion: 1 as const,
      id: id(index + 1000),
      formId: id(11),
      formVersionId: id(12),
      target: { kind: 'general_pool' as const },
      title: `Proposal ${index + 1}`,
      primaryParticipantName: 'Amina Diallo',
      submittedAt: '2026-08-12T10:00:00.000Z'
    }));
    expect(organizerPersonSubmissionPageSchema.safeParse({
      schemaVersion: 1,
      rows,
      nextAfterSubmissionId: rows.at(-1)!.id
    }).success).toBe(true);
    expect(organizerPersonSubmissionPageSchema.safeParse({
      schemaVersion: 1,
      rows,
      nextAfterSubmissionId: id(9999)
    }).success).toBe(false);
    expect(organizerPersonSubmissionPageSchema.safeParse({
      schemaVersion: 1,
      rows: rows.slice(0, 2),
      nextAfterSubmissionId: rows[1]!.id
    }).success).toBe(false);
  });

  test('public draft status cannot claim incoherent submission linkage', () => {
    const base = {
      schemaVersion: 1 as const, formId: id(1), formVersionId: id(2), draftVersion: 1,
      answeredFieldIds: [], updatedAt: '2026-08-12T10:00:00.000Z'
    };
    expect(publicApplicationDraftStatusSchema.safeParse({
      ...base, status: 'in_progress', submittedSubmissionId: id(3)
    }).success).toBe(false);
    expect(publicApplicationDraftStatusSchema.safeParse({
      ...base, status: 'submitted', submittedSubmissionId: null
    }).success).toBe(false);
  });
});
