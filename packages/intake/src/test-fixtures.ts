import { createHash } from 'node:crypto';
import type {
  FieldRegistrySnapshotDto,
  FieldRegistryOptionSource,
  FormDefinitionCreateDraftInput,
  FormVersionDto,
  IntakeScopeDto
} from '@jooevents/contracts';
import { encodeCanonicalJson } from '@jooevents/kernel';
import type { ApplicationCollectionSource } from './submissions';
import type { FormCatalogState } from './model';

export const fixtureId = (suffix: number): string =>
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`;

export const fixtureIds = Object.freeze({
  workspace: fixtureId(1),
  event: fixtureId(2),
  user: fixtureId(3),
  form: fixtureId(4),
  version: fixtureId(5),
  email: fixtureId(6),
  title: fixtureId(7),
  track: fixtureId(8),
  consent: fixtureId(9),
  ordinaryCheckbox: fixtureId(10),
  trackAi: fixtureId(11),
  trackWeb: fixtureId(12),
  deadline: fixtureId(13),
  session: fixtureId(14),
  draft: fixtureId(15),
  revision1: fixtureId(16),
  revision2: fixtureId(17),
  submission: fixtureId(18),
  submitEvidence: fixtureId(19),
  person: fixtureId(20),
  participantIdentity: fixtureId(21),
  participantEvidence: fixtureId(22),
  consentEvidence: fixtureId(23),
  policyBegin: fixtureId(24),
  policySave: fixtureId(25),
  policySubmit: fixtureId(26)
});

export const fixtureScope: IntakeScopeDto = Object.freeze({
  workspaceId: fixtureIds.workspace,
  eventId: fixtureIds.event
});

export const fixtureAt = Object.freeze({
  create: '2026-08-13T01:00:00.000Z',
  publish: '2026-08-13T01:01:00.000Z',
  save: '2026-08-13T01:02:00.000Z',
  submit: '2026-08-13T01:03:00.000Z'
});

const contexts = (required: boolean) => ({
  apply: { visible: true, required },
  onboard: { visible: false, required: false },
  profile: { visible: false, required: false }
});

export const fixtureRegistry: FieldRegistrySnapshotDto = {
  schemaVersion: 1,
  scope: fixtureScope,
  version: 7,
  registryDigestSha256: 'a'.repeat(64),
  fields: [
    {
      id: fixtureIds.email,
      key: 'person_email',
      version: 2,
      kind: 'email' as const,
      label: 'Email',
      help: null,
      answerOwner: 'person' as const,
      mapsTo: 'person.email' as const,
      purpose: { kind: 'ordinary' as const },
      scope: { kind: 'shared' as const },
      group: 'contact' as const,
      position: 0,
      contexts: contexts(true),
      options: { kind: 'none' as const },
      constraints: { removal: 'forbidden' as const, applyVisibility: 'required_visible' as const },
      fileUpload: 'not_applicable' as const,
      resolvedOptions: null
    },
    {
      id: fixtureIds.title,
      key: 'talk_title',
      version: 3,
      kind: 'text' as const,
      label: 'Title',
      help: null,
      answerOwner: 'talk' as const,
      mapsTo: 'talk.title' as const,
      purpose: { kind: 'ordinary' as const },
      scope: { kind: 'shared' as const },
      group: 'talk' as const,
      position: 1,
      contexts: contexts(false),
      options: { kind: 'none' as const },
      constraints: { removal: 'allowed' as const, applyVisibility: 'editable' as const },
      fileUpload: 'not_applicable' as const,
      resolvedOptions: null
    },
    {
      id: fixtureIds.track,
      key: 'talk_track',
      version: 4,
      kind: 'select' as const,
      label: 'Track',
      help: null,
      answerOwner: 'talk' as const,
      mapsTo: 'talk.track' as const,
      purpose: { kind: 'ordinary' as const },
      scope: { kind: 'shared' as const },
      group: 'talk' as const,
      position: 2,
      contexts: contexts(false),
      options: { kind: 'program_vocabulary' as const, source: 'tracks' as const },
      constraints: { removal: 'allowed' as const, applyVisibility: 'editable' as const },
      fileUpload: 'not_applicable' as const,
      resolvedOptions: [
        { id: fixtureIds.trackAi, label: 'AI', version: 2 },
        { id: fixtureIds.trackWeb, label: 'Web', version: 1 }
      ]
    },
    {
      id: fixtureIds.consent,
      key: 'recording_release',
      version: 1,
      kind: 'checkbox' as const,
      label: 'I agree to recording',
      help: null,
      answerOwner: 'person' as const,
      mapsTo: null,
      purpose: { kind: 'consent' as const, key: 'recording_release' },
      scope: { kind: 'shared' as const },
      group: 'consent' as const,
      position: 3,
      contexts: contexts(true),
      options: { kind: 'none' as const },
      constraints: { removal: 'allowed' as const, applyVisibility: 'editable' as const },
      fileUpload: 'not_applicable' as const,
      resolvedOptions: null
    },
    {
      id: fixtureIds.ordinaryCheckbox,
      key: 'needs_followup',
      version: 1,
      kind: 'checkbox' as const,
      label: 'Contact me about logistics',
      help: null,
      answerOwner: 'person' as const,
      mapsTo: null,
      purpose: { kind: 'ordinary' as const },
      scope: { kind: 'shared' as const },
      group: 'consent' as const,
      position: 4,
      contexts: contexts(false),
      options: { kind: 'none' as const },
      constraints: { removal: 'allowed' as const, applyVisibility: 'editable' as const },
      fileUpload: 'not_applicable' as const,
      resolvedOptions: null
    }
  ]
};

export function fixtureCreateDraft(
  overrides: Partial<FormDefinitionCreateDraftInput['definition']> = {}
): FormDefinitionCreateDraftInput {
  return {
    expectedCatalogVersion: 1,
    expectedRegistryVersion: fixtureRegistry.version,
    definition: {
      kind: 'cfp',
      name: 'Main CFP',
      target: { kind: 'general_pool' },
      availability: { kind: 'evergreen' },
      confirmation: 'Application received.',
      composition: {
        excludedFieldIds: [],
        requiredOverrides: { [fixtureIds.email]: false },
        optionExposure: { [fixtureIds.track]: [fixtureIds.trackAi] }
      },
      rules: [],
      ...overrides
    }
  };
}

export const fixtureCatalog: FormCatalogState = Object.freeze({
  scope: fixtureScope,
  version: 1,
  heads: Object.freeze([])
});

export const fixtureCollection: ApplicationCollectionSource = Object.freeze({
  resolveActiveCategory() { return undefined; },
  resolveCollectingSession() { return undefined; },
  resolveCurrentDeadline() { return undefined; },
  readLiveOptions(_scope: IntakeScopeDto, source: FieldRegistryOptionSource) {
    return source === 'tracks'
      ? [
          { id: fixtureIds.trackAi, label: 'Applied AI', version: 5, status: 'active' as const },
          { id: fixtureIds.trackWeb, label: 'Web', version: 1, status: 'active' as const }
        ]
      : [];
  }
});

export function fixtureDigest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

export function withPublishedVersion(
  version: FormVersionDto,
  headVersion: number
) {
  return {
    schemaVersion: 1 as const,
    id: version.formId,
    scope: version.scope,
    version: headVersion,
    status: 'open' as const,
    currentPublishedVersionId: version.id,
    definition: {
      kind: version.definition.kind,
      name: version.definition.name,
      target: version.definition.target,
      availability: version.definition.availability,
      confirmation: version.definition.confirmation,
      composition: {
        excludedFieldIds: [],
        requiredOverrides: { [fixtureIds.email]: false },
        optionExposure: { [fixtureIds.track]: [fixtureIds.trackAi] }
      },
      rules: version.definition.rules.map((rule) => ({
        id: rule.id,
        key: rule.key,
        position: rule.position,
        condition: rule.condition.kind === 'selected_any'
          ? {
              kind: 'selected_any' as const,
              sourceFieldId: rule.condition.sourceFieldId,
              choiceIds: rule.condition.choiceIds
            }
          : rule.condition,
        effect: rule.effect
      }))
    },
    createdByUserId: fixtureIds.user,
    createdAt: fixtureAt.create,
    updatedByUserId: fixtureIds.user,
    updatedAt: fixtureAt.publish
  };
}
