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
  TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS,
  templateArtifactGetCanonicalResultSchema,
  templateArtifactGetInputSchema,
  templateArtifactGetOperationResultSchema,
  templateArtifactListCanonicalResultSchema,
  templateArtifactListDataSchema,
  templateArtifactListInputSchema,
  templateArtifactListOperationResultSchema,
  templateArtifactMutationDraftCanonicalResultSchema,
  templateArtifactMutationDraftDataSchema,
  templateArtifactMutationDraftOperationResultSchema,
  templateArtifactMutationInputSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type TemplateArtifactSnapshotDto,
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
import { z } from 'zod';
import { createTemplateArtifactDraftHandler } from './preparation';

export const TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION = Object.freeze({
  name: 'template.artifact.change.draft', version: 1
});
export const TEMPLATE_ARTIFACT_LIST_OPERATION = Object.freeze({
  name: 'template.artifact.list', version: 1
});
export const TEMPLATE_ARTIFACT_GET_OPERATION = Object.freeze({
  name: 'template.artifact.get', version: 1
});
export const TEMPLATE_ARTIFACT_MUTATION_DRAFT_PATH =
  '/api/events/current/template-artifacts/drafts';
export const TEMPLATE_ARTIFACT_LIST_PATH = '/api/events/current/template-artifacts';
export const TEMPLATE_ARTIFACT_GET_PATH = '/api/events/current/template-artifacts/detail';
export const TEMPLATE_ARTIFACT_DRAFT_REQUEST_HASH_PROFILE =
  ref('request-hash.template.artifact-draft');
export const TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY =
  ref('capability.template.artifact.changeset-draft');

const canonicalId = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nullDetailSchema = z.null();
const staleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'artifact_missing', 'artifact_kind_changed', 'stale_revision',
    'revision_missing', 'no_changes', 'invalid_plan'
  ]),
  action: z.enum(['replace', 'revert']),
  artifactId: canonicalId
});

export const templateArtifactDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('template_artifact_changeset_draft'),
  preparationHandle: canonicalId,
  action: z.enum(['replace', 'revert']),
  workspaceId: canonicalId,
  eventId: canonicalId,
  artifactId: canonicalId,
  changesetId: canonicalId,
  revisionId: canonicalId,
  revisionDigestSha256: digest,
  recordDigestSha256: digest,
  occurredAt: z.iso.datetime({ offset: true })
});
export const templateArtifactDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: canonicalId,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: canonicalId,
  eventId: canonicalId,
  changesetId: canonicalId,
  revisionId: canonicalId,
  occurredAt: z.iso.datetime({ offset: true })
});

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: templateArtifactMutationDraftDataSchema }),
  domain: templateArtifactDraftDomainContributionSchema,
  receiptChildren: z.tuple([templateArtifactDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.safeDiff.artifactId !== domain.artifactId
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'template draft evidence is incoherent' });
  }
});
const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const key = `${outcome.class}:${outcome.kind}`;
  const detailSchema = key === 'stale_revision:template.artifact_changed'
    ? staleDetailSchema : nullDetailSchema;
  if (![
    'stale_revision:template.artifact_changed',
    'conflict:template.artifact.event_required',
    'conflict:changeset.id_collision'
  ].includes(key) || outcome.retryable || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'template draft refusal is invalid' });
  }
});
export const templateArtifactDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);
export type TemplateArtifactDraftContribution = z.infer<typeof templateArtifactDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
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

const draftSchemas = Object.freeze({
  input: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.mutationDraft.inputSchema,
  contribution: schemaRef(
    'schema.template-artifact.mutation-draft.contribution',
    templateArtifactDraftContributionSchema
  ),
  canonical: schemaRef(
    'schema.template-artifact.mutation-draft.canonical-result',
    templateArtifactMutationDraftCanonicalResultSchema
  ),
  projected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.mutationDraft.resultSchema,
  nullDetail: schemaRef('schema.template-artifact.mutation-draft.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.template-artifact.mutation-draft.stale-detail', staleDetailSchema)
});
const draftRefs = Object.freeze({
  context: ref('context.template.artifact.mutation-draft'),
  autonomy: ref('autonomy.template.artifact.mutation-draft'),
  handler: ref('handler.template.artifact.mutation-draft'),
  projection: ref('projection.template.artifact.mutation-draft.operator'),
  audit: ref('audit.template.artifact.mutation-draft'),
  auditRecordProfile: ref('record-profile.template.artifact.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: TEMPLATE_ARTIFACT_DRAFT_REQUEST_HASH_PROFILE,
  concurrency: ref('concurrency.template.artifact'),
  family: ref('template.artifact.mutation-draft.execution-family'),
  phase: ref('template.artifact.mutation-draft.phase.single-uow'),
  terminalization: ref('template.artifact.mutation-draft.terminalization'),
  risk: ref('template.artifact.mutation-draft.risk-resolver'),
  evidence: ref('template.artifact.mutation-draft.autonomy-evidence'),
  approval: ref('template.artifact.mutation-draft.approval-resolver'),
  preflight: ref('template.artifact.mutation-draft.autonomy-preflight')
});

export interface TemplateArtifactOperationIds { newInvocationId(): InvocationId; }
export interface CreateTemplateArtifactDraftOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: TemplateArtifactOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export function createTemplateArtifactDraftOperationModule(
  input: CreateTemplateArtifactDraftOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.managePolicy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== EVENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('template_artifact_draft_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: draftRefs.autonomy,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
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
  const context = createEffectInvocationContextBuilder({
    reference: draftRefs.context,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    effect: 'draft', lanes: [lane], scopeResolver: workspaceScopeResolver(workspaceId),
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: draftRefs.requestHash,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: draftRefs.family, phase: draftRefs.phase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: draftRefs.terminalization,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    phase: draftRefs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: draftRefs.phase, family: draftRefs.family,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    effect: 'draft', handler: draftRefs.handler,
    handlerCapability: TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: draftSchemas.contribution,
    terminalization: draftRefs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: draftRefs.risk,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    resolve: () => ({
      risk: 'low', consequenceTags: ['changeset-drafted'],
      evidenceIds: ['template.artifact.change.draft.risk']
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: draftRefs.evidence,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: { key: 'template.artifact.change.draft.execute', version: 1,
          digestSha256: subject.requestHashSha256 },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: draftRefs.approval,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: draftRefs.preflight,
    operation: TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
    policy: draftRefs.autonomy, riskResolver: draftRefs.risk,
    evidenceResolver: draftRefs.evidence, approvalResolver: draftRefs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: draftSchemas.nullDetail
  }));
  const handler = createTemplateArtifactDraftHandler({
    reference: draftRefs.handler,
    handlerCapability: TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: draftSchemas.contribution,
    canonicalResultSchema: draftSchemas.canonical
  });
  return Object.freeze({
    id: 'template-artifact-draft.operation',
    source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase],
      terminalizationResolvers: [terminalization], riskResolvers: [risk],
      autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [autonomy],
      contextBuilders: [], readCapabilities: [], handlers: [], operations: [],
      readOperationalTraceTargets: [],
      schemas: [
        { reference: draftSchemas.input, schema: templateArtifactMutationInputSchema },
        { reference: draftSchemas.contribution, schema: templateArtifactDraftContributionSchema },
        { reference: draftSchemas.canonical, schema: templateArtifactMutationDraftCanonicalResultSchema },
        { reference: draftSchemas.projected, schema: templateArtifactMutationDraftOperationResultSchema },
        { reference: draftSchemas.nullDetail, schema: nullDetailSchema },
        { reference: draftSchemas.staleDetail, schema: staleDetailSchema }
      ],
      projections: [{
        reference: draftRefs.projection,
        canonicalResultSchema: draftSchemas.canonical,
        projectedResultSchema: draftSchemas.projected,
        project: (candidate: unknown) => templateArtifactMutationDraftCanonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: draftRefs.audit, kind: 'operation_audit_record' as const,
        recordProfile: draftRefs.auditRecordProfile
      }],
      operationAuditRecordProfiles: [{
        reference: draftRefs.auditRecordProfile,
        kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      effectContextBuilders: [context], effectHandlers: [handler],
      effectOperations: [{
        ...TEMPLATE_ARTIFACT_MUTATION_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one template, surface, or theme revision for review.',
        effect: 'draft' as const, maxRisk: 'low' as const,
        autonomyPolicy: draftRefs.autonomy, consequenceTags: ['changeset-drafted'],
        inputSchema: draftSchemas.input, contributionSchema: draftSchemas.contribution,
        canonicalResultSchema: draftSchemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: draftSchemas.nullDetail },
          ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'template.artifact_changed', retryable: false, detailSchema: draftSchemas.staleDetail },
          { class: 'conflict' as const, kind: 'template.artifact.event_required', retryable: false, detailSchema: draftSchemas.nullDetail },
          { class: 'conflict' as const, kind: 'changeset.id_collision', retryable: false, detailSchema: draftSchemas.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: draftSchemas.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(draftSchemas.nullDetail)
        ],
        accessLanes: [lane], contextBuilder: draftRefs.context,
        handlerCapability: TEMPLATE_ARTIFACT_DRAFT_HANDLER_CAPABILITY,
        handler: draftRefs.handler,
        audit: { mode: 'required' as const, target: draftRefs.audit },
        idempotency: {
          keySource: draftRefs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: draftRefs.requestHash
        },
        concurrency: draftRefs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const, family: draftRefs.family,
          phase: draftRefs.phase, terminalization: draftRefs.terminalization,
          autonomyPreflight: draftRefs.preflight
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const,
          path: TEMPLATE_ARTIFACT_MUTATION_DRAFT_PATH, input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: draftRefs.projection
        }]
      }]
    })
  });
}

const readRefs = Object.freeze({
  list: {
    context: ref('context.template.artifact.list'), autonomy: ref('autonomy.template.artifact.list'),
    handler: ref('handler.template.artifact.list'), projection: ref('projection.template.artifact.list.operator')
  },
  get: {
    context: ref('context.template.artifact.get'), autonomy: ref('autonomy.template.artifact.get'),
    handler: ref('handler.template.artifact.get'), projection: ref('projection.template.artifact.get.operator')
  },
  capability: ref('capability.template.artifact.read'),
  trace: ref('trace.template.artifact.read'),
  record: ref('record-profile.template.artifact.read-trace')
});
const readSchemas = Object.freeze({
  listInput: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.list.inputSchema,
  listCanonical: schemaRef('schema.template-artifact.list.canonical-result', templateArtifactListCanonicalResultSchema),
  listProjected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.list.resultSchema,
  getInput: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.get.inputSchema,
  getCanonical: schemaRef('schema.template-artifact.get.canonical-result', templateArtifactGetCanonicalResultSchema),
  getProjected: TEMPLATE_AUTHORING_OPERATION_SCHEMA_REFS.get.resultSchema,
  nullDetail: schemaRef('schema.template-artifact.read.null-detail', nullDetailSchema)
});

export interface TemplateArtifactCurrentReadPort {
  listCurrent(workspaceId: WorkspaceId):
    | readonly TemplateArtifactSnapshotDto[]
    | undefined
    | Promise<readonly TemplateArtifactSnapshotDto[] | undefined>;
}
export interface CreateTemplateArtifactReadOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentRead: TemplateArtifactCurrentReadPort;
  readonly clock: Clock;
  readonly ids: TemplateArtifactOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}

export function createTemplateArtifactReadOperationModule(
  input: CreateTemplateArtifactReadOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== EVENT_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== EVENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('template_artifact_read_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.readPolicy });
  const operations = [
    { key: 'list' as const, operation: TEMPLATE_ARTIFACT_LIST_OPERATION },
    { key: 'get' as const, operation: TEMPLATE_ARTIFACT_GET_OPERATION }
  ];
  const autonomies = operations.map(({ key, operation }) => createOperationAutonomyPolicy({
    definition: readRefs[key].autonomy, operation,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  }));
  const contexts = operations.map(({ key, operation }) => createReadInvocationContextBuilder({
    reference: readRefs[key].context, operation, effect: 'read', lanes: [lane],
    scopeResolver: workspaceScopeResolver(workspaceId), authorityResolver: input.currentAuthority,
    clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  }));
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: readRefs.capability,
    openSnapshot: async (context: EffectInvocationContext) => Object.freeze({
      artifacts: await input.currentRead.listCurrent(context.scope.workspaceId)
    })
  });
  const eventRequired = () => ({
    kind: 'outcome' as const,
    outcome: {
      class: 'conflict' as const, kind: 'template.artifact.event_required', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const notFound = () => ({
    kind: 'outcome' as const,
    outcome: {
      class: 'conflict' as const, kind: 'template.artifact.not_found', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: readSchemas.nullDetail
  }));
  return Object.freeze({
    id: 'template-artifact-read.operation',
    source: Object.freeze({
      effectExecutionFamilies: [], effectPhases: [], terminalizationResolvers: [],
      riskResolvers: [], autonomyEvidenceResolvers: [], renewedApprovalResolvers: [],
      autonomyPreflights: [], autonomyPolicies: autonomies,
      schemas: [
        { reference: readSchemas.listInput, schema: templateArtifactListInputSchema },
        { reference: readSchemas.listCanonical, schema: templateArtifactListCanonicalResultSchema },
        { reference: readSchemas.listProjected, schema: templateArtifactListOperationResultSchema },
        { reference: readSchemas.getInput, schema: templateArtifactGetInputSchema },
        { reference: readSchemas.getCanonical, schema: templateArtifactGetCanonicalResultSchema },
        { reference: readSchemas.getProjected, schema: templateArtifactGetOperationResultSchema },
        { reference: readSchemas.nullDetail, schema: nullDetailSchema }
      ],
      contextBuilders: contexts, readCapabilities: [capability],
      handlers: [
        {
          reference: readRefs.list.handler,
          readCapability: readRefs.capability,
          canonicalResultSchema: readSchemas.listCanonical,
          handle: ({ snapshot, businessInput }: { snapshot: Readonly<Record<string, unknown>>; businessInput: unknown }) => {
            if (snapshot.artifacts === undefined) return eventRequired();
            const query = templateArtifactListInputSchema.parse(businessInput);
            const artifacts = snapshot.artifacts as readonly TemplateArtifactSnapshotDto[];
            return {
              kind: 'success' as const,
              data: templateArtifactListDataSchema.parse({
                schemaVersion: 1,
                artifacts: query.kind === undefined
                  ? [...artifacts]
                  : artifacts.filter((entry) => entry.head.artifactKind === query.kind)
              })
            };
          }
        },
        {
          reference: readRefs.get.handler,
          readCapability: readRefs.capability,
          canonicalResultSchema: readSchemas.getCanonical,
          handle: ({ snapshot, businessInput }: { snapshot: Readonly<Record<string, unknown>>; businessInput: unknown }) => {
            if (snapshot.artifacts === undefined) return eventRequired();
            const query = templateArtifactGetInputSchema.parse(businessInput);
            const artifact = (snapshot.artifacts as readonly TemplateArtifactSnapshotDto[])
              .find((entry) => entry.head.artifactId === query.artifactId);
            return artifact ? { kind: 'success' as const, data: artifact } : notFound();
          }
        }
      ],
      projections: [
        {
          reference: readRefs.list.projection,
          canonicalResultSchema: readSchemas.listCanonical,
          projectedResultSchema: readSchemas.listProjected,
          project: (candidate: unknown) => templateArtifactListCanonicalResultSchema.parse(candidate)
        },
        {
          reference: readRefs.get.projection,
          canonicalResultSchema: readSchemas.getCanonical,
          projectedResultSchema: readSchemas.getProjected,
          project: (candidate: unknown) => templateArtifactGetCanonicalResultSchema.parse(candidate)
        }
      ],
      readOperationalTraceTargets: [{
        reference: readRefs.trace, kind: 'read_operational_trace_record' as const,
        recordProfile: readRefs.record
      }],
      operationAuditTargets: [],
      operationAuditRecordProfiles: [{
        reference: readRefs.record, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      operations: operations.map(({ key, operation }) => ({
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: key === 'list' ? 'List current template authoring artifacts.' : 'Read one template authoring artifact.',
        effect: 'read' as const, maxRisk: 'low' as const,
        autonomyPolicy: readRefs[key].autonomy, consequenceTags: [],
        inputSchema: key === 'list' ? readSchemas.listInput : readSchemas.getInput,
        canonicalResultSchema: key === 'list' ? readSchemas.listCanonical : readSchemas.getCanonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'template.artifact.event_required', retryable: false, detailSchema: readSchemas.nullDetail },
          ...(key === 'get' ? [{ class: 'conflict' as const, kind: 'template.artifact.not_found', retryable: false, detailSchema: readSchemas.nullDetail }] : [])
        ],
        accessLanes: [lane], contextBuilder: readRefs[key].context,
        readCapability: readRefs.capability, handler: readRefs[key].handler,
        observability: { trace: { mode: 'required' as const, target: readRefs.trace }, immutableAudit: { mode: 'none' as const } },
        bindings: [{
          surface: 'operator_http' as const, method: 'GET' as const,
          path: key === 'list' ? TEMPLATE_ARTIFACT_LIST_PATH : TEMPLATE_ARTIFACT_GET_PATH,
          input: 'query' as const, browserResumption: { kind: 'none' as const },
          projection: readRefs[key].projection
        }]
      })),
      effectContextBuilders: [], effectHandlers: [], effectOperations: []
    })
  });
}
