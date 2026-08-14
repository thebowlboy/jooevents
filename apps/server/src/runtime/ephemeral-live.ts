import { createHash, createHmac as createNodeHmac } from 'node:crypto';
import {
  assertOperatorAuthorityPolicyCatalogCoversOperationRegistry,
  COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createClassifiedPayloadProfileRef,
  createCommunicationProviderReadOperationModule,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createProvisioningService,
  createWorkspaceTeamOperationModule,
  type InvocationEvidence,
  WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
  WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE,
  WORKSPACE_TEAM_OPERATION_ACCESS,
} from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile
} from '@jooevents/application/synchronous-classified-payload-store';
import type {
  FormTarget,
  FormTargetReferencePinDto
} from '@jooevents/contracts';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
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
  createOutboundEmailDeliveryOperationModule
} from '@jooevents/communication-operations';
import {
  DECISION_NOTIFICATION_MERGE_FIELDS,
  createDeterministicFakeEmailProvider,
  createEmailProviderConfigurationService,
  createEmailProviderReadinessReader,
  createHmacOrganizerPreviewOpaqueTokenCodec,
  createOrganizerMergeRegistryRelease,
  createOrganizerPlainTextRenderStrategyPort,
  createOutboundEmailProviderRegistry
} from '@jooevents/communications';
import {
  DEADLINE_DRAFT_REQUEST_HASH_PROFILE,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_READ_ACCESS_POLICY,
  createDeadlineOperationModule
} from '@jooevents/deadline-operations';
import {
  DECISION_DRAFT_ACCESS_POLICY,
  DECISION_DRAFT_REQUEST_HASH_PROFILE,
  DECISION_READ_ACCESS_POLICY,
  createDecisionDraftOperationModule,
  createDecisionOperationModule
} from '@jooevents/decision-operations';
import {
  ENGAGEMENT_CHANGE_DRAFT_OPERATION,
  ENGAGEMENT_DRAFT_ACCESS_POLICY,
  ENGAGEMENT_DRAFT_APPROVAL_POLICY,
  ENGAGEMENT_DRAFT_HANDLER_CAPABILITY,
  ENGAGEMENT_DRAFT_PERMISSION_ID,
  ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE,
  ENGAGEMENT_READ_ACCESS_POLICY,
  createEngagementDraftOperationModule,
  createEngagementOperationModule,
  sealEngagementDraftPreparation
} from '@jooevents/engagement-operations';
import {
  createEventDependencyContributorRegistry,
  issueEventOrdinaryPolicy,
  type EventDependencyContributorRef
} from '@jooevents/event';
import {
  EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
  createEventCreateDraftOperationModule,
  createEventOperationModule,
  createEventSettingsReadOperationModule,
  createEventSettingsUpdateDraftOperationModule
} from '@jooevents/event-operations';
import {
  FIELD_REGISTRY_DRAFT_REQUEST_HASH_PROFILE,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  FIELD_REGISTRY_READ_ACCESS_POLICY,
  createFieldRegistryOperationModule,
  createFieldRegistryOrdinaryPolicy
} from '@jooevents/field-registry';
import {
  issueFormOrdinaryPolicy,
  issueSubmissionDirectEntryChangesetPolicy
} from '@jooevents/intake';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_EVENT_READ_ACCESS_POLICY,
  INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_FORM_READ_OPERATION,
  INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
  INTAKE_SUBMISSION_READ_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
  SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
  createIntakeFormDraftOperationModule,
  createIntakePublicFormReadOperationModule,
  createIntakeReadOperationModule,
  createSubmissionDirectEntryDraftOperationModule,
  type IntakePublicFormScopeSource
} from '@jooevents/intake-operations';
import {
  evaluateAccess,
  parseOperationAccessLane,
  type CurrentAuthorityResolver
} from '@jooevents/identity-access';
import {
  createReviewOperationModule,
  REVIEW_EVALUATE_ACCESS_POLICY,
  REVIEW_MANAGE_ACCESS_POLICY,
  REVIEW_REQUEST_HASH_PROFILE,
  REVIEW_SNAPSHOT_ACCESS_POLICY,
  REVIEW_STEP_BACK_ACCESS_POLICY,
  type ReviewViewerResolver
} from '@jooevents/review-operations';
import {
  createReviewerRosterOperationModule,
  REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
  REVIEWER_ROSTER_MANAGE_ACCESS_POLICY
} from '@jooevents/review-operations/roster';
import {
  createProgramReferenceContributorRegistry,
  issueProgramVocabularyOrdinaryPolicy
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
  createProgramVocabularyOperationModule
} from '@jooevents/program-operations';
import type { PlaceableSessionIdentityPort } from '@jooevents/schedule';
import {
  SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
  createSchedulePlacementOperationModule
} from '@jooevents/schedule-operations';
import {
  createSchedulePlaceableSessionPort,
  createSessionAwareReviewerScopeTargetSource
} from '@jooevents/session';
import {
  SESSION_DRAFT_ACCESS_POLICY,
  SESSION_DRAFT_REQUEST_HASH_PROFILE,
  SESSION_READ_ACCESS_POLICY,
  createSessionDraftOperationModule,
  createSessionOperationModule
} from '@jooevents/session-operations';
import {
  SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE,
  SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
  SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
  SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
  createSubmissionTriageDraftOperationModule,
  createSubmissionTriageReadOperationModule,
  createSubmissionTriageSubmitInitializer,
  issueSubmissionTriageChangesetPolicy
} from '@jooevents/submission-triage';
import {
  DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG,
  WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
  createWorkspaceOverviewOperationModule
} from '@jooevents/workspace-operations';
import {
  canonicalJsonText,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  bootstrapEmptyInstall,
  createFoundationEphemeralSQLiteRuntime,
  createSQLiteAccessRepositories,
  createSQLiteEventSettingsChangesetEffectDomainRegistration,
  createSQLiteEventSettingsInitializer,
  createSQLiteEventSettingsUpdateDraftEffectDomainRegistration,
  createSQLiteProvisioningStore,
  SQLiteEventSettingsRepository,
  SQLiteReadImmutableAuditPort,
  type EphemeralSQLiteRuntime
} from '@jooevents/persistence';
import {
  createSQLiteEventCreationChangesetEffectDomainRegistration
} from '@jooevents/persistence/event-changeset-effect-domain';
import {
  createSQLiteDeadlineChangesetEffectDomainRegistration
} from '@jooevents/persistence/deadline-changeset-effect-domain';
import {
  createSQLiteDeadlineDraftEffectDomainRegistration
} from '@jooevents/persistence/deadline-draft-effect-domain';
import {
  SQLiteDecisionCandidateSourceAdapter,
  SQLiteDecisionRepository,
  SQLiteDecisionReviewBasisSourceAdapter,
  createSQLiteDecisionEnvironmentSource,
  createSQLiteIntakeParticipantPersonSource
} from '@jooevents/persistence/decision';
import {
  createSQLiteDecisionChangesetEffectDomainRegistration
} from '@jooevents/persistence/decision-changeset-effect-domain';
import {
  createSQLiteDecisionDraftEffectDomainRegistration
} from '@jooevents/persistence/decision-draft-effect-domain';
import {
  createSQLiteDecisionAudienceSource,
  createSQLiteDraftRenderContentSource,
  decisionAudienceDelegates,
  mintDecisionAudienceRecipes,
  seedDecisionNotificationCommunications
} from '@jooevents/persistence/organizer-decision-audience';
import {
  SQLiteCommunicationMessageReleaseStore,
  createSQLiteOutboundEmailEnvelopeResolver
} from '@jooevents/persistence/message-releases';
import {
  createSQLiteCommunicationReleaseChangesetOwnerRegistration
} from '@jooevents/persistence/message-release-effect-domain';
import { SQLiteOutboundEmailDeliveryLedger } from '@jooevents/persistence/outbound-email-delivery';
import {
  createSQLiteOutboundEmailDeliveryEffectDomainRegistration
} from '@jooevents/persistence/outbound-email-delivery-effect-domain';
import {
  createSQLiteEngagementSubmissionReferenceSource
} from '@jooevents/persistence/engagement';
import {
  createSQLiteEngagementChangesetEffectDomainRegistration
} from '@jooevents/persistence/engagement-changeset-effect-domain';
import {
  createSQLiteEngagementDraftEffectDomainRegistration
} from '@jooevents/persistence/engagement-draft-effect-domain';
import {
  createSQLiteEventCreateDraftEffectDomainRegistration
} from '@jooevents/persistence/event-create-draft-effect-domain';
import {
  createSQLiteFieldRegistryChangesetEffectDomainRegistration
} from '@jooevents/persistence/field-registry-changeset-effect-domain';
import {
  createSQLiteFieldRegistryDraftEffectDomainRegistration
} from '@jooevents/persistence/field-registry-draft-effect-domain';
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
import {
  createSQLiteProgramVocabularyChangesetEffectDomainRegistration
} from '@jooevents/persistence/program-vocabulary-changeset-effect-domain';
import {
  createSQLiteChangesetLifecycleEffectDomainRouter
} from '@jooevents/persistence/changeset-lifecycle-effect-domain-router';
import { SQLiteIntakeClassifiedProjection } from '@jooevents/persistence/intake-classified-projection';
import {
  createSQLiteIntakeDirectEntryChangesetEffectDomainRegistration,
  createSQLiteIntakeDirectEntryDraftEffectDomainRegistration
} from '@jooevents/persistence/intake-direct-entry-effect-domain';
import {
  createSQLiteIntakeFormChangesetEffectDomainRegistration
} from '@jooevents/persistence/intake-form-changeset-effect-domain';
import {
  createSQLiteIntakeFormDraftEffectDomainRegistration
} from '@jooevents/persistence/intake-form-draft-effect-domain';
import {
  createSQLiteIntakeFormProgramVocabularyReferenceAdapter,
  INTAKE_FORM_PROGRAM_VOCABULARY_CONTRIBUTOR
} from '@jooevents/persistence/intake-form-program-reference';
import {
  SQLiteIntakeRepository,
  type SQLiteIntakeScopeInput
} from '@jooevents/persistence/intake';
import {
  SQLiteIntakeSubmissionTriageSourceAdapter,
  SQLiteSubmissionTriageRepository
} from '@jooevents/persistence/submission-triage';
import {
  createSQLiteSubmissionTriageChangesetEffectDomainRegistration
} from '@jooevents/persistence/submission-triage-changeset-effect-domain';
import {
  createSQLiteSubmissionTriageDraftEffectDomainRegistration
} from '@jooevents/persistence/submission-triage-draft-effect-domain';
import {
  createSQLiteProgramVocabularyDraftEffectDomainRegistration
} from '@jooevents/persistence/program-vocabulary-draft-effect-domain';
import {
  SQLiteProgramVocabularyRepository,
  createSQLiteProgramVocabularyContributorAdapterRegistry
} from '@jooevents/persistence/program-vocabulary';
import {
  createSQLiteSchedulePlacementChangesetEffectDomainRegistration
} from '@jooevents/persistence/schedule-placement-changeset-effect-domain';
import {
  createSQLiteSchedulePlacementDraftEffectDomainRegistration
} from '@jooevents/persistence/schedule-placement-draft-effect-domain';
import {
  SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
  createSQLiteScheduleRoomReferenceAdapter
} from '@jooevents/persistence/schedule-placement';
import { SQLiteSessionRepository } from '@jooevents/persistence/session';
import { SQLiteReviewRepository } from '@jooevents/persistence/review';
import {
  createSQLiteReviewDraftEffectDomainRegistration
} from '@jooevents/persistence/review-draft-effect-domain';
import {
  createSQLiteReviewEvaluationDraftSaveEffectDomainRegistration
} from '@jooevents/persistence/review-evaluation-draft-save-effect-domain';
import {
  createSQLiteReviewChangesetEffectDomainRegistration
} from '@jooevents/persistence/review-changeset-effect-domain';
import {
  SQLiteReviewerAuthoritySource
} from '@jooevents/persistence/reviewer-authority-source';
import {
  SQLiteReviewerScopeTargetSource
} from '@jooevents/persistence/reviewer-scope-target-source';
import { SQLiteReviewerRosterRepository } from '@jooevents/persistence/reviewer-roster';
import {
  createSQLiteReviewerRosterDraftEffectDomainRegistration
} from '@jooevents/persistence/reviewer-roster-draft-effect-domain';
import {
  createSQLiteReviewerRosterChangesetEffectDomainRegistration
} from '@jooevents/persistence/reviewer-roster-changeset-effect-domain';
import {
  createSQLiteSessionChangesetEffectDomainRegistration
} from '@jooevents/persistence/session-changeset-effect-domain';
import {
  createSQLiteSessionDraftEffectDomainRegistration
} from '@jooevents/persistence/session-draft-effect-domain';
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
  createWorkspaceTeamProvisioningSynchronizationPort,
  SQLiteWorkspaceTeamRepository,
  ensureWorkspaceTeamRoles
} from '@jooevents/persistence/sqlite/workspace-team';
import {
  createWorkspaceTeamChangesetPolicy
} from '@jooevents/persistence/sqlite/workspace-team-changesets';
import {
  SQLiteWorkspaceTeamDraftEffectDomainAdapter
} from '@jooevents/persistence/sqlite/workspace-team-draft-effect-domain';
import {
  createSQLiteWorkspaceTeamChangesetEffectDomainRegistration
} from '@jooevents/persistence/sqlite/workspace-team-changeset-effect-domain';
import { createAuth, type JooEventsAuth } from '../auth/better-auth';
import { createBetterAuthOperatorEvidenceVerifier } from '../auth/operator-evidence';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import type { ServerConfig } from '../config';
import { createHttpApp } from '../http/app';
import { createPublicOperationsHttpAdapter } from '../http/public-operations';
import { createSerialHttpRequestBoundary } from '../http/request-serialization';
import {
  communicationReleaseLifecycleInertAdapter,
  createCommunicationSendLane,
  type CommunicationSendLane
} from './communication-send-lane';
import {
  createSQLiteCommunicationDeliveryHistorySource
} from './communication-delivery-history';
import { createCommunicationSendOperationRuntime } from './communication-send-operations';
import { createOutboundDispatchLoop, type OutboundDispatchLoop } from './outbound-dispatch-loop';
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

const changesetProfiles = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.changeset.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.changeset.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.changeset.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.changeset.idempotency-credential',
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
    ['communication.provider.manage', 'Ephemeral live email provider owner grant']
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
  /** One-pass outbound dispatch over the delivery ledger with the inert fake provider. */
  readonly outboundDispatch: OutboundDispatchLoop;
  close(): ReturnType<EphemeralSQLiteRuntime['close']>;
}

/** Opens one process-lifetime isolated organizer runtime over a new database. */
export async function createEphemeralLiveRuntime(input: {
  readonly config: ServerConfig;
}): Promise<EphemeralLiveRuntime> {
  const database = createFoundationEphemeralSQLiteRuntime();
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
    const auth = createAuth(input.config, database.db);
    const clock = Object.freeze({
      now: () => parseInstant(new Date().toISOString())
    });
    const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
    const deadlineDraftDomain = createSQLiteDeadlineDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newDeadlineId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID()
      })
    });
    const eventDependencySource = new SQLiteFieldRegistryEventDependencySource(
      database.sqlite
    );
    const eventDependencyRegistry = createEventDependencyContributorRegistry({
      expected: [FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR],
      contributors: [FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR]
    });
    const eventPolicy = issueEventOrdinaryPolicy({
      key: 'event.creation.bounded',
      version: 1,
      risk: 'low',
      approval: 'none'
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
    const programVocabularyPolicy = issueProgramVocabularyOrdinaryPolicy({
      key: 'program_vocabulary.bounded',
      version: 1,
      ordinaryRisk: 'low',
      mergeRisk: 'consequential',
      approval: Object.freeze({ ordinary: 'none', merge: 'none' })
    });
    const programVocabularyChangesets =
      createSQLiteProgramVocabularyChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: programVocabularyPolicy,
        referenceRegistry,
        contributors: contributorAdapters,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
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
    // Recorder default BLOCKED-2 (provider inertness): the deterministic fake
    // exists ONLY as the dispatch worker's adapter. The configurable-provider
    // registry stays empty — its outbound-only gate structurally rejects the
    // fake's full manifest, and an empty registry keeps the provider setup and
    // readiness surfaces honestly reporting that nothing is configured.
    // External activation stays withheld, the Cloudflare provider runtime
    // stays unconsumed, and the send lane's non-scenario external delivery key
    // makes every fake submission resolve as a terminal known rejection, so
    // deliveries are recorded honestly as not delivered.
    const fakeEmailProvider = createDeterministicFakeEmailProvider();
    const emailProviderRegistry = createOutboundEmailProviderRegistry([]);
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
      principals: createSQLiteAuthPrincipalReader(database.sqlite),
      store: createSQLiteProvisioningStore(database.sqlite, {
        workspaceTeam: createWorkspaceTeamProvisioningSynchronizationPort(
          workspaceTeamRepository
        )
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
    // Live decision-set audience source over the same decision heads and
    // classified intake contacts the mounted Decision and Submissions
    // surfaces serve; identity is personId-bearing evidence, never email.
    const decisionAudienceSource = createSQLiteDecisionAudienceSource({
      sqlite: database.sqlite,
      contacts: intakeRepository,
      submissions: submissionTriageSource,
      addressFingerprintKeyBytes: randomHmacKey()
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
          values: decisionAudienceSource
        }),
        digestProfile: Object.freeze({ key: 'communication.preview.sha256', version: 1 }),
        audienceCursorKeyBytes: randomHmacKey(),
        registeredSources: decisionAudienceDelegates(decisionAudienceSource)
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
    };
    const communicationMessageReleases = new SQLiteCommunicationMessageReleaseStore(
      database.sqlite,
      organizerCommunicationClassifiedStore,
      Object.freeze({ newEnvelopePayloadRefId: () => crypto.randomUUID() })
    );
    const communicationReleaseChangesets =
      createSQLiteCommunicationReleaseChangesetOwnerRegistration({
        sqlite: database.sqlite,
        workspaceId
      });
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
      provider: fakeEmailProvider.delivery,
      envelopes: createSQLiteOutboundEmailEnvelopeResolver(communicationMessageReleases),
      ids: Object.freeze({ newAttemptId: () => crypto.randomUUID() }),
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
      clock
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
      }
    });
    const fieldRegistryPolicy = createFieldRegistryOrdinaryPolicy({
      key: 'field_registry.bounded',
      version: 1,
      ordinaryRisk: 'low',
      approval: 'none'
    });
    const formPolicy = issueFormOrdinaryPolicy({
      key: 'intake_form.bounded',
      version: 1,
      ordinaryRisk: 'low',
      approval: Object.freeze({ ordinary: 'none' })
    });
    const submissionTriagePolicy = issueSubmissionTriageChangesetPolicy({
      key: 'submission.triage.bounded',
      version: 1,
      approval: Object.freeze({ ordinary: 'none', discardRecoverable: 'none' })
    });
    const submissionDirectEntryPolicy = issueSubmissionDirectEntryChangesetPolicy({
      key: 'submission.direct-entry.bounded',
      version: 1,
      approval: Object.freeze({ create: 'none' })
    });
    const workspaceTeamPolicy = createWorkspaceTeamChangesetPolicy({
      key: 'workspace_team.bounded',
      version: 1,
      approval: 'none'
    });
    const intakeFormChangesets = createSQLiteIntakeFormChangesetEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      policy: formPolicy,
      repository: intakeRepository,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newApprovalId: () => crypto.randomUUID(),
        newCorrectionAttemptId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID()
      })
    });
    const eventSettingsChangesets =
      createSQLiteEventSettingsChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: eventPolicy,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const fieldRegistryChangesets =
      createSQLiteFieldRegistryChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: fieldRegistryPolicy,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const submissionTriageChangesets =
      createSQLiteSubmissionTriageChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: submissionTriagePolicy,
        repository: submissionTriageRepository,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const intakeDirectEntryChangesets =
      createSQLiteIntakeDirectEntryChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: submissionDirectEntryPolicy,
        repository: intakeRepository,
        projection: intakeClassifiedProjection,
        submissionTriage: createSubmissionTriageSubmitInitializer({
          store: submissionTriageRepository,
          ids: Object.freeze({ newArrivalId: () => crypto.randomUUID() })
        }),
        // Engagement heads hold durable `submissionId` references: a submission
        // whose acceptance seeded engagements refuses direct-entry compensation
        // until the acceptance itself is compensated first.
        references: Object.freeze([
          createSQLiteEngagementSubmissionReferenceSource(database.sqlite)
        ]),
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const workspaceTeamChangesets =
      createSQLiteWorkspaceTeamChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: workspaceTeamPolicy,
        classifiedStore: workspaceTeamClassifiedStore,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const deadlineChangesets =
      createSQLiteDeadlineChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
          })
        });
    const schedulePlacementChangesets =
      createSQLiteSchedulePlacementChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        sessions: placeableSessions,
        vocabulary: vocabularyRead,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const schedulePlacementDraftDomain =
      createSQLiteSchedulePlacementDraftEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        sessions: placeableSessions,
        vocabulary: vocabularyRead,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newOccurrenceId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID()
        })
      });
    const sessionDraftDomain = createSQLiteSessionDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      vocabulary: vocabularyRead,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newSessionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID()
      })
    });
    const sessionChangesets = createSQLiteSessionChangesetEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      vocabulary: vocabularyRead,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newApprovalId: () => crypto.randomUUID(),
        newCorrectionAttemptId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID()
      })
    });
    const reviewChangesets = createSQLiteReviewChangesetEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: reviewRepository,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newApprovalId: () => crypto.randomUUID(),
        newCorrectionAttemptId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID()
      })
    });
    const reviewerRosterChangesets =
      createSQLiteReviewerRosterChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        sources: reviewerRosterSources,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        })
      });
    const decisionChangesets = createSQLiteDecisionChangesetEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      vocabulary: vocabularyRead,
      environment: decisionEnvironment,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newApprovalId: () => crypto.randomUUID(),
        newCorrectionAttemptId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID()
      })
    });
    const engagementChangesets = createSQLiteEngagementChangesetEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      approvalPolicy: ENGAGEMENT_DRAFT_APPROVAL_POLICY,
      permissionId: ENGAGEMENT_DRAFT_PERMISSION_ID,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newApprovalId: () => crypto.randomUUID(),
        newCorrectionAttemptId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID(),
        newPointerId: () => crypto.randomUUID()
      })
    });
    const eventCreationChangesets =
      createSQLiteEventCreationChangesetEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: eventPolicy,
        dependencyRegistry: eventDependencyRegistry,
        dependencySource: eventDependencySource,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newApprovalId: () => crypto.randomUUID(),
          newCorrectionAttemptId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newFactId: () => crypto.randomUUID(),
          newPointerId: () => crypto.randomUUID()
        }),
        createdEventInitializer: (() => {
          const fieldRegistry = createSQLiteFieldRegistryEventInitializer({
            sqlite: database.sqlite,
            ids: Object.freeze({
              newFieldId: () => crypto.randomUUID(),
              newChoiceId: () => crypto.randomUUID()
            })
          });
          const settings = createSQLiteEventSettingsInitializer({ sqlite: database.sqlite });
          const spineHeadRead = database.sqlite.query<
            { readonly name: string; readonly created_at_ms: number },
            [string, string]
          >(`
            SELECT name, created_at_ms FROM event_spine_heads
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
              // Project the committed Event into the identity-access `events`
              // table inside the same transaction so event-scoped access
              // evidence (event-scoped role assignments and overrides, and the
              // reviewer authority source) resolves for the created Event.
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
              return settings.initializeCreatedEventSettings(scope);
            }
          });
        })()
      });
    const changesetLifecycle = createSQLiteChangesetLifecycleEffectDomainRouter([
      Object.freeze({
        ownerId: 'event_creation',
        adapter: eventCreationChangesets.adapter,
        ownerResolution: eventCreationChangesets.ownerResolution,
        subjectRelationships: eventCreationChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: 'program_vocabulary',
        adapter: programVocabularyChangesets.adapter,
        ownerResolution: programVocabularyChangesets.ownerResolution,
        subjectRelationships: programVocabularyChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: intakeFormChangesets.ownerId,
        adapter: intakeFormChangesets.adapter,
        ownerResolution: intakeFormChangesets.ownerResolution,
        subjectRelationships: intakeFormChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: 'field_registry',
        adapter: fieldRegistryChangesets.adapter,
        ownerResolution: fieldRegistryChangesets.ownerResolution,
        subjectRelationships: fieldRegistryChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: eventSettingsChangesets.ownerId,
        adapter: eventSettingsChangesets.adapter,
        ownerResolution: eventSettingsChangesets.ownerResolution,
        subjectRelationships: eventSettingsChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: 'deadline',
        adapter: deadlineChangesets.adapter,
        ownerResolution: deadlineChangesets.ownerResolution,
        subjectRelationships: deadlineChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: submissionTriageChangesets.ownerId,
        adapter: submissionTriageChangesets.adapter,
        ownerResolution: submissionTriageChangesets.ownerResolution,
        subjectRelationships: submissionTriageChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: intakeDirectEntryChangesets.ownerId,
        adapter: intakeDirectEntryChangesets.adapter,
        ownerResolution: intakeDirectEntryChangesets.ownerResolution,
        subjectRelationships: intakeDirectEntryChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: 'workspace_team',
        adapter: workspaceTeamChangesets.adapter,
        ownerResolution: workspaceTeamChangesets.ownerResolution,
        subjectRelationships: workspaceTeamChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: 'schedule_placement',
        adapter: schedulePlacementChangesets.adapter,
        ownerResolution: schedulePlacementChangesets.ownerResolution,
        subjectRelationships: schedulePlacementChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: sessionChangesets.ownerId,
        adapter: sessionChangesets.adapter,
        ownerResolution: sessionChangesets.ownerResolution,
        subjectRelationships: sessionChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: reviewChangesets.ownerId,
        adapter: reviewChangesets.adapter,
        ownerResolution: reviewChangesets.ownerResolution,
        subjectRelationships: reviewChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: reviewerRosterChangesets.ownerId,
        adapter: reviewerRosterChangesets.adapter,
        ownerResolution: reviewerRosterChangesets.ownerResolution,
        subjectRelationships: reviewerRosterChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: decisionChangesets.ownerId,
        adapter: decisionChangesets.adapter,
        ownerResolution: decisionChangesets.ownerResolution,
        subjectRelationships: decisionChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: engagementChangesets.ownerId,
        adapter: engagementChangesets.adapter,
        ownerResolution: engagementChangesets.ownerResolution,
        subjectRelationships: engagementChangesets.subjectRelationships
      }),
      Object.freeze({
        ownerId: communicationReleaseChangesets.ownerId,
        adapter: communicationReleaseLifecycleInertAdapter,
        ownerResolution: communicationReleaseChangesets.ownerResolution,
        subjectRelationships: communicationReleaseChangesets.subjectRelationships
      })
    ]);
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
          policy: SESSION_DRAFT_ACCESS_POLICY,
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
          policy: DECISION_DRAFT_ACCESS_POLICY,
          permissionId: 'event.manage' as const
        }),
        Object.freeze({
          policy: ENGAGEMENT_READ_ACCESS_POLICY,
          permissionId: 'speaker.directory.read' as const
        }),
        Object.freeze({
          policy: ENGAGEMENT_DRAFT_ACCESS_POLICY,
          permissionId: 'event.manage' as const
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
        }),
        Object.freeze({
          policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
          permission: Object.freeze({
            kind: 'domain_subject' as const,
            domain: 'changeset',
            entity: 'owner',
            mappings: Object.freeze([
              Object.freeze({
                id: 'event_creation',
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: 'field_registry',
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: eventSettingsChangesets.ownerId,
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: 'deadline',
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: 'intake_form',
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: 'program_vocabulary',
                permissionId: 'program.vocabulary.manage' as const
              }),
              Object.freeze({
                id: 'schedule_placement',
                permissionId: 'schedule.manage' as const
              }),
              Object.freeze({
                id: 'session',
                permissionId: 'schedule.manage' as const
              }),
              Object.freeze({
                id: submissionTriageChangesets.ownerId,
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: intakeDirectEntryChangesets.ownerId,
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: reviewChangesets.ownerId,
                anyOfPermissionIds: Object.freeze([
                  'event.manage',
                  'submission.score',
                  'submission.comment'
                ] as const)
              }),
              Object.freeze({
                id: reviewerRosterChangesets.ownerId,
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: decisionChangesets.ownerId,
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: engagementChangesets.ownerId,
                permissionId: 'event.manage' as const
              }),
              Object.freeze({
                id: 'workspace_team',
                anyOfPermissionIds: Object.freeze([
                  'access.roles.manage',
                  'access.users.invite',
                  'access.users.suspend'
                ] as const)
              })
            ])
          })
        })
      ]),
      clock,
      eventRelationships,
      additionalSubjectRelationships: changesetLifecycle.subjectRelationships
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
      mountLegacyDirectCreate: false
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
    const eventSettingsDraftOperations = createEventSettingsUpdateDraftOperationModule({
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
        profile: EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
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
    const eventCreateDraftOperations = createEventCreateDraftOperationModule({
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
        profile: EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: eventProfiles.idempotencyCredential,
      idempotencyCredentialSealer
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
      deadlineRead: deadlineDraftDomain.deadlineRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: deadlineProfiles.authorityPrincipal,
      scopePartitionProfile: deadlineProfiles.scopePartition,
      requestCanonicalizationProfile: deadlineProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: DEADLINE_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: deadlineProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: deadlineProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const publicFormPolicyRevisionId = parsePublicPolicyRevisionId(crypto.randomUUID());
    const publicFormAuthority = Object.freeze({
      resolve(input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
        if (input.evidence.kind !== 'public_open'
            || input.evidence.publicPolicyRevisionId !== publicFormPolicyRevisionId
            || input.lane.kind !== 'public_open'
            || input.lane.surface !== 'public_http'
            || input.lane.policy.key !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.key
            || input.lane.policy.version !== INTAKE_PUBLIC_OPEN_ACCESS_POLICY.version
            || input.operation.name !== INTAKE_PUBLIC_FORM_READ_OPERATION.name
            || input.operation.version !== INTAKE_PUBLIC_FORM_READ_OPERATION.version) {
          return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
        }
        return Object.freeze({
          kind: 'authorized' as const,
          authority: Object.freeze({
            actor: Object.freeze({
              kind: 'public_request' as const,
              publicPolicyRevisionId: publicFormPolicyRevisionId,
              authority: Object.freeze({ kind: 'open_policy' as const })
            }),
            principal: Object.freeze({
              kind: 'public_capability' as const,
              publicPolicyRevisionId: publicFormPolicyRevisionId,
              authority: Object.freeze({ kind: 'open_policy' as const })
            }),
            lane: input.lane,
            scope: input.scope,
            grants: Object.freeze([{
              kind: 'public_policy' as const,
              key: INTAKE_PUBLIC_FORM_READ_OPERATION.name
            }]),
            evidenceIds: Object.freeze(['intake-public-form-read.current']),
            authorityCitationIds: Object.freeze([]),
            evaluatedAt: input.evaluatedAt
          })
        });
      }
    } satisfies CurrentAuthorityResolver<InvocationEvidence>);
    const publicFormReadOperations = createIntakePublicFormReadOperationModule({
      policy: INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
      currentAuthority: publicFormAuthority,
      publicFormScope: Object.freeze({
        resolve(input: Parameters<IntakePublicFormScopeSource['resolve']>[0]) {
          if (input.publicPolicyRevisionId !== publicFormPolicyRevisionId) return undefined;
          const current = currentEvent.resolveCurrentEvent(workspaceId);
          if (!current.eventId) return undefined;
          return Object.freeze({
            workspaceId,
            eventId: current.eventId,
            evidenceIds: Object.freeze([
              ...current.evidenceIds,
              `intake-public-form-policy:${publicFormPolicyRevisionId}`
            ])
          });
        }
      }),
      read: Object.freeze({
        readServedForm: intakeRepository.readServedForm.bind(intakeRepository)
      }),
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
        scopePartitionProfile: intakeProfiles.scopePartition,
        requestCanonicalizationProfile: intakeProfiles.requestCanonicalization
      })
    });
    const programVocabularyRequestHashSealer = createHmacRequestHashSealer({
      profile: PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: randomHmacKey()
    });
    const programVocabularyIdempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: programVocabularyProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const programVocabularyOperations = createProgramVocabularyOperationModule({
      workspaceId,
      policies: Object.freeze({
        read: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
        manage: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY
      }),
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
      requestCanonicalizationProfile: programVocabularyProfiles.requestCanonicalization,
      requestHashSealer: programVocabularyRequestHashSealer,
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
      scheduleRead: schedulePlacementDraftDomain.scheduleRead,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: schedulePlacementProfiles.authorityPrincipal,
      scopePartitionProfile: schedulePlacementProfiles.scopePartition,
      requestCanonicalizationProfile: schedulePlacementProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
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
    const sessionDraftOperations = createSessionDraftOperationModule({
      workspaceId,
      draftPolicy: SESSION_DRAFT_ACCESS_POLICY,
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
        profile: SESSION_DRAFT_REQUEST_HASH_PROFILE,
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
        profile: FIELD_REGISTRY_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: fieldRegistryProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: fieldRegistryProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const changesetRequestHashSealer = createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: randomHmacKey()
    });
    const changesetIdempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: changesetProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const changesetOperations = createChangesetOperationModule({
      workspaceId,
      policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      lifecycleStore: programVocabularyChangesets.lifecycleStore,
      ownerResolution: changesetLifecycle.ownerResolution,
      clock,
      ids: Object.freeze({
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      }),
      authorityPrincipalKeyProfile: changesetProfiles.authorityPrincipal,
      scopePartitionProfile: changesetProfiles.scopePartition,
      requestCanonicalizationProfile: changesetProfiles.requestCanonicalization,
      requestHashSealer: changesetRequestHashSealer,
      idempotencyCredentialProfile: changesetProfiles.idempotencyCredential,
      idempotencyCredentialSealer: changesetIdempotencyCredentialSealer
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
    const intakeRequestHashSealer = createHmacRequestHashSealer({
      profile: INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: randomHmacKey()
    });
    const intakeIdempotencyCredentialSealer = createHmacIdempotencyCredentialSealer({
      profile: intakeProfiles.idempotencyCredential,
      keyBytes: randomHmacKey()
    });
    const intakeFormDraftOperations = createIntakeFormDraftOperationModule({
      workspaceId,
      policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        authorityPrincipalKeyProfile: intakeProfiles.authorityPrincipal,
        scopePartitionProfile: intakeProfiles.scopePartition,
        requestCanonicalizationProfile: intakeProfiles.requestCanonicalization,
        requestHashSealer: intakeRequestHashSealer,
        idempotencyCredentialProfile: intakeProfiles.idempotencyCredential,
        idempotencyCredentialSealer: intakeIdempotencyCredentialSealer
      })
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
    const submissionTriageDraftOperations = createSubmissionTriageDraftOperationModule({
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
          profile: SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE,
          keyBytes: randomHmacKey()
        }),
        idempotencyCredentialProfile: submissionTriageProfiles.idempotencyCredential,
        idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
          profile: submissionTriageProfiles.idempotencyCredential,
          keyBytes: randomHmacKey()
        })
      })
    });
    const submissionDirectEntryDraftOperations =
      createSubmissionDirectEntryDraftOperationModule({
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
            profile: SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
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
        profile: WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE,
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
      requestHashSealer: createHmacRequestHashSealer({
        profile: REVIEWER_ROSTER_DRAFT_REQUEST_HASH_PROFILE,
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
    const decisionDraftOperations = createDecisionDraftOperationModule({
      workspaceId,
      draftPolicy: DECISION_DRAFT_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: decisionProfiles.authorityPrincipal,
      scopePartitionProfile: decisionProfiles.scopePartition,
      requestCanonicalizationProfile: decisionProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: DECISION_DRAFT_REQUEST_HASH_PROFILE,
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
    const engagementDraftOperations = createEngagementDraftOperationModule({
      workspaceId,
      draftPolicy: ENGAGEMENT_DRAFT_ACCESS_POLICY,
      currentAuthority: authority.resolver,
      currentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      authorityPrincipalKeyProfile: engagementProfiles.authorityPrincipal,
      scopePartitionProfile: engagementProfiles.scopePartition,
      requestCanonicalizationProfile: engagementProfiles.requestCanonicalization,
      requestHashSealer: createHmacRequestHashSealer({
        profile: ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: randomHmacKey()
      }),
      idempotencyCredentialProfile: engagementProfiles.idempotencyCredential,
      idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
        profile: engagementProfiles.idempotencyCredential,
        keyBytes: randomHmacKey()
      })
    });
    const eventCreateDraftDomain = createSQLiteEventCreateDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      policy: eventPolicy,
      dependencyRegistry: eventDependencyRegistry,
      dependencySource: eventDependencySource,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newEventId: () => crypto.randomUUID()
      })
    });
    const eventSettingsDraftDomain =
      createSQLiteEventSettingsUpdateDraftEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: eventPolicy,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID()
        })
      });
    const programVocabularyDomain =
      createSQLiteProgramVocabularyDraftEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: programVocabularyPolicy,
        referenceRegistry,
        contributors: contributorAdapters,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newVocabularyItemId: () => crypto.randomUUID()
        })
      });
    const intakeFormDraftDomain = createSQLiteIntakeFormDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      policy: formPolicy,
      repository: intakeRepository,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFormEntityId: () => crypto.randomUUID(),
        newFormVersionId: () => crypto.randomUUID()
      })
    });
    const fieldRegistryDraftDomain = createSQLiteFieldRegistryDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      policy: fieldRegistryPolicy,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
        newFieldId: () => crypto.randomUUID(),
        newChoiceId: () => crypto.randomUUID()
      })
    });
    const submissionTriageDraftDomain =
      createSQLiteSubmissionTriageDraftEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: submissionTriagePolicy,
        repository: submissionTriageRepository,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID()
        })
      });
    const intakeDirectEntryDraftDomain =
      createSQLiteIntakeDirectEntryDraftEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        policy: submissionDirectEntryPolicy,
        repository: intakeRepository,
        classifiedStore: intakeClassifiedStore,
        classifiedProfiles: intakeClassifiedProfiles,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newPayloadRefId: () => crypto.randomUUID(),
          newSubmissionId: () => crypto.randomUUID(),
          newEntryEvidenceId: () => crypto.randomUUID(),
          newPersonId: () => crypto.randomUUID(),
          newParticipantIdentityId: () => crypto.randomUUID(),
          newParticipantEvidenceId: () => crypto.randomUUID()
        })
      });
    const workspaceTeamDraftDomain = Object.freeze({
      capability: WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
      adapter: new SQLiteWorkspaceTeamDraftEffectDomainAdapter({
        sqlite: database.sqlite,
        workspaceId,
        policy: workspaceTeamPolicy,
        classifiedStore: workspaceTeamClassifiedStore,
        invitationLookupKeyBytes: workspaceTeamInvitationLookupKey,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID(),
          newReservationId: () => crypto.randomUUID(),
          newReservationRoleAssignmentId: () => crypto.randomUUID(),
          newReleaseIntentId: () => crypto.randomUUID(),
          newHistoryId: () => crypto.randomUUID(),
          newPayloadRefId: () => crypto.randomUUID(),
          newSessionRevocationIntentId: () => crypto.randomUUID()
        })
      })
    });
    const reviewDraftDomain = createSQLiteReviewDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      repository: reviewRepository,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID(),
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
    const reviewerRosterDraftDomain =
      createSQLiteReviewerRosterDraftEffectDomainRegistration({
        sqlite: database.sqlite,
        workspaceId,
        sources: reviewerRosterSources,
        eventRelationships,
        ids: Object.freeze({
          newChangesetId: () => crypto.randomUUID(),
          newRevisionId: () => crypto.randomUUID(),
          newPreparationHandle: () => crypto.randomUUID(),
          newTimelineId: () => crypto.randomUUID()
        })
      });
    const decisionDraftDomain = createSQLiteDecisionDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      vocabulary: vocabularyRead,
      environment: decisionEnvironment,
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newSessionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID()
      })
    });
    const engagementDraftDomain = createSQLiteEngagementDraftEffectDomainRegistration({
      sqlite: database.sqlite,
      workspaceId,
      operations: Object.freeze({
        operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
        accessPolicy: ENGAGEMENT_DRAFT_ACCESS_POLICY,
        permissionId: ENGAGEMENT_DRAFT_PERMISSION_ID,
        capability: ENGAGEMENT_DRAFT_HANDLER_CAPABILITY,
        approvalPolicy: ENGAGEMENT_DRAFT_APPROVAL_POLICY,
        seal: sealEngagementDraftPreparation
      }),
      eventRelationships,
      ids: Object.freeze({
        newChangesetId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newPreparationHandle: () => crypto.randomUUID(),
        newTimelineId: () => crypto.randomUUID()
      })
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
    const domains = createSQLiteEffectDomainAdapterRegistry([
      eventCreateDraftDomain,
      eventSettingsDraftDomain,
      deadlineDraftDomain,
      programVocabularyDomain,
      schedulePlacementDraftDomain,
      sessionDraftDomain,
      intakeFormDraftDomain,
      fieldRegistryDraftDomain,
      submissionTriageDraftDomain,
      intakeDirectEntryDraftDomain,
      workspaceTeamDraftDomain,
      reviewDraftDomain,
      reviewEvaluationDraftSaveDomain,
      reviewerRosterDraftDomain,
      decisionDraftDomain,
      engagementDraftDomain,
      outboundEmailDeliveryDomain,
      ...organizerCommunicationAuthoringDomains,
      ...communicationSendRuntime.effectDomains,
      changesetLifecycle
    ]);
    const unitOfWork = new SQLiteEffectUnitOfWorkPort(
      database.sqlite,
      domains,
      authority.effectRecheckSource
    );
    const source = composeOperationRegistryModules([
      changesetOperations,
      workspaceOverviewOperations,
      eventOperations,
      eventCreateDraftOperations,
      eventSettingsReadOperations,
      eventSettingsDraftOperations,
      deadlineOperations,
      programVocabularyOperations,
      schedulePlacementOperations,
      sessionOperations,
      sessionDraftOperations,
      fieldRegistryOperations,
      intakeReadOperations,
      intakeFormDraftOperations,
      submissionTriageReadOperations,
      submissionTriageDraftOperations,
      submissionDirectEntryDraftOperations,
      workspaceTeamOperations,
      reviewOperations,
      reviewerRosterOperations,
      decisionOperations,
      decisionDraftOperations,
      engagementOperations,
      engagementDraftOperations,
      organizerCommunicationAuthoringOperations,
      organizerCommunicationAudiencePreviewOperations,
      communicationProviderReadOperations,
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
      unitOfWork,
      newReceiptId: () => crypto.randomUUID()
    });
    const publicFormReadRuntime = await createApplicationOperationRuntime({
      source: publicFormReadOperations.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: new SQLiteReadImmutableAuditPort(database.sqlite),
        clock,
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      },
      unitOfWork,
      newReceiptId: () => crypto.randomUUID()
    });
    assertOperatorAuthorityPolicyCatalogCoversOperationRegistry({
      catalog: authority.policies,
      registry: operations.registry
    });
    const evidence = createBetterAuthOperatorEvidenceVerifier({
      sessions: { getSession: (headers) => auth.api.getSession({ headers }) },
      allowedOrigins: [input.config.baseUrl, ...input.config.trustedOrigins]
    });
    const requestSerialization = createSerialHttpRequestBoundary();
    const app = createHttpApp({
      auth,
      accessContext,
      workspaceId,
      baseUrl: input.config.baseUrl,
      operatorOperations: { operations, evidence },
      requestSerialization
    });
    const publicFormReadAdapter = createPublicOperationsHttpAdapter({
      operations: publicFormReadRuntime,
      evidence: {
        verify({ binding }) {
          if (binding.operationName !== INTAKE_PUBLIC_FORM_READ_OPERATION.name
              || binding.operationVersion !== INTAKE_PUBLIC_FORM_READ_OPERATION.version
              || binding.path !== '/api/public/forms/current') {
            throw new TypeError('ephemeral_public_form_read_binding_mismatch');
          }
          return Object.freeze({
            kind: 'verified' as const,
            evidence: Object.freeze({
              kind: 'public_open' as const,
              surface: 'public_http' as const,
              client: Object.freeze({ key: 'public.intake-form-read' }),
              publicPolicyRevisionId: publicFormPolicyRevisionId
            })
          });
        }
      }
    });
    app.route('/', publicFormReadAdapter);
    let closed = false;
    let closeResult: ReturnType<EphemeralSQLiteRuntime['close']> | undefined;
    const close = () => {
      if (!closed) {
        closeResult = database.close();
        closed = true;
      }
      return closeResult!;
    };
    return Object.freeze({
      database,
      auth,
      app,
      workspaceId,
      communications,
      outboundDispatch,
      close
    });
  } catch (error) {
    database.close();
    throw error;
  }
}
