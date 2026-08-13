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
  createSafeSchemaManifestRef,
  eventCreateDraftCanonicalResultSchema,
  eventCreateDraftDataSchema,
  eventCreateDraftInputSchema,
  eventCreateDraftOperationResultSchema,
  EVENT_OPERATION_SCHEMA_REFS,
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
import { EVENT_MANAGE_ACCESS_POLICY } from './module';
import { createEventCreateDraftHandler } from './draft-preparation';

export const EVENT_CREATE_DRAFT_OPERATION = Object.freeze({
  name: 'event.create.draft',
  version: 1
});
export const EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.event.create-draft');
export const EVENT_CREATE_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.event.changeset_draft'
);

const canonicalApplicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: 'Application IDs must use canonical lowercase bytes.' }
);

export const eventCreateDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('event_creation_changeset_draft'),
  preparationHandle: canonicalApplicationIdSchema,
  action: z.literal('create'),
  workspaceId: canonicalApplicationIdSchema,
  eventId: canonicalApplicationIdSchema,
  changesetId: canonicalApplicationIdSchema,
  revisionId: canonicalApplicationIdSchema,
  revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recordDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.iso.datetime({ offset: true })
});

export const eventCreateDraftEvidenceChildSchema = z.strictObject({
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
  code: z.enum(['stale_event_set', 'event_already_selected']),
  action: z.literal('create'),
  eventId: canonicalApplicationIdSchema
});

const successContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: eventCreateDraftDataSchema }),
  domain: eventCreateDraftDomainContributionSchema,
  receiptChildren: z.tuple([eventCreateDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.safeDiff.after.id !== domain.eventId
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
  const schema = key === 'conflict:changeset.id_collision' ? nullDetailSchema : staleDetailSchema;
  if (![
    'stale_revision:event.creation_changed',
    'conflict:event.already_selected',
    'conflict:changeset.id_collision'
  ].includes(key) || outcome.retryable || outcome.detailSchemaVersion !== 1
      || !schema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Event draft refusal is invalid.' });
  }
});

export const eventCreateDraftContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);

export type EventCreateDraftContribution = z.infer<typeof eventCreateDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const schemas = Object.freeze({
  input: EVENT_OPERATION_SCHEMA_REFS.createDraft.inputSchema,
  contribution: schemaRef(
    'schema.event.create-draft.contribution',
    eventCreateDraftContributionSchema
  ),
  canonical: schemaRef(
    'schema.event.create-draft.canonical-result',
    eventCreateDraftCanonicalResultSchema
  ),
  projected: EVENT_OPERATION_SCHEMA_REFS.createDraft.resultSchema,
  nullDetail: schemaRef('schema.event.create-draft.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.event.create-draft.stale-detail', staleDetailSchema)
});

const refs = Object.freeze({
  context: ref('context.event.create-draft'),
  autonomy: ref('autonomy.event.create-draft'),
  handler: ref('handler.event.create-draft'),
  projection: ref('projection.event.create-draft.operator'),
  audit: ref('audit.event.create-draft'),
  auditRecordProfile: ref('record-profile.event.create-draft.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
  concurrency: ref('concurrency.event.create-draft.workspace-event-set'),
  executionFamily: ref('event.create-draft.execution-family'),
  executionPhase: ref('event.create-draft.phase.single-uow'),
  terminalization: ref('event.create-draft.terminalization'),
  riskResolver: ref('event.create-draft.risk-resolver'),
  autonomyEvidence: ref('event.create-draft.autonomy-evidence'),
  approvalResolver: ref('event.create-draft.approval-resolver'),
  autonomyPreflight: ref('event.create-draft.autonomy-preflight')
});

export interface EventCreateDraftOperationIds {
  newInvocationId(): InvocationId;
}

export interface CreateEventCreateDraftOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: EventCreateDraftOperationIds;
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

export function createEventCreateDraftOperationModule(
  input: CreateEventCreateDraftOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== EVENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('event_create_draft_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: EVENT_CREATE_DRAFT_OPERATION,
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
    operation: EVENT_CREATE_DRAFT_OPERATION,
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
    operation: EVENT_CREATE_DRAFT_OPERATION,
    phase: refs.executionPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.executionPhase,
    family: refs.executionFamily,
    operation: EVENT_CREATE_DRAFT_OPERATION,
    effect: 'draft',
    handler: refs.handler,
    handlerCapability: EVENT_CREATE_DRAFT_HANDLER_CAPABILITY,
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
    operation: EVENT_CREATE_DRAFT_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['event.create.draft.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: EVENT_CREATE_DRAFT_OPERATION,
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
          key: 'event.create.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approvalResolver = createRenewedApprovalResolverRegistration({
    reference: refs.approvalResolver,
    operation: EVENT_CREATE_DRAFT_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const autonomyPreflight = createAutonomyPreflightRegistration({
    reference: refs.autonomyPreflight,
    operation: EVENT_CREATE_DRAFT_OPERATION,
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
  const handler = createEventCreateDraftHandler({
    reference: refs.handler,
    handlerCapability: EVENT_CREATE_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'event-create-draft.operation',
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
        { reference: schemas.input, schema: eventCreateDraftInputSchema },
        { reference: schemas.contribution, schema: eventCreateDraftContributionSchema },
        { reference: schemas.canonical, schema: eventCreateDraftCanonicalResultSchema },
        { reference: schemas.projected, schema: eventCreateDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: staleDetailSchema }
      ]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => eventCreateDraftCanonicalResultSchema.parse(candidate)
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
        ...EVENT_CREATE_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft creation of the first Event for review.',
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
            kind: 'event.creation_changed',
            retryable: false,
            detailSchema: schemas.staleDetail
          },
          {
            class: 'conflict' as const,
            kind: 'event.already_selected',
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
        handlerCapability: EVENT_CREATE_DRAFT_HANDLER_CAPABILITY,
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
          path: '/api/events/drafts/create',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
