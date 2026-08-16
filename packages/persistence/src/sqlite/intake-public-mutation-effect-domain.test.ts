import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createClassifiedPayloadProfileRef,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import { createPublicEffectConformanceBoundary } from '@jooevents/application/public-effect-conformance';
import type {
  FieldRegistrySnapshotDto,
  FormDefinitionCreateAuthorInput
} from '@jooevents/contracts';
import { planFieldRegistryMutation } from '@jooevents/field-registry';
import {
  applyFormMutationPlan,
  issuePublicInputPolicyEvaluator,
  parseApplicationMutationPlan,
  parseFormCatalogState,
  planFormCreation,
  planFormLifecycleChange,
  planFormPublication,
  type FormDefinitionIdentityAssignment
} from '@jooevents/intake';
import {
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_DRAFT_RESUME_OPERATION,
  INTAKE_PUBLIC_MUTATE_OPERATION,
  INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
  createIntakePublicConformanceMutationOperationModule,
  intakePublicMutationOperationResultSchema
} from '@jooevents/intake-operations';
import {
  createPublicMutationContinuationBoundary,
  type PublicMutationContinuationPolicy,
  type RegisteredPublicMutationBootstrapVerifier
} from '@jooevents/application/public-mutation-continuation';
import {
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type AuditEventId,
  type CeremonyEvidenceId
} from '@jooevents/kernel';
import type { ProgramReferenceContributorSnapshot } from '@jooevents/program';
import { createSubmissionTriageSubmitInitializer } from '@jooevents/submission-triage';
import { installDeadlineSchema } from './deadline';
import { installEventSpineSchema } from './event-spine';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema,
  SQLiteFieldRegistryRepository,
  SQLiteIntakeFieldRegistryFormReferenceResolver
} from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import { SQLiteIntakeClassifiedProjection } from './intake-classified-projection';
import {
  createIntakePublicCeremonyBoundaryRegistry,
  createIntakePublicCeremonyDirectory
} from './intake-public-ceremony';
import {
  createSQLiteIntakeParticipantAttributionConformance,
  installSQLiteIntakeParticipantAttributionConformanceSchema
} from './intake-participant-attribution-conformance';
import {
  createSQLiteIntakeFormProgramVocabularyReferenceAdapter
} from './intake-form-program-reference';
import {
  createSQLiteIntakePublicMutationEffectDomainRegistration,
  installSQLiteIntakePublicMutationEffectSchema,
  type SQLiteIntakePublicMutationEffectIds
} from './intake-public-mutation-effect-domain';
import { installSQLiteIntakeSchema, SQLiteIntakeRepository } from './intake';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteIntakeSubmissionTriageSourceAdapter,
  SQLiteSubmissionTriageRepository
} from './submission-triage';
import { installProgramVocabularySchema } from './program-vocabulary';
import {
  installSQLitePublicMutationEffectCompletion,
  SQLitePublicMutationEffectCompletionPort
} from './public-mutation-effect-completion';
import {
  installSQLitePublicMutationContinuationTrial,
  SQLitePublicMutationContinuationTrial
} from './public-mutation-continuation-trial';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from './sqlite-classified-payload-store';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const id = (suffix: number): string =>
  `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(id(1));
const eventId = parseEventId(id(2));
const userId = id(3);
const formId = id(4);
const formVersionId = id(5);
const titleId = id(6);
const emailId = id(7);
const consentId = id(8);
const personId = id(9);
const participantIdentityId = id(10);
const draftId = id(11);
const otherEventId = parseEventId(id(13));
const trackFieldId = id(14);
const trackChoiceId = id(15);
const republishedFormVersionId = id(20);
const now = parseInstant('2026-08-12T12:00:00.000Z');
const republishedAt = parseInstant('2026-08-12T12:01:00.000Z');
const policyRevisionId = parsePublicPolicyRevisionId(id(12));
const binding = Object.freeze({ key: 'intake.public-application', version: parseContractVersion(1) });
const bootstrapRef = Object.freeze({ key: 'intake.public-bootstrap', version: parseContractVersion(1) });
const profile = Object.freeze({ key: 'intake-public-test', version: parseContractVersion(1) });

function definition(registry: FieldRegistrySnapshotDto): FormDefinitionCreateAuthorInput {
  const included = new Set([titleId, emailId, consentId, trackFieldId]);
  return {
    kind: 'cfp', name: 'Main CFP', target: { kind: 'general_pool' },
    availability: { kind: 'evergreen' }, confirmation: 'Received.',
    composition: {
      excludedFieldIds: registry.fields
        .filter((field) => field.contexts.apply.visible && !included.has(field.id))
        .map((field) => field.id)
        .sort(),
      requiredOverrides: {},
      optionExposure: {}
    },
    rules: []
  };
}

const identities: FormDefinitionIdentityAssignment = {
  formId,
  rules: []
};

const profiles = Object.freeze({
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

function continuationPolicy(): PublicMutationContinuationPolicy {
  const key = (seed: number) => new Uint8Array(32).fill(seed);
  return Object.freeze({
    binding,
    publicPolicyRevisionId: policyRevisionId,
    operation: {
      name: INTAKE_PUBLIC_MUTATE_OPERATION.name,
      version: parseContractVersion(INTAKE_PUBLIC_MUTATE_OPERATION.version)
    },
    scope: { kind: 'event' as const, workspaceId, eventId },
    purpose: 'intake.application',
    action: 'mutate',
    resourceBindings: [
      { kind: 'intake_form', id: formId },
      { kind: 'intake_form_version', id: formVersionId }
    ],
    lifetimeMs: 300_000,
    bootstrapVerifier: bootstrapRef,
    originPolicy: { key: 'intake.origin', version: parseContractVersion(1) },
    csrfPolicy: { key: 'intake.csrf', version: parseContractVersion(1) },
    rateLimitPolicy: { key: 'intake.rate', version: parseContractVersion(1) },
    replayPolicy: { key: 'intake.replay', version: parseContractVersion(1) },
    continuationProfiles: [{
      reference: { key: 'intake.continuation', version: parseContractVersion(1) },
      keyBytes: key(1)
    }] as const,
    principalPartitionProfile: {
      reference: { key: 'intake.partition', version: parseContractVersion(1) }, keyBytes: key(2)
    },
    bootstrapReplayProfile: {
      reference: { key: 'intake.bootstrap-replay', version: parseContractVersion(1) }, keyBytes: key(3)
    }
  });
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly total: number }, []>(`SELECT count(*) AS total FROM ${table}`)
    .get()?.total ?? -1;
}

function substitutedChild(
  base: SQLiteEffectDomainAdapter,
  mismatchAtCall: number
): SQLiteEffectDomainAdapter {
  let childCalls = 0;
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    ...(base.afterOperationLogInserted
      ? { afterOperationLogInserted: base.afterOperationLogInserted.bind(base) }
      : {}),
    afterEffectContributionInserted(receiptId, contribution) {
      childCalls += 1;
      const changed = structuredClone(contribution) as Record<string, unknown>;
      if (childCalls === mismatchAtCall) {
        if (changed.kind === 'domain_fact') changed.factId = id(9999);
        else if (changed.kind === 'outbox_pointer') changed.pointerId = id(9999);
        else changed.timelineId = id(9999);
      }
      return base.afterEffectContributionInserted?.(receiptId, changed);
    },
    ...(base.afterEffectApplicationCommitted
      ? { afterEffectApplicationCommitted: base.afterEffectApplicationCommitted.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base) }
      : {})
  };
}

async function fixture(options: { readonly mismatchChild?: boolean } = {}) {
  const sqlite = new Database(':memory:', { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteSubmissionTriageSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLitePublicMutationContinuationTrial(sqlite);
  installSQLitePublicMutationEffectCompletion(sqlite);
  installSQLiteIntakeParticipantAttributionConformanceSchema(sqlite);
  installSQLiteIntakePublicMutationEffectSchema(sqlite);
  sqlite.query(`INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)`).run(workspaceId);
  sqlite.query(`INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Owner', 1, 1, 1)`).run(userId);
  sqlite.exec('BEGIN IMMEDIATE');
  sqlite.query(`INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)`).run(workspaceId);
  sqlite.query(`INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Intake Event', 'UTC', '2026-08-12', '2026-08-13', 1, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Other Event', 'UTC', '2026-09-12', '2026-09-13', 1, ?, ?, ?)`)
    .run(workspaceId, otherEventId, userId, Date.parse(now), 'b'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, otherEventId);
  sqlite.query(`UPDATE event_spine_workspace_sets
    SET version = 2, current_event_id = ? WHERE workspace_id = ?`).run(eventId, workspaceId);
  sqlite.query(`INSERT INTO program_vocabulary_sets (
      workspace_id, event_id, set_version, created_by_user_id, created_at_ms,
      updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, 2, ?, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(now), userId, Date.parse(now));
  sqlite.query(`INSERT INTO program_vocabulary_tracks (
      workspace_id, event_id, id, name, status, version, created_by_user_id,
      created_at_ms, updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, ?, 'Applied AI', 'active', 1, ?, ?, ?, ?)`)
    .run(
      workspaceId, eventId, trackChoiceId, userId, Date.parse(now), userId, Date.parse(now)
    );
  sqlite.exec('COMMIT');

  let nextFieldId = 100;
  let nextChoiceId = 200;
  sqlite.exec('BEGIN IMMEDIATE');
  initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: {
      newFieldId(key) {
        if (key === 'talk.title') return titleId;
        if (key === 'talk.track') return trackFieldId;
        if (key === 'person.email') return emailId;
        if (key === 'person.recording_consent') return consentId;
        return id(nextFieldId++);
      },
      newChoiceId() { return id(nextChoiceId++); }
    }
  });
  sqlite.exec('COMMIT');

  const encryption = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.intake-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x44)
  });
  let nonce = 1;
  const rawStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: encryption,
    nonceSource: () => new Uint8Array(12).fill(nonce++)
  });
  const capturedBuffers: Uint8Array[] = [];
  const classifiedStore: SynchronousClassifiedPayloadStore = Object.freeze({
    put(input: Parameters<SynchronousClassifiedPayloadStore['put']>[0]) {
      capturedBuffers.push(input.bytes);
      return rawStore.put(input);
    },
    read(input: Parameters<SynchronousClassifiedPayloadStore['read']>[0]) {
      return rawStore.read(input);
    }
  });
  const projection = new SQLiteIntakeClassifiedProjection({ store: classifiedStore, profiles });
  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  }, projection);
  const registryStore = new SQLiteFieldRegistryRepository(
    sqlite,
    new SQLiteIntakeFieldRegistryFormReferenceResolver(sqlite)
  );
  sqlite.exec('BEGIN IMMEDIATE');
  const empty = parseFormCatalogState({ scope: { workspaceId, eventId }, version: 1, heads: [] });
  const registry = repository.readFieldRegistrySnapshot({ workspaceId, eventId });
  if (!registry) throw new TypeError('registry_fixture_missing');
  const create = planFormCreation({
    catalog: empty,
    registry,
    authorInput: {
      expectedCatalogVersion: 1,
      expectedRegistryVersion: registry.version,
      definition: definition(registry)
    },
    identities,
    references: repository,
    deadlineContribution: null,
    server: { createdByUserId: userId, createdAt: now }
  });
  const created = applyFormMutationPlan({
    catalog: empty, registry, plan: create, references: repository
  }).catalog;
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
    references: repository,
    server: { formVersionId, updatedByUserId: userId, updatedAt: now }
  });
  if (!open.publishedVersion) throw new TypeError('published_version_missing');
  applyFormMutationPlan({
    catalog: created,
    registry,
    plan: open,
    references: repository,
    existingVersions: []
  });
  repository.applyFormMutation(create);
  repository.applyFormMutation(open);
  sqlite.exec('COMMIT');

  let audit = 100;
  let ceremony = 200;
  const clock = { now: () => now };
  const continuationStore = new SQLitePublicMutationContinuationTrial(sqlite, {
    clock,
    newAuditEventId: () => parseAuditEventId(id(audit++)),
    newCompletionReference: () => `pcr_${String(audit++).padStart(24, '0')}`
  });
  const verifier: RegisteredPublicMutationBootstrapVerifier = Object.freeze({
    reference: bootstrapRef,
    verify() {
      return {
        kind: 'verified' as const,
        principalPartitionMaterial: new TextEncoder().encode('applicant-one'),
        bootstrapReplayMaterial: new TextEncoder().encode('bootstrap-one'),
        originEvidenceId: 'poe_0123456789abcdef',
        csrfEvidenceId: 'pce_0123456789abcdef',
        rateLimitEvidenceId: 'pre_0123456789abcdef',
        replayEvidenceId: 'ppe_0123456789abcdef'
      };
    }
  });
  const makeBoundary = () => createPublicMutationContinuationBoundary({
    binding,
    policies: { resolve: () => continuationPolicy() },
    bootstrapVerifiers: { resolve: () => verifier },
    store: continuationStore,
    clock,
    newActionAnchorId: () => draftId,
    newCeremonyEvidenceId: () => parseCeremonyEvidenceId(id(ceremony++)),
    newAuditEventId: () => parseAuditEventId(id(audit++)),
    randomBytes: () => new Uint8Array(32).fill(0x22)
  });
  const completion = new SQLitePublicMutationEffectCompletionPort(sqlite, {
    clock, newAuditEventId: () => parseAuditEventId(id(audit++))
  });
  const boundary = makeBoundary();
  const directory = createIntakePublicCeremonyDirectory(
    createIntakePublicCeremonyBoundaryRegistry([{ formId, formVersionId, boundary, completion }])
  );
  const minted = await directory.mint({ formId, protocolEvidence: {} });
  if (minted.kind !== 'issued') throw new TypeError('expected continuation');
  const admitted = directory.admit({ formId, continuation: minted.continuation });
  if (admitted.kind !== 'ready') throw new TypeError('expected admission');
  const resolved = await directory.resolve(admitted.evidence.ceremonyEvidenceId);
  if (!resolved) throw new TypeError('expected binding');

  const participant = createSQLiteIntakeParticipantAttributionConformance(sqlite);
  sqlite.exec('BEGIN IMMEDIATE');
  participant.register({
    ceremonyEvidenceId: admitted.evidence.ceremonyEvidenceId,
    authorityPartitionDigestSha256: resolved.authorityPartitionDigestSha256,
    personId, participantIdentityId,
    evidenceIds: ['participant-conformance:one']
  });
  sqlite.exec('COMMIT');

  let refuseInputPolicy = false;
  const inputPolicy = issuePublicInputPolicyEvaluator({
    policy: { key: 'intake.cooperative-input', version: 1 },
    issueEvaluationId: () => id(ceremony++),
    decide: () => refuseInputPolicy
      ? { disposition: 'reject', reasonCode: 'input_refused', remedyCode: 'revise_input' }
      : { disposition: 'allow', reasonCode: null, remedyCode: null }
  });
  let generated = 1000;
  const ids: SQLiteIntakePublicMutationEffectIds = {
    newPreparationHandle: () => id(generated++),
    newRevisionId: () => id(generated++),
    newPayloadRefId: () => id(generated++),
    newSubmissionId: () => id(generated++),
    newSubmitEvidenceId: () => id(generated++),
    newParticipantEvidenceId: () => id(generated++),
    newConsentEvidenceId: () => id(generated++),
    newFactId: () => id(generated++),
    newPointerId: () => id(generated++),
    newTimelineId: () => id(generated++),
    newCompletionReference: () => `pcr_${String(generated++).padStart(24, '0')}`
  };
  const submissionTriage = createSubmissionTriageSubmitInitializer({
    store: new SQLiteSubmissionTriageRepository(
      sqlite,
      new SQLiteIntakeSubmissionTriageSourceAdapter(repository)
    ),
    ids: { newArrivalId: () => id(generated++) }
  });
  const registration = createSQLiteIntakePublicMutationEffectDomainRegistration({
    sqlite, workspaceId, repository, projection, classifiedStore,
    classifiedProfiles: profiles, inputPolicy, ceremonies: directory,
    participantAttribution: participant, submissionTriage, ids
  });
  const adapter = options.mismatchChild
    ? substitutedChild(registration.adapter, 4) : registration.adapter;
  const adapters = createSQLiteEffectDomainAdapterRegistry([{
    capability: registration.capability, adapter
  }]);
  const publicConformance = createPublicEffectConformanceBoundary();
  const module = createIntakePublicConformanceMutationOperationModule({
    policy: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
    currentAuthority: directory.currentAuthority,
    ceremonyScope: directory,
    publicEffectConformance: publicConformance,
    clock,
    ids: { newInvocationId: () => parseInvocationId(id(generated++)) },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x55)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(value) {
          return { verifierProfile: profile,
            verifierSha256: createHash('sha256').update(value).digest('hex') };
        }
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: directory.currentAuthority.resolve,
    now: () => now
  });
  const runtime = await publicConformance.createRuntime({
    source: module.source,
    read: { operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock, newInvocationId: () => parseInvocationId(id(generated++)) },
    unitOfWork,
    newOperationLogId: () => id(generated++)
  });
  let request = 1;
  const evidence: InvocationEvidence = {
    kind: 'public_ceremony', surface: 'public_http', client: { key: 'public.intake-test' },
    ceremonyEvidenceId: admitted.evidence.ceremonyEvidenceId
  };
  return {
    sqlite, repository, registryStore, projection, directory, boundary, completion,
    continuationStore,
    token: minted.continuation, evidence, capturedBuffers,
    refuseInputPolicy() { refuseInputPolicy = true; },
    restartDirectory() {
      const restartedBoundary = makeBoundary();
      return createIntakePublicCeremonyDirectory(
        createIntakePublicCeremonyBoundaryRegistry([{
          formId, formVersionId, boundary: restartedBoundary, completion
        }])
      );
    },
    async execute(businessInput: unknown, idempotency = `request-${request++}`) {
      const invocation = await runtime.effectBuilder.build({
        operationName: INTAKE_PUBLIC_MUTATE_OPERATION.name,
        operationVersion: 1,
        surface: 'public_http',
        correlationId: id(generated++), businessInput,
        verifiedEvidence: evidence,
        rawIdempotencyKey: idempotency
      });
      return runtime.effectExecutor.execute(invocation);
    },
    close() { sqlite.close(); }
  };
}

describe('SQLite Intake public mutation effect domain', () => {
  test('begins, saves and submits atomically, then resumes the exact terminal receipt after restart', async () => {
    const f = await fixture();
    try {
      const begin = intakePublicMutationOperationResultSchema.parse(await f.execute({
        action: 'begin', input: { formId }
      }));
      expect(begin).toMatchObject({ kind: 'success', data: { action: 'begin', draft: {
        formId, formVersionId, draftVersion: 1, status: 'in_progress'
      } } });
      expect(f.directory.resolve(f.evidence.ceremonyEvidenceId)).toBeDefined();

      const beforeRefusal = count(f.sqlite, 'operation_log');
      expect(await f.execute({ action: 'begin', input: { formId } }, 'fresh-begin'))
        .toMatchObject({ kind: 'outcome', terminal: false,
          outcome: { class: 'conflict', kind: 'intake.changed' } });
      expect(count(f.sqlite, 'operation_log')).toBe(beforeRefusal);

      const save = intakePublicMutationOperationResultSchema.parse(await f.execute({
        action: 'save', input: {
          expectedDraftVersion: 1,
          answers: [
            { kind: 'text', fieldId: titleId, value: 'A precise proposal' },
            { kind: 'email', fieldId: emailId, value: 'speaker@example.test' },
            { kind: 'select', fieldId: trackFieldId, choiceId: trackChoiceId },
            { kind: 'checkbox', fieldId: consentId, checked: true }
          ]
        }
      }));
      expect(save).toMatchObject({ kind: 'success', data: { action: 'save', draft: {
        draftVersion: 2, status: 'in_progress'
      } } });
      expect(f.capturedBuffers.length).toBe(2);
      expect(f.capturedBuffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
      expect(JSON.stringify(f.sqlite.query('SELECT * FROM classified_payload_records').all()))
        .not.toContain('speaker@example.test');
      expect(f.repository.readPublicDraftResume({ workspaceId, eventId }, {
        draftId, formId, formVersionId,
        authorityPartitionDigestSha256:
          f.directory.resolveCurrent(f.evidence.ceremonyEvidenceId)!
            .authorityPartitionDigestSha256
      })).toMatchObject({
        draft: { formId, formVersionId, draftVersion: 2 },
        answers: expect.arrayContaining([
          { kind: 'text', fieldId: titleId, value: 'A precise proposal' },
          { kind: 'email', fieldId: emailId, value: 'speaker@example.test' },
          { kind: 'select', fieldId: trackFieldId, choiceId: trackChoiceId },
          { kind: 'checkbox', fieldId: consentId, checked: true }
        ])
      });
      const currentBinding = f.directory.resolveCurrent(f.evidence.ceremonyEvidenceId);
      if (!currentBinding) throw new TypeError('expected current binding');
      const resumeAuthority = await f.directory.currentAuthority.resolve({
        operation: { ...INTAKE_PUBLIC_DRAFT_RESUME_OPERATION, effect: 'read' },
        evidence: f.evidence,
        lane: {
          kind: 'public_ceremony', surface: 'public_http',
          policy: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY
        },
        scope: {
          workspaceId, eventId,
          resolutionEvidenceIds: currentBinding.evidenceIds,
          subjects: [
            { kind: 'workspace', id: workspaceId },
            { kind: 'event', id: eventId },
            { kind: 'domain', domain: 'intake', entity: 'application_draft', id: draftId },
            { kind: 'domain', domain: 'intake', entity: 'form', id: formId },
            { kind: 'domain', domain: 'intake', entity: 'form_version', id: formVersionId },
            { kind: 'domain', domain: 'intake', entity: 'authority_partition',
              id: currentBinding.authorityPartitionDigestSha256 }
          ]
        },
        evaluatedAt: now
      });
      expect(resumeAuthority).toMatchObject({
        kind: 'authorized', authority: { grants: [{
          kind: 'public_policy', key: INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.name
        }] }
      });

      const storedDraft = f.repository.readDraft({ workspaceId, eventId }, draftId);
      const storedVersion = f.repository.readFormVersion(
        { workspaceId, eventId }, formVersionId
      );
      if (!storedDraft || !storedVersion) throw new TypeError('missing saved draft');
      const text = storedDraft.revision.answers.find((answer) => answer.kind === 'text');
      const email = storedDraft.revision.answers.find((answer) => answer.kind === 'email');
      if (!text || text.kind !== 'text' || !email || email.kind !== 'email') {
        throw new TypeError('missing governed answers');
      }
      const swappedRevision = {
        ...storedDraft.revision,
        answers: storedDraft.revision.answers.map((answer) => answer.fieldId === text.fieldId
          ? { ...answer, value: email.value }
          : answer.fieldId === email.fieldId ? { ...answer, value: text.value } : answer)
      } as typeof storedDraft.revision;
      expect(() => f.projection.resolveDraftResume({
        head: storedDraft.head, revision: swappedRevision, version: storedVersion
      })).toThrow('payload_binding_mismatch');

      const submit = intakePublicMutationOperationResultSchema.parse(await f.execute({
        action: 'submit', input: { expectedDraftVersion: 2 }
      }));
      expect(submit).toMatchObject({ kind: 'success', data: { action: 'submit', submission: {
        formId, formVersionId
      } } });
      if (submit.kind !== 'success' || submit.data.action !== 'submit') {
        throw new TypeError('expected submit success');
      }
      expect(count(f.sqlite, 'intake_submission_heads')).toBe(1);
      expect(count(f.sqlite, 'submission_arrival_facts')).toBe(1);
      expect(count(f.sqlite, 'submission_triage_heads')).toBe(1);
      expect(count(f.sqlite, 'submission_triage_event_heads')).toBe(1);
      expect(f.sqlite.query<{
        readonly classification: string;
        readonly state: string;
      }, [string]>(`
        SELECT arrival.classification, head.state
          FROM submission_arrival_facts AS arrival
          JOIN submission_triage_heads AS head
            ON head.workspace_id = arrival.workspace_id
           AND head.event_id = arrival.event_id
           AND head.submission_id = arrival.submission_id
         WHERE arrival.submission_id = ?
      `).get(submit.data.submission.submissionId)).toEqual({
        classification: 'on_time', state: 'inbox'
      });
      expect(count(f.sqlite, 'intake_public_mutation_facts')).toBe(3);
      expect(count(f.sqlite, 'public_mutation_registered_effect_completions')).toBe(1);
      expect(f.directory.resolve(f.evidence.ceremonyEvidenceId)).toBeUndefined();

      const submittedReferenceResolution =
        createSQLiteIntakeFormProgramVocabularyReferenceAdapter().read({
          sqlite: f.sqlite,
          scope: { workspaceId, eventId }
        });
      expect(submittedReferenceResolution.kind).toBe('available');
      if (submittedReferenceResolution.kind !== 'available') {
        throw new TypeError('submitted_reference_snapshot_missing');
      }
      const submittedReferences = (
        submittedReferenceResolution.snapshot as ProgramReferenceContributorSnapshot
      );
      expect(submittedReferences.references).toContainEqual(expect.objectContaining({
        referenceKey:
          `intake_submission:${submit.data.submission.submissionId}:field:${trackFieldId}:choice:${trackChoiceId}`,
        version: 1,
        item: { kind: 'track', id: trackChoiceId },
        mode: 'historical',
        destination: { kind: 'intake.submission.answer', id: submit.data.submission.submissionId }
      }));

      const restarted = f.restartDirectory();
      const terminal = restarted.admit({ formId, continuation: f.token });
      expect(terminal.kind).toBe('terminal');
      if (terminal.kind !== 'terminal') throw new TypeError('expected terminal');
      expect(terminal.receipt.result).toEqual(submit);
      expect(restarted.admit({ formId: id(77), continuation: f.token }))
        .toEqual({ kind: 'stopped', reason: 'not_available' });

      const currentHead = f.repository.readFormHead({ workspaceId, eventId }, formId);
      const existingVersions = f.repository.readFormVersions({ workspaceId, eventId }, formId);
      if (!currentHead) throw new TypeError('missing form head');
      const registryState = f.registryStore.readFieldRegistry({ workspaceId, eventId });
      const titleField = registryState?.fields.find((field) => field.id === titleId);
      if (!registryState || !titleField) throw new TypeError('registry_title_missing');
      const titleEdit = planFieldRegistryMutation({
        state: registryState,
        formReferences: f.registryStore,
        author: {
          action: 'edit',
          scope: { workspaceId, eventId },
          request: {
            fieldId: titleId,
            expectedFieldVersion: titleField.version,
            expectedRegistryVersion: registryState.version,
            changes: { label: 'Current proposal title' }
          },
          choiceIdentities: []
        }
      });
      f.sqlite.exec('BEGIN IMMEDIATE');
      f.registryStore.applyFieldRegistryPlan(titleEdit);
      f.sqlite.query(`UPDATE program_vocabulary_sets
         SET set_version = 3, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND set_version = 2`)
        .run(Date.parse(republishedAt), workspaceId, eventId);
      f.sqlite.query(`UPDATE program_vocabulary_tracks
         SET name = 'Current AI', version = 2, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = 1`)
        .run(Date.parse(republishedAt), workspaceId, eventId, trackChoiceId);
      f.sqlite.exec('COMMIT');
      const currentRegistry = f.repository.readFieldRegistrySnapshot({ workspaceId, eventId });
      if (!currentRegistry) throw new TypeError('registry_snapshot_missing');
      const republish = planFormPublication({
        head: currentHead,
        registry: currentRegistry,
        existingVersions,
        authorInput: {
          formId,
          expectedDefinitionVersion: currentHead.version,
          expectedRegistryVersion: currentRegistry.version
        },
        references: f.repository,
        server: {
          formVersionId: republishedFormVersionId,
          publishedByUserId: userId,
          publishedAt: republishedAt
        }
      });
      f.sqlite.exec('BEGIN IMMEDIATE');
      try {
        f.repository.applyFormMutation(republish);
        f.sqlite.exec('COMMIT');
      } catch (error) {
        f.sqlite.exec('ROLLBACK');
        throw error;
      }

      const currentServed = f.repository.readServedForm({ workspaceId, eventId }, formId);
      expect(currentServed?.formVersionId).toBe(republishedFormVersionId);
      expect(currentServed?.fields.find((field) => field.id === titleId))
        .toMatchObject({ label: 'Current proposal title' });
      expect(currentServed?.fields.find((field) => field.id === trackFieldId))
        .toMatchObject({
          label: 'Track',
          options: [{ id: trackChoiceId, label: 'Current AI', position: 0 }]
        });
      expect(f.repository.listSubmissions({ workspaceId, eventId })[0]).toMatchObject({
        title: 'A precise proposal'
      });
      const safeDetail = f.repository.readSubmissionDetail({ workspaceId, eventId },
        submit.data.submission.submissionId);
      expect(safeDetail).toMatchObject({
        formVersionId,
        affirmedConsentFieldIds: [consentId]
      });
      expect(safeDetail?.answers).toContainEqual({
        kind: 'text', fieldId: titleId, fieldLabel: 'Talk title',
        value: 'A precise proposal'
      });
      expect(safeDetail?.answers).toContainEqual({
        kind: 'checkbox', fieldId: consentId,
        fieldLabel: 'I agree to the code of conduct and to my session being recorded if accepted',
        checked: true
      });
      expect(safeDetail?.answers).toContainEqual({
        kind: 'select', fieldId: trackFieldId, fieldLabel: 'Track',
        choice: { id: trackChoiceId, label: 'Applied AI' }
      });
      const safeJson = JSON.stringify(safeDetail);
      expect(safeJson).not.toContain('speaker@example.test');
      expect(safeJson).not.toContain('payloadRef');
      expect(safeJson).not.toContain('digestSha256');
      expect(safeJson).not.toContain('canonicalBytes');
      expect(f.repository.readSubmissionContact({ workspaceId, eventId },
        submit.data.submission.submissionId)).toMatchObject({
        email: 'speaker@example.test'
      });
      const submitPlanRow = f.sqlite.query<{ readonly source_plan_json: string }, []>(`
        SELECT source_plan_json FROM intake_public_mutation_facts
         WHERE action = 'submit' LIMIT 2
      `).get();
      if (!submitPlanRow) throw new TypeError('missing_submit_plan');
      const submitPlan = parseApplicationMutationPlan(JSON.parse(submitPlanRow.source_plan_json));
      if (submitPlan.action !== 'submit') throw new TypeError('wrong_submit_plan');
      expect(() => f.projection.projectSummary({
        head: submitPlan.submission,
        submitEvidence: submitPlan.submitEvidence,
        version: { ...storedVersion, formId: id(9900) },
        draftHead: submitPlan.afterHead,
        sourceRevision: submitPlan.sourceRevision
      })).toThrow();
      const classifiedCanaries = [
        'A precise proposal',
        'speaker@example.test'
      ];
      const classifiedHashes = classifiedCanaries.map((value) =>
        createHash('sha256').update(value).digest('hex')
      );
      const nonStoreTables = [
        'intake_application_draft_revisions',
        'intake_submission_submit_evidence',
        'intake_public_mutation_facts'
      ];
      const nonStoreRows = JSON.stringify(nonStoreTables.flatMap((table) =>
        f.sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all()
      ));
      for (const canary of [...classifiedCanaries, ...classifiedHashes]) {
        expect(nonStoreRows).not.toContain(canary);
      }
      expect(nonStoreRows).not.toContain('canonicalBytes');
      expect(nonStoreRows).not.toContain('integrityDigest');
      expect(nonStoreRows).not.toContain('scopeBinding');
    } finally { f.close(); }
  });

  test('rolls all save, payload, receipt and evidence rows back and zeroizes bytes on substituted child evidence', async () => {
    const f = await fixture({ mismatchChild: true });
    try {
      await f.execute({ action: 'begin', input: { formId } });
      const tables = [
        'intake_application_draft_heads', 'intake_application_draft_revisions',
        'classified_payload_records', 'intake_submission_heads',
        'intake_submission_submit_evidence', 'intake_submission_participant_evidence',
        'intake_submission_consent_evidence', 'intake_public_mutation_receipt_links',
        'intake_public_mutation_facts', 'intake_public_mutation_pointers',
        'intake_public_mutation_timeline', 'public_mutation_registered_effect_completions',
        'operation_log'
      ] as const;
      const before = new Map(tables.map((table) => [table, count(f.sqlite, table)]));
      await expect(f.execute({
        action: 'save', input: {
          expectedDraftVersion: 1,
          answers: [
            { kind: 'text', fieldId: titleId, value: 'Rollback canary title' },
            { kind: 'email', fieldId: emailId, value: 'rollback@example.test' },
            { kind: 'checkbox', fieldId: consentId, checked: true }
          ]
        }
      })).rejects
        .toMatchObject({ name: 'OperationExecutionError', phase: 'effect_contributions' });
      for (const table of tables) {
        const expected = before.get(table);
        if (expected === undefined) throw new TypeError(`missing table count: ${table}`);
        expect(count(f.sqlite, table), table).toBe(expected);
      }
      expect(f.capturedBuffers).toHaveLength(2);
      expect(f.capturedBuffers.every((buffer) => buffer.every((byte) => byte === 0)))
        .toBe(true);
      expect(JSON.stringify(f.sqlite.query('SELECT * FROM classified_payload_records').all()))
        .not.toContain('Rollback canary title');
      expect(f.repository.readDraft({ workspaceId, eventId }, draftId)?.head.version)
        .toBe(1);
    } finally { f.close(); }
  });

  test('rejects input policy before classified adoption or durable mutation', async () => {
    const f = await fixture();
    try {
      await f.execute({ action: 'begin', input: { formId } });
      const tables = [
        'classified_payload_records', 'intake_application_draft_heads',
        'intake_application_draft_revisions', 'intake_submission_heads',
        'intake_public_mutation_facts', 'operation_log'
      ] as const;
      const before = new Map(tables.map((table) => [table, count(f.sqlite, table)]));
      const buffersBefore = f.capturedBuffers.length;
      f.refuseInputPolicy();
      const refused = await f.execute({
        action: 'save',
        input: {
          expectedDraftVersion: 1,
          answers: [{ kind: 'text', fieldId: titleId, value: 'must not be adopted' }]
        }
      });
      expect(refused).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: { class: 'policy_violation', kind: 'intake.refused', retryable: false }
      });
      expect(f.capturedBuffers).toHaveLength(buffersBefore);
      for (const table of tables) expect(count(f.sqlite, table)).toBe(before.get(table)!);
    } finally { f.close(); }
  });

  test('database constraints reject cross-bound fact and timeline scope, action, digest and time', async () => {
    const f = await fixture();
    try {
      await f.execute({ action: 'begin', input: { formId } });
      const sourceReceipt = f.sqlite.query<{ readonly receipt_id: string }, []>(`
        SELECT receipt_id FROM intake_public_mutation_receipt_links LIMIT 1
      `).get()?.receipt_id;
      if (!sourceReceipt) throw new TypeError('missing source receipt');
      const secondReceipt = id(8000);
      f.sqlite.query(`
        INSERT INTO operation_log (
          id, operation_name, operation_version, registry_digest_sha256, surface,
          actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
          summary, occurred_at_ms, correlation_id, scope_partition_key,
          idempotency_verifier_profile_key,
          idempotency_verifier_profile_version, idempotency_key_verifier,
          request_hash, result_json, action_batch_id, action_step_id
        )
        SELECT ?, operation_name, operation_version, registry_digest_sha256, surface,
          actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
          summary, occurred_at_ms, correlation_id, scope_partition_key,
          idempotency_verifier_profile_key,
          idempotency_verifier_profile_version, ?, request_hash,
          json_set(result_json, '$.receipt.id', ?), action_batch_id, action_step_id
        FROM operation_log WHERE id = ?
      `).run(secondReceipt, 'c'.repeat(64), secondReceipt, sourceReceipt);
      f.sqlite.query(`
        INSERT INTO intake_public_mutation_receipt_links (
          receipt_id, ceremony_evidence_id, workspace_id, event_id, draft_id,
          action, plan_digest_sha256, operation_name, operation_version,
          occurred_at_ms, participant_attribution_evidence_json
        )
        SELECT ?, ceremony_evidence_id, workspace_id, event_id, draft_id,
          action, plan_digest_sha256, operation_name, operation_version,
          occurred_at_ms, participant_attribution_evidence_json
        FROM intake_public_mutation_receipt_links WHERE receipt_id = ?
      `).run(secondReceipt, sourceReceipt);
      const link = f.sqlite.query<{
        readonly plan_digest_sha256: string;
        readonly occurred_at_ms: number;
      }, [string]>('SELECT plan_digest_sha256, occurred_at_ms FROM intake_public_mutation_receipt_links WHERE receipt_id = ?')
        .get(secondReceipt);
      if (!link) throw new TypeError('missing second link');
      const insertFact = (action: string, event: string, digest: string, occurredAt: number) =>
        f.sqlite.query(`
          INSERT INTO intake_public_mutation_facts (
            fact_id, receipt_id, fact_kind, action, workspace_id, event_id,
            plan_digest_sha256, source_plan_json, occurred_at_ms
          ) VALUES (?, ?, 'application_draft_changed', ?, ?, ?, ?, '{}', ?)
        `).run(id(8100), secondReceipt, action, workspaceId, event, digest, occurredAt);
      expect(() => insertFact('save', eventId, link.plan_digest_sha256,
        link.occurred_at_ms)).toThrow();
      expect(() => insertFact('begin', otherEventId, link.plan_digest_sha256,
        link.occurred_at_ms)).toThrow();
      expect(() => insertFact('begin', eventId, 'd'.repeat(64),
        link.occurred_at_ms)).toThrow();
      expect(() => insertFact('begin', eventId, link.plan_digest_sha256,
        link.occurred_at_ms + 1)).toThrow();

      insertFact('begin', eventId, link.plan_digest_sha256, link.occurred_at_ms);
      const insertTimeline = (action: string, event: string, occurredAt: number) =>
        f.sqlite.query(`
          INSERT INTO intake_public_mutation_timeline (
            timeline_id, receipt_id, fact_id, workspace_id, event_id,
            action, source_kind, occurred_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'domain_fact', ?)
        `).run(id(8200), secondReceipt, id(8100), workspaceId, event, action, occurredAt);
      expect(() => insertTimeline('save', eventId, link.occurred_at_ms)).toThrow();
      expect(() => insertTimeline('begin', otherEventId, link.occurred_at_ms)).toThrow();
      expect(() => insertTimeline('begin', eventId, link.occurred_at_ms + 1)).toThrow();
      expect(f.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { f.close(); }
  });
});
