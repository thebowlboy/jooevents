import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
  programVocabularySnapshotCanonicalResultSchema,
  programVocabularySnapshotReadInputSchema,
  programVocabularySnapshotReadResultSchema,
  programVocabularySnapshotSchema,
  type ProgramVocabularySnapshotDto,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  assertProgramReferenceContributorRegistry,
  captureRegisteredProgramReferences,
  projectProgramVocabularySnapshot,
  type ProgramReferenceContributorRegistry,
  type ProgramVocabularyReadPort
} from '@jooevents/program';
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
  parseContractVersion,
  parseEventId,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

export const PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'program_vocabulary.snapshot.read', version: 1
});
export const PROGRAM_VOCABULARY_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.program_vocabulary.read', version: parseContractVersion(1)
});
export const PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.program_vocabulary.manage', version: parseContractVersion(1)
});
export const PROGRAM_VOCABULARY_READ_PERMISSION_ID: PermissionId = 'event.read';
export const PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID: PermissionId =
  'program.vocabulary.manage';

export interface ProgramVocabularyCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface ProgramVocabularyCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): ProgramVocabularyCurrentEventResolution
    | Promise<ProgramVocabularyCurrentEventResolution>;
}

export interface ProgramVocabularyOperationIds {
  newInvocationId(): InvocationId;
}

/** Runtime-neutral projected source for asynchronous database adapters such as D1. */
export interface ProgramVocabularySnapshotReadSource {
  readSnapshot(scope: {
    readonly workspaceId: WorkspaceId;
    readonly eventId: ReturnType<typeof parseEventId>;
  }): ProgramVocabularySnapshotDto | undefined | Promise<ProgramVocabularySnapshotDto | undefined>;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const nullDetailSchema = z.null();
const refs = Object.freeze({
  context: ref('context.program_vocabulary.snapshot-read'),
  autonomy: ref('autonomy.program_vocabulary.snapshot-read'),
  capability: ref('capability.program_vocabulary.snapshot-read'),
  handler: ref('handler.program_vocabulary.snapshot-read'),
  projection: ref('projection.program_vocabulary.snapshot-read.operator'),
  trace: ref('trace.program_vocabulary.snapshot-read'),
  recordProfile: ref('record-profile.program_vocabulary.read-trace')
});
const schemas = Object.freeze({
  input: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  canonical: schemaRef('schema.program_vocabulary.snapshot-read.canonical-result',
    programVocabularySnapshotCanonicalResultSchema),
  projected: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  nullDetail: schemaRef('schema.program_vocabulary.snapshot-read.null-detail', nullDetailSchema)
});

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({ class: 'access_denied', kind: `authority.${reason}`,
    retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 });
}

function eventRequiredOutcome(): StructuredOutcome {
  return Object.freeze({ class: 'conflict', kind: 'program_vocabulary.event_required',
    retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 });
}

function scopeResolver(workspaceId: WorkspaceId,
  source: ProgramVocabularyCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await source.resolveCurrentEvent(workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('program_vocabulary_current_event_resolution_invalid');
      }
      const evidenceIds = Object.freeze([...new Set(resolved.evidenceIds.map((value) => {
        if (typeof value !== 'string' || value.trim() !== value || !value || value.length > 512) {
          throw new TypeError('program_vocabulary_current_event_evidence_invalid');
        }
        return value;
      }))].sort());
      if (resolved.eventId === undefined) return Object.freeze({ workspaceId,
        subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: evidenceIds });
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({ workspaceId, eventId, subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        { kind: 'event' as const, id: eventId }
      ]), resolutionEvidenceIds: evidenceIds });
    }
  });
}

type ProgramVocabularyReadSourceInput =
  | {
      readonly snapshotRead: ProgramVocabularySnapshotReadSource;
      readonly vocabularyRead?: never;
      readonly referenceRegistry?: never;
    }
  | {
      readonly snapshotRead?: never;
      readonly vocabularyRead: ProgramVocabularyReadPort;
      readonly referenceRegistry: ProgramReferenceContributorRegistry;
    };

export function createProgramVocabularyReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ProgramVocabularyCurrentEventSource;
  readonly clock: Clock;
  readonly ids: ProgramVocabularyOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
} & ProgramVocabularyReadSourceInput): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== PROGRAM_VOCABULARY_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== PROGRAM_VOCABULARY_READ_ACCESS_POLICY.version) {
    throw new TypeError('program_vocabulary_read_policy_catalog_mismatch');
  }
  if (input.snapshotRead === undefined) {
    assertProgramReferenceContributorRegistry(input.referenceRegistry);
  }
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http',
    policy: input.readPolicy });
  const autonomy = createOperationAutonomyPolicy({ definition: refs.autonomy,
    operation: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION, riskFloor: 'low',
    unattendedRiskCeiling: 'low', supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ], triggerDispositions: { authority_lost: 'block',
      unattended_bounds_exceeded: 'renewed_approval', approval_required: 'renewed_approval',
      known_retryable_failure: 'safe_retry', ambiguous_external_effect: 'reconcile',
      stale_plan: 'replan', compensation_required: 'compensate', terminal_failure: 'attention'
    }, requiresSeparateApproval: false });
  const context = createReadInvocationContextBuilder({ reference: refs.context,
    operation: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION, effect: 'read', lanes: [lane],
    scopeResolver: scopeResolver(workspaceId, input.currentEvent),
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome });
  const capability: ReadCapabilityRegistration = Object.freeze({ reference: refs.capability,
    async openSnapshot(readContext: ReadInvocationContext) {
      if (readContext.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
      if (input.snapshotRead !== undefined) {
        const snapshot = await input.snapshotRead.readSnapshot({
          workspaceId: readContext.scope.workspaceId,
          eventId: readContext.scope.eventId
        });
        if (!snapshot) throw new TypeError('program_vocabulary_current_event_state_missing');
        return Object.freeze({
          kind: 'snapshot',
          value: programVocabularySnapshotSchema.parse(snapshot)
        });
      }
      const state = input.vocabularyRead.readVocabulary({ workspaceId: readContext.scope.workspaceId,
        eventId: readContext.scope.eventId });
      if (!state) throw new TypeError('program_vocabulary_current_event_state_missing');
      const references = captureRegisteredProgramReferences({ registry: input.referenceRegistry,
        scope: state.scope, source: input.vocabularyRead });
      return Object.freeze({ kind: 'snapshot', value: projectProgramVocabularySnapshot(state, references) });
    } });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: schemas.nullDetail }));
  return Object.freeze({ id: 'program-vocabulary-read.operation', source: Object.freeze({
    effectExecutionFamilies: Object.freeze([]), effectPhases: Object.freeze([]),
    terminalizationResolvers: Object.freeze([]), riskResolvers: Object.freeze([]),
    autonomyEvidenceResolvers: Object.freeze([]), renewedApprovalResolvers: Object.freeze([]),
    autonomyPreflights: Object.freeze([]), autonomyPolicies: Object.freeze([autonomy]),
    schemas: Object.freeze([
      { reference: schemas.input, schema: programVocabularySnapshotReadInputSchema },
      { reference: schemas.canonical, schema: programVocabularySnapshotCanonicalResultSchema },
      { reference: schemas.projected, schema: programVocabularySnapshotReadResultSchema },
      { reference: schemas.nullDetail, schema: nullDetailSchema }
    ]), contextBuilders: Object.freeze([context]), readCapabilities: Object.freeze([capability]),
    handlers: Object.freeze([{ reference: refs.handler, readCapability: refs.capability,
      canonicalResultSchema: schemas.canonical,
      handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) =>
        snapshot.kind === 'event_required'
          ? Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() })
          : Object.freeze({ kind: 'success' as const,
              data: programVocabularySnapshotSchema.parse(snapshot.value) }) }]),
    projections: Object.freeze([{ reference: refs.projection,
      canonicalResultSchema: schemas.canonical, projectedResultSchema: schemas.projected,
      project: (candidate: unknown) => programVocabularySnapshotCanonicalResultSchema.parse(candidate) }]),
    readOperationalTraceTargets: Object.freeze([{ reference: refs.trace,
      kind: 'read_operational_trace_record' as const, recordProfile: refs.recordProfile }]),
    operationAuditTargets: Object.freeze([]), operationAuditRecordProfiles: Object.freeze([{
      reference: refs.recordProfile, kind: 'canonical_json' as const, maximumBytes: 65_536 }]),
    operations: Object.freeze([{ ...PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
      lifecycle: { status: 'active' as const },
      summary: 'Read rooms, tracks, and formats for the current Event.', effect: 'read' as const,
      maxRisk: 'low' as const, autonomyPolicy: refs.autonomy, consequenceTags: [],
      inputSchema: schemas.input, canonicalResultSchema: schemas.canonical,
      outcomes: [...access, { class: 'conflict' as const,
        kind: 'program_vocabulary.event_required', retryable: false,
        detailSchema: schemas.nullDetail }], accessLanes: [lane], contextBuilder: refs.context,
      readCapability: refs.capability, handler: refs.handler,
      observability: { trace: { mode: 'required' as const, target: refs.trace },
        immutableAudit: { mode: 'none' as const } }, bindings: [{
        surface: 'operator_http' as const, method: 'GET' as const,
        path: '/api/events/current/program-vocabulary', input: 'query' as const,
        browserResumption: { kind: 'none' as const }, projection: refs.projection }] }]),
    effectContextBuilders: Object.freeze([]), effectHandlers: Object.freeze([]),
    effectOperations: Object.freeze([])
  }) });
}
