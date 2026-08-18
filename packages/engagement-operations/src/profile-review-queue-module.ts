import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  type InvocationEvidence,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext
} from '@jooevents/application';
import {
  SPEAKER_PROFILE_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  speakerProfileReviewQueueReadInputSchema,
  speakerProfileReviewQueueReadResultSchema,
  speakerProfileReviewQueueSchema,
  structuredOutcomeSchema,
  type SpeakerProfileReviewQueueDto,
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
import { parseWorkspaceId, type Clock, type InvocationId, type WorkspaceId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  ENGAGEMENT_READ_ACCESS_POLICY,
  currentEventScopeResolver,
  type EngagementCurrentEventSource
} from './module';

export const SPEAKER_PROFILE_REVIEW_QUEUE_READ_OPERATION = Object.freeze({
  name: 'speaker.profile.review_queue.read', version: 1
});

export interface SpeakerProfileReviewQueueReadSource {
  readReviewQueue(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): SpeakerProfileReviewQueueDto;
}

const ref = (key: string): VersionedDefinitionRef => Object.freeze({ key, version: 1 });
const canonical = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: speakerProfileReviewQueueSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const refs = Object.freeze({
  autonomy: ref('autonomy.speaker.profile-review-queue.read'),
  context: ref('context.speaker.profile-review-queue.read'),
  capability: ref('capability.speaker.profile-review-queue.read'),
  handler: ref('handler.speaker.profile-review-queue.read'),
  canonical: createSafeSchemaManifestRef(
    'schema.speaker.profile-review-queue-read.canonical-result', canonical
  ),
  projection: ref('projection.speaker.profile-review-queue-read.operator'),
  trace: ref('trace.speaker.profile-review-queue.read'),
  recordProfile: ref('record-profile.speaker.profile-review-queue.read-trace'),
  nullDetail: createSafeSchemaManifestRef(
    'schema.speaker.profile-review-queue-read.null-detail', z.null()
  )
});

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

export function createSpeakerProfileReviewQueueReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: EngagementCurrentEventSource;
  readonly profiles: SpeakerProfileReviewQueueReadSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== ENGAGEMENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== ENGAGEMENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('speaker_profile_review_queue_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: SPEAKER_PROFILE_REVIEW_QUEUE_READ_OPERATION,
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
    operation: SPEAKER_PROFILE_REVIEW_QUEUE_READ_OPERATION,
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
  return Object.freeze({
    id: 'speaker.profile-review-queue.read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        {
          reference: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewQueueRead.inputSchema,
          schema: speakerProfileReviewQueueReadInputSchema
        },
        { reference: refs.canonical, schema: canonical },
        {
          reference: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewQueueRead.resultSchema,
          schema: speakerProfileReviewQueueReadResultSchema
        },
        { reference: refs.nullDetail, schema: z.null() }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([{
        reference: refs.capability,
        openSnapshot: (invocation: ReadInvocationContext) => invocation.scope.eventId === undefined
          ? Object.freeze({ kind: 'event_required' as const })
          : Object.freeze({
              kind: 'scope' as const,
              scope: Object.freeze({
                workspaceId: invocation.scope.workspaceId,
                eventId: invocation.scope.eventId
              })
            })
      } satisfies ReadCapabilityRegistration]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: refs.canonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          speakerProfileReviewQueueReadInputSchema.parse(businessInput);
          if (snapshot.kind === 'event_required') {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'speaker.profile.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          return Object.freeze({
            kind: 'success' as const,
            data: speakerProfileReviewQueueSchema.parse(
              input.profiles.readReviewQueue(
                snapshot.scope as { readonly workspaceId: string; readonly eventId: string }
              )
            )
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewQueueRead.resultSchema,
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
        ...SPEAKER_PROFILE_REVIEW_QUEUE_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the current profile-review policy and event speaker profiles.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewQueueRead.inputSchema,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          ...CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
            class: 'access_denied' as const,
            kind: `authority.${reason}`,
            retryable: false,
            detailSchema: refs.nullDetail
          })),
          {
            class: 'conflict' as const,
            kind: 'speaker.profile.event_required',
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
          path: '/api/events/current/speakers/profile-review',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
