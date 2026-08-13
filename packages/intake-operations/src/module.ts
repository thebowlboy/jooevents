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
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer
} from '@jooevents/application';
import type { PublicEffectConformanceBoundary } from '@jooevents/application/public-effect-conformance';
import {
  createEffectfulOperationResultSchema,
  createSafeSchemaManifestRef,
  createReadOperationResultSchema,
  formClosingChangeDraftInputSchema,
  formDefinitionCreateDraftInputSchema,
  formDefinitionReviseDraftInputSchema,
  formLifecycleChangeDraftInputSchema,
  formVersionPublishDraftInputSchema,
  INTAKE_OPERATION_SCHEMA_REFS,
  intakeEmptyReadInputSchema,
  intakeFormReadInputSchema,
  intakeSubmissionReadInputSchema,
  intakeDigestSchema,
  intakeFormDraftActionSchema,
  intakeFormDraftCanonicalResultSchema,
  intakeFormDraftDataSchema,
  intakeFormDraftOperationResultSchema,
  intakeFormSafeDiffSchema,
  intakeIdInputSchema,
  intakeIdSchema,
  organizerFormCatalogSchema,
  organizerFormCatalogReadResultSchema,
  organizerFormDetailSchema,
  organizerFormDetailReadResultSchema,
  organizerSubmissionContactSchema,
  organizerSubmissionContactReadResultSchema,
  organizerSubmissionDetailSchema,
  organizerSubmissionDetailReadResultSchema,
  organizerSubmissionListReadResultSchema,
  organizerSubmissionListSchema,
  publicApplicationDraftBeginInputSchema,
  publicApplicationDraftReadInputSchema,
  publicApplicationDraftResumeSchema,
  publicApplicationDraftSaveInputSchema,
  publicApplicationDraftStatusSchema,
  publicApplicationSubmitInputSchema,
  publicApplicationSubmitResultSchema,
  servedPublicFormSchema,
  structuredOutcomeSchema,
  type IntakeFormDraftAction,
  type OrganizerFormDetailDto,
  type OrganizerFormCatalogDto,
  type OrganizerSubmissionContactDto,
  type OrganizerSubmissionDetailDto,
  type OrganizerSubmissionSummaryDto,
  type PublicApplicationDraftResumeDto,
  type SafeSchemaManifestRef,
  type ServedPublicFormDto,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type PermissionId,
  type OperationAccessLane,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type CeremonyEvidenceId,
  type Clock,
  type EventId,
  type InvocationId,
  type PublicPolicyRevisionId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createIntakeHandler } from './preparation';

export {
  intakeFormDraftActionSchema,
  intakeFormDraftCanonicalResultSchema,
  intakeFormDraftDataSchema,
  intakeFormDraftOperationResultSchema,
  intakeFormSafeDiffSchema,
  type IntakeFormDraftAction
} from '@jooevents/contracts';

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, parseContractVersion(1));
}

export const INTAKE_FORM_LIST_OPERATION = Object.freeze({ name: 'form.list', version: 1 });
export const INTAKE_FORM_READ_OPERATION = Object.freeze({ name: 'form.read', version: 1 });
export const INTAKE_PUBLIC_FORM_READ_OPERATION = Object.freeze({ name: 'form.public.read', version: 1 });
export const INTAKE_PUBLIC_DRAFT_RESUME_OPERATION = Object.freeze({
  name: 'application.public.resume', version: 1
});
export const INTAKE_SUBMISSION_LIST_OPERATION = Object.freeze({ name: 'submission.list', version: 1 });
export const INTAKE_SUBMISSION_READ_OPERATION = Object.freeze({ name: 'submission.read', version: 1 });
export const INTAKE_SUBMISSION_CONTACT_READ_OPERATION = Object.freeze({
  name: 'submission.contact.read', version: 1
});
export const INTAKE_PUBLIC_MUTATE_OPERATION = Object.freeze({ name: 'application.public.mutate', version: 1 });
export const INTAKE_FORM_CREATE_DRAFT_OPERATION = Object.freeze({
  name: 'form.definition.create.draft', version: 1
});
export const INTAKE_FORM_REVISE_DRAFT_OPERATION = Object.freeze({
  name: 'form.definition.revise.draft', version: 1
});
export const INTAKE_FORM_PUBLISH_DRAFT_OPERATION = Object.freeze({
  name: 'form.version.publish.draft', version: 1
});
export const INTAKE_FORM_LIFECYCLE_DRAFT_OPERATION = Object.freeze({
  name: 'form.lifecycle.change.draft', version: 1
});
export const INTAKE_FORM_CLOSING_DRAFT_OPERATION = Object.freeze({
  name: 'form.closing.change.draft', version: 1
});

export const INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY = ref('capability.application.public.mutate');
export const INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE = ref('request-hash.application.public.mutate');
export const INTAKE_FORM_DRAFT_HANDLER_CAPABILITY = ref('capability.intake.form.changeset-draft');
export const INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE = ref('request-hash.intake.form.draft');

export const INTAKE_EVENT_READ_ACCESS_POLICY = Object.freeze({
  key: 'authority.intake.event-read', version: parseContractVersion(1)
});
export const INTAKE_EVENT_MANAGE_ACCESS_POLICY = Object.freeze({
  key: 'authority.intake.event-manage', version: parseContractVersion(1)
});
export const INTAKE_SUBMISSION_READ_ACCESS_POLICY = Object.freeze({
  key: 'authority.intake.submission-read', version: parseContractVersion(1)
});
export const INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY = Object.freeze({
  key: 'authority.intake.submission-contact-read', version: parseContractVersion(1)
});
export const INTAKE_PUBLIC_OPEN_ACCESS_POLICY = Object.freeze({
  key: 'authority.intake.public-open', version: parseContractVersion(1)
});
export const INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY = Object.freeze({
  key: 'authority.intake.public-ceremony', version: parseContractVersion(1)
});

export const INTAKE_EVENT_READ_PERMISSION_ID: PermissionId = 'event.read';
export const INTAKE_EVENT_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';
export const INTAKE_SUBMISSION_READ_PERMISSION_ID: PermissionId = 'submission.read';
export const INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS = Object.freeze([
  'speaker.contact.read' as const,
  'submission.read' as const
]) satisfies readonly [PermissionId, PermissionId];

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());
const canonicalResult = <Schema extends z.ZodType>(data: Schema) => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const intakePublicMutateInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('begin'), input: publicApplicationDraftBeginInputSchema }),
  z.strictObject({ action: z.literal('save'), input: publicApplicationDraftSaveInputSchema }),
  z.strictObject({ action: z.literal('submit'), input: publicApplicationSubmitInputSchema })
]);

const intakeFormDraftOperations = Object.freeze([
  Object.freeze({
    action: 'create' as const,
    operation: INTAKE_FORM_CREATE_DRAFT_OPERATION,
    inputSchema: formDefinitionCreateDraftInputSchema,
    path: '/api/events/current/forms/drafts/create'
  }),
  Object.freeze({
    action: 'revise' as const,
    operation: INTAKE_FORM_REVISE_DRAFT_OPERATION,
    inputSchema: formDefinitionReviseDraftInputSchema,
    path: '/api/events/current/forms/drafts/revise'
  }),
  Object.freeze({
    action: 'publish' as const,
    operation: INTAKE_FORM_PUBLISH_DRAFT_OPERATION,
    inputSchema: formVersionPublishDraftInputSchema,
    path: '/api/events/current/forms/drafts/publish'
  }),
  Object.freeze({
    action: 'lifecycle' as const,
    operation: INTAKE_FORM_LIFECYCLE_DRAFT_OPERATION,
    inputSchema: formLifecycleChangeDraftInputSchema,
    path: '/api/events/current/forms/drafts/lifecycle'
  }),
  Object.freeze({
    action: 'closing' as const,
    operation: INTAKE_FORM_CLOSING_DRAFT_OPERATION,
    inputSchema: formClosingChangeDraftInputSchema,
    path: '/api/events/current/forms/drafts/closing'
  })
]);

export function intakeFormDraftActionForOperation(
  operationName: string,
  operationVersion: number
): IntakeFormDraftAction | undefined {
  return intakeFormDraftOperations.find(({ operation }) =>
    operation.name === operationName && operation.version === operationVersion
  )?.action;
}

export const intakeFormDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('intake_form_changeset_draft'),
  preparationHandle: canonicalUuid,
  action: intakeFormDraftActionSchema,
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  changesetId: canonicalUuid,
  revisionId: canonicalUuid,
  revisionDigestSha256: intakeDigestSchema,
  recordDigestSha256: intakeDigestSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

export const intakeFormDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: canonicalUuid,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  changesetId: canonicalUuid,
  revisionId: canonicalUuid,
  occurredAt: z.iso.datetime({ offset: true })
});

const intakeFormDraftDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_catalog', 'stale_definition', 'stale_registry',
    'form_exists', 'form_missing', 'form_not_publishable', 'form_version_exists',
    'category_missing', 'category_changed', 'session_unavailable', 'session_changed',
    'deadline_unavailable', 'deadline_changed',
    'invalid_identity_assignment', 'invalid_definition', 'invalid_transition', 'invalid_plan'
  ]),
  action: intakeFormDraftActionSchema,
  formId: intakeIdInputSchema
});

const intakeFormDraftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: intakeFormDraftDataSchema }),
  domain: intakeFormDraftDomainContributionSchema,
  receiptChildren: z.tuple([intakeFormDraftEvidenceChildSchema])
}).superRefine((value, context) => {
  const data = value.result.data;
  const domain = value.domain;
  const timeline = value.receiptChildren[0];
  if (data.action !== domain.action || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Form draft evidence is incoherent.' });
  }
});

const intakeFormDraftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((value, context) => {
  const outcome = value.result.outcome;
  const allowed = new Set([
    'conflict:intake_form.event_required',
    'stale_revision:intake_form.changed',
    'policy_violation:intake_form.change_refused',
    'conflict:changeset.id_collision'
  ]);
  const detail = outcome.kind === 'intake_form.changed'
      || outcome.kind === 'intake_form.change_refused'
    ? intakeFormDraftDetailSchema
    : z.null();
  if (!allowed.has(`${outcome.class}:${outcome.kind}`) || outcome.retryable
      || outcome.detailSchemaVersion !== 1 || !detail.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Form draft refusal is invalid.' });
  }
});

export const intakeFormDraftContributionSchema = z.union([
  intakeFormDraftSuccessContributionSchema,
  intakeFormDraftOutcomeContributionSchema
]);

export type IntakeFormDraftContribution = z.infer<typeof intakeFormDraftContributionSchema>;

const formIdInputSchema = intakeFormReadInputSchema;
const emptyInputSchema = intakeEmptyReadInputSchema;
const submissionIdInputSchema = intakeSubmissionReadInputSchema;

export const intakePublicMutationResultDataSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('begin'), draft: publicApplicationDraftStatusSchema }),
  z.strictObject({ action: z.literal('save'), draft: publicApplicationDraftStatusSchema }),
  z.strictObject({ action: z.literal('submit'), submission: publicApplicationSubmitResultSchema })
]);

export const intakePublicMutationCanonicalResultSchema = canonicalResult(intakePublicMutationResultDataSchema);
export const intakePublicMutationOperationResultSchema = createEffectfulOperationResultSchema(
  intakePublicMutationResultDataSchema
);

const actionSchema = z.enum(['begin', 'save', 'submit']);
const planDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const intakeMutationDomainContributionSchema = z.strictObject({
  kind: z.literal('intake_public_mutation'),
  preparationHandle: canonicalUuid,
  action: actionSchema,
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  planDigestSha256: planDigestSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

export const intakeMutationEvidenceChildSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('domain_fact'), factId: canonicalUuid,
    factKind: z.enum(['application_draft_changed', 'application_submitted']),
    action: actionSchema, workspaceId: canonicalUuid, eventId: canonicalUuid,
    planDigestSha256: planDigestSchema, sourcePlan: z.json(), occurredAt: z.iso.datetime({ offset: true })
  }),
  z.strictObject({
    kind: z.literal('outbox_pointer'), pointerId: canonicalUuid,
    sourceKind: z.literal('domain_fact'), factId: canonicalUuid
  }),
  z.strictObject({
    kind: z.literal('timeline'), timelineId: canonicalUuid,
    sourceKind: z.literal('domain_fact'), factId: canonicalUuid,
    workspaceId: canonicalUuid, eventId: canonicalUuid,
    action: actionSchema, occurredAt: z.iso.datetime({ offset: true })
  })
]);

function contributionSchema(result: z.ZodType) {
  return z.union([
    z.strictObject({
      result: z.strictObject({ kind: z.literal('success'), data: result }),
      domain: intakeMutationDomainContributionSchema,
      receiptChildren: z.tuple([
        intakeMutationEvidenceChildSchema,
        intakeMutationEvidenceChildSchema,
        intakeMutationEvidenceChildSchema
      ])
    }),
    z.strictObject({
      result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
      domain: z.null(),
      receiptChildren: z.tuple([])
    })
  ]);
}

export const intakePublicMutationContributionSchema = contributionSchema(intakePublicMutationResultDataSchema);

export type IntakePublicMutateInput = z.infer<typeof intakePublicMutateInputSchema>;
export type IntakePublicMutationResultData = z.infer<typeof intakePublicMutationResultDataSchema>;
export type IntakeMutationDomainContribution = z.infer<typeof intakeMutationDomainContributionSchema>;
export type IntakeMutationEvidenceChild = z.infer<typeof intakeMutationEvidenceChildSchema>;

export interface IntakeReadPort {
  listForms(scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }): OrganizerFormCatalogDto;
  readForm(scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }, formId: string): OrganizerFormDetailDto | undefined;
  readServedForm(scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }, formId: string): ServedPublicFormDto | undefined;
  listSubmissions(scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }): readonly OrganizerSubmissionSummaryDto[];
  readSubmission(scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }, submissionId: string): OrganizerSubmissionDetailDto | undefined;
  readSubmissionContact(scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }, submissionId: string): OrganizerSubmissionContactDto | undefined;
  readPublicDraftResume(
    scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId },
    binding: IntakePublicCeremonyBinding
  ): IntakePublicDraftResumeProjection | undefined;
}

export interface IntakeCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId): { readonly eventId?: string; readonly evidenceIds: readonly string[] } | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}

export interface IntakePublicFormScopeSource {
  resolve(input: { readonly formId: string; readonly publicPolicyRevisionId: PublicPolicyRevisionId }): { readonly workspaceId: string; readonly eventId: string; readonly evidenceIds: readonly string[] } | undefined | Promise<{ readonly workspaceId: string; readonly eventId: string; readonly evidenceIds: readonly string[] } | undefined>;
}

export interface IntakePublicCeremonyScopeSource {
  resolve(ceremonyEvidenceId: CeremonyEvidenceId): IntakePublicCeremonyBindingResolution
    | undefined
    | Promise<IntakePublicCeremonyBindingResolution | undefined>;
}

export interface IntakePublicCeremonyBinding {
  readonly draftId: string;
  readonly formId: string;
  readonly formVersionId: string;
  readonly authorityPartitionDigestSha256: string;
}

/** Internal projection proof; only `data` crosses the public read boundary. */
export interface IntakePublicDraftResumeProjection {
  readonly binding: IntakePublicCeremonyBinding;
  readonly data: PublicApplicationDraftResumeDto;
}

export interface IntakePublicCeremonyBindingResolution extends IntakePublicCeremonyBinding {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly evidenceIds: readonly string[];
}

export interface IntakeOperationIds { newInvocationId(): InvocationId; }
export interface IntakeOperationPolicies {
  readonly eventRead: VersionedAccessPolicyRef;
  readonly eventManage: VersionedAccessPolicyRef;
  readonly submissionRead: VersionedAccessPolicyRef;
  readonly submissionContactRead: VersionedAccessPolicyRef;
  readonly publicOpen: VersionedAccessPolicyRef;
  readonly publicCeremony: VersionedAccessPolicyRef;
}

export interface IntakeOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function canonicalEvidence(values: readonly string[]): readonly string[] {
  const checked = values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value) {
      throw new TypeError('intake_scope_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(checked)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

function assertPolicy(
  actual: VersionedAccessPolicyRef,
  expected: VersionedAccessPolicyRef,
  code: string
): void {
  if (actual.key !== expected.key || actual.version !== expected.version) {
    throw new TypeError(code);
  }
}

function eventScope(workspaceId: WorkspaceId, source: IntakeCurrentEventSource): InvocationScopeResolver {
  return Object.freeze({ async resolve() {
    const current = await source.resolveCurrentEvent(workspaceId);
    const evidence = canonicalEvidence(current.evidenceIds);
    if (!current.eventId) return Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: evidence
    });
    const eventId = parseEventId(current.eventId);
    return Object.freeze({
      workspaceId, eventId,
      subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        { kind: 'event' as const, id: eventId }
      ]),
      resolutionEvidenceIds: evidence
    });
  }});
}

function publicFormScope(source: IntakePublicFormScopeSource): InvocationScopeResolver {
  return Object.freeze({ async resolve({ businessInput, evidence }:
    Parameters<InvocationScopeResolver['resolve']>[0]) {
    if (evidence.kind !== 'public_open') throw new TypeError('intake_public_open_evidence_required');
    const { formId } = formIdInputSchema.parse(businessInput);
    const resolved = await source.resolve({ formId, publicPolicyRevisionId: evidence.publicPolicyRevisionId });
    if (!resolved) throw new TypeError('intake_public_form_unavailable');
    const workspaceId = parseWorkspaceId(resolved.workspaceId);
    const eventId = parseEventId(resolved.eventId);
    return Object.freeze({
      workspaceId, eventId,
      subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        { kind: 'event' as const, id: eventId },
        { kind: 'domain' as const, domain: 'intake', entity: 'form', id: formId }
      ]),
      resolutionEvidenceIds: canonicalEvidence(resolved.evidenceIds)
    });
  }});
}

function ceremonyScope(source: IntakePublicCeremonyScopeSource): InvocationScopeResolver {
  return Object.freeze({ async resolve({ operation, businessInput, evidence }:
    Parameters<InvocationScopeResolver['resolve']>[0]) {
    if (evidence.kind !== 'public_ceremony') throw new TypeError('intake_public_ceremony_evidence_required');
    const resolved = await source.resolve(evidence.ceremonyEvidenceId);
    if (!resolved) throw new TypeError('intake_public_ceremony_unavailable');
    const workspaceId = parseWorkspaceId(resolved.workspaceId);
    const eventId = parseEventId(resolved.eventId);
    const draftId = canonicalUuid.parse(resolved.draftId);
    const formId = canonicalUuid.parse(resolved.formId);
    const formVersionId = canonicalUuid.parse(resolved.formVersionId);
    const authorityPartitionDigestSha256 = planDigestSchema.parse(
      resolved.authorityPartitionDigestSha256
    );
    if (operation.name === INTAKE_PUBLIC_MUTATE_OPERATION.name
        && operation.version === INTAKE_PUBLIC_MUTATE_OPERATION.version) {
      const mutation = intakePublicMutateInputSchema.parse(businessInput);
      if (mutation.action === 'begin' && mutation.input.formId !== formId) {
        throw new TypeError('intake_public_ceremony_form_mismatch');
      }
    }
    return Object.freeze({
      workspaceId, eventId,
      subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        { kind: 'event' as const, id: eventId },
        { kind: 'domain' as const, domain: 'intake', entity: 'application_draft', id: draftId },
        { kind: 'domain' as const, domain: 'intake', entity: 'form', id: formId },
        { kind: 'domain' as const, domain: 'intake', entity: 'form_version', id: formVersionId },
        {
          kind: 'domain' as const,
          domain: 'intake',
          entity: 'authority_partition',
          id: authorityPartitionDigestSha256
        }
      ]),
      resolutionEvidenceIds: canonicalEvidence(resolved.evidenceIds)
    });
  }});
}

function publicCeremonyBinding(context: ReadInvocationContext): IntakePublicCeremonyBinding {
  const subject = (entity: string) => context.scope.subjects.filter((candidate) =>
    candidate.kind === 'domain'
    && candidate.domain === 'intake'
    && candidate.entity === entity
  );
  const draft = subject('application_draft');
  const form = subject('form');
  const version = subject('form_version');
  const partition = subject('authority_partition');
  if (draft.length !== 1 || form.length !== 1 || version.length !== 1 || partition.length !== 1) {
    throw new TypeError('intake_public_ceremony_scope_invalid');
  }
  return Object.freeze({
    draftId: canonicalUuid.parse(draft[0]!.id),
    formId: canonicalUuid.parse(form[0]!.id),
    formVersionId: canonicalUuid.parse(version[0]!.id),
    authorityPartitionDigestSha256: planDigestSchema.parse(partition[0]!.id)
  });
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function autonomy(operation: { readonly name: string; readonly version: number }, definition: VersionedDefinitionRef, risk: 'low' | 'normal') {
  return createOperationAutonomyPolicy({
    definition, operation, riskFloor: risk, unattendedRiskCeiling: risk,
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
}

const nullSchema = z.null();
const refs = Object.freeze({
  auditRecord: ref('record-profile.intake.operation-audit'),
  trace: ref('trace.intake.read'),
  nullDetail: schemaRef('schema.intake.operation.null-detail', nullSchema)
});

function readSchemas(
  key: string,
  input: z.ZodType,
  data: z.ZodType,
  published?: {
    readonly refs: { readonly inputSchema: SafeSchemaManifestRef; readonly resultSchema: SafeSchemaManifestRef };
    readonly projectedSchema: z.ZodType;
  }
) {
  const canonical = canonicalResult(data);
  const projected = published?.projectedSchema ?? createReadOperationResultSchema(data);
  return Object.freeze({
    input: published?.refs.inputSchema ?? schemaRef(`schema.${key}.input`, input),
    canonical: schemaRef(`schema.${key}.canonical-result`, canonical),
    projected: published?.refs.resultSchema ?? schemaRef(`schema.${key}.projected-result`, projected),
    inputSchema: input, canonicalSchema: canonical, projectedSchema: projected
  });
}

const readCatalog = Object.freeze({
  formList: readSchemas('form.list', emptyInputSchema, organizerFormCatalogSchema, {
    refs: INTAKE_OPERATION_SCHEMA_REFS.formList,
    projectedSchema: organizerFormCatalogReadResultSchema
  }),
  formRead: readSchemas('form.read', formIdInputSchema, organizerFormDetailSchema, {
    refs: INTAKE_OPERATION_SCHEMA_REFS.formRead,
    projectedSchema: organizerFormDetailReadResultSchema
  }),
  publicForm: readSchemas('form.public-read', formIdInputSchema, servedPublicFormSchema),
  submissionList: readSchemas('submission.list', emptyInputSchema, organizerSubmissionListSchema, {
    refs: INTAKE_OPERATION_SCHEMA_REFS.submissionList,
    projectedSchema: organizerSubmissionListReadResultSchema
  }),
  submissionRead: readSchemas(
    'submission.read', submissionIdInputSchema, organizerSubmissionDetailSchema, {
      refs: INTAKE_OPERATION_SCHEMA_REFS.submissionRead,
      projectedSchema: organizerSubmissionDetailReadResultSchema
    }
  ),
  submissionContact: readSchemas(
    'submission.contact-read', submissionIdInputSchema, organizerSubmissionContactSchema, {
      refs: INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead,
      projectedSchema: organizerSubmissionContactReadResultSchema
    }
  ),
  publicResume: readSchemas('application.public-resume', publicApplicationDraftReadInputSchema, publicApplicationDraftResumeSchema)
});

type ReadEntry = {
  readonly operation: { readonly name: string; readonly version: number };
  readonly key: keyof typeof readCatalog;
  readonly path: string;
  readonly lane: HttpReadLane;
  readonly scope: InvocationScopeResolver;
  readonly requiresEvent?: boolean;
  readonly read: (context: ReadInvocationContext, input: unknown) => unknown;
};

type HttpReadLane = Extract<OperationAccessLane, {
  readonly surface: 'operator_http' | 'public_http';
}>;
type OperatorLane = Extract<OperationAccessLane, {
  readonly kind: 'operator';
  readonly surface: 'operator_http';
}>;
type PublicOpenLane = Extract<OperationAccessLane, {
  readonly kind: 'public_open';
  readonly surface: 'public_http';
}>;
type PublicCeremonyLane = Extract<OperationAccessLane, {
  readonly kind: 'public_ceremony';
  readonly surface: 'public_http';
}>;

function operatorLane(policy: VersionedAccessPolicyRef): OperatorLane {
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy });
  if (lane.kind !== 'operator') throw new TypeError('intake_operator_lane_invalid');
  return lane;
}

function publicOpenLane(policy: VersionedAccessPolicyRef): PublicOpenLane {
  const lane = parseOperationAccessLane({ kind: 'public_open', surface: 'public_http', policy });
  if (lane.kind !== 'public_open') throw new TypeError('intake_public_open_lane_invalid');
  return lane;
}

function publicCeremonyLane(policy: VersionedAccessPolicyRef): PublicCeremonyLane {
  const lane = parseOperationAccessLane({ kind: 'public_ceremony', surface: 'public_http', policy });
  if (lane.kind !== 'public_ceremony') throw new TypeError('intake_public_ceremony_lane_invalid');
  return lane;
}

function readModule(input: {
  readonly id: string;
  readonly authority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: Pick<IntakeOperationCrypto, 'authorityPrincipalKeyProfile' | 'scopePartitionProfile' | 'requestCanonicalizationProfile'>;
  readonly entries: readonly ReadEntry[];
}): OperationRegistryModule {
  const built = input.entries.map((entry) => {
    const schema = readCatalog[entry.key];
    const autonomyRef = ref(`autonomy.${entry.operation.name}`);
    const contextRef = ref(`context.${entry.operation.name}`);
    const capabilityRef = ref(`capability.${entry.operation.name}`);
    const handlerRef = ref(`handler.${entry.operation.name}`);
    const projectionRef = ref(`projection.${entry.operation.name}`);
    return Object.freeze({
      ...entry, schema, autonomy: autonomy(entry.operation, autonomyRef, 'low'),
      contextRef, capabilityRef, handlerRef, projectionRef,
      context: createReadInvocationContextBuilder({
        reference: contextRef, operation: entry.operation, effect: 'read', lanes: [entry.lane],
        scopeResolver: entry.scope, authorityResolver: input.authority, clock: input.clock,
        newInvocationId: input.ids.newInvocationId,
        authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
        scopePartitionProfile: input.crypto.scopePartitionProfile,
        requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
        deniedAuthorityOutcome: authorityOutcome
      })
    });
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: refs.nullDetail
  }));
  return Object.freeze({
    id: input.id,
    source: Object.freeze({
      autonomyPolicies: built.map((entry) => entry.autonomy),
      schemas: [
        ...built.flatMap((entry) => [
          { reference: entry.schema.input, schema: entry.schema.inputSchema },
          { reference: entry.schema.canonical, schema: entry.schema.canonicalSchema },
          { reference: entry.schema.projected, schema: entry.schema.projectedSchema }
        ]),
        { reference: refs.nullDetail, schema: nullSchema }
      ],
      contextBuilders: built.map((entry) => entry.context),
      readCapabilities: built.map<ReadCapabilityRegistration>((entry) => Object.freeze({
        reference: entry.capabilityRef,
        openSnapshot: (context: ReadInvocationContext) => Object.freeze({ context })
      })),
      handlers: built.map((entry) => Object.freeze({
        reference: entry.handlerRef,
        readCapability: entry.capabilityRef,
        canonicalResultSchema: entry.schema.canonical,
        handle: ({ businessInput, context }: { readonly businessInput: unknown; readonly context: ReadInvocationContext }) => {
          if (entry.requiresEvent && !context.scope.eventId) {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'intake.event_required',
                retryable: false,
                subjects: Object.freeze([]),
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          const value = entry.read(context, businessInput);
          return value === undefined
            ? Object.freeze({ kind: 'outcome', outcome: { class: 'conflict', kind: 'intake.not_found', retryable: false, subjects: [], detail: null, detailSchemaVersion: 1 } })
            : Object.freeze({ kind: 'success', data: value });
        }
      })),
      projections: built.map((entry) => Object.freeze({
        reference: entry.projectionRef,
        canonicalResultSchema: entry.schema.canonical,
        projectedResultSchema: entry.schema.projected,
        project: (candidate: unknown) => entry.schema.canonicalSchema.parse(candidate)
      })),
      readOperationalTraceTargets: [{ reference: refs.trace, kind: 'read_operational_trace_record' as const, recordProfile: refs.auditRecord }],
      operationAuditRecordProfiles: [{ reference: refs.auditRecord, kind: 'canonical_json' as const, maximumBytes: 262_144 }],
      operations: built.map((entry) => ({
        ...entry.operation, lifecycle: { status: 'active' as const }, summary: `Read ${entry.operation.name}.`,
        effect: 'read' as const, maxRisk: 'low' as const, autonomyPolicy: entry.autonomy.definition,
        consequenceTags: [], inputSchema: entry.schema.input,
        canonicalResultSchema: entry.schema.canonical,
        outcomes: [
          ...accessOutcomes,
          ...(entry.requiresEvent ? [{
            class: 'conflict' as const,
            kind: 'intake.event_required',
            retryable: false,
            detailSchema: refs.nullDetail
          }] : []),
          { class: 'conflict' as const, kind: 'intake.not_found', retryable: false,
            detailSchema: refs.nullDetail }
        ],
        accessLanes: [entry.lane], contextBuilder: entry.contextRef,
        readCapability: entry.capabilityRef, handler: entry.handlerRef,
        observability: { trace: { mode: 'required' as const, target: refs.trace }, immutableAudit: { mode: 'none' as const } },
        bindings: entry.lane.surface === 'operator_http'
          ? [{ surface: 'operator_http' as const, method: 'GET' as const, path: entry.path, input: 'query' as const, browserResumption: { kind: 'none' as const }, projection: entry.projectionRef }]
          : [{ surface: 'public_http' as const, method: 'GET' as const, path: entry.path, input: 'query' as const, browserResumption: { kind: 'none' as const }, projection: entry.projectionRef }]
      }))
    })
  });
}

function eventRequired(context: ReadInvocationContext): { readonly workspaceId: WorkspaceId; readonly eventId: EventId } {
  if (!context.scope.eventId) throw new TypeError('intake_current_event_required');
  return { workspaceId: context.scope.workspaceId, eventId: context.scope.eventId };
}

function assertProjectionScope(
  actual: { readonly workspaceId: string; readonly eventId: string },
  expected: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }
): void {
  if (actual.workspaceId !== expected.workspaceId || actual.eventId !== expected.eventId) {
    throw new TypeError('intake_read_projection_scope_mismatch');
  }
}

export function createIntakeReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policies: IntakeOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: IntakeCurrentEventSource;
  readonly read: IntakeReadPort;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: Pick<IntakeOperationCrypto, 'authorityPrincipalKeyProfile' | 'scopePartitionProfile' | 'requestCanonicalizationProfile'>;
}): OperationRegistryModule {
  assertPolicy(input.policies.eventRead, INTAKE_EVENT_READ_ACCESS_POLICY,
    'intake_event_read_policy_catalog_mismatch');
  assertPolicy(input.policies.submissionRead, INTAKE_SUBMISSION_READ_ACCESS_POLICY,
    'intake_submission_read_policy_catalog_mismatch');
  assertPolicy(input.policies.submissionContactRead, INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
    'intake_submission_contact_policy_catalog_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const operatorScope = eventScope(workspaceId, input.currentEvent);
  const eventRead = operatorLane(input.policies.eventRead);
  const submissionRead = operatorLane(input.policies.submissionRead);
  const contactRead = operatorLane(input.policies.submissionContactRead);
  return readModule({
    id: 'intake.read-operations', authority: input.currentAuthority,
    clock: input.clock, ids: input.ids, crypto: input.crypto,
    entries: [
      { operation: INTAKE_FORM_LIST_OPERATION, key: 'formList', path: '/api/events/current/forms', lane: eventRead, scope: operatorScope, requiresEvent: true, read: (context) => input.read.listForms(eventRequired(context)) },
      { operation: INTAKE_FORM_READ_OPERATION, key: 'formRead', path: '/api/events/current/forms/detail', lane: eventRead, scope: operatorScope, requiresEvent: true, read: (context, raw) => {
        const currentScope = eventRequired(context);
        const { formId } = formIdInputSchema.parse(raw);
        const value = input.read.readForm(currentScope, formId);
        if (value && value.head.id !== formId) throw new TypeError('intake_read_projection_id_mismatch');
        if (value) assertProjectionScope(value.head.scope, currentScope);
        return value;
      } },
      { operation: INTAKE_SUBMISSION_LIST_OPERATION, key: 'submissionList', path: '/api/events/current/submissions', lane: submissionRead, scope: operatorScope, requiresEvent: true, read: (context) => input.read.listSubmissions(eventRequired(context)) },
      { operation: INTAKE_SUBMISSION_READ_OPERATION, key: 'submissionRead', path: '/api/events/current/submissions/detail', lane: submissionRead, scope: operatorScope, requiresEvent: true, read: (context, raw) => {
        const currentScope = eventRequired(context);
        const { submissionId } = submissionIdInputSchema.parse(raw);
        const value = input.read.readSubmission(currentScope, submissionId);
        if (value && value.submissionId !== submissionId) {
          throw new TypeError('intake_read_projection_id_mismatch');
        }
        return value;
      } },
      { operation: INTAKE_SUBMISSION_CONTACT_READ_OPERATION, key: 'submissionContact', path: '/api/events/current/submissions/contact', lane: contactRead, scope: operatorScope, requiresEvent: true, read: (context, raw) => {
        const currentScope = eventRequired(context);
        const { submissionId } = submissionIdInputSchema.parse(raw);
        const value = input.read.readSubmissionContact(currentScope, submissionId);
        if (value && value.submissionId !== submissionId) {
          throw new TypeError('intake_read_projection_id_mismatch');
        }
        return value;
      } }
    ]
  });
}

/** Registers only the open, public-safe Form projection; no participant ceremony. */
export function createIntakePublicFormReadOperationModule(input: {
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly publicFormScope: IntakePublicFormScopeSource;
  readonly read: Pick<IntakeReadPort, 'readServedForm'>;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: Pick<IntakeOperationCrypto, 'authorityPrincipalKeyProfile' | 'scopePartitionProfile' | 'requestCanonicalizationProfile'>;
}): OperationRegistryModule {
  assertPolicy(input.policy, INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
    'intake_public_open_policy_catalog_mismatch');
  return readModule({
    id: 'intake.public-form-read',
    authority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    crypto: input.crypto,
    entries: [{
      operation: INTAKE_PUBLIC_FORM_READ_OPERATION,
      key: 'publicForm',
      path: '/api/public/forms/current',
      lane: publicOpenLane(input.policy),
      scope: publicFormScope(input.publicFormScope),
      read: (context, raw) => {
        const currentScope = eventRequired(context);
        const { formId } = formIdInputSchema.parse(raw);
        const value = input.read.readServedForm(currentScope, formId);
        if (value && value.formId !== formId) {
          throw new TypeError('intake_read_projection_id_mismatch');
        }
        return value;
      }
    }]
  });
}

/** Public reads remain isolated until the public surface is deliberately activated. */
export function createIntakePublicConformanceReadOperationModule(input: {
  readonly policies: Pick<IntakeOperationPolicies, 'publicOpen' | 'publicCeremony'>;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly publicFormScope: IntakePublicFormScopeSource;
  readonly ceremonyScope: IntakePublicCeremonyScopeSource;
  readonly read: Pick<IntakeReadPort, 'readServedForm' | 'readPublicDraftResume'>;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: Pick<IntakeOperationCrypto, 'authorityPrincipalKeyProfile' | 'scopePartitionProfile' | 'requestCanonicalizationProfile'>;
}): OperationRegistryModule {
  assertPolicy(input.policies.publicOpen, INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
    'intake_public_open_policy_catalog_mismatch');
  assertPolicy(input.policies.publicCeremony, INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
    'intake_public_ceremony_policy_catalog_mismatch');
  const publicOpen = publicOpenLane(input.policies.publicOpen);
  const publicCeremony = publicCeremonyLane(input.policies.publicCeremony);
  return readModule({
    id: 'intake.public-conformance-reads',
    authority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    crypto: input.crypto,
    entries: [
      {
        operation: INTAKE_PUBLIC_FORM_READ_OPERATION,
        key: 'publicForm',
        path: '/api/public/forms/current',
        lane: publicOpen,
        scope: publicFormScope(input.publicFormScope),
        read: (context, raw) => {
          const currentScope = eventRequired(context);
          const { formId } = formIdInputSchema.parse(raw);
          const value = input.read.readServedForm(currentScope, formId);
          if (value && value.formId !== formId) {
            throw new TypeError('intake_read_projection_id_mismatch');
          }
          return value;
        }
      },
      {
        operation: INTAKE_PUBLIC_DRAFT_RESUME_OPERATION,
        key: 'publicResume',
        path: '/api/public/forms/application',
        lane: publicCeremony,
        scope: ceremonyScope(input.ceremonyScope),
        read: (context: ReadInvocationContext) => {
          const binding = publicCeremonyBinding(context);
          const value = input.read.readPublicDraftResume(eventRequired(context), binding);
          if (value && (value.binding.draftId !== binding.draftId
              || value.binding.formId !== binding.formId
              || value.binding.formVersionId !== binding.formVersionId
              || value.binding.authorityPartitionDigestSha256
                !== binding.authorityPartitionDigestSha256
              || value.data.draft.formId !== binding.formId
              || value.data.draft.formVersionId !== binding.formVersionId)) {
            throw new TypeError('intake_read_projection_id_mismatch');
          }
          return value?.data;
        }
      }
    ]
  });
}

/** Explicit organizer draft operations; none writes effective Form state. */
export function createIntakeFormDraftOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: IntakeCurrentEventSource;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: IntakeOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy, INTAKE_EVENT_MANAGE_ACCESS_POLICY,
    'intake_event_manage_policy_catalog_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = operatorLane(input.policy);
  const scopeResolver = eventScope(workspaceId, input.currentEvent);
  const nullDetail = z.null();
  const schema = Object.freeze({
    contribution: schemaRef('schema.intake.form-draft.contribution', intakeFormDraftContributionSchema),
    canonical: schemaRef('schema.intake.form-draft.canonical-result', intakeFormDraftCanonicalResultSchema),
    projected: INTAKE_OPERATION_SCHEMA_REFS.formDrafts.create.resultSchema,
    detail: schemaRef('schema.intake.form-draft.refusal-detail', intakeFormDraftDetailSchema),
    nullDetail: schemaRef('schema.intake.form-draft.null-detail', nullDetail),
    inputs: Object.freeze(Object.fromEntries(intakeFormDraftOperations.map((entry) => [
      entry.action,
      INTAKE_OPERATION_SCHEMA_REFS.formDrafts[entry.action].inputSchema
    ])) as Record<IntakeFormDraftAction, SafeSchemaManifestRef>)
  });
  const shared = Object.freeze({
    handler: ref('handler.intake.form.changeset-draft'),
    projection: ref('projection.intake.form.changeset-draft.operator'),
    audit: ref('audit.intake.form.changeset-draft'),
    auditProfile: ref('record-profile.intake.form-draft.operation-audit'),
    keySource: ref('idempotency.operator-header')
  });
  const built = intakeFormDraftOperations.map((entry) => {
    const refs = Object.freeze({
      context: ref(`context.intake.form.${entry.action}-draft`),
      autonomy: ref(`autonomy.intake.form.${entry.action}-draft`),
      concurrency: ref(`concurrency.intake.form.${entry.action}-draft`),
      family: ref(`intake.form.${entry.action}-draft.execution-family`),
      phase: ref(`intake.form.${entry.action}-draft.phase.single-uow`),
      terminalization: ref(`intake.form.${entry.action}-draft.terminalization`),
      risk: ref(`intake.form.${entry.action}-draft.risk-resolver`),
      evidence: ref(`intake.form.${entry.action}-draft.autonomy-evidence`),
      approval: ref(`intake.form.${entry.action}-draft.approval-resolver`),
      preflight: ref(`intake.form.${entry.action}-draft.autonomy-preflight`)
    });
    const policy = autonomy(entry.operation, refs.autonomy, 'low');
    const context = createEffectInvocationContextBuilder({
      reference: refs.context,
      operation: entry.operation,
      effect: 'draft',
      lanes: [lane],
      scopeResolver,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      requestHashProfile: INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
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
      operation: entry.operation,
      phase: refs.phase,
      resolve: ({ result }) => result.kind === 'success'
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.phase,
      family: refs.family,
      operation: entry.operation,
      effect: 'draft',
      handler: shared.handler,
      handlerCapability: INTAKE_FORM_DRAFT_HANDLER_CAPABILITY,
      contributionSchema: schema.contribution,
      terminalization: refs.terminalization,
      terminalOutcomeKeys: [],
      contentionOutcome: {
        class: 'conflict', kind: 'operation.in_progress', retryable: true,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    });
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk,
      operation: entry.operation,
      resolve: () => ({
        risk: 'low', consequenceTags: ['changeset-drafted'],
        evidenceIds: [`intake.form.${entry.action}.draft.risk`]
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence,
      operation: entry.operation,
      resolve: ({ subject }) => {
        const bounds = {
          scopeKeys: [...subject.scopeKeys], maximumSpendMicros: 0, maximumActions: 1,
          notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
        };
        return {
          evaluatedAt: subject.evaluatedAt,
          hardBounds: bounds,
          unattendedBounds: bounds,
          spendMicros: 0,
          actionCount: 1,
          completesBy: subject.evaluatedAt,
          proposedAction: {
            key: `intake.form.${entry.action}.draft.execute`, version: 1,
            digestSha256: subject.requestHashSha256
          },
          failure: { kind: 'none' }
        };
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: refs.approval,
      operation: entry.operation,
      resolve: () => ({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: refs.preflight,
      operation: entry.operation,
      policy: refs.autonomy,
      riskResolver: refs.risk,
      evidenceResolver: refs.evidence,
      approvalResolver: refs.approval,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return Object.freeze({ ...entry, refs, policy, context, family, terminalization, phase,
      risk, evidence, approval, preflight });
  });
  const handler = createIntakeHandler({
    reference: shared.handler,
    effect: 'draft',
    handlerCapability: INTAKE_FORM_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schema.contribution,
    canonicalResultSchema: schema.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: schema.nullDetail
  }));
  return Object.freeze({
    id: 'intake.form-draft-operations',
    source: Object.freeze({
      autonomyPolicies: built.map((entry) => entry.policy),
      schemas: [
        ...built.map((entry) => ({
          reference: schema.inputs[entry.action], schema: entry.inputSchema
        })),
        { reference: schema.contribution, schema: intakeFormDraftContributionSchema },
        { reference: schema.canonical, schema: intakeFormDraftCanonicalResultSchema },
        { reference: schema.projected, schema: intakeFormDraftOperationResultSchema },
        { reference: schema.detail, schema: intakeFormDraftDetailSchema },
        { reference: schema.nullDetail, schema: nullDetail }
      ],
      contextBuilders: [], readCapabilities: [], handlers: [],
      projections: [{
        reference: shared.projection,
        canonicalResultSchema: schema.canonical,
        projectedResultSchema: schema.projected,
        project: (candidate: unknown) => intakeFormDraftCanonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: shared.audit, kind: 'operation_audit_record' as const,
        recordProfile: shared.auditProfile
      }],
      operationAuditRecordProfiles: [{
        reference: shared.auditProfile, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      operations: [],
      effectContextBuilders: built.map((entry) => entry.context),
      effectHandlers: [handler],
      effectExecutionFamilies: built.map((entry) => entry.family),
      effectPhases: built.map((entry) => entry.phase),
      terminalizationResolvers: built.map((entry) => entry.terminalization),
      riskResolvers: built.map((entry) => entry.risk),
      autonomyEvidenceResolvers: built.map((entry) => entry.evidence),
      renewedApprovalResolvers: built.map((entry) => entry.approval),
      autonomyPreflights: built.map((entry) => entry.preflight),
      effectOperations: built.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Draft a Form ${entry.action} change for review.`,
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: schema.inputs[entry.action],
        contributionSchema: schema.contribution,
        canonicalResultSchema: schema.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schema.nullDetail },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'intake_form.event_required', retryable: false, detailSchema: schema.nullDetail },
          { class: 'stale_revision' as const, kind: 'intake_form.changed', retryable: false, detailSchema: schema.detail },
          { class: 'policy_violation' as const, kind: 'intake_form.change_refused', retryable: false, detailSchema: schema.detail },
          { class: 'conflict' as const, kind: 'changeset.id_collision', retryable: false, detailSchema: schema.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schema.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(schema.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: entry.refs.context,
        handlerCapability: INTAKE_FORM_DRAFT_HANDLER_CAPABILITY,
        handler: shared.handler,
        audit: { mode: 'required' as const, target: shared.audit },
        idempotency: {
          keySource: shared.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE
        },
        concurrency: entry.refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: entry.refs.family,
          phase: entry.refs.phase,
          terminalization: entry.refs.terminalization,
          autonomyPreflight: entry.refs.preflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: entry.path,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: shared.projection
        }]
      }))
    })
  });
}

function effectModule(input: {
  readonly id: string;
  readonly operation: { readonly name: string; readonly version: number };
  readonly inputSchema: z.ZodType;
  readonly canonicalSchema: z.ZodType;
  readonly projectedSchema: z.ZodType;
  readonly contributionSchema: z.ZodType;
  readonly capability: VersionedDefinitionRef;
  readonly requestHashProfile: VersionedDefinitionRef;
  readonly lane: PublicCeremonyLane;
  readonly scope: InvocationScopeResolver;
  readonly authority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: IntakeOperationCrypto;
  readonly publicBoundary?: PublicEffectConformanceBoundary;
  readonly path: string;
}): OperationRegistryModule {
  const operation = input.operation;
  const key = operation.name;
  const r = {
    input: schemaRef(`schema.${key}.input`, input.inputSchema),
    contribution: schemaRef(`schema.${key}.contribution`, input.contributionSchema),
    canonical: schemaRef(`schema.${key}.canonical-result`, input.canonicalSchema),
    projected: schemaRef(`schema.${key}.projected-result`, input.projectedSchema),
    context: ref(`context.${key}`), handler: ref(`handler.${key}`), projection: ref(`projection.${key}`),
    autonomy: ref(`autonomy.${key}`), audit: ref(`audit.${key}`),
    concurrency: ref(`concurrency.${key}`), family: ref(`${key}.execution-family`),
    phase: ref(`${key}.phase.single-uow`), terminalization: ref(`${key}.terminalization`),
    risk: ref(`${key}.risk-resolver`), evidence: ref(`${key}.autonomy-evidence`),
    approval: ref(`${key}.approval-resolver`), preflight: ref(`${key}.autonomy-preflight`),
    keySource: ref(input.lane.kind === 'public_ceremony' ? 'idempotency.public-header' : 'idempotency.operator-header')
  };
  const policy = autonomy(operation, r.autonomy, 'normal');
  const contextFactory = input.publicBoundary?.createContextBuilder ?? createEffectInvocationContextBuilder;
  const context = contextFactory({
    reference: r.context, operation, effect: 'commit', lanes: [input.lane],
    scopeResolver: input.scope, authorityResolver: input.authority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    requestHashProfile: input.requestHashProfile, requestHashSealer: input.crypto.requestHashSealer,
    idempotencyCredentialProfile: input.crypto.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.crypto.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: r.terminalization, operation, phase: r.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: r.family, phase: r.phase });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: r.phase, family: r.family, operation, effect: 'commit', handler: r.handler,
    handlerCapability: input.capability, contributionSchema: r.contribution,
    terminalization: r.terminalization, terminalOutcomeKeys: [],
    contentionOutcome: { class: 'conflict', kind: 'operation.in_progress', retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: r.risk, operation,
    resolve: () => ({ risk: 'normal', consequenceTags: ['intake-state-changed'], evidenceIds: [`${key}.risk`] })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: r.evidence, operation,
    resolve: ({ subject }) => {
      const bounds = { scopeKeys: [...subject.scopeKeys], maximumSpendMicros: 0, maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) };
      return { evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds, spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt, proposedAction: { key: `${key}.execute`, version: 1, digestSha256: subject.requestHashSha256 }, failure: { kind: 'none' } };
    }
  });
  const approval = createRenewedApprovalResolverRegistration({ reference: r.approval, operation, resolve: () => ({ approverCurrentlyAuthorized: false }) });
  const preflight = createAutonomyPreflightRegistration({ reference: r.preflight, operation, policy: r.autonomy, riskResolver: r.risk, evidenceResolver: r.evidence, approvalResolver: r.approval, interventionOutcomes: autonomyInterventionOutcomes(1) });
  const handler = createIntakeHandler({ reference: r.handler, effect: 'commit', handlerCapability: input.capability, contributionSchema: r.contribution, canonicalResultSchema: r.canonical });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({ class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: refs.nullDetail }));
  return Object.freeze({
    id: input.id,
    source: Object.freeze({
      autonomyPolicies: [policy], schemas: [
        { reference: r.input, schema: input.inputSchema },
        { reference: r.contribution, schema: input.contributionSchema },
        { reference: r.canonical, schema: input.canonicalSchema },
        { reference: r.projected, schema: input.projectedSchema },
        { reference: refs.nullDetail, schema: nullSchema }
      ], contextBuilders: [], readCapabilities: [], handlers: [], projections: [{
        reference: r.projection, canonicalResultSchema: r.canonical,
        projectedResultSchema: r.projected,
        project: (candidate: unknown) => input.canonicalSchema.parse(candidate)
      }], operations: [], effectContextBuilders: [context], effectHandlers: [handler],
      operationAuditTargets: [{ reference: r.audit, kind: 'operation_audit_record' as const, recordProfile: refs.auditRecord }],
      operationAuditRecordProfiles: [{ reference: refs.auditRecord, kind: 'canonical_json' as const, maximumBytes: 262_144 }],
      effectExecutionFamilies: [family], effectPhases: [phase], terminalizationResolvers: [terminalization],
      riskResolvers: [risk], autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval], autonomyPreflights: [preflight],
      effectOperations: [{
        ...operation, lifecycle: { status: 'active' as const }, summary: `Apply ${operation.name}.`,
        effect: 'commit' as const, maxRisk: 'normal' as const, autonomyPolicy: r.autonomy,
        consequenceTags: ['intake-state-changed'], inputSchema: r.input,
        contributionSchema: r.contribution, canonicalResultSchema: r.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: refs.nullDetail },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'intake.changed', retryable: false, detailSchema: refs.nullDetail },
          { class: 'policy_violation' as const, kind: 'intake.refused', retryable: false, detailSchema: refs.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: refs.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(refs.nullDetail)
        ],
        accessLanes: [input.lane], contextBuilder: r.context,
        handlerCapability: input.capability, handler: r.handler,
        audit: { mode: 'required' as const, target: r.audit },
        idempotency: { keySource: r.keySource, credentialVerifierProfile: input.crypto.idempotencyCredentialProfile, requestHashProfile: input.requestHashProfile },
        concurrency: r.concurrency,
        execution: { kind: 'single_unit_of_work' as const, family: r.family, phase: r.phase, terminalization: r.terminalization, autonomyPreflight: r.preflight },
        bindings: [{
          surface: 'public_http' as const, method: 'POST' as const, path: input.path, input: 'body' as const,
          browserResumption: { kind: 'server_ref' as const, referenceSchema: r.projected, requestCodec: ref('codec.application.public-mutate-response'), maximumReferenceBytes: 512 },
          projection: r.projection
        }]
      }]
    })
  });
}

export function createIntakePublicConformanceMutationOperationModule(input: {
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly ceremonyScope: IntakePublicCeremonyScopeSource;
  readonly publicEffectConformance: PublicEffectConformanceBoundary;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: IntakeOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy, INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
    'intake_public_ceremony_policy_catalog_mismatch');
  return effectModule({
    id: 'intake.public-conformance-effects', operation: INTAKE_PUBLIC_MUTATE_OPERATION,
    inputSchema: intakePublicMutateInputSchema,
    canonicalSchema: intakePublicMutationCanonicalResultSchema,
    projectedSchema: intakePublicMutationOperationResultSchema,
    contributionSchema: intakePublicMutationContributionSchema,
    capability: INTAKE_PUBLIC_MUTATION_HANDLER_CAPABILITY,
    requestHashProfile: INTAKE_PUBLIC_MUTATION_REQUEST_HASH_PROFILE,
    lane: publicCeremonyLane(input.policy),
    scope: ceremonyScope(input.ceremonyScope), authority: input.currentAuthority,
    clock: input.clock, ids: input.ids, crypto: input.crypto,
    publicBoundary: input.publicEffectConformance,
    path: '/api/public/forms/application/mutate'
  });
}
