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
  EVENT_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  eventListProjectionSchema,
  eventListReadInputSchema,
  eventListReadResultSchema,
  structuredOutcomeSchema,
  type EventListProjection,
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
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { EVENT_READ_ACCESS_POLICY } from './module';

export const EVENT_LIST_READ_OPERATION = Object.freeze({ name: 'event.list.read', version: 1 });
export const EVENT_LIST_READ_PATH = '/api/events';

export interface EventListReadPort {
  readList(workspaceId: WorkspaceId): ReturnTypeOrPromise<EventListProjection>;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function workspaceScope(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

const nullDetailSchema = z.null();
const canonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: eventListProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const schemas = Object.freeze({
  input: EVENT_OPERATION_SCHEMA_REFS.listRead.inputSchema,
  canonical: schemaRef('schema.event.list-read.canonical-result', canonicalResultSchema),
  projected: EVENT_OPERATION_SCHEMA_REFS.listRead.resultSchema,
  nullDetail: schemaRef('schema.event.list-read.null-detail', nullDetailSchema)
});
const refs = Object.freeze({
  autonomy: ref('autonomy.event.list-read'),
  context: ref('context.event.list-read'),
  capability: ref('capability.event.list-read'),
  handler: ref('handler.event.list-read'),
  projection: ref('projection.event.list-read.operator'),
  trace: ref('trace.event.list-read'),
  auditRecord: ref('record-profile.event.list-read')
});

export function createEventListReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly list: EventListReadPort;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}): OperationRegistryModule {
  if (input.readPolicy.key !== EVENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== EVENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('event_list_read_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: EVENT_LIST_READ_OPERATION,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
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
    operation: EVENT_LIST_READ_OPERATION,
    effect: 'read',
    lanes: [lane],
    scopeResolver: workspaceScope(workspaceId),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.capability,
    openSnapshot: async (invocation: ReadInvocationContext) => Object.freeze({
      list: await input.list.readList(parseWorkspaceId(invocation.scope.workspaceId))
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: schemas.nullDetail
  }));
  return Object.freeze({
    id: 'event.list-read.operations',
    source: Object.freeze({
      autonomyPolicies: [autonomy],
      schemas: [
        { reference: schemas.input, schema: eventListReadInputSchema },
        { reference: schemas.canonical, schema: canonicalResultSchema },
        { reference: schemas.projected, schema: eventListReadResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ],
      contextBuilders: [context],
      readCapabilities: [capability],
      handlers: [{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => ({
          kind: 'success' as const,
          data: eventListProjectionSchema.parse(snapshot.list)
        })
      }],
      projections: [{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => canonicalResultSchema.parse(candidate)
      }],
      readOperationalTraceTargets: [{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecord
      }],
      operationAuditRecordProfiles: [{
        reference: refs.auditRecord, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      operations: [{
        ...EVENT_LIST_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'List Events in the active workspace and identify the current Event.',
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
          path: EVENT_LIST_READ_PATH,
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }]
    })
  });
}
