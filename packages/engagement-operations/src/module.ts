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
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  ENGAGEMENT_OPERATION_SCHEMA_REFS,
  engagementSnapshotReadInputSchema,
  engagementSnapshotReadResultSchema,
  engagementSnapshotSchema,
  type EngagementScopeDto,
  type EngagementSnapshotDto
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
  parseContractVersion,
  parseEventId,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

export const ENGAGEMENT_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'engagement.snapshot.read', version: 1
});

export const ENGAGEMENT_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.engagement.read', version: parseContractVersion(1)
});
export const ENGAGEMENT_READ_PERMISSION_ID: PermissionId = 'speaker.directory.read';

export const engagementSnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: engagementSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export { engagementSnapshotReadResultSchema };

/**
 * Current engagement heads for the whole event scope. `undefined` means the
 * scope root itself is missing — a composition fault, never an empty state:
 * an event with no engagements serves an empty snapshot.
 */
export interface EngagementSnapshotReadSource {
  readEngagementSnapshot(scope: EngagementScopeDto): EngagementSnapshotDto | undefined;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: ENGAGEMENT_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  canonical: schemaRef(
    'schema.engagement.snapshot-read.canonical-result',
    engagementSnapshotCanonicalResultSchema
  ),
  projected: ENGAGEMENT_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  nullDetail: schemaRef('schema.engagement.operation.null-detail', z.null())
});

const refs = Object.freeze({
  context: ref('context.engagement.snapshot-read'),
  autonomy: ref('autonomy.engagement.snapshot-read'),
  capability: ref('capability.engagement.snapshot-read'),
  handler: ref('handler.engagement.snapshot-read'),
  projection: ref('projection.engagement.snapshot-read.operator'),
  trace: ref('trace.engagement.snapshot-read'),
  recordProfile: ref('record-profile.engagement.read-operational-trace')
});

export interface EngagementOperationIds {
  newInvocationId(): InvocationId;
}

export interface EngagementCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface EngagementCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    EngagementCurrentEventResolution | Promise<EngagementCurrentEventResolution>;
}

export interface CreateEngagementOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: EngagementCurrentEventSource;
  readonly clock: Clock;
  readonly ids: EngagementOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly engagements: EngagementSnapshotReadSource;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.trim() !== value) {
      throw new TypeError('engagement_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: EngagementCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('engagement_current_event_resolution_invalid');
      }
      const evidenceIds = canonicalEvidenceIds(resolved.evidenceIds);
      if (resolved.eventId === undefined) {
        return Object.freeze({
          workspaceId: input.workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
          resolutionEvidenceIds: evidenceIds
        });
      }
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({
        workspaceId: input.workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: input.workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: evidenceIds
      });
    }
  });
}

export function createEngagementOperationModule(
  input: CreateEngagementOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== ENGAGEMENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== ENGAGEMENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('engagement_operation_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: ENGAGEMENT_SNAPSHOT_READ_OPERATION,
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
    operation: ENGAGEMENT_SNAPSHOT_READ_OPERATION,
    effect: 'read',
    lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const openSnapshot = (invocation: ReadInvocationContext) => {
    if (invocation.scope.eventId === undefined) {
      return Object.freeze({ kind: 'event_required' as const });
    }
    return Object.freeze({
      kind: 'scope' as const,
      scope: Object.freeze({
        workspaceId: invocation.scope.workspaceId,
        eventId: invocation.scope.eventId
      })
    });
  };
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.capability,
    openSnapshot
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));

  return Object.freeze({
    id: 'engagement.operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: engagementSnapshotReadInputSchema },
        { reference: schemas.canonical, schema: engagementSnapshotCanonicalResultSchema },
        { reference: schemas.projected, schema: engagementSnapshotReadResultSchema },
        { reference: schemas.nullDetail, schema: z.null() }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([capability]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          if (snapshot.kind === 'event_required') {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'engagement.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          engagementSnapshotReadInputSchema.parse(businessInput);
          const scope = snapshot.scope as EngagementScopeDto;
          const served = input.engagements.readEngagementSnapshot(scope);
          // A resolved current event whose scope root is missing is corrupt
          // composition state, never an honest empty snapshot.
          if (served === undefined) throw new TypeError('engagement_snapshot_scope_missing');
          return Object.freeze({
            kind: 'success' as const,
            data: engagementSnapshotSchema.parse(served)
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => engagementSnapshotCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.recordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.recordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      operations: Object.freeze([{
        ...ENGAGEMENT_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read every engagement head for the current event: session-person invitations and their response states.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: schemas.input,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'engagement.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          }
        ],
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
          path: '/api/events/current/engagements',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
