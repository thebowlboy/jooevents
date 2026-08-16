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
  type RequestHashSealer
} from '@jooevents/application';
import {
  PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  programVocabularyChangeResultSchema,
  programVocabularyMergeDraftRequestSchema,
  programVocabularyMergePublishCanonicalResultSchema,
  programVocabularyMergePublishInputSchema,
  programVocabularyMergePublishOperationResultSchema,
  programVocabularyMergeReviewCanonicalResultSchema,
  programVocabularyMergeReviewDataSchema,
  programVocabularyMergeReviewOperationResultSchema,
  programVocabularySafeDiffSchema,
  structuredOutcomeSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  parseProgramVocabularyMutationPlan,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import { z } from 'zod';
import { createProgramVocabularyMergeHandler } from './merge-preparation';

export const PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.merge.draft', version: 1
});

export const PROGRAM_VOCABULARY_MERGE_OPERATION = Object.freeze({
  name: 'program_vocabulary.merge', version: 1
});
export const PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.program_vocabulary.merge-review-draft'
);
export const PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY = ref(
  'capability.program_vocabulary.merge-publish'
);
export const PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.program_vocabulary.merge-review-draft'
);
export const PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE = ref(
  'request-hash.program_vocabulary.merge-publish'
);

const mergePlanSchema = z.custom<ProgramVocabularyMutationPlan>((value) => {
  try {
    return parseProgramVocabularyMutationPlan(value).action === 'merge';
  } catch {
    return false;
  }
}, { message: 'Expected a Program Vocabulary merge plan.' });
export const programVocabularyMergeDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: programVocabularyMergeReviewDataSchema }),
    domain: z.strictObject({
      kind: z.literal('program_vocabulary_merge_review_draft'),
      draftId: z.uuid(), revisionId: z.uuid(),
      revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      plan: mergePlanSchema,
      safeDiff: programVocabularySafeDiffSchema
    }),
    effectContributions: z.tuple([])
  }).superRefine((value, context) => {
    if (value.domain.safeDiff.action !== 'merge'
        || value.result.data.draftId !== value.domain.draftId
        || value.result.data.revision.id !== value.domain.revisionId
        || value.result.data.revision.digestSha256 !== value.domain.revisionDigestSha256) {
      context.addIssue({ code: 'custom', message: 'Program Vocabulary merge draft mismatch.' });
    }
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(), effectContributions: z.tuple([])
  })
]);
export const programVocabularyMergePublishContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: programVocabularyChangeResultSchema }),
    domain: z.strictObject({
      kind: z.literal('program_vocabulary_merge_publish'),
      draftId: z.uuid(), revisionId: z.uuid(),
      revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      plan: mergePlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(), effectContributions: z.tuple([])
  })
]);
export type ProgramVocabularyMergeDraftContribution =
  z.infer<typeof programVocabularyMergeDraftContributionSchema>;
export type ProgramVocabularyMergePublishContribution =
  z.infer<typeof programVocabularyMergePublishContributionSchema>;

function ref(key: string): VersionedDefinitionRef { return Object.freeze({ key, version: 1 }); }
const nullSchema = z.null();
const detailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_set', 'item_exists', 'item_missing', 'stale_item',
    'invalid_transition', 'delete_referenced', 'stale_reference', 'invalid_merge', 'invalid_plan'
  ]),
  action: z.literal('merge'),
  kind: z.enum(['room', 'track', 'format']),
  ids: z.array(z.uuid()).min(1).max(2)
});
const schemas = {
  draftInput: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergeReviewDraft.inputSchema,
  draftContribution: createSafeSchemaManifestRef(
    'schema.program_vocabulary.merge-review-draft.contribution',
    programVocabularyMergeDraftContributionSchema
  ),
  draftCanonical: createSafeSchemaManifestRef(
    'schema.program_vocabulary.merge-review-draft.canonical-result',
    programVocabularyMergeReviewCanonicalResultSchema
  ),
  draftProjected: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergeReviewDraft.resultSchema,
  publishInput: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergePublish.inputSchema,
  publishContribution: createSafeSchemaManifestRef(
    'schema.program_vocabulary.merge-publish.contribution',
    programVocabularyMergePublishContributionSchema
  ),
  publishCanonical: createSafeSchemaManifestRef(
    'schema.program_vocabulary.merge-publish.canonical-result',
    programVocabularyMergePublishCanonicalResultSchema
  ),
  publishProjected: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergePublish.resultSchema,
  null: createSafeSchemaManifestRef('schema.program_vocabulary.merge.null-detail', nullSchema),
  detail: createSafeSchemaManifestRef('schema.program_vocabulary.merge.changed-detail', detailSchema)
};

export interface CreateProgramVocabularyMergeOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: {
    resolveCurrentEvent(workspaceId: WorkspaceId): {
      readonly eventId?: string; readonly evidenceIds: readonly string[];
    } | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
  };
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly draftRequestHashSealer: RequestHashSealer;
  readonly publishRequestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return {
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  };
}

export function createProgramVocabularyMergeOperationModule(
  input: CreateProgramVocabularyMergeOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const scope: InvocationScopeResolver = Object.freeze({
    async resolve() {
      const resolved = await input.currentEvent.resolveCurrentEvent(workspaceId);
      const eventId = resolved.eventId ? parseEventId(resolved.eventId) : undefined;
      return Object.freeze({
        workspaceId,
        ...(eventId ? { eventId } : {}),
        subjects: Object.freeze(eventId
          ? [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }]
          : [{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: Object.freeze([...new Set(resolved.evidenceIds)].sort())
      });
    }
  });
  const entries = [
    {
      key: 'draft', operation: PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
      effect: 'draft' as const, capability: PROGRAM_VOCABULARY_MERGE_DRAFT_HANDLER_CAPABILITY,
      hash: PROGRAM_VOCABULARY_MERGE_DRAFT_REQUEST_HASH_PROFILE,
      sealer: input.draftRequestHashSealer,
      input: schemas.draftInput, contribution: schemas.draftContribution,
      canonical: schemas.draftCanonical, projected: schemas.draftProjected,
      path: '/api/events/current/program-vocabulary/merge/draft'
    },
    {
      key: 'publish', operation: PROGRAM_VOCABULARY_MERGE_OPERATION,
      effect: 'commit' as const, capability: PROGRAM_VOCABULARY_MERGE_PUBLISH_HANDLER_CAPABILITY,
      hash: PROGRAM_VOCABULARY_MERGE_PUBLISH_REQUEST_HASH_PROFILE,
      sealer: input.publishRequestHashSealer,
      input: schemas.publishInput, contribution: schemas.publishContribution,
      canonical: schemas.publishCanonical, projected: schemas.publishProjected,
      path: '/api/events/current/program-vocabulary/merge'
    }
  ].map((entry) => {
    const refs = {
      context: ref(`context.program_vocabulary.merge.${entry.key}`),
      autonomy: ref(`autonomy.program_vocabulary.merge.${entry.key}`),
      family: ref(`program_vocabulary.merge.${entry.key}.family`),
      phase: ref(`program_vocabulary.merge.${entry.key}.phase`),
      terminal: ref(`program_vocabulary.merge.${entry.key}.terminal`),
      risk: ref(`program_vocabulary.merge.${entry.key}.risk`),
      evidence: ref(`program_vocabulary.merge.${entry.key}.evidence`),
      approval: ref(`program_vocabulary.merge.${entry.key}.approval`),
      preflight: ref(`program_vocabulary.merge.${entry.key}.preflight`),
      concurrency: ref(`concurrency.program_vocabulary.merge.${entry.key}`),
      handler: ref(`handler.program_vocabulary.merge.${entry.key}`),
      projection: ref(`projection.program_vocabulary.merge.${entry.key}`)
    };
    const context = createEffectInvocationContextBuilder({
      reference: refs.context, operation: entry.operation, effect: entry.effect,
      lanes: [lane], scopeResolver: scope, authorityResolver: input.currentAuthority,
      clock: input.clock, newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: entry.hash, requestHashSealer: entry.sealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: refs.family, phase: refs.phase
    });
    const terminal = createTerminalizationResolverRegistration({
      reference: refs.terminal, operation: entry.operation, phase: refs.phase,
      resolve: ({ result }) => result.kind === 'success'
        ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const }
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.phase, family: refs.family, operation: entry.operation,
      effect: entry.effect, handler: refs.handler, handlerCapability: entry.capability,
      contributionSchema: entry.contribution, terminalization: refs.terminal,
      terminalOutcomeKeys: [],
      contentionOutcome: {
        class: 'conflict', kind: 'operation.in_progress', retryable: true,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    });
    const autonomy = createOperationAutonomyPolicy({
      definition: refs.autonomy, operation: entry.operation,
      riskFloor: 'consequential', unattendedRiskCeiling: 'consequential',
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
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk, operation: entry.operation,
      resolve: () => ({
        risk: 'consequential' as const,
        consequenceTags: Object.freeze(['program-vocabulary-merge']),
        evidenceIds: Object.freeze([`program_vocabulary.merge.${entry.key}.risk`])
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence, operation: entry.operation,
      resolve: ({ subject }) => {
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
          maximumActions: 1,
          notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
        });
        return {
          evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
          spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
          proposedAction: {
            key: `program_vocabulary.merge.${entry.key}.execute`, version: 1,
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
      reference: refs.preflight, operation: entry.operation, policy: refs.autonomy,
      riskResolver: refs.risk, evidenceResolver: refs.evidence,
      approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    const handler = createProgramVocabularyMergeHandler({
      reference: refs.handler, effect: entry.effect, capability: entry.capability,
      contributionSchema: entry.contribution, canonicalResultSchema: entry.canonical
    });
    return { entry, refs, context, family, terminal, phase, autonomy, risk, evidence, approval, preflight, handler };
  });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: schemas.null
  }));
  const audit = ref('audit.program_vocabulary.merge');
  const auditProfile = ref('record-profile.program_vocabulary.merge-audit');
  return Object.freeze({
    id: 'program-vocabulary.reviewed-merge-operations',
    source: Object.freeze({
      contextBuilders: Object.freeze([]), readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]), operations: Object.freeze([]),
      effectExecutionFamilies: Object.freeze(entries.map((value) => value.family)),
      effectPhases: Object.freeze(entries.map((value) => value.phase)),
      terminalizationResolvers: Object.freeze(entries.map((value) => value.terminal)),
      riskResolvers: Object.freeze(entries.map((value) => value.risk)),
      autonomyEvidenceResolvers: Object.freeze(entries.map((value) => value.evidence)),
      renewedApprovalResolvers: Object.freeze(entries.map((value) => value.approval)),
      autonomyPreflights: Object.freeze(entries.map((value) => value.preflight)),
      autonomyPolicies: Object.freeze(entries.map((value) => value.autonomy)),
      schemas: Object.freeze([
        { reference: schemas.draftInput, schema: programVocabularyMergeDraftRequestSchema },
        { reference: schemas.draftContribution, schema: programVocabularyMergeDraftContributionSchema },
        { reference: schemas.draftCanonical, schema: programVocabularyMergeReviewCanonicalResultSchema },
        { reference: schemas.draftProjected, schema: programVocabularyMergeReviewOperationResultSchema },
        { reference: schemas.publishInput, schema: programVocabularyMergePublishInputSchema },
        { reference: schemas.publishContribution, schema: programVocabularyMergePublishContributionSchema },
        { reference: schemas.publishCanonical, schema: programVocabularyMergePublishCanonicalResultSchema },
        { reference: schemas.publishProjected, schema: programVocabularyMergePublishOperationResultSchema },
        { reference: schemas.null, schema: nullSchema },
        { reference: schemas.detail, schema: detailSchema }
      ]),
      effectContextBuilders: Object.freeze(entries.map((value) => value.context)),
      effectHandlers: Object.freeze(entries.map((value) => value.handler)),
      projections: Object.freeze(entries.map((value) => ({
        reference: value.refs.projection,
        canonicalResultSchema: value.entry.canonical,
        projectedResultSchema: value.entry.projected,
        project: (candidate: unknown) => value.entry.key === 'draft'
          ? programVocabularyMergeReviewCanonicalResultSchema.parse(candidate)
          : programVocabularyMergePublishCanonicalResultSchema.parse(candidate)
      }))),
      operationAuditTargets: Object.freeze([{
        reference: audit, kind: 'operation_audit_record' as const, recordProfile: auditProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: auditProfile, kind: 'canonical_json' as const, maximumBytes: 262_144
      }]),
      effectOperations: Object.freeze(entries.map(({ entry, refs }) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: entry.key === 'draft'
          ? 'Prepare one Program Vocabulary merge for review.'
          : 'Publish one reviewed Program Vocabulary merge.',
        effect: entry.effect,
        maxRisk: 'consequential' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['program-vocabulary-merge'],
        inputSchema: entry.input,
        contributionSchema: entry.contribution,
        canonicalResultSchema: entry.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.null },
          ...access,
          { class: 'conflict' as const, kind: 'program_vocabulary.event_required', retryable: false, detailSchema: schemas.null },
          { class: 'stale_revision' as const, kind: 'program_vocabulary.changed', retryable: false, detailSchema: schemas.detail },
          { class: 'policy_violation' as const, kind: 'program_vocabulary.change_refused', retryable: false, detailSchema: schemas.detail },
          { class: 'conflict' as const, kind: 'program_vocabulary.merge_draft_changed', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.null },
          ...autonomyInterventionOutcomeDeclarations(schemas.null)
        ],
        accessLanes: [lane],
        contextBuilder: refs.context,
        handlerCapability: entry.capability,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: audit },
        idempotency: {
          keySource: ref('idempotency.operator-header'),
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: entry.hash
        },
        concurrency: refs.concurrency,
        execution: entry.key === 'publish'
          ? {
              kind: 'single_unit_of_work' as const,
              profile: 'direct_audited' as const,
              family: refs.family, phase: refs.phase, terminalization: refs.terminal,
              autonomyPreflight: refs.preflight,
              history: { summariesByAction: Object.freeze({ merge: 'Merged program categories' }) }
            }
          : {
              kind: 'single_unit_of_work' as const,
              family: refs.family, phase: refs.phase, terminalization: refs.terminal,
              autonomyPreflight: refs.preflight
            },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const, path: entry.path,
          input: 'body' as const, browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      })))
    })
  });
}
