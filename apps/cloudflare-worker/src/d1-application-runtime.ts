import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createOperatorAuthorityPolicyCatalog,
  type InvocationEvidence
} from '@jooevents/application';
import {
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_OPERATION_KEY_PROFILES,
  EVENT_READ_ACCESS_POLICY,
  EVENT_SELECT_REQUEST_HASH_PROFILE,
  createEventListReadOperationModule,
  createEventOperationModule,
  createEventSelectOperationModule
} from '@jooevents/event-operations';
import {
  parseInstant,
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
  createD1EventCreateEffectDomainRegistration,
  createD1EventSelectEffectDomainRegistration
} from './d1-event-domain';
import { createD1EventReadSource } from './d1-event-read';
import {
  D1EffectUnitOfWorkPort,
  createD1EffectDomainAdapterRegistry
} from './d1-effect-unit-of-work';
import { createD1OperatorCurrentAuthorityResolver } from './d1-operator-authority';

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

/** Builds the first production application slice: authenticated Event reads and writes over D1. */
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
    { policy: EVENT_MANAGE_ACCESS_POLICY, permissionId: 'event.manage' }
  ]);
  const currentAuthority = createD1OperatorCurrentAuthorityResolver({
    session: environment.DB.withSession('first-primary'),
    workspaceId,
    policies
  });
  const reads = createD1EventReadSource({ database: environment.DB, workspaceId });
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
    createD1EventSelectEffectDomainRegistration({ workspaceId })
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
      eventSelectOperations
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
