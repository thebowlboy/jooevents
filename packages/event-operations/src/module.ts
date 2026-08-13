import { createHash } from 'node:crypto';
import {
  createEffectInvocationContextBuilder,
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createEffectfulOperationResultSchema,
  createSafeSchemaManifestRef,
  currentEventProjectionSchema,
  currentEventReadInputSchema,
  currentEventReadResultSchema,
  EVENT_OPERATION_SCHEMA_REFS,
  eventCreateInputSchema,
  eventCreateOperationResultSchema,
  eventCreateResultSchema,
  eventCreateSafeDiffSchema,
  structuredOutcomeSchema,
  type CurrentEventProjection,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  diffEventCreatePlan,
  eventCreatePlanDigest,
  eventCreateResult,
  parseEventCreatePlan,
  type EventCreatePlan
} from '@jooevents/event';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  encodeCanonicalJson,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type Clock,
  type EventId,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createEventCreateHandler } from './preparation';

export const EVENT_CURRENT_READ_OPERATION = Object.freeze({ name: 'event.current.read', version: 1 });
export const EVENT_CREATE_OPERATION = Object.freeze({ name: 'event.create', version: 1 });
export const EVENT_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.event.read', version: parseContractVersion(1)
});
export const EVENT_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.event.manage', version: parseContractVersion(1)
});
export const EVENT_CREATE_REQUEST_HASH_PROFILE = ref('request-hash.event.create');

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

const nullDetailSchema = z.null();
const canonicalReadResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: currentEventProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const canonicalCreateResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: eventCreateResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

const eventCreatePlanSchema = z.custom<EventCreatePlan>(
  (value) => {
    try { parseEventCreatePlan(value); return true; } catch { return false; }
  },
  { message: 'invalid_event_create_plan' }
);

export const eventCreateDomainContributionSchema = z.strictObject({
  kind: z.literal('event_create'),
  preparationHandle: z.string().trim().min(1).max(256),
  planDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const eventCreateEvidenceChildSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('domain_fact'),
    factId: z.uuid(),
    factKind: z.literal('event_created'),
    factVersion: z.literal(1),
    eventId: z.uuid(),
    sourcePlan: eventCreatePlanSchema,
    safeDiff: eventCreateSafeDiffSchema
  }),
  z.strictObject({
    kind: z.literal('outbox_pointer'),
    pointerId: z.uuid(),
    sourceKind: z.literal('domain_fact'),
    factId: z.uuid()
  }),
  z.strictObject({
    kind: z.literal('timeline'),
    timelineId: z.uuid(),
    sourceKind: z.literal('domain_fact'),
    factId: z.uuid(),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true })
  })
]);

const eventCreateSuccessContributionSchema = z.strictObject({
  result: canonicalCreateResultSchema,
  domain: eventCreateDomainContributionSchema,
  receiptChildren: z.tuple([
    eventCreateEvidenceChildSchema.options[0],
    eventCreateEvidenceChildSchema.options[1],
    eventCreateEvidenceChildSchema.options[2]
  ])
}).superRefine((contribution, context) => {
  if (contribution.result.kind !== 'success') {
    context.addIssue({ code: 'custom', message: 'Event create contribution must succeed.' });
    return;
  }
  const [fact, pointer, timeline] = contribution.receiptChildren;
  let sourcePlan: EventCreatePlan;
  try { sourcePlan = parseEventCreatePlan(fact.sourcePlan); } catch {
    context.addIssue({ code: 'custom', message: 'Invalid source Event create plan.', path: ['receiptChildren', 0, 'sourcePlan'] });
    return;
  }
  if (
    contribution.domain.planDigestSha256 !== eventCreatePlanDigest(sourcePlan)
    || canonicalDigest(contribution.result.data) !== canonicalDigest(eventCreateResult(sourcePlan))
    || canonicalDigest(fact.safeDiff) !== canonicalDigest(diffEventCreatePlan(sourcePlan))
    || fact.eventId !== sourcePlan.after.id
    || pointer.factId !== fact.factId
    || timeline.factId !== fact.factId
    || timeline.eventId !== sourcePlan.after.id
    || timeline.workspaceId !== sourcePlan.workspaceId
    || timeline.occurredAt !== sourcePlan.after.createdAt
  ) context.addIssue({ code: 'custom', message: 'Event create evidence is incoherent.' });
});

const eventCreateOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const key = `${contribution.result.outcome.class}:${contribution.result.outcome.kind}`;
  if (![
    'stale_revision:event.event_set_changed',
    'conflict:event.already_selected'
  ].includes(key) || contribution.result.outcome.retryable !== false
    || contribution.result.outcome.detail !== null
    || contribution.result.outcome.detailSchemaVersion !== 1) {
    context.addIssue({ code: 'custom', message: 'Event create outcome is not a domain refusal.' });
  }
});

export const eventCreateContributionSchema = z.union([
  eventCreateSuccessContributionSchema,
  eventCreateOutcomeContributionSchema
]);

export type EventCreateContribution = z.infer<typeof eventCreateContributionSchema>;

const schemas = {
  readInput: EVENT_OPERATION_SCHEMA_REFS.currentRead.inputSchema,
  readCanonical: schemaRef('schema.event.current-read.canonical-result', canonicalReadResultSchema),
  readProjected: EVENT_OPERATION_SCHEMA_REFS.currentRead.resultSchema,
  createInput: EVENT_OPERATION_SCHEMA_REFS.create.inputSchema,
  createContribution: schemaRef('schema.event.create.contribution', eventCreateContributionSchema),
  createCanonical: schemaRef('schema.event.create.canonical-result', canonicalCreateResultSchema),
  createProjected: EVENT_OPERATION_SCHEMA_REFS.create.resultSchema,
  nullDetail: schemaRef('schema.event.operation.null-detail', nullDetailSchema)
} as const;

export const EVENT_CREATE_HANDLER_CAPABILITY = ref('capability.event.create');

const refs = {
  readContext: ref('context.event.current-read'),
  readAutonomy: ref('autonomy.event.current-read'),
  readCapability: ref('capability.event.current-read'),
  readHandler: ref('handler.event.current-read'),
  readProjection: ref('projection.event.current-read.operator'),
  readTrace: ref('trace.event.current-read'),
  createContext: ref('context.event.create'),
  createAutonomy: ref('autonomy.event.create'),
  createHandler: ref('handler.event.create'),
  createProjection: ref('projection.event.create.operator'),
  createAudit: ref('audit.event.create'),
  auditRecordProfile: ref('record-profile.event.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: EVENT_CREATE_REQUEST_HASH_PROFILE,
  concurrency: ref('concurrency.event.workspace-event-set'),
  executionFamily: ref('event.create.execution-family'),
  executionPhase: ref('event.create.phase.single-uow'),
  terminalization: ref('event.create.terminalization'),
  riskResolver: ref('event.create.risk-resolver'),
  autonomyEvidence: ref('event.create.autonomy-evidence'),
  approvalResolver: ref('event.create.approval-resolver'),
  autonomyPreflight: ref('event.create.autonomy-preflight')
} as const;

export interface CurrentEventReadPort {
  readCurrent(workspaceId: WorkspaceId): CurrentEventProjection | Promise<CurrentEventProjection>;
}

export interface EventOperationIds {
  newInvocationId(): InvocationId;
}

export interface EventOperationPolicies {
  readonly read: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
}

export interface CreateEventOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: EventOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEventRead: CurrentEventReadPort;
  readonly clock: Clock;
  readonly ids: EventOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
  /** Defaults true for compatibility; ordinary composition sets false and mounts create-draft. */
  readonly mountLegacyDirectCreate?: boolean;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
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

function operationAutonomy(operation: typeof EVENT_CURRENT_READ_OPERATION | typeof EVENT_CREATE_OPERATION) {
  return createOperationAutonomyPolicy({
    definition: operation.name === EVENT_CREATE_OPERATION.name ? refs.createAutonomy : refs.readAutonomy,
    operation,
    riskFloor: operation.name === EVENT_CREATE_OPERATION.name ? 'normal' : 'low',
    unattendedRiskCeiling: operation.name === EVENT_CREATE_OPERATION.name ? 'normal' : 'low',
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
}

export function createEventOperationModule(input: CreateEventOperationModuleInput): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (
    input.policies.read.key !== EVENT_READ_ACCESS_POLICY.key
    || input.policies.read.version !== EVENT_READ_ACCESS_POLICY.version
    || input.policies.manage.key !== EVENT_MANAGE_ACCESS_POLICY.key
    || input.policies.manage.version !== EVENT_MANAGE_ACCESS_POLICY.version
  ) throw new TypeError('event_operation_policy_catalog_mismatch');
  const scopeResolver = workspaceScopeResolver(workspaceId);
  const mountLegacyDirectCreate = input.mountLegacyDirectCreate !== false;
  const readLane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policies.read });
  const manageLane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policies.manage });
  const readAutonomy = operationAutonomy(EVENT_CURRENT_READ_OPERATION);
  const createAutonomy = operationAutonomy(EVENT_CREATE_OPERATION);
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext, operation: EVENT_CURRENT_READ_OPERATION, effect: 'read', lanes: [readLane],
    scopeResolver, authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const createContext = createEffectInvocationContextBuilder({
    reference: refs.createContext, operation: EVENT_CREATE_OPERATION, effect: 'commit', lanes: [manageLane],
    scopeResolver, authorityResolver: input.currentAuthority, clock: input.clock,
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
  const contentionOutcome = Object.freeze({
    class: 'conflict' as const,
    kind: 'operation.in_progress',
    retryable: true,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
  const executionFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.executionFamily,
    phase: refs.executionPhase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: EVENT_CREATE_OPERATION,
    phase: refs.executionPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const executionPhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.executionPhase,
    family: refs.executionFamily,
    operation: EVENT_CREATE_OPERATION,
    effect: 'commit',
    handler: refs.createHandler,
    handlerCapability: EVENT_CREATE_HANDLER_CAPABILITY,
    contributionSchema: schemas.createContribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome
  });
  const riskResolver = createOperationRiskResolverRegistration({
    reference: refs.riskResolver,
    operation: EVENT_CREATE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'normal' as const,
      consequenceTags: Object.freeze(['event-created']),
      evidenceIds: Object.freeze(['event.create.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: EVENT_CREATE_OPERATION,
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
          key: 'event.create.execute', version: 1, digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approvalResolver = createRenewedApprovalResolverRegistration({
    reference: refs.approvalResolver,
    operation: EVENT_CREATE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const autonomyPreflight = createAutonomyPreflightRegistration({
    reference: refs.autonomyPreflight,
    operation: EVENT_CREATE_OPERATION,
    policy: refs.createAutonomy,
    riskResolver: refs.riskResolver,
    evidenceResolver: refs.autonomyEvidence,
    approvalResolver: refs.approvalResolver,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const execution = Object.freeze({
    kind: 'single_unit_of_work' as const,
    family: refs.executionFamily,
    phase: refs.executionPhase,
    terminalization: refs.terminalization,
    autonomyPreflight: refs.autonomyPreflight
  });
  const readCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.readCapability,
    openSnapshot: async (context: EffectInvocationContext) => Object.freeze({
      current: await input.currentEventRead.readCurrent(context.scope.workspaceId)
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: schemas.nullDetail
  }));

  return Object.freeze({
    id: 'event.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(mountLegacyDirectCreate ? [executionFamily] : []),
      effectPhases: Object.freeze(mountLegacyDirectCreate ? [executionPhase] : []),
      terminalizationResolvers: Object.freeze(mountLegacyDirectCreate ? [terminalization] : []),
      riskResolvers: Object.freeze(mountLegacyDirectCreate ? [riskResolver] : []),
      autonomyEvidenceResolvers: Object.freeze(mountLegacyDirectCreate ? [autonomyEvidence] : []),
      renewedApprovalResolvers: Object.freeze(mountLegacyDirectCreate ? [approvalResolver] : []),
      autonomyPreflights: Object.freeze(mountLegacyDirectCreate ? [autonomyPreflight] : []),
      autonomyPolicies: Object.freeze([
        readAutonomy,
        ...(mountLegacyDirectCreate ? [createAutonomy] : [])
      ]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: currentEventReadInputSchema },
        { reference: schemas.readCanonical, schema: canonicalReadResultSchema },
        { reference: schemas.readProjected, schema: currentEventReadResultSchema },
        ...(mountLegacyDirectCreate ? [
          { reference: schemas.createInput, schema: eventCreateInputSchema },
          { reference: schemas.createContribution, schema: eventCreateContributionSchema },
          { reference: schemas.createCanonical, schema: canonicalCreateResultSchema },
          { reference: schemas.createProjected, schema: eventCreateOperationResultSchema }
        ] : []),
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: refs.readHandler, readCapability: refs.readCapability,
        canonicalResultSchema: schemas.readCanonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => ({
          kind: 'success', data: currentEventProjectionSchema.parse(snapshot.current)
        })
      }]),
      projections: Object.freeze([{
        reference: refs.readProjection, canonicalResultSchema: schemas.readCanonical,
        projectedResultSchema: schemas.readProjected,
        project: (candidate: unknown) => canonicalReadResultSchema.parse(candidate)
      }, ...(mountLegacyDirectCreate ? [{
        reference: refs.createProjection, canonicalResultSchema: schemas.createCanonical,
        projectedResultSchema: schemas.createProjected,
        project: (candidate: unknown) => canonicalCreateResultSchema.parse(candidate)
      }] : [])]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.readTrace, kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditTargets: Object.freeze(mountLegacyDirectCreate ? [{
        reference: refs.createAudit, kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }] : []),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile, kind: 'canonical_json' as const, maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...EVENT_CURRENT_READ_OPERATION, lifecycle: { status: 'active' as const },
        summary: 'Read the current Event for the active workspace.', effect: 'read' as const,
        maxRisk: 'low' as const, autonomyPolicy: refs.readAutonomy, consequenceTags: [],
        inputSchema: schemas.readInput, canonicalResultSchema: schemas.readCanonical,
        outcomes: accessOutcomes, accessLanes: [readLane], contextBuilder: refs.readContext,
        readCapability: refs.readCapability, handler: refs.readHandler,
        observability: { trace: { mode: 'required' as const, target: refs.readTrace }, immutableAudit: { mode: 'none' as const } },
        bindings: [{ surface: 'operator_http' as const, method: 'GET' as const, path: '/api/events/current', input: 'query' as const, browserResumption: { kind: 'none' as const }, projection: refs.readProjection }]
      }]),
      effectContextBuilders: Object.freeze(mountLegacyDirectCreate ? [createContext] : []),
      effectHandlers: Object.freeze(mountLegacyDirectCreate ? [createEventCreateHandler({
        reference: refs.createHandler, handlerCapability: EVENT_CREATE_HANDLER_CAPABILITY,
        contributionSchema: schemas.createContribution, canonicalResultSchema: schemas.createCanonical
      })] : []),
      effectOperations: Object.freeze(mountLegacyDirectCreate ? [{
        ...EVENT_CREATE_OPERATION, lifecycle: { status: 'active' as const },
        summary: 'Create and select the first Event in the active workspace.', effect: 'commit' as const,
        maxRisk: 'normal' as const, autonomyPolicy: refs.createAutonomy, consequenceTags: ['event-created'],
        inputSchema: schemas.createInput, contributionSchema: schemas.createContribution,
        canonicalResultSchema: schemas.createCanonical,
        outcomes: [{ class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.nullDetail }, ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'event.event_set_changed', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'event.already_selected', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)],
        accessLanes: [manageLane], contextBuilder: refs.createContext,
        handlerCapability: EVENT_CREATE_HANDLER_CAPABILITY, handler: refs.createHandler,
        audit: { mode: 'required' as const, target: refs.createAudit },
        idempotency: { keySource: refs.keySource, credentialVerifierProfile: input.idempotencyCredentialProfile, requestHashProfile: refs.requestHash },
        concurrency: refs.concurrency, execution,
        bindings: [{ surface: 'operator_http' as const, method: 'POST' as const, path: '/api/events', input: 'body' as const, browserResumption: { kind: 'none' as const }, projection: refs.createProjection }]
      }] : [])
    })
  });
}
