import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import {
  createAirtableDirectFeatureContributor,
  createAirtableVerifiedInboxAuthorityResolver,
  RegisteredOperationAirtableInboundPort
} from '@jooevents/airtable-sync';
import {
  assertExternalAgentAuthorityPolicyCatalogCoversOperationRegistry,
  assertOperatorAuthorityPolicyCatalogCoversOperationRegistry,
  API_KEY_MANAGE_ACCESS_POLICY,
  API_KEY_MUTATION_REQUEST_HASH_PROFILE,
  API_KEY_OPERATIONS,
  COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
  COMMUNICATION_PROVIDER_OPERATIONS,
  composeOperationRegistryModules,
  createAgentActionPlanSurface,
  createAgentActionRunner,
  createApiKeyOperationModule,
  createExternalAgentAuthorityResolver,
  getCompiledEffectOperation,
  getCompiledReadOperation,
  resolveOperatorAuthorityPermissionRequirement,
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
  type CurrentOperatorSessionRepository,
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
  issueSynchronousClassifiedPayloadEncryptionProfile,
  sealSynchronousClassifiedPayload
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  accessContextSchema,
  acceleventsExportArtifactReadResultSchema,
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
import { buildAcceleventsPackage, renderAcceleventsLocationsCsv } from '@jooevents/program-export';
import type {
  FormTarget,
  FormTargetReferencePinDto,
  ReleaseScopeDto,
  ReleaseTemplateRevisionPinDto
} from '@jooevents/contracts';
import { fileIdInputSchema } from '@jooevents/contracts/files';
import {
  openInertFileDownload,
  contentDispositionAttachment,
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
  createCommunicationAttentionReadOperationModule,
  createCommunicationDeliveryHistoryReadOperationModule,
  createCommunicationThreadReadOperationModule,
  createCommunicationTimelineReadOperationModule,
  createCommunicationSendOperationModule,
  createOrganizerAudiencePreviewReadOperationModule,
  createOrganizerCommunicationMutationOperationModule,
  createOrganizerCommunicationReadOperationModule,
  createOutboundEmailDeliveryOperationModule,
  createWorkspaceSenderIdentityOperationModule,
  WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
  WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE
} from '@jooevents/communication-operations';
import {
  cloudflareEmailSendingExpectedDnsRecords,
  type CloudflareFetch
} from '@jooevents/cloudflare-email';
import {
  DECISION_NOTIFICATION_MERGE_FIELDS,
  createDeterministicFakeEmailProvider,
  createEmailProviderConfigurationService,
  createEmailProviderReadinessReader,
  createEventCommunicationSeedRendererDefinition,
  createHmacOrganizerPreviewOpaqueTokenCodec,
  createOrganizerMergeRegistryRelease,
  createOrganizerPlainTextRenderStrategyPort,
  type InstallationMailSenderIdentity,
  type OrganizerMergeValueSource
} from '@jooevents/communications';
import {
  DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_OPERATION_KEY_PROFILES,
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
  SPEAKER_LINEUP_MANAGE_ACCESS_POLICY,
  SPEAKER_LINEUP_REQUEST_HASH_PROFILE,
  PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE,
  PORTAL_PARTICIPANT_ACT_ACCESS_POLICY,
  PORTAL_PARTICIPANT_READ_ACCESS_POLICY,
  createEngagementDirectOperationModule,
  createEngagementOperationModule,
  createSpeakerPersonHistoryOperationModule,
  createSpeakerLineupDirectOperationModule,
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
  EVENT_OPERATION_KEY_PROFILES,
  EVENT_SELECT_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
  createEventOperationModule,
  createEventListReadOperationModule,
  createEventSelectOperationModule,
  createEventSettingsReadOperationModule,
  createEventSettingsUpdateOperationModule
} from '@jooevents/event-operations';
import {
  FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  FIELD_REGISTRY_OPERATION_KEY_PROFILES,
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
import {
  ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY,
  ACCELEVENTS_EXPORT_CONFIG_REQUEST_HASH_PROFILE,
  ACCELEVENTS_EXPORT_READ_ACCESS_POLICY,
  createAcceleventsExportConfigOperationModule,
  createAcceleventsExportReadOperationModule,
  ACCELEVENTS_EXPORT_LOCATIONS_READ_OPERATION,
  ACCELEVENTS_EXPORT_PACKAGE_READ_OPERATION
} from '@jooevents/program-export-operations';
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
  TASK_OPERATION_KEY_PROFILES,
  createTaskBoardReadOperationModule,
  createTaskMutationOperationModule
} from '@jooevents/task-operations';
import {
  DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG,
  createOperationHistoryReadOperationModule,
  WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
  createWorkspaceOverviewOperationModule,
  WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
  createWorkspaceShellSummaryOperationModule
} from '@jooevents/workspace-operations';
import {
  DeterministicTemplateEditService,
  starterTemplateArtifacts
} from '@jooevents/template-authoring';
import {
  TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
  TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
  TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES,
  TEMPLATE_EDIT_REQUEST_HASH_PROFILE,
  createTemplateArtifactNativeOperationModule,
  createTemplateArtifactReadOperationModule,
  createTemplateEditOperationModule
} from '@jooevents/template-authoring-operations';
import {
  canonicalJsonText,
  parseApiKeyId,
  parseAuditEventId,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseIntegrationInboxReceiptId,
  parseInvocationId,
  parseJobId,
  parseParticipantIdentityId,
  parseParticipantSessionId,
  parsePersonId,
  parsePublicPolicyRevisionId,
  parseSourceConnectionId,
  parseUserId,
  parseVerifierRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import type { Clock } from '@jooevents/kernel';
import {
  bootstrapEmptyInstall,
  createFoundationEphemeralSQLiteRuntime,
  createSQLiteBetterAuthDatabase,
  createSQLiteAccessRepositories,
  createSQLiteOperatorAuthorityPersistence,
  createSQLiteDeadlineDirectEffectDomainRegistration,
  createSQLiteDecisionDirectEffectDomainRegistration,
  createSQLiteEngagementDirectEffectDomainRegistration,
  createSQLiteSpeakerLineupDirectEffectDomainRegistration,
  SQLiteSpeakerLineupRepository,
  createSQLiteEventEffectDomainRegistration,
  createSQLiteEventSelectEffectDomainRegistration,
  createSQLiteEventSettingsDirectEffectDomainRegistration,
  createSQLiteAcceleventsExportDirectEffectDomainRegistration,
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
  SQLiteApiKeyStore,
  SQLiteApiKeyManagementReadPort,
  SQLiteAcceleventsExportRepository,
  SQLiteExternalApiIdempotencyStore,
  SQLiteExternalApiRateLimiter,
  SQLiteAirtableProjectionContributionAdapter,
  createSQLiteApiKeyEffectDomainRegistration,
  type EphemeralSQLiteRuntime
} from '@jooevents/persistence';
import { createMcpToolRegistry } from '@jooevents/mcp';
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
import {
  createSQLiteMailSenderPresentationResolver
} from '@jooevents/persistence/workspace-sender-identity';
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
  createSQLiteSubmissionConfirmationRegistration,
  seedSubmissionConfirmationPurpose,
  type SubmissionConfirmationRegistrationPort
} from '@jooevents/persistence/submission-confirmation-delivery';
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
import {
  SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR,
  SQLiteSessionRepository,
  createSQLiteSessionProgramReferenceAdapter
} from '@jooevents/persistence/session';
import { SQLiteReviewRepository } from '@jooevents/persistence/review';
import { SQLiteSignalRepository } from '@jooevents/persistence/signals';
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
import {
  createSQLiteWorkspaceShellSummaryProjection
} from '@jooevents/persistence/workspace-shell-summary';
import { createSQLiteOperationHistoryReader } from '@jooevents/persistence/operation-history';
import { createSQLiteSpeakerPersonHistoryReader } from '@jooevents/persistence/speaker-person-history';
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
import { createApiKeyEvidenceVerifier } from '../auth/api-key-evidence';
import { ApiKeySecretDeliveryVault } from '../auth/api-key-secret-delivery';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import { SHARP_FILE_IMAGE_REENCODER } from './file-image-reencoder';
import type { ConfiguredServerConfig, ServerConfig } from '../config';
import type { AirtableProviderConfig } from '../config/airtable';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig,
  type CommunicationsProviderConfig,
  type MailSenderConfig
} from '../config/communications';
import { createHttpApp } from '../http/app';
import { createExternalAgentApi } from '../http/external-agent-api';
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
import {
  AIRTABLE_INTEGRATION_MANAGE_ACCESS_POLICY,
  AIRTABLE_INTEGRATION_READ_ACCESS_POLICY,
  createAirtableLiveRuntime,
  type AirtableLiveRuntime
} from './airtable-live-runtime';
import {
  createBackgroundSupervisor,
  type BackgroundSupervisor,
  type BackgroundSupervisorSnapshot
} from './background-supervisor';
import { createCloudflareTokenVerificationReadinessProbe } from './cloudflare-email-readiness-probe';
import {
  buildDeploymentSenderPresentation,
  createCommunicationSendLane,
  type CommunicationDeliveryRoute,
  type CommunicationSendLane
} from './communication-send-lane';
import {
  CommunicationsProviderActivationError,
  createCommunicationsProviderActivation,
  type CommunicationsProviderActivation
} from './communications-provider-activation';
import {
  createCloudflareApiTokenLease,
  createCommunicationsProviderRuntime,
  type OpaqueSecretTextResolver
} from './communications-provider-runtime';
import { createDeploymentSecretFileResolver } from './deployment-secret-resolver';
import { createDohTxtResolver, DOH_TXT_RESOLVER_KEY } from './doh-txt-resolver';
import {
  createSQLiteCommunicationDeliveryHistorySource
} from './communication-delivery-history';
import {
  createSQLiteCommunicationAttentionSource,
  createSQLiteCommunicationThreadSource,
  createSQLiteCommunicationTimelineSource
} from './communication-organizer-projections';
import { createCommunicationSendOperationRuntime } from './communication-send-operations';
import { createOutboundDispatchLoop, type OutboundDispatchLoop } from './outbound-dispatch-loop';
import { createFilesLiveComposition, type FilesLiveComposition } from './files-live';
import { createWorkspaceSenderIdentityComposition } from './communication-sender-identity-live';
import { createSQLiteOperatorAuthorityComposition } from './operator-authority';
import type { DurableCryptoProfileComposition } from './durable-crypto-profiles';

const eventProfiles = EVENT_OPERATION_KEY_PROFILES;

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

const speakerLineupProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.speaker-lineup.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.speaker-lineup.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.speaker-lineup.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.speaker-lineup.idempotency-credential',
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
  requestHashSealer: DurableCryptoProfileComposition['requestHashSealer'],
  operations: readonly { readonly name: string }[] =
    Object.values(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS)
) {
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
      const profile = Object.freeze({
        key: `request-hash.communication.organizer.${operationName}`,
        version: parseContractVersion(1)
      });
      return requestHashSealer(profile).seal(canonicalRequestBytes);
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

function newUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hexadecimal = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
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
  database: Pick<EphemeralSQLiteRuntime, 'sqlite'>,
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

function bootstrapInitialOwnerPermissionGrants(input: {
  readonly database: Pick<EphemeralSQLiteRuntime, 'sqlite'>;
  readonly ownerReservationId: string;
  readonly mode: 'ephemeral' | 'retained_release';
}): void {
  const insert = input.database.sqlite.query<never, [string, string, string, string]>(`
    INSERT INTO reservation_permission_overrides (
      id, reservation_id, permission_id, effect, scope_kind, event_id, reason
    ) VALUES (?, ?, ?, 'grant', 'workspace', NULL, ?)
  `);
  const releaseGrants = [
    ['program.vocabulary.manage', 'Initial release owner Program Vocabulary grant'],
    ['communication.provider.manage', 'Initial release owner email provider grant'],
    ['integration.api.manage', 'Initial release owner external API grant'],
    ['publication.manage', 'Initial release owner publication grant']
  ] as const;
  const grants = input.mode === 'ephemeral'
    ? [
        ...releaseGrants,
        ['integration.airtable.read', 'Ephemeral live Airtable connection read grant'],
        ['integration.airtable.manage', 'Ephemeral live Airtable connection management grant']
      ] as const
    : releaseGrants;
  for (const [permissionId, reason] of grants) {
    insert.run(crypto.randomUUID(), input.ownerReservationId, permissionId, reason);
  }
}

export interface JoinedLiveDatabaseRuntime {
  readonly sqlite: EphemeralSQLiteRuntime['sqlite'];
  close(): unknown;
}

/**
 * The complete joined application composition over a caller-owned SQLite
 * lifetime. The generic keeps disposable-test and retained-production storage
 * identities distinct while sharing one operation/HTTP composition.
 */
export interface JoinedLiveRuntime<DatabaseRuntime extends JoinedLiveDatabaseRuntime> {
  readonly database: DatabaseRuntime;
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
  /** Named, supervised runtime work and its sanitized operational state. */
  readonly background: {
    snapshot(): BackgroundSupervisorSnapshot;
    runNow(name: string): Promise<boolean>;
  };
  /**
   * Structurally test-only access to the compiled operator executor, real
   * admission path, and a read-only public-binding snapshot. It is absent unless
   * `devFixtures: true`; no member exposes a handler, authority resolver, or
   * database mutation primitive.
   */
  readonly testSupport?: EphemeralLiveTestSupport;
  /** Starts external/background work only after the listener is known-good. */
  startBackgroundWork(): Promise<void>;
  close(): Promise<void>;
}

export type EphemeralLiveRuntime = JoinedLiveRuntime<EphemeralSQLiteRuntime>;

export type EphemeralLiveTestActorPersona = 'organizer' | 'reviewer' | 'second-organizer';

export interface EphemeralLiveTestActor {
  readonly persona: EphemeralLiveTestActorPersona;
  readonly userId: string;
  readonly membership: { readonly id: string; readonly version: number };
  readonly cookie: string;
  readonly sessionHandle: string;
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
  /** Revalidates retained test actors after the configured runtime is reopened. */
  resumeActors(actors: readonly EphemeralLiveTestActor[]): Promise<void>;
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

export interface EphemeralLiveRuntimeOptions {
  readonly config: ServerConfig;
  /**
   * Server-composition-only fixture seam. The runtime neither returns nor
   * routes this clock; ordinary and production entries omit it. It exists so
   * the seeded playground can create a believable historical corpus through
   * the real registered operations without granting time authority to a user.
   */
  readonly devFixtureClock?: Clock;
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
  /** Structurally inert unless the entry supplies a complete OAuth configuration. */
  readonly airtable?: {
    readonly provider: AirtableProviderConfig;
    readonly fetch?: import('@jooevents/airtable').AirtableFetch;
  };
}

type JoinedLiveBlobStorage =
  | { readonly kind: 'ephemeral' }
  | { readonly kind: 'retained'; readonly rootDirectory: string };

type JoinedLiveCryptoProfiles = Pick<
  DurableCryptoProfileComposition,
  'requestHashSealer' | 'idempotencyCredentialSealer' |
  'classifiedPayloadEncryptionProfiles' | 'profileSelection' |
  'withPersistentHmacKey' | 'withPersistentHmacKeySelection'
>;

function assertRetainedCryptoProfileVersionsAvailable(input: {
  readonly sqlite: EphemeralSQLiteRuntime['sqlite'];
  readonly cryptoProfiles: JoinedLiveCryptoProfiles;
}): void {
  const versions = (family: 'classified_payload' | 'persistent_hmac', key: string) =>
    new Set([
      input.cryptoProfiles.profileSelection(family, key).active.version,
      ...input.cryptoProfiles.profileSelection(family, key).retained.map(
        (profile) => profile.version
      )
    ]);
  const classifiedVersions = versions(
    'classified_payload',
    'encryption.retained-reference-check'
  );
  const persistentHmacVersions = versions(
    'persistent_hmac',
    'security.retained-reference-check'
  );
  const unavailableClassified = input.sqlite.query<{ readonly version: number }, []>(`
    SELECT DISTINCT encryption_profile_version AS version
      FROM classified_payload_records
  `).all().some((row) => !classifiedVersions.has(row.version));
  const unavailablePersistent = input.sqlite.query<{ readonly version: number }, []>(`
    SELECT DISTINCT version FROM (
      SELECT principal_profile_version AS version
        FROM public_mutation_continuations_trial
      UNION
      SELECT replay_profile_version AS version
        FROM public_mutation_continuations_trial
      UNION
      SELECT profile_version AS version
        FROM public_mutation_continuation_aliases_trial
      UNION
      SELECT lookup_version AS version
        FROM communication_channel_address_versions
      UNION
      SELECT address_lookup_fingerprint_version AS version
        FROM communication_outbound_delivery_heads
    )
  `).all().some((row) => !persistentHmacVersions.has(row.version));
  if (unavailableClassified || unavailablePersistent) {
    throw new TypeError('retained_crypto_profile_version_unavailable');
  }
}

interface InstallationCryptoCheckEvidence {
  readonly schemaVersion: 1;
  readonly bundleVersion: number;
  readonly requestHashVerifierSha256: string;
  readonly idempotencyVerifierSha256: string;
  readonly classifiedPayloadVerifierSha256: string;
  readonly persistentHmacVerifierSha256: string;
}

async function installationCryptoCheckEvidence(input: {
  readonly cryptoProfiles: JoinedLiveCryptoProfiles;
  readonly workspaceId: string;
  readonly version: number;
}): Promise<InstallationCryptoCheckEvidence> {
  const version = parseContractVersion(input.version);
  const material = canonicalJsonText({
    schemaVersion: 1,
    namespace: 'jooevents.installation.crypto-check',
    workspaceId: input.workspaceId,
    version
  });
  const bytes = new TextEncoder().encode(material);
  const request = await input.cryptoProfiles.requestHashSealer(Object.freeze({
    key: 'installation.crypto-check.request-hash',
    version
  })).seal(bytes);
  const idempotency = await input.cryptoProfiles.idempotencyCredentialSealer(Object.freeze({
    key: 'installation.crypto-check.idempotency',
    version
  })).seal(material);
  const classified = input.cryptoProfiles.classifiedPayloadEncryptionProfiles({
    active: Object.freeze({ key: 'installation.crypto-check.classified-payload', version })
  }).encryptionProfile;
  const authenticatedData = new TextEncoder().encode('jooevents.installation.crypto-check.aad.v1');
  const encrypted = sealSynchronousClassifiedPayload({
    profile: classified,
    plaintext: bytes,
    authenticatedData,
    nonceSource: (size) => new Uint8Array(size).fill(0x5a)
  });
  const classifiedPayloadVerifierSha256 = createHash('sha256')
    .update(encrypted.nonce)
    .update(encrypted.ciphertext)
    .update(encrypted.authenticationTag)
    .digest('hex');
  const persistentHmacVerifierSha256 = input.cryptoProfiles.withPersistentHmacKey(
    Object.freeze({ key: 'installation.crypto-check.persistent-hmac', version }),
    (keyBytes) => createHmac('sha256', keyBytes).update(material, 'utf8').digest('hex')
  );
  bytes.fill(0);
  authenticatedData.fill(0);
  return Object.freeze({
    schemaVersion: 1,
    bundleVersion: version,
    requestHashVerifierSha256: request.verifierSha256,
    idempotencyVerifierSha256: idempotency.verifierSha256,
    classifiedPayloadVerifierSha256,
    persistentHmacVerifierSha256
  });
}

async function assertOrCreateInstallationCryptoChecks(input: {
  readonly sqlite: EphemeralSQLiteRuntime['sqlite'];
  readonly cryptoProfiles: JoinedLiveCryptoProfiles;
  readonly workspaceId: string;
  readonly now: string;
}): Promise<void> {
  const rows = input.sqlite.query<{ readonly evidence_json: string }, [string]>(`
    SELECT evidence_json FROM audit_events
     WHERE workspace_id = ? AND actor_type = 'system'
       AND action = 'bootstrap.crypto.profile_bound'
       AND target_type = 'workspace' AND target_id = workspace_id
     ORDER BY occurred_at, id
  `).all(input.workspaceId);
  const observed = new Set<number>();
  for (const row of rows) {
    try {
      const stored = JSON.parse(row.evidence_json) as InstallationCryptoCheckEvidence;
      if (stored.schemaVersion !== 1 || !Number.isSafeInteger(stored.bundleVersion)
          || stored.bundleVersion < 1 || observed.has(stored.bundleVersion)) {
        throw new TypeError('invalid');
      }
      const expected = await installationCryptoCheckEvidence({
        cryptoProfiles: input.cryptoProfiles,
        workspaceId: input.workspaceId,
        version: stored.bundleVersion
      });
      if (canonicalJsonText(stored) !== canonicalJsonText(expected)) {
        throw new TypeError('invalid');
      }
      observed.add(stored.bundleVersion);
    } catch {
      throw new TypeError('installation_crypto_check_failed');
    }
  }
  const activeVersion = input.cryptoProfiles.profileSelection(
    'persistent_hmac',
    'installation.crypto-check.active-version'
  ).active.version;
  if (observed.has(activeVersion)) return;
  const evidence = await installationCryptoCheckEvidence({
    cryptoProfiles: input.cryptoProfiles,
    workspaceId: input.workspaceId,
    version: activeVersion
  });
  input.sqlite.query(`
    INSERT INTO audit_events (
      id, actor_type, action, target_type, target_id, workspace_id,
      evidence_json, correlation_id, occurred_at
    ) VALUES (?, 'system', 'bootstrap.crypto.profile_bound', 'workspace', ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    input.workspaceId,
    input.workspaceId,
    canonicalJsonText(evidence),
    crypto.randomUUID(),
    Date.parse(input.now)
  );
}

function createEphemeralJoinedLiveCryptoProfiles(): JoinedLiveCryptoProfiles {
  const requestHashSealers = new Map<
    string,
    ReturnType<JoinedLiveCryptoProfiles['requestHashSealer']>
  >();
  const idempotencyCredentialSealers = new Map<
    string,
    ReturnType<JoinedLiveCryptoProfiles['idempotencyCredentialSealer']>
  >();
  const encryptionProfiles = new Map<
    string,
    ReturnType<typeof issueSynchronousClassifiedPayloadEncryptionProfile>
  >();
  const persistentHmacKeys = new Map<string, Uint8Array>();
  const identity = (reference: Readonly<{ key: string; version: number }>) =>
    `${reference.key}@${reference.version}`;
  const encryptionProfile = (
    reference: Parameters<
      JoinedLiveCryptoProfiles['classifiedPayloadEncryptionProfiles']
    >[0]['active']
  ) => {
    const key = identity(reference);
    const existing = encryptionProfiles.get(key);
    if (existing !== undefined) return existing;
    const created = issueSynchronousClassifiedPayloadEncryptionProfile({
      reference,
      keyBytes: randomHmacKey()
    });
    encryptionProfiles.set(key, created);
    return created;
  };
  return Object.freeze({
    requestHashSealer: (profile) => {
      const key = identity(profile);
      const existing = requestHashSealers.get(key);
      if (existing !== undefined) return existing;
      const created = createHmacRequestHashSealer({
        profile,
        keyBytes: randomHmacKey()
      });
      requestHashSealers.set(key, created);
      return created;
    },
    idempotencyCredentialSealer: (profile) => {
      const key = identity(profile);
      const existing = idempotencyCredentialSealers.get(key);
      if (existing !== undefined) return existing;
      const created = createHmacIdempotencyCredentialSealer({
        profile: Object.freeze({
        key: profile.key,
        version: parseContractVersion(profile.version)
        }),
        keyBytes: randomHmacKey()
      });
      idempotencyCredentialSealers.set(key, created);
      return created;
    },
    classifiedPayloadEncryptionProfiles: (selection) => Object.freeze({
      encryptionProfile: encryptionProfile(selection.active),
      retainedEncryptionProfiles: Object.freeze(
        (selection.retained ?? []).map(encryptionProfile)
      )
    }),
    profileSelection: (_family, key) => Object.freeze({
      active: Object.freeze({ key, version: parseContractVersion(1) }),
      retained: Object.freeze([])
    }),
    withPersistentHmacKey: (profile, create) => {
      const key = identity(profile);
      let retained = persistentHmacKeys.get(key);
      if (retained === undefined) {
        retained = randomHmacKey();
        persistentHmacKeys.set(key, retained);
      }
      const temporary = Uint8Array.from(retained);
      try {
        return create(temporary);
      } finally {
        temporary.fill(0);
      }
    },
    withPersistentHmacKeySelection: (key, create) => {
      const reference = Object.freeze({ key, version: parseContractVersion(1) });
      const identityKey = identity(reference);
      let retained = persistentHmacKeys.get(identityKey);
      if (retained === undefined) {
        retained = randomHmacKey();
        persistentHmacKeys.set(identityKey, retained);
      }
      const temporary = Uint8Array.from(retained);
      try {
        return create(Object.freeze({
          active: Object.freeze({ reference, keyBytes: temporary }),
          retained: Object.freeze([])
        }));
      } finally {
        temporary.fill(0);
      }
    }
  });
}

type JoinedLiveRuntimeOptions<DatabaseRuntime extends JoinedLiveDatabaseRuntime> =
  EphemeralLiveRuntimeOptions & {
    readonly database: DatabaseRuntime;
    readonly blobStorage: JoinedLiveBlobStorage;
    readonly cryptoProfiles: JoinedLiveCryptoProfiles;
    readonly initialOwnerGrantMode: 'ephemeral' | 'retained_release';
  };

/** Opens one process-lifetime isolated organizer runtime over a new database. */
export async function createEphemeralLiveRuntime(
  input: EphemeralLiveRuntimeOptions
): Promise<EphemeralLiveRuntime> {
  return createJoinedLiveRuntime({
    ...input,
    database: createFoundationEphemeralSQLiteRuntime(),
    blobStorage: Object.freeze({ kind: 'ephemeral' as const }),
    cryptoProfiles: createEphemeralJoinedLiveCryptoProfiles(),
    initialOwnerGrantMode: 'ephemeral'
  });
}

export type RetainedJoinedLiveRuntime<
  DatabaseRuntime extends JoinedLiveDatabaseRuntime = JoinedLiveDatabaseRuntime
> = JoinedLiveRuntime<DatabaseRuntime>;

export interface RetainedJoinedLiveRuntimeOptions<
  DatabaseRuntime extends JoinedLiveDatabaseRuntime
> extends Omit<EphemeralLiveRuntimeOptions, 'config' | 'devFixtures' | 'devFixtureClock'> {
  readonly config: ConfiguredServerConfig;
  readonly database: DatabaseRuntime;
  readonly blobRootDirectory: string;
}

/**
 * Composes the complete application over caller-owned retained storage. The
 * caller must open/validate SQLite and validate the blob root before calling;
 * this function owns and closes both lifetimes after successful handoff.
 */
export async function createRetainedJoinedLiveRuntime<
  DatabaseRuntime extends JoinedLiveDatabaseRuntime
>(
  input: RetainedJoinedLiveRuntimeOptions<DatabaseRuntime>
): Promise<RetainedJoinedLiveRuntime<DatabaseRuntime>> {
  return createJoinedLiveRuntime({
    ...input,
    blobStorage: Object.freeze({
      kind: 'retained' as const,
      rootDirectory: input.blobRootDirectory
    }),
    cryptoProfiles: input.config.durableCryptoProfiles,
    initialOwnerGrantMode: 'retained_release'
  });
}

/**
 * Test-only retained composition used to drive the production adapters through
 * registered operations before restart/recovery acceptance. Production entries
 * cannot enable fixture routes through the configured runtime constructor.
 */
export async function createRetainedJoinedLiveRuntimeForTesting<
  DatabaseRuntime extends JoinedLiveDatabaseRuntime
>(
  input: RetainedJoinedLiveRuntimeOptions<DatabaseRuntime> & {
    readonly devFixtures: true;
    readonly devFixtureClock?: Clock;
  }
): Promise<RetainedJoinedLiveRuntime<DatabaseRuntime>> {
  if (process.env.NODE_ENV === 'production') {
    throw new TypeError('retained_live_test_fixture_forbidden_in_production');
  }
  return createJoinedLiveRuntime({
    ...input,
    blobStorage: Object.freeze({
      kind: 'retained' as const,
      rootDirectory: input.blobRootDirectory
    }),
    cryptoProfiles: input.config.durableCryptoProfiles,
    initialOwnerGrantMode: 'retained_release'
  });
}

/**
 * One composition root for every SQLite lifetime. Retained callers are added
 * only after durable crypto and role/bootstrap duties can be supplied; keeping
 * this function private prevents an unsafe partial production constructor.
 */
async function createJoinedLiveRuntime<DatabaseRuntime extends JoinedLiveDatabaseRuntime>(
  input: JoinedLiveRuntimeOptions<DatabaseRuntime>
): Promise<JoinedLiveRuntime<DatabaseRuntime>> {
  const database = input.database;
  const cryptoProfiles = input.cryptoProfiles;
  let airtableLive: AirtableLiveRuntime | undefined;
  let backgroundSupervisor: BackgroundSupervisor | undefined;
  let filesBlobRootDirectory: string | undefined;
  try {
    assertRetainedCryptoProfileVersionsAvailable({
      sqlite: database.sqlite,
      cryptoProfiles
    });
    const bootstrap = bootstrapEmptyInstall({
      sqlite: database.sqlite,
      ownerEmail: input.config.bootstrapOwnerEmail,
      workspaceName: 'JooEvents',
      now: new Date().toISOString()
    });
    const workspaceId = parseWorkspaceId(bootstrap.workspaceId);
    await assertOrCreateInstallationCryptoChecks({
      sqlite: database.sqlite,
      cryptoProfiles,
      workspaceId,
      now: new Date().toISOString()
    });
    if (bootstrap.created) {
      bootstrapInitialOwnerPermissionGrants({
        database,
        ownerReservationId: bootstrap.ownerReservationId,
        mode: input.initialOwnerGrantMode
      });
    }
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
    const clock: Clock = input.devFixtureClock ?? Object.freeze({
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
      sqlite: database.sqlite
    });
    const sessionProgramReferenceAdapter = createSQLiteSessionProgramReferenceAdapter({
      sqlite: database.sqlite
    });
    const referenceRegistry = createProgramReferenceContributorRegistry({
      expected: [
        INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
        SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
        SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR
      ],
      contributors: [
        INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
        SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
        SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR
      ]
    });
    const contributorAdapters = createSQLiteProgramVocabularyContributorAdapterRegistry({
      sqlite: database.sqlite,
      expected: [
        INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR,
        SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
        SESSION_PROGRAM_VOCABULARY_CONTRIBUTOR
      ],
      adapters: [
        intakeFormReferenceAdapter,
        scheduleRoomReferenceAdapter,
        sessionProgramReferenceAdapter
      ]
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
    const classifiedStoreOptions = (key: string) => {
      const selected = cryptoProfiles.classifiedPayloadEncryptionProfiles(
        cryptoProfiles.profileSelection('classified_payload', key)
      );
      return Object.freeze({
        encryptionProfile: selected.encryptionProfile,
        retainedEncryptionProfiles: selected.retainedEncryptionProfiles
      });
    };
    const intakeClassifiedStore = new SQLiteClassifiedPayloadStore(
      database.sqlite,
      classifiedStoreOptions('encryption.intake-answer')
    );
    const workspaceTeamClassifiedStore = new SQLiteClassifiedPayloadStore(
      database.sqlite,
      classifiedStoreOptions('encryption.workspace-invitation')
    );
    const organizerCommunicationClassifiedStore = new SQLiteClassifiedPayloadStore(
      database.sqlite,
      {
        ...classifiedStoreOptions('encryption.communication-organizer-payload')
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
        ids: Object.freeze({ newId: () => crypto.randomUUID() }),
        // Advisory deliverability diagnostics ride the same injectable fetch
        // as the provider transport, so tests can fake DNS-over-HTTPS answers
        // and no composition path performs hidden network I/O.
        deliverability: Object.freeze({
          resolver: createDohTxtResolver({
            fetch: input.communications?.fetch
              ?? ((request, init) => globalThis.fetch(request, init))
          }),
          resolverKey: DOH_TXT_RESOLVER_KEY,
          expectedRecords: cloudflareEmailSendingExpectedDnsRecords
        })
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
    const workspaceTeamInvitationLookupProfileKey =
      'security.workspace-invitation-lookup';
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
      store: cryptoProfiles.withPersistentHmacKeySelection(
        workspaceTeamInvitationLookupProfileKey,
        (selection) => createSQLiteProvisioningStore(
          database.sqlite,
          {
            workspaceTeam: createWorkspaceTeamProvisioningSynchronizationPort(
              workspaceTeamRepository
            ),
            workspaceInvitationLookupKeyBytes: selection.active.keyBytes,
            workspaceInvitationRetainedLookupKeyBytes: selection.retained.map(
              (profile) => profile.keyBytes
            )
          }
        )
      ),
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
    const acceleventsExportRepository = new SQLiteAcceleventsExportRepository(
      database.sqlite,
      intakeRepository
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
    const intakePublicKeyProfiles = (key: string) =>
      cryptoProfiles.withPersistentHmacKeySelection(key, (selection) => Object.freeze({
        active: Object.freeze({
          reference: selection.active.reference,
          keyBytes: Uint8Array.from(selection.active.keyBytes)
        }),
        retained: Object.freeze(selection.retained.map((profile) => Object.freeze({
          reference: profile.reference,
          keyBytes: Uint8Array.from(profile.keyBytes)
        })))
      }));
    const intakePublicContinuationProfiles = intakePublicKeyProfiles(
      'key-profile.intake.public-continuation'
    );
    const intakePublicPartitionProfiles = intakePublicKeyProfiles(
      'key-profile.intake.public-partition'
    );
    const intakePublicBootstrapReplayProfiles = intakePublicKeyProfiles(
      'key-profile.intake.public-bootstrap-replay'
    );
    const intakePublicCeremonyBoundary = createPublicMutationContinuationBoundary({
      binding: intakePublicContinuationBinding,
      policies: createApplySurfaceGatedContinuationPolicySource({
        gate: applySurfaceGate,
        binding: intakePublicContinuationBinding,
        security: {
          lifetimeMs: 900_000,
          ...INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
          continuationProfiles: [
            intakePublicContinuationProfiles.active,
            ...intakePublicContinuationProfiles.retained
          ],
          principalPartitionProfile: intakePublicPartitionProfiles.active,
          bootstrapReplayProfile: intakePublicBootstrapReplayProfiles.active
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
    let submissionConfirmationRegistration: SubmissionConfirmationRegistrationPort | undefined;
    const submissionConfirmationForwarder: SubmissionConfirmationRegistrationPort = Object.freeze({
      registerWithinTransaction(
        request: Parameters<SubmissionConfirmationRegistrationPort['registerWithinTransaction']>[0]
      ) {
        if (submissionConfirmationRegistration === undefined) {
          throw new TypeError('submission_confirmation_runtime_not_composed');
        }
        return submissionConfirmationRegistration.registerWithinTransaction(request);
      }
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
      submissionConfirmation: submissionConfirmationForwarder,
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
    const signalRepository = new SQLiteSignalRepository(database.sqlite);
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
        candidateDisplay: reviewRepository,
        accolades: signalRepository
      }))
    });
    const decisionRepository = new SQLiteDecisionRepository({
      sqlite: database.sqlite,
      sessions: sessionRepository,
      environment: decisionEnvironment,
      lineups: new SQLiteSpeakerLineupRepository(database.sqlite)
    });
    const taskRepository = new SQLiteTaskRepository(database.sqlite);
    const taskDeadlineRepository = new SQLiteDeadlineRepository(database.sqlite, events);
    // Live decision-set audience source over the same decision heads and
    // classified intake contacts the mounted Decision and Submissions
    // surfaces serve; identity is personId-bearing evidence, never email.
    const decisionAudienceSource = cryptoProfiles.withPersistentHmacKeySelection(
      'security.communication-address-fingerprint',
      (selection) => createSQLiteDecisionAudienceSource({
        sqlite: database.sqlite,
        contacts: intakeRepository,
        submissions: submissionTriageSource,
        addressFingerprintKeyBytes: selection.active.keyBytes,
        addressFingerprintProfile: Object.freeze({
          key: 'communication.address-fingerprint.hmac-sha256',
          version: selection.active.reference.version
        })
      })
    );
    const taskReminderAudienceSource = createSQLiteTaskReminderAudienceSource({
      sqlite: database.sqlite,
      tasks: taskRepository,
      engagements: new SQLiteEngagementRepository(database.sqlite),
      submissions: submissionTriageSource,
      submissionAddresses: decisionAudienceSource
    });
    const organizerCommunicationPreview = cryptoProfiles.withPersistentHmacKeySelection(
      'security.communication-audience-cursor',
      (cursorSelection) => new SQLiteOrganizerAudiencePreviewRepository(
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
        opaqueTokens: cryptoProfiles.withPersistentHmacKeySelection(
          'security.communication-preview-opaque-token',
          (selection) => createHmacOrganizerPreviewOpaqueTokenCodec({
            keyBytes: selection.active.keyBytes,
            profile: Object.freeze({
              key: 'communication.preview.opaque-token',
              version: selection.active.reference.version
            })
          })
        ),
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
        audienceCursorKeyBytes: cursorSelection.active.keyBytes,
        audienceCursorRetainedKeyBytes: cursorSelection.retained.map(
          (profile) => profile.keyBytes
        ),
        registeredSources: [
          ...decisionAudienceDelegates(decisionAudienceSource),
          taskReminderAudienceSource
        ]
        })
      )
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
        renderer: createEventCommunicationSeedRendererDefinition(),
        now: clock.now()
      });
      mintDecisionAudienceRecipes({
        repository: organizerCommunicationPreview,
        scope,
        purposeRevision: seeded.purposeRevision
      });
      seedTaskReminderPurpose({ sqlite: database.sqlite, scope });
      seedSubmissionConfirmationPurpose({ sqlite: database.sqlite, scope });
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
        newOccurrenceId: () => crypto.randomUUID(),
        newBreakId: () => crypto.randomUUID()
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
    const airtableVerifiedInboxAttribution = Object.freeze({
      resolve(request: { readonly sourceConnectionId: string; readonly workspaceId: string }) {
        const userId = database.sqlite.query<{ readonly user_id: string }, [string, string]>(`
          SELECT membership.user_id
            FROM airtable_sync_connections connection
            JOIN workspace_memberships membership
              ON membership.workspace_id=connection.workspace_id AND membership.status='active'
           WHERE connection.id=? AND connection.workspace_id=? AND connection.state='active'
           ORDER BY membership.created_at,membership.id LIMIT 1
        `).get(request.sourceConnectionId, request.workspaceId)?.user_id;
        return userId ? parseUserId(userId) : undefined;
      }
    });
    const engagementDirectDomain = createSQLiteEngagementDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      verifiedInboxAttribution: airtableVerifiedInboxAttribution
    });
    const speakerLineupDirectDomain = createSQLiteSpeakerLineupDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      newCategoryId: () => crypto.randomUUID()
    });
    const taskDirectDomain = createSQLiteTaskDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      verifiedInboxAttribution: airtableVerifiedInboxAttribution,
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
    const eventSelectDirectDomain = createSQLiteEventSelectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId
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
      lineups: new SQLiteSpeakerLineupRepository(database.sqlite),
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
    const approvedActionSessions = new Map<string, {
      readonly userId: string;
      readonly expiresAt: string;
    }>();
    const internalOperatorSessions: CurrentOperatorSessionRepository = Object.freeze({
      resolveCurrent(
        request: Parameters<CurrentOperatorSessionRepository['resolveCurrent']>[0]
      ) {
        const { sessionHandle, evaluatedAt } = request;
        const session = approvedActionSessions.get(sessionHandle);
        if (!session) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
        if (Date.parse(session.expiresAt) <= Date.parse(evaluatedAt)) {
          return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
        }
        return Object.freeze({
          kind: 'current' as const,
          session: Object.freeze({
            sessionId: sessionHandle,
            authUserId: `approved-agent-action:${session.userId}`,
            userId: parseUserId(session.userId),
            expiresAt: parseInstant(session.expiresAt),
            evidenceIds: Object.freeze([`agent-action-approval:${sessionHandle}`])
          })
        });
      }
    });
    const withApprovedActionSession = async <Value>(input: {
      readonly userId: string;
      readonly expiresAt: string;
      work(evidence: InvocationEvidence): Promise<Value>;
    }): Promise<Value> => {
      const handle = `approved-action-${crypto.randomUUID()}`;
      approvedActionSessions.set(handle, {
        userId: parseUserId(input.userId),
        expiresAt: parseInstant(input.expiresAt)
      });
      try {
        return await input.work(Object.freeze({
          kind: 'operator' as const,
          surface: 'operator_http' as const,
          client: Object.freeze({ key: 'worker.approved-agent-action', version: '1' }),
          sessionHandle: handle
        }));
      } finally {
        approvedActionSessions.delete(handle);
      }
    };
    const authority = createSQLiteOperatorAuthorityComposition({
      sqlite: database.sqlite,
      workspaceId,
      internalSessions: internalOperatorSessions,
      policies: Object.freeze([
        Object.freeze({ policy: EVENT_READ_ACCESS_POLICY, permissionId: 'event.read' as const }),
        Object.freeze({
          policy: API_KEY_MANAGE_ACCESS_POLICY,
          permissionId: 'integration.api.manage' as const
        }),
        Object.freeze({
          policy: AIRTABLE_INTEGRATION_READ_ACCESS_POLICY,
          permissionId: 'integration.airtable.read' as const
        }),
        Object.freeze({
          policy: AIRTABLE_INTEGRATION_MANAGE_ACCESS_POLICY,
          permissionId: 'integration.airtable.manage' as const
        }),
        Object.freeze({
          policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
          permissionId: 'event.read' as const
        }),
        Object.freeze({
          policy: WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
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
          policy: ACCELEVENTS_EXPORT_READ_ACCESS_POLICY,
          permission: Object.freeze({
            kind: 'all_of' as const,
            permissionIds: ['event.read', 'speaker.contact.read'] as const
          })
        }),
        Object.freeze({
          policy: ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
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
          policy: SPEAKER_LINEUP_MANAGE_ACCESS_POLICY,
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
    const apiKeys = new SQLiteApiKeyStore(database.sqlite);
    const externalAuthorityPersistence = createSQLiteOperatorAuthorityPersistence({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships
    });
    const externalAuthority = createExternalAgentAuthorityResolver({
      workspaceId,
      policies: authority.policies,
      apiKeys,
      memberships: externalAuthorityPersistence.memberships,
      authorization: externalAuthorityPersistence.authorization,
      scopeRelationships: externalAuthorityPersistence.scopeRelationships
    });
    const airtableInboundAuthority = createAirtableVerifiedInboxAuthorityResolver({
      policies: Object.freeze([TASK_MANAGE_ACCESS_POLICY, ENGAGEMENT_MANAGE_ACCESS_POLICY]),
      source: Object.freeze({
        async resolve(inboxReceiptId: string) {
          const receiptId = parseIntegrationInboxReceiptId(inboxReceiptId);
          const row = database.sqlite.query<{
            readonly connection_id: string;
            readonly workspace_id: string;
            readonly state: 'active' | 'paused' | 'needs_reconnect' | 'disconnected';
            readonly event_id: string | null;
          }, [string]>(`
            SELECT settle.connection_id,connection.workspace_id,connection.state,
                   COALESCE(task.event_id,engagement.event_id) AS event_id
              FROM airtable_sync_settle_heads settle
              JOIN airtable_sync_connections connection ON connection.id=settle.connection_id
              JOIN airtable_sync_record_links link
                ON link.connection_id=settle.connection_id
               AND link.provider_table_id=settle.provider_table_id
               AND link.provider_record_id=settle.provider_record_id
              LEFT JOIN task_assignments task
                ON link.subject_kind='task_assignment' AND task.id=link.subject_id
              LEFT JOIN engagement_heads engagement
                ON link.subject_kind='engagement' AND engagement.id=link.subject_id
             WHERE settle.id=? LIMIT 2
          `).get(receiptId);
          if (!row?.event_id || row.state !== 'active') return undefined;
          return Object.freeze({
            sourceConnectionId: parseSourceConnectionId(row.connection_id),
            verifierRevisionId: parseVerifierRevisionId('019c30db-4e00-7000-8000-0000000000a1'),
            workspaceId: parseWorkspaceId(row.workspace_id),
            eventId: parseEventId(row.event_id),
            state: row.state
          });
        }
      })
    });
    const currentAuthority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
      resolve(
        resolutionInput: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]
      ) {
        return resolutionInput.lane.kind === 'external_mcp'
          ? externalAuthority.resolve(resolutionInput)
          : resolutionInput.lane.kind === 'verified_inbox'
            ? airtableInboundAuthority.resolve(resolutionInput)
          : authority.resolver.resolve(resolutionInput);
      }
    });
    const apiKeyRead = new SQLiteApiKeyManagementReadPort({
      sqlite: database.sqlite,
      workspaceId,
      ...(input.config.apiKeyPolicy === undefined ? {} : { policy: input.config.apiKeyPolicy }),
      now: () => new Date().toISOString()
    });
    const apiKeyOperations = createApiKeyOperationModule({
      workspaceId,
      policy: API_KEY_MANAGE_ACCESS_POLICY,
      currentAuthority,
      read: apiKeyRead,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(API_KEY_MUTATION_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(eventProfiles.idempotencyCredential)
    });
    const apiKeySecretDelivery = new ApiKeySecretDeliveryVault();
    const apiKeyDomain = createSQLiteApiKeyEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      ...(input.config.apiKeyPolicy === undefined ? {} : { policy: input.config.apiKeyPolicy }),
      now: () => new Date().toISOString(),
      newApiKeyId: () => crypto.randomUUID(),
      secretDelivery: apiKeySecretDelivery
    });
    const requestHashSealer = cryptoProfiles.requestHashSealer(EVENT_CREATE_REQUEST_HASH_PROFILE);
    const idempotencyCredentialSealer = cryptoProfiles.idempotencyCredentialSealer(eventProfiles.idempotencyCredential);
    const eventOperations = createEventOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: EVENT_READ_ACCESS_POLICY,
        manage: EVENT_MANAGE_ACCESS_POLICY
      }),
      currentAuthority,
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
    const eventListOperations = createEventListReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority,
      list: Object.freeze({
        readList(requestedWorkspaceId: typeof workspaceId) {
          if (requestedWorkspaceId !== workspaceId) {
            throw new TypeError('event_list_read_workspace_mismatch');
          }
          const list = events.readEventListProjection(workspaceId);
          if (!list) throw new TypeError('event_workspace_set_missing');
          return list;
        }
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization
    });
    const eventSelectOperations = createEventSelectOperationModule({
      workspaceId,
      managePolicy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(EVENT_SELECT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer
    });
    const eventSettingsReadOperations = createEventSettingsReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority,
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
      currentAuthority,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer
    });
    const workspaceOverviewOperations = createWorkspaceOverviewOperationModule({
      workspaceId,
      policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
      currentAuthority,
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
    const workspaceShellSummaryOperations = createWorkspaceShellSummaryOperationModule({
      workspaceId,
      policy: WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
      currentAuthority,
      read: createSQLiteWorkspaceShellSummaryProjection(database.sqlite),
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
    const acceleventsExportReadOperations = createAcceleventsExportReadOperationModule({
      workspaceId,
      policy: ACCELEVENTS_EXPORT_READ_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      source: Object.freeze({
        readSource(scope: { readonly workspaceId: string; readonly eventId: string }) {
          return acceleventsExportRepository.readSource(scope);
        }
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization
    });
    const acceleventsExportConfigOperations = createAcceleventsExportConfigOperationModule({
      workspaceId,
      policy: ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: eventProfiles.authorityPrincipal,
      scopePartitionProfile: eventProfiles.scopePartition,
      requestCanonicalizationProfile: eventProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(ACCELEVENTS_EXPORT_CONFIG_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer
    });
    const operationHistoryOperations = createOperationHistoryReadOperationModule({
      workspaceId,
      policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
      currentAuthority,
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
      currentAuthority,
      currentEvent,
      currentRead: Object.freeze({
        listCurrent(
          requestedWorkspaceId: typeof workspaceId,
          requestedEventId: ReturnType<typeof parseEventId>
        ) {
          return templateAuthoringRepository.listArtifacts({
            workspaceId: requestedWorkspaceId,
            eventId: requestedEventId
          });
        }
      }),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.requestCanonicalization
    });
    const templateArtifactNativeOperations = createTemplateArtifactNativeOperationModule({
      workspaceId,
      policy: EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.requestCanonicalization,
      draftRequestHashSealer: cryptoProfiles.requestHashSealer(TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE),
      publishRequestHashSealer: cryptoProfiles.requestHashSealer(TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.idempotencyCredential)
    });
    const templateEditOperations = createTemplateEditOperationModule({
      workspaceId,
      policies: { read: EVENT_READ_ACCESS_POLICY, manage: EVENT_MANAGE_ACCESS_POLICY },
      currentAuthority,
      choices: () => templateEditService.choices(),
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(TEMPLATE_EDIT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.idempotencyCredential)
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
      requestHashSealer: createOrganizerCommunicationRequestHashSealer(
        cryptoProfiles.requestHashSealer
      ),
      idempotencyCredentialProfile: organizerCommunicationProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(organizerCommunicationProfiles.idempotencyCredential)
    });
    const organizerCommunicationReadOperations = createOrganizerCommunicationReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority,
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
        currentAuthority,
        currentEvent: organizerCommunicationCurrentEvent,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
		crypto: organizerCommunicationCrypto,
		enabledOperations: [
			'store_communication_authoring_payload',
			'create_message_draft',
			'revise_message_batch',
			'discard_message_draft'
		]
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
        currentAuthority,
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
      currentAuthority,
      currentEvent: organizerCommunicationCurrentEvent,
      adoptionPreparer: communicationSendRuntime.adoptionPreparer,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        ...organizerCommunicationCrypto,
        // The shared communication sealer allowlists per-operation profile
        // keys; the send-lane effects hash under their own operation names.
        requestHashSealer: createOrganizerCommunicationRequestHashSealer(
          cryptoProfiles.requestHashSealer,
          Object.values(COMMUNICATION_SEND_LANE_OPERATIONS)
        )
      })
    });
    const communicationDeliveryHistory = createSQLiteCommunicationDeliveryHistorySource({
      sqlite: database.sqlite
    });
    const communicationDeliveryHistoryOperations =
      createCommunicationDeliveryHistoryReadOperationModule({
        workspaceId,
        policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
        currentAuthority,
        currentEvent: organizerCommunicationCurrentEvent,
        read: communicationDeliveryHistory,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: organizerCommunicationCrypto
      });
    const communicationAttentionOperations = createCommunicationAttentionReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority,
      currentEvent: organizerCommunicationCurrentEvent,
      read: createSQLiteCommunicationAttentionSource({
        authoring: organizerCommunicationAuthoring,
        readiness: emailProviderReadiness,
        history: communicationDeliveryHistory
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: organizerCommunicationCrypto
    });
    const communicationThreadOperations = createCommunicationThreadReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority,
      currentEvent: organizerCommunicationCurrentEvent,
      read: createSQLiteCommunicationThreadSource({
        sqlite: database.sqlite,
        previews: organizerCommunicationPreview
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: organizerCommunicationCrypto
    });
    const communicationTimelineOperations = createCommunicationTimelineReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority: organizerCommunicationPreviewAuthority,
      currentEvent: organizerCommunicationCurrentEvent,
      read: createSQLiteCommunicationTimelineSource({
        sqlite: database.sqlite,
        previews: organizerCommunicationPreview
      }),
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
      requestHashSealer: cryptoProfiles.requestHashSealer(OUTBOUND_DISPATCH_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: outboundDispatchProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(outboundDispatchProfiles.idempotencyCredential)
    });
    const deadlineOperations = createDeadlineOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: DEADLINE_READ_ACCESS_POLICY,
        manage: DEADLINE_MANAGE_ACCESS_POLICY
      }),
      currentAuthority,
      currentEvent,
      deadlineRead: deadlineDirectDomain.deadlineRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: DEADLINE_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: DEADLINE_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: DEADLINE_OPERATION_KEY_PROFILES.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(DEADLINE_CHANGE_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: DEADLINE_OPERATION_KEY_PROFILES.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
        DEADLINE_OPERATION_KEY_PROFILES.idempotencyCredential
      )
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
        if ((resolution.kind !== 'pinned' && resolution.kind !== 'closed')
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
        requestHashSealer: cryptoProfiles.requestHashSealer(INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE),
        idempotencyCredentialProfile: intakeProfiles.idempotencyCredential,
        idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(intakeProfiles.idempotencyCredential)
      })
    });
    const releaseNativeOperations = createReleaseNativeOperationModule({
      workspaceId,
      policy: RELEASE_DRAFT_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: releaseProfiles.authorityPrincipal,
      scopePartitionProfile: releaseProfiles.scopePartition,
      requestCanonicalizationProfile: releaseProfiles.requestCanonicalization,
      draftRequestHashSealer: cryptoProfiles.requestHashSealer(RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE),
      publishRequestHashSealer: cryptoProfiles.requestHashSealer(RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: releaseProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(releaseProfiles.idempotencyCredential)
    });
    const releaseOverviewOperations = createReleaseOverviewOperationModule({
      workspaceId,
      readPolicy: RELEASE_DRAFT_ACCESS_POLICY,
      currentAuthority,
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
    const programVocabularyIdempotencyCredentialSealer = cryptoProfiles.idempotencyCredentialSealer(programVocabularyProfiles.idempotencyCredential);
    const programVocabularyOperations = createProgramVocabularyReadOperationModule({
      workspaceId,
      readPolicy: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
      currentAuthority,
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
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: programVocabularyProfiles.authorityPrincipal,
      scopePartitionProfile: programVocabularyProfiles.scopePartition,
      requestCanonicalizationProfile: programVocabularyProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: programVocabularyProfiles.idempotencyCredential,
      idempotencyCredentialSealer: programVocabularyIdempotencyCredentialSealer
    });
    const programVocabularyMergeOperations = createProgramVocabularyMergeOperationModule({
      workspaceId,
      managePolicy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: programVocabularyProfiles.authorityPrincipal,
      scopePartitionProfile: programVocabularyProfiles.scopePartition,
      requestCanonicalizationProfile: programVocabularyProfiles.requestCanonicalization,
      draftRequestHashSealer: cryptoProfiles.requestHashSealer(PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE),
      publishRequestHashSealer: cryptoProfiles.requestHashSealer(PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: programVocabularyProfiles.idempotencyCredential,
      idempotencyCredentialSealer: programVocabularyIdempotencyCredentialSealer
    });
    const schedulePlacementOperations = createSchedulePlacementOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
        manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
      }),
      currentAuthority,
      currentEvent,
      scheduleRead: schedulePlacementDirectDomain.scheduleRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: schedulePlacementProfiles.authorityPrincipal,
      scopePartitionProfile: schedulePlacementProfiles.scopePartition,
      requestCanonicalizationProfile: schedulePlacementProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: schedulePlacementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(schedulePlacementProfiles.idempotencyCredential)
    });
    const schedulePlacementDirectOperations = createSchedulePlacementDirectOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
        manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
      }),
      currentAuthority,
      currentEvent,
      scheduleRead: schedulePlacementDirectDomain.scheduleRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: schedulePlacementProfiles.authorityPrincipal,
      scopePartitionProfile: schedulePlacementProfiles.scopePartition,
      requestCanonicalizationProfile: schedulePlacementProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: schedulePlacementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(schedulePlacementProfiles.idempotencyCredential)
    });
    const sessionOperations = createSessionOperationModule({
      workspaceId,
      readPolicy: SESSION_READ_ACCESS_POLICY,
      currentAuthority,
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
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: sessionProfiles.authorityPrincipal,
      scopePartitionProfile: sessionProfiles.scopePartition,
      requestCanonicalizationProfile: sessionProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(SESSION_CHANGE_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: sessionProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(sessionProfiles.idempotencyCredential)
    });
    const fieldRegistryOperations = createFieldRegistryOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: FIELD_REGISTRY_READ_ACCESS_POLICY,
        manage: FIELD_REGISTRY_MANAGE_ACCESS_POLICY
      }),
      currentAuthority,
      currentEvent,
      registryRead: fieldRegistryRepository,
      optionSource: fieldRegistryOptionSource,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
        FIELD_REGISTRY_OPERATION_KEY_PROFILES.idempotencyCredential
      )
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
      currentAuthority,
      currentEvent,
      read: Object.freeze({
        listForms: intakeRepository.listForms.bind(intakeRepository),
        readForm: intakeRepository.readFormDetail.bind(intakeRepository),
        readServedForm: intakeRepository.readServedForm.bind(intakeRepository),
        listSubmissions: intakeRepository.listSubmissions.bind(intakeRepository),
        listPersonSubmissions: intakeRepository.listPersonSubmissions.bind(intakeRepository),
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
    const intakeIdempotencyCredentialSealer = cryptoProfiles.idempotencyCredentialSealer(intakeProfiles.idempotencyCredential);
    const intakeFormWriteOperations = createIntakeFormWriteOperationModule({
      workspaceId,
      policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
      scopePartitionProfile: intakeProfiles.scopePartition,
      requestCanonicalizationProfile: intakeProfiles.requestCanonicalization,
      directRequestHashSealer: cryptoProfiles.requestHashSealer(INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE),
      reviewRequestHashSealer: cryptoProfiles.requestHashSealer(INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE),
      publishRequestHashSealer: cryptoProfiles.requestHashSealer(INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: intakeProfiles.idempotencyCredential,
      idempotencyCredentialSealer: intakeIdempotencyCredentialSealer
    });
    const submissionTriageReadOperations = createSubmissionTriageReadOperationModule({
      workspaceId,
      policies: Object.freeze({
        operatorRead: SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
        externalMcpRead: SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY
      }),
      currentAuthority,
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
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: submissionTriageProfiles.authorityPrincipal,
        scopePartitionProfile: submissionTriageProfiles.scopePartition,
        requestCanonicalizationProfile: submissionTriageProfiles.requestCanonicalization,
        requestHashSealer: cryptoProfiles.requestHashSealer(SUBMISSION_TRIAGE_REQUEST_HASH_PROFILE),
        idempotencyCredentialProfile: submissionTriageProfiles.idempotencyCredential,
        idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(submissionTriageProfiles.idempotencyCredential)
      })
    });
    const submissionDirectEntryOperations =
      createSubmissionDirectEntryOperationModule({
        workspaceId,
        policy: SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
        currentAuthority,
        currentEvent,
        clock,
        ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
        crypto: Object.freeze({
          authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
          scopePartitionProfile: intakeProfiles.scopePartition,
          requestCanonicalizationProfile: intakeProfiles.requestCanonicalization,
          requestHashSealer: cryptoProfiles.requestHashSealer(SUBMISSION_DIRECT_ENTRY_REQUEST_HASH_PROFILE),
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
      currentAuthority,
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
      requestHashSealer: cryptoProfiles.requestHashSealer(WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: workspaceTeamProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(workspaceTeamProfiles.idempotencyCredential)
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
      currentAuthority,
      currentEvent,
      viewer: reviewViewer,
      repository: reviewRepository,
      sources: reviewRepository,
      candidateDisplay: reviewRepository,
      accolades: signalRepository,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: reviewProfiles.authorityPrincipal,
      scopePartitionProfile: reviewProfiles.scopePartition,
      requestCanonicalizationProfile: reviewProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(REVIEW_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: reviewProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(reviewProfiles.idempotencyCredential)
    });
    const reviewDirectOperations = createReviewDirectOperationModule({
      workspaceId,
      policies: Object.freeze({
        manage: REVIEW_MANAGE_ACCESS_POLICY,
        stepBack: REVIEW_STEP_BACK_ACCESS_POLICY,
        evaluate: REVIEW_EVALUATE_ACCESS_POLICY
      }),
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: reviewProfiles.authorityPrincipal,
      scopePartitionProfile: reviewProfiles.scopePartition,
      requestCanonicalizationProfile: reviewProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(REVIEW_DIRECT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: reviewProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(reviewProfiles.idempotencyCredential)
    });
    const reviewerRosterOperations = createReviewerRosterOperationModule({
      workspaceId,
      policy: REVIEWER_ROSTER_MANAGE_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      rosterRead: Object.freeze({
        repository: reviewerRosterRepository,
        authority: reviewerAuthoritySource,
        candidatePopulation: reviewRepository
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: reviewerRosterProfiles.authorityPrincipal,
      scopePartitionProfile: reviewerRosterProfiles.scopePartition,
      requestCanonicalizationProfile: reviewerRosterProfiles.requestCanonicalization,
      directRequestHashSealer: cryptoProfiles.requestHashSealer(REVIEWER_ROSTER_DIRECT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: reviewerRosterProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(reviewerRosterProfiles.idempotencyCredential)
    });
    const decisionOperations = createDecisionOperationModule({
      workspaceId,
      readPolicy: DECISION_READ_ACCESS_POLICY,
      currentAuthority,
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
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: decisionProfiles.authorityPrincipal,
      scopePartitionProfile: decisionProfiles.scopePartition,
      requestCanonicalizationProfile: decisionProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(DECISION_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: decisionProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(decisionProfiles.idempotencyCredential)
    });
    const engagementOperations = createEngagementOperationModule({
      workspaceId,
      readPolicy: ENGAGEMENT_READ_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: engagementProfiles.authorityPrincipal,
      scopePartitionProfile: engagementProfiles.scopePartition,
      requestCanonicalizationProfile: engagementProfiles.requestCanonicalization,
      // The same repository instance the decision transaction seeds through;
      // nothing here reads a second copy of engagement state.
      engagements: decisionRepository.engagements,
      lineups: new SQLiteSpeakerLineupRepository(database.sqlite)
    });
    const engagementDirectOperations = createEngagementDirectOperationModule({
      workspaceId,
      managePolicy: ENGAGEMENT_MANAGE_ACCESS_POLICY,
      currentAuthority,
      enableVerifiedInbox: true,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: engagementProfiles.authorityPrincipal,
      scopePartitionProfile: engagementProfiles.scopePartition,
      requestCanonicalizationProfile: engagementProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(ENGAGEMENT_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: engagementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(engagementProfiles.idempotencyCredential)
    });
    const speakerPersonHistoryOperations = createSpeakerPersonHistoryOperationModule({
      workspaceId,
      readPolicy: ENGAGEMENT_READ_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      read: createSQLiteSpeakerPersonHistoryReader(database.sqlite),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: engagementProfiles.authorityPrincipal,
      scopePartitionProfile: engagementProfiles.scopePartition,
      requestCanonicalizationProfile: engagementProfiles.requestCanonicalization
    });
    const speakerLineupDirectOperations = createSpeakerLineupDirectOperationModule({
      workspaceId,
      managePolicy: SPEAKER_LINEUP_MANAGE_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: speakerLineupProfiles.authorityPrincipal,
      scopePartitionProfile: speakerLineupProfiles.scopePartition,
      requestCanonicalizationProfile: speakerLineupProfiles.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(SPEAKER_LINEUP_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: speakerLineupProfiles.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
        speakerLineupProfiles.idempotencyCredential
      )
    });
    const taskBoardOperations = createTaskBoardReadOperationModule({
      workspaceId,
      readPolicy: EVENT_READ_ACCESS_POLICY,
      currentAuthority,
      currentEvent,
      tasks: Object.freeze({
        readCurrent(
          requestedWorkspaceId: typeof workspaceId,
          eventId: ReturnType<typeof parseEventId>
        ) {
          return taskRepository.readTaskBoard({
            workspaceId: requestedWorkspaceId,
            eventId
          });
        }
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: TASK_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: TASK_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: TASK_OPERATION_KEY_PROFILES.requestCanonicalization
    });
    const taskMutationOperations = createTaskMutationOperationModule({
      workspaceId,
      managePolicy: TASK_MANAGE_ACCESS_POLICY,
      currentAuthority,
      enableVerifiedInbox: true,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: TASK_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: TASK_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: TASK_OPERATION_KEY_PROFILES.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(TASK_MUTATION_REQUEST_HASH_PROFILE),
      idempotencyCredentialProfile: TASK_OPERATION_KEY_PROFILES.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
        TASK_OPERATION_KEY_PROFILES.idempotencyCredential
      )
    });
    const eventSettingsDirectDomain =
      createSQLiteEventSettingsDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId
      });
    const acceleventsExportConfigDomain =
      createSQLiteAcceleventsExportDirectEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        intake: intakeRepository,
        newConfigurationId: newUuidV7
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
    const workspaceTeamMutationDomain = cryptoProfiles.withPersistentHmacKeySelection(
      workspaceTeamInvitationLookupProfileKey,
      (selection) =>
        createSQLiteWorkspaceTeamMutationEffectDomainRegistration({
          sqlite: database.sqlite,
          workspaceId,
          classifiedStore: workspaceTeamClassifiedStore,
          invitationLookupKeyBytes: selection.active.keyBytes,
          ids: Object.freeze({
            newPreparationHandle: () => crypto.randomUUID(),
            newReservationId: () => crypto.randomUUID(),
            newReservationRoleAssignmentId: () => crypto.randomUUID(),
            newReleaseIntentId: () => crypto.randomUUID(),
            newHistoryId: () => crypto.randomUUID(),
            newPayloadRefId: () => crypto.randomUUID(),
            newSessionRevocationIntentId: () => crypto.randomUUID()
          })
        })
    );
    const reviewDirectDomain = createSQLiteReviewDirectEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: reviewRepository,
      signals: signalRepository,
      eventRelationships,
      ids: Object.freeze({
        newRoundId: () => crypto.randomUUID(),
        newDeadlineId: () => crypto.randomUUID(),
        newCriterionId: () => crypto.randomUUID(),
        newAssignmentId: () => crypto.randomUUID(),
        newReviewRevisionId: () => crypto.randomUUID(),
        newSignalObservationId: () => crypto.randomUUID()
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
    const submissionConfirmationSenderResolver = createSQLiteMailSenderPresentationResolver({
      sqlite: database.sqlite,
      workspaceId,
      installation: mailSender.configured
        ? Object.freeze({
            fromAddress: mailSender.fromAddress,
            ...(mailSender.fromDisplayName === undefined
              ? {}
              : { fromDisplayName: mailSender.fromDisplayName }),
            ...(mailSender.replyToAddress === undefined
              ? {}
              : { replyToAddress: mailSender.replyToAddress })
          })
        : Object.freeze({ fromAddress: 'events@unconfigured.invalid' })
    });
    const submissionConfirmationPolicySetting =
      process.env.JOOEVENTS_SUBMISSION_CONFIRMATIONS;
    if (submissionConfirmationPolicySetting !== undefined
        && submissionConfirmationPolicySetting !== 'on'
        && submissionConfirmationPolicySetting !== 'off') {
      throw new TypeError('JOOEVENTS_SUBMISSION_CONFIRMATIONS must be on or off');
    }
    submissionConfirmationRegistration = cryptoProfiles.withPersistentHmacKeySelection(
      'security.communication-address-fingerprint',
      (selection) => createSQLiteSubmissionConfirmationRegistration({
        sqlite: database.sqlite,
        intake: intakeRepository,
        submissions: submissionTriageSource,
        releases: communicationMessageReleases,
        senderResolver: submissionConfirmationSenderResolver,
        portalOrigin: input.config.baseUrl,
        purposeRevision: (scope) => seedSubmissionConfirmationPurpose({
          sqlite: database.sqlite,
          scope
        }),
        addressFingerprint: Object.freeze({
          keyBytes: selection.active.keyBytes,
          version: selection.active.reference.version
        }),
        policyActive: submissionConfirmationPolicySetting !== 'off',
        ...(communicationDeliveryRoute === undefined
          ? {}
          : {
              providerRoute: Object.freeze({
                providerConnectionRevisionId:
                  communicationDeliveryRoute.providerConnectionRevisionId
              })
            })
      })
    );
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
        requestHashSealer: cryptoProfiles.requestHashSealer(PORTAL_ENGAGEMENT_RESPOND_REQUEST_HASH_PROFILE),
        idempotencyCredentialProfile: participantPortalProfiles.idempotencyCredential,
        idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(participantPortalProfiles.idempotencyCredential)
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
    filesBlobRootDirectory = input.blobStorage.kind === 'ephemeral'
      ? mkdtempSync(join(tmpdir(), 'jooevents-ephemeral-files-'))
      : input.blobStorage.rootDirectory;
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
    const filesRequestHashSealer = cryptoProfiles.requestHashSealer(FILES_COMMAND_REQUEST_HASH_PROFILE);
    const filesIdempotencyCredentialSealer = cryptoProfiles.idempotencyCredentialSealer(filesProfiles.idempotencyCredential);
    const filesReadOperations = createFilesReadOperationModule({
      workspaceId,
      readPolicy: FILE_READ_ACCESS_POLICY,
      // The external MCP surface carries reads only (agents never move bytes);
      // the lane is registered vocabulary — this composition mounts no MCP
      // transport, so nothing serves it yet.
      mcpReadPolicy: FILE_MCP_READ_ACCESS_POLICY,
      currentAuthority,
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
      currentAuthority,
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
      currentAuthority,
      read: senderIdentity.read,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: senderIdentityProfiles.authorityPrincipal,
        scopePartitionProfile: senderIdentityProfiles.scopePartition,
        requestCanonicalizationProfile: senderIdentityProfiles.requestCanonicalization,
        requestHashSealer: cryptoProfiles.requestHashSealer(WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE),
        idempotencyCredentialProfile: senderIdentityProfiles.idempotencyCredential,
        idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(senderIdentityProfiles.idempotencyCredential)
      })
    });
    const domains = createSQLiteEffectDomainAdapterRegistry([
      eventDirectDomain,
      eventSelectDirectDomain,
      eventSettingsDirectDomain,
      acceleventsExportConfigDomain,
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
      speakerLineupDirectDomain,
      taskDirectDomain,
      ...releaseNativeDomains,
      participantPortalDomain,
      outboundEmailDeliveryDomain,
      intakePublicMutationDomain,
      files.effectDomain,
      senderIdentity.effectDomain,
      ...organizerCommunicationAuthoringDomains,
      ...communicationSendRuntime.effectDomains,
      apiKeyDomain
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
          : recheckInput.lane.kind === 'verified_inbox'
            ? airtableInboundAuthority.resolve(recheckInput)
            : authority.effectRecheckSource.resolveAuthority(recheckInput),
      now: authority.effectRecheckSource.now
    });
    const airtableProjectionContribution = new SQLiteAirtableProjectionContributionAdapter(
      database.sqlite,
      () => crypto.randomUUID(),
      Object.freeze({
        async publish(wake: { readonly connectionId: string }) { airtableLive?.wake(wake.connectionId); }
      })
    );
    const unitOfWork = new SQLiteEffectUnitOfWorkPort(
      database.sqlite,
      domains,
      effectRecheckSource,
      {},
      airtableProjectionContribution
    );
    const source = composeOperationRegistryModules([
      apiKeyOperations,
      workspaceShellSummaryOperations,
      workspaceOverviewOperations,
      operationHistoryOperations,
      eventOperations,
      eventListOperations,
      eventSelectOperations,
      eventSettingsReadOperations,
      eventSettingsUpdateOperations,
      acceleventsExportReadOperations,
      acceleventsExportConfigOperations,
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
      speakerPersonHistoryOperations,
      engagementDirectOperations,
      speakerLineupDirectOperations,
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
      communicationAttentionOperations,
      communicationThreadOperations,
      communicationTimelineOperations,
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
      unitOfWork,
      directFeatureContributor: createAirtableDirectFeatureContributor()
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
    assertExternalAgentAuthorityPolicyCatalogCoversOperationRegistry({
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
    // One retained SQLite connection is shared by HTTP and supervised jobs.
    // Every asynchronous owner enters this boundary before touching it.
    const requestSerialization = createSerialHttpRequestBoundary();
    if (input.airtable) {
      const readLane = parseOperationAccessLane({
        kind: 'operator', surface: 'operator_http', policy: AIRTABLE_INTEGRATION_READ_ACCESS_POLICY
      });
      const manageLane = parseOperationAccessLane({
        kind: 'operator', surface: 'operator_http', policy: AIRTABLE_INTEGRATION_MANAGE_ACCESS_POLICY
      });
      airtableLive = createAirtableLiveRuntime({
        sqlite: database.sqlite,
        workspaceId,
        baseUrl: input.config.baseUrl,
        config: input.airtable.provider,
        serializeWork: (work) => requestSerialization.run(work),
        ...(input.airtable.fetch ? { fetch: input.airtable.fetch } : {}),
        controlledOperationsForClaim: (claim) => new RegisteredOperationAirtableInboundPort({
          builder: operations.effectBuilder,
          executor: operations.effectExecutor,
          verifiedInboxEvidence: Object.freeze({
            kind: 'verified_inbox' as const,
            surface: 'provider_ingress' as const,
            client: Object.freeze({ key: 'airtable.sync', version: '1' }),
            inboxReceiptId: parseIntegrationInboxReceiptId(claim.settleId)
          } satisfies InvocationEvidence),
          deletionReview: Object.freeze({
            async request() {
              database.sqlite.query(`
                INSERT INTO airtable_sync_boundary_observations(
                  id,connection_id,record_link_id,field_key,kind,classification,
                  before_json,after_json,inbox_receipt_id,occurred_at_ms
                )
                SELECT ?,settle.connection_id,link.id,'record.deleted','request','ordinary',
                       '{"deleted":false}','{"deleted":true}',settle.id,?
                  FROM airtable_sync_settle_heads settle
                  JOIN airtable_sync_record_links link
                    ON link.connection_id=settle.connection_id
                   AND link.provider_table_id=settle.provider_table_id
                   AND link.provider_record_id=settle.provider_record_id
                 WHERE settle.id=?
                   AND NOT EXISTS (
                     SELECT 1 FROM airtable_sync_boundary_observations prior
                      WHERE prior.connection_id=settle.connection_id
                        AND prior.inbox_receipt_id=settle.id
                        AND prior.field_key='record.deleted' AND prior.kind='request'
                   )
              `).run(crypto.randomUUID(), Date.parse(clock.now()), claim.settleId);
              return Object.freeze({
                kind: 'applied' as const,
                operationReceiptId: `airtable-deletion-review:${claim.settleId}`
              });
            }
          }),
          newCorrelationId: () => crypto.randomUUID()
        }),
        async authorize(request) {
          const verified = await evidence.verify({
            request: request.request,
            correlationId: crypto.randomUUID(),
            binding: { method: request.request.method } as Parameters<typeof evidence.verify>[0]['binding']
          });
          if (verified.kind !== 'verified') return verified.reason;
          const read = request.action === 'read';
          const resolution = await authority.resolver.resolve({
            operation: {
              name: read ? 'airtable.integration.read' : 'airtable.integration.manage',
              version: 1,
              effect: read ? 'read' : 'commit'
            },
            evidence: verified.evidence as InvocationEvidence,
            lane: read ? readLane : manageLane,
            scope: Object.freeze({
              workspaceId,
              subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
              resolutionEvidenceIds: Object.freeze(['workspace.current'])
            }),
            evaluatedAt: clock.now()
          });
          return resolution.kind === 'authorized' ? 'authorized' : 'forbidden';
        }
      });
    }
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
    const app = createHttpApp({
      auth,
      accessContext,
      workspaceId,
      baseUrl: input.config.baseUrl,
      operatorOperations: { operations, evidence },
      acceleventsExportDownload: Object.freeze({
        async download(downloadInput: {
          readonly kind: 'locations' | 'package';
          readonly request: Request;
          readonly releaseId: string;
          readonly correlationId: string;
        }) {
          const operation = downloadInput.kind === 'locations'
            ? ACCELEVENTS_EXPORT_LOCATIONS_READ_OPERATION
            : ACCELEVENTS_EXPORT_PACKAGE_READ_OPERATION;
          const binding = operations.registry.operatorHttpBindings.find((candidate) =>
            candidate.operationName === operation.name
            && candidate.operationVersion === operation.version
          );
          if (!binding) throw new TypeError('accelevents_export_download_binding_missing');
          const verified = await evidence.verify({
            request: downloadInput.request,
            correlationId: downloadInput.correlationId,
            binding
          });
          if (verified.kind !== 'verified') {
            return Response.json(
              { code: verified.reason, retryable: false, correlationId: downloadInput.correlationId },
              { status: verified.reason === 'unauthenticated' ? 401 : 403 }
            );
          }
          const result = acceleventsExportArtifactReadResultSchema.parse(
            await operations.readExecutor.execute({
              operationName: operation.name,
              operationVersion: operation.version,
              surface: 'operator_http',
              correlationId: downloadInput.correlationId,
              businessInput: { releaseId: downloadInput.releaseId },
              verifiedEvidence: verified.evidence
            })
          );
          if (result.kind !== 'success') {
            const status = result.outcome.class === 'access_denied' ? 403 : 409;
            return Response.json({
              code: result.outcome.kind,
              message: 'The export is not ready. Reload the preparation and resolve its blockers.',
              retryable: result.outcome.retryable,
              correlationId: downloadInput.correlationId
            }, { status });
          }
          const current = currentEvent.resolveCurrentEvent(workspaceId);
          if (!current.eventId) {
            return Response.json({ code: 'event_required', retryable: false, correlationId: downloadInput.correlationId }, { status: 409 });
          }
          const source = acceleventsExportRepository.readSource({ workspaceId, eventId: current.eventId });
          const artifact = downloadInput.kind === 'locations'
            ? {
                bytes: new TextEncoder().encode(renderAcceleventsLocationsCsv(source)),
                filename: 'locations.csv',
                contentType: 'text/csv; charset=utf-8'
              }
            : (() => {
                const built = buildAcceleventsPackage(source, result.data.generatedAt);
                return { bytes: built.bytes, filename: built.filename, contentType: 'application/zip' };
              })();
          return new Response(new Uint8Array(artifact.bytes).buffer, {
            status: 200,
            headers: {
              'content-type': artifact.contentType,
              'content-disposition': contentDispositionAttachment(artifact.filename),
              'content-length': String(artifact.bytes.byteLength),
              'cache-control': 'no-store, max-age=0',
              'x-content-type-options': 'nosniff',
              'x-correlation-id': downloadInput.correlationId
            }
          });
        }
      }),
      participantEntry: participantEntryRuntime,
      participantOperations: { operations, evidence: participantEvidence },
      ...(airtableLive ? {
        airtableIntegration: airtableLive.integration,
        airtableWebhookIngress: airtableLive.webhookIngress
      } : {}),
      health: Object.freeze({
        read: () => Object.freeze({
          ok: true as const,
          background: backgroundSupervisor!.snapshot()
        })
      }),
      requestSerialization
    });
    const apiKeyManageLane = parseOperationAccessLane({
      kind: 'operator', surface: 'operator_http', policy: API_KEY_MANAGE_ACCESS_POLICY
    });
    app.post('/api/workspace/api-key-secrets/:handle', async (context) => {
      const handle = context.req.param('handle');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(handle)) {
        return context.json({ kind: 'unavailable' as const }, 404);
      }
      const verified = await evidence.verify({
        request: context.req.raw,
        correlationId: context.get('correlationId' as never) as string,
        binding: { method: 'POST' } as Parameters<typeof evidence.verify>[0]['binding']
      });
      if (verified.kind !== 'verified') {
        return context.json(
          { kind: 'unavailable' as const },
          verified.reason === 'unauthenticated' ? 401 : 403
        );
      }
      const resolution = await authority.resolver.resolve({
        operation: { ...API_KEY_OPERATIONS.create, effect: 'commit' },
        evidence: verified.evidence as InvocationEvidence,
        lane: apiKeyManageLane,
        scope: Object.freeze({
          workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
          resolutionEvidenceIds: Object.freeze(['workspace.current'])
        }),
        evaluatedAt: clock.now()
      });
      if (resolution.kind !== 'authorized' || resolution.authority.actor.kind !== 'workspace_user') {
        return context.json({ kind: 'unavailable' as const }, 403);
      }
      const secret = apiKeySecretDelivery.consume(handle, resolution.authority.actor.userId);
      return secret === undefined
        ? context.json({ kind: 'unavailable' as const }, 404)
        : context.json({ kind: 'delivered' as const, secret });
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
    const agentActionAuthority: AgentActionCurrentAuthority = Object.freeze({
      async recheck(request: Parameters<AgentActionCurrentAuthority['recheck']>[0]) {
        const { batch, step, now } = request;
        const approval = batch.approval;
        if (!approval || batch.plan.scope.workspaceId !== workspaceId) {
          return { kind: 'paused' as const, reason: 'current_approval_authority_changed' };
        }
        const compiled = getCompiledEffectOperation(
          operations.registry,
          step.operationName,
          step.operationVersion,
          'operator_http'
        );
        const lane = compiled?.operation.definition.accessLanes.find(
          (candidate) => candidate.kind === 'operator' && candidate.surface === 'operator_http'
        );
        if (!compiled || !lane) {
          return { kind: 'paused' as const, reason: 'operation_authority_lane_unavailable' };
        }
        const scope = Object.freeze({
          workspaceId,
          ...(batch.plan.scope.eventId === undefined
            ? {}
            : { eventId: parseEventId(batch.plan.scope.eventId) }),
          subjects: Object.freeze(batch.plan.scope.subjects.map((subject) => Object.freeze({
            kind: subject.type,
            id: subject.id
          }))),
          resolutionEvidenceIds: Object.freeze([
            `agent-action-batch:${batch.plan.batchId}`,
            `agent-action-step:${step.id}`
          ])
        }) as Parameters<typeof authority.resolver.resolve>[0]['scope'];
        const requirement = resolveOperatorAuthorityPermissionRequirement({
          catalog: authority.policies,
          policy: lane.policy,
          scope
        });
        if (!requirement) {
          return { kind: 'paused' as const, reason: 'operation_authority_policy_unavailable' };
        }

        if (batch.plan.source.surface === 'external_mcp') {
          const match = /^api-key:([0-9a-f-]{36})$/.exec(batch.plan.source.clientKey);
          const key = match ? apiKeys.get(parseApiKeyId(match[1]!)) : undefined;
          const eventAllowed = key && (key.eventIds.length === 0
            || (batch.plan.scope.eventId !== undefined
              && key.eventIds.includes(parseEventId(batch.plan.scope.eventId))));
          const grantAllows = key && (requirement.kind === 'all_of'
            ? requirement.permissionIds.every((permissionId) => key.permissionIds.includes(permissionId))
            : requirement.permissionIds.some((permissionId) => key.permissionIds.includes(permissionId)));
          if (!key
              || key.workspaceId !== workspaceId
              || key.ownerUserId !== parseUserId(batch.plan.source.proposingPrincipalId)
              || key.standing !== 'active'
              || !key.maySubmitPlans
              || (key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.parse(now))
              || !eventAllowed
              || !grantAllows) {
            return { kind: 'paused' as const, reason: 'current_source_grant_changed' };
          }
          const relationship = await externalAuthorityPersistence.scopeRelationships.validate({
            userId: key.ownerUserId,
            scope,
            evaluatedAt: parseInstant(now)
          });
          const membership = await externalAuthorityPersistence.memberships.find(
            workspaceId,
            key.ownerUserId
          );
          const roles = await externalAuthorityPersistence.authorization.listRoles(workspaceId);
          const assignments = await externalAuthorityPersistence.authorization.listAssignments(
            workspaceId,
            key.ownerUserId
          );
          const overrides = await externalAuthorityPersistence.authorization.listOverrides(
            workspaceId,
            key.ownerUserId
          );
          const requestedScope = batch.plan.scope.eventId === undefined
            ? { kind: 'workspace' as const, workspaceId }
            : {
                kind: 'event' as const,
                workspaceId,
                eventId: parseEventId(batch.plan.scope.eventId)
              };
          const sourceStillAllowed = relationship.kind === 'valid'
            && (requirement.kind === 'all_of'
              ? requirement.permissionIds.every((permissionId) => evaluateAccess({
                  userId: key.ownerUserId,
                  permissionId,
                  requestedScope,
                  ...(membership ? { membership } : {}),
                  roles,
                  assignments,
                  overrides,
                  now: parseInstant(now)
                }).allowed)
              : requirement.permissionIds.some((permissionId) => evaluateAccess({
                  userId: key.ownerUserId,
                  permissionId,
                  requestedScope,
                  ...(membership ? { membership } : {}),
                  roles,
                  assignments,
                  overrides,
                  now: parseInstant(now)
                }).allowed));
          if (!sourceStillAllowed) {
            return { kind: 'paused' as const, reason: 'current_source_authority_changed' };
          }
        } else if (!(input.devFixtures === true
          && batch.plan.source.clientKey.startsWith('test.'))) {
          // App-model execution is activated only with a durable model-run
          // authority reader. No such production adapter is composed yet.
          return { kind: 'paused' as const, reason: 'current_source_grant_unavailable' };
        }

        return withApprovedActionSession({
          userId: approval.approvedByPrincipalId,
          expiresAt: approval.approvalExpiresAt,
          async work(evidence) {
            const resolution = await authority.resolver.resolve({
              operation: {
                name: step.operationName,
                version: step.operationVersion,
                effect: compiled.operation.definition.effect
              },
              evidence,
              lane,
              scope,
              evaluatedAt: parseInstant(now)
            });
            return resolution.kind === 'authorized'
              ? { kind: 'allowed' as const }
              : {
                  kind: 'paused' as const,
                  reason: 'current_approval_authority_changed',
                  detail: { denial: resolution.reason }
                };
          }
        });
      }
    });
    let crashAfterAtomicCommitForBatch: string | undefined;
    const registeredAgentActionExecutor = createRegisteredAgentActionExecutor({
      catalog: agentActionCatalog,
      operationExecutor: Object.freeze({
        async executeRegistered(
          request: Parameters<ApprovedAgentActionOperationExecutionPort['executeRegistered']>[0]
        ) {
          const result = await withApprovedActionSession({
            userId: request.approval.approvedByPrincipalId,
            expiresAt: request.approval.approvalExpiresAt,
            async work(evidence) {
              return unitOfWork.executeApprovedAgentActionStep({
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
    const createLiveAgentActionRunner = (at?: string) => createAgentActionRunner({
      repository: agentActionRuns,
      catalog: agentActionCatalog,
      authority: agentActionAuthority,
      executor: registeredAgentActionExecutor,
      now: () => at ?? new Date().toISOString(),
      leaseDurationMs: 60_000
    });
    const actionWorkerId = `agent-action:${crypto.randomUUID()}`;
    backgroundSupervisor = createBackgroundSupervisor({
      jobs: Object.freeze([
        ...(providerRuntime.registration?.delivery
          ? [{
              name: 'outbound_email_dispatch',
              intervalMs: 2_000,
              runOnStart: true,
              async run() {
                await requestSerialization.run(async () => {
                  await outboundDispatch.runOnce();
                  for (const fault of outboundDispatch.faults()) {
                    console.error(
                      `[jooevents] outbound delivery ${fault.deliveryId} failed`,
                      fault.error
                    );
                  }
                });
              }
            }]
          : []),
        {
          name: 'approved_agent_actions',
          intervalMs: 1_000,
          runOnStart: true,
          async run() {
            await requestSerialization.run(async () => {
              const batches = [
                ...agentActionRuns.list({ status: 'queued', limit: 100 }),
                ...agentActionRuns.list({ status: 'running', limit: 100 }),
                ...agentActionRuns.list({ status: 'cancel_requested', limit: 100 })
              ];
              let failed = false;
              for (const batch of batches) {
                try {
                  await createLiveAgentActionRunner().advance(
                    batch.plan.batchId,
                    actionWorkerId
                  );
                } catch (error) {
                  failed = true;
                  console.error(
                    `[jooevents] approved action batch ${batch.plan.batchId} failed to advance`,
                    error
                  );
                }
              }
              if (failed) throw new Error('agent_action_advance_failed');
            });
          }
        },
        {
          name: 'expired_file_intents',
          intervalMs: 5 * 60_000,
          runOnStart: true,
          run: () => requestSerialization.run(() => files.sweepExpiredIntents()).then(() => {})
        },
        {
          name: 'orphan_file_blobs',
          intervalMs: 60 * 60_000,
          runOnStart: true,
          run: () => requestSerialization.run(() => files.sweepOrphanBlobs()).then(() => {})
        }
      ]),
      onError(jobName, error) {
        console.error(`[jooevents] background job ${jobName} failed`, error);
      }
    });
    const externalToolRegistry = await createMcpToolRegistry(
      operations.registry.safeManifest,
      { enableCommitTools: false }
    );
    const externalRateLimiter = new SQLiteExternalApiRateLimiter(database.sqlite);
    const externalIdempotency = new SQLiteExternalApiIdempotencyStore(database.sqlite);
    app.route('/', createExternalAgentApi({
      operations,
      tools: externalToolRegistry,
      evidence: createApiKeyEvidenceVerifier({
        workspaceId,
        apiKeys,
        now: () => new Date().toISOString(),
        ownerIsCurrent(key) {
          return database.sqlite.query<{ readonly current: number }, [string, string]>(`
            SELECT 1 AS current FROM workspace_memberships
             WHERE workspace_id=? AND user_id=? AND status='active'
          `).get(key.workspaceId, key.ownerUserId)?.current === 1;
        }
      }),
      owner: Object.freeze({
        displayName(key) {
          return database.sqlite.query<{ readonly display_name: string }, [string]>(
            'SELECT display_name FROM users WHERE id = ?'
          ).get(key.ownerUserId)?.display_name ?? 'Unknown user';
        }
      }),
      rateLimiter: externalRateLimiter,
      idempotency: externalIdempotency,
      idempotencySealer: idempotencyCredentialSealer,
      plans: agentActionPlanSurface,
      planRepository: agentActionRuns,
      planOperations: agentActionCatalog.entries,
      now: () => new Date().toISOString(),
      reviewUrl: (batchId) => `/app/approvals?batchId=${encodeURIComponent(batchId)}`,
      clientAddress(request) {
        return request.headers.get('cf-connecting-ip')
          ?? request.headers.get('x-real-ip')
          ?? 'unavailable';
      },
      ...(input.config.externalAgentApiPolicy === undefined
        ? {}
        : { policy: input.config.externalAgentApiPolicy }),
      async toolAvailability(key, tool) {
        const compiled = getCompiledReadOperation(
          operations.registry,
          tool.contract.operation.name,
          tool.contract.operation.version,
          'external_mcp'
        );
        const lane = compiled?.operation.definition.accessLanes.find(
          (lane) => lane.kind === 'external_mcp' && lane.surface === 'external_mcp'
        );
        if (!compiled || !lane) {
          return { state: 'locked_owner' as const, permissionIds: ['event.read'], note: 'The operation policy is not available in this workspace.' };
        }
        const current = events.readCurrentEventState(workspaceId)?.currentEvent;
        const scope = Object.freeze({
          workspaceId,
          ...(current ? { eventId: parseEventId(current.id) } : {}),
          subjects: Object.freeze([
            Object.freeze({ kind: 'workspace' as const, id: workspaceId }),
            ...(current ? [Object.freeze({ kind: 'event' as const, id: parseEventId(current.id) })] : [])
          ]),
          resolutionEvidenceIds: Object.freeze(['external-tool-catalog.current'])
        });
        const requirement = resolveOperatorAuthorityPermissionRequirement({
          catalog: authority.policies,
          policy: lane.policy,
          scope
        });
        if (!requirement) {
          return { state: 'locked_owner' as const, permissionIds: ['event.read'], note: 'The owner cannot reach this tool in the current scope.' };
        }
        const relationship = await externalAuthorityPersistence.scopeRelationships.validate({
          userId: key.ownerUserId, scope, evaluatedAt: clock.now()
        });
        const membership = await externalAuthorityPersistence.memberships.find(workspaceId, key.ownerUserId);
        const roles = await externalAuthorityPersistence.authorization.listRoles(workspaceId);
        const assignments = await externalAuthorityPersistence.authorization.listAssignments(workspaceId, key.ownerUserId);
        const overrides = await externalAuthorityPersistence.authorization.listOverrides(workspaceId, key.ownerUserId);
        const requestedScope = current
          ? { kind: 'event' as const, workspaceId, eventId: parseEventId(current.id) }
          : { kind: 'workspace' as const, workspaceId };
        const decisions = requirement.permissionIds.map((permissionId) => ({
          permissionId,
          ownerAllows: relationship.kind === 'valid' && evaluateAccess({
            userId: key.ownerUserId, permissionId, requestedScope,
            ...(membership ? { membership } : {}), roles, assignments, overrides,
            now: clock.now()
          }).allowed
        }));
        const ownerAllows = requirement.kind === 'all_of'
          ? decisions.every((decision) => decision.ownerAllows)
          : decisions.some((decision) => decision.ownerAllows);
        if (!ownerAllows) return {
          state: 'locked_owner' as const,
          permissionIds: [...requirement.permissionIds],
          note: 'The key owner does not currently hold the permission required by this tool.'
        };
        const keyAllows = requirement.kind === 'all_of'
          ? decisions.every((decision) => decision.ownerAllows && key.permissionIds.includes(decision.permissionId))
          : decisions.some((decision) => decision.ownerAllows && key.permissionIds.includes(decision.permissionId));
        return keyAllows
          ? { state: 'active' as const }
          : {
              state: 'locked_scope' as const,
              permissionIds: [...requirement.permissionIds],
              note: 'This key does not carry the permission required by this tool.',
              humanDoor: '/app/settings/api-keys' as const
            };
      },
      async planOperationAvailability(key, operation, planScope) {
        const planEventId = planScope.eventId === undefined
          ? undefined
          : parseEventId(planScope.eventId);
        if (key.eventIds.length > 0
            && (planEventId === undefined || !key.eventIds.includes(planEventId))) {
          return {
            state: 'locked_scope' as const,
            permissionIds: ['event.read'],
            note: 'This key is not scoped to the plan event.',
            humanDoor: '/app/settings/api-keys' as const
          };
        }
        const manifest = operations.registry.safeManifest.operations.find((candidate) =>
          candidate.name === operation.operationName && candidate.version === operation.operationVersion
        );
        const bindingSurface = manifest?.enabledBindings[0]?.surface;
        if (!manifest || !bindingSurface || manifest.effect === 'read') return {
          state: 'locked_owner' as const,
          permissionIds: ['event.manage'],
          note: 'The operation policy is not available in this workspace.'
        };
        const compiled = getCompiledEffectOperation(
          operations.registry, operation.operationName, operation.operationVersion, bindingSurface
        );
        const lane = compiled?.operation.definition.accessLanes.find((candidate) =>
          candidate.kind === 'operator'
        );
        if (!compiled || !lane) return {
          state: 'locked_owner' as const,
          permissionIds: ['event.manage'],
          note: 'The operation authority lane is not available in this workspace.'
        };
        const scope = Object.freeze({
          workspaceId,
          ...(planEventId === undefined ? {} : { eventId: planEventId }),
          subjects: Object.freeze(planScope.subjects.map((subject) => Object.freeze({
            kind: subject.type, id: subject.id
          }))),
          resolutionEvidenceIds: Object.freeze(['external-plan.current'])
        });
        const requirement = resolveOperatorAuthorityPermissionRequirement({
          catalog: authority.policies,
          policy: lane.policy,
          scope: scope as Parameters<typeof resolveOperatorAuthorityPermissionRequirement>[0]['scope']
        });
        if (!requirement) return {
          state: 'locked_owner' as const,
          permissionIds: ['event.manage'],
          note: 'The owner cannot reach this operation in the requested scope.'
        };
        const relationship = await externalAuthorityPersistence.scopeRelationships.validate({
          userId: key.ownerUserId,
          scope: scope as Parameters<typeof externalAuthorityPersistence.scopeRelationships.validate>[0]['scope'],
          evaluatedAt: clock.now()
        });
        const membership = await externalAuthorityPersistence.memberships.find(workspaceId, key.ownerUserId);
        const roles = await externalAuthorityPersistence.authorization.listRoles(workspaceId);
        const assignments = await externalAuthorityPersistence.authorization.listAssignments(workspaceId, key.ownerUserId);
        const overrides = await externalAuthorityPersistence.authorization.listOverrides(workspaceId, key.ownerUserId);
        const requestedScope = planEventId === undefined
          ? { kind: 'workspace' as const, workspaceId }
          : { kind: 'event' as const, workspaceId, eventId: planEventId };
        const decisions = requirement.permissionIds.map((permissionId) => ({
          permissionId,
          ownerAllows: relationship.kind === 'valid' && evaluateAccess({
            userId: key.ownerUserId, permissionId, requestedScope,
            ...(membership ? { membership } : {}), roles, assignments, overrides,
            now: clock.now()
          }).allowed
        }));
        const ownerAllows = requirement.kind === 'all_of'
          ? decisions.every((decision) => decision.ownerAllows)
          : decisions.some((decision) => decision.ownerAllows);
        if (!ownerAllows) return {
          state: 'locked_owner' as const,
          permissionIds: [...requirement.permissionIds],
          note: 'The key owner does not currently hold the permission required by this operation.'
        };
        const keyAllows = requirement.kind === 'all_of'
          ? decisions.every((decision) => decision.ownerAllows && key.permissionIds.includes(decision.permissionId))
          : decisions.some((decision) => decision.ownerAllows && key.permissionIds.includes(decision.permissionId));
        return keyAllows
          ? { state: 'active' as const }
          : {
              state: 'locked_scope' as const,
              permissionIds: [...requirement.permissionIds],
              note: 'This key does not carry the permission required by this operation.',
              humanDoor: '/app/settings/api-keys' as const
            };
      },
      async dormantPermissionIds(key) {
        const current = events.readCurrentEventState(workspaceId)?.currentEvent;
        const membership = await externalAuthorityPersistence.memberships.find(workspaceId, key.ownerUserId);
        const roles = await externalAuthorityPersistence.authorization.listRoles(workspaceId);
        const assignments = await externalAuthorityPersistence.authorization.listAssignments(workspaceId, key.ownerUserId);
        const overrides = await externalAuthorityPersistence.authorization.listOverrides(workspaceId, key.ownerUserId);
        const requestedScope = current
          ? { kind: 'event' as const, workspaceId, eventId: parseEventId(current.id) }
          : { kind: 'workspace' as const, workspaceId };
        return key.permissionIds.filter((permissionId) => !evaluateAccess({
          userId: key.ownerUserId, permissionId, requestedScope,
          ...(membership ? { membership } : {}), roles, assignments, overrides,
          now: clock.now()
        }).allowed);
      },
      async pendingAttention(key, pendingCorrelationId) {
        const verifiedEvidence = Object.freeze({
          kind: 'external_mcp' as const,
          surface: 'external_mcp' as const,
          client: Object.freeze({ key: 'api.v1.pending' }),
          credentialHandle: key.apiKeyId,
          clientKey: `api-key:${key.apiKeyId}`
        });
        const [drafts, deliveries] = await Promise.all([
          operations.readExecutor.execute({
            operationName: 'list_message_drafts', operationVersion: 1,
            surface: 'external_mcp', correlationId: pendingCorrelationId,
            businessInput: { limit: 100 }, verifiedEvidence
          }),
          operations.readExecutor.execute({
            operationName: 'get_delivery_history', operationVersion: 1,
            surface: 'external_mcp', correlationId: pendingCorrelationId,
            businessInput: { limit: 100 }, verifiedEvidence
          })
        ]);
        if (drafts.kind !== 'success' || deliveries.kind !== 'success') return [];
        const draftRows = (drafts.data as { readonly rows?: readonly {
          readonly state?: string;
          readonly authoring?: { readonly state?: string };
        }[] }).rows ?? [];
        const deliveryRows = (deliveries.data as { readonly rows?: readonly {
          readonly state?: string;
        }[] }).rows ?? [];
        const draftsAwaitingSend = draftRows.filter((draft) =>
          draft.state === 'active' && draft.authoring?.state === 'ready'
        ).length;
        const inFlightStates = new Set([
          'authorized', 'deferred', 'materialized', 'attempting',
          'accepted', 'delayed', 'acceptance_unknown'
        ]);
        const batchesInFlight = deliveryRows.filter((batch) =>
          batch.state !== undefined && inFlightStates.has(batch.state)
        ).length;
        if (draftsAwaitingSend === 0 && batchesInFlight === 0) return [];
        const draftText = `${draftsAwaitingSend} message draft${draftsAwaitingSend === 1 ? '' : 's'} ${draftsAwaitingSend === 1 ? 'is' : 'are'} waiting for a send decision`;
        const batchText = `${batchesInFlight} sent batch${batchesInFlight === 1 ? '' : 'es'} still ${batchesInFlight === 1 ? 'has' : 'have'} deliveries in flight`;
        return [{
          area: 'communications' as const,
          summary: `${draftText}, and ${batchText}.`,
          counts: { draftsAwaitingSend, batchesInFlight },
          tools: ['list_message_drafts', 'get_delivery_history'] as const,
          humanDoor: '/app/messages' as const
        }];
      }
    }));
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
            // An absent/superseded surface remains indistinguishable. A closed
            // surface may enter only the read operation, which returns its typed
            // detail-free marker; the ceremony still accepts only `pinned`.
            const resolution = applySurfaceGate.resolveApplySurface();
            if (resolution.kind !== 'pinned' && resolution.kind !== 'closed') {
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
    const filesPortalRequestHashSealer = cryptoProfiles.requestHashSealer(FILES_COMMAND_REQUEST_HASH_PROFILE);
    const filesPortalIdempotencySealer = cryptoProfiles.idempotencyCredentialSealer(filesPortalProfiles.idempotencyCredential);
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
        operation: { readonly name: string; readonly version: number },
        method: 'GET' | 'POST' = 'POST'
      ): Promise<
        | { readonly kind: 'authorized' }
        | { readonly kind: 'refused'; readonly status: 401 | 403 }
      > => {
        const verified = await evidence.verify({
          request,
          correlationId: crypto.randomUUID(),
          binding: { method } as Parameters<typeof evidence.verify>[0]['binding']
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
      // Advisory deliverability diagnostics: public-DNS lookups for the
      // sending domain's declared records. Never persisted, never a gate —
      // the provider's own readiness evidence stays authoritative.
      app.post('/api/communications/email-deliverability/check', async (context) => {
        const authorized = await requireProviderManageAuthority(
          context.req.raw,
          COMMUNICATION_PROVIDER_OPERATIONS.checkDeliverability
        );
        if (authorized.kind === 'refused') {
          return context.json({ kind: 'refused' as const }, authorized.status);
        }
        let deliverability;
        try {
          deliverability = await executorActivation.checkDeliverability();
        } catch (error) {
          if (
            error instanceof CommunicationsProviderActivationError
            && (error.code === 'deliverability_not_supported'
              || error.code === 'deliverability_declaration_invalid')
          ) {
            // No usable diagnostic exists here at all, so the capability is
            // honestly absent (an invalid adapter declaration included).
            return context.json({ kind: 'not_available' as const }, 409);
          }
          if (
            error instanceof CommunicationsProviderActivationError
            && error.code === 'sender_domain_unavailable'
          ) {
            // A configured provider whose from-address has no checkable
            // public domain is a completed advisory answer, not an absent
            // capability — conflating it with `not_available` is what let a
            // working Delivery panel latch into a false "not configured".
            return context.json({ kind: 'sender_domain_unavailable' as const });
          }
          throw error;
        }
        return context.json({ kind: 'completed' as const, deliverability });
      });
      // The manifest-derived, non-secret setup steps for the one configured
      // provider, so the settings surface and a guided agent session read the
      // same checklist the adapter declares instead of copying it.
      app.get('/api/communications/email-setup-guide', async (context) => {
        const authorized = await requireProviderManageAuthority(
          context.req.raw,
          COMMUNICATION_PROVIDER_OPERATIONS.getSetupGuide,
          'GET'
        );
        if (authorized.kind === 'refused') {
          return context.json({ kind: 'refused' as const }, authorized.status);
        }
        return context.json({
          kind: 'completed' as const,
          guide: executorActivation.getSetupGuide()
        });
      });
    }
    const testSupport = input.devFixtures === true
      ? (() => {
          type OperatorEvidence = Extract<InvocationEvidence, { readonly kind: 'operator' }>;
          const actorEvidence = new WeakMap<EphemeralLiveTestActor, OperatorEvidence>();
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
              cookie,
              sessionHandle: session.id
            });
            actorEvidence.set(actor, evidence);
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
          const resumeActors = async (candidates: readonly EphemeralLiveTestActor[]): Promise<void> => {
            if (candidates.length === 0) throw new TypeError('ephemeral_test_resume_actors_empty');
            for (const actor of candidates) {
              const response = await app.request('/api/me/access-context', {
                headers: { cookie: actor.cookie, 'x-correlation-id': crypto.randomUUID() }
              });
              if (response.status !== 200) throw new TypeError(`ephemeral_test_resume_http_${response.status}`);
              const access = accessContextSchema.parse(await response.json());
              if (access.state !== 'active' || access.workspace.id !== workspaceId || access.user.id !== actor.userId) {
                throw new TypeError('ephemeral_test_resume_identity_changed');
              }
              actorEvidence.set(actor, Object.freeze({
                kind: 'operator' as const,
                surface: 'operator_http' as const,
                client: Object.freeze({ key: 'test.ephemeral.flow' }),
                sessionHandle: actor.sessionHandle
              }));
            }
            const organizer = candidates.find((actor) => actor.persona === 'organizer');
            if (!organizer) throw new TypeError('ephemeral_test_resume_organizer_missing');
            const team = await readTeam(requireEvidence(organizer));
            for (const actor of candidates) {
              const member = team.members.find((candidate) =>
                candidate.kind === 'member' && candidate.id === actor.membership.id
                  && candidate.status === 'active' && candidate.userId === actor.userId
              );
              if (!member) throw new TypeError('ephemeral_test_resume_membership_changed');
            }
          };
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
            resumeActors,
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
              const runner = createLiveAgentActionRunner(at);
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
    let closePromise: Promise<void> | undefined;
    const cleanEphemeralBlobs = () => {
      try {
        if (filesBlobRootDirectory !== undefined && input.blobStorage.kind === 'ephemeral') {
          rmSync(filesBlobRootDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        console.error('[jooevents] ephemeral files blob cleanup failed', error);
      }
    };
    const closeDatabase = (): Promise<void> => {
      try {
        const result = database.close();
        if (result !== null && typeof result === 'object' && 'then' in result) {
          return Promise.resolve(result).then(cleanEphemeralBlobs);
        }
        cleanEphemeralBlobs();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const closeStorage = (): Promise<void> => {
      const backgroundRunning = backgroundSupervisor?.snapshot().jobs.some(
        (job) => job.state === 'running'
      ) ?? false;
      const airtableRunning = airtableLive?.hasInFlightWork() ?? false;
      const drains = [backgroundSupervisor?.close(), airtableLive?.close()]
        .filter((value): value is Promise<void> => value !== undefined);
      if (!backgroundRunning && !airtableRunning) {
        const databaseClose = closeDatabase();
        return Promise.all([...drains, databaseClose]).then(() => undefined);
      }
      return Promise.all(drains).then(closeDatabase);
    };
    const close = (): Promise<void> => {
      if (closePromise === undefined) {
        closePromise = closeStorage();
      }
      return closePromise!;
    };
    const startBackgroundWork = async (): Promise<void> => {
      await backgroundSupervisor!.start();
      airtableLive?.start();
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
      background: Object.freeze({
        snapshot: () => backgroundSupervisor!.snapshot(),
        runNow: (name: string) => backgroundSupervisor!.runNow(name)
      }),
      ...(testSupport === undefined ? {} : { testSupport }),
      startBackgroundWork,
      close
    });
  } catch (error) {
    await backgroundSupervisor?.close();
    await airtableLive?.close();
    await database.close();
    if (filesBlobRootDirectory !== undefined && input.blobStorage.kind === 'ephemeral') {
      try {
        rmSync(filesBlobRootDirectory, { recursive: true, force: true });
      } catch {
        // The boot failure below is the primary fault; cleanup stays best-effort.
      }
    }
    throw error;
  }
}
