import {
  composeOperationRegistryModules,
  API_KEY_MANAGE_ACCESS_POLICY,
  API_KEY_MUTATION_REQUEST_HASH_PROFILE,
  COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
  createApiKeyOperationModule,
  createApplicationOperationRuntime,
  createCommunicationProviderReadOperationModule,
  createOperatorAuthorityPolicyCatalog,
  createWorkspaceTeamOperationModule,
  WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  type InvocationEvidence
} from '@jooevents/application';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS,
  WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
  WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE,
  composeOrganizerCommunicationAuthoringOperationModules,
  createOrganizerAudiencePreviewReadOperationModule,
  createOrganizerCommunicationMutationOperationModule,
  createOrganizerCommunicationReadOperationModule,
  createWorkspaceSenderIdentityOperationModule
} from '@jooevents/communication-operations';
import type { InstallationMailSenderIdentity } from '@jooevents/communications';
import {
  DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_OPERATION_KEY_PROFILES,
  DEADLINE_READ_ACCESS_POLICY,
  createDeadlineOperationModule
} from '@jooevents/deadline-operations';
import {
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_OPERATION_KEY_PROFILES,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SELECT_REQUEST_HASH_PROFILE,
  EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
  createEventListReadOperationModule,
  createEventOperationModule,
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
  FILES_COMMAND_ACCESS_POLICY,
  FILES_COMMAND_REQUEST_HASH_PROFILE,
  FILE_READ_ACCESS_POLICY,
  createFilesCommandOperationModule,
  createFilesReadOperationModule
} from '@jooevents/files-operations';
import { parseFileUploadLimits } from '@jooevents/files/commands';
import {
  PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
  createProgramVocabularyDirectOperationModule,
  createProgramVocabularyMergeOperationModule,
  createProgramVocabularyReadOperationModule
} from '@jooevents/program-operations';
import {
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE,
  createSchedulePlacementDirectOperationModule,
  createSchedulePlacementOperationModule
} from '@jooevents/schedule-operations';
import {
  SESSION_CHANGE_REQUEST_HASH_PROFILE,
  SESSION_MANAGE_ACCESS_POLICY,
  SESSION_READ_ACCESS_POLICY,
  createSessionDirectOperationModule,
  createSessionOperationModule
} from '@jooevents/session-operations';
import {
  TASK_MANAGE_ACCESS_POLICY,
  TASK_MUTATION_REQUEST_HASH_PROFILE,
  TASK_OPERATION_KEY_PROFILES,
  createTaskBoardReadOperationModule,
  createTaskMutationOperationModule
} from '@jooevents/task-operations';
import {
  TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
  TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
  TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES,
  createTemplateArtifactNativeOperationModule,
  createTemplateArtifactReadOperationModule
} from '@jooevents/template-authoring-operations';
import {
  WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
  WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
  createOperationHistoryReadOperationModule,
  createWorkspaceOverviewOperationModule,
  createWorkspaceShellSummaryOperationModule
} from '@jooevents/workspace-operations';
import {
  parseInstant,
  parseContractVersion,
  parseInvocationId,
  parseWorkspaceId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  createDurableCryptoProfileComposition,
  type DurableCryptoProfileComposition
} from '@jooevents/application/durable-crypto-profiles';
import {
  createBetterAuthOperatorEvidenceVerifier,
  createOperatorOperationsHttpAdapter
} from '@jooevents/http-operation-adapters';
import { createD1Auth } from './d1-auth';
import { createD1ApiKeyManagementReadPort } from './d1-api-key-management';
import {
  createD1ApiKeyMutationEffectDomainRegistration,
  createD1ApiKeyResponseSecretHandoff
} from './d1-api-key-mutation';
import {
  loadCloudflareAuthRuntimeConfiguration,
  type CloudflareAuthBindings
} from './auth-config';
import { createD1CreatedEventInitializer } from './d1-created-event-initializer';
import { createD1CommunicationProviderReadPorts } from './d1-communication-provider-read';
import {
  createD1DeadlineDirectEffectDomainRegistration,
  createD1DeadlineReadSource
} from './d1-deadline';
import {
  createD1EventCreateEffectDomainRegistration,
  createD1EventSelectEffectDomainRegistration
} from './d1-event-domain';
import { createD1EventReadSource } from './d1-event-read';
import {
  createD1EventSettingsEffectDomainRegistration,
  createD1EventSettingsReadSource
} from './d1-event-settings';
import {
  createD1FieldRegistryDirectEffectDomainRegistration,
  createD1FieldRegistrySnapshotSource
} from './d1-field-registry';
import {
  createD1FileDownloadAssetSource,
  createD1FilesOrganizerReadPort
} from './d1-files';
import { createD1FilesOperatorHttpTransport } from './d1-files-http';
import { createD1FilesCommandEffectDomainRegistration } from './d1-files-mutation';
import {
  createD1TaskBoardReadSource,
  createD1TaskDirectEffectDomainRegistration
} from './d1-task';
import {
  createD1TemplateArtifactNativeEffectDomainRegistrations,
  createD1TemplateArtifactReadSource
} from './d1-template-artifact';
import {
  D1EffectUnitOfWorkPort,
  createD1EffectDomainAdapterRegistry
} from './d1-effect-unit-of-work';
import { createD1OperatorCurrentAuthorityResolver } from './d1-operator-authority';
import { createD1OperationHistoryReadSource } from './d1-operation-history';
import { createD1OrganizerCommunicationReadPort } from './d1-organizer-communication-read';
import { createD1OrganizerAudiencePreviewReadPort } from './d1-organizer-audience-preview-read';
import {
  createD1OrganizerCommunicationPayloadEffectDomainRegistration
} from './d1-organizer-communication-payload-mutation';
import { createD1ProgramVocabularySnapshotReadSource } from './d1-program-vocabulary';
import {
  createD1ProgramVocabularyDirectEffectDomainRegistration
} from './d1-program-vocabulary-mutation';
import {
  createD1ProgramVocabularyMergeEffectDomainRegistrations
} from './d1-program-vocabulary-merge';
import { createD1SchedulePlacementReadSource } from './d1-schedule-placement';
import {
  createD1SchedulePlacementDirectEffectDomainRegistration
} from './d1-schedule-placement-mutation';
import { createD1SessionCatalogReadSource } from './d1-session-catalog';
import { createD1SessionDirectEffectDomainRegistration } from './d1-session-mutation';
import { createD1WorkspaceOverviewReadSource } from './d1-workspace-overview';
import { createD1WorkspaceShellSummaryReadSource } from './d1-workspace-summary';
import { createD1WorkspaceTeamReadSource } from './d1-workspace-team';
import { createD1WorkspaceTeamMutationEffectDomainRegistration } from './d1-workspace-team-mutation';
import {
  createD1WorkspaceSenderIdentityEffectDomainRegistration,
  createD1WorkspaceSenderIdentityReadPort
} from './d1-workspace-sender-identity';
import { createR2FileBlobStore } from './r2-file-blob-store';

export type D1ApplicationRuntimeEnvironment = CloudflareAuthBindings & {
  readonly DB: D1Database;
  readonly FILES: R2Bucket;
  readonly JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER?: string;
  readonly JOOEVENTS_FILES_MAX_UPLOAD_BYTES_ORGANIZER?: string;
  readonly JOOEVENTS_FILES_MAX_TOTAL_BYTES_PER_SPEAKER_EVENT?: string;
  readonly JOOEVENTS_MAIL_FROM_ADDRESS?: string;
  readonly JOOEVENTS_MAIL_FROM_NAME?: string;
  readonly JOOEVENTS_MAIL_REPLY_TO?: string;
};

export function loadD1CryptoProfiles(
  environment: D1ApplicationRuntimeEnvironment
): DurableCryptoProfileComposition {
  return createDurableCryptoProfileComposition({
    requestHashKeys: environment.JOOEVENTS_REQUEST_HASH_KEYS,
    idempotencyKeys: environment.JOOEVENTS_IDEMPOTENCY_KEYS,
    classifiedPayloadKeys: environment.JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS,
    persistentHmacKeys: environment.JOOEVENTS_PERSISTENT_HMAC_KEYS
  });
}

export function classifiedD1CommunicationProfiles(
  cryptoProfiles: DurableCryptoProfileComposition
) {
  return cryptoProfiles.classifiedPayloadEncryptionProfiles(
    cryptoProfiles.profileSelection(
      'classified_payload',
      'encryption.communication-organizer-payload'
    )
  );
}

const WORKSPACE_TEAM_KEY_PROFILES = Object.freeze({
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

const API_KEY_OPERATION_KEY_PROFILES = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.workspace-api-key.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.workspace-api-key.workspace-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.workspace-api-key.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.workspace-api-key.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const FILES_OPERATION_KEY_PROFILES = Object.freeze({
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

const COMMUNICATION_PROVIDER_READ_PROFILES = Object.freeze({
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

const ORGANIZER_COMMUNICATION_PROFILES = Object.freeze({
  authorityPrincipalKeyProfile: Object.freeze({
    key: 'key-profile.communication.organizer-principal',
    version: parseContractVersion(1)
  }),
  scopePartitionProfile: Object.freeze({
    key: 'key-profile.communication.current-event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalizationProfile: Object.freeze({
    key: 'key-profile.communication.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredentialProfile: Object.freeze({
    key: 'key-profile.communication.idempotency-credential',
    version: parseContractVersion(1)
  })
});

function createOrganizerCommunicationRequestHashSealer(
  cryptoProfiles: DurableCryptoProfileComposition
) {
  const operationNames: ReadonlySet<string> = new Set(
    Object.values(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS)
      .map((operation) => operation.name)
  );
  return Object.freeze({
    seal(canonicalRequestBytes: Uint8Array) {
      if (!(canonicalRequestBytes instanceof Uint8Array)
          || canonicalRequestBytes.byteLength === 0) {
        throw new TypeError('communication_request_hash_input_invalid');
      }
      let operationName: string;
      try {
        const request = JSON.parse(new TextDecoder().decode(canonicalRequestBytes)) as {
          readonly operation?: { readonly name?: unknown };
        };
        if (typeof request.operation?.name !== 'string'
            || !operationNames.has(request.operation.name)) throw new TypeError();
        operationName = request.operation.name;
      } catch {
        throw new TypeError('communication_request_hash_operation_invalid');
      }
      return cryptoProfiles.requestHashSealer(Object.freeze({
        key: `request-hash.communication.organizer.${operationName}`,
        version: parseContractVersion(1)
      })).seal(canonicalRequestBytes);
    }
  });
}

const SENDER_IDENTITY_OPERATION_KEY_PROFILES = Object.freeze({
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

function loadInstallationMailSenderIdentity(
  environment: D1ApplicationRuntimeEnvironment
): InstallationMailSenderIdentity {
  const fromAddress = environment.JOOEVENTS_MAIL_FROM_ADDRESS?.trim();
  if (!fromAddress) throw new TypeError('JOOEVENTS_MAIL_FROM_ADDRESS is required');
  const fromDisplayName = environment.JOOEVENTS_MAIL_FROM_NAME?.trim();
  const replyToAddress = environment.JOOEVENTS_MAIL_REPLY_TO?.trim();
  return Object.freeze({
    fromAddress,
    ...(fromDisplayName ? { fromDisplayName } : {}),
    ...(replyToAddress ? { replyToAddress } : {})
  });
}

const PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.program-vocabulary.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.program-vocabulary.event-scope',
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

const SCHEDULE_OPERATION_KEY_PROFILES = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.schedule.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.schedule.event-scope',
    version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.schedule.request-canonicalization',
    version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.schedule.idempotency-credential',
    version: parseContractVersion(1)
  })
});

const SESSION_OPERATION_KEY_PROFILES = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.session.operator-principal',
    version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.session.event-scope',
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

function classifiedWorkspaceInvitationProfiles(
  cryptoProfiles: DurableCryptoProfileComposition
) {
  const selected = cryptoProfiles.classifiedPayloadEncryptionProfiles(
    cryptoProfiles.profileSelection(
      'classified_payload',
      'encryption.workspace-invitation'
    )
  );
  return Object.freeze({
    encryptionProfile: selected.encryptionProfile,
    retainedEncryptionProfiles: selected.retainedEncryptionProfiles
  });
}

/** Builds the authenticated workspace-history and current Event application slice over D1. */
export async function createConfiguredD1ApplicationRuntime(
  environment: D1ApplicationRuntimeEnvironment
) {
  if (environment.JOOEVENTS_APPLICATION_RUNTIME_ENABLED !== 'true') {
    throw new TypeError('cloudflare_application_runtime_not_enabled');
  }
  const config = loadCloudflareAuthRuntimeConfiguration(environment);
  const workspaceId = parseWorkspaceId(config.workspaceId);
  const cryptoProfiles = loadD1CryptoProfiles(environment);
  const clock = Object.freeze({ now: () => parseInstant(new Date().toISOString()) });
  const policies = createOperatorAuthorityPolicyCatalog([
    { policy: EVENT_READ_ACCESS_POLICY, permissionId: 'event.read' },
    { policy: EVENT_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' },
    { policy: FIELD_REGISTRY_READ_ACCESS_POLICY, permissionId: 'event.read' },
    { policy: FIELD_REGISTRY_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' },
    { policy: DEADLINE_READ_ACCESS_POLICY, permissionId: 'event.read' },
    { policy: DEADLINE_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' },
    { policy: TASK_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' },
    { policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY, permissionId: 'event.read' },
    { policy: WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY, permissionId: 'event.read' },
    {
      policy: WORKSPACE_TEAM_OPERATION_ACCESS.read.policy,
      permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.read.permissionId
    },
    {
      policy: WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy,
      permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.invite.permissionId
    },
    {
      policy: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy,
      permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.permissionId
    },
    {
      policy: WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy,
      permissionId: WORKSPACE_TEAM_OPERATION_ACCESS.remove.permissionId
    },
    { policy: FILE_READ_ACCESS_POLICY, permissionId: 'submission.read' },
    { policy: FILES_COMMAND_ACCESS_POLICY, permissionId: 'event.manage' },
    { policy: PROGRAM_VOCABULARY_READ_ACCESS_POLICY, permissionId: 'event.read' },
    { policy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
      permissionId: 'program.vocabulary.manage' },
    { policy: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY, permissionId: 'schedule.read' },
    { policy: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY, permissionId: 'schedule.manage' },
    { policy: SESSION_READ_ACCESS_POLICY, permissionId: 'event.read' },
    { policy: SESSION_MANAGE_ACCESS_POLICY, permissionId: 'schedule.manage' },
    { policy: API_KEY_MANAGE_ACCESS_POLICY, permissionId: 'integration.api.manage' },
    { policy: COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
      permissionId: 'communication.provider.manage' },
    { policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      permissionId: 'communication.draft' }
  ]);
  const currentAuthority = createD1OperatorCurrentAuthorityResolver({
    session: environment.DB.withSession('first-primary'),
    workspaceId,
    policies
  });
  const reads = createD1EventReadSource({ database: environment.DB, workspaceId });
  const settings = createD1EventSettingsReadSource({ database: environment.DB, workspaceId });
  const fieldRegistry = createD1FieldRegistrySnapshotSource({
    database: environment.DB,
    workspaceId
  });
  const deadlines = createD1DeadlineReadSource({ database: environment.DB, workspaceId });
  const tasks = createD1TaskBoardReadSource({ database: environment.DB, workspaceId });
  const templateArtifacts = createD1TemplateArtifactReadSource({
    database: environment.DB,
    workspaceId
  });
  const operationHistory = createD1OperationHistoryReadSource({
    database: environment.DB,
    workspaceId
  });
  const programVocabulary = createD1ProgramVocabularySnapshotReadSource({
    database: environment.DB,
    workspaceId
  });
  const schedule = createD1SchedulePlacementReadSource({
    database: environment.DB,
    workspaceId
  });
  const sessions = createD1SessionCatalogReadSource({
    database: environment.DB,
    workspaceId
  });
  const workspaceSummary = createD1WorkspaceShellSummaryReadSource({
    database: environment.DB,
    workspaceId
  });
  const workspaceOverview = createD1WorkspaceOverviewReadSource({
    database: environment.DB,
    workspaceId
  });
  const workspaceTeam = createD1WorkspaceTeamReadSource({
    database: environment.DB,
    workspaceId,
    nowEpochMs: Date.now,
    classifiedPayload: classifiedWorkspaceInvitationProfiles(cryptoProfiles)
  });
  const apiKeys = createD1ApiKeyManagementReadPort({
    database: environment.DB,
    workspaceId,
    nowEpochMs: Date.now
  });
  const apiKeySecretHandoff = createD1ApiKeyResponseSecretHandoff();
  const files = createD1FilesOrganizerReadPort({
    database: environment.DB,
    workspaceId
  });
  const fileDownloadAssets = createD1FileDownloadAssetSource({
    database: environment.DB,
    workspaceId
  });
  const fileBlobs = createR2FileBlobStore({ bucket: environment.FILES });
  const fileLimits = parseFileUploadLimits({
    JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER:
      environment.JOOEVENTS_FILES_MAX_UPLOAD_BYTES_SPEAKER,
    JOOEVENTS_FILES_MAX_UPLOAD_BYTES_ORGANIZER:
      environment.JOOEVENTS_FILES_MAX_UPLOAD_BYTES_ORGANIZER,
    JOOEVENTS_FILES_MAX_TOTAL_BYTES_PER_SPEAKER_EVENT:
      environment.JOOEVENTS_FILES_MAX_TOTAL_BYTES_PER_SPEAKER_EVENT
  });
  const communicationProvider = createD1CommunicationProviderReadPorts({
    database: environment.DB,
    workspaceId
  });
  const installationMailSender = loadInstallationMailSenderIdentity(environment);
  const senderIdentity = createD1WorkspaceSenderIdentityReadPort({
    database: environment.DB,
    workspaceId,
    installation: installationMailSender
  });
  const organizerCommunicationRead = createD1OrganizerCommunicationReadPort({
    database: environment.DB,
    classifiedPayload: classifiedD1CommunicationProfiles(cryptoProfiles)
  });
  const organizerAudiencePreviewRead = await createD1OrganizerAudiencePreviewReadPort({
    database: environment.DB,
    workspaceId,
    cryptoProfiles
  });
  const organizerCommunicationCurrentEvent = Object.freeze({
    async resolveCurrentEvent(requestedWorkspaceId: WorkspaceId) {
      const selected = await reads.resolveCurrentEvent(requestedWorkspaceId);
      return selected.eventId === undefined
        ? undefined
        : Object.freeze({ eventId: selected.eventId, evidenceIds: selected.evidenceIds });
    }
  });
  const common = Object.freeze({
    workspaceId,
    currentAuthority,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: EVENT_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: EVENT_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: EVENT_OPERATION_KEY_PROFILES.requestCanonicalization
  });
  const idempotencyCredentialSealer = cryptoProfiles.idempotencyCredentialSealer(
    EVENT_OPERATION_KEY_PROFILES.idempotencyCredential
  );
  const eventOperations = createEventOperationModule({
    ...common,
    policies: Object.freeze({
      read: EVENT_READ_ACCESS_POLICY,
      manage: EVENT_MANAGE_ACCESS_POLICY
    }),
    currentEventRead: reads,
    requestHashSealer: cryptoProfiles.requestHashSealer(EVENT_CREATE_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: EVENT_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer,
    mountLegacyDirectCreate: true
  });
  const eventListOperations = createEventListReadOperationModule({
    ...common,
    readPolicy: EVENT_READ_ACCESS_POLICY,
    list: reads
  });
  const eventSelectOperations = createEventSelectOperationModule({
    ...common,
    managePolicy: EVENT_MANAGE_ACCESS_POLICY,
    requestHashSealer: cryptoProfiles.requestHashSealer(EVENT_SELECT_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: EVENT_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer
  });
  const eventSettingsReadOperations = createEventSettingsReadOperationModule({
    ...common,
    readPolicy: EVENT_READ_ACCESS_POLICY,
    currentSettingsRead: settings
  });
  const eventSettingsUpdateOperations = createEventSettingsUpdateOperationModule({
    ...common,
    managePolicy: EVENT_MANAGE_ACCESS_POLICY,
    requestHashSealer: cryptoProfiles.requestHashSealer(
      EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile: EVENT_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer
  });
  const fieldRegistryOperations = createFieldRegistryOperationModule({
    workspaceId,
    policies: Object.freeze({
      read: FIELD_REGISTRY_READ_ACCESS_POLICY,
      manage: FIELD_REGISTRY_MANAGE_ACCESS_POLICY
    }),
    currentAuthority,
    currentEvent: reads,
    snapshotRead: fieldRegistry,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      FIELD_REGISTRY_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(
      FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile: FIELD_REGISTRY_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      FIELD_REGISTRY_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const deadlineOperations = createDeadlineOperationModule({
    workspaceId,
    policies: Object.freeze({
      read: DEADLINE_READ_ACCESS_POLICY,
      manage: DEADLINE_MANAGE_ACCESS_POLICY
    }),
    currentAuthority,
    currentEvent: reads,
    deadlineRead: deadlines,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: DEADLINE_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: DEADLINE_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      DEADLINE_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(DEADLINE_CHANGE_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: DEADLINE_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      DEADLINE_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const taskBoardOperations = createTaskBoardReadOperationModule({
    workspaceId,
    readPolicy: EVENT_READ_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    tasks,
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
    currentEvent: reads,
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
  const templateArtifactReadOperations = createTemplateArtifactReadOperationModule({
    workspaceId,
    readPolicy: EVENT_READ_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    currentRead: templateArtifacts,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile:
      TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.requestCanonicalization
  });
  const templateArtifactNativeOperations = createTemplateArtifactNativeOperationModule({
    workspaceId,
    policy: EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile:
      TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.requestCanonicalization,
    draftRequestHashSealer: cryptoProfiles.requestHashSealer(
      TEMPLATE_ARTIFACT_NATIVE_DRAFT_REQUEST_HASH_PROFILE
    ),
    publishRequestHashSealer: cryptoProfiles.requestHashSealer(
      TEMPLATE_ARTIFACT_NATIVE_PUBLISH_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile:
      TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      TEMPLATE_ARTIFACT_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const operationHistoryOperations = createOperationHistoryReadOperationModule({
    workspaceId,
    policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    read: operationHistory,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    crypto: Object.freeze({
      authorityPrincipalKeyProfile: EVENT_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: EVENT_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: EVENT_OPERATION_KEY_PROFILES.requestCanonicalization
    })
  });
  const workspaceSummaryOperations = createWorkspaceShellSummaryOperationModule({
    workspaceId,
    policy: WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
    currentAuthority,
    read: workspaceSummary,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    crypto: Object.freeze({
      authorityPrincipalKeyProfile: EVENT_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: EVENT_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile: EVENT_OPERATION_KEY_PROFILES.requestCanonicalization
    })
  });
  const workspaceOverviewOperations = createWorkspaceOverviewOperationModule({
    workspaceId,
    policy: WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
    currentAuthority,
    overviewRead: workspaceOverview,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: EVENT_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: EVENT_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: EVENT_OPERATION_KEY_PROFILES.requestCanonicalization
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
    teamRead: workspaceTeam,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: WORKSPACE_TEAM_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: WORKSPACE_TEAM_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: WORKSPACE_TEAM_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(
      WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile: WORKSPACE_TEAM_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      WORKSPACE_TEAM_KEY_PROFILES.idempotencyCredential
    )
  });
  const apiKeyOperations = createApiKeyOperationModule({
    workspaceId,
    policy: API_KEY_MANAGE_ACCESS_POLICY,
    currentAuthority,
    read: apiKeys,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: API_KEY_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: API_KEY_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: API_KEY_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(API_KEY_MUTATION_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: API_KEY_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      API_KEY_OPERATION_KEY_PROFILES.idempotencyCredential
    ),
    mountMutations: true
  });
  const fileReadOperations = createFilesReadOperationModule({
    workspaceId,
    readPolicy: FILE_READ_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: FILES_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: FILES_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: FILES_OPERATION_KEY_PROFILES.requestCanonicalization,
    read: files
  });
  const fileCommandOperations = createFilesCommandOperationModule({
    workspaceId,
    commandPolicy: FILES_COMMAND_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: FILES_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: FILES_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: FILES_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(FILES_COMMAND_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: FILES_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      FILES_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const communicationProviderReadOperations = createCommunicationProviderReadOperationModule({
    workspaceId,
    policy: COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
    currentAuthority,
    configuration: communicationProvider.configuration,
    readiness: communicationProvider.readiness,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    crypto: COMMUNICATION_PROVIDER_READ_PROFILES
  });
  const senderIdentityOperations = createWorkspaceSenderIdentityOperationModule({
    workspaceId,
    policy: WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY,
    currentAuthority,
    read: senderIdentity,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    crypto: Object.freeze({
      authorityPrincipalKeyProfile:
        SENDER_IDENTITY_OPERATION_KEY_PROFILES.authorityPrincipal,
      scopePartitionProfile: SENDER_IDENTITY_OPERATION_KEY_PROFILES.scopePartition,
      requestCanonicalizationProfile:
        SENDER_IDENTITY_OPERATION_KEY_PROFILES.requestCanonicalization,
      requestHashSealer: cryptoProfiles.requestHashSealer(
        WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE
      ),
      idempotencyCredentialProfile:
        SENDER_IDENTITY_OPERATION_KEY_PROFILES.idempotencyCredential,
      idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
        SENDER_IDENTITY_OPERATION_KEY_PROFILES.idempotencyCredential
      )
    })
  });
  const organizerCommunicationReadOperations = createOrganizerCommunicationReadOperationModule({
    workspaceId,
    policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
    currentAuthority,
    currentEvent: organizerCommunicationCurrentEvent,
    read: organizerCommunicationRead,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    crypto: ORGANIZER_COMMUNICATION_PROFILES
  });
  const organizerCommunicationMutationOperations =
    createOrganizerCommunicationMutationOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority,
      currentEvent: organizerCommunicationCurrentEvent,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: Object.freeze({
        ...ORGANIZER_COMMUNICATION_PROFILES,
        requestHashSealer: createOrganizerCommunicationRequestHashSealer(cryptoProfiles),
        idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
          ORGANIZER_COMMUNICATION_PROFILES.idempotencyCredentialProfile
        )
      }),
      enabledOperations: ['store_communication_authoring_payload']
    });
  const organizerCommunicationAuthoringOperations =
    composeOrganizerCommunicationAuthoringOperationModules({
      read: organizerCommunicationReadOperations,
      mutation: organizerCommunicationMutationOperations
    });
  const organizerAudiencePreviewReadOperations =
    createOrganizerAudiencePreviewReadOperationModule({
      workspaceId,
      policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
      currentAuthority,
      currentEvent: organizerCommunicationCurrentEvent,
      read: organizerAudiencePreviewRead,
      clock,
      ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
      crypto: ORGANIZER_COMMUNICATION_PROFILES,
      enabledOperations: ['list_audience_options']
    });
  const programVocabularyReadOperations = createProgramVocabularyReadOperationModule({
    workspaceId,
    readPolicy: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    snapshotRead: programVocabulary,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.requestCanonicalization
  });
  const programVocabularyDirectOperations = createProgramVocabularyDirectOperationModule({
    workspaceId,
    managePolicy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(
      PROGRAM_VOCABULARY_DIRECT_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const programVocabularyMergeOperations = createProgramVocabularyMergeOperationModule({
    workspaceId,
    managePolicy: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.requestCanonicalization,
    draftRequestHashSealer: cryptoProfiles.requestHashSealer(
      PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE
    ),
    publishRequestHashSealer: cryptoProfiles.requestHashSealer(
      PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile:
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      PROGRAM_VOCABULARY_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const scheduleReadOperations = createSchedulePlacementOperationModule({
    workspaceId,
    policies: {
      read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
      manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
    },
    currentAuthority,
    currentEvent: reads,
    scheduleRead: schedule,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: SCHEDULE_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: SCHEDULE_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: SCHEDULE_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(
      SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile: SCHEDULE_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      SCHEDULE_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const scheduleDirectOperations = createSchedulePlacementDirectOperationModule({
    workspaceId,
    policies: {
      read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
      manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
    },
    currentAuthority,
    currentEvent: reads,
    scheduleRead: schedule,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: SCHEDULE_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: SCHEDULE_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: SCHEDULE_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(
      SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE
    ),
    idempotencyCredentialProfile: SCHEDULE_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      SCHEDULE_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const sessionReadOperations = createSessionOperationModule({
    workspaceId,
    readPolicy: SESSION_READ_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    sessions,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: SESSION_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: SESSION_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: SESSION_OPERATION_KEY_PROFILES.requestCanonicalization
  });
  const sessionDirectOperations = createSessionDirectOperationModule({
    workspaceId,
    managePolicy: SESSION_MANAGE_ACCESS_POLICY,
    currentAuthority,
    currentEvent: reads,
    clock,
    ids: Object.freeze({ newInvocationId: () => parseInvocationId(crypto.randomUUID()) }),
    authorityPrincipalKeyProfile: SESSION_OPERATION_KEY_PROFILES.authorityPrincipal,
    scopePartitionProfile: SESSION_OPERATION_KEY_PROFILES.scopePartition,
    requestCanonicalizationProfile: SESSION_OPERATION_KEY_PROFILES.requestCanonicalization,
    requestHashSealer: cryptoProfiles.requestHashSealer(SESSION_CHANGE_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: SESSION_OPERATION_KEY_PROFILES.idempotencyCredential,
    idempotencyCredentialSealer: cryptoProfiles.idempotencyCredentialSealer(
      SESSION_OPERATION_KEY_PROFILES.idempotencyCredential
    )
  });
  const workspaceTeamMutationDomain = cryptoProfiles.withPersistentHmacKeySelection(
    'security.workspace-invitation-lookup',
    (selection) => createD1WorkspaceTeamMutationEffectDomainRegistration({
      workspaceId,
      classifiedPayload: classifiedWorkspaceInvitationProfiles(cryptoProfiles),
      invitationLookupKeyBytes: selection.active.keyBytes,
      ids: {
        newPreparationHandle: () => crypto.randomUUID(),
        newReservationId: () => crypto.randomUUID(),
        newReservationRoleAssignmentId: () => crypto.randomUUID(),
        newReleaseIntentId: () => crypto.randomUUID(),
        newHistoryId: () => crypto.randomUUID(),
        newPayloadRefId: () => crypto.randomUUID(),
        newSessionRevocationIntentId: () => crypto.randomUUID()
      }
    })
  );
  const domains = createD1EffectDomainAdapterRegistry([
    createD1EventCreateEffectDomainRegistration({
      workspaceId,
      newEventId: () => crypto.randomUUID(),
      createdEventInitializer: createD1CreatedEventInitializer({
        classifiedPayloadEncryptionProfile:
          classifiedD1CommunicationProfiles(cryptoProfiles).encryptionProfile,
        ids: {
          newFieldId: () => crypto.randomUUID(),
          newChoiceId: () => crypto.randomUUID()
        }
      })
    }),
    createD1EventSelectEffectDomainRegistration({ workspaceId }),
    createD1EventSettingsEffectDomainRegistration({ workspaceId }),
    createD1FieldRegistryDirectEffectDomainRegistration({
      workspaceId,
      ids: {
        newFieldId: () => crypto.randomUUID(),
        newChoiceId: () => crypto.randomUUID()
      }
    }),
    createD1ProgramVocabularyDirectEffectDomainRegistration({
      workspaceId,
      newVocabularyItemId: () => crypto.randomUUID()
    }),
    ...createD1ProgramVocabularyMergeEffectDomainRegistrations({
      workspaceId,
      ids: {
        newDraftId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID()
      }
    }),
    createD1SessionDirectEffectDomainRegistration({
      workspaceId,
      newSessionId: () => crypto.randomUUID()
    }),
    createD1SchedulePlacementDirectEffectDomainRegistration({
      workspaceId,
      newOccurrenceId: () => crypto.randomUUID()
    }),
    createD1DeadlineDirectEffectDomainRegistration({
      workspaceId,
      newDeadlineId: () => crypto.randomUUID()
    }),
    createD1TaskDirectEffectDomainRegistration({
      workspaceId,
      ids: {
        newTaskDefinitionId: () => crypto.randomUUID(),
        newTaskDefinitionRevisionId: () => crypto.randomUUID(),
        newDeadlineId: () => crypto.randomUUID()
      }
    }),
    createD1FilesCommandEffectDomainRegistration({
      workspaceId,
      limits: fileLimits,
      storageProvider: fileBlobs.provider,
      ids: {
        newPreparationHandle: () => crypto.randomUUID(),
        newFactId: () => crypto.randomUUID()
      }
    }),
    createD1WorkspaceSenderIdentityEffectDomainRegistration({
      workspaceId,
      installation: installationMailSender
    }),
    createD1OrganizerCommunicationPayloadEffectDomainRegistration({
      workspaceId,
      classifiedPayload: classifiedD1CommunicationProfiles(cryptoProfiles),
      ids: { newTimelineId: () => crypto.randomUUID() }
    }),
    ...createD1TemplateArtifactNativeEffectDomainRegistrations({
      workspaceId,
      ids: {
        newDraftId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newArtifactRevisionId: () => crypto.randomUUID()
      }
    }),
    workspaceTeamMutationDomain,
    createD1ApiKeyMutationEffectDomainRegistration({
      workspaceId,
      ids: {
        newApiKeyId: () => crypto.randomUUID(),
        newSecretHandle: () => crypto.randomUUID()
      },
      secretDelivery: apiKeySecretHandoff
    })
  ]);
  const unitOfWork = new D1EffectUnitOfWorkPort(environment.DB, domains, {
    authorityRecheck: (buffered) => ({
      now: clock.now,
      resolveAuthority: createD1OperatorCurrentAuthorityResolver({
        session: buffered.readSession,
        unitOfWork: buffered,
        workspaceId,
        policies
      }).resolve
    }),
    recordShortOperationAudit: () => undefined
  });
  const operations = await createApplicationOperationRuntime({
    source: composeOperationRegistryModules([
      eventOperations,
      eventListOperations,
      eventSelectOperations,
      eventSettingsReadOperations,
      eventSettingsUpdateOperations,
      fieldRegistryOperations,
      deadlineOperations,
      taskBoardOperations,
      taskMutationOperations,
      templateArtifactReadOperations,
      templateArtifactNativeOperations,
      operationHistoryOperations,
      workspaceSummaryOperations,
      workspaceOverviewOperations,
      workspaceTeamOperations,
      apiKeyOperations,
      fileReadOperations,
      fileCommandOperations,
      communicationProviderReadOperations,
      senderIdentityOperations,
      organizerCommunicationAuthoringOperations,
      organizerAudiencePreviewReadOperations,
      programVocabularyReadOperations,
      programVocabularyDirectOperations,
      programVocabularyMergeOperations,
      scheduleReadOperations,
      scheduleDirectOperations,
      sessionReadOperations,
      sessionDirectOperations
    ]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock,
      newInvocationId: () => parseInvocationId(crypto.randomUUID())
    },
    unitOfWork
  });
  const auth = createD1Auth(environment.DB, config);
  const evidence = createBetterAuthOperatorEvidenceVerifier({
    sessions: { getSession: (headers) => auth.api.getSession({ headers }) },
    allowedOrigins: [config.baseUrl, ...config.trustedOrigins]
  });
  const operator = createOperatorOperationsHttpAdapter({ operations, evidence });
  const operatorWithApiKeySecretHandoff = Object.freeze({
    async fetch(request: Request): Promise<Response> {
      return apiKeySecretHandoff.attach(await operator.fetch(request));
    }
  });
  const fileReadBinding = operations.registry.operatorHttpBindings.find((binding) =>
    binding.operationName === 'file.overview.read' && binding.operationVersion === 1);
  if (!fileReadBinding) throw new TypeError('cloudflare_file_read_binding_missing');
  const fileCommandBinding = operations.registry.operatorHttpEffectBindings.find((binding) =>
    binding.operationName === 'file.upload.intent' && binding.operationVersion === 1);
  if (!fileCommandBinding) throw new TypeError('cloudflare_file_command_binding_missing');
  return createD1FilesOperatorHttpTransport({
    database: environment.DB,
    workspaceId,
    delegate: operatorWithApiKeySecretHandoff,
    evidence,
    evidenceBinding: fileReadBinding,
    commandEvidenceBinding: fileCommandBinding,
    currentAuthority,
    currentEvent: reads,
    clock,
    assets: fileDownloadAssets,
    blobs: fileBlobs
  });
}

export function cloudflareApplicationRuntimeEnabled(
  environment: D1ApplicationRuntimeEnvironment
): boolean {
  return environment.JOOEVENTS_APPLICATION_RUNTIME_ENABLED === 'true';
}
