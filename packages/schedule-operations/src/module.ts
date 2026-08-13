import { createHash } from 'node:crypto';
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
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
  schedulePlacementConflictDetailSchema,
  schedulePlacementDraftDataSchema,
  schedulePlacementDraftOperationResultSchema,
  schedulePlacementInputSchema,
  schedulePlacementPlanSchema,
  schedulePlacementReadInputSchema,
  schedulePlacementReadResultSchema,
  schedulePlacementSnapshotSchema,
  schedulePlacementVersionSchema
} from '@jooevents/contracts/schedule-placement';
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
  encodeCanonicalJson,
  isApplicationId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SchedulePlacementReadPort } from '@jooevents/schedule';
import { z } from 'zod';
import { createSchedulePlacementDraftHandler } from './preparation';

export const SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'schedule.placement.snapshot.read', version: 1
});
export const SCHEDULE_PLACEMENT_DRAFT_OPERATION = Object.freeze({
  name: 'schedule.placement.draft', version: 1
});

export const SCHEDULE_PLACEMENT_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.schedule.read', version: parseContractVersion(1)
});
export const SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.schedule.manage', version: parseContractVersion(1)
});
export const SCHEDULE_PLACEMENT_READ_PERMISSION_ID: PermissionId = 'schedule.read';
export const SCHEDULE_PLACEMENT_MANAGE_PERMISSION_ID: PermissionId = 'schedule.manage';
export const SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.schedule.placement-draft'
);
export const SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.schedule.placement-changeset-draft'
);
export const SCHEDULE_PLACEMENT_APPROVAL_POLICY = (() => {
  const reference = ref('policy.schedule.placement.bounded');
  const definition = Object.freeze({
    reference,
    requirement: 'none' as const
  });
  return Object.freeze({
    ...definition,
    definitionDigestSha256: createHash('sha256')
      .update(encodeCanonicalJson(definition))
      .digest('hex')
  });
})();

const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Application IDs must be canonical lowercase UUIDv4 or UUIDv7 values.'
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
}, 'Expected a canonical UTC instant.');

/** @deprecated Use the canonical numeric read input from public contracts. */
export const schedulePlacementReadQueryInputSchema = schedulePlacementReadInputSchema;

export const schedulePlacementSnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: schedulePlacementSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const schedulePlacementSnapshotReadResultSchema = schedulePlacementReadResultSchema;
export const schedulePlacementDraftCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: schedulePlacementDraftDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export { schedulePlacementDraftDataSchema, schedulePlacementDraftOperationResultSchema };

export const schedulePlacementDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('schedule_placement_changeset_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: sha256Schema,
  recordDigestSha256: sha256Schema,
  action: z.enum(['place', 'move']),
  occurredAt: canonicalInstantSchema
});
export const schedulePlacementDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
});

export const schedulePlacementStaleDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'stale_schedule', 'occurrence_exists', 'occurrence_missing',
    'stale_occurrence', 'session_missing', 'room_missing', 'room_retired',
    'stale_room_query', 'invalid_plan'
  ]),
  action: z.enum(['place', 'move']),
  occurrenceId: applicationIdSchema
});
const nullDetailSchema = z.null();

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: schedulePlacementDraftDataSchema }),
  domain: schedulePlacementDraftDomainContributionSchema,
  receiptChildren: z.tuple([schedulePlacementDraftEvidenceChildSchema])
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
    context.addIssue({ code: 'custom', message: 'Schedule draft evidence is incoherent.' });
  }
});

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  const detailSchema = outcome.kind === 'schedule_room_overlap'
    ? schedulePlacementConflictDetailSchema
    : outcome.kind === 'schedule_placement_changed'
      ? schedulePlacementStaleDetailSchema
      : nullDetailSchema;
  const allowed = new Set([
    'conflict:schedule.event_required',
    'conflict:schedule_room_overlap',
    'stale_revision:schedule_placement_changed',
    'conflict:changeset.id_collision'
  ]);
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Schedule draft refusal is invalid.' });
  }
});

export const schedulePlacementDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

export type SchedulePlacementDraftData = z.infer<typeof schedulePlacementDraftDataSchema>;
export type SchedulePlacementDraftContribution =
  z.infer<typeof schedulePlacementDraftContributionSchema>;

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  const jsonSchema = JSON.parse(JSON.stringify(
    z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' })
  )) as unknown;
  return Object.freeze({
    key,
    version: 1,
    digestSha256: createHash('sha256').update(encodeCanonicalJson(jsonSchema)).digest('hex')
  });
}

const schemas = Object.freeze({
  readInput: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
  readCanonical: schemaRef(
    'schema.schedule.placement-snapshot-read.canonical-result',
    schedulePlacementSnapshotCanonicalResultSchema
  ),
  readProjected: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
  draftInput: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placementDraft.inputSchema,
  draftContribution: schemaRef(
    'schema.schedule.placement-draft.contribution', schedulePlacementDraftContributionSchema
  ),
  draftCanonical: schemaRef(
    'schema.schedule.placement-draft.canonical-result', schedulePlacementDraftCanonicalResultSchema
  ),
  draftProjected: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placementDraft.resultSchema,
  nullDetail: schemaRef('schema.schedule.operation.null-detail', nullDetailSchema),
  staleDetail: schemaRef('schema.schedule.placement-stale.detail', schedulePlacementStaleDetailSchema),
  overlapDetail: schemaRef(
    'schema.schedule.placement-room-overlap.detail', schedulePlacementConflictDetailSchema
  )
});

const refs = Object.freeze({
  readContext: ref('context.schedule.placement-snapshot-read'),
  readAutonomy: ref('autonomy.schedule.placement-snapshot-read'),
  readCapability: ref('capability.schedule.placement-snapshot-read'),
  readHandler: ref('handler.schedule.placement-snapshot-read'),
  readProjection: ref('projection.schedule.placement-snapshot-read.operator'),
  readTrace: ref('trace.schedule.placement-snapshot-read'),
  draftContext: ref('context.schedule.placement-draft'),
  draftAutonomy: ref('autonomy.schedule.placement-draft'),
  draftConcurrency: ref('concurrency.schedule.placement-draft'),
  draftFamily: ref('schedule.placement-draft.execution-family'),
  draftPhase: ref('schedule.placement-draft.phase.single-uow'),
  draftTerminalization: ref('schedule.placement-draft.terminalization'),
  draftRisk: ref('schedule.placement-draft.risk-resolver'),
  draftAutonomyEvidence: ref('schedule.placement-draft.autonomy-evidence'),
  draftApproval: ref('schedule.placement-draft.approval-resolver'),
  draftPreflight: ref('schedule.placement-draft.autonomy-preflight'),
  draftHandler: ref('handler.schedule.placement-draft'),
  draftProjection: ref('projection.schedule.placement-draft.operator'),
  audit: ref('audit.schedule.placement-draft'),
  auditRecordProfile: ref('record-profile.schedule.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

export interface SchedulePlacementCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface SchedulePlacementCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    SchedulePlacementCurrentEventResolution | Promise<SchedulePlacementCurrentEventResolution>;
}

export interface SchedulePlacementOperationPolicies {
  readonly read: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
}

export interface CreateSchedulePlacementOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policies: SchedulePlacementOperationPolicies;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: SchedulePlacementCurrentEventSource;
  readonly scheduleRead: Pick<SchedulePlacementReadPort, 'readSchedule'>;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
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
    kind: 'schedule.event_required',
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.trim() !== value) {
      throw new TypeError('schedule_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function currentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: SchedulePlacementCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('schedule_current_event_resolution_invalid');
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

export function createSchedulePlacementOperationModule(
  input: CreateSchedulePlacementOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.read.key !== SCHEDULE_PLACEMENT_READ_ACCESS_POLICY.key
      || input.policies.read.version !== SCHEDULE_PLACEMENT_READ_ACCESS_POLICY.version
      || input.policies.manage.key !== SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY.key
      || input.policies.manage.version !== SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('schedule_placement_operation_policy_catalog_mismatch');
  }
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const readLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.read
  });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.manage
  });
  const readAutonomy = operationAutonomy({
    operation: SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
    definition: refs.readAutonomy
  });
  const draftAutonomy = operationAutonomy({
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    definition: refs.draftAutonomy
  });
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext,
    operation: SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
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
      if (context.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
      const state = input.scheduleRead.readSchedule({
        workspaceId: context.scope.workspaceId,
        eventId: context.scope.eventId
      });
      if (!state) throw new TypeError('schedule_current_event_state_missing');
      if (state.scope.workspaceId !== context.scope.workspaceId
          || state.scope.eventId !== context.scope.eventId) {
        throw new TypeError('schedule_current_event_state_scope_mismatch');
      }
      return Object.freeze({ kind: 'schedule', state });
    }
  });
  const draftContext = createEffectInvocationContextBuilder({
    reference: refs.draftContext,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    effect: 'draft',
    lanes: [manageLane],
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const draftFamily = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.draftFamily, phase: refs.draftPhase
  });
  const draftTerminalization = createTerminalizationResolverRegistration({
    reference: refs.draftTerminalization,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    phase: refs.draftPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const draftPhase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.draftPhase,
    family: refs.draftFamily,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    effect: 'draft',
    handler: refs.draftHandler,
    handlerCapability: SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.draftContribution,
    terminalization: refs.draftTerminalization,
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
  const draftRisk = createOperationRiskResolverRegistration({
    reference: refs.draftRisk,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['schedule.placement.draft.risk'])
    })
  });
  const draftAutonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.draftAutonomyEvidence,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString());
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
          key: 'schedule.placement.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const draftApproval = createRenewedApprovalResolverRegistration({
    reference: refs.draftApproval,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const draftPreflight = createAutonomyPreflightRegistration({
    reference: refs.draftPreflight,
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    policy: refs.draftAutonomy,
    riskResolver: refs.draftRisk,
    evidenceResolver: refs.draftAutonomyEvidence,
    approvalResolver: refs.draftApproval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));
  const draftHandler = createSchedulePlacementDraftHandler({
    reference: refs.draftHandler,
    handlerCapability: SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.draftContribution,
    canonicalResultSchema: schemas.draftCanonical
  });

  return Object.freeze({
    id: 'schedule-placement.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([draftFamily]),
      effectPhases: Object.freeze([draftPhase]),
      terminalizationResolvers: Object.freeze([draftTerminalization]),
      riskResolvers: Object.freeze([draftRisk]),
      autonomyEvidenceResolvers: Object.freeze([draftAutonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([draftApproval]),
      autonomyPreflights: Object.freeze([draftPreflight]),
      autonomyPolicies: Object.freeze([readAutonomy, draftAutonomy]),
      schemas: Object.freeze([
        { reference: schemas.readInput, schema: schedulePlacementReadInputSchema },
        { reference: schemas.readCanonical, schema: schedulePlacementSnapshotCanonicalResultSchema },
        { reference: schemas.readProjected, schema: schedulePlacementSnapshotReadResultSchema },
        { reference: schemas.draftInput, schema: schedulePlacementInputSchema },
        { reference: schemas.draftContribution, schema: schedulePlacementDraftContributionSchema },
        { reference: schemas.draftCanonical, schema: schedulePlacementDraftCanonicalResultSchema },
        { reference: schemas.draftProjected, schema: schedulePlacementDraftOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema },
        { reference: schemas.staleDetail, schema: schedulePlacementStaleDetailSchema },
        { reference: schemas.overlapDetail, schema: schedulePlacementConflictDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: refs.readHandler,
        readCapability: refs.readCapability,
        canonicalResultSchema: schemas.readCanonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          if (snapshot.kind === 'event_required') {
            return Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() });
          }
          const query = schedulePlacementReadInputSchema.parse(businessInput);
          const state = snapshot.state as {
            readonly scope: { readonly workspaceId: string; readonly eventId: string };
            readonly scheduleVersion: number;
            readonly occurrences: readonly {
              readonly id: string; readonly sessionId: string; readonly roomId: string;
              readonly startAt: string; readonly endAt: string; readonly version: number;
            }[];
          };
          return Object.freeze({
            kind: 'success' as const,
            data: schedulePlacementSnapshotSchema.parse({
              schemaVersion: 1,
              scope: state.scope,
              scheduleVersion: state.scheduleVersion,
              occurrences: state.occurrences
                .filter((occurrence) => occurrence.startAt < query.endAt && query.startAt < occurrence.endAt)
                .slice(0, query.limit)
            })
          });
        }
      }]),
      projections: Object.freeze([{
        reference: refs.readProjection,
        canonicalResultSchema: schemas.readCanonical,
        projectedResultSchema: schemas.readProjected,
        project: (candidate: unknown) => schedulePlacementSnapshotCanonicalResultSchema.parse(candidate)
      }, {
        reference: refs.draftProjection,
        canonicalResultSchema: schemas.draftCanonical,
        projectedResultSchema: schemas.draftProjected,
        project: (candidate: unknown) => schedulePlacementDraftCanonicalResultSchema.parse(candidate)
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
        ...SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read placement occurrences for the current Event and UTC range.',
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
            kind: 'schedule.event_required',
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
          path: '/api/events/current/schedule/placements',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.readProjection
        }]
      }]),
      effectContextBuilders: Object.freeze([draftContext]),
      effectHandlers: Object.freeze([draftHandler]),
      effectOperations: Object.freeze([{
        ...SCHEDULE_PLACEMENT_DRAFT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one placement or move for review.',
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.draftAutonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: schemas.draftInput,
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
            kind: 'schedule.event_required',
            retryable: false,
            detailSchema: schemas.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'schedule_room_overlap',
            retryable: false,
            detailSchema: schemas.overlapDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'schedule_placement_changed',
            retryable: false,
            detailSchema: schemas.staleDetail
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
        contextBuilder: refs.draftContext,
        handlerCapability: SCHEDULE_PLACEMENT_DRAFT_HANDLER_CAPABILITY,
        handler: refs.draftHandler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.draftConcurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: refs.draftFamily,
          phase: refs.draftPhase,
          terminalization: refs.draftTerminalization,
          autonomyPreflight: refs.draftPreflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: '/api/events/current/schedule/placements/drafts',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.draftProjection
        }]
      }])
    })
  });
}
