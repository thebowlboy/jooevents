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
  FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
  fieldRegistryAddDraftRequestSchema,
  fieldRegistryDigestSchema,
  fieldRegistryDraftActionSchema,
  fieldRegistryDraftCanonicalResultSchema,
  fieldRegistryDraftDataSchema,
  fieldRegistryDraftOperationResultSchema,
  fieldRegistryEditDraftRequestSchema,
  fieldRegistryIdSchema,
  fieldRegistryMoveDraftRequestSchema,
  fieldRegistryRemoveDraftRequestSchema,
  fieldRegistryRestoreDraftRequestSchema,
  fieldRegistrySnapshotCanonicalResultSchema,
  fieldRegistrySnapshotReadInputSchema,
  fieldRegistrySnapshotReadResultSchema,
  fieldRegistrySnapshotSchema,
  structuredOutcomeSchema,
  createSafeSchemaManifestRef,
  type FieldRegistryDraftAction,
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
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  projectFieldRegistrySnapshot,
  type FieldRegistryLiveOptionSource
} from './model';
import type { FieldRegistryReadPort } from './changesets';
import { createFieldRegistryDraftHandler } from './preparation';

export const FIELD_REGISTRY_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'field_registry.snapshot.read', version: 1
});
export const FIELD_REGISTRY_ADD_DRAFT_OPERATION = Object.freeze({
  name: 'field_registry.add.draft', version: 1
});
export const FIELD_REGISTRY_EDIT_DRAFT_OPERATION = Object.freeze({
  name: 'field_registry.edit.draft', version: 1
});
export const FIELD_REGISTRY_MOVE_DRAFT_OPERATION = Object.freeze({
  name: 'field_registry.move.draft', version: 1
});
export const FIELD_REGISTRY_REMOVE_DRAFT_OPERATION = Object.freeze({
  name: 'field_registry.remove.draft', version: 1
});
export const FIELD_REGISTRY_RESTORE_DRAFT_OPERATION = Object.freeze({
  name: 'field_registry.restore.draft', version: 1
});

export const FIELD_REGISTRY_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.field_registry.read', version: parseContractVersion(1)
});
export const FIELD_REGISTRY_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.field_registry.manage', version: parseContractVersion(1)
});
export const FIELD_REGISTRY_READ_PERMISSION_ID: PermissionId = 'event.read';
export const FIELD_REGISTRY_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';
export const FIELD_REGISTRY_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.field_registry.draft'
);
export const FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.field_registry.changeset_draft'
);

const draftOperations = Object.freeze([
  Object.freeze({
    action: 'add' as const,
    operation: FIELD_REGISTRY_ADD_DRAFT_OPERATION,
    schema: fieldRegistryAddDraftRequestSchema
  }),
  Object.freeze({
    action: 'edit' as const,
    operation: FIELD_REGISTRY_EDIT_DRAFT_OPERATION,
    schema: fieldRegistryEditDraftRequestSchema
  }),
  Object.freeze({
    action: 'move' as const,
    operation: FIELD_REGISTRY_MOVE_DRAFT_OPERATION,
    schema: fieldRegistryMoveDraftRequestSchema
  }),
  Object.freeze({
    action: 'remove' as const,
    operation: FIELD_REGISTRY_REMOVE_DRAFT_OPERATION,
    schema: fieldRegistryRemoveDraftRequestSchema
  }),
  Object.freeze({
    action: 'restore' as const,
    operation: FIELD_REGISTRY_RESTORE_DRAFT_OPERATION,
    schema: fieldRegistryRestoreDraftRequestSchema
  })
]);

export const fieldRegistryDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('field_registry_changeset_draft'),
  preparationHandle: fieldRegistryIdSchema,
  action: fieldRegistryDraftActionSchema,
  workspaceId: fieldRegistryIdSchema,
  eventId: fieldRegistryIdSchema,
  changesetId: fieldRegistryIdSchema,
  revisionId: fieldRegistryIdSchema,
  revisionDigestSha256: fieldRegistryDigestSchema,
  recordDigestSha256: fieldRegistryDigestSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

export const fieldRegistryDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: fieldRegistryIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: fieldRegistryIdSchema,
  eventId: fieldRegistryIdSchema,
  changesetId: fieldRegistryIdSchema,
  revisionId: fieldRegistryIdSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

const nullDetailSchema = z.null();
export const fieldRegistryDraftDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_registry', 'field_exists', 'field_missing', 'stale_field',
    'field_removed', 'field_active', 'form_missing', 'form_changed', 'locked_field',
    'invalid_options', 'invalid_position', 'invalid_plan', 'policy_changed'
  ]),
  action: fieldRegistryDraftActionSchema,
  fieldId: fieldRegistryIdSchema
});

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: fieldRegistryDraftDataSchema }),
  domain: fieldRegistryDraftDomainContributionSchema,
  receiptChildren: z.tuple([fieldRegistryDraftEvidenceChildSchema])
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
    context.addIssue({ code: 'custom', message: 'Field Registry draft evidence is incoherent.' });
  }
});

const allowedDraftOutcomes = new Set([
  'conflict:field_registry.event_required',
  'stale_revision:field_registry.changed',
  'policy_violation:field_registry.change_refused',
  'conflict:changeset.id_collision'
]);

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'field_registry.event_required'
      || outcome.kind === 'changeset.id_collision'
    ? nullDetailSchema
    : fieldRegistryDraftDetailSchema;
  if (!allowedDraftOutcomes.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Field Registry draft refusal is invalid.' });
  }
});

export const fieldRegistryDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);
export type FieldRegistryDraftContribution = z.infer<typeof fieldRegistryDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, parseContractVersion(1));
}

const schemas = Object.freeze({
  readInput: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  readCanonical: schemaRef(
    'schema.field_registry.snapshot-read.canonical-result',
    fieldRegistrySnapshotCanonicalResultSchema
  ),
  readProjected: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  draftContribution: schemaRef(
    'schema.field_registry.changeset-draft.contribution',
    fieldRegistryDraftContributionSchema
  ),
  draftCanonical: schemaRef(
    'schema.field_registry.changeset-draft.canonical-result',
    fieldRegistryDraftCanonicalResultSchema
  ),
  draftProjected: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts.add.resultSchema,
  nullDetail: schemaRef('schema.field_registry.operation.null-detail', nullDetailSchema),
  draftDetail: schemaRef(
    'schema.field_registry.draft-refusal.detail',
    fieldRegistryDraftDetailSchema
  ),
  draftInputs: Object.freeze({
    add: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts.add.inputSchema,
    edit: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts.edit.inputSchema,
    move: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts.move.inputSchema,
    remove: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts.remove.inputSchema,
    restore: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts.restore.inputSchema
  })
});

const refs = Object.freeze({
  readContext: ref('context.field_registry.snapshot-read'),
  readAutonomy: ref('autonomy.field_registry.snapshot-read'),
  readCapability: ref('capability.field_registry.snapshot-read'),
  readHandler: ref('handler.field_registry.snapshot-read'),
  readProjection: ref('projection.field_registry.snapshot-read.operator'),
  readTrace: ref('trace.field_registry.snapshot-read'),
  draftHandler: ref('handler.field_registry.changeset-draft'),
  draftProjection: ref('projection.field_registry.changeset-draft.operator'),
  audit: ref('audit.field_registry.changeset-draft'),
  auditRecordProfile: ref('record-profile.field_registry.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: FIELD_REGISTRY_DRAFT_REQUEST_HASH_PROFILE
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

function refsFor(action: FieldRegistryDraftAction): DraftRefs {
  return Object.freeze({
    context: ref(`context.field_registry.${action}-draft`),
    autonomy: ref(`autonomy.field_registry.${action}-draft`),
    concurrency: ref(`concurrency.field_registry.${action}-draft`),
    executionFamily: ref(`field_registry.${action}-draft.execution-family`),
    executionPhase: ref(`field_registry.${action}-draft.phase.single-uow`),
    terminalization: ref(`field_registry.${action}-draft.terminalization`),
    riskResolver: ref(`field_registry.${action}-draft.risk-resolver`),
    autonomyEvidence: ref(`field_registry.${action}-draft.autonomy-evidence`),
    approvalResolver: ref(`field_registry.${action}-draft.approval-resolver`),
    autonomyPreflight: ref(`field_registry.${action}-draft.autonomy-preflight`)
  });
}

export interface FieldRegistryCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface FieldRegistryCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    FieldRegistryCurrentEventResolution | Promise<FieldRegistryCurrentEventResolution>;
}

export interface FieldRegistryOperationIds {
  newInvocationId(): InvocationId;
}

export interface FieldRegistryOperationPolicies {
  readonly read: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
}

export interface CreateFieldRegistryOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: FieldRegistryOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: FieldRegistryCurrentEventSource;
  readonly registryRead: FieldRegistryReadPort;
  readonly optionSource: FieldRegistryLiveOptionSource;
  readonly clock: Clock;
  readonly ids: FieldRegistryOperationIds;
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
    kind: 'field_registry.event_required',
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512
        || value.trim() !== value) {
      throw new TypeError('field_registry_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: FieldRegistryCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('field_registry_current_event_resolution_invalid');
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

export function fieldRegistryDraftActionForOperation(
  operationName: string,
  operationVersion: number
): FieldRegistryDraftAction | undefined {
  return draftOperations.find(({ operation }) =>
    operation.name === operationName && operation.version === operationVersion
  )?.action;
}

function pathFor(action: FieldRegistryDraftAction): string {
  return `/api/events/current/field-registry/drafts/${action}`;
}

/** Registers one exact snapshot read and five inert changeset-draft mutations. */
export function createFieldRegistryOperationModule(
  input: CreateFieldRegistryOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.read.key !== FIELD_REGISTRY_READ_ACCESS_POLICY.key
      || input.policies.read.version !== FIELD_REGISTRY_READ_ACCESS_POLICY.version
      || input.policies.manage.key !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.key
      || input.policies.manage.version !== FIELD_REGISTRY_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('field_registry_operation_policy_catalog_mismatch');
  }
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const readLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.read
  });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.manage
  });
  const readAutonomy = operationAutonomy({
    operation: FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
    definition: refs.readAutonomy
  });
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext,
    operation: FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
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
      const state = input.registryRead.readFieldRegistry({
        workspaceId: context.scope.workspaceId,
        eventId: context.scope.eventId
      });
      if (!state) throw new TypeError('field_registry_current_event_state_missing');
      if (state.scope.workspaceId !== context.scope.workspaceId
          || state.scope.eventId !== context.scope.eventId) {
        throw new TypeError('field_registry_current_event_state_scope_mismatch');
      }
      return Object.freeze({
        kind: 'snapshot',
        value: projectFieldRegistrySnapshot({ state, optionSource: input.optionSource })
      });
    }
  });

  const drafts = draftOperations.map(({ action, operation }) => {
    const operationRefs = refsFor(action);
    const autonomy = operationAutonomy({ operation, definition: operationRefs.autonomy });
    const context = createEffectInvocationContextBuilder({
      reference: operationRefs.context,
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
      reference: operationRefs.executionFamily,
      phase: operationRefs.executionPhase
    });
    const terminalization = createTerminalizationResolverRegistration({
      reference: operationRefs.terminalization,
      operation,
      phase: operationRefs.executionPhase,
      resolve: ({ result }) => result.kind === 'success'
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: operationRefs.executionPhase,
      family: operationRefs.executionFamily,
      operation,
      effect: 'draft',
      handler: refs.draftHandler,
      handlerCapability: FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY,
      contributionSchema: schemas.draftContribution,
      terminalization: operationRefs.terminalization,
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
      reference: operationRefs.riskResolver,
      operation,
      resolve: () => Object.freeze({
        risk: 'low' as const,
        consequenceTags: Object.freeze(['changeset-drafted']),
        evidenceIds: Object.freeze([`field_registry.${action}.draft.risk`])
      })
    });
    const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
      reference: operationRefs.autonomyEvidence,
      operation,
      resolve: ({ subject }) => {
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]),
          maximumSpendMicros: 0,
          maximumActions: 1,
          notAfter: parseInstant(
            new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()
          )
        });
        return Object.freeze({
          evaluatedAt: subject.evaluatedAt,
          hardBounds: bounds,
          unattendedBounds: bounds,
          spendMicros: 0,
          actionCount: 1,
          completesBy: subject.evaluatedAt,
          proposedAction: Object.freeze({
            key: `field_registry.${action}.draft.execute`,
            version: 1,
            digestSha256: subject.requestHashSha256
          }),
          failure: Object.freeze({ kind: 'none' as const })
        });
      }
    });
    const approvalResolver = createRenewedApprovalResolverRegistration({
      reference: operationRefs.approvalResolver,
      operation,
      resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: operationRefs.autonomyPreflight,
      operation,
      policy: operationRefs.autonomy,
      riskResolver: operationRefs.riskResolver,
      evidenceResolver: operationRefs.autonomyEvidence,
      approvalResolver: operationRefs.approvalResolver,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return Object.freeze({
      action, operation, refs: operationRefs, autonomy, context, family,
      terminalization, phase, riskResolver, autonomyEvidence, approvalResolver, preflight
    });
  });

  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  const draftHandler = createFieldRegistryDraftHandler({
    reference: refs.draftHandler,
    handlerCapability: FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.draftContribution,
    canonicalResultSchema: schemas.draftCanonical,
    actionForOperation: fieldRegistryDraftActionForOperation
  });

  return Object.freeze({
    id: 'field-registry.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(drafts.map((entry) => entry.family)),
      effectPhases: Object.freeze(drafts.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(drafts.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(drafts.map((entry) => entry.riskResolver)),
      autonomyEvidenceResolvers: Object.freeze(drafts.map((entry) => entry.autonomyEvidence)),
      renewedApprovalResolvers: Object.freeze(drafts.map((entry) => entry.approvalResolver)),
      autonomyPreflights: Object.freeze(drafts.map((entry) => entry.preflight)),
      autonomyPolicies: Object.freeze([readAutonomy, ...drafts.map((entry) => entry.autonomy)]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: fieldRegistrySnapshotReadInputSchema },
        { reference: schemas.readCanonical, schema: fieldRegistrySnapshotCanonicalResultSchema },
        { reference: schemas.readProjected, schema: fieldRegistrySnapshotReadResultSchema },
        ...draftOperations.map(({ action, schema }) => ({
          reference: schemas.draftInputs[action], schema
        })),
        { reference: schemas.draftContribution, schema: fieldRegistryDraftContributionSchema },
        { reference: schemas.draftCanonical, schema: fieldRegistryDraftCanonicalResultSchema },
        { reference: schemas.draftProjected, schema: fieldRegistryDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.draftDetail, schema: fieldRegistryDraftDetailSchema }
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
                data: fieldRegistrySnapshotSchema.parse(snapshot.value)
              })
      }]),
      projections: Object.freeze([{
        reference: refs.readProjection,
        canonicalResultSchema: schemas.readCanonical,
        projectedResultSchema: schemas.readProjected,
        project: (candidate: unknown) => fieldRegistrySnapshotCanonicalResultSchema.parse(candidate)
      }, {
        reference: refs.draftProjection,
        canonicalResultSchema: schemas.draftCanonical,
        projectedResultSchema: schemas.draftProjected,
        project: (candidate: unknown) => fieldRegistryDraftCanonicalResultSchema.parse(candidate)
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
        maximumBytes: 262_144
      }]),
      operations: Object.freeze([{
        ...FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the current Event person-and-talk field registry.',
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
            kind: 'field_registry.event_required',
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
          path: '/api/events/current/field-registry',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.readProjection
        }]
      }]),
      effectContextBuilders: Object.freeze(drafts.map((entry) => entry.context)),
      effectHandlers: Object.freeze([draftHandler]),
      effectOperations: Object.freeze(drafts.map(({ action, operation, refs: operationRefs }) => ({
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: `Draft a Field Registry ${action} change for review.`,
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
            kind: 'field_registry.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'field_registry.changed',
            retryable: false,
            detailSchema: schemas.draftDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'field_registry.change_refused',
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
        handlerCapability: FIELD_REGISTRY_DRAFT_HANDLER_CAPABILITY,
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
