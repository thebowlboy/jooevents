import {
  templateArtifactAuthorInputSchema,
  templateArtifactMutationPlanSchema,
  templateArtifactRevisionSchema,
  templateArtifactSafeDiffSchema,
  templateArtifactScopeSchema,
  type TemplateArtifactAuthorInputDto,
  type TemplateArtifactMutationPlanDto,
  type TemplateArtifactRevisionDto,
  type TemplateArtifactSafeDiffDto,
  type TemplateArtifactScopeDto,
  type TemplateArtifactSnapshotDto
} from '@jooevents/contracts';
import { createHash } from 'node:crypto';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition
} from '@jooevents/changesets';
import { z } from 'zod';
import {
  TemplateArtifactPlanningError,
  parseTemplateArtifactSnapshot,
  planTemplateArtifactMutation,
  validateTemplateArtifactMutation,
  type TemplateArtifactPlanningErrorCode,
  type TemplateArtifactReadPort,
  type TemplateArtifactTransactionPort
} from './model';
import {
  assertTemplateAuthoringPolicy,
  captureTemplateAuthoringApprovalPolicy,
  templateAuthoringPolicySchema,
  type TemplateAuthoringPolicy
} from './policy';

export const TEMPLATE_ARTIFACT_CHANGESET_KIND = 'template.artifact.change';
export const TEMPLATE_ARTIFACT_CHANGESET_VERSION = 1;

export const templateArtifactReadPort = defineChangesetReadPort<TemplateArtifactReadPort>(
  'template_artifact.read', 1
);
export const templateArtifactValidationPort =
  defineChangesetValidationPort<TemplateArtifactReadPort>('template_artifact.validation', 1);
export const templateArtifactTransactionPort =
  defineChangesetTransactionPort<TemplateArtifactTransactionPort>('template_artifact.transaction', 1);

export interface TemplateArtifactChangesetPlan {
  readonly policy: TemplateAuthoringPolicy;
  readonly mutation: TemplateArtifactMutationPlanDto;
}

const authorSchema = defineChangesetSchema({
  key: 'template_artifact.author', version: 1, schema: templateArtifactAuthorInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'template_artifact.plan', version: 1,
  schema: z.strictObject({
    policy: templateAuthoringPolicySchema,
    mutation: templateArtifactMutationPlanSchema
  })
});
const diffSchema = defineChangesetSchema({
  key: 'template_artifact.safe_diff', version: 1, schema: templateArtifactSafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'template_artifact.result', version: 1, schema: templateArtifactRevisionSchema
});
const refusalCodeSchema = z.enum([
  'wrong_scope', 'artifact_missing', 'artifact_kind_changed', 'stale_revision',
  'revision_missing', 'no_changes', 'invalid_plan', 'policy_changed'
]);
const outcomeDetailSchema = defineChangesetSchema({
  key: 'template_artifact.stale_detail', version: 1,
  schema: z.strictObject({
    code: refusalCodeSchema,
    action: z.enum(['replace', 'revert']),
    artifactId: templateArtifactMutationPlanSchema.shape.artifactId
  })
});

type Definition = ChangesetOperationDefinition<
  TemplateArtifactAuthorInputDto,
  TemplateArtifactChangesetPlan,
  TemplateArtifactSafeDiffDto,
  TemplateArtifactChangesetPlan,
  TemplateArtifactRevisionDto
>;

export interface TemplateArtifactChangesetBundle {
  readonly policy: TemplateAuthoringPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

export function templateArtifactAggregateId(artifactId: string): string {
  return `template_artifact:${artifactId}`;
}

function compensationRevisionId(plan: TemplateArtifactMutationPlanDto): string {
  const hex = createHash('sha256')
    .update(`template-compensation\u0000${plan.after.revisionId}\u0000${plan.before.revisionId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function requireArtifact(
  scope: TemplateArtifactScopeDto,
  artifactId: string,
  port: TemplateArtifactReadPort
): TemplateArtifactSnapshotDto {
  const snapshot = port.readArtifact(scope, artifactId);
  if (!snapshot) throw new TemplateArtifactPlanningError('artifact_missing');
  return parseTemplateArtifactSnapshot(snapshot);
}

function safeDiff(plan: TemplateArtifactMutationPlanDto): TemplateArtifactSafeDiffDto {
  return templateArtifactSafeDiffSchema.parse({
    action: plan.action,
    artifactId: plan.artifactId,
    artifactKind: plan.before.document.kind,
    before: plan.before,
    after: plan.after,
    restoredFromRevisionNumber: plan.restoredFromRevisionNumber
  });
}

function refusal(
  code: TemplateArtifactPlanningErrorCode | 'policy_changed',
  plan: TemplateArtifactMutationPlanDto
) {
  return {
    class: 'stale_revision' as const,
    kind: 'template.artifact_changed',
    retryable: false,
    subjects: [{ type: 'event' as const, id: plan.scope.eventId }],
    detail: { code, action: plan.action, artifactId: plan.artifactId },
    detailSchemaVersion: 1
  };
}

export function createTemplateArtifactChangesetBundle(input: {
  readonly policy: TemplateAuthoringPolicy;
}): TemplateArtifactChangesetBundle {
  assertTemplateAuthoringPolicy(input.policy);
  const policy = input.policy;
  const definition: Definition = {
    kind: TEMPLATE_ARTIFACT_CHANGESET_KIND,
    version: TEMPLATE_ARTIFACT_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [templateArtifactReadPort],
    validationPorts: [templateArtifactValidationPort],
    transactionPorts: [templateArtifactTransactionPort],
    allowedAggregateKinds: ['template_artifact'],
    allowedGuardKinds: [],
    allowedRisks: ['low', 'normal'],
    allowedConsequences: ['template_artifact_changed'],
    allowedOutcomes: [{
      class: 'stale_revision', kind: 'template.artifact_changed', retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [{ kind: 'template_artifact_changed', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = templateArtifactAuthorInputSchema.parse(authorInput);
      const current = requireArtifact(
        author.scope,
        author.mutation.artifactId,
        snapshot.getPort(templateArtifactReadPort)
      );
      const mutation = planTemplateArtifactMutation({
        scope: author.scope,
        current,
        mutation: author.mutation,
        revisionId: author.revisionId,
        actorUserId: author.actorUserId,
        occurredAt: author.occurredAt
      });
      return {
        plan: { policy, mutation },
        aggregateRefs: [{
          id: templateArtifactAggregateId(mutation.artifactId),
          version: mutation.expectedHeadVersion
        }],
        guardRefs: [],
        riskTier: policy.risk,
        consequences: ['template_artifact_changed']
      };
    },
    projectDiff(plan) {
      return { diff: safeDiff(plan.mutation), representedConsequences: ['template_artifact_changed'] };
    },
    validateWithin(plan, validation) {
      if (canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(policy)) {
        return { kind: 'outcome', outcome: refusal('policy_changed', plan.mutation) };
      }
      const issue = validateTemplateArtifactMutation({
        plan: plan.mutation,
        read: validation.getPort(templateArtifactValidationPort)
      });
      return issue
        ? { kind: 'outcome', outcome: refusal(issue, plan.mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const result = transaction.getPort(templateArtifactTransactionPort)
        .applyMutation(plan.mutation).current;
      return {
        result,
        facts: [{
          kind: 'template_artifact_changed', version: 1,
          payload: {
            action: plan.mutation.action,
            artifactId: result.artifactId,
            artifactKind: result.document.kind,
            revisionId: result.revisionId,
            revisionNumber: result.number,
            digestSha256: result.digestSha256
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      const current = snapshot.getPort(templateArtifactReadPort)
        .readArtifact(plan.mutation.scope, plan.mutation.artifactId);
      if (!current) return { kind: 'blocked', reasonKey: 'template_artifact.missing' };
      const verified = parseTemplateArtifactSnapshot(current);
      if (verified.current.revisionId !== plan.mutation.after.revisionId) {
        return { kind: 'blocked', reasonKey: 'template_artifact.superseded' };
      }
      return {
        kind: 'exact',
        authorInput: {
          scope: plan.mutation.scope,
          mutation: {
            action: 'revert',
            artifactId: plan.mutation.artifactId,
            expectedRevisionNumber: verified.current.number,
            targetRevisionNumber: plan.mutation.before.number
          },
          revisionId: compensationRevisionId(plan.mutation),
          actorUserId: plan.mutation.after.createdByUserId,
          occurredAt: plan.mutation.after.createdAt
        }
      };
    }
  };
  const bundle = Object.freeze({
    policy,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, outcomeDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertTemplateArtifactChangesetBundle(
  candidate: TemplateArtifactChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) throw new TypeError('invalid_template_artifact_changeset_bundle');
  assertTemplateAuthoringPolicy(candidate.policy);
}

export function captureTemplateArtifactApprovalPolicy(input: {
  readonly bundle: TemplateArtifactChangesetBundle;
}) {
  assertTemplateArtifactChangesetBundle(input.bundle);
  return captureTemplateAuthoringApprovalPolicy({ policy: input.bundle.policy });
}
