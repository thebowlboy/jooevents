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
  workspaceTeamDraftCanonicalResultSchema,
  workspaceTeamDraftDataSchema,
  workspaceTeamDraftOperationResultSchema,
  workspaceTeamInviteDraftInputSchema,
  workspaceTeamMembersCanonicalResultSchema,
  workspaceTeamMembersReadInputSchema,
  workspaceTeamMembersReadResultSchema,
  workspaceTeamRemovalDraftInputSchema,
  workspaceTeamRoleChangeDraftInputSchema,
  workspaceTeamSnapshotSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef,
  type WorkspaceTeamDraftData,
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

export type WorkspaceTeamDraftAction = 'invite' | 'change_role' | 'remove';

export const WORKSPACE_TEAM_MEMBERS_READ_OPERATION = Object.freeze({
  name: 'workspace_team.members.read', version: 1
});
export const WORKSPACE_TEAM_INVITE_DRAFT_OPERATION = Object.freeze({
  name: 'workspace_team.invite.draft', version: 1
});
export const WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION = Object.freeze({
  name: 'workspace_team.role_change.draft', version: 1
});
export const WORKSPACE_TEAM_REMOVAL_DRAFT_OPERATION = Object.freeze({
  name: 'workspace_team.removal.draft', version: 1
});

export const WORKSPACE_TEAM_OPERATION_ACCESS = Object.freeze({
  read: Object.freeze({
    policy: { key: 'authority.workspace_team.members.read', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.read
  }),
  invite: Object.freeze({
    policy: { key: 'authority.workspace_team.invite.draft', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.invite
  }),
  changeRole: Object.freeze({
    policy: { key: 'authority.workspace_team.role_change.draft', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.changeRole
  }),
  remove: Object.freeze({
    policy: { key: 'authority.workspace_team.removal.draft', version: parseContractVersion(1) },
    permissionId: WORKSPACE_TEAM_PERMISSIONS.remove
  })
});

export const WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.workspace_team.draft'
);
export const WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.workspace_team.changeset_draft'
);

const applicationIdSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.iso.datetime({ offset: true });

export const workspaceTeamDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('workspace_team_changeset_draft'),
  preparationHandle: applicationIdSchema,
  action: z.enum(['invite', 'change_role', 'remove']),
  workspaceId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: digestSchema,
  recordDigestSha256: digestSchema,
  occurredAt: instantSchema
});

export const workspaceTeamDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: instantSchema
});

export const workspaceTeamDraftRefusalDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_team', 'subject_missing', 'stale_subject',
    'role_unavailable', 'unsupported_assignment', 'duplicate_invitation',
    'current_actor_role_change', 'current_actor_removal', 'last_owner',
    'recipient_invalid', 'recipient_collision', 'policy_changed'
  ]),
  action: z.enum(['invite', 'change_role', 'remove'])
});

const successContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: workspaceTeamDraftDataSchema }),
  domain: workspaceTeamDraftDomainContributionSchema,
  receiptChildren: z.tuple([workspaceTeamDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const { data } = contribution.result;
  const { domain } = contribution;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Workspace team draft evidence is incoherent.' });
  }
});

const allowedDraftOutcomes = new Set([
  'conflict:workspace_team.change_refused',
  'stale_revision:workspace_team.change_refused',
  'policy_violation:workspace_team.change_refused',
  'conflict:changeset.id_collision'
]);
const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const validDetail = outcome.kind === 'changeset.id_collision'
    ? outcome.detail === null
    : workspaceTeamDraftRefusalDetailSchema.safeParse(outcome.detail).success;
  if (!allowedDraftOutcomes.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable || outcome.detailSchemaVersion !== 1 || !validDetail) {
    context.addIssue({ code: 'custom', message: 'Workspace team draft refusal is invalid.' });
  }
});

export const workspaceTeamDraftContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);
export type WorkspaceTeamDraftContribution =
  z.infer<typeof workspaceTeamDraftContributionSchema>;

export interface WorkspaceTeamReadPort {
  readWorkspaceTeam(workspaceId: WorkspaceId): WorkspaceTeamSnapshot;
}

export interface WorkspaceTeamDraftPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

export interface WorkspaceTeamDraftPreparation {
  prepare(input: {
    readonly action: WorkspaceTeamDraftAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): WorkspaceTeamDraftPreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: WorkspaceTeamDraftPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealWorkspaceTeamDraftPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: WorkspaceTeamDraftPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('workspace_team_draft_preparation_invalid');
  }
  const snapshot = Object.freeze({ strategy: 'workspace_team_changeset_draft', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createDraftHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
}): EffectHandlerRegistration {
  const capability = WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY;
  return Object.freeze({
    reference: input.reference,
    effect: 'draft' as const,
    handlerCapability: capability,
    contributionSchema: input.contributionSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      const action = workspaceTeamDraftActionForOperation(
        context.operation.name, context.operation.version
      );
      if (!sealed || !sameReference(sealed.capability, capability)
          || sealed.context !== context || sealed.phase !== 'ready' || !action) {
        throw new TypeError('workspace_team_draft_preparation_invalid');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ action, businessInput, context });
        if (contribution && typeof (contribution as { then?: unknown }).then === 'function') {
          throw new TypeError('workspace_team_draft_preparation_must_be_synchronous');
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
  draftContribution: schemaRef(
    'schema.workspace_team.changeset-draft.contribution',
    workspaceTeamDraftContributionSchema
  ),
  draftCanonical: schemaRef(
    'schema.workspace_team.changeset-draft.canonical-result',
    workspaceTeamDraftCanonicalResultSchema
  ),
  draftProjected: WORKSPACE_TEAM_OPERATION_SCHEMA_REFS.invite.resultSchema,
  nullDetail: schemaRef('schema.workspace_team.operation.null-detail', z.null()),
  refusalDetail: schemaRef(
    'schema.workspace_team.draft-refusal.detail', workspaceTeamDraftRefusalDetailSchema
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
  draftHandler: ref('handler.workspace_team.changeset-draft'),
  draftProjection: ref('projection.workspace_team.changeset-draft.operator'),
  audit: ref('audit.workspace_team.changeset-draft'),
  auditRecordProfile: ref('record-profile.workspace_team.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: WORKSPACE_TEAM_DRAFT_REQUEST_HASH_PROFILE
});

const draftEntries = Object.freeze([
  {
    action: 'invite' as const,
    operation: WORKSPACE_TEAM_INVITE_DRAFT_OPERATION,
    inputSchema: workspaceTeamInviteDraftInputSchema,
    inputRef: schemas.inviteInput,
    access: WORKSPACE_TEAM_OPERATION_ACCESS.invite,
    path: '/api/workspace/team/invitations/drafts'
  },
  {
    action: 'change_role' as const,
    operation: WORKSPACE_TEAM_ROLE_CHANGE_DRAFT_OPERATION,
    inputSchema: workspaceTeamRoleChangeDraftInputSchema,
    inputRef: schemas.roleInput,
    access: WORKSPACE_TEAM_OPERATION_ACCESS.changeRole,
    path: '/api/workspace/team/role-changes/drafts'
  },
  {
    action: 'remove' as const,
    operation: WORKSPACE_TEAM_REMOVAL_DRAFT_OPERATION,
    inputSchema: workspaceTeamRemovalDraftInputSchema,
    inputRef: schemas.removalInput,
    access: WORKSPACE_TEAM_OPERATION_ACCESS.remove,
    path: '/api/workspace/team/removals/drafts'
  }
]);

interface DraftRefs {
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

function refsFor(action: WorkspaceTeamDraftAction): DraftRefs {
  return Object.freeze({
    context: ref(`context.workspace_team.${action}-draft`),
    autonomy: ref(`autonomy.workspace_team.${action}-draft`),
    executionFamily: ref(`workspace_team.${action}-draft.execution-family`),
    executionPhase: ref(`workspace_team.${action}-draft.phase.single-uow`),
    concurrency: ref(`concurrency.workspace_team.${action}-draft`),
    terminalization: ref(`workspace_team.${action}-draft.terminalization`),
    risk: ref(`workspace_team.${action}-draft.risk-resolver`),
    evidence: ref(`workspace_team.${action}-draft.autonomy-evidence`),
    approval: ref(`workspace_team.${action}-draft.approval-resolver`),
    preflight: ref(`workspace_team.${action}-draft.autonomy-preflight`)
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

export function workspaceTeamDraftActionForOperation(
  operationName: string,
  operationVersion: number
): WorkspaceTeamDraftAction | undefined {
  return draftEntries.find(({ operation }) =>
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

  const drafts = draftEntries.map((entry) => {
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
      effect: 'draft', lanes: [lane], scopeResolver,
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
      operation: entry.operation, effect: 'draft', handler: commonRefs.draftHandler,
      handlerCapability: WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
      contributionSchema: schemas.draftContribution,
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
        consequenceTags: Object.freeze(['changeset-drafted']),
        evidenceIds: Object.freeze([`workspace_team.${entry.action}.draft.risk`])
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
            key: `workspace_team.${entry.action}.draft.execute`, version: 1,
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
  const draftHandler = createDraftHandler({
    reference: commonRefs.draftHandler,
    contributionSchema: schemas.draftContribution,
    canonicalResultSchema: schemas.draftCanonical
  });

  return Object.freeze({
    id: 'workspace-team.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(drafts.map((entry) => entry.family)),
      effectPhases: Object.freeze(drafts.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(drafts.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(drafts.map((entry) => entry.risk)),
      autonomyEvidenceResolvers: Object.freeze(drafts.map((entry) => entry.evidence)),
      renewedApprovalResolvers: Object.freeze(drafts.map((entry) => entry.approval)),
      autonomyPreflights: Object.freeze(drafts.map((entry) => entry.preflight)),
      autonomyPolicies: Object.freeze([readAutonomy, ...drafts.map((entry) => entry.autonomy)]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: workspaceTeamMembersReadInputSchema },
        { reference: schemas.readCanonical, schema: workspaceTeamMembersCanonicalResultSchema },
        { reference: schemas.readProjected, schema: workspaceTeamMembersReadResultSchema },
        ...drafts.map((entry) => ({ reference: entry.inputRef, schema: entry.inputSchema })),
        { reference: schemas.draftContribution, schema: workspaceTeamDraftContributionSchema },
        { reference: schemas.draftCanonical, schema: workspaceTeamDraftCanonicalResultSchema },
        { reference: schemas.draftProjected, schema: workspaceTeamDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: z.null() },
        { reference: schemas.refusalDetail, schema: workspaceTeamDraftRefusalDetailSchema }
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
        reference: commonRefs.draftProjection,
        canonicalResultSchema: schemas.draftCanonical,
        projectedResultSchema: schemas.draftProjected,
        project: (candidate: unknown) => workspaceTeamDraftCanonicalResultSchema.parse(candidate)
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
      effectContextBuilders: Object.freeze(drafts.map((entry) => entry.context)),
      effectHandlers: Object.freeze([draftHandler]),
      effectOperations: Object.freeze(drafts.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Draft a workspace team ${entry.action} change for review.`,
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: entry.inputRef,
        contributionSchema: schemas.draftContribution,
        canonicalResultSchema: schemas.draftCanonical,
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
            kind: 'changeset.id_collision', retryable: false,
            detailSchema: schemas.nullDetail
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
        handlerCapability: WORKSPACE_TEAM_DRAFT_HANDLER_CAPABILITY,
        handler: commonRefs.draftHandler,
        audit: { mode: 'required' as const, target: commonRefs.audit },
        idempotency: {
          keySource: commonRefs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: commonRefs.requestHash
        },
        concurrency: entry.refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: entry.refs.executionFamily,
          phase: entry.refs.executionPhase,
          terminalization: entry.refs.terminalization,
          autonomyPreflight: entry.refs.preflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: entry.path,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: commonRefs.draftProjection
        }]
      })))
    })
  });
}
