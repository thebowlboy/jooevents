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
  ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS,
  acceleventsExportArtifactDescriptorSchema,
  acceleventsExportArtifactReadInputSchema,
  acceleventsExportArtifactReadResultSchema,
  acceleventsExportViewReadInputSchema,
  acceleventsExportViewReadResultSchema,
  acceleventsExportViewSchema,
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type AcceleventsExportView,
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
import {
  buildAcceleventsPackage,
  projectAcceleventsExportView,
  renderAcceleventsLocationsCsv,
  type AcceleventsExportSource
} from '@jooevents/program-export';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ACCELEVENTS_EXPORT_LOCATIONS_PREPARE_PATH,
  ACCELEVENTS_EXPORT_PACKAGE_PREPARE_PATH,
  ACCELEVENTS_EXPORT_READ_ACCESS_POLICY,
  ACCELEVENTS_EXPORT_VIEW_PATH,
  type AcceleventsExportCurrentEventSource
} from './policy';

export const ACCELEVENTS_EXPORT_VIEW_READ_OPERATION = Object.freeze({ name: 'program.export.accelevents.view.read', version: 1 });
export const ACCELEVENTS_EXPORT_LOCATIONS_READ_OPERATION = Object.freeze({ name: 'program.export.accelevents.locations.read', version: 1 });
export const ACCELEVENTS_EXPORT_PACKAGE_READ_OPERATION = Object.freeze({ name: 'program.export.accelevents.package.read', version: 1 });

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
const canonicalViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: acceleventsExportViewSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const canonicalArtifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: acceleventsExportArtifactDescriptorSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const schemas = Object.freeze({
  viewInput: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.viewRead.inputSchema,
  viewCanonical: createSafeSchemaManifestRef('schema.program.export.accelevents.view-read.canonical', canonicalViewSchema),
  viewProjected: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.viewRead.resultSchema,
  artifactInput: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.locationsRead.inputSchema,
  artifactCanonical: createSafeSchemaManifestRef('schema.program.export.accelevents.artifact-read.canonical', canonicalArtifactSchema),
  locationsProjected: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.locationsRead.resultSchema,
  packageProjected: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.packageRead.resultSchema,
  nullDetail: createSafeSchemaManifestRef('schema.program.export.accelevents.null-detail', z.null()),
  blockerDetail: createSafeSchemaManifestRef('schema.program.export.accelevents.blocker-detail', z.strictObject({
    severity: z.literal('block'), blockers: z.array(z.strictObject({ id: z.string(), summary: z.string(), anchor: z.string().optional() })).max(20_000)
  }))
});
const refs = Object.freeze({
  view: { autonomy: ref('autonomy.program.export.accelevents.view-read'), context: ref('context.program.export.accelevents.view-read'), handler: ref('handler.program.export.accelevents.view-read'), projection: ref('projection.program.export.accelevents.view-read.operator'), trace: ref('trace.program.export.accelevents.view-read'), audit: ref('audit.program.export.accelevents.view-read') },
  locations: { autonomy: ref('autonomy.program.export.accelevents.locations-read'), context: ref('context.program.export.accelevents.locations-read'), handler: ref('handler.program.export.accelevents.locations-read'), projection: ref('projection.program.export.accelevents.locations-read.operator'), trace: ref('trace.program.export.accelevents.locations-read') },
  package: { autonomy: ref('autonomy.program.export.accelevents.package-read'), context: ref('context.program.export.accelevents.package-read'), handler: ref('handler.program.export.accelevents.package-read'), projection: ref('projection.program.export.accelevents.package-read.operator'), trace: ref('trace.program.export.accelevents.package-read'), audit: ref('audit.program.export.accelevents.package-read') },
  capability: ref('capability.program.export.accelevents.read'),
  traceRecord: ref('record-profile.program.export.accelevents.read-trace'),
  auditRecord: ref('record-profile.program.export.accelevents.classified-read')
});

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return { class: 'access_denied', kind: `authority.${reason}`, retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 };
}
function eventScopeResolver(workspaceId: WorkspaceId, currentEvent: AcceleventsExportCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({ async resolve() {
    const current = await currentEvent.resolveCurrentEvent(workspaceId);
    if (current.eventId) {
      const eventId = parseEventId(current.eventId);
      return {
      workspaceId, eventId,
      subjects: [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }],
      resolutionEvidenceIds: [...new Set(current.evidenceIds)].sort()
      };
    }
    return { workspaceId, subjects: [{ kind: 'workspace' as const, id: workspaceId }], resolutionEvidenceIds: [...new Set(current.evidenceIds)].sort() };
  }});
}

export interface AcceleventsExportReadSource {
  readSource(scope: { readonly workspaceId: string; readonly eventId: string }): AcceleventsExportSource;
}

export function createAcceleventsExportReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: AcceleventsExportCurrentEventSource;
  readonly source: AcceleventsExportReadSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policy.key !== ACCELEVENTS_EXPORT_READ_ACCESS_POLICY.key || input.policy.version !== ACCELEVENTS_EXPORT_READ_ACCESS_POLICY.version) throw new TypeError('accelevents_export_read_policy_mismatch');
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy });
  const definitions = [
    { key: 'view' as const, operation: ACCELEVENTS_EXPORT_VIEW_READ_OPERATION, path: ACCELEVENTS_EXPORT_VIEW_PATH, inputSchema: acceleventsExportViewReadInputSchema, inputRef: schemas.viewInput, canonical: canonicalViewSchema, canonicalRef: schemas.viewCanonical, projected: acceleventsExportViewReadResultSchema, projectedRef: schemas.viewProjected, immutableAudit: refs.view.audit },
    { key: 'locations' as const, operation: ACCELEVENTS_EXPORT_LOCATIONS_READ_OPERATION, path: ACCELEVENTS_EXPORT_LOCATIONS_PREPARE_PATH, inputSchema: acceleventsExportArtifactReadInputSchema, inputRef: schemas.artifactInput, canonical: canonicalArtifactSchema, canonicalRef: schemas.artifactCanonical, projected: acceleventsExportArtifactReadResultSchema, projectedRef: schemas.locationsProjected, immutableAudit: null },
    { key: 'package' as const, operation: ACCELEVENTS_EXPORT_PACKAGE_READ_OPERATION, path: ACCELEVENTS_EXPORT_PACKAGE_PREPARE_PATH, inputSchema: acceleventsExportArtifactReadInputSchema, inputRef: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.packageRead.inputSchema, canonical: canonicalArtifactSchema, canonicalRef: schemas.artifactCanonical, projected: acceleventsExportArtifactReadResultSchema, projectedRef: schemas.packageProjected, immutableAudit: refs.package.audit }
  ] as const;
  const autonomyPolicies = definitions.map((entry) => createOperationAutonomyPolicy({
    definition: refs[entry.key].autonomy, operation: entry.operation, riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval', approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry', ambiguous_external_effect: 'reconcile', stale_plan: 'replan', compensation_required: 'compensate', terminal_failure: 'attention' },
    requiresSeparateApproval: false
  }));
  const contexts = definitions.map((entry) => createReadInvocationContextBuilder({
    reference: refs[entry.key].context, operation: entry.operation, effect: 'read', lanes: [lane],
    scopeResolver: eventScopeResolver(workspaceId, input.currentEvent), authorityResolver: input.currentAuthority,
    clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile, scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile, deniedAuthorityOutcome: authorityOutcome
  }));
  const capability: ReadCapabilityRegistration = {
    reference: refs.capability,
    openSnapshot(invocation: EffectInvocationContext) {
      return Object.freeze({
        eventId: invocation.scope.eventId,
        generatedAt: invocation.receivedAt,
        source: invocation.scope.eventId ? input.source.readSource({ workspaceId, eventId: invocation.scope.eventId }) : undefined
      });
    }
  };
  const eventRequired = () => ({ kind: 'outcome' as const, outcome: { class: 'conflict' as const, kind: 'program.export.accelevents.event_required', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } });
  const blocked = (blockers: AcceleventsExportView['preflight']['blockers']) => ({ kind: 'outcome' as const, outcome: { class: 'policy_violation' as const, kind: 'program.export.accelevents.blocked', retryable: false, subjects: [], detail: { severity: 'block' as const, blockers }, detailSchemaVersion: 1 } });
  const handlers = definitions.map((entry) => ({
    reference: refs[entry.key].handler, readCapability: refs.capability, canonicalResultSchema: entry.canonicalRef,
    handle({ snapshot, businessInput }: { snapshot: Readonly<Record<string, unknown>>; businessInput: unknown }) {
      const source = snapshot.source as AcceleventsExportSource | undefined;
      if (!source) return eventRequired();
      const view = projectAcceleventsExportView(source);
      if (entry.key === 'view') return { kind: 'success' as const, data: view };
      const request = acceleventsExportArtifactReadInputSchema.parse(businessInput);
      if (request.releaseId !== view.selectedReleaseId) return blocked([{ id: 'release-changed', summary: 'The selected release changed. Reload the export preparation.', anchor: '#release' }]);
      if (entry.key === 'package' && !view.preflight.ready) return blocked(view.preflight.blockers);
      const packageArtifact = entry.key === 'package'
        ? buildAcceleventsPackage(source, String(snapshot.generatedAt))
        : null;
      const bytes = packageArtifact?.bytes
        ?? new TextEncoder().encode(renderAcceleventsLocationsCsv(source));
      const filename = packageArtifact?.filename ?? 'locations.csv';
      return { kind: 'success' as const, data: {
        releaseId: request.releaseId,
        releaseNumber: source.releases.find((candidate) => candidate.id === request.releaseId)!.number,
        filename, byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        generatedAt: String(snapshot.generatedAt)
      }};
    }
  }));
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.nullDetail }));
  return Object.freeze({ id: 'accelevents-export-read.operation', source: Object.freeze({
    effectExecutionFamilies: [], effectPhases: [], terminalizationResolvers: [], riskResolvers: [], autonomyEvidenceResolvers: [], renewedApprovalResolvers: [], autonomyPreflights: [], autonomyPolicies,
    schemas: [
      { reference: schemas.viewInput, schema: acceleventsExportViewReadInputSchema }, { reference: schemas.viewCanonical, schema: canonicalViewSchema }, { reference: schemas.viewProjected, schema: acceleventsExportViewReadResultSchema },
      { reference: schemas.artifactInput, schema: acceleventsExportArtifactReadInputSchema }, { reference: ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.packageRead.inputSchema, schema: acceleventsExportArtifactReadInputSchema },
      { reference: schemas.artifactCanonical, schema: canonicalArtifactSchema }, { reference: schemas.locationsProjected, schema: acceleventsExportArtifactReadResultSchema }, { reference: schemas.packageProjected, schema: acceleventsExportArtifactReadResultSchema },
      { reference: schemas.nullDetail, schema: z.null() }, { reference: schemas.blockerDetail, schema: z.strictObject({ severity: z.literal('block'), blockers: z.array(z.strictObject({ id: z.string(), summary: z.string(), anchor: z.string().optional() })).max(20_000) }) }
    ],
    contextBuilders: contexts, readCapabilities: [capability], handlers,
    projections: definitions.map((entry) => ({ reference: refs[entry.key].projection, canonicalResultSchema: entry.canonicalRef, projectedResultSchema: entry.projectedRef, project: (candidate: unknown) => entry.canonical.parse(candidate) })),
    readOperationalTraceTargets: definitions.map((entry) => ({ reference: refs[entry.key].trace, kind: 'read_operational_trace_record' as const, recordProfile: refs.traceRecord })),
    operationAuditTargets: [refs.view.audit, refs.package.audit].map((reference) => ({ reference, kind: 'operation_audit_record' as const, recordProfile: refs.auditRecord })),
    operationAuditRecordProfiles: [{ reference: refs.traceRecord, kind: 'canonical_json' as const, maximumBytes: 262_144 }, { reference: refs.auditRecord, kind: 'canonical_json' as const, maximumBytes: 262_144 }],
    operations: definitions.map((entry) => ({
      ...entry.operation, lifecycle: { status: 'active' as const }, summary: entry.key === 'view' ? 'Read the Accelevents export preparation.' : `Prepare the Accelevents ${entry.key} artifact.`, effect: 'read' as const, maxRisk: 'low' as const,
      autonomyPolicy: refs[entry.key].autonomy, consequenceTags: entry.key === 'locations' ? [] : ['speaker-contact-disclosure'], inputSchema: entry.inputRef, canonicalResultSchema: entry.canonicalRef,
      outcomes: [...accessOutcomes, { class: 'conflict' as const, kind: 'program.export.accelevents.event_required', retryable: false, detailSchema: schemas.nullDetail }, { class: 'policy_violation' as const, kind: 'program.export.accelevents.blocked', retryable: false, detailSchema: schemas.blockerDetail }],
      accessLanes: [lane], contextBuilder: refs[entry.key].context, readCapability: refs.capability, handler: refs[entry.key].handler,
      observability: { trace: { mode: 'required' as const, target: refs[entry.key].trace }, immutableAudit: entry.immutableAudit ? { mode: 'required' as const, reason: 'classified' as const, target: entry.immutableAudit } : { mode: 'none' as const } },
      bindings: [{ surface: 'operator_http' as const, method: 'GET' as const, path: entry.path, input: 'query' as const, browserResumption: { kind: 'none' as const }, projection: refs[entry.key].projection }]
    })),
    effectContextBuilders: [], effectHandlers: [], effectOperations: []
  }) });
}
