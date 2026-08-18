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
  ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  organizerCommunicationAttentionListInputSchema,
  organizerCommunicationAttentionPageCanonicalResultSchema,
  organizerCommunicationAttentionPageOperationResultSchema,
  organizerCommunicationThreadGetInputSchema,
  organizerCommunicationThreadPageCanonicalResultSchema,
  organizerCommunicationThreadPageOperationResultSchema,
  organizerCommunicationTimelineGetInputSchema,
  organizerCommunicationTimelinePageCanonicalResultSchema,
  organizerCommunicationTimelinePageOperationResultSchema,
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
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION,
  type OrganizerPreviewContactDisclosure
} from './organizer-audience-preview-module';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationCurrentEventSource,
  type OrganizerCommunicationScope
} from './organizer-authoring-module';

export const LIST_MESSAGE_ATTENTION_ITEMS_OPERATION = Object.freeze({
  name: 'list_message_attention_items', version: 1
});
export const GET_PERSON_THREAD_OPERATION = Object.freeze({
  name: 'get_person_thread', version: 1
});
export const GET_DELIVERY_TIMELINE_OPERATION = Object.freeze({
  name: 'get_delivery_timeline', version: 1
});

export interface CommunicationAttentionReadPort {
  listAttentionItems(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    input: unknown
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

export interface CommunicationThreadReadPort {
  getPersonThread(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    input: unknown
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

export interface CommunicationTimelineReadPort {
  getDeliveryTimeline(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    input: unknown,
    disclosure: OrganizerPreviewContactDisclosure
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

interface ProjectionOperationIds { newInvocationId(): InvocationId }
interface ProjectionOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
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

function assertPolicy(policy: VersionedAccessPolicyRef): void {
  if (policy.key !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.key
      || policy.version !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('communication_projection_policy_catalog_mismatch');
  }
}

const nullDetailSchema = z.null();

type ProjectionDefinition = Readonly<{
  operation: { readonly name: string; readonly version: number };
  moduleId: string;
  summary: string;
  path: string;
  refs: (typeof ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS)[
    'listAttention' | 'getThread' | 'getTimeline'
  ];
  inputSchema: z.ZodType;
  canonicalSchema: z.ZodType;
  projectedSchema: z.ZodType;
  handle(scope: OrganizerCommunicationScope, context: ReadInvocationContext, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}>;

function createProjectionModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OrganizerCommunicationCurrentEventSource;
  readonly clock: Clock;
  readonly ids: ProjectionOperationIds;
  readonly crypto: ProjectionOperationCrypto;
  readonly definition: ProjectionDefinition;
}): OperationRegistryModule {
  assertPolicy(input.policy);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const { definition } = input;
  const lanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy: input.policy }),
    parseOperationAccessLane({ kind: 'app_model', surface: 'app_model', policy: input.policy })
  ]);
  const base = `communication.organizer.${definition.operation.name}`;
  const refs = Object.freeze({
    autonomy: ref(`autonomy.${base}`),
    context: ref(`context.${base}`),
    capability: ref(`capability.${base}`),
    handler: ref(`handler.${base}`),
    projection: ref(`projection.${base}`),
    canonical: schemaRef(`schema.${base}.canonical-result`, definition.canonicalSchema),
    nullDetail: schemaRef(`schema.${base}.null-detail`, nullDetailSchema),
    trace: ref(`trace.${base}`),
    audit: ref(`audit.${base}`),
    auditRecord: ref(`record-profile.${base}`)
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: definition.operation,
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
  const scopeResolver = Object.freeze({
    async resolve() {
      const selected = await input.currentEvent.resolveCurrentEvent(workspaceId);
      if (selected === undefined) {
        return Object.freeze({
          workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
          resolutionEvidenceIds: Object.freeze(['workspace.current', 'event.selection.absent'])
        });
      }
      const eventId = parseEventId(selected.eventId);
      return Object.freeze({
        workspaceId, eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: Object.freeze(
          [...new Set(['workspace.current', ...selected.evidenceIds])].sort()
        )
      });
    }
  });
  const context = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: definition.operation,
    effect: 'read', lanes, scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: refs.nullDetail
  }));
  return Object.freeze({
    id: definition.moduleId,
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: refs.nullDetail, schema: nullDetailSchema },
        { reference: definition.refs.inputSchema, schema: definition.inputSchema },
        { reference: refs.canonical, schema: definition.canonicalSchema },
        { reference: definition.refs.resultSchema, schema: definition.projectedSchema }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([{
        reference: refs.capability,
        openSnapshot: (invocation: ReadInvocationContext) => Object.freeze({ context: invocation })
      } satisfies ReadCapabilityRegistration]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: refs.canonical,
        handle: async ({ businessInput, context: invocation }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) => {
          if (invocation.scope.eventId === undefined) {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const, kind: 'communication.event_required',
                retryable: false, subjects: [], detail: null, detailSchemaVersion: 1
              })
            });
          }
          return await definition.handle(Object.freeze({
            workspaceId: parseWorkspaceId(invocation.scope.workspaceId),
            eventId: parseEventId(invocation.scope.eventId)
          }), invocation, businessInput);
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: definition.refs.resultSchema,
        project: (candidate: unknown) => definition.canonicalSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace, kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecord
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit, kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecord
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecord, kind: 'canonical_json' as const, maximumBytes: 262_144
      }]),
      operations: Object.freeze([{
        ...definition.operation,
        lifecycle: { status: 'active' as const },
        summary: definition.summary,
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: definition.refs.inputSchema,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'communication.event_required', retryable: false,
            detailSchema: refs.nullDetail },
          { class: 'conflict' as const, kind: 'communication.not_found', retryable: false,
            detailSchema: refs.nullDetail },
          { class: 'policy_violation' as const, kind: 'communication.preview_invalid', retryable: false,
            detailSchema: refs.nullDetail }
        ],
        accessLanes: lanes,
        contextBuilder: refs.context,
        readCapability: refs.capability,
        handler: refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'external_mcp_app_model' as const, target: refs.audit }
        },
        bindings: [
          { surface: 'operator_http' as const, method: 'GET' as const, path: definition.path,
            input: 'query' as const, browserResumption: { kind: 'none' as const },
            projection: refs.projection },
          { surface: 'external_mcp' as const, toolName: definition.operation.name,
            projection: refs.projection },
          { surface: 'app_model' as const, toolName: definition.operation.name,
            projection: refs.projection }
        ]
      }])
    })
  });
}

type SharedInput = Readonly<{
  workspaceId: WorkspaceId;
  policy: VersionedAccessPolicyRef;
  currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  currentEvent: OrganizerCommunicationCurrentEventSource;
  clock: Clock;
  ids: ProjectionOperationIds;
  crypto: ProjectionOperationCrypto;
}>;

export function createCommunicationAttentionReadOperationModule(
  input: SharedInput & { readonly read: CommunicationAttentionReadPort }
): OperationRegistryModule {
  return createProjectionModule({
    ...input,
    definition: {
      operation: LIST_MESSAGE_ATTENTION_ITEMS_OPERATION,
      moduleId: 'communication.organizer.attention-read-operations',
      summary: 'List rebuildable organizer communication attention conditions.',
      path: '/api/events/current/communications/attention',
      refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listAttention,
      inputSchema: organizerCommunicationAttentionListInputSchema,
      canonicalSchema: organizerCommunicationAttentionPageCanonicalResultSchema,
      projectedSchema: organizerCommunicationAttentionPageOperationResultSchema,
      handle: (scope, context, businessInput) =>
        input.read.listAttentionItems(scope, context.authorityPrincipalKey, businessInput)
    }
  });
}

export function createCommunicationThreadReadOperationModule(
  input: SharedInput & { readonly read: CommunicationThreadReadPort }
): OperationRegistryModule {
  return createProjectionModule({
    ...input,
    definition: {
      operation: GET_PERSON_THREAD_OPERATION,
      moduleId: 'communication.organizer.person-thread-read-operations',
      summary: 'Read one person\'s organizer-visible communication thread.',
      path: '/api/events/current/communications/thread',
      refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getThread,
      inputSchema: organizerCommunicationThreadGetInputSchema,
      canonicalSchema: organizerCommunicationThreadPageCanonicalResultSchema,
      projectedSchema: organizerCommunicationThreadPageOperationResultSchema,
      handle: (scope, context, businessInput) => input.read.getPersonThread(
        scope, context.authorityPrincipalKey, businessInput
      )
    }
  });
}

export function createCommunicationTimelineReadOperationModule(
  input: SharedInput & { readonly read: CommunicationTimelineReadPort }
): OperationRegistryModule {
  return createProjectionModule({
    ...input,
    definition: {
      operation: GET_DELIVERY_TIMELINE_OPERATION,
      moduleId: 'communication.organizer.delivery-timeline-read-operations',
      summary: 'Read safe per-recipient delivery and attempt evidence for one message batch.',
      path: '/api/events/current/communications/timeline',
      refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getTimeline,
      inputSchema: organizerCommunicationTimelineGetInputSchema,
      canonicalSchema: organizerCommunicationTimelinePageCanonicalResultSchema,
      projectedSchema: organizerCommunicationTimelinePageOperationResultSchema,
      handle: (scope, context, businessInput) => input.read.getDeliveryTimeline(
        scope,
        context.authorityPrincipalKey,
        businessInput,
        context.authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION
        ) ? 'exact_authorized' : 'masked'
      )
    }
  });
}
