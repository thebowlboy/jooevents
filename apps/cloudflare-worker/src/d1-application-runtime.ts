import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createOperatorAuthorityPolicyCatalog,
  createWorkspaceTeamOperationModule,
  WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE,
  WORKSPACE_TEAM_OPERATION_ACCESS,
  type InvocationEvidence
} from '@jooevents/application';
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
  parseWorkspaceId
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
import {
  loadCloudflareAuthRuntimeConfiguration,
  type CloudflareAuthBindings
} from './auth-config';
import { createD1CreatedEventInitializer } from './d1-created-event-initializer';
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
import { createD1WorkspaceOverviewReadSource } from './d1-workspace-overview';
import { createD1WorkspaceShellSummaryReadSource } from './d1-workspace-summary';
import { createD1WorkspaceTeamReadSource } from './d1-workspace-team';

export type D1ApplicationRuntimeEnvironment = CloudflareAuthBindings & {
  readonly DB: D1Database;
};

function loadCryptoProfiles(
  environment: D1ApplicationRuntimeEnvironment
): DurableCryptoProfileComposition {
  return createDurableCryptoProfileComposition({
    requestHashKeys: environment.JOOEVENTS_REQUEST_HASH_KEYS,
    idempotencyKeys: environment.JOOEVENTS_IDEMPOTENCY_KEYS,
    classifiedPayloadKeys: environment.JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS,
    persistentHmacKeys: environment.JOOEVENTS_PERSISTENT_HMAC_KEYS
  });
}

function classifiedCommunicationProfile(cryptoProfiles: DurableCryptoProfileComposition) {
  return cryptoProfiles.classifiedPayloadEncryptionProfiles(
    cryptoProfiles.profileSelection(
      'classified_payload',
      'encryption.communication-organizer-payload'
    )
  ).encryptionProfile;
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
  const cryptoProfiles = loadCryptoProfiles(environment);
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
    }
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
    ),
    mountMutations: false
  });
  const domains = createD1EffectDomainAdapterRegistry([
    createD1EventCreateEffectDomainRegistration({
      workspaceId,
      newEventId: () => crypto.randomUUID(),
      createdEventInitializer: createD1CreatedEventInitializer({
        classifiedPayloadEncryptionProfile: classifiedCommunicationProfile(cryptoProfiles),
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
    ...createD1TemplateArtifactNativeEffectDomainRegistrations({
      workspaceId,
      ids: {
        newDraftId: () => crypto.randomUUID(),
        newRevisionId: () => crypto.randomUUID(),
        newArtifactRevisionId: () => crypto.randomUUID()
      }
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
      workspaceTeamOperations
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
  return createOperatorOperationsHttpAdapter({ operations, evidence });
}

export function cloudflareApplicationRuntimeEnabled(
  environment: D1ApplicationRuntimeEnvironment
): boolean {
  return environment.JOOEVENTS_APPLICATION_RUNTIME_ENABLED === 'true';
}
