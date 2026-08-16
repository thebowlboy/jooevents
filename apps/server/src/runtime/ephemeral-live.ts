import { createHash, createHmac as createNodeHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import {
  assertOperatorAuthorityPolicyCatalogCoversOperationRegistry,
  COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
  COMMUNICATION_PROVIDER_OPERATIONS,
  composeOperationRegistryModules,
  createAgentActionPlanSurface,
  createAgentActionRunner,
  createApplicationOperationRuntime,
  createRegisteredAgentActionEligibilityCatalog,
  createRegisteredAgentActionExecutor,
  OperationInputError,
  createClassifiedPayloadProfileRef,
  createCommunicationProviderReadOperationModule,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createProvisioningService,
  createWorkspaceTeamOperationModule,
  type InvocationEvidence,
  type AgentActionCurrentAuthority,
  type ApprovedAgentActionOperationExecutionPort,
  type RegisteredAgentActionEligibility,
  type OperationRegistryModule,
  WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE,
  WORKSPACE_TEAM_OPERATION_ACCESS,
} from '@jooevents/application';
import { createPublicEffectConformanceBoundary } from '@jooevents/application/public-effect-conformance';
import {
  createPublicMutationContinuationBoundary
} from '@jooevents/application/public-mutation-continuation';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  accessContextSchema,
  effectfulOperationResultSchema,
  intakeIdInputSchema,
  intakeIdSchema,
  readOperationResultSchema,
  workspaceTeamSnapshotSchema,
  type AgentActionBatchView,
  type EffectfulOperationResult,
  type ReadOperationResult,
  type WorkspaceTeamSnapshot
} from '@jooevents/contracts';
import type {
  FormTarget,
  FormTargetReferencePinDto,
  ReleaseScopeDto,
  ReleaseTemplateRevisionPinDto
} from '@jooevents/contracts';
import { fileIdInputSchema } from '@jooevents/contracts/files';
import {
  openInertFileDownload,
  streamFileUploadBytes,
  type InertDownloadOutcome,
  type StreamUploadBytesResult
} from '@jooevents/files';
import {
  FILE_MCP_READ_ACCESS_POLICY,
  FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION,
  FILE_PORTAL_READ_ACCESS_POLICY,
  FILE_READ_ACCESS_POLICY,
  FILE_READ_PERMISSION_ID,
  FILES_COMMAND_ACCESS_POLICY,
  FILES_COMMAND_REQUEST_HASH_PROFILE,
  FILES_PORTAL_COMMAND_ACCESS_POLICY,
  FILE_MANAGE_PERMISSION_ID,
  createFilesCommandOperationModule,
  createFilesPortalCommandOperationModule,
  createFilesPortalReadOperationModule,
  createFilesReadOperationModule
} from '@jooevents/files-operations';
import {
  COMMUNICATION_SEND_LANE_OPERATIONS,
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS,
  OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY,
  SEND_MESSAGES_DRAFT_ACCESS_POLICY,
  composeOrganizerCommunicationAuthoringOperationModules,
  createCommunicationDeliveryHistoryReadOperationModule,
  createCommunicationSendOperationModule,
  createOrganizerAudiencePreviewReadOperationModule,
  createOrganizerCommunicationMutationOperationModule,
  createOrganizerCommunicationReadOperationModule,
  createOutboundEmailDeliveryOperationModule,
  createWorkspaceSenderIdentityOperationModule,
  WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
  WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE
} from '@jooevents/communication-operations';
import type { CloudflareFetch } from '@jooevents/cloudflare-email';
import {
  DECISION_NOTIFICATION_MERGE_FIELDS,
  createDeterministicFakeEmailProvider,
  createEmailProviderConfigurationService,
  createEmailProviderReadinessReader,
  createHmacOrganizerPreviewOpaqueTokenCodec,
  createOrganizerMergeRegistryRelease,
  createOrganizerPlainTextRenderStrategyPort,
  type InstallationMailSenderIdentity,
  type OrganizerMergeValueSource
} from '@jooevents/communications';
import {
  DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_READ_ACCESS_POLICY,
  createDeadlineOperationModule
} from '@jooevents/deadline-operations';
import {
  DECISION_MANAGE_ACCESS_POLICY,
  DECISION_REQUEST_HASH_PROFILE,
  DECISION_READ_ACCESS_POLICY,
  createDecisionDirectOperationModule,
  createDecisionOperationModule
} from '@jooevents/decision-operations';
import {
  ENGAGEMENT_MANAGE_ACCESS_POLICY,
  ENGAGEMENT_REQUEST_HASH_PROFILE,
  ENGAGEMENT_READ_ACCESS_POLICY,
  PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE,
  PORTAL_PARTICIPANT_ACT_ACCESS_POLICY,
  PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
  createEngagementDirectOperationModule,
  createEngagementOperationModule,
  createParticipantCurrentAuthorityResolver,
  createParticipantPortalOperationModule
} from '@jooevents/engagement-operations';
import {
  RELEASE_DRAFT_ACCESS_POLICY,
  RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
  RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
  RELEASE_PUBLIC_OPEN_ACCESS_POLICY,
  RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_APPLY_PRESENTATION_READ_PATH,
  RELEASE_PUBLIC_ROSTER_READ_OPERATION,
  RELEASE_PUBLIC_ROSTER_READ_PATH,
  RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_PATH,
  RELEASE_PUBLIC_SCHEDULE_READ_OPERATION,
  RELEASE_PUBLIC_SCHEDULE_READ_PATH,
  RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION,
  RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_PATH,
  createReleaseNativeOperationModule,
  createReleaseOverviewOperationModule,
  createReleasePublicReadOperationModule
} from '@jooevents/release-operations';
import {
  createEventDependencyContributorRegistry,
  type EventDependencyContributorRef
} from '@jooevents/event';
import {
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
  createEventOperationModule,
  createEventSettingsReadOperationModule,
  createEventSettingsUpdateOperationModule
} from '@jooevents/event-operations';
import {
  FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  FIELD_REGISTRY_READ_ACCESS_POLICY,
  createFieldRegistryOperationModule
} from '@jooevents/field-registry';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_EVENT_READ_ACCESS_POLICY,
  INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
  INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE,
  INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_DRAFT_RESUME_OPERATION,
  INTAKE_PUBLIC_FORM_READ_OPERATION,
  INTAKE_PUBLIC_MUTATE_OPERATION,
  INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
  INTAKE_SUBMISSION_READ_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_REQUEST_HASH_PROFILE,
  createApplySurfaceGatedContinuationPolicySource,
  createApplySurfaceGatedPublicFormScopeSource,
  createIntakeFormWriteOperationModule,
  createIntakePublicConformanceMutationOperationModule,
  createIntakePublicConformanceReadOperationModule,
  createIntakeReadOperationModule,
  createOffUnlessConfiguredPublicInputPolicyEvaluator,
  createOffUnlessConfiguredPublicIntakeBootstrapVerifier,
  createSubmissionDirectEntryOperationModule,
  intakePublicApplyPolicyRevision,
  type IntakePublicApplySurfaceGate
} from '@jooevents/intake-operations';
import {
  evaluateAccess,
  PARTICIPANT_ACCESS_LAUNCH_POLICY,
  parseOperationAccessLane,
  parseParticipantEmail,
  resolveParticipantAuthority,
  resolveParticipantContext,
  type CurrentAuthorityResolver,
  type ParticipantChallengeDelivery,
  type ParticipantLane,
  type ParticipantSignInLinkDeliveryEffect
} from '@jooevents/identity-access';
import {
  createReviewDirectOperationModule,
  createReviewOperationModule,
  REVIEW_DIRECT_REQUEST_HASH_PROFILE,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_REQUEST_HASH_PROFILE,
  REVIEW_SNAPSHOT_ACCESS_POLICY,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  type ReviewViewerResolver
} from '@jooevents/review-operations';
import {
  createReviewerRosterOperationModule,
  REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY
} from '@jooevents/review-operations/roster';
import {
  createProgramReferenceContributorRegistry,
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
  createProgramVocabularyReadOperationModule,
  createProgramVocabularyDirectOperationModule,
  createProgramVocabularyMergeOperationModule
} from '@jooevents/program-operations';
import type { PlaceableSessionIdentityPort } from '@jooevents/schedule';
import {
  SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
  createSchedulePlacementDirectOperationModule,
  createSchedulePlacementOperationModule
} from '@jooevents/schedule-operations';
import {
  createSchedulePlaceableSessionPort,
  createSessionAwareReviewerScopeTargetSource
} from '@jooevents/session';
import {
  SESSION_CHANGE_REQUEST_HASH_PROFILE,
  SESSION_MANAGE_ACCESS_POLICY,
  SESSION_READ_ACCESS_POLICY,
  createSessionDirectOperationModule,
  createSessionOperationModule
} from '@jooevents/session-operations';
import {
  SUBMISSION_TRIAGE_REQUEST_HASH_PROFILE,
  SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
  SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
  SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
  createSubmissionTriageTransitionOperationModule,
  createSubmissionTriageReadOperationModule,
  createSubmissionTriageSubmitInitializer
} from '@jooevents/submission-triage';
import {
  TASK_MANAGE_ACCESS_POLICY,
  TASK_MUTATION_REQUEST_HASH_PROFILE,
  createTaskBoardReadOperationModule,
  createTaskMutationOperationModule
} from '@jooevents/task-operations';
import {
  DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG,
  createOperationHistoryReadOperationModule,
  WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
  createWorkspaceOverviewOperationModule
} from '@jooevents/workspace-operations';
import {
  DeterministicTemplateEditService,
  starterTemplateArtifacts
} from '@jooevents/template-authoring';
import {
  TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
  TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
  TEMPLATE_EDIT_REQUEST_HASH_PROFILE,
  createTemplateArtifactNativeOperationModule,
  createTemplateArtifactReadOperationModule,
  createTemplateEditOperationModule
} from '@jooevents/template-authoring-operations';
import {
  canonicalJsonText,
  parseAuditEventId,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  bootstrapEmptyInstall,
  createFoundationEphemeralSQLiteRuntime,
  createSQLiteBetterAuthDatabase,
  createSQLiteAccessRepositories,
  createSQLiteDeadlineDirectEffectDomainRegistration,
  createSQLiteDecisionDirectEffectDomainRegistration,
  createSQLiteEngagementDirectEffectDomainRegistration,
  createSQLiteEventEffectDomainRegistration,
  createSQLiteEventSettingsDirectEffectDomainRegistration,
  createSQLiteEventSettingsInitializer,
  createSQLiteTemplateArtifactNativeEffectDomainRegistrations,
  createSQLiteTemplateEditEffectDomainRegistration,
  createSQLiteParticipantPortalEffectDomainRegistration,
  createSQLiteParticipantPortalReadSource,
  createSQLiteParticipantSessionAuthorityView,
  createSQLiteProvisioningStore,
  createSQLiteSchedulePlacementDirectEffectDomainRegistration,
  createSQLiteSessionDirectEffectDomainRegistration,
  createSQLiteSubmissionTriageDirectEffectDomainRegistration,
  createSQLiteTaskDirectEffectDomainRegistration,
  createSQLiteIntakeDirectEntryEffectDomainRegistration,
  SQLiteEventSettingsRepository,
  SQLiteTaskRepository,
  SQLiteTemplateAuthoringRepository,
  SQLiteReadImmutableAuditPort,
  SQLiteAgentActionRunRepository,
  type EphemeralSQLiteRuntime
} from '@jooevents/persistence';
import { SQLiteDeadlineRepository } from '@jooevents/persistence/deadline';
import {
  SQLiteDecisionCandidateSourceAdapter,
  SQLiteDecisionRepository,
  SQLiteDecisionReviewBasisSourceAdapter,
  createSQLiteDecisionEnvironmentSource,
  createSQLiteIntakeParticipantPersonSource
} from '@jooevents/persistence/decision';
import {
  createSQLiteDecisionAudienceSource,
  createSQLiteDraftRenderContentSource,
  decisionAudienceDelegates,
  mintDecisionAudienceRecipes,
  seedDecisionNotificationCommunications
} from '@jooevents/persistence/organizer-decision-audience';
import {
  createSQLiteTaskReminderAudienceSource,
  seedTaskReminderPurpose
} from '@jooevents/persistence/organizer-task-reminder-audience';
import {
  SQLiteCommunicationMessageReleaseStore,
  createSQLiteOutboundEmailEnvelopeResolver
} from '@jooevents/persistence/message-releases';
import { SQLiteOutboundEmailDeliveryLedger } from '@jooevents/persistence/outbound-email-delivery';
import {
  createSQLiteOutboundEmailDeliveryEffectDomainRegistration
} from '@jooevents/persistence/outbound-email-delivery-effect-domain';
import {
  SQLiteEngagementRepository
} from '@jooevents/persistence/engagement';
import {
  createSQLiteIntakeFormVersionPinSource,
  SQLiteReleaseRepository,
  type SQLiteReleaseParticipantNameSource,
  type SQLiteReleaseUpstreamSources
} from '@jooevents/persistence/release';
import {
  createSQLiteReleaseNativeEffectDomainRegistrations
} from '@jooevents/persistence/release-native-effect-domain';
import {
  createSQLiteIntakeAttributedParticipantSource,
  createSQLiteParticipantRelationshipSource,
  SQLiteParticipantAccessStore
} from '@jooevents/persistence/participant-access';
import {
  createSQLiteParticipantChallengeDelivery
} from '@jooevents/persistence/participant-challenge-delivery';
import {
  createSQLiteWorkspaceSignInLinkDelivery,
  decideWorkspaceSignInLinkEligibility,
  workspaceSignInLinkAddressFingerprint,
  WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID
} from '@jooevents/persistence/workspace-sign-in-link';
import {
  createSQLiteFieldRegistryDirectEffectDomainRegistration
} from '@jooevents/persistence/field-registry-direct-effect-domain';
import {
  FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR,
  SQLiteFieldRegistryEventDependencySource,
  SQLiteFieldRegistryRepository,
  SQLiteIntakeFieldRegistryFormReferenceResolver,
  SQLiteProgramVocabularyFieldOptionSource,
  createSQLiteFieldRegistryEventInitializer
} from '@jooevents/persistence/field-registry';
import {
  SQLiteEventSpineRepository,
  createSQLiteEventSpineOperatorEventRelationshipSource
} from '@jooevents/persistence/event-spine';
import { SQLiteIntakeClassifiedProjection } from '@jooevents/persistence/intake-classified-projection';
import {
  createSQLiteIntakeFormWriteEffectDomainRegistrations
} from '@jooevents/persistence/intake-form-write-effect-domain';
import {
  createSQLiteIntakeFormProgramVocabularyReferenceAdapter,
  INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR
} from '@jooevents/persistence/intake-form-program-reference';
import {
  SQLiteIntakeRepository,
  type SQLiteIntakeScopeInput
} from '@jooevents/persistence/intake';
import {
  INTAKE_PUBLIC_CONTINUATION_HEADER,
  INTAKE_PUBLIC_CONTINUATION_MINT_PATH,
  INTAKE_PUBLIC_FORM_SELECTOR_HEADER,
  createIntakePublicCeremonyGatedDirectory,
  createSQLiteCeremonyMintedIntakeParticipantAttributionSource,
  createSQLiteIntakePublicApplySurfaceGate,
  intakePublicApplySurfaceCeremonyPinSource
} from '@jooevents/persistence/intake-public-ceremony';
import {
  createSQLiteIntakePublicMutationEffectDomainRegistration,
  type SQLiteIntakePublicMutationEffectIds
} from '@jooevents/persistence/intake-public-mutation-effect-domain';
import {
  SQLitePublicMutationEffectCompletionPort
} from '@jooevents/persistence/public-mutation-effect-completion';
import {
  SQLitePublicMutationContinuationTrial
} from '@jooevents/persistence/testing/public-mutation-continuation-trial';
import {
  SQLiteIntakeSubmissionTriageSourceAdapter,
  SQLiteSubmissionTriageRepository
} from '@jooevents/persistence/submission-triage';
import {
  createSQLiteProgramVocabularyDirectEffectDomainRegistration
} from '@jooevents/persistence/program-vocabulary-direct-effect-domain';
import {
  createSQLiteProgramVocabularyMergeEffectDomainRegistrations
} from '@jooevents/persistence/program-vocabulary-merge-effect-domain';
import {
  SQLiteProgramVocabularyRepository,
  createSQLiteProgramVocabularyContributorAdapterRegistry
} from '@jooevents/persistence/program-vocabulary';
import {
  SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
  createSQLiteScheduleRoomReferenceAdapter
} from '@jooevents/persistence/schedule-placement';
import { SQLiteSessionRepository } from '@jooevents/persistence/session';
import { SQLiteReviewRepository } from '@jooevents/persistence/review';
import {
  createSQLiteReviewDirectEffectDomainRegistration
} from '@jooevents/persistence/review-direct-effect-domain';
import {
  createSQLiteReviewEvaluationDraftSaveEffectDomainRegistration
} from '@jooevents/persistence/review-evaluation-draft-save-effect-domain';
import {
  SQLiteReviewerAuthoritySource
} from '@jooevents/persistence/reviewer-authority-source';
import {
  SQLiteReviewerScopeTargetSource
} from '@jooevents/persistence/reviewer-scope-target-source';
import { SQLiteReviewerRosterRepository } from '@jooevents/persistence/reviewer-roster';
import {
  createSQLiteReviewerRosterDirectEffectDomainRegistration
} from '@jooevents/persistence/reviewer-roster-direct-effect-domain';
import {
  SQLiteEffectUnitOfWorkPort,
  createSQLiteEffectDomainAdapterRegistry
} from '@jooevents/persistence/sqlite-effect-unit-of-work';
import { SQLiteClassifiedPayloadStore } from '@jooevents/persistence/sqlite-classified-payload-store';
import {
  SQLiteOrganizerCommunicationAuthoringRepository
} from '@jooevents/persistence/organizer-authoring';
import {
  createSQLiteOrganizerCommunicationAuthoringEffectDomainRegistrations
} from '@jooevents/persistence/organizer-authoring-effect-domain';
import {
  SQLiteOrganizerAudiencePreviewRepository,
  createOrganizerPreviewDraftBindingSource
} from '@jooevents/persistence/organizer-audience-preview';
import {
  SQLiteEmailProviderConfigurationRepository
} from '@jooevents/persistence/email-provider-configuration';
import { createSQLiteWorkspaceOverviewProjection } from '@jooevents/persistence/workspace-overview';
import { createSQLiteOperationHistoryReader } from '@jooevents/persistence/operation-history';
import {
  createWorkspaceTeamProvisioningSynchronizationPort,
  SQLiteWorkspaceTeamRepository,
  ensureWorkspaceTeamRoles
} from '@jooevents/persistence/sqlite/workspace-team';
import {
  createSQLiteWorkspaceTeamMutationEffectDomainRegistration
} from '@jooevents/persistence/sqlite/workspace-team-direct-effect-domain';
import {
  createAuth,
  WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS,
  type JooEventsAuth
} from '../auth/better-auth';
import { createBetterAuthOperatorEvidenceVerifier } from '../auth/operator-evidence';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import { SHARP_FILE_IMAGE_REENCODER } from './file-image-reencoder';
import type { ServerConfig } from '../config';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig,
  type CommunicationsProviderConfig,
  type MailSenderConfig
} from '../config/communications';
import { createHttpApp } from '../http/app';
import { createAgentActionRunsHttpAdapter } from '../http/agent-action-runs';
import type { EmbedFramingPolicySource } from '../http/embed-security';
import {
  createParticipantOperationsHttpAdapter
} from '../http/participant-operations';
import {
  readPortalSessionToken,
  type ParticipantEntryRuntime
} from '../http/participant-entry';
import { createPublicOperationsHttpAdapter } from '../http/public-operations';
import { createSerialHttpRequestBoundary } from '../http/request-serialization';
import { createCloudflareTokenVerificationReadinessProbe } from './cloudflare-email-readiness-probe';
import {
  buildDeploymentSenderPresentation,
  createCommunicationSendLane,
  type CommunicationDeliveryRoute,
  type CommunicationSendLane
} from './communication-send-lane';
import {
  createCommunicationsProviderActivation,
  type CommunicationsProviderActivation
} from './communications-provider-activation';
import {
  createCloudflareApiTokenLease,
  createCommunicationsProviderRuntime,
  type OpaqueSecretTextResolver
} from './communications-provider-runtime';
import { createDeploymentSecretFileResolver } from './deployment-secret-resolver';
import {
  createSQLiteCommunicationDeliveryHistorySource
} from './communication-delivery-history';
import { createCommunicationSendOperationRuntime } from './communication-send-operations';
import { createOutboundDispatchLoop, type OutboundDispatchLoop } from './outbound-dispatch-loop';
import { createFilesLiveComposition, type FilesLiveComposition } from './files-live';
import { createWorkspaceSenderIdentityComposition } from './communication-sender-identity-live';
import { createSQLiteOperatorAuthorityComposition } from './operator-authority';

const eventProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.event.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.event.workspace-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.event.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.event.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const templateArtifactProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.template-artifact.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.template-artifact.workspace-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.template-artifact.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.template-artifact.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const programVocabularyProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.program-vocabulary.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.program-vocabulary.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.program-vocabulary.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.program-vocabulary.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const schedulePlacementProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.schedule-placement.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.schedule-placement.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.schedule-placement.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.schedule-placement.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const sessionProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.session.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.session.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.session.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.session.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const releaseProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.release.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.release.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.release.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.release.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const participantPortalProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.portal.participant-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.portal.lane-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.portal.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.portal.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const filesProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.file.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.file.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.file.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.file.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const filesPortalProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.file.portal-participant-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.file.portal-lane-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.file.portal-request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.file.portal-idempotency-credential',
    version: parseContractVersion(1)
  })
});

const deadlineProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.deadline.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.deadline.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.deadline.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.deadline.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const taskProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.task.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.task.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.task.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.task.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const decisionProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.decision.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.decision.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.decision.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.decision.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const engagementProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.engagement.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.engagement.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.engagement.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.engagement.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const intakeProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.intake.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.intake.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.intake.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.intake.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const fieldRegistryProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.field-registry.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.field-registry.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.field-registry.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.field-registry.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const submissionTriageProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.submission-triage.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.submission-triage.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.submission-triage.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.submission-triage.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const reviewProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.review.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.review.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.review.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.review.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const reviewerRosterProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.reviewer-roster.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.reviewer-roster.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.reviewer-roster.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.reviewer-roster.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const workspaceTeamProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.workspace-team.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.workspace-team.workspace-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.workspace-team.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.workspace-team.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const organizerCommunicationProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.communication.organizer-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.communication.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.communication.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.communication.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const communicationProviderReadProfiles = Object.freeze({
  authorityPrincipalKeyProfile: Object.freeze({
    key: 'key-profile.communication.provider-principal',
    version: parseContractVersion(1)
  }),
  scopePartitionProfile: Object.freeze({
    key: 'key-profile.communication.provider-workspace-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalizationProfile: Object.freeze({
    key: 'key-profile.communication.provider-request-canonicalization',
    version: parseContractVersion(1)
  })
});

const senderIdentityProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.communication.sender-identity-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.communication.sender-identity-workspace-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.communication.sender-identity-request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.communication.sender-identity-idempotency-credential',
    version: parseContractVersion(1)
  })
});

const outboundDispatchProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.communication.outbound-dispatch-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.communication.outbound-dispatch-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.communication.outbound-dispatch-request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.communication.outbound-dispatch-idempotency-credential',
    version: parseContractVersion(1)
  })
});

const OUTBOUND_DISPATCH_REQUEST_HASH_PROFILE = Object.freeze({
  key: 'request-hash.communication.outbound-email-dispatch',
  version: parseContractVersion(1)
});

const organizerCommunicationExactContactPolicy = Object.freeze({
  key: 'policy.communication.preview-contact-disclosure',
  version: parseContractVersion(1)
});

function communicationDefinitionRef(key: string, definition: unknown) {
  const reference = Object.freeze({ key, version: parseContractVersion(1) });
  return Object.freeze({
    reference,
    definitionDigestSha256: createHash('sha256')
      .update(canonicalJsonText({ schemaVersion: 1, reference, definition }), 'utf8')
      .digest('hex')
  });
}

function createOrganizerCommunicationRequestHashSealer(
  keyBytesInput: Uint8Array,
  operations: readonly { readonly name: string }[] =
    Object.values(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS)
) {
  const keyBytes = Uint8Array.from(keyBytesInput);
  const operationNames: ReadonlySet<string> = new Set(
    operations.map((operation) => operation.name)
  );
  return Object.freeze({
    seal(canonicalRequestBytes: Uint8Array) {
      if (!(canonicalRequestBytes instanceof Uint8Array) || canonicalRequestBytes.byteLength === 0) {
        throw new TypeError('communication_request_hash_input_invalid');
      }
      let operationName: string;
      try {
        const request = JSON.parse(new TextDecoder().decode(canonicalRequestBytes)) as {
          readonly operation?: { readonly name?: unknown };
        };
        if (typeof request.operation?.name !== 'string' || !operationNames.has(request.operation.name)) {
          throw new TypeError();
        }
        operationName = request.operation.name;
      } catch {
        throw new TypeError('communication_request_hash_operation_invalid');
      }
      return Object.freeze({
        verifierProfile: Object.freeze({
          key: `request-hash.communication.organizer.${operationName}`,
          version: parseContractVersion(1)
        }),
        verifierSha256: createNodeHmac('sha256', keyBytes)
          .update(canonicalRequestBytes)
          .digest('hex')
      });
    }
  });
}

const intakeClassifiedProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef(
    'classification', 'classification.intake-answer', 1
  ),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.intake-answer', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.utf8-text', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef(
    'descriptor_auth', 'descriptor-auth.intake-answer', 1
  )
});

function randomHmacKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function newPublicCompletionReference(): string {
  return `pcr_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * The intake read and mutation modules each register the shared intake
 * null-detail schema and operation-audit record profile; when both compose
 * into the one public registry the second registration must be dropped so
 * the composition stays duplicate-free.
 */
function omitSharedIntakeInfrastructure(module: OperationRegistryModule): OperationRegistryModule {
  return Object.freeze({
    ...module,
    source: Object.freeze({
      ...module.source,
      schemas: (module.source.schemas ?? []).filter((entry) =>
        entry.reference.key !== 'schema.intake.operation.null-detail'
      ),
      operationAuditRecordProfiles: (module.source.operationAuditRecordProfiles ?? [])
        .filter((entry) => entry.reference.key !== 'record-profile.intake.operation-audit')
    })
  });
}

function bootstrapEventSet(
  database: EphemeralSQLiteRuntime,
  workspaceId: ReturnType<typeof parseWorkspaceId>
): SQLiteEventSpineRepository {
  const repository = new SQLiteEventSpineRepository(database.sqlite);
  let began = false;
  try {
    database.sqlite.exec('BEGIN IMMEDIATE;');
    began = true;
    repository.bootstrapWorkspaceEventSet(workspaceId);
    database.sqlite.exec('COMMIT;');
    return repository;
  } catch (error) {
    if (began && database.sqlite.inTransaction) database.sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function bootstrapEphemeralOwnerPermissionGrants(input: {
  readonly database: EphemeralSQLiteRuntime;
  readonly ownerReservationId: string;
}): void {
  const insert = input.database.sqlite.query<never, [string, string, string, string]>(`
    INSERT INTO reservation_permission_overrides (
      id, reservation_id, permission_id, effect, scope_kind, event_id, reason
    ) VALUES (?, ?, ?, 'grant', 'workspace', NULL, ?)
  `);
  for (const [permissionId, reason] of [
    ['program.vocabulary.manage', 'Ephemeral live Program Vocabulary owner grant'],
    ['communication.provider.manage', 'Ephemeral live email provider owner grant'],
    // `publication.manage` is minted with no preset carrying it; this
    // explicit reservation override is a bootstrap-only grant so the owner
    // principal can publish in the joined ephemeral runtime.
    ['publication.manage', 'Ephemeral live publication owner grant (bootstrap-only)']
  ] as const) {
    insert.run(crypto.randomUUID(), input.ownerReservationId, permissionId, reason);
  }
}

export interface EphemeralLiveRuntime {
  readonly database: EphemeralSQLiteRuntime;
  readonly auth: JooEventsAuth;
  readonly app: ReturnType<typeof createHttpApp>;
  readonly workspaceId: string;
  /**
   * Composed decision-notification send lane (adopt reviewed previews, commit
   * `send_messages` ceremonies). Server-internal seam consumed by tests today
   * and by the J-WEB-2 HTTP mounting next.
   */
  readonly communications: CommunicationSendLane;
  /**
   * Read-only access to the immutable per-recipient release store. The reviewed
   * envelope is the byte-exact record of what a send will present, so this is
   * the honest place to assert rendered sender presentation.
   */
  readonly communicationReleases: Pick<SQLiteCommunicationMessageReleaseStore, 'read'>;
  /**
   * One-pass outbound dispatch over the delivery ledger: the inert fake
   * provider by default, the activated registration's delivery adapter when a
   * provider mode is composed.
   */
  readonly outboundDispatch: OutboundDispatchLoop;
  /**
   * Present only when a provider registration is composed: the activation
   * lifecycle row handle and the owner-lane external-effect executors
   * (readiness check, diagnostic send).
   */
  readonly providerActivation?: CommunicationsProviderActivation;
  /**
   * Per-request embed framing policy over the current event's surface heads.
   * The Bun request handler stamps `/embed/*` HTML with exactly this
   * allowlist; everything else serves the deny-all pair.
   */
  readonly embedFraming: EmbedFramingPolicySource;
  /**
   * Files v1 composition: the D4 limits actually in force, the blob store,
   * the repository, and the D7 orphan sweep as a callable seam (a job runner
   * or operator action invokes it; deliberately no timer in this runtime).
   */
  readonly files: Pick<
    FilesLiveComposition,
    'limits' | 'blobs' | 'repository' | 'sweepOrphanBlobs' | 'sweepExpiredIntents'
  >;
  /**
   * Structurally test-only access to the compiled operator executor, real
   * admission path, and a read-only public-binding snapshot. It is absent unless
   * `devFixtures: true`; no member exposes a handler, authority resolver, or
   * database mutation primitive.
   */
  readonly testSupport?: EphemeralLiveTestSupport;
  close(): ReturnType<EphemeralSQLiteRuntime['close']>;
}

export type EphemeralLiveTestActorPersona = 'organizer' | 'reviewer' | 'second-organizer';

export interface EphemeralLiveTestActor {
  readonly persona: EphemeralLiveTestActorPersona;
  readonly userId: string;
  readonly membership: { readonly id: string; readonly version: number };
  readonly cookie: string;
}

export interface EphemeralLiveTestPublicEffectBinding {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly method: 'POST';
  readonly path: string;
}

export interface EphemeralLiveTestSupport {
  /** Read-only snapshot of the production public registry; it cannot invoke an operation. */
  publicEffectBindings(): readonly EphemeralLiveTestPublicEffectBinding[];
  /** Invokes one registered operator read through context, authority, and projection. */
  invokeRead(input: {
    readonly actor: EphemeralLiveTestActor;
    readonly operationName: string;
    readonly operationVersion?: number;
    readonly businessInput?: unknown;
    readonly correlationId?: string;
  }): Promise<ReadOperationResult>;
  /** Invokes one registered operator effect through seal, guard, UoW, log, and replay. */
  invokeEffect(input: {
    readonly actor: EphemeralLiveTestActor;
    readonly operationName: string;
    readonly operationVersion?: number;
    readonly businessInput: unknown;
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<EffectfulOperationResult>;
  /**
   * Creates three Better Auth principals and admits them through the same
   * reservation/access-context path as product sign-in. Additional actors are
   * invited through `workspace_team.invite`, never inserted into auth/domain tables.
   */
  bootstrapActors(): Promise<{
    readonly organizer: EphemeralLiveTestActor;
    readonly reviewer: EphemeralLiveTestActor;
    readonly secondOrganizer: EphemeralLiveTestActor;
  }>;
  /** Frozen registry-derived plan metadata; no handler or mutation capability escapes. */
  agentActionPlanCatalog(): {
    readonly registryDigestSha256: string;
    readonly operations: readonly RegisteredAgentActionEligibility[];
  };
  /** Submits through the application plan-only surface, never the repository. */
  submitAgentActionPlan(candidate: unknown): AgentActionBatchView;
  /** Safe projection used by the approval directory/detail surface. */
  inspectAgentActionRun(batchId: string): AgentActionBatchView | undefined;
  /** Advances exactly one leased step through the real registered executor. */
  advanceAgentActionRun(input: {
    readonly batchId: string;
    readonly workerId: string;
    readonly at?: string;
    readonly crashAfterAtomicCommit?: boolean;
  }): Promise<AgentActionBatchView>;
}

/** Opens one process-lifetime isolated organizer runtime over a new database. */
export async function createEphemeralLiveRuntime(input: {
  readonly config: ServerConfig;
  /**
   * Structurally opts this composition into the dev-only participant fixture
   * routes (the issued-link token oracle that bypasses email delivery). It is
   * OFF unless a caller sets it explicitly, so a beyond-loopback preview never
   * mounts the oracle by convention: only a loopback-bound dev/test entry
   * enables it. See the `/api/portal/entry/dev/issued-link` mount below.
   */
  readonly devFixtures?: boolean;
  /**
   * Outbound email provider composition. STRUCTURALLY inert unless an entry
   * passes it: callers that omit this (every test constructing the runtime
   * directly) get the empty provider registry, the deterministic fake dispatch
   * adapter, and the sentinel delivery routes regardless of process env, so no
   * test run can reach a real provider by accident. The Bun entry loads it
   * from the deployment environment (`loadCommunicationsProviderConfig`,
   * `loadMailSenderConfig`); `JOOEVENTS_EMAIL_PROVIDER_MODE` therefore stays
   * the final, instantly reversible switch.
   */
  readonly communications?: {
    readonly provider: CommunicationsProviderConfig;
    readonly mailSender?: MailSenderConfig;
    /** Test seam. Defaults to the `deployment.secret` file resolver. */
    readonly secretResolver?: OpaqueSecretTextResolver;
    /** Test seam. Defaults to global fetch. */
    readonly fetch?: CloudflareFetch;
  };
}): Promise<EphemeralLiveRuntime> {
  const database = createFoundationEphemeralSQLiteRuntime();
  let filesBlobRootDirectory: string | undefined;
  try {
    const bootstrap = bootstrapEmptyInstall({
      sqlite: database.sqlite,
      ownerEmail: input.config.bootstrapOwnerEmail,
      workspaceName: 'JooEvents',
      now: new Date().toISOString()
    });
    const workspaceId = parseWorkspaceId(bootstrap.workspaceId);
    bootstrapEphemeralOwnerPermissionGrants({
      database,
      ownerReservationId: bootstrap.ownerReservationId
    });
    const events = bootstrapEventSet(database, workspaceId);
    // The magic-link deliver seam late-binds: the gated outbox delivery needs
    // the communications composition, which composes after auth. Until it is
    // fulfilled, every requested link drops silently — exactly the posture an
    // ineligible address gets — so the surface never widens during boot.
    let workspaceSignInLinkDeliver:
      | ((input: {
          readonly email: string;
          readonly url: string;
          readonly token: string;
        }) => Promise<void>)
      | null = null;
    const auth = createAuth(input.config, createSQLiteBetterAuthDatabase(database.sqlite), {
      magicLink: {
        deliver: async (link) => {
          if (workspaceSignInLinkDeliver !== null) await workspaceSignInLinkDeliver(link);
        }
      }
    });
    const clock = Object.freeze({
      now: () => parseInstant(new Date().toISOString())
    });
    const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
    const deadlineDirectDomain = createSQLiteDeadlineDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      ids: Object.freeze({
        newDeadlineId: () => crypto.randomUUID()
      })
    });
    const eventDependencySource = new SQLiteFieldRegistryEventDependencySource(
      database.sqlite
    );
    const eventDependencyRegistry = createEventDependencyContributorRegistry({
      expected: [FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR],
      contributors: [FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR]
    });
    const intakeFormReferenceAdapter =
      createSQLiteIntakeFormProgramVocabularyReferenceAdapter();
    const scheduleRoomReferenceAdapter = createSQLiteScheduleRoomReferenceAdapter({
      sqlite: database.sqlite,
      attribution() {
        throw new TypeError('schedule_room_reference_repoint_requires_session_owner');
      }
    });
    const referenceRegistry = createProgramReferenceContributorRegistry({
      expected: [
        INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
        SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR
      ],
      contributors: [
        INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
        SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR
      ]
    });
    const contributorAdapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite: database.sqlite,
      expected: [
        INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
        SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR
      ],
      adapters: [intakeFormReferenceAdapter, scheduleRoomReferenceAdapter]
    });
    const vocabularyRead = new SQLiteProgramVocabularyRepository(
      database.sqlite,
      referenceRegistry,
      contributorAdapters,
      () => {
        throw new TypeError('program_vocabulary_read_repository_cannot_mutate');
      }
    );
    const sessionRepository = new SQLiteSessionRepository(database.sqlite, vocabularyRead);
    const placeableSessions: PlaceableSessionIdentityPort =
      createSchedulePlaceableSessionPort(sessionRepository);
    const intakeClassifiedStore = new SQLiteClassifiedPayloadStore(database.sqlite, {
      encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
        reference: Object.freeze({ key: 'encryption.intake-answer', version: 1 }),
        keyBytes: randomHmacKey()
      })
    });
    const workspaceTeamClassifiedStore = new SQLiteClassifiedPayloadStore(database.sqlite, {
      encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
        reference: Object.freeze({ key: 'encryption.workspace-invitation', version: 1 }),
        keyBytes: randomHmacKey()
      })
    });
    const organizerCommunicationClassifiedStore = new SQLiteClassifiedPayloadStore(
      database.sqlite,
      {
        encryptionProfile: issueSynchronousClassifiedPayloadEncryptionProfile({
          reference: Object.freeze({
            key: 'encryption.communication-organizer-payload',
            version: 1
          }),
          keyBytes: randomHmacKey()
        })
      }
    );
    const organizerCommunicationAuthoring =
      new SQLiteOrganizerCommunicationAuthoringRepository(
        database.sqlite,
        organizerCommunicationClassifiedStore
      );
    // Outbound provider seam. Default posture (no `communications` input, or
    // mode `disabled`): the deterministic fake exists ONLY as the dispatch
    // worker's adapter, the configurable-provider registry is composed empty —
    // its outbound-only gate structurally rejects the fake's full manifest, an
    // empty registry keeps the provider setup and readiness surfaces honestly
    // reporting that nothing is configured — and the send lanes' non-scenario
    // external delivery keys make every fake submission resolve as a terminal
    // known rejection, so deliveries are recorded honestly as not delivered.
    // With `mode: 'cloudflare_rest'` (reviewed activation, entry-composed),
    // the registry carries the one Cloudflare REST registration built over the
    // opaque `deployment.secret` token resolver and the token-verification
    // readiness probe; construction performs no provider I/O.
    const communicationsProviderConfig = input.communications?.provider
      ?? loadCommunicationsProviderConfig({});
    const mailSender = input.communications?.mailSender ?? loadMailSenderConfig(process.env);
    if (communicationsProviderConfig.mode !== 'disabled' && !mailSender.configured) {
      throw new TypeError(
        'JOOEVENTS_MAIL_FROM_ADDRESS is required when JOOEVENTS_EMAIL_PROVIDER_MODE is not disabled'
      );
    }
    const providerRuntime = createCommunicationsProviderRuntime({
      config: communicationsProviderConfig,
      ...(communicationsProviderConfig.mode === 'cloudflare_rest'
        ? (() => {
            const secretResolver = input.communications?.secretResolver
              ?? createDeploymentSecretFileResolver();
            const cloudflareFetch: CloudflareFetch = input.communications?.fetch
              ?? ((request, init) => globalThis.fetch(request, init));
            return {
              secretResolver,
              fetch: cloudflareFetch,
              readinessProbe: createCloudflareTokenVerificationReadinessProbe({
                tokenLease: createCloudflareApiTokenLease({
                  reference: communicationsProviderConfig.apiTokenSecret,
                  resolver: secretResolver
                }),
                fetch: cloudflareFetch
              })
            };
          })()
        : {})
    });
    const fakeEmailProvider = createDeterministicFakeEmailProvider();
    const emailProviderRegistry = providerRuntime.registry;
    const emailProviderRepository = new SQLiteEmailProviderConfigurationRepository(
      database.sqlite
    );
    const emailProviderConfiguration = createEmailProviderConfigurationService({
      registry: emailProviderRegistry,
      store: emailProviderRepository
    });
    const emailProviderReadiness = createEmailProviderReadinessReader({
      configuration: emailProviderConfiguration,
      registry: emailProviderRegistry,
      store: emailProviderRepository,
      nowEpochMs: () => Date.now()
    });
    // Reviewed activation (runbook §4): with the Cloudflare registration in
    // the registry, stage and activate the one `email_provider_connections`
    // lifecycle row, and compose the two owner-lane external-effect executors
    // (readiness check, diagnostic send). Absent a configured provider this
    // whole block is structurally skipped and nothing below changes.
    let providerActivation: CommunicationsProviderActivation | undefined;
    let communicationDeliveryRoute: CommunicationDeliveryRoute | undefined;
    if (
      providerRuntime.registration !== null
      && communicationsProviderConfig.mode === 'cloudflare_rest'
      && mailSender.configured
    ) {
      providerActivation = createCommunicationsProviderActivation({
        sqlite: database.sqlite,
        workspaceId,
        configuration: emailProviderConfiguration,
        repository: emailProviderRepository,
        registration: providerRuntime.registration,
        connectionConfig: Object.freeze({
          accountId: communicationsProviderConfig.accountId,
          apiTokenSecret: communicationsProviderConfig.apiTokenSecret
        }),
        sender: mailSender,
        clock,
        nowEpochMs: () => Date.now(),
        ids: Object.freeze({ newId: () => crypto.randomUUID() })
      });
      const activeConnection = await providerActivation.ensureActiveOutboundConnection();
      communicationDeliveryRoute = Object.freeze({
        providerConnectionRevisionId: activeConnection.revisionId,
        sender: buildDeploymentSenderPresentation(mailSender)
      });
    }
    const organizerPlainTextMergeRegistry = createOrganizerMergeRegistryRelease({
      reference: Object.freeze({
        key: 'merge-registry.communication.plain-text',
        version: 1
      }),
      // The decision-notification field set; the release digest matches
      // `createDecisionNotificationMergeRegistryRelease()` exactly.
      fields: DECISION_NOTIFICATION_MERGE_FIELDS
    });
    const workspaceTeamInvitationLookupKey = randomHmacKey();
    const workspaceTeamRepository = new SQLiteWorkspaceTeamRepository(
      database.sqlite,
      workspaceTeamClassifiedStore
    );
    database.sqlite.transaction(() => {
      ensureWorkspaceTeamRoles({
        sqlite: database.sqlite,
        workspaceId,
        now: clock.now(),
        newRoleId: () => crypto.randomUUID()
      });
      workspaceTeamRepository.initialize(workspaceId);
    }).immediate();
    const accessContext = createProvisioningService({
      // Email-proof principals (workspace magic link) carry claims issued by
      // this installation, keyed by the auth user id — never by the address.
      principals: createSQLiteAuthPrincipalReader(database.sqlite, {
        issuerOrigin: new URL(input.config.baseUrl).origin
      }),
      store: createSQLiteProvisioningStore(database.sqlite, {
        workspaceTeam: createWorkspaceTeamProvisioningSynchronizationPort(
          workspaceTeamRepository
        ),
        workspaceInvitationLookupKeyBytes: workspaceTeamInvitationLookupKey
      }),
      admission: {
        mode: input.config.admissionMode,
        ...(input.config.googleHostedDomain
          ? { hostedDomain: input.config.googleHostedDomain }
          : {})
      }
    });
    const intakeClassifiedProjection = new SQLiteIntakeClassifiedProjection({
      store: intakeClassifiedStore,
      profiles: intakeClassifiedProfiles
    });
    const intakeRepository = new SQLiteIntakeRepository(
      database.sqlite,
      Object.freeze({
        resolveActiveCategory(
          scope: SQLiteIntakeScopeInput,
          target: Extract<FormTarget, { readonly kind: 'category' }>
        ): Extract<FormTargetReferencePinDto, { readonly kind: 'category' }> | undefined {
          const vocabulary = vocabularyRead.readVocabulary(scope);
          const candidates = target.category.kind === 'track'
            ? vocabulary?.tracks
            : vocabulary?.formats;
          const item = candidates?.find((candidate) =>
            candidate.id === target.category.id && candidate.status === 'active'
          );
          return item
            ? Object.freeze({
                kind: 'category' as const,
                categoryKind: target.category.kind,
                id: item.id,
                name: item.name,
                version: item.version
              })
            : undefined;
        }
      }),
      intakeClassifiedProjection
    );
    const fieldRegistryRepository = new SQLiteFieldRegistryRepository(
      database.sqlite,
      new SQLiteIntakeFieldRegistryFormReferenceResolver(database.sqlite)
    );
    const eventSettingsRepository = new SQLiteEventSettingsRepository(database.sqlite);
    const templateAuthoringRepository = new SQLiteTemplateAuthoringRepository(database.sqlite);
    const templateEditService = new DeterministicTemplateEditService();
    const fieldRegistryOptionSource = new SQLiteProgramVocabularyFieldOptionSource(
      database.sqlite
    );
    const submissionTriageSource = new SQLiteIntakeSubmissionTriageSourceAdapter(
      intakeRepository
    );
    const submissionTriageRepository = new SQLiteSubmissionTriageRepository(
      database.sqlite,
      submissionTriageSource
    );
    // ------------------------------------------------------------------
    // Public CFP submission activation. One published apply-surface gate is
    // the single serving truth for the anonymous surface: it sources the
    // public form-read scope, the continuation policy the ceremony boundary
    // re-resolves on every mint/admit/effect, and the `public_open` policy
    // revision. The gate follows the workspace's CURRENT event per
    // resolution, so absence, rollback, closing, re-pinning, and an event
    // switch all fail closed without recomposition.
    // ------------------------------------------------------------------
    const applySurfaceGatesByEvent = new Map<string, IntakePublicApplySurfaceGate>();
    const applySurfaceGate: IntakePublicApplySurfaceGate = Object.freeze({
      resolveApplySurface() {
        const current = events.readCurrentEventState(workspaceId);
        const currentEventId = current?.currentEvent?.id;
        if (!currentEventId) {
          return Object.freeze({
            kind: 'refused' as const,
            reason: 'no_published_apply_surface' as const
          });
        }
        let gate = applySurfaceGatesByEvent.get(currentEventId);
        if (!gate) {
          gate = createSQLiteIntakePublicApplySurfaceGate({
            sqlite: database.sqlite,
            workspaceId,
            eventId: parseEventId(currentEventId),
            forms: Object.freeze({
              readFormHead: (
                formScope: { readonly workspaceId: string; readonly eventId: string },
                formId: string
              ) => intakeRepository.readFormHead(formScope, formId)
            })
          });
          applySurfaceGatesByEvent.set(currentEventId, gate);
        }
        return gate.resolveApplySurface();
      }
    });
    const intakePublicContinuationBinding = Object.freeze({
      key: 'intake.public-apply',
      version: parseContractVersion(1)
    });
    const intakePublicContinuationStore = new SQLitePublicMutationContinuationTrial(
      database.sqlite,
      Object.freeze({
        clock,
        newAuditEventId: () => parseAuditEventId(crypto.randomUUID()),
        newCompletionReference: newPublicCompletionReference
      })
    );
    const intakePublicBootstrapVerifier = createOffUnlessConfiguredPublicIntakeBootstrapVerifier();
    const intakePublicKeyProfile = (key: string) => Object.freeze({
      reference: Object.freeze({ key, version: parseContractVersion(1) }),
      keyBytes: randomHmacKey()
    });
    const intakePublicCeremonyBoundary = createPublicMutationContinuationBoundary({
      binding: intakePublicContinuationBinding,
      policies: createApplySurfaceGatedContinuationPolicySource({
        gate: applySurfaceGate,
        binding: intakePublicContinuationBinding,
        security: {
          lifetimeMs: 900_000,
          ...INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
          continuationProfiles: [
            intakePublicKeyProfile('key-profile.intake.public-continuation')
          ],
          principalPartitionProfile:
            intakePublicKeyProfile('key-profile.intake.public-partition'),
          bootstrapReplayProfile:
            intakePublicKeyProfile('key-profile.intake.public-bootstrap-replay')
        }
      }),
      bootstrapVerifiers: Object.freeze({
        resolve: (reference: { readonly key: string; readonly version: number }) =>
          reference.key === intakePublicBootstrapVerifier.reference.key
            && reference.version === intakePublicBootstrapVerifier.reference.version
            ? intakePublicBootstrapVerifier
            : undefined
      }),
      store: intakePublicContinuationStore,
      clock,
      newActionAnchorId: () => crypto.randomUUID(),
      newCeremonyEvidenceId: () => parseCeremonyEvidenceId(crypto.randomUUID()),
      newAuditEventId: () => parseAuditEventId(crypto.randomUUID())
    });
    const intakePublicEffectCompletion = new SQLitePublicMutationEffectCompletionPort(
      database.sqlite,
      Object.freeze({
        clock,
        newAuditEventId: () => parseAuditEventId(crypto.randomUUID())
      })
    );
    // The gated directory follows the live pin, so an apply surface release
    // published after process start serves without recomposition.
    const intakePublicCeremonies = createIntakePublicCeremonyGatedDirectory({
      pin: intakePublicApplySurfaceCeremonyPinSource(applySurfaceGate),
      boundary: intakePublicCeremonyBoundary,
      completion: intakePublicEffectCompletion
    });
    const intakePublicParticipantAttribution =
      createSQLiteCeremonyMintedIntakeParticipantAttributionSource(database.sqlite, {
        newPersonId: () => crypto.randomUUID(),
        newParticipantIdentityId: () => crypto.randomUUID()
      });
    const intakePublicInputPolicy = createOffUnlessConfiguredPublicInputPolicyEvaluator({
      issueEvaluationId: () => crypto.randomUUID()
    });
    const intakePublicMutationIds: SQLiteIntakePublicMutationEffectIds = Object.freeze({
      newPreparationHandle: () => crypto.randomUUID(),
      newRevisionId: () => crypto.randomUUID(),
      newPayloadRefId: () => crypto.randomUUID(),
      newSubmissionId: () => crypto.randomUUID(),
      newSubmitEvidenceId: () => crypto.randomUUID(),
      newParticipantEvidenceId: () => crypto.randomUUID(),
      newConsentEvidenceId: () => crypto.randomUUID(),
      newFactId: () => crypto.randomUUID(),
      newPointerId: () => crypto.randomUUID(),
      newTimelineId: () => crypto.randomUUID(),
      newCompletionReference: newPublicCompletionReference
    });
    const intakePublicMutationDomain = createSQLiteIntakePublicMutationEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: intakeRepository,
      projection: intakeClassifiedProjection,
      classifiedStore: intakeClassifiedStore,
      classifiedProfiles: intakeClassifiedProfiles,
      inputPolicy: intakePublicInputPolicy,
      ceremonies: intakePublicCeremonies,
      participantAttribution: intakePublicParticipantAttribution,
      submissionTriage: createSubmissionTriageSubmitInitializer({
        store: submissionTriageRepository,
        ids: Object.freeze({ newArrivalId: () => crypto.randomUUID() })
      }),
      ids: intakePublicMutationIds
    });
    const reviewerAuthoritySource = new SQLiteReviewerAuthoritySource(
      database.sqlite,
      () => clock.now()
    );
    const reviewerScopeTargetSource = createSessionAwareReviewerScopeTargetSource(
      new SQLiteReviewerScopeTargetSource(vocabularyRead),
      sessionRepository
    );
    const reviewerRosterSources = Object.freeze({
      readReviewerAuthority:
        reviewerAuthoritySource.readReviewerAuthority.bind(reviewerAuthoritySource),
      readReviewerScopeTargets:
        reviewerScopeTargetSource.readReviewerScopeTargets.bind(reviewerScopeTargetSource)
    });
    const reviewerRosterRepository = new SQLiteReviewerRosterRepository(
      database.sqlite,
      reviewerRosterSources
    );
    const reviewRepository = new SQLiteReviewRepository(database.sqlite, {
      triage: submissionTriageRepository,
      roster: reviewerRosterSources
    });
    // Decision candidates and review basis are projections over the same
    // effective sources the mounted triage and Review surfaces serve; nothing
    // here reads a second copy of any effective state.
    const decisionEnvironment = createSQLiteDecisionEnvironmentSource({
      candidates: new SQLiteDecisionCandidateSourceAdapter(
        submissionTriageSource,
        createSQLiteIntakeParticipantPersonSource(database.sqlite)
      ),
      reviewBasis: new SQLiteDecisionReviewBasisSourceAdapter(Object.freeze({
        repository: reviewRepository,
        sources: reviewRepository,
        candidateDisplay: reviewRepository
      }))
    });
    const decisionRepository = new SQLiteDecisionRepository({
      sqlite: database.sqlite,
      sessions: sessionRepository,
      environment: decisionEnvironment
    });
    const taskRepository = new SQLiteTaskRepository(database.sqlite);
    const taskDeadlineRepository = new SQLiteDeadlineRepository(database.sqlite, events);
    // Live decision-set audience source over the same decision heads and
    // classified intake contacts the mounted Decision and Submissions
    // surfaces serve; identity is personId-bearing evidence, never email.
    const decisionAudienceSource = createSQLiteDecisionAudienceSource({
      sqlite: database.sqlite,
      contacts: intakeRepository,
      submissions: submissionTriageSource,
      addressFingerprintKeyBytes: randomHmacKey()
    });
    const taskReminderAudienceSource = createSQLiteTaskReminderAudienceSource({
      sqlite: database.sqlite,
      tasks: taskRepository,
      engagements: new SQLiteEngagementRepository(database.sqlite),
      submissions: submissionTriageSource,
      submissionAddresses: decisionAudienceSource
    });
    const organizerCommunicationPreview = new SQLiteOrganizerAudiencePreviewRepository(
      database.sqlite,
      organizerCommunicationClassifiedStore,
      Object.freeze({
        drafts: createOrganizerPreviewDraftBindingSource({
          authoring: organizerCommunicationAuthoring,
          plainTextRenderer: communicationDefinitionRef(
            'renderer.communication.plain-text',
            Object.freeze({ kind: 'plain_text', version: 1 })
          ),
          plainTextMergeRegistry: organizerPlainTextMergeRegistry.identity
        }),
        opaqueTokens: createHmacOrganizerPreviewOpaqueTokenCodec({
          keyBytes: randomHmacKey(),
          profile: Object.freeze({ key: 'communication.preview.opaque-token', version: 1 })
        }),
        render: createOrganizerPlainTextRenderStrategyPort({
          mergeRegistry: organizerPlainTextMergeRegistry,
          content: createSQLiteDraftRenderContentSource({
            sqlite: database.sqlite,
            authoring: organizerCommunicationAuthoring
          }),
          values: Object.freeze({
            resolveMergeValues(value: Parameters<OrganizerMergeValueSource['resolveMergeValues']>[0]) {
              return value.candidate.contactRefId.startsWith('task-engagement:')
                ? taskReminderAudienceSource.resolveMergeValues(value)
                : decisionAudienceSource.resolveMergeValues(value);
            }
          })
        }),
        digestProfile: Object.freeze({ key: 'communication.preview.sha256', version: 1 }),
        audienceCursorKeyBytes: randomHmacKey(),
        registeredSources: [
          ...decisionAudienceDelegates(decisionAudienceSource),
          taskReminderAudienceSource
        ]
      })
    );
    /**
     * Recorder defaults BLOCKED-4/BLOCKED-5/BLOCKED-12: installs the one
     * transactional decision-notification purpose with its two templates and
     * mints the two immutable decision-set audience recipes for one event
     * scope. Runs inside the caller's transaction; identities are
     * deterministic per scope, so a re-run converges.
     */
    const seedCommunicationsForEvent = (rawScope: {
      readonly workspaceId: string;
      readonly eventId: string;
    }): void => {
      const scope = Object.freeze({
        workspaceId: parseWorkspaceId(rawScope.workspaceId),
        eventId: parseEventId(rawScope.eventId)
      });
      const seeded = seedDecisionNotificationCommunications({
        sqlite: database.sqlite,
        authoring: organizerCommunicationAuthoring,
        scope,
        mergeRegistry: organizerPlainTextMergeRegistry.identity,
        renderer: communicationDefinitionRef(
          'renderer.communication.plain-text',
          Object.freeze({ kind: 'plain_text', version: 1 })
        ),
        now: clock.now()
      });
      mintDecisionAudienceRecipes({
        repository: organizerCommunicationPreview,
        scope,
        purposeRevision: seeded.purposeRevision
      });
      seedTaskReminderPurpose({ sqlite: database.sqlite, scope });
    };
    const communicationMessageReleases = new SQLiteCommunicationMessageReleaseStore(
      database.sqlite,
      organizerCommunicationClassifiedStore,
      Object.freeze({ newEnvelopePayloadRefId: () => crypto.randomUUID() })
    );
    const outboundEmailDeliveryLedger = new SQLiteOutboundEmailDeliveryLedger(
      database.sqlite,
      Object.freeze({
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID(),
        newHistoryId: () => crypto.randomUUID()
      })
    );
    const outboundDispatch = createOutboundDispatchLoop({
      sqlite: database.sqlite,
      ledger: outboundEmailDeliveryLedger,
      // The one composed dispatch adapter: the activated registration's real
      // delivery adapter, or the deterministic fake in the inert posture.
      provider: providerRuntime.registration?.delivery ?? fakeEmailProvider.delivery,
      envelopes: createSQLiteOutboundEmailEnvelopeResolver(communicationMessageReleases),
      ids: Object.freeze({
        newAttemptId: () => crypto.randomUUID(),
        newClaimId: () => crypto.randomUUID()
      }),
      clock: Object.freeze({ now: () => new Date().toISOString() })
    });
    const communications = createCommunicationSendLane({
      sqlite: database.sqlite,
      workspaceId,
      currentEventId: () => {
        const current = events.readCurrentEventState(workspaceId);
        if (!current?.currentEvent) throw new TypeError('communication_send_event_missing');
        return current.currentEvent.id;
      },
      previewRepository: organizerCommunicationPreview,
      classifiedStore: organizerCommunicationClassifiedStore,
      releases: communicationMessageReleases,
      clock,
      ...(communicationDeliveryRoute === undefined
        ? {}
        : { deliveryRoute: communicationDeliveryRoute })
    });
    /**
     * Operator HTTP mounting of the send lane (J-WEB-2/P8): the adoption
     * preparer runs the asynchronous audience resolution before the unit of
     * work, and the two effect-domain adapters run the sealed synchronous
     * steps inside it over the same composed repository, classified store,
     * and release store instances. After a send commit lands durably, one
     * dispatch pass runs — with only the deterministic fake composed, every
     * delivery still resolves terminally not-delivered (BLOCKED-2).
     */
    // With a real provider activated, the outbox is pumped continuously so
    // time-sensitive security mail (portal and workspace sign-in links) leaves
    // promptly — those lanes register deliveries outside any send commit, so
    // the after-commit pass alone would strand them as pending forever. The
    // inert fake composition deliberately gets no pump: joined tests keep
    // deterministic dispatch timing.
    let outboundDispatchPump: ReturnType<typeof setInterval> | undefined;
    if (providerRuntime.registration?.delivery) {
      let pumping = false;
      outboundDispatchPump = setInterval(() => {
        if (pumping) return;
        pumping = true;
        void outboundDispatch.runOnce()
          .then(() => {
            /* Per-delivery faults no longer abort the pass, so they surface
               here instead — one bad row must be visible without silencing
               every delivery queued behind it. */
            for (const fault of outboundDispatch.faults()) {
              console.error(
                `[jooevents] outbound delivery ${fault.deliveryId} failed`,
                fault.error
              );
            }
          })
          .catch((error) => {
            console.error('[jooevents] outbound dispatch pass failed', error);
          })
          .finally(() => { pumping = false; });
      }, 2000);
    }
    const communicationSendRuntime = createCommunicationSendOperationRuntime({
      sqlite: database.sqlite,
      workspaceId,
      previewRepository: organizerCommunicationPreview,
      classifiedStore: organizerCommunicationClassifiedStore,
      releases: communicationMessageReleases,
      clock,
      dispatchAfterCommit: async () => {
        await outboundDispatch.runOnce();
      },
      ...(communicationDeliveryRoute === undefined
        ? {}
        : { deliveryRoute: communicationDeliveryRoute })
    });
    const submissionTriageDirectDomain =
      createSQLiteSubmissionTriageDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        repository: submissionTriageRepository,
        eventRelationships
      });
    const intakeDirectEntryDirectDomain =
      createSQLiteIntakeDirectEntryEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        repository: intakeRepository,
        projection: intakeClassifiedProjection,
        submissionTriage: createSubmissionTriageSubmitInitializer({
          store: submissionTriageRepository,
          ids: Object.freeze({ newArrivalId: () => crypto.randomUUID() })
        }),
        classifiedStore: intakeClassifiedStore,
        classifiedProfiles: intakeClassifiedProfiles,
        eventRelationships,
        ids: Object.freeze({
          newPayloadRefId: () => crypto.randomUUID(),
          newSubmissionId: () => crypto.randomUUID(),
          newEntryEvidenceId: () => crypto.randomUUID(),
          newPersonId: () => crypto.randomUUID(),
          newParticipantIdentityId: () => crypto.randomUUID(),
          newParticipantEvidenceId: () => crypto.randomUUID()
        })
      });
    const schedulePlacementDirectDomain =
      createSQLiteSchedulePlacementDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        sessions: placeableSessions,
        vocabulary: vocabularyRead,
        eventRelationships,
        newOccurrenceId: () => crypto.randomUUID()
      });
    const sessionDirectDomain = createSQLiteSessionDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: sessionRepository,
      eventRelationships,
      newSessionId: () => crypto.randomUUID()
    });
    const decisionDirectDomain = createSQLiteDecisionDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: decisionRepository,
      eventRelationships,
      newSessionId: () => crypto.randomUUID()
    });
    const engagementDirectDomain = createSQLiteEngagementDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships
    });
    const taskDirectDomain = createSQLiteTaskDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      ids: Object.freeze({
        newTaskDefinitionId: () => crypto.randomUUID(),
        newTaskDefinitionRevisionId: () => crypto.randomUUID(),
        newDeadlineId: () => crypto.randomUUID()
      })
    });
    const createdEventInitializer = (() => {
      const fieldRegistry = createSQLiteFieldRegistryEventInitializer({
        sqlite: database.sqlite,
        ids: Object.freeze({
          newFieldId: () => crypto.randomUUID(),
          newChoiceId: () => crypto.randomUUID()
        })
      });
      const settings = createSQLiteEventSettingsInitializer({ sqlite: database.sqlite });
      const spineHeadRead = database.sqlite.query<
        {
          readonly name: string;
          readonly created_by_user_id: string;
          readonly created_at_ms: number;
        },
        [string, string]
      >(`
        SELECT name, created_by_user_id, created_at_ms FROM event_spine_heads
         WHERE workspace_id = ? AND id = ?
      `);
      const identityEventInsert = database.sqlite.query<
        never,
        [string, string, string, number, number]
      >(`
        INSERT INTO events (id, workspace_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      return Object.freeze({
        initializeCreatedEvent(scope: Parameters<
          typeof fieldRegistry.initializeCreatedEvent
        >[0]) {
          const head = spineHeadRead.get(scope.workspaceId, scope.eventId);
          if (!head) throw new TypeError('event_identity_projection_head_missing');
          identityEventInsert.run(
            scope.eventId,
            scope.workspaceId,
            head.name,
            head.created_at_ms,
            head.created_at_ms
          );
          fieldRegistry.initializeCreatedEvent(scope);
          seedCommunicationsForEvent(scope);
          templateAuthoringRepository.initializeCreatedEvent({
            scope,
            createdByUserId: head.created_by_user_id,
            createdAt: new Date(head.created_at_ms).toISOString(),
            artifacts: starterTemplateArtifacts({ scope, eventName: head.name })
          });
          return settings.initializeCreatedEventSettings(scope);
        }
      });
    })();
    const eventDirectDomain = createSQLiteEventEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      ids: Object.freeze({ newEventId: () => crypto.randomUUID() }),
      createdEventInitializer
    });
    const engagementReadRepository = new SQLiteEngagementRepository(database.sqlite);
    // The governed name-declassification source: personId → the person's own
    // participant evidence → the least-disclosure triage source row's
    // `summary.primaryParticipantName` (the decision-audience precedent) —
    // never the raw classified store.
    const releaseParticipantNames: SQLiteReleaseParticipantNameSource = Object.freeze({
      readParticipantDisplayName(
        scope: { readonly workspaceId: string; readonly eventId: string },
        personId: string
      ) {
        const evidence = database.sqlite.query<{ readonly submission_id: string }, [
          string, string, string
        ]>(`
          SELECT submission_id FROM intake_submission_participant_evidence
           WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           ORDER BY submission_id LIMIT 1
        `).get(scope.workspaceId, scope.eventId, personId);
        if (!evidence) return undefined;
        const row = submissionTriageSource.readSourceRow(
          { workspaceId: scope.workspaceId, eventId: scope.eventId },
          evidence.submission_id
        );
        return row?.summary.primaryParticipantName ?? undefined;
      }
    });
    const releaseSources: SQLiteReleaseUpstreamSources = Object.freeze({
      sessions: sessionRepository,
      schedule: schedulePlacementDirectDomain.scheduleRead,
      engagements: engagementReadRepository,
      vocabulary: vocabularyRead,
      eventSettings: eventSettingsRepository,
      names: releaseParticipantNames,
      forms: createSQLiteIntakeFormVersionPinSource(database.sqlite),
      templates: Object.freeze({
        readPinnedArtifact(scope: ReleaseScopeDto, pin: ReleaseTemplateRevisionPinDto) {
          const snapshot = templateAuthoringRepository.readArtifact(scope, pin.artifactId);
          if (!snapshot
              || snapshot.head.currentRevisionId !== pin.revisionId
              || snapshot.head.currentRevisionNumber !== pin.revisionNumber
              || snapshot.current.digestSha256 !== pin.digestSha256) return undefined;
          return snapshot.current.document;
        }
      })
    });
    const releaseRepository = new SQLiteReleaseRepository(database.sqlite, releaseSources);
    const releaseNativeDomains = createSQLiteReleaseNativeEffectDomainRegistrations({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      sources: releaseSources,
      ids: Object.freeze({
        newDraftId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newReleaseId: () => crypto.randomUUID()
      })
    });
    const authority = createSQLiteOperatorAuthorityComposition({
      sqlite: database.sqlite,
      workspaceId,
      policies: Object.freeze([
        Object.freeze({ policy: EVENT_READ_ACCESS_POLICY, permissionId: 'event.read' as const }),
        Object.freeze({
          policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
          permissionId: 'communication.draft' as const
        }),
        Object.freeze({
          policy: SEND_MESSAGES_DRAFT_ACCESS_POLICY,
          permissionId: 'communication.send' as const
        }),
        Object.freeze({
          policy: COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
          permissionId: 'communication.provider.manage' as const
        }),
        // `WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY` is this same catalog entry
        // by key and version: the workspace sender identity IS a sender
        // profile, so it rides the provider-management permission rather than
        // splitting one responsibility across two grants.
        Object.freeze({
          policy: organizerCommunicationExactContactPolicy,
          permissionId: 'speaker.contact.read' as const
        }),
        Object.freeze({ policy: EVENT_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' as const }),
        Object.freeze({
          policy: DEADLINE_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: DEADLINE_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: TASK_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: FIELD_REGISTRY_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
          permissionId: 'program.vocabulary.manage' as const
        }),
        Object.freeze({
          policy: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
          permissionId: 'schedule.read' as const
        }),
        Object.freeze({
          policy: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
          permissionId: 'schedule.manage' as const
        }),
        Object.freeze({
          policy: SESSION_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: SESSION_MANAGE_ACCESS_POLICY,
          permissionId: 'schedule.manage' as const
        }),
        Object.freeze({
          policy: INTAKE_EVENT_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: INTAKE_SUBMISSION_READ_ACCESS_POLICY,
          permissionId: 'submission.read' as const
        }),
        Object.freeze({
          policy: SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: REVIEW_SNAPSHOT_ACCESS_POLICY,
          permission: Object.freeze({
            kind: 'all_of' as const,
            permissionIds: ['event.read', 'submission.read'] as const
          })
        }),
        Object.freeze({
          policy: REVIEW_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: REVIEW_STEP_BACK_ACCESS_POLICY,
          permissionId: 'submission.score' as const
        }),
        Object.freeze({
          policy: REVIEW_EVALUATE_ACCESS_POLICY,
          permission: Object.freeze({
            kind: 'all_of' as const,
            permissionIds: ['submission.comment', 'submission.score'] as const
          })
        }),
        Object.freeze({
          policy: REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: DECISION_READ_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: DECISION_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: ENGAGEMENT_READ_ACCESS_POLICY,
          permissionId: 'speaker.directory.read' as const
        }),
        Object.freeze({
          policy: ENGAGEMENT_MANAGE_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: RELEASE_DRAFT_ACCESS_POLICY,
          permissionId: 'publication.manage' as const
        }),
        Object.freeze({
          policy: FILE_READ_ACCESS_POLICY,
          permissionId: FILE_READ_PERMISSION_ID
        }),
        Object.freeze({
          policy: FILE_MCP_READ_ACCESS_POLICY,
          permissionId: FILE_READ_PERMISSION_ID
        }),
        Object.freeze({
          policy: FILES_COMMAND_ACCESS_POLICY,
          permissionId: FILE_MANAGE_PERMISSION_ID
        }),
        Object.freeze({
          policy: WORKSPACE_TEAM_OPERATION_ACCESS.read.policy,
          permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.read.permissionId
        }),
        Object.freeze({
          policy: WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy,
          permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.invite.permissionId
        }),
        Object.freeze({
          policy: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy,
          permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.permissionId
        }),
        Object.freeze({
          policy: WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy,
          permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.remove.permissionId
        }),
        Object.freeze({
          policy: INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
          permission: Object.freeze({
            kind: 'all_of' as const,
            permissionIds: ['speaker.contact.read', 'submission.read'] as const
          })
        })
      ]),
      clock,
      eventRelationships
    });
    const requestHashSealer = createHmacRequestHashSealer({
      profile: EVENT_CREATE_REQUEST_HASH_PROFILE,
      keyBytes: randomHmacKey()
    });
    const idempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: eventProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const eventOperations = createEventOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: EVENT_READ_ACCESS_POLICY,
        manage: EVENT_MANAGE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEventRead: Object.freeze({
        readCurrent(requestedWorkspaceId: typeof workspaceId) {
          if (requestedWorkspaceId !== workspaceId) {
            throw new TypeError('event_read_workspace_mismatch');
          }
          const current = events.readCurrentEventProjection(workspaceId);
          if (!current) throw new TypeError('event_workspace_set_missing');
          return current;
        }
      }),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization,
      requestHashSealer,
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer,
      mountLegacyDirectCreate: true
    });
    const eventSettingsReadOperations = createEventSettingsReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentSettingsRead: Object.freeze({
        readCurrent(requestedWorkspaceId: typeof workspaceId) {
          if (requestedWorkspaceId !== workspaceId) {
            throw new TypeError('event_settings_read_workspace_mismatch');
          }
          return eventSettingsRepository.readCurrentEventSettings(requestedWorkspaceId);
        }
      }),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization
    });
    const eventSettingsUpdateOperations = createEventSettingsUpdateOperationModule({
      workspaceId,
      managePolicy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer
    });
    const workspaceOverviewOperations = createWorkspaceOverviewOperationModule({
      workspaceId,
      policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      overviewRead: createSQLiteWorkspaceOverviewProjection({
        sqlite: database.sqlite,
        areaCatalog: DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG
      }),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization
    });
    const currentEvent = Object.freeze({
      resolveCurrentEvent(requestedWorkspaceId: typeof workspaceId) {
        if (requestedWorkspaceId !== workspaceId) {
          throw new TypeError('program_vocabulary_workspace_mismatch');
        }
        const current = events.readCurrentEventState(workspaceId);
        if (!current) throw new TypeError('event_workspace_set_missing');
        const evidenceIds = [
          `event-spine-set:${current.eventSet.workspaceId}@${current.eventSet.version}`,
          ...(current.currentEvent
            ? [`event-spine-root:${current.currentEvent.id}@${current.currentEvent.version}`]
            : [])
        ];
        return Object.freeze({
          ...(current.currentEvent ? { eventId: current.currentEvent.id } : {}),
          evidenceIds: Object.freeze(evidenceIds)
        });
      }
    });
    const operationHistoryOperations = createOperationHistoryReadOperationModule({
      workspaceId,
      policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      read: createSQLiteOperationHistoryReader(database.sqlite),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
        scopePartitionProfile: eventProfiles.scopePartition,
        requestCanonicalizationProfile: eventProfiles.requestCanonicalization
      })
    });
    const templateArtifactReadOperations = createTemplateArtifactReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentRead: Object.freeze({
        listCurrent(requestedWorkspaceId: typeof workspaceId) {
          const selected = currentEvent.resolveCurrentEvent(requestedWorkspaceId);
          return selected.eventId === undefined
            ? undefined
            : templateAuthoringRepository.listArtifacts({
                workspaceId: requestedWorkspaceId,
                eventId: selected.eventId
              });
        }
      }),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: templateArtifactProfiles.authorityPrincipal,
      scopePartitionProfile: templateArtifactProfiles.scopePartition,
      requestCanonicalizationProfile: templateArtifactProfiles.requestCanonicalization
    });
    const templateArtifactNativeOperations = createTemplateArtifactNativeOperationModule({
      workspaceId,
      policy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: templateArtifactProfiles.authorityPrincipal,
      scopePartitionProfile: templateArtifactProfiles.scopePartition,
      requestCanonicalizationProfile: templateArtifactProfiles.requestCanonicalization,
      draftRequestHashSealer: createHmacRequestHashSealer({
        profile: TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      publishRequestHashSealer: createHmacRequestHashSealer({
        profile: TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: templateArtifactProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: templateArtifactProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const templateEditOperations = createTemplateEditOperationModule({
      workspaceId,
      policies: { read: EVENT_READ_ACCESS_POLICY, manage: EVENT_MANAGE_ACCESS_POLICY },
      currentAuthority: authority.resolver,
      choices: () => templateEditService.choices(),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: templateArtifactProfiles.authorityPrincipal,
      scopePartitionProfile: templateArtifactProfiles.scopePartition,
      requestCanonicalizationProfile: templateArtifactProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: TEMPLATE_EDIT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: templateArtifactProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: templateArtifactProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const organizerCommunicationCurrentEvent = Object.freeze({
      resolveCurrentEvent(requestedWorkspaceId: typeof workspaceId) {
        const selected = currentEvent.resolveCurrentEvent(requestedWorkspaceId);
        return selected.eventId === undefined
          ? undefined
          : Object.freeze({
              eventId: selected.eventId,
              evidenceIds: selected.evidenceIds
            });
      }
    });
    const organizerCommunicationPreviewAuthority: CurrentAuthorityResolver<InvocationEvidence> =
      Object.freeze({
        async resolve(
          resolutionInput: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]
        ) {
          const required = await authority.resolver.resolve(resolutionInput);
          if (required.kind !== 'authorized') return required;
          const optional = await authority.resolver.resolve({
            ...resolutionInput,
            lane: Object.freeze({
              ...resolutionInput.lane,
              policy: organizerCommunicationExactContactPolicy
            })
          });
          if (optional.kind !== 'authorized') return required;
          if (
            canonicalJsonText(optional.authority.actor) !== canonicalJsonText(required.authority.actor)
            || canonicalJsonText(optional.authority.principal)
              !== canonicalJsonText(required.authority.principal)
            || canonicalJsonText(optional.authority.scope) !== canonicalJsonText(required.authority.scope)
          ) {
            throw new TypeError('communication_optional_contact_authority_mismatch');
          }
          return Object.freeze({
            kind: 'authorized' as const,
            authority: Object.freeze({
              ...required.authority,
              grants: Object.freeze([
                ...required.authority.grants,
                ...optional.authority.grants.filter((grant) =>
                  !required.authority.grants.some((candidate) =>
                    candidate.kind === grant.kind && candidate.key === grant.key
                  )
                )
              ]),
              evidenceIds: Object.freeze([
                ...new Set([
                  ...required.authority.evidenceIds,
                  ...optional.authority.evidenceIds
                ])
              ].sort()),
              authorityCitationIds: Object.freeze([
                ...new Set([
                  ...required.authority.authorityCitationIds,
                  ...optional.authority.authorityCitationIds
                ])
              ].sort())
            })
          });
        }
      });
    const organizerCommunicationCrypto = Object.freeze({
      authorityPrincipalKeyProfile: organizerCommunicationProfiles.authorityPrincipal,
      scopePartitionProfile: organizerCommunicationProfiles.scopePartition,
      requestCanonicalizationProfile: organizerCommunicationProfiles.requestCanonicalization,
      requestHashSealer: createOrganizerCommunicationRequestHashSealer(randomHmacKey()),
      idempotencyCredentialProfile: organizerCommunicationProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: organizerCommunicationProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const organizerCommunicationReadOperations = createOrganizerCommunicationReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent: organizerCommunicationCurrentEvent,
      read: organizerCommunicationAuthoring,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: organizerCommunicationCrypto
    });
    const organizerCommunicationMutationOperations =
      createOrganizerCommunicationMutationOperationModule({
        workspaceId,
        policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
        currentAuthority: authority.resolver,
        currentEvent: organizerCommunicationCurrentEvent,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: organizerCommunicationCrypto
      });
    const organizerCommunicationAuthoringOperations =
      composeOrganizerCommunicationAuthoringOperationModules({
        read: organizerCommunicationReadOperations,
        mutation: organizerCommunicationMutationOperations
      });
    const organizerCommunicationAudiencePreviewOperations =
      createOrganizerAudiencePreviewReadOperationModule({
        workspaceId,
        policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
        currentAuthority: organizerCommunicationPreviewAuthority,
        currentEvent: organizerCommunicationCurrentEvent,
        read: organizerCommunicationPreview,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: organizerCommunicationCrypto
      });
    const communicationProviderReadOperations =
      createCommunicationProviderReadOperationModule({
        workspaceId,
        policy: COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
        currentAuthority: authority.resolver,
        configuration: emailProviderConfiguration,
        readiness: emailProviderReadiness,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: communicationProviderReadProfiles
      });
    const communicationSendOperations = createCommunicationSendOperationModule({
      workspaceId,
      draftPolicy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      sendPolicy: SEND_MESSAGES_DRAFT_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent: organizerCommunicationCurrentEvent,
      adoptionPreparer: communicationSendRuntime.adoptionPreparer,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        ...organizerCommunicationCrypto,
        // The shared communication sealer allowlists per-operation profile
        // keys; the send-lane effects hash under their own operation names.
        requestHashSealer: createOrganizerCommunicationRequestHashSealer(
          randomHmacKey(),
          Object.values(COMMUNICATION_SEND_LANE_OPERATIONS)
        )
      })
    });
    const communicationDeliveryHistoryOperations =
      createCommunicationDeliveryHistoryReadOperationModule({
        workspaceId,
        policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
        currentAuthority: authority.resolver,
        currentEvent: organizerCommunicationCurrentEvent,
        read: createSQLiteCommunicationDeliveryHistorySource({ sqlite: database.sqlite }),
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: organizerCommunicationCrypto
      });
    const outboundDispatchJobIdentity = Object.freeze({
      jobId: parseJobId(crypto.randomUUID()),
      capabilityRevisionId: parseCapabilityRevisionId(crypto.randomUUID()),
      authorityCitationId: parseAuthorityCitationId(crypto.randomUUID())
    });
    const outboundDispatchLane = parseOperationAccessLane({
      kind: 'registered_job',
      surface: 'application_job',
      policy: OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY
    });
    /**
     * Dormant registered-job authority for `dispatch_message_release`. The
     * operation compiles only an internal `application_job` binding (no
     * operator/public surface), and this runtime hosts no job scheduler, so
     * the resolver exists to pin the lane to this process's minted dispatch
     * job identity; the operator policy catalog deliberately does not map the
     * job-lane policy to any operator permission.
     */
    const outboundDispatchJobAuthority: CurrentAuthorityResolver<InvocationEvidence> =
      Object.freeze({
        resolve: (resolution: Parameters<
          CurrentAuthorityResolver<InvocationEvidence>['resolve']
        >[0]) => Object.freeze({
          kind: 'authorized' as const,
          authority: Object.freeze({
            actor: Object.freeze({
              kind: 'system_job' as const,
              jobId: outboundDispatchJobIdentity.jobId,
              registeredCapabilityRevisionId: outboundDispatchJobIdentity.capabilityRevisionId
            }),
            principal: Object.freeze({
              kind: 'registered_job' as const,
              jobId: outboundDispatchJobIdentity.jobId,
              capabilityRevisionId: outboundDispatchJobIdentity.capabilityRevisionId,
              authorityCitationId: outboundDispatchJobIdentity.authorityCitationId
            }),
            lane: outboundDispatchLane,
            scope: resolution.scope,
            grants: Object.freeze([Object.freeze({
              kind: 'registered_capability' as const,
              key: outboundDispatchJobIdentity.capabilityRevisionId
            })]),
            evidenceIds: Object.freeze([`job-current:${outboundDispatchJobIdentity.jobId}`]),
            authorityCitationIds: Object.freeze([outboundDispatchJobIdentity.authorityCitationId]),
            evaluatedAt: resolution.evaluatedAt
          })
        })
      });
    const outboundEmailDispatchOperations = createOutboundEmailDeliveryOperationModule({
      policy: OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY,
      scopeResolver: Object.freeze({
        resolve: () => {
          const current = events.readCurrentEventState(workspaceId);
          if (!current?.currentEvent) throw new TypeError('outbound_dispatch_event_missing');
          return Object.freeze({
            workspaceId,
            eventId: current.currentEvent.id,
            subjects: Object.freeze([
              Object.freeze({ kind: 'workspace' as const, id: workspaceId }),
              Object.freeze({ kind: 'event' as const, id: current.currentEvent.id })
            ]),
            resolutionEvidenceIds: Object.freeze([
              `event-spine-root:${current.currentEvent.id}@${current.currentEvent.version}`
            ])
          });
        }
      }),
      currentAuthority: outboundDispatchJobAuthority,
      registeredJob: Object.freeze({
        job: Object.freeze({ key: 'communication.message-dispatch', version: 1 }),
        inputProjection: Object.freeze({
          key: 'communication.message-dispatch.input',
          version: 1
        }),
        capabilityRevisionId: outboundDispatchJobIdentity.capabilityRevisionId,
        authorityCitation: Object.freeze({
          key: 'communication.message-dispatch.authority',
          version: 1
        })
      }),
      clock,
      newInvocationId: () => parseInvocationId(crypto.randomUUID()),
      authorityPrincipalKeyProfile: outboundDispatchProfiles.authorityPrincipal,
      scopePartitionProfile: outboundDispatchProfiles.scopePartition,
      requestCanonicalizationProfile: outboundDispatchProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: OUTBOUND_DISPATCH_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: outboundDispatchProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: outboundDispatchProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const deadlineOperations = createDeadlineOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: DEADLINE_READ_ACCESS_POLICY,
        manage: DEADLINE_MANAGE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      deadlineRead: deadlineDirectDomain.deadlineRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: deadlineProfiles.authorityPrincipal,
      scopePartitionProfile: deadlineProfiles.scopePartition,
      requestCanonicalizationProfile: deadlineProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: deadlineProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: deadlineProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    // Public intake surface: `public_open` evidence is honored only against a
    // FRESH gate resolution — the served policy revision IS the active apply
    // surface release id — and `public_ceremony` evidence resolves through
    // the gated ceremony directory's own current-authority recheck.
    const intakePublicReadCrypto = Object.freeze({
      authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
      scopePartitionProfile: intakeProfiles.scopePartition,
      requestCanonicalizationProfile: intakeProfiles.requestCanonicalization
    });
    const intakePublicAuthority = Object.freeze({
      resolve(input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
        if (input.evidence.kind === 'public_ceremony') {
          return intakePublicCeremonies.currentAuthority.resolve(input);
        }
        if (input.evidence.kind !== 'public_open') {
          return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
        }
        const resolution = applySurfaceGate.resolveApplySurface();
        if (resolution.kind !== 'pinned'
            || input.lane.kind !== 'public_open'
            || input.lane.surface !== 'public_http'
            || input.lane.policy.key !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.key
            || input.lane.policy.version !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.version
            || input.operation.name !== INTAKE_PUBLIC_FORM_READ_OPERATION.name
            || input.operation.version !== INTAKE_PUBLIC_FORM_READ_OPERATION.version
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
              key: INTAKE_PUBLIC_FORM_READ_OPERATION.name
            }]),
            evidenceIds: resolution.pin.evidenceIds,
            authorityCitationIds: Object.freeze([]),
            evaluatedAt: input.evaluatedAt
          })
        });
      }
    } satisfies CurrentAuthorityResolver<InvocationEvidence>);
    const intakePublicReadOperations = createIntakePublicConformanceReadOperationModule({
      policies: Object.freeze({
        publicOpen: INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
        publicCeremony: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY
      }),
      currentAuthority: intakePublicAuthority,
      publicFormScope: createApplySurfaceGatedPublicFormScopeSource({ gate: applySurfaceGate }),
      ceremonyScope: intakePublicCeremonies,
      read: Object.freeze({
        readServedForm: intakeRepository.readServedForm.bind(intakeRepository),
        readPublicDraftResume(scope, binding) {
          const data = intakeRepository.readPublicDraftResume(scope, binding);
          return data ? Object.freeze({ binding, data }) : undefined;
        }
      } satisfies Parameters<typeof createIntakePublicConformanceReadOperationModule>[0]['read']),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: intakePublicReadCrypto
    });
    const publicEffectBoundary = createPublicEffectConformanceBoundary();
    const intakePublicMutationOperations = createIntakePublicConformanceMutationOperationModule({
      policy: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
      currentAuthority: intakePublicCeremonies.currentAuthority,
      ceremonyScope: intakePublicCeremonies,
      publicEffectConformance: publicEffectBoundary,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        ...intakePublicReadCrypto,
        requestHashSealer: createHmacRequestHashSealer({
          profile: INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
          keyBytes: randomHmacKey()
        }),
        idempotencyCredentialProfile: intakeProfiles.idempotencyCredential,
        idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
          profile: intakeProfiles.idempotencyCredential,
          keyBytes: randomHmacKey()
        })
      })
    });
    const releaseNativeOperations = createReleaseNativeOperationModule({
      workspaceId,
      policy: RELEASE_DRAFT_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: releaseProfiles.authorityPrincipal,
      scopePartitionProfile: releaseProfiles.scopePartition,
      requestCanonicalizationProfile: releaseProfiles.requestCanonicalization,
      draftRequestHashSealer: createHmacRequestHashSealer({
        profile: RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      publishRequestHashSealer: createHmacRequestHashSealer({
        profile: RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: releaseProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: releaseProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const releaseOverviewOperations = createReleaseOverviewOperationModule({
      workspaceId,
      readPolicy: RELEASE_DRAFT_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      read: releaseRepository,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: releaseProfiles.authorityPrincipal,
      scopePartitionProfile: releaseProfiles.scopePartition,
      requestCanonicalizationProfile: releaseProfiles.requestCanonicalization
    });
    // Read-only public surfaces follow the newest published release, so the
    // per-process policy revision gates admission only (the G0 model card's
    // Model-3 read-only arm); the module stays revision-source-agnostic.
    const releasePublicPolicyRevisionId = parsePublicPolicyRevisionId(crypto.randomUUID());
    const releasePublicOperations = new Set([
      `${RELEASE_PUBLIC_SCHEDULE_READ_OPERATION.name}@${RELEASE_PUBLIC_SCHEDULE_READ_OPERATION.version}`,
      `${RELEASE_PUBLIC_ROSTER_READ_OPERATION.name}@${RELEASE_PUBLIC_ROSTER_READ_OPERATION.version}`,
      `${RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION.name}@${RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION.version}`,
      `${RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION.name}@${RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION.version}`,
      `${RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION.name}@${RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION.version}`
    ]);
    const releasePublicAuthority = Object.freeze({
      resolve(input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
        if (input.evidence.kind !== 'public_open'
            || input.evidence.publicPolicyRevisionId !== releasePublicPolicyRevisionId
            || input.lane.kind !== 'public_open'
            || input.lane.surface !== 'public_http'
            || input.lane.policy.key !== RELEASE_PUBLIC_OPEN_ACCESS_POLICY.key
            || input.lane.policy.version !== RELEASE_PUBLIC_OPEN_ACCESS_POLICY.version
            || !releasePublicOperations.has(
              `${input.operation.name}@${input.operation.version}`
            )) {
          return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
        }
        return Object.freeze({
          kind: 'authorized' as const,
          authority: Object.freeze({
            actor: Object.freeze({
              kind: 'public_request' as const,
              publicPolicyRevisionId: releasePublicPolicyRevisionId,
              authority: Object.freeze({ kind: 'open_policy' as const })
            }),
            principal: Object.freeze({
              kind: 'public_capability' as const,
              publicPolicyRevisionId: releasePublicPolicyRevisionId,
              authority: Object.freeze({ kind: 'open_policy' as const })
            }),
            lane: input.lane,
            scope: input.scope,
            grants: Object.freeze([{
              kind: 'public_policy' as const,
              key: input.operation.name
            }]),
            evidenceIds: Object.freeze(['release-public-read.current']),
            authorityCitationIds: Object.freeze([]),
            evaluatedAt: input.evaluatedAt
          })
        });
      }
    } satisfies CurrentAuthorityResolver<InvocationEvidence>);
    const releasePublicReadOperations = createReleasePublicReadOperationModule({
      policy: RELEASE_PUBLIC_OPEN_ACCESS_POLICY,
      currentAuthority: releasePublicAuthority,
      publicScope: Object.freeze({
        resolve(input: { readonly publicPolicyRevisionId: ReturnType<typeof parsePublicPolicyRevisionId> }) {
          // Match the intake public-read posture: an unaddressable surface
          // (stale policy revision or no current event) refuses as an
          // invalid request, never as an internal fault.
          if (input.publicPolicyRevisionId !== releasePublicPolicyRevisionId) {
            throw new OperationInputError();
          }
          const current = currentEvent.resolveCurrentEvent(workspaceId);
          if (!current.eventId) throw new OperationInputError();
          return Object.freeze({
            workspaceId,
            eventId: current.eventId,
            evidenceIds: Object.freeze([
              ...current.evidenceIds,
              `release-public-policy:${releasePublicPolicyRevisionId}`
            ])
          });
        }
      }),
      read: Object.freeze({
        readServedSchedule: releaseRepository.readServedSchedule.bind(releaseRepository),
        readServedRoster: releaseRepository.readServedRoster.bind(releaseRepository),
        readServedPresentation: releaseRepository.readServedPresentation.bind(releaseRepository)
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: releaseProfiles.authorityPrincipal,
        scopePartitionProfile: releaseProfiles.scopePartition,
        requestCanonicalizationProfile: releaseProfiles.requestCanonicalization
      })
    });
    const programVocabularyIdempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: programVocabularyProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const programVocabularyOperations = createProgramVocabularyReadOperationModule({
      workspaceId,
      readPolicy: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      vocabularyRead,
      referenceRegistry,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: programVocabularyProfiles.authorityPrincipal,
      scopePartitionProfile: programVocabularyProfiles.scopePartition,
      requestCanonicalizationProfile: programVocabularyProfiles.requestCanonicalization
    });
    const programVocabularyDirectOperations = createProgramVocabularyDirectOperationModule({
      workspaceId,
      managePolicy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: programVocabularyProfiles.authorityPrincipal,
      scopePartitionProfile: programVocabularyProfiles.scopePartition,
      requestCanonicalizationProfile: programVocabularyProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: programVocabularyProfiles.idempotencyCredential,
      idempotencyCredentialSealer: programVocabularyIdempotencyCredentialSealer
    });
    const programVocabularyMergeOperations = createProgramVocabularyMergeOperationModule({
      workspaceId,
      managePolicy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: programVocabularyProfiles.authorityPrincipal,
      scopePartitionProfile: programVocabularyProfiles.scopePartition,
      requestCanonicalizationProfile: programVocabularyProfiles.requestCanonicalization,
      draftRequestHashSealer: createHmacRequestHashSealer({
        profile: PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      publishRequestHashSealer: createHmacRequestHashSealer({
        profile: PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: programVocabularyProfiles.idempotencyCredential,
      idempotencyCredentialSealer: programVocabularyIdempotencyCredentialSealer
    });
    const schedulePlacementOperations = createSchedulePlacementOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
        manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      scheduleRead: schedulePlacementDirectDomain.scheduleRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: schedulePlacementProfiles.authorityPrincipal,
      scopePartitionProfile: schedulePlacementProfiles.scopePartition,
      requestCanonicalizationProfile: schedulePlacementProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: schedulePlacementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: schedulePlacementProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const schedulePlacementDirectOperations = createSchedulePlacementDirectOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
        manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      scheduleRead: schedulePlacementDirectDomain.scheduleRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: schedulePlacementProfiles.authorityPrincipal,
      scopePartitionProfile: schedulePlacementProfiles.scopePartition,
      requestCanonicalizationProfile: schedulePlacementProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: schedulePlacementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: schedulePlacementProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const sessionOperations = createSessionOperationModule({
      workspaceId,
      readPolicy: SESSION_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: sessionProfiles.authorityPrincipal,
      scopePartitionProfile: sessionProfiles.scopePartition,
      requestCanonicalizationProfile: sessionProfiles.requestCanonicalization,
      sessions: sessionRepository
    });
    const sessionDirectOperations = createSessionDirectOperationModule({
      workspaceId,
      managePolicy: SESSION_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: sessionProfiles.authorityPrincipal,
      scopePartitionProfile: sessionProfiles.scopePartition,
      requestCanonicalizationProfile: sessionProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SESSION_CHANGE_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: sessionProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: sessionProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const fieldRegistryOperations = createFieldRegistryOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: FIELD_REGISTRY_READ_ACCESS_POLICY,
        manage: FIELD_REGISTRY_MANAGE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      registryRead: fieldRegistryRepository,
      optionSource: fieldRegistryOptionSource,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: fieldRegistryProfiles.authorityPrincipal,
      scopePartitionProfile: fieldRegistryProfiles.scopePartition,
      requestCanonicalizationProfile: fieldRegistryProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: fieldRegistryProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: fieldRegistryProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const intakeReadOperations = createIntakeReadOperationModule({
      workspaceId,
      policies: Object.freeze({
        eventRead: INTAKE_EVENT_READ_ACCESS_POLICY,
        eventManage: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
        submissionRead: INTAKE_SUBMISSION_READ_ACCESS_POLICY,
        submissionContactRead: INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
        publicOpen: INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
        publicCeremony: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      read: Object.freeze({
        listForms: intakeRepository.listForms.bind(intakeRepository),
        readForm: intakeRepository.readFormDetail.bind(intakeRepository),
        readServedForm: intakeRepository.readServedForm.bind(intakeRepository),
        listSubmissions: intakeRepository.listSubmissions.bind(intakeRepository),
        readSubmission: intakeRepository.readSubmissionDetail.bind(intakeRepository),
        readSubmissionContact: intakeRepository.readSubmissionContact.bind(intakeRepository),
        readPublicDraftResume(scope, binding) {
          const data = intakeRepository.readPublicDraftResume(scope, binding);
          return data ? Object.freeze({ binding, data }) : undefined;
        }
      } satisfies Parameters<typeof createIntakeReadOperationModule>[0]['read']),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
        scopePartitionProfile: intakeProfiles.scopePartition,
        requestCanonicalizationProfile: intakeProfiles.requestCanonicalization
      })
    });
    const intakeIdempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: intakeProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const intakeFormWriteOperations = createIntakeFormWriteOperationModule({
      workspaceId,
      policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
      scopePartitionProfile: intakeProfiles.scopePartition,
      requestCanonicalizationProfile: intakeProfiles.requestCanonicalization,
      directRequestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      reviewRequestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      publishRequestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: intakeProfiles.idempotencyCredential,
      idempotencyCredentialSealer: intakeIdempotencyCredentialSealer
    });
    const submissionTriageReadOperations = createSubmissionTriageReadOperationModule({
      workspaceId,
      policies: Object.freeze({
        operatorRead: SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
        externalMcpRead: SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      read: submissionTriageRepository,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: submissionTriageProfiles.authorityPrincipal,
        scopePartitionProfile: submissionTriageProfiles.scopePartition,
        requestCanonicalizationProfile: submissionTriageProfiles.requestCanonicalization
      })
    });
    const submissionTriageTransitionOperations = createSubmissionTriageTransitionOperationModule({
      workspaceId,
      policy: SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: submissionTriageProfiles.authorityPrincipal,
        scopePartitionProfile: submissionTriageProfiles.scopePartition,
        requestCanonicalizationProfile: submissionTriageProfiles.requestCanonicalization,
        requestHashSealer: createHmacRequestHashSealer({
          profile: SUBMISSION_TRIAGE_REQUEST_HASH_PROFILE,
          keyBytes: randomHmacKey()
        }),
        idempotencyCredentialProfile: submissionTriageProfiles.idempotencyCredential,
        idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
          profile: submissionTriageProfiles.idempotencyCredential,
          keyBytes: randomHmacKey()
        })
      })
    });
    const submissionDirectEntryOperations =
      createSubmissionDirectEntryOperationModule({
        workspaceId,
        policy: SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
        currentAuthority: authority.resolver,
        currentEvent,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: Object.freeze({
          authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
          scopePartitionProfile: intakeProfiles.scopePartition,
          requestCanonicalizationProfile: intakeProfiles.requestCanonicalization,
          requestHashSealer: createHmacRequestHashSealer({
            profile: SUBMISSION_DIRECT_ENTRY_REQUEST_HASH_PROFILE,
            keyBytes: randomHmacKey()
          }),
          idempotencyCredentialProfile: intakeProfiles.idempotencyCredential,
          idempotencyCredentialSealer: intakeIdempotencyCredentialSealer
        })
      });
    const workspaceTeamOperations = createWorkspaceTeamOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: WORKSPACE_TEAM_OPERATION_ACCESS.read.policy,
        invite: WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy,
        changeRole: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy,
        remove: WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy
      }),
      currentAuthority: authority.resolver,
      teamRead: Object.freeze({
        readWorkspaceTeam(requestedWorkspaceId: typeof workspaceId) {
          if (requestedWorkspaceId !== workspaceId) {
            throw new TypeError('workspace_team_read_workspace_mismatch');
          }
          return workspaceTeamRepository.readProjection(requestedWorkspaceId);
        }
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: workspaceTeamProfiles.authorityPrincipal,
      scopePartitionProfile: workspaceTeamProfiles.scopePartition,
      requestCanonicalizationProfile: workspaceTeamProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: workspaceTeamProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: workspaceTeamProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const reviewViewerAccess = createSQLiteAccessRepositories(database.sqlite);
    /**
     * Resolves the Review projection viewer from durable admission and grant
     * evidence. A roster match always wins over organizer evidence so a
     * rostered reviewer keeps the blind-round reviewer view even when extra
     * grants would authorize the whole-population organizer view; organizer
     * resolves only on real `event.manage` evidence at the current event
     * scope, never from the snapshot lane's read permissions alone.
     */
    const reviewViewer: ReviewViewerResolver = Object.freeze({
      async resolveViewer({ scope, actor }: Parameters<
        ReviewViewerResolver['resolveViewer']
      >[0]) {
        if (
          actor.kind !== 'workspace_user'
          || scope.workspaceId !== workspaceId
          || scope.eventId === undefined
        ) {
          return Object.freeze({ kind: 'unavailable' as const });
        }
        const membership = await reviewViewerAccess.memberships.find(
          workspaceId,
          actor.userId
        );
        if (!membership || membership.status !== 'active') {
          return Object.freeze({ kind: 'unavailable' as const });
        }
        const reviewerId = reviewRepository.resolveActingReviewer(
          Object.freeze({ workspaceId: scope.workspaceId, eventId: scope.eventId }),
          membership.id
        );
        if (reviewerId !== undefined) {
          return Object.freeze({
            kind: 'viewer' as const,
            viewer: Object.freeze({ kind: 'reviewer' as const, reviewerId })
          });
        }
        const [roles, assignments, overrides] = await Promise.all([
          reviewViewerAccess.authorization.listRoles(workspaceId),
          reviewViewerAccess.authorization.listAssignments(workspaceId, actor.userId),
          reviewViewerAccess.authorization.listOverrides(workspaceId, actor.userId)
        ]);
        const organizer = evaluateAccess({
          userId: actor.userId,
          permissionId: 'event.manage',
          requestedScope: Object.freeze({
            kind: 'event' as const,
            workspaceId,
            eventId: scope.eventId
          }),
          membership,
          roles,
          assignments,
          overrides,
          now: clock.now()
        });
        return organizer.allowed
          ? Object.freeze({
              kind: 'viewer' as const,
              viewer: Object.freeze({ kind: 'organizer' as const })
            })
          : Object.freeze({ kind: 'unavailable' as const });
      }
    });
    const reviewOperations = createReviewOperationModule({
      workspaceId,
      policies: Object.freeze({
        snapshot: REVIEW_SNAPSHOT_ACCESS_POLICY,
        manage: REVIEW_MANAGE_ACCESS_POLICY,
        stepBack: REVIEW_STEP_BACK_ACCESS_POLICY,
        evaluate: REVIEW_EVALUATE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      viewer: reviewViewer,
      repository: reviewRepository,
      sources: reviewRepository,
      candidateDisplay: reviewRepository,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: reviewProfiles.authorityPrincipal,
      scopePartitionProfile: reviewProfiles.scopePartition,
      requestCanonicalizationProfile: reviewProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: REVIEW_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: reviewProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: reviewProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const reviewDirectOperations = createReviewDirectOperationModule({
      workspaceId,
      policies: Object.freeze({
        manage: REVIEW_MANAGE_ACCESS_POLICY,
        stepBack: REVIEW_STEP_BACK_ACCESS_POLICY,
        evaluate: REVIEW_EVALUATE_ACCESS_POLICY
      }),
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: reviewProfiles.authorityPrincipal,
      scopePartitionProfile: reviewProfiles.scopePartition,
      requestCanonicalizationProfile: reviewProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: REVIEW_DIRECT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: reviewProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: reviewProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const reviewerRosterOperations = createReviewerRosterOperationModule({
      workspaceId,
      policy: REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      rosterRead: Object.freeze({
        repository: reviewerRosterRepository,
        authority: reviewerAuthoritySource
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: reviewerRosterProfiles.authorityPrincipal,
      scopePartitionProfile: reviewerRosterProfiles.scopePartition,
      requestCanonicalizationProfile: reviewerRosterProfiles.requestCanonicalization,
      directRequestHashSealer: createHmacRequestHashSealer({
        profile: REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: reviewerRosterProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: reviewerRosterProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const decisionOperations = createDecisionOperationModule({
      workspaceId,
      readPolicy: DECISION_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: decisionProfiles.authorityPrincipal,
      scopePartitionProfile: decisionProfiles.scopePartition,
      requestCanonicalizationProfile: decisionProfiles.requestCanonicalization,
      decisions: decisionRepository
    });
    const decisionDirectOperations = createDecisionDirectOperationModule({
      workspaceId,
      managePolicy: DECISION_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: decisionProfiles.authorityPrincipal,
      scopePartitionProfile: decisionProfiles.scopePartition,
      requestCanonicalizationProfile: decisionProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: DECISION_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: decisionProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: decisionProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const engagementOperations = createEngagementOperationModule({
      workspaceId,
      readPolicy: ENGAGEMENT_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: engagementProfiles.authorityPrincipal,
      scopePartitionProfile: engagementProfiles.scopePartition,
      requestCanonicalizationProfile: engagementProfiles.requestCanonicalization,
      // The same repository instance the decision transaction seeds through;
      // nothing here reads a second copy of engagement state.
      engagements: decisionRepository.engagements
    });
    const engagementDirectOperations = createEngagementDirectOperationModule({
      workspaceId,
      managePolicy: ENGAGEMENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: engagementProfiles.authorityPrincipal,
      scopePartitionProfile: engagementProfiles.scopePartition,
      requestCanonicalizationProfile: engagementProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: ENGAGEMENT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: engagementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: engagementProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const taskBoardOperations = createTaskBoardReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      tasks: Object.freeze({
        readCurrent(requestedWorkspaceId: typeof workspaceId) {
          const selected = currentEvent.resolveCurrentEvent(requestedWorkspaceId);
          return selected.eventId === undefined
            ? undefined
            : taskRepository.readTaskBoard({
                workspaceId: requestedWorkspaceId,
                eventId: selected.eventId
              });
        }
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: taskProfiles.authorityPrincipal,
      scopePartitionProfile: taskProfiles.scopePartition,
      requestCanonicalizationProfile: taskProfiles.requestCanonicalization
    });
    const taskMutationOperations = createTaskMutationOperationModule({
      workspaceId,
      managePolicy: TASK_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: taskProfiles.authorityPrincipal,
      scopePartitionProfile: taskProfiles.scopePartition,
      requestCanonicalizationProfile: taskProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: TASK_MUTATION_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: taskProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: taskProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const eventSettingsDirectDomain =
      createSQLiteEventSettingsDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId
      });
    const templateArtifactNativeDomains =
      createSQLiteTemplateArtifactNativeEffectDomainRegistrations({
        sqlite: database.sqlite,
        workspaceId,
        eventRelationships,
        ids: Object.freeze({
          newDraftId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newArtifactRevisionId: () => crypto.randomUUID()
        })
      });
    const templateEditDomain = createSQLiteTemplateEditEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      service: templateEditService,
      ids: Object.freeze({
        newPreparationHandle: () => crypto.randomUUID(),
        newRunId: () => crypto.randomUUID(),
        newAttemptId: () => crypto.randomUUID()
      })
    });
    const programVocabularyDirectDomain =
      createSQLiteProgramVocabularyDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        referenceRegistry,
        contributors: contributorAdapters,
        eventRelationships,
        ids: Object.freeze({ newVocabularyItemId: () => crypto.randomUUID() })
      });
    const programVocabularyMergeDomains =
      createSQLiteProgramVocabularyMergeEffectDomainRegistrations({
        sqlite: database.sqlite,
        workspaceId,
        referenceRegistry,
        contributors: contributorAdapters,
        eventRelationships,
        ids: Object.freeze({
          newDraftId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID()
        })
      });
    const intakeFormWriteDomains = createSQLiteIntakeFormWriteEffectDomainRegistrations({
      sqlite: database.sqlite,
      workspaceId,
      repository: intakeRepository,
      eventRelationships,
      ids: Object.freeze({
        newFormEntityId: () => crypto.randomUUID(),
        newFormVersionId: () => crypto.randomUUID(),
        newReviewDraftId: () => crypto.randomUUID(),
        newReviewRevisionId: () => crypto.randomUUID()
      })
    });
    const fieldRegistryDirectDomain = createSQLiteFieldRegistryDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      ids: Object.freeze({
        newFieldId: () => crypto.randomUUID(),
        newChoiceId: () => crypto.randomUUID()
      })
    });
    const workspaceTeamMutationDomain =
      createSQLiteWorkspaceTeamMutationEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        classifiedStore: workspaceTeamClassifiedStore,
        invitationLookupKeyBytes: workspaceTeamInvitationLookupKey,
        ids: Object.freeze({
          newPreparationHandle: () => crypto.randomUUID(),
          newReservationId: () => crypto.randomUUID(),
          newReservationRoleAssignmentId: () => crypto.randomUUID(),
          newReleaseIntentId: () => crypto.randomUUID(),
          newHistoryId: () => crypto.randomUUID(),
          newPayloadRefId: () => crypto.randomUUID(),
          newSessionRevocationIntentId: () => crypto.randomUUID()
        })
      });
    const reviewDirectDomain = createSQLiteReviewDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: reviewRepository,
      eventRelationships,
      ids: Object.freeze({
        newRoundId: () => crypto.randomUUID(),
        newDeadlineId: () => crypto.randomUUID(),
        newCriterionId: () => crypto.randomUUID(),
        newAssignmentId: () => crypto.randomUUID(),
        newReviewRevisionId: () => crypto.randomUUID()
      })
    });
    const reviewEvaluationDraftSaveDomain =
      createSQLiteReviewEvaluationDraftSaveEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        repository: reviewRepository,
        eventRelationships,
        ids: Object.freeze({
          newPreparationHandle: () => crypto.randomUUID()
        })
      });
    const reviewerRosterDirectDomain =
      createSQLiteReviewerRosterDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        sources: reviewerRosterSources,
        eventRelationships
      });
    const organizerCommunicationAuthoringDomains =
      createSQLiteOrganizerCommunicationAuthoringEffectDomainRegistrations({
        sqlite: database.sqlite,
        workspaceId,
        repository: organizerCommunicationAuthoring,
        eventRelationships,
        ids: Object.freeze({
          newTimelineId: () => crypto.randomUUID()
        })
      });
    const outboundEmailDeliveryDomain = createSQLiteOutboundEmailDeliveryEffectDomainRegistration({
      sqlite: database.sqlite,
      ids: Object.freeze({
        newPreparationHandle: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID(),
        newHistoryThreadId: () => crypto.randomUUID(),
        newHistoryId: () => crypto.randomUUID()
      })
    });
    // ------------------------------------------------------------------
    // Participant lane (single-event launch): the lane resolves the current
    // event per read, mirroring the dispatch job's event-missing posture —
    // requests that need a lane before an event exists are answered honestly
    // at the boundary and never reach these getters.
    // ------------------------------------------------------------------
    const resolvePortalLane = (): ParticipantLane | undefined => {
      const current = currentEvent.resolveCurrentEvent(workspaceId);
      return current.eventId === undefined
        ? undefined
        : Object.freeze({ workspaceId, eventId: parseEventId(current.eventId) });
    };
    const portalLane: ParticipantLane = Object.freeze({
      workspaceId,
      get eventId() {
        const lane = resolvePortalLane();
        if (lane === undefined) throw new TypeError('portal_lane_event_missing');
        return lane.eventId;
      }
    }) as ParticipantLane;
    const participantStore = new SQLiteParticipantAccessStore(database.sqlite, {
      policy: PARTICIPANT_ACCESS_LAUNCH_POLICY
    });
    // Sender identity is per-installation configuration; unset environments
    // use an explicit unconfigured `.invalid` profile (never a hardcoded
    // production identity), matching the inert-provider posture. The
    // auth-specific `JOOEVENTS_AUTH_MAIL_*` names override the deployment-wide
    // `JOOEVENTS_MAIL_*` sender for this security lane.
    const participantSenderFallback = mailSender.configured
      ? mailSender
      : undefined;
    const installationSenderIdentity: InstallationMailSenderIdentity = Object.freeze({
      fromAddress: process.env.JOOEVENTS_AUTH_MAIL_FROM_ADDRESS
        ?? participantSenderFallback?.fromAddress
        ?? 'sign-in@unconfigured.invalid',
      ...(process.env.JOOEVENTS_AUTH_MAIL_FROM_NAME
        ? { fromDisplayName: process.env.JOOEVENTS_AUTH_MAIL_FROM_NAME }
        : participantSenderFallback?.fromDisplayName !== undefined
          ? { fromDisplayName: participantSenderFallback.fromDisplayName }
          : {}),
      ...(process.env.JOOEVENTS_AUTH_MAIL_REPLY_TO
        ? { replyToAddress: process.env.JOOEVENTS_AUTH_MAIL_REPLY_TO }
        : participantSenderFallback?.replyToAddress !== undefined
          ? { replyToAddress: participantSenderFallback.replyToAddress }
          : {})
    });
    // Display name and reply-to are workspace settings, so the deliveries below
    // hold a RESOLVER rather than a frozen sender: each send composes the
    // current workspace presentation over this installation-owned
    // from-address, and an operator's edit lands on the next mail.
    const senderIdentity = createWorkspaceSenderIdentityComposition({
      sqlite: database.sqlite,
      workspaceId,
      installation: installationSenderIdentity
    });
    const participantDelivery = createSQLiteParticipantChallengeDelivery({
      sqlite: database.sqlite,
      releases: communicationMessageReleases,
      ids: Object.freeze({
        newReleaseId: () => crypto.randomUUID(),
        newDeliveryId: () => crypto.randomUUID(),
        newEvidenceId: () => crypto.randomUUID()
      }),
      senderResolver: senderIdentity.senderResolver,
      portalOrigin: input.config.baseUrl,
      challenges: participantStore,
      ...(communicationDeliveryRoute === undefined
        ? {}
        : {
            providerRoute: Object.freeze({
              providerConnectionRevisionId:
                communicationDeliveryRoute.providerConnectionRevisionId
            })
          })
    });
    // The auth-owned delivery seam declares no return value; the SQLite
    // adapter additionally returns the registration receipt, captured here so
    // the after-commit entry hook dispatches exactly that delivery. Requests
    // that register nothing leave the slot empty and the hook falls back to
    // one sweep pass. The serialized HTTP boundary keeps the slot
    // request-local.
    let lastRegisteredParticipantDeliveryId: string | undefined;
    const kickTrackedParticipantDelivery: ParticipantChallengeDelivery = Object.freeze({
      enqueueSignInLink(effect: ParticipantSignInLinkDeliveryEffect) {
        lastRegisteredParticipantDeliveryId =
          participantDelivery.enqueueSignInLink(effect).deliveryId;
      }
    });
    // Workspace magic-link fulfillment (owner revision, 2026-08-14: registered
    // or reserved). The gate decides server-privately; a denied address and a
    // missing current event both drop without a trace the browser could read.
    // Delivery scope pins the current event; a pre-event install keeps Google
    // as its first-sign-in path until security mail gains event-free scope.
    const workspaceSignInLinkDelivery = createSQLiteWorkspaceSignInLinkDelivery({
      sqlite: database.sqlite,
      releases: communicationMessageReleases,
      ids: Object.freeze({
        newReleaseId: () => crypto.randomUUID(),
        newDeliveryId: () => crypto.randomUUID(),
        newEvidenceId: () => crypto.randomUUID()
      }),
      senderResolver: senderIdentity.senderResolver,
      ...(communicationDeliveryRoute === undefined
        ? {}
        : {
            providerRoute: Object.freeze({
              providerConnectionRevisionId:
                communicationDeliveryRoute.providerConnectionRevisionId
            })
          })
    });
    const shortSignInLinkOrigin = new URL(input.config.baseUrl).origin;
    workspaceSignInLinkDeliver = async ({ email, token }) => {
      const lane = resolvePortalLane();
      if (lane === undefined) return;
      const decision = decideWorkspaceSignInLinkEligibility({
        sqlite: database.sqlite,
        workspaceId,
        email
      });
      if (!decision.eligible) return;
      const requestedAt = new Date().toISOString();
      const expiresAt = new Date(
        Date.parse(requestedAt) + WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS * 1000
      ).toISOString();
      const effect = Object.freeze({
        workspaceId: lane.workspaceId,
        eventId: lane.eventId,
        requestId: crypto.randomUUID(),
        recipientEmail: email,
        // The emailed link is the short `/a/<token>` form; its route rebuilds
        // the plugin verify URL, which stays the single arbiter of validity.
        linkUrl: `${shortSignInLinkOrigin}/a/${token}`,
        requestedAt,
        expiresAt
      });
      let began = false;
      let registered: { readonly deliveryId: string } | undefined;
      try {
        database.sqlite.exec('BEGIN IMMEDIATE;');
        began = true;
        registered = workspaceSignInLinkDelivery.enqueueSignInLink(effect);
        database.sqlite.exec('COMMIT;');
      } catch (error) {
        if (began && database.sqlite.inTransaction) database.sqlite.exec('ROLLBACK;');
        // A delivery fault must not become an eligibility oracle: the browser
        // acknowledgement stays uniform, the ledger's absence is the honest
        // record, and the operator log carries the fault without the address.
        console.error('[jooevents] workspace sign-in link delivery failed', error);
        return;
      }
      // After-commit instant dispatch, real provider only: security mail must
      // not wait for the sweep tick. Fire-and-forget and never rethrown, so
      // dispatch faults cannot leak eligibility either; the pump remains the
      // sweeper for anything this kick misses.
      if (registered !== undefined && providerRuntime.registration?.delivery !== undefined) {
        const { deliveryId } = registered;
        // Losing the claim to a sweep is a typed outcome, not a rejection, so
        // this catch is left for genuine faults only. It used to swallow
        // ordinary contention as an error, which is how the collision between
        // this kick and the sweep stayed invisible.
        void outboundDispatch.dispatchOne(deliveryId).catch((error) => {
          console.error('[jooevents] workspace sign-in link dispatch kick failed', error);
        });
      }
    };
    const participantRelationships = createSQLiteParticipantRelationshipSource(database.sqlite);
    const participantIntakeAttribution = createSQLiteIntakeAttributedParticipantSource({
      sqlite: database.sqlite,
      contacts: intakeRepository
    });
    const portalReadSource = createSQLiteParticipantPortalReadSource({
      sqlite: database.sqlite,
      intake: intakeRepository
    });
    const participantAuthority = createParticipantCurrentAuthorityResolver({
      lane: portalLane,
      policies: Object.freeze([
        PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
        PORTAL_PARTICIPANT_ACT_ACCESS_POLICY
      ]),
      sessions: createSQLiteParticipantSessionAuthorityView(database.sqlite),
      identities: participantStore,
      relationships: participantRelationships
    });
    const participantPortalOperations = createParticipantPortalOperationModule({
      lane: portalLane,
      policies: Object.freeze({
        read: PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
        act: PORTAL_PARTICIPANT_ACT_ACCESS_POLICY
      }),
      currentAuthority: participantAuthority,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: participantPortalProfiles.authorityPrincipal,
        scopePartitionProfile: participantPortalProfiles.scopePartition,
        requestCanonicalizationProfile: participantPortalProfiles.requestCanonicalization,
        requestHashSealer: createHmacRequestHashSealer({
          profile: PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE,
          keyBytes: randomHmacKey()
        }),
        idempotencyCredentialProfile: participantPortalProfiles.idempotencyCredential,
        idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
          profile: participantPortalProfiles.idempotencyCredential,
          keyBytes: randomHmacKey()
        })
      }),
      identities: participantStore,
      relationships: participantRelationships,
      engagements: engagementReadRepository,
      portal: portalReadSource
    });
    const participantPortalDomain = createSQLiteParticipantPortalEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      lane: portalLane,
      intake: intakeRepository,
      ids: Object.freeze({
        newPreparationHandle: () => crypto.randomUUID(),
        newActivityId: () => crypto.randomUUID()
      })
    });
    // ------------------------------------------------------------------
    // Files v1 (D1–D9): the whole domain composes over the shared effect
    // unit of work. Limits come from env-shaped configuration (invalid values
    // throw at boot, never fall back), blobs live beside the ephemeral
    // database and die with it, and the `none` scan provider releases on
    // ingest while serving stays structurally inert on every path.
    // ------------------------------------------------------------------
    // Blob bytes are as disposable as the database, but the ephemeral SQLite
    // runtime owns its directory exclusively, so the blobs get their own
    // process-lifetime temp tree, removed on close.
    filesBlobRootDirectory = mkdtempSync(join(tmpdir(), 'jooevents-ephemeral-files-'));
    const files = createFilesLiveComposition({
      sqlite: database.sqlite,
      workspaceId,
      blobRootDirectory: filesBlobRootDirectory,
      events,
      trackExists: (scope, trackId) => {
        const vocabulary = vocabularyRead.readVocabulary(scope);
        return vocabulary?.tracks.some(
          (track) => track.id === trackId && track.status === 'active'
        ) ?? false;
      },
      env: process.env
    });
    const filesOperationIds = Object.freeze({
      newInvocationId: () => parseInvocationId(crypto.randomUUID())
    });
    const filesRequestHashSealer = createHmacRequestHashSealer({
      profile: FILES_COMMAND_REQUEST_HASH_PROFILE,
      keyBytes: randomHmacKey()
    });
    const filesIdempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: filesProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const filesReadOperations = createFilesReadOperationModule({
      workspaceId,
      readPolicy: FILE_READ_ACCESS_POLICY,
      // The external MCP surface carries reads only (agents never move bytes);
      // the lane is registered vocabulary — this composition mounts no MCP
      // transport, so nothing serves it yet.
      mcpReadPolicy: FILE_MCP_READ_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: filesOperationIds,
      authorityPrincipalKeyProfile: filesProfiles.authorityPrincipal,
      scopePartitionProfile: filesProfiles.scopePartition,
      requestCanonicalizationProfile: filesProfiles.requestCanonicalization,
      read: files.organizerRead
    });
    const filesCommandOperations = createFilesCommandOperationModule({
      workspaceId,
      commandPolicy: FILES_COMMAND_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: filesOperationIds,
      authorityPrincipalKeyProfile: filesProfiles.authorityPrincipal,
      scopePartitionProfile: filesProfiles.scopePartition,
      requestCanonicalizationProfile: filesProfiles.requestCanonicalization,
      requestHashSealer: filesRequestHashSealer,
      idempotencyCredentialProfile: filesProfiles.idempotencyCredential,
      idempotencyCredentialSealer: filesIdempotencyCredentialSealer
    });
    const senderIdentityOperations = createWorkspaceSenderIdentityOperationModule({
      workspaceId,
      policy: WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      read: senderIdentity.read,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: senderIdentityProfiles.authorityPrincipal,
        scopePartitionProfile: senderIdentityProfiles.scopePartition,
        requestCanonicalizationProfile: senderIdentityProfiles.requestCanonicalization,
        requestHashSealer: createHmacRequestHashSealer({
          profile: WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE,
          keyBytes: randomHmacKey()
        }),
        idempotencyCredentialProfile: senderIdentityProfiles.idempotencyCredential,
        idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
          profile: senderIdentityProfiles.idempotencyCredential,
          keyBytes: randomHmacKey()
        })
      })
    });
    const domains = createSQLiteEffectDomainAdapterRegistry([
      eventDirectDomain,
      eventSettingsDirectDomain,
      ...templateArtifactNativeDomains,
      templateEditDomain,
      deadlineDirectDomain,
      programVocabularyDirectDomain,
      ...programVocabularyMergeDomains,
      schedulePlacementDirectDomain,
      sessionDirectDomain,
      ...intakeFormWriteDomains,
      fieldRegistryDirectDomain,
      submissionTriageDirectDomain,
      intakeDirectEntryDirectDomain,
      workspaceTeamMutationDomain,
      reviewDirectDomain,
      reviewEvaluationDraftSaveDomain,
      reviewerRosterDirectDomain,
      decisionDirectDomain,
      engagementDirectDomain,
      taskDirectDomain,
      ...releaseNativeDomains,
      participantPortalDomain,
      outboundEmailDeliveryDomain,
      intakePublicMutationDomain,
      files.effectDomain,
      senderIdentity.effectDomain,
      ...organizerCommunicationAuthoringDomains,
      ...communicationSendRuntime.effectDomains
    ]);
    // The in-transaction authority recheck dispatches by lane: participant
    // invocations re-prove the participant session (without sliding it),
    // identity standing, and current relationship; public-ceremony
    // invocations re-prove the ceremony against the live apply-surface pin
    // through the gated directory; everything else re-proves operator
    // authority. No resolver ever answers another resolver's lane.
    const effectRecheckSource = Object.freeze({
      resolveAuthority: (
        recheckInput: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]
      ) => recheckInput.lane.kind === 'participant'
        ? participantAuthority.resolve(recheckInput)
        : recheckInput.lane.kind === 'public_ceremony'
          ? intakePublicCeremonies.currentAuthority.resolve(recheckInput)
          : authority.effectRecheckSource.resolveAuthority(recheckInput),
      now: authority.effectRecheckSource.now
    });
    const unitOfWork = new SQLiteEffectUnitOfWorkPort(
      database.sqlite,
      domains,
      effectRecheckSource
    );
    const source = composeOperationRegistryModules([
      workspaceOverviewOperations,
      operationHistoryOperations,
      eventOperations,
      eventSettingsReadOperations,
      eventSettingsUpdateOperations,
      templateArtifactReadOperations,
      templateArtifactNativeOperations,
      templateEditOperations,
      deadlineOperations,
      programVocabularyOperations,
      programVocabularyDirectOperations,
      programVocabularyMergeOperations,
      schedulePlacementOperations,
      schedulePlacementDirectOperations,
      sessionOperations,
      sessionDirectOperations,
      fieldRegistryOperations,
      intakeReadOperations,
      intakeFormWriteOperations,
      submissionTriageReadOperations,
      submissionTriageTransitionOperations,
      submissionDirectEntryOperations,
      workspaceTeamOperations,
      reviewDirectOperations,
      reviewOperations,
      reviewerRosterOperations,
      decisionOperations,
      decisionDirectOperations,
      engagementOperations,
      engagementDirectOperations,
      taskBoardOperations,
      taskMutationOperations,
      releaseNativeOperations,
      releaseOverviewOperations,
      filesReadOperations,
      filesCommandOperations,
      participantPortalOperations,
      organizerCommunicationAuthoringOperations,
      organizerCommunicationAudiencePreviewOperations,
      communicationProviderReadOperations,
      senderIdentityOperations,
      communicationSendOperations,
      communicationDeliveryHistoryOperations,
      outboundEmailDispatchOperations
    ]);
    const operations = await createApplicationOperationRuntime({
      source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: new SQLiteReadImmutableAuditPort(database.sqlite),
        clock,
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      },
      unitOfWork
    });
    // ONE public registry behind ONE adapter: the gated intake form read,
    // the ceremony resume read, the two release reads, and the one public
    // mutation effect compose into a single conformance-checked runtime
    // sharing the one unit of work, preserving the structural `/api/public/`
    // guarantee at one seam.
    const publicRuntime = await publicEffectBoundary.createRuntime({
      source: composeOperationRegistryModules([
        intakePublicReadOperations,
        releasePublicReadOperations,
        omitSharedIntakeInfrastructure(intakePublicMutationOperations)
      ]),
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: new SQLiteReadImmutableAuditPort(database.sqlite),
        clock,
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      },
      unitOfWork
    });
    assertOperatorAuthorityPolicyCatalogCoversOperationRegistry({
      catalog: authority.policies,
      registry: operations.registry
    });
    // Public-registry coverage gate (counterpart of the operator assert):
    // the composed public surface is exactly the pinned data/presentation reads and
    // the one ceremony-guarded effect binding.
    {
      const publicBindings = publicRuntime.registry.publicHttpBindings
        .map((binding) =>
          `${binding.operationName}@${binding.operationVersion} GET ${binding.path}`)
        .sort();
      const expectedPublicBindings = [
        `${INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.name}@${INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.version} GET /api/public/forms/application`,
        `${INTAKE_PUBLIC_FORM_READ_OPERATION.name}@${INTAKE_PUBLIC_FORM_READ_OPERATION.version} GET /api/public/forms/current`,
        `${RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION.name}@${RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION.version} GET ${RELEASE_PUBLIC_APPLY_PRESENTATION_READ_PATH}`,
        `${RELEASE_PUBLIC_ROSTER_READ_OPERATION.name}@${RELEASE_PUBLIC_ROSTER_READ_OPERATION.version} GET ${RELEASE_PUBLIC_ROSTER_READ_PATH}`,
        `${RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION.name}@${RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION.version} GET ${RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_PATH}`,
        `${RELEASE_PUBLIC_SCHEDULE_READ_OPERATION.name}@${RELEASE_PUBLIC_SCHEDULE_READ_OPERATION.version} GET ${RELEASE_PUBLIC_SCHEDULE_READ_PATH}`,
        `${RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION.name}@${RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION.version} GET ${RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_PATH}`
      ].sort();
      const publicEffectBindings = publicRuntime.registry.publicHttpEffectBindings
        .map((binding) =>
          `${binding.operationName}@${binding.operationVersion} POST ${binding.path}`)
        .sort();
      const expectedPublicEffectBindings = [
        `${INTAKE_PUBLIC_MUTATE_OPERATION.name}@${INTAKE_PUBLIC_MUTATE_OPERATION.version} POST /api/public/forms/application/mutate`
      ];
      if (publicBindings.length !== expectedPublicBindings.length
          || publicBindings.some((entry, index) => entry !== expectedPublicBindings[index])
          || publicEffectBindings.length !== expectedPublicEffectBindings.length
          || publicEffectBindings.some((entry, index) =>
            entry !== expectedPublicEffectBindings[index])) {
        throw new TypeError('ephemeral_public_registry_coverage_mismatch');
      }
    }
    const evidence = createBetterAuthOperatorEvidenceVerifier({
      sessions: { getSession: (headers) => auth.api.getSession({ headers }) },
      allowedOrigins: [input.config.baseUrl, ...input.config.trustedOrigins]
    });
    const participantAllowedOrigins = new Set([
      input.config.baseUrl,
      ...input.config.trustedOrigins
    ]);
    const participantEntryRuntime: ParticipantEntryRuntime = Object.freeze({
      resolveLane: resolvePortalLane,
      transaction: <Value>(work: () => Value): Value => {
        let began = false;
        try {
          database.sqlite.exec('BEGIN IMMEDIATE;');
          began = true;
          const value = work();
          database.sqlite.exec('COMMIT;');
          return value;
        } catch (error) {
          if (began && database.sqlite.inTransaction) database.sqlite.exec('ROLLBACK;');
          throw error;
        }
      },
      store: participantStore,
      delivery: kickTrackedParticipantDelivery,
      intakeAttribution: participantIntakeAttribution,
      policy: PARTICIPANT_ACCESS_LAUNCH_POLICY,
      // After-commit instant dispatch, real provider only: targeted when the
      // registration receipt was captured, one sweep pass otherwise. Fire-and-
      // forget with the failure swallowed here — the acknowledgement stays
      // byte-uniform and the 2s pump remains the sweeper.
      afterSignInLinkRegistered: () => {
        if (providerRuntime.registration?.delivery === undefined) return;
        const deliveryId = lastRegisteredParticipantDeliveryId;
        lastRegisteredParticipantDeliveryId = undefined;
        // As above: contention with the sweep resolves to a typed skip, so only
        // a genuine fault reaches this catch.
        void (deliveryId === undefined
          ? outboundDispatch.runOnce()
          : outboundDispatch.dispatchOne(deliveryId)
        ).catch((error) => {
          console.error('[jooevents] participant sign-in link dispatch kick failed', error);
        });
      },
      ids: Object.freeze({
        newChallengeId: () => crypto.randomUUID(),
        newReceiptId: () => crypto.randomUUID(),
        newPersonId: () => parsePersonId(crypto.randomUUID()),
        newParticipantIdentityId: () => parseParticipantIdentityId(crypto.randomUUID()),
        newSessionId: () => parseParticipantSessionId(crypto.randomUUID())
      }),
      readPortalEvent: (lane: ParticipantLane) => portalReadSource.readPortalEvent(lane),
      now: () => parseInstant(new Date().toISOString()),
      allowedOrigins: Object.freeze([input.config.baseUrl, ...input.config.trustedOrigins])
    });
    const participantEvidence = Object.freeze({
      verify({ request, binding }: {
        readonly request: Request;
        readonly correlationId: string;
        readonly binding: { readonly method: string };
      }) {
        if (request.method !== binding.method) {
          return Object.freeze({ kind: 'rejected' as const, reason: 'forbidden' as const });
        }
        if (binding.method === 'POST') {
          const origin = request.headers.get('origin');
          if (!origin || !participantAllowedOrigins.has(origin)) {
            return Object.freeze({ kind: 'rejected' as const, reason: 'forbidden' as const });
          }
        }
        const lane = resolvePortalLane();
        const token = readPortalSessionToken(request);
        if (lane === undefined || token === undefined) {
          return Object.freeze({ kind: 'rejected' as const, reason: 'unauthenticated' as const });
        }
        const context = resolveParticipantContext({
          sessions: participantStore,
          identities: participantStore,
          lane,
          sessionToken: token,
          now: parseInstant(new Date().toISOString())
        });
        if (context.kind !== 'active') {
          return Object.freeze({ kind: 'rejected' as const, reason: 'unauthenticated' as const });
        }
        return Object.freeze({
          kind: 'verified' as const,
          evidence: Object.freeze({
            kind: 'participant' as const,
            surface: 'participant_http' as const,
            client: Object.freeze({ key: 'portal-web' }),
            participantSessionId: context.session.sessionId
          })
        });
      }
    });
    const requestSerialization = createSerialHttpRequestBoundary();
    const app = createHttpApp({
      auth,
      accessContext,
      workspaceId,
      baseUrl: input.config.baseUrl,
      operatorOperations: { operations, evidence },
      participantEntry: participantEntryRuntime,
      participantOperations: { operations, evidence: participantEvidence },
      requestSerialization
    });
    const agentActionRuns = new SQLiteAgentActionRunRepository(
      database.sqlite,
      ({ approval }) => approval.approvedByPrincipalId.length > 0
        && !approval.approvedByPrincipalId.startsWith('model-')
        && !approval.approvedByPrincipalId.startsWith('mcp-')
    );
    const agentActionCatalog = createRegisteredAgentActionEligibilityCatalog(operations.registry);
    const agentActionPlanSurface = createAgentActionPlanSurface({
      repository: agentActionRuns,
      catalog: agentActionCatalog,
      now: () => new Date().toISOString()
    });
    app.route('/', createAgentActionRunsHttpAdapter({
      repository: agentActionRuns,
      allowedOrigins: [input.config.baseUrl, ...input.config.trustedOrigins],
      now: () => new Date().toISOString(),
      async authenticateEligibleHuman(request) {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return undefined;
        const result = await accessContext.ensureAuthPrincipalProvisioned({
          authUserId: session.user.id,
          workspaceId,
          correlationId: request.headers.get('x-correlation-id') ?? crypto.randomUUID(),
          now: new Date().toISOString()
        });
        return result.kind === 'success' && result.data.state === 'active'
          ? result.data.user.id
          : undefined;
      }
    }));
    // Public apply transport (the reviewed activation recipe): the mint route
    // issues continuations against the live gate — the transport `Origin`
    // header rides into the bootstrap protocol evidence — and the ceremony
    // middleware admits every resume/mutate request before the registered
    // binding runs. A terminal ceremony replays its registered completion; a
    // stopped one answers an undistinguishing 404.
    const publicCeremonyEvidenceByRequest = new WeakMap<Request, InvocationEvidence>();
    app.post(INTAKE_PUBLIC_CONTINUATION_MINT_PATH, async (context) => {
      const selected = context.req.header(INTAKE_PUBLIC_FORM_SELECTOR_HEADER);
      if (!selected || selected.includes(',') || !intakeIdSchema.safeParse(selected).success) {
        return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
      }
      let payload: unknown;
      try {
        payload = await context.req.json();
      } catch {
        return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
      }
      const minted = await intakePublicCeremonies.mint({
        formId: selected,
        protocolEvidence: {
          schemaVersion: 1,
          bootstrap: (payload as { readonly bootstrap?: unknown } | null)?.bootstrap,
          origin: context.req.header('origin') ?? null
        }
      });
      context.header('cache-control', 'no-store, max-age=0');
      return context.json(minted, minted.kind === 'issued' ? 201 : 409);
    });
    const intakePublicCeremonyMiddleware = async (
      context: Parameters<Parameters<typeof app.use>[1]>[0],
      nextMiddleware: Parameters<Parameters<typeof app.use>[1]>[1]
    ) => {
      const selected = context.req.header(INTAKE_PUBLIC_FORM_SELECTOR_HEADER);
      const continuation = context.req.header(INTAKE_PUBLIC_CONTINUATION_HEADER);
      if (!selected || selected.includes(',') || !intakeIdSchema.safeParse(selected).success
          || !continuation || continuation.includes(',')) {
        return context.json({ kind: 'transport_error', code: 'invalid_request' }, 400);
      }
      const admission = intakePublicCeremonies.admit({ formId: selected, continuation });
      if (admission.kind === 'terminal') {
        context.header('cache-control', 'no-store, max-age=0');
        return context.json(admission.receipt.result);
      }
      if (admission.kind === 'stopped') {
        return context.json({ kind: 'transport_error', code: 'not_available' }, 404);
      }
      const evidence: InvocationEvidence = Object.freeze({
        kind: 'public_ceremony',
        surface: 'public_http',
        client: { key: 'public.intake-apply' },
        ceremonyEvidenceId: admission.evidence.ceremonyEvidenceId
      });
      publicCeremonyEvidenceByRequest.set(context.req.raw, evidence);
      await nextMiddleware();
    };
    app.use('/api/public/forms/application', intakePublicCeremonyMiddleware);
    app.use('/api/public/forms/application/mutate', intakePublicCeremonyMiddleware);
    const publicOperationsAdapter = createPublicOperationsHttpAdapter({
      operations: publicRuntime,
      evidence: {
        verify({ request, binding }) {
          if (binding.operationName === INTAKE_PUBLIC_FORM_READ_OPERATION.name
              && binding.operationVersion === INTAKE_PUBLIC_FORM_READ_OPERATION.version
              && binding.path === '/api/public/forms/current') {
            // Gate-refused form reads answer 401; unknown and rolled-back
            // surfaces are indistinguishable at this boundary.
            const resolution = applySurfaceGate.resolveApplySurface();
            if (resolution.kind !== 'pinned') {
              return Object.freeze({
                kind: 'rejected' as const,
                reason: 'unauthenticated' as const
              });
            }
            // A well-formed formId naming anything but the pinned form gets the
            // same bytes as no surface at all: probing ids must not distinguish
            // "not served" from "served under a different id". A malformed id
            // falls through to the executor's own 400. The producer's
            // fail-closed scope refusal stays behind this as defense in depth.
            const requestedFormId = (() => {
              try {
                const raw = new URL(request.url).searchParams.get('formId');
                if (raw === null) return null;
                const parsed = intakeIdInputSchema.safeParse(raw);
                return parsed.success ? parsed.data : null;
              } catch {
                return null;
              }
            })();
            if (requestedFormId !== null && requestedFormId !== resolution.pin.formId) {
              return Object.freeze({
                kind: 'rejected' as const,
                reason: 'unauthenticated' as const
              });
            }
            return Object.freeze({
              kind: 'verified' as const,
              evidence: Object.freeze({
                kind: 'public_open' as const,
                surface: 'public_http' as const,
                client: Object.freeze({ key: 'public.intake-form-read' }),
                publicPolicyRevisionId: intakePublicApplyPolicyRevision(resolution.pin)
              })
            });
          }
          if (releasePublicOperations.has(`${binding.operationName}@${binding.operationVersion}`)
              && (binding.path === RELEASE_PUBLIC_SCHEDULE_READ_PATH
                || binding.path === RELEASE_PUBLIC_ROSTER_READ_PATH
                || binding.path === RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_PATH
                || binding.path === RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_PATH
                || binding.path === RELEASE_PUBLIC_APPLY_PRESENTATION_READ_PATH)) {
            return Object.freeze({
              kind: 'verified' as const,
              evidence: Object.freeze({
                kind: 'public_open' as const,
                surface: 'public_http' as const,
                client: Object.freeze({ key: 'public.release-read' }),
                publicPolicyRevisionId: releasePublicPolicyRevisionId
              })
            });
          }
          if ((binding.operationName === INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.name
                && binding.operationVersion === INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.version
                && binding.path === '/api/public/forms/application')
              || (binding.operationName === INTAKE_PUBLIC_MUTATE_OPERATION.name
                && binding.operationVersion === INTAKE_PUBLIC_MUTATE_OPERATION.version
                && binding.path === '/api/public/forms/application/mutate')) {
            const evidence = publicCeremonyEvidenceByRequest.get(request);
            return evidence
              ? Object.freeze({ kind: 'verified' as const, evidence })
              : Object.freeze({
                  kind: 'rejected' as const,
                  reason: 'unauthenticated' as const
                });
          }
          throw new TypeError('ephemeral_public_binding_mismatch');
        }
      }
    });
    app.route('/', publicOperationsAdapter);
    // ------------------------------------------------------------------
    // Files v1 transport. Every command and read is a registered operation;
    // the transport owns exactly (a) the raw-byte streaming step of the
    // two-phase upload — through-app, hashing and the hard cap inline,
    // strictly OUTSIDE the shared unit of work — and (b) the inert download:
    // Content-Disposition attachment + nosniff with the content type copied
    // from the asset record, never sniffed, never inline. The participant
    // surface composes lazily per current event because the portal read
    // module pins its lane eagerly and no event exists at boot.
    // ------------------------------------------------------------------
    const filesPortalRequestHashSealer = createHmacRequestHashSealer({
      profile: FILES_COMMAND_REQUEST_HASH_PROFILE,
      keyBytes: randomHmacKey()
    });
    const filesPortalIdempotencySealer = createHmacIdempotencyCredentialSealer({
      profile: filesPortalProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    interface FilesPortalComposition {
      readonly runtime: Awaited<ReturnType<typeof createApplicationOperationRuntime>>;
      readonly adapter: ReturnType<typeof createParticipantOperationsHttpAdapter>;
    }
    const filesPortalByEvent = new Map<string, Promise<FilesPortalComposition>>();
    const currentFilesPortal = (): Promise<FilesPortalComposition> | undefined => {
      const lane = resolvePortalLane();
      if (lane === undefined) return undefined;
      const laneEventId: string = lane.eventId;
      const existing = filesPortalByEvent.get(laneEventId);
      if (existing) return existing;
      const composed = (async (): Promise<FilesPortalComposition> => {
        const filesPortalReadOperations = createFilesPortalReadOperationModule({
          lane: { workspaceId, eventId: laneEventId },
          readPolicy: FILE_PORTAL_READ_ACCESS_POLICY,
          currentAuthority: participantAuthority,
          clock,
          ids: filesOperationIds,
          authorityPrincipalKeyProfile: filesPortalProfiles.authorityPrincipal,
          scopePartitionProfile: filesPortalProfiles.scopePartition,
          requestCanonicalizationProfile: filesPortalProfiles.requestCanonicalization,
          read: files.portalRead
        });
        const filesPortalCommandOperations = createFilesPortalCommandOperationModule({
          lane: { workspaceId, eventId: laneEventId },
          commandPolicy: FILES_PORTAL_COMMAND_ACCESS_POLICY,
          currentAuthority: participantAuthority,
          clock,
          ids: filesOperationIds,
          authorityPrincipalKeyProfile: filesPortalProfiles.authorityPrincipal,
          scopePartitionProfile: filesPortalProfiles.scopePartition,
          requestCanonicalizationProfile: filesPortalProfiles.requestCanonicalization,
          requestHashSealer: filesPortalRequestHashSealer,
          idempotencyCredentialProfile: filesPortalProfiles.idempotencyCredential,
          idempotencyCredentialSealer: filesPortalIdempotencySealer
        });
        // A second registry, same shared unit of work (the public runtime
        // precedent): the portal command operations reuse the operator
        // command operation names, which one registry cannot carry twice.
        const filesPortalRuntime = await createApplicationOperationRuntime({
          source: composeOperationRegistryModules([
            filesPortalReadOperations,
            filesPortalCommandOperations
          ]),
          read: {
            operationalTrace: { emit() {} },
            immutableAudit: new SQLiteReadImmutableAuditPort(database.sqlite),
            clock,
            newInvocationId: () => parseInvocationId(crypto.randomUUID())
          },
          unitOfWork
        });
        return Object.freeze({
          runtime: filesPortalRuntime,
          adapter: createParticipantOperationsHttpAdapter({
            operations: filesPortalRuntime,
            evidence: participantEvidence
          })
        });
      })();
      composed.catch(() => {
        filesPortalByEvent.delete(laneEventId);
      });
      filesPortalByEvent.set(laneEventId, composed);
      return composed;
    };
    const jsonResponse = (body: unknown, status: number, correlationId: string): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store, max-age=0',
          'x-correlation-id': correlationId
        }
      });
    async function* httpRequestBodyBytes(request: Request): AsyncIterable<Uint8Array> {
      const body = request.body;
      if (!body) return;
      const reader = body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          if (!(chunk.value instanceof Uint8Array)) {
            throw new TypeError('files_upload_body_chunk_invalid');
          }
          yield chunk.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    const webStreamFromAsyncBytes = (
      bytes: AsyncIterable<Uint8Array>
    ): ReadableStream<Uint8Array> => {
      const iterator = bytes[Symbol.asyncIterator]();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          await iterator.return?.();
        }
      });
    };
    const uploadStreamRefusalStatus = Object.freeze({
      intent_not_pending: 409,
      intent_expired: 410,
      byte_cap_exceeded: 413,
      empty_stream: 400,
      image_reencoder_unavailable: 422,
      image_decode_failed: 422,
      image_reencode_invalid: 422
    } as const);
    const respondUploadStream = (
      outcome: StreamUploadBytesResult,
      correlationId: string
    ): Response => outcome.kind === 'stored'
      ? jsonResponse({
          kind: 'stored',
          intent: {
            id: outcome.intent.id,
            contentType: outcome.intent.contentType,
            byteSize: outcome.intent.storedByteSize,
            sha256: outcome.intent.storedSha256
          }
        }, 200, correlationId)
      : jsonResponse(
          { kind: 'refused', code: outcome.code },
          uploadStreamRefusalStatus[outcome.code],
          correlationId
        );
    const downloadRefusalStatus = Object.freeze({
      asset_blocked: 403,
      content_type_not_servable: 415,
      blob_missing: 410
    } as const);
    const respondInertDownload = (
      outcome: InertDownloadOutcome,
      correlationId: string
    ): Response => {
      if (outcome.kind === 'not_found') {
        return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      }
      if (outcome.kind === 'refused') {
        return jsonResponse(
          { kind: 'refused', code: outcome.code },
          downloadRefusalStatus[outcome.code],
          correlationId
        );
      }
      // Serve EXACTLY the inert headers the domain computed: attachment
      // disposition (RFC 5987 pair), nosniff, and the recorded content type.
      return new Response(webStreamFromAsyncBytes(outcome.bytes), {
        status: 200,
        headers: {
          'content-type': outcome.headers.contentType,
          'content-disposition': outcome.headers.contentDisposition,
          'x-content-type-options': outcome.headers.xContentTypeOptions,
          'content-length': String(outcome.byteSize),
          'cache-control': 'no-store, max-age=0',
          'x-correlation-id': correlationId
        }
      });
    };
    const filesOperatorCommandLane = parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: FILES_COMMAND_ACCESS_POLICY
    });
    const filesOperatorReadLane = parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: FILE_READ_ACCESS_POLICY
    });
    const requireFilesOperatorAuthority = async (request: {
      readonly raw: Request;
      readonly method: 'GET' | 'PUT';
      readonly lane: typeof filesOperatorCommandLane;
      readonly operation: {
        readonly name: string;
        readonly version: number;
        readonly effect: 'read' | 'commit';
      };
    }): Promise<
      | {
          readonly kind: 'authorized';
          readonly scope: { readonly workspaceId: string; readonly eventId: string };
          readonly actorUserId: string;
        }
      | { readonly kind: 'refused'; readonly status: 401 | 403 }
      | { readonly kind: 'event_required' }
    > => {
      const verified = await evidence.verify({
        request: request.raw,
        correlationId: crypto.randomUUID(),
        binding: { method: request.method } as Parameters<typeof evidence.verify>[0]['binding']
      });
      if (verified.kind !== 'verified') {
        return {
          kind: 'refused',
          status: verified.reason === 'unauthenticated' ? 401 : 403
        };
      }
      const current = events.readCurrentEventState(workspaceId);
      const currentEventHead = current?.currentEvent;
      if (!currentEventHead) return { kind: 'event_required' };
      const eventId = parseEventId(currentEventHead.id);
      const resolution = await authority.resolver.resolve({
        operation: {
          name: request.operation.name,
          version: request.operation.version,
          effect: request.operation.effect
        },
        evidence: verified.evidence as InvocationEvidence,
        lane: request.lane,
        scope: Object.freeze({
          workspaceId,
          eventId,
          subjects: Object.freeze([
            Object.freeze({ kind: 'workspace' as const, id: workspaceId }),
            Object.freeze({ kind: 'event' as const, id: eventId })
          ]),
          resolutionEvidenceIds: Object.freeze([
            `event-spine-root:${currentEventHead.id}@${currentEventHead.version}`
          ])
        }),
        evaluatedAt: clock.now()
      });
      if (resolution.kind !== 'authorized') return { kind: 'refused', status: 403 };
      const actor = resolution.authority.actor as {
        readonly kind: string;
        readonly userId?: unknown;
      };
      if (actor.kind !== 'workspace_user' || typeof actor.userId !== 'string') {
        return { kind: 'refused', status: 403 };
      }
      return {
        kind: 'authorized',
        scope: { workspaceId, eventId },
        actorUserId: actor.userId
      };
    };
    const resolvePortalFilesActor = (request: Request):
      | {
          readonly kind: 'authorized';
          readonly lane: ParticipantLane;
          readonly participantIdentityId: string;
          readonly engagementIds: readonly string[];
        }
      | { readonly kind: 'unauthenticated' }
      | { readonly kind: 'event_required' } => {
      const lane = resolvePortalLane();
      if (lane === undefined) return Object.freeze({ kind: 'event_required' as const });
      const resolution = resolveParticipantAuthority({
        sessions: participantStore,
        identities: participantStore,
        relationships: participantRelationships,
        lane,
        sessionToken: readPortalSessionToken(request),
        now: parseInstant(new Date().toISOString())
      });
      if (resolution.kind !== 'authorized') {
        return Object.freeze({ kind: 'unauthenticated' as const });
      }
      return Object.freeze({
        kind: 'authorized' as const,
        lane,
        participantIdentityId: resolution.identity.participantIdentityId,
        engagementIds: resolution.relationship.kind === 'related'
          ? resolution.relationship.engagementIds
          : Object.freeze([])
      });
    };
    // The registered portal engagement-files read declares a structured
    // `subject` input that flat GET query parameters cannot express, so this
    // transport translator decodes `?engagementId=` and invokes the exact
    // registered operation through its executor — same authorization, trace,
    // and projection. Registered first, it shadows the adapter's own GET.
    app.get('/api/portal/engagements/files', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const portal = currentFilesPortal();
      if (portal === undefined) {
        return jsonResponse(
          { kind: 'transport_error', code: 'not_available' }, 404, correlationId
        );
      }
      const verified = participantEvidence.verify({
        request: context.req.raw,
        correlationId,
        binding: { method: 'GET' }
      });
      if (verified.kind === 'rejected') {
        return jsonResponse(
          {
            kind: 'transport_error',
            code: verified.reason,
            retryable: false,
            correlationId
          },
          verified.reason === 'unauthenticated' ? 401 : 403,
          correlationId
        );
      }
      const engagementId = fileIdInputSchema.safeParse(context.req.query('engagementId'));
      if (!engagementId.success) {
        return jsonResponse(
          { kind: 'transport_error', code: 'invalid_request', retryable: false, correlationId },
          400,
          correlationId
        );
      }
      try {
        const { runtime: filesPortalRuntime } = await portal;
        const result = await filesPortalRuntime.readExecutor.execute({
          operationName: FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION.name,
          operationVersion: FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION.version,
          surface: 'participant_http',
          correlationId,
          businessInput: {
            subject: { kind: 'engagement', engagementId: engagementId.data }
          },
          verifiedEvidence: verified.evidence
        });
        const parsed = readOperationResultSchema.safeParse(result);
        if (!parsed.success || parsed.data.correlationId !== correlationId) {
          throw new TypeError('files_portal_read_result_invalid');
        }
        return context.json(parsed.data);
      } catch (error) {
        if (error instanceof OperationInputError) {
          return jsonResponse(
            { kind: 'transport_error', code: 'invalid_request', retryable: false, correlationId },
            400,
            correlationId
          );
        }
        console.error('[jooevents] files portal read failed', error);
        return jsonResponse(
          { kind: 'transport_error', code: 'internal_error', retryable: true, correlationId },
          500,
          correlationId
        );
      }
    });
    app.put('/api/portal/files/uploads/:intentId/bytes', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const origin = context.req.header('origin');
      if (!origin || !participantAllowedOrigins.has(origin)) {
        return jsonResponse({ kind: 'refused', code: 'forbidden' }, 403, correlationId);
      }
      const actor = resolvePortalFilesActor(context.req.raw);
      if (actor.kind === 'event_required') {
        return jsonResponse({ kind: 'refused', code: 'event_required' }, 409, correlationId);
      }
      if (actor.kind !== 'authorized') {
        return jsonResponse({ kind: 'refused', code: 'unauthenticated' }, 401, correlationId);
      }
      const intentId = fileIdInputSchema.safeParse(context.req.param('intentId'));
      if (!intentId.success) return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      const scope = {
        workspaceId: actor.lane.workspaceId,
        eventId: actor.lane.eventId
      };
      const intent = files.repository.readIntent(scope, intentId.data);
      if (!intent) return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      if (intent.uploader.kind !== 'participant'
          || intent.uploader.participantIdentityId !== actor.participantIdentityId) {
        return jsonResponse({ kind: 'refused', code: 'not_intent_owner' }, 403, correlationId);
      }
      const outcome = await streamFileUploadBytes({
        intents: files.transactionalIntents,
        intent,
        bytes: httpRequestBodyBytes(context.req.raw),
        blobs: files.blobs,
        imageReEncoder: SHARP_FILE_IMAGE_REENCODER,
        now: new Date().toISOString()
      });
      return respondUploadStream(outcome, correlationId);
    });
    app.get('/api/portal/files/download/:assetId', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const actor = resolvePortalFilesActor(context.req.raw);
      if (actor.kind === 'event_required') {
        return jsonResponse({ kind: 'refused', code: 'event_required' }, 409, correlationId);
      }
      if (actor.kind !== 'authorized') {
        return jsonResponse({ kind: 'refused', code: 'unauthenticated' }, 401, correlationId);
      }
      const assetId = fileIdInputSchema.safeParse(context.req.param('assetId'));
      if (!assetId.success) return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      const scope = {
        workspaceId: actor.lane.workspaceId,
        eventId: actor.lane.eventId
      };
      // Reachability first: the asset must be live material attached to one
      // of the participant's own engagements; anything else is an
      // undistinguishing not-found.
      const reachable = actor.engagementIds.some((engagementId) =>
        files.repository
          .listAttachmentsForSubject(scope, { kind: 'engagement', engagementId })
          .some((attachment) => attachment.state === 'attached'
            && attachment.content.kind === 'asset'
            && attachment.content.assetId === assetId.data));
      if (!reachable) return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      const outcome = await openInertFileDownload({
        assets: files.repository,
        blobs: files.blobs,
        scope,
        assetId: assetId.data
      });
      return respondInertDownload(outcome, correlationId);
    });
    // The portal files operations live in their own registry (operator and
    // portal command modules share operation names, which one registry cannot
    // carry twice), so the main /api/operations/manifest cannot list them.
    // This browser-safe manifest is how the portal client resolves its files
    // bindings; pre-event it answers the same not_available the sibling
    // portal files routes do. Registered before the wildcard forwarder so it
    // wins the match.
    app.get('/api/portal/files/operations/manifest', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const portal = currentFilesPortal();
      if (portal === undefined) {
        return jsonResponse(
          { kind: 'transport_error', code: 'not_available' }, 404, correlationId
        );
      }
      const composition = await portal;
      return jsonResponse(composition.runtime.registry.safeManifest, 200, correlationId);
    });
    // The registered portal files command bindings live in the lazily
    // composed per-event registry; this forwarder hands matching requests to
    // its adapter once a current event exists and fails closed before then.
    app.all('/api/portal/files/*', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const portal = currentFilesPortal();
      if (portal === undefined) {
        return jsonResponse(
          { kind: 'transport_error', code: 'not_available' }, 404, correlationId
        );
      }
      const { adapter } = await portal;
      return adapter.fetch(context.req.raw);
    });
    app.put('/api/events/current/files/uploads/:intentId/bytes', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const origin = context.req.header('origin');
      if (!origin || !participantAllowedOrigins.has(origin)) {
        return jsonResponse({ kind: 'refused', code: 'forbidden' }, 403, correlationId);
      }
      const authorized = await requireFilesOperatorAuthority({
        raw: context.req.raw,
        method: 'PUT',
        lane: filesOperatorCommandLane,
        operation: { name: 'file.upload.intent', version: 1, effect: 'commit' }
      });
      if (authorized.kind === 'refused') {
        return jsonResponse(
          {
            kind: 'refused',
            code: authorized.status === 401 ? 'unauthenticated' : 'forbidden'
          },
          authorized.status,
          correlationId
        );
      }
      if (authorized.kind === 'event_required') {
        return jsonResponse({ kind: 'refused', code: 'event_required' }, 409, correlationId);
      }
      const intentId = fileIdInputSchema.safeParse(context.req.param('intentId'));
      if (!intentId.success) return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      const intent = files.repository.readIntent(authorized.scope, intentId.data);
      if (!intent) return jsonResponse({ kind: 'not_found' }, 404, correlationId);
      if (intent.uploader.kind !== 'operator_user'
          || intent.uploader.userId !== authorized.actorUserId) {
        return jsonResponse({ kind: 'refused', code: 'not_intent_owner' }, 403, correlationId);
      }
      const outcome = await streamFileUploadBytes({
        intents: files.transactionalIntents,
        intent,
        bytes: httpRequestBodyBytes(context.req.raw),
        blobs: files.blobs,
        imageReEncoder: SHARP_FILE_IMAGE_REENCODER,
        now: new Date().toISOString()
      });
      return respondUploadStream(outcome, correlationId);
    });
    app.get('/api/events/current/files/download/:assetId', async (context) => {
      const correlationId = context.res.headers.get('x-correlation-id') ?? crypto.randomUUID();
      const authorized = await requireFilesOperatorAuthority({
        raw: context.req.raw,
        method: 'GET',
        lane: filesOperatorReadLane,
        operation: { name: 'file.overview.read', version: 1, effect: 'read' }
      });
      if (authorized.kind === 'refused') {
        return jsonResponse(
          {
            kind: 'refused',
            code: authorized.status === 401 ? 'unauthenticated' : 'forbidden'
          },
          authorized.status,
          correlationId
        );
      }
      if (authorized.kind === 'event_required') {
        return jsonResponse({ kind: 'refused', code: 'event_required' }, 409, correlationId);
      }
      const assetId = fileIdInputSchema.safeParse(context.req.param('assetId'));
      if (!assetId.success) {
        return jsonResponse({ kind: 'refused', code: 'invalid_request' }, 400, correlationId);
      }
      const outcome = await openInertFileDownload({
        assets: files.repository,
        blobs: files.blobs,
        scope: authorized.scope,
        assetId: assetId.data
      });
      return respondInertDownload(outcome, correlationId);
    });
    // Dev-only fixture control for the hash-only challenge store: it hands out a
    // working magic-link token bypassing the mailbox-possession proof the portal
    // ceremony depends on, so its being dev-only must be STRUCTURAL, not a
    // convention about which composition "is" the dev/test one. The route exists
    // only when a caller sets `devFixtures` — the loopback-bound dev/test entries
    // do; a beyond-loopback deployment does not — so no remote peer can reach a
    // token oracle. It is never mounted through `http/app.ts`. When present it
    // reads the challenge's classified release envelope for the link; delivery
    // history keeps recording the honest terminal not-delivered.
    if (input.devFixtures === true) {
      app.post('/api/portal/entry/dev/issued-link', async (context) => {
        let payload: unknown;
        try { payload = await context.req.json(); } catch { payload = undefined; }
        const email = (payload as { readonly email?: unknown } | undefined)?.email;
        const lane = resolvePortalLane();
        if (typeof email !== 'string' || lane === undefined) {
          return context.json({ kind: 'none' as const });
        }
        let normalizedEmail: string;
        try {
          normalizedEmail = parseParticipantEmail(email).normalizedEmail;
        } catch {
          return context.json({ kind: 'none' as const });
        }
        const row = database.sqlite.query<{
          readonly delivery_id: string | null;
          readonly expires_at_ms: number;
        }, [string, string, string]>(`
          SELECT delivery_id, expires_at_ms FROM participant_sign_in_challenges
           WHERE workspace_id = ? AND event_id = ? AND normalized_email = ? AND state = 'issued'
           ORDER BY requested_at_ms DESC LIMIT 1
        `).get(lane.workspaceId, lane.eventId, normalizedEmail);
        if (!row || row.delivery_id === null) return context.json({ kind: 'none' as const });
        const head = outboundEmailDeliveryLedger.read(row.delivery_id);
        const release = head ? communicationMessageReleases.read(head.releaseId) : undefined;
        // The rendered portal link is the short `${origin}/p/<token>` form —
        // the only form a disposable runtime can contain, since every release
        // was rendered by this very process.
        const match = release
          ? /\/p\/([A-Za-z0-9_-]+)/.exec(release.envelope.textBody)
          : null;
        if (!match) return context.json({ kind: 'none' as const });
        return context.json({
          kind: 'issued' as const,
          url: `/portal/auth/complete?token=${match[1]!}`,
          expiresAt: new Date(row.expires_at_ms).toISOString()
        });
      });
      // The workspace-lane twin of the portal oracle above, under the same
      // structural gating: it reads the newest workspace sign-in link mail for
      // an address from the classified release, so tests can complete the
      // ceremony without a mailbox. Never mounted through `http/app.ts`.
      app.post('/api/entry/dev/issued-link', async (context) => {
        let payload: unknown;
        try { payload = await context.req.json(); } catch { payload = undefined; }
        const email = (payload as { readonly email?: unknown } | undefined)?.email;
        if (typeof email !== 'string') return context.json({ kind: 'none' as const });
        const row = database.sqlite.query<{
          readonly release_id: string;
        }, [string, string]>(`
          SELECT release_id FROM communication_outbound_delivery_heads
           WHERE template_revision_ref_id = ? AND address_lookup_fingerprint_sha256 = ?
           ORDER BY rowid DESC LIMIT 1
        `).get(
          WORKSPACE_SIGN_IN_LINK_TEMPLATE_REVISION_REF_ID,
          workspaceSignInLinkAddressFingerprint(email)
        );
        const release = row ? communicationMessageReleases.read(row.release_id) : undefined;
        // The emailed naked link is the short `${origin}/a/<token>` form.
        const match = release
          ? /(https?:\/\/\S+\/a\/[A-Za-z0-9_-]+)/.exec(release.envelope.textBody)
          : null;
        if (!match) return context.json({ kind: 'none' as const });
        return context.json({ kind: 'issued' as const, url: match[1]! });
      });
    }
    // Owner-lane external-effect executors (runbook §4): mounted ONLY when a
    // provider registration is composed, gated by the same operator evidence
    // verifier and the `communication.provider.manage` policy every provider
    // read already uses. Provider I/O runs inside the executor strictly
    // outside any database transaction; a denied caller gets a typed refusal.
    if (providerActivation !== undefined) {
      const executorActivation = providerActivation;
      const providerManageLane = parseOperationAccessLane({
        kind: 'operator',
        surface: 'operator_http',
        policy: COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY
      });
      const providerManageScope = Object.freeze({
        workspaceId,
        subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: Object.freeze(['workspace.current'])
      });
      const requireProviderManageAuthority = async (
        request: Request,
        operation: { readonly name: string; readonly version: number }
      ): Promise<
        | { readonly kind: 'authorized' }
        | { readonly kind: 'refused'; readonly status: 401 | 403 }
      > => {
        const verified = await evidence.verify({
          request,
          correlationId: crypto.randomUUID(),
          binding: { method: 'POST' } as Parameters<typeof evidence.verify>[0]['binding']
        });
        if (verified.kind !== 'verified') {
          return { kind: 'refused', status: verified.reason === 'unauthenticated' ? 401 : 403 };
        }
        const resolution = await authority.resolver.resolve({
          operation: { name: operation.name, version: operation.version, effect: 'commit' },
          evidence: verified.evidence as InvocationEvidence,
          lane: providerManageLane,
          scope: providerManageScope,
          evaluatedAt: clock.now()
        });
        return resolution.kind === 'authorized'
          ? { kind: 'authorized' }
          : { kind: 'refused', status: 403 };
      };
      app.post('/api/communications/email-readiness/check', async (context) => {
        const authorized = await requireProviderManageAuthority(
          context.req.raw,
          COMMUNICATION_PROVIDER_OPERATIONS.runReadinessCheck
        );
        if (authorized.kind === 'refused') {
          return context.json({ kind: 'refused' as const }, authorized.status);
        }
        const check = await executorActivation.runReadinessCheck();
        return context.json({ kind: 'completed' as const, check });
      });
      app.post('/api/communications/email-diagnostic/send-test', async (context) => {
        const authorized = await requireProviderManageAuthority(
          context.req.raw,
          COMMUNICATION_PROVIDER_OPERATIONS.sendDiagnosticTest
        );
        if (authorized.kind === 'refused') {
          return context.json({ kind: 'refused' as const }, authorized.status);
        }
        let payload: unknown;
        try { payload = await context.req.json(); } catch { payload = undefined; }
        const recipient = (payload as { readonly recipient?: unknown } | undefined)?.recipient;
        if (typeof recipient !== 'string') {
          return context.json({ kind: 'invalid_recipient' as const }, 422);
        }
        let diagnostic;
        try {
          diagnostic = await executorActivation.sendDiagnosticTest({ recipient });
        } catch (error) {
          if (error instanceof TypeError) {
            return context.json({ kind: 'invalid_recipient' as const }, 422);
          }
          throw error;
        }
        return context.json({ kind: 'completed' as const, diagnostic });
      });
    }
    const testSupport = input.devFixtures === true
      ? (() => {
          type OperatorEvidence = Extract<InvocationEvidence, { readonly kind: 'operator' }>;
          const actorEvidence = new WeakMap<EphemeralLiveTestActor, OperatorEvidence>();
          const actorEvidenceByUserId = new Map<string, OperatorEvidence>();
          const requireEvidence = (actor: EphemeralLiveTestActor): OperatorEvidence => {
            const resolved = actorEvidence.get(actor);
            if (!resolved) throw new TypeError('ephemeral_test_actor_not_admitted');
            return resolved;
          };
          const executeRead = async (request: {
            readonly evidence: OperatorEvidence;
            readonly operationName: string;
            readonly operationVersion?: number;
            readonly businessInput?: unknown;
            readonly correlationId?: string;
          }): Promise<ReadOperationResult> => readOperationResultSchema.parse(
            await operations.readExecutor.execute({
              operationName: request.operationName,
              operationVersion: request.operationVersion ?? 1,
              surface: 'operator_http',
              correlationId: request.correlationId ?? crypto.randomUUID(),
              businessInput: request.businessInput ?? {},
              verifiedEvidence: request.evidence
            })
          );
          const executeEffect = async (request: {
            readonly evidence: OperatorEvidence;
            readonly operationName: string;
            readonly operationVersion?: number;
            readonly businessInput: unknown;
            readonly idempotencyKey: string;
            readonly correlationId?: string;
          }): Promise<EffectfulOperationResult> => {
            const invocation = await operations.effectBuilder.build({
              operationName: request.operationName,
              operationVersion: request.operationVersion ?? 1,
              surface: 'operator_http',
              correlationId: request.correlationId ?? crypto.randomUUID(),
              businessInput: request.businessInput,
              verifiedEvidence: request.evidence,
              rawIdempotencyKey: request.idempotencyKey
            });
            return effectfulOperationResultSchema.parse(
              await operations.effectExecutor.execute(invocation)
            );
          };
          const readTeam = async (evidence: OperatorEvidence): Promise<WorkspaceTeamSnapshot> => {
            const result = await executeRead({
              evidence,
              operationName: 'workspace_team.members.read',
              businessInput: {}
            });
            if (result.kind !== 'success') {
              throw new TypeError(`ephemeral_test_team_read_refused:${result.outcome.kind}`);
            }
            return workspaceTeamSnapshotSchema.parse(result.data);
          };
          const createAdmittedActor = async (details: {
            readonly persona: EphemeralLiveTestActorPersona;
            readonly name: string;
            readonly email: string;
          }, membershipReaderEvidence?: OperatorEvidence): Promise<EphemeralLiveTestActor> => {
            const authContext = await auth.$context;
            // Better Auth owns these test principal/session rows. Deliberately
            // leave the principal accountless: the runtime's reviewed
            // first-party email-proof reader recognizes exactly this shape,
            // while JooEvents identity/membership state is still created only
            // by the real reservation admission below.
            const created = await authContext.internalAdapter.createUser({
              name: details.name,
              email: details.email,
              emailVerified: true,
              image: null
            });
            const session = await authContext.internalAdapter.createSession(created.id);
            const secret = input.config.authSecrets[0]?.value;
            if (!secret) throw new TypeError('ephemeral_test_auth_secret_missing');
            const signature = await makeSignature(session.token, secret);
            const cookieName = new URL(input.config.baseUrl).protocol === 'https:'
              ? '__Secure-better-auth.session_token'
              : 'better-auth.session_token';
            const cookie = `${cookieName}=${session.token}.${signature}`;
            const response = await app.request('/api/me/access-context', {
              headers: { cookie, 'x-correlation-id': crypto.randomUUID() }
            });
            if (response.status !== 200) {
              throw new TypeError(`ephemeral_test_admission_http_${response.status}`);
            }
            const access = accessContextSchema.parse(await response.json());
            if (access.state !== 'active' || access.workspace.id !== workspaceId) {
              throw new TypeError(`ephemeral_test_admission_${access.state}`);
            }
            const evidence = Object.freeze({
              kind: 'operator' as const,
              surface: 'operator_http' as const,
              client: Object.freeze({ key: 'test.ephemeral.flow' }),
              sessionHandle: session.id
            });
            const team = await readTeam(membershipReaderEvidence ?? evidence);
            const member = team.members.find((candidate) =>
              candidate.kind === 'member'
              && candidate.status === 'active'
              && candidate.userId === access.user.id
            );
            if (!member || member.kind !== 'member') {
              throw new TypeError('ephemeral_test_admitted_membership_missing');
            }
            const actor = Object.freeze({
              persona: details.persona,
              userId: access.user.id,
              membership: Object.freeze({ id: member.id, version: member.version }),
              cookie
            });
            actorEvidence.set(actor, evidence);
            actorEvidenceByUserId.set(actor.userId, evidence);
            return actor;
          };
          let actors: Promise<{
            readonly organizer: EphemeralLiveTestActor;
            readonly reviewer: EphemeralLiveTestActor;
            readonly secondOrganizer: EphemeralLiveTestActor;
          }> | undefined;
          const bootstrapActors = () => actors ??= (async () => {
            const organizer = await createAdmittedActor({
              persona: 'organizer',
              name: 'Ephemeral Flow Organizer',
              email: input.config.bootstrapOwnerEmail
            });
            const invite = async (
              email: string,
              roleKey: 'speaker_reviewer' | 'event_manager'
            ) => {
              const team = await readTeam(requireEvidence(organizer));
              const result = await executeEffect({
                evidence: requireEvidence(organizer),
                operationName: 'workspace_team.invite',
                businessInput: {
                  email,
                  roleKey,
                  expectedTeamVersion: team.version,
                  expectedTeamDigestSha256: team.digestSha256
                },
                idempotencyKey: `ephemeral-test-invite-${roleKey}`
              });
              if (result.kind !== 'success') {
                throw new TypeError(`ephemeral_test_invite_refused:${result.outcome.kind}`);
              }
            };
            const reviewerEmail = 'flow-reviewer@jooevents.example';
            await invite(reviewerEmail, 'speaker_reviewer');
            const reviewer = await createAdmittedActor({
              persona: 'reviewer',
              name: 'Ephemeral Flow Reviewer',
              email: reviewerEmail
            }, requireEvidence(organizer));
            const secondOrganizerEmail = 'flow-second-organizer@jooevents.example';
            await invite(secondOrganizerEmail, 'event_manager');
            const secondOrganizer = await createAdmittedActor({
              persona: 'second-organizer',
              name: 'Ephemeral Flow Second Organizer',
              email: secondOrganizerEmail
            }, requireEvidence(organizer));
            return Object.freeze({ organizer, reviewer, secondOrganizer });
          })();
          let crashAfterAtomicCommitForBatch: string | undefined;
          const registeredAgentActionExecutor = createRegisteredAgentActionExecutor({
            catalog: agentActionCatalog,
            operationExecutor: Object.freeze({
              async executeRegistered(
                request: Parameters<ApprovedAgentActionOperationExecutionPort['executeRegistered']>[0]
              ) {
                const evidence = actorEvidenceByUserId.get(request.approval.approvedByPrincipalId);
                if (!evidence) {
                  return { kind: 'paused' as const, outcome: { reason: 'approver_not_admitted' } };
                }
                const result = await unitOfWork.executeApprovedAgentActionStep({
                  batchId: request.batchId,
                  stepId: request.stepId,
                  workerId: request.lease.workerId,
                  leaseVersion: request.lease.leaseVersion,
                  leaseExpiresAt: request.lease.leaseExpiresAt,
                  completedAt: request.now,
                  execute: async () => {
                    const invocation = await operations.effectBuilder.build({
                      operationName: request.operation.name,
                      operationVersion: request.operation.version,
                      surface: 'operator_http',
                      correlationId: crypto.randomUUID(),
                      businessInput: request.businessInput,
                      verifiedEvidence: evidence,
                      rawIdempotencyKey: request.semanticIdempotencyKey
                    });
                    return effectfulOperationResultSchema.parse(
                      await operations.effectExecutor.execute(invocation)
                    );
                  }
                });
                if (result.kind === 'success' || result.terminal === true) {
                  if (crashAfterAtomicCommitForBatch === request.batchId) {
                    throw new Error('ephemeral_agent_action_crash_after_atomic_commit');
                  }
                  return { kind: 'succeeded' as const, terminalLogId: result.receipt.id };
                }
                return { kind: 'paused' as const, outcome: result.outcome };
              }
            })
          });
          return Object.freeze({
            publicEffectBindings: () => Object.freeze(
              publicRuntime.registry.publicHttpEffectBindings.map((binding) => Object.freeze({
                operationName: binding.operationName,
                operationVersion: binding.operationVersion,
                method: binding.method,
                path: binding.path
              }))
            ),
            invokeRead: (request: Parameters<EphemeralLiveTestSupport['invokeRead']>[0]) =>
              executeRead({ ...request, evidence: requireEvidence(request.actor) }),
            invokeEffect: (request: Parameters<EphemeralLiveTestSupport['invokeEffect']>[0]) =>
              executeEffect({ ...request, evidence: requireEvidence(request.actor) }),
            bootstrapActors,
            agentActionPlanCatalog: () => Object.freeze({
              registryDigestSha256: operations.registry.manifestDigestSha256,
              operations: agentActionCatalog.entries
            }),
            submitAgentActionPlan: (candidate: unknown) => agentActionPlanSurface.submit(candidate),
            inspectAgentActionRun: (batchId: string) => agentActionPlanSurface.inspect(batchId),
            advanceAgentActionRun: async (
              request: Parameters<EphemeralLiveTestSupport['advanceAgentActionRun']>[0]
            ) => {
              const at = request.at ?? new Date().toISOString();
              const runner = createAgentActionRunner({
                repository: agentActionRuns,
                catalog: agentActionCatalog,
                authority: Object.freeze({
                  recheck({ batch }: Parameters<AgentActionCurrentAuthority['recheck']>[0]) {
                    const approval = batch.approval;
                    return approval
                      && actorEvidenceByUserId.has(approval.approvedByPrincipalId)
                      && batch.plan.scope.workspaceId === workspaceId
                      ? { kind: 'allowed' as const }
                      : { kind: 'paused' as const, reason: 'current_approval_authority_changed' };
                  }
                }) satisfies AgentActionCurrentAuthority,
                executor: registeredAgentActionExecutor,
                now: () => at,
                leaseDurationMs: 60_000
              });
              crashAfterAtomicCommitForBatch = request.crashAfterAtomicCommit
                ? request.batchId
                : undefined;
              try {
                return await runner.advance(request.batchId, request.workerId);
              } finally {
                crashAfterAtomicCommitForBatch = undefined;
              }
            }
          }) satisfies EphemeralLiveTestSupport;
        })()
      : undefined;
    let closed = false;
    let closeResult: ReturnType<EphemeralSQLiteRuntime['close']> | undefined;
    const close = () => {
      if (!closed) {
        if (outboundDispatchPump !== undefined) clearInterval(outboundDispatchPump);
        closeResult = database.close();
        closed = true;
        try {
          if (filesBlobRootDirectory !== undefined) {
            rmSync(filesBlobRootDirectory, { recursive: true, force: true });
          }
        } catch (error) {
          console.error('[jooevents] ephemeral files blob cleanup failed', error);
        }
      }
      return closeResult!;
    };
    // Per-request framing policy over the current event's surface heads —
    // never cached; the surface allowlist is mutable event configuration.
    const embedFraming: EmbedFramingPolicySource = Object.freeze({
      readSurfaceFrameOrigins(kind: Parameters<EmbedFramingPolicySource['readSurfaceFrameOrigins']>[0]) {
        const lane = resolvePortalLane();
        if (lane === undefined) return undefined;
        return releaseRepository.readSurfaceHead(
          { workspaceId: lane.workspaceId, eventId: lane.eventId },
          kind
        )?.allowedFrameOrigins;
      }
    });
    return Object.freeze({
      database,
      auth,
      app,
      workspaceId,
      communications,
      communicationReleases: Object.freeze({
        read: (releaseId: string) => communicationMessageReleases.read(releaseId)
      }),
      outboundDispatch,
      ...(providerActivation === undefined ? {} : { providerActivation }),
      embedFraming,
      files: Object.freeze({
        limits: files.limits,
        blobs: files.blobs,
        repository: files.repository,
        sweepOrphanBlobs: files.sweepOrphanBlobs,
        sweepExpiredIntents: files.sweepExpiredIntents
      }),
      ...(testSupport === undefined ? {} : { testSupport }),
      close
    });
  } catch (error) {
    database.close();
    if (filesBlobRootDirectory !== undefined) {
      try {
        rmSync(filesBlobRootDirectory, { recursive: true, force: true });
      } catch {
        // The boot failure below is the primary fault; cleanup stays best-effort.
      }
    }
    throw error;
  }
}
