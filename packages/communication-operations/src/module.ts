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
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type RequestHashSealer
} from '@jooevents/application';
import {
  OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  outboundEmailDeliveryWorkAnchorSchema,
  outboundEmailDeliveryWorkInputSchema,
  outboundEmailDeliveryWorkOperationResultSchema,
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
  encodeCanonicalJson,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseInstant,
  type CapabilityRevisionId,
  type Clock,
  type InvocationId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOutboundEmailDeliveryHandler } from './preparation';

export const DISPATCH_MESSAGE_RELEASE_OPERATION = Object.freeze({
  name: 'dispatch_message_release',
  version: 1
});

export const OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.communication.dispatch',
  version: parseContractVersion(1)
});

export const OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY = Object.freeze({
  key: 'capability.communication.outbound-email-delivery.register',
  version: 1
});

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function digest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

const nullDetailSchema = z.null();
const canonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: outboundEmailDeliveryWorkAnchorSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const outboundEmailDeliveryDomainContributionSchema = z.strictObject({
  kind: z.literal('outbound_email_delivery_registration'),
  preparationHandle: z.string().min(1).max(256),
  deliveryId: z.string().min(1).max(256),
  workDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const outboundEmailDeliveryEvidenceChildSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('domain_fact'),
    factId: z.string().min(1).max(256),
    factKind: z.literal('outbound_email_delivery_requested'),
    factVersion: z.literal(1),
    deliveryId: z.string().min(1).max(256),
    releaseId: z.string().min(1).max(256),
    reviewedMessageDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedEnvelopeDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: z.iso.datetime({ offset: true })
  }),
  z.strictObject({
    kind: z.literal('outbox_pointer'),
    pointerId: z.string().min(1).max(256),
    sourceKind: z.literal('domain_fact'),
    factId: z.string().min(1).max(256),
    deliveryId: z.string().min(1).max(256),
    purpose: z.literal('communication.outbound-email.dispatch')
  }),
  z.strictObject({
    kind: z.literal('history'),
    historyId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    sourceKind: z.literal('domain_fact'),
    factId: z.string().min(1).max(256),
    deliveryId: z.string().min(1).max(256),
    summaryCode: z.literal('communication.outbound-email.requested'),
    occurredAt: z.iso.datetime({ offset: true })
  })
]);

const createdContributionSchema = z.strictObject({
  result: z.strictObject({
    kind: z.literal('success'),
    data: outboundEmailDeliveryWorkAnchorSchema.extend({ disposition: z.literal('created') })
  }),
  domain: outboundEmailDeliveryDomainContributionSchema,
  receiptChildren: z.tuple([
    outboundEmailDeliveryEvidenceChildSchema.options[0],
    outboundEmailDeliveryEvidenceChildSchema.options[1],
    outboundEmailDeliveryEvidenceChildSchema.options[2]
  ])
}).superRefine((value, context) => {
  const [fact, pointer, history] = value.receiptChildren;
  if (
    value.result.data.deliveryId !== value.domain.deliveryId
    || value.result.data.deliveryId !== fact.deliveryId
    || pointer.deliveryId !== fact.deliveryId
    || history.deliveryId !== fact.deliveryId
    || pointer.factId !== fact.factId
    || history.factId !== fact.factId
    || history.occurredAt !== fact.occurredAt
  ) context.addIssue({ code: 'custom', message: 'Outbound delivery evidence is incoherent.' });
});

const alreadyReadyContributionSchema = z.strictObject({
  result: z.strictObject({
    kind: z.literal('success'),
    data: outboundEmailDeliveryWorkAnchorSchema.extend({ disposition: z.literal('already_ready') })
  }),
  domain: z.null(),
  receiptChildren: z.tuple([])
});

const identityConflictContributionSchema = z.strictObject({
  result: z.strictObject({
    kind: z.literal('outcome'),
    outcome: structuredOutcomeSchema
  }).superRefine((value, context) => {
    if (
      value.outcome.class !== 'idempotency_conflict'
      || value.outcome.kind !== 'communication.delivery_identity_changed'
      || value.outcome.retryable !== false
      || value.outcome.detail !== null
      || value.outcome.detailSchemaVersion !== 1
    ) context.addIssue({ code: 'custom', message: 'Invalid delivery identity conflict.' });
  }),
  domain: z.null(),
  receiptChildren: z.tuple([])
});

export const outboundEmailDeliveryContributionSchema = z.union([
  createdContributionSchema,
  alreadyReadyContributionSchema,
  identityConflictContributionSchema
]);

export type OutboundEmailDeliveryContribution = z.infer<
  typeof outboundEmailDeliveryContributionSchema
>;

const schemas = {
  input: OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS.dispatch.inputSchema,
  projected: OUTBOUND_EMAIL_DELIVERY_OPERATION_SCHEMA_REFS.dispatch.resultSchema,
  contribution: schemaRef(
    'schema.communication.outbound-email-delivery.dispatch.contribution',
    outboundEmailDeliveryContributionSchema
  ),
  canonical: schemaRef(
    'schema.communication.outbound-email-delivery.dispatch.canonical-result',
    canonicalResultSchema
  ),
  nullDetail: schemaRef('schema.communication.operation.null-detail', nullDetailSchema)
} as const;

const refs = {
  context: ref('context.communication.outbound-email-delivery.dispatch'),
  autonomy: ref('autonomy.communication.outbound-email-delivery.dispatch'),
  handler: ref('handler.communication.outbound-email-delivery.dispatch'),
  projection: ref('projection.communication.outbound-email-delivery.dispatch.job'),
  audit: ref('audit.communication.outbound-email-delivery.dispatch'),
  auditRecordProfile: ref('record-profile.communication.operation-audit'),
  keySource: ref('idempotency.registered-job'),
  requestHash: ref('request-hash.communication.outbound-email-delivery.dispatch'),
  concurrency: ref('concurrency.communication.outbound-email-delivery'),
  executionFamily: ref('communication.outbound-email-delivery.execution-family'),
  executionPhase: ref('communication.outbound-email-delivery.phase.single-uow'),
  terminalization: ref('communication.outbound-email-delivery.terminalization'),
  riskResolver: ref('communication.outbound-email-delivery.risk-resolver'),
  autonomyEvidence: ref('communication.outbound-email-delivery.autonomy-evidence'),
  approvalResolver: ref('communication.outbound-email-delivery.approval-resolver'),
  autonomyPreflight: ref('communication.outbound-email-delivery.autonomy-preflight')
} as const;

export interface OutboundEmailDeliveryRegisteredJobBinding {
  readonly job: VersionedDefinitionRef;
  readonly inputProjection: VersionedDefinitionRef;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly authorityCitation: VersionedDefinitionRef;
}

export interface CreateOutboundEmailDeliveryOperationModuleInput {
  readonly policy: VersionedAccessPolicyRef;
  readonly scopeResolver: InvocationScopeResolver;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly registeredJob: OutboundEmailDeliveryRegisteredJobBinding;
  readonly clock: Clock;
  readonly newInvocationId: () => InvocationId;
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

export function createOutboundEmailDeliveryOperationModule(
  input: CreateOutboundEmailDeliveryOperationModuleInput
): OperationRegistryModule {
  if (
    input.policy.key !== OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY.key
    || input.policy.version !== OUTBOUND_EMAIL_DISPATCH_ACCESS_POLICY.version
  ) throw new TypeError('outbound_email_delivery_policy_catalog_mismatch');
  const capabilityRevisionId = parseCapabilityRevisionId(
    input.registeredJob.capabilityRevisionId
  );
  const lane = parseOperationAccessLane({
    kind: 'registered_job',
    surface: 'application_job',
    policy: input.policy
  });
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
    effect: 'commit',
    lanes: [lane],
    scopeResolver: input.scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: refs.requestHash,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
    riskFloor: 'normal',
    unattendedRiskCeiling: 'normal',
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
  const executionFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.executionFamily,
    phase: refs.executionPhase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
    phase: refs.executionPhase,
    resolve: ({ result }) => result.kind === 'success'
      || (result.kind === 'outcome'
        && result.outcomeClass === 'idempotency_conflict'
        && result.outcomeKind === 'communication.delivery_identity_changed')
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const contentionOutcome: StructuredOutcome = Object.freeze({
    class: 'conflict',
    kind: 'operation.in_progress',
    retryable: true,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
  const executionPhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.executionPhase,
    family: refs.executionFamily,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
    effect: 'commit',
    handler: refs.handler,
    handlerCapability: OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: ['idempotency_conflict:communication.delivery_identity_changed'],
    contentionOutcome
  });
  const riskResolver = createOperationRiskResolverRegistration({
    reference: refs.riskResolver,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'normal' as const,
      consequenceTags: Object.freeze(['outbound-email-dispatch-queued']),
      evidenceIds: Object.freeze(['communication.outbound-email-delivery.reviewed-release'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
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
          key: 'communication.outbound-email-delivery.register',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approvalResolver = createRenewedApprovalResolverRegistration({
    reference: refs.approvalResolver,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const autonomyPreflight = createAutonomyPreflightRegistration({
    reference: refs.autonomyPreflight,
    operation: DISPATCH_MESSAGE_RELEASE_OPERATION,
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
  const execution = Object.freeze({
    kind: 'single_unit_of_work' as const,
    family: refs.executionFamily,
    phase: refs.executionPhase,
    terminalization: refs.terminalization,
    autonomyPreflight: refs.autonomyPreflight
  });

  return Object.freeze({
    id: 'communication.outbound-email-delivery.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([executionFamily]),
      effectPhases: Object.freeze([executionPhase]),
      terminalizationResolvers: Object.freeze([terminalization]),
      riskResolvers: Object.freeze([riskResolver]),
      autonomyEvidenceResolvers: Object.freeze([autonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([approvalResolver]),
      autonomyPreflights: Object.freeze([autonomyPreflight]),
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: outboundEmailDeliveryWorkInputSchema },
        { reference: schemas.contribution, schema: outboundEmailDeliveryContributionSchema },
        { reference: schemas.canonical, schema: canonicalResultSchema },
        { reference: schemas.projected, schema: outboundEmailDeliveryWorkOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => canonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([]),
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
      operations: Object.freeze([]),
      effectContextBuilders: Object.freeze([context]),
      effectHandlers: Object.freeze([createOutboundEmailDeliveryHandler({
        reference: refs.handler,
        handlerCapability: OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY,
        contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical
      })]),
      effectOperations: Object.freeze([{
        ...DISPATCH_MESSAGE_RELEASE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Register one reviewed outbound email release for worker delivery.',
        effect: 'commit' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['outbound-email-dispatch-queued'],
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
            class: 'idempotency_conflict' as const,
            kind: 'communication.delivery_identity_changed',
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
        handlerCapability: OUTBOUND_EMAIL_DELIVERY_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: refs.requestHash
        },
        concurrency: refs.concurrency,
        execution,
        bindings: [],
        registeredJobBindings: [{
          surface: 'application_job' as const,
          lane: 'registered_job' as const,
          job: input.registeredJob.job,
          inputProjection: input.registeredJob.inputProjection,
          capabilityRevisionId,
          authorityCitation: input.registeredJob.authorityCitation,
          projection: refs.projection
        }]
      }])
    })
  });
}

export function outboundEmailDeliveryWorkDigest(value: unknown): string {
  return digest(outboundEmailDeliveryWorkInputSchema.parse(value));
}
