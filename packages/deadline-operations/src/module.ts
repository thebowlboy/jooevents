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
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  DEADLINE_OPERATION_SCHEMA_REFS,
  activeDeadlineHeadSchema,
  deadlineCatalogSnapshotSchema,
  deadlineChangeInputSchema,
  deadlineChangeCanonicalResultSchema,
  deadlineChangeDataSchema,
  deadlineChangeOperationResultSchema,
  deadlineGetProjectionSchema,
  deadlineGetReadInputSchema,
  deadlineGetReadResultSchema,
  deadlineListReadInputSchema,
  deadlineListReadResultSchema,
  deadlineMutationPlanSchema,
  deadlineVersionSchema
} from '@jooevents/contracts/deadlines';
import type { DeadlineRepository } from '@jooevents/deadline';
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
  isApplicationId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createDeadlineDirectHandler } from './preparation';

export const DEADLINE_CATALOG_READ_OPERATION = Object.freeze({
  name: 'deadline.catalog.read', version: 1
});
export const DEADLINE_CURRENT_READ_OPERATION = Object.freeze({
  name: 'deadline.current.read', version: 1
});
export const DEADLINE_CHANGE_OPERATION = Object.freeze({
  name: 'deadline.change', version: 1
});

export const DEADLINE_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.deadline.read', version: parseContractVersion(1)
});
export const DEADLINE_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.deadline.manage', version: parseContractVersion(1)
});
// V1 treats Deadline configuration as Event operating detail; no preset is silently widened.
export const DEADLINE_READ_PERMISSION_ID: PermissionId = 'event.read';
export const DEADLINE_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';
export const DEADLINE_CHANGE_REQUEST_HASH_PROFILE = ref('request-hash.deadline.change');
export const DEADLINE_CHANGE_HANDLER_CAPABILITY = ref(
  'capability.deadline.change-direct'
);
const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const nullDetailSchema = z.null();

export const deadlineCatalogCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: deadlineCatalogSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const deadlineCurrentCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: deadlineGetProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const deadlineChangeStaleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'deadline_exists', 'deadline_missing',
    'stale_deadline', 'deadline_cleared', 'deadline_unchanged',
    'event_time_unavailable', 'event_time_changed', 'invalid_display_date',
    'invalid_event_timezone', 'boundary_nonexistent', 'boundary_ambiguous',
    'invalid_plan'
  ]),
  action: z.enum(['create', 'update', 'clear']),
  deadlineId: applicationIdSchema
});

const directSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: deadlineChangeDataSchema }),
  domain: z.strictObject({
    kind: z.literal('deadline_direct_change'),
    plan: deadlineMutationPlanSchema
  }),
  effectContributions: z.tuple([])
});

const directOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const allowed = new Set([
    'conflict:deadline.event_required',
    'conflict:deadline.no_change',
    'stale_revision:deadline.canonical_changed',
  ]);
  const detailSchema = outcome.kind === 'deadline.canonical_changed'
    ? deadlineChangeStaleDetailSchema
    : nullDetailSchema;
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Deadline direct refusal is invalid.' });
  }
});

export const deadlineDirectContributionSchema = z.union([
  directSuccessContributionSchema,
  directOutcomeContributionSchema
]);
export type DeadlineDirectContribution = z.infer<typeof deadlineDirectContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

export const DEADLINE_OPERATION_RUNTIME_SCHEMA_REFS = Object.freeze({
  catalogInput: DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.inputSchema,
  catalogCanonical: schemaRef(
    'schema.deadline.catalog-read.canonical-result', deadlineCatalogCanonicalResultSchema
  ),
  catalogProjected: DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.resultSchema,
  currentInput: DEADLINE_OPERATION_SCHEMA_REFS.currentRead.inputSchema,
  currentCanonical: schemaRef(
    'schema.deadline.current-read.canonical-result', deadlineCurrentCanonicalResultSchema
  ),
  currentProjected: DEADLINE_OPERATION_SCHEMA_REFS.currentRead.resultSchema,
  changeInput: DEADLINE_OPERATION_SCHEMA_REFS.change.inputSchema,
  changeContribution: schemaRef(
    'schema.deadline.change.contribution', deadlineDirectContributionSchema
  ),
  changeCanonical: schemaRef(
    'schema.deadline.change.canonical-result', deadlineChangeCanonicalResultSchema
  ),
  changeProjected: DEADLINE_OPERATION_SCHEMA_REFS.change.resultSchema,
  staleDetail: schemaRef(
    'schema.deadline.canonical-changed.detail', deadlineChangeStaleDetailSchema
  ),
  nullDetail: schemaRef('schema.deadline.operation.null-detail', nullDetailSchema)
});

const schemas = DEADLINE_OPERATION_RUNTIME_SCHEMA_REFS;
const refs = Object.freeze({
  catalogContext: ref('context.deadline.catalog-read'),
  catalogAutonomy: ref('autonomy.deadline.catalog-read'),
  catalogCapability: ref('capability.deadline.catalog-read'),
  catalogHandler: ref('handler.deadline.catalog-read'),
  catalogProjection: ref('projection.deadline.catalog-read.operator'),
  catalogTrace: ref('trace.deadline.catalog-read'),
  currentContext: ref('context.deadline.current-read'),
  currentAutonomy: ref('autonomy.deadline.current-read'),
  currentCapability: ref('capability.deadline.current-read'),
  currentHandler: ref('handler.deadline.current-read'),
  currentProjection: ref('projection.deadline.current-read.operator'),
  currentTrace: ref('trace.deadline.current-read'),
  changeContext: ref('context.deadline.change'),
  changeAutonomy: ref('autonomy.deadline.change'),
  changeConcurrency: ref('concurrency.deadline.change'),
  changeFamily: ref('deadline.change.execution-family'),
  changePhase: ref('deadline.change.phase.direct-uow'),
  changeTerminalization: ref('deadline.change.terminalization'),
  changeRisk: ref('deadline.change.risk-resolver'),
  changeAutonomyEvidence: ref('deadline.change.autonomy-evidence'),
  changeApproval: ref('deadline.change.approval-resolver'),
  changePreflight: ref('deadline.change.autonomy-preflight'),
  changeHandler: ref('handler.deadline.change'),
  changeProjection: ref('projection.deadline.change.operator'),
  audit: ref('audit.deadline.change'),
  auditRecordProfile: ref('record-profile.deadline.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

export interface DeadlineCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface DeadlineCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    DeadlineCurrentEventResolution | Promise<DeadlineCurrentEventResolution>;
}

export interface DeadlineOperationPolicies {
  readonly read: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
}

export interface CreateDeadlineOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: DeadlineOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: DeadlineCurrentEventSource;
  readonly deadlineRead: Pick<DeadlineRepository, 'readDeadlineCatalog'>;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function eventRequiredOutcome(): StructuredOutcome {
  return Object.freeze({
    class: 'conflict', kind: 'deadline.event_required', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: DeadlineCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
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

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.trim() !== value) {
      throw new TypeError('deadline_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort());
}

function autonomy(operation: { readonly name: string; readonly version: number }, definition: VersionedDefinitionRef) {
  return createOperationAutonomyPolicy({
    definition,
    operation,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
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

export function createDeadlineOperationModule(
  input: CreateDeadlineOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.read.key !== DEADLINE_READ_ACCESS_POLICY.key
      || input.policies.read.version !== DEADLINE_READ_ACCESS_POLICY.version
      || input.policies.manage.key !== DEADLINE_MANAGE_ACCESS_POLICY.key
      || input.policies.manage.version !== DEADLINE_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('deadline_operation_policy_catalog_mismatch');
  }
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const readLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.read
  });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.manage
  });
  const catalogAutonomy = autonomy(DEADLINE_CATALOG_READ_OPERATION, refs.catalogAutonomy);
  const currentAutonomy = autonomy(DEADLINE_CURRENT_READ_OPERATION, refs.currentAutonomy);
  const changeAutonomy = autonomy(DEADLINE_CHANGE_OPERATION, refs.changeAutonomy);

  const catalogContext = createReadInvocationContextBuilder({
    reference: refs.catalogContext,
    operation: DEADLINE_CATALOG_READ_OPERATION,
    effect: 'read', lanes: [readLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const currentContext = createReadInvocationContextBuilder({
    reference: refs.currentContext,
    operation: DEADLINE_CURRENT_READ_OPERATION,
    effect: 'read', lanes: [readLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const openDeadlineSnapshot = (context: ReadInvocationContext) => {
    if (context.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
    const catalog = input.deadlineRead.readDeadlineCatalog({
      workspaceId: context.scope.workspaceId,
      eventId: context.scope.eventId
    });
    if (!catalog) throw new TypeError('deadline_current_event_catalog_missing');
    if (catalog.scope.workspaceId !== context.scope.workspaceId
        || catalog.scope.eventId !== context.scope.eventId) {
      throw new TypeError('deadline_current_event_catalog_scope_mismatch');
    }
    return Object.freeze({ kind: 'catalog', catalog });
  };
  const catalogCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.catalogCapability,
    openSnapshot: openDeadlineSnapshot
  });
  const currentCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.currentCapability,
    openSnapshot: openDeadlineSnapshot
  });

  const changeContext = createEffectInvocationContextBuilder({
    reference: refs.changeContext,
    operation: DEADLINE_CHANGE_OPERATION,
    effect: 'commit', lanes: [manageLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: DEADLINE_CHANGE_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const changeFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.changeFamily, phase: refs.changePhase
  });
  const changeTerminalization = createTerminalizationResolverRegistration({
    reference: refs.changeTerminalization,
    operation: DEADLINE_CHANGE_OPERATION,
    phase: refs.changePhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const changePhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.changePhase,
    family: refs.changeFamily,
    operation: DEADLINE_CHANGE_OPERATION,
    effect: 'commit',
    handler: refs.changeHandler,
    handlerCapability: DEADLINE_CHANGE_HANDLER_CAPABILITY,
    contributionSchema: schemas.changeContribution,
    terminalization: refs.changeTerminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const changeRisk = createOperationRiskResolverRegistration({
    reference: refs.changeRisk,
    operation: DEADLINE_CHANGE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['deadline-changed']),
      evidenceIds: Object.freeze(['deadline.change.risk'])
    })
  });
  const changeAutonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.changeAutonomyEvidence,
    operation: DEADLINE_CHANGE_OPERATION,
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
          key: 'deadline.change.execute', version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const changeApproval = createRenewedApprovalResolverRegistration({
    reference: refs.changeApproval,
    operation: DEADLINE_CHANGE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const changePreflight = createAutonomyPreflightRegistration({
    reference: refs.changePreflight,
    operation: DEADLINE_CHANGE_OPERATION,
    policy: refs.changeAutonomy,
    riskResolver: refs.changeRisk,
    evidenceResolver: refs.changeAutonomyEvidence,
    approvalResolver: refs.changeApproval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const changeHandler = createDeadlineDirectHandler({
    reference: refs.changeHandler,
    handlerCapability: DEADLINE_CHANGE_HANDLER_CAPABILITY,
    contributionSchema: schemas.changeContribution,
    canonicalResultSchema: schemas.changeCanonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));

  return Object.freeze({
    id: 'deadline.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([changeFamily]),
      effectPhases: Object.freeze([changePhase]),
      terminalizationResolvers: Object.freeze([changeTerminalization]),
      riskResolvers: Object.freeze([changeRisk]),
      autonomyEvidenceResolvers: Object.freeze([changeAutonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([changeApproval]),
      autonomyPreflights: Object.freeze([changePreflight]),
      autonomyPolicies: Object.freeze([catalogAutonomy, currentAutonomy, changeAutonomy]),
      schemas: Object.freeze([
        { reference: schemas.catalogInput, schema: deadlineListReadInputSchema },
        { reference: schemas.catalogCanonical, schema: deadlineCatalogCanonicalResultSchema },
        { reference: schemas.catalogProjected, schema: deadlineListReadResultSchema },
        { reference: schemas.currentInput, schema: deadlineGetReadInputSchema },
        { reference: schemas.currentCanonical, schema: deadlineCurrentCanonicalResultSchema },
        { reference: schemas.currentProjected, schema: deadlineGetReadResultSchema },
        { reference: schemas.changeInput, schema: deadlineChangeInputSchema },
        { reference: schemas.changeContribution, schema: deadlineDirectContributionSchema },
        { reference: schemas.changeCanonical, schema: deadlineChangeCanonicalResultSchema },
        { reference: schemas.changeProjected, schema: deadlineChangeOperationResultSchema },
        { reference: schemas.staleDetail, schema: deadlineChangeStaleDetailSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([catalogContext, currentContext]),
      readCapabilities: Object.freeze([catalogCapability, currentCapability]),
      handlers: Object.freeze([{
        reference: refs.catalogHandler,
        readCapability: refs.catalogCapability,
        canonicalResultSchema: schemas.catalogCanonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) =>
          snapshot.kind === 'event_required'
            ? Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() })
            : Object.freeze({
                kind: 'success' as const,
                data: deadlineCatalogSnapshotSchema.parse(snapshot.catalog)
              })
      }, {
        reference: refs.currentHandler,
        readCapability: refs.currentCapability,
        canonicalResultSchema: schemas.currentCanonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          if (snapshot.kind === 'event_required') {
            return Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() });
          }
          const query = deadlineGetReadInputSchema.parse(businessInput);
          const catalog = deadlineCatalogSnapshotSchema.parse(snapshot.catalog);
          const deadline = catalog.deadlines.find((candidate) =>
            candidate.id === query.deadlineId && candidate.status === 'active'
          );
          return Object.freeze({
            kind: 'success' as const,
            data: deadlineGetProjectionSchema.parse({
              schemaVersion: 1,
              deadline: deadline ? activeDeadlineHeadSchema.parse(deadline) : null
            })
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.catalogProjection,
        canonicalResultSchema: schemas.catalogCanonical,
        projectedResultSchema: schemas.catalogProjected,
        project: (candidate: unknown) => deadlineCatalogCanonicalResultSchema.parse(candidate)
      }, {
        reference: refs.currentProjection,
        canonicalResultSchema: schemas.currentCanonical,
        projectedResultSchema: schemas.currentProjected,
        project: (candidate: unknown) => deadlineCurrentCanonicalResultSchema.parse(candidate)
      }, {
        reference: refs.changeProjection,
        canonicalResultSchema: schemas.changeCanonical,
        projectedResultSchema: schemas.changeProjected,
        project: (candidate: unknown) => deadlineChangeCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.catalogTrace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecordProfile
      }, {
        reference: refs.currentTrace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecordProfile
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
      operations: Object.freeze([
        readOperation({
          operation: DEADLINE_CATALOG_READ_OPERATION,
          summary: 'List canonical Deadline heads for the current Event.',
          autonomyPolicy: refs.catalogAutonomy,
          inputSchema: schemas.catalogInput,
          canonicalResultSchema: schemas.catalogCanonical,
          contextBuilder: refs.catalogContext,
          readCapability: refs.catalogCapability,
          handler: refs.catalogHandler,
          trace: refs.catalogTrace,
          projection: refs.catalogProjection,
          path: '/api/events/current/deadlines',
          accessLane: readLane,
          accessOutcomes
        }),
        readOperation({
          operation: DEADLINE_CURRENT_READ_OPERATION,
          summary: 'Resolve one active canonical Deadline in the current Event.',
          autonomyPolicy: refs.currentAutonomy,
          inputSchema: schemas.currentInput,
          canonicalResultSchema: schemas.currentCanonical,
          contextBuilder: refs.currentContext,
          readCapability: refs.currentCapability,
          handler: refs.currentHandler,
          trace: refs.currentTrace,
          projection: refs.currentProjection,
          path: '/api/events/current/deadlines/current',
          accessLane: readLane,
          accessOutcomes
        })
      ]),
      effectContextBuilders: Object.freeze([changeContext]),
      effectHandlers: Object.freeze([changeHandler]),
      effectOperations: Object.freeze([{
        ...DEADLINE_CHANGE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Change one canonical Deadline.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.changeAutonomy,
        consequenceTags: ['deadline-changed'],
        agentAction: {
          eligible: true as const,
          displayLabel: 'Change a deadline',
          consequences: ['A deadline may be created, updated, or cleared.'],
          externalEffect: 'none' as const
        },
        inputSchema: schemas.changeInput,
        contributionSchema: schemas.changeContribution,
        canonicalResultSchema: schemas.changeCanonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed', retryable: false,
            detailSchema: schemas.nullDetail
          },
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'deadline.event_required', retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'deadline.no_change', retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'deadline.canonical_changed', retryable: false,
            detailSchema: schemas.staleDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress', retryable: true,
            detailSchema: schemas.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [manageLane],
        contextBuilder: refs.changeContext,
        handlerCapability: DEADLINE_CHANGE_HANDLER_CAPABILITY,
        handler: refs.changeHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: DEADLINE_CHANGE_REQUEST_HASH_PROFILE
        },
        concurrency: refs.changeConcurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.changeFamily,
          phase: refs.changePhase,
          terminalization: refs.changeTerminalization,
          autonomyPreflight: refs.changePreflight,
          history: {
            summariesByAction: Object.freeze({
              create: 'Created a deadline',
              update: 'Updated a deadline',
              clear: 'Cleared a deadline'
            })
          }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/deadlines',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.changeProjection
        }]
      }])
    })
  });
}

function readOperation(input: {
  readonly operation: { readonly name: string; readonly version: number };
  readonly summary: string;
  readonly autonomyPolicy: VersionedDefinitionRef;
  readonly inputSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
  readonly contextBuilder: VersionedDefinitionRef;
  readonly readCapability: VersionedDefinitionRef;
  readonly handler: VersionedDefinitionRef;
  readonly trace: VersionedDefinitionRef;
  readonly projection: VersionedDefinitionRef;
  readonly path: string;
  readonly accessLane: ReturnType<typeof parseOperationAccessLane>;
  readonly accessOutcomes: readonly {
    readonly class: 'access_denied'; readonly kind: string; readonly retryable: false;
    readonly detailSchema: SafeSchemaManifestRef;
  }[];
}) {
  return Object.freeze({
    ...input.operation,
    lifecycle: { status: 'active' as const },
    summary: input.summary,
    effect: 'read' as const,
    maxRisk: 'low' as const,
    autonomyPolicy: input.autonomyPolicy,
    consequenceTags: [],
    inputSchema: input.inputSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    outcomes: [
      ...input.accessOutcomes,
      {
        class: 'conflict' as const,
        kind: 'deadline.event_required', retryable: false,
        detailSchema: schemas.nullDetail
      }
    ],
    accessLanes: [input.accessLane],
    contextBuilder: input.contextBuilder,
    readCapability: input.readCapability,
    handler: input.handler,
    observability: {
      trace: { mode: 'required' as const, target: input.trace },
      immutableAudit: { mode: 'none' as const }
    },
    bindings: [{
      surface: 'operator_http' as const,
      method: 'GET' as const,
      path: input.path,
      input: 'query' as const,
      browserResumption: { kind: 'none' as const },
      projection: input.projection
    }]
  });
}
