import {
  createReadInvocationContextBuilder,
  createOperationAutonomyPolicy,
  type EffectInvocationContext,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  currentEventSettingsCanonicalResultSchema,
  currentEventSettingsReadInputSchema,
  currentEventSettingsReadResultSchema,
  EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
  eventSettingsEventRequiredOutcomeSchema,
  eventSettingsSchema,
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
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { EVENT_READ_ACCESS_POLICY } from './module';

export const EVENT_SETTINGS_CURRENT_READ_OPERATION = Object.freeze({
  name: 'event.settings.current.read', version: 1
});

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const nullDetailSchema = z.null();

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

function workspaceScopeResolver(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

const refs = Object.freeze({
  context: ref('context.event.settings.current-read'),
  autonomy: ref('autonomy.event.settings.current-read'),
  capability: ref('capability.event.settings.current-read'),
  handler: ref('handler.event.settings.current-read'),
  projection: ref('projection.event.settings.current-read.operator'),
  trace: ref('trace.event.settings.current-read'),
  recordProfile: ref('record-profile.event.settings.read-trace')
});

const schemas = Object.freeze({
  input: EVENT_SETTINGS_OPERATION_SCHEMA_REFS.currentRead.inputSchema,
  canonical: schemaRef(
    'schema.event-settings.current-read.canonical-result',
    currentEventSettingsCanonicalResultSchema
  ),
  projected: EVENT_SETTINGS_OPERATION_SCHEMA_REFS.currentRead.resultSchema,
  nullDetail: schemaRef('schema.event-settings.current-read.null-detail', nullDetailSchema)
});

export interface EventSettingsCurrentReadPort {
  readCurrent(workspaceId: WorkspaceId):
    | z.infer<typeof eventSettingsSchema>
    | undefined
    | Promise<z.infer<typeof eventSettingsSchema> | undefined>;
}

export interface EventSettingsOperationIds {
  newInvocationId(): InvocationId;
}

export interface CreateEventSettingsReadOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentSettingsRead: EventSettingsCurrentReadPort;
  readonly clock: Clock;
  readonly ids: EventSettingsOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}

export function createEventSettingsReadOperationModule(
  input: CreateEventSettingsReadOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== EVENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== EVENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('event_settings_read_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: EVENT_SETTINGS_CURRENT_READ_OPERATION,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
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
  const context = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: EVENT_SETTINGS_CURRENT_READ_OPERATION,
    effect: 'read',
    lanes: [lane],
    scopeResolver: workspaceScopeResolver(workspaceId),
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
    openSnapshot: async (readContext: EffectInvocationContext) => Object.freeze({
      current: await input.currentSettingsRead.readCurrent(readContext.scope.workspaceId)
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  return Object.freeze({
    id: 'event-settings-read.operation',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([]),
      effectPhases: Object.freeze([]),
      terminalizationResolvers: Object.freeze([]),
      riskResolvers: Object.freeze([]),
      autonomyEvidenceResolvers: Object.freeze([]),
      renewedApprovalResolvers: Object.freeze([]),
      autonomyPreflights: Object.freeze([]),
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: currentEventSettingsReadInputSchema },
        { reference: schemas.canonical, schema: currentEventSettingsCanonicalResultSchema },
        { reference: schemas.projected, schema: currentEventSettingsReadResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([capability]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) =>
          snapshot.current === undefined
            ? {
                kind: 'outcome' as const,
                outcome: eventSettingsEventRequiredOutcomeSchema.parse({
                  class: 'conflict',
                  kind: 'event.settings.event_required',
                  retryable: false,
                  subjects: [],
                  detail: null,
                  detailSchemaVersion: 1
                })
              }
            : { kind: 'success' as const, data: eventSettingsSchema.parse(snapshot.current) }
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => currentEventSettingsCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.recordProfile
      }]),
      operationAuditTargets: Object.freeze([]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.recordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...EVENT_SETTINGS_CURRENT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read settings for the selected Event.',
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
            kind: 'event.settings.event_required',
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
          path: '/api/events/current/settings',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }]),
      effectContextBuilders: Object.freeze([]),
      effectHandlers: Object.freeze([]),
      effectOperations: Object.freeze([])
    })
  });
}
