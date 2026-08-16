import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type ReturnTypeOrPromise
} from '@jooevents/application';
import {
  WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  workspaceShellSummaryCanonicalResultSchema,
  workspaceShellSummaryProjectionSchema,
  workspaceShellSummaryReadInputSchema,
  workspaceShellSummaryReadResultSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef,
  type WorkspaceShellSummaryProjection
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

export const WORKSPACE_SHELL_SUMMARY_READ_OPERATION = Object.freeze({
  name: 'workspace.shell.summary.read',
  version: 1
});

export const WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY: VersionedAccessPolicyRef =
  Object.freeze({
    key: 'authority.workspace.shell.summary.read',
    version: parseContractVersion(1)
  });

export interface WorkspaceShellSummaryReadPort {
  readSummary(workspaceId: WorkspaceId): ReturnTypeOrPromise<WorkspaceShellSummaryProjection>;
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

function workspaceScopeResolver(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

const nullDetailSchema = z.null();
const schemas = Object.freeze({
  input: WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.inputSchema,
  canonical: schemaRef(
    'schema.workspace.shell.summary.read.canonical-result',
    workspaceShellSummaryCanonicalResultSchema
  ),
  projected: WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.resultSchema,
  nullDetail: schemaRef('schema.workspace.shell.summary.read.null-detail', nullDetailSchema)
});
const refs = Object.freeze({
  autonomy: ref('autonomy.workspace.shell.summary.read'),
  context: ref('context.workspace.shell.summary.read'),
  capability: ref('capability.workspace.shell.summary.read'),
  handler: ref('handler.workspace.shell.summary.read'),
  projection: ref('projection.workspace.shell.summary.read.operator'),
  trace: ref('trace.workspace.shell.summary.read'),
  auditRecord: ref('record-profile.workspace.shell.summary.read')
});

export function createWorkspaceShellSummaryOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly read: WorkspaceShellSummaryReadPort;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly crypto: {
    readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
    readonly scopePartitionProfile: VersionedKeyProfileRef;
    readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  };
}): OperationRegistryModule {
  if (
    input.policy.key !== WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY.key
    || input.policy.version !== WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY.version
  ) {
    throw new TypeError('workspace_shell_summary_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: WORKSPACE_SHELL_SUMMARY_READ_OPERATION,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
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
  const context = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: WORKSPACE_SHELL_SUMMARY_READ_OPERATION,
    effect: 'read',
    lanes: [lane],
    scopeResolver: workspaceScopeResolver(workspaceId),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.capability,
    openSnapshot: async (invocation: ReadInvocationContext) => Object.freeze({
      summary: await input.read.readSummary(parseWorkspaceId(invocation.scope.workspaceId))
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));

  return Object.freeze({
    id: 'workspace.shell.summary.operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: workspaceShellSummaryReadInputSchema },
        { reference: schemas.canonical, schema: workspaceShellSummaryCanonicalResultSchema },
        { reference: schemas.projected, schema: workspaceShellSummaryReadResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([capability]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => ({
          kind: 'success' as const,
          data: workspaceShellSummaryProjectionSchema.parse(snapshot.summary)
        })
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => workspaceShellSummaryCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecord
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecord,
        kind: 'canonical_json' as const,
        maximumBytes: 16_384
      }]),
      operations: Object.freeze([{
        ...WORKSPACE_SHELL_SUMMARY_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the active workspace and current Event identity for workspace chrome.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: schemas.input,
        canonicalResultSchema: schemas.canonical,
        outcomes: accessOutcomes,
        accessLanes: [lane],
        contextBuilder: refs.context,
        readCapability: refs.capability,
        handler: refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: '/api/workspace/shell-summary',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
