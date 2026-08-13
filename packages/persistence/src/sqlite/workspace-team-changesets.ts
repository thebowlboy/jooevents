import {
  changesetApplicationIdSchema,
  workspaceTeamRecipientHintSchema,
  workspaceTeamRoleKeySchema,
  workspaceTeamSafeDiffSchema,
  workspaceTeamSubjectRefSchema,
  type WorkspaceTeamSafeDiff
} from '@jooevents/contracts';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type CompensationDerivation
} from '@jooevents/changesets';
import {
  WorkspaceTeamPlanningError,
  planWorkspaceTeamInvitation,
  planWorkspaceTeamRemoval,
  planWorkspaceTeamRoleChange,
  projectWorkspaceTeamSafeDiff,
  type WorkspaceTeamMutationPlan,
  type WorkspaceTeamPlanningErrorCode,
  type WorkspaceTeamPlanningSnapshot
} from '@jooevents/identity-access';
import {
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

export const WORKSPACE_TEAM_CHANGESET_KIND = 'workspace_team.mutate';
export const WORKSPACE_TEAM_CHANGESET_VERSION = 1;

const positive = z.number().int().positive().safe();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.iso.datetime({ offset: true });

export interface WorkspaceTeamChangesetPolicy {
  readonly activation: 'trial';
  readonly key: string;
  readonly version: number;
  readonly approval: 'none' | 'distinct_current_human';
  readonly definitionDigestSha256: string;
}

const policySchema: z.ZodType<WorkspaceTeamChangesetPolicy> = z.strictObject({
  activation: z.literal('trial'),
  key: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
  version: positive,
  approval: z.enum(['none', 'distinct_current_human']),
  definitionDigestSha256: digestSchema
}).superRefine((policy, context) => {
  const definition = {
    activation: policy.activation,
    key: policy.key,
    version: policy.version,
    approval: policy.approval
  };
  if (canonicalJsonSha256(definition) !== policy.definitionDigestSha256) {
    context.addIssue({
      code: 'custom', path: ['definitionDigestSha256'],
      message: 'Workspace team policy digest changed.'
    });
  }
});

const issuedPolicies = new WeakSet<object>();

export function createWorkspaceTeamChangesetPolicy(input: {
  readonly key: string;
  readonly version: number;
  readonly approval: 'none' | 'distinct_current_human';
}): WorkspaceTeamChangesetPolicy {
  const definition = {
    activation: 'trial' as const,
    key: input.key,
    version: input.version,
    approval: input.approval
  };
  const policy = Object.freeze(policySchema.parse({
    ...definition,
    definitionDigestSha256: canonicalJsonSha256(definition)
  }));
  issuedPolicies.add(policy);
  return policy;
}

function assertPolicy(policy: WorkspaceTeamChangesetPolicy): void {
  if (!issuedPolicies.has(policy)) throw new TypeError('workspace_team_changeset_policy_invalid');
  policySchema.parse(policy);
}

export function captureWorkspaceTeamApprovalPolicy(policy: WorkspaceTeamChangesetPolicy) {
  assertPolicy(policy);
  return Object.freeze({
    reference: Object.freeze({ key: policy.key, version: policy.version }),
    definitionDigestSha256: policy.definitionDigestSha256,
    requirement: policy.approval
  });
}

const guardShape = {
  workspaceId: changesetApplicationIdSchema,
  expectedTeamVersion: positive,
  expectedTeamDigestSha256: digestSchema
} as const;

const invitationAuthorSchema = z.strictObject({
  action: z.literal('invite'),
  ...guardShape,
  roleKey: workspaceTeamRoleKeySchema,
  recipient: z.strictObject({
    payloadRefId: changesetApplicationIdSchema,
    lookupBinding: digestSchema,
    hint: workspaceTeamRecipientHintSchema
  }),
  ids: z.strictObject({
    reservationId: changesetApplicationIdSchema,
    reservationRoleAssignmentId: changesetApplicationIdSchema,
    releaseIntentId: changesetApplicationIdSchema,
    historyId: changesetApplicationIdSchema
  }),
  actorUserId: changesetApplicationIdSchema,
  evaluatedAt: instantSchema
});

const roleChangeAuthorSchema = z.strictObject({
  action: z.literal('change_role'),
  ...guardShape,
  subject: workspaceTeamSubjectRefSchema,
  roleKey: workspaceTeamRoleKeySchema,
  actorUserId: changesetApplicationIdSchema,
  evaluatedAt: instantSchema,
  historyId: changesetApplicationIdSchema
});

const removalAuthorSchema = z.strictObject({
  action: z.literal('remove'),
  ...guardShape,
  subject: workspaceTeamSubjectRefSchema,
  actorUserId: changesetApplicationIdSchema,
  evaluatedAt: instantSchema,
  historyId: changesetApplicationIdSchema,
  sessionRevocationIntentId: changesetApplicationIdSchema.optional()
});

export const workspaceTeamChangesetAuthorInputSchema = z.discriminatedUnion('action', [
  invitationAuthorSchema,
  roleChangeAuthorSchema,
  removalAuthorSchema
]).superRefine((author, context) => {
  if (author.action === 'remove'
      && author.subject.kind === 'member'
      && author.sessionRevocationIntentId === undefined) {
    context.addIssue({
      code: 'custom', path: ['sessionRevocationIntentId'],
      message: 'Member removal requires a session-revocation intent.'
    });
  }
});
export type WorkspaceTeamChangesetAuthorInput =
  z.infer<typeof workspaceTeamChangesetAuthorInputSchema>;

const planBase = {
  workspaceId: changesetApplicationIdSchema,
  expectedTeamVersion: positive,
  expectedTeamDigestSha256: digestSchema,
  resultingTeamVersion: positive,
  historyId: changesetApplicationIdSchema
} as const;

export const workspaceTeamMutationPlanSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('invite'), ...planBase,
    reservationId: changesetApplicationIdSchema,
    reservationRoleAssignmentId: changesetApplicationIdSchema,
    releaseIntentId: changesetApplicationIdSchema,
    payloadRefId: changesetApplicationIdSchema,
    lookupBinding: digestSchema,
    recipientHint: workspaceTeamRecipientHintSchema,
    roleId: changesetApplicationIdSchema,
    roleKey: workspaceTeamRoleKeySchema,
    createdByUserId: changesetApplicationIdSchema,
    createdAt: instantSchema
  }),
  z.strictObject({
    action: z.literal('change_role'), ...planBase,
    subject: workspaceTeamSubjectRefSchema,
    beforeRoleId: changesetApplicationIdSchema,
    beforeRoleKey: workspaceTeamRoleKeySchema,
    afterRoleId: changesetApplicationIdSchema,
    afterRoleKey: workspaceTeamRoleKeySchema,
    actorUserId: changesetApplicationIdSchema,
    changedAt: instantSchema
  }),
  z.strictObject({
    action: z.literal('remove'), ...planBase,
    subject: workspaceTeamSubjectRefSchema,
    beforeRoleId: changesetApplicationIdSchema,
    beforeRoleKey: workspaceTeamRoleKeySchema,
    actorUserId: changesetApplicationIdSchema,
    removedAt: instantSchema,
    sessionRevocationIntentId: changesetApplicationIdSchema.optional()
  })
]).superRefine((plan, context) => {
  if (plan.resultingTeamVersion !== plan.expectedTeamVersion + 1) {
    context.addIssue({
      code: 'custom', path: ['resultingTeamVersion'],
      message: 'Workspace team plan must advance its guard exactly once.'
    });
  }
  if (plan.action === 'remove'
      && plan.subject.kind === 'member'
      && plan.sessionRevocationIntentId === undefined) {
    context.addIssue({
      code: 'custom', path: ['sessionRevocationIntentId'],
      message: 'Member removal requires a session-revocation intent.'
    });
  }
});

export interface WorkspaceTeamChangesetPlan {
  readonly policy: WorkspaceTeamChangesetPolicy;
  readonly mutation: WorkspaceTeamMutationPlan;
}

const fullPlanSchema = z.strictObject({
  policy: policySchema,
  mutation: workspaceTeamMutationPlanSchema
});
const resultSchemaValue = z.strictObject({
  action: z.enum(['invite', 'change_role', 'remove']),
  teamVersion: positive
});
const refusalCodes = [
  'wrong_scope', 'stale_team', 'subject_missing', 'stale_subject',
  'role_unavailable', 'unsupported_assignment', 'duplicate_invitation',
  'current_actor_role_change', 'current_actor_removal', 'last_owner', 'policy_changed'
] as const;
const refusalDetailSchemaValue = z.strictObject({
  code: z.enum(refusalCodes),
  action: z.enum(['invite', 'change_role', 'remove'])
});

const authorSchema = defineChangesetSchema({
  key: 'workspace_team.author', version: 1, schema: workspaceTeamChangesetAuthorInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'workspace_team.plan', version: 1, schema: fullPlanSchema
});
const diffSchema = defineChangesetSchema({
  key: 'workspace_team.safe_diff', version: 1, schema: workspaceTeamSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'workspace_team.result', version: 1, schema: resultSchemaValue
});
const refusalDetailSchema = defineChangesetSchema({
  key: 'workspace_team.refusal', version: 1, schema: refusalDetailSchemaValue
});

export interface WorkspaceTeamReadPort {
  readWorkspaceTeam(workspaceId: string): WorkspaceTeamPlanningSnapshot | undefined;
}

export interface WorkspaceTeamTransactionPort extends WorkspaceTeamReadPort {
  applyWorkspaceTeamPlan(plan: WorkspaceTeamMutationPlan): void;
}

export const workspaceTeamReadPort = defineChangesetReadPort<WorkspaceTeamReadPort>(
  'workspace_team.read', 1
);
export const workspaceTeamValidationPort = defineChangesetValidationPort<WorkspaceTeamReadPort>(
  'workspace_team.validation', 1
);
export const workspaceTeamTransactionPort =
  defineChangesetTransactionPort<WorkspaceTeamTransactionPort>('workspace_team.transaction', 1);

function planAuthor(
  author: WorkspaceTeamChangesetAuthorInput,
  snapshot: WorkspaceTeamPlanningSnapshot
): WorkspaceTeamMutationPlan {
  const base = {
    snapshot,
    expectedTeamVersion: author.expectedTeamVersion,
    expectedTeamDigestSha256: author.expectedTeamDigestSha256,
    actorUserId: parseUserId(author.actorUserId),
    evaluatedAt: parseInstant(author.evaluatedAt)
  };
  if (author.action === 'invite') return planWorkspaceTeamInvitation({
    ...base,
    roleKey: author.roleKey,
    recipient: author.recipient,
    ids: author.ids
  });
  if (author.action === 'change_role') return planWorkspaceTeamRoleChange({
    ...base,
    subject: author.subject,
    roleKey: author.roleKey,
    historyId: author.historyId
  });
  return planWorkspaceTeamRemoval({
    ...base,
    subject: author.subject,
    historyId: author.historyId,
    ...(author.sessionRevocationIntentId === undefined
      ? {}
      : { sessionRevocationIntentId: author.sessionRevocationIntentId })
  });
}

function authorFromPlan(plan: WorkspaceTeamMutationPlan): WorkspaceTeamChangesetAuthorInput {
  const base = {
    workspaceId: plan.workspaceId,
    expectedTeamVersion: plan.expectedTeamVersion,
    expectedTeamDigestSha256: plan.expectedTeamDigestSha256
  };
  if (plan.action === 'invite') return workspaceTeamChangesetAuthorInputSchema.parse({
    action: 'invite', ...base, roleKey: plan.roleKey,
    recipient: {
      payloadRefId: plan.payloadRefId,
      lookupBinding: plan.lookupBinding,
      hint: plan.recipientHint
    },
    ids: {
      reservationId: plan.reservationId,
      reservationRoleAssignmentId: plan.reservationRoleAssignmentId,
      releaseIntentId: plan.releaseIntentId,
      historyId: plan.historyId
    },
    actorUserId: plan.createdByUserId,
    evaluatedAt: plan.createdAt
  });
  if (plan.action === 'change_role') return workspaceTeamChangesetAuthorInputSchema.parse({
    action: 'change_role', ...base, subject: plan.subject,
    roleKey: plan.afterRoleKey, actorUserId: plan.actorUserId,
    evaluatedAt: plan.changedAt, historyId: plan.historyId
  });
  return workspaceTeamChangesetAuthorInputSchema.parse({
    action: 'remove', ...base, subject: plan.subject,
    actorUserId: plan.actorUserId, evaluatedAt: plan.removedAt,
    historyId: plan.historyId,
    ...(plan.sessionRevocationIntentId === undefined
      ? {}
      : { sessionRevocationIntentId: plan.sessionRevocationIntentId })
  });
}

function refusal(
  code: WorkspaceTeamPlanningErrorCode | 'policy_changed',
  action: WorkspaceTeamMutationPlan['action']
) {
  const stale = code === 'stale_team' || code === 'stale_subject';
  const policy = [
    'unsupported_assignment', 'current_actor_role_change',
    'current_actor_removal', 'last_owner', 'policy_changed'
  ].includes(code);
  return {
    class: stale ? 'stale_revision' as const : policy ? 'policy_violation' as const : 'conflict' as const,
    kind: 'workspace_team.change_refused',
    retryable: false,
    subjects: [],
    detail: { code, action },
    detailSchemaVersion: 1
  };
}

type Definition = ChangesetOperationDefinition<
  WorkspaceTeamChangesetAuthorInput,
  WorkspaceTeamChangesetPlan,
  WorkspaceTeamSafeDiff,
  WorkspaceTeamChangesetPlan,
  { readonly action: WorkspaceTeamMutationPlan['action']; readonly teamVersion: number }
>;

export interface WorkspaceTeamChangesetBundle {
  readonly policy: WorkspaceTeamChangesetPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

export function createWorkspaceTeamChangesetBundle(input: {
  readonly policy: WorkspaceTeamChangesetPolicy;
}): WorkspaceTeamChangesetBundle {
  assertPolicy(input.policy);
  const definition: Definition = {
    kind: WORKSPACE_TEAM_CHANGESET_KIND,
    version: WORKSPACE_TEAM_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [workspaceTeamReadPort],
    validationPorts: [workspaceTeamValidationPort],
    transactionPorts: [workspaceTeamTransactionPort],
    allowedAggregateKinds: ['workspace_team'],
    allowedGuardKinds: ['workspace_team_guard'],
    allowedRisks: ['normal', 'consequential'],
    allowedConsequences: ['workspace_team_changed'],
    allowedOutcomes: [
      { class: 'conflict', kind: 'workspace_team.change_refused', retryable: false,
        detailSchema: refusalDetailSchema.reference },
      { class: 'stale_revision', kind: 'workspace_team.change_refused', retryable: false,
        detailSchema: refusalDetailSchema.reference },
      { class: 'policy_violation', kind: 'workspace_team.change_refused', retryable: false,
        detailSchema: refusalDetailSchema.reference }
    ],
    allowedFacts: [{ kind: 'workspace_team_changed', version: 1 }],
    allowedEffects: [],
    plan(candidate, planning) {
      const author = workspaceTeamChangesetAuthorInputSchema.parse(candidate);
      const workspaceId = parseWorkspaceId(author.workspaceId);
      const snapshot = planning.getPort(workspaceTeamReadPort).readWorkspaceTeam(workspaceId);
      if (!snapshot || snapshot.workspaceId !== workspaceId) {
        throw new WorkspaceTeamPlanningError('wrong_scope');
      }
      const mutation = planAuthor(author, snapshot);
      return {
        plan: { policy: input.policy, mutation },
        aggregateRefs: [{ id: `workspace_team:${workspaceId}`, version: mutation.expectedTeamVersion }],
        guardRefs: [{
          id: `workspace_team_guard:${workspaceId}`,
          version: mutation.expectedTeamVersion,
          digest: mutation.expectedTeamDigestSha256
        }],
        riskTier: mutation.action === 'invite' ? 'normal' : 'consequential',
        consequences: ['workspace_team_changed']
      };
    },
    projectDiff(plan) {
      return {
        diff: projectWorkspaceTeamSafeDiff(plan.mutation),
        representedConsequences: ['workspace_team_changed']
      };
    },
    validateWithin(candidate, validation) {
      const plan = fullPlanSchema.parse(candidate) as unknown as WorkspaceTeamChangesetPlan;
      if (canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(input.policy)) {
        return { kind: 'outcome', outcome: refusal('policy_changed', plan.mutation.action) };
      }
      const snapshot = validation.getPort(workspaceTeamValidationPort)
        .readWorkspaceTeam(plan.mutation.workspaceId);
      if (!snapshot) {
        return { kind: 'outcome', outcome: refusal('wrong_scope', plan.mutation.action) };
      }
      try {
        const replay = planAuthor(authorFromPlan(plan.mutation), snapshot);
        if (canonicalJsonSha256(replay) !== canonicalJsonSha256(plan.mutation)) {
          return { kind: 'outcome', outcome: refusal('stale_team', plan.mutation.action) };
        }
        return { kind: 'ready', validated: plan };
      } catch (error) {
        if (!(error instanceof WorkspaceTeamPlanningError)) throw error;
        return { kind: 'outcome', outcome: refusal(error.code, plan.mutation.action) };
      }
    },
    applyWithin(plan, transaction) {
      transaction.getPort(workspaceTeamTransactionPort).applyWorkspaceTeamPlan(plan.mutation);
      return {
        result: { action: plan.mutation.action, teamVersion: plan.mutation.resultingTeamVersion },
        facts: [{
          kind: 'workspace_team_changed', version: 1,
          payload: {
            action: plan.mutation.action,
            teamVersion: plan.mutation.resultingTeamVersion,
            subjectKind: plan.mutation.action === 'invite'
              ? 'invitation'
              : plan.mutation.subject.kind
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan): CompensationDerivation<WorkspaceTeamChangesetAuthorInput> {
      if (plan.mutation.action === 'remove') return {
        kind: 'irreversible', remediationKey: 'workspace_team.access_requires_fresh_readmission'
      };
      return { kind: 'blocked', reasonKey: 'workspace_team.fresh_authority_required' };
    }
  };
  const bundle = Object.freeze({
    policy: input.policy,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, refusalDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertWorkspaceTeamChangesetBundle(bundle: WorkspaceTeamChangesetBundle): void {
  if (!issuedBundles.has(bundle)) throw new TypeError('workspace_team_changeset_bundle_invalid');
  assertPolicy(bundle.policy);
}
