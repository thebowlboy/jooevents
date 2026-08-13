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
  DECISION_OPERATION_SCHEMA_REFS,
  decisionStateReadInputSchema,
  decisionStateReadResultSchema,
  decisionStateSnapshotSchema,
  type DecisionHeadDto,
  type DecisionScopeDto,
  type SubmissionSessionOriginDto
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

export const DECISION_STATE_READ_OPERATION = Object.freeze({
  name: 'decision.state.read', version: 1
});

export const DECISION_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.decision.read', version: parseContractVersion(1)
});
export const DECISION_READ_PERMISSION_ID: PermissionId = 'event.manage';

export const decisionStateCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: decisionStateSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

/** Decision heads and origin links for the requested submission-id set. */
export interface DecisionStateReadSource {
  readDecisionHead(scope: DecisionScopeDto, submissionId: string): DecisionHeadDto | undefined;
  readSubmissionSessionOrigin(
    scope: DecisionScopeDto,
    submissionId: string
  ): SubmissionSessionOriginDto | undefined;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: DECISION_OPERATION_SCHEMA_REFS.stateRead.inputSchema,
  canonical: schemaRef('schema.decision.state-read.canonical-result', decisionStateCanonicalResultSchema),
  projected: DECISION_OPERATION_SCHEMA_REFS.stateRead.resultSchema,
  nullDetail: schemaRef('schema.decision.operation.null-detail', z.null())
});

const refs = Object.freeze({
  context: ref('context.decision.state-read'),
  autonomy: ref('autonomy.decision.state-read'),
  capability: ref('capability.decision.state-read'),
  handler: ref('handler.decision.state-read'),
  projection: ref('projection.decision.state-read.operator'),
  trace: ref('trace.decision.state-read'),
  recordProfile: ref('record-profile.decision.read-operational-trace')
});

export interface DecisionOperationIds {
  newInvocationId(): InvocationId;
}

export interface DecisionCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface DecisionCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    DecisionCurrentEventResolution | Promise<DecisionCurrentEventResolution>;
}

export interface CreateDecisionOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: DecisionCurrentEventSource;
  readonly clock: Clock;
  readonly ids: DecisionOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly decisions: DecisionStateReadSource;
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
      throw new TypeError('decision_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: DecisionCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('decision_current_event_resolution_invalid');
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

export function createDecisionOperationModule(
  input: CreateDecisionOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== DECISION_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== DECISION_READ_ACCESS_POLICY.version) {
    throw new TypeError('decision_operation_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: DECISION_STATE_READ_OPERATION,
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
    operation: DECISION_STATE_READ_OPERATION,
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
    id: 'decision.operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: decisionStateReadInputSchema },
        { reference: schemas.canonical, schema: decisionStateCanonicalResultSchema },
        { reference: schemas.projected, schema: decisionStateReadResultSchema },
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
                kind: 'decision.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          const query = decisionStateReadInputSchema.parse(businessInput);
          const scope = snapshot.scope as DecisionScopeDto;
          // Undecided submissions serve a null head; absence is never a state.
          return Object.freeze({
            kind: 'success' as const,
            data: decisionStateSnapshotSchema.parse({
              schemaVersion: 1,
              rows: query.submissionIds.map((submissionId) => ({
                submissionId,
                head: input.decisions.readDecisionHead(scope, submissionId) ?? null,
                origin: input.decisions.readSubmissionSessionOrigin(scope, submissionId) ?? null
              }))
            })
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => decisionStateCanonicalResultSchema.parse(candidate)
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
        ...DECISION_STATE_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read Decision heads and Session origin links for a submission-id set.',
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
            kind: 'decision.event_required',
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
          path: '/api/events/current/decisions',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
