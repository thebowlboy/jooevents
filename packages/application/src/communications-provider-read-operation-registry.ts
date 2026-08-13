import {
  EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  emailProviderConfigurationReadInputSchema,
  emailProviderConnectionCanonicalResultSchema,
  emailProviderReadinessCanonicalResultSchema,
  emailProviderReadinessGetInputSchema,
  emailProviderReadinessReadOperationResultSchema,
  emailProviderConfigurationReadOperationResultSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOperationAutonomyPolicy } from './autonomy';
import {
  createReadInvocationContextBuilder,
  type InvocationEvidence,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext
} from './operations';
import {
  COMMUNICATION_PROVIDER_OPERATIONS,
  createCommunicationProviderReadOperations,
  type CommunicationProviderConfigurationReadPort,
  type CommunicationProviderReadinessReadPort
} from './communications-provider-operations';

export const COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef =
  Object.freeze({
    key: 'policy.communication.provider.manage',
    version: parseContractVersion(1)
  });

export interface CommunicationProviderReadOperationIds {
  newInvocationId(): InvocationId;
}

export interface CommunicationProviderReadOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}

export interface CreateCommunicationProviderReadOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly configuration: CommunicationProviderConfigurationReadPort;
  readonly readiness: CommunicationProviderReadinessReadPort;
  readonly clock: Clock;
  readonly ids: CommunicationProviderReadOperationIds;
  readonly crypto: CommunicationProviderReadOperationCrypto;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function assertPolicy(policy: VersionedAccessPolicyRef): void {
  if (
    policy.key !== COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY.key
    || policy.version !== COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY.version
  ) {
    throw new TypeError('communication_provider_read_policy_catalog_mismatch');
  }
}

function autonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition,
    operation,
    riskFloor: 'normal',
    unattendedRiskCeiling: 'normal',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block',
      unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval',
      known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile',
      stale_plan: 'replan',
      compensation_required: 'compensate',
      terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
}

const nullDetailSchema = z.null();
const sharedRefs = Object.freeze({
  nullDetail: schemaRef('schema.communication.provider-read.null-detail', nullDetailSchema),
  trace: ref('trace.communication.provider-read'),
  audit: ref('audit.communication.provider-read'),
  recordProfile: ref('record-profile.communication.provider-read')
});

const readCatalog = Object.freeze({
  getConnection: Object.freeze({
    operation: COMMUNICATION_PROVIDER_OPERATIONS.getConnection,
    inputSchema: emailProviderConfigurationReadInputSchema,
    inputRef: EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getConnection.inputSchema,
    canonicalSchema: emailProviderConnectionCanonicalResultSchema,
    canonicalRef: schemaRef(
      'schema.communication.provider-connection.read.canonical-result',
      emailProviderConnectionCanonicalResultSchema
    ),
    projectedSchema: emailProviderConfigurationReadOperationResultSchema,
    projectedRef: EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getConnection.resultSchema,
    path: '/api/communications/provider-connection',
    toolName: 'get_email_provider_connection'
  }),
  getReadiness: Object.freeze({
    operation: COMMUNICATION_PROVIDER_OPERATIONS.getReadiness,
    inputSchema: emailProviderReadinessGetInputSchema,
    inputRef: EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getReadiness.inputSchema,
    canonicalSchema: emailProviderReadinessCanonicalResultSchema,
    canonicalRef: schemaRef(
      'schema.communication.email-readiness.read.canonical-result',
      emailProviderReadinessCanonicalResultSchema
    ),
    projectedSchema: emailProviderReadinessReadOperationResultSchema,
    projectedRef: EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getReadiness.resultSchema,
    path: '/api/communications/email-readiness',
    toolName: 'get_email_readiness'
  })
});

type ReadKey = keyof typeof readCatalog;

function workspaceScope(workspaceId: WorkspaceId) {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

/** Registers only the persisted provider-connection and readiness read projections. */
export function createCommunicationProviderReadOperationModule(
  input: CreateCommunicationProviderReadOperationModuleInput
): OperationRegistryModule {
  assertPolicy(input.policy);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const read = createCommunicationProviderReadOperations({
    workspaceId,
    configuration: input.configuration,
    readiness: input.readiness
  });
  const lanes = Object.freeze([
    parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: input.policy
    }),
    parseOperationAccessLane({
      kind: 'external_mcp',
      surface: 'external_mcp',
      policy: input.policy
    })
  ]);
  const scopeResolver = workspaceScope(workspaceId);
  const entries = (Object.keys(readCatalog) as ReadKey[]).map((key) => {
    const catalog = readCatalog[key];
    const base = catalog.operation.name;
    const refs = Object.freeze({
      autonomy: ref(`autonomy.${base}`),
      context: ref(`context.${base}`),
      capability: ref(`capability.${base}`),
      handler: ref(`handler.${base}`),
      projection: ref(`projection.${base}`)
    });
    const operationAutonomy = autonomy(catalog.operation, refs.autonomy);
    const context = createReadInvocationContextBuilder({
      reference: refs.context,
      operation: catalog.operation,
      effect: 'read',
      lanes,
      scopeResolver,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      deniedAuthorityOutcome: authorityOutcome
    });
    return Object.freeze({ key, catalog, refs, operationAutonomy, context });
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: sharedRefs.nullDetail
  }));
  const schemaMap = new Map<string, {
    readonly reference: SafeSchemaManifestRef;
    readonly schema: z.ZodType;
  }>();
  const addSchema = (reference: SafeSchemaManifestRef, schema: z.ZodType): void => {
    schemaMap.set(
      `${reference.key}@${reference.version}:${reference.digestSha256}`,
      Object.freeze({ reference, schema })
    );
  };
  addSchema(sharedRefs.nullDetail, nullDetailSchema);
  for (const entry of entries) {
    addSchema(entry.catalog.inputRef, entry.catalog.inputSchema);
    addSchema(entry.catalog.canonicalRef, entry.catalog.canonicalSchema);
    addSchema(entry.catalog.projectedRef, entry.catalog.projectedSchema);
  }

  return Object.freeze({
    id: 'communication.provider-read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze(entries.map((entry) => entry.operationAutonomy)),
      schemas: Object.freeze([...schemaMap.values()]),
      contextBuilders: Object.freeze(entries.map((entry) => entry.context)),
      readCapabilities: Object.freeze(entries.map<ReadCapabilityRegistration>((entry) => ({
        reference: entry.refs.capability,
        openSnapshot(context: ReadInvocationContext) {
          if (context.scope.workspaceId !== workspaceId || context.scope.eventId !== undefined) {
            throw new TypeError('communication_provider_read_scope_mismatch');
          }
          return Object.freeze({ workspaceId });
        }
      }))),
      handlers: Object.freeze(entries.map((entry) => ({
        reference: entry.refs.handler,
        readCapability: entry.refs.capability,
        canonicalResultSchema: entry.catalog.canonicalRef,
        handle: ({ businessInput }: { readonly businessInput: unknown }) => entry.key === 'getConnection'
          ? read.getConnection(emailProviderConfigurationReadInputSchema.parse(businessInput))
          : read.getReadiness(emailProviderReadinessGetInputSchema.parse(businessInput))
      }))),
      projections: Object.freeze(entries.map((entry) => ({
        reference: entry.refs.projection,
        canonicalResultSchema: entry.catalog.canonicalRef,
        projectedResultSchema: entry.catalog.projectedRef,
        project: (candidate: unknown) => entry.catalog.canonicalSchema.parse(candidate)
      }))),
      readOperationalTraceTargets: Object.freeze([{
        reference: sharedRefs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: sharedRefs.recordProfile
      }]),
      operationAuditTargets: Object.freeze([{
        reference: sharedRefs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: sharedRefs.recordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: sharedRefs.recordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 131_072
      }]),
      operations: Object.freeze(entries.map((entry) => ({
        ...entry.catalog.operation,
        lifecycle: { status: 'active' as const },
        summary: entry.key === 'getConnection'
          ? 'Read one safe email-provider connection projection.'
          : 'Read stored email-provider readiness evidence.',
        effect: 'read' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [],
        inputSchema: entry.catalog.inputRef,
        canonicalResultSchema: entry.catalog.canonicalRef,
        outcomes: [
          ...accessOutcomes,
          ...(entry.key === 'getConnection'
            ? [{
                class: 'conflict' as const,
                kind: 'communication.provider_connection_unavailable',
                retryable: false,
                detailSchema: sharedRefs.nullDetail
              }]
            : [])
        ],
        accessLanes: lanes,
        contextBuilder: entry.refs.context,
        readCapability: entry.refs.capability,
        handler: entry.refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: sharedRefs.trace },
          immutableAudit: {
            mode: 'external_mcp_app_model' as const,
            target: sharedRefs.audit
          }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: entry.catalog.path,
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: entry.refs.projection
        }, {
          surface: 'external_mcp' as const,
          toolName: entry.catalog.toolName,
          projection: entry.refs.projection
        }]
      })))
    })
  });
}
