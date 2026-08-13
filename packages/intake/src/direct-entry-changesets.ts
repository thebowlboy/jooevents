import { createHash } from 'node:crypto';
import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  applicationAnswerIndexSchema,
  intakeDigestSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeStableKeySchema,
  intakeVersionSchema,
  submissionDirectEntryEvidenceSchema,
  submissionDirectEntrySafeDiffSchema,
  submissionDirectEntryResultSchema,
  submissionHeadSchema,
  submissionParticipantEvidenceSchema,
  type ApplicationAnswerIndexDto,
  type FormDefinitionHeadDto,
  type FormVersionDto,
  type IntakeScopeDto,
  type SubmissionDirectEntryResultDto,
  type SubmissionDirectEntrySafeDiff
} from '@jooevents/contracts';
import { submissionArrivalCloseEvidenceSchema } from '@jooevents/contracts/submission-triage';
import {
  canonicalJsonSha256,
  createChangesetDefinitionRegistry,
  defineChangesetReadPort,
  defineChangesetSchema,
  defineChangesetTransactionPort,
  defineChangesetValidationPort,
  type ChangesetDefinitionRegistry,
  type ChangesetOperationDefinition,
  type ChangesetPlanningSnapshot,
  type CompensationDerivation
} from '@jooevents/changesets';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { z } from 'zod';
import { deepFreeze } from './model';
import {
  parseApplicationDirectEntryPlan,
  planApplicationDirectEntry,
  validateApplicationDirectEntryPlanAgainstForm,
  type ApplicationDirectEntryPlan
} from './direct-entry';
import {
  ApplicationPlanningError,
  type ApplicationAnswerPayloadReferenceVerifier,
  type ApplicationCollectionSource,
  type ApplicationPlanningErrorCode
} from './submissions';

export const SUBMISSION_DIRECT_ENTRY_CHANGESET_KIND = 'submission.direct_entry.create';
export const SUBMISSION_DIRECT_ENTRY_CHANGESET_VERSION = 1;
export const SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID = 'intake_direct_entry';

/**
 * Server-assembled author input. The governed answer index and the five fresh
 * identities are minted inside the sealed draft invocation; the operator's wire
 * input never carries them, so a plan cannot smuggle its own `submittedAt`,
 * source, or identity values.
 */
export interface SubmissionDirectEntryChangesetAuthorInput {
  readonly action: 'create';
  readonly scope: IntakeScopeDto;
  readonly formId: string;
  readonly expectedFormDefinitionVersion: number;
  readonly answers: ApplicationAnswerIndexDto;
  readonly identities: {
    readonly submissionId: string;
    readonly entryEvidenceId: string;
    readonly personId: string;
    readonly participantIdentityId: string;
    readonly participantEvidenceId: string;
  };
  readonly requestDigestSha256: string;
}

export interface SubmissionDirectEntryFormSource {
  readFormHead(scope: IntakeScopeDto, formId: string): FormDefinitionHeadDto | undefined;
  readFormVersion(scope: IntakeScopeDto, formVersionId: string): FormVersionDto | undefined;
}

export interface SubmissionDirectEntryReadPort
extends SubmissionDirectEntryFormSource, ApplicationCollectionSource {}

/**
 * A transaction composition supplies the authentic invocation and its exact
 * current-authority recheck. `enteredByUserId` and `submittedAt` never come
 * from author input.
 */
export interface SubmissionDirectEntryPlanningAttributionSource {
  readonly context: EffectInvocationContext;
  readonly authorityRecheck: SealedEffectAuthorityRecheckResult;
}

export interface SubmissionDirectEntryPlanningAttributionReadPort {
  readSubmissionDirectEntryPlanningAttribution(
    scope: IntakeScopeDto
  ): SubmissionDirectEntryPlanningAttributionSource | undefined;
}

/** Reference census consulted only by compensation derivation. */
export interface SubmissionDirectEntryReferenceReadPort {
  readCurrentEntryRecordDigest(scope: IntakeScopeDto, submissionId: string): string | undefined;
  countSubmissionReferences(scope: IntakeScopeDto, submissionId: string): number;
}

export interface SubmissionDirectEntryValidationPort
extends SubmissionDirectEntryFormSource, ApplicationCollectionSource {
  readonly payloadReferences: ApplicationAnswerPayloadReferenceVerifier;
}

export interface SubmissionDirectEntryTransactionPort {
  applyDirectEntryPlan(plan: ApplicationDirectEntryPlan): SubmissionDirectEntryResultDto;
}

export const submissionDirectEntryChangesetReadPort =
  defineChangesetReadPort<SubmissionDirectEntryReadPort>('submission_direct_entry.read', 1);
export const submissionDirectEntryPlanningAttributionReadPort =
  defineChangesetReadPort<SubmissionDirectEntryPlanningAttributionReadPort>(
    'submission_direct_entry.planning_attribution', 1
  );
export const submissionDirectEntryReferenceReadPort =
  defineChangesetReadPort<SubmissionDirectEntryReferenceReadPort>(
    'submission_direct_entry.references', 1
  );
export const submissionDirectEntryChangesetValidationPort =
  defineChangesetValidationPort<SubmissionDirectEntryValidationPort>(
    'submission_direct_entry.validation', 1
  );
export const submissionDirectEntryChangesetTransactionPort =
  defineChangesetTransactionPort<SubmissionDirectEntryTransactionPort>(
    'submission_direct_entry.transaction', 1
  );

const authorIdentitiesSchema = z.strictObject({
  submissionId: intakeIdSchema,
  entryEvidenceId: intakeIdSchema,
  personId: intakeIdSchema,
  participantIdentityId: intakeIdSchema,
  participantEvidenceId: intakeIdSchema
}).superRefine((identities, context) => {
  const ids = Object.values(identities);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'direct entry identities must be distinct' });
  }
});

const authorInputValueSchema: z.ZodType<SubmissionDirectEntryChangesetAuthorInput> =
  z.strictObject({
    action: z.literal('create'),
    scope: intakeScopeSchema,
    formId: intakeIdSchema,
    expectedFormDefinitionVersion: intakeVersionSchema,
    answers: applicationAnswerIndexSchema,
    identities: authorIdentitiesSchema,
    requestDigestSha256: intakeDigestSchema
  });

const planValueSchema: z.ZodType<ApplicationDirectEntryPlan> = z.strictObject({
  action: z.literal('direct_entry'),
  formDefinitionVersion: intakeVersionSchema,
  formVersionDigestSha256: intakeDigestSchema,
  submission: submissionHeadSchema,
  entryEvidence: submissionDirectEntryEvidenceSchema,
  participant: submissionParticipantEvidenceSchema,
  closeEvidence: submissionArrivalCloseEvidenceSchema.nullable()
}).superRefine((plan, context) => {
  try {
    parseApplicationDirectEntryPlan(plan);
  } catch {
    context.addIssue({ code: 'custom', message: 'direct entry plan must be exact and coherent' });
  }
});

const refusalCodes = [
  'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
  'target_unavailable', 'deadline_unavailable', 'deadline_changed',
  'invalid_answers', 'invalid_submission_identity',
  'direct_entry_title_required', 'direct_entry_email_required', 'invalid_plan'
] as const;

export type SubmissionDirectEntryRefusalCode = (typeof refusalCodes)[number];

const authorSchema = defineChangesetSchema({
  key: 'submission.direct_entry.author', version: 1, schema: authorInputValueSchema
});
const planSchema = defineChangesetSchema({
  key: 'submission.direct_entry.plan', version: 1, schema: planValueSchema
});
const diffSchema = defineChangesetSchema({
  key: 'submission.direct_entry.safe_diff', version: 1,
  schema: submissionDirectEntrySafeDiffSchema
});
const resultSchema = defineChangesetSchema({
  key: 'submission.direct_entry.result', version: 1, schema: submissionDirectEntryResultSchema
});
const outcomeDetailSchema = defineChangesetSchema({
  key: 'submission.direct_entry.stale_detail', version: 1,
  schema: z.strictObject({
    code: z.enum(refusalCodes),
    action: z.literal('create'),
    formId: intakeIdSchema
  })
});

export type SubmissionDirectEntryApprovalRequirement = 'none' | 'distinct_current_human';

export interface SubmissionDirectEntryChangesetPolicyInput {
  readonly key: string;
  readonly version: number;
  readonly approval: { readonly create: SubmissionDirectEntryApprovalRequirement };
}

export interface SubmissionDirectEntryChangesetPolicy
extends SubmissionDirectEntryChangesetPolicyInput {
  readonly activation: 'submission_direct_entry';
  readonly definitionDigestSha256: string;
}

const policyInputSchema = z.strictObject({
  key: intakeStableKeySchema,
  version: intakeVersionSchema,
  approval: z.strictObject({ create: z.enum(['none', 'distinct_current_human']) })
});

const issuedPolicies = new WeakSet<object>();

export function issueSubmissionDirectEntryChangesetPolicy(
  candidate: SubmissionDirectEntryChangesetPolicyInput
): SubmissionDirectEntryChangesetPolicy {
  const input = policyInputSchema.parse(candidate);
  const approval = Object.freeze({ ...input.approval });
  const policy: SubmissionDirectEntryChangesetPolicy = Object.freeze({
    activation: 'submission_direct_entry',
    key: input.key,
    version: input.version,
    approval,
    definitionDigestSha256: policyDigest({ ...input, approval })
  });
  issuedPolicies.add(policy);
  return policy;
}

export function assertSubmissionDirectEntryChangesetPolicy(
  policy: SubmissionDirectEntryChangesetPolicy
): void {
  if (!issuedPolicies.has(policy)
      || policy.activation !== 'submission_direct_entry'
      || policyDigest(policy) !== policy.definitionDigestSha256) {
    throw new TypeError('invalid_submission_direct_entry_changeset_policy');
  }
}

export function captureSubmissionDirectEntryApprovalPolicy(input: {
  readonly policy: SubmissionDirectEntryChangesetPolicy;
}): {
  readonly reference: { readonly key: string; readonly version: number };
  readonly definitionDigestSha256: string;
  readonly requirement: SubmissionDirectEntryApprovalRequirement;
} {
  assertSubmissionDirectEntryChangesetPolicy(input.policy);
  return Object.freeze({
    reference: Object.freeze({ key: input.policy.key, version: input.policy.version }),
    definitionDigestSha256: input.policy.definitionDigestSha256,
    requirement: input.policy.approval.create
  });
}

function policyDigest(policy: SubmissionDirectEntryChangesetPolicyInput): string {
  return canonicalJsonSha256({
    activation: 'submission_direct_entry',
    key: policy.key,
    version: policy.version,
    approval: policy.approval
  });
}

type SubmissionDirectEntryDefinition = ChangesetOperationDefinition<
  SubmissionDirectEntryChangesetAuthorInput,
  ApplicationDirectEntryPlan,
  SubmissionDirectEntrySafeDiff,
  ApplicationDirectEntryPlan,
  SubmissionDirectEntryResultDto
>;

export interface SubmissionDirectEntryChangesetBundle {
  readonly policy: SubmissionDirectEntryChangesetPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

export function createSubmissionDirectEntryChangesetBundle(input: {
  readonly policy: SubmissionDirectEntryChangesetPolicy;
}): SubmissionDirectEntryChangesetBundle {
  assertSubmissionDirectEntryChangesetPolicy(input.policy);
  const definition: SubmissionDirectEntryDefinition = {
    kind: SUBMISSION_DIRECT_ENTRY_CHANGESET_KIND,
    version: SUBMISSION_DIRECT_ENTRY_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [
      submissionDirectEntryChangesetReadPort,
      submissionDirectEntryPlanningAttributionReadPort,
      submissionDirectEntryReferenceReadPort
    ],
    validationPorts: [submissionDirectEntryChangesetValidationPort],
    transactionPorts: [submissionDirectEntryChangesetTransactionPort],
    allowedAggregateKinds: ['intake_form'],
    allowedGuardKinds: ['intake_form_current_version'],
    allowedRisks: ['low'],
    allowedConsequences: ['submission_created'],
    allowedOutcomes: [
      {
        class: 'stale_revision',
        kind: 'submission_direct_entry_changed',
        retryable: false,
        detailSchema: outcomeDetailSchema.reference
      },
      {
        class: 'policy_violation',
        kind: 'submission_direct_entry_refused',
        retryable: false,
        detailSchema: outcomeDetailSchema.reference
      }
    ],
    allowedFacts: [{ kind: 'submission_created', version: 1 }],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = parseSubmissionDirectEntryChangesetAuthorInput(authorInput);
      const port = snapshot.getPort(submissionDirectEntryChangesetReadPort);
      const { formHead, formVersion } = requireCurrentForm(author, port);
      const attribution = requirePlanningAttribution(author.scope, snapshot);
      const plan = planApplicationDirectEntry({
        formHead,
        formVersion,
        collection: port,
        answers: author.answers,
        identities: {
          submissionId: author.identities.submissionId,
          submitEvidenceId: author.identities.entryEvidenceId,
          personId: author.identities.personId,
          participantIdentityId: author.identities.participantIdentityId,
          participantEvidenceId: author.identities.participantEvidenceId,
          consentEvidenceIds: []
        },
        enteredByUserId: attribution.enteredByUserId,
        requestDigestSha256: author.requestDigestSha256,
        server: { submittedAt: attribution.occurredAt }
      });
      return {
        plan,
        aggregateRefs: [{
          id: submissionDirectEntryFormAggregateId(plan.submission.formId),
          version: plan.formDefinitionVersion
        }],
        guardRefs: [{
          id: submissionDirectEntryFormGuardId(plan.submission.formId),
          version: plan.formDefinitionVersion,
          digest: plan.formVersionDigestSha256
        }],
        riskTier: 'low',
        consequences: ['submission_created']
      };
    },
    projectDiff(plan) {
      return {
        diff: submissionDirectEntrySafeDiff(plan),
        representedConsequences: ['submission_created']
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(submissionDirectEntryChangesetValidationPort);
      const formHead = port.readFormHead(plan.submission.scope, plan.submission.formId);
      const formVersion = port.readFormVersion(plan.submission.scope, plan.submission.formVersionId);
      if (!formHead || !formVersion) {
        return { kind: 'outcome', outcome: refusal('form_missing', plan) };
      }
      try {
        const validated = validateApplicationDirectEntryPlanAgainstForm({
          plan,
          formHead,
          formVersion,
          collection: port,
          payloadReferences: port.payloadReferences
        });
        return { kind: 'ready', validated };
      } catch (error) {
        if (error instanceof ApplicationPlanningError) {
          return { kind: 'outcome', outcome: refusal(refusalCode(error.code), plan) };
        }
        throw error;
      }
    },
    applyWithin(plan, transaction) {
      const result = submissionDirectEntryResultSchema.parse(
        transaction.getPort(submissionDirectEntryChangesetTransactionPort)
          .applyDirectEntryPlan(plan)
      );
      if (result.submissionId !== plan.submission.id
          || result.formId !== plan.submission.formId
          || result.formVersionId !== plan.submission.formVersionId
          || result.submittedAt !== plan.submission.submittedAt
          || result.undo.submissionId !== plan.submission.id) {
        throw new TypeError('submission_direct_entry_apply_result_mismatch');
      }
      return {
        result,
        facts: [{
          kind: 'submission_created',
          version: 1,
          payload: {
            schemaVersion: 1,
            workspaceId: plan.submission.scope.workspaceId,
            eventId: plan.submission.scope.eventId,
            submissionId: result.submissionId,
            formId: result.formId,
            formVersionId: result.formVersionId,
            source: 'direct_entry',
            submittedAt: result.submittedAt,
            triageQueryGuard: result.triage.queryGuard
          }
        }],
        effects: []
      };
    },
    deriveCompensation(plan, snapshot) {
      return compensation(plan, snapshot);
    }
  };
  const bundle: SubmissionDirectEntryChangesetBundle = Object.freeze({
    policy: input.policy,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, outcomeDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertSubmissionDirectEntryChangesetBundle(
  candidate: SubmissionDirectEntryChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) {
    throw new TypeError('invalid_submission_direct_entry_changeset_bundle');
  }
  assertSubmissionDirectEntryChangesetPolicy(candidate.policy);
}

export function parseSubmissionDirectEntryChangesetAuthorInput(
  candidate: unknown
): SubmissionDirectEntryChangesetAuthorInput {
  return deepFreeze(authorInputValueSchema.parse(candidate));
}

export function submissionDirectEntryFormAggregateId(formId: string): string {
  return `intake_form:${intakeIdSchema.parse(formId)}`;
}

export function submissionDirectEntryFormGuardId(formId: string): string {
  return `intake_form_current_version:${intakeIdSchema.parse(formId)}`;
}

export function submissionDirectEntrySafeDiff(
  planInput: ApplicationDirectEntryPlan
): SubmissionDirectEntrySafeDiff {
  const plan = parseApplicationDirectEntryPlan(planInput);
  return deepFreeze(submissionDirectEntrySafeDiffSchema.parse({
    schemaVersion: 1,
    action: 'create',
    submission: {
      id: plan.submission.id,
      formId: plan.submission.formId,
      formVersionId: plan.submission.formVersionId,
      source: 'direct_entry',
      submittedAt: plan.submission.submittedAt,
      answeredFieldIds: plan.entryEvidence.answers
        .map((answer) => answer.fieldId)
        .sort(compareText),
      programVocabularyAnswerPins: plan.entryEvidence.programVocabularyAnswerPins
    }
  }));
}

function requireCurrentForm(
  author: SubmissionDirectEntryChangesetAuthorInput,
  port: SubmissionDirectEntryReadPort
): { readonly formHead: FormDefinitionHeadDto; readonly formVersion: FormVersionDto } {
  const formHead = port.readFormHead(author.scope, author.formId);
  if (!formHead) throw new ApplicationPlanningError('form_version_mismatch');
  if (formHead.version !== author.expectedFormDefinitionVersion) {
    throw new ApplicationPlanningError('form_version_mismatch');
  }
  if (formHead.status !== 'open' || formHead.currentPublishedVersionId === null) {
    throw new ApplicationPlanningError('form_not_open');
  }
  const formVersion = port.readFormVersion(author.scope, formHead.currentPublishedVersionId);
  if (!formVersion) throw new ApplicationPlanningError('form_version_mismatch');
  return Object.freeze({ formHead, formVersion });
}

function refusalCode(code: ApplicationPlanningErrorCode): SubmissionDirectEntryRefusalCode {
  return (refusalCodes as readonly string[]).includes(code)
    ? code as SubmissionDirectEntryRefusalCode
    : 'invalid_plan';
}

function refusal(code: SubmissionDirectEntryRefusalCode, plan: ApplicationDirectEntryPlan) {
  const stale = new Set<SubmissionDirectEntryRefusalCode>([
    'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
    'target_unavailable', 'deadline_unavailable', 'deadline_changed'
  ]).has(code);
  return {
    class: stale ? ('stale_revision' as const) : ('policy_violation' as const),
    kind: stale ? 'submission_direct_entry_changed' : 'submission_direct_entry_refused',
    retryable: false,
    subjects: [{ type: 'submission', id: plan.submission.id }],
    detail: { code, action: 'create' as const, formId: plan.submission.formId },
    detailSchemaVersion: 1
  };
}

/**
 * The arrival record is immutable evidence, so no derivation un-creates it.
 * While the submission stands unreferenced its visible-effect removal is the
 * recoverable triage discard (the route the commit receipt's `undo` names);
 * once review or decision state references it, even that route is blocked.
 */
function compensation(
  plan: ApplicationDirectEntryPlan,
  snapshot: ChangesetPlanningSnapshot
): CompensationDerivation<SubmissionDirectEntryChangesetAuthorInput> {
  const references = snapshot.getPort(submissionDirectEntryReferenceReadPort);
  const currentDigest = references.readCurrentEntryRecordDigest(
    plan.submission.scope, plan.submission.id
  );
  if (currentDigest !== submissionDirectEntryRecordDigest(plan)) {
    return { kind: 'blocked', reasonKey: 'submission.direct_entry.later_change' };
  }
  const referenceCount = references.countSubmissionReferences(
    plan.submission.scope, plan.submission.id
  );
  if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) {
    throw new TypeError('submission_direct_entry_reference_census_invalid');
  }
  if (referenceCount > 0) {
    return { kind: 'blocked', reasonKey: 'submission.direct_entry.referenced' };
  }
  return { kind: 'blocked', reasonKey: 'submission.direct_entry.discard_via_triage' };
}

function requirePlanningAttribution(
  scopeInput: IntakeScopeDto,
  snapshot: ChangesetPlanningSnapshot
): { readonly enteredByUserId: string; readonly occurredAt: string } {
  const scope = intakeScopeSchema.parse(scopeInput);
  const source = snapshot.getPort(submissionDirectEntryPlanningAttributionReadPort)
    .readSubmissionDirectEntryPlanningAttribution(scope);
  if (!source) throw new TypeError('invalid_submission_direct_entry_planning_attribution');
  try {
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(
      source.context, source.authorityRecheck
    );
    const occurredAt = intakeInstantSchema.parse(
      resolveEffectInvocationCurrentAuthorityRecheckTime(source.context, source.authorityRecheck)
    );
    const context = source.context;
    const baseSubjects = context.scope.subjects.filter((subject) =>
      subject.kind === 'workspace' || subject.kind === 'event'
    );
    const ownerSubjects = context.scope.subjects.filter((subject) => subject.kind === 'domain');
    const exactBaseSubjects = baseSubjects.length === 2
      && baseSubjects.some((subject) =>
        subject.kind === 'workspace' && subject.id === scope.workspaceId
      )
      && baseSubjects.some((subject) => subject.kind === 'event' && subject.id === scope.eventId);
    const ordinaryPlanning = context.scope.subjects.length === 2
      && ownerSubjects.length === 0
      && context.operation.name === 'submission.direct_entry.create.draft'
      && authority.lane.policy.key === 'authority.submission.direct-entry'
      && authority.lane.policy.version === 1;
    const lifecyclePlanning = context.scope.subjects.length === 3
      && ownerSubjects.length === 1
      && ownerSubjects[0]!.domain === 'changeset'
      && ownerSubjects[0]!.entity === 'owner'
      && ownerSubjects[0]!.id === SUBMISSION_DIRECT_ENTRY_CHANGESET_OWNER_ID
      && ownerSubjects[0]!.version === undefined
      && new Set(['changeset.rebuild', 'changeset.correction.draft']).has(context.operation.name)
      && authority.lane.policy.key === 'authority.changeset.lifecycle'
      && authority.lane.policy.version === 1;
    if (context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== scope.workspaceId
        || context.scope.eventId !== scope.eventId
        || !exactBaseSubjects
        || (!ordinaryPlanning && !lifecyclePlanning)
        || context.actor.kind !== 'workspace_user'
        || authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || authority.actor.userId !== context.actor.userId
        || authority.scope.workspaceId !== scope.workspaceId
        || authority.scope.eventId !== scope.eventId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) {
      throw new TypeError('invalid_submission_direct_entry_planning_attribution');
    }
    return deepFreeze({
      enteredByUserId: intakeIdSchema.parse(authority.actor.userId),
      occurredAt
    });
  } catch {
    throw new TypeError('invalid_submission_direct_entry_planning_attribution');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Digest over the stored pair `{head, evidence}` — recomputable both from a
 * plan and from persisted rows, so the compensation census and its adapter
 * agree on one basis.
 */
export function submissionDirectEntryRecordDigest(source: {
  readonly submission: ApplicationDirectEntryPlan['submission'];
  readonly entryEvidence: ApplicationDirectEntryPlan['entryEvidence'];
}): string {
  return createHash('sha256').update(encodeCanonicalJson({
    head: source.submission,
    evidence: source.entryEvidence
  })).digest('hex');
}
