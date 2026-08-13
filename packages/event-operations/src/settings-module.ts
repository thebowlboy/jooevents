import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createReadInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type IdempotencyCredentialSealer,
  type EffectInvocationContext,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  currentEventSettingsCanonicalResultSchema,
  currentEventSettingsReadInputSchema,
  currentEventSettingsReadResultSchema,
  eventSettingsUpdateDraftCanonicalResultSchema,
  eventSettingsUpdateDraftDataSchema,
  eventSettingsUpdateDraftInputSchema,
  eventSettingsUpdateDraftOperationResultSchema,
  EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
  eventSettingsSchema,
  eventSettingsEventRequiredOutcomeSchema,
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
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { EVENT_MANAGE_ACCESS_POLICY, EVENT_READ_ACCESS_POLICY } from './module';
import { createEventSettingsUpdateDraftHandler } from './settings-preparation';

export const EVENT_SETTINGS_UPDATE_DRAFT_OPERATION = Object.freeze({
  name: 'event.settings.update.draft',
  version: 1
});
export const EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE =
  ref('request-hash.event.settings.update-draft');
export const EVENT_SETTINGS_UPDATE_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.event.settings.changeset_draft'
);
export const EVENT_SETTINGS_CURRENT_READ_OPERATION = Object.freeze({
  name: 'event.settings.current.read', version: 1
});

const canonicalApplicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: 'Application IDs must use canonical lowercase bytes.' }
);

export const eventSettingsUpdateDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('event_settings_changeset_draft'),
  preparationHandle: canonicalApplicationIdSchema,
  action: z.literal('update'),
  workspaceId: canonicalApplicationIdSchema,
  eventId: canonicalApplicationIdSchema,
  changesetId: canonicalApplicationIdSchema,
  revisionId: canonicalApplicationIdSchema,
  revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recordDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.iso.datetime({ offset: true })
});

export const eventSettingsUpdateDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: canonicalApplicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: canonicalApplicationIdSchema,
  eventId: canonicalApplicationIdSchema,
  changesetId: canonicalApplicationIdSchema,
  revisionId: canonicalApplicationIdSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

const nullDetailSchema = z.null();
const staleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'current_event_missing', 'selection_changed', 'stale_event_set',
    'stale_event', 'settings_changed', 'no_changes', 'invalid_plan'
  ]),
  action: z.literal('update'),
  eventId: canonicalApplicationIdSchema
});

const successContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: eventSettingsUpdateDraftDataSchema }),
  domain: eventSettingsUpdateDraftDomainContributionSchema,
  receiptChildren: z.tuple([eventSettingsUpdateDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.safeDiff.after.eventId !== domain.eventId
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Event draft evidence is incoherent.' });
  }
});

const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const key = `${outcome.class}:${outcome.kind}`;
  const detailSchema = key === 'conflict:changeset.id_collision'
      || key === 'conflict:event.settings.event_required'
    ? nullDetailSchema
    : staleDetailSchema;
  if (![
    'stale_revision:event.settings_changed',
    'conflict:event.settings.event_required',
    'conflict:changeset.id_collision'
  ].includes(key) || outcome.retryable || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Event draft refusal is invalid.' });
  }
});

export const eventSettingsUpdateDraftContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);

export type EventSettingsUpdateDraftContribution = z.infer<typeof eventSettingsUpdateDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: EVENT_SETTINGS_OPERATION_SCHEMA_REFS.updateDraft.inputSchema,
  contribution: schemaRef(
    'schema.event-settings.update-draft.contribution',
    eventSettingsUpdateDraftContributionSchema
  ),
  canonical: schemaRef(
    'schema.event-settings.update-draft.canonical-result',
    eventSettingsUpdateDraftCanonicalResultSchema
  ),
  projected: EVENT_SETTINGS_OPERATION_SCHEMA_REFS.updateDraft.resultSchema,
  nullDetail: schemaRef('schema.event-settings.update-draft.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.event-settings.update-draft.stale-detail', staleDetailSchema)
});

const refs = Object.freeze({
  context: ref('context.event.settings.update-draft'),
  autonomy: ref('autonomy.event.settings.update-draft'),
  handler: ref('handler.event.settings.update-draft'),
  projection: ref('projection.event.settings.update-draft.operator'),
  audit: ref('audit.event.settings.update-draft'),
  auditRecordProfile: ref('record-profile.event.settings.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
  concurrency: ref('concurrency.event.settings.workspace-event-set'),
  executionFamily: ref('event.settings.update-draft.execution-family'),
  executionPhase: ref('event.settings.update-draft.phase.single-uow'),
  terminalization: ref('event.settings.update-draft.terminalization'),
  riskResolver: ref('event.settings.update-draft.risk-resolver'),
  autonomyEvidence: ref('event.settings.update-draft.autonomy-evidence'),
  approvalResolver: ref('event.settings.update-draft.approval-resolver'),
  autonomyPreflight: ref('event.settings.update-draft.autonomy-preflight')
});

export interface EventSettingsUpdateDraftOperationIds {
  newInvocationId(): InvocationId;
}

export interface CreateEventSettingsUpdateDraftOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: EventSettingsUpdateDraftOperationIds;
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

function workspaceScopeResolver(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

export function createEventSettingsUpdateDraftOperationModule(
  input: CreateEventSettingsUpdateDraftOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== EVENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('event_settings_update_draft_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
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
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
    effect: 'draft',
    lanes: [lane],
    scopeResolver: workspaceScopeResolver(workspaceId),
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
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
    phase: refs.executionPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.executionPhase,
    family: refs.executionFamily,
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
    effect: 'draft',
    handler: refs.handler,
    handlerCapability: EVENT_SETTINGS_UPDATE_DRAFT_HANDLER_CAPABILITY,
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
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['event.settings.update.draft.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(
        new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()
      );
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
          key: 'event.settings.update.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approvalResolver = createRenewedApprovalResolverRegistration({
    reference: refs.approvalResolver,
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const autonomyPreflight = createAutonomyPreflightRegistration({
    reference: refs.autonomyPreflight,
    operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
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
  const handler = createEventSettingsUpdateDraftHandler({
    reference: refs.handler,
    handlerCapability: EVENT_SETTINGS_UPDATE_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'event-settings-update-draft.operation',
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
        { reference: schemas.input, schema: eventSettingsUpdateDraftInputSchema },
        { reference: schemas.contribution, schema: eventSettingsUpdateDraftContributionSchema },
        { reference: schemas.canonical, schema: eventSettingsUpdateDraftCanonicalResultSchema },
        { reference: schemas.projected, schema: eventSettingsUpdateDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: staleDetailSchema }
      ]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => eventSettingsUpdateDraftCanonicalResultSchema.parse(candidate)
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      effectContextBuilders: Object.freeze([context]),
      effectHandlers: Object.freeze([handler]),
      effectOperations: Object.freeze([{
        ...EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft an update to the selected Event settings for review.',
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['changeset-drafted'],
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
            kind: 'changeset.id_collision',
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
        handlerCapability: EVENT_SETTINGS_UPDATE_DRAFT_HANDLER_CAPABILITY,
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
          family: refs.executionFamily,
          phase: refs.executionPhase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.autonomyPreflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/settings/drafts/update',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}

const readRefs = Object.freeze({
  context: ref('context.event.settings.current-read'),
  autonomy: ref('autonomy.event.settings.current-read'),
  capability: ref('capability.event.settings.current-read'),
  handler: ref('handler.event.settings.current-read'),
  projection: ref('projection.event.settings.current-read.operator'),
  trace: ref('trace.event.settings.current-read'),
  recordProfile: ref('record-profile.event.settings.read-trace')
});

const readSchemas = Object.freeze({
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

export interface CreateEventSettingsReadOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentSettingsRead: EventSettingsCurrentReadPort;
  readonly clock: Clock;
  readonly ids: EventSettingsUpdateDraftOperationIds;
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
    definition: readRefs.autonomy,
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
    reference: readRefs.context,
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
    reference: readRefs.capability,
    openSnapshot: async (readContext: EffectInvocationContext) => Object.freeze({
      current: await input.currentSettingsRead.readCurrent(readContext.scope.workspaceId)
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: readSchemas.nullDetail
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
        { reference: readSchemas.input, schema: currentEventSettingsReadInputSchema },
        { reference: readSchemas.canonical, schema: currentEventSettingsCanonicalResultSchema },
        { reference: readSchemas.projected, schema: currentEventSettingsReadResultSchema },
        { reference: readSchemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([capability]),
      handlers: Object.freeze([{
        reference: readRefs.handler,
        readCapability: readRefs.capability,
        canonicalResultSchema: readSchemas.canonical,
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
            : {
                kind: 'success' as const,
                data: eventSettingsSchema.parse(snapshot.current)
              }
      }]),
      projections: Object.freeze([{
        reference: readRefs.projection,
        canonicalResultSchema: readSchemas.canonical,
        projectedResultSchema: readSchemas.projected,
        project: (candidate: unknown) => currentEventSettingsCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: readRefs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: readRefs.recordProfile
      }]),
      operationAuditTargets: Object.freeze([]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: readRefs.recordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...EVENT_SETTINGS_CURRENT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read settings for the selected Event.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: readRefs.autonomy,
        consequenceTags: [],
        inputSchema: readSchemas.input,
        canonicalResultSchema: readSchemas.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'event.settings.event_required',
            retryable: false,
            detailSchema: readSchemas.nullDetail
          }
        ],
        accessLanes: [lane],
        contextBuilder: readRefs.context,
        readCapability: readRefs.capability,
        handler: readRefs.handler,
        observability: {
          trace: { mode: 'required' as const, target: readRefs.trace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: '/api/events/current/settings',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: readRefs.projection
        }]
      }]),
      effectContextBuilders: Object.freeze([]),
      effectHandlers: Object.freeze([]),
      effectOperations: Object.freeze([])
    })
  });
}
