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
  taskDraftCanonicalResultSchema,
  taskDraftDataSchema,
  taskDraftOperationResultSchema,
  taskMutationDraftInputSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type TaskBoardSnapshotDto,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { EVENT_MANAGE_ACCESS_POLICY, EVENT_READ_ACCESS_POLICY } from '@jooevents/event-operations';
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
import { createHash } from 'node:crypto';
import { encodeCanonicalJson, parseContractVersion } from '@jooevents/kernel';
import { z } from 'zod';
import { createTaskDraftHandler } from './preparation';

export const TASK_BOARD_READ_OPERATION = Object.freeze({ name: 'task.board.read', version: 1 });
export const TASK_MUTATION_DRAFT_OPERATION = Object.freeze({ name: 'task.mutation.draft', version: 1 });
export const TASK_BOARD_READ_PATH = '/api/events/current/tasks';
export const TASK_MUTATION_DRAFT_PATH = '/api/events/current/tasks/drafts';
export const TASK_DRAFT_HANDLER_CAPABILITY = ref('capability.task.changeset-draft');
export const TASK_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.task.mutation-draft');
export const TASK_READ_PERMISSION_ID = 'speaker.directory.read' as const;
export const TASK_MANAGE_PERMISSION_ID = 'event.manage' as const;
export const TASK_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.task.read', version: parseContractVersion(1)
});
export const TASK_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.task.manage', version: parseContractVersion(1)
});
export const TASK_DRAFT_APPROVAL_POLICY = (() => {
  const reference = ref('policy.task.mutation.bounded');
  const definition = Object.freeze({ reference, requirement: 'none' as const });
  return Object.freeze({
    ...definition,
    definitionDigestSha256: createHash('sha256')
      .update(encodeCanonicalJson(definition)).digest('hex')
  });
})();

const idSchema = z.uuid().refine((value) => value === value.toLowerCase());
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.iso.datetime({ offset: true });
const nullSchema = z.null();
const staleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'definition_exists', 'assignment_missing',
    'stale_assignment', 'invalid_transition', 'membership_changed',
    'deadline_changed', 'invalid_plan'
  ]),
  action: z.enum(['create_definition', 'waive_assignment', 'accept_fulfillment']),
  subjectId: z.string().min(1).max(512)
});
export const taskDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('task_changeset_draft'),
  preparationHandle: idSchema,
  workspaceId: idSchema,
  eventId: idSchema,
  changesetId: idSchema,
  revisionId: idSchema,
  revisionDigestSha256: digestSchema,
  recordDigestSha256: digestSchema,
  action: z.enum(['create_definition', 'waive_assignment', 'accept_fulfillment']),
  subjectId: idSchema,
  occurredAt: instantSchema
});
export const taskDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: idSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: idSchema,
  eventId: idSchema,
  changesetId: idSchema,
  revisionId: idSchema,
  occurredAt: instantSchema
});
export const taskDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: taskDraftDataSchema }),
    domain: taskDraftDomainContributionSchema,
    receiptChildren: z.tuple([taskDraftEvidenceChildSchema])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    receiptChildren: z.tuple([])
  })
]);
export type TaskDraftContribution = z.infer<typeof taskDraftContributionSchema>;

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
function workspaceScope(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
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
    scopeResolver: workspaceScope(workspaceId), authorityResolver: input.currentAuthority,
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

export function createTaskDraftOperationModule(input: SharedTaskOperationInput & {
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== EVENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('task_draft_policy_catalog_mismatch');
  }
  const refs = {
    context: ref('context.task.mutation-draft'), autonomy: ref('autonomy.task.mutation-draft'),
    handler: ref('handler.task.mutation-draft'), projection: ref('projection.task.mutation-draft.operator'),
    audit: ref('audit.task.mutation-draft'), record: ref('record-profile.task.operation-audit'),
    keySource: ref('idempotency.operator-header'), concurrency: ref('concurrency.task.mutation-draft'),
    family: ref('task.mutation-draft.execution-family'), phase: ref('task.mutation-draft.phase.single-uow'),
    terminalization: ref('task.mutation-draft.terminalization'), risk: ref('task.mutation-draft.risk'),
    evidence: ref('task.mutation-draft.autonomy-evidence'), approval: ref('task.mutation-draft.approval'),
    preflight: ref('task.mutation-draft.autonomy-preflight')
  };
  const schemas = {
    input: TASK_OPERATION_SCHEMA_REFS.mutationDraft.inputSchema,
    contribution: schemaRef('schema.task.mutation-draft.contribution', taskDraftContributionSchema),
    canonical: schemaRef('schema.task.mutation-draft.canonical-result', taskDraftCanonicalResultSchema),
    projected: TASK_OPERATION_SCHEMA_REFS.mutationDraft.resultSchema,
    null: schemaRef('schema.task.mutation-draft.null-detail', nullSchema),
    stale: schemaRef('schema.task.mutation-draft.stale-detail', staleDetailSchema)
  };
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const policy = autonomy(refs.autonomy, TASK_MUTATION_DRAFT_OPERATION);
  const context = createEffectInvocationContextBuilder({
    reference: refs.context, operation: TASK_MUTATION_DRAFT_OPERATION, effect: 'draft', lanes: [lane],
    scopeResolver: workspaceScope(workspaceId), authorityResolver: input.currentAuthority,
    clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: TASK_DRAFT_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization, operation: TASK_MUTATION_DRAFT_OPERATION, phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase, family: refs.family, operation: TASK_MUTATION_DRAFT_OPERATION,
    effect: 'draft', handler: refs.handler, handlerCapability: TASK_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution, terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk, operation: TASK_MUTATION_DRAFT_OPERATION,
    resolve: () => ({ risk: 'low', consequenceTags: ['changeset-drafted'], evidenceIds: ['task.mutation.draft.risk'] })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence, operation: TASK_MUTATION_DRAFT_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: { key: 'task.mutation.draft.execute', version: 1, digestSha256: subject.requestHashSha256 },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval, operation: TASK_MUTATION_DRAFT_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight, operation: TASK_MUTATION_DRAFT_OPERATION,
    policy: refs.autonomy, riskResolver: refs.risk, evidenceResolver: refs.evidence,
    approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createTaskDraftHandler({
    reference: refs.handler,
    handlerCapability: TASK_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'task-mutation-draft.operation',
    source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase],
      terminalizationResolvers: [terminalization], riskResolvers: [risk],
      autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [policy],
      contextBuilders: [], readCapabilities: [], handlers: [], operations: [],
      readOperationalTraceTargets: [],
      schemas: [
        { reference: schemas.input, schema: taskMutationDraftInputSchema },
        { reference: schemas.contribution, schema: taskDraftContributionSchema },
        { reference: schemas.canonical, schema: taskDraftCanonicalResultSchema },
        { reference: schemas.projected, schema: taskDraftOperationResultSchema },
        { reference: schemas.null, schema: nullSchema },
        { reference: schemas.stale, schema: staleDetailSchema }
      ],
      projections: [{
        reference: refs.projection, canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => taskDraftCanonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: refs.audit, kind: 'operation_audit_record' as const, recordProfile: refs.record
      }],
      operationAuditRecordProfiles: [{
        reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      effectContextBuilders: [context], effectHandlers: [handler],
      effectOperations: [{
        ...TASK_MUTATION_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one task definition or assignment transition for review.',
        effect: 'draft' as const, maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy, consequenceTags: ['changeset-drafted'],
        inputSchema: schemas.input, contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.null },
          ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'task.changed', retryable: false, detailSchema: schemas.stale },
          { class: 'conflict' as const, kind: 'task.event_required', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'changeset.id_collision', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.null },
          ...autonomyInterventionOutcomeDeclarations(schemas.null)
        ],
        accessLanes: [lane], contextBuilder: refs.context,
        handlerCapability: TASK_DRAFT_HANDLER_CAPABILITY, handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: TASK_DRAFT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const, family: refs.family, phase: refs.phase,
          terminalization: refs.terminalization, autonomyPreflight: refs.preflight
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const,
          path: TASK_MUTATION_DRAFT_PATH, input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.projection
        }]
      }]
    })
  });
}
