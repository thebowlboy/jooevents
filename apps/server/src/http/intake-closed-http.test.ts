import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createClassifiedPayloadProfileRef,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  type InvocationEvidence,
  type OperationRegistryModule
} from '@jooevents/application';
import { createPublicEffectConformanceBoundary } from '@jooevents/application/public-effect-conformance';
import {
  createPublicMutationContinuationBoundary,
  type PublicMutationContinuationPolicy,
  type RegisteredPublicMutationBootstrapVerifier
} from '@jooevents/application/public-mutation-continuation';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  intakeIdSchema,
  organizerFormCatalogSchema,
  organizerFormDetailSchema,
  organizerSubmissionContactSchema,
  organizerSubmissionDetailSchema,
  organizerSubmissionSummarySchema,
  publicApplicationDraftResumeSchema,
  servedPublicFormSchema,
  type FormDefinitionCreateAuthorInput
} from '@jooevents/contracts';
import {
  issueFormOrdinaryPolicy,
  issuePublicInputPolicyEvaluator
} from '@jooevents/intake';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_EVENT_READ_ACCESS_POLICY,
  INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS,
  INTAKE_SUBMISSION_READ_ACCESS_POLICY,
  createIntakeFormDraftOperationModule,
  createIntakePublicConformanceMutationOperationModule,
  createIntakePublicConformanceReadOperationModule,
  createIntakeReadOperationModule,
  intakeFormDraftOperationResultSchema,
  intakePublicMutationOperationResultSchema,
  type IntakeReadPort
} from '@jooevents/intake-operations';
import {
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parsePublicPolicyRevisionId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import type { CurrentAuthorityResolver } from '@jooevents/identity-access';
import { createSubmissionTriageSubmitInitializer } from '@jooevents/submission-triage';
import { openSQLite } from '@jooevents/persistence';
import { installSQLiteChangesetLifecycleSchema } from '@jooevents/persistence/changeset-lifecycle';
import { createSQLiteChangesetLifecycleEffectDomainRouter } from '@jooevents/persistence/changeset-lifecycle-effect-domain-router';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from '@jooevents/persistence/event-spine';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema
} from '@jooevents/persistence/field-registry';
import { SQLiteIntakeClassifiedProjection } from '@jooevents/persistence/intake-classified-projection';
import {
  createSQLiteIntakeFormChangesetEffectDomainRegistration,
  installIntakeFormChangesetEffectSchema
} from '@jooevents/persistence/intake-form-changeset-effect-domain';
import {
  createSQLiteIntakeFormDraftEffectDomainRegistration,
  installSQLiteIntakeFormDraftEffectSchema
} from '@jooevents/persistence/intake-form-draft-effect-domain';
import {
  INTAKE_PUBLIC_CONTINUATION_HEADER,
  INTAKE_PUBLIC_CONTINUATION_MINT_PATH,
  INTAKE_PUBLIC_FORM_SELECTOR_HEADER,
  createIntakePublicCeremonyBoundaryRegistry,
  createIntakePublicCeremonyDirectory,
  type IntakePublicCeremonyDirectory
} from '@jooevents/persistence/intake-public-ceremony';
import {
  createSQLiteIntakePublicMutationEffectDomainRegistration,
  installSQLiteIntakePublicMutationEffectSchema,
  type SQLiteIntakePublicMutationEffectIds
} from '@jooevents/persistence/intake-public-mutation-effect-domain';
import {
  installSQLiteIntakeSchema,
  SQLiteIntakeRepository
} from '@jooevents/persistence/intake';
import { installDeadlineSchema } from '@jooevents/persistence/deadline';
import { installProgramVocabularySchema } from '@jooevents/persistence/program-vocabulary';
import {
  installSQLiteSubmissionTriageSchema,
  SQLiteIntakeSubmissionTriageSourceAdapter,
  SQLiteSubmissionTriageRepository
} from '@jooevents/persistence/submission-triage';
import {
  installSQLitePublicMutationEffectCompletion,
  SQLitePublicMutationEffectCompletionPort
} from '@jooevents/persistence/public-mutation-effect-completion';
import {
  installSQLiteClassifiedPayloadStoreSchema,
  SQLiteClassifiedPayloadStore
} from '@jooevents/persistence/sqlite-classified-payload-store';
import {
  createSQLiteEffectDomainAdapterRegistry,
  SQLiteEffectUnitOfWorkPort,
  type SQLiteEffectDomainAdapter
} from '@jooevents/persistence/sqlite-effect-unit-of-work';
import {
  createSQLiteIntakeParticipantAttributionConformance,
  installSQLiteIntakeParticipantAttributionConformanceSchema
} from '@jooevents/persistence/testing/intake-participant-attribution-conformance';
import { installFoundationTrialUnitOfWorkSchema } from '@jooevents/persistence/testing/foundation-trial-uow';
import {
  installSQLitePublicMutationContinuationTrial,
  SQLitePublicMutationContinuationTrial
} from '@jooevents/persistence/testing/public-mutation-continuation-trial';
import { Hono } from 'hono';
import { createHttpApp } from './app';
import { createOperatorOperationsHttpAdapter } from './operator-operations';
import { createPublicOperationsHttpAdapter } from './public-operations';

const uuid = (suffix: number): string =>
  `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(1));
const eventId = parseEventId(uuid(2));
const userId = parseUserId(uuid(3));
const membershipId = parseMembershipId(uuid(4));
const formId = uuid(5);
const formVersionId = uuid(6);
const titleFieldId = uuid(7);
const emailFieldId = uuid(8);
const consentFieldId = uuid(9);
const applicantA = Object.freeze({
  name: 'applicant-a', draftId: uuid(10), personId: uuid(11), participantIdentityId: uuid(12)
});
const applicantB = Object.freeze({
  name: 'applicant-b', draftId: uuid(13), personId: uuid(14), participantIdentityId: uuid(15)
});
const now = parseInstant('2026-08-12T12:00:00.000Z');
const publicPolicyRevisionId = parsePublicPolicyRevisionId(uuid(16));
const continuationBinding = Object.freeze({
  key: 'intake.closed-http', version: parseContractVersion(1)
});
const bootstrapRef = Object.freeze({
  key: 'intake.closed-http-bootstrap', version: parseContractVersion(1)
});
const profile = Object.freeze({ key: 'intake-closed-http', version: parseContractVersion(1) });

type CanonicalRegistry = ReturnType<typeof initializeCanonicalFieldRegistry>;

function formDefinition(registry: CanonicalRegistry): FormDefinitionCreateAuthorInput {
  const included = new Set([titleFieldId, emailFieldId, consentFieldId]);
  return {
    kind: 'cfp',
    name: 'Main application',
    target: { kind: 'general_pool' },
    availability: { kind: 'evergreen' },
    confirmation: 'Application received.',
    composition: {
      excludedFieldIds: registry.fields
        .filter((field) => field.scope.kind === 'shared'
          && field.contexts.apply.visible
          && !included.has(field.id))
        .map((field) => field.id)
        .sort(),
      requiredOverrides: {},
      optionExposure: {}
    },
    rules: []
  };
}

const classifiedProfiles = Object.freeze({
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

const operatorEvidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'verified-intake-closed-http-session'
});

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function transaction<Result>(
  sqlite: ReturnType<typeof openSQLite>['sqlite'],
  work: () => Result
): Result {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function seed(sqlite: ReturnType<typeof openSQLite>['sqlite']): CanonicalRegistry {
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Intake HTTP workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Intake owner', 1, 1, 1)
  `).run(userId);
  let baselineFieldSuffix = 0x2000;
  let baselineChoiceSuffix = 0x3000;
  return transaction(sqlite, () => {
    sqlite.query(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
    `).run(workspaceId);
    sqlite.query(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Intake Event', 'UTC', '2026-08-12', '2026-08-13', 1, ?, ?, ?)
    `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
    sqlite.query(`
      INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
    `).run(workspaceId, eventId);
    sqlite.query(`
      UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
       WHERE workspace_id = ?
    `).run(eventId, workspaceId);
    return initializeCanonicalFieldRegistry({
      sqlite,
      scope: { workspaceId, eventId },
      ids: {
        newFieldId(key) {
          if (key === 'talk.title') return titleFieldId;
          if (key === 'person.email') return emailFieldId;
          if (key === 'person.recording_consent') return consentFieldId;
          return uuid(baselineFieldSuffix++);
        },
        newChoiceId() { return uuid(baselineChoiceSuffix++); }
      }
    });
  });
}

function continuationPolicy(): PublicMutationContinuationPolicy {
  const key = (value: number) => new Uint8Array(32).fill(value);
  return Object.freeze({
    binding: continuationBinding,
    publicPolicyRevisionId,
    operation: { name: 'application.public.mutate', version: parseContractVersion(1) },
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
      reference: { key: 'intake.continuation', version: parseContractVersion(1) }, keyBytes: key(1)
    }] as const,
    principalPartitionProfile: {
      reference: { key: 'intake.partition', version: parseContractVersion(1) }, keyBytes: key(2)
    },
    bootstrapReplayProfile: {
      reference: { key: 'intake.bootstrap-replay', version: parseContractVersion(1) }, keyBytes: key(3)
    }
  });
}

function lateChildFault(
  base: SQLiteEffectDomainAdapter,
  active: () => boolean
): SQLiteEffectDomainAdapter {
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    ...(base.afterReceiptParentInserted
      ? { afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base) }
      : {}),
    afterReceiptChildInserted(receiptId, contribution) {
      const changed = structuredClone(contribution) as Record<string, unknown>;
      if (active() && changed.kind === 'timeline') changed.timelineId = uuid(0xfff);
      return base.afterReceiptChildInserted?.(receiptId, changed);
    },
    ...(base.afterExecutionClaimReleased
      ? { afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base) }
      : {})
  };
}

function omitSharedIntakeInfrastructure(
  module: OperationRegistryModule,
  options: { readonly readTrace: boolean }
): OperationRegistryModule {
  return Object.freeze({
    ...module,
    source: Object.freeze({
      ...module.source,
      schemas: (module.source.schemas ?? []).filter((entry) =>
        entry.reference.key !== 'schema.intake.operation.null-detail'
      ),
      operationAuditRecordProfiles: (module.source.operationAuditRecordProfiles ?? [])
        .filter((entry) =>
          entry.reference.key !== 'record-profile.intake.operation-audit'
        ),
      ...(options.readTrace
        ? {
            readOperationalTraceTargets: (module.source.readOperationalTraceTargets ?? [])
              .filter((entry) => entry.reference.key !== 'trace.intake.read')
          }
        : {})
    })
  });
}

function operatorRequest(body: unknown, key: string, correlation = uuid(0x900)): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-correlation-id': correlation
    },
    body: JSON.stringify(body)
  };
}

function publicRequest(input: {
  readonly method?: 'GET' | 'POST';
  readonly token: string;
  readonly body?: unknown;
  readonly key?: string;
  readonly correlation?: string;
}): RequestInit {
  const headers: Record<string, string> = {
    [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
    [INTAKE_PUBLIC_CONTINUATION_HEADER]: input.token,
    'x-correlation-id': input.correlation ?? uuid(0x901)
  };
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  if (input.key !== undefined) headers['idempotency-key'] = input.key;
  return {
    method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  };
}

async function openFixture() {
  const { sqlite } = openSQLite(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteSubmissionTriageSchema(sqlite);
  installSQLiteIntakeFormDraftEffectSchema(sqlite);
  installIntakeFormChangesetEffectSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLitePublicMutationContinuationTrial(sqlite);
  installSQLitePublicMutationEffectCompletion(sqlite);
  installSQLiteIntakeParticipantAttributionConformanceSchema(sqlite);
  installSQLiteIntakePublicMutationEffectSchema(sqlite);
  const fieldRegistry = seed(sqlite);

  let generated = 0x100;
  const next = () => uuid(generated++);
  const clock = Object.freeze({ now: () => now });
  const encryption = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.intake-closed-http', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x44)
  });
  let nonce = 1;
  const rawClassifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: encryption,
    nonceSource: () => new Uint8Array(12).fill(nonce++)
  });
  const capturedBuffers: Uint8Array[] = [];
  const classifiedStore: SynchronousClassifiedPayloadStore = Object.freeze({
    put(input: Parameters<SynchronousClassifiedPayloadStore['put']>[0]) {
      capturedBuffers.push(input.bytes);
      return rawClassifiedStore.put(input);
    },
    read(input: Parameters<SynchronousClassifiedPayloadStore['read']>[0]) {
      return rawClassifiedStore.read(input);
    }
  });
  const projection = new SQLiteIntakeClassifiedProjection({
    store: classifiedStore,
    profiles: classifiedProfiles
  });
  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  }, projection);

  const formPolicy = issueFormOrdinaryPolicy({
    key: 'intake.form.bounded', version: 1, ordinaryRisk: 'low',
    approval: { ordinary: 'none' }
  });
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const formEntityIds = [formId];
  const formDraftRegistration = createSQLiteIntakeFormDraftEffectDomainRegistration({
    sqlite,
    workspaceId,
    policy: formPolicy,
    repository,
    eventRelationships,
    ids: {
      newChangesetId: next,
      newRevisionId: next,
      newPreparationHandle: next,
      newTimelineId: next,
      newFormEntityId() {
        const value = formEntityIds.shift();
        if (!value) throw new TypeError('intake_closed_http_form_id_exhausted');
        return value;
      },
      newFormVersionId: () => formVersionId
    }
  });
  const formLifecycleRegistration =
    createSQLiteIntakeFormChangesetEffectDomainRegistration({
      sqlite,
      workspaceId,
      policy: formPolicy,
      repository,
      eventRelationships,
      ids: {
        newChangesetId: next,
        newRevisionId: next,
        newApprovalId: next,
        newCorrectionAttemptId: next,
        newPreparationHandle: next,
        newTimelineId: next,
        newFactId: next,
        newPointerId: next
      }
    });
  const routedLifecycle = createSQLiteChangesetLifecycleEffectDomainRouter([{
    ownerId: formLifecycleRegistration.ownerId,
    adapter: formLifecycleRegistration.adapter,
    ownerResolution: formLifecycleRegistration.ownerResolution,
    subjectRelationships: formLifecycleRegistration.subjectRelationships
  }]);

  let audit = 0x500;
  let ceremony = 0x600;
  let randomSeed = 0x20;
  const continuationStore = new SQLitePublicMutationContinuationTrial(sqlite, {
    clock,
    newAuditEventId: () => parseAuditEventId(uuid(audit++)),
    newCompletionReference: () => `pcr_${String(audit++).padStart(24, '0')}`
  });
  const bootstrapVerifier: RegisteredPublicMutationBootstrapVerifier = Object.freeze({
    reference: bootstrapRef,
    verify(input: Parameters<RegisteredPublicMutationBootstrapVerifier['verify']>[0]) {
      const applicant = (input.protocolEvidence as { readonly applicant?: unknown } | null)
        ?.applicant;
      if (applicant !== applicantA.name && applicant !== applicantB.name) {
        return Object.freeze({ kind: 'rejected' as const, reason: 'origin_rejected' as const });
      }
      return Object.freeze({
        kind: 'verified' as const,
        principalPartitionMaterial: new TextEncoder().encode(`principal:${applicant}`),
        bootstrapReplayMaterial: new TextEncoder().encode(`bootstrap:${applicant}`),
        originEvidenceId: `poe_${applicant}_0123456789`,
        csrfEvidenceId: `pce_${applicant}_0123456789`,
        rateLimitEvidenceId: `pre_${applicant}_0123456789`,
        replayEvidenceId: `ppe_${applicant}_0123456789`
      });
    }
  });
  const completion = new SQLitePublicMutationEffectCompletionPort(sqlite, {
    clock,
    newAuditEventId: () => parseAuditEventId(uuid(audit++))
  });
  const actionAnchors = [applicantA.draftId, applicantB.draftId];
  const makeDirectory = (): IntakePublicCeremonyDirectory => {
    const boundary = createPublicMutationContinuationBoundary({
      binding: continuationBinding,
      policies: { resolve: () => continuationPolicy() },
      bootstrapVerifiers: { resolve: () => bootstrapVerifier },
      store: continuationStore,
      clock,
      newActionAnchorId() {
        const value = actionAnchors.shift();
        if (!value) throw new TypeError('intake_closed_http_draft_id_exhausted');
        return value;
      },
      newCeremonyEvidenceId: () => parseCeremonyEvidenceId(uuid(ceremony++)),
      newAuditEventId: () => parseAuditEventId(uuid(audit++)),
      randomBytes(size) {
        return new Uint8Array(size).fill(randomSeed++);
      }
    });
    return createIntakePublicCeremonyDirectory(
      createIntakePublicCeremonyBoundaryRegistry([{
        formId, formVersionId, boundary, completion
      }])
    );
  };
  const directory = makeDirectory();
  const participantAttribution =
    createSQLiteIntakeParticipantAttributionConformance(sqlite);
  const inputPolicy = issuePublicInputPolicyEvaluator({
    policy: { key: 'intake.closed-http-input', version: 1 },
    issueEvaluationId: next,
    decide: () => ({ disposition: 'allow', reasonCode: null, remedyCode: null })
  });
  const publicIds: SQLiteIntakePublicMutationEffectIds = {
    newPreparationHandle: next,
    newRevisionId: next,
    newPayloadRefId: next,
    newSubmissionId: next,
    newSubmitEvidenceId: next,
    newParticipantEvidenceId: next,
    newConsentEvidenceId: next,
    newFactId: next,
    newPointerId: next,
    newTimelineId: next,
    newCompletionReference: () => `pcr_${String(generated++).padStart(24, '0')}`
  };
  const submissionTriage = createSubmissionTriageSubmitInitializer({
    store: new SQLiteSubmissionTriageRepository(
      sqlite,
      new SQLiteIntakeSubmissionTriageSourceAdapter(repository)
    ),
    ids: { newArrivalId: next }
  });
  const publicRegistration = createSQLiteIntakePublicMutationEffectDomainRegistration({
    sqlite,
    workspaceId,
    repository,
    projection,
    classifiedStore,
    classifiedProfiles,
    inputPolicy,
    ceremonies: directory,
    participantAttribution,
    submissionTriage,
    ids: publicIds
  });
  let injectLateFault = false;
  const publicAdapter = lateChildFault(
    publicRegistration.adapter,
    () => injectLateFault
  );

  let contactPermissions = new Set<string>(
    INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS
  );
  const authority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
    async resolve(input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
      if (input.evidence.kind === 'public_ceremony') {
        return directory.currentAuthority.resolve(input);
      }
      if (input.evidence.kind === 'public_open') {
        if (input.lane.kind !== 'public_open'
            || input.lane.surface !== 'public_http'
            || input.lane.policy.key !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.key
            || input.lane.policy.version !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.version
            || input.evidence.publicPolicyRevisionId !== publicPolicyRevisionId) {
          return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
        }
        return Object.freeze({
          kind: 'authorized' as const,
          authority: Object.freeze({
            actor: Object.freeze({
              kind: 'public_request' as const,
              publicPolicyRevisionId,
              authority: Object.freeze({ kind: 'open_policy' as const })
            }),
            principal: Object.freeze({
              kind: 'public_capability' as const,
              publicPolicyRevisionId,
              authority: Object.freeze({ kind: 'open_policy' as const })
            }),
            lane: input.lane,
            scope: input.scope,
            grants: Object.freeze([{
              kind: 'public_policy' as const,
              key: input.operation.name
            }]),
            evidenceIds: Object.freeze(['intake-public-open.current']),
            authorityCitationIds: Object.freeze([]),
            evaluatedAt: input.evaluatedAt
          })
        });
      }
      if (input.evidence.kind !== 'operator'
          || input.lane.kind !== 'operator'
          || input.lane.surface !== 'operator_http') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      let permissions: readonly string[];
      if (input.lane.policy.key === INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY.key) {
        if (!INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS.every((permission) =>
          contactPermissions.has(permission))) {
          return Object.freeze({ kind: 'denied' as const, reason: 'not_authorized' as const });
        }
        permissions = INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS;
      } else if (input.lane.policy.key === INTAKE_SUBMISSION_READ_ACCESS_POLICY.key) {
        permissions = ['submission.read'];
      } else if (input.lane.policy.key === INTAKE_EVENT_READ_ACCESS_POLICY.key) {
        permissions = ['event.read'];
      } else {
        permissions = ['event.manage'];
      }
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({
            kind: 'workspace_user' as const, userId, membershipId
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze(permissions.map((permission) => Object.freeze({
            kind: 'permission' as const,
            key: permission
          }))),
          evidenceIds: Object.freeze(['intake-membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  });

  const read: IntakeReadPort = Object.freeze({
    listForms: repository.listForms.bind(repository),
    readForm: repository.readFormDetail.bind(repository),
    readServedForm: repository.readServedForm.bind(repository),
    listSubmissions: repository.listSubmissions.bind(repository),
    readSubmission: repository.readSubmissionDetail.bind(repository),
    readSubmissionContact: repository.readSubmissionContact.bind(repository),
    readPublicDraftResume(
      scope: Parameters<IntakeReadPort['readPublicDraftResume']>[0],
      binding: Parameters<IntakeReadPort['readPublicDraftResume']>[1]
    ) {
      const data = repository.readPublicDraftResume(scope, binding);
      return data ? Object.freeze({ binding, data }) : undefined;
    }
  });
  const keySealer = createHmacIdempotencyCredentialSealer({
    profile,
    keyBytes: new Uint8Array(32).fill(0x55)
  });
  const readCrypto = Object.freeze({
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile
  });
  const effectCrypto = Object.freeze({
    ...readCrypto,
    requestHashSealer: createHmacRequestHashSealer({
      profile: INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x56)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const currentEvent = Object.freeze({
    resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] })
  });
  const publicBoundary = createPublicEffectConformanceBoundary();
  const operatorReads = createIntakeReadOperationModule({
    workspaceId,
    policies: {
      eventRead: INTAKE_EVENT_READ_ACCESS_POLICY,
      eventManage: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
      submissionRead: INTAKE_SUBMISSION_READ_ACCESS_POLICY,
      submissionContactRead: INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
      publicOpen: INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
      publicCeremony: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY
    },
    currentAuthority: authority,
    currentEvent,
    read,
    clock,
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: readCrypto
  });
  const publicReads = createIntakePublicConformanceReadOperationModule({
    policies: {
      publicOpen: INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
      publicCeremony: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY
    },
    currentAuthority: authority,
    publicFormScope: {
      resolve(input) {
        return input.formId === formId
            && input.publicPolicyRevisionId === publicPolicyRevisionId
          ? { workspaceId, eventId, evidenceIds: ['form.served'] }
          : undefined;
      }
    },
    ceremonyScope: directory,
    read,
    clock,
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: readCrypto
  });
  const formDrafts = createIntakeFormDraftOperationModule({
    workspaceId,
    policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent,
    clock,
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: effectCrypto
  });
  const changesets = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority,
    lifecycleStore: formLifecycleRegistration.lifecycleStore,
    ownerResolution: routedLifecycle.ownerResolution,
    clock,
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x57)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const publicMutations = createIntakePublicConformanceMutationOperationModule({
    policy: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
    currentAuthority: directory.currentAuthority,
    ceremonyScope: directory,
    publicEffectConformance: publicBoundary,
    clock,
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: {
      ...readCrypto,
      requestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x58)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: keySealer
    }
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    formDraftRegistration,
    routedLifecycle,
    { capability: publicRegistration.capability, adapter: publicAdapter }
  ]);
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => now
  });
  const runtime = await publicBoundary.createRuntime({
    source: composeOperationRegistryModules([
      operatorReads,
      omitSharedIntakeInfrastructure(publicReads, { readTrace: true }),
      formDrafts,
      changesets,
      omitSharedIntakeInfrastructure(publicMutations, { readTrace: false })
    ]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock,
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: next
  });

  const admittedByToken = new Map<string, ReturnType<typeof parseCeremonyEvidenceId>>();
  const createTransport = (servedDirectory: IntakePublicCeremonyDirectory) => {
    const evidenceByRequest = new WeakMap<Request, InvocationEvidence>();
    const http = new Hono();
    http.post(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, async (context) => {
      const selected = context.req.header(INTAKE_PUBLIC_FORM_SELECTOR_HEADER);
      const applicant = context.req.header('x-intake-test-applicant');
      if (!selected || selected.includes(',') || !intakeIdSchema.safeParse(selected).success
          || (applicant !== applicantA.name && applicant !== applicantB.name)) {
        return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
      }
      const minted = await servedDirectory.mint({
        formId: selected,
        protocolEvidence: { applicant }
      });
      context.header('cache-control', 'no-store, max-age=0');
      return context.json(minted, minted.kind === 'issued' ? 201 : 409);
    });
    const ceremonyMiddleware = async (
      context: Parameters<Parameters<typeof http.use>[1]>[0],
      nextMiddleware: Parameters<Parameters<typeof http.use>[1]>[1]
    ) => {
      const selected = context.req.header(INTAKE_PUBLIC_FORM_SELECTOR_HEADER);
      const continuation = context.req.header(INTAKE_PUBLIC_CONTINUATION_HEADER);
      if (!selected || selected.includes(',') || !intakeIdSchema.safeParse(selected).success
          || !continuation || continuation.includes(',')) {
        return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
      }
      const admission = servedDirectory.admit({ formId: selected, continuation });
      if (admission.kind === 'terminal') {
        context.header('cache-control', 'no-store, max-age=0');
        return context.json(admission.receipt.result);
      }
      if (admission.kind === 'stopped') {
        return context.json({ kind: 'transport_error', code: 'not_available' }, 404);
      }
      const evidence: InvocationEvidence = Object.freeze({
        kind: 'public_ceremony', surface: 'public_http',
        client: { key: 'public.intake-closed-http' },
        ceremonyEvidenceId: admission.evidence.ceremonyEvidenceId
      });
      evidenceByRequest.set(context.req.raw, evidence);
      admittedByToken.set(continuation, admission.evidence.ceremonyEvidenceId);
      await nextMiddleware();
    };
    http.use('/api/public/forms/application', ceremonyMiddleware);
    http.use('/api/public/forms/application/mutate', ceremonyMiddleware);
    http.route('/', createOperatorOperationsHttpAdapter({
      operations: runtime,
      evidence: { verify: () => ({ kind: 'verified', evidence: operatorEvidence }) }
    }));
    http.route('/', createPublicOperationsHttpAdapter({
      operations: runtime,
      evidence: {
        verify({ request, binding }) {
          if (binding.path === '/api/public/forms/current') {
            return {
              kind: 'verified',
              evidence: {
                kind: 'public_open', surface: 'public_http',
                client: { key: 'public.intake-closed-http' },
                publicPolicyRevisionId
              } satisfies InvocationEvidence
            };
          }
          const evidence = evidenceByRequest.get(request);
          return evidence
            ? { kind: 'verified', evidence }
            : { kind: 'rejected', reason: 'unauthenticated' };
        }
      }
    }));
    return http;
  };
  const http = createTransport(directory);

  return {
    sqlite,
    repository,
    fieldRegistry,
    directory,
    http,
    capturedBuffers,
    enableLateFault() { injectLateFault = true; },
    disableLateFault() { injectLateFault = false; },
    setContactPermissions(permissions: readonly string[]) {
      contactPermissions = new Set(permissions);
    },
    restartTransport() { return createTransport(makeDirectory()); },
    registerApplicant(
      token: string,
      applicant: typeof applicantA | typeof applicantB
    ) {
      const ceremonyEvidenceId = admittedByToken.get(token);
      if (!ceremonyEvidenceId) throw new TypeError('intake_closed_http_admission_missing');
      const binding = directory.resolveCurrent(ceremonyEvidenceId);
      if (!binding) throw new TypeError('intake_closed_http_binding_missing');
      transaction(sqlite, () => participantAttribution.register({
        ceremonyEvidenceId,
        authorityPartitionDigestSha256: binding.authorityPartitionDigestSha256,
        personId: applicant.personId,
        participantIdentityId: applicant.participantIdentityId,
        evidenceIds: [`participant:${applicant.name}`]
      }));
    },
    close() { sqlite.close(); }
  };
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;

async function commitDraft(
  fixture: Fixture,
  path: string,
  input: unknown,
  key: string
) {
  const draftResponse = await fixture.http.request(
    path,
    operatorRequest(input, `${key}-draft`, uuid(0x910))
  );
  expect(draftResponse.status).toBe(200);
  const draft = intakeFormDraftOperationResultSchema.parse(await draftResponse.json());
  if (draft.kind !== 'success') throw new TypeError(`intake_closed_http_${key}_draft_failed`);
  const selector = Object.freeze({
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  });
  const proposalResponse = await fixture.http.request(
    '/api/changesets/proposals',
    operatorRequest({
      ...selector,
      expectedHeadVersion: draft.data.headVersion
    }, `${key}-propose`, uuid(0x911))
  );
  expect(proposalResponse.status).toBe(200);
  const proposal = changesetLifecycleOperationResultSchema.parse(
    await proposalResponse.json()
  );
  if (proposal.kind !== 'success' || proposal.data.action !== 'propose') {
    throw new TypeError(`intake_closed_http_${key}_proposal_failed`);
  }
  const commitResponse = await fixture.http.request(
    '/api/changesets/commits',
    operatorRequest({
      ...selector,
      expectedHeadVersion: proposal.data.diff.headVersion
    }, `${key}-commit`, uuid(0x912))
  );
  expect(commitResponse.status).toBe(200);
  const committed = changesetLifecycleOperationResultSchema.parse(
    await commitResponse.json()
  );
  if (committed.kind !== 'success' || committed.data.action !== 'commit') {
    throw new TypeError(`intake_closed_http_${key}_commit_failed`);
  }
  return Object.freeze({ draft, proposal, committed });
}

async function readFormDetail(fixture: Fixture) {
  const response = await fixture.http.request(
    `/api/events/current/forms/detail?formId=${formId}`,
    { headers: { 'x-correlation-id': uuid(0x913) } }
  );
  expect(response.status).toBe(200);
  const result = await response.json() as { readonly kind?: unknown; readonly data?: unknown };
  if (result.kind !== 'success') throw new TypeError('intake_closed_http_form_read_failed');
  return organizerFormDetailSchema.parse(result.data);
}

async function provisionOpenForm(fixture: Fixture) {
  const listResponse = await fixture.http.request('/api/events/current/forms', {
    headers: { 'x-correlation-id': uuid(0x914) }
  });
  expect(listResponse.status).toBe(200);
  const listedResult = await listResponse.json() as {
    readonly kind?: unknown;
    readonly data?: unknown;
  };
  if (listedResult.kind !== 'success') {
    throw new TypeError('intake_closed_http_form_list_failed');
  }
  const listed = organizerFormCatalogSchema.parse(listedResult.data);
  expect(listed).toMatchObject({
    schemaVersion: 1,
    catalogVersion: 1,
    registryPin: { version: fixture.fieldRegistry.version },
    forms: []
  });
  await commitDraft(fixture, '/api/events/current/forms/drafts/create', {
    expectedCatalogVersion: listed.catalogVersion,
    expectedRegistryVersion: listed.registryPin.version,
    definition: formDefinition(fixture.fieldRegistry)
  }, 'form-create');
  let detail = await readFormDetail(fixture);
  expect(detail.head).toMatchObject({ id: formId, version: 1, status: 'draft' });
  await commitDraft(fixture, '/api/events/current/forms/drafts/lifecycle', {
    transition: 'publish_and_open',
    formId,
    expectedDefinitionVersion: detail.head.version,
    expectedRegistryVersion: detail.registryPin.version
  }, 'form-publish-and-open');
  detail = await readFormDetail(fixture);
  expect(detail).toMatchObject({
    head: { id: formId, version: 2, status: 'open' },
    currentPublishedVersion: { id: formVersionId }
  });
  const servedResponse = await fixture.http.request(
    `/api/public/forms/current?formId=${formId}`,
    { headers: { 'x-correlation-id': uuid(0x915) } }
  );
  expect(servedResponse.status).toBe(200);
  const servedResult = await servedResponse.json() as {
    readonly kind?: unknown;
    readonly data?: unknown;
  };
  if (servedResult.kind !== 'success') {
    throw new TypeError('intake_closed_http_public_form_read_failed');
  }
  const served = servedPublicFormSchema.parse(servedResult.data);
  expect(served).toMatchObject({ formId, formVersionId, name: 'Main application' });
  expect(served.fields.map((field) => field.id)).toEqual([
    emailFieldId, titleFieldId, consentFieldId
  ]);
  return served;
}

async function mint(
  fixture: Fixture,
  applicant: typeof applicantA | typeof applicantB
): Promise<string> {
  const response = await fixture.http.request(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, {
    method: 'POST',
    headers: {
      [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
      'x-intake-test-applicant': applicant.name,
      'x-correlation-id': uuid(0x916)
    }
  });
  expect(response.status).toBe(201);
  const result = await response.json() as {
    readonly kind?: unknown;
    readonly continuation?: unknown;
  };
  if (result.kind !== 'issued' || typeof result.continuation !== 'string') {
    throw new TypeError('intake_closed_http_mint_failed');
  }
  return result.continuation;
}

async function mutate(
  fixture: Fixture,
  token: string,
  body: unknown,
  key: string,
  correlation: string
) {
  return fixture.http.request(
    '/api/public/forms/application/mutate',
    publicRequest({ token, body, key, correlation })
  );
}

describe('closed Intake HTTP conformance', () => {
  test('ordinary server composition leaves every public Intake mutation route unavailable', async () => {
    const auth = {
      handler: () => new Response(null, { status: 404 }),
      api: { getSession: () => null }
    } as unknown as Parameters<typeof createHttpApp>[0]['auth'];
    const app = createHttpApp({
      auth,
      accessContext: {
        ensureAuthPrincipalProvisioned() {
          throw new TypeError('intake_closed_http_unexpected_access_resolution');
        }
      },
      workspaceId,
      baseUrl: 'http://localhost:5176'
    });
    for (const [path, init] of [
      [INTAKE_PUBLIC_CONTINUATION_MINT_PATH, { method: 'POST' }],
      ['/api/public/forms/application/mutate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      }]
    ] as const) {
      const response = await app.request(path, init);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'route_not_found' });
    }
  });

  test('runs two independent applicants through real organizer and public HTTP adapters', async () => {
    const fixture = await openFixture();
    try {
      await provisionOpenForm(fixture);
      const tokenA = await mint(fixture, applicantA);
      const tokenB = await mint(fixture, applicantB);
      expect(tokenA).not.toBe(tokenB);

      const beginAResponse = await mutate(fixture, tokenA, {
        action: 'begin', input: { formId }
      }, 'applicant-a-begin', uuid(0x920));
      expect(beginAResponse.status).toBe(200);
      const beginA = intakePublicMutationOperationResultSchema.parse(
        await beginAResponse.json()
      );
      expect(beginA).toMatchObject({
        kind: 'success',
        data: { action: 'begin', draft: {
          formId, formVersionId, draftVersion: 1, status: 'in_progress'
        } }
      });
      const beginBResponse = await mutate(fixture, tokenB, {
        action: 'begin', input: { formId }
      }, 'applicant-b-begin', uuid(0x921));
      expect(beginBResponse.status).toBe(200);
      expect(intakePublicMutationOperationResultSchema.parse(await beginBResponse.json()))
        .toMatchObject({
          kind: 'success',
          data: { action: 'begin', draft: {
            formId, formVersionId, draftVersion: 1, status: 'in_progress'
          } }
        });
      fixture.registerApplicant(tokenA, applicantA);
      fixture.registerApplicant(tokenB, applicantB);

      const title = 'A precise proposal for the main stage';
      const email = 'speaker.one@example.test';
      const answers = [
        { kind: 'text', fieldId: titleFieldId, value: title },
        { kind: 'email', fieldId: emailFieldId, value: email },
        { kind: 'checkbox', fieldId: consentFieldId, checked: true }
      ] as const;
      const saveResponse = await mutate(fixture, tokenA, {
        action: 'save', input: { expectedDraftVersion: 1, answers }
      }, 'applicant-a-save', uuid(0x922));
      expect(saveResponse.status).toBe(200);
      const save = intakePublicMutationOperationResultSchema.parse(await saveResponse.json());
      expect(save).toMatchObject({
        kind: 'success', data: { action: 'save', draft: {
          draftVersion: 2, answeredFieldIds: [titleFieldId, emailFieldId, consentFieldId]
        } }
      });
      expect(fixture.capturedBuffers).toHaveLength(2);
      expect(fixture.capturedBuffers.every((bytes) => bytes.every((byte) => byte === 0)))
        .toBe(true);

      const resumeAResponse = await fixture.http.request(
        '/api/public/forms/application',
        publicRequest({ token: tokenA, correlation: uuid(0x923) })
      );
      expect(resumeAResponse.status).toBe(200);
      const resumeAResult = await resumeAResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (resumeAResult.kind !== 'success') {
        throw new TypeError('intake_closed_http_resume_a_failed');
      }
      expect(publicApplicationDraftResumeSchema.parse(resumeAResult.data)).toMatchObject({
        draft: { draftVersion: 2 },
        answers
      });
      const resumeBResponse = await fixture.http.request(
        '/api/public/forms/application',
        publicRequest({ token: tokenB, correlation: uuid(0x924) })
      );
      expect(resumeBResponse.status).toBe(200);
      const resumeBResult = await resumeBResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (resumeBResult.kind !== 'success') {
        throw new TypeError('intake_closed_http_resume_b_failed');
      }
      expect(publicApplicationDraftResumeSchema.parse(resumeBResult.data)).toMatchObject({
        draft: { draftVersion: 1 }, answers: []
      });

      const beforeStrictSelector = count(fixture.sqlite, 'foundation_trial_operation_receipts');
      const selectorLeak = await fixture.http.request(
        `/api/public/forms/application?formId=${formId}`,
        publicRequest({ token: tokenA, correlation: uuid(0x925) })
      );
      expect(selectorLeak.status).toBe(400);
      expect(await selectorLeak.json()).toMatchObject({
        kind: 'transport_error', code: 'invalid_request'
      });
      const bodyLeak = await mutate(fixture, tokenA, {
        action: 'save',
        input: { expectedDraftVersion: 2, answers },
        formId
      }, 'selector-body-leak', uuid(0x926));
      expect(bodyLeak.status).toBe(400);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts'))
        .toBe(beforeStrictSelector);

      const staleResponse = await mutate(fixture, tokenA, {
        action: 'save', input: { expectedDraftVersion: 1, answers }
      }, 'applicant-a-stale', uuid(0x927));
      expect(staleResponse.status).toBe(200);
      expect(intakePublicMutationOperationResultSchema.parse(await staleResponse.json()))
        .toMatchObject({
          kind: 'outcome', outcome: { class: 'conflict', kind: 'intake.changed' }
        });
      const changedRequest = await mutate(fixture, tokenA, {
        action: 'save', input: {
          expectedDraftVersion: 2,
          answers: [...answers.slice(0, 2), {
            kind: 'checkbox', fieldId: consentFieldId, checked: false
          }]
        }
      }, 'applicant-a-save', uuid(0x928));
      expect(changedRequest.status).toBe(200);
      expect(intakePublicMutationOperationResultSchema.parse(await changedRequest.json()))
        .toMatchObject({
          kind: 'outcome',
          outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
        });

      const storedDraft = fixture.repository.readDraft(
        { workspaceId, eventId }, applicantA.draftId
      );
      if (!storedDraft) throw new TypeError('intake_closed_http_saved_draft_missing');
      const governed = storedDraft.revision.answers.filter((answer) =>
        answer.kind === 'text' || answer.kind === 'email'
      );
      expect(governed).toHaveLength(2);

      const submitResponse = await mutate(fixture, tokenA, {
        action: 'submit', input: { expectedDraftVersion: 2 }
      }, 'applicant-a-submit', uuid(0x929));
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      const submit = intakePublicMutationOperationResultSchema.parse(submitBody);
      expect(submit).toMatchObject({
        kind: 'success',
        data: { action: 'submit', submission: { formId, formVersionId } }
      });
      if (submit.kind !== 'success' || submit.data.action !== 'submit') {
        throw new TypeError('intake_closed_http_submit_failed');
      }
      const submissionId = submit.data.submission.submissionId;
      expect(fixture.repository.readDraft({ workspaceId, eventId }, applicantB.draftId))
        .toMatchObject({ head: { status: 'in_progress', version: 1 } });

      const listResponse = await fixture.http.request('/api/events/current/submissions', {
        headers: { 'x-correlation-id': uuid(0x930) }
      });
      expect(listResponse.status).toBe(200);
      const listResult = await listResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (listResult.kind !== 'success') {
        throw new TypeError('intake_closed_http_submission_list_failed');
      }
      const summaries = organizerSubmissionSummarySchema.array().parse(listResult.data);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ id: submissionId, title });

      const detailResponse = await fixture.http.request(
        `/api/events/current/submissions/detail?submissionId=${submissionId}`,
        { headers: { 'x-correlation-id': uuid(0x931) } }
      );
      expect(detailResponse.status).toBe(200);
      const detailResult = await detailResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (detailResult.kind !== 'success') {
        throw new TypeError('intake_closed_http_submission_detail_failed');
      }
      const detail = organizerSubmissionDetailSchema.parse(detailResult.data);
      expect(detail).toMatchObject({
        submissionId,
        participantCount: 1,
        affirmedConsentFieldIds: [consentFieldId],
        answers: expect.arrayContaining([{
          kind: 'text', fieldId: titleFieldId, fieldLabel: 'Talk title', value: title
        }])
      });
      const safeJson = JSON.stringify(detail);
      expect(safeJson).not.toContain(email);
      expect(safeJson).not.toContain('payloadRef');
      expect(safeJson).not.toContain('digestSha256');
      expect(safeJson).not.toContain('canonicalBytes');
      for (const answer of governed) {
        if (answer.kind === 'text' || answer.kind === 'email') {
          expect(safeJson).not.toContain(answer.value.payloadRef.id);
        }
      }

      fixture.setContactPermissions(['submission.read']);
      const deniedContact = await fixture.http.request(
        `/api/events/current/submissions/contact?submissionId=${submissionId}`,
        { headers: { 'x-correlation-id': uuid(0x932) } }
      );
      expect(deniedContact.status).toBe(200);
      expect(await deniedContact.json()).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
      });
      fixture.setContactPermissions(INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS);
      const contactResponse = await fixture.http.request(
        `/api/events/current/submissions/contact?submissionId=${submissionId}`,
        { headers: { 'x-correlation-id': uuid(0x933) } }
      );
      expect(contactResponse.status).toBe(200);
      const contactResult = await contactResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (contactResult.kind !== 'success') {
        throw new TypeError('intake_closed_http_contact_failed');
      }
      expect(organizerSubmissionContactSchema.parse(contactResult.data)).toMatchObject({
        submissionId,
        personId: applicantA.personId,
        participantIdentityId: applicantA.participantIdentityId,
        sourceFieldId: emailFieldId,
        email
      });

      const children = fixture.sqlite.query<{ readonly kind: string }, [string]>(`
        SELECT json_extract(contribution_json, '$.kind') AS kind
          FROM foundation_trial_operation_receipt_children
         WHERE receipt_id = ? ORDER BY ordinal
      `).all(submit.receipt.id);
      expect(children).toEqual([
        { kind: 'domain_fact' }, { kind: 'outbox_pointer' }, { kind: 'timeline' }
      ]);
      expect(count(fixture.sqlite, 'intake_submission_participant_evidence')).toBe(1);
      expect(count(fixture.sqlite, 'intake_submission_consent_evidence')).toBe(1);
      expect(count(fixture.sqlite, 'submission_arrival_facts')).toBe(1);
      expect(count(fixture.sqlite, 'submission_triage_heads')).toBe(1);
      expect(fixture.sqlite.query<{
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
      `).get(submissionId)).toEqual({ classification: 'on_time', state: 'inbox' });
      expect(count(fixture.sqlite, 'public_mutation_registered_effect_completions')).toBe(1);

      const restart = fixture.restartTransport();
      const replayResponse = await restart.request(
        '/api/public/forms/application/mutate',
        publicRequest({
          token: tokenA,
          body: { action: 'submit', input: { expectedDraftVersion: 999 } },
          key: 'fresh-after-response-loss',
          correlation: uuid(0x934)
        })
      );
      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual(submitBody);
      expect(count(fixture.sqlite, 'intake_submission_heads')).toBe(1);
      expect(count(fixture.sqlite, 'submission_arrival_facts')).toBe(1);
      expect(count(fixture.sqlite, 'submission_triage_heads')).toBe(1);

      const serialized = Buffer.from(fixture.sqlite.serialize());
      for (const secret of [title, email]) {
        expect(serialized.includes(Buffer.from(secret, 'utf8'))).toBe(false);
      }
      const plainHashes = [title, email].map((secret) =>
        createHash('sha256').update(secret, 'utf8').digest('hex')
      );
      const hashBearingTables = fixture.sqlite.query<{ readonly name: string }, []>(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name <> 'classified_payload_records'
         ORDER BY name COLLATE BINARY
      `).all().flatMap(({ name }) => {
        const rows = JSON.stringify(fixture.sqlite.query(`SELECT * FROM "${name}"`).all());
        return plainHashes.some((digest) => rows.includes(digest)) ? [name] : [];
      });
      expect(hashBearingTables).toEqual([]);
      expect(JSON.stringify([submitBody, detail, contactResult.data]))
        .not.toContain(plainHashes[0]!);
      expect(JSON.stringify([submitBody, detail, contactResult.data]))
        .not.toContain(plainHashes[1]!);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rolls back a late public save fault and zeroizes transient answer buffers', async () => {
    const fixture = await openFixture();
    try {
      await provisionOpenForm(fixture);
      const token = await mint(fixture, applicantA);
      const beginResponse = await mutate(fixture, token, {
        action: 'begin', input: { formId }
      }, 'fault-begin', uuid(0x940));
      expect(beginResponse.status).toBe(200);
      const before = Object.freeze({
        revisions: count(fixture.sqlite, 'intake_application_draft_revisions'),
        payloads: count(fixture.sqlite, 'classified_payload_records'),
        receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
        links: count(fixture.sqlite, 'intake_public_mutation_receipt_links'),
        facts: count(fixture.sqlite, 'intake_public_mutation_facts'),
        pointers: count(fixture.sqlite, 'intake_public_mutation_pointers'),
        timeline: count(fixture.sqlite, 'intake_public_mutation_timeline')
      });
      fixture.enableLateFault();
      const failed = await mutate(fixture, token, {
        action: 'save', input: {
          expectedDraftVersion: 1,
          answers: [
            { kind: 'text', fieldId: titleFieldId, value: 'Rollback canary title' },
            { kind: 'email', fieldId: emailFieldId, value: 'rollback@example.test' },
            { kind: 'checkbox', fieldId: consentFieldId, checked: true }
          ]
        }
      }, 'fault-save', uuid(0x941));
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({
        kind: 'transport_error', code: 'internal_error'
      });
      expect({
        revisions: count(fixture.sqlite, 'intake_application_draft_revisions'),
        payloads: count(fixture.sqlite, 'classified_payload_records'),
        receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
        links: count(fixture.sqlite, 'intake_public_mutation_receipt_links'),
        facts: count(fixture.sqlite, 'intake_public_mutation_facts'),
        pointers: count(fixture.sqlite, 'intake_public_mutation_pointers'),
        timeline: count(fixture.sqlite, 'intake_public_mutation_timeline')
      }).toEqual(before);
      expect(fixture.repository.readDraft({ workspaceId, eventId }, applicantA.draftId))
        .toMatchObject({ head: { version: 1 }, revision: { version: 1, answers: [] } });
      expect(fixture.capturedBuffers).toHaveLength(2);
      expect(fixture.capturedBuffers.every((bytes) => bytes.every((byte) => byte === 0)))
        .toBe(true);
      expect(count(fixture.sqlite, 'foundation_trial_operation_execution_claims')).toBe(0);
      expect(Buffer.from(fixture.sqlite.serialize()).includes(
        Buffer.from('Rollback canary title', 'utf8')
      )).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('rolls back submission and triage together on a late fault, then retries cleanly', async () => {
    const fixture = await openFixture();
    try {
      await provisionOpenForm(fixture);
      const token = await mint(fixture, applicantA);
      const begin = await mutate(fixture, token, {
        action: 'begin', input: { formId }
      }, 'triage-fault-begin', uuid(0x950));
      expect(begin.status).toBe(200);
      fixture.registerApplicant(token, applicantA);
      const save = await mutate(fixture, token, {
        action: 'save', input: {
          expectedDraftVersion: 1,
          answers: [
            { kind: 'text', fieldId: titleFieldId, value: 'Atomic triage proposal' },
            { kind: 'email', fieldId: emailFieldId, value: 'atomic@example.test' },
            { kind: 'checkbox', fieldId: consentFieldId, checked: true }
          ]
        }
      }, 'triage-fault-save', uuid(0x951));
      expect(save.status).toBe(200);
      const tables = [
        'intake_submission_heads',
        'intake_submission_submit_evidence',
        'intake_submission_participant_evidence',
        'intake_submission_consent_evidence',
        'submission_arrival_facts',
        'submission_triage_heads',
        'submission_triage_event_heads',
        'intake_public_mutation_receipt_links',
        'intake_public_mutation_facts',
        'intake_public_mutation_pointers',
        'intake_public_mutation_timeline',
        'public_mutation_registered_effect_completions',
        'foundation_trial_operation_receipts',
        'foundation_trial_operation_receipt_children'
      ] as const;
      const before = new Map(tables.map((table) => [table, count(fixture.sqlite, table)]));

      fixture.enableLateFault();
      const failed = await mutate(fixture, token, {
        action: 'submit', input: { expectedDraftVersion: 2 }
      }, 'triage-fault-submit', uuid(0x952));
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({
        kind: 'transport_error', code: 'internal_error'
      });
      for (const table of tables) {
        expect(count(fixture.sqlite, table), table).toBe(before.get(table)!);
      }
      expect(fixture.repository.readDraft({ workspaceId, eventId }, applicantA.draftId))
        .toMatchObject({ head: { status: 'in_progress', version: 2 } });

      fixture.disableLateFault();
      const retriedResponse = await mutate(fixture, token, {
        action: 'submit', input: { expectedDraftVersion: 2 }
      }, 'triage-clean-submit', uuid(0x953));
      expect(retriedResponse.status).toBe(200);
      const retried = intakePublicMutationOperationResultSchema.parse(
        await retriedResponse.json()
      );
      expect(retried).toMatchObject({ kind: 'success', data: { action: 'submit' } });
      expect(count(fixture.sqlite, 'intake_submission_heads')).toBe(1);
      expect(count(fixture.sqlite, 'submission_arrival_facts')).toBe(1);
      expect(count(fixture.sqlite, 'submission_triage_heads')).toBe(1);
      expect(count(fixture.sqlite, 'submission_triage_event_heads')).toBe(1);
      expect(count(fixture.sqlite, 'public_mutation_registered_effect_completions')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
