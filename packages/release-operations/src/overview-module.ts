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
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  RELEASE_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  releaseOverviewReadInputSchema,
  releaseOverviewReadResultSchema,
  releaseOverviewSchema,
  structuredOutcomeSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  parseEventId,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { ReleaseReadPort } from '@jooevents/release';
import { z } from 'zod';
import {
  RELEASE_DRAFT_ACCESS_POLICY,
  type ReleaseCurrentEventSource
} from './policy';

export const RELEASE_OVERVIEW_READ_OPERATION = Object.freeze({
  name: 'release.overview.read', version: 1
});
export const RELEASE_OVERVIEW_READ_PATH = '/api/events/current/releases';

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

const canonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: releaseOverviewSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const schemas = Object.freeze({
  input: RELEASE_OPERATION_SCHEMA_REFS.overviewRead.inputSchema,
  canonical: createSafeSchemaManifestRef(
    'schema.release.overview-read.canonical-result', canonicalResultSchema
  ),
  projected: RELEASE_OPERATION_SCHEMA_REFS.overviewRead.resultSchema,
  nullDetail: createSafeSchemaManifestRef('schema.release.overview-read.null-detail', z.null())
});
const refs = Object.freeze({
  autonomy: ref('autonomy.release.overview-read'),
  context: ref('context.release.overview-read'),
  capability: ref('capability.release.overview-read'),
  handler: ref('handler.release.overview-read'),
  projection: ref('projection.release.overview-read.operator'),
  trace: ref('trace.release.overview-read'),
  record: ref('record-profile.release.overview-read')
});

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function scopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly currentEvent: ReleaseCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const current = await input.currentEvent.resolveCurrentEvent(input.workspaceId);
      const evidenceIds = Object.freeze([...new Set(current.evidenceIds)].sort());
      if (current.eventId === undefined) return Object.freeze({
        workspaceId: input.workspaceId,
        subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
        resolutionEvidenceIds: evidenceIds
      });
      const eventId = parseEventId(current.eventId);
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

export function createReleaseOverviewOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ReleaseCurrentEventSource;
  readonly read: Pick<
    ReleaseReadPort,
    | 'readCurrentProgramRelease'
    | 'readCurrentStyleSetRelease'
    | 'readSurfaceHead'
    | 'readSurfaceRelease'
  >;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== RELEASE_DRAFT_ACCESS_POLICY.key
      || input.readPolicy.version !== RELEASE_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('release_overview_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: RELEASE_OVERVIEW_READ_OPERATION,
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
    operation: RELEASE_OVERVIEW_READ_OPERATION,
    effect: 'read', lanes: [lane],
    scopeResolver: scopeResolver({ workspaceId, currentEvent: input.currentEvent }),
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
    openSnapshot: (invocation: EffectInvocationContext) => Object.freeze({
      workspaceId: invocation.scope.workspaceId,
      eventId: invocation.scope.eventId
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  return Object.freeze({
    id: 'release-overview-read.operation',
    source: Object.freeze({
      effectExecutionFamilies: [], effectPhases: [], terminalizationResolvers: [],
      riskResolvers: [], autonomyEvidenceResolvers: [], renewedApprovalResolvers: [],
      autonomyPreflights: [], autonomyPolicies: [autonomy],
      schemas: [
        { reference: schemas.input, schema: releaseOverviewReadInputSchema },
        { reference: schemas.canonical, schema: canonicalResultSchema },
        { reference: schemas.projected, schema: releaseOverviewReadResultSchema },
        { reference: schemas.nullDetail, schema: z.null() }
      ],
      contextBuilders: [context],
      readCapabilities: [capability],
      handlers: [{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => {
          if (typeof snapshot.eventId !== 'string') return Object.freeze({
            kind: 'outcome' as const,
            outcome: {
              class: 'conflict' as const, kind: 'release.event_required', retryable: false,
              subjects: [], detail: null, detailSchemaVersion: 1
            }
          });
          const scope = {
            workspaceId: parseWorkspaceId(snapshot.workspaceId),
            eventId: parseEventId(snapshot.eventId)
          };
          const surfaceHeads = (['schedule', 'speakers', 'apply'] as const)
            .flatMap((kind) => input.read.readSurfaceHead(scope, kind) ?? []);
          return Object.freeze({
            kind: 'success' as const,
            data: releaseOverviewSchema.parse({
              schemaVersion: 1,
              scope,
              currentProgramRelease: input.read.readCurrentProgramRelease(scope) ?? null,
              currentStyleSetRelease: input.read.readCurrentStyleSetRelease(scope) ?? null,
              surfaceHeads,
              activeSurfaceReleases: surfaceHeads.map((head) => {
                const release = input.read.readSurfaceRelease(scope, head.activeReleaseId);
                if (release === undefined) throw new TypeError('release_overview_active_surface_missing');
                return release;
              })
            })
          });
        }
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
        recordProfile: refs.record
      }],
      operationAuditTargets: [],
      operationAuditRecordProfiles: [{
        reference: refs.record,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }],
      operations: [{
        ...RELEASE_OVERVIEW_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read current program, style-set, and public-surface release heads.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: schemas.input,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const, kind: 'release.event_required', retryable: false,
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
          path: RELEASE_OVERVIEW_READ_PATH,
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }],
      effectContextBuilders: [], effectHandlers: [], effectOperations: []
    })
  });
}
