import {
  API_KEY_OPERATION_SCHEMA_REFS,
  apiKeyCreateCanonicalResultSchema,
  apiKeyCreateInputSchema,
  apiKeyCreateOperationResultSchema,
  apiKeyListCanonicalResultSchema,
  apiKeyListDataSchema,
  apiKeyListInputSchema,
  apiKeyListOperationResultSchema,
  apiKeyRevokeCanonicalResultSchema,
  apiKeyRevokeInputSchema,
  apiKeyRevokeOperationResultSchema,
  apiKeyRotateCanonicalResultSchema,
  apiKeyRotateInputSchema,
  apiKeyRotateOperationResultSchema,
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type ApiKeyListDataDto,
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
  parseContractVersion,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOperationAutonomyPolicy } from './autonomy';
import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type RequestHashSealer
} from './operations';

export const API_KEY_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'policy.workspace.api-key.manage', version: parseContractVersion(1)
});
export const API_KEY_OPERATIONS = Object.freeze({
  list: Object.freeze({ name: 'workspace.api_key.list', version: 1 }),
  create: Object.freeze({ name: 'workspace.api_key.create', version: 1 }),
  rotate: Object.freeze({ name: 'workspace.api_key.rotate', version: 1 }),
  revoke: Object.freeze({ name: 'workspace.api_key.revoke', version: 1 })
});
export const API_KEY_MUTATION_HANDLER_CAPABILITY = ref('capability.workspace.api-key.mutation');
export const API_KEY_MUTATION_REQUEST_HASH_PROFILE = ref('request-hash.workspace.api-key.mutation');

type MutationAction = 'create' | 'rotate' | 'revoke';

export interface ApiKeyManagementReadPort {
  read(viewerUserId: UserId): ApiKeyListDataDto | Promise<ApiKeyListDataDto>;
}

export interface ApiKeyMutationPreparation {
  prepare(input: {
    readonly action: MutationAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): { readonly result: unknown; readonly domain: unknown; readonly effectContributions: readonly [] };
}

interface SealedPreparation {
  readonly context: EffectInvocationContext;
  readonly prepare: ApiKeyMutationPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

export function sealApiKeyMutationPreparation(input: {
  readonly context: EffectInvocationContext;
  readonly preparation: ApiKeyMutationPreparation;
}): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('api_key_mutation_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'api_key_mutation', version: 1 });
  sealedPreparations.set(snapshot, {
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
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

function createMutationHandler(input: {
  readonly action: MutationAction;
  readonly reference: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
}): EffectHandlerRegistration {
  return Object.freeze({
    reference: input.reference,
    effect: 'commit' as const,
    handlerCapability: API_KEY_MUTATION_HANDLER_CAPABILITY,
    contributionSchema: input.contributionSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed || sealed.context !== context || sealed.phase !== 'ready') {
        throw new TypeError('api_key_mutation_preparation_invalid');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ action: input.action, businessInput, context });
        if (contribution && typeof (contribution as { then?: unknown }).then === 'function') {
          throw new TypeError('api_key_mutation_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return contribution;
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

const nullDetailSchema = z.null();
export const apiKeyMutationRefusalDetailSchema = z.strictObject({
  code: z.enum(['missing', 'stale', 'not_owner', 'expired_policy'])
});
const newRecordSchema = z.strictObject({
  apiKeyId: z.string().uuid(), workspaceId: z.string().uuid(), ownerUserId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(80), tokenHashSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tokenHint: z.string().regex(/^jooak1_[A-Za-z0-9_-]{4}$/), mayRead: z.boolean(),
  maySubmitPlans: z.boolean(), permissionIds: z.array(z.string()).min(1).max(100),
  eventIds: z.array(z.string().uuid()).max(500), createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable()
});
export const apiKeyCreateDomainContributionSchema = z.strictObject({
  kind: z.literal('api_key_create'), record: newRecordSchema
});
export const apiKeyRotateDomainContributionSchema = z.strictObject({
  kind: z.literal('api_key_rotate'), predecessorId: z.string().uuid(),
  expectedVersion: z.number().int().positive(), predecessorExpiresAt: z.iso.datetime({ offset: true }),
  successor: newRecordSchema
});
export const apiKeyRevokeDomainContributionSchema = z.strictObject({
  kind: z.literal('api_key_revoke'), apiKeyId: z.string().uuid(),
  expectedVersion: z.number().int().positive(), revokedAt: z.iso.datetime({ offset: true }),
  revokedByUserId: z.string().uuid(), reason: z.enum(['rotated', 'owner_request', 'admin_request', 'security'])
});
const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(), effectContributions: z.tuple([])
}).superRefine((value, context) => {
  if (!['conflict', 'stale_revision', 'policy_violation'].includes(value.result.outcome.class)
      || value.result.outcome.kind !== 'api_key.change_refused'
      || !apiKeyMutationRefusalDetailSchema.safeParse(value.result.outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Invalid API key mutation refusal.' });
  }
});
export const apiKeyCreateContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: apiKeyCreateCanonicalResultSchema.options[0].shape.data }),
    domain: apiKeyCreateDomainContributionSchema, effectContributions: z.tuple([])
  }), outcomeContributionSchema
]);
export const apiKeyRotateContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: apiKeyRotateCanonicalResultSchema.options[0].shape.data }),
    domain: apiKeyRotateDomainContributionSchema, effectContributions: z.tuple([])
  }), outcomeContributionSchema
]);
export const apiKeyRevokeContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: apiKeyRevokeCanonicalResultSchema.options[0].shape.data }),
    domain: apiKeyRevokeDomainContributionSchema, effectContributions: z.tuple([])
  }), outcomeContributionSchema
]);

const mutationCatalog = Object.freeze({
  create: Object.freeze({
    operation: API_KEY_OPERATIONS.create, inputSchema: apiKeyCreateInputSchema,
    inputRef: API_KEY_OPERATION_SCHEMA_REFS.create.inputSchema,
    resultSchema: apiKeyCreateOperationResultSchema,
    resultRef: API_KEY_OPERATION_SCHEMA_REFS.create.resultSchema,
    canonicalSchema: apiKeyCreateCanonicalResultSchema,
    contributionSchema: apiKeyCreateContributionSchema,
    path: '/api/workspace/api-keys/create', summary: 'Created an API key'
  }),
  rotate: Object.freeze({
    operation: API_KEY_OPERATIONS.rotate, inputSchema: apiKeyRotateInputSchema,
    inputRef: API_KEY_OPERATION_SCHEMA_REFS.rotate.inputSchema,
    resultSchema: apiKeyRotateOperationResultSchema,
    resultRef: API_KEY_OPERATION_SCHEMA_REFS.rotate.resultSchema,
    canonicalSchema: apiKeyRotateCanonicalResultSchema,
    contributionSchema: apiKeyRotateContributionSchema,
    path: '/api/workspace/api-keys/rotate', summary: 'Rotated an API key'
  }),
  revoke: Object.freeze({
    operation: API_KEY_OPERATIONS.revoke, inputSchema: apiKeyRevokeInputSchema,
    inputRef: API_KEY_OPERATION_SCHEMA_REFS.revoke.inputSchema,
    resultSchema: apiKeyRevokeOperationResultSchema,
    resultRef: API_KEY_OPERATION_SCHEMA_REFS.revoke.resultSchema,
    canonicalSchema: apiKeyRevokeCanonicalResultSchema,
    contributionSchema: apiKeyRevokeContributionSchema,
    path: '/api/workspace/api-keys/revoke', summary: 'Revoked an API key'
  })
});

/** Human-only API-key management. No machine binding and no agent-action eligibility exist. */
export function createApiKeyOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly read: ApiKeyManagementReadPort;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  if (input.policy.key !== API_KEY_MANAGE_ACCESS_POLICY.key
      || input.policy.version !== API_KEY_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('api_key_manage_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policy
  });
  const scopeResolver = workspaceScope(workspaceId);
  const readRefs = Object.freeze({
    autonomy: ref('autonomy.workspace.api-key.list'), context: ref('context.workspace.api-key.list'),
    capability: ref('capability.workspace.api-key.list'), handler: ref('handler.workspace.api-key.list'),
    projection: ref('projection.workspace.api-key.list'), trace: ref('trace.workspace.api-key.list')
  });
  const readContext = createReadInvocationContextBuilder({
    reference: readRefs.context, operation: API_KEY_OPERATIONS.list, effect: 'read', lanes: [lane],
    scopeResolver, authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const readAutonomy = createOperationAutonomyPolicy({
    definition: readRefs.autonomy, operation: API_KEY_OPERATIONS.list,
    riskFloor: 'consequential', unattendedRiskCeiling: 'normal',
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval', approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry', ambiguous_external_effect: 'reconcile', stale_plan: 'replan', compensation_required: 'compensate', terminal_failure: 'attention' },
    requiresSeparateApproval: false
  });
  const mutationEntries = (Object.keys(mutationCatalog) as MutationAction[]).map((action) => {
    const catalog = mutationCatalog[action];
    const base = catalog.operation.name;
    const refs = Object.freeze({
      autonomy: ref(`autonomy.${base}`), context: ref(`context.${base}`), handler: ref(`handler.${base}`),
      projection: ref(`projection.${base}`), family: ref(`family.${base}`), phase: ref(`phase.${base}`),
      terminalization: ref(`terminalization.${base}`), risk: ref(`risk.${base}`),
      evidence: ref(`evidence.${base}`), approval: ref(`approval.${base}`), preflight: ref(`preflight.${base}`),
      concurrency: ref('concurrency.workspace.api-key'), keySource: ref('idempotency.operator-header')
    });
    const schemas = Object.freeze({
      contribution: createSafeSchemaManifestRef(`schema.${base}.contribution`, catalog.contributionSchema),
      canonical: createSafeSchemaManifestRef(`schema.${base}.canonical-result`, catalog.canonicalSchema)
    });
    const autonomy = createOperationAutonomyPolicy({
      definition: refs.autonomy, operation: catalog.operation,
      riskFloor: 'consequential', unattendedRiskCeiling: 'consequential',
      supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
      triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval', approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry', ambiguous_external_effect: 'reconcile', stale_plan: 'replan', compensation_required: 'compensate', terminal_failure: 'attention' },
      requiresSeparateApproval: false
    });
    const context = createEffectInvocationContextBuilder({
      reference: refs.context, operation: catalog.operation, effect: 'commit', lanes: [lane],
      scopeResolver, authorityResolver: input.currentAuthority, clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: API_KEY_MUTATION_REQUEST_HASH_PROFILE,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
    const terminalization = createTerminalizationResolverRegistration({
      reference: refs.terminalization, operation: catalog.operation, phase: refs.phase,
      resolve: ({ result }) => result.kind === 'success'
        || (result.kind === 'outcome'
          && result.outcomeKind === 'api_key.change_refused'
          && ['conflict', 'stale_revision', 'policy_violation'].includes(result.outcomeClass))
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.phase, family: refs.family, operation: catalog.operation, effect: 'commit',
      handler: refs.handler, handlerCapability: API_KEY_MUTATION_HANDLER_CAPABILITY,
      contributionSchema: schemas.contribution, terminalization: refs.terminalization,
      terminalOutcomeKeys: [
        'conflict:api_key.change_refused',
        'stale_revision:api_key.change_refused',
        'policy_violation:api_key.change_refused'
      ],
      contentionOutcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 }
    });
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk, operation: catalog.operation,
      resolve: () => ({ risk: 'consequential', consequenceTags: ['machine-credential-changed'], evidenceIds: [`${base}.risk`] })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence, operation: catalog.operation,
      resolve: ({ subject }) => {
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]),
          maximumSpendMicros: 0, maximumActions: 1,
          notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
        });
        return {
          evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
          spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
          proposedAction: { key: `${base}.execute`, version: 1, digestSha256: subject.requestHashSha256 },
          failure: { kind: 'none' as const }
        };
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: refs.approval, operation: catalog.operation,
      resolve: () => ({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: refs.preflight, operation: catalog.operation, policy: refs.autonomy,
      riskResolver: refs.risk, evidenceResolver: refs.evidence,
      approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return Object.freeze({ action, catalog, refs, schemas, autonomy, context, family, terminalization, phase, risk, evidence, approval, preflight });
  });
  const nullRef = createSafeSchemaManifestRef('schema.workspace.api-key.null-detail', nullDetailSchema);
  const refusalRef = createSafeSchemaManifestRef('schema.workspace.api-key.refusal-detail', apiKeyMutationRefusalDetailSchema);
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: nullRef
  }));
  const audit = ref('audit.workspace.api-key');
  const record = ref('record-profile.workspace.api-key');
  return Object.freeze({
    id: 'workspace.api-key.operations',
    source: Object.freeze({
      autonomyPolicies: [readAutonomy, ...mutationEntries.map((entry) => entry.autonomy)],
      schemas: [
        { reference: API_KEY_OPERATION_SCHEMA_REFS.list.inputSchema, schema: apiKeyListInputSchema },
        { reference: API_KEY_OPERATION_SCHEMA_REFS.list.resultSchema, schema: apiKeyListOperationResultSchema },
        { reference: createSafeSchemaManifestRef('schema.workspace.api-key.list.canonical-result', apiKeyListCanonicalResultSchema), schema: apiKeyListCanonicalResultSchema },
        { reference: nullRef, schema: nullDetailSchema }, { reference: refusalRef, schema: apiKeyMutationRefusalDetailSchema },
        ...mutationEntries.flatMap((entry) => [
          { reference: entry.catalog.inputRef, schema: entry.catalog.inputSchema },
          { reference: entry.catalog.resultRef, schema: entry.catalog.resultSchema },
          { reference: entry.schemas.canonical, schema: entry.catalog.canonicalSchema },
          { reference: entry.schemas.contribution, schema: entry.catalog.contributionSchema }
        ])
      ],
      contextBuilders: [readContext],
      readCapabilities: [{
        reference: readRefs.capability,
        openSnapshot(context) {
          if (context.actor.kind !== 'workspace_user') throw new TypeError('api_key_read_actor_invalid');
          return Object.freeze({ viewerUserId: context.actor.userId });
        }
      } satisfies ReadCapabilityRegistration],
      handlers: [{
        reference: readRefs.handler, readCapability: readRefs.capability,
        canonicalResultSchema: createSafeSchemaManifestRef('schema.workspace.api-key.list.canonical-result', apiKeyListCanonicalResultSchema),
        async handle({ snapshot }: Parameters<import('./operations').ReadHandlerRegistration['handle']>[0]) {
          return { kind: 'success', data: await input.read.read(snapshot.viewerUserId as UserId) };
        }
      }],
      projections: [{
        reference: readRefs.projection,
        canonicalResultSchema: createSafeSchemaManifestRef('schema.workspace.api-key.list.canonical-result', apiKeyListCanonicalResultSchema),
        projectedResultSchema: API_KEY_OPERATION_SCHEMA_REFS.list.resultSchema,
        project: (candidate: unknown) => apiKeyListCanonicalResultSchema.parse(candidate)
      }, ...mutationEntries.map((entry) => ({
        reference: entry.refs.projection, canonicalResultSchema: entry.schemas.canonical,
        projectedResultSchema: entry.catalog.resultRef,
        project: (candidate: unknown) => entry.catalog.canonicalSchema.parse(candidate)
      }))],
      readOperationalTraceTargets: [{ reference: readRefs.trace, kind: 'read_operational_trace_record' as const, recordProfile: record }],
      operationAuditTargets: [{ reference: audit, kind: 'operation_audit_record' as const, recordProfile: record }],
      operationAuditRecordProfiles: [{ reference: record, kind: 'canonical_json' as const, maximumBytes: 131_072 }],
      operations: [{
        ...API_KEY_OPERATIONS.list, lifecycle: { status: 'active' as const },
        summary: 'List human-managed external API keys.', effect: 'read' as const,
        maxRisk: 'consequential' as const, autonomyPolicy: readRefs.autonomy, consequenceTags: [],
        inputSchema: API_KEY_OPERATION_SCHEMA_REFS.list.inputSchema,
        canonicalResultSchema: createSafeSchemaManifestRef('schema.workspace.api-key.list.canonical-result', apiKeyListCanonicalResultSchema),
        outcomes: accessOutcomes, accessLanes: [lane], contextBuilder: readRefs.context,
        readCapability: readRefs.capability, handler: readRefs.handler,
        observability: { trace: { mode: 'required' as const, target: readRefs.trace }, immutableAudit: { mode: 'none' as const } },
        bindings: [{ surface: 'operator_http' as const, method: 'GET' as const,
          path: '/api/workspace/api-keys', input: 'query' as const,
          browserResumption: { kind: 'none' as const }, projection: readRefs.projection }]
      }],
      effectExecutionFamilies: mutationEntries.map((entry) => entry.family),
      effectPhases: mutationEntries.map((entry) => entry.phase),
      terminalizationResolvers: mutationEntries.map((entry) => entry.terminalization),
      riskResolvers: mutationEntries.map((entry) => entry.risk),
      autonomyEvidenceResolvers: mutationEntries.map((entry) => entry.evidence),
      renewedApprovalResolvers: mutationEntries.map((entry) => entry.approval),
      autonomyPreflights: mutationEntries.map((entry) => entry.preflight),
      effectContextBuilders: mutationEntries.map((entry) => entry.context),
      effectHandlers: mutationEntries.map((entry) => createMutationHandler({
        action: entry.action, reference: entry.refs.handler,
        contributionSchema: entry.schemas.contribution, canonicalResultSchema: entry.schemas.canonical
      })),
      effectOperations: mutationEntries.map((entry) => ({
        ...entry.catalog.operation, lifecycle: { status: 'active' as const },
        summary: `Human-only ${entry.action} API key operation.`, effect: 'commit' as const,
        maxRisk: 'consequential' as const, autonomyPolicy: entry.refs.autonomy,
        consequenceTags: ['machine-credential-changed'], inputSchema: entry.catalog.inputRef,
        contributionSchema: entry.schemas.contribution, canonicalResultSchema: entry.schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: nullRef },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'api_key.change_refused', retryable: false, detailSchema: refusalRef },
          { class: 'stale_revision' as const, kind: 'api_key.change_refused', retryable: false, detailSchema: refusalRef },
          { class: 'policy_violation' as const, kind: 'api_key.change_refused', retryable: false, detailSchema: refusalRef },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: nullRef },
          ...autonomyInterventionOutcomeDeclarations(nullRef)
        ],
        accessLanes: [lane], contextBuilder: entry.refs.context,
        handlerCapability: API_KEY_MUTATION_HANDLER_CAPABILITY, handler: entry.refs.handler,
        audit: { mode: 'required' as const, target: audit },
        idempotency: { keySource: entry.refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: API_KEY_MUTATION_REQUEST_HASH_PROFILE },
        concurrency: entry.refs.concurrency,
        execution: { kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const,
          family: entry.refs.family, phase: entry.refs.phase,
          terminalization: entry.refs.terminalization, autonomyPreflight: entry.refs.preflight,
          history: { summary: entry.catalog.summary } },
        bindings: [{ surface: 'operator_http' as const, method: 'POST' as const,
          path: entry.catalog.path, input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: entry.refs.projection }]
      }))
    })
  });
}
