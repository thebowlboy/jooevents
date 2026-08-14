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
  organizerCommunicationHistoryListInputSchema,
  organizerCommunicationHistoryPageCanonicalResultSchema,
  organizerCommunicationHistoryPageOperationResultSchema,
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
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationCurrentEventSource,
  type OrganizerCommunicationScope
} from './organizer-authoring-module';

/**
 * The mounted delivery-history read: per-batch send evidence with live
 * per-recipient delivery-state counts recomputed from the outbound ledger on
 * every read. It shares the ordinary communication-draft policy — history
 * rows carry labels, counts, and opaque references, never an address.
 */
export const GET_DELIVERY_HISTORY_OPERATION = Object.freeze({
  name: 'get_delivery_history',
  version: 1
});

export interface CommunicationDeliveryHistoryReadPort {
  listDeliveryHistory(
    scope: OrganizerCommunicationScope,
    input: unknown
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

export interface CommunicationDeliveryHistoryOperationIds {
  newInvocationId(): InvocationId;
}

export interface CommunicationDeliveryHistoryOperationCrypto {
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
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function assertPolicy(policy: VersionedAccessPolicyRef): void {
  if (policy.key !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.key
      || policy.version !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('communication_delivery_history_policy_catalog_mismatch');
  }
}

const nullDetailSchema = z.null();
const sharedRefs = Object.freeze({
  nullDetail: schemaRef('schema.communication.organizer.delivery-history.null-detail', nullDetailSchema),
  trace: ref('trace.communication.organizer.delivery-history-read'),
  audit: ref('audit.communication.organizer.delivery-history-read'),
  auditRecord: ref('record-profile.communication.organizer.delivery-history-read')
});

export function createCommunicationDeliveryHistoryReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OrganizerCommunicationCurrentEventSource;
  readonly read: CommunicationDeliveryHistoryReadPort;
  readonly clock: Clock;
  readonly ids: CommunicationDeliveryHistoryOperationIds;
  readonly crypto: CommunicationDeliveryHistoryOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy: input.policy }),
    parseOperationAccessLane({ kind: 'app_model', surface: 'app_model', policy: input.policy })
  ]);
  const operation = GET_DELIVERY_HISTORY_OPERATION;
  const base = `communication.organizer.${operation.name}`;
  const refs = Object.freeze({
    autonomy: ref(`autonomy.${base}`),
    context: ref(`context.${base}`),
    capability: ref(`capability.${base}`),
    handler: ref(`handler.${base}`),
    projection: ref(`projection.${base}`),
    canonical: schemaRef(
      `schema.${base}.canonical-result`,
      organizerCommunicationHistoryPageCanonicalResultSchema
    )
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation,
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
      const evidenceIds = [...new Set(['workspace.current', ...selected.evidenceIds])].sort();
      return Object.freeze({
        workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: Object.freeze(evidenceIds)
      });
    }
  });
  const context = createReadInvocationContextBuilder({
    reference: refs.context,
    operation,
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
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: sharedRefs.nullDetail
  }));

  return Object.freeze({
    id: 'communication.organizer.delivery-history-read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: sharedRefs.nullDetail, schema: nullDetailSchema },
        {
          reference: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getHistory.inputSchema,
          schema: organizerCommunicationHistoryListInputSchema
        },
        {
          reference: refs.canonical,
          schema: organizerCommunicationHistoryPageCanonicalResultSchema
        },
        {
          reference: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getHistory.resultSchema,
          schema: organizerCommunicationHistoryPageOperationResultSchema
        }
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
                class: 'conflict' as const,
                kind: 'communication.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          return await input.read.listDeliveryHistory(
            Object.freeze({
              workspaceId: parseWorkspaceId(invocation.scope.workspaceId),
              eventId: parseEventId(invocation.scope.eventId)
            }),
            businessInput
          );
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getHistory.resultSchema,
        project: (candidate: unknown) =>
          organizerCommunicationHistoryPageCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: sharedRefs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: sharedRefs.auditRecord
      }]),
      operationAuditTargets: Object.freeze([{
        reference: sharedRefs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: sharedRefs.auditRecord
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: sharedRefs.auditRecord,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      operations: Object.freeze([{
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: 'Read per-batch delivery history with live per-recipient state counts.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getHistory.inputSchema,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'communication.event_required',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'communication.preview_invalid',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          }
        ],
        accessLanes: lanes,
        contextBuilder: refs.context,
        readCapability: refs.capability,
        handler: refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: sharedRefs.trace },
          immutableAudit: {
            mode: 'external_mcp_app_model' as const,
            target: sharedRefs.audit
          }
        },
        bindings: [
          {
            surface: 'operator_http' as const,
            method: 'GET' as const,
            path: '/api/events/current/communications/deliveries/history',
            input: 'query' as const,
            browserResumption: { kind: 'none' as const },
            projection: refs.projection
          },
          {
            surface: 'external_mcp' as const,
            toolName: operation.name,
            projection: refs.projection
          },
          {
            surface: 'app_model' as const,
            toolName: operation.name,
            projection: refs.projection
          }
        ]
      }])
    })
  });
}
