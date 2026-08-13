import { createHash } from 'node:crypto';
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
  decisionDecideDraftDataSchema,
  decisionDecideDraftOperationResultSchema,
  decisionTargetUnavailableDetailSchema
} from '@jooevents/contracts';
import { decisionStaleDetailSchema } from '@jooevents/decision';
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
  encodeCanonicalJson,
  isApplicationId,
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
import { createDecisionDraftHandler } from './preparation';

export const DECISION_DECIDE_DRAFT_OPERATION = Object.freeze({
  name: 'decision.decide.draft', version: 1
});

export const DECISION_DRAFT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.decision.draft', version: parseContractVersion(1)
});
export const DECISION_DRAFT_PERMISSION_ID: PermissionId = 'event.manage';
export const DECISION_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.decision.decide-draft');
export const DECISION_DRAFT_HANDLER_CAPABILITY = ref('capability.decision.decide-draft');
export const DECISION_DRAFT_APPROVAL_POLICY = (() => {
  const reference = ref('policy.decision.decide.bounded');
  const definition = Object.freeze({ reference, requirement: 'none' as const });
  return Object.freeze({
    ...definition,
    definitionDigestSha256: createHash('sha256')
      .update(encodeCanonicalJson(definition))
      .digest('hex')
  });
})();

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, 'Expected a canonical UTC instant.');
const nullDetailSchema = z.null();

export const decisionDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: decisionDecideDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export { decisionDecideDraftDataSchema, decisionDecideDraftOperationResultSchema };

export const decisionDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('decision_changeset_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: sha256Schema,
  recordDigestSha256: sha256Schema,
  action: z.literal('decide'),
  decisionCount: z.number().int().min(1).max(DECISION_DECIDE_ROWS_MAX),
  occurredAt: canonicalInstantSchema
});
export const decisionDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});

export const decisionDraftStaleDetailSchema = decisionStaleDetailSchema;
export const decisionDraftTargetUnavailableDetailSchema = decisionTargetUnavailableDetailSchema;

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: decisionDecideDraftDataSchema }),
  domain: decisionDraftDomainContributionSchema,
  receiptChildren: z.tuple([decisionDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const diff = data.safeDiff;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || diff.action !== 'decide'
      || diff.rows.length !== domain.decisionCount
      || diff.rows.some((row) => row.after === null
        || row.after.scope.workspaceId !== domain.workspaceId
        || row.after.scope.eventId !== domain.eventId)
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Decision draft evidence is incoherent.' });
  }
});

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'decision.changed'
    ? decisionDraftStaleDetailSchema
    : outcome.kind === 'decision.target_unavailable'
      ? decisionDraftTargetUnavailableDetailSchema
      : nullDetailSchema;
  const allowed = new Set([
    'conflict:decision.event_required',
    'stale_revision:decision.changed',
    'conflict:decision.target_unavailable',
    'conflict:changeset.id_collision'
  ]);
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Decision draft refusal is invalid.' });
  }
});

export const decisionDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

export type DecisionDraftContribution = z.infer<typeof decisionDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: DECISION_OPERATION_SCHEMA_REFS.decideDraft.inputSchema,
  contribution: schemaRef('schema.decision.decide-draft.contribution', decisionDraftContributionSchema),
  canonical: schemaRef('schema.decision.decide-draft.canonical-result', decisionDraftCanonicalResultSchema),
  projected: DECISION_OPERATION_SCHEMA_REFS.decideDraft.resultSchema,
  nullDetail: schemaRef('schema.decision.decide-draft.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.decision.changed.detail', decisionDraftStaleDetailSchema),
  targetDetail: schemaRef(
    'schema.decision.target-unavailable.detail',
    decisionDraftTargetUnavailableDetailSchema
  )
});

const refs = Object.freeze({
  context: ref('context.decision.decide-draft'),
  autonomy: ref('autonomy.decision.decide-draft'),
  concurrency: ref('concurrency.decision.decide-draft'),
  family: ref('decision.decide-draft.execution-family'),
  phase: ref('decision.decide-draft.phase.single-uow'),
  terminalization: ref('decision.decide-draft.terminalization'),
  risk: ref('decision.decide-draft.risk-resolver'),
  autonomyEvidence: ref('decision.decide-draft.autonomy-evidence'),
  approval: ref('decision.decide-draft.approval-resolver'),
  preflight: ref('decision.decide-draft.autonomy-preflight'),
  handler: ref('handler.decision.decide-draft'),
  projection: ref('projection.decision.decide-draft.operator'),
  audit: ref('audit.decision.decide-draft'),
  auditRecordProfile: ref('record-profile.decision.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

export interface CreateDecisionDraftOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly draftPolicy: VersionedAccessPolicyRef;
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

export function createDecisionDraftOperationModule(
  input: CreateDecisionDraftOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.draftPolicy.key !== DECISION_DRAFT_ACCESS_POLICY.key
      || input.draftPolicy.version !== DECISION_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('decision_draft_operation_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.draftPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: DECISION_DECIDE_DRAFT_OPERATION,
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
    operation: DECISION_DECIDE_DRAFT_OPERATION,
    effect: 'draft',
    lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: DECISION_DRAFT_REQUEST_HASH_PROFILE,
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
    operation: DECISION_DECIDE_DRAFT_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: DECISION_DECIDE_DRAFT_OPERATION,
    effect: 'draft',
    handler: refs.handler,
    handlerCapability: DECISION_DRAFT_HANDLER_CAPABILITY,
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
    operation: DECISION_DECIDE_DRAFT_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['decision.decide.draft.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: DECISION_DECIDE_DRAFT_OPERATION,
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
          key: 'decision.decide.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: DECISION_DECIDE_DRAFT_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: DECISION_DECIDE_DRAFT_OPERATION,
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
  const handler = createDecisionDraftHandler({
    reference: refs.handler,
    handlerCapability: DECISION_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'decision-decide-draft.operation',
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
        { reference: schemas.contribution, schema: decisionDraftContributionSchema },
        { reference: schemas.canonical, schema: decisionDraftCanonicalResultSchema },
        { reference: schemas.projected, schema: decisionDecideDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: decisionDraftStaleDetailSchema },
        { reference: schemas.targetDetail, schema: decisionDraftTargetUnavailableDetailSchema }
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
        project: (candidate: unknown) => decisionDraftCanonicalResultSchema.parse(candidate)
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
        ...DECISION_DECIDE_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one consequential decide changeset over up to one hundred submissions for review.',
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
        handlerCapability: DECISION_DRAFT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: DECISION_DRAFT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: refs.family,
          phase: refs.phase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/decisions/decide-drafts',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
