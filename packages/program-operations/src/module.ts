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
import {
  programVocabularyCreateDraftRequestSchema,
  createSafeSchemaManifestRef,
  programVocabularyDeleteDraftRequestSchema,
  programVocabularyDraftCanonicalResultSchema as sharedProgramVocabularyDraftCanonicalResultSchema,
  programVocabularyDraftDataSchema as sharedProgramVocabularyDraftDataSchema,
  programVocabularyDraftOperationResultSchema as sharedProgramVocabularyDraftOperationResultSchema,
  programVocabularyEditDraftRequestSchema,
  programVocabularyKindSchema,
  programVocabularyMergeDraftRequestSchema,
  programVocabularyRestoreDraftRequestSchema,
  programVocabularyRetireDraftRequestSchema,
  programVocabularySnapshotCanonicalResultSchema,
  programVocabularySnapshotReadInputSchema,
  programVocabularySnapshotReadResultSchema,
  programVocabularySnapshotSchema,
  PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
  structuredOutcomeSchema,
  type ProgramVocabularySnapshotDto,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  assertProgramReferenceContributorRegistry,
  captureRegisteredProgramReferences,
  projectProgramVocabularySnapshot,
  type ProgramReferenceContributorRegistry,
  type ProgramVocabularyReadPort
} from '@jooevents/program';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type PermissionId,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type EventId,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  createProgramVocabularyDraftHandler,
  type ProgramVocabularyDraftAction
} from './preparation';

export const PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'program_vocabulary.snapshot.read', version: 1
});
export const PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.create.draft', version: 1
});
export const PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.edit.draft', version: 1
});
export const PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.retire.draft', version: 1
});
export const PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.restore.draft', version: 1
});
export const PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.delete.draft', version: 1
});
export const PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION = Object.freeze({
  name: 'program_vocabulary.merge.draft', version: 1
});

export const PROGRAM_VOCABULARY_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.program_vocabulary.read', version: parseContractVersion(1)
});
export const PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.program_vocabulary.manage', version: parseContractVersion(1)
});
export const PROGRAM_VOCABULARY_READ_PERMISSION_ID: PermissionId = 'event.read';
export const PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID: PermissionId =
  'program.vocabulary.manage';
export const PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.program_vocabulary.draft'
);
export const PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.program_vocabulary.changeset_draft'
);

const canonicalApplicationIdSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: 'Application IDs must use canonical lowercase bytes.' }
);

const draftOperations = Object.freeze([
  Object.freeze({ action: 'create' as const, operation: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION }),
  Object.freeze({ action: 'edit' as const, operation: PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION }),
  Object.freeze({ action: 'retire' as const, operation: PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION }),
  Object.freeze({ action: 'restore' as const, operation: PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION }),
  Object.freeze({ action: 'delete' as const, operation: PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION }),
  Object.freeze({ action: 'merge' as const, operation: PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION })
]);

export const programVocabularyCreateDraftInputSchema =
  programVocabularyCreateDraftRequestSchema;
export const programVocabularyEditDraftInputSchema =
  programVocabularyEditDraftRequestSchema;
export const programVocabularyRetireDraftInputSchema =
  programVocabularyRetireDraftRequestSchema;
export const programVocabularyRestoreDraftInputSchema =
  programVocabularyRestoreDraftRequestSchema;
export const programVocabularyDeleteDraftInputSchema =
  programVocabularyDeleteDraftRequestSchema;
export const programVocabularyMergeDraftInputSchema =
  programVocabularyMergeDraftRequestSchema;
export const programVocabularyDraftDataSchema = sharedProgramVocabularyDraftDataSchema;
export const programVocabularyDraftCanonicalResultSchema =
  sharedProgramVocabularyDraftCanonicalResultSchema;
export const programVocabularyDraftOperationResultSchema =
  sharedProgramVocabularyDraftOperationResultSchema;

export const programVocabularyDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('program_vocabulary_changeset_draft'),
  preparationHandle: canonicalApplicationIdSchema,
  action: z.enum(['create', 'edit', 'retire', 'restore', 'delete', 'merge']),
  workspaceId: canonicalApplicationIdSchema,
  eventId: canonicalApplicationIdSchema,
  changesetId: canonicalApplicationIdSchema,
  revisionId: canonicalApplicationIdSchema,
  revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recordDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.iso.datetime({ offset: true })
});

export const programVocabularyDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: canonicalApplicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: canonicalApplicationIdSchema,
  eventId: canonicalApplicationIdSchema,
  changesetId: canonicalApplicationIdSchema,
  revisionId: canonicalApplicationIdSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

const nullDetailSchema = z.null();
const draftDetailSchema = z.strictObject({
  code: z.enum([
    'stale_set',
    'stale_item',
    'stale_reference',
    'item_exists',
    'item_missing',
    'invalid_transition',
    'delete_referenced',
    'invalid_merge'
  ]),
  action: z.enum(['create', 'edit', 'retire', 'restore', 'delete', 'merge']),
  kind: programVocabularyKindSchema.optional(),
  ids: z.array(canonicalApplicationIdSchema).max(2)
});

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: programVocabularyDraftDataSchema }),
  domain: programVocabularyDraftDomainContributionSchema,
  receiptChildren: z.tuple([programVocabularyDraftEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Program Vocabulary draft evidence is incoherent.' });
  }
});

const allowedDraftOutcomeKeys = new Set([
  'conflict:program_vocabulary.event_required',
  'stale_revision:program_vocabulary.changed',
  'policy_violation:program_vocabulary.change_refused',
  'conflict:changeset.id_collision'
]);

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'program_vocabulary.event_required'
      || outcome.kind === 'changeset.id_collision'
    ? nullDetailSchema
    : draftDetailSchema;
  if (!allowedDraftOutcomeKeys.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Program Vocabulary draft refusal is invalid.' });
  }
});

export const programVocabularyDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

export type ProgramVocabularyDraftData = z.infer<typeof programVocabularyDraftDataSchema>;
export type ProgramVocabularyDraftContribution =
  z.infer<typeof programVocabularyDraftContributionSchema>;
export type ProgramVocabularyCreateDraftInput =
  z.infer<typeof programVocabularyCreateDraftInputSchema>;
export type ProgramVocabularyEditDraftInput = z.infer<typeof programVocabularyEditDraftInputSchema>;
export type ProgramVocabularyRetireDraftInput =
  z.infer<typeof programVocabularyRetireDraftInputSchema>;
export type ProgramVocabularyRestoreDraftInput =
  z.infer<typeof programVocabularyRestoreDraftInputSchema>;
export type ProgramVocabularyDeleteDraftInput =
  z.infer<typeof programVocabularyDeleteDraftInputSchema>;
export type ProgramVocabularyMergeDraftInput = z.infer<typeof programVocabularyMergeDraftInputSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const inputSchemas = Object.freeze({
  create: programVocabularyCreateDraftInputSchema,
  edit: programVocabularyEditDraftInputSchema,
  retire: programVocabularyRetireDraftInputSchema,
  restore: programVocabularyRestoreDraftInputSchema,
  delete: programVocabularyDeleteDraftInputSchema,
  merge: programVocabularyMergeDraftInputSchema
});

const schemas = Object.freeze({
  readInput: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  readCanonical: schemaRef(
    'schema.program_vocabulary.snapshot-read.canonical-result',
    programVocabularySnapshotCanonicalResultSchema
  ),
  readProjected: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  draftContribution: schemaRef(
    'schema.program_vocabulary.changeset-draft.contribution',
    programVocabularyDraftContributionSchema
  ),
  draftCanonical: schemaRef(
    'schema.program_vocabulary.changeset-draft.canonical-result',
    programVocabularyDraftCanonicalResultSchema
  ),
  draftProjected: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.create.resultSchema,
  nullDetail: schemaRef('schema.program_vocabulary.operation.null-detail', nullDetailSchema),
  draftDetail: schemaRef('schema.program_vocabulary.draft-refusal.detail', draftDetailSchema),
  draftInputs: Object.freeze({
    create: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.create.inputSchema,
    edit: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.edit.inputSchema,
    retire: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.retire.inputSchema,
    restore: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.restore.inputSchema,
    delete: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.delete.inputSchema,
    merge: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.merge.inputSchema
  })
});

const refs = Object.freeze({
  readContext: ref('context.program_vocabulary.snapshot-read'),
  readAutonomy: ref('autonomy.program_vocabulary.snapshot-read'),
  readCapability: ref('capability.program_vocabulary.snapshot-read'),
  readHandler: ref('handler.program_vocabulary.snapshot-read'),
  readProjection: ref('projection.program_vocabulary.snapshot-read.operator'),
  readTrace: ref('trace.program_vocabulary.snapshot-read'),
  draftHandler: ref('handler.program_vocabulary.changeset-draft'),
  draftProjection: ref('projection.program_vocabulary.changeset-draft.operator'),
  audit: ref('audit.program_vocabulary.changeset-draft'),
  auditRecordProfile: ref('record-profile.program_vocabulary.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE
});

interface DraftRefs {
  readonly context: VersionedDefinitionRef;
  readonly autonomy: VersionedDefinitionRef;
  readonly concurrency: VersionedDefinitionRef;
  readonly executionFamily: VersionedDefinitionRef;
  readonly executionPhase: VersionedDefinitionRef;
  readonly terminalization: VersionedDefinitionRef;
  readonly riskResolver: VersionedDefinitionRef;
  readonly autonomyEvidence: VersionedDefinitionRef;
  readonly approvalResolver: VersionedDefinitionRef;
  readonly autonomyPreflight: VersionedDefinitionRef;
}

function refsFor(action: ProgramVocabularyDraftAction): DraftRefs {
  return Object.freeze({
    context: ref(`context.program_vocabulary.${action}-draft`),
    autonomy: ref(`autonomy.program_vocabulary.${action}-draft`),
    concurrency: ref(`concurrency.program_vocabulary.${action}-draft`),
    executionFamily: ref(`program_vocabulary.${action}-draft.execution-family`),
    executionPhase: ref(`program_vocabulary.${action}-draft.phase.single-uow`),
    terminalization: ref(`program_vocabulary.${action}-draft.terminalization`),
    riskResolver: ref(`program_vocabulary.${action}-draft.risk-resolver`),
    autonomyEvidence: ref(`program_vocabulary.${action}-draft.autonomy-evidence`),
    approvalResolver: ref(`program_vocabulary.${action}-draft.approval-resolver`),
    autonomyPreflight: ref(`program_vocabulary.${action}-draft.autonomy-preflight`)
  });
}

export interface ProgramVocabularyCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface ProgramVocabularyCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    ProgramVocabularyCurrentEventResolution | Promise<ProgramVocabularyCurrentEventResolution>;
}

export interface ProgramVocabularyOperationIds {
  newInvocationId(): InvocationId;
}

export interface ProgramVocabularyOperationPolicies {
  readonly read: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
}

export interface CreateProgramVocabularyOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: ProgramVocabularyOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: ProgramVocabularyCurrentEventSource;
  readonly vocabularyRead: ProgramVocabularyReadPort;
  readonly referenceRegistry: ProgramReferenceContributorRegistry;
  readonly clock: Clock;
  readonly ids: ProgramVocabularyOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function eventRequiredOutcome(): StructuredOutcome {
  return Object.freeze({
    class: 'conflict',
    kind: 'program_vocabulary.event_required',
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.trim() !== value) {
      throw new TypeError('program_vocabulary_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: ProgramVocabularyCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('program_vocabulary_current_event_resolution_invalid');
      }
      const evidenceIds = canonicalEvidenceIds(resolved.evidenceIds);
      if (resolved.eventId === undefined) {
        return Object.freeze({
          workspaceId: input.workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
          resolutionEvidenceIds: evidenceIds
        });
      }
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({
        workspaceId: input.workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: input.workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: evidenceIds
      });
    }
  });
}

function operationAutonomy(input: {
  readonly operation: { readonly name: string; readonly version: number };
  readonly definition: VersionedDefinitionRef;
}) {
  return createOperationAutonomyPolicy({
    definition: input.definition,
    operation: input.operation,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block',
      unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval',
      known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile',
      stale_plan: 'replan',
      compensation_required: 'compensate',
      terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
}

export function programVocabularyDraftActionForOperation(
  operationName: string,
  operationVersion: number
): ProgramVocabularyDraftAction | undefined {
  return draftOperations.find(({ operation }) =>
    operation.name === operationName && operation.version === operationVersion
  )?.action;
}

function pathFor(action: ProgramVocabularyDraftAction): string {
  return `/api/events/current/program-vocabulary/drafts/${action}`;
}

export function createProgramVocabularyOperationModule(
  input: CreateProgramVocabularyOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.read.key !== PROGRAM_VOCABULARY_READ_ACCESS_POLICY.key
      || input.policies.read.version !== PROGRAM_VOCABULARY_READ_ACCESS_POLICY.version
      || input.policies.manage.key !== PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY.key
      || input.policies.manage.version !== PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('program_vocabulary_operation_policy_catalog_mismatch');
  }
  assertProgramReferenceContributorRegistry(input.referenceRegistry);
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const readLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.read
  });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.manage
  });
  const readAutonomy = operationAutonomy({
    operation: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
    definition: refs.readAutonomy
  });
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext,
    operation: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
    effect: 'read',
    lanes: [readLane],
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const readCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.readCapability,
    openSnapshot(context: ReadInvocationContext) {
      if (context.scope.eventId === undefined) {
        return Object.freeze({ kind: 'event_required' });
      }
      const state = input.vocabularyRead.readVocabulary({
        workspaceId: context.scope.workspaceId,
        eventId: context.scope.eventId
      });
      if (!state) throw new TypeError('program_vocabulary_current_event_state_missing');
      if (state.scope.workspaceId !== context.scope.workspaceId
          || state.scope.eventId !== context.scope.eventId) {
        throw new TypeError('program_vocabulary_current_event_state_scope_mismatch');
      }
      const references = captureRegisteredProgramReferences({
        registry: input.referenceRegistry,
        scope: state.scope,
        source: input.vocabularyRead
      });
      return Object.freeze({
        kind: 'snapshot',
        value: projectProgramVocabularySnapshot(state, references)
      });
    }
  });

  const draftDefinitions = draftOperations.map(({ action, operation }) => {
    const definitionRefs = refsFor(action);
    const autonomy = operationAutonomy({ operation, definition: definitionRefs.autonomy });
    const context = createEffectInvocationContextBuilder({
      reference: definitionRefs.context,
      operation,
      effect: 'draft',
      lanes: [manageLane],
      scopeResolver,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: refs.requestHash,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: definitionRefs.executionFamily,
      phase: definitionRefs.executionPhase
    });
    const terminalization = createTerminalizationResolverRegistration({
      reference: definitionRefs.terminalization,
      operation,
      phase: definitionRefs.executionPhase,
      resolve: ({ result }) => result.kind === 'success'
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: definitionRefs.executionPhase,
      family: definitionRefs.executionFamily,
      operation,
      effect: 'draft',
      handler: refs.draftHandler,
      handlerCapability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
      contributionSchema: schemas.draftContribution,
      terminalization: definitionRefs.terminalization,
      terminalOutcomeKeys: [],
      contentionOutcome: Object.freeze({
        class: 'conflict' as const,
        kind: 'operation.in_progress',
        retryable: true,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      })
    });
    const riskResolver = createOperationRiskResolverRegistration({
      reference: definitionRefs.riskResolver,
      operation,
      resolve: () => Object.freeze({
        risk: 'low' as const,
        consequenceTags: Object.freeze(['changeset-drafted']),
        evidenceIds: Object.freeze([`program_vocabulary.${action}.draft.risk`])
      })
    });
    const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
      reference: definitionRefs.autonomyEvidence,
      operation,
      resolve: ({ subject }) => {
        const notAfter = parseInstant(
          new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()
        );
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]),
          maximumSpendMicros: 0,
          maximumActions: 1,
          notAfter
        });
        return Object.freeze({
          evaluatedAt: subject.evaluatedAt,
          hardBounds: bounds,
          unattendedBounds: bounds,
          spendMicros: 0,
          actionCount: 1,
          completesBy: subject.evaluatedAt,
          proposedAction: Object.freeze({
            key: `program_vocabulary.${action}.draft.execute`,
            version: 1,
            digestSha256: subject.requestHashSha256
          }),
          failure: Object.freeze({ kind: 'none' as const })
        });
      }
    });
    const approvalResolver = createRenewedApprovalResolverRegistration({
      reference: definitionRefs.approvalResolver,
      operation,
      resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
    });
    const autonomyPreflight = createAutonomyPreflightRegistration({
      reference: definitionRefs.autonomyPreflight,
      operation,
      policy: definitionRefs.autonomy,
      riskResolver: definitionRefs.riskResolver,
      evidenceResolver: definitionRefs.autonomyEvidence,
      approvalResolver: definitionRefs.approvalResolver,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return Object.freeze({
      action,
      operation,
      refs: definitionRefs,
      autonomy,
      context,
      family,
      terminalization,
      phase,
      riskResolver,
      autonomyEvidence,
      approvalResolver,
      autonomyPreflight
    });
  });

  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  const draftHandler = createProgramVocabularyDraftHandler({
    reference: refs.draftHandler,
    handlerCapability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.draftContribution,
    canonicalResultSchema: schemas.draftCanonical,
    actionForOperation: programVocabularyDraftActionForOperation
  });

  return Object.freeze({
    id: 'program-vocabulary.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(draftDefinitions.map((entry) => entry.family)),
      effectPhases: Object.freeze(draftDefinitions.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(
        draftDefinitions.map((entry) => entry.terminalization)
      ),
      riskResolvers: Object.freeze(draftDefinitions.map((entry) => entry.riskResolver)),
      autonomyEvidenceResolvers: Object.freeze(
        draftDefinitions.map((entry) => entry.autonomyEvidence)
      ),
      renewedApprovalResolvers: Object.freeze(
        draftDefinitions.map((entry) => entry.approvalResolver)
      ),
      autonomyPreflights: Object.freeze(
        draftDefinitions.map((entry) => entry.autonomyPreflight)
      ),
      autonomyPolicies: Object.freeze([
        readAutonomy,
        ...draftDefinitions.map((entry) => entry.autonomy)
      ]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: programVocabularySnapshotReadInputSchema },
        { reference: schemas.readCanonical, schema: programVocabularySnapshotCanonicalResultSchema },
        { reference: schemas.readProjected, schema: programVocabularySnapshotReadResultSchema },
        ...draftOperations.map(({ action }) => ({
          reference: schemas.draftInputs[action], schema: inputSchemas[action]
        })),
        { reference: schemas.draftContribution, schema: programVocabularyDraftContributionSchema },
        { reference: schemas.draftCanonical, schema: programVocabularyDraftCanonicalResultSchema },
        { reference: schemas.draftProjected, schema: programVocabularyDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.draftDetail, schema: draftDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: refs.readHandler,
        readCapability: refs.readCapability,
        canonicalResultSchema: schemas.readCanonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) =>
          snapshot.kind === 'event_required'
            ? Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() })
            : Object.freeze({
                kind: 'success' as const,
                data: programVocabularySnapshotSchema.parse(snapshot.value)
              })
      }]),
      projections: Object.freeze([{
        reference: refs.readProjection,
        canonicalResultSchema: schemas.readCanonical,
        projectedResultSchema: schemas.readProjected,
        project: (candidate: unknown) =>
          programVocabularySnapshotCanonicalResultSchema.parse(candidate)
      }, {
        reference: refs.draftProjection,
        canonicalResultSchema: schemas.draftCanonical,
        projectedResultSchema: schemas.draftProjected,
        project: (candidate: unknown) => programVocabularyDraftCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.readTrace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read rooms, tracks, and formats for the current Event.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.readAutonomy,
        consequenceTags: [],
        inputSchema: schemas.readInput,
        canonicalResultSchema: schemas.readCanonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'program_vocabulary.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          }
        ],
        accessLanes: [readLane],
        contextBuilder: refs.readContext,
        readCapability: refs.readCapability,
        handler: refs.readHandler,
        observability: {
          trace: { mode: 'required' as const, target: refs.readTrace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: '/api/events/current/program-vocabulary',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.readProjection
        }]
      }]),
      effectContextBuilders: Object.freeze(draftDefinitions.map((entry) => entry.context)),
      effectHandlers: Object.freeze([draftHandler]),
      effectOperations: Object.freeze(draftDefinitions.map(({ action, operation, refs: operationRefs }) => ({
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: `Draft a Program Vocabulary ${action} change for review.`,
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: operationRefs.autonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: schemas.draftInputs[action],
        contributionSchema: schemas.draftContribution,
        canonicalResultSchema: schemas.draftCanonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'program_vocabulary.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'program_vocabulary.changed',
            retryable: false,
            detailSchema: schemas.draftDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'program_vocabulary.change_refused',
            retryable: false,
            detailSchema: schemas.draftDetail
          },
          {
            class: 'conflict' as const,
            kind: 'changeset.id_collision',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: schemas.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [manageLane],
        contextBuilder: operationRefs.context,
        handlerCapability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
        handler: refs.draftHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: refs.requestHash
        },
        concurrency: operationRefs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: operationRefs.executionFamily,
          phase: operationRefs.executionPhase,
          terminalization: operationRefs.terminalization,
          autonomyPreflight: operationRefs.autonomyPreflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: pathFor(action),
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.draftProjection
        }]
      })))
    })
  });
}

export function programVocabularySnapshotData(
  snapshot: ProgramVocabularySnapshotDto
): ProgramVocabularySnapshotDto {
  return programVocabularySnapshotSchema.parse(snapshot);
}
