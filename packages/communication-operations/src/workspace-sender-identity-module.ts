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
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
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
  WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS,
  workspaceSenderIdentityCanonicalResultSchema,
  workspaceSenderIdentityReadInputSchema,
  workspaceSenderIdentityReadResultSchema,
  workspaceSenderIdentityRefusalDetailSchema,
  workspaceSenderIdentitySchema,
  workspaceSenderIdentityStaleDetailSchema,
  workspaceSenderIdentityUpdateInputSchema,
  workspaceSenderIdentityUpdateResultSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef,
  type WorkspaceSenderIdentityDto
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
  isApplicationId,
  parseContractVersion,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

/**
 * The workspace-scoped outbound sender-identity pair: read the presentation the
 * next send will use, and update the two workspace-editable pieces of it.
 *
 * Authorization reuses `communication.provider.manage` (through
 * `policy.communication.provider.manage`, which the operator authority
 * composition already maps to it). That permission's declared meaning is
 * "read and manage email provider connections, readiness, SENDER PROFILES, and
 * routing" — this setting is exactly a sender profile, so a new permission id
 * would split one responsibility across two grants and hand some role the sender
 * presentation without the provider it sends through.
 *
 * The from-address is deliberately absent from the update input: it is
 * per-installation configuration, because moving it per workspace breaks
 * SPF/DKIM alignment.
 */

export const WORKSPACE_SENDER_IDENTITY_READ_OPERATION = Object.freeze({
  name: 'communication.sender_identity.read', version: 1
});
export const WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION = Object.freeze({
  name: 'communication.sender_identity.update', version: 1
});

export const WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'policy.communication.provider.manage',
  version: parseContractVersion(1)
});

/** The permission every lane of this pair evaluates at the server boundary. */
export const WORKSPACE_SENDER_IDENTITY_PERMISSION_ID = 'communication.provider.manage';

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

export const WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY = ref(
  'capability.communication.sender-identity.update'
);
export const WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE = ref(
  'request-hash.communication.sender-identity.update'
);

const applicationIdSchema = z.string().refine(isApplicationId);
const canonicalInstantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
});

export const workspaceSenderIdentityDomainContributionSchema = z.strictObject({
  kind: z.literal('workspace_sender_identity_update'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  headVersion: z.number().int().positive().safe(),
  occurredAt: canonicalInstantSchema
});

export const workspaceSenderIdentityFactChildSchema = z.strictObject({
  kind: z.literal('domain_fact'),
  factId: applicationIdSchema,
  factKind: z.literal('workspace_sender_identity_changed'),
  payload: z.strictObject({
    headVersion: z.number().int().positive().safe(),
    displayNameSet: z.boolean(),
    replyToAddressSet: z.boolean()
  }),
  occurredAt: canonicalInstantSchema
});

const successContributionSchema = z.strictObject({
  result: z.strictObject({
    kind: z.literal('success'),
    data: workspaceSenderIdentitySchema
  }),
  domain: workspaceSenderIdentityDomainContributionSchema,
  effectContributions: z.tuple([workspaceSenderIdentityFactChildSchema])
}).superRefine((contribution, context) => {
  const { data } = contribution.result;
  const fact = contribution.effectContributions[0];
  if (data.workspaceId !== contribution.domain.workspaceId
      || data.headVersion !== contribution.domain.headVersion
      || fact.payload.headVersion !== contribution.domain.headVersion
      || fact.payload.displayNameSet !== (data.displayName !== null)
      || fact.payload.replyToAddressSet !== (data.replyToAddress !== null)
      || fact.occurredAt !== contribution.domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Sender identity evidence is incoherent.' });
  }
});

const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const key = `${outcome.class}:${outcome.kind}`;
  const detail = key === 'policy_violation:communication.sender_identity_refused'
    ? workspaceSenderIdentityRefusalDetailSchema
    : workspaceSenderIdentityStaleDetailSchema;
  if (!['policy_violation:communication.sender_identity_refused',
    'stale_revision:communication.sender_identity_changed'].includes(key)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detail.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Sender identity refusal is invalid.' });
  }
});

export const workspaceSenderIdentityContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);

export type WorkspaceSenderIdentityContribution = z.infer<
  typeof workspaceSenderIdentityContributionSchema
>;

// ---------------------------------------------------------------------------
// Sealed preparation seam (adapter-owned, transaction-bound)
// ---------------------------------------------------------------------------

export interface WorkspaceSenderIdentityPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

export interface WorkspaceSenderIdentityPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): WorkspaceSenderIdentityPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: WorkspaceSenderIdentityPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealWorkspaceSenderIdentityPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: WorkspaceSenderIdentityPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('workspace_sender_identity_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('workspace_sender_identity_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'workspace_sender_identity', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createUpdateHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({
    ...WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY
  });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: 'commit',
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_workspace_sender_identity_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution
            && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('workspace_sender_identity_preparation_must_be_synchronous');
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

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export interface WorkspaceSenderIdentityReadPort {
  readSenderIdentity(workspaceId: WorkspaceId):
    | WorkspaceSenderIdentityDto
    | Promise<WorkspaceSenderIdentityDto>;
}

export interface WorkspaceSenderIdentityOperationIds {
  newInvocationId(): InvocationId;
}

export interface WorkspaceSenderIdentityOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export interface CreateWorkspaceSenderIdentityOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly read: WorkspaceSenderIdentityReadPort;
  readonly clock: Clock;
  readonly ids: WorkspaceSenderIdentityOperationIds;
  readonly crypto: WorkspaceSenderIdentityOperationCrypto;
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

function autonomyFor(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition,
    operation,
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
}

const nullDetailSchema = z.null();

const schemas = Object.freeze({
  readInput: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.read.inputSchema,
  readProjected: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.read.resultSchema,
  updateInput: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.update.inputSchema,
  updateProjected: WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.update.resultSchema,
  canonical: schemaRef(
    'schema.communication.sender-identity.canonical-result',
    workspaceSenderIdentityCanonicalResultSchema
  ),
  contribution: schemaRef(
    'schema.communication.sender-identity.update.contribution',
    workspaceSenderIdentityContributionSchema
  ),
  nullDetail: schemaRef('schema.communication.sender-identity.null-detail', nullDetailSchema),
  refusalDetail: schemaRef(
    'schema.communication.sender-identity.refusal-detail',
    workspaceSenderIdentityRefusalDetailSchema
  ),
  staleDetail: schemaRef(
    'schema.communication.sender-identity.stale-detail',
    workspaceSenderIdentityStaleDetailSchema
  )
});

const refs = Object.freeze({
  readAutonomy: ref('autonomy.communication.sender-identity.read'),
  readContext: ref('context.communication.sender-identity.read'),
  readCapability: ref('capability.communication.sender-identity.read'),
  readHandler: ref('handler.communication.sender-identity.read'),
  readProjection: ref('projection.communication.sender-identity.read'),
  trace: ref('trace.communication.sender-identity.read'),
  readAudit: ref('audit.communication.sender-identity.read'),
  updateAutonomy: ref('autonomy.communication.sender-identity.update'),
  updateContext: ref('context.communication.sender-identity.update'),
  updateHandler: ref('handler.communication.sender-identity.update'),
  updateProjection: ref('projection.communication.sender-identity.update'),
  updateAudit: ref('audit.communication.sender-identity.update'),
  keySource: ref('idempotency.operator-header'),
  concurrency: ref('concurrency.communication.sender-identity.workspace'),
  family: ref('communication.sender-identity.update.execution-family'),
  phase: ref('communication.sender-identity.update.phase.single-uow'),
  terminalization: ref('communication.sender-identity.update.terminalization'),
  risk: ref('communication.sender-identity.update.risk-resolver'),
  autonomyEvidence: ref('communication.sender-identity.update.autonomy-evidence'),
  approval: ref('communication.sender-identity.update.approval-resolver'),
  preflight: ref('communication.sender-identity.update.autonomy-preflight'),
  recordProfile: ref('record-profile.communication.sender-identity')
});

/** Registers the read projection and the permission-gated commit, on both lanes. */
export function createWorkspaceSenderIdentityOperationModule(
  input: CreateWorkspaceSenderIdentityOperationModuleInput
): OperationRegistryModule {
  if (input.policy.key !== WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.key
      || input.policy.version !== WORKSPACE_SENDER_IDENTITY_ACCESS_POLICY.version) {
    throw new TypeError('workspace_sender_identity_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const scopeResolver = workspaceScopeResolver(workspaceId);
  const readLanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy }),
    parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy: input.policy })
  ]);
  // The read is consumed identically by the browser and by MCP agents. The
  // update is operator-lane only, and not by choice of this module: the
  // platform forbids app_model access on commit operations (agents draft,
  // people commit), and the external MCP surface carries no effect binding
  // vocabulary at all. An agent-authored sender change therefore needs the
  // reviewed sender-configuration loop, which is a separate decision, not one this module
  // resolves silently.
  const updateLanes = Object.freeze([
    parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policy })
  ]);
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));

  const readAutonomy = autonomyFor(WORKSPACE_SENDER_IDENTITY_READ_OPERATION, refs.readAutonomy);
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext,
    operation: WORKSPACE_SENDER_IDENTITY_READ_OPERATION,
    effect: 'read',
    lanes: readLanes,
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const readCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.readCapability,
    openSnapshot: async (context: ReadInvocationContext) => {
      if (context.scope.workspaceId !== workspaceId || context.scope.eventId !== undefined) {
        throw new TypeError('workspace_sender_identity_read_scope_mismatch');
      }
      return Object.freeze({ identity: await input.read.readSenderIdentity(workspaceId) });
    }
  });

  const updateAutonomy = autonomyFor(
    WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION, refs.updateAutonomy
  );
  const updateContext = createEffectInvocationContextBuilder({
    reference: refs.updateContext,
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
    effect: 'commit',
    lanes: updateLanes,
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    requestHashProfile: WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE,
    requestHashSealer: input.crypto.requestHashSealer,
    idempotencyCredentialProfile: input.crypto.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.crypto.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.family, phase: refs.phase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
    effect: 'commit',
    handler: refs.updateHandler,
    handlerCapability: WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY,
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
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
    resolve: () => Object.freeze({
      risk: 'normal' as const,
      consequenceTags: Object.freeze(['sender-identity-changed']),
      evidenceIds: Object.freeze(['communication.sender_identity.update.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
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
          key: 'communication.sender_identity.update.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
    policy: refs.updateAutonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.autonomyEvidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const updateHandler = createUpdateHandler({
    reference: refs.updateHandler,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });

  return Object.freeze({
    id: 'communication.sender-identity-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([readAutonomy, updateAutonomy]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: workspaceSenderIdentityReadInputSchema },
        { reference: schemas.readProjected, schema: workspaceSenderIdentityReadResultSchema },
        { reference: schemas.updateInput, schema: workspaceSenderIdentityUpdateInputSchema },
        { reference: schemas.updateProjected, schema: workspaceSenderIdentityUpdateResultSchema },
        { reference: schemas.canonical, schema: workspaceSenderIdentityCanonicalResultSchema },
        { reference: schemas.contribution, schema: workspaceSenderIdentityContributionSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.refusalDetail, schema: workspaceSenderIdentityRefusalDetailSchema },
        { reference: schemas.staleDetail, schema: workspaceSenderIdentityStaleDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: refs.readHandler,
        readCapability: refs.readCapability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => ({
          kind: 'success' as const,
          data: workspaceSenderIdentitySchema.parse(snapshot.identity)
        })
      }]),
      projections: Object.freeze([
        {
          reference: refs.readProjection,
          canonicalResultSchema: schemas.canonical,
          projectedResultSchema: schemas.readProjected,
          project: (candidate: unknown) =>
            workspaceSenderIdentityCanonicalResultSchema.parse(candidate)
        },
        {
          reference: refs.updateProjection,
          canonicalResultSchema: schemas.canonical,
          projectedResultSchema: schemas.updateProjected,
          project: (candidate: unknown) =>
            workspaceSenderIdentityCanonicalResultSchema.parse(candidate)
        }
      ]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.recordProfile
      }]),
      operationAuditTargets: Object.freeze([
        {
          reference: refs.readAudit,
          kind: 'operation_audit_record' as const,
          recordProfile: refs.recordProfile
        },
        {
          reference: refs.updateAudit,
          kind: 'operation_audit_record' as const,
          recordProfile: refs.recordProfile
        }
      ]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.recordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...WORKSPACE_SENDER_IDENTITY_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the outbound sender presentation the next message will use.',
        effect: 'read' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: refs.readAutonomy,
        consequenceTags: [],
        inputSchema: schemas.readInput,
        canonicalResultSchema: schemas.canonical,
        outcomes: accessOutcomes,
        accessLanes: readLanes,
        contextBuilder: refs.readContext,
        readCapability: refs.readCapability,
        handler: refs.readHandler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: {
            mode: 'external_mcp_app_model' as const,
            target: refs.readAudit
          }
        },
        bindings: [
          {
            surface: 'operator_http' as const,
            method: 'GET' as const,
            path: '/api/communications/sender-identity',
            input: 'query' as const,
            browserResumption: { kind: 'none' as const },
            projection: refs.readProjection
          },
          {
            surface: 'external_mcp' as const,
            toolName: 'get_email_sender_identity',
            projection: refs.readProjection
          }
        ]
      }]),
      effectExecutionFamilies: Object.freeze([family]),
      effectPhases: Object.freeze([phase]),
      terminalizationResolvers: Object.freeze([terminalization]),
      riskResolvers: Object.freeze([risk]),
      autonomyEvidenceResolvers: Object.freeze([autonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([approval]),
      autonomyPreflights: Object.freeze([preflight]),
      effectContextBuilders: Object.freeze([updateContext]),
      effectHandlers: Object.freeze([updateHandler]),
      effectOperations: Object.freeze([{
        ...WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Set the workspace sender display name and reply-to address.',
        effect: 'commit' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: refs.updateAutonomy,
        consequenceTags: ['sender-identity-changed'],
        inputSchema: schemas.updateInput,
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
            class: 'policy_violation' as const,
            kind: 'communication.sender_identity_refused',
            retryable: false,
            detailSchema: schemas.refusalDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'communication.sender_identity_changed',
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
        accessLanes: updateLanes,
        contextBuilder: refs.updateContext,
        handlerCapability: WORKSPACE_SENDER_IDENTITY_UPDATE_HANDLER_CAPABILITY,
        handler: refs.updateHandler,
        audit: { mode: 'required' as const, target: refs.updateAudit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: WORKSPACE_SENDER_IDENTITY_UPDATE_REQUEST_HASH_PROFILE
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
          path: '/api/communications/sender-identity',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.updateProjection
        }]
      }])
    })
  });
}
