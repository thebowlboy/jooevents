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
import { createPublicMutationContinuationBoundary } from '@jooevents/application/public-mutation-continuation';
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
  organizerFormDetailSchema,
  organizerSubmissionContactSchema,
  organizerSubmissionDetailSchema,
  publicApplicationDraftResumeSchema,
  servedPublicFormSchema,
  type FormDefinitionCreateAuthorInput,
  type ReleaseScopeDto
} from '@jooevents/contracts';
import { issueFormOrdinaryPolicy } from '@jooevents/intake';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_EVENT_READ_ACCESS_POLICY,
  INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS,
  INTAKE_SUBMISSION_READ_ACCESS_POLICY,
  createApplySurfaceGatedContinuationPolicySource,
  createApplySurfaceGatedPublicFormScopeSource,
  createIntakeFormDraftOperationModule,
  createIntakePublicConformanceMutationOperationModule,
  createIntakePublicConformanceReadOperationModule,
  createIntakeReadOperationModule,
  createOffUnlessConfiguredPublicInputPolicyEvaluator,
  createOffUnlessConfiguredPublicIntakeBootstrapVerifier,
  intakeFormDraftOperationResultSchema,
  intakePublicApplyPolicyRevision,
  intakePublicMutationOperationResultSchema,
  type IntakeReadPort
} from '@jooevents/intake-operations';
import {
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  parseInstant
} from '@jooevents/kernel';
import type { CurrentAuthorityResolver } from '@jooevents/identity-access';
import { isStyleSetPlan, isSurfacePublishPlan, planReleaseMutation } from '@jooevents/release';
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
  createIntakePublicCeremonyGatedDirectory,
  createSQLiteCeremonyMintedIntakeParticipantAttributionSource,
  createSQLiteIntakePublicApplySurfaceGate,
  intakePublicApplySurfaceCeremonyPinSource,
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
  installReleaseSchema,
  SQLiteReleaseRepository,
  type SQLiteReleaseUpstreamSources
} from '@jooevents/persistence/release';
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
  SQLiteEffectUnitOfWorkPort
} from '@jooevents/persistence/sqlite-effect-unit-of-work';
import { installSQLiteIntakeParticipantAttributionConformanceSchema } from '@jooevents/persistence/testing/intake-participant-attribution-conformance';
import { installFoundationTrialUnitOfWorkSchema } from '@jooevents/persistence/testing/foundation-trial-uow';
import {
  installSQLitePublicMutationContinuationTrial,
  SQLitePublicMutationContinuationTrial
} from '@jooevents/persistence/testing/public-mutation-continuation-trial';
import { Hono } from 'hono';
import { createOperatorOperationsHttpAdapter } from './operator-operations';
import { createPublicOperationsHttpAdapter } from './public-operations';

const uuid = (suffix: number): string =>
  `019c2f11-77aa-73aa-8aa4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(1));
const eventId = parseEventId(uuid(2));
const userId = parseUserId(uuid(3));
const membershipId = parseMembershipId(uuid(4));
const formId = uuid(5);
const formVersion1 = uuid(6);
const formVersion2 = uuid(0x16);
const titleFieldId = uuid(7);
const emailFieldId = uuid(8);
const consentFieldId = uuid(9);
const now = parseInstant('2026-08-14T12:00:00.000Z');
const scope: ReleaseScopeDto = { workspaceId, eventId };
const continuationBinding = Object.freeze({
  key: 'intake.public-apply', version: parseContractVersion(1)
});
const profile = Object.freeze({ key: 'intake-public-activation', version: parseContractVersion(1) });

type CanonicalRegistry = ReturnType<typeof initializeCanonicalFieldRegistry>;

function formDefinition(registry: CanonicalRegistry, name: string): FormDefinitionCreateAuthorInput {
  const included = new Set([titleFieldId, emailFieldId, consentFieldId]);
  return {
    kind: 'cfp',
    name,
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
  sessionHandle: 'verified-intake-public-activation-session'
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
    VALUES (?, 'Public activation workspace', 'active', 1, 1, 1)
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
      ) VALUES (?, ?, 'Activation Event', 'UTC', '2026-08-14', '2026-08-15', 1, ?, ?, ?)
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
  installReleaseSchema(sqlite);
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
    reference: { key: 'encryption.intake-public-activation', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x44)
  });
  let nonce = 1;
  const rawClassifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile: encryption,
    nonceSource: () => new Uint8Array(12).fill(nonce++)
  });
  const classifiedStore: SynchronousClassifiedPayloadStore = Object.freeze({
    put: rawClassifiedStore.put.bind(rawClassifiedStore),
    read: rawClassifiedStore.read.bind(rawClassifiedStore)
  });
  const projection = new SQLiteIntakeClassifiedProjection({
    store: classifiedStore,
    profiles: classifiedProfiles
  });
  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  }, projection);

  // The real release domain over the same database: the fixture publishes and
  // rolls back apply surface releases exactly as the operator flow would.
  const neverUpstream = (): never => {
    throw new TypeError('intake_public_activation_unexpected_upstream_read');
  };
  const releaseSources: SQLiteReleaseUpstreamSources = {
    sessions: { readSessionCatalog: neverUpstream },
    schedule: { readSchedule: neverUpstream },
    engagements: { readEngagementSnapshot: neverUpstream },
    vocabulary: { readVocabulary: neverUpstream },
    eventSettings: { readEventSettings: neverUpstream },
    names: { readParticipantDisplayName: neverUpstream },
    forms: {
      readCurrentPublishedFormVersionId: (releaseScope, requestedFormId) =>
        repository.readFormHead(releaseScope, requestedFormId)?.currentPublishedVersionId
          ?? undefined
    }
  };
  const releaseRepository = new SQLiteReleaseRepository(sqlite, releaseSources);
  const gate = createSQLiteIntakePublicApplySurfaceGate({
    sqlite,
    workspaceId,
    eventId,
    forms: { readFormHead: (formScope, form) => repository.readFormHead(formScope, form) }
  });

  const formPolicy = issueFormOrdinaryPolicy({
    key: 'intake.form.bounded', version: 1, ordinaryRisk: 'low',
    approval: { ordinary: 'none' }
  });
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const formEntityIds = [formId];
  const formVersionIds = [formVersion1, formVersion2];
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
        if (!value) throw new TypeError('intake_public_activation_form_id_exhausted');
        return value;
      },
      newFormVersionId() {
        const value = formVersionIds.shift();
        if (!value) throw new TypeError('intake_public_activation_form_version_exhausted');
        return value;
      }
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
  const bootstrapVerifier = createOffUnlessConfiguredPublicIntakeBootstrapVerifier();
  const keyProfile = (key: string, fill: number) => Object.freeze({
    reference: Object.freeze({ key, version: parseContractVersion(1) }),
    keyBytes: new Uint8Array(32).fill(fill)
  });
  const boundary = createPublicMutationContinuationBoundary({
    binding: continuationBinding,
    policies: createApplySurfaceGatedContinuationPolicySource({
      gate,
      binding: continuationBinding,
      security: {
        lifetimeMs: 300_000,
        ...INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
        continuationProfiles: [keyProfile('intake.public-continuation', 1)],
        principalPartitionProfile: keyProfile('intake.public-partition', 2),
        bootstrapReplayProfile: keyProfile('intake.public-bootstrap-replay', 3)
      }
    }),
    bootstrapVerifiers: {
      resolve: (reference) =>
        reference.key === bootstrapVerifier.reference.key
          && reference.version === bootstrapVerifier.reference.version
          ? bootstrapVerifier
          : undefined
    },
    store: continuationStore,
    clock,
    newActionAnchorId: next,
    newCeremonyEvidenceId: () => parseCeremonyEvidenceId(uuid(ceremony++)),
    newAuditEventId: () => parseAuditEventId(uuid(audit++)),
    randomBytes(size) {
      return new Uint8Array(size).fill(randomSeed++);
    }
  });
  const completion = new SQLitePublicMutationEffectCompletionPort(sqlite, {
    clock,
    newAuditEventId: () => parseAuditEventId(uuid(audit++))
  });
  const directory: IntakePublicCeremonyDirectory = createIntakePublicCeremonyGatedDirectory({
    pin: intakePublicApplySurfaceCeremonyPinSource(gate),
    boundary,
    completion
  });
  const participantAttribution =
    createSQLiteCeremonyMintedIntakeParticipantAttributionSource(sqlite, {
      newPersonId: next,
      newParticipantIdentityId: next
    });
  const inputPolicy = createOffUnlessConfiguredPublicInputPolicyEvaluator({
    issueEvaluationId: next
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

  const authority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
    async resolve(input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
      if (input.evidence.kind === 'public_ceremony') {
        return directory.currentAuthority.resolve(input);
      }
      if (input.evidence.kind === 'public_open') {
        const resolution = gate.resolveApplySurface();
        if (resolution.kind !== 'pinned'
            || input.lane.kind !== 'public_open'
            || input.lane.surface !== 'public_http'
            || input.lane.policy.key !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.key
            || input.lane.policy.version !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.version
            || input.evidence.publicPolicyRevisionId
              !== intakePublicApplyPolicyRevision(resolution.pin)) {
          return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
        }
        const publicPolicyRevisionId = intakePublicApplyPolicyRevision(resolution.pin);
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
            evidenceIds: resolution.pin.evidenceIds,
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
      const permissions =
        input.lane.policy.key === INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY.key
          ? INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS
          : input.lane.policy.key === INTAKE_SUBMISSION_READ_ACCESS_POLICY.key
            ? (['submission.read'] as const)
            : input.lane.policy.key === INTAKE_EVENT_READ_ACCESS_POLICY.key
              ? (['event.read'] as const)
              : (['event.manage'] as const);
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
      resumeScope: Parameters<IntakeReadPort['readPublicDraftResume']>[0],
      binding: Parameters<IntakeReadPort['readPublicDraftResume']>[1]
    ) {
      const data = repository.readPublicDraftResume(resumeScope, binding);
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
    publicFormScope: createApplySurfaceGatedPublicFormScopeSource({ gate }),
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
    { capability: publicRegistration.capability, adapter: publicRegistration.adapter }
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
  const http = new Hono();
  http.post(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, async (context) => {
    const selected = context.req.header(INTAKE_PUBLIC_FORM_SELECTOR_HEADER);
    if (!selected || selected.includes(',') || !intakeIdSchema.safeParse(selected).success) {
      return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
    }
    const minted = await directory.mint({
      formId: selected,
      protocolEvidence: {
        schemaVersion: 1,
        bootstrap: (body as { readonly bootstrap?: unknown } | null)?.bootstrap,
        origin: context.req.header('origin') ?? null
      }
    });
    context.header('cache-control', 'no-store, max-age=0');
    return context.json(minted, minted.kind === 'issued' ? 201 : 409);
  });
  const evidenceByRequest = new WeakMap<Request, InvocationEvidence>();
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
    const admission = directory.admit({ formId: selected, continuation });
    if (admission.kind === 'terminal') {
      context.header('cache-control', 'no-store, max-age=0');
      return context.json(admission.receipt.result);
    }
    if (admission.kind === 'stopped') {
      return context.json({ kind: 'transport_error', code: 'not_available' }, 404);
    }
    const evidence: InvocationEvidence = Object.freeze({
      kind: 'public_ceremony', surface: 'public_http',
      client: { key: 'public.intake-activation' },
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
          const resolution = gate.resolveApplySurface();
          if (resolution.kind !== 'pinned') {
            return { kind: 'rejected', reason: 'unauthenticated' };
          }
          return {
            kind: 'verified',
            evidence: {
              kind: 'public_open', surface: 'public_http',
              client: { key: 'public.intake-activation' },
              publicPolicyRevisionId: intakePublicApplyPolicyRevision(resolution.pin)
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

  return {
    sqlite,
    repository,
    releaseRepository,
    fieldRegistry,
    gate,
    directory,
    http,
    admittedByToken,
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
  if (draft.kind !== 'success') {
    throw new TypeError(`intake_public_activation_${key}_draft_failed`);
  }
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
    throw new TypeError(`intake_public_activation_${key}_proposal_failed`);
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
    throw new TypeError(`intake_public_activation_${key}_commit_failed`);
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
  if (result.kind !== 'success') throw new TypeError('intake_public_activation_form_read_failed');
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
    throw new TypeError('intake_public_activation_form_list_failed');
  }
  const listed = listedResult.data as {
    readonly catalogVersion: number;
    readonly registryPin: { readonly version: number };
  };
  await commitDraft(fixture, '/api/events/current/forms/drafts/create', {
    expectedCatalogVersion: listed.catalogVersion,
    expectedRegistryVersion: listed.registryPin.version,
    definition: formDefinition(fixture.fieldRegistry, 'Main application')
  }, 'form-create');
  let detail = await readFormDetail(fixture);
  await commitDraft(fixture, '/api/events/current/forms/drafts/lifecycle', {
    transition: 'publish_and_open',
    formId,
    expectedDefinitionVersion: detail.head.version,
    expectedRegistryVersion: detail.registryPin.version
  }, 'form-publish-and-open');
  detail = await readFormDetail(fixture);
  expect(detail).toMatchObject({
    head: { id: formId, status: 'open' },
    currentPublishedVersion: { id: formVersion1 }
  });
  return detail;
}

function publishStyleSet(fixture: Fixture): string {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'style_set_publish',
      scope,
      actorUserId: userId,
      occurredAt: now,
      releaseId: uuid(0xa01),
      recipe: {
        name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
        text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
      },
      expectedCurrentStyleSetNumber: null
    },
    port: fixture.releaseRepository
  });
  if (!isStyleSetPlan(plan)) throw new Error('wrong style set plan');
  transaction(fixture.sqlite, () => fixture.releaseRepository.applyReleasePlan(plan));
  return plan.release.id;
}

function publishApplySurface(fixture: Fixture, input: {
  readonly releaseId: string;
  readonly styleSetReleaseId: string;
  readonly formVersionId: string;
  readonly expectedSurfaceHeadVersion: number | null;
}): string {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'surface_publish',
      scope,
      actorUserId: userId,
      occurredAt: now,
      releaseId: input.releaseId,
      kind: 'apply',
      manifest: { schemaVersion: 1, heading: null, intro: null },
      styleSetReleaseId: input.styleSetReleaseId,
      formRef: { formId, formVersionId: input.formVersionId },
      expectedSurfaceHeadVersion: input.expectedSurfaceHeadVersion
    },
    port: fixture.releaseRepository
  });
  if (!isSurfacePublishPlan(plan)) throw new Error('wrong surface plan');
  transaction(fixture.sqlite, () => fixture.releaseRepository.applyReleasePlan(plan));
  return plan.release.id;
}

function rollbackApplySurface(fixture: Fixture, input: {
  readonly targetReleaseId: string;
  readonly expectedSurfaceHeadVersion: number;
}): void {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'surface_rollback',
      scope,
      actorUserId: userId,
      occurredAt: now,
      kind: 'apply',
      targetReleaseId: input.targetReleaseId,
      expectedSurfaceHeadVersion: input.expectedSurfaceHeadVersion
    },
    port: fixture.releaseRepository
  });
  transaction(fixture.sqlite, () => fixture.releaseRepository.applyReleasePlan(plan));
}

async function mint(fixture: Fixture, bootstrap: string): Promise<Response> {
  return fixture.http.request(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, {
    method: 'POST',
    headers: {
      [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: formId,
      'content-type': 'application/json',
      'x-correlation-id': uuid(0x916)
    },
    body: JSON.stringify({ schemaVersion: 1, bootstrap })
  });
}

async function mintToken(fixture: Fixture, bootstrap: string): Promise<string> {
  const response = await mint(fixture, bootstrap);
  expect(response.status).toBe(201);
  const result = await response.json() as {
    readonly kind?: unknown;
    readonly continuation?: unknown;
  };
  if (result.kind !== 'issued' || typeof result.continuation !== 'string') {
    throw new TypeError('intake_public_activation_mint_failed');
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

describe('public apply activation over real HTTP adapters', () => {
  test('every public intake surface fails closed before an apply surface release exists', async () => {
    const fixture = await openFixture();
    try {
      await provisionOpenForm(fixture);
      // The form is open, but no apply surface release has been published:
      // read, mint, and mutate all refuse without distinguishing why.
      const readResponse = await fixture.http.request(
        `/api/public/forms/current?formId=${formId}`,
        { headers: { 'x-correlation-id': uuid(0x917) } }
      );
      expect(readResponse.status).toBe(401);
      const mintResponse = await mint(fixture, 'a'.repeat(48));
      expect(mintResponse.status).toBe(409);
      expect(await mintResponse.json()).toEqual({ kind: 'unavailable' });
      const mutateResponse = await mutate(fixture, 'gsr_'.padEnd(47, 'x'), {
        action: 'begin', input: { formId }
      }, 'pre-surface-begin', uuid(0x918));
      expect(mutateResponse.status).toBe(404);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBeGreaterThan(0);
      expect(count(fixture.sqlite, 'intake_public_mutation_receipt_links')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('a submitter completes autosave, resume, and submit against the published surface', async () => {
    const fixture = await openFixture();
    try {
      await provisionOpenForm(fixture);
      const styleSet = publishStyleSet(fixture);
      const surfaceRelease = publishApplySurface(fixture, {
        releaseId: uuid(0xa02),
        styleSetReleaseId: styleSet,
        formVersionId: formVersion1,
        expectedSurfaceHeadVersion: null
      });
      expect(fixture.gate.resolveApplySurface()).toMatchObject({
        kind: 'pinned',
        pin: { formId, formVersionId: formVersion1, surfaceReleaseId: surfaceRelease }
      });

      // The public read now serves the pinned form.
      const servedResponse = await fixture.http.request(
        `/api/public/forms/current?formId=${formId}`,
        { headers: { 'x-correlation-id': uuid(0x919) } }
      );
      expect(servedResponse.status).toBe(200);
      const servedResult = await servedResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (servedResult.kind !== 'success') {
        throw new TypeError('intake_public_activation_served_read_failed');
      }
      const served = servedPublicFormSchema.parse(servedResult.data);
      expect(served).toMatchObject({ formId, formVersionId: formVersion1 });

      const token = await mintToken(fixture, 'a'.repeat(48));
      // Equal client bootstrap secrets replay to the already-issued ceremony.
      const replayMint = await mint(fixture, 'a'.repeat(48));
      expect(replayMint.status).toBe(409);
      expect(await replayMint.json()).toMatchObject({ kind: 'already_issued' });

      const begin = await mutate(fixture, token, {
        action: 'begin', input: { formId }
      }, 'applicant-begin', uuid(0x920));
      expect(begin.status).toBe(200);
      expect(intakePublicMutationOperationResultSchema.parse(await begin.json()))
        .toMatchObject({
          kind: 'success',
          data: { action: 'begin', draft: {
            formId, formVersionId: formVersion1, draftVersion: 1, status: 'in_progress'
          } }
        });

      const title = 'A precise proposal for the activation stage';
      const email = 'activation.speaker@example.test';
      const answers = [
        { kind: 'text', fieldId: titleFieldId, value: title },
        { kind: 'email', fieldId: emailFieldId, value: email },
        { kind: 'checkbox', fieldId: consentFieldId, checked: true }
      ] as const;
      const save = await mutate(fixture, token, {
        action: 'save', input: { expectedDraftVersion: 1, answers }
      }, 'applicant-save', uuid(0x921));
      expect(save.status).toBe(200);
      expect(intakePublicMutationOperationResultSchema.parse(await save.json()))
        .toMatchObject({ kind: 'success', data: { action: 'save', draft: { draftVersion: 2 } } });

      const resume = await fixture.http.request(
        '/api/public/forms/application',
        publicRequest({ token, correlation: uuid(0x922) })
      );
      expect(resume.status).toBe(200);
      const resumeResult = await resume.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (resumeResult.kind !== 'success') {
        throw new TypeError('intake_public_activation_resume_failed');
      }
      expect(publicApplicationDraftResumeSchema.parse(resumeResult.data)).toMatchObject({
        draft: { draftVersion: 2 },
        answers
      });

      // Submit needs no pre-registered submitter: identity is minted from the
      // ceremony evidence inside the same transaction.
      const submitResponse = await mutate(fixture, token, {
        action: 'submit', input: { expectedDraftVersion: 2 }
      }, 'applicant-submit', uuid(0x923));
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      const submit = intakePublicMutationOperationResultSchema.parse(submitBody);
      expect(submit).toMatchObject({
        kind: 'success',
        data: { action: 'submit', submission: { formId, formVersionId: formVersion1 } }
      });
      if (submit.kind !== 'success' || submit.data.action !== 'submit') {
        throw new TypeError('intake_public_activation_submit_failed');
      }
      const submissionId = submit.data.submission.submissionId;

      const detailResponse = await fixture.http.request(
        `/api/events/current/submissions/detail?submissionId=${submissionId}`,
        { headers: { 'x-correlation-id': uuid(0x924) } }
      );
      expect(detailResponse.status).toBe(200);
      const detailResult = await detailResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (detailResult.kind !== 'success') {
        throw new TypeError('intake_public_activation_detail_failed');
      }
      const detail = organizerSubmissionDetailSchema.parse(detailResult.data);
      expect(detail).toMatchObject({
        submissionId,
        participantCount: 1,
        affirmedConsentFieldIds: [consentFieldId]
      });
      const safeJson = JSON.stringify(detail);
      expect(safeJson).not.toContain(email);
      expect(safeJson).not.toContain('payloadRef');

      const contactResponse = await fixture.http.request(
        `/api/events/current/submissions/contact?submissionId=${submissionId}`,
        { headers: { 'x-correlation-id': uuid(0x925) } }
      );
      expect(contactResponse.status).toBe(200);
      const contactResult = await contactResponse.json() as {
        readonly kind?: unknown;
        readonly data?: unknown;
      };
      if (contactResult.kind !== 'success') {
        throw new TypeError('intake_public_activation_contact_failed');
      }
      const contact = organizerSubmissionContactSchema.parse(contactResult.data);
      expect(contact).toMatchObject({ submissionId, sourceFieldId: emailFieldId, email });
      // Ceremony-minted identity: real ids exist without any submitter account.
      expect(contact.personId).toMatch(/^[0-9a-f-]{36}$/);
      expect(contact.participantIdentityId).toMatch(/^[0-9a-f-]{36}$/);
      expect(contact.personId).not.toBe(contact.participantIdentityId);
      expect(count(fixture.sqlite, 'intake_participant_attribution_conformance')).toBe(1);

      // Idempotent replay: after response loss, the terminal ceremony returns
      // the identical submit result and writes nothing further.
      const beforeReplay = {
        receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
        submissions: count(fixture.sqlite, 'intake_submission_heads'),
        arrivals: count(fixture.sqlite, 'submission_arrival_facts')
      };
      const replayResponse = await mutate(fixture, token, {
        action: 'submit', input: { expectedDraftVersion: 999 }
      }, 'fresh-after-response-loss', uuid(0x926));
      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.json()).toEqual(submitBody);
      expect({
        receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
        submissions: count(fixture.sqlite, 'intake_submission_heads'),
        arrivals: count(fixture.sqlite, 'submission_arrival_facts')
      }).toEqual(beforeReplay);
      expect(count(fixture.sqlite, 'public_mutation_registered_effect_completions')).toBe(1);

      // Classified separation: raw answers never land in ordinary rows.
      const serialized = Buffer.from(fixture.sqlite.serialize());
      for (const secret of [title, email]) {
        expect(serialized.includes(Buffer.from(secret, 'utf8'))).toBe(false);
      }
      const plainHashes = [title, email].map((secret) =>
        createHash('sha256').update(secret, 'utf8').digest('hex')
      );
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

  test('republish re-pins through the reviewed successor and rollback stops every ceremony write', async () => {
    const fixture = await openFixture();
    try {
      await provisionOpenForm(fixture);
      const styleSet = publishStyleSet(fixture);
      const release1 = publishApplySurface(fixture, {
        releaseId: uuid(0xa03),
        styleSetReleaseId: styleSet,
        formVersionId: formVersion1,
        expectedSurfaceHeadVersion: null
      });
      const tokenA = await mintToken(fixture, 'a'.repeat(48));
      const beginA = await mutate(fixture, tokenA, {
        action: 'begin', input: { formId }
      }, 'ceremony-a-begin', uuid(0x930));
      expect(beginA.status).toBe(200);

      // Republish the form: the reviewed changeset mints version 2 AND plans
      // the successor apply surface release pinning it, atomically.
      let detail = await readFormDetail(fixture);
      await commitDraft(fixture, '/api/events/current/forms/drafts/revise', {
        formId,
        expectedDefinitionVersion: detail.head.version,
        expectedRegistryVersion: detail.registryPin.version,
        definition: formDefinition(fixture.fieldRegistry, 'Main application, revised')
      }, 'form-revise');
      detail = await readFormDetail(fixture);
      await commitDraft(fixture, '/api/events/current/forms/drafts/publish', {
        formId,
        expectedDefinitionVersion: detail.head.version,
        expectedRegistryVersion: detail.registryPin.version
      }, 'form-republish');
      detail = await readFormDetail(fixture);
      expect(detail.currentPublishedVersion).toMatchObject({ id: formVersion2 });
      const repinned = fixture.gate.resolveApplySurface();
      expect(repinned).toMatchObject({
        kind: 'pinned',
        pin: { formId, formVersionId: formVersion2 }
      });
      if (repinned.kind !== 'pinned') throw new TypeError('expected successor pin');
      const release2 = repinned.pin.surfaceReleaseId;
      expect(release2).not.toBe(release1);

      // Ceremony A was bound to the superseded pin: it can no longer write.
      const writesBefore = count(fixture.sqlite, 'intake_public_mutation_receipt_links');
      const staleSave = await mutate(fixture, tokenA, {
        action: 'save', input: { expectedDraftVersion: 1, answers: [] }
      }, 'ceremony-a-stale-save', uuid(0x931));
      expect(staleSave.status).toBe(404);
      expect(count(fixture.sqlite, 'intake_public_mutation_receipt_links')).toBe(writesBefore);

      // A fresh ceremony under the successor pin serves without recomposition.
      const tokenB = await mintToken(fixture, 'b'.repeat(48));
      const beginB = await mutate(fixture, tokenB, {
        action: 'begin', input: { formId }
      }, 'ceremony-b-begin', uuid(0x932));
      expect(beginB.status).toBe(200);
      expect(intakePublicMutationOperationResultSchema.parse(await beginB.json()))
        .toMatchObject({
          kind: 'success',
          data: { action: 'begin', draft: { formId, formVersionId: formVersion2 } }
        });

      // Roll the surface head back to the release pinning version 1: the pin
      // is now superseded, so the whole public surface fails closed at once.
      rollbackApplySurface(fixture, {
        targetReleaseId: release1,
        expectedSurfaceHeadVersion: 2
      });
      expect(fixture.gate.resolveApplySurface())
        .toEqual({ kind: 'refused', reason: 'apply_form_version_superseded' });

      const rolledBackSave = await mutate(fixture, tokenB, {
        action: 'save', input: { expectedDraftVersion: 1, answers: [] }
      }, 'ceremony-b-rolled-back-save', uuid(0x933));
      expect(rolledBackSave.status).toBe(404);
      expect(await rolledBackSave.json()).toMatchObject({
        kind: 'transport_error', code: 'not_available'
      });
      const rolledBackResume = await fixture.http.request(
        '/api/public/forms/application',
        publicRequest({ token: tokenB, correlation: uuid(0x934) })
      );
      expect(rolledBackResume.status).toBe(404);
      const rolledBackRead = await fixture.http.request(
        `/api/public/forms/current?formId=${formId}`,
        { headers: { 'x-correlation-id': uuid(0x935) } }
      );
      expect(rolledBackRead.status).toBe(401);
      const rolledBackMint = await mint(fixture, 'c'.repeat(48));
      expect(rolledBackMint.status).toBe(409);
      expect(await rolledBackMint.json()).toEqual({ kind: 'unavailable' });

      // Non-enumeration: an unknown form and the rolled-back form answer with
      // exactly the same shape at mint and at mutate.
      const unknownFormMint = await fixture.http.request(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, {
        method: 'POST',
        headers: {
          [INTAKE_PUBLIC_FORM_SELECTOR_HEADER]: uuid(0xdead),
          'content-type': 'application/json',
          'x-correlation-id': uuid(0x936)
        },
        body: JSON.stringify({ schemaVersion: 1, bootstrap: 'd'.repeat(48) })
      });
      expect(unknownFormMint.status).toBe(409);
      expect(await unknownFormMint.json()).toEqual({ kind: 'unavailable' });
      const garbageToken = await mutate(fixture, `gsr_${'e'.repeat(43)}`, {
        action: 'begin', input: { formId }
      }, 'garbage-token-begin', uuid(0x937));
      expect(garbageToken.status).toBe(404);
      expect(await garbageToken.json()).toMatchObject({
        kind: 'transport_error', code: 'not_available'
      });

      // The public path never inherits organizer authority: an organizer
      // session cookie on the ceremony route changes nothing.
      const cookied = await fixture.http.request(
        '/api/public/forms/application/mutate',
        {
          ...publicRequest({
            token: tokenB,
            body: { action: 'save', input: { expectedDraftVersion: 1, answers: [] } },
            key: 'cookied-save',
            correlation: uuid(0x938)
          }),
          headers: {
            ...(publicRequest({
              token: tokenB,
              body: {},
              key: 'cookied-save',
              correlation: uuid(0x938)
            }).headers as Record<string, string>),
            cookie: 'better-auth.session_token=organizer-session'
          }
        }
      );
      expect(cookied.status).toBe(404);
      expect(count(fixture.sqlite, 'intake_public_mutation_receipt_links'))
        .toBe(writesBefore + 1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
