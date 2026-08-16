import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type RequestHashSealer,
} from "@jooevents/application";
import {
  createSafeSchemaManifestRef,
  formClosingChangeDraftInputSchema,
  formDefinitionCreateDraftInputSchema,
  formDefinitionReviseDraftInputSchema,
  INTAKE_OPERATION_SCHEMA_REFS,
  intakeFormDirectCanonicalResultSchema,
  intakeFormDirectLifecycleInputSchema,
  intakeFormDirectOperationResultSchema,
  intakeFormVersionPublishCanonicalResultSchema,
  intakeFormVersionPublishInputSchema,
  intakeFormVersionPublishOperationResultSchema,
  intakeFormVersionReviewDraftCanonicalResultSchema,
  intakeFormVersionReviewDraftDataSchema,
  intakeFormVersionReviewDraftOperationResultSchema,
  intakeFormVersionReviewInputSchema,
  intakeFormVersionReviewSafeDiffSchema,
  intakeFormWriteActionSchema,
  intakeFormWriteDataSchema,
  releaseSurfaceSuccessorPlanSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef,
} from "@jooevents/contracts";
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef,
} from "@jooevents/identity-access";
import {
  parseFormMutationPlan,
  type FormMutationPlan,
} from "@jooevents/intake";
import {
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId,
} from "@jooevents/kernel";
import { z } from "zod";
import { INTAKE_EVENT_MANAGE_ACCESS_POLICY } from "./module";
import { createIntakeFormWriteHandler } from "./form-write-preparation";

export const INTAKE_FORM_CREATE_OPERATION = Object.freeze({
  name: "form.definition.create",
  version: 1,
});
export const INTAKE_FORM_REVISE_OPERATION = Object.freeze({
  name: "form.definition.revise",
  version: 1,
});
export const INTAKE_FORM_CLOSING_OPERATION = Object.freeze({
  name: "form.closing.change",
  version: 1,
});
export const INTAKE_FORM_LIFECYCLE_OPERATION = Object.freeze({
  name: "form.lifecycle.change",
  version: 1,
});
export const INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION = Object.freeze({
  name: "form.version.publish.draft",
  version: 1,
});
export const INTAKE_FORM_VERSION_PUBLISH_OPERATION = Object.freeze({
  name: "form.version.publish",
  version: 1,
});

export const INTAKE_FORM_DIRECT_HANDLER_CAPABILITY = ref(
  "capability.intake.form.direct",
);
export const INTAKE_FORM_REVIEW_DRAFT_HANDLER_CAPABILITY = ref(
  "capability.intake.form.version-review",
);
export const INTAKE_FORM_PUBLISH_HANDLER_CAPABILITY = ref(
  "capability.intake.form.version-publish",
);
export const INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE = ref(
  "request-hash.intake.form.direct",
);
export const INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE = ref(
  "request-hash.intake.form.version-review",
);
export const INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE = ref(
  "request-hash.intake.form.version-publish",
);

const mutationPlanSchema = z.custom<FormMutationPlan>(
  (value) => {
    try {
      parseFormMutationPlan(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid_intake_form_mutation_plan" },
);
const reviewPlanSchema = z.strictObject({
  action: z.enum(["publish", "publish_and_open"]),
  mutation: mutationPlanSchema,
  surfaceSuccessors: releaseSurfaceSuccessorPlanSchema,
});

export const intakeFormDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({
      kind: z.literal("success"),
      data: intakeFormWriteDataSchema,
    }),
    domain: z.strictObject({
      kind: z.literal("intake_form_direct_change"),
      plan: mutationPlanSchema,
    }),
    effectContributions: z.tuple([]),
  }),
  z.strictObject({
    result: z.strictObject({
      kind: z.literal("outcome"),
      outcome: structuredOutcomeSchema,
    }),
    domain: z.null(),
    effectContributions: z.tuple([]),
  }),
]);
export const intakeFormVersionReviewDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({
      kind: z.literal("success"),
      data: intakeFormVersionReviewDraftDataSchema,
    }),
    domain: z.strictObject({
      kind: z.literal("intake_form_version_review_draft"),
      draftId: z.uuid(),
      revisionId: z.uuid(),
      revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      review: reviewPlanSchema,
      safeDiff: intakeFormVersionReviewSafeDiffSchema,
    }),
    effectContributions: z.tuple([]),
  }),
  z.strictObject({
    result: z.strictObject({
      kind: z.literal("outcome"),
      outcome: structuredOutcomeSchema,
    }),
    domain: z.null(),
    effectContributions: z.tuple([]),
  }),
]);
export const intakeFormVersionPublishContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({
      kind: z.literal("success"),
      data: intakeFormWriteDataSchema,
    }),
    domain: z.strictObject({
      kind: z.literal("intake_form_version_publish"),
      draftId: z.uuid(),
      revisionId: z.uuid(),
      revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      review: reviewPlanSchema,
    }),
    effectContributions: z.tuple([]),
  }),
  z.strictObject({
    result: z.strictObject({
      kind: z.literal("outcome"),
      outcome: structuredOutcomeSchema,
    }),
    domain: z.null(),
    effectContributions: z.tuple([]),
  }),
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}
const nullSchema = z.null();
const staleSchema = z.strictObject({
  code: z.string().min(1).max(80),
  action: intakeFormWriteActionSchema,
  formId: z.uuid(),
});
const refs = {
  directContribution: createSafeSchemaManifestRef(
    "schema.intake.form-direct.contribution",
    intakeFormDirectContributionSchema,
  ),
  directCanonical: createSafeSchemaManifestRef(
    "schema.intake.form-direct.canonical-result",
    intakeFormDirectCanonicalResultSchema,
  ),
  reviewContribution: createSafeSchemaManifestRef(
    "schema.intake.form-version-review.contribution",
    intakeFormVersionReviewDraftContributionSchema,
  ),
  reviewCanonical: createSafeSchemaManifestRef(
    "schema.intake.form-version-review.canonical-result",
    intakeFormVersionReviewDraftCanonicalResultSchema,
  ),
  publishContribution: createSafeSchemaManifestRef(
    "schema.intake.form-version-publish.contribution",
    intakeFormVersionPublishContributionSchema,
  ),
  publishCanonical: createSafeSchemaManifestRef(
    "schema.intake.form-version-publish.canonical-result",
    intakeFormVersionPublishCanonicalResultSchema,
  ),
  null: createSafeSchemaManifestRef(
    "schema.intake.form-write.null-detail",
    nullSchema,
  ),
  stale: createSafeSchemaManifestRef(
    "schema.intake.form-write.changed-detail",
    staleSchema,
  ),
  audit: ref("audit.intake.form-write"),
  auditProfile: ref("record-profile.intake.form-write-audit"),
  keySource: ref("idempotency.operator-header"),
};

export interface CreateIntakeFormWriteOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: {
    resolveCurrentEvent(
      workspaceId: WorkspaceId,
    ):
      | { readonly eventId?: string; readonly evidenceIds: readonly string[] }
      | Promise<{
          readonly eventId?: string;
          readonly evidenceIds: readonly string[];
        }>;
  };
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly directRequestHashSealer: RequestHashSealer;
  readonly reviewRequestHashSealer: RequestHashSealer;
  readonly publishRequestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
  readonly includeReviewDraft?: boolean;
}

function authorityOutcome(
  reason: CurrentAuthorityDenialReason,
): StructuredOutcome {
  return {
    class: "access_denied",
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1,
  };
}

export function createIntakeFormWriteOperationModule(
  input: CreateIntakeFormWriteOperationModuleInput,
): OperationRegistryModule {
  if (
    input.policy.key !== INTAKE_EVENT_MANAGE_ACCESS_POLICY.key ||
    input.policy.version !== INTAKE_EVENT_MANAGE_ACCESS_POLICY.version
  )
    throw new TypeError("intake_form_write_policy_mismatch");
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: "operator",
    surface: "operator_http",
    policy: input.policy,
  });
  const scope: InvocationScopeResolver = Object.freeze({
    async resolve() {
      const current = await input.currentEvent.resolveCurrentEvent(workspaceId);
      const eventId = current.eventId
        ? parseEventId(current.eventId)
        : undefined;
      return Object.freeze({
        workspaceId,
        ...(eventId ? { eventId } : {}),
        subjects: Object.freeze(
          eventId
            ? [
                { kind: "workspace" as const, id: workspaceId },
                { kind: "event" as const, id: eventId },
              ]
            : [{ kind: "workspace" as const, id: workspaceId }],
        ),
        resolutionEvidenceIds: Object.freeze(
          [...new Set(current.evidenceIds)].sort(),
        ),
      });
    },
  });
  const entries = [
    {
      key: "create",
      operation: INTAKE_FORM_CREATE_OPERATION,
      effect: "commit" as const,
      capability: INTAKE_FORM_DIRECT_HANDLER_CAPABILITY,
      hash: INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
      sealer: input.directRequestHashSealer,
      inputSchema: formDefinitionCreateDraftInputSchema,
      inputRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.create.inputSchema,
      contributionSchema: intakeFormDirectContributionSchema,
      contributionRef: refs.directContribution,
      canonicalSchema: intakeFormDirectCanonicalResultSchema,
      canonicalRef: refs.directCanonical,
      projectedRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.create.resultSchema,
      path: "/api/events/current/forms/create",
      risk: "low" as const,
    },
    {
      key: "revise",
      operation: INTAKE_FORM_REVISE_OPERATION,
      effect: "commit" as const,
      capability: INTAKE_FORM_DIRECT_HANDLER_CAPABILITY,
      hash: INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
      sealer: input.directRequestHashSealer,
      inputSchema: formDefinitionReviseDraftInputSchema,
      inputRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.revise.inputSchema,
      contributionSchema: intakeFormDirectContributionSchema,
      contributionRef: refs.directContribution,
      canonicalSchema: intakeFormDirectCanonicalResultSchema,
      canonicalRef: refs.directCanonical,
      projectedRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.revise.resultSchema,
      path: "/api/events/current/forms/revise",
      risk: "low" as const,
    },
    {
      key: "closing",
      operation: INTAKE_FORM_CLOSING_OPERATION,
      effect: "commit" as const,
      capability: INTAKE_FORM_DIRECT_HANDLER_CAPABILITY,
      hash: INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
      sealer: input.directRequestHashSealer,
      inputSchema: formClosingChangeDraftInputSchema,
      inputRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.closing.inputSchema,
      contributionSchema: intakeFormDirectContributionSchema,
      contributionRef: refs.directContribution,
      canonicalSchema: intakeFormDirectCanonicalResultSchema,
      canonicalRef: refs.directCanonical,
      projectedRef:
        INTAKE_OPERATION_SCHEMA_REFS.formWrites.closing.resultSchema,
      path: "/api/events/current/forms/closing",
      risk: "low" as const,
    },
    {
      key: "lifecycle",
      operation: INTAKE_FORM_LIFECYCLE_OPERATION,
      effect: "commit" as const,
      capability: INTAKE_FORM_DIRECT_HANDLER_CAPABILITY,
      hash: INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
      sealer: input.directRequestHashSealer,
      inputSchema: intakeFormDirectLifecycleInputSchema,
      inputRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.lifecycle.inputSchema,
      contributionSchema: intakeFormDirectContributionSchema,
      contributionRef: refs.directContribution,
      canonicalSchema: intakeFormDirectCanonicalResultSchema,
      canonicalRef: refs.directCanonical,
      projectedRef:
        INTAKE_OPERATION_SCHEMA_REFS.formWrites.lifecycle.resultSchema,
      path: "/api/events/current/forms/lifecycle",
      risk: "low" as const,
    },
    {
      key: "review",
      operation: INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION,
      effect: "draft" as const,
      capability: INTAKE_FORM_REVIEW_DRAFT_HANDLER_CAPABILITY,
      hash: INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE,
      sealer: input.reviewRequestHashSealer,
      inputSchema: intakeFormVersionReviewInputSchema,
      inputRef:
        INTAKE_OPERATION_SCHEMA_REFS.formWrites.publishDraft.inputSchema,
      contributionSchema: intakeFormVersionReviewDraftContributionSchema,
      contributionRef: refs.reviewContribution,
      canonicalSchema: intakeFormVersionReviewDraftCanonicalResultSchema,
      canonicalRef: refs.reviewCanonical,
      projectedRef:
        INTAKE_OPERATION_SCHEMA_REFS.formWrites.publishDraft.resultSchema,
      path: "/api/events/current/forms/publish/draft",
      risk: "normal" as const,
    },
    {
      key: "publish",
      operation: INTAKE_FORM_VERSION_PUBLISH_OPERATION,
      effect: "commit" as const,
      capability: INTAKE_FORM_PUBLISH_HANDLER_CAPABILITY,
      hash: INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE,
      sealer: input.publishRequestHashSealer,
      inputSchema: intakeFormVersionPublishInputSchema,
      inputRef: INTAKE_OPERATION_SCHEMA_REFS.formWrites.publish.inputSchema,
      contributionSchema: intakeFormVersionPublishContributionSchema,
      contributionRef: refs.publishContribution,
      canonicalSchema: intakeFormVersionPublishCanonicalResultSchema,
      canonicalRef: refs.publishCanonical,
      projectedRef:
        INTAKE_OPERATION_SCHEMA_REFS.formWrites.publish.resultSchema,
      path: "/api/events/current/forms/publish",
      risk: "consequential" as const,
    },
  ]
    .filter(
      (entry) => input.includeReviewDraft !== false || entry.key !== "review",
    )
    .map((entry) => {
      const local = {
        context: ref(`context.intake.form-write.${entry.key}`),
        autonomy: ref(`autonomy.intake.form-write.${entry.key}`),
        concurrency: ref(`concurrency.intake.form-write.${entry.key}`),
        family: ref(`intake.form-write.${entry.key}.family`),
        phase: ref(`intake.form-write.${entry.key}.phase`),
        terminal: ref(`intake.form-write.${entry.key}.terminal`),
        risk: ref(`intake.form-write.${entry.key}.risk`),
        evidence: ref(`intake.form-write.${entry.key}.evidence`),
        approval: ref(`intake.form-write.${entry.key}.approval`),
        preflight: ref(`intake.form-write.${entry.key}.preflight`),
        handler: ref(`handler.intake.form-write.${entry.key}`),
        projection: ref(`projection.intake.form-write.${entry.key}`),
      };
      const autonomy = createOperationAutonomyPolicy({
        definition: local.autonomy,
        operation: entry.operation,
        riskFloor: entry.risk,
        unattendedRiskCeiling: entry.risk,
        supportedDispositions: [
          "proceed",
          "safe_retry",
          "reconcile",
          "renewed_approval",
          "replan",
          "compensate",
          "block",
          "attention",
        ],
        triggerDispositions: {
          authority_lost: "block",
          unattended_bounds_exceeded: "renewed_approval",
          approval_required: "renewed_approval",
          known_retryable_failure: "safe_retry",
          ambiguous_external_effect: "reconcile",
          stale_plan: "replan",
          compensation_required: "compensate",
          terminal_failure: "attention",
        },
        requiresSeparateApproval: false,
      });
      const context = createEffectInvocationContextBuilder({
        reference: local.context,
        operation: entry.operation,
        effect: entry.effect,
        lanes: [lane],
        scopeResolver: scope,
        authorityResolver: input.currentAuthority,
        clock: input.clock,
        newInvocationId: input.ids.newInvocationId,
        authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
        scopePartitionProfile: input.scopePartitionProfile,
        requestCanonicalizationProfile: input.requestCanonicalizationProfile,
        requestHashProfile: entry.hash,
        requestHashSealer: entry.sealer,
        idempotencyCredentialProfile: input.idempotencyCredentialProfile,
        idempotencyCredentialSealer: input.idempotencyCredentialSealer,
        deniedAuthorityOutcome: authorityOutcome,
      });
      const family = createSingleUnitOfWorkFamilyRegistration({
        reference: local.family,
        phase: local.phase,
      });
      const terminal = createTerminalizationResolverRegistration({
        reference: local.terminal,
        operation: entry.operation,
        phase: local.phase,
        resolve: ({ result }) =>
          result.kind === "success"
            ? { kind: "terminal" as const }
            : { kind: "nonterminal" as const },
      });
      const phase = createSingleUnitOfWorkPhaseRegistration({
        reference: local.phase,
        family: local.family,
        operation: entry.operation,
        effect: entry.effect,
        handler: local.handler,
        handlerCapability: entry.capability,
        contributionSchema: entry.contributionRef,
        terminalization: local.terminal,
        terminalOutcomeKeys: [],
        contentionOutcome: {
          class: "conflict",
          kind: "operation.in_progress",
          retryable: true,
          subjects: [],
          detail: null,
          detailSchemaVersion: 1,
        },
      });
      const risk = createOperationRiskResolverRegistration({
        reference: local.risk,
        operation: entry.operation,
        resolve: () => ({
          risk: entry.risk,
          consequenceTags: Object.freeze([
            entry.key === "review"
              ? "form-version-reviewed"
              : "intake-form-changed",
          ]),
          evidenceIds: Object.freeze([`intake.form.${entry.key}.risk`]),
        }),
      });
      const evidence = createAutonomyEvidenceResolverRegistration({
        reference: local.evidence,
        operation: entry.operation,
        resolve: ({ subject }) => {
          const bounds = Object.freeze({
            scopeKeys: Object.freeze([...subject.scopeKeys]),
            maximumSpendMicros: 0,
            maximumActions: 1,
            notAfter: parseInstant(
              new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString(),
            ),
          });
          return {
            evaluatedAt: subject.evaluatedAt,
            hardBounds: bounds,
            unattendedBounds: bounds,
            spendMicros: 0,
            actionCount: 1,
            completesBy: subject.evaluatedAt,
            proposedAction: {
              key: `intake.form.${entry.key}.execute`,
              version: 1,
              digestSha256: subject.requestHashSha256,
            },
            failure: { kind: "none" as const },
          };
        },
      });
      const approval = createRenewedApprovalResolverRegistration({
        reference: local.approval,
        operation: entry.operation,
        resolve: () => ({ approverCurrentlyAuthorized: false }),
      });
      const preflight = createAutonomyPreflightRegistration({
        reference: local.preflight,
        operation: entry.operation,
        policy: local.autonomy,
        riskResolver: local.risk,
        evidenceResolver: local.evidence,
        approvalResolver: local.approval,
        interventionOutcomes: autonomyInterventionOutcomes(1),
      });
      const handler = createIntakeFormWriteHandler({
        reference: local.handler,
        effect: entry.effect,
        capability: entry.capability,
        contributionSchema: entry.contributionRef,
        canonicalResultSchema: entry.canonicalRef,
      });
      return {
        entry,
        local,
        autonomy,
        context,
        family,
        terminal,
        phase,
        risk,
        evidence,
        approval,
        preflight,
        handler,
      };
    });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: "access_denied" as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.null,
  }));
  const summaries = Object.freeze({
    create: "Created a form",
    revise: "Updated a form",
    set_closing: "Set a form's closing date",
    update_closing: "Updated a form's closing date",
    remove_closing: "Removed a form's closing date",
    close: "Closed a form",
    reopen: "Reopened a form",
    publish: "Published a form version",
    publish_and_open: "Published and opened a form",
  });
  const schemaPairs = new Map<
    string,
    { reference: SafeSchemaManifestRef; schema: z.ZodType }
  >();
  for (const value of entries)
    for (const pair of [
      { reference: value.entry.inputRef, schema: value.entry.inputSchema },
      {
        reference: value.entry.contributionRef,
        schema: value.entry.contributionSchema,
      },
      {
        reference: value.entry.canonicalRef,
        schema: value.entry.canonicalSchema,
      },
      {
        reference: value.entry.projectedRef,
        schema:
          value.entry.key === "review"
            ? intakeFormVersionReviewDraftOperationResultSchema
            : value.entry.key === "publish"
              ? intakeFormVersionPublishOperationResultSchema
              : intakeFormDirectOperationResultSchema,
      },
    ])
      schemaPairs.set(`${pair.reference.key}@${pair.reference.version}`, pair);
  for (const pair of [
    { reference: refs.null, schema: nullSchema },
    { reference: refs.stale, schema: staleSchema },
  ])
    schemaPairs.set(`${pair.reference.key}@${pair.reference.version}`, pair);
  return Object.freeze({
    id: "intake.form-owner-write-operations",
    source: Object.freeze({
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      operations: Object.freeze([]),
      effectExecutionFamilies: Object.freeze(entries.map((v) => v.family)),
      effectPhases: Object.freeze(entries.map((v) => v.phase)),
      terminalizationResolvers: Object.freeze(entries.map((v) => v.terminal)),
      riskResolvers: Object.freeze(entries.map((v) => v.risk)),
      autonomyEvidenceResolvers: Object.freeze(entries.map((v) => v.evidence)),
      renewedApprovalResolvers: Object.freeze(entries.map((v) => v.approval)),
      autonomyPreflights: Object.freeze(entries.map((v) => v.preflight)),
      autonomyPolicies: Object.freeze(entries.map((v) => v.autonomy)),
      schemas: Object.freeze([...schemaPairs.values()]),
      effectContextBuilders: Object.freeze(entries.map((v) => v.context)),
      effectHandlers: Object.freeze(entries.map((v) => v.handler)),
      projections: Object.freeze(
        entries.map((v) => ({
          reference: v.local.projection,
          canonicalResultSchema: v.entry.canonicalRef,
          projectedResultSchema: v.entry.projectedRef,
          project: (candidate: unknown) =>
            v.entry.canonicalSchema.parse(candidate),
        })),
      ),
      operationAuditTargets: Object.freeze([
        {
          reference: refs.audit,
          kind: "operation_audit_record" as const,
          recordProfile: refs.auditProfile,
        },
      ]),
      operationAuditRecordProfiles: Object.freeze([
        {
          reference: refs.auditProfile,
          kind: "canonical_json" as const,
          maximumBytes: 262_144,
        },
      ]),
      effectOperations: Object.freeze(
        entries.map(({ entry, local }) => ({
          ...entry.operation,
          lifecycle: { status: "active" as const },
          summary:
            entry.key === "review"
              ? "Prepare one Form version and its successor public surfaces for review."
              : entry.key === "publish"
                ? "Publish one exact reviewed Form version."
                : `${entry.key} one Form.`,
          effect: entry.effect,
          maxRisk: entry.risk,
          autonomyPolicy: local.autonomy,
          consequenceTags: [
            entry.key === "review"
              ? "form-version-reviewed"
              : "intake-form-changed",
          ],
          ...(entry.key === "review" || entry.key === "publish"
            ? {}
            : {
                agentAction: {
                  eligible: true as const,
                  displayLabel: `${entry.key} a form`,
                  consequences: [
                    "The form definition, closing state, or lifecycle may change.",
                  ],
                  externalEffect: "none" as const,
                },
              }),
          inputSchema: entry.inputRef,
          contributionSchema: entry.contributionRef,
          canonicalResultSchema: entry.canonicalRef,
          outcomes: [
            {
              class: "idempotency_conflict" as const,
              kind: "operation.request_changed",
              retryable: false,
              detailSchema: refs.null,
            },
            ...access,
            {
              class: "conflict" as const,
              kind: "intake_form.event_required",
              retryable: false,
              detailSchema: refs.null,
            },
            {
              class: "stale_revision" as const,
              kind: "intake_form.changed",
              retryable: false,
              detailSchema: refs.stale,
            },
            {
              class: "policy_violation" as const,
              kind: "intake_form.change_refused",
              retryable: false,
              detailSchema: refs.stale,
            },
            {
              class: "conflict" as const,
              kind: "intake_form.review_changed",
              retryable: false,
              detailSchema: refs.null,
            },
            {
              class: "conflict" as const,
              kind: "operation.in_progress",
              retryable: true,
              detailSchema: refs.null,
            },
            ...autonomyInterventionOutcomeDeclarations(refs.null),
          ],
          accessLanes: [lane],
          contextBuilder: local.context,
          handlerCapability: entry.capability,
          handler: local.handler,
          audit: { mode: "required" as const, target: refs.audit },
          idempotency: {
            keySource: refs.keySource,
            credentialVerifierProfile: input.idempotencyCredentialProfile,
            requestHashProfile: entry.hash,
          },
          concurrency: local.concurrency,
          execution:
            entry.key === "review"
              ? {
                  kind: "single_unit_of_work" as const,
                  family: local.family,
                  phase: local.phase,
                  terminalization: local.terminal,
                  autonomyPreflight: local.preflight,
                }
              : {
                  kind: "single_unit_of_work" as const,
                  profile: "direct_audited" as const,
                  family: local.family,
                  phase: local.phase,
                  terminalization: local.terminal,
                  autonomyPreflight: local.preflight,
                  history: { summariesByAction: summaries },
                },
          bindings: [
            {
              surface: "operator_http" as const,
              method: "POST" as const,
              path: entry.path,
              input: "body" as const,
              browserResumption: { kind: "none" as const },
              projection: local.projection,
            },
          ],
        })),
      ),
    }),
  });
}
