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
  speakerProfileReadInputSchema,
  speakerProfileReadResultSchema,
  speakerProfileViewSchema,
  structuredOutcomeSchema,
  type SpeakerProfileViewDto,
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

export const SPEAKER_PROFILE_READ_OPERATION = Object.freeze({
  name: 'speaker.profile.read', version: 1
});

export interface SpeakerProfileReadSource {
  hasEventPersonRelationship(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
  }): boolean;
  readSpeakerProfileView(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
  }): SpeakerProfileViewDto;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}
function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

const canonical = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: speakerProfileViewSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const refs = Object.freeze({
  autonomy: ref('autonomy.speaker.profile.read'),
  context: ref('context.speaker.profile.read'),
  capability: ref('capability.speaker.profile.read'),
  handler: ref('handler.speaker.profile.read'),
  canonical: createSafeSchemaManifestRef('schema.speaker.profile-read.canonical-result', canonical),
  projection: ref('projection.speaker.profile-read.operator'),
  trace: ref('trace.speaker.profile.read'),
  recordProfile: ref('record-profile.speaker.profile.read-trace'),
  nullDetail: createSafeSchemaManifestRef('schema.speaker.profile-read.null-detail', z.null())
});

export function createSpeakerProfileReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: EngagementCurrentEventSource;
  readonly profiles: SpeakerProfileReadSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== ENGAGEMENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== ENGAGEMENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('speaker_profile_read_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: SPEAKER_PROFILE_READ_OPERATION,
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
    operation: SPEAKER_PROFILE_READ_OPERATION,
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
    id: 'speaker.profile.read-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.read.inputSchema,
          schema: speakerProfileReadInputSchema },
        { reference: refs.canonical, schema: canonical },
        { reference: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.read.resultSchema,
          schema: speakerProfileReadResultSchema },
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
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          if (snapshot.kind === 'event_required') {
            return Object.freeze({ kind: 'outcome' as const, outcome: Object.freeze({
              class: 'conflict' as const, kind: 'speaker.profile.event_required',
              retryable: false, subjects: [], detail: null, detailSchemaVersion: 1
            }) });
          }
          const request = speakerProfileReadInputSchema.parse(businessInput);
          const scope = snapshot.scope as { readonly workspaceId: string; readonly eventId: string };
          const exact = { ...scope, personId: request.personId };
          if (!input.profiles.hasEventPersonRelationship(exact)) {
            return Object.freeze({ kind: 'outcome' as const, outcome: Object.freeze({
              class: 'conflict' as const, kind: 'speaker.profile.person_out_of_scope',
              retryable: false, subjects: [], detail: null, detailSchemaVersion: 1
            }) });
          }
          return Object.freeze({
            kind: 'success' as const,
            data: speakerProfileViewSchema.parse(input.profiles.readSpeakerProfileView(exact))
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.read.resultSchema,
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
        ...SPEAKER_PROFILE_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read one exact Person profile and its current event approvals.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.read.inputSchema,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'speaker.profile.event_required',
            retryable: false, detailSchema: refs.nullDetail },
          { class: 'conflict' as const, kind: 'speaker.profile.person_out_of_scope',
            retryable: false, detailSchema: refs.nullDetail }
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
          path: '/api/events/current/speakers/profile',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
