import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles
} from '@jooevents/application';
import type {
  SynchronousClassifiedPayloadReadInput,
  SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import type {
  ApplicationAnswerIndexDto,
  FieldRegistrySnapshotDto,
  FormDefinitionCreateDraftInput
} from '@jooevents/contracts';
import { createSubmissionTriageSubmitInitializer } from '@jooevents/submission-triage';
import {
  PUBLIC_INPUT_POLICY_ACTION,
  applicationAnswerPayloadScopeBinding,
  applyFormMutationPlan,
  evaluatePublicInputPolicy,
  issuePublicInputPolicyEvaluator,
  parseFormCatalogState,
  planApplicationDraftBegin,
  planApplicationDraftSave,
  planApplicationSubmit,
  planFormCreation,
  planFormLifecycleChange,
  type FormDefinitionIdentityAssignment,
  type FormTargetReferenceResolver
} from '@jooevents/intake';
import { canonicalJsonText } from '@jooevents/kernel';
import { installDeadlineSchema } from './deadline';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema
} from './field-registry';
import { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import { installSQLiteIntakeSchema, SQLiteIntakeRepository } from './intake';
import { installProgramVocabularySchema } from './program-vocabulary';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteIntakeSubmissionTriageSourceAdapter,
  SQLiteSubmissionTriageRepository
} from './submission-triage';

const id = (suffix: number): string =>
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const userId = id(3);
const formId = id(4);
const formVersionId = id(5);
const titleFieldId = id(6);
const abstractFieldId = id(7);
const nameFieldId = id(8);
const emailFieldId = id(9);
const trackId = id(10);
const draftId = id(11);
const beginRevisionId = id(12);
const saveRevisionId = id(13);
const submissionId = id(14);
const submitEvidenceId = id(15);
const personId = id(16);
const participantIdentityId = id(17);
const participantEvidenceId = id(18);
const titlePayloadId = id(30);
const abstractPayloadId = id(31);
const namePayloadId = id(32);
const emailPayloadId = id(33);
const at1 = '2026-08-12T09:00:00.000Z';
const at2 = '2026-08-12T09:01:00.000Z';
const at3 = '2026-08-12T09:02:00.000Z';
const at4 = '2026-08-12T09:03:00.000Z';
const at5 = '2026-08-12T09:04:00.000Z';
const authorityPartition = 'a'.repeat(64);

const targetReferences: FormTargetReferenceResolver = {
  resolveActiveCategory(scope, target) {
    if (scope.workspaceId !== workspaceId || scope.eventId !== eventId
        || target.category.kind !== 'track' || target.category.id !== trackId) return undefined;
    return {
      kind: 'category' as const,
      categoryKind: 'track' as const,
      id: trackId,
      name: 'Historical Data & AI',
      version: 1
    };
  },
  resolveCollectingSession() { return undefined; },
  resolveCurrentDeadline() { return undefined; }
};

const identities: FormDefinitionIdentityAssignment = {
  formId,
  rules: []
};

function createInput(registry: FieldRegistrySnapshotDto): FormDefinitionCreateDraftInput {
  const included = new Set([titleFieldId, abstractFieldId, nameFieldId, emailFieldId]);
  return {
    expectedCatalogVersion: 1,
    expectedRegistryVersion: registry.version,
    definition: {
      kind: 'cfp',
      name: 'Main CFP',
      target: { kind: 'category', category: { kind: 'track', id: trackId } },
      availability: { kind: 'evergreen' },
      confirmation: 'Application received.',
      composition: {
        excludedFieldIds: registry.fields
          .filter((field) => field.contexts.apply.visible && !included.has(field.id))
          .map((field) => field.id)
          .sort(),
        requiredOverrides: {},
        optionExposure: {}
      },
      rules: []
    }
  };
}

const profiles: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef(
    'classification', 'classification.intake-sensitive', 1
  ),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.intake-answer', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.intake-answer', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef(
    'descriptor_auth', 'descriptor-auth.intake-answer', 1
  )
});

function answers(): ApplicationAnswerIndexDto {
  return [
    { kind: 'text', fieldId: titleFieldId, value: { payloadRef: { id: titlePayloadId } } },
    { kind: 'textarea', fieldId: abstractFieldId,
      value: { payloadRef: { id: abstractPayloadId } } },
    { kind: 'text', fieldId: nameFieldId, value: { payloadRef: { id: namePayloadId } } },
    { kind: 'email', fieldId: emailFieldId, value: { payloadRef: { id: emailPayloadId } } }
  ];
}

function classifiedStore(): SynchronousClassifiedPayloadStore {
  const text = new Map([
    [titlePayloadId, 'Canonical Intake proposal'],
    [abstractPayloadId, 'Immutable version labels survive later changes.'],
    [namePayloadId, 'José Sørensen'],
    [emailPayloadId, 'private@example.test']
  ]);
  const expectedScope = new Map([
    [titlePayloadId, { fieldId: titleFieldId, kind: 'text' as const }],
    [abstractPayloadId, { fieldId: abstractFieldId, kind: 'textarea' as const }],
    [namePayloadId, { fieldId: nameFieldId, kind: 'text' as const }],
    [emailPayloadId, { fieldId: emailFieldId, kind: 'email' as const }]
  ]);
  return Object.freeze({
    put() { throw new TypeError('test_store_put_not_available'); },
    read(input: SynchronousClassifiedPayloadReadInput): Uint8Array {
      const value = text.get(input.payloadRef.id);
      const field = expectedScope.get(input.payloadRef.id);
      if (!value || !field || input.purpose !== 'intake.application_answer'
          || input.expectedBinding.contentType !== 'text/plain'
          || canonicalJsonText(input.expectedBinding.profiles) !== canonicalJsonText(profiles)
          || input.expectedBinding.scopeBinding !== applicationAnswerPayloadScopeBinding({
            scope: { workspaceId, eventId },
            formVersionId,
            owner: {
              draftId,
              revisionId: saveRevisionId,
              authorityPartitionDigestSha256: authorityPartition
            },
            fieldId: field.fieldId,
            kind: field.kind
          })) throw new TypeError('test_classified_binding_mismatch');
      return new TextEncoder().encode(value);
    }
  });
}

function openDatabase() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE event_spine_scope_roots (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO users (id) VALUES ('${userId}');
    INSERT INTO event_spine_scope_roots (workspace_id, event_id)
      VALUES ('${workspaceId}', '${eventId}');
  `);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteSubmissionTriageSchema(sqlite);
  let nextFieldId = 100;
  let nextChoiceId = 200;
  sqlite.exec('BEGIN IMMEDIATE');
  initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: {
      newFieldId(key) {
        if (key === 'talk.title') return titleFieldId;
        if (key === 'talk.abstract') return abstractFieldId;
        if (key === 'person.name') return nameFieldId;
        if (key === 'person.email') return emailFieldId;
        return id(nextFieldId++);
      },
      newChoiceId() { return id(nextChoiceId++); }
    }
  });
  sqlite.exec('COMMIT');
  const projection = new SQLiteIntakeClassifiedProjection({ store: classifiedStore(), profiles });
  const intake = new SQLiteIntakeRepository(sqlite, targetReferences, projection);
  return { sqlite, intake, projection };
}

function installGenuineSubmission(
  sqlite: Database,
  intake: SQLiteIntakeRepository,
  projection: SQLiteIntakeClassifiedProjection
) {
  const empty = parseFormCatalogState({
    scope: { workspaceId, eventId }, version: 1, heads: []
  });
  const registry = intake.readFieldRegistrySnapshot({ workspaceId, eventId });
  if (!registry) throw new TypeError('registry_fixture_missing');
  const create = planFormCreation({
    catalog: empty,
    registry,
    authorInput: createInput(registry),
    identities,
    references: intake,
    deadlineContribution: null,
    server: { createdByUserId: userId, createdAt: at1 }
  });
  applyFormMutationPlan({ catalog: empty, registry, plan: create, references: intake });
  const open = planFormLifecycleChange({
    head: create.after,
    registry,
    existingVersions: [],
    authorInput: {
      transition: 'publish_and_open',
      formId,
      expectedDefinitionVersion: 1,
      expectedRegistryVersion: registry.version
    },
    references: intake,
    server: { formVersionId, updatedByUserId: userId, updatedAt: at2 }
  });
  if (!open.publishedVersion) throw new TypeError('published_version_missing');
  const evaluator = issuePublicInputPolicyEvaluator({
    policy: { key: 'intake.cooperative_limits', version: 1 },
    issueEvaluationId: (() => {
      let next = 60;
      return () => id(next++);
    })(),
    decide: () => ({ disposition: 'allow', reasonCode: null, remedyCode: null })
  });
  const decision = (
    action: typeof PUBLIC_INPUT_POLICY_ACTION[keyof typeof PUBLIC_INPUT_POLICY_ACTION],
    requestDigestSha256: string,
    evaluatedAt: string
  ) => evaluatePublicInputPolicy(evaluator, {
    scope: { workspaceId, eventId }, action, requestDigestSha256, evaluatedAt
  });
  const beginDigest = 'b'.repeat(64);
  const begin = planApplicationDraftBegin({
    formHead: open.after,
    formVersion: open.publishedVersion,
    collection: intake,
    inputPolicy: decision(PUBLIC_INPUT_POLICY_ACTION.draftBegin, beginDigest, at3),
    requestDigestSha256: beginDigest,
    server: {
      draftId,
      revisionId: beginRevisionId,
      authorityPartitionDigestSha256: authorityPartition,
      createdAt: at3
    }
  });
  const saveDigest = 'c'.repeat(64);
  const save = planApplicationDraftSave({
    formHead: open.after,
    formVersion: open.publishedVersion,
    collection: intake,
    draftHead: begin.head,
    currentRevision: begin.revision,
    expectedDraftVersion: 1,
    expectedAuthorityPartitionDigestSha256: authorityPartition,
    requestDigestSha256: saveDigest,
    inputPolicy: decision(PUBLIC_INPUT_POLICY_ACTION.draftSave, saveDigest, at4),
    answers: answers(),
    server: { revisionId: saveRevisionId, savedAt: at4 }
  });
  const submitDigest = 'd'.repeat(64);
  const submit = planApplicationSubmit({
    formHead: open.after,
    formVersion: open.publishedVersion,
    collection: intake,
    draftHead: save.afterHead,
    currentRevision: save.afterRevision,
    expectedDraftVersion: 2,
    expectedAuthorityPartitionDigestSha256: authorityPartition,
    requestDigestSha256: submitDigest,
    inputPolicy: decision(PUBLIC_INPUT_POLICY_ACTION.submit, submitDigest, at5),
    identities: {
      submissionId,
      submitEvidenceId,
      personId,
      participantIdentityId,
      participantEvidenceId,
      consentEvidenceIds: []
    },
    server: { submittedAt: at5 }
  });
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    intake.applyFormMutation(create);
    intake.applyFormMutation(open);
    intake.applyApplicationMutation(begin, projection);
    // The plans' payload refs are revalidated by the same authenticated
    // production projection during both save and submit.
    intake.applyApplicationMutation(save, projection);
    intake.applyApplicationMutation(submit, projection);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  return submit;
}

describe('SQLite Intake submission-triage source adapter', () => {
  test('projects a genuine Intake submission with pinned labels and no contact', () => {
    const { sqlite, intake, projection } = openDatabase();
    try {
      const submit = installGenuineSubmission(sqlite, intake, projection);
      const source = new SQLiteIntakeSubmissionTriageSourceAdapter(intake);
      const rows = source.listSourceRows({ workspaceId, eventId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scope: { workspaceId, eventId },
        source: 'public_form',
        summary: {
          id: submissionId,
          formVersionId,
          title: 'Canonical Intake proposal',
          primaryParticipantName: 'José Sørensen'
        },
        abstract: 'Immutable version labels survive later changes.',
        track: { id: trackId, label: 'Historical Data & AI' },
        format: null
      });
      expect(JSON.stringify(rows[0])).not.toContain('private@example.test');

      const triage = new SQLiteSubmissionTriageRepository(sqlite, source);
      sqlite.exec('BEGIN IMMEDIATE');
      const initializer = createSubmissionTriageSubmitInitializer({
        store: triage,
        ids: { newArrivalId: () => id(70) }
      });
      expect(initializer.initializeWithinTransaction({
        scope: { workspaceId, eventId },
        submission: {
          id: submit.submission.id,
          formId: submit.submission.formId,
          formVersionId: submit.submission.formVersionId,
          source: 'public_form',
          submittedAt: submit.submission.submittedAt
        },
        recordedAt: submit.submission.submittedAt,
        closeEvidence: null
      })).toMatchObject({
        submissionId, replay: false
      });
      sqlite.exec('COMMIT');
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.close();
    }
  });
});
