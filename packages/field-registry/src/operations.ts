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
  fieldRegistryDirectCanonicalResultSchema,
  fieldRegistryDirectDataSchema,
  fieldRegistryDirectOperationResultSchema,
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
import type { FieldRegistryMutationPlan, FieldRegistryReadPort } from './domain';
import { createFieldRegistryDirectHandler } from './preparation';

export const FIELD_REGISTRY_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'field_registry.snapshot.read', version: 1
});
export const FIELD_REGISTRY_ADD_OPERATION = Object.freeze({
  name: 'field_registry.add', version: 1
});
export const FIELD_REGISTRY_EDIT_OPERATION = Object.freeze({
  name: 'field_registry.edit', version: 1
});
export const FIELD_REGISTRY_MOVE_OPERATION = Object.freeze({
  name: 'field_registry.move', version: 1
});
export const FIELD_REGISTRY_REMOVE_OPERATION = Object.freeze({
  name: 'field_registry.remove', version: 1
});
export const FIELD_REGISTRY_RESTORE_OPERATION = Object.freeze({
  name: 'field_registry.restore', version: 1
});

export const FIELD_REGISTRY_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.field_registry.read', version: parseContractVersion(1)
});
export const FIELD_REGISTRY_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.field_registry.manage', version: parseContractVersion(1)
});
export const FIELD_REGISTRY_READ_PERMISSION_ID: PermissionId = 'event.read';
export const FIELD_REGISTRY_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';
export const FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE = ref(
  'request-hash.field_registry.direct'
);
export const FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY = ref(
  'capability.field_registry.direct'
);

const directOperations = Object.freeze([
  Object.freeze({
    action: 'add' as const,
    operation: FIELD_REGISTRY_ADD_OPERATION,
    schema: fieldRegistryAddDraftRequestSchema
  }),
  Object.freeze({
    action: 'edit' as const,
    operation: FIELD_REGISTRY_EDIT_OPERATION,
    schema: fieldRegistryEditDraftRequestSchema
  }),
  Object.freeze({
    action: 'move' as const,
    operation: FIELD_REGISTRY_MOVE_OPERATION,
    schema: fieldRegistryMoveDraftRequestSchema
  }),
  Object.freeze({
    action: 'remove' as const,
    operation: FIELD_REGISTRY_REMOVE_OPERATION,
    schema: fieldRegistryRemoveDraftRequestSchema
  }),
  Object.freeze({
    action: 'restore' as const,
    operation: FIELD_REGISTRY_RESTORE_OPERATION,
    schema: fieldRegistryRestoreDraftRequestSchema
  })
]);

const nullDetailSchema = z.null();
export const fieldRegistryDirectDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_registry', 'field_exists', 'field_missing', 'stale_field',
    'field_removed', 'field_active', 'form_missing', 'form_changed', 'locked_field',
    'invalid_options', 'invalid_position', 'invalid_plan'
  ]),
  action: fieldRegistryDraftActionSchema,
  fieldId: fieldRegistryIdSchema
});

const mutationPlanSchema = z.custom<FieldRegistryMutationPlan>((value) => {
  if (!value || typeof value !== 'object') return false;
  return fieldRegistryDraftActionSchema.safeParse(
    (value as { readonly action?: unknown }).action
  ).success;
}, { message: 'invalid_field_registry_mutation_plan' });

const directSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: fieldRegistryDirectDataSchema }),
  domain: z.strictObject({
    kind: z.literal('field_registry_direct_change'),
    plan: mutationPlanSchema
  }),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  if (contribution.result.data.action !== contribution.domain.plan.action) {
    context.addIssue({ code: 'custom', message: 'Field Registry direct action mismatch.' });
  }
});

const allowedDirectOutcomes = new Set([
  'conflict:field_registry.event_required',
  'stale_revision:field_registry.changed',
  'policy_violation:field_registry.change_refused'
]);

const directOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'field_registry.event_required'
    ? nullDetailSchema : fieldRegistryDirectDetailSchema;
  if (!allowedDirectOutcomes.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Field Registry direct refusal is invalid.' });
  }
});

export const fieldRegistryDirectContributionSchema = z.union([
  directSuccessContributionSchema,
  directOutcomeContributionSchema
]);
export type FieldRegistryDirectContribution = z.infer<typeof fieldRegistryDirectContributionSchema>;

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
  directContribution: schemaRef(
    'schema.field_registry.direct.contribution',
    fieldRegistryDirectContributionSchema
  ),
  directCanonical: schemaRef(
    'schema.field_registry.direct.canonical-result',
    fieldRegistryDirectCanonicalResultSchema
  ),
  directProjected: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct.add.resultSchema,
  nullDetail: schemaRef('schema.field_registry.operation.null-detail', nullDetailSchema),
  directDetail: schemaRef(
    'schema.field_registry.direct-refusal.detail',
    fieldRegistryDirectDetailSchema
  ),
  directInputs: Object.freeze({
    add: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct.add.inputSchema,
    edit: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct.edit.inputSchema,
    move: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct.move.inputSchema,
    remove: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct.remove.inputSchema,
    restore: FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct.restore.inputSchema
  })
});

const refs = Object.freeze({
  readContext: ref('context.field_registry.snapshot-read'),
  readAutonomy: ref('autonomy.field_registry.snapshot-read'),
  readCapability: ref('capability.field_registry.snapshot-read'),
  readHandler: ref('handler.field_registry.snapshot-read'),
  readProjection: ref('projection.field_registry.snapshot-read.operator'),
  readTrace: ref('trace.field_registry.snapshot-read'),
  directHandler: ref('handler.field_registry.direct'),
  directProjection: ref('projection.field_registry.direct.operator'),
  audit: ref('audit.field_registry.direct'),
  auditRecordProfile: ref('record-profile.field_registry.operation-audit'),
  keySource: ref('idempotency.operator-header'),
  requestHash: FIELD_REGISTRY_DIRECT_REQUEST_HASH_PROFILE
});

interface DirectRefs {
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

function refsFor(action: FieldRegistryDraftAction): DirectRefs {
  return Object.freeze({
    context: ref(`context.field_registry.${action}`),
    autonomy: ref(`autonomy.field_registry.${action}`),
    concurrency: ref(`concurrency.field_registry.${action}`),
    executionFamily: ref(`field_registry.${action}.execution-family`),
    executionPhase: ref(`field_registry.${action}.phase.direct-uow`),
    terminalization: ref(`field_registry.${action}.terminalization`),
    riskResolver: ref(`field_registry.${action}.risk-resolver`),
    autonomyEvidence: ref(`field_registry.${action}.autonomy-evidence`),
    approvalResolver: ref(`field_registry.${action}.approval-resolver`),
    autonomyPreflight: ref(`field_registry.${action}.autonomy-preflight`)
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

export function fieldRegistryDirectActionForOperation(
  operationName: string,
  operationVersion: number
): FieldRegistryDraftAction | undefined {
  return directOperations.find(({ operation }) =>
    operation.name === operationName && operation.version === operationVersion
  )?.action;
}

function pathFor(action: FieldRegistryDraftAction): string {
  return `/api/events/current/field-registry/${action}`;
}

/** Registers one exact snapshot read and five direct audited mutations. */
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

  const directs = directOperations.map(({ action, operation }) => {
    const operationRefs = refsFor(action);
    const autonomy = operationAutonomy({ operation, definition: operationRefs.autonomy });
    const context = createEffectInvocationContextBuilder({
      reference: operationRefs.context,
      operation,
      effect: 'commit',
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
      effect: 'commit',
      handler: refs.directHandler,
      handlerCapability: FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
      contributionSchema: schemas.directContribution,
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
        consequenceTags: Object.freeze(['field-registry-changed']),
        evidenceIds: Object.freeze([`field_registry.${action}.risk`])
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
            key: `field_registry.${action}.execute`,
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
  const directHandler = createFieldRegistryDirectHandler({
    reference: refs.directHandler,
    handlerCapability: FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.directContribution,
    canonicalResultSchema: schemas.directCanonical,
    actionForOperation: fieldRegistryDirectActionForOperation
  });

  return Object.freeze({
    id: 'field-registry.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(directs.map((entry) => entry.family)),
      effectPhases: Object.freeze(directs.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(directs.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(directs.map((entry) => entry.riskResolver)),
      autonomyEvidenceResolvers: Object.freeze(directs.map((entry) => entry.autonomyEvidence)),
      renewedApprovalResolvers: Object.freeze(directs.map((entry) => entry.approvalResolver)),
      autonomyPreflights: Object.freeze(directs.map((entry) => entry.preflight)),
      autonomyPolicies: Object.freeze([readAutonomy, ...directs.map((entry) => entry.autonomy)]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: fieldRegistrySnapshotReadInputSchema },
        { reference: schemas.readCanonical, schema: fieldRegistrySnapshotCanonicalResultSchema },
        { reference: schemas.readProjected, schema: fieldRegistrySnapshotReadResultSchema },
        ...directOperations.map(({ action, schema }) => ({
          reference: schemas.directInputs[action], schema
        })),
        { reference: schemas.directContribution, schema: fieldRegistryDirectContributionSchema },
        { reference: schemas.directCanonical, schema: fieldRegistryDirectCanonicalResultSchema },
        { reference: schemas.directProjected, schema: fieldRegistryDirectOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.directDetail, schema: fieldRegistryDirectDetailSchema }
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
        reference: refs.directProjection,
        canonicalResultSchema: schemas.directCanonical,
        projectedResultSchema: schemas.directProjected,
        project: (candidate: unknown) => fieldRegistryDirectCanonicalResultSchema.parse(candidate)
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
      effectContextBuilders: Object.freeze(directs.map((entry) => entry.context)),
      effectHandlers: Object.freeze([directHandler]),
      effectOperations: Object.freeze(directs.map(({ action, operation, refs: operationRefs }) => ({
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: `${action === 'add' ? 'Added' : action === 'edit' ? 'Updated' : action === 'move' ? 'Moved' : action === 'remove' ? 'Removed' : 'Restored'} a speaker field`,
        effect: 'commit' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: operationRefs.autonomy,
        consequenceTags: ['field-registry-changed'],
        inputSchema: schemas.directInputs[action],
        contributionSchema: schemas.directContribution,
        canonicalResultSchema: schemas.directCanonical,
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
            detailSchema: schemas.directDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'field_registry.change_refused',
            retryable: false,
            detailSchema: schemas.directDetail
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
        handlerCapability: FIELD_REGISTRY_DIRECT_HANDLER_CAPABILITY,
        handler: refs.directHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: refs.requestHash
        },
        concurrency: operationRefs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: operationRefs.executionFamily,
          phase: operationRefs.executionPhase,
          terminalization: operationRefs.terminalization,
          autonomyPreflight: operationRefs.autonomyPreflight,
          history: { summariesByAction: Object.freeze({
            add: 'Added a speaker field',
            edit: 'Updated a speaker field',
            move: 'Moved a speaker field',
            remove: 'Removed a speaker field',
            restore: 'Restored a speaker field'
          }) }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: pathFor(action),
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.directProjection
        }]
      })))
    })
  });
}
