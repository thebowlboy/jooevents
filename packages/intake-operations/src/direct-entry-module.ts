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
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule
} from '@jooevents/application';
import {
  SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  intakeDigestSchema,
  intakeIdSchema,
  structuredOutcomeSchema,
  submissionDirectEntryDraftCanonicalResultSchema,
  submissionDirectEntryDraftDataSchema,
  submissionDirectEntryDraftInputSchema,
  submissionDirectEntryDraftOperationResultSchema,
  submissionDirectEntrySafeDiffSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type PermissionId,
  type VersionedAccessPolicyRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import type { IntakeOperationCrypto, IntakeOperationIds, IntakeCurrentEventSource } from './module';
import { createIntakeHandler } from './preparation';

export const SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION = Object.freeze({
  name: 'submission.direct_entry.create.draft', version: 1
});

export const SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY: VersionedDefinitionRef =
  Object.freeze({
    key: 'capability.submission.direct-entry.changeset-draft',
    version: parseContractVersion(1)
  });
export const SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE: VersionedDefinitionRef =
  Object.freeze({
    key: 'request-hash.submission.direct-entry.draft',
    version: parseContractVersion(1)
  });

export const SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.submission.direct-entry',
  version: parseContractVersion(1)
});

export const SUBMISSION_DIRECT_ENTRY_PERMISSION_ID: PermissionId = 'event.manage';

export const SUBMISSION_DIRECT_ENTRY_HTTP_PATHS = Object.freeze({
  draft: '/api/events/current/submissions/direct-entry/drafts'
});

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());

export const submissionDirectEntryDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('submission_direct_entry_changeset_draft'),
  preparationHandle: canonicalUuid,
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  action: z.literal('create'),
  submissionId: intakeIdSchema,
  changesetId: canonicalUuid,
  revisionId: canonicalUuid,
  revisionDigestSha256: intakeDigestSchema,
  recordDigestSha256: intakeDigestSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

export const submissionDirectEntryDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: canonicalUuid,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  changesetId: canonicalUuid,
  revisionId: canonicalUuid,
  occurredAt: z.iso.datetime({ offset: true })
});

export const submissionDirectEntryDraftRefusalDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'form_missing', 'form_not_open', 'form_version_mismatch',
    'target_unavailable', 'deadline_unavailable', 'deadline_changed',
    'invalid_answers', 'invalid_submission_identity',
    'direct_entry_title_required', 'direct_entry_email_required', 'invalid_plan'
  ]),
  action: z.literal('create'),
  formId: intakeIdSchema
});

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({
    kind: z.literal('success'),
    data: submissionDirectEntryDraftDataSchema
  }),
  domain: submissionDirectEntryDraftDomainContributionSchema,
  receiptChildren: z.tuple([submissionDirectEntryDraftEvidenceChildSchema])
}).superRefine((value, context) => {
  const data = value.result.data;
  const domain = value.domain;
  const timeline = value.receiptChildren[0];
  if (data.action !== domain.action
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || data.safeDiff.submission.id !== domain.submissionId
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'direct entry draft evidence is incoherent' });
  }
});

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((value, context) => {
  const outcome = value.result.outcome;
  const allowed = new Set([
    'conflict:submission_direct_entry.event_required',
    'stale_revision:submission_direct_entry.changed',
    'policy_violation:submission_direct_entry.refused',
    'conflict:changeset.id_collision'
  ]);
  const detailSchema = outcome.kind === 'submission_direct_entry.changed'
      || outcome.kind === 'submission_direct_entry.refused'
    ? submissionDirectEntryDraftRefusalDetailSchema
    : z.null();
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'direct entry draft refusal is invalid' });
  }
});

export const submissionDirectEntryDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, parseContractVersion(1));
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

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function canonicalEvidence(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512
        || value.trim() !== value) {
      throw new TypeError('submission_direct_entry_scope_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort());
}

function eventScope(
  workspaceId: WorkspaceId,
  source: IntakeCurrentEventSource
): InvocationScopeResolver {
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
      workspaceId,
      eventId,
      subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        { kind: 'event' as const, id: eventId }
      ]),
      resolutionEvidenceIds: evidence
    });
  } });
}

function operatorLane(policy: VersionedAccessPolicyRef) {
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy });
  if (lane.kind !== 'operator') throw new TypeError('submission_direct_entry_lane_invalid');
  return lane;
}

/**
 * Registers the organizer direct-entry draft: one confirm on the operator
 * surface producing a single low-tier create changeset. The commit itself runs
 * through the generic changeset lifecycle operations.
 */
export function createSubmissionDirectEntryDraftOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: IntakeCurrentEventSource;
  readonly clock: Clock;
  readonly ids: IntakeOperationIds;
  readonly crypto: IntakeOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy, SUBMISSION_DIRECT_ENTRY_ACCESS_POLICY,
    'submission_direct_entry_policy_catalog_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = operatorLane(input.policy);
  const operation = SUBMISSION_DIRECT_ENTRY_DRAFT_OPERATION;
  const nullDetail = z.null();
  const refs = {
    input: SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS.draft.inputSchema,
    contribution: schemaRef(
      'schema.submission.direct-entry-draft.contribution',
      submissionDirectEntryDraftContributionSchema
    ),
    canonical: schemaRef(
      'schema.submission.direct-entry-draft.canonical-result',
      submissionDirectEntryDraftCanonicalResultSchema
    ),
    projected: SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS.draft.resultSchema,
    detail: schemaRef(
      'schema.submission.direct-entry-draft.refusal-detail',
      submissionDirectEntryDraftRefusalDetailSchema
    ),
    nullDetail: schemaRef('schema.submission.direct-entry-draft.null-detail', nullDetail),
    context: ref('context.submission.direct-entry.create-draft'),
    handler: ref('handler.submission.direct-entry.changeset-draft'),
    projection: ref('projection.submission.direct-entry.changeset-draft.operator'),
    autonomy: ref('autonomy.submission.direct-entry.create-draft'),
    audit: ref('audit.submission.direct-entry.changeset-draft'),
    auditProfile: ref('record-profile.submission.direct-entry-draft.operation-audit'),
    keySource: ref('idempotency.operator-header'),
    concurrency: ref('concurrency.submission.direct-entry.create-draft'),
    family: ref('submission.direct-entry.create-draft.execution-family'),
    phase: ref('submission.direct-entry.create-draft.phase.single-uow'),
    terminalization: ref('submission.direct-entry.create-draft.terminalization'),
    risk: ref('submission.direct-entry.create-draft.risk-resolver'),
    evidence: ref('submission.direct-entry.create-draft.autonomy-evidence'),
    approval: ref('submission.direct-entry.create-draft.approval-resolver'),
    preflight: ref('submission.direct-entry.create-draft.autonomy-preflight')
  };
  const operationAutonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
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
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation,
    effect: 'draft',
    lanes: [lane],
    scopeResolver: eventScope(workspaceId, input.currentEvent),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    requestHashProfile: SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE,
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
    operation,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? { kind: 'terminal' as const }
      : { kind: 'nonterminal' as const }
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation,
    effect: 'draft',
    handler: refs.handler,
    handlerCapability: SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: refs.contribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk,
    operation,
    resolve: () => ({
      risk: 'low',
      consequenceTags: ['changeset-drafted'],
      evidenceIds: ['submission.direct-entry.create.draft.risk']
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence,
    operation,
    resolve: ({ subject }) => {
      const bounds = {
        scopeKeys: [...subject.scopeKeys],
        maximumSpendMicros: 0,
        maximumActions: 1,
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
          key: 'submission.direct-entry.create.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        },
        failure: { kind: 'none' as const }
      };
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation,
    policy: refs.autonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.evidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createIntakeHandler({
    reference: refs.handler,
    effect: 'draft',
    handlerCapability: SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: refs.contribution,
    canonicalResultSchema: refs.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.nullDetail
  }));
  return Object.freeze({
    id: 'submission-direct-entry.draft-operation',
    source: Object.freeze({
      autonomyPolicies: [operationAutonomy],
      schemas: [
        { reference: refs.input, schema: submissionDirectEntryDraftInputSchema },
        { reference: refs.contribution, schema: submissionDirectEntryDraftContributionSchema },
        { reference: refs.canonical, schema: submissionDirectEntryDraftCanonicalResultSchema },
        { reference: refs.projected, schema: submissionDirectEntryDraftOperationResultSchema },
        { reference: refs.detail, schema: submissionDirectEntryDraftRefusalDetailSchema },
        { reference: refs.nullDetail, schema: nullDetail },
        {
          reference: schemaRef(
            'schema.submission.direct-entry.safe-diff', submissionDirectEntrySafeDiffSchema
          ),
          schema: submissionDirectEntrySafeDiffSchema
        }
      ],
      contextBuilders: [],
      readCapabilities: [],
      handlers: [],
      projections: [{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: refs.projected,
        project: (candidate: unknown) =>
          submissionDirectEntryDraftCanonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditProfile
      }],
      operationAuditRecordProfiles: [{
        reference: refs.auditProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }],
      operations: [],
      effectContextBuilders: [context],
      effectHandlers: [handler],
      effectExecutionFamilies: [family],
      effectPhases: [phase],
      terminalizationResolvers: [terminalization],
      riskResolvers: [risk],
      autonomyEvidenceResolvers: [evidence],
      renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight],
      effectOperations: [{
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one organizer-entered submission as a low-tier create changeset.',
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: refs.input,
        contributionSchema: refs.contribution,
        canonicalResultSchema: refs.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: refs.nullDetail },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'submission_direct_entry.event_required', retryable: false, detailSchema: refs.nullDetail },
          { class: 'stale_revision' as const, kind: 'submission_direct_entry.changed', retryable: false, detailSchema: refs.detail },
          { class: 'policy_violation' as const, kind: 'submission_direct_entry.refused', retryable: false, detailSchema: refs.detail },
          { class: 'conflict' as const, kind: 'changeset.id_collision', retryable: false, detailSchema: refs.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: refs.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(refs.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.context,
        handlerCapability: SUBMISSION_DIRECT_ENTRY_DRAFT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: SUBMISSION_DIRECT_ENTRY_DRAFT_REQUEST_HASH_PROFILE
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
          path: SUBMISSION_DIRECT_ENTRY_HTTP_PATHS.draft,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }]
    })
  });
}
