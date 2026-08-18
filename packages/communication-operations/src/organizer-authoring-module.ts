import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  composeOperationRegistryModules,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer,
  type ReturnTypeOrPromise
} from '@jooevents/application';
import {
  ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  organizerCommunicationAuthoringPayloadCanonicalResultSchema,
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationAuthoringPayloadRefSchema,
  organizerCommunicationDraftCanonicalResultSchema,
  organizerCommunicationDraftGetInputSchema,
  organizerCommunicationDraftListInputSchema,
  organizerCommunicationDraftMutationCanonicalResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema,
  organizerCommunicationDraftMutationResultSchema,
  organizerCommunicationDraftOperationResultSchema,
  organizerCommunicationDraftPageCanonicalResultSchema,
  organizerCommunicationDraftPageOperationResultSchema,
  organizerCommunicationDraftPageSchema,
  organizerCommunicationDraftProjectionSchema,
  organizerCommunicationPurposeDetailOperationResultSchema,
  organizerCommunicationPurposeDetailCanonicalResultSchema,
  organizerCommunicationPurposeDetailSchema,
  organizerCommunicationPurposeGetInputSchema,
  organizerCommunicationPurposeListInputSchema,
  organizerCommunicationPurposePageCanonicalResultSchema,
  organizerCommunicationPurposePageOperationResultSchema,
  organizerCommunicationPurposePageSchema,
	organizerCreateMessageTemplateInputSchema,
  organizerCreateCommunicationDraftInputSchema,
  organizerDiscardCommunicationDraftInputSchema,
  organizerMessageTemplateDetailCanonicalResultSchema,
  organizerMessageTemplateDetailOperationResultSchema,
  organizerMessageTemplateDetailSchema,
  organizerMessageTemplateGetInputSchema,
  organizerMessageTemplateListInputSchema,
  organizerMessageTemplatePageCanonicalResultSchema,
  organizerMessageTemplatePageOperationResultSchema,
  organizerMessageTemplatePageSchema,
	organizerMessageTemplateMutationCanonicalResultSchema,
	organizerMessageTemplateMutationOperationResultSchema,
	organizerMessageTemplateSummarySchema,
  organizerReviseCommunicationDraftInputSchema,
  organizerStoreAuthoringPayloadInputSchema,
  structuredOutcomeSchema,
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
  parseContractVersion,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type EventId,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  createOrganizerCommunicationMutationHandler,
  type OrganizerCommunicationMutationOperationName
} from './organizer-authoring-preparation';

export const ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'policy.communication.draft',
  version: parseContractVersion(1)
});

export const ORGANIZER_COMMUNICATION_READ_OPERATIONS = Object.freeze({
  listPurposes: Object.freeze({ name: 'list_communication_purposes', version: 1 }),
  getPurpose: Object.freeze({ name: 'get_communication_purpose', version: 1 }),
  listTemplates: Object.freeze({ name: 'list_message_templates', version: 1 }),
  getTemplate: Object.freeze({ name: 'get_message_template', version: 1 }),
  listDrafts: Object.freeze({ name: 'list_message_drafts', version: 1 }),
  getDraft: Object.freeze({ name: 'get_message_draft', version: 1 })
});

export const ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS = Object.freeze({
  storeAuthoringPayload: Object.freeze({ name: 'store_communication_authoring_payload', version: 1 }),
  createTemplate: Object.freeze({ name: 'message_template.create', version: 1 }),
  createDraft: Object.freeze({ name: 'create_message_draft', version: 1 }),
  reviseDraft: Object.freeze({ name: 'revise_message_batch', version: 1 }),
  discardDraft: Object.freeze({ name: 'discard_message_draft', version: 1 })
});

const canonicalIdSchema = z.string().min(1).max(256);
const readSummaries: Readonly<Record<keyof typeof ORGANIZER_COMMUNICATION_READ_OPERATIONS, string>> = Object.freeze({
  listPurposes: 'List the communication purposes available when choosing why a message should be sent.',
  getPurpose: 'Get one communication purpose and the constraints that shape its message.',
  listTemplates: 'List message templates available for drafting communication in the selected event.',
  getTemplate: 'Get one message template with its current authored content and metadata.',
  listDrafts: 'List message drafts and their current readiness so pending send decisions are visible.',
  getDraft: 'Get one message draft with the content and audience state needed for review.'
});
export const organizerCommunicationMutationDomainContributionSchema = z.strictObject({
  kind: z.literal('organizer_communication_authoring'),
  operationName: z.enum([
    'store_communication_authoring_payload',
	'message_template.create',
    'create_message_draft',
    'revise_message_batch',
    'discard_message_draft'
  ]),
  workspaceId: z.uuid(),
  eventId: z.uuid(),
  entityId: canonicalIdSchema,
  entityVersion: z.number().int().positive().safe(),
  occurredAt: z.iso.datetime({ offset: true })
});

const mutationSuccessDataSchema = z.union([
  organizerCommunicationAuthoringPayloadRefSchema,
	organizerMessageTemplateSummarySchema,
  organizerCommunicationDraftMutationResultSchema
]);

export const organizerCommunicationMutationContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: mutationSuccessDataSchema }),
    domain: organizerCommunicationMutationDomainContributionSchema,
    effectContributions: z.tuple([])
  }).superRefine((contribution, context) => {
    const data = contribution.result.data;
	const isPayload = 'payloadRefId' in data;
	const isTemplate = 'revision' in data;
	const expectedId = isPayload ? data.payloadRefId : isTemplate ? data.revision.templateId : data.draftId;
	const expectedVersion = isPayload ? data.payloadRefVersion
		: isTemplate ? data.revision.revisionNumber : data.version;
    if ((contribution.domain.operationName === 'store_communication_authoring_payload') !== isPayload
		|| (contribution.domain.operationName === 'message_template.create') !== isTemplate
		|| contribution.domain.entityId !== expectedId
		|| contribution.domain.entityVersion !== expectedVersion) {
      context.addIssue({ code: 'custom', message: 'Organizer communication mutation evidence is incoherent.' });
    }
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);

export type OrganizerCommunicationMutationContribution = z.infer<
  typeof organizerCommunicationMutationContributionSchema
>;

export type OrganizerCommunicationCanonicalResult =
  | { readonly kind: 'success'; readonly data: unknown }
  | { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };

export interface OrganizerCommunicationScope {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

export interface OrganizerCommunicationReadPort {
  listPurposes(scope: OrganizerCommunicationScope, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  getPurpose(scope: OrganizerCommunicationScope, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  listTemplates(scope: OrganizerCommunicationScope, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  getTemplate(scope: OrganizerCommunicationScope, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  listDrafts(scope: OrganizerCommunicationScope, ownerKey: string, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
  getDraft(scope: OrganizerCommunicationScope, ownerKey: string, input: unknown):
    ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

export interface OrganizerCommunicationCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): ReturnTypeOrPromise<
    | { readonly eventId: EventId; readonly evidenceIds: readonly string[] }
    | undefined
  >;
}

export interface OrganizerCommunicationOperationIds {
  newInvocationId(): InvocationId;
}

export interface OrganizerCommunicationOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

/** Exact persistence/runtime seam for the five organizer authoring mutations. */
export const ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION = Object.freeze({
  store_communication_authoring_payload: ref(
    'capability.communication.organizer.store_communication_authoring_payload'
  ),
  'message_template.create': ref('capability.communication.organizer.message_template.create'),
  create_message_draft: ref('capability.communication.organizer.create_message_draft'),
  revise_message_batch: ref('capability.communication.organizer.revise_message_batch'),
  discard_message_draft: ref('capability.communication.organizer.discard_message_draft')
} satisfies Readonly<Record<
  OrganizerCommunicationMutationOperationName,
  VersionedDefinitionRef
>>);

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
    throw new TypeError('organizer_communication_policy_catalog_mismatch');
  }
}

function scopeResolver(
  workspaceId: WorkspaceId,
  currentEvent: OrganizerCommunicationCurrentEventSource
): InvocationScopeResolver {
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

function operationAutonomy(
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
  nullDetail: schemaRef('schema.communication.organizer.authoring.null-detail', nullDetailSchema),
  trace: ref('trace.communication.organizer.authoring-read'),
  readAudit: ref('audit.communication.organizer.authoring-read'),
  effectAudit: ref('audit.communication.organizer.authoring-mutation'),
  auditRecord: ref('record-profile.communication.organizer.operation-audit'),
  contribution: schemaRef(
    'schema.communication.organizer.authoring-mutation.contribution',
    organizerCommunicationMutationContributionSchema
  ),
  keySource: ref('idempotency.operator-or-tool-header')
});

type ReadKey = keyof typeof ORGANIZER_COMMUNICATION_READ_OPERATIONS;

const readCatalog: Readonly<Record<ReadKey, {
  readonly refs: { readonly inputSchema: SafeSchemaManifestRef; readonly resultSchema: SafeSchemaManifestRef };
  readonly inputSchema: z.ZodType;
  readonly dataSchema: z.ZodType;
  readonly canonicalSchema: z.ZodType;
  readonly projectedSchema: z.ZodType;
  readonly path: string;
}>> = Object.freeze({
  listPurposes: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listPurposes,
    inputSchema: organizerCommunicationPurposeListInputSchema,
    dataSchema: organizerCommunicationPurposePageSchema,
    canonicalSchema: organizerCommunicationPurposePageCanonicalResultSchema,
    projectedSchema: organizerCommunicationPurposePageOperationResultSchema,
    path: '/api/events/current/communications/purposes'
  }),
  getPurpose: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getPurpose,
    inputSchema: organizerCommunicationPurposeGetInputSchema,
    dataSchema: organizerCommunicationPurposeDetailSchema,
    canonicalSchema: organizerCommunicationPurposeDetailCanonicalResultSchema,
    projectedSchema: organizerCommunicationPurposeDetailOperationResultSchema,
    path: '/api/events/current/communications/purposes/detail'
  }),
  listTemplates: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listTemplates,
    inputSchema: organizerMessageTemplateListInputSchema,
    dataSchema: organizerMessageTemplatePageSchema,
    canonicalSchema: organizerMessageTemplatePageCanonicalResultSchema,
    projectedSchema: organizerMessageTemplatePageOperationResultSchema,
    path: '/api/events/current/communications/templates'
  }),
  getTemplate: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getTemplate,
    inputSchema: organizerMessageTemplateGetInputSchema,
    dataSchema: organizerMessageTemplateDetailSchema,
    canonicalSchema: organizerMessageTemplateDetailCanonicalResultSchema,
    projectedSchema: organizerMessageTemplateDetailOperationResultSchema,
    path: '/api/events/current/communications/templates/detail'
  }),
  listDrafts: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listDrafts,
    inputSchema: organizerCommunicationDraftListInputSchema,
    dataSchema: organizerCommunicationDraftPageSchema,
    canonicalSchema: organizerCommunicationDraftPageCanonicalResultSchema,
    projectedSchema: organizerCommunicationDraftPageOperationResultSchema,
    path: '/api/events/current/communications/drafts'
  }),
  getDraft: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.getDraft,
    inputSchema: organizerCommunicationDraftGetInputSchema,
    dataSchema: organizerCommunicationDraftProjectionSchema,
    canonicalSchema: organizerCommunicationDraftCanonicalResultSchema,
    projectedSchema: organizerCommunicationDraftOperationResultSchema,
    path: '/api/events/current/communications/drafts/detail'
  })
});

function canonicalRead(input: {
  readonly key: ReadKey;
  readonly port: OrganizerCommunicationReadPort;
  readonly scope: OrganizerCommunicationScope;
  readonly ownerKey: string;
  readonly businessInput: unknown;
}): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult> {
  switch (input.key) {
    case 'listPurposes': return input.port.listPurposes(input.scope, input.businessInput);
    case 'getPurpose': return input.port.getPurpose(input.scope, input.businessInput);
    case 'listTemplates': return input.port.listTemplates(input.scope, input.businessInput);
    case 'getTemplate': return input.port.getTemplate(input.scope, input.businessInput);
    case 'listDrafts': return input.port.listDrafts(input.scope, input.ownerKey, input.businessInput);
    case 'getDraft': return input.port.getDraft(input.scope, input.ownerKey, input.businessInput);
  }
}

export function createOrganizerCommunicationReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OrganizerCommunicationCurrentEventSource;
  readonly read: OrganizerCommunicationReadPort;
  readonly clock: Clock;
  readonly ids: OrganizerCommunicationOperationIds;
  readonly crypto: Pick<
    OrganizerCommunicationOperationCrypto,
    'authorityPrincipalKeyProfile' | 'scopePartitionProfile' | 'requestCanonicalizationProfile'
  >;
}): OperationRegistryModule {
  assertPolicy(input.policy);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy: input.policy }),
    parseOperationAccessLane({ kind: 'app_model', surface: 'app_model', policy: input.policy })
  ]);
  const scope = scopeResolver(workspaceId, input.currentEvent);
  const entries = (Object.keys(ORGANIZER_COMMUNICATION_READ_OPERATIONS) as ReadKey[]).map((key) => {
    const operation = ORGANIZER_COMMUNICATION_READ_OPERATIONS[key];
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
    const autonomy = operationAutonomy(operation, refs.autonomy, 'low');
    const context = createReadInvocationContextBuilder({
      reference: refs.context,
      operation,
      effect: 'read',
      lanes,
      scopeResolver: scope,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      deniedAuthorityOutcome: authorityOutcome
    });
    return Object.freeze({ key, operation, catalog, refs, autonomy, context });
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: sharedRefs.nullDetail
  }));
  const schemaMap = new Map<string, { readonly reference: SafeSchemaManifestRef; readonly schema: z.ZodType }>();
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
    id: 'communication.organizer.authoring-read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze(entries.map((entry) => entry.autonomy)),
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
            ownerKey: context.authorityPrincipalKey,
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
        reference: sharedRefs.readAudit,
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
        summary: readSummaries[entry.key],
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [],
        inputSchema: entry.catalog.refs.inputSchema,
        canonicalResultSchema: entry.refs.canonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'communication.event_required', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'conflict' as const, kind: 'communication.not_found', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'stale_revision' as const, kind: 'communication.revision_changed', retryable: false,
            detailSchema: sharedRefs.nullDetail }
        ],
        accessLanes: lanes,
        contextBuilder: entry.refs.context,
        readCapability: entry.refs.capability,
        handler: entry.refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: sharedRefs.trace },
          immutableAudit: {
            mode: 'external_mcp_app_model' as const,
            target: sharedRefs.readAudit
          }
        },
        bindings: [
          { surface: 'operator_http' as const, method: 'GET' as const, path: entry.catalog.path,
            input: 'query' as const, browserResumption: { kind: 'none' as const },
            projection: entry.refs.projection },
          { surface: 'external_mcp' as const, toolName: entry.operation.name,
            projection: entry.refs.projection },
          { surface: 'app_model' as const, toolName: entry.operation.name,
            projection: entry.refs.projection }
        ]
      })))
    })
  });
}

type MutationKey = keyof typeof ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS;

const mutationCatalog: Readonly<Record<MutationKey, {
  readonly refs: { readonly inputSchema: SafeSchemaManifestRef; readonly resultSchema: SafeSchemaManifestRef };
  readonly inputSchema: z.ZodType;
  readonly canonicalSchema: z.ZodType;
  readonly projectedSchema: z.ZodType;
  readonly path: string;
  readonly consequenceTag: string;
}>> = Object.freeze({
  storeAuthoringPayload: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.storeAuthoringPayload,
    inputSchema: organizerStoreAuthoringPayloadInputSchema,
    canonicalSchema: organizerCommunicationAuthoringPayloadCanonicalResultSchema,
    projectedSchema: organizerCommunicationAuthoringPayloadOperationResultSchema,
    path: '/api/events/current/communications/authoring-payloads',
    consequenceTag: 'communication-authoring-payload-stored'
  }),
	createTemplate: Object.freeze({
		refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.createTemplate,
		inputSchema: organizerCreateMessageTemplateInputSchema,
		canonicalSchema: organizerMessageTemplateMutationCanonicalResultSchema,
		projectedSchema: organizerMessageTemplateMutationOperationResultSchema,
		path: '/api/events/current/communications/templates/create',
		consequenceTag: 'communication-template-created'
	}),
  createDraft: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.createDraft,
    inputSchema: organizerCreateCommunicationDraftInputSchema,
    canonicalSchema: organizerCommunicationDraftMutationCanonicalResultSchema,
    projectedSchema: organizerCommunicationDraftMutationOperationResultSchema,
    path: '/api/events/current/communications/drafts/create',
    consequenceTag: 'communication-draft-created'
  }),
  reviseDraft: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.reviseDraft,
    inputSchema: organizerReviseCommunicationDraftInputSchema,
    canonicalSchema: organizerCommunicationDraftMutationCanonicalResultSchema,
    projectedSchema: organizerCommunicationDraftMutationOperationResultSchema,
    path: '/api/events/current/communications/drafts/revise',
    consequenceTag: 'communication-draft-revised'
  }),
  discardDraft: Object.freeze({
    refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.discardDraft,
    inputSchema: organizerDiscardCommunicationDraftInputSchema,
    canonicalSchema: organizerCommunicationDraftMutationCanonicalResultSchema,
    projectedSchema: organizerCommunicationDraftMutationOperationResultSchema,
    path: '/api/events/current/communications/drafts/discard',
    consequenceTag: 'communication-draft-discarded'
  })
});

export function createOrganizerCommunicationMutationOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OrganizerCommunicationCurrentEventSource;
  readonly clock: Clock;
  readonly ids: OrganizerCommunicationOperationIds;
  readonly crypto: OrganizerCommunicationOperationCrypto;
  readonly enabledOperations?: readonly OrganizerCommunicationMutationOperationName[];
}): OperationRegistryModule {
  assertPolicy(input.policy);
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'app_model', surface: 'app_model', policy: input.policy })
  ]);
  const scope = scopeResolver(workspaceId, input.currentEvent);
  const enabledOperations = input.enabledOperations === undefined
    ? undefined
    : new Set(input.enabledOperations);
  if (enabledOperations !== undefined && (enabledOperations.size !== input.enabledOperations!.length
      || [...enabledOperations].some((name) =>
        !(name in ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION)))) {
    throw new TypeError('organizer_communication_enabled_operations_invalid');
  }
  const entries = (Object.keys(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS) as MutationKey[])
    .filter((key) => enabledOperations === undefined
      || enabledOperations.has(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS[key].name))
    .map((key) => {
    const operation = ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS[key];
    const operationName = operation.name as OrganizerCommunicationMutationOperationName;
    const catalog = mutationCatalog[key];
    const base = `communication.organizer.${operation.name}`;
    const refs = Object.freeze({
      autonomy: ref(`autonomy.${base}`),
      context: ref(`context.${base}`),
      handler: ref(`handler.${base}`),
      capability: ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION[operationName],
      projection: ref(`projection.${base}`),
      canonical: schemaRef(`schema.${base}.canonical-result`, catalog.canonicalSchema),
      requestHash: ref(`request-hash.${base}`),
      concurrency: ref(`concurrency.${base}`),
      family: ref(`${base}.execution-family`),
      phase: ref(`${base}.phase.single-uow`),
      terminalization: ref(`${base}.terminalization`),
      risk: ref(`${base}.risk-resolver`),
      evidence: ref(`${base}.autonomy-evidence`),
      approval: ref(`${base}.approval-resolver`),
      preflight: ref(`${base}.autonomy-preflight`)
    });
    const autonomy = operationAutonomy(operation, refs.autonomy, 'normal');
    const context = createEffectInvocationContextBuilder({
      reference: refs.context,
      operation,
      effect: 'draft',
      lanes,
      scopeResolver: scope,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      requestHashProfile: refs.requestHash,
      requestHashSealer: input.crypto.requestHashSealer,
      idempotencyCredentialProfile: input.crypto.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.crypto.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: refs.family,
      phase: refs.phase
    });
    const terminalization = createTerminalizationResolverRegistration({
      reference: refs.terminalization,
      operation,
      phase: refs.phase,
      resolve: ({ result }) => result.kind === 'success'
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.phase,
      family: refs.family,
      operation,
      effect: 'draft',
      handler: refs.handler,
      handlerCapability: refs.capability,
      contributionSchema: sharedRefs.contribution,
      terminalization: refs.terminalization,
      terminalOutcomeKeys: [],
      contentionOutcome: Object.freeze({
        class: 'conflict' as const,
        kind: 'operation.in_progress',
        retryable: true,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      })
    });
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk,
      operation,
      resolve: () => Object.freeze({
        risk: 'normal' as const,
        consequenceTags: Object.freeze([catalog.consequenceTag]),
        evidenceIds: Object.freeze([`${operation.name}.risk`])
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence,
      operation,
      resolve: ({ subject }) => {
        const notAfter = parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString());
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]),
          maximumSpendMicros: 0,
          maximumActions: 1,
          notAfter
        });
        return Object.freeze({
          evaluatedAt: subject.evaluatedAt,
          hardBounds: bounds,
          unattendedBounds: bounds,
          spendMicros: 0,
          actionCount: 1,
          completesBy: subject.evaluatedAt,
          proposedAction: Object.freeze({
            key: `${operation.name}.execute`,
            version: 1,
            digestSha256: subject.requestHashSha256
          }),
          failure: Object.freeze({ kind: 'none' as const })
        });
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: refs.approval,
      operation,
      resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: refs.preflight,
      operation,
      policy: refs.autonomy,
      riskResolver: refs.risk,
      evidenceResolver: refs.evidence,
      approvalResolver: refs.approval,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    const handler = createOrganizerCommunicationMutationHandler({
      reference: refs.handler,
      operationName,
      handlerCapability: refs.capability,
      contributionSchema: sharedRefs.contribution,
      canonicalResultSchema: refs.canonical
    });
    return Object.freeze({
      key, operation, operationName, catalog, refs, autonomy, context, family,
      terminalization, phase, risk, evidence, approval, preflight, handler
    });
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: sharedRefs.nullDetail
  }));
  const schemaMap = new Map<string, { readonly reference: SafeSchemaManifestRef; readonly schema: z.ZodType }>();
  const addSchema = (reference: SafeSchemaManifestRef, schema: z.ZodType) => {
    schemaMap.set(`${reference.key}@${reference.version}:${reference.digestSha256}`, { reference, schema });
  };
  addSchema(sharedRefs.nullDetail, nullDetailSchema);
  addSchema(sharedRefs.contribution, organizerCommunicationMutationContributionSchema);
  for (const entry of entries) {
    addSchema(entry.catalog.refs.inputSchema, entry.catalog.inputSchema);
    addSchema(entry.refs.canonical, entry.catalog.canonicalSchema);
    addSchema(entry.catalog.refs.resultSchema, entry.catalog.projectedSchema);
  }

  return Object.freeze({
    id: 'communication.organizer.authoring-mutation-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze(entries.map((entry) => entry.autonomy)),
      schemas: Object.freeze([...schemaMap.values()]),
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      projections: Object.freeze(entries.map((entry) => ({
        reference: entry.refs.projection,
        canonicalResultSchema: entry.refs.canonical,
        projectedResultSchema: entry.catalog.refs.resultSchema,
        project: (candidate: unknown) => entry.catalog.canonicalSchema.parse(candidate)
      }))),
      readOperationalTraceTargets: Object.freeze([]),
      operationAuditTargets: Object.freeze([{
        reference: sharedRefs.effectAudit,
        kind: 'operation_audit_record' as const,
        recordProfile: sharedRefs.auditRecord
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: sharedRefs.auditRecord,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      operations: Object.freeze([]),
      effectExecutionFamilies: Object.freeze(entries.map((entry) => entry.family)),
      effectPhases: Object.freeze(entries.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(entries.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(entries.map((entry) => entry.risk)),
      autonomyEvidenceResolvers: Object.freeze(entries.map((entry) => entry.evidence)),
      renewedApprovalResolvers: Object.freeze(entries.map((entry) => entry.approval)),
      autonomyPreflights: Object.freeze(entries.map((entry) => entry.preflight)),
      effectContextBuilders: Object.freeze(entries.map((entry) => entry.context)),
      effectHandlers: Object.freeze(entries.map((entry) => entry.handler)),
      effectOperations: Object.freeze(entries.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Apply inert organizer authoring mutation ${entry.operation.name}.`,
        effect: 'draft' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [entry.catalog.consequenceTag],
        inputSchema: entry.catalog.refs.inputSchema,
        contributionSchema: sharedRefs.contribution,
        canonicalResultSchema: entry.refs.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'communication.event_required', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'conflict' as const, kind: 'communication.not_found', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'conflict' as const, kind: 'communication.draft_not_active', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'stale_revision' as const, kind: 'communication.revision_changed', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'policy_violation' as const, kind: 'communication.authoring_invalid', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'quota_exceeded' as const, kind: 'communication.authoring_quota', retryable: false,
            detailSchema: sharedRefs.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
            detailSchema: sharedRefs.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(sharedRefs.nullDetail)
        ],
        accessLanes: lanes,
        contextBuilder: entry.refs.context,
        handlerCapability: entry.refs.capability,
        handler: entry.refs.handler,
        audit: { mode: 'required' as const, target: sharedRefs.effectAudit },
        idempotency: {
          keySource: sharedRefs.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: entry.refs.requestHash
        },
        concurrency: entry.refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: entry.refs.family,
          phase: entry.refs.phase,
          terminalization: entry.refs.terminalization,
          autonomyPreflight: entry.refs.preflight
        },
        bindings: [
          { surface: 'operator_http' as const, method: 'POST' as const, path: entry.catalog.path,
            input: 'body' as const, browserResumption: { kind: 'none' as const },
            projection: entry.refs.projection },
          { surface: 'app_model' as const, toolName: entry.operation.name,
            projection: entry.refs.projection }
        ]
      })))
    })
  });
}

/** Joins the read and mutation halves while retaining one exact copy of their shared schema/audit registrations. */
export function composeOrganizerCommunicationAuthoringOperationModules(input: {
  readonly read: OperationRegistryModule;
  readonly mutation: OperationRegistryModule;
}): OperationRegistryModule {
  if (input.read.id !== 'communication.organizer.authoring-read-operations'
      || input.mutation.id !== 'communication.organizer.authoring-mutation-operations') {
    throw new TypeError('communication_authoring_module_pair_invalid');
  }
  const readSchemas = new Map(
    (input.read.source.schemas ?? []).map((registered) => [
      `${registered.reference.key}@${registered.reference.version}`,
      registered
    ])
  );
  const readAuditProfiles = new Map(
    (input.read.source.operationAuditRecordProfiles ?? []).map((registered) => [
      `${registered.reference.key}@${registered.reference.version}`,
      registered
    ])
  );
  const mutation: OperationRegistryModule = Object.freeze({
    ...input.mutation,
    source: Object.freeze({
      ...input.mutation.source,
      schemas: Object.freeze((input.mutation.source.schemas ?? []).filter((registered) => {
        const existing = readSchemas.get(
          `${registered.reference.key}@${registered.reference.version}`
        );
        if (!existing) return true;
        if (existing.reference.digestSha256 !== registered.reference.digestSha256
            || existing.schema !== registered.schema) {
          throw new TypeError('communication_authoring_shared_schema_mismatch');
        }
        return false;
      })),
      operationAuditRecordProfiles: Object.freeze(
        (input.mutation.source.operationAuditRecordProfiles ?? []).filter((registered) => {
          const existing = readAuditProfiles.get(
            `${registered.reference.key}@${registered.reference.version}`
          );
          if (!existing) return true;
          if (existing.kind !== registered.kind
              || existing.maximumBytes !== registered.maximumBytes) {
            throw new TypeError('communication_authoring_shared_audit_profile_mismatch');
          }
          return false;
        })
      )
    })
  });
  return Object.freeze({
    id: 'communication.organizer.authoring-operations',
    source: composeOperationRegistryModules([input.read, mutation])
  });
}
