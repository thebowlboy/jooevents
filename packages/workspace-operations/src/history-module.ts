import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  type InvocationEvidence,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type ReturnTypeOrPromise
} from '@jooevents/application';
import {
  OPERATION_HISTORY_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  operationHistoryCanonicalResultSchema,
  operationHistoryListInputSchema,
  operationHistoryListResultSchema,
  operationHistoryPageSchema,
  type OperationHistoryPage,
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
  parseEventId,
  parseWorkspaceId,
  type Clock,
  type EventId,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { WORKSPACE_OVERVIEW_READ_ACCESS_POLICY } from './module';

export const OPERATION_HISTORY_LIST_OPERATION = Object.freeze({
  name: 'operation.history.list',
  version: 1
});

export interface OperationHistoryCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): ReturnTypeOrPromise<{
    readonly eventId?: EventId;
    readonly evidenceIds: readonly string[];
  }>;
}

export interface OperationHistoryReadPort {
  list(
    scope: { readonly workspaceId: WorkspaceId; readonly eventId?: EventId },
    input: unknown
  ): ReturnTypeOrPromise<OperationHistoryPage>;
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

const nullDetailSchema = z.null();
const refs = Object.freeze({
  autonomy: ref('autonomy.operation.history.list'),
  context: ref('context.operation.history.list'),
  capability: ref('capability.operation.history.list'),
  handler: ref('handler.operation.history.list'),
  canonical: schemaRef(
    'schema.operation.history.list.canonical-result',
    operationHistoryCanonicalResultSchema
  ),
  projection: ref('projection.operation.history.list'),
  trace: ref('trace.operation.history.list'),
  audit: ref('audit.operation.history.list'),
  auditRecord: ref('record-profile.operation.history.list'),
  nullDetail: schemaRef('schema.operation.history.list.null-detail', nullDetailSchema)
});

export function createOperationHistoryReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OperationHistoryCurrentEventSource;
  readonly read: OperationHistoryReadPort;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly crypto: {
    readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
    readonly scopePartitionProfile: VersionedKeyProfileRef;
    readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  };
}): OperationRegistryModule {
  if (input.policy.key !== WORKSPACE_OVERVIEW_READ_ACCESS_POLICY.key
      || input.policy.version !== WORKSPACE_OVERVIEW_READ_ACCESS_POLICY.version) {
    throw new TypeError('operation_history_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy: input.policy }),
    parseOperationAccessLane({ kind: 'app_model', surface: 'app_model', policy: input.policy })
  ]);
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: OPERATION_HISTORY_LIST_OPERATION,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
  const context = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: OPERATION_HISTORY_LIST_OPERATION,
    effect: 'read',
    lanes,
    scopeResolver: Object.freeze({
      async resolve({ businessInput }: { readonly businessInput: unknown }) {
        const request = operationHistoryListInputSchema.parse(businessInput);
        if (request.view === 'workspace') {
          return Object.freeze({
            workspaceId,
            subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
            resolutionEvidenceIds: Object.freeze(['workspace.current'])
          });
        }
        const selected = await input.currentEvent.resolveCurrentEvent(workspaceId);
        if (selected.eventId === undefined) {
          return Object.freeze({
            workspaceId,
            subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
            resolutionEvidenceIds: Object.freeze([
              'workspace.current', ...selected.evidenceIds, 'event.selection.absent'
            ])
          });
        }
        const eventId = parseEventId(selected.eventId);
        return Object.freeze({
          workspaceId,
          eventId,
          subjects: Object.freeze([
            { kind: 'workspace' as const, id: workspaceId },
            { kind: 'event' as const, id: eventId }
          ]),
          resolutionEvidenceIds: Object.freeze([
            ...new Set(['workspace.current', ...selected.evidenceIds])
          ].sort())
        });
      }
    }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.nullDetail
  }));
  return Object.freeze({
    id: 'operation.history.read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: OPERATION_HISTORY_SCHEMA_REFS.list.inputSchema, schema: operationHistoryListInputSchema },
        { reference: refs.canonical, schema: operationHistoryCanonicalResultSchema },
        { reference: OPERATION_HISTORY_SCHEMA_REFS.list.resultSchema, schema: operationHistoryListResultSchema },
        { reference: refs.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([{
        reference: refs.capability,
        openSnapshot: (invocation: ReadInvocationContext) => Object.freeze({ invocation })
      } satisfies ReadCapabilityRegistration]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: refs.canonical,
        handle: async ({ businessInput, context: invocation }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) => {
          const request = operationHistoryListInputSchema.parse(businessInput);
          if (request.view === 'event' && invocation.scope.eventId === undefined) {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'operation_history.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          return Object.freeze({
            kind: 'success' as const,
            data: await input.read.list({
              workspaceId: parseWorkspaceId(invocation.scope.workspaceId),
              ...(invocation.scope.eventId === undefined
                ? {}
                : { eventId: parseEventId(invocation.scope.eventId) })
            }, businessInput)
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: OPERATION_HISTORY_SCHEMA_REFS.list.resultSchema,
        project: (candidate: unknown) => operationHistoryCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecord
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecord
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecord,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      operations: Object.freeze([{
        ...OPERATION_HISTORY_LIST_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'List safe operation history in workspace or current-event scope.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: OPERATION_HISTORY_SCHEMA_REFS.list.inputSchema,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'operation_history.event_required',
            retryable: false,
            detailSchema: refs.nullDetail
          }
        ],
        accessLanes: lanes,
        contextBuilder: refs.context,
        readCapability: refs.capability,
        handler: refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: {
            mode: 'external_mcp_app_model' as const,
            target: refs.audit
          }
        },
        bindings: [
          {
            surface: 'operator_http' as const,
            method: 'GET' as const,
            path: '/api/workspace/history',
            input: 'query' as const,
            browserResumption: { kind: 'none' as const },
            projection: refs.projection
          },
          { surface: 'external_mcp' as const, toolName: OPERATION_HISTORY_LIST_OPERATION.name,
            projection: refs.projection },
          { surface: 'app_model' as const, toolName: OPERATION_HISTORY_LIST_OPERATION.name,
            projection: refs.projection }
        ]
      }])
    })
  });
}
