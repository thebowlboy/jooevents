import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  type EffectInvocationContext,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
  templateArtifactGetCanonicalResultSchema,
  templateArtifactGetInputSchema,
  templateArtifactGetOperationResultSchema,
  templateArtifactListCanonicalResultSchema,
  templateArtifactListDataSchema,
  templateArtifactListInputSchema,
  templateArtifactListOperationResultSchema,
  type StructuredOutcome,
  type TemplateArtifactSnapshotDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { EVENT_READ_ACCESS_POLICY } from '@jooevents/event-operations';
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

export const TEMPLATE_ARTIFACT_LIST_OPERATION = Object.freeze({ name: 'template.artifact.list', version: 1 });
export const TEMPLATE_ARTIFACT_GET_OPERATION = Object.freeze({ name: 'template.artifact.get', version: 1 });
export const TEMPLATE_ARTIFACT_LIST_PATH = '/api/events/current/template-artifacts';
export const TEMPLATE_ARTIFACT_GET_PATH = '/api/events/current/template-artifacts/detail';

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
function denied(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return { class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
}
function scope(
  workspaceId: WorkspaceId,
  currentEvent: TemplateArtifactCurrentEventSource
): InvocationScopeResolver {
  return Object.freeze({ async resolve() {
    const current = await currentEvent.resolveCurrentEvent(workspaceId);
    const eventId = current.eventId === undefined ? undefined : parseEventId(current.eventId);
    return Object.freeze({
      workspaceId,
      ...(eventId === undefined ? {} : { eventId }),
      subjects: Object.freeze(eventId === undefined
        ? [{ kind: 'workspace' as const, id: workspaceId }]
        : [
            { kind: 'workspace' as const, id: workspaceId },
            { kind: 'event' as const, id: eventId }
          ]),
      resolutionEvidenceIds: Object.freeze([...current.evidenceIds])
    });
  } });
}

const refs = Object.freeze({
  list: { context: ref('context.template.artifact.list'), autonomy: ref('autonomy.template.artifact.list'), handler: ref('handler.template.artifact.list'), projection: ref('projection.template.artifact.list.operator') },
  get: { context: ref('context.template.artifact.get'), autonomy: ref('autonomy.template.artifact.get'), handler: ref('handler.template.artifact.get'), projection: ref('projection.template.artifact.get.operator') },
  capability: ref('capability.template.artifact.read'),
  trace: ref('trace.template.artifact.read'),
  record: ref('record-profile.template.artifact.read-trace')
});
const nullSchema = z.null();
const schemas = Object.freeze({
  listInput: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.list.inputSchema,
  listCanonical: createSafeSchemaManifestRef('schema.template-artifact.list.canonical-result', templateArtifactListCanonicalResultSchema),
  listProjected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.list.resultSchema,
  getInput: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.get.inputSchema,
  getCanonical: createSafeSchemaManifestRef('schema.template-artifact.get.canonical-result', templateArtifactGetCanonicalResultSchema),
  getProjected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.get.resultSchema,
  null: createSafeSchemaManifestRef('schema.template-artifact.read.null-detail', nullSchema)
});

export interface TemplateArtifactOperationIds { newInvocationId(): InvocationId; }
export interface TemplateArtifactCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): {
    readonly eventId?: string;
    readonly evidenceIds: readonly string[];
  } | Promise<{
    readonly eventId?: string;
    readonly evidenceIds: readonly string[];
  }>;
}
export interface TemplateArtifactCurrentReadPort {
  listCurrent(workspaceId: WorkspaceId, eventId: EventId): readonly TemplateArtifactSnapshotDto[]
    | undefined | Promise<readonly TemplateArtifactSnapshotDto[] | undefined>;
}
export interface CreateTemplateArtifactReadOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: TemplateArtifactCurrentEventSource;
  readonly currentRead: TemplateArtifactCurrentReadPort;
  readonly clock: Clock;
  readonly ids: TemplateArtifactOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}

export function createTemplateArtifactReadOperationModule(input: CreateTemplateArtifactReadOperationModuleInput): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== EVENT_READ_ACCESS_POLICY.key || input.readPolicy.version !== EVENT_READ_ACCESS_POLICY.version) throw new TypeError('template_artifact_read_policy_catalog_mismatch');
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.readPolicy });
  const operations = [{ key: 'list' as const, operation: TEMPLATE_ARTIFACT_LIST_OPERATION }, { key: 'get' as const, operation: TEMPLATE_ARTIFACT_GET_OPERATION }];
  const autonomies = operations.map(({ key, operation }) => createOperationAutonomyPolicy({ definition: refs[key].autonomy, operation, riskFloor: 'low', unattendedRiskCeiling: 'low', supportedDispositions: ['proceed','safe_retry','reconcile','renewed_approval','replan','compensate','block','attention'], triggerDispositions: { authority_lost:'block', unattended_bounds_exceeded:'renewed_approval', approval_required:'renewed_approval', known_retryable_failure:'safe_retry', ambiguous_external_effect:'reconcile', stale_plan:'replan', compensation_required:'compensate', terminal_failure:'attention' }, requiresSeparateApproval: false }));
  const contexts = operations.map(({ key, operation }) => createReadInvocationContextBuilder({ reference: refs[key].context, operation, effect: 'read', lanes: [lane], scopeResolver: scope(workspaceId, input.currentEvent), authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId, authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile, requestCanonicalizationProfile: input.requestCanonicalizationProfile, deniedAuthorityOutcome: denied }));
  const capability: ReadCapabilityRegistration = Object.freeze({ reference: refs.capability, openSnapshot: async (context: EffectInvocationContext) => Object.freeze({ artifacts: context.scope.eventId === undefined ? undefined : await input.currentRead.listCurrent(context.scope.workspaceId, context.scope.eventId) }) });
  const conflict = (kind: 'template.artifact.event_required' | 'template.artifact.not_found') => ({ kind: 'outcome' as const, outcome: { class: 'conflict' as const, kind, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.null }));
  return Object.freeze({ id: 'template-artifact-read.operation', source: Object.freeze({
    effectExecutionFamilies: [], effectPhases: [], terminalizationResolvers: [], riskResolvers: [], autonomyEvidenceResolvers: [], renewedApprovalResolvers: [], autonomyPreflights: [], autonomyPolicies: autonomies,
    schemas: [
      { reference: schemas.listInput, schema: templateArtifactListInputSchema }, { reference: schemas.listCanonical, schema: templateArtifactListCanonicalResultSchema }, { reference: schemas.listProjected, schema: templateArtifactListOperationResultSchema },
      { reference: schemas.getInput, schema: templateArtifactGetInputSchema }, { reference: schemas.getCanonical, schema: templateArtifactGetCanonicalResultSchema }, { reference: schemas.getProjected, schema: templateArtifactGetOperationResultSchema }, { reference: schemas.null, schema: nullSchema }
    ],
    contextBuilders: contexts, readCapabilities: [capability],
    handlers: [
      { reference: refs.list.handler, readCapability: refs.capability, canonicalResultSchema: schemas.listCanonical, handle: ({ snapshot, businessInput }: { snapshot: Readonly<Record<string, unknown>>; businessInput: unknown }) => { if (snapshot.artifacts === undefined) return conflict('template.artifact.event_required'); const query = templateArtifactListInputSchema.parse(businessInput); const artifacts = snapshot.artifacts as readonly TemplateArtifactSnapshotDto[]; return { kind: 'success' as const, data: templateArtifactListDataSchema.parse({ schemaVersion: 1, artifacts: query.kind === undefined ? [...artifacts] : artifacts.filter((entry) => entry.head.artifactKind === query.kind) }) }; } },
      { reference: refs.get.handler, readCapability: refs.capability, canonicalResultSchema: schemas.getCanonical, handle: ({ snapshot, businessInput }: { snapshot: Readonly<Record<string, unknown>>; businessInput: unknown }) => { if (snapshot.artifacts === undefined) return conflict('template.artifact.event_required'); const query = templateArtifactGetInputSchema.parse(businessInput); const artifact = (snapshot.artifacts as readonly TemplateArtifactSnapshotDto[]).find((entry) => entry.head.artifactId === query.artifactId); return artifact ? { kind: 'success' as const, data: artifact } : conflict('template.artifact.not_found'); } }
    ],
    projections: [
      { reference: refs.list.projection, canonicalResultSchema: schemas.listCanonical, projectedResultSchema: schemas.listProjected, project: (candidate: unknown) => templateArtifactListCanonicalResultSchema.parse(candidate) },
      { reference: refs.get.projection, canonicalResultSchema: schemas.getCanonical, projectedResultSchema: schemas.getProjected, project: (candidate: unknown) => templateArtifactGetCanonicalResultSchema.parse(candidate) }
    ],
    readOperationalTraceTargets: [{ reference: refs.trace, kind: 'read_operational_trace_record' as const, recordProfile: refs.record }], operationAuditTargets: [], operationAuditRecordProfiles: [{ reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 262_144 }],
    operations: operations.map(({ key, operation }) => ({ ...operation, lifecycle: { status: 'active' as const }, summary: key === 'list' ? 'List current template authoring artifacts.' : 'Read one template authoring artifact.', effect: 'read' as const, maxRisk: 'low' as const, autonomyPolicy: refs[key].autonomy, consequenceTags: [], inputSchema: key === 'list' ? schemas.listInput : schemas.getInput, canonicalResultSchema: key === 'list' ? schemas.listCanonical : schemas.getCanonical, outcomes: [...access, { class: 'conflict' as const, kind: 'template.artifact.event_required', retryable: false, detailSchema: schemas.null }, ...(key === 'get' ? [{ class: 'conflict' as const, kind: 'template.artifact.not_found', retryable: false, detailSchema: schemas.null }] : [])], accessLanes: [lane], contextBuilder: refs[key].context, readCapability: refs.capability, handler: refs[key].handler, observability: { trace: { mode: 'required' as const, target: refs.trace }, immutableAudit: { mode: 'none' as const } }, bindings: [{ surface: 'operator_http' as const, method: 'GET' as const, path: key === 'list' ? TEMPLATE_ARTIFACT_LIST_PATH : TEMPLATE_ARTIFACT_GET_PATH, input: 'query' as const, browserResumption: { kind: 'none' as const }, projection: refs[key].projection }] })),
    effectContextBuilders: [], effectHandlers: [], effectOperations: []
  }) });
}
