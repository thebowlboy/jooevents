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
  engagementChangeDraftDataSchema,
  engagementChangeDraftOperationResultSchema,
  engagementResponseActionSchema
} from '@jooevents/contracts';
import { engagementStaleDetailSchema } from '@jooevents/engagement';
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
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  currentEventScopeResolver,
  type EngagementCurrentEventSource,
  type EngagementOperationIds
} from './module';

/**
 * The one engagement wire mutation. The persistence draft adapter refuses
 * construction unless it is injected exactly this identity; its receipt
 * tables physically CHECK the same name and version.
 */
export const ENGAGEMENT_CHANGE_DRAFT_OPERATION = Object.freeze({
  name: 'engagement.change.draft', version: 1
});

export const ENGAGEMENT_DRAFT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.engagement.draft', version: parseContractVersion(1)
});
export const ENGAGEMENT_DRAFT_PERMISSION_ID: PermissionId = 'event.manage';
export const ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.engagement.change-draft');
export const ENGAGEMENT_DRAFT_HANDLER_CAPABILITY = ref('capability.engagement.change-draft');
export const ENGAGEMENT_DRAFT_APPROVAL_POLICY = (() => {
  const reference = ref('policy.engagement.respond.bounded');
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

export const engagementDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: engagementChangeDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export { engagementChangeDraftDataSchema, engagementChangeDraftOperationResultSchema };

/**
 * Mounted mirror of the adapter-authored contribution shapes in
 * `@jooevents/persistence/engagement-draft-effect-domain`; both derive from
 * the pinned `engagement.change.draft` v1 contract, and the engine validates
 * every contribution against this mounted schema.
 */
export const engagementDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('engagement_changeset_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: sha256Schema,
  recordDigestSha256: sha256Schema,
  action: engagementResponseActionSchema,
  engagementId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});
export const engagementDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});

export const engagementDraftStaleDetailSchema = engagementStaleDetailSchema;

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: engagementChangeDraftDataSchema }),
  domain: engagementDraftDomainContributionSchema,
  receiptChildren: z.tuple([engagementDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const diff = data.safeDiff;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || diff.action !== domain.action
      || diff.before === null
      || diff.after === null
      || diff.before.id !== domain.engagementId
      || diff.after.id !== domain.engagementId
      || diff.before.scope.workspaceId !== domain.workspaceId
      || diff.before.scope.eventId !== domain.eventId
      || diff.after.scope.workspaceId !== domain.workspaceId
      || diff.after.scope.eventId !== domain.eventId
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Engagement draft evidence is incoherent.' });
  }
});

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'engagement.changed'
    ? engagementDraftStaleDetailSchema
    : nullDetailSchema;
  const allowed = new Set([
    'conflict:engagement.event_required',
    'stale_revision:engagement.changed',
    'conflict:changeset.id_collision'
  ]);
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Engagement draft refusal is invalid.' });
  }
});

export const engagementDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

export type EngagementDraftContribution = z.infer<typeof engagementDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: ENGAGEMENT_OPERATION_SCHEMA_REFS.changeDraft.inputSchema,
  contribution: schemaRef('schema.engagement.change-draft.contribution', engagementDraftContributionSchema),
  canonical: schemaRef('schema.engagement.change-draft.canonical-result', engagementDraftCanonicalResultSchema),
  projected: ENGAGEMENT_OPERATION_SCHEMA_REFS.changeDraft.resultSchema,
  nullDetail: schemaRef('schema.engagement.change-draft.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.engagement.changed.detail', engagementDraftStaleDetailSchema)
});

const refs = Object.freeze({
  context: ref('context.engagement.change-draft'),
  autonomy: ref('autonomy.engagement.change-draft'),
  concurrency: ref('concurrency.engagement.change-draft'),
  family: ref('engagement.change-draft.execution-family'),
  phase: ref('engagement.change-draft.phase.single-uow'),
  terminalization: ref('engagement.change-draft.terminalization'),
  risk: ref('engagement.change-draft.risk-resolver'),
  autonomyEvidence: ref('engagement.change-draft.autonomy-evidence'),
  approval: ref('engagement.change-draft.approval-resolver'),
  preflight: ref('engagement.change-draft.autonomy-preflight'),
  handler: ref('handler.engagement.change-draft'),
  projection: ref('projection.engagement.change-draft.operator'),
  audit: ref('audit.engagement.change-draft'),
  auditRecordProfile: ref('record-profile.engagement.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: EngagementDraftPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export interface EngagementDraftPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

/** Transaction-owned preparation for one inert engagement response draft. */
export interface EngagementDraftPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): EngagementDraftPreparedContribution;
}

export function sealEngagementDraftPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: EngagementDraftPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('engagement_draft_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('engagement_draft_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'engagement_changeset_draft', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createEngagementDraftHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'draft' as const,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_engagement_draft_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('engagement_draft_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          receiptChildren: [...contribution.receiptChildren]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

export interface CreateEngagementDraftOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly draftPolicy: VersionedAccessPolicyRef;
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

export function createEngagementDraftOperationModule(
  input: CreateEngagementDraftOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.draftPolicy.key !== ENGAGEMENT_DRAFT_ACCESS_POLICY.key
      || input.draftPolicy.version !== ENGAGEMENT_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('engagement_draft_operation_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.draftPolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
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
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
    effect: 'draft',
    lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE,
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
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
    effect: 'draft',
    handler: refs.handler,
    handlerCapability: ENGAGEMENT_DRAFT_HANDLER_CAPABILITY,
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
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['engagement.change.draft.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
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
          key: 'engagement.change.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: ENGAGEMENT_CHANGE_DRAFT_OPERATION,
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
  const handler = createEngagementDraftHandler({
    reference: refs.handler,
    handlerCapability: ENGAGEMENT_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'engagement-change-draft.operation',
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
        { reference: schemas.contribution, schema: engagementDraftContributionSchema },
        { reference: schemas.canonical, schema: engagementDraftCanonicalResultSchema },
        { reference: schemas.projected, schema: engagementChangeDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: engagementDraftStaleDetailSchema }
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
        project: (candidate: unknown) => engagementDraftCanonicalResultSchema.parse(candidate)
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
        ...ENGAGEMENT_CHANGE_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one consequential engagement response changeset for review.',
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
        handlerCapability: ENGAGEMENT_DRAFT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: ENGAGEMENT_DRAFT_REQUEST_HASH_PROFILE
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
          path: '/api/events/current/engagements/drafts',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
