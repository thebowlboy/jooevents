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
  organizerCommunicationAudienceOptionListInputSchema,
  organizerCommunicationAudienceOptionPageCanonicalResultSchema,
  organizerCommunicationAudienceOptionPageOperationResultSchema,
  organizerCommunicationAudienceOptionPageSchema,
  organizerMessageBatchPreviewDetailCanonicalResultSchema,
  organizerMessageBatchPreviewDetailOperationResultSchema,
  organizerMessageBatchPreviewDetailSchema,
  organizerMessageBatchPreviewGetInputSchema,
  organizerMessagePreviewRecipientListInputSchema,
  organizerMessagePreviewRecipientPageCanonicalResultSchema,
  organizerMessagePreviewRecipientPageOperationResultSchema,
  organizerMessagePreviewRecipientPageSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type PermissionId,
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
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationCurrentEventSource,
  type OrganizerCommunicationScope
} from './organizer-authoring-module';

export const ORGANIZER_COMMUNICATION_AUDIENCE_PREVIEW_READ_OPERATIONS = Object.freeze({
  listAudienceOptions: Object.freeze({ name: 'list_audience_options', version: 1 }),
  getPreview: Object.freeze({ name: 'get_message_batch_preview', version: 1 }),
  listPreviewRecipients: Object.freeze({ name: 'list_message_preview_recipients', version: 1 })
});

/** Exact address disclosure is independent from ordinary communication drafting. */
export const ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION =
  'speaker.contact.read' as const satisfies PermissionId;

export type OrganizerPreviewContactDisclosure = 'masked' | 'exact_authorized';

export interface OrganizerAudiencePreviewReadPort {
  listAudienceOptions(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    input: unknown
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  getMessageBatchPreview(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    input: unknown
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  listMessagePreviewRecipients(
    scope: OrganizerCommunicationScope,
    authorityPrincipalKey: string,
    input: unknown,
    disclosure: OrganizerPreviewContactDisclosure
  ): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

export interface OrganizerAudiencePreviewOperationIds {
  newInvocationId(): InvocationId;
}

export interface OrganizerAudiencePreviewOperationCrypto {
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
    throw new TypeError('organizer_audience_preview_policy_catalog_mismatch');
  }
}

function scopeResolver(
  workspaceId: WorkspaceId,
  currentEvent: OrganizerCommunicationCurrentEventSource
) {
  return Object.freeze({
    async resolve() {
      const selected = await currentEvent.resolveCurrentEvent(workspaceId);
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
}

function eventScope(context: ReadInvocationContext): OrganizerCommunicationScope | undefined {
  return context.scope.eventId === undefined
    ? undefined
    : Object.freeze({
        workspaceId: parseWorkspaceId(context.scope.workspaceId),
        eventId: parseEventId(context.scope.eventId)
      });
}

function eventRequiredOutcome(): OrganizerCommunicationCanonicalResult {
  return Object.freeze({
    kind: 'outcome',
    outcome: Object.freeze({
      class: 'conflict',
      kind: 'communication.event_required',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
}

function autonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef,
  risk: 'low' | 'normal'
) {
  return createOperationAutonomyPolicy({
    definition,
    operation,
    riskFloor: risk,
    unattendedRiskCeiling: risk,
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
  nullDetail: schemaRef('schema.communication.organizer.audience-preview.null-detail', nullDetailSchema),
  trace: ref('trace.communication.organizer.audience-preview-read'),
  audit: ref('audit.communication.organizer.audience-preview-read'),
  auditRecord: ref('record-profile.communication.organizer.audience-preview-read')
});

type ReadKey = keyof typeof ORGANIZER_COMMUNICATION_AUDIENCE_PREVIEW_READ_OPERATIONS;

const readCatalog: Readonly<Record<ReadKey, {
  readonly refs: { readonly inputSchema: SafeSchemaManifestRef; readonly resultSchema: SafeSchemaManifestRef };
  readonly inputSchema: z.ZodType;
  readonly canonicalSchema: z.ZodType;
  readonly projectedSchema: z.ZodType;
  readonly path: string;
  readonly risk: 'low' | 'normal';
}>> = Object.freeze({
  listAudienceOptions: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listAudienceOptions,
    inputSchema: organizerCommunicationAudienceOptionListInputSchema,
    canonicalSchema: organizerCommunicationAudienceOptionPageCanonicalResultSchema,
    projectedSchema: organizerCommunicationAudienceOptionPageOperationResultSchema,
    path: '/api/events/current/communications/audiences/options',
    risk: 'low'
  }),
  getPreview: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getPreview,
    inputSchema: organizerMessageBatchPreviewGetInputSchema,
    canonicalSchema: organizerMessageBatchPreviewDetailCanonicalResultSchema,
    projectedSchema: organizerMessageBatchPreviewDetailOperationResultSchema,
    path: '/api/events/current/communications/previews/detail',
    risk: 'normal'
  }),
  listPreviewRecipients: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listPreviewRecipients,
    inputSchema: organizerMessagePreviewRecipientListInputSchema,
    canonicalSchema: organizerMessagePreviewRecipientPageCanonicalResultSchema,
    projectedSchema: organizerMessagePreviewRecipientPageOperationResultSchema,
    path: '/api/events/current/communications/previews/recipients',
    risk: 'normal'
  })
});

function exactDisclosure(context: ReadInvocationContext): OrganizerPreviewContactDisclosure {
  return context.authority.grants.some((grant) =>
    grant.kind === 'permission' && grant.key === ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION
  ) ? 'exact_authorized' : 'masked';
}

async function canonicalRead(input: {
  readonly key: ReadKey;
  readonly port: OrganizerAudiencePreviewReadPort;
  readonly scope: OrganizerCommunicationScope;
  readonly context: ReadInvocationContext;
  readonly businessInput: unknown;
}): Promise<OrganizerCommunicationCanonicalResult> {
  switch (input.key) {
    case 'listAudienceOptions':
      return await input.port.listAudienceOptions(
        input.scope,
        input.context.authorityPrincipalKey,
        input.businessInput
      );
    case 'getPreview':
      return await input.port.getMessageBatchPreview(
        input.scope,
        input.context.authorityPrincipalKey,
        input.businessInput
      );
    case 'listPreviewRecipients':
      return await input.port.listMessagePreviewRecipients(
        input.scope,
        input.context.authorityPrincipalKey,
        input.businessInput,
        exactDisclosure(input.context)
      );
  }
}

export function createOrganizerAudiencePreviewReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OrganizerCommunicationCurrentEventSource;
  readonly read: OrganizerAudiencePreviewReadPort;
  readonly clock: Clock;
  readonly ids: OrganizerAudiencePreviewOperationIds;
  readonly crypto: OrganizerAudiencePreviewOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy: input.policy }),
    parseOperationAccessLane({ kind: 'app_model', surface: 'app_model', policy: input.policy })
  ]);
  const resolvedScope = scopeResolver(workspaceId, input.currentEvent);
  const entries = (Object.keys(
    ORGANIZER_COMMUNICATION_AUDIENCE_PREVIEW_READ_OPERATIONS
  ) as ReadKey[]).map((key) => {
    const operation = ORGANIZER_COMMUNICATION_AUDIENCE_PREVIEW_READ_OPERATIONS[key];
    const catalog = readCatalog[key];
    const base = `communication.organizer.${operation.name}`;
    const refs = Object.freeze({
      autonomy: ref(`autonomy.${base}`),
      context: ref(`context.${base}`),
      capability: ref(`capability.${base}`),
      handler: ref(`handler.${base}`),
      projection: ref(`projection.${base}`),
      canonical: schemaRef(`schema.${base}.canonical-result`, catalog.canonicalSchema)
    });
    const operationAutonomy = autonomy(operation, refs.autonomy, catalog.risk);
    const context = createReadInvocationContextBuilder({
      reference: refs.context,
      operation,
      effect: 'read',
      lanes,
      scopeResolver: resolvedScope,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      deniedAuthorityOutcome: authorityOutcome
    });
    return Object.freeze({ key, operation, catalog, refs, operationAutonomy, context });
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
  const addSchema = (reference: SafeSchemaManifestRef, schema: z.ZodType) => {
    schemaMap.set(`${reference.key}@${reference.version}:${reference.digestSha256}`, { reference, schema });
  };
  addSchema(sharedRefs.nullDetail, nullDetailSchema);
  for (const entry of entries) {
    addSchema(entry.catalog.refs.inputSchema, entry.catalog.inputSchema);
    addSchema(entry.refs.canonical, entry.catalog.canonicalSchema);
    addSchema(entry.catalog.refs.resultSchema, entry.catalog.projectedSchema);
  }

  return Object.freeze({
    id: 'communication.organizer.audience-preview-read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze(entries.map((entry) => entry.operationAutonomy)),
      schemas: Object.freeze([...schemaMap.values()]),
      contextBuilders: Object.freeze(entries.map((entry) => entry.context)),
      readCapabilities: Object.freeze(entries.map<ReadCapabilityRegistration>((entry) => ({
        reference: entry.refs.capability,
        openSnapshot: (context: ReadInvocationContext) => Object.freeze({ context })
      }))),
      handlers: Object.freeze(entries.map((entry) => ({
        reference: entry.refs.handler,
        readCapability: entry.refs.capability,
        canonicalResultSchema: entry.refs.canonical,
        handle: async ({ businessInput, context }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) => {
          const selected = eventScope(context);
          if (selected === undefined) return eventRequiredOutcome();
          return await canonicalRead({
            key: entry.key,
            port: input.read,
            scope: selected,
            context,
            businessInput
          });
        }
      }))),
      projections: Object.freeze(entries.map((entry) => ({
        reference: entry.refs.projection,
        canonicalResultSchema: entry.refs.canonical,
        projectedResultSchema: entry.catalog.refs.resultSchema,
        project: (candidate: unknown) => entry.catalog.canonicalSchema.parse(candidate)
      }))),
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
      operations: Object.freeze(entries.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Read ${entry.operation.name}.`,
        effect: 'read' as const,
        maxRisk: entry.catalog.risk,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [],
        inputSchema: entry.catalog.refs.inputSchema,
        canonicalResultSchema: entry.refs.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'communication.event_required',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'communication.not_found',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'communication.revision_changed',
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
        contextBuilder: entry.refs.context,
        readCapability: entry.refs.capability,
        handler: entry.refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: sharedRefs.trace },
          immutableAudit: entry.key === 'listAudienceOptions'
            ? { mode: 'external_mcp_app_model' as const, target: sharedRefs.audit }
            : {
                mode: 'required' as const,
                reason: 'classified' as const,
                target: sharedRefs.audit
              }
        },
        bindings: [
          {
            surface: 'operator_http' as const,
            method: 'GET' as const,
            path: entry.catalog.path,
            input: 'query' as const,
            browserResumption: { kind: 'none' as const },
            projection: entry.refs.projection
          },
          {
            surface: 'external_mcp' as const,
            toolName: entry.operation.name,
            projection: entry.refs.projection
          },
          {
            surface: 'app_model' as const,
            toolName: entry.operation.name,
            projection: entry.refs.projection
          }
        ]
      })))
    })
  });
}

export type OrganizerAudiencePreviewScope = Readonly<{
  workspaceId: WorkspaceId;
  eventId: EventId;
}>;
