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
  ENGAGEMENT_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  speakerPersonHistoryInputSchema,
  speakerPersonHistoryPageSchema,
  speakerPersonHistoryReadResultSchema,
  structuredOutcomeSchema,
  type EngagementScopeDto,
  type SafeSchemaManifestRef,
  type SpeakerPersonHistoryPageDto,
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
import {
  ENGAGEMENT_READ_ACCESS_POLICY,
  currentEventScopeResolver,
  type EngagementCurrentEventSource
} from './module';

export const SPEAKER_PERSON_HISTORY_READ_OPERATION = Object.freeze({
  name: 'speaker.person-history.read', version: 1
});

export interface SpeakerPersonHistoryReadSource {
  read(
    scope: EngagementScopeDto,
    input: unknown
  ): ReturnTypeOrPromise<SpeakerPersonHistoryPageDto | undefined>;
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

const canonical = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: speakerPersonHistoryPageSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const refs = Object.freeze({
  autonomy: ref('autonomy.speaker.person-history.read'),
  context: ref('context.speaker.person-history.read'),
  capability: ref('capability.speaker.person-history.read'),
  handler: ref('handler.speaker.person-history.read'),
  canonical: schemaRef('schema.speaker.person-history-read.canonical-result', canonical),
  projection: ref('projection.speaker.person-history-read.operator'),
  trace: ref('trace.speaker.person-history.read'),
  recordProfile: ref('record-profile.speaker.person-history.read-trace'),
  nullDetail: schemaRef('schema.speaker.person-history-read.null-detail', z.null())
});

export function createSpeakerPersonHistoryOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: EngagementCurrentEventSource;
  readonly read: SpeakerPersonHistoryReadSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== ENGAGEMENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== ENGAGEMENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('speaker_person_history_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: SPEAKER_PERSON_HISTORY_READ_OPERATION,
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
    operation: SPEAKER_PERSON_HISTORY_READ_OPERATION,
    effect: 'read', lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.nullDetail
  }));
  return Object.freeze({
    id: 'speaker.person-history.read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead.inputSchema,
          schema: speakerPersonHistoryInputSchema },
        { reference: refs.canonical, schema: canonical },
        { reference: ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead.resultSchema,
          schema: speakerPersonHistoryReadResultSchema },
        { reference: refs.nullDetail, schema: z.null() }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([{
        reference: refs.capability,
        openSnapshot: (invocation: ReadInvocationContext) => invocation.scope.eventId === undefined
          ? Object.freeze({ kind: 'event_required' as const })
          : Object.freeze({ kind: 'scope' as const, scope: Object.freeze({
              workspaceId: invocation.scope.workspaceId, eventId: invocation.scope.eventId
            }) })
      } satisfies ReadCapabilityRegistration]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: refs.canonical,
        handle: async ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          if (snapshot.kind === 'event_required') {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'speaker.person-history.event_required',
                retryable: false, subjects: [], detail: null, detailSchemaVersion: 1
              })
            });
          }
          const request = speakerPersonHistoryInputSchema.parse(businessInput);
          const served = await input.read.read(snapshot.scope as EngagementScopeDto, request);
          if (served === undefined) throw new TypeError('speaker_person_history_scope_missing');
          return Object.freeze({ kind: 'success' as const, data: speakerPersonHistoryPageSchema.parse(served) });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead.resultSchema,
        project: (candidate: unknown) => canonical.parse(candidate)
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
        ...SPEAKER_PERSON_HISTORY_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the exact retained history linked to one Person in the current event.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead.inputSchema,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'speaker.person-history.event_required',
            retryable: false,
            detailSchema: refs.nullDetail
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
          path: '/api/events/current/speakers/person-history',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
