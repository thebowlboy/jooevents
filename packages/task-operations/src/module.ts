import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
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
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  TASK_OPERATION_SCHEMA_REFS,
  taskBoardReadInputSchema,
  taskBoardReadResultSchema,
  taskBoardSnapshotSchema,
  taskMutationCanonicalResultSchema,
  taskMutationDataSchema,
  taskMutationOperationResultSchema,
  taskMutationInputSchema,
  taskAssignmentRestorePlanSchema,
  taskMutationPlanSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type TaskBoardSnapshotDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { EVENT_READ_ACCESS_POLICY } from '@jooevents/event-operations';
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
import { parseContractVersion, parseEventId } from '@jooevents/kernel';
import { z } from 'zod';
import { createTaskDirectHandler } from './preparation';

export const TASK_BOARD_READ_OPERATION = Object.freeze({ name: 'task.board.read', version: 1 });
export const TASK_MUTATION_OPERATION = Object.freeze({ name: 'task.mutation', version: 1 });
export const TASK_BOARD_READ_PATH = '/api/events/current/tasks';
export const TASK_MUTATION_PATH = '/api/events/current/tasks';
export const TASK_MUTATION_HANDLER_CAPABILITY = ref('capability.task.direct-mutation');
export const TASK_MUTATION_REQUEST_HASH_PROFILE = ref('request-hash.task.mutation');
export const TASK_READ_PERMISSION_ID = 'speaker.directory.read' as const;
export const TASK_MANAGE_PERMISSION_ID = 'event.manage' as const;
export const TASK_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.task.read', version: parseContractVersion(1)
});
export const TASK_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.task.manage', version: parseContractVersion(1)
});
const nullSchema = z.null();
const staleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'definition_exists', 'assignment_missing',
    'stale_assignment', 'invalid_transition', 'membership_changed',
    'deadline_changed', 'invalid_plan'
  ]),
  action: z.enum(['create_definition', 'waive_assignment', 'accept_fulfillment', 'restore_assignment']),
  subjectId: z.string().min(1).max(512)
});
export const taskDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: taskMutationDataSchema }),
    domain: z.strictObject({
      kind: z.literal('task_direct_mutation'),
      plan: z.union([taskMutationPlanSchema, taskAssignmentRestorePlanSchema])
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);
export type TaskDirectContribution = z.infer<typeof taskDirectContributionSchema>;
function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}
function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}
export interface TaskCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): { readonly eventId?: string; readonly evidenceIds: readonly string[] }
    | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}
function eventScope(workspaceId: WorkspaceId, source: TaskCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await source.resolveCurrentEvent(workspaceId);
      if (resolved.eventId === undefined) return Object.freeze({
        workspaceId, subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: Object.freeze([...resolved.evidenceIds])
      });
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({ workspaceId, eventId, subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }
      ]), resolutionEvidenceIds: Object.freeze([...resolved.evidenceIds]) });
    }
  });
}
function autonomy(
  definition: VersionedDefinitionRef,
  operation: { readonly name: string; readonly version: number }
) {
  return createOperationAutonomyPolicy({
    definition, operation,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan',
      'compensate', 'block', 'attention'
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

export interface TaskOperationIds { newInvocationId(): InvocationId; }
export interface TaskBoardReadSource {
  readCurrent(workspaceId: WorkspaceId): TaskBoardSnapshotDto | undefined
    | Promise<TaskBoardSnapshotDto | undefined>;
}
export interface SharedTaskOperationInput {
  readonly workspaceId: WorkspaceId;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: TaskOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly currentEvent: TaskCurrentEventSource;
}

export function createTaskBoardReadOperationModule(input: SharedTaskOperationInput & {
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly tasks: TaskBoardReadSource;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== EVENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== EVENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('task_read_policy_catalog_mismatch');
  }
  const refs = {
    context: ref('context.task.board-read'), autonomy: ref('autonomy.task.board-read'),
    capability: ref('capability.task.board-read'), handler: ref('handler.task.board-read'),
    projection: ref('projection.task.board-read.operator'), trace: ref('trace.task.board-read'),
    record: ref('record-profile.task.board-read')
  };
  const schemas = {
    input: TASK_OPERATION_SCHEMA_REFS.boardRead.inputSchema,
    canonical: schemaRef('schema.task.board-read.canonical-result', z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('success'), data: taskBoardSnapshotSchema }),
      z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
    ])),
    projected: TASK_OPERATION_SCHEMA_REFS.boardRead.resultSchema,
    null: schemaRef('schema.task.board-read.null-detail', nullSchema)
  };
  const canonical = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('success'), data: taskBoardSnapshotSchema }),
    z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
  ]);
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.readPolicy
  });
  const policy = autonomy(refs.autonomy, TASK_BOARD_READ_OPERATION);
  const context = createReadInvocationContextBuilder({
    reference: refs.context, operation: TASK_BOARD_READ_OPERATION, effect: 'read', lanes: [lane],
    scopeResolver: eventScope(workspaceId, input.currentEvent), authorityResolver: input.currentAuthority,
    clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.capability,
    openSnapshot: async (context: EffectInvocationContext) => Object.freeze({
      board: await input.tasks.readCurrent(context.scope.workspaceId)
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'task-board-read.operation',
    source: Object.freeze({
      effectExecutionFamilies: [], effectPhases: [], terminalizationResolvers: [],
      riskResolvers: [], autonomyEvidenceResolvers: [], renewedApprovalResolvers: [],
      autonomyPreflights: [], autonomyPolicies: [policy],
      schemas: [
        { reference: schemas.input, schema: taskBoardReadInputSchema },
        { reference: schemas.canonical, schema: canonical },
        { reference: schemas.projected, schema: taskBoardReadResultSchema },
        { reference: schemas.null, schema: nullSchema }
      ],
      contextBuilders: [context], readCapabilities: [capability],
      handlers: [{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          taskBoardReadInputSchema.parse(businessInput);
          return snapshot.board === undefined
            ? {
                kind: 'outcome' as const,
                outcome: {
                  class: 'conflict' as const, kind: 'task.event_required', retryable: false,
                  subjects: [], detail: null, detailSchemaVersion: 1
                }
              }
            : { kind: 'success' as const, data: taskBoardSnapshotSchema.parse(snapshot.board) };
        }
      }],
      projections: [{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => canonical.parse(candidate)
      }],
      readOperationalTraceTargets: [{
        reference: refs.trace, kind: 'read_operational_trace_record' as const,
        recordProfile: refs.record
      }],
      operationAuditTargets: [],
      operationAuditRecordProfiles: [{
        reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      operations: [{
        ...TASK_BOARD_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read canonical task definitions and materialized assignments for the current event.',
        effect: 'read' as const, maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy, consequenceTags: [],
        inputSchema: schemas.input, canonicalResultSchema: schemas.canonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'task.event_required', retryable: false, detailSchema: schemas.null }
        ],
        accessLanes: [lane], contextBuilder: refs.context,
        readCapability: refs.capability, handler: refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'GET' as const,
          path: TASK_BOARD_READ_PATH, input: 'query' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.projection
        }]
      }],
      effectContextBuilders: [], effectHandlers: [], effectOperations: []
    })
  });
}

export function createTaskMutationOperationModule(input: SharedTaskOperationInput & {
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== TASK_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== TASK_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('task_mutation_policy_catalog_mismatch');
  }
  const refs = {
    context: ref('context.task.mutation'), autonomy: ref('autonomy.task.mutation'),
    handler: ref('handler.task.mutation'), projection: ref('projection.task.mutation.operator'),
    audit: ref('audit.task.mutation'), record: ref('record-profile.task.operation-audit'),
    keySource: ref('idempotency.operator-header'), concurrency: ref('concurrency.task.mutation'),
    family: ref('task.mutation.execution-family'), phase: ref('task.mutation.phase.direct-uow'),
    terminalization: ref('task.mutation.terminalization'), risk: ref('task.mutation.risk'),
    evidence: ref('task.mutation.autonomy-evidence'), approval: ref('task.mutation.approval'),
    preflight: ref('task.mutation.autonomy-preflight')
  };
  const schemas = {
    input: TASK_OPERATION_SCHEMA_REFS.mutation.inputSchema,
    contribution: schemaRef('schema.task.mutation.contribution', taskDirectContributionSchema),
    canonical: schemaRef('schema.task.mutation.canonical-result', taskMutationCanonicalResultSchema),
    projected: TASK_OPERATION_SCHEMA_REFS.mutation.resultSchema,
    null: schemaRef('schema.task.mutation.null-detail', nullSchema),
    stale: schemaRef('schema.task.mutation.stale-detail', staleDetailSchema)
  };
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const policy = autonomy(refs.autonomy, TASK_MUTATION_OPERATION);
  const context = createEffectInvocationContextBuilder({
    reference: refs.context, operation: TASK_MUTATION_OPERATION, effect: 'commit', lanes: [lane],
    scopeResolver: eventScope(workspaceId, input.currentEvent), authorityResolver: input.currentAuthority,
    clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: TASK_MUTATION_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization, operation: TASK_MUTATION_OPERATION, phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase, family: refs.family, operation: TASK_MUTATION_OPERATION,
    effect: 'commit', handler: refs.handler, handlerCapability: TASK_MUTATION_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution, terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk, operation: TASK_MUTATION_OPERATION,
    resolve: () => ({ risk: 'low', consequenceTags: ['task-mutated'], evidenceIds: ['task.mutation.risk'] })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence, operation: TASK_MUTATION_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: { key: 'task.mutation.execute', version: 1, digestSha256: subject.requestHashSha256 },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval, operation: TASK_MUTATION_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight, operation: TASK_MUTATION_OPERATION,
    policy: refs.autonomy, riskResolver: refs.risk, evidenceResolver: refs.evidence,
    approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createTaskDirectHandler({
    reference: refs.handler,
    handlerCapability: TASK_MUTATION_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'task-mutation.operation',
    source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase],
      terminalizationResolvers: [terminalization], riskResolvers: [risk],
      autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [policy],
      contextBuilders: [], readCapabilities: [], handlers: [], operations: [],
      readOperationalTraceTargets: [],
      schemas: [
        { reference: schemas.input, schema: taskMutationInputSchema },
        { reference: schemas.contribution, schema: taskDirectContributionSchema },
        { reference: schemas.canonical, schema: taskMutationCanonicalResultSchema },
        { reference: schemas.projected, schema: taskMutationOperationResultSchema },
        { reference: schemas.null, schema: nullSchema },
        { reference: schemas.stale, schema: staleDetailSchema }
      ],
      projections: [{
        reference: refs.projection, canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => taskMutationCanonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: refs.audit, kind: 'operation_audit_record' as const, recordProfile: refs.record
      }],
      operationAuditRecordProfiles: [{
        reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      effectContextBuilders: [context], effectHandlers: [handler],
      effectOperations: [{
        ...TASK_MUTATION_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Create or change a speaker task.',
        effect: 'commit' as const, maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy, consequenceTags: ['task-mutated'],
        agentAction: {
          eligible: true as const,
          displayLabel: 'Change speaker tasks',
          consequences: ['Speaker task responsibilities or completion state may change.'],
          externalEffect: 'none' as const
        },
        inputSchema: schemas.input, contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.null },
          ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'task.changed', retryable: false, detailSchema: schemas.stale },
          { class: 'conflict' as const, kind: 'task.event_required', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.null },
          ...autonomyInterventionOutcomeDeclarations(schemas.null)
        ],
        accessLanes: [lane], contextBuilder: refs.context,
        handlerCapability: TASK_MUTATION_HANDLER_CAPABILITY, handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: TASK_MUTATION_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const,
          family: refs.family, phase: refs.phase,
          terminalization: refs.terminalization, autonomyPreflight: refs.preflight,
          history: {
            summariesByAction: Object.freeze({
              create_definition: 'Created speaker tasks',
              waive_assignment: 'Waived a speaker task',
              accept_fulfillment: "Accepted a speaker's completed task",
              restore_assignment: 'Restored a speaker task'
            })
          }
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const,
          path: TASK_MUTATION_PATH, input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.projection
        }]
      }]
    })
  });
}
