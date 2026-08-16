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
  type OperationRegistryModule,
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
  DECISION_DECIDE_ROWS_MAX,
  DECISION_OPERATION_SCHEMA_REFS,
  decisionAuthorInputSchema,
  decisionDecideCanonicalResultSchema,
  decisionDecideDataSchema,
  decisionDecideOperationResultSchema,
  decisionMutationPlanSchema,
  decisionTargetUnavailableDetailSchema
} from '@jooevents/contracts';
import { DECISION_PLANNING_ERROR_CODES } from '@jooevents/decision';
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
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  currentEventScopeResolver,
  type DecisionCurrentEventSource,
  type DecisionOperationIds
} from './module';
import { createDecisionDirectHandler } from './preparation';

export const DECISION_DECIDE_OPERATION = Object.freeze({ name: 'decision.decide', version: 1 });

export const DECISION_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.decision.manage', version: parseContractVersion(1)
});
export const DECISION_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';
export const DECISION_REQUEST_HASH_PROFILE = ref('request-hash.decision.decide');
export const DECISION_DIRECT_HANDLER_CAPABILITY = ref('capability.decision.decide');
const nullDetailSchema = z.null();

export const decisionDirectCanonicalResultSchema = decisionDecideCanonicalResultSchema;
export const decisionStaleDetailSchema = z.strictObject({
  code: z.enum(DECISION_PLANNING_ERROR_CODES),
  submissionId: z.uuid()
});
export { decisionDecideDataSchema, decisionDecideOperationResultSchema };

export const decisionDirectDomainContributionSchema = z.strictObject({
  kind: z.literal('decision_direct'),
  plan: decisionMutationPlanSchema
});

export const decisionDirectStaleDetailSchema = decisionStaleDetailSchema;
export const decisionDirectTargetUnavailableDetailSchema = decisionTargetUnavailableDetailSchema;

const directSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: decisionDecideDataSchema }),
  domain: decisionDirectDomainContributionSchema,
  effectContributions: z.tuple([])
});

const directOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'decision.changed'
    ? decisionDirectStaleDetailSchema
    : outcome.kind === 'decision.target_unavailable'
      ? decisionDirectTargetUnavailableDetailSchema
      : nullDetailSchema;
  const allowed = new Set([
    'conflict:decision.event_required',
    'stale_revision:decision.changed',
    'conflict:decision.target_unavailable',
  ]);
  const expectedDetailSchemaVersion = outcome.kind === 'decision.changed' ? 2 : 1;
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== expectedDetailSchemaVersion
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Decision direct refusal is invalid.' });
  }
});

export const decisionDirectContributionSchema = z.union([
  directSuccessContributionSchema,
  directOutcomeContributionSchema
]);

export type DecisionDirectContribution = z.infer<typeof decisionDirectContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType, version = 1): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, version);
}

const schemas = Object.freeze({
  input: DECISION_OPERATION_SCHEMA_REFS.decide.inputSchema,
  contribution: schemaRef('schema.decision.decide.contribution', decisionDirectContributionSchema, 2),
  canonical: schemaRef('schema.decision.decide.canonical-result', decisionDirectCanonicalResultSchema, 2),
  projected: DECISION_OPERATION_SCHEMA_REFS.decide.resultSchema,
  nullDetail: schemaRef('schema.decision.decide.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.decision.changed.detail', decisionDirectStaleDetailSchema, 2),
  targetDetail: schemaRef(
    'schema.decision.target-unavailable.detail',
    decisionDirectTargetUnavailableDetailSchema
  )
});

const refs = Object.freeze({
  context: ref('context.decision.decide'),
  autonomy: ref('autonomy.decision.decide'),
  concurrency: ref('concurrency.decision.decide'),
  family: ref('decision.decide.execution-family'),
  phase: ref('decision.decide.phase.single-uow'),
  terminalization: ref('decision.decide.terminalization'),
  risk: ref('decision.decide.risk-resolver'),
  autonomyEvidence: ref('decision.decide.autonomy-evidence'),
  approval: ref('decision.decide.approval-resolver'),
  preflight: ref('decision.decide.autonomy-preflight'),
  handler: ref('handler.decision.decide'),
  projection: ref('projection.decision.decide.operator'),
  audit: ref('audit.decision.decide'),
  auditRecordProfile: ref('record-profile.decision.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

export interface CreateDecisionDirectOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: DecisionCurrentEventSource;
  readonly clock: Clock;
  readonly ids: DecisionOperationIds;
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

export function createDecisionDirectOperationModule(
  input: CreateDecisionDirectOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== DECISION_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== DECISION_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('decision_direct_operation_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: DECISION_DECIDE_OPERATION,
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
    operation: DECISION_DECIDE_OPERATION,
    effect: 'commit',
    lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: DECISION_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.family, phase: refs.phase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: DECISION_DECIDE_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: DECISION_DECIDE_OPERATION,
    effect: 'commit',
    handler: refs.handler,
    handlerCapability: DECISION_DIRECT_HANDLER_CAPABILITY,
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
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk,
    operation: DECISION_DECIDE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['decision-recorded']),
      evidenceIds: Object.freeze(['decision.decide.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: DECISION_DECIDE_OPERATION,
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
          key: 'decision.decide.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: DECISION_DECIDE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: DECISION_DECIDE_OPERATION,
    policy: refs.autonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.autonomyEvidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  const handler = createDecisionDirectHandler({
    reference: refs.handler,
    handlerCapability: DECISION_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'decision-decide.operation',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([family]),
      effectPhases: Object.freeze([phase]),
      terminalizationResolvers: Object.freeze([terminalization]),
      riskResolvers: Object.freeze([risk]),
      autonomyEvidenceResolvers: Object.freeze([autonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([approval]),
      autonomyPreflights: Object.freeze([preflight]),
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: decisionAuthorInputSchema },
        { reference: schemas.contribution, schema: decisionDirectContributionSchema },
        { reference: schemas.canonical, schema: decisionDirectCanonicalResultSchema },
        { reference: schemas.projected, schema: decisionDecideOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: decisionDirectStaleDetailSchema },
        { reference: schemas.targetDetail, schema: decisionDirectTargetUnavailableDetailSchema }
      ]),
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      operations: Object.freeze([]),
      readOperationalTraceTargets: Object.freeze([]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => decisionDirectCanonicalResultSchema.parse(candidate)
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      effectContextBuilders: Object.freeze([context]),
      effectHandlers: Object.freeze([handler]),
      effectOperations: Object.freeze([{
        ...DECISION_DECIDE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Record submission decisions.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['decision-recorded'],
        agentAction: { eligible: true as const, displayLabel: 'Record submission decisions', consequences: ['Submission decision state may change.'], externalEffect: 'none' as const },
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
            class: 'conflict' as const,
            kind: 'decision.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'decision.changed',
            retryable: false,
            detailSchema: schemas.staleDetail
          },
          {
            class: 'conflict' as const,
            kind: 'decision.target_unavailable',
            retryable: false,
            detailSchema: schemas.targetDetail
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
        handlerCapability: DECISION_DIRECT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: DECISION_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.family,
          phase: refs.phase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight,
          history: { summariesByAction: Object.freeze({ decide: 'Recorded submission decisions' }) }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/decisions',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
