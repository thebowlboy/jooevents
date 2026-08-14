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
  intakeFormSurfaceSuccessorDiffSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  intakeStableKeySchema,
  intakeVersionSchema,
  releaseMutationResultSchema,
  releaseSurfaceSuccessorPlanSchema,
  type FieldRegistrySnapshotDto,
  type FormClosingChangeDraftInput,
  type FormDefinitionContentDto,
  type FormDefinitionCreateDraftInput,
  type FormDefinitionReviseDraftInput,
  type FormLifecycleChangeDraftInput,
  type FormVersionDto,
  type FormVersionPublishDraftInput,
  type IntakeScopeDto,
  type ReleaseMutationResultDto,
  type ReleaseSurfaceSuccessorInputDto,
  type ReleaseSurfaceSuccessorPlanDto,
  type SurfaceHeadDto
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

/**
 * The owner Model-3 coupling seam, hosted where the coupling rule binds: any
 * form plan that mints a FormVersion consults this collaboration at propose
 * time and freezes the resulting successor apply-surface releases into its own
 * reviewed plan. The plan schema makes the consultation non-bypassable — a
 * version-minting plan without a recorded successor set cannot parse — so a
 * republish can never silently leave a public apply surface pinned to the
 * superseded version. The composing runtime bridges these ports to the release
 * domain's `planReleaseSurfaceSuccessorFrom` / `validate…` / apply functions.
 */
export interface FormSurfaceSuccessorPlanningPort {
  planFormSurfaceSuccessors(input: ReleaseSurfaceSuccessorInputDto): {
    readonly plan: ReleaseSurfaceSuccessorPlanDto;
    readonly guardRefs: readonly GuardRef[];
  };
}

export type FormSurfaceSuccessorValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused' };

export interface FormSurfaceSuccessorValidationPort {
  validateFormSurfaceSuccessors(
    plan: ReleaseSurfaceSuccessorPlanDto
  ): FormSurfaceSuccessorValidation;
}

export interface FormSurfaceSuccessorTransactionPort {
  applyFormSurfaceSuccessors(plan: ReleaseSurfaceSuccessorPlanDto): readonly SurfaceHeadDto[];
}

export const formSurfaceSuccessorPlanningPort =
  defineChangesetReadPort<FormSurfaceSuccessorPlanningPort>(
    'intake_form.surface_successor.planning', 1
  );
export const formSurfaceSuccessorValidationPort =
  defineChangesetValidationPort<FormSurfaceSuccessorValidationPort>(
    'intake_form.surface_successor.validation', 1
  );
export const formSurfaceSuccessorTransactionPort =
  defineChangesetTransactionPort<FormSurfaceSuccessorTransactionPort>(
    'intake_form.surface_successor.transaction', 1
  );

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
// Version 3: version-minting plans (publish, first-open lifecycle) freeze the
// surface-successor collaboration result — the owner Model-3 "same reviewed
// changeset" coupling — beside the mutation.
const planSchema = defineChangesetSchema({
  key: 'intake.form.plan', version: 3,
  schema: z.strictObject({
    policy: formOrdinaryPolicySchema,
    mutation: mutationPlanSchema,
    surfaceSuccessors: releaseSurfaceSuccessorPlanSchema.nullable()
  }).superRefine((plan, context) => {
    const minting = plan.mutation.action === 'publish'
      || (plan.mutation.action === 'lifecycle' && plan.mutation.publishedVersion !== null);
    if (minting !== (plan.surfaceSuccessors !== null)) {
      context.addIssue({
        code: 'custom', path: ['surfaceSuccessors'],
        message: 'exactly a version-minting plan records its surface-successor consultation'
      });
      return;
    }
    if (plan.surfaceSuccessors === null || plan.mutation.action === 'create') return;
    const mutation = plan.mutation;
    const publishedVersionId = mutation.action === 'publish'
      ? mutation.publishedVersion.id
      : mutation.action === 'lifecycle'
        ? mutation.publishedVersion?.id
        : undefined;
    if (plan.surfaceSuccessors.input.formId !== mutation.before.id
        || plan.surfaceSuccessors.input.formVersionId !== publishedVersionId
        || plan.surfaceSuccessors.input.scope.workspaceId !== mutation.scope.workspaceId
        || plan.surfaceSuccessors.input.scope.eventId !== mutation.scope.eventId) {
      context.addIssue({
        code: 'custom', path: ['surfaceSuccessors'],
        message: 'surface successors must pin exactly the minted form version'
      });
    }
  })
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
    publishedVersion: publishedVersionSafeSchema,
    surfaceSuccessors: z.array(intakeFormSurfaceSuccessorDiffSchema).max(20)
  }),
  z.strictObject({
    action: z.literal('lifecycle'), before: safeHeadSchema, after: safeHeadSchema,
    publishedVersion: publishedVersionSafeSchema.nullable(),
    surfaceSuccessors: z.array(intakeFormSurfaceSuccessorDiffSchema).max(20).nullable()
  }),
  z.strictObject({
    action: z.literal('closing'), before: safeHeadSchema, after: safeHeadSchema,
    deadline: deadlineSafeDiffSchema
  })
]);
// Version 3: version-minting diffs show which public apply surfaces the same
// commit re-releases onto the minted version.
const diffSchema = defineChangesetSchema({
  key: 'intake.form.safe_diff', version: 3, schema: safeDiffValueSchema
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
// Version 3: adds the validate-time surface-successor drift refusal.
const outcomeDetailSchema = defineChangesetSchema({
  key: 'intake.form.stale_detail', version: 3,
  schema: z.strictObject({
    code: z.enum([...planningErrorCodes, 'policy_changed', 'surface_successor_changed']),
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
      formCloseDeadlinePlanningPort,
      formSurfaceSuccessorPlanningPort
    ],
    validationPorts: [
      formChangesetValidationPort,
      formCloseDeadlineValidationPort,
      formSurfaceSuccessorValidationPort
    ],
    transactionPorts: [
      formChangesetTransactionPort,
      formCloseDeadlineTransactionPort,
      formSurfaceSuccessorTransactionPort
    ],
    allowedAggregateKinds: [
      'intake_form', 'field_registry', 'program_track', 'program_format',
      'session', 'deadline', 'event'
    ],
    allowedGuardKinds: [
      'intake_form_catalog', 'intake_form_version_set', 'field_registry_guard',
      'deadline_catalog', 'surface_head_state'
    ],
    allowedRisks: ['low', 'normal'],
    allowedConsequences: ['intake_form_changed', 'deadline_changed', 'release_changed'],
    allowedOutcomes: [{
      class: 'stale_revision',
      kind: 'intake_form_changed',
      retryable: false,
      detailSchema: outcomeDetailSchema.reference
    }],
    allowedFacts: [
      { kind: 'intake_form_changed', version: 1 },
      { kind: 'deadline_changed', version: 1 },
      { kind: 'release_changed', version: 1 }
    ],
    allowedEffects: [],
    plan(authorInput, snapshot) {
      const author = parseFormChangesetAuthorInput(authorInput);
      const port = snapshot.getPort(formChangesetReadPort);
      const catalog = requireCatalog(author.scope, port);
      const registry = requireRegistry(author.scope, port);
      const attribution = requirePlanningAttribution(author.scope, snapshot);
      const mutation = planMutation(author, catalog, registry, port, attribution, snapshot);
      const successors = planSurfaceSuccessors(mutation, attribution, snapshot);
      const plan = {
        policy: input.policy,
        mutation,
        surfaceSuccessors: successors?.plan ?? null
      };
      return {
        plan,
        aggregateRefs: aggregateRefs(mutation),
        guardRefs: uniqueGuardRefs([...guardRefs(mutation), ...(successors?.guardRefs ?? [])]),
        riskTier: input.policy.ordinaryRisk,
        consequences: formConsequences(plan)
      };
    },
    projectDiff(plan) {
      return {
        diff: safeDiff(plan),
        representedConsequences: formConsequences(plan)
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
      if (code) return { kind: 'outcome', outcome: refusal(code, plan.mutation) };
      if (plan.surfaceSuccessors !== null) {
        const successors = validation.getPort(formSurfaceSuccessorValidationPort)
          .validateFormSurfaceSuccessors(plan.surfaceSuccessors);
        if (successors.kind !== 'ready') {
          return { kind: 'outcome', outcome: refusal('surface_successor_changed', plan.mutation) };
        }
      }
      return { kind: 'ready', validated: plan };
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
      let successorFacts: readonly {
        readonly kind: 'release_changed';
        readonly version: 1;
        readonly payload: ReleaseMutationResultDto;
      }[] = [];
      if (plan.surfaceSuccessors !== null) {
        const heads = transaction.getPort(formSurfaceSuccessorTransactionPort)
          .applyFormSurfaceSuccessors(plan.surfaceSuccessors);
        const expected = plan.surfaceSuccessors.successors.map((successor) => successor.headAfter);
        if (canonicalJsonSha256(heads) !== canonicalJsonSha256(expected)) {
          throw new TypeError('form_surface_successor_apply_head_changed');
        }
        // One canonical release-domain result per successor, so audit and
        // outbox consumers see ordinary surface publishes — same fact kind and
        // payload shape the release changeset itself emits.
        successorFacts = plan.surfaceSuccessors.successors.map((successor) => ({
          kind: 'release_changed' as const,
          version: 1 as const,
          payload: releaseMutationResultSchema.parse({
            action: 'surface_publish',
            release: successor.release,
            head: successor.headAfter
          })
        }));
      }
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
        }, ...successorFacts, ...(deadlineApplied?.facts ?? [])],
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

/**
 * Consults the successor collaboration for every version-minting mutation. A
 * first publish provably yields an empty set (no apply surface can pin an
 * unpublished form), but the consultation is still recorded so no minting
 * path — present or future — can skip the coupling. Collaboration failures
 * refuse the plan; they are corrupt-state, never a partial publish.
 */
function planSurfaceSuccessors(
  mutation: FormMutationPlan,
  attribution: FormPlanningAttributionRecord,
  snapshot: ChangesetPlanningSnapshot
): { readonly plan: ReleaseSurfaceSuccessorPlanDto; readonly guardRefs: readonly GuardRef[] } | null {
  if (!publishesVersion(mutation) || mutation.publishedVersion === null) return null;
  try {
    const planned = snapshot.getPort(formSurfaceSuccessorPlanningPort)
      .planFormSurfaceSuccessors({
        scope: mutation.scope,
        formId: mutation.before.id,
        formVersionId: mutation.publishedVersion.id,
        actorUserId: attribution.actorUserId,
        occurredAt: attribution.occurredAt
      });
    return {
      plan: releaseSurfaceSuccessorPlanSchema.parse(planned.plan),
      guardRefs: planned.guardRefs
    };
  } catch (error) {
    // Release-domain refusals and malformed collaboration output refuse the
    // plan as corrupt state; infrastructure failures stay loud.
    if (error instanceof Error
        && (error.name === 'ReleasePlanningError' || error.name === 'ZodError')) {
      throw new FormPlanningError('invalid_plan');
    }
    throw error;
  }
}

function formConsequences(plan: {
  readonly mutation: FormMutationPlan;
  readonly surfaceSuccessors: ReleaseSurfaceSuccessorPlanDto | null;
}): readonly string[] {
  return [
    'intake_form_changed',
    ...((plan.surfaceSuccessors?.successors.length ?? 0) > 0 ? ['release_changed'] : []),
    ...(deadlineContribution(plan.mutation) === null ? [] : ['deadline_changed'])
  ];
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

function safeSurfaceSuccessors(successors: ReleaseSurfaceSuccessorPlanDto) {
  return successors.successors.map((successor) => ({
    surfaceReleaseId: successor.release.id,
    supersedesReleaseId: successor.headBefore.activeReleaseId,
    formVersionId: successors.input.formVersionId,
    headVersion: successor.headAfter.version
  }));
}

function safeDiff(plan: {
  readonly mutation: FormMutationPlan;
  readonly surfaceSuccessors: ReleaseSurfaceSuccessorPlanDto | null;
}): FormChangesetSafeDiff {
  const mutation = plan.mutation;
  if (mutation.action === 'create') {
    return { action: 'create', before: null, after: safeHead(mutation.after) };
  }
  if (mutation.action === 'publish') {
    if (plan.surfaceSuccessors === null) throw new FormPlanningError('invalid_plan');
    return {
      action: 'publish',
      before: safeHead(mutation.before),
      after: safeHead(mutation.after),
      publishedVersion: safePublishedVersion(mutation.publishedVersion),
      surfaceSuccessors: safeSurfaceSuccessors(plan.surfaceSuccessors)
    };
  }
  if (mutation.action === 'lifecycle') return {
    action: 'lifecycle',
    before: safeHead(mutation.before),
    after: safeHead(mutation.after),
    publishedVersion: mutation.publishedVersion === null
      ? null : safePublishedVersion(mutation.publishedVersion),
    surfaceSuccessors: plan.surfaceSuccessors === null
      ? null : safeSurfaceSuccessors(plan.surfaceSuccessors)
  };
  if (mutation.action === 'closing') return {
    action: 'closing',
    before: safeHead(mutation.before),
    after: safeHead(mutation.after),
    deadline: projectFormCloseDeadlineDiff(mutation.deadlineContribution)
  };
  return { action: 'revise', before: safeHead(mutation.before), after: safeHead(mutation.after) };
}

function refusal(
  code: FormPlanningErrorCode | 'policy_changed' | 'surface_successor_changed',
  plan: FormMutationPlan
) {
  return {
    class: 'stale_revision' as const,
    kind: 'intake_form_changed',
    retryable: false,
    subjects: [{ type: 'intake_form', id: plan.after.id }],
    detail: { code, action: plan.action, formId: plan.after.id },
    detailSchemaVersion: 3
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
