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
  createTerminalizationResolverRegistration
} from './operations';
import { createOperationAutonomyPolicy } from './autonomy';
import type {
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext,
  IdempotencyCredentialSealer,
  InvocationEvidence,
  InvocationScopeResolver,
  OperationRegistryModule,
  ReadCapabilityRegistration,
  ReadInvocationContext,
  RequestHashSealer
} from './operations';
import {
  WORKSPACE_TEAM_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  workspaceTeamMutationCanonicalResultSchema,
  workspaceTeamMutationDataSchema,
  workspaceTeamMutationOperationResultSchema,
  workspaceTeamInviteInputSchema,
  workspaceTeamMembersCanonicalResultSchema,
  workspaceTeamMembersReadInputSchema,
  workspaceTeamMembersReadResultSchema,
  workspaceTeamRemovalInputSchema,
  workspaceTeamRoleChangeInputSchema,
  workspaceTeamSnapshotSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef,
  type WorkspaceTeamMutationData,
  type WorkspaceTeamSnapshot
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  WORKSPACE_TEAM_PERMISSIONS,
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
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

export type WorkspaceTeamMutationAction = 'invite' | 'change_role' | 'remove';

export const WORKSPACE_TEAM_MEMBERS_READ_OPERATION = Object.freeze({
  name: 'workspace_team.members.read', version: 1
});
export const WORKSPACE_TEAM_INVITE_OPERATION = Object.freeze({
  name: 'workspace_team.invite', version: 1
});
export const WORKSPACE_TEAM_ROLE_CHANGE_OPERATION = Object.freeze({
  name: 'workspace_team.role_change', version: 1
});
export const WORKSPACE_TEAM_REMOVAL_OPERATION = Object.freeze({
  name: 'workspace_team.remove', version: 1
});

export const WORKSPACE_TEAM_OPERATION_ACCESS = Object.freeze({
  read: Object.freeze({
    policy: { key: 'authority.workspace_team.members.read', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.read
  }),
  invite: Object.freeze({
    policy: { key: 'authority.workspace_team.invite', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.invite
  }),
  changeRole: Object.freeze({
    policy: { key: 'authority.workspace_team.role_change', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.changeRole
  }),
  remove: Object.freeze({
    policy: { key: 'authority.workspace_team.remove', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.remove
  })
});

export const WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE = ref(
  'request-hash.workspace_team.mutation'
);
export const WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY = ref(
  'capability.workspace_team.direct_mutation'
);

const applicationIdSchema = z.string().uuid();
const instantSchema = z.iso.datetime({ offset: true });

export const workspaceTeamMutationDomainContributionSchema = z.strictObject({
  kind: z.literal('workspace_team_direct_mutation'),
  preparationHandle: applicationIdSchema,
  action: z.enum(['invite', 'change_role', 'remove']),
  workspaceId: applicationIdSchema,
  resultingTeamVersion: z.number().int().positive(),
  occurredAt: instantSchema
});

export const workspaceTeamMutationRefusalDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_team', 'subject_missing', 'stale_subject',
    'role_unavailable', 'unsupported_assignment', 'duplicate_invitation',
    'current_actor_role_change', 'current_actor_removal', 'last_owner',
    'recipient_invalid', 'recipient_collision', 'policy_changed'
  ]),
  action: z.enum(['invite', 'change_role', 'remove'])
});

const successContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: workspaceTeamMutationDataSchema }),
  domain: workspaceTeamMutationDomainContributionSchema,
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const { data } = contribution.result;
  const { domain } = contribution;
  if (data.action !== domain.action
      || data.teamVersion !== domain.resultingTeamVersion) {
    context.addIssue({ code: 'custom', message: 'Workspace team mutation evidence is incoherent.' });
  }
});

const allowedMutationOutcomes = new Set([
  'conflict:workspace_team.change_refused',
  'stale_revision:workspace_team.change_refused',
  'policy_violation:workspace_team.change_refused'
]);
const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const validDetail = workspaceTeamMutationRefusalDetailSchema.safeParse(outcome.detail).success;
  if (!allowedMutationOutcomes.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable || outcome.detailSchemaVersion !== 1 || !validDetail) {
    context.addIssue({ code: 'custom', message: 'Workspace team mutation refusal is invalid.' });
  }
});

export const workspaceTeamMutationContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);
export type WorkspaceTeamMutationContribution =
  z.infer<typeof workspaceTeamMutationContributionSchema>;

export interface WorkspaceTeamReadPort {
  readWorkspaceTeam(workspaceId: WorkspaceId): WorkspaceTeamSnapshot;
}

export interface WorkspaceTeamMutationPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly effectContributions: readonly unknown[];
}

export interface WorkspaceTeamMutationPreparation {
  prepare(input: {
    readonly action: WorkspaceTeamMutationAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): WorkspaceTeamMutationPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: WorkspaceTeamMutationPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealWorkspaceTeamMutationPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: WorkspaceTeamMutationPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('workspace_team_mutation_preparation_invalid');
  }
  const snapshot = Object.freeze({ strategy: 'workspace_team_direct_mutation', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createMutationHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
}): EffectHandlerRegistration {
  const capability = WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY;
  return Object.freeze({
    reference: input.reference,
    effect: 'commit' as const,
    handlerCapability: capability,
    contributionSchema: input.contributionSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      const action = workspaceTeamMutationActionForOperation(
        context.operation.name, context.operation.version
      );
      if (!sealed || !sameReference(sealed.capability, capability)
          || sealed.context !== context || sealed.phase !== 'ready' || !action) {
        throw new TypeError('workspace_team_mutation_preparation_invalid');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ action, businessInput, context });
        if (contribution && typeof (contribution as { then?: unknown }).then === 'function') {
          throw new TypeError('workspace_team_mutation_preparation_must_be_synchronous');
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

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, 1);
}

const schemas = Object.freeze({
  readInput: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.members.inputSchema,
  readCanonical: schemaRef(
    'schema.workspace_team.members-read.canonical-result',
    workspaceTeamMembersCanonicalResultSchema
  ),
  readProjected: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.members.resultSchema,
  mutationContribution: schemaRef(
    'schema.workspace_team.mutation.contribution',
    workspaceTeamMutationContributionSchema
  ),
  mutationCanonical: schemaRef(
    'schema.workspace_team.mutation.canonical-result',
    workspaceTeamMutationCanonicalResultSchema
  ),
  mutationProjected: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite.resultSchema,
  nullDetail: schemaRef('schema.workspace_team.operation.null-detail', z.null()),
  refusalDetail: schemaRef(
    'schema.workspace_team.mutation-refusal.detail', workspaceTeamMutationRefusalDetailSchema
  ),
  inviteInput: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite.inputSchema,
  roleInput: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.roleChange.inputSchema,
  removalInput: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.removal.inputSchema
});

const commonRefs = Object.freeze({
  readContext: ref('context.workspace_team.members-read'),
  readAutonomy: ref('autonomy.workspace_team.members-read'),
  readCapability: ref('capability.workspace_team.members-read'),
  readHandler: ref('handler.workspace_team.members-read'),
  readProjection: ref('projection.workspace_team.members-read.operator'),
  readTrace: ref('trace.workspace_team.members-read'),
  mutationHandler: ref('handler.workspace_team.direct-mutation'),
  mutationProjection: ref('projection.workspace_team.mutation.operator'),
  audit: ref('audit.workspace_team.mutation'),
  auditRecordProfile: ref('record-profile.workspace_team.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: WORKSPACE_TEAM_MUTATION_REQUEST_HASH_PROFILE
});

const mutationEntries = Object.freeze([
  {
    action: 'invite' as const,
    operation: WORKSPACE_TEAM_INVITE_OPERATION,
    inputSchema: workspaceTeamInviteInputSchema,
    inputRef: schemas.inviteInput,
    access: WORKSPACE_TEAM_OPERATION_ACCESS.invite,
    path: '/api/workspace/team/invitations'
  },
  {
    action: 'change_role' as const,
    operation: WORKSPACE_TEAM_ROLE_CHANGE_OPERATION,
    inputSchema: workspaceTeamRoleChangeInputSchema,
    inputRef: schemas.roleInput,
    access: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole,
    path: '/api/workspace/team/role-changes'
  },
  {
    action: 'remove' as const,
    operation: WORKSPACE_TEAM_REMOVAL_OPERATION,
    inputSchema: workspaceTeamRemovalInputSchema,
    inputRef: schemas.removalInput,
    access: WORKSPACE_TEAM_OPERATION_ACCESS.remove,
    path: '/api/workspace/team/removals'
  }
]);

interface MutationRefs {
  readonly context: VersionedDefinitionRef;
  readonly autonomy: VersionedDefinitionRef;
  readonly executionFamily: VersionedDefinitionRef;
  readonly executionPhase: VersionedDefinitionRef;
  readonly concurrency: VersionedDefinitionRef;
  readonly terminalization: VersionedDefinitionRef;
  readonly risk: VersionedDefinitionRef;
  readonly evidence: VersionedDefinitionRef;
  readonly approval: VersionedDefinitionRef;
  readonly preflight: VersionedDefinitionRef;
}

function refsFor(action: WorkspaceTeamMutationAction): MutationRefs {
  return Object.freeze({
    context: ref(`context.workspace_team.${action}`),
    autonomy: ref(`autonomy.workspace_team.${action}`),
    executionFamily: ref(`workspace_team.${action}.execution-family`),
    executionPhase: ref(`workspace_team.${action}.phase.direct-uow`),
    concurrency: ref(`concurrency.workspace_team.${action}`),
    terminalization: ref(`workspace_team.${action}.terminalization`),
    risk: ref(`workspace_team.${action}.risk-resolver`),
    evidence: ref(`workspace_team.${action}.autonomy-evidence`),
    approval: ref(`workspace_team.${action}.approval-resolver`),
    preflight: ref(`workspace_team.${action}.autonomy-preflight`)
  });
}

export interface WorkspaceTeamOperationPolicies {
  readonly read: VersionedAccessPolicyRef;
  readonly invite: VersionedAccessPolicyRef;
  readonly changeRole: VersionedAccessPolicyRef;
  readonly remove: VersionedAccessPolicyRef;
}

export interface CreateWorkspaceTeamOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: WorkspaceTeamOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly teamRead: WorkspaceTeamReadPort;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function exactPolicy(actual: VersionedAccessPolicyRef, expected: VersionedAccessPolicyRef): boolean {
  return actual.key === expected.key && actual.version === expected.version;
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

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function autonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition, operation,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
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

export function workspaceTeamMutationActionForOperation(
  operationName: string,
  operationVersion: number
): WorkspaceTeamMutationAction | undefined {
  return mutationEntries.find(({ operation }) =>
    operation.name === operationName && operation.version === operationVersion
  )?.action;
}

export function createWorkspaceTeamOperationModule(
  input: CreateWorkspaceTeamOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!exactPolicy(input.policies.read, WORKSPACE_TEAM_OPERATION_ACCESS.read.policy)
      || !exactPolicy(input.policies.invite, WORKSPACE_TEAM_OPERATION_ACCESS.invite.policy)
      || !exactPolicy(input.policies.changeRole, WORKSPACE_TEAM_OPERATION_ACCESS.changeRole.policy)
      || !exactPolicy(input.policies.remove, WORKSPACE_TEAM_OPERATION_ACCESS.remove.policy)) {
    throw new TypeError('workspace_team_operation_policy_catalog_mismatch');
  }
  const scopeResolver = workspaceScopeResolver(workspaceId);
  const readLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.read
  });
  const readAutonomy = autonomy(WORKSPACE_TEAM_MEMBERS_READ_OPERATION, commonRefs.readAutonomy);
  const readContext = createReadInvocationContextBuilder({
    reference: commonRefs.readContext,
    operation: WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
    effect: 'read', lanes: [readLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const readCapability: ReadCapabilityRegistration = Object.freeze({
    reference: commonRefs.readCapability,
    openSnapshot(context: ReadInvocationContext) {
      return Object.freeze({ team: input.teamRead.readWorkspaceTeam(context.scope.workspaceId) });
    }
  });

  const mutations = mutationEntries.map((entry) => {
    const refs = refsFor(entry.action);
    const lane = parseOperationAccessLane({
      kind: 'operator', surface: 'operator_http', policy: input.policies[
        entry.action === 'invite' ? 'invite' : entry.action === 'change_role' ? 'changeRole' : 'remove'
      ]
    });
    const operationAutonomy = autonomy(entry.operation, refs.autonomy);
    const context = createEffectInvocationContextBuilder({
      reference: refs.context,
      operation: entry.operation,
      effect: 'commit', lanes: [lane], scopeResolver,
      authorityResolver: input.currentAuthority, clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: commonRefs.requestHash,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: refs.executionFamily, phase: refs.executionPhase
    });
    const terminalization = createTerminalizationResolverRegistration({
      reference: refs.terminalization, operation: entry.operation,
      phase: refs.executionPhase,
      resolve: ({ result }) => result.kind === 'success'
        ? { kind: 'terminal' as const }
        : { kind: 'nonterminal' as const }
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.executionPhase, family: refs.executionFamily,
      operation: entry.operation, effect: 'commit', handler: commonRefs.mutationHandler,
      handlerCapability: WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
      contributionSchema: schemas.mutationContribution,
      terminalization: refs.terminalization,
      terminalOutcomeKeys: [],
      contentionOutcome: {
        class: 'conflict', kind: 'operation.in_progress', retryable: true,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    });
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk, operation: entry.operation,
      resolve: () => ({
        risk: 'low' as const,
        consequenceTags: Object.freeze([`workspace-team-${entry.action}`]),
        evidenceIds: Object.freeze([`workspace_team.${entry.action}.risk`])
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence, operation: entry.operation,
      resolve: ({ subject }) => {
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]),
          maximumSpendMicros: 0, maximumActions: 1,
          notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
        });
        return {
          evaluatedAt: subject.evaluatedAt,
          hardBounds: bounds, unattendedBounds: bounds,
          spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
          proposedAction: {
            key: `workspace_team.${entry.action}.execute`, version: 1,
            digestSha256: subject.requestHashSha256
          },
          failure: { kind: 'none' as const }
        };
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: refs.approval, operation: entry.operation,
      resolve: () => ({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: refs.preflight, operation: entry.operation,
      policy: refs.autonomy, riskResolver: refs.risk,
      evidenceResolver: refs.evidence, approvalResolver: refs.approval,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return {
      ...entry, refs, lane, autonomy: operationAutonomy, context, family,
      terminalization, phase, risk, evidence, approval, preflight
    };
  });

  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  const mutationHandler = createMutationHandler({
    reference: commonRefs.mutationHandler,
    contributionSchema: schemas.mutationContribution,
    canonicalResultSchema: schemas.mutationCanonical
  });

  return Object.freeze({
    id: 'workspace-team.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(mutations.map((entry) => entry.family)),
      effectPhases: Object.freeze(mutations.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(mutations.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(mutations.map((entry) => entry.risk)),
      autonomyEvidenceResolvers: Object.freeze(mutations.map((entry) => entry.evidence)),
      renewedApprovalResolvers: Object.freeze(mutations.map((entry) => entry.approval)),
      autonomyPreflights: Object.freeze(mutations.map((entry) => entry.preflight)),
      autonomyPolicies: Object.freeze([readAutonomy, ...mutations.map((entry) => entry.autonomy)]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: workspaceTeamMembersReadInputSchema },
        { reference: schemas.readCanonical, schema: workspaceTeamMembersCanonicalResultSchema },
        { reference: schemas.readProjected, schema: workspaceTeamMembersReadResultSchema },
        ...mutations.map((entry) => ({ reference: entry.inputRef, schema: entry.inputSchema })),
        { reference: schemas.mutationContribution, schema: workspaceTeamMutationContributionSchema },
        { reference: schemas.mutationCanonical, schema: workspaceTeamMutationCanonicalResultSchema },
        { reference: schemas.mutationProjected, schema: workspaceTeamMutationOperationResultSchema },
        { reference: schemas.nullDetail, schema: z.null() },
        { reference: schemas.refusalDetail, schema: workspaceTeamMutationRefusalDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: commonRefs.readHandler,
        readCapability: commonRefs.readCapability,
        canonicalResultSchema: schemas.readCanonical,
        handle: ({ snapshot }: { snapshot: Readonly<Record<string, unknown>> }) => ({
          kind: 'success' as const,
          data: workspaceTeamSnapshotSchema.parse(snapshot.team)
        })
      }]),
      projections: Object.freeze([{
        reference: commonRefs.readProjection,
        canonicalResultSchema: schemas.readCanonical,
        projectedResultSchema: schemas.readProjected,
        project: (candidate: unknown) => workspaceTeamMembersCanonicalResultSchema.parse(candidate)
      }, {
        reference: commonRefs.mutationProjection,
        canonicalResultSchema: schemas.mutationCanonical,
        projectedResultSchema: schemas.mutationProjected,
        project: (candidate: unknown) => workspaceTeamMutationCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: commonRefs.readTrace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: commonRefs.auditRecordProfile
      }]),
      operationAuditTargets: Object.freeze([{
        reference: commonRefs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: commonRefs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: commonRefs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 131_072
      }]),
      operations: Object.freeze([{
        ...WORKSPACE_TEAM_MEMBERS_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the current workspace member and invitation roster.',
        effect: 'read' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: commonRefs.readAutonomy,
        consequenceTags: [],
        inputSchema: schemas.readInput,
        canonicalResultSchema: schemas.readCanonical,
        outcomes: accessOutcomes,
        accessLanes: [readLane],
        contextBuilder: commonRefs.readContext,
        readCapability: commonRefs.readCapability,
        handler: commonRefs.readHandler,
        observability: {
          trace: { mode: 'required' as const, target: commonRefs.readTrace },
          immutableAudit: {
            mode: 'required' as const,
            reason: 'classified' as const,
            target: commonRefs.audit
          }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: '/api/workspace/team',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: commonRefs.readProjection
        }]
      }]),
      effectContextBuilders: Object.freeze(mutations.map((entry) => entry.context)),
      effectHandlers: Object.freeze([mutationHandler]),
      effectOperations: Object.freeze(mutations.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: entry.action === 'invite' ? 'Invite a workspace teammate.'
          : entry.action === 'change_role' ? 'Change a workspace teammate role.'
            : 'Remove a workspace teammate.',
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [`workspace-team-${entry.action}`],
        inputSchema: entry.inputRef,
        contributionSchema: schemas.mutationContribution,
        canonicalResultSchema: schemas.mutationCanonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed', retryable: false,
            detailSchema: schemas.nullDetail
          },
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'workspace_team.change_refused', retryable: false,
            detailSchema: schemas.refusalDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'workspace_team.change_refused', retryable: false,
            detailSchema: schemas.refusalDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'workspace_team.change_refused', retryable: false,
            detailSchema: schemas.refusalDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress', retryable: true,
            detailSchema: schemas.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [entry.lane],
        contextBuilder: entry.refs.context,
        handlerCapability: WORKSPACE_TEAM_MUTATION_HANDLER_CAPABILITY,
        handler: commonRefs.mutationHandler,
        audit: { mode: 'required' as const, target: commonRefs.audit },
        idempotency: {
          keySource: commonRefs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: commonRefs.requestHash
        },
        concurrency: entry.refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: entry.refs.executionFamily,
          phase: entry.refs.executionPhase,
          terminalization: entry.refs.terminalization,
          autonomyPreflight: entry.refs.preflight,
          history: { summary: entry.action === 'invite' ? 'Invited a teammate'
            : entry.action === 'change_role' ? 'Changed a teammate role'
              : 'Removed a teammate' }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: entry.path,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: commonRefs.mutationProjection
        }]
      })))
    })
  });
}
