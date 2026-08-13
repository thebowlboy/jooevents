import {
  resolveEffectInvocationAuthorityRecheckAttribution,
  resolveEffectInvocationCurrentAuthorityRecheckTime,
  type EffectInvocationContext,
  type SealedEffectAuthorityRecheckResult
} from '@jooevents/application';
import {
  fieldRegistrySnapshotSchema,
  formClosingChangeDraftInputSchema,
  formDefinitionContentSchema,
  formDefinitionCreateDraftInputSchema,
  formDefinitionHeadSchema,
  formDefinitionReviseDraftInputSchema,
  formLifecycleChangeDraftInputSchema,
  formRegistryPinSchema,
  formTargetReferencePinSchema,
  formVersionPublishDraftInputSchema,
  formVersionSchema,
  intakeDigestSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeStableKeySchema,
  intakeVersionSchema,
  type FieldRegistrySnapshotDto,
  type FormClosingChangeDraftInput,
  type FormDefinitionContentDto,
  type FormDefinitionCreateDraftInput,
  type FormDefinitionReviseDraftInput,
  type FormLifecycleChangeDraftInput,
  type FormVersionDto,
  type FormVersionPublishDraftInput,
  type IntakeScopeDto
} from '@jooevents/contracts';
import {
  deadlineMutationPlanSchema,
  deadlineSafeDiffSchema
} from '@jooevents/contracts/deadlines';
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
  type CompensationDerivation,
  type GuardRef,
  type VersionRef
} from '@jooevents/changesets';
import {
  formCloseDeadlineAggregateRefs,
  formCloseDeadlineGuardRefs,
  formCloseDeadlinePlanningPort,
  formCloseDeadlineTransactionPort,
  formCloseDeadlineValidationPort,
  projectFormCloseDeadlineDiff,
  type FormCloseDeadlineContribution
} from '@jooevents/deadline';
import { z } from 'zod';
import {
  applyFormMutationPlan,
  formCatalogDigest,
  formVersionSetDigest,
  parseFormMutationPlan,
  planFormClosingChange,
  planFormCreation,
  planFormLifecycleChange,
  planFormPublication,
  planFormRevision,
  validateFormMutationPlan,
  FormPlanningError,
  type AppliedFormMutation,
  type FormDefinitionIdentityAssignment,
  type FormMutationPlan,
  type FormPlanningErrorCode,
  type FormTargetReferenceResolver
} from './forms';
import {
  assertFormOrdinaryPolicy,
  formActionSchema,
  formOrdinaryPolicySchema,
  type FormOrdinaryPolicy
} from './form-policy';
import { deepFreeze, parseFormCatalogState, type FormCatalogState } from './model';

export const FORM_CHANGESET_KIND = 'intake.form.mutate';
export const FORM_CHANGESET_VERSION = 3;

export interface FormChangesetAuthorBase {
  readonly scope: IntakeScopeDto;
}

/**
 * IDs in this internal author record are allocated by the effect adapter. The
 * public create/closing contracts deliberately never ask a browser to invent a
 * Deadline identity.
 */
export type FormChangesetAuthorInput =
  | (FormChangesetAuthorBase & {
      readonly action: 'create';
      readonly draft: FormDefinitionCreateDraftInput;
      readonly identities: FormDefinitionIdentityAssignment;
      readonly deadlineId: string | null;
    })
  | (FormChangesetAuthorBase & {
      readonly action: 'revise';
      readonly draft: FormDefinitionReviseDraftInput;
      readonly identities: FormDefinitionIdentityAssignment;
    })
  | (FormChangesetAuthorBase & {
      readonly action: 'publish';
      readonly draft: FormVersionPublishDraftInput;
      readonly formVersionId: string;
    })
  | (FormChangesetAuthorBase & {
      readonly action: 'lifecycle';
      readonly draft: FormLifecycleChangeDraftInput;
      readonly formVersionId: string | null;
    })
  | (FormChangesetAuthorBase & {
      readonly action: 'closing';
      readonly draft: FormClosingChangeDraftInput;
      readonly deadlineId: string | null;
    });

export interface FormChangesetReadPort extends FormTargetReferenceResolver {
  readFormCatalog(scope: IntakeScopeDto): FormCatalogState | undefined;
  readFormVersions(scope: IntakeScopeDto, formId: string): readonly FormVersionDto[];
  readFieldRegistrySnapshot(scope: IntakeScopeDto): FieldRegistrySnapshotDto | undefined;
}

export interface FormChangesetTransactionPort extends FormChangesetReadPort {
  applyFormPlan(plan: FormMutationPlan): AppliedFormMutation;
}

export interface FormPlanningAttributionSource {
  readonly context: EffectInvocationContext;
  readonly authorityRecheck: SealedEffectAuthorityRecheckResult;
}

export interface FormPlanningAttributionReadPort {
  readFormPlanningAttribution(scope: IntakeScopeDto): FormPlanningAttributionSource | undefined;
}

export const formChangesetReadPort = defineChangesetReadPort<FormChangesetReadPort>(
  'intake_form.read', 1
);
export const formChangesetValidationPort = defineChangesetValidationPort<FormChangesetReadPort>(
  'intake_form.validation', 1
);
export const formChangesetTransactionPort =
  defineChangesetTransactionPort<FormChangesetTransactionPort>('intake_form.transaction', 1);
export const formPlanningAttributionReadPort =
  defineChangesetReadPort<FormPlanningAttributionReadPort>('intake_form.planning_attribution', 1);

const identityAssignmentSchema: z.ZodType<FormDefinitionIdentityAssignment> = z.strictObject({
  formId: intakeIdSchema,
  rules: z.array(z.strictObject({ key: intakeStableKeySchema, id: intakeIdSchema }))
});

const authorCommon = { scope: intakeScopeSchema } as const;
const formChangesetAuthorInputSchema: z.ZodType<FormChangesetAuthorInput> =
  z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('create'), ...authorCommon,
      draft: formDefinitionCreateDraftInputSchema,
      identities: identityAssignmentSchema,
      deadlineId: intakeIdSchema.nullable()
    }),
    z.strictObject({
      action: z.literal('revise'), ...authorCommon,
      draft: formDefinitionReviseDraftInputSchema,
      identities: identityAssignmentSchema
    }),
    z.strictObject({
      action: z.literal('publish'), ...authorCommon,
      draft: formVersionPublishDraftInputSchema,
      formVersionId: intakeIdSchema
    }),
    z.strictObject({
      action: z.literal('lifecycle'), ...authorCommon,
      draft: formLifecycleChangeDraftInputSchema,
      formVersionId: intakeIdSchema.nullable()
    }),
    z.strictObject({
      action: z.literal('closing'), ...authorCommon,
      draft: formClosingChangeDraftInputSchema,
      deadlineId: intakeIdSchema.nullable()
    })
  ]).superRefine((author, context) => {
    if (author.action === 'create') {
      const needsDeadline = author.draft.definition.availability.kind === 'fixed_close_date';
      if (needsDeadline !== (author.deadlineId !== null)) context.addIssue({
        code: 'custom', path: ['deadlineId'],
        message: 'A fixed closing date requires exactly one server-authored Deadline identity.'
      });
    }
    if (author.action === 'lifecycle') {
      const publishes = author.draft.transition === 'publish_and_open';
      if (publishes !== (author.formVersionId !== null)) context.addIssue({
        code: 'custom', path: ['formVersionId'],
        message: 'Only first-open carries a server-authored FormVersion identity.'
      });
    }
  });

export function parseFormChangesetAuthorInput(candidate: unknown): FormChangesetAuthorInput {
  return deepFreeze(formChangesetAuthorInputSchema.parse(candidate));
}

// The Deadline pin is not a Deadline head. Keep the common base explicit rather
// than deriving it from a collaborator plan image.
const exactPlanBase = {
  scope: intakeScopeSchema,
  targetPin: formTargetReferencePinSchema.nullable(),
  deadlinePin: z.strictObject({
    id: intakeIdSchema,
    version: intakeVersionSchema,
    digestSha256: intakeDigestSchema,
    effectiveAt: intakeInstantSchema,
    displayDate: z.iso.date(),
    gracePolicy: z.literal('soft')
  }).nullable()
} as const;

const mutationPlanSchema: z.ZodType<FormMutationPlan> = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'), ...exactPlanBase,
    registryPin: formRegistryPinSchema,
    expectedCatalogVersion: intakeVersionSchema,
    catalogGuardDigestSha256: intakeDigestSchema,
    resultingCatalogVersion: intakeVersionSchema,
    deadlineContribution: deadlineMutationPlanSchema.nullable(),
    before: z.null(),
    after: formDefinitionHeadSchema
  }),
  z.strictObject({
    action: z.literal('revise'), ...exactPlanBase,
    registryPin: formRegistryPinSchema,
    before: formDefinitionHeadSchema,
    after: formDefinitionHeadSchema
  }),
  z.strictObject({
    action: z.literal('publish'), ...exactPlanBase,
    registryPin: formRegistryPinSchema,
    expectedLatestVersionNumber: z.number().int().nonnegative().safe(),
    versionSetDigestSha256: intakeDigestSchema,
    before: formDefinitionHeadSchema,
    after: formDefinitionHeadSchema,
    publishedVersion: formVersionSchema
  }),
  z.strictObject({
    action: z.literal('lifecycle'), ...exactPlanBase,
    registryPin: formRegistryPinSchema.nullable(),
    expectedLatestVersionNumber: z.number().int().nonnegative().safe().nullable(),
    versionSetDigestSha256: intakeDigestSchema.nullable(),
    before: formDefinitionHeadSchema,
    after: formDefinitionHeadSchema,
    publishedVersion: formVersionSchema.nullable()
  }),
  z.strictObject({
    action: z.literal('closing'), ...exactPlanBase,
    before: formDefinitionHeadSchema,
    after: formDefinitionHeadSchema,
    deadlineContribution: deadlineMutationPlanSchema
  })
]).superRefine((plan, context) => {
  try {
    parseFormMutationPlan(plan);
  } catch {
    context.addIssue({ code: 'custom', message: 'Form mutation plan must be exact and coherent.' });
  }
});

const authorSchema = defineChangesetSchema({
  key: 'intake.form.author', version: 3, schema: formChangesetAuthorInputSchema
});
const planSchema = defineChangesetSchema({
  key: 'intake.form.plan', version: 2,
  schema: z.strictObject({ policy: formOrdinaryPolicySchema, mutation: mutationPlanSchema })
});

const safeHeadSchema = z.strictObject({
  id: intakeIdSchema,
  version: intakeVersionSchema,
  status: z.enum(['draft', 'open', 'closed']),
  currentPublishedVersionId: intakeIdSchema.nullable(),
  definition: formDefinitionContentSchema
});
const publishedVersionSafeSchema = z.strictObject({
  id: intakeIdSchema,
  number: intakeVersionSchema,
  definitionDigestSha256: intakeDigestSchema
});
const safeDiffValueSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), before: z.null(), after: safeHeadSchema }),
  z.strictObject({ action: z.literal('revise'), before: safeHeadSchema, after: safeHeadSchema }),
  z.strictObject({
    action: z.literal('publish'), before: safeHeadSchema, after: safeHeadSchema,
    publishedVersion: publishedVersionSafeSchema
  }),
  z.strictObject({
    action: z.literal('lifecycle'), before: safeHeadSchema, after: safeHeadSchema,
    publishedVersion: publishedVersionSafeSchema.nullable()
  }),
  z.strictObject({
    action: z.literal('closing'), before: safeHeadSchema, after: safeHeadSchema,
    deadline: deadlineSafeDiffSchema
  })
]);
const diffSchema = defineChangesetSchema({
  key: 'intake.form.safe_diff', version: 2, schema: safeDiffValueSchema
});
const resultValueSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: formActionSchema,
  formId: intakeIdSchema,
  formDefinitionVersion: intakeVersionSchema,
  catalogVersion: intakeVersionSchema,
  publishedVersionId: intakeIdSchema.nullable()
});
const resultSchema = defineChangesetSchema({
  key: 'intake.form.result', version: 2, schema: resultValueSchema
});

const planningErrorCodes: readonly FormPlanningErrorCode[] = [
  'wrong_scope', 'stale_catalog', 'stale_definition', 'stale_registry',
  'form_exists', 'form_missing', 'form_not_publishable', 'form_version_exists',
  'category_missing', 'category_changed', 'session_unavailable', 'session_changed',
  'deadline_unavailable', 'deadline_changed', 'invalid_identity_assignment',
  'invalid_definition', 'invalid_transition', 'invalid_plan'
];
const outcomeDetailSchema = defineChangesetSchema({
  key: 'intake.form.stale_detail', version: 2,
  schema: z.strictObject({
    code: z.enum([...planningErrorCodes, 'policy_changed']),
    action: formActionSchema,
    formId: intakeIdSchema
  })
});

export type FormChangesetPlan = z.infer<typeof planSchema.schema>;
export type FormChangesetSafeDiff = z.infer<typeof safeDiffValueSchema>;
export type FormChangesetResult = z.infer<typeof resultValueSchema>;

type FormChangesetDefinition = ChangesetOperationDefinition<
  FormChangesetAuthorInput,
  FormChangesetPlan,
  FormChangesetSafeDiff,
  FormChangesetPlan,
  FormChangesetResult
>;

export interface FormOrdinaryChangesetBundle {
  readonly policy: FormOrdinaryPolicy;
  readonly registry: ChangesetDefinitionRegistry;
}

const issuedBundles = new WeakSet<object>();

export function createFormOrdinaryChangesetBundle(input: {
  readonly policy: FormOrdinaryPolicy;
}): FormOrdinaryChangesetBundle {
  assertFormOrdinaryPolicy(input.policy);
  const definition: FormChangesetDefinition = deepFreeze({
    kind: FORM_CHANGESET_KIND,
    version: FORM_CHANGESET_VERSION,
    schemas: {
      authorInput: authorSchema.reference,
      plan: planSchema.reference,
      diff: diffSchema.reference,
      result: resultSchema.reference
    },
    readPorts: [
      formChangesetReadPort,
      formPlanningAttributionReadPort,
      formCloseDeadlinePlanningPort
    ],
    validationPorts: [formChangesetValidationPort, formCloseDeadlineValidationPort],
    transactionPorts: [formChangesetTransactionPort, formCloseDeadlineTransactionPort],
    allowedAggregateKinds: [
      'intake_form', 'field_registry', 'program_track', 'program_format',
      'session', 'deadline', 'event'
    ],
    allowedGuardKinds: [
      'intake_form_catalog', 'intake_form_version_set', 'field_registry_guard',
      'deadline_catalog'
    ],
    allowedRisks: ['low', 'normal'],
    allowedConsequences: ['intake_form_changed', 'deadline_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'intake_form_changed',
      retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [
      { kind: 'intake_form_changed', version: 1 },
      { kind: 'deadline_changed', version: 1 }
    ],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = parseFormChangesetAuthorInput(authorInput);
      const port = snapshot.getPort(formChangesetReadPort);
      const catalog = requireCatalog(author.scope, port);
      const registry = requireRegistry(author.scope, port);
      const attribution = requirePlanningAttribution(author.scope, snapshot);
      const mutation = planMutation(author, catalog, registry, port, attribution, snapshot);
      const consequences = formConsequences(mutation);
      return {
        plan: { policy: input.policy, mutation },
        aggregateRefs: aggregateRefs(mutation),
        guardRefs: guardRefs(mutation),
        riskTier: input.policy.ordinaryRisk,
        consequences
      };
    },
    projectDiff(plan) {
      return {
        diff: safeDiff(plan.mutation),
        representedConsequences: formConsequences(plan.mutation)
      };
    },
    validateWithin(plan, validation) {
      const port = validation.getPort(formChangesetValidationPort);
      const catalog = port.readFormCatalog(plan.mutation.scope);
      const registry = port.readFieldRegistrySnapshot(plan.mutation.scope);
      if (!catalog || !registry) {
        return { kind: 'outcome', outcome: refusal('wrong_scope', plan.mutation) };
      }
      if (canonicalJsonSha256(plan.policy) !== canonicalJsonSha256(input.policy)) {
        return { kind: 'outcome', outcome: refusal('policy_changed', plan.mutation) };
      }
      const contribution = deadlineContribution(plan.mutation);
      if (contribution !== null) {
        const result = validation.getPort(formCloseDeadlineValidationPort)
          .validateFormCloseDeadline(contribution);
        if (result.kind === 'refused') {
          return { kind: 'outcome', outcome: refusal('deadline_changed', plan.mutation) };
        }
      }
      const versions = publishesVersion(plan.mutation)
        ? port.readFormVersions(plan.mutation.scope, plan.mutation.before.id)
        : undefined;
      const code = validateFormMutationPlan({
        catalog,
        registry: fieldRegistrySnapshotSchema.parse(registry),
        plan: plan.mutation,
        references: port,
        ...(versions === undefined ? {} : { existingVersions: versions })
      });
      return code
        ? { kind: 'outcome', outcome: refusal(code, plan.mutation) }
        : { kind: 'ready', validated: plan };
    },
    applyWithin(plan, transaction) {
      const contribution = deadlineContribution(plan.mutation);
      const deadlineApplied = contribution === null
        ? null
        : transaction.getPort(formCloseDeadlineTransactionPort)
          .applyFormCloseDeadline(contribution);
      if (deadlineApplied !== null
          && canonicalJsonSha256(deadlineApplied.pin)
            !== canonicalJsonSha256(plan.mutation.deadlinePin)) {
        throw new TypeError('form_close_deadline_apply_pin_changed');
      }
      const applied = transaction.getPort(formChangesetTransactionPort)
        .applyFormPlan(plan.mutation);
      const result = resultValueSchema.parse({
        schemaVersion: 1,
        action: plan.mutation.action,
        formId: plan.mutation.after.id,
        formDefinitionVersion: plan.mutation.after.version,
        catalogVersion: applied.catalog.version,
        publishedVersionId: plan.mutation.after.currentPublishedVersionId
      });
      return {
        result,
        facts: [{
          kind: 'intake_form_changed',
          version: 1,
          payload: {
            action: result.action,
            formId: result.formId,
            formDefinitionVersion: result.formDefinitionVersion,
            catalogVersion: result.catalogVersion,
            publishedVersionId: result.publishedVersionId
          }
        }, ...(deadlineApplied?.facts ?? [])],
        effects: [...(deadlineApplied?.effects ?? [])]
      };
    },
    deriveCompensation(plan, snapshot) {
      return compensation(plan.mutation, snapshot);
    }
  });
  const bundle: FormOrdinaryChangesetBundle = Object.freeze({
    policy: input.policy,
    registry: createChangesetDefinitionRegistry({
      schemas: [authorSchema, planSchema, diffSchema, resultSchema, outcomeDetailSchema],
      definitions: [definition]
    })
  });
  issuedBundles.add(bundle);
  return bundle;
}

export function assertFormOrdinaryChangesetBundle(
  candidate: FormOrdinaryChangesetBundle
): void {
  if (!issuedBundles.has(candidate)) throw new TypeError('invalid_form_ordinary_changeset_bundle');
  assertFormOrdinaryPolicy(candidate.policy);
}

export function formAggregateId(formId: string): string {
  return `intake_form:${intakeIdSchema.parse(formId)}`;
}

export function formCatalogGuardId(eventId: string): string {
  return `intake_form_catalog:${intakeIdSchema.parse(eventId)}`;
}

export function formVersionSetGuardId(formId: string): string {
  return `intake_form_version_set:${intakeIdSchema.parse(formId)}`;
}

export function formVersionSetGuardVersion(latestPublishedVersionNumber: number): number {
  if (!Number.isSafeInteger(latestPublishedVersionNumber) || latestPublishedVersionNumber < 0) {
    throw new TypeError('invalid_form_version_set_guard_version');
  }
  return latestPublishedVersionNumber + 1;
}

function requireCatalog(scope: IntakeScopeDto, port: FormChangesetReadPort): FormCatalogState {
  const catalog = port.readFormCatalog(scope);
  if (!catalog) throw new FormPlanningError('wrong_scope');
  return parseFormCatalogState(catalog);
}

function requireRegistry(
  scope: IntakeScopeDto,
  port: FormChangesetReadPort
): FieldRegistrySnapshotDto {
  const registry = port.readFieldRegistrySnapshot(scope);
  if (!registry) throw new FormPlanningError('wrong_scope');
  const parsed = fieldRegistrySnapshotSchema.parse(registry);
  if (parsed.scope.workspaceId !== scope.workspaceId || parsed.scope.eventId !== scope.eventId) {
    throw new FormPlanningError('wrong_scope');
  }
  return parsed;
}

function planMutation(
  author: FormChangesetAuthorInput,
  catalog: FormCatalogState,
  registry: FieldRegistrySnapshotDto,
  port: FormChangesetReadPort,
  attribution: FormPlanningAttributionRecord,
  snapshot: ChangesetPlanningSnapshot
): FormMutationPlan {
  if (author.action === 'create') {
    const deadlineContribution = author.draft.definition.availability.kind === 'fixed_close_date'
      ? snapshot.getPort(formCloseDeadlinePlanningPort).planFormCloseDeadlineChange({
          scope: author.scope,
          currentDeadlineId: null,
          closesAt: author.draft.definition.availability.displayDate,
          identity: { deadlineId: author.deadlineId! },
          attribution: { userId: attribution.actorUserId, at: attribution.occurredAt }
        })
      : null;
    return planFormCreation({
      catalog,
      registry,
      authorInput: author.draft,
      identities: author.identities,
      references: port,
      deadlineContribution,
      server: { createdByUserId: attribution.actorUserId, createdAt: attribution.occurredAt }
    });
  }
  const head = catalog.heads.find((candidate) => candidate.id === author.draft.formId);
  if (!head) throw new FormPlanningError('form_missing');
  if (author.action === 'revise') return planFormRevision({
    head,
    registry,
    authorInput: author.draft,
    identities: author.identities,
    references: port,
    server: { updatedByUserId: attribution.actorUserId, updatedAt: attribution.occurredAt }
  });
  if (author.action === 'publish') return planFormPublication({
    head,
    registry,
    existingVersions: port.readFormVersions(author.scope, head.id),
    authorInput: author.draft,
    references: port,
    server: {
      formVersionId: author.formVersionId,
      publishedByUserId: attribution.actorUserId,
      publishedAt: attribution.occurredAt
    }
  });
  if (author.action === 'lifecycle') return planFormLifecycleChange({
    head,
    ...(author.draft.transition === 'publish_and_open'
      ? {
          registry,
          existingVersions: port.readFormVersions(author.scope, head.id),
          server: {
            updatedByUserId: attribution.actorUserId,
            updatedAt: attribution.occurredAt,
            formVersionId: author.formVersionId!
          }
        }
      : {
          server: {
            updatedByUserId: attribution.actorUserId,
            updatedAt: attribution.occurredAt
          }
        }),
    authorInput: author.draft,
    references: port
  });
  const currentDeadlineId = head.definition.availability.kind === 'deadline'
    ? head.definition.availability.deadlineId
    : null;
  if (currentDeadlineId === null && author.draft.closesAt === null) {
    throw new FormPlanningError('invalid_transition');
  }
  if ((currentDeadlineId === null) !== (author.deadlineId !== null)) {
    throw new FormPlanningError('invalid_plan');
  }
  const planning = snapshot.getPort(formCloseDeadlinePlanningPort);
  const contribution = currentDeadlineId === null
    ? planning.planFormCloseDeadlineChange({
        scope: author.scope,
        currentDeadlineId: null,
        closesAt: author.draft.closesAt!,
        identity: { deadlineId: author.deadlineId! },
        attribution: { userId: attribution.actorUserId, at: attribution.occurredAt }
      })
    : planning.planFormCloseDeadlineChange({
        scope: author.scope,
        currentDeadlineId,
        closesAt: author.draft.closesAt,
        attribution: { userId: attribution.actorUserId, at: attribution.occurredAt }
      });
  return planFormClosingChange({
    head,
    authorInput: author.draft,
    deadlineContribution: contribution,
    server: { updatedByUserId: attribution.actorUserId, updatedAt: attribution.occurredAt }
  });
}

function deadlineContribution(plan: FormMutationPlan): FormCloseDeadlineContribution | null {
  if (plan.action === 'closing') return plan.deadlineContribution;
  if (plan.action === 'create') return plan.deadlineContribution;
  return null;
}

function publishesVersion(
  plan: FormMutationPlan
): plan is Extract<FormMutationPlan, { action: 'publish' | 'lifecycle' }> {
  return plan.action === 'publish'
    || (plan.action === 'lifecycle' && plan.publishedVersion !== null);
}

function formConsequences(plan: FormMutationPlan): readonly string[] {
  return deadlineContribution(plan) === null
    ? ['intake_form_changed']
    : ['intake_form_changed', 'deadline_changed'];
}

function registryPin(plan: FormMutationPlan) {
  if (plan.action === 'create' || plan.action === 'revise' || plan.action === 'publish') {
    return plan.registryPin;
  }
  return plan.action === 'lifecycle' ? plan.registryPin : null;
}

function aggregateRefs(plan: FormMutationPlan): readonly VersionRef[] {
  const pin = registryPin(plan);
  const refs: VersionRef[] = [
    ...(plan.action === 'create'
      ? []
      : [{ id: formAggregateId(plan.before.id), version: plan.before.version }]),
    ...(pin === null
      ? []
      : [{ id: `field_registry:${plan.scope.eventId}`, version: pin.version }]),
    ...(plan.targetPin === null ? [] : [{
      id: plan.targetPin.kind === 'category'
        ? `program_${plan.targetPin.categoryKind}:${plan.targetPin.id}`
        : `session:${plan.targetPin.id}`,
      version: plan.targetPin.version
    }]),
    ...(plan.deadlinePin === null || deadlineContribution(plan) !== null
      ? []
      : [{ id: `deadline:${plan.deadlinePin.id}`, version: plan.deadlinePin.version }]),
    ...(deadlineContribution(plan) === null
      ? []
      : formCloseDeadlineAggregateRefs(deadlineContribution(plan)!))
  ];
  return uniqueVersionRefs(refs);
}

function guardRefs(plan: FormMutationPlan): readonly GuardRef[] {
  const pin = registryPin(plan);
  const refs: GuardRef[] = [
    ...(plan.action === 'create' ? [{
      id: formCatalogGuardId(plan.scope.eventId),
      version: plan.expectedCatalogVersion,
      digest: plan.catalogGuardDigestSha256
    }] : []),
    ...(publishesVersion(plan) ? [{
      id: formVersionSetGuardId(plan.before.id),
      version: formVersionSetGuardVersion(plan.expectedLatestVersionNumber!),
      digest: plan.versionSetDigestSha256!
    }] : []),
    ...(pin === null ? [] : [{
      id: `field_registry_guard:${plan.scope.eventId}`,
      version: pin.version,
      digest: pin.digestSha256
    }]),
    ...(deadlineContribution(plan) === null
      ? []
      : formCloseDeadlineGuardRefs(deadlineContribution(plan)!))
  ];
  return uniqueGuardRefs(refs);
}

function uniqueVersionRefs(refs: readonly VersionRef[]): readonly VersionRef[] {
  const byId = new Map<string, VersionRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.id);
    if (prior && prior.version !== ref.version) throw new FormPlanningError('invalid_plan');
    byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

function uniqueGuardRefs(refs: readonly GuardRef[]): readonly GuardRef[] {
  const byId = new Map<string, GuardRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.id);
    if (prior && (prior.version !== ref.version || prior.digest !== ref.digest)) {
      throw new FormPlanningError('invalid_plan');
    }
    byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

function safeHead(head: FormMutationPlan['after']) {
  return {
    id: head.id,
    version: head.version,
    status: head.status,
    currentPublishedVersionId: head.currentPublishedVersionId,
    definition: head.definition
  };
}

function safePublishedVersion(version: FormVersionDto) {
  return {
    id: version.id,
    number: version.number,
    definitionDigestSha256: version.definitionDigestSha256
  };
}

function safeDiff(plan: FormMutationPlan): FormChangesetSafeDiff {
  if (plan.action === 'create') {
    return { action: 'create', before: null, after: safeHead(plan.after) };
  }
  if (plan.action === 'publish') return {
    action: 'publish',
    before: safeHead(plan.before),
    after: safeHead(plan.after),
    publishedVersion: safePublishedVersion(plan.publishedVersion)
  };
  if (plan.action === 'lifecycle') return {
    action: 'lifecycle',
    before: safeHead(plan.before),
    after: safeHead(plan.after),
    publishedVersion: plan.publishedVersion === null
      ? null : safePublishedVersion(plan.publishedVersion)
  };
  if (plan.action === 'closing') return {
    action: 'closing',
    before: safeHead(plan.before),
    after: safeHead(plan.after),
    deadline: projectFormCloseDeadlineDiff(plan.deadlineContribution)
  };
  return { action: 'revise', before: safeHead(plan.before), after: safeHead(plan.after) };
}

function refusal(
  code: FormPlanningErrorCode | 'policy_changed',
  plan: FormMutationPlan
) {
  return {
    class: 'stale_revision' as const,
    kind: 'intake_form_changed',
    retryable: false,
    subjects: [{ type: 'intake_form', id: plan.after.id }],
    detail: { code, action: plan.action, formId: plan.after.id },
    detailSchemaVersion: 2
  };
}

function compensation(
  plan: FormMutationPlan,
  snapshot: ChangesetPlanningSnapshot
): CompensationDerivation<FormChangesetAuthorInput> {
  const port = snapshot.getPort(formChangesetReadPort);
  const catalog = port.readFormCatalog(plan.scope);
  const current = catalog?.heads.find((head) => head.id === plan.after.id);
  if (!current || canonicalJsonSha256(current) !== canonicalJsonSha256(plan.after)) {
    return { kind: 'blocked', reasonKey: 'intake.form_later_change' };
  }
  if (plan.action === 'create') {
    return { kind: 'blocked', reasonKey: 'intake.form_delete_not_available' };
  }
  if (plan.action === 'publish') {
    return { kind: 'blocked', reasonKey: 'intake.form_published_version_is_immutable' };
  }
  if (plan.action === 'closing') {
    return { kind: 'blocked', reasonKey: 'intake.form_deadline_correction_requires_explicit_review' };
  }
  let attribution: FormPlanningAttributionRecord;
  try {
    attribution = requirePlanningAttribution(plan.scope, snapshot);
  } catch {
    return { kind: 'blocked', reasonKey: 'intake.form_correction_requires_fresh_attribution' };
  }
  if (plan.action === 'revise') return {
    kind: 'semantic',
    authorInput: {
      action: 'revise',
      scope: attribution.scope,
      draft: {
        formId: current.id,
        expectedDefinitionVersion: current.version,
        expectedRegistryVersion: requireRegistry(plan.scope, port).version,
        definition: definitionAuthorInput(plan.before.definition)
      },
      identities: definitionIdentities(plan.before)
    },
    noteKey: 'intake.form_definition_semantically_restored'
  };
  const transition = plan.after.status === 'closed' ? 'reopen' : 'close';
  return {
    kind: 'semantic',
    authorInput: {
      action: 'lifecycle',
      scope: attribution.scope,
      draft: {
        transition,
        formId: current.id,
        expectedDefinitionVersion: current.version
      },
      formVersionId: null
    },
    noteKey: plan.publishedVersion === null
      ? 'intake.form_lifecycle_semantically_restored'
      : 'intake.form_first_publication_retained_and_form_closed'
  };
}

interface FormPlanningAttributionRecord extends FormChangesetAuthorBase {
  readonly actorUserId: string;
  readonly occurredAt: string;
}

function requirePlanningAttribution(
  scope: IntakeScopeDto,
  snapshot: ChangesetPlanningSnapshot
): FormPlanningAttributionRecord {
  const expectedScope = intakeScopeSchema.parse(scope);
  const source = snapshot.getPort(formPlanningAttributionReadPort)
    .readFormPlanningAttribution(expectedScope);
  if (!source) throw new TypeError('invalid_form_planning_attribution');
  try {
    const authority = resolveEffectInvocationAuthorityRecheckAttribution(
      source.context, source.authorityRecheck
    );
    const occurredAt = intakeInstantSchema.parse(
      resolveEffectInvocationCurrentAuthorityRecheckTime(
        source.context, source.authorityRecheck
      )
    );
    const context = source.context;
    const baseSubjects = context.scope.subjects.filter((subject) =>
      subject.kind === 'workspace' || subject.kind === 'event'
    );
    const ownerSubjects = context.scope.subjects.filter((subject) => subject.kind === 'domain');
    const exactBaseSubjects = baseSubjects.length === 2
      && baseSubjects.some((subject) =>
        subject.kind === 'workspace' && subject.id === expectedScope.workspaceId
      )
      && baseSubjects.some((subject) =>
        subject.kind === 'event' && subject.id === expectedScope.eventId
      );
    const ordinaryPlanning = context.scope.subjects.length === 2
      && ownerSubjects.length === 0
      && new Set([
        'form.definition.create.draft',
        'form.definition.revise.draft',
        'form.version.publish.draft',
        'form.lifecycle.change.draft',
        'form.closing.change.draft'
      ]).has(context.operation.name)
      && authority.lane.policy.key === 'authority.intake.event-manage'
      && authority.lane.policy.version === 1;
    const correctionPlanning = context.scope.subjects.length === 3
      && ownerSubjects.length === 1
      && ownerSubjects[0]!.domain === 'changeset'
      && ownerSubjects[0]!.entity === 'owner'
      && ownerSubjects[0]!.id === 'intake_form'
      && ownerSubjects[0]!.version === undefined
      && new Set(['changeset.rebuild', 'changeset.correction.draft'])
        .has(context.operation.name)
      && authority.lane.policy.key === 'authority.changeset.lifecycle'
      && authority.lane.policy.version === 1;
    if (context.operation.effect !== 'draft'
        || context.surface !== 'operator_http'
        || context.scope.workspaceId !== expectedScope.workspaceId
        || context.scope.eventId !== expectedScope.eventId
        || !exactBaseSubjects
        || (!ordinaryPlanning && !correctionPlanning)
        || context.actor.kind !== 'workspace_user'
        || authority.actor.kind !== 'workspace_user'
        || authority.principal.kind !== 'workspace_user'
        || authority.actor.userId !== authority.principal.userId
        || authority.actor.userId !== context.actor.userId
        || authority.scope.workspaceId !== expectedScope.workspaceId
        || authority.scope.eventId !== expectedScope.eventId
        || authority.lane.kind !== 'operator'
        || authority.lane.surface !== 'operator_http'
        || !authority.grants.some((grant) =>
          grant.kind === 'permission' && grant.key === 'event.manage'
        )) {
      throw new TypeError('invalid_form_planning_attribution');
    }
    return deepFreeze({
      scope: expectedScope,
      actorUserId: intakeIdSchema.parse(authority.actor.userId),
      occurredAt
    });
  } catch {
    throw new TypeError('invalid_form_planning_attribution');
  }
}

function definitionAuthorInput(
  definition: FormDefinitionContentDto
): FormDefinitionReviseDraftInput['definition'] {
  return {
    kind: definition.kind,
    name: definition.name,
    target: definition.target,
    availability: definition.availability,
    confirmation: definition.confirmation,
    composition: definition.composition,
    rules: definition.rules.map((rule) => ({
      key: rule.key,
      condition: rule.condition,
      effect: rule.effect
    }))
  };
}

function definitionIdentities(
  head: Extract<FormMutationPlan, { action: 'revise' }>['before']
): FormDefinitionIdentityAssignment {
  return {
    formId: head.id,
    rules: head.definition.rules.map((rule) => ({ key: rule.key, id: rule.id }))
  };
}

/** Reference helper for transaction adapters implementing the declared port. */
export function applyFormChangesetPlan(input: {
  readonly port: FormChangesetReadPort;
  readonly plan: FormMutationPlan;
}): AppliedFormMutation {
  const catalog = requireCatalog(input.plan.scope, input.port);
  const registry = requireRegistry(input.plan.scope, input.port);
  const versions = publishesVersion(input.plan)
    ? input.port.readFormVersions(input.plan.scope, input.plan.before.id)
    : undefined;
  return applyFormMutationPlan({
    catalog,
    registry,
    plan: input.plan,
    references: input.port,
    ...(versions === undefined ? {} : { existingVersions: versions })
  });
}
