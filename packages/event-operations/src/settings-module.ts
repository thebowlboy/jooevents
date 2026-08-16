import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  eventSettingsUpdateCanonicalResultSchema,
  eventSettingsUpdateInputSchema,
  eventSettingsUpdateOperationResultSchema,
  EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
  structuredOutcomeSchema,
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
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { EVENT_MANAGE_ACCESS_POLICY } from './module';
import {
  createEventSettingsDirectUpdateHandler,
  eventSettingsDirectUpdateContributionSchema
} from './settings-direct-preparation';

export {
  createEventSettingsReadOperationModule,
  EVENT_SETTINGS_CURRENT_READ_OPERATION,
  type CreateEventSettingsReadOperationModuleInput,
  type EventSettingsCurrentReadPort,
  type EventSettingsOperationIds
} from './settings-read-module';

export const EVENT_SETTINGS_UPDATE_OPERATION = Object.freeze({
  name: 'event.settings.update',
  version: 1
});
export const EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE =
  ref('request-hash.event.settings.update');
export const EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY = ref(
  'capability.event.settings.direct_update'
);

const nullDetailSchema = z.null();
const staleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'current_event_missing', 'selection_changed', 'stale_event_set',
    'stale_event', 'settings_changed', 'no_changes', 'invalid_plan'
  ]),
  action: z.literal('update'),
  eventId: z.uuid()
});

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: EVENT_SETTINGS_OPERATION_SCHEMA_REFS.update.inputSchema,
  contribution: schemaRef(
    'schema.event-settings.update.contribution',
    eventSettingsDirectUpdateContributionSchema
  ),
  canonical: schemaRef(
    'schema.event-settings.update.canonical-result',
    eventSettingsUpdateCanonicalResultSchema
  ),
  projected: EVENT_SETTINGS_OPERATION_SCHEMA_REFS.update.resultSchema,
  nullDetail: schemaRef('schema.event-settings.update.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.event-settings.update.stale-detail', staleDetailSchema)
});

const refs = Object.freeze({
  context: ref('context.event.settings.update'),
  autonomy: ref('autonomy.event.settings.update'),
  handler: ref('handler.event.settings.update'),
  projection: ref('projection.event.settings.update.operator'),
  audit: ref('audit.event.settings.update'),
  auditRecordProfile: ref('record-profile.event.settings.operation-log'),
  keySource: ref('idempotency.operator-header'),
  requestHash: EVENT_SETTINGS_UPDATE_REQUEST_HASH_PROFILE,
  concurrency: ref('concurrency.event.settings.workspace-event-set'),
  executionFamily: ref('event.settings.update.execution-family'),
  executionPhase: ref('event.settings.update.phase.direct-uow'),
  terminalization: ref('event.settings.update.terminalization'),
  riskResolver: ref('event.settings.update.risk-resolver'),
  autonomyEvidence: ref('event.settings.update.autonomy-evidence'),
  approvalResolver: ref('event.settings.update.approval-resolver'),
  autonomyPreflight: ref('event.settings.update.autonomy-preflight')
});

export interface EventSettingsUpdateOperationIds {
  newInvocationId(): InvocationId;
}

export interface CreateEventSettingsUpdateOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: EventSettingsUpdateOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

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

function eventScopeResolver(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: ({ businessInput }: Parameters<InvocationScopeResolver['resolve']>[0]) => {
      const request = eventSettingsUpdateInputSchema.parse(businessInput);
      const eventId = parseEventId(request.expectedEventId);
      return Object.freeze({
        workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: Object.freeze(['workspace.current', `event:${eventId}`])
      });
    }
  });
}

export function createEventSettingsUpdateOperationModule(
  input: CreateEventSettingsUpdateOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== EVENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('event_settings_update_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
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
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    effect: 'commit',
    lanes: [lane],
    scopeResolver: eventScopeResolver(workspaceId),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: refs.requestHash,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.executionFamily,
    phase: refs.executionPhase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    phase: refs.executionPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.executionPhase,
    family: refs.executionFamily,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    effect: 'commit',
    handler: refs.handler,
    handlerCapability: EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const,
      kind: 'operation.in_progress',
      retryable: true,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
  const riskResolver = createOperationRiskResolverRegistration({
    reference: refs.riskResolver,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['event-settings-updated']),
      evidenceIds: Object.freeze(['event.settings.update.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString());
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]),
        maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt,
        hardBounds: bounds,
        unattendedBounds: bounds,
        spendMicros: 0,
        actionCount: 1,
        completesBy: subject.evaluatedAt,
        proposedAction: Object.freeze({
          key: 'event.settings.update.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approvalResolver = createRenewedApprovalResolverRegistration({
    reference: refs.approvalResolver,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const autonomyPreflight = createAutonomyPreflightRegistration({
    reference: refs.autonomyPreflight,
    operation: EVENT_SETTINGS_UPDATE_OPERATION,
    policy: refs.autonomy,
    riskResolver: refs.riskResolver,
    evidenceResolver: refs.autonomyEvidence,
    approvalResolver: refs.approvalResolver,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  const handler = createEventSettingsDirectUpdateHandler({
    reference: refs.handler,
    handlerCapability: EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'event-settings-update.operation',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([family]),
      effectPhases: Object.freeze([phase]),
      terminalizationResolvers: Object.freeze([terminalization]),
      riskResolvers: Object.freeze([riskResolver]),
      autonomyEvidenceResolvers: Object.freeze([autonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([approvalResolver]),
      autonomyPreflights: Object.freeze([autonomyPreflight]),
      autonomyPolicies: Object.freeze([autonomy]),
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      operations: Object.freeze([]),
      readOperationalTraceTargets: Object.freeze([]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: eventSettingsUpdateInputSchema },
        { reference: schemas.contribution, schema: eventSettingsDirectUpdateContributionSchema },
        { reference: schemas.canonical, schema: eventSettingsUpdateCanonicalResultSchema },
        { reference: schemas.projected, schema: eventSettingsUpdateOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: staleDetailSchema }
      ]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => eventSettingsUpdateCanonicalResultSchema.parse(candidate)
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 16_384
      }]),
      effectContextBuilders: Object.freeze([context]),
      effectHandlers: Object.freeze([handler]),
      effectOperations: Object.freeze([{
        ...EVENT_SETTINGS_UPDATE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Update the selected Event settings.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['event-settings-updated'],
        agentAction: {
          eligible: true as const,
          displayLabel: 'Update event settings',
          consequences: ['The event name, dates, or timezone may change.'],
          externalEffect: 'none' as const
        },
        inputSchema: schemas.input,
        contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          ...accessOutcomes,
          {
            class: 'stale_revision' as const,
            kind: 'event.settings_changed',
            retryable: false,
            detailSchema: schemas.staleDetail
          },
          {
            class: 'conflict' as const,
            kind: 'event.settings.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: schemas.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.context,
        handlerCapability: EVENT_SETTINGS_UPDATE_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: refs.requestHash
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.executionFamily,
          phase: refs.executionPhase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.autonomyPreflight,
          history: { summary: 'Updated event settings' }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/settings',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
