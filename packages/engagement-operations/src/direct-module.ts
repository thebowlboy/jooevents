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
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
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
  ENGAGEMENT_OPERATION_SCHEMA_REFS,
  engagementAuthorInputSchema,
  engagementChangeCanonicalResultSchema,
  engagementChangeDataSchema,
  engagementChangeOperationResultSchema,
  engagementMutationPlanSchema,
  engagementResponseActionSchema
} from '@jooevents/contracts';
import { ENGAGEMENT_PLANNING_ERROR_CODES } from '@jooevents/engagement';
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
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  currentEventScopeResolver,
  type EngagementCurrentEventSource,
  type EngagementOperationIds
} from './module';

/**
 * The one organizer engagement mutation boundary.
 */
export const ENGAGEMENT_CHANGE_OPERATION = Object.freeze({
  name: 'engagement.change', version: 1
});

export const ENGAGEMENT_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.engagement.manage', version: parseContractVersion(1)
});
export const ENGAGEMENT_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';
export const ENGAGEMENT_REQUEST_HASH_PROFILE = ref('request-hash.engagement.change');
export const ENGAGEMENT_DIRECT_HANDLER_CAPABILITY = ref('capability.engagement.change');
const nullDetailSchema = z.null();

export const engagementDirectCanonicalResultSchema = engagementChangeCanonicalResultSchema;
export const engagementStaleDetailSchema = z.strictObject({
  code: z.enum(ENGAGEMENT_PLANNING_ERROR_CODES),
  engagementId: z.uuid()
});
export { engagementChangeDataSchema, engagementChangeOperationResultSchema };

export const engagementDirectDomainContributionSchema = z.strictObject({
  kind: z.literal('engagement_direct'),
  plan: engagementMutationPlanSchema,
  taskPlan: z.json().optional()
});

export const engagementDirectStaleDetailSchema = engagementStaleDetailSchema;

const directSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: engagementChangeDataSchema }),
  domain: engagementDirectDomainContributionSchema,
  effectContributions: z.tuple([])
});

const directOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'engagement.changed'
    ? engagementDirectStaleDetailSchema
    : nullDetailSchema;
  const allowed = new Set([
    'conflict:engagement.event_required',
    'stale_revision:engagement.changed',
  ]);
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Engagement direct refusal is invalid.' });
  }
});

export const engagementDirectContributionSchema = z.union([
  directSuccessContributionSchema,
  directOutcomeContributionSchema
]);

export type EngagementDirectContribution = z.infer<typeof engagementDirectContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: ENGAGEMENT_OPERATION_SCHEMA_REFS.change.inputSchema,
  contribution: schemaRef('schema.engagement.change.contribution', engagementDirectContributionSchema),
  canonical: schemaRef('schema.engagement.change.canonical-result', engagementDirectCanonicalResultSchema),
  projected: ENGAGEMENT_OPERATION_SCHEMA_REFS.change.resultSchema,
  nullDetail: schemaRef('schema.engagement.change.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.engagement.changed.detail', engagementDirectStaleDetailSchema)
});

const refs = Object.freeze({
  context: ref('context.engagement.change'),
  autonomy: ref('autonomy.engagement.change'),
  concurrency: ref('concurrency.engagement.change'),
  family: ref('engagement.change.execution-family'),
  phase: ref('engagement.change.phase.single-uow'),
  terminalization: ref('engagement.change.terminalization'),
  risk: ref('engagement.change.risk-resolver'),
  autonomyEvidence: ref('engagement.change.autonomy-evidence'),
  approval: ref('engagement.change.approval-resolver'),
  preflight: ref('engagement.change.autonomy-preflight'),
  handler: ref('handler.engagement.change'),
  projection: ref('projection.engagement.change.operator'),
  audit: ref('audit.engagement.change'),
  auditRecordProfile: ref('record-profile.engagement.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: EngagementDirectPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export interface EngagementDirectPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

/** Transaction-owned preparation for one direct engagement response. */
export interface EngagementDirectPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): EngagementDirectPreparedContribution;
}

export function sealEngagementDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: EngagementDirectPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('engagement_direct_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('engagement_direct_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'engagement_direct', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createEngagementDirectHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit' as const,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_engagement_direct_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('engagement_direct_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          effectContributions: [...contribution.effectContributions]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

export interface CreateEngagementDirectOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: EngagementCurrentEventSource;
  readonly clock: Clock;
  readonly ids: EngagementOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
  /** Enabled only when a verified-inbox runtime mounts the finite Airtable allowlist. */
  readonly enableVerifiedInbox?: boolean;
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

export function createEngagementDirectOperationModule(
  input: CreateEngagementDirectOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== ENGAGEMENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== ENGAGEMENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('engagement_direct_operation_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const inboundLane = input.enableVerifiedInbox ? parseOperationAccessLane({
    kind: 'verified_inbox', surface: 'provider_ingress', policy: input.managePolicy
  }) : undefined;
  const lanes = inboundLane ? [lane, inboundLane] : [lane];
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: ENGAGEMENT_CHANGE_OPERATION,
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
    operation: ENGAGEMENT_CHANGE_OPERATION,
    effect: 'commit',
    lanes,
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: ENGAGEMENT_REQUEST_HASH_PROFILE,
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
    operation: ENGAGEMENT_CHANGE_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: ENGAGEMENT_CHANGE_OPERATION,
    effect: 'commit',
    handler: refs.handler,
    handlerCapability: ENGAGEMENT_DIRECT_HANDLER_CAPABILITY,
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
    operation: ENGAGEMENT_CHANGE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['engagement-changed']),
      evidenceIds: Object.freeze(['engagement.change.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: ENGAGEMENT_CHANGE_OPERATION,
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
          key: 'engagement.change.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: ENGAGEMENT_CHANGE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: ENGAGEMENT_CHANGE_OPERATION,
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
  const handler = createEngagementDirectHandler({
    reference: refs.handler,
    handlerCapability: ENGAGEMENT_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'engagement-change.operation',
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
        { reference: schemas.input, schema: engagementAuthorInputSchema },
        { reference: schemas.contribution, schema: engagementDirectContributionSchema },
        { reference: schemas.canonical, schema: engagementDirectCanonicalResultSchema },
        { reference: schemas.projected, schema: engagementChangeOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: engagementDirectStaleDetailSchema }
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
        project: (candidate: unknown) => engagementDirectCanonicalResultSchema.parse(candidate)
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
        ...ENGAGEMENT_CHANGE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Record an engagement change.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['engagement-changed'],
        agentAction: { eligible: true as const, displayLabel: 'Change an engagement', consequences: ['A speaker engagement state may change.'], externalEffect: 'none' as const },
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
            kind: 'engagement.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'engagement.changed',
            retryable: false,
            detailSchema: schemas.staleDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: schemas.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: lanes,
        contextBuilder: refs.context,
        handlerCapability: ENGAGEMENT_DIRECT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: ENGAGEMENT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.family,
          phase: refs.phase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight,
          history: { summariesByAction: Object.freeze({
            record_confirmation: 'Recorded a speaker confirmation',
            decline: 'Recorded a speaker decline',
            request_cancellation: 'Requested a speaker cancellation',
            withdraw_cancellation: 'Withdrew a speaker cancellation request',
            accept_cancellation: 'Accepted a speaker cancellation'
          }) }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/engagements',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }],
        ...(inboundLane ? { verifiedInboxBindings: [{
          surface: 'provider_ingress' as const, lane: 'verified_inbox' as const,
          projection: refs.projection
        }] } : {})
      }])
    })
  });
}
